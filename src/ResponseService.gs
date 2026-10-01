/**
 * @fileoverview NÃºcleo de gravaÃ§Ã£o de respostas do SETUR Forms GAS.
 * ValidaÃ§Ã£o dupla, LockService, sanitizaÃ§Ã£o, fila de contingÃªncia.
 */

// ============================================================
// RECEBER RESPOSTA (PONTO DE ENTRADA PRINCIPAL)
// ============================================================

/**
 * Recebe e grava uma resposta de formulÃ¡rio.
 * Pipeline: validar nonce â†’ anti-bot â†’ revalidar â†’ lock â†’ sanitizar â†’ gravar.
 * @param {string} formId - ID do formulÃ¡rio
 * @param {Object} payload - Dados da resposta
 * @param {Object} payload.respostas - Mapa questionId â†’ valor
 * @param {string} payload.nonce - Token Ãºnico de submissÃ£o
 * @param {string} payload.honeypot - Campo honeypot (deve estar vazio)
 * @param {number} payload.tempoPreenchimento - Segundos desde o carregamento
 * @param {string} [payload.userAgent] - User-Agent do cliente
 * @returns {{ok: boolean, data?: Object, error?: string}}
 */
function receberResposta(formId, payload) {
  const responseId = gerarUUID();

  try {
    // â”€â”€ 1. Honeypot anti-bot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (payload.honeypot && payload.honeypot !== '') {
      logEvento(formId, NIVEL_LOG.WARN, 'Honeypot preenchido â€” provÃ¡vel bot rejeitado.');
      return respostaErro('SubmissÃ£o invÃ¡lida.', 'BOT_DETECTADO');
    }

    // â”€â”€ 2. Tempo mÃ­nimo de preenchimento â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const config = obterConfig();
    const tempoMin = parseInt(config['tempoMinimoResposta']) || 5;
    if ((payload.tempoPreenchimento || 0) < tempoMin) {
      logEvento(formId, NIVEL_LOG.WARN,
        'Resposta muito rÃ¡pida (' + payload.tempoPreenchimento + 's). PossÃ­vel bot.');
      return respostaErro('SubmissÃ£o muito rÃ¡pida. Por favor, aguarde.', 'MUITO_RAPIDO');
    }

    // â”€â”€ 3. Validar e invalidar nonce â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!validarNonce(formId, payload.nonce)) {
      logEvento(formId, NIVEL_LOG.WARN, 'Nonce invÃ¡lido ou jÃ¡ usado. responseId: ' + responseId);
      return respostaErro('Esta submissÃ£o jÃ¡ foi processada ou expirou. Recarregue a pÃ¡gina.', 'NONCE_INVALIDO');
    }

    // â”€â”€ 4. Obter e verificar o formulÃ¡rio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const formResult = obterFormularioPublico(formId);
    if (!formResult.ok) return formResult;
    const form = formResult.data;

    // â”€â”€ 5. Verificar resposta Ãºnica por pessoa â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const verificacaoUnica = _verificarRespostaUnica(formId, form.configJSON, payload);
    if (!verificacaoUnica.ok) return verificacaoUnica;

    // â”€â”€ 6. RevalidaÃ§Ã£o server-side completa â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const validacao = _revalidarRespostas(form.configJSON, payload.respostas);
    if (!validacao.ok) return validacao;

    // â”€â”€ 7. Gravar com LockService â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const resultado = _gravarComLock(formId, responseId, form, payload);
    return resultado;

  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR, 'Erro ao receber resposta: ' + e.message, e.stack);
    // Tentar salvar na fila de contingÃªncia
    _adicionarNaFila(formId, responseId, payload, e.message);
    return respostaErro(
      'Ocorreu um erro ao registrar sua resposta. Ela foi salva e serÃ¡ processada em breve.',
      'ERRO_GRAVACAO_CONTINGENCIA'
    );
  }
}

