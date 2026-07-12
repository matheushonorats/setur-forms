/**
 * @fileoverview Geração de fichas de inscrição em PDF a partir das respostas.
 * Modelo geral (serve para qualquer formulário): cabeçalho + perguntas/respostas
 * + QR codes dos anexos. As fichas são salvas em uma subpasta "Fichas de
 * Inscrição" dentro da pasta do formulário no Drive (privadas — só o admin).
 */

// ============================================================
// API PÚBLICA (chamada pelo dashboard admin)
// ============================================================

/**
 * Gera a ficha PDF de UMA resposta.
 * @param {string} formId
 * @param {string} responseId
 * @returns {{ok:boolean, data?:{url:string, nome:string}, error?:string}}
 */
function gerarFichaInscricao(formId, responseId) {
  try {
    const fr = obterFormulario(formId);
    if (!fr.ok) return fr;
    const form = fr.data;
    const config = _parseConfig_(form.configJSON);

    const info = _carregarRespostaPorId_(formId, responseId);
    if (!info) return respostaErro('Resposta não encontrada.', 'NAO_ENCONTRADO');

    const pdf = _construirFichaPDF_(form, config, info);
    const subpasta = _obterSubpastaFichas_(form.pastaId);
    const arq = subpasta.createFile(pdf.blob);
    const url = arq.getUrl();
    const planInfo = _obterInfoPlanilha(formId);
    _registrarUrlFicha_(planInfo.planilhaId, responseId, url);
    logEvento(formId, NIVEL_LOG.INFO, 'Ficha gerada para responseId ' + responseId);
    return respostaOk({ url: url, nome: pdf.nome, urlPasta: subpasta.getUrl() });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR, 'Erro ao gerar ficha: ' + e.message, e.stack);
    return respostaErro('Erro ao gerar a ficha: ' + e.message, 'ERRO_FICHA');
  }
}

/**
 * Gera as fichas PDF de TODAS as respostas do formulário (em lote).
 * Atenção: cada ficha leva alguns segundos; lotes muito grandes podem atingir
 * o limite de tempo de execução do Apps Script (~6 min).
 * @param {string} formId
 * @returns {{ok:boolean, data?:{total:number, gerados:number, urlPasta:string}}}
 */
function gerarFichasTodas(formId) {
  try {
    const fr = obterFormulario(formId);
    if (!fr.ok) return fr;
    const form = fr.data;
    const config = _parseConfig_(form.configJSON);

    const linhas = _carregarTodasRespostas_(formId);
    if (!linhas || !linhas.length) return respostaOk({ total: 0, gerados: 0, urlPasta: '' });

    const subpasta = _obterSubpastaFichas_(form.pastaId);
    const planInfo = _obterInfoPlanilha(formId);
    let gerados = 0;
    const LIMITE_LOTE = 40; // proteção contra timeout
    for (let i = 0; i < linhas.length && i < LIMITE_LOTE; i++) {
      try {
        const pdf = _construirFichaPDF_(form, config, { numero: i + 1, dados: linhas[i] });
        const arq = subpasta.createFile(pdf.blob);
        _registrarUrlFicha_(planInfo.planilhaId, linhas[i].responseId, arq.getUrl());
        gerados++;
      } catch (e) {
        logEvento(formId, NIVEL_LOG.WARN, 'Falha ao gerar ficha #' + (i + 1) + ': ' + e.message);
      }
    }
    logEvento(formId, NIVEL_LOG.INFO, 'Fichas em lote: ' + gerados + ' de ' + linhas.length);
    return respostaOk({ total: linhas.length, gerados: gerados, urlPasta: subpasta.getUrl() });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR, 'Erro ao gerar fichas em lote: ' + e.message, e.stack);
    return respostaErro('Erro ao gerar as fichas: ' + e.message, 'ERRO_FICHAS');
  }
}

/**
 * EXECUTE UMA VEZ no editor para conceder as permissões de Documentos (criar/
 * exportar o PDF) e de requisição externa (QR code) usadas pela geração de fichas.
 * Depois disso, os botões de ficha funcionam no Web App.
 */
function autorizarFichas() {
  const doc = DocumentApp.create('Autorizacao SETUR Forms (pode apagar)');
  const id = doc.getId();
  doc.saveAndClose();
  try { DriveApp.getFileById(id).setTrashed(true); } catch (e) {}
  _qrCodeBlob_('https://script.google.com');
  console.log('Permissoes de Documentos e requisicao externa concedidas com sucesso.');
}

