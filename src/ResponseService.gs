/**
 * @fileoverview Núcleo de gravação de respostas do SETUR Forms GAS.
 * Validação dupla, LockService, sanitização, fila de contingência.
 */

// ============================================================
// RECEBER RESPOSTA (PONTO DE ENTRADA PRINCIPAL)
// ============================================================

/**
 * Recebe e grava uma resposta de formulário.
 * Pipeline: validar nonce → anti-bot → revalidar → lock → sanitizar → gravar.
 * @param {string} formId - ID do formulário
 * @param {Object} payload - Dados da resposta
 * @param {Object} payload.respostas - Mapa questionId → valor
 * @param {string} payload.nonce - Token único de submissão
 * @param {string} payload.honeypot - Campo honeypot (deve estar vazio)
 * @param {number} payload.tempoPreenchimento - Segundos desde o carregamento
 * @param {string} [payload.userAgent] - User-Agent do cliente
 * @returns {{ok: boolean, data?: Object, error?: string}}
 */
function receberResposta(formId, payload) {
  const responseId = gerarUUID();

  try {
    // ── 1. Honeypot anti-bot ──────────────────────────────
    if (payload.honeypot && payload.honeypot !== '') {
      logEvento(formId, NIVEL_LOG.WARN, 'Honeypot preenchido — provável bot rejeitado.');
      return respostaErro('Submissão inválida.', 'BOT_DETECTADO');
    }

    // ── 2. Tempo mínimo de preenchimento ─────────────────
    const config = obterConfig();
    const tempoMin = parseInt(config['tempoMinimoResposta']) || 5;
    if ((payload.tempoPreenchimento || 0) < tempoMin) {
      logEvento(formId, NIVEL_LOG.WARN,
        'Resposta muito rápida (' + payload.tempoPreenchimento + 's). Possível bot.');
      return respostaErro('Submissão muito rápida. Por favor, aguarde.', 'MUITO_RAPIDO');
    }

    // ── 3. Validar e invalidar nonce ─────────────────────
    if (!validarNonce(formId, payload.nonce)) {
      logEvento(formId, NIVEL_LOG.WARN, 'Nonce inválido ou já usado. responseId: ' + responseId);
      return respostaErro('Esta submissão já foi processada ou expirou. Recarregue a página.', 'NONCE_INVALIDO');
    }

    // ── 4. Obter e verificar o formulário ────────────────
    const formResult = obterFormularioPublico(formId);
    if (!formResult.ok) return formResult;
    const form = formResult.data;

    // ── 5. Verificar resposta única por pessoa ───────────
    const verificacaoUnica = _verificarRespostaUnica(formId, form.configJSON, payload);
    if (!verificacaoUnica.ok) return verificacaoUnica;

    // ── 6. Revalidação server-side completa ──────────────
    const validacao = _revalidarRespostas(form.configJSON, payload.respostas);
    if (!validacao.ok) return validacao;

    // ── 7. Gravar com LockService ─────────────────────────
    const resultado = _gravarComLock(formId, responseId, form, payload);
    return resultado;

  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR, 'Erro ao receber resposta: ' + e.message, e.stack);
    // Tentar salvar na fila de contingência
    _adicionarNaFila(formId, responseId, payload, e.message);
    return respostaErro(
      'Ocorreu um erro ao registrar sua resposta. Ela foi salva e será processada em breve.',
      'ERRO_GRAVACAO_CONTINGENCIA'
    );
  }
}

// ============================================================
// NONCE (TOKEN ÚNICO DE SUBMISSÃO)
// ============================================================

/**
 * Gera e armazena um nonce de submissão único para um formulário.
 * @param {string} formId
 * @returns {string} Nonce gerado
 */
function gerarNonce(formId) {
  const nonce = gerarUUID();
  CacheService.getScriptCache().put(
    'nonce_' + formId + '_' + nonce,
    '1',
    LIMITE.CACHE_NONCE_SEGUNDOS
  );
  return nonce;
}

/**
 * Valida e invalida um nonce (uso único).
 * @param {string} formId
 * @param {string} nonce
 * @returns {boolean}
 */
function validarNonce(formId, nonce) {
  if (!nonce) return false;
  const cache = CacheService.getScriptCache();
  const chave = 'nonce_' + formId + '_' + nonce;
  const existe = cache.get(chave);
  if (existe) {
    cache.remove(chave); // Invalidar — uso único
    return true;
  }
  return false;
}

