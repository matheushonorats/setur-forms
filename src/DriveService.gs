/**
 * @fileoverview Serviço de gerenciamento do Google Drive.
 * Criação de pastas, planilhas de respostas e uploads.
 */

// ============================================================
// GESTÃO DE PASTAS
// ============================================================

/**
 * Cria a estrutura de pastas para um formulário no Drive.
 * Padrão: SETUR Forms/ANO/slug-do-formulario/
 * @param {string} formId - Slug do formulário
 * @param {string} titulo - Título para exibição
 * @returns {{pastaId: string, uploadsFolderId: string}}
 */
function criarPastaFormulario(formId, titulo) {
  const pastaRaizId = PropertiesService.getScriptProperties().getProperty('PASTA_RAIZ_ID');
  if (!pastaRaizId) throw new Error('Pasta raiz não configurada. Execute setup() primeiro.');

  const pastaRaiz = DriveApp.getFolderById(pastaRaizId);

  // Pasta do ano: SETUR Forms/2026/
  const ano = anoAtual();
  const pastaAno = _obterOuCriarSubpasta(pastaRaiz, ano);

  // Pasta do formulário: SETUR Forms/2026/slug/
  const nomeFormulario = titulo || formId;
  const pastaForm = _obterOuCriarSubpasta(pastaAno, nomeFormulario);

  // Subpasta de uploads: SETUR Forms/2026/slug/uploads/
  const pastaUploads = _obterOuCriarSubpasta(pastaForm, 'uploads');

  return {
    pastaId: pastaForm.getId(),
    uploadsFolderId: pastaUploads.getId(),
    url: pastaForm.getUrl(),
  };
}

/**
 * Cria a planilha de respostas para um formulário dentro de sua pasta.
 * @param {string} formId - ID do formulário
 * @param {string} titulo - Título do formulário
 * @param {string} pastaId - ID da pasta do formulário no Drive
 * @param {string[]} cabecalhos - Array com os cabeçalhos das colunas
 * @returns {{planilhaId: string, urlPlanilha: string}}
 */
function criarPlanilhaRespostas(formId, titulo, pastaId, cabecalhos) {
  const pasta = DriveApp.getFolderById(pastaId);

  // Verificar se já existe
  const existentes = pasta.getFilesByName('Respostas - ' + titulo);
  if (existentes.hasNext()) {
    const arquivo = existentes.next();
    const ss = SpreadsheetApp.openById(arquivo.getId());
    return { planilhaId: arquivo.getId(), urlPlanilha: ss.getUrl() };
  }

  // Criar nova planilha
  const ss = SpreadsheetApp.create('Respostas - ' + titulo);
  const arquivo = DriveApp.getFileById(ss.getId());

  // Mover para a pasta correta
  arquivo.moveTo(pasta);

  // Configurar a aba de respostas
  const aba = ss.getActiveSheet();
  aba.setName('Respostas');

  // Tratar cabeçalhos dinâmicos
  const cabecalhosDinamicos = cabecalhos.map(c => {
    if (typeof c === 'object' && c !== null && c.id) {
      return c;
    }
    return { id: c, titulo: c }; // fallback se for array de strings
  });

  // Cabeçalhos padrão (valores e notas)
  const cabecalhosPadrao = [
    { id: 'responseId', titulo: 'ID da Resposta' },
    { id: 'timestamp', titulo: 'Data/Hora' },
    { id: 'formId', titulo: 'ID do Formulário' },
    { id: 'versaoForm', titulo: 'Versão' },
    { id: 'enderecoIP', titulo: 'IP' },
    { id: 'userAgent', titulo: 'Navegador' },
    { id: 'tempoPreenchimentoSeg', titulo: 'Tempo (s)' }
  ];

  const todosCabecalhos = [...cabecalhosPadrao, ...cabecalhosDinamicos];

  const valoresHeader = todosCabecalhos.map(c => c.titulo);
  const notasHeader = todosCabecalhos.map(c => c.id);

  aba.appendRow(valoresHeader);

  // Definir notas para identificar as colunas por ID
  const rangeHeader = aba.getRange(1, 1, 1, todosCabecalhos.length);
  rangeHeader.setNotes([notasHeader]);

  // Formatar cabeçalho
  rangeHeader.setBackground('#1a73e8')
             .setFontColor('#ffffff')
             .setFontWeight('bold');
  aba.setFrozenRows(1);

  // Aba de metadados
  const abaMeta = ss.insertSheet('_meta');
  abaMeta.appendRow(['formId', formId]);
  abaMeta.appendRow(['criadoEm', formatarDataBR(new Date())]);
  abaMeta.appendRow(['versao', '1.0.0']);
  abaMeta.hideSheet();

  logEvento(formId, NIVEL_LOG.INFO,
    'Planilha de respostas criada: ' + ss.getUrl());

  return { planilhaId: ss.getId(), urlPlanilha: ss.getUrl() };
}

