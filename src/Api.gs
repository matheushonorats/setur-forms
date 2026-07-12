/**
 * @fileoverview API Dispatcher central do SETUR Forms GAS.
 * Ponto único de entrada para todas as chamadas do frontend.
 * Valida sessão/permissões e roteia para os serviços corretos.
 */

// ============================================================
// MAPA DE AÇÕES
// ============================================================

/**
 * Ações que NÃO requerem autenticação admin.
 * Requerem apenas que o formulário exista e esteja ativo.
 */
const ACOES_PUBLICAS = new Set([
  'obterFormularioPublico',
  'gerarNonce',
  'submitResponse',
  'uploadArquivo',
  'deletarArquivoUpload',   // Permitido publicamente: o respondente pode remover seu próprio arquivo
  'carregarRespostaParaEdicao',
  'listarFormulariosPublicos',
  'validarTokenDashboard',
]);

/**
 * Dispatcher central da API.
 * Chamado pelo frontend via google.script.run.api(action, payload).
 * Retorna sempre {ok: boolean, data?, error?, codigo?}.
 *
 * @param {string} action - Nome da ação a executar
 * @param {Object} payload - Dados da ação
 * @returns {{ok: boolean, data?: *, error?: string, codigo?: string}}
 */
function api(action, payload) {
  try {
    if (!action) return respostaErro('Ação não especificada.', 'ACAO_INVALIDA');

    const p = payload || {};

    // ── Ações de autenticação (sem sessão exigida) ──────
    if (action === 'login') {
      return autenticar(p.senha, p.fingerprint || 'anon');
    }
    if (action === 'alterarSenha') {
      if (!validarSessao(p.token)) return respostaErro('Sessão expirada.', 'SESSAO_INVALIDA');
      return alterarSenha(p.senhaAtual, p.novaSenha);
    }
    if (action === 'logout') {
      logout(p.token);
      return respostaOk({ mensagem: 'Sessão encerrada.' });
    }

    // ── Ações públicas (sem autenticação admin) ─────────
    if (ACOES_PUBLICAS.has(action)) {
      return _rotearAcaoPublica(action, p);
    }

    // ── Ações protegidas (exigem sessão admin) ──────────
    if (!validarSessao(p.token)) {
      return respostaErro('Sessão expirada. Faça login novamente.', 'SESSAO_INVALIDA');
    }

    return _rotearAcaoAdmin(action, p);

  } catch (e) {
    logEvento('SYSTEM', NIVEL_LOG.ERROR,
      'Erro no dispatcher API [' + action + ']: ' + e.message, e.stack);
    return respostaErro('Erro interno do servidor. Tente novamente.', 'ERRO_SERVIDOR');
  }
}

// ============================================================
// ROTEADOR DE AÇÕES PÚBLICAS
// ============================================================

/**
 * Roteia ações que não requerem sessão admin.
 * @param {string} action
 * @param {Object} p - Payload
 * @returns {Object} Resposta padronizada
 * @private
 */