// ============================================================
// GRAVAÇÃO COM LOCK — PADRÃO: INTENÇÃO → WRITE → FLUSH → VERIFY → CONFIRM
// ============================================================

/**
 * Grava a resposta na planilha com garantia de entrega.
 *
 * Fluxo de garantia de entrega em 5 etapas:
 *  1. INTENÇÃO  — registra responseId no CacheService ANTES de qualquer escrita
 *                 Se o processo morrer aqui, o trigger detecta e reprocessa
 *  2. WRITE     — appendRow com LockService (sem corrupção por concorrência)
 *  3. FLUSH     — SpreadsheetApp.flush() força commit físico na API
 *  4. VERIFY    — lê de volta a linha pelo responseId para confirmar presença
 *  5. CONFIRM   — só retorna ok:true após verificação positiva
 *                 Se verificação falhar → retry → fila → nunca ok:true sem dados
 *
 * @param {string} formId
 * @param {string} responseId
 * @param {Object} form - Dados do formulário
 * @param {Object} payload - Payload da resposta
 * @returns {{ok: boolean, data?: Object, error?: string}}
 * @private
 */
function _gravarComLock(formId, responseId, form, payload) {

  // ── ETAPA 1: REGISTRAR INTENÇÃO ───────────────────────────
  // Antes de qualquer I/O na planilha, marcamos a intenção no cache.
  // Se o processo morrer entre aqui e o CONFIRM, o trigger detecta
  // respostas sem par na planilha e reprocessa da fila.
  _registrarIntencao(formId, responseId, payload);

  // ── ETAPA 2: OBTER LOCK ───────────────────────────────────
  const lock = LockService.getScriptLock();
  let lockObtido = false;
  let tentativaLock = 0;

  while (tentativaLock < LIMITE.MAX_RETRIES_LOCK) {
    try {
      lock.waitLock(LIMITE.LOCK_TIMEOUT_MS);
      lockObtido = true;
      break;
    } catch (e) {
      tentativaLock++;
      if (tentativaLock >= LIMITE.MAX_RETRIES_LOCK) {
        logEvento(formId, NIVEL_LOG.WARN,
          'LockService timeout após ' + LIMITE.MAX_RETRIES_LOCK + ' tentativas. responseId: ' + responseId);
        // Intenção já registrada → fila vai processar
        _adicionarNaFila(formId, responseId, payload, 'Lock timeout após retries');
        // Limpa intenção pois a fila assumiu a responsabilidade
        _removerIntencao(responseId);
        return respostaErro(
          'O sistema recebeu sua resposta, mas está processando muitos envios simultâneos. ' +
          'Sua resposta (ID: ' + responseId.substring(0, 8) + '...) foi salva e será registrada em até 5 minutos. ' +
          'Você pode fechar esta página com segurança.',
          'LOCK_TIMEOUT_FILA'
        );
      }
      Utilities.sleep(LIMITE.BACKOFF_BASE_MS * Math.pow(2, tentativaLock - 1));
    }
  }

  try {
    // ── ETAPA 2 (cont): VERIFICAR SE JÁ FOI GRAVADA ──────────
    // Proteção extra: se por algum motivo o mesmo responseId já chegou
    // (ex: retry do cliente), não duplicar.
    const { planilhaId } = _obterInfoPlanilha(formId);
    const ss = SpreadsheetApp.openById(planilhaId);
    const aba = ss.getSheetByName('Respostas');

    if (_responseIdExisteNaPlanilha(aba, responseId)) {
      logEvento(formId, NIVEL_LOG.WARN,
        'responseId já existia na planilha (submissão duplicada ignorada): ' + responseId);
      _removerIntencao(responseId);
      // Retornar sucesso pois a resposta JÁ está gravada
      const timestamp = formatarDataBR(new Date());
      return respostaOk({
        responseId: responseId,
        timestamp: timestamp,
        mensagemConfirmacao: _getMensagemConfirmacao(form),
      });
    }

    // ── ETAPA 3: ESCREVER (dentro do lock) ───────────────────
    const ultimaColuna = aba.getLastColumn();
    const rangeHeader = aba.getRange(1, 1, 1, ultimaColuna);
    const cabecalhos = rangeHeader.getValues()[0];
    const notasCabecalhos = rangeHeader.getNotes()[0];
    const respostasSanitizadas = sanitizarRespostas(payload.respostas || {});
    const timestamp = formatarDataBR(new Date());

    // Versão real do formulário (gravada no configJSON pelo admin), com fallback
    const cfg = form.configJSON;
    const parsedCfg = typeof cfg === 'string' ? JSON.parse(cfg || '{}') : (cfg || {});
    const versaoForm = (parsedCfg.configuracoes && parsedCfg.configuracoes.versao) || '1.0';

    const linhaDados = cabecalhos.map((cabecalho, idx) => {
      const questionId = notasCabecalhos[idx] || cabecalho; // Fallback para compatibilidade
      switch (questionId) {
        case 'responseId':            return responseId;
        case 'timestamp':             return timestamp;
        case 'formId':                return formId;
        case 'versaoForm':            return versaoForm;
        case 'enderecoIP':            return sanitizarCelula(payload.userIp || '');
        case 'userAgent': {
          var uaRaw = (payload.userAgent || '').substring(0, 500);
          var uaLegivel = parsearUserAgent(uaRaw);
          return sanitizarCelula(uaLegivel || uaRaw);
        }
        case 'tempoPreenchimentoSeg': return payload.tempoPreenchimento || 0;
        default:
          return respostasSanitizadas[questionId] !== undefined
            ? respostasSanitizadas[questionId] : '';
      }
    });

    aba.appendRow(linhaDados);

    // ── ETAPA 4: FLUSH FÍSICO ─────────────────────────────────
    // Força o commit de todas as alterações pendentes na API do Sheets
    // ANTES de verificar. Sem isso, getValues() poderia retornar cache stale.
    SpreadsheetApp.flush();

    // ── ETAPA 5: VERIFICAR PRESENÇA NA PLANILHA ───────────────
    // Lê de volta para confirmar que a linha está realmente persistida.
    const gravado = _responseIdExisteNaPlanilha(aba, responseId);

    if (!gravado) {
      logEvento(formId, NIVEL_LOG.WARN,
        'VERIFY falhou na 1ª tentativa para responseId: ' + responseId + '. Aguardando propagação...');

      Utilities.sleep(1000); // Espera 1s para propagação do Sheets
      SpreadsheetApp.flush();

      // Verificar se a linha apareceu após a espera (sem duplicar)
      if (_responseIdExisteNaPlanilha(aba, responseId)) {
        logEvento(formId, NIVEL_LOG.INFO,
          'VERIFY corrigido na 2ª tentativa de leitura para responseId: ' + responseId);
      } else {
        logEvento(formId, NIVEL_LOG.WARN,
          'VERIFY falhou na 2ª leitura. Executando appendRow novamente para: ' + responseId);
        aba.appendRow(linhaDados);
        SpreadsheetApp.flush();

        const gravadoRetry = _responseIdExisteNaPlanilha(aba, responseId);

        if (!gravadoRetry) {
          logEvento(formId, NIVEL_LOG.ERROR,
            'CRÍTICO: appendRow+flush executados mas responseId não encontrado na planilha: ' + responseId);
          _adicionarNaFila(formId, responseId, payload, 'Verify falhou após retry');
          _removerIntencao(responseId);
          return respostaErro(
            'Sua resposta foi recebida mas tivemos dificuldade técnica ao confirmá-la. ' +
            'Ela foi salva em nosso sistema de contingência (ID: ' + responseId.substring(0, 8) + '...) ' +
            'e será registrada automaticamente em até 5 minutos. ' +
            'Por favor, não envie novamente.',
            'VERIFY_FALHOU_FILA'
          );
        }
      }
    }

    // ── CONFIRM: GRAVAÇÃO CONFIRMADA ──────────────────────────
    // Só chegamos aqui se a linha foi lida de volta com sucesso.
    _removerIntencao(responseId);
    _incrementarContador(formId);
    _verificarLimiteEEncerrar(formId, form);
    _enfileirarNotificacao(formId, form.configJSON, responseId, timestamp);
    _registrarRespostaUnicaCache(formId, form.configJSON, payload);

    logEvento(formId, NIVEL_LOG.INFO,
      'Resposta CONFIRMADA na planilha. responseId: ' + responseId);

    return respostaOk({
      responseId: responseId,
      timestamp: timestamp,
      mensagemConfirmacao: _getMensagemConfirmacao(form),
    });

  } catch (e) {
    // Erro inesperado dentro do lock — garantir enfileiramento
    logEvento(formId, NIVEL_LOG.ERROR,
      'Erro dentro do lock para responseId ' + responseId + ': ' + e.message, e.stack);
    _adicionarNaFila(formId, responseId, payload, 'Erro no lock: ' + e.message);
    _removerIntencao(responseId);
    return respostaErro(
      'Ocorreu um erro técnico ao registrar sua resposta. ' +
      'Ela foi salva e será processada automaticamente (ID: ' + responseId.substring(0, 8) + '...). ' +
      'Não envie novamente.',
      'ERRO_LOCK_FILA'
    );
  } finally {
    if (lockObtido) {
      try { lock.releaseLock(); } catch (ignore) { /* Silencioso */ }
    }
  }
}