/**
 * Sincroniza o nome da planilha de respostas e atualiza os cabeçalhos
 * e notas de colunas conforme as alterações feitas no construtor.
 * @param {string} planilhaId
 * @param {Object|string} configJSON
 * @param {string} [novoTituloForm]
 */
function sincronizarPlanilhaForm(planilhaId, configJSON, novoTituloForm) {
  try {
    if (!planilhaId) return;
    const ss = SpreadsheetApp.openById(planilhaId);
    
    // 1. Atualizar o nome da planilha se o título do formulário mudou
    if (novoTituloForm) {
      const novoNome = 'Respostas - ' + novoTituloForm.trim();
      if (ss.getName() !== novoNome) {
        ss.setName(novoNome);
        logEvento('SYSTEM', NIVEL_LOG.INFO, 'Planilha renomeada para: ' + novoNome);
      }
    }

    const aba = ss.getSheetByName('Respostas');
    if (!aba) return;

    // Obter colunas existentes
    const ultimaCol = aba.getLastColumn();
    if (ultimaCol === 0) return;

    const rangeHeader = aba.getRange(1, 1, 1, ultimaCol);
    const valoresHeader = rangeHeader.getValues()[0];
    const notasHeader = rangeHeader.getNotes()[0];

    // Extrair cabeçalhos novos do configJSON
    const cabecalhosNovos = _extrairCabecalhosComDetalhes(configJSON);

    // Mapear nota (questionId) -> index (0-based) e dados da coluna
    const mapaColunasExistentes = {};
    notasHeader.forEach((nota, idx) => {
      const questionId = nota || valoresHeader[idx]; // fallback para cabeçalhos antigos sem nota
      mapaColunasExistentes[questionId] = {
        index: idx,
        tituloAtual: valoresHeader[idx],
        temNota: !!nota
      };
    });

    let alterouHeaders = false;

    // Atualizar títulos das perguntas existentes se mudaram
    cabecalhosNovos.forEach(c => {
      const colInfo = mapaColunasExistentes[c.id];
      if (colInfo) {
        // Se o título mudou na edição do formulário, atualizamos na planilha
        if (colInfo.tituloAtual !== c.titulo) {
          aba.getRange(1, colInfo.index + 1).setValue(c.titulo);
          alterouHeaders = true;
        }
        // Se a coluna antiga não tinha nota (compatibilidade), adicionamos a nota agora
        if (!colInfo.temNota) {
          aba.getRange(1, colInfo.index + 1).setNote(c.id);
          alterouHeaders = true;
        }
      }
    });

    // Identificar perguntas novas que não existem na planilha
    const novasPerguntas = cabecalhosNovos.filter(c => !mapaColunasExistentes[c.id]);

    if (novasPerguntas.length > 0) {
      novasPerguntas.forEach((c, idx) => {
        const col = ultimaCol + idx + 1;
        aba.getRange(1, col)
           .setValue(c.titulo)
           .setNote(c.id)
           .setBackground('#fbbc04')
           .setFontWeight('bold');
      });
      alterouHeaders = true;
      logEvento('SYSTEM', NIVEL_LOG.INFO, 'Adicionadas ' + novasPerguntas.length + ' colunas de perguntas novas.');
    }

    if (alterouHeaders) {
      SpreadsheetApp.flush();
    }

  } catch (e) {
    logEvento('SYSTEM', NIVEL_LOG.WARN, 'Erro ao sincronizar planilha: ' + e.message, e.stack);
  }
}

/**
 * Adiciona novas colunas à planilha de respostas sem destruir as existentes.
 * Chamado quando um formulário editado tem novas perguntas.
 * @param {string} planilhaId - ID da planilha de respostas
 * @param {string[]} novosIds - IDs de perguntas novas a adicionar
 * @param {Object} mapaRotulos - questionId → título da pergunta
 */
function adicionarColunasRespostas(planilhaId, novosIds, mapaRotulos) {
  try {
    const ss = SpreadsheetApp.openById(planilhaId);
    const aba = ss.getSheetByName('Respostas');
    if (!aba) return;

    const ultimaColuna = aba.getLastColumn();
    const cabecalhos = aba.getRange(1, 1, 1, ultimaColuna).getValues()[0];
    const cabecalhosSet = new Set(cabecalhos);

    const novasColunas = novosIds.filter(id => !cabecalhosSet.has(id));
    if (novasColunas.length === 0) return;

    novasColunas.forEach((id, idx) => {
      const col = ultimaColuna + idx + 1;
      aba.getRange(1, col).setValue(id).setBackground('#fbbc04').setFontWeight('bold');
    });

    logEvento('SYSTEM', NIVEL_LOG.INFO,
      'Adicionadas ' + novasColunas.length + ' novas colunas na planilha ' + planilhaId);
  } catch (e) {
    logEvento('SYSTEM', NIVEL_LOG.WARN,
      'Falha ao adicionar colunas: ' + e.message, e.stack);
  }
}

/**
 * Verifica se uma planilha de respostas existe e está acessível.
 * Recria se necessária.
 * @param {string} planilhaId - ID da planilha
 * @param {string} formId - ID do formulário
 * @param {string} titulo - Título do formulário
 * @param {string} pastaId - ID da pasta
 * @param {string[]} cabecalhos - Cabeçalhos para recriar
 * @returns {{planilhaId: string, urlPlanilha: string, recriada: boolean}}
 */
function verificarPlanilhaExiste(planilhaId, formId, titulo, pastaId, cabecalhos) {
  try {
    if (planilhaId) {
      const ss = SpreadsheetApp.openById(planilhaId);
      return { planilhaId: planilhaId, urlPlanilha: ss.getUrl(), recriada: false };
    }
  } catch (e) {
    logEvento(formId, NIVEL_LOG.WARN,
      'Planilha de respostas não encontrada (ID: ' + planilhaId + '). Recriando...', e.message);
  }

  // Recriar planilha
  const resultado = criarPlanilhaRespostas(formId, titulo, pastaId, cabecalhos);
  resultado.recriada = true;
  return resultado;
}

// ============================================================
// UPLOADS DE ARQUIVO
// ============================================================

/**
 * Salva um arquivo enviado pelo respondente no Drive.
 * @param {string} formId - ID do formulário
 * @param {string} perguntaId - ID da pergunta de upload
 * @param {string} uploadsFolderId - ID da pasta de uploads
 * @param {string} base64Data - Conteúdo do arquivo em Base64
 * @param {string} nomeArquivo - Nome original do arquivo
 * @param {string} mimeType - Tipo MIME
 * @param {number} tamanhoMaxMB - Tamanho máximo permitido em MB
 * @param {string[]} extensoesPermitidas - Ex: ['pdf', 'jpg', 'png']
 * @returns {{ok: boolean, url?: string, error?: string}}
 */
function salvarUpload(formId, perguntaId, uploadsFolderId, base64Data, nomeArquivo, mimeType, tamanhoMaxMB, extensoesPermitidas) {
  try {
    // Validar extensão
    const ext = nomeArquivo.split('.').pop().toLowerCase();
    if (extensoesPermitidas && extensoesPermitidas.length > 0) {
      if (!extensoesPermitidas.map(e => e.toLowerCase()).includes(ext)) {
        return respostaErro(
          'Extensão não permitida: .' + ext + '. Permitidas: ' + extensoesPermitidas.join(', '),
          'EXTENSAO_INVALIDA'
        );
      }
    }

    // Validar tamanho (Base64 ~= 4/3 * bytes)
    const tamanhoBytes = Math.ceil(base64Data.length * 0.75);
    const tamanhoMaxBytes = (tamanhoMaxMB || LIMITE.UPLOAD_MAX_MB) * 1024 * 1024;
    if (tamanhoBytes > tamanhoMaxBytes) {
      return respostaErro(
        'Arquivo muito grande. Máximo: ' + (tamanhoMaxMB || LIMITE.UPLOAD_MAX_MB) + 'MB.',
        'ARQUIVO_GRANDE'
      );
    }

    // Decodificar e salvar
    const blob = Utilities.newBlob(
      Utilities.base64Decode(base64Data),
      mimeType,
      nomeArquivo
    );

    const pasta = DriveApp.getFolderById(uploadsFolderId);
    const arquivo = pasta.createFile(blob);

    // Tornar acessível a quem tem o link
    arquivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    logEvento(formId, NIVEL_LOG.INFO,
      'Upload salvo: ' + nomeArquivo + ' (' + Math.ceil(tamanhoBytes / 1024) + 'KB)');

    return respostaOk({
      url: arquivo.getUrl(),
      fileId: arquivo.getId(),
      nome: nomeArquivo,
    });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR, 'Erro no upload: ' + e.message, e.stack);
    return respostaErro('Erro ao salvar o arquivo. Tente novamente.', 'ERRO_UPLOAD');
  }
}

/**
 * Salva uma assinatura desenhada em canvas (PNG base64) no Drive.
 * @param {string} formId
 * @param {string} perguntaId
 * @param {string} uploadsFolderId
 * @param {string} base64Png - Imagem PNG em Base64 (sem prefixo data:)
 * @param {string} responseId - UUID da resposta
 * @returns {{ok: boolean, url?: string, error?: string}}
 */
function salvarAssinatura(formId, perguntaId, uploadsFolderId, base64Png, responseId) {
  const nomeArquivo = 'assinatura_' + perguntaId + '_' + responseId + '.png';
  return salvarUpload(
    formId, perguntaId, uploadsFolderId,
    base64Png, nomeArquivo, 'image/png',
    1, ['png'] // Máx 1MB para assinaturas
  );
}

// ============================================================
// FUNÇÕES AUXILIARES INTERNAS
// ============================================================

/**
 * Obtém ou cria uma subpasta dentro de uma pasta pai.
 * @param {GoogleAppsScript.Drive.Folder} pastaPai
 * @param {string} nome - Nome da subpasta
 * @returns {GoogleAppsScript.Drive.Folder}
 * @private
 */
function _obterOuCriarSubpasta(pastaPai, nome) {
  const existentes = pastaPai.getFoldersByName(nome);
  if (existentes.hasNext()) return existentes.next();
  return pastaPai.createFolder(nome);
}

/**
 * Extrai o ID do arquivo a partir de uma URL do Google Drive.
 * @param {string} url
 * @returns {string|null}
 * @private
 */
function _extrairFileId(url) {
  if (!url) return null;
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Envia um arquivo para a lixeira do Drive para preservar a privacidade do preenchedor.
 * @param {string} url - URL do arquivo no Google Drive
 * @returns {{ok: boolean, error?: string}}
 */
function deletarArquivoUpload(url) {
  try {
    const fileId = _extrairFileId(url);
    if (!fileId) {
      return respostaErro('URL do arquivo inválida.', 'ID_INVALIDO');
    }
    const arquivo = DriveApp.getFileById(fileId);
    arquivo.setTrashed(true);
    return respostaOk({ deletado: true });
  } catch (e) {
    logEvento('SYSTEM', NIVEL_LOG.WARNING, 'Erro ao deletar arquivo no Drive: ' + e.message);
    return respostaErro('Erro ao remover arquivo do Drive: ' + e.message, 'ERRO_DELETAR');
  }
}

/**
 * Obtém ou cria uma subpasta por seu ID e nome.
 * @param {string} pastaPaiId
 * @param {string} nomeSubpasta
 * @returns {string} ID da subpasta criada ou obtida
 */
function obterOuCriarSubpastaPorId(pastaPaiId, nomeSubpasta) {
  const pastaPai = DriveApp.getFolderById(pastaPaiId);
  const nomeSanitizado = nomeSubpasta.replace(/[\\\/*?"<>|:]/g, '-');
  const existentes = pastaPai.getFoldersByName(nomeSanitizado);
  if (existentes.hasNext()) return existentes.next().getId();
  return pastaPai.createFolder(nomeSanitizado).getId();
}
