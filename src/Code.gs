/**
 * @fileoverview Roteador principal do SETUR Forms GAS.
 * Ponto de entrada HTTP: doGet() e a função pública api().
 */

// ============================================================
// ROTEADOR HTTP
// ============================================================

/**
 * Ponto de entrada HTTP do Web App.
 * Roteia por parâmetros de query string para o HTML correto.
 *
 * Rotas:
 *  ?page=admin           → Painel administrativo (builder)
 *  ?form=<formId>        → Formulário público para resposta
 *  ?page=dash&form=<id>  → Dashboard de resultados
 *  (sem parâmetros)      → Página índice (formulários ativos)
 *
 * @param {GoogleAppsScript.Events.DoGet} e - Evento HTTP GET
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(e) {
  try {
    const params = e.parameter || {};
    const page = params.page || '';
    const formId = params.form || '';
    const token = params.token || '';
    const editar = params.editar || '';

    // ── Painel admin ────────────────────────────────────────
    if (page === 'admin') {
      return _renderizarPagina('admin', { titulo: 'SETUR Forms — Painel Admin' });
    }

    // ── Dashboard ───────────────────────────────────────────
    if (page === 'dash') {
      if (!formId) return _paginaErro('Formulário não especificado.');
      return _renderizarPagina('dash', {
        titulo: 'SETUR Forms — Dashboard',
        formId: formId,
        token: token,
      });
    }

    // ── Formulário público ──────────────────────────────────
    if (formId) {
      return _renderizarPagina('form', {
        titulo: 'SETUR Forms — Formulário',
        formId: formId,
        tokenEdicao: editar,
      });
    }

    // ── Índice (sem parâmetros) ─────────────────────────────
    const config = obterConfig();
    if (config['mostrarIndice'] === 'true' || config['mostrarIndice'] === true) {
      return _renderizarPagina('index', {
        titulo: 'SETUR Forms — Formulários',
        urlBase: ScriptApp.getService().getUrl(),
      });
    }

    // Índice desativado
    return _paginaErro('Nenhum formulário especificado.');

  } catch (e) {
    logEvento('SYSTEM', NIVEL_LOG.ERROR, 'Erro no doGet: ' + e.message, e.stack);
    return _paginaErro('Erro interno. Por favor, tente novamente.');
  }
}

// ============================================================
// HELPER DE RENDERIZAÇÃO
// ============================================================

/**
 * Renderiza uma página HTML com variáveis injetadas.
 * @param {string} pagina - Nome do arquivo HTML (sem .html)
 * @param {Object} vars - Variáveis a injetar via scriptlets
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 * @private
 */
function _renderizarPagina(pagina, vars) {
  const template = HtmlService.createTemplateFromFile(pagina);

  // Injetar variáveis no template
  Object.entries(vars).forEach(([chave, valor]) => {
    template[chave] = valor;
  });

  const output = template.evaluate();
  output.setTitle(vars.titulo || 'SETUR Forms GAS');
  output.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  output.addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0');

  return output;
}

/**
 * Retorna uma página de erro amigável.
 * @param {string} mensagem
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 * @private
 */
function _paginaErro(mensagem) {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SETUR Forms — Erro</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', sans-serif;
      background: #f8f9fa;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 48px 40px;
      max-width: 480px;
      text-align: center;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
    }
    .icon { font-size: 56px; margin-bottom: 20px; }
    h1 { font-size: 22px; color: #202124; margin-bottom: 12px; }
    p { color: #5f6368; font-size: 15px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>Página não encontrada</h1>
    <p>${mensagem}</p>
  </div>
</body>
</html>`;

  return HtmlService.createHtmlOutput(html)
    .setTitle('SETUR Forms — Erro')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

// ============================================================
// INCLUDE (HELPER PARA TEMPLATES HTML)
// ============================================================

/**
 * Inclui o conteúdo de um arquivo HTML parcial no template.
 * Uso: <?!= include('css') ?> dentro dos arquivos .html
 * @param {string} nomeArquivo - Nome do arquivo (sem .html)
 * @returns {string} Conteúdo HTML do arquivo
 */
function include(nomeArquivo) {
  return HtmlService.createHtmlOutputFromFile(nomeArquivo).getContent();
}