// ============================================================
// REGISTRO DE INTENÇÃO (GARANTIA DE ENTREGA)
// ============================================================

/**
 * Registra a intenção de gravar uma resposta ANTES de qualquer I/O na planilha.
 * Usado pelo trigger de reconciliação para detectar respostas perdidas.
 * @param {string} formId
 * @param {string} responseId
 * @param {Object} payload
 * @private
 */
function _registrarIntencao(formId, responseId, payload) {
  try {
    // CacheService: janela de 10 minutos (suficiente para o processo completar)
    CacheService.getScriptCache().put(
      'intencao_' + responseId,
      JSON.stringify({ formId: formId, ts: Date.now() }),
      600 // 10 minutos
    );
  } catch (e) {
    logEvento(formId, NIVEL_LOG.WARN, 'Falha ao gravar no CacheService (não crítico): ' + e.message);
  }

  const lock = LockService.getScriptLock();
  let lockObtido = false;
  try {
    lockObtido = lock.tryLock(3000); // Timeout curto de 3s para o envio do usuário
  } catch (err) {
    // Silencioso, lockObtido continuará false
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const info = {
      formId: formId,
      registradoEm: new Date().toISOString(),
      payload: JSON.stringify(payload)
    };
    props.setProperty('INTENCAO_' + responseId, JSON.stringify(info));
  } catch (e) {
    // Não bloquear o fluxo do usuário se o registro de intenção falhar (degradação graciosa)
    logEvento(formId, NIVEL_LOG.WARN, 'Falha ao registrar intenção no PropertiesService (não crítico): ' + e.message);
  } finally {
    if (lockObtido) {
      try { lock.releaseLock(); } catch (ignore) {}
    }
  }
}

/**
 * Remove o registro de intenção após gravação confirmada.
 * @param {string} responseId
 * @private
 */
function _removerIntencao(responseId) {
  try {
    CacheService.getScriptCache().remove('intencao_' + responseId);
  } catch (e) {
    /* Silencioso */
  }

  const lock = LockService.getScriptLock();
  let lockObtido = false;
  try {
    lockObtido = lock.tryLock(3000); // Timeout curto de 3s
  } catch (err) {
    // Silencioso
  }

  try {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty('INTENCAO_' + responseId);
  } catch (e) {
    /* Silencioso — não logar como erro para evitar ruído */
  } finally {
    if (lockObtido) {
      try { lock.releaseLock(); } catch (ignore) {}
    }
  }
}

/**
 * Verifica se um responseId já existe na aba de respostas.
 * Lê apenas a coluna responseId (coluna 1) para eficiência.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} aba
 * @param {string} responseId
 * @returns {boolean}
 * @private
 */
function _responseIdExisteNaPlanilha(aba, responseId) {
  try {
    const ultimaLinha = aba.getLastRow();
    if (ultimaLinha <= 1) return false;
    // Lê apenas a primeira coluna (responseId) — eficiente mesmo com muitas respostas
    const colResponseId = aba.getRange(2, 1, ultimaLinha - 1, 1).getValues();
    return colResponseId.some(r => r[0] === responseId);
  } catch (e) {
    return false;
  }
}

/**
 * Extrai a mensagem de confirmação do configJSON de forma segura.
 * @param {Object} form
 * @returns {string}
 * @private
 */
function _getMensagemConfirmacao(form) {
  try {
    const config = typeof form.configJSON === 'string'
      ? JSON.parse(form.configJSON)
      : form.configJSON;
    return (config && config.configuracoes && config.configuracoes.mensagemConfirmacao)
      ? config.configuracoes.mensagemConfirmacao
      : '<h3>Obrigado!</h3><p>Sua resposta foi registrada com sucesso.</p>';
  } catch (e) {
    return '<h3>Obrigado!</h3><p>Sua resposta foi registrada com sucesso.</p>';
  }
}