function _rotearAcaoPublica(action, p) {
  switch (action) {
    case 'obterFormularioPublico': {
      // configJSON/tema vão como STRING ao cliente: enviar objeto aninhado pelo
      // google.script.run pode quebrar a serialização (ex.: U+2028/U+2029 em texto
      // colado de PDF/Word) e travar a página em "Carregando...". O cliente faz JSON.parse.
      const rPub = obterFormularioPublico(p.formId);
      if (rPub && rPub.ok && rPub.data) {
        if (typeof rPub.data.configJSON !== 'string') rPub.data.configJSON = JSON.stringify(rPub.data.configJSON || {});
        if (typeof rPub.data.tema !== 'string') rPub.data.tema = JSON.stringify(rPub.data.tema || {});
        rPub.data.configJSON = rPub.data.configJSON.replace(/[\u2028\u2029]/g, ' ');
        rPub.data.tema = rPub.data.tema.replace(/[\u2028\u2029]/g, ' ');
        if (rPub.data.descricao) rPub.data.descricao = String(rPub.data.descricao).replace(/[\u2028\u2029]/g, ' ');
        if (rPub.data.titulo) rPub.data.titulo = String(rPub.data.titulo).replace(/[\u2028\u2029]/g, ' ');
      }
      return rPub;
    }

    case 'gerarNonce':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return respostaOk({ nonce: gerarNonce(p.formId) });

    case 'submitResponse':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return receberResposta(p.formId, p);

    case 'uploadArquivo':
      if (!p.formId || !p.perguntaId) {
        return respostaErro('formId e perguntaId são obrigatórios.', 'PARAM_INVALIDO');
      }
      // Obter pasta de uploads do formulário
      const formInfo = obterFormularioPublico(p.formId);
      if (!formInfo.ok) return formInfo;

      const linha = _encontrarLinhaForm(p.formId);
      if (!linha) return respostaErro('Formulário não encontrado.', 'NAO_ENCONTRADO');
      const formObj = _linhaParaObjeto(linha);

      // Encontrar configurações de upload da pergunta
      const config = JSON.parse(formObj.configJSON || '{}');
      let perguntaConfig = null;
      (config.secoes || []).forEach(s => {
        (s.perguntas || []).forEach(pg => {
          if (pg.id === p.perguntaId) perguntaConfig = pg;
        });
      });

      const tamanhoMax = perguntaConfig && perguntaConfig.config
        ? (parseInt(perguntaConfig.config.tamanhoMaxMB, 10) || LIMITE.UPLOAD_MAX_MB)
        : LIMITE.UPLOAD_MAX_MB;

      let extensoes = [];
      if (perguntaConfig && perguntaConfig.config) {
        const rawFormatos = perguntaConfig.config.formatosAceitos || perguntaConfig.config.extensoesPermitidas;
        if (Array.isArray(rawFormatos)) {
          extensoes = rawFormatos;
        } else if (typeof rawFormatos === 'string') {
          extensoes = rawFormatos.split(',').map(s => s.trim()).filter(Boolean);
        }
      }
      extensoes = extensoes.map(e => e.toLowerCase());


      // Obter pasta de uploads
      const uploadsFolderId = _obterUploadsFolderId(formObj.pastaId);
      const nomePastaPergunta = perguntaConfig ? (perguntaConfig.titulo || perguntaConfig.id) : p.perguntaId;
      const subpastaId = obterOuCriarSubpastaPorId(uploadsFolderId, nomePastaPergunta);

      return salvarUpload(
        p.formId, p.perguntaId, subpastaId,
        p.base64Data, p.nomeArquivo, p.mimeType,
        tamanhoMax, extensoes
      );

    case 'deletarArquivoUpload':
      return deletarArquivoUpload(p.url);

    case 'carregarRespostaParaEdicao':
      return carregarRespostaParaEdicao(p.token);

    case 'listarFormulariosPublicos':
      return listarFormularios({ publico: true });

    case 'validarTokenDashboard':
      const valido = validarTokenPublico(p.formId, p.token) || validarSessao(p.token);
      if (valido) {
        const isAdmin = validarSessao(p.token);
        return obterDadosDashboard(p.formId, isAdmin);
      }
      return respostaErro('Token inválido ou expirado.', 'TOKEN_INVALIDO');

    default:
      return respostaErro('Ação pública não reconhecida: ' + action, 'ACAO_INVALIDA');
  }
}

// ============================================================
// ROTEADOR DE AÇÕES ADMIN (PROTEGIDAS)
// ============================================================

/**
 * Roteia ações que requerem sessão admin válida.
 * @param {string} action
 * @param {Object} p - Payload
 * @returns {Object} Resposta padronizada
 * @private
 */