// ============================================================
// CONSTRUÇÃO DO DOCUMENTO / PDF
// ============================================================

/**
 * Monta o documento da ficha e retorna o PDF como blob. Remove o Doc temporário.
 * @returns {{blob: GoogleAppsScript.Base.Blob, nome: string}}
 * @private
 */
function _construirFichaPDF_(form, config, info) {
  const d = info.dados || {};
  const numero = info.numero;
  const nomeBase = 'Ficha ' + (form.formId || 'form') + ' #' + numero;

  // Se houver um documento-modelo configurado (com timbre/cabeçalho da Prefeitura),
  // copiamos ele e limpamos só o CORPO — o cabeçalho/rodapé do modelo se mantém em
  // todas as páginas de toda ficha. Caso contrário, cria um doc em branco.
  let doc;
  const templateId = _idModeloFicha_();
  if (templateId) {
    try {
      const copia = DriveApp.getFileById(templateId).makeCopy(nomeBase);
      doc = DocumentApp.openById(copia.getId());
      doc.getBody().clear();
    } catch (e) {
      doc = DocumentApp.create(nomeBase);
    }
  } else {
    doc = DocumentApp.create(nomeBase);
  }
  const body = doc.getBody();

  body.appendParagraph(form.titulo || 'Formulário').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph('Ficha de inscrição nº ' + numero + ' — Preenchida online');
  body.appendParagraph('Inscrição realizada em: ' + (d.timestamp || '—'));
  body.appendHorizontalRule();

  // Perguntas (na ordem do formulário), exceto textos explicativos
  const perguntas = [];
  (config.secoes || []).forEach(s => {
    (s.perguntas || []).forEach(p => {
      if (p.tipo !== TIPO_PERGUNTA.SOMENTE_LEITURA) perguntas.push(p);
    });
  });

  const anexos = [];
  perguntas.forEach(p => {
    const titulo = String(p.titulo || p.id || '').replace(/<[^>]*>/g, '').trim() || '(sem título)';
    let resp = d[p.id];
    const ehAnexo = (p.tipo === TIPO_PERGUNTA.UPLOAD_ARQUIVO || p.tipo === TIPO_PERGUNTA.ASSINATURA_CANVAS);
    const respStr = (resp == null) ? '' : (Array.isArray(resp) ? resp.join(', ') : String(resp));

    if (ehAnexo && respStr.indexOf('http') === 0) {
      anexos.push({ titulo: titulo, url: respStr });
      const par = body.appendParagraph('');
      par.appendText(titulo + ': ').setBold(true);
      par.appendText('(anexo — ver QR Code ao final)').setBold(false);
    } else {
      const par = body.appendParagraph('');
      par.appendText(titulo + ': ').setBold(true);
      par.appendText(respStr || '—').setBold(false);
    }
  });

  // Anexos como QR Codes
  if (anexos.length) {
    body.appendHorizontalRule();
    body.appendParagraph('Anexos enviados').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    const tabela = body.appendTable();
    const linhaTitulos = tabela.appendTableRow();
    const linhaQR = tabela.appendTableRow();
    anexos.forEach(a => {
      linhaTitulos.appendTableCell(a.titulo);
      const celula = linhaQR.appendTableCell('');
      try {
        const qr = _qrCodeBlob_(a.url);
        if (qr) celula.appendImage(qr);
      } catch (e) { /* sem QR — segue só com o link */ }
      const pLink = celula.appendParagraph(a.url);
      try { pLink.editAsText().setLinkUrl(a.url); } catch (e) {}
    });
  }

  doc.saveAndClose();

  const arqDoc = DriveApp.getFileById(doc.getId());
  const blob = arqDoc.getAs('application/pdf').setName(nomeBase + '.pdf');
  try { arqDoc.setTrashed(true); } catch (e) { /* deixa o doc se não der pra remover */ }
  return { blob: blob, nome: nomeBase + '.pdf' };
}

/**
 * Gera o blob PNG de um QR Code para a URL (via api.qrserver.com — gratuito).
 * Requer a permissão de requisição externa (a mesma do link curto).
 * @param {string} url
 * @returns {GoogleAppsScript.Base.Blob|null}
 * @private
 */