// ============================================================
// NONCE (TOKEN ÃšNICO DE SUBMISSÃƒO)
// ============================================================

/**
 * Gera e armazena um nonce de submissÃ£o Ãºnico para um formulÃ¡rio.
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
 * Valida e invalida um nonce (uso Ãºnico).
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
    cache.remove(chave); // Invalidar â€” uso Ãºnico
    return true;
  }
  return false;
}

// ============================================================
// GRAVAÃ‡ÃƒO COM LOCK â€” PADRÃƒO: INTENÃ‡ÃƒO â†’ WRITE â†’ FLUSH â†’ VERIFY â†’ CONFIRM
// ============================================================

/**
 * Grava a resposta na planilha com garantia de entrega.
 *
 * Fluxo de garantia de entrega em 5 etapas:
 *  1. INTENÃ‡ÃƒO  â€” registra responseId no CacheService ANTES de qualquer escrita
 *                 Se o processo morrer aqui, o trigger detecta e reprocessa
 *  2. WRITE     â€” appendRow com LockService (sem corrupÃ§Ã£o por concorrÃªncia)
 *  3. FLUSH     â€” SpreadsheetApp.flush() forÃ§a commit fÃ­sico na API
 *  4. VERIFY    â€” lÃª de volta a linha pelo responseId para confirmar presenÃ§a
 *  5. CONFIRM   â€” sÃ³ retorna ok:true apÃ³s verificaÃ§Ã£o positiva
 *                 Se verificaÃ§Ã£o falhar â†’ retry â†’ fila â†’ nunca ok:true sem dados
 *
 * @param {string} formId
 * @param {string} responseId
 * @param {Object} form - Dados do formulÃ¡rio
 * @param {Object} payload - Payload da resposta
 * @returns {{ok: boolean, data?: Object, error?: string}}
 * @private
 */
function _gravarComLock(formId, responseId, form, payload) {

  // â”€â”€ ETAPA 1: REGISTRAR INTENÃ‡ÃƒO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Antes de qualquer I/O na planilha, marcamos a intenÃ§Ã£o no cache.
  // Se o processo morrer entre aqui e o CONFIRM, o trigger detecta
  // respostas sem par na planilha e reprocessa da fila.
  _registrarIntencao(formId, responseId, payload);

  // â”€â”€ ETAPA 2: OBTER LOCK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
          'LockService timeout apÃ³s ' + LIMITE.MAX_RETRIES_LOCK + ' tentativas. responseId: ' + responseId);
        // IntenÃ§Ã£o jÃ¡ registrada â†’ fila vai processar
        _adicionarNaFila(formId, responseId, payload, 'Lock timeout apÃ³s retries');
        // Limpa intenÃ§Ã£o pois a fila assumiu a responsabilidade
        _removerIntencao(responseId);
        return respostaErro(
          'O sistema recebeu sua resposta, mas estÃ¡ processando muitos envios simultÃ¢neos. ' +
          'Sua resposta (ID: ' + responseId.substring(0, 8) + '...) foi salva e serÃ¡ registrada em atÃ© 5 minutos. ' +
          'VocÃª pode fechar esta pÃ¡gina com seguranÃ§a.',
          'LOCK_TIMEOUT_FILA'
        );
      }
      Utilities.sleep(LIMITE.BACKOFF_BASE_MS * Math.pow(2, tentativaLock - 1));
    }
  }

  try {
    // â”€â”€ ETAPA 2 (cont): VERIFICAR SE JÃ FOI GRAVADA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // ProteÃ§Ã£o extra: se por algum motivo o mesmo responseId jÃ¡ chegou
    // (ex: retry do cliente), nÃ£o duplicar.
    const { planilhaId } = _obterInfoPlanilha(formId);
    const ss = SpreadsheetApp.openById(planilhaId);
    const aba = ss.getSheetByName('Respostas');

    if (_responseIdExisteNaPlanilha(aba, responseId)) {
      logEvento(formId, NIVEL_LOG.WARN,
        'responseId jÃ¡ existia na planilha (submissÃ£o duplicada ignorada): ' + responseId);
      _removerIntencao(responseId);
      // Retornar sucesso pois a resposta JÃ estÃ¡ gravada
      const timestamp = formatarDataBR(new Date());
      return respostaOk({
        responseId: responseId,
        timestamp: timestamp,
        mensagemConfirmacao: _getMensagemConfirmacao(form),
      });
    }

    // â”€â”€ ETAPA 3: ESCREVER (dentro do lock) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const ultimaColuna = aba.getLastColumn();
    const rangeHeader = aba.getRange(1, 1, 1, ultimaColuna);
    const cabecalhos = rangeHeader.getValues()[0];
    const notasCabecalhos = rangeHeader.getNotes()[0];
    const respostasSanitizadas = sanitizarRespostas(payload.respostas || {});
    const timestamp = formatarDataBR(new Date());

    // VersÃ£o real do formulÃ¡rio (gravada no configJSON pelo admin), com fallback
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

    // â”€â”€ ETAPA 4: FLUSH FÃSICO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // ForÃ§a o commit de todas as alteraÃ§Ãµes pendentes na API do Sheets
    // ANTES de verificar. Sem isso, getValues() poderia retornar cache stale.
    SpreadsheetApp.flush();

    // â”€â”€ ETAPA 5: VERIFICAR PRESENÃ‡A NA PLANILHA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // LÃª de volta para confirmar que a linha estÃ¡ realmente persistida.
    const gravado = _responseIdExisteNaPlanilha(aba, responseId);

    if (!gravado) {
      logEvento(formId, NIVEL_LOG.WARN,
        'VERIFY falhou na 1Âª tentativa para responseId: ' + responseId + '. Aguardando propagaÃ§Ã£o...');

      Utilities.sleep(1000); // Espera 1s para propagaÃ§Ã£o do Sheets
      SpreadsheetApp.flush();

      // Verificar se a linha apareceu apÃ³s a espera (sem duplicar)
      if (_responseIdExisteNaPlanilha(aba, responseId)) {
        logEvento(formId, NIVEL_LOG.INFO,
          'VERIFY corrigido na 2Âª tentativa de leitura para responseId: ' + responseId);
      } else {
        logEvento(formId, NIVEL_LOG.WARN,
          'VERIFY falhou na 2Âª leitura. Executando appendRow novamente para: ' + responseId);
        aba.appendRow(linhaDados);
        SpreadsheetApp.flush();

        const gravadoRetry = _responseIdExisteNaPlanilha(aba, responseId);

        if (!gravadoRetry) {
          logEvento(formId, NIVEL_LOG.ERROR,
            'CRÃTICO: appendRow+flush executados mas responseId nÃ£o encontrado na planilha: ' + responseId);
          _adicionarNaFila(formId, responseId, payload, 'Verify falhou apÃ³s retry');
          _removerIntencao(responseId);
          return respostaErro(
            'Sua resposta foi recebida mas tivemos dificuldade tÃ©cnica ao confirmÃ¡-la. ' +
            'Ela foi salva em nosso sistema de contingÃªncia (ID: ' + responseId.substring(0, 8) + '...) ' +
            'e serÃ¡ registrada automaticamente em atÃ© 5 minutos. ' +
            'Por favor, nÃ£o envie novamente.',
            'VERIFY_FALHOU_FILA'
          );
        }
      }
    }

    // â”€â”€ CONFIRM: GRAVAÃ‡ÃƒO CONFIRMADA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // SÃ³ chegamos aqui se a linha foi lida de volta com sucesso.
    _removerIntencao(responseId);
    _incrementarContador(formId);
    _verificarLimiteEEncerrar(formId, form);
    _enfileirarNotificacao(formId, form.configJSON, responseId, timestamp);
    _registrarRespostaUnicaCache(formId, form.configJSON, payload);

    // Organizar uploads por resposta, se configurado
    _organizarUploadsPorResposta(formId, form, payload, responseId);

    logEvento(formId, NIVEL_LOG.INFO,
      'Resposta CONFIRMADA na planilha. responseId: ' + responseId);

    return respostaOk({
      responseId: responseId,
      timestamp: timestamp,
      mensagemConfirmacao: _getMensagemConfirmacao(form),
    });

  } catch (e) {
    // Erro inesperado dentro do lock â€” garantir enfileiramento
    logEvento(formId, NIVEL_LOG.ERROR,
      'Erro dentro do lock para responseId ' + responseId + ': ' + e.message, e.stack);
    _adicionarNaFila(formId, responseId, payload, 'Erro no lock: ' + e.message);
    _removerIntencao(responseId);
    return respostaErro(
      'Ocorreu um erro tÃ©cnico ao registrar sua resposta. ' +
      'Ela foi salva e serÃ¡ processada automaticamente (ID: ' + responseId.substring(0, 8) + '...). ' +
      'NÃ£o envie novamente.',
      'ERRO_LOCK_FILA'
    );
  } finally {
    if (lockObtido) {
      try { lock.releaseLock(); } catch (ignore) { /* Silencioso */ }
    }
  }
}