// ============================================================
// REVALIDAÇÃO SERVER-SIDE
// ============================================================

/**
 * Revalida todas as respostas server-side.
 * Nunca confiar no cliente.
 * @param {Object} configJSON - Configuração do formulário
 * @param {Object} respostas - Mapa questionId → valor
 * @returns {{ok: boolean, error?: string, erros?: Object}}
 * @private
 */
function _revalidarRespostas(configJSON, respostas) {
  const erros = {};
  const todasPerguntas = [];

  (configJSON.secoes || []).forEach(secao => {
    (secao.perguntas || []).forEach(p => todasPerguntas.push(p));
  });

  todasPerguntas.forEach(pergunta => {
    if (pergunta.tipo === TIPO_PERGUNTA.SOMENTE_LEITURA) return;

    const valor = respostas[pergunta.id];
    const vazio = valor === undefined || valor === null || String(valor).trim() === '';

     // Verificar obrigatoriedade
     const deveSerObrigatorio = pergunta.obrigatoria || pergunta.tipo === 'ACEITE_TERMOS';
     if (deveSerObrigatorio && vazio) {
       erros[pergunta.id] = pergunta.tipo === 'ACEITE_TERMOS'
         ? 'Você deve aceitar os termos para prosseguir.'
         : 'Este campo é obrigatório.';
       return;
     }

    if (vazio) return; // Campo opcional vazio — OK

    // Validações por tipo
    switch (pergunta.tipo) {
      case TIPO_PERGUNTA.RESPOSTA_CURTA:
        const erroValidacao = _validarTipoResposta(valor, pergunta.validacao);
        if (erroValidacao) erros[pergunta.id] = erroValidacao;
        break;

      case TIPO_PERGUNTA.PARAGRAFO:
        const limiteChars = pergunta.config && pergunta.config.limiteCaracteres;
        if (limiteChars && String(valor).length > limiteChars) {
          erros[pergunta.id] = 'Texto excede o limite de ' + limiteChars + ' caracteres.';
        }
        break;

      case TIPO_PERGUNTA.CAIXAS_SELECAO:
        const selecionados = Array.isArray(valor) ? valor.length : 0;
        const minSel = pergunta.config && pergunta.config.minSelecoes;
        const maxSel = pergunta.config && pergunta.config.maxSelecoes;
        if (minSel && selecionados < minSel) {
          erros[pergunta.id] = 'Selecione pelo menos ' + minSel + ' opção(ões).';
        }
        if (maxSel && selecionados > maxSel) {
          erros[pergunta.id] = 'Selecione no máximo ' + maxSel + ' opção(ões).';
        }
        break;

      case TIPO_PERGUNTA.ESCALA_LINEAR:
      case TIPO_PERGUNTA.AVALIACAO_ESTRELAS:
      case TIPO_PERGUNTA.SLIDER_NUMERICO:
        if (!validarNumero(valor)) {
          erros[pergunta.id] = 'Valor numérico inválido.';
        }
        break;
    }
  });

  if (Object.keys(erros).length > 0) {
    return { ok: false, error: 'Existem campos inválidos.', erros: erros, codigo: 'VALIDACAO_FALHOU' };
  }

  return { ok: true };
}

/**
 * Valida um valor de resposta curta contra seu tipo de validação.
 * @param {string} valor
 * @param {Object} validacao - Configuração de validação da pergunta
 * @returns {string|null} Mensagem de erro ou null se válido
 * @private
 */
function _validarTipoResposta(valor, validacao) {
  if (!validacao || validacao.tipo === TIPO_VALIDACAO.LIVRE) return null;

  switch (validacao.tipo) {
    case TIPO_VALIDACAO.EMAIL:
      return validarEmail(valor) ? null : 'E-mail inválido.';
    case TIPO_VALIDACAO.TELEFONE:
      return validarTelefoneBR(valor) ? null : 'Telefone inválido. Use (XX) XXXXX-XXXX.';
    case TIPO_VALIDACAO.CPF:
      return validarCPF(valor) ? null : 'CPF inválido.';
    case TIPO_VALIDACAO.CNPJ:
      return validarCNPJ(valor) ? null : 'CNPJ inválido.';
    case TIPO_VALIDACAO.CEP:
      return validarCEP(valor) ? null : 'CEP inválido.';
    case TIPO_VALIDACAO.NUMERO:
      return validarNumero(valor) ? null : 'Apenas números são permitidos.';
    case TIPO_VALIDACAO.REGEX:
      if (!validacao.regex) return null;
      return validarRegex(valor, validacao.regex) ? null
        : (validacao.mensagemErro || 'Formato inválido.');
    default:
      return null;
  }
}

// ============================================================
// RESPOSTA ÚNICA POR PESSOA
// ============================================================

/**
 * Verifica se o respondente já enviou resposta (quando configurado).
 * @param {string} formId
 * @param {Object} configJSON
 * @param {Object} payload
 * @returns {{ok: boolean, error?: string}}
 * @private
 */
function _verificarRespostaUnica(formId, configJSON, payload) {
  const cfg = configJSON.configuracoes;
  if (!cfg || !cfg.respostaUnica) return { ok: true };

  // Verificar por campo único (CPF ou email)
  const campoId = cfg.campoRespostaUnica;
  if (campoId && payload.respostas && payload.respostas[campoId]) {
    const valorCampo = String(payload.respostas[campoId]).trim().toLowerCase();
    const hashCampo = hashSHA256(formId + '_' + valorCampo);

    const cache = CacheService.getScriptCache();
    const chave = 'resp_unica_' + hashCampo;

    // Verificar também na planilha (cache pode ter expirado)
    if (cache.get(chave) || _verificarDuplicataAPlanilha(formId, campoId, valorCampo)) {
      return respostaErro(
        'Você já enviou uma resposta para este formulário.',
        'RESPOSTA_DUPLICADA'
      );
    }

  }

  return { ok: true };
}

/**
 * Verifica duplicata diretamente na planilha de respostas.
 * Usado como fallback quando cache expirou.
 * @param {string} formId
 * @param {string} campoId - ID da pergunta a verificar
 * @param {string} valor - Valor a buscar
 * @returns {boolean}
 * @private
 */
function _verificarDuplicataAPlanilha(formId, campoId, valor) {
  try {
    const info = _obterInfoPlanilha(formId);
    if (!info.planilhaId) return false;

    const ss = SpreadsheetApp.openById(info.planilhaId);
    const aba = ss.getSheetByName('Respostas');
    if (!aba || aba.getLastRow() <= 1) return false;

    const colIdx = _obterColunaPorId(aba, campoId);
    if (colIdx === -1) return false;

    const dados = aba.getRange(2, colIdx + 1, aba.getLastRow() - 1, 1).getValues();
    return dados.some(r => String(r[0]).trim().toLowerCase() === valor);
  } catch (e) {
    return false;
  }
}

// ============================================================
// FILA DE CONTINGÊNCIA
// ============================================================

/**
 * Adiciona uma resposta na fila de contingência (aba FILA).
 * @param {string} formId
 * @param {string} responseId
 * @param {Object} payload
 * @param {string} motivo - Motivo do enfileiramento
 * @private
 */
function _adicionarNaFila(formId, responseId, payload, motivo) {
  try {
    const ss = obterPlanilhaMestre_();
    const aba = ss.getSheetByName(ABA.FILA);
    aba.appendRow([
      responseId,
      formId,
      JSON.stringify(payload),
      0, // tentativas
      STATUS_FILA.PENDENTE,
      formatarDataBR(new Date()),
      motivo || '',
    ]);
    logEvento(formId, NIVEL_LOG.WARN,
      'Resposta enfileirada. responseId: ' + responseId + '. Motivo: ' + motivo);
  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR,
      'CRÍTICO: Falha ao enfileirar resposta: ' + e.message, e.stack);
  }
}

// ============================================================
// EDITAR RESPOSTA (LINK DE EDIÇÃO)
// ============================================================

/**
 * Gera um link de edição para uma resposta existente.
 * @param {string} formId
 * @param {string} responseId
 * @returns {{ok: boolean, data?: {url: string}, error?: string}}
 */
function gerarLinkEdicao(formId, responseId) {
  try {
    const token = gerarUUID();
    CacheService.getScriptCache().put(
      'edicao_' + token,
      JSON.stringify({ formId, responseId }),
      21600 // 6h
    );
    const url = ScriptApp.getService().getUrl() +
      '?form=' + formId + '&editar=' + token;
    return respostaOk({ url: url });
  } catch (e) {
    return respostaErro('Erro ao gerar link de edição.', 'ERRO_LINK_EDICAO');
  }
}

