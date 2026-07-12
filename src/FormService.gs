/**
 * @fileoverview Serviço de gestão de formulários do SETUR Forms GAS.
 * CRUD completo, configJSON, lógica de programação de funcionamento.
 */

// ============================================================
// CRIAR FORMULÁRIO
// ============================================================

/**
 * Cria um novo formulário com configuração inicial.
 * @param {Object} dadosForm - Dados do formulário
 * @param {string} dadosForm.titulo - Título do formulário
 * @param {string} [dadosForm.descricao] - Descrição
 * @param {Object} [dadosForm.configJSON] - Configuração completa (perguntas, etc)
 * @param {Object} [dadosForm.tema] - Configurações visuais
 * @returns {{ok: boolean, data?: Object, error?: string}}
 */
function criarFormulario(dadosForm) {
  try {
    if (!dadosForm.titulo || !dadosForm.titulo.trim()) {
      return respostaErro('O título do formulário é obrigatório.', 'TITULO_OBRIGATORIO');
    }

    const ss = obterPlanilhaMestre_();
    const aba = ss.getSheetByName(ABA.FORMS);

    // Verificar se já existe formulário com o mesmo título (não excluído)
    const tituloBusca = dadosForm.titulo.trim().toLowerCase();
    const dadosAba = aba.getDataRange().getValues();
    if (dadosAba.length > 1) {
      const cabecalhos = dadosAba[0];
      const tituloIdx = cabecalhos.indexOf('titulo');
      const excluidoIdx = cabecalhos.indexOf('excluido');
      
      const existeDuplicado = dadosAba.slice(1).some(linha => {
        const tituloExistente = String(linha[tituloIdx] || '').trim().toLowerCase();
        const excluido = String(linha[excluidoIdx] || '');
        return tituloExistente === tituloBusca && excluido !== 'true';
      });

      if (existeDuplicado) {
        return respostaErro('Já existe um formulário com este título.', 'TITULO_DUPLICADO');
      }
    }

    // Gerar ID único FIXO (letras+números, estilo Google Forms). Não muda com o
    // título — a URL do formulário permanece estável mesmo se o nome for alterado.
    const formId = _gerarIdFormulario_();

    // Config padrão e mesclagem
    const configJSONDefault = _configJSONPadrao();
    let configJSON = configJSONDefault;
    if (dadosForm.configJSON) {
      let cfgInput = dadosForm.configJSON;
      if (typeof cfgInput === 'string') {
        try { cfgInput = JSON.parse(cfgInput); } catch (e) { cfgInput = {}; }
      }
      configJSON = {
        secoes: cfgInput.secoes || configJSONDefault.secoes,
        logicaCondicional: cfgInput.logicaCondicional || configJSONDefault.logicaCondicional,
        configuracoes: Object.assign({}, configJSONDefault.configuracoes, cfgInput.configuracoes || {}),
        aparencia: Object.assign({}, configJSONDefault.aparencia, cfgInput.aparencia || {}),
      };
    }

    const temaDefault = _temaPadrao();
    let tema = temaDefault;
    if (dadosForm.tema) {
      let temaInput = dadosForm.tema;
      if (typeof temaInput === 'string') {
        try { temaInput = JSON.parse(temaInput); } catch (e) { temaInput = {}; }
      }
      tema = Object.assign({}, temaDefault, temaInput);
    }

    // Criar estrutura no Drive
    const drive = criarPastaFormulario(formId, dadosForm.titulo);

    // Extrair cabeçalhos das perguntas para a planilha
    const cabecalhos = _extrairCabecalhosComDetalhes(configJSON);

    // Criar planilha de respostas
    const planilha = criarPlanilhaRespostas(
      formId, dadosForm.titulo, drive.pastaId, cabecalhos
    );

    const agora = formatarDataBR(new Date());

    // Gravar na aba FORMS
    aba.appendRow([
      formId,                          // formId
      dadosForm.titulo,                // titulo
      dadosForm.descricao || '',       // descricao
      STATUS.RASCUNHO,                 // status
      planilha.urlPlanilha,            // urlPlanilha
      planilha.planilhaId,             // planilhaId
      drive.pastaId,                   // pastaId
      agora,                           // dataCriacao
      dadosForm.dataInicio || '',      // dataInicio
      dadosForm.dataLimite || '',      // dataLimite
      dadosForm.limiteRespostas || 0,  // limiteRespostas
      0,                               // totalRespostas
      JSON.stringify(tema),            // tema
      JSON.stringify(configJSON),      // configJSON (rascunho)
      'false',                         // excluido
      '',                              // configJSONPublicado (vazio até a publicação)
    ]);

    logEvento(formId, NIVEL_LOG.INFO, 'Formulário criado: ' + dadosForm.titulo);

    return respostaOk({
      formId: formId,
      status: STATUS.RASCUNHO,
      urlPlanilha: planilha.urlPlanilha,
      urlFormulario: ScriptApp.getService().getUrl() + '?form=' + formId,
      urlDashboard: ScriptApp.getService().getUrl() + '?page=dash&form=' + formId,
    });
  } catch (e) {
    logEvento('SYSTEM', NIVEL_LOG.ERROR, 'Erro ao criar formulário: ' + e.message, e.stack);
    return respostaErro('Erro ao criar o formulário. Tente novamente.', 'ERRO_CRIAR');
  }
}

// ============================================================
// OBTER FORMULÁRIO
// ============================================================

/**
 * Retorna os dados completos de um formulário.
 * @param {string} formId
 * @param {boolean} [incluirRespostas=false] - Se true, inclui total de respostas
 * @returns {{ok: boolean, data?: Object, error?: string}}
 */
function obterFormulario(formId) {
  try {
    const linha = _encontrarLinhaForm(formId);
    if (!linha) return respostaErro('Formulário não encontrado.', 'NAO_ENCONTRADO');

    const form = _linhaParaObjeto(linha);
    if (String(form.excluido) === 'true') {
      return respostaErro('Formulário não encontrado.', 'NAO_ENCONTRADO');
    }

    form.configJSON = form.configJSON ? JSON.parse(form.configJSON) : {};
    form.tema = form.tema ? JSON.parse(form.tema) : {};

    return respostaOk(form);
  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR, 'Erro ao obter formulário: ' + e.message, e.stack);
    return respostaErro('Erro ao obter o formulário.', 'ERRO_OBTER');
  }
}

/**
 * Retorna os dados de um formulário para renderização pública.
 * Não requer sessão admin — dados não sensíveis apenas.
 * @param {string} formId
 * @returns {{ok: boolean, data?: Object, error?: string}}
 */
function obterFormularioPublico(formId) {
  try {
    const linha = _encontrarLinhaForm(formId);
    if (!linha) return respostaErro('Formulário não encontrado.', 'NAO_ENCONTRADO');

    const form = _linhaParaObjeto(linha);
    if (String(form.excluido) === 'true') return respostaErro('Formulário não encontrado.', 'NAO_ENCONTRADO');

    // Verificar status e restrições
    const agora = new Date();

    if (form.status === STATUS.RASCUNHO) {
      return respostaErro('Este formulário ainda não está disponível.', 'RASCUNHO');
    }
    if (form.status === STATUS.PAUSADO) {
      return respostaErro('Este formulário está temporariamente pausado.', 'PAUSADO');
    }
    if (form.status === STATUS.ENCERRADO) {
      return respostaErro('Este formulário foi encerrado.', 'ENCERRADO');
    }

    // Verificar janela de tempo
    if (form.dataInicio) {
      const inicio = parseDateInFuso(form.dataInicio);
      if (inicio && agora < inicio) {
        return respostaErro(
          'Este formulário ainda não está aberto. Disponível a partir de ' +
          Utilities.formatDate(inicio, 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm') + '.',
          'AINDA_NAO_INICIOU'
        );
      }
    }
    if (form.dataLimite) {
      const limite = parseDateInFuso(form.dataLimite);
      if (limite && agora > limite) {
        return respostaErro('O prazo para responder este formulário expirou.', 'PRAZO_EXPIRADO');
      }
    }

    // Verificar limite de respostas
    const limiteResp = parseInt(form.limiteRespostas) || 0;
    const totalResp = parseInt(form.totalRespostas) || 0;
    if (limiteResp > 0 && totalResp >= limiteResp) {
      return respostaErro('Este formulário atingiu o limite máximo de respostas.', 'LIMITE_ATINGIDO');
    }

    // Retornar apenas campos necessários para o respondente (sem dados internos)
    // configJSONPublicado é a versão publicada (snapshot); configJSON é o rascunho.
    // Se configJSONPublicado existir, serve-o ao público; caso contrário, usa configJSON
    // (retrocompatibilidade com formulários criados antes desta feature).
    const configPublico = form.configJSONPublicado && String(form.configJSONPublicado).trim()
      ? _parseConfig_(form.configJSONPublicado)
      : _parseConfig_(form.configJSON);
    const tema = _parseConfig_(form.tema);

    return respostaOk({
      formId: form.formId,
      titulo: form.titulo,
      descricao: form.descricao,
      status: form.status,
      dataLimite: form.dataLimite,
      limiteRespostas: limiteResp,
      totalRespostas: totalResp,
      configJSON: configPublico,
      tema: tema,
    });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR, 'Erro ao obter formulário público: ' + e.message, e.stack);
    return respostaErro('Erro ao carregar o formulário.', 'ERRO_OBTER');
  }
}