// ============================================================
// REGISTRO DE INTENÃ‡ÃƒO (GARANTIA DE ENTREGA)
// ============================================================

/**
 * Registra a intenÃ§Ã£o de gravar uma resposta ANTES de qualquer I/O na planilha.
 * Usado pelo trigger de reconciliaÃ§Ã£o para detectar respostas perdidas.
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
    logEvento(formId, NIVEL_LOG.WARN, 'Falha ao gravar no CacheService (nÃ£o crÃ­tico): ' + e.message);
  }

  const lock = LockService.getScriptLock();
  let lockObtido = false;
  try {
    lockObtido = lock.tryLock(3000); // Timeout curto de 3s para o envio do usuÃ¡rio
  } catch (err) {
    // Silencioso, lockObtido continuarÃ¡ false
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
    // NÃ£o bloquear o fluxo do usuÃ¡rio se o registro de intenÃ§Ã£o falhar (degradaÃ§Ã£o graciosa)
    logEvento(formId, NIVEL_LOG.WARN, 'Falha ao registrar intenÃ§Ã£o no PropertiesService (nÃ£o crÃ­tico): ' + e.message);
  } finally {
    if (lockObtido) {
      try { lock.releaseLock(); } catch (ignore) {}
    }
  }
}

/**
 * Remove o registro de intenÃ§Ã£o apÃ³s gravaÃ§Ã£o confirmada.
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
    /* Silencioso â€” nÃ£o logar como erro para evitar ruÃ­do */
  } finally {
    if (lockObtido) {
      try { lock.releaseLock(); } catch (ignore) {}
    }
  }
}

/**
 * Verifica se um responseId jÃ¡ existe na aba de respostas.
 * LÃª apenas a coluna responseId (coluna 1) para eficiÃªncia.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} aba
 * @param {string} responseId
 * @returns {boolean}
 * @private
 */
function _responseIdExisteNaPlanilha(aba, responseId) {
  try {
    const ultimaLinha = aba.getLastRow();
    if (ultimaLinha <= 1) return false;
    // LÃª apenas a primeira coluna (responseId) â€” eficiente mesmo com muitas respostas
    const colResponseId = aba.getRange(2, 1, ultimaLinha - 1, 1).getValues();
    return colResponseId.some(r => r[0] === responseId);
  } catch (e) {
    return false;
  }
}

/**
 * Extrai a mensagem de confirmaÃ§Ã£o do configJSON de forma segura.
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
// REVALIDAÃ‡ÃƒO SERVER-SIDE
// ============================================================

/**
 * Revalida todas as respostas server-side.
 * Nunca confiar no cliente.
 * @param {Object} configJSON - ConfiguraÃ§Ã£o do formulÃ¡rio
 * @param {Object} respostas - Mapa questionId â†’ valor
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
         ? 'VocÃª deve aceitar os termos para prosseguir.'
         : 'Este campo Ã© obrigatÃ³rio.';
       return;
     }

    if (vazio) return; // Campo opcional vazio â€” OK

    // ValidaÃ§Ãµes por tipo
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
          erros[pergunta.id] = 'Selecione pelo menos ' + minSel + ' opÃ§Ã£o(Ãµes).';
        }
        if (maxSel && selecionados > maxSel) {
          erros[pergunta.id] = 'Selecione no mÃ¡ximo ' + maxSel + ' opÃ§Ã£o(Ãµes).';
        }
        break;

      case TIPO_PERGUNTA.ESCALA_LINEAR:
      case TIPO_PERGUNTA.AVALIACAO_ESTRELAS:
      case TIPO_PERGUNTA.SLIDER_NUMERICO:
        if (!validarNumero(valor)) {
          erros[pergunta.id] = 'Valor numÃ©rico invÃ¡lido.';
        }
        break;
    }
  });

  if (Object.keys(erros).length > 0) {
    return { ok: false, error: 'Existem campos invÃ¡lidos.', erros: erros, codigo: 'VALIDACAO_FALHOU' };
  }

  return { ok: true };
}

/**
 * Valida um valor de resposta curta contra seu tipo de validaÃ§Ã£o.
 * @param {string} valor
 * @param {Object} validacao - ConfiguraÃ§Ã£o de validaÃ§Ã£o da pergunta
 * @returns {string|null} Mensagem de erro ou null se vÃ¡lido
 * @private
 */
function _validarTipoResposta(valor, validacao) {
  if (!validacao || validacao.tipo === TIPO_VALIDACAO.LIVRE) return null;

  switch (validacao.tipo) {
    case TIPO_VALIDACAO.EMAIL:
      return validarEmail(valor) ? null : 'E-mail invÃ¡lido.';
    case TIPO_VALIDACAO.TELEFONE:
      return validarTelefoneBR(valor) ? null : 'Telefone invÃ¡lido. Use (XX) XXXXX-XXXX.';
    case TIPO_VALIDACAO.CPF:
      return validarCPF(valor) ? null : 'CPF invÃ¡lido.';
    case TIPO_VALIDACAO.CNPJ:
      return validarCNPJ(valor) ? null : 'CNPJ invÃ¡lido.';
    case TIPO_VALIDACAO.CEP:
      return validarCEP(valor) ? null : 'CEP invÃ¡lido.';
    case TIPO_VALIDACAO.NUMERO:
      return validarNumero(valor) ? null : 'Apenas nÃºmeros sÃ£o permitidos.';
    case TIPO_VALIDACAO.REGEX:
      if (!validacao.regex) return null;
      return validarRegex(valor, validacao.regex) ? null
        : (validacao.mensagemErro || 'Formato invÃ¡lido.');
    default:
      return null;
  }
}

// ============================================================
// RESPOSTA ÃšNICA POR PESSOA
// ============================================================

/**
 * Verifica se o respondente jÃ¡ enviou resposta (quando configurado).
 * @param {string} formId
 * @param {Object} configJSON
 * @param {Object} payload
 * @returns {{ok: boolean, error?: string}}
 * @private
 */
function _verificarRespostaUnica(formId, configJSON, payload) {
  const cfg = configJSON.configuracoes;
  if (!cfg || !cfg.respostaUnica) return { ok: true };

  // Verificar por campo Ãºnico (CPF ou email)
  const campoId = cfg.campoRespostaUnica;
  if (campoId && payload.respostas && payload.respostas[campoId]) {
    const valorCampo = String(payload.respostas[campoId]).trim().toLowerCase();
    const hashCampo = hashSHA256(formId + '_' + valorCampo);

    const cache = CacheService.getScriptCache();
    const chave = 'resp_unica_' + hashCampo;

    // Verificar tambÃ©m na planilha (cache pode ter expirado)
    if (cache.get(chave) || _verificarDuplicataAPlanilha(formId, campoId, valorCampo)) {
      return respostaErro(
        'VocÃª jÃ¡ enviou uma resposta para este formulÃ¡rio.',
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
// FILA DE CONTINGÃŠNCIA
// ============================================================

/**
 * Adiciona uma resposta na fila de contingÃªncia (aba FILA).
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
      'CRÃTICO: Falha ao enfileirar resposta: ' + e.message, e.stack);
  }
}

// ============================================================
// EDITAR RESPOSTA (LINK DE EDIÃ‡ÃƒO)
// ============================================================

/**
 * Gera um link de ediÃ§Ã£o para uma resposta existente.
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
    return respostaErro('Erro ao gerar link de ediÃ§Ã£o.', 'ERRO_LINK_EDICAO');
  }
}

/**
 * Carrega uma resposta existente para ediÃ§Ã£o, dado um token.
 * @param {string} token - Token de ediÃ§Ã£o
 * @returns {{ok: boolean, data?: Object, error?: string}}
 */
function carregarRespostaParaEdicao(token) {
  try {
    const dados = CacheService.getScriptCache().get('edicao_' + token);
    if (!dados) {
      return respostaErro('Link de ediÃ§Ã£o expirado ou invÃ¡lido.', 'TOKEN_INVALIDO');
    }

    const { formId, responseId } = JSON.parse(dados);
    const info = _obterInfoPlanilha(formId);
    const ss = SpreadsheetApp.openById(info.planilhaId);
    const aba = ss.getSheetByName('Respostas');

    const colResponseId = _obterColunaPorId(aba, 'responseId');
    if (colResponseId === -1) return respostaErro('Planilha de respostas com estrutura invÃ¡lida.', 'PLANILHA_INVALIDA');
    const dados2 = aba.getDataRange().getValues();
    const linhaDados = dados2.find(r => r[colResponseId] === responseId);

    if (!linhaDados) return respostaErro('Resposta nÃ£o encontrada.', 'RESPOSTA_NAO_ENCONTRADA');

    const colunas = aba.getLastColumn();
    const rangeHeader = aba.getRange(1, 1, 1, colunas);
    const cabecalhos = rangeHeader.getValues()[0];
    const notas = rangeHeader.getNotes()[0];

    const obj = {};
    cabecalhos.forEach((chave, idx) => {
      const questionId = notas[idx] || chave; // Fallback para cabeÃ§alho sem nota
      obj[questionId] = linhaDados[idx] !== undefined ? linhaDados[idx] : '';
    });

    return respostaOk({ formId, responseId, respostas: obj });
  } catch (e) {
    return respostaErro('Erro ao carregar resposta para ediÃ§Ã£o. ' + e.message, 'ERRO_EDICAO');
  }
}

// ============================================================
// HELPERS INTERNOS
// ============================================================

/**
 * ObtÃ©m informaÃ§Ãµes da planilha de um formulÃ¡rio a partir da aba FORMS.
 * @param {string} formId
 * @returns {{planilhaId: string, urlPlanilha: string, pastaId: string, titulo: string}}
 * @private
 */
function _obterInfoPlanilha(formId) {
  const linha = _encontrarLinhaForm(formId);
  if (!linha) throw new Error('FormulÃ¡rio nÃ£o encontrado: ' + formId);
  const obj = _linhaParaObjeto(linha);

  // Verificar e recriar planilha se necessÃ¡rio
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
 * Verifica se o formulÃ¡rio atingiu o limite e encerra automaticamente.
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
        'FormulÃ¡rio encerrado automaticamente: limite de ' + limite + ' respostas atingido.');
    }
  } catch (e) {
    /* Silencioso */
  }
}

/**
 * Enfileira notificaÃ§Ã£o para o admin se configurado.
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
    /* Silencioso â€” notificaÃ§Ã£o nÃ£o Ã© crÃ­tica */
  }
}

/**
 * Envia e-mail de notificaÃ§Ã£o imediata ao admin.
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
        <p><strong>FormulÃ¡rio:</strong> ${formId}</p>
        <p><strong>Resposta ID:</strong> ${responseId}</p>
        <p><strong>Data/hora:</strong> ${timestamp}</p>
        <p><a href="${urlDash}">Ver todas as respostas no dashboard</a></p>
      `,
    });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.WARN, 'Falha ao enviar e-mail de notificaÃ§Ã£o: ' + e.message);
  }
}

/**
 * Salva a resposta no cache de resposta Ãºnica.
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
 * Retorna o Ã­ndice (0-based) da coluna que corresponde ao questionId.
 * Busca nas notas da cÃ©lula (linha 1) primeiro, depois no texto.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} aba
 * @param {string} questionId
 * @returns {number} Ãndice ou -1 se nÃ£o encontrado
 * @private
 */
function _obterColunaPorId(aba, questionId) {
  try {
    const colunas = aba.getLastColumn();
    if (colunas === 0) return -1;
    
    const rangeHeader = aba.getRange(1, 1, 1, colunas);
    const notas = rangeHeader.getNotes()[0];
    
    // 1. Buscar nas notas do cabeÃ§alho
    const idxNota = notas.indexOf(questionId);
    if (idxNota >= 0) return idxNota;
    
    // 2. Fallback para os valores de texto do cabeÃ§alho
    const valores = rangeHeader.getValues()[0];
    return valores.indexOf(questionId);
  } catch(e) {
    return -1;
  }
}


/**
 * Move os arquivos enviados para uma subpasta especifica da resposta.
 * @param {string} formId
 * @param {Object} form
 * @param {Object} payload
 * @param {string} responseId
 * @private
 */
function _organizarUploadsPorResposta(formId, form, payload, responseId) {
  try {
    const cfg = typeof form.configJSON === 'string' ? JSON.parse(form.configJSON) : (form.configJSON || {});
    if (!cfg.configuracoes || cfg.configuracoes.agruparUploadsPor !== 'RESPOSTA') return;

    const campoNomePasta = cfg.configuracoes.campoNomePasta || 'responseId';
    let nomePasta = payload.respostas[campoNomePasta] || responseId;
    nomePasta = String(nomePasta).trim().replace(/[\/\\:*?"<>|]/g, '-');

    const uploadsFolderId = _obterUploadsFolderId(form.pastaId);
    const pastaUploads = DriveApp.getFolderById(uploadsFolderId);
    const subpasta = _obterOuCriarSubpasta(pastaUploads, nomePasta);

    const urlsUpload = [];
    Object.values(payload.respostas || {}).forEach(val => {
      if (typeof val === 'string' && val.includes('drive.google.com/file/d/')) {
        urlsUpload.push(val);
      }
      if (Array.isArray(val)) {
        val.forEach(v => {
          if (typeof v === 'string' && v.includes('drive.google.com/file/d/')) urlsUpload.push(v);
        });
      }
    });

    urlsUpload.forEach(url => {
      const fileId = _extrairFileId(url);
      if (fileId) {
        try {
          const arquivo = DriveApp.getFileById(fileId);
          arquivo.moveTo(subpasta);
        } catch (e) {
          logEvento(formId, NIVEL_LOG.WARN, 'Nao foi possivel mover o arquivo ' + fileId + ' para a subpasta.');
        }
      }
    });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR, 'Erro ao organizar uploads por resposta: ' + e.message);
  }
}