function _rotearAcaoAdmin(action, p) {
  switch (action) {

    // ── Formulários ───────────────────────────────────────
    case 'criarFormulario':
      return criarFormulario(p.dados);

    case 'editarFormulario':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return editarFormulario(p.formId, p.atualizacoes);

    case 'obterFormulario':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return obterFormulario(p.formId);

    case 'listarFormularios':
      return listarFormularios(p.filtros);

    case 'duplicarFormulario':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return duplicarFormulario(p.formId);

    case 'excluirFormulario':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return excluirFormulario(p.formId);

    case 'alterarStatus':
      if (!p.formId || !p.status) {
        return respostaErro('formId e status são obrigatórios.', 'PARAM_INVALIDO');
      }
      return alterarStatus(p.formId, p.status);

    case 'publicarFormulario':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return publicarFormulario(p.formId);

    case 'obterEstadoPublicacao':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return obterEstadoPublicacao(p.formId);

    case 'programarFuncionamento':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return programarFuncionamento(p.formId, p.dataInicio, p.dataLimite);

    // ── Dashboard ─────────────────────────────────────────
    case 'obterDadosDashboard':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return obterDadosDashboard(p.formId, true);

    case 'resetarFormulario':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return resetarFormulario(p.formId);

    case 'listarRespostas':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return listarRespostas(p.formId, p.pagina, p.porPagina, p.busca);

    case 'exportarCSV':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return exportarCSV(p.formId);

    case 'gerarLinkPublicoDashboard':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return gerarLinkPublicoDashboard(p.formId);

    case 'gerarLinkCurto':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return gerarLinkCurto(p.formId);

    case 'gerarFicha':
      if (!p.formId || !p.responseId) {
        return respostaErro('formId e responseId são obrigatórios.', 'PARAM_INVALIDO');
      }
      return gerarFichaInscricao(p.formId, p.responseId);

    case 'gerarFichasTodas':
      if (!p.formId) return respostaErro('formId obrigatório.', 'PARAM_INVALIDO');
      return gerarFichasTodas(p.formId);

    case 'gerarLinkEdicao':
      if (!p.formId || !p.responseId) {
        return respostaErro('formId e responseId são obrigatórios.', 'PARAM_INVALIDO');
      }
      return gerarLinkEdicao(p.formId, p.responseId);

    // ── Configurações globais ─────────────────────────────
    case 'obterConfig':
      return respostaOk(obterConfig());

    case 'atualizarConfig':
      if (!p.chave || p.valor === undefined) {
        return respostaErro('chave e valor são obrigatórios.', 'PARAM_INVALIDO');
      }
      // Não permitir alterar chaves sensíveis por esta rota
      if (p.chave === 'senhaHash') {
        return respostaErro('Use a ação alterarSenha para alterar a senha.', 'OPERACAO_INVALIDA');
      }
      definirConfig(p.chave, p.valor);
      return respostaOk({ mensagem: 'Configuração atualizada.' });

    case 'obterUrls':
      const urlBase = _urlWebApp_();
      return respostaOk({
        admin: urlBase + '?page=admin',
        indice: urlBase,
        webApp: urlBase,
      });

    case 'diagnostico':
      return respostaOk(diagnostico());

    default:
      return respostaErro('Ação não reconhecida: ' + action, 'ACAO_INVALIDA');
  }
}

// ============================================================
// HELPER INTERNO
// ============================================================

/**
 * Obtém o ID da pasta de uploads dado o ID da pasta do formulário.
 * @param {string} pastaFormId
 * @returns {string} ID da pasta uploads
 * @private
 */
function _obterUploadsFolderId(pastaFormId) {
  try {
    const pasta = DriveApp.getFolderById(pastaFormId);
    const uploads = pasta.getFoldersByName('uploads');
    if (uploads.hasNext()) return uploads.next().getId();
    return pasta.createFolder('uploads').getId();
  } catch (e) {
    throw new Error('Pasta de uploads não encontrada: ' + e.message);
  }
}