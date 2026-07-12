/**
 * @fileoverview Triggers periódicos do SETUR Forms GAS.
 * Processamento de fila, encerramento programado, notificações agrupadas.
 */

// ============================================================
// PROCESSAR FILA DE CONTINGÊNCIA
// ============================================================

/**
 * Processa itens pendentes na fila de contingência (aba FILA).
 * Executado a cada 5 minutos pelo trigger periódico.
 */
function processarFila() {
  const ss = obterPlanilhaMestre_();
  const aba = ss.getSheetByName(ABA.FILA);

  if (!aba || aba.getLastRow() <= 1) return;

  const dados = aba.getDataRange().getValues();
  const cabecalhos = dados[0];
  const itens = dados.slice(1);

  let processados = 0;
  const agora = formatarDataBR(new Date());

  itens.forEach((linha, idx) => {
    const numLinha = idx + 2; // +2: 1-based + cabeçalho
    const status = linha[cabecalhos.indexOf('status')];
    const tentativas = parseInt(linha[cabecalhos.indexOf('tentativas')]) || 0;

    if (status !== STATUS_FILA.PENDENTE) return;
    if (tentativas >= LIMITE.MAX_FILA_TENTATIVAS) {
      aba.getRange(numLinha, cabecalhos.indexOf('status') + 1).setValue(STATUS_FILA.FALHA);
      logEvento(
        linha[cabecalhos.indexOf('formId')],
        NIVEL_LOG.ERROR,
        'Item da fila falhou após ' + LIMITE.MAX_FILA_TENTATIVAS + ' tentativas. ID: ' +
        linha[cabecalhos.indexOf('id')]
      );
      return;
    }

    const formId = linha[cabecalhos.indexOf('formId')];
    const payloadStr = linha[cabecalhos.indexOf('payload')];
    const itemId = linha[cabecalhos.indexOf('id')];

    try {
      const payload = JSON.parse(payloadStr);

      // Tentar gravar diretamente (sem nonce nesta tentativa — já validado antes)
      const form = obterFormularioPublico(formId);
      if (!form.ok) {
        throw new Error('Formulário não disponível: ' + form.error);
      }

      const resultado = _gravarComLock(formId, itemId, form.data, payload);

      if (resultado.ok) {
        aba.getRange(numLinha, cabecalhos.indexOf('status') + 1).setValue(STATUS_FILA.PROCESSADO);
        logEvento(formId, NIVEL_LOG.INFO, 'Item da fila processado com sucesso. ID: ' + itemId);
        processados++;
      } else {
        throw new Error(resultado.error);
      }
    } catch (e) {
      // Incrementar tentativas
      aba.getRange(numLinha, cabecalhos.indexOf('tentativas') + 1).setValue(tentativas + 1);
      aba.getRange(numLinha, cabecalhos.indexOf('erro') + 1).setValue(e.message);
      logEvento(formId, NIVEL_LOG.WARN,
        'Tentativa ' + (tentativas + 1) + ' falhou para fila ID ' + itemId + ': ' + e.message);
    }
  });

  if (processados > 0) {
    logEvento('SYSTEM', NIVEL_LOG.INFO, 'Fila processada: ' + processados + ' itens concluídos.');
  }
}

// ============================================================
// ENCERRAMENTO/ATIVAÇÃO PROGRAMADA
// ============================================================

/**
 * Verifica todos os formulários ativos/rascunhos e aplica
 * encerramento ou ativação automática baseada em datas.
 * Executado a cada 10 minutos pelo trigger periódico.
 */
function verificarEncerramentoProgramado() {
  try {
    const ss = obterPlanilhaMestre_();
    const aba = ss.getSheetByName(ABA.FORMS);
    const dados = aba.getDataRange().getValues();

    if (dados.length <= 1) return;

    const cabecalhos = dados[0];
    const agora = new Date();

    dados.slice(1).forEach((linha, idx) => {
      const numLinha = idx + 2;
      const obj = _arrayParaObjeto(cabecalhos, linha);

      if (String(obj.excluido) === 'true') return;

      const formId = obj.formId;
      if (!formId) return;

      const status = obj.status;

      // ── Ativação por data de início ──────────────────────
      if (status === STATUS.RASCUNHO && obj.dataInicio) {
        const inicio = parseDateInFuso(obj.dataInicio);
        if (inicio && !isNaN(inicio.getTime()) && agora >= inicio) {
          _alterarStatusDireto(aba, numLinha, cabecalhos, STATUS.ATIVO);
          logEvento(formId, NIVEL_LOG.INFO,
            'Formulário ativado automaticamente (data de início atingida).');
        }
      }

      // ── Encerramento por data limite ─────────────────────
      if ((status === STATUS.ATIVO || status === STATUS.RASCUNHO) && obj.dataLimite) {
        const limite = parseDateInFuso(obj.dataLimite);
        if (limite && !isNaN(limite.getTime()) && agora >= limite) {
          _alterarStatusDireto(aba, numLinha, cabecalhos, STATUS.ENCERRADO);
          logEvento(formId, NIVEL_LOG.INFO,
            'Formulário encerrado automaticamente (data limite atingida).');
        }
      }
    });
  } catch (e) {
    logEvento('SYSTEM', NIVEL_LOG.ERROR,
      'Erro no trigger de encerramento programado: ' + e.message, e.stack);
  }
}

/**
 * Altera status diretamente na aba FORMS sem chamar editarFormulario()
 * para evitar overhead no trigger periódico.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} aba
 * @param {number} numLinha
 * @param {string[]} cabecalhos
 * @param {string} novoStatus
 * @private
 */
function _alterarStatusDireto(aba, numLinha, cabecalhos, novoStatus) {
  const colStatus = cabecalhos.indexOf('status') + 1;
  if (colStatus > 0) {
    aba.getRange(numLinha, colStatus).setValue(novoStatus);
  }
}

// ============================================================
// NOTIFICAÇÕES AGRUPADAS (RESUMO DIÁRIO)
// ============================================================

/**
 * Envia resumo diário de respostas por e-mail.
 * Executado diariamente às 8h pelo trigger.
 * Respeita a cota do MailApp (~100 e-mails/dia).
 */
function enviarNotificacoesPendentes() {
  try {
    const props = PropertiesService.getScriptProperties();
    const filaJson = props.getProperty('NOTIF_QUEUE') || '[]';
    const fila = JSON.parse(filaJson);

    if (fila.length === 0) return;

    // Verificar cota restante do MailApp
    const quotaRestante = MailApp.getRemainingDailyQuota();
    if (quotaRestante < 1) {
      logEvento('SYSTEM', NIVEL_LOG.WARN, 'Cota do MailApp esgotada. Notificações adiadas.');
      return;
    }

    const config = obterConfig();
    const emailAdmin = config['emailAdmin'];
    if (!emailAdmin) return;

    // Agrupar por formulário
    const porFormulario = {};
    fila.filter(n => n.modo === MODO_NOTIFICACAO.RESUMO_DIARIO).forEach(notif => {
      if (!porFormulario[notif.formId]) porFormulario[notif.formId] = [];
      porFormulario[notif.formId].push(notif);
    });

    if (Object.keys(porFormulario).length === 0) {
      props.setProperty('NOTIF_QUEUE', '[]');
      return;
    }

    const urlBase = ScriptApp.getService().getUrl();
    let html = '<h2>Resumo diário de respostas — SETUR Forms GAS</h2>';
    html += '<p>Data: ' + Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'dd/MM/yyyy') + '</p>';

    for (const [formId, notifs] of Object.entries(porFormulario)) {
      html += `<h3>${formId}: ${notifs.length} nova(s) resposta(s)</h3>`;
      html += `<p><a href="${urlBase}?page=dash&form=${formId}">Ver no dashboard</a></p>`;
    }

    MailApp.sendEmail({
      to: emailAdmin,
      subject: '[SETUR Forms] Resumo diário de respostas',
      htmlBody: html,
    });

    // Limpar fila de resumos processados
    const restante = fila.filter(n => n.modo !== MODO_NOTIFICACAO.RESUMO_DIARIO);
    props.setProperty('NOTIF_QUEUE', JSON.stringify(restante));

    logEvento('SYSTEM', NIVEL_LOG.INFO,
      'Resumo diário enviado para ' + emailAdmin + '. ' + fila.length + ' notificações processadas.');
  } catch (e) {
    logEvento('SYSTEM', NIVEL_LOG.ERROR,
      'Erro ao enviar notificações pendentes: ' + e.message, e.stack);
  }
}

// ============================================================
// RECONCILIAÇÃO DE INTENÇÕES (SAFETY NET FINAL)
// ============================================================

/**
 * Detecta respostas que foram INICIADAS mas não CONFIRMADAS na planilha.
 * Intenções registradas no PropertiesService com mais de 3 minutos
 * que não constam na planilha são enviadas para a fila de contingência.
 *
 * Cenários cobertos por este trigger:
 *  - appendRow executado, processo morreu antes de SpreadsheetApp.flush()
 *  - flush executado, processo morreu antes de _removerIntencao()
 *  - qualquer crash silencioso dentro do lock
 *
 * Executado a cada 10 minutos pelo trigger periódico.
 */
function reconciliarIntencoes() {
  const lock = LockService.getScriptLock();
  let lockObtido = false;
  try {
    lockObtido = lock.tryLock(5000); // Aguarda até 5 segundos no background
  } catch (err) {
    // Silencioso
  }

  if (!lockObtido) {
    logEvento('SYSTEM', NIVEL_LOG.WARN, 'Reconciliação abortada: não foi possível obter o script lock.');
    return;
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const todasProps = props.getProperties();
    const agora = Date.now();
    const TIMEOUT_INTENCAO_MS = 3 * 60 * 1000; // 3 minutos

    let reconciliados = 0;
    let removidos = 0;

    for (const [chave, valor] of Object.entries(todasProps)) {
      if (!chave.startsWith('INTENCAO_')) continue;
      const responseId = chave.replace('INTENCAO_', '');

      try {
        const info = JSON.parse(valor);
        const registradoEm = new Date(info.registradoEm).getTime();

        // Intenção muito recente? Ainda pode estar processando.
        if (agora - registradoEm < TIMEOUT_INTENCAO_MS) continue;

        // Verificar se chegou à planilha
        const formId = info.formId;
        const formLinha = _encontrarLinhaForm(formId);
        if (!formLinha) {
          // Formulário não existe mais — limpar intenção
          props.deleteProperty(chave);
          removidos++;
          continue;
        }

        const formObj = _linhaParaObjeto(formLinha);
        if (!formObj.planilhaId) {
          props.deleteProperty(chave);
          removidos++;
          continue;
        }

        const ss = SpreadsheetApp.openById(formObj.planilhaId);
        const aba = ss.getSheetByName('Respostas');

        if (aba && _responseIdExisteNaPlanilha(aba, responseId)) {
          // Está na planilha — intenção cumprida, limpar registro
          props.deleteProperty(chave);
          removidos++;
        } else {
          // NÃO está na planilha — enfileirar para processamento
          logEvento(formId, NIVEL_LOG.WARN,
            'Reconciliação: intenção órfã detectada para responseId: ' + responseId +
            '. Enfileirando para processamento.');

          const payload = JSON.parse(info.payload || '{}');
          _adicionarNaFila(formId, responseId, payload, 'Reconciliação de intenção órfã');

          props.deleteProperty(chave);
          reconciliados++;
        }
      } catch (err) {
        logEvento('SYSTEM', NIVEL_LOG.WARN,
          'Erro ao reconciliar intenção ' + responseId + ': ' + err.message);
        // Deletar propriedade corrompida para evitar loops infinitos
        try { props.deleteProperty(chave); } catch (e) {}
      }
    }

    if (reconciliados > 0 || removidos > 0) {
      logEvento('SYSTEM', NIVEL_LOG.INFO,
        'Reconciliação: ' + reconciliados + ' enfileiradas, ' + removidos + ' limpas.');
    }
  } catch (e) {
    logEvento('SYSTEM', NIVEL_LOG.ERROR,
      'Erro no trigger de reconciliação: ' + e.message, e.stack);
  } finally {
    if (lockObtido) {
      try { lock.releaseLock(); } catch (ignore) {}
    }
  }
}