// ============================================================
// LISTAR FORMULÁRIOS
// ============================================================

/**
 * Lista todos os formulários (excluídos logicamente omitidos).
 * @param {Object} [filtros] - Filtros opcionais
 * @param {string} [filtros.status] - Filtrar por status
 * @param {boolean} [filtros.apenasAtivos] - Somente formulários ativos
 * @returns {{ok: boolean, data?: Object[], error?: string}}
 */
function listarFormularios(filtros) {
  try {
    const ss = obterPlanilhaMestre_();
    const aba = ss.getSheetByName(ABA.FORMS);
    const dados = aba.getDataRange().getValues();

    if (dados.length <= 1) return respostaOk([]);

    const cabecalhos = dados[0];
    let formularios = dados.slice(1)
      .map(linha => _linhaParaObjeto(linha))
      .filter(f => String(f.excluido) !== 'true' && f.formId);

    if (filtros) {
      if (filtros.status) {
        formularios = formularios.filter(f => f.status === filtros.status);
      }
      if (filtros.apenasAtivos) {
        formularios = formularios.filter(f => f.status === STATUS.ATIVO);
      }
      // Listagem pública: mostra publicados (ativos, pausados, encerrados),
      // mas nunca rascunhos (versões ainda não publicadas).
      if (filtros.publico) {
        formularios = formularios.filter(f => f.status !== STATUS.RASCUNHO);
      }
    }

    // Ordenar por data de criação (mais recente primeiro)
    formularios.sort((a, b) => new Date(b.dataCriacao) - new Date(a.dataCriacao));

    // Não retornar configJSON completo na listagem (pesado)
    return respostaOk(formularios.map(f => ({
      formId: f.formId,
      titulo: f.titulo,
      descricao: f.descricao,
      status: f.status,
      urlPlanilha: f.urlPlanilha,
      dataCriacao: f.dataCriacao,
      dataInicio: f.dataInicio,
      dataLimite: f.dataLimite,
      limiteRespostas: f.limiteRespostas,
      totalRespostas: f.totalRespostas,
      tema: f.tema ? JSON.parse(f.tema) : {},
    })));
  } catch (e) {
    logEvento('SYSTEM', NIVEL_LOG.ERROR, 'Erro ao listar formulários: ' + e.message, e.stack);
    return respostaErro('Erro ao listar formulários.', 'ERRO_LISTAR');
  }
}

// ============================================================
// EDITAR FORMULÁRIO
// ============================================================

/**
 * Atualiza os dados e/ou configJSON de um formulário.
 * Perguntas novas são adicionadas à planilha sem destruir dados.
 * @param {string} formId
 * @param {Object} atualizacoes - Campos a atualizar
 * @returns {{ok: boolean, error?: string}}
 */
function editarFormulario(formId, atualizacoes) {
  try {
    const { numLinha, dados } = _encontrarLinhaComIndice(formId);
    if (numLinha === -1) return respostaErro('Formulário não encontrado.', 'NAO_ENCONTRADO');

    const ss = obterPlanilhaMestre_();
    const aba = ss.getSheetByName(ABA.FORMS);
    const cabecalhos = aba.getRange(1, 1, 1, aba.getLastColumn()).getValues()[0];
    const obj = _arrayParaObjeto(cabecalhos, dados);

    let finalFormId = formId;
    let formIdAlterado = false;

    // O título mudou? O formId é FIXO (a URL nunca muda). Apenas renomeamos os
    // artefatos vinculados: a pasta do Drive aqui; a planilha de respostas é
    // renomeada logo abaixo, em sincronizarPlanilhaForm ("Respostas - <título>").
    if (atualizacoes.titulo && atualizacoes.titulo.trim() && atualizacoes.titulo !== obj.titulo) {
      // Verificar se já existe outro formulário com este título (não excluído)
      const tituloBusca = atualizacoes.titulo.trim().toLowerCase();
      const dadosAba = aba.getDataRange().getValues();
      const tituloIdx = cabecalhos.indexOf('titulo');
      const excluidoIdx = cabecalhos.indexOf('excluido');
      const formIdIdx = cabecalhos.indexOf('formId');
      
      const existeDuplicado = dadosAba.slice(1).some(linha => {
        const tituloExistente = String(linha[tituloIdx] || '').trim().toLowerCase();
        const excluido = String(linha[excluidoIdx] || '');
        const idExistente = String(linha[formIdIdx] || '');
        return tituloExistente === tituloBusca && excluido !== 'true' && idExistente !== formId;
      });

      if (existeDuplicado) {
        return respostaErro('Já existe outro formulário com este título.', 'TITULO_DUPLICADO');
      }

      if (obj.pastaId) {
        try {
          DriveApp.getFolderById(obj.pastaId).setName(atualizacoes.titulo);
        } catch (e) {
          logEvento(formId, NIVEL_LOG.WARN, 'Erro ao renomear pasta no Drive: ' + e.message);
        }
      }
    }

    // Campos atualizáveis pelo editor
    // NOTA: 'status' foi REMOVIDO intencionalmente — status só muda via alterarStatus().
    // Isso evita que um salvar automático derrube um formulário publicado.
    const camposAtualizaveis = [
      'titulo', 'descricao', 'dataInicio', 'dataLimite',
      'limiteRespostas', 'tema', 'configJSON', 'excluido', 'planilhaId',
      'urlPlanilha'
    ];

    // Permitir atualização de status somente quando explicitamente via alterarStatus
    // (identificado pelo campo interno _forcarStatus)
    if (atualizacoes._forcarStatus !== undefined) {
      camposAtualizaveis.push('status');
      atualizacoes.status = atualizacoes._forcarStatus;
      delete atualizacoes._forcarStatus;
    }
    // configJSONPublicado também só é atualizado via publicarFormulario()
    if (atualizacoes._publicarConfigJSON !== undefined) {
      camposAtualizaveis.push('configJSONPublicado');
      atualizacoes.configJSONPublicado = atualizacoes._publicarConfigJSON;
      delete atualizacoes._publicarConfigJSON;
    }

    camposAtualizaveis.forEach(campo => {
      if (atualizacoes[campo] !== undefined) {
        const colIdx = cabecalhos.indexOf(campo);
        if (colIdx >= 0) {
          const valor = typeof atualizacoes[campo] === 'object'
            ? JSON.stringify(atualizacoes[campo])
            : atualizacoes[campo];
          aba.getRange(numLinha, colIdx + 1).setValue(valor);
        }
      }
    });

    // Sincronizar planilha de respostas (renomear planilha se o título mudou, atualizar/adicionar colunas)
    if (obj.planilhaId && (atualizacoes.configJSON || atualizacoes.titulo)) {
      const configSinc = atualizacoes.configJSON || obj.configJSON;
      const tituloSinc = atualizacoes.titulo || obj.titulo;
      sincronizarPlanilhaForm(obj.planilhaId, configSinc, tituloSinc);
    }

    logEvento(finalFormId, NIVEL_LOG.INFO, 'Formulário atualizado: ' + JSON.stringify(Object.keys(atualizacoes)));
    return respostaOk({ formId: finalFormId, formIdAlterado: formIdAlterado });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR, 'Erro ao editar formulário: ' + e.message, e.stack);
    return respostaErro('Erro ao salvar as alterações.', 'ERRO_EDITAR');
  }
}

// ============================================================
// PUBLICAR FORMULÁRIO
// ============================================================

/**
 * Publica o rascunho atual de um formulário.
 * Copia configJSON (rascunho) para configJSONPublicado e muda status para ATIVO.
 * A partir deste momento, respondentes veem a versão publicada.
 * @param {string} formId
 * @returns {{ok: boolean, data?: Object, error?: string}}
 */
function publicarFormulario(formId) {
  try {
    const resultado = obterFormulario(formId);
    if (!resultado.ok) return resultado;

    const form = resultado.data;
    const configDraft = typeof form.configJSON === 'string'
      ? form.configJSON
      : JSON.stringify(form.configJSON || {});

    // Copia o rascunho para o publicado e ativa o status
    return editarFormulario(formId, {
      _forcarStatus: STATUS.ATIVO,
      _publicarConfigJSON: configDraft,
    });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR, 'Erro ao publicar formulário: ' + e.message, e.stack);
    return respostaErro('Erro ao publicar o formulário.', 'ERRO_PUBLICAR');
  }
}

// ============================================================
// ESTADO DE PUBLICAÇÃO
// ============================================================

/**
 * Compara o rascunho com o publicado e retorna se há diferenças.
 * @param {string} formId
 * @returns {{ok: boolean, data?: {publicado: boolean, hasDiff: boolean, resumo: string[]}}}
 */
function obterEstadoPublicacao(formId) {
  try {
    const resultado = obterFormulario(formId);
    if (!resultado.ok) return resultado;

    const form = resultado.data;
    const draft = typeof form.configJSON === 'string'
      ? form.configJSON
      : JSON.stringify(form.configJSON || {});
    const publicado = typeof form.configJSONPublicado === 'string'
      ? form.configJSONPublicado
      : JSON.stringify(form.configJSONPublicado || '');

    // Nunca foi publicado
    if (!publicado || publicado === '{}' || publicado === '') {
      return respostaOk({ publicado: false, hasDiff: true, resumo: ['Formulário nunca publicado'] });
    }

    const hasDiff = draft !== publicado;
    const resumo = [];

    if (hasDiff) {
      try {
        const d = JSON.parse(draft);
        const p = JSON.parse(publicado);
        const secoesD = (d.secoes || []);
        const secoesP = (p.secoes || []);
        if (secoesD.length !== secoesP.length) {
          resumo.push('Número de seções alterado');
        }
        secoesD.forEach(function(sd, i) {
          const sp = secoesP[i];
          if (!sp) { resumo.push('Seção adicionada: ' + (sd.titulo || ('Seção ' + (i + 1)))); return; }
          if ((sd.perguntas || []).length !== (sp.perguntas || []).length) {
            resumo.push('Perguntas alteradas em: ' + (sd.titulo || ('Seção ' + (i + 1))));
          }
        });
        if (!resumo.length) resumo.push('Configurações de perguntas alteradas');
      } catch (e) {
        resumo.push('Alterações detectadas');
      }
    }

    return respostaOk({ publicado: true, hasDiff: hasDiff, resumo: resumo });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR, 'Erro ao verificar estado de publicação: ' + e.message, e.stack);
    return respostaErro('Erro ao verificar estado de publicação.', 'ERRO_ESTADO');
  }
}

// ============================================================
// ALTERAR STATUS
// ============================================================

/**
 * Altera o status de um formulário.
 * @param {string} formId
 * @param {string} novoStatus - Um dos valores de STATUS
 * @returns {{ok: boolean, error?: string}}
 */
function alterarStatus(formId, novoStatus) {
  if (!Object.values(STATUS).includes(novoStatus)) {
    return respostaErro('Status inválido: ' + novoStatus, 'STATUS_INVALIDO');
  }
  return editarFormulario(formId, { _forcarStatus: novoStatus });
}

// ============================================================
// DUPLICAR FORMULÁRIO
// ============================================================

/**
 * Duplica um formulário existente com novo ID.
 * @param {string} formId - ID do formulário original
 * @returns {{ok: boolean, data?: Object, error?: string}}
 */
function duplicarFormulario(formId) {
  try {
    const resultado = obterFormulario(formId);
    if (!resultado.ok) return resultado;

    const original = resultado.data;
    const config = JSON.parse(original.configJSON || '{}');
    const tema = JSON.parse(original.tema || '{}');

    return criarFormulario({
      titulo: 'Cópia de ' + original.titulo,
      descricao: original.descricao,
      configJSON: config,
      tema: tema,
    });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.ERROR, 'Erro ao duplicar formulário: ' + e.message, e.stack);
    return respostaErro('Erro ao duplicar o formulário.', 'ERRO_DUPLICAR');
  }
}

// ============================================================
// EXCLUIR FORMULÁRIO (LÓGICO)
// ============================================================

/**
 * Realiza exclusão lógica de um formulário (não apaga respostas).
 * @param {string} formId
 * @returns {{ok: boolean, error?: string}}
 */
function excluirFormulario(formId) {
  return editarFormulario(formId, { excluido: 'true', status: STATUS.ENCERRADO });
}

// ============================================================
// PROGRAMAR FUNCIONAMENTO
// ============================================================

/**
 * Define a janela de tempo em que o formulário aceita respostas.
 * @param {string} formId
 * @param {string|null} dataInicio - ISO 8601 ou null (sem data de início programada)
 * @param {string|null} dataLimite - ISO 8601 ou null (sem encerramento automático)
 * @returns {{ok: boolean, error?: string}}
 */
function programarFuncionamento(formId, dataInicio, dataLimite) {
  if (dataInicio && dataLimite) {
    const inicio = new Date(dataInicio);
    const limite = new Date(dataLimite);
    if (inicio >= limite) {
      return respostaErro(
        'A data de início deve ser anterior à data de encerramento.',
        'DATAS_INVALIDAS'
      );
    }
  }

  return editarFormulario(formId, {
    dataInicio: dataInicio || '',
    dataLimite: dataLimite || '',
  });
}

// ============================================================
// LINK PÚBLICO DO DASHBOARD
// ============================================================

/**
 * Gera um token de acesso público (somente-leitura) ao dashboard.
 * @param {string} formId
 * @returns {{ok: boolean, data?: {url: string}, error?: string}}
 */
function gerarLinkPublicoDashboard(formId) {
  try {
    const token = gerarUUID();
    // Armazenar com TTL de 7 dias (máximo do CacheService: 6h)
    // Solução: usar PropertiesService para tokens de longa duração
    const props = PropertiesService.getScriptProperties();
    const tokensJson = props.getProperty('PUBLIC_TOKENS') || '{}';
    const tokens = JSON.parse(tokensJson);
    tokens[token] = { formId: formId, criadoEm: new Date().toISOString() };
    props.setProperty('PUBLIC_TOKENS', JSON.stringify(tokens));

    const url = ScriptApp.getService().getUrl() + '?page=dash&form=' + formId + '&token=' + token;
    return respostaOk({ url: url, token: token });
  } catch (e) {
    return respostaErro('Erro ao gerar link público.', 'ERRO_TOKEN');
  }
}

/**
 * Valida um token de dashboard público.
 * @param {string} formId
 * @param {string} token
 * @returns {boolean}
 */
function validarTokenPublico(formId, token) {
  try {
    const props = PropertiesService.getScriptProperties();
    const tokens = JSON.parse(props.getProperty('PUBLIC_TOKENS') || '{}');
    return tokens[token] && tokens[token].formId === formId;
  } catch (e) {
    return false;
  }
}

// ============================================================
// LINK CURTO (TinyURL)
// ============================================================

/**
 * Gera um link curto (TinyURL) para o formulário público.
 * Se o encurtador falhar, retorna o link completo (encurtado:false).
 * @param {string} formId
 * @returns {{ok:boolean, data?:{url:string, encurtado:boolean, urlLonga:string}}}
 */
function gerarLinkCurto(formId) {
  const urlLonga = _urlWebApp_() + '?form=' + formId;
  try {
    const curta = encurtarUrl_(urlLonga);
    return respostaOk({ url: curta || urlLonga, encurtado: !!curta, urlLonga: urlLonga });
  } catch (e) {
    logEvento(formId, NIVEL_LOG.WARN, 'Falha ao encurtar link: ' + e.message);
    return respostaOk({ url: urlLonga, encurtado: false, urlLonga: urlLonga });
  }
}

/**
 * Encurta uma URL usando a API gratuita do TinyURL (sem cadastro).
 * @param {string} urlLonga
 * @returns {string|null} URL curta ou null se falhar
 * @private
 */