/**
 * Carrega uma resposta existente para edição, dado um token.
 * @param {string} token - Token de edição
 * @returns {{ok: boolean, data?: Object, error?: string}}
 */
function carregarRespostaParaEdicao(token) {
  try {
    const dados = CacheService.getScriptCache().get('edicao_' + token);
    if (!dados) {
      return respostaErro('Link de edição expirado ou inválido.', 'TOKEN_INVALIDO');
    }

    const { formId, responseId } = JSON.parse(dados);
    const info = _obterInfoPlanilha(formId);
    const ss = SpreadsheetApp.openById(info.planilhaId);
    const aba = ss.getSheetByName('Respostas');

    const colResponseId = _obterColunaPorId(aba, 'responseId');
    if (colResponseId === -1) return respostaErro('Planilha de respostas com estrutura inválida.', 'PLANILHA_INVALIDA');
    const dados2 = aba.getDataRange().getValues();
    const linhaDados = dados2.find(r => r[colResponseId] === responseId);

    if (!linhaDados) return respostaErro('Resposta não encontrada.', 'RESPOSTA_NAO_ENCONTRADA');

    const colunas = aba.getLastColumn();
    const rangeHeader = aba.getRange(1, 1, 1, colunas);
    const cabecalhos = rangeHeader.getValues()[0];
    const notas = rangeHeader.getNotes()[0];

    const obj = {};
    cabecalhos.forEach((chave, idx) => {
      const questionId = notas[idx] || chave; // Fallback para cabeçalho sem nota
      obj[questionId] = linhaDados[idx] !== undefined ? linhaDados[idx] : '';
    });

    return respostaOk({ formId, responseId, respostas: obj });
  } catch (e) {
    return respostaErro('Erro ao carregar resposta para edição. ' + e.message, 'ERRO_EDICAO');
  }
}

// ============================================================
// HELPERS INTERNOS
// ============================================================

/**
 * Obtém informações da planilha de um formulário a partir da aba FORMS.
 * @param {string} formId
 * @returns {{planilhaId: string, urlPlanilha: string, pastaId: string, titulo: string}}
 * @private
 */
function _obterInfoPlanilha(formId) {
  const linha = _encontrarLinhaForm(formId);
  if (!linha) throw new Error('Formulário não encontrado: ' + formId);
  const obj = _linhaParaObjeto(linha);

  // Verificar e recriar planilha se necessário
  if (obj.planilhaId) {
    const info = verificarPlanilhaExiste(
      obj.planilhaId, formId, obj.titulo, obj.pastaId,
      _extrairCabecalhosDoForm(obj.configJSON)
    );
    if (info.recriada) {
      editarFormulario(formId, {
        planilhaId: info.planilhaId,
        urlPlanilha: info.urlPlanilha,
      });
      return { planilhaId: info.planilhaId, urlPlanilha: info.urlPlanilha, pastaId: obj.pastaId, titulo: obj.titulo };
    }
  }

  return {
    planilhaId: obj.planilhaId,
    urlPlanilha: obj.urlPlanilha,
    pastaId: obj.pastaId,
    titulo: obj.titulo,
  };
}

/**
 * Incrementa o contador de respostas na aba FORMS.
 * @param {string} formId
 * @private
 */
function _incrementarContador(formId) {
  try {
    const { numLinha } = _encontrarLinhaComIndice(formId);
    if (numLinha === -1) return;

    const ss = obterPlanilhaMestre_();
    const aba = ss.getSheetByName(ABA.FORMS);
    const colTotal = CABECALHO_FORMS.indexOf('totalRespostas') + 1;
    const atual = aba.getRange(numLinha, colTotal).getValue() || 0;
    aba.getRange(numLinha, colTotal).setValue(parseInt(atual) + 1);
  } catch (e) {
    logEvento(formId, NIVEL_LOG.WARN, 'Falha ao incrementar contador: ' + e.message);
  }
}

/**
 * Verifica se o formulário atingiu o limite e encerra automaticamente.
 * @param {string} formId
 * @param {Object} form
 * @private
 */
function _verificarLimiteEEncerrar(formId, form) {
  try {
    const limite = parseInt(form.limiteRespostas) || 0;
    if (limite <= 0) return;

    const total = parseInt(form.totalRespostas) || 0;
    if (total + 1 >= limite) {
      alterarStatus(formId, STATUS.ENCERRADO);
      logEvento(formId, NIVEL_LOG.INFO,
        'Formulário encerrado automaticamente: limite de ' + limite + ' respostas atingido.');
    }
  } catch (e) {
    /* Silencioso */
  }
}

/**
 * Enfileira notificação para o admin se configurado.
 * @param {string} formId
 * @param {Object} configJSON
 * @param {string} responseId
 * @param {string} timestamp
 * @private
 */
function _enfileirarNotificacao(formId, configJSON, responseId, timestamp) {
  try {
    const cfg = configJSON && configJSON.configuracoes;
    if (!cfg || !cfg.notificarAdmin || cfg.modoNotificacao === MODO_NOTIFICACAO.DESATIVADO) return;

    const props = PropertiesService.getScriptProperties();
    const filaNotifsJson = props.getProperty('NOTIF_QUEUE') || '[]';
    const fila = JSON.parse(filaNotifsJson);
    fila.push({ formId, responseId, timestamp, modo: cfg.modoNotificacao });

    // Processar imediatamente se CADA_RESPOSTA
    if (cfg.modoNotificacao === MODO_NOTIFICACAO.CADA_RESPOSTA) {
      _enviarNotificacaoImediata(formId, responseId, timestamp);
    } else {
      props.setProperty('NOTIF_QUEUE', JSON.stringify(fila));
    }
  } catch (e) {
    /* Silencioso — notificação não é crítica */
  }
}

/**
 * Envia e-mail de notificação imediata ao admin.
 * @param {string} formId
 * @param {string} responseId
 * @param {string} timestamp
 * @private
 */
function _enviarNotificacaoImediata(formId, responseId, timestamp) {
  try {
    const config = obterConfig();
    const emailAdmin = config['emailAdmin'];
    if (!emailAdmin) return;

    const urlDash = ScriptApp.getService().getUrl() + '?page=dash&form=' + formId;

    MailApp.sendEmail({
      to: emailAdmin,
      subject: '[SETUR Forms] Nova resposta: ' + formId,
      htmlBody: `
        <h2>Nova resposta recebida</h2>
        <p><strong>Formulário:</strong> ${formId}</p>
        <p><strong>Resposta ID:</strong> ${responseId}</p>
        <p><strong>Data/hora:</strong> ${timestamp}</p>
        <p><a href="${urlDash}">Ver todas as respostas no dashboard</a></p>
      `,
    });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.WARN, 'Falha ao enviar e-mail de notificação: ' + e.message);
  }
}

/**
 * Salva a resposta no cache de resposta única.
 * @param {string} formId
 * @param {Object|string} configJSON
 * @param {Object} payload
 * @private
 */
function _registrarRespostaUnicaCache(formId, configJSON, payload) {
  try {
    const cfg = typeof configJSON === 'string' ? JSON.parse(configJSON) : configJSON;
    const c = cfg && cfg.configuracoes;
    if (!c || !c.respostaUnica) return;
    const campoId = c.campoRespostaUnica;
    if (campoId && payload.respostas && payload.respostas[campoId]) {
      const valorCampo = String(payload.respostas[campoId]).trim().toLowerCase();
      const hashCampo = hashSHA256(formId + '_' + valorCampo);
      CacheService.getScriptCache().put('resp_unica_' + hashCampo, '1', 21600); // 6h cache
    }
  } catch (e) {
    /* Silencioso */
  }
}

/**
 * Retorna o índice (0-based) da coluna que corresponde ao questionId.
 * Busca nas notas da célula (linha 1) primeiro, depois no texto.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} aba
 * @param {string} questionId
 * @returns {number} Índice ou -1 se não encontrado
 * @private
 */
function _obterColunaPorId(aba, questionId) {
  try {
    const colunas = aba.getLastColumn();
    if (colunas === 0) return -1;
    
    const rangeHeader = aba.getRange(1, 1, 1, colunas);
    const notas = rangeHeader.getNotes()[0];
    
    // 1. Buscar nas notas do cabeçalho
    const idxNota = notas.indexOf(questionId);
    if (idxNota >= 0) return idxNota;
    
    // 2. Fallback para os valores de texto do cabeçalho
    const valores = rangeHeader.getValues()[0];
    return valores.indexOf(questionId);
  } catch(e) {
    return -1;
  }
}
