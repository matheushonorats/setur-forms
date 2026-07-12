/**
 * @fileoverview Serviço de dados para o Dashboard de resultados.
 * Agrega respostas, prepara dados para gráficos e paginação.
 */

// ============================================================
// DADOS GERAIS DO DASHBOARD
// ============================================================

/**
 * Retorna dados agregados de um formulário para o dashboard.
 * @param {string} formId
 * @returns {{ok: boolean, data?: Object, error?: string}}
 */
function obterDadosDashboard(formId, isAdmin) {
  try {
    const formResult = obterFormulario(formId);
    if (!formResult.ok) return formResult;
    const form = formResult.data;

    const { planilhaId } = _obterInfoPlanilhaSimples(formId, form);
    if (!planilhaId) {
      return respostaOk({ totalRespostas: 0, graficos: [], respostas: [], isAdmin: !!isAdmin });
    }

    const ss = SpreadsheetApp.openById(planilhaId);
    const aba = ss.getSheetByName('Respostas');

    if (!aba || aba.getLastRow() <= 1) {
      return respostaOk({ totalRespostas: 0, graficos: [], respostas: [], isAdmin: !!isAdmin });
    }

    const dados = aba.getDataRange().getValues();
    const cabecalhos = dados[0];
    const notasCabecalhos = aba.getRange(1, 1, 1, aba.getLastColumn()).getNotes()[0];
    const idsCabecalhos = cabecalhos.map((c, idx) => notasCabecalhos[idx] || c);

    const linhas = dados.slice(1);
    const configJSON = _parseConfig_(form.configJSON);

    // Extrair todas as perguntas
    const todasPerguntas = [];
    (configJSON.secoes || []).forEach(s => {
      (s.perguntas || []).forEach(p => {
        if (p.tipo !== TIPO_PERGUNTA.SOMENTE_LEITURA) todasPerguntas.push(p);
      });
    });

    // Montar array de objetos de resposta
    const respostasObjetos = linhas.map(linha => _arrayParaObjeto(idsCabecalhos, linha));

    // Respostas por dia
    const porDia = _contarPorDia(respostasObjetos);

    // Gráficos por pergunta (mapeado por idsCabecalhos)
    const graficos = _gerarDadosGraficos(todasPerguntas, idsCabecalhos, linhas);

    // Taxa de conclusão (mapeado por idsCabecalhos)
    const taxaConclusao = _calcularTaxaConclusao(todasPerguntas, idsCabecalhos, linhas);

    // URL da pasta de fichas (se já existir e for admin)
    let urlPastaFichas = '';
    if (isAdmin && form.pastaId) {
      try {
        const pf = DriveApp.getFolderById(form.pastaId).getFoldersByName('Fichas de Inscrição');
        if (pf.hasNext()) urlPastaFichas = pf.next().getUrl();
      } catch (e) { /* sem pasta ainda */ }
    }

    return respostaOk({
      formId: formId,
      titulo: form.titulo,
      status: form.status,
      totalRespostas: linhas.length,
      porDia: porDia,
      taxaConclusao: taxaConclusao,
      graficos: graficos,
      urlPlanilha: isAdmin ? form.urlPlanilha : '',
      urlPastaFichas: urlPastaFichas,
      isAdmin: !!isAdmin,
    });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR,
      'Erro ao obter dados do dashboard: ' + e.message, e.stack);
    return respostaErro('Erro ao carregar o dashboard.', 'ERRO_DASH');
  }
}

/**
 * Retorna respostas individuais com paginação.
 * @param {string} formId
 * @param {number} [pagina=1] - Página (1-based)
 * @param {number} [porPagina=20] - Itens por página
 * @param {string} [busca=''] - Filtro de texto
 * @returns {{ok: boolean, data?: Object, error?: string}}
 */
function listarRespostas(formId, pagina, porPagina, busca) {
  try {
    const formResult = obterFormulario(formId);
    if (!formResult.ok) return formResult;
    const form = formResult.data;

    const { planilhaId } = _obterInfoPlanilhaSimples(formId, form);
    if (!planilhaId) return respostaOk({ total: 0, pagina: 1, itens: [] });

    const ss = SpreadsheetApp.openById(planilhaId);
    const aba = ss.getSheetByName('Respostas');

    if (!aba || aba.getLastRow() <= 1) {
      return respostaOk({ total: 0, pagina: 1, itens: [] });
    }

    const dados = aba.getDataRange().getValues();
    const cabecalhos = dados[0];
    const notasCabecalhos = aba.getRange(1, 1, 1, aba.getLastColumn()).getNotes()[0];
    const idsCabecalhos = cabecalhos.map((c, idx) => notasCabecalhos[idx] || c);
    let linhas = dados.slice(1).map(l => {
      const obj = _arrayParaObjeto(idsCabecalhos, l);
      Object.keys(obj).forEach(k => {
        if (obj[k] instanceof Date) {
          obj[k] = Utilities.formatDate(obj[k], 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm:ss');
        }
      });
      return obj;
    });

    // Filtro de busca
    if (busca && busca.trim()) {
      const termoBusca = busca.trim().toLowerCase();
      linhas = linhas.filter(linha =>
        Object.values(linha).some(v => String(v).toLowerCase().includes(termoBusca))
      );
    }

    // Paginação
    const pg = Math.max(1, parseInt(pagina) || 1);
    const pp = Math.min(100, Math.max(1, parseInt(porPagina) || 20));
    const total = linhas.length;
    const inicio = (pg - 1) * pp;
    const fim = inicio + pp;

    return respostaOk({
      total: total,
      pagina: pg,
      porPagina: pp,
      totalPaginas: Math.ceil(total / pp),
      cabecalhos: cabecalhos,
      idsCabecalhos: idsCabecalhos,
      itens: linhas.slice(inicio, fim),
    });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR, 'Erro ao listar respostas: ' + e.message, e.stack);
    return respostaErro('Erro ao carregar as respostas.', 'ERRO_LISTAR_RESP');
  }
}

/**
 * Exporta as respostas como CSV (string).
 * @param {string} formId
 * @returns {{ok: boolean, data?: {csv: string, nomeArquivo: string}}}
 */
function exportarCSV(formId) {
  try {
    const formResult = obterFormulario(formId);
    if (!formResult.ok) return formResult;
    const form = formResult.data;

    const { planilhaId } = _obterInfoPlanilhaSimples(formId, form);
    if (!planilhaId) return respostaOk({ csv: '', nomeArquivo: formId + '.csv' });

    const ss = SpreadsheetApp.openById(planilhaId);
    const aba = ss.getSheetByName('Respostas');

    if (!aba) return respostaOk({ csv: '', nomeArquivo: formId + '.csv' });

    const dados = aba.getDataRange().getValues();
    const csv = dados.map(linha =>
      linha.map(cel => {
        const s = String(cel).replace(/"/g, '""');
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
      }).join(',')
    ).join('\n');

    return respostaOk({
      csv: csv,
      nomeArquivo: formId + '_respostas_' +
        Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyyMMdd') + '.csv',
    });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR, 'Erro ao exportar CSV: ' + e.message, e.stack);
    return respostaErro('Erro ao exportar o CSV.', 'ERRO_CSV');
  }
}

// ============================================================
// FUNÇÕES DE AGREGAÇÃO
// ============================================================

/**
 * Conta respostas agrupadas por dia.
 * @param {Object[]} respostas
 * @returns {Object[]} [{data: 'YYYY-MM-DD', total: N}]
 * @private
 */
function _contarPorDia(respostas) {
  const contagem = {};
  respostas.forEach(r => {
    if (!r.timestamp) return;
    const data = String(r.timestamp).substring(0, 10);
    contagem[data] = (contagem[data] || 0) + 1;
  });

  return Object.entries(contagem)
    .map(([data, total]) => ({ data, total }))
    .sort((a, b) => a.data.localeCompare(b.data));
}

/**
 * Gera dados de gráficos para cada pergunta.
 * @param {Object[]} perguntas
 * @param {string[]} cabecalhos
 * @param {Array[]} linhas
 * @returns {Object[]}
 * @private
 */
function _gerarDadosGraficos(perguntas, cabecalhos, linhas) {
  const graficos = [];

  perguntas.forEach(pergunta => {
    const colIdx = cabecalhos.indexOf(pergunta.id);
    if (colIdx === -1) return;

    const valores = linhas
      .map(l => l[colIdx])
      .filter(v => v !== null && v !== undefined && String(v).trim() !== '');

    switch (pergunta.tipo) {
      case TIPO_PERGUNTA.MULTIPLA_ESCOLHA:
      case TIPO_PERGUNTA.LISTA_SUSPENSA:
        graficos.push({
          perguntaId: pergunta.id,
          titulo: pergunta.titulo,
          tipo: 'pizza',
          dados: _contarOcorrencias(valores),
        });
        break;

      case TIPO_PERGUNTA.CAIXAS_SELECAO:
        const valoresFlat = valores.flatMap(v =>
          String(v).split(',').map(s => s.trim())
        );
        graficos.push({
          perguntaId: pergunta.id,
          titulo: pergunta.titulo,
          tipo: 'barras',
          dados: _contarOcorrencias(valoresFlat),
        });
        break;

      case TIPO_PERGUNTA.ESCALA_LINEAR:
      case TIPO_PERGUNTA.AVALIACAO_ESTRELAS:
      case TIPO_PERGUNTA.SLIDER_NUMERICO:
        graficos.push({
          perguntaId: pergunta.id,
          titulo: pergunta.titulo,
          tipo: 'histograma',
          dados: _contarOcorrencias(valores.map(v => String(Math.round(parseFloat(v))))),
          media: valores.reduce((s, v) => s + parseFloat(v), 0) / valores.length,
        });
        break;

      case TIPO_PERGUNTA.RESPOSTA_CURTA:
      case TIPO_PERGUNTA.PARAGRAFO:
        // Lista das últimas 10 respostas
        graficos.push({
          perguntaId: pergunta.id,
          titulo: pergunta.titulo,
          tipo: 'lista',
          dados: valores.slice(-10).map(v => ({ label: String(v), count: 1 })),
          total: valores.length,
        });
        break;
    }
  });

  return graficos;
}

/**
 * Conta ocorrências de cada valor em um array.
 * @param {string[]} valores
 * @returns {{label: string, count: number}[]}
 * @private
 */
function _contarOcorrencias(valores) {
  const contagem = {};
  valores.forEach(v => {
    const chave = String(v).trim();
    contagem[chave] = (contagem[chave] || 0) + 1;
  });
  return Object.entries(contagem)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Calcula taxa de conclusão das respostas.
 * @param {Object[]} perguntas
 * @param {string[]} cabecalhos
 * @param {Array[]} linhas
 * @returns {number} Percentual (0-100)
 * @private
 */
function _calcularTaxaConclusao(perguntas, cabecalhos, linhas) {
  if (linhas.length === 0) return 0;
  const obrigatorias = perguntas.filter(p => p.obrigatoria);
  if (obrigatorias.length === 0) return 100;

  let concluidas = 0;
  linhas.forEach(linha => {
    const todasPreenchidas = obrigatorias.every(p => {
      const colIdx = cabecalhos.indexOf(p.id);
      if (colIdx === -1) return false;
      const v = linha[colIdx];
      return v !== null && v !== undefined && String(v).trim() !== '';
    });
    if (todasPreenchidas) concluidas++;
  });

  return Math.round((concluidas / linhas.length) * 100);
}

/**
 * Obtém planilhaId de forma simples a partir dos dados do formulário.
 * @param {string} formId
 * @param {Object} form
 * @returns {{planilhaId: string}}
 * @private
 */
function _obterInfoPlanilhaSimples(formId, form) {
  return { planilhaId: form.planilhaId || '' };
}

/**
 * Apaga permanentemente todas as respostas (limpa a aba Respostas a partir da linha 2)
 * e exclui todos os arquivos da pasta de Uploads e Fichas no Drive.
 * @param {string} formId
 * @returns {{ok: boolean, error?: string}}
 */
function resetarFormulario(formId) {
  try {
    const formResult = obterFormulario(formId);
    if (!formResult.ok) return formResult;
    const form = formResult.data;

    // 1. Limpar planilha de respostas
    const { planilhaId } = _obterInfoPlanilhaSimples(formId, form);
    if (planilhaId) {
      const ss = SpreadsheetApp.openById(planilhaId);
      const aba = ss.getSheetByName('Respostas');
      if (aba && aba.getLastRow() > 1) {
        aba.deleteRows(2, aba.getLastRow() - 1);
        SpreadsheetApp.flush();
      }
    }

    // 2. Apagar anexos na pasta de Uploads do Drive
    if (form.pastaId) {
      const pastaPai = DriveApp.getFolderById(form.pastaId);
      
      // Pasta de Uploads
      const pastasUploads = pastaPai.getFoldersByName('Uploads');
      if (pastasUploads.hasNext()) {
        const pastaUploads = pastasUploads.next();
        
        // Excluir todos os arquivos recursivamente na pasta de Uploads
        const arquivos = pastaUploads.getFiles();
        while (arquivos.hasNext()) {
          arquivos.next().setTrashed(true);
        }
        
        // Excluir também subpastas se houver
        const subpastas = pastaUploads.getFolders();
        while (subpastas.hasNext()) {
          subpastas.next().setTrashed(true);
        }
      }

      // Pasta de Fichas de Inscrição
      const pastasFichas = pastaPai.getFoldersByName('Fichas de Inscrição');
      if (pastasFichas.hasNext()) {
        const pastaFichas = pastasFichas.next();
        const arquivosFichas = pastaFichas.getFiles();
        while (arquivosFichas.hasNext()) {
          arquivosFichas.next().setTrashed(true);
        }
      }
    }

    logEvento(formId, NIVEL_LOG.INFO, 'Formulário resetado: todas as respostas e arquivos foram excluídos.');
    return respostaOk({ resetado: true });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR, 'Erro ao resetar formulário: ' + e.message, e.stack);
    return respostaErro('Não foi possível resetar o formulário: ' + e.message, 'ERRO_RESET');
  }
}