function encurtarUrl_(urlLonga) {
  try {
    const endpoint = 'https://tinyurl.com/api-create.php?url=' + encodeURIComponent(urlLonga);
    const resp = UrlFetchApp.fetch(endpoint, { muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      const curta = (resp.getContentText() || '').trim();
      if (curta && curta.indexOf('http') === 0 && curta.indexOf('tinyurl') !== -1) {
        return curta;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * EXECUTE UMA VEZ no editor para conceder a permissão de requisição externa
 * (necessária para o link curto via TinyURL). Depois disso, o botão de link
 * curto funciona normalmente no Web App.
 */
function autorizarLinkCurto() {
  const r = encurtarUrl_('https://script.google.com');
  console.log('Permissao de requisicao externa concedida. Teste de encurtamento: ' + r);
  return r;
}

// ============================================================
// FUNÇÕES AUXILIARES INTERNAS
// ============================================================

/**
 * Encontra a linha de um formulário na aba FORMS.
 * @param {string} formId
 * @returns {Array|null} Array de valores da linha ou null
 * @private
 */
function _encontrarLinhaForm(formId) {
  const ss = obterPlanilhaMestre_();
  const aba = ss.getSheetByName(ABA.FORMS);
  const dados = aba.getDataRange().getValues();
  return dados.slice(1).find(r => r[0] === formId) || null;
}

/**
 * Encontra a linha e seu índice (1-based) na aba FORMS.
 * @param {string} formId
 * @returns {{numLinha: number, dados: Array}}
 * @private
 */
function _encontrarLinhaComIndice(formId) {
  const ss = obterPlanilhaMestre_();
  const aba = ss.getSheetByName(ABA.FORMS);
  const dados = aba.getDataRange().getValues();
  const idx = dados.slice(1).findIndex(r => r[0] === formId);
  if (idx === -1) return { numLinha: -1, dados: [] };
  return { numLinha: idx + 2, dados: dados[idx + 1] }; // +2 por ser 1-based e pular cabeçalho
}

/**
 * Converte uma linha da aba FORMS em objeto.
 * @param {Array} linha
 * @returns {Object}
 * @private
 */
function _linhaParaObjeto(linha) {
  const obj = _arrayParaObjeto(CABECALHO_FORMS, linha);
  
  // Garantir que instâncias de Date sejam convertidas para string
  // para evitar falhas de serialização no google.script.run (que retorna null)
  if (obj.dataCriacao instanceof Date) {
    obj.dataCriacao = formatarDataBR(obj.dataCriacao);
  } else if (obj.dataCriacao) {
    obj.dataCriacao = String(obj.dataCriacao);
  }
  
  if (obj.dataInicio instanceof Date) {
    obj.dataInicio = Utilities.formatDate(obj.dataInicio, 'America/Sao_Paulo', "yyyy-MM-dd'T'HH:mm");
  } else if (obj.dataInicio) {
    obj.dataInicio = String(obj.dataInicio);
  }
  
  if (obj.dataLimite instanceof Date) {
    obj.dataLimite = Utilities.formatDate(obj.dataLimite, 'America/Sao_Paulo', "yyyy-MM-dd'T'HH:mm");
  } else if (obj.dataLimite) {
    obj.dataLimite = String(obj.dataLimite);
  }
  
  return obj;
}


/**
 * Extrai os IDs das perguntas de um configJSON (para cabeçalhos da planilha).
 * @param {Object|string} configJSON
 * @returns {string[]}
 * @private
 */
function _extrairCabecalhos(configJSON) {
  try {
    const config = typeof configJSON === 'string' ? JSON.parse(configJSON) : configJSON;
    const ids = [];
    (config.secoes || []).forEach(secao => {
      (secao.perguntas || []).forEach(pergunta => {
        if (pergunta.tipo !== TIPO_PERGUNTA.SOMENTE_LEITURA) {
          ids.push(pergunta.id);
        }
      });
    });
    return ids;
  } catch (e) {
    return [];
  }
}

/**
 * Extrai cabeçalhos de um configJSON serializado (string).
 * @param {string} configJSONString
 * @returns {string[]}
 * @private
 */
function _extrairCabecalhosDoForm(configJSONString) {
  try {
    return _extrairCabecalhos(JSON.parse(configJSONString));
  } catch (e) {
    return [];
  }
}

/**
 * Extrai os cabeçalhos com detalhes (id e titulo) de cada pergunta (exceto texto explicativo).
 * @param {Object|string} configJSON
 * @returns {Object[]} Array de {id: string, titulo: string}
 */
function _extrairCabecalhosComDetalhes(configJSON) {
  try {
    const config = typeof configJSON === 'string' ? JSON.parse(configJSON) : configJSON;
    const cabecalhos = [];
    (config.secoes || []).forEach(secao => {
      (secao.perguntas || []).forEach(pergunta => {
        if (pergunta.tipo !== TIPO_PERGUNTA.SOMENTE_LEITURA) {
          cabecalhos.push({
            id: pergunta.id,
            titulo: (pergunta.titulo || 'Pergunta sem título').replace(/<[^>]*>/g, '').trim() // limpa tags HTML
          });
        }
      });
    });
    return cabecalhos;
  } catch (e) {
    return [];
  }
}

/**
 * Retorna um configJSON padrão para novos formulários.
 * @returns {Object}
 * @private
 */
function _configJSONPadrao() {
  return {
    secoes: [
      {
        id: 'sec_' + gerarUUID().split('-')[0],
        titulo: 'Seção 1',
        descricao: '',
        perguntas: [],
      }
    ],
    logicaCondicional: [],
    configuracoes: {
      embaralharPerguntas: false,
      embaralharOpcoes: false,
      respostaUnica: false,
      campoRespostaUnica: null,
      coletarEmail: false,
      permitirEdicao: false,
      mensagemConfirmacao: '<h3>Obrigado!</h3><p>Sua resposta foi registrada com sucesso.</p>',
      notificarAdmin: false,
      modoNotificacao: MODO_NOTIFICACAO.DESATIVADO,
      dataInicio: null,
      dataLimite: null,
      limiteRespostas: 0,
    },
    aparencia: _temaPadrao(),
  };
}

/**
 * Retorna o tema visual padrão.
 * @returns {Object}
 * @private
 */
function _temaPadrao() {
  return {
    corPrimaria: '#1a73e8',
    corFundo: '#f8f9fa',
    corTexto: '#202124',
    corCard: '#ffffff',
    fonte: 'Inter',
    bordaArredondada: '12px',
    modoEscuro: false,
    imagemCabecalho: null,
    imagemFundo: null,
    imagemRodape: null,
    cssExtra: '',
  };
}