function _qrCodeBlob_(url) {
  try {
    const api = 'https://api.qrserver.com/v1/create-qr-code/?size=150x150&margin=4&data=' + encodeURIComponent(url);
    const resp = UrlFetchApp.fetch(api, { muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) return resp.getBlob();
  } catch (e) { /* silencioso */ }
  return null;
}

// ============================================================
// HELPERS DE DADOS / PASTA
// ============================================================

/**
 * Obtém (ou cria) a subpasta "Fichas de Inscrição" dentro da pasta do formulário.
 * @param {string} pastaFormId
 * @returns {GoogleAppsScript.Drive.Folder}
 * @private
 */
function _obterSubpastaFichas_(pastaFormId) {
  if (!pastaFormId) throw new Error('Pasta do formulário não definida.');
  const pasta = DriveApp.getFolderById(pastaFormId);
  const existentes = pasta.getFoldersByName('Fichas de Inscrição');
  if (existentes.hasNext()) return existentes.next();
  return pasta.createFolder('Fichas de Inscrição');
}

/**
 * Grava (ou atualiza) o link da ficha PDF na linha da resposta, numa coluna
 * própria (nota 'fichaUrl', criada se não existir). Assim o dashboard mostra
 * o link de forma persistente.
 * @private
 */
function _registrarUrlFicha_(planilhaId, responseId, url) {
  try {
    if (!planilhaId || !responseId) return;
    const ss = SpreadsheetApp.openById(planilhaId);
    const aba = ss.getSheetByName('Respostas');
    if (!aba) return;

    let col = _obterColunaPorId(aba, 'fichaUrl'); // 0-based
    if (col === -1) {
      col = aba.getLastColumn(); // 0-based da nova coluna no fim
      aba.getRange(1, col + 1)
        .setValue('Ficha (PDF)')
        .setNote('fichaUrl')
        .setBackground('#fbbc04')
        .setFontWeight('bold');
    }

    const colResp = _obterColunaPorId(aba, 'responseId');
    if (colResp === -1) return;
    const ultima = aba.getLastRow();
    if (ultima <= 1) return;
    const ids = aba.getRange(2, colResp + 1, ultima - 1, 1).getValues();
    const idx = ids.findIndex(r => r[0] === responseId);
    if (idx === -1) return;
    aba.getRange(idx + 2, col + 1).setValue(url);
  } catch (e) {
    logEvento('SYSTEM', NIVEL_LOG.WARN, 'Falha ao registrar URL da ficha: ' + e.message);
  }
}

/**
 * Carrega uma resposta pelo responseId, retornando { numero, dados } onde
 * 'dados' mapeia questionId -> valor e 'numero' é a ordem da inscrição (1-based).
 * @private
 */
function _carregarRespostaPorId_(formId, responseId) {
  const info = _obterInfoPlanilha(formId);
  if (!info.planilhaId) return null;
  const ss = SpreadsheetApp.openById(info.planilhaId);
  const aba = ss.getSheetByName('Respostas');
  if (!aba || aba.getLastRow() <= 1) return null;

  const colResp = _obterColunaPorId(aba, 'responseId');
  if (colResp === -1) return null;

  const dados = aba.getDataRange().getValues();
  const cabecalhos = dados[0];
  const notas = aba.getRange(1, 1, 1, aba.getLastColumn()).getNotes()[0];
  const idx = dados.slice(1).findIndex(r => r[colResp] === responseId);
  if (idx === -1) return null;

  const obj = {};
  cabecalhos.forEach((c, i) => { obj[notas[i] || c] = dados[idx + 1][i]; });
  return { numero: idx + 1, dados: obj };
}

/**
 * Carrega TODAS as respostas como array de objetos (questionId -> valor).
 * @private
 */
function _carregarTodasRespostas_(formId) {
  const info = _obterInfoPlanilha(formId);
  if (!info.planilhaId) return [];
  const ss = SpreadsheetApp.openById(info.planilhaId);
  const aba = ss.getSheetByName('Respostas');
  if (!aba || aba.getLastRow() <= 1) return [];

  const dados = aba.getDataRange().getValues();
  const cabecalhos = dados[0];
  const notas = aba.getRange(1, 1, 1, aba.getLastColumn()).getNotes()[0];
  return dados.slice(1).map(linha => {
    const obj = {};
    cabecalhos.forEach((c, i) => { obj[notas[i] || c] = linha[i]; });
    return obj;
  });
}
