/**
 * @fileoverview Utilitários globais do SETUR Forms GAS
 * Constantes, UUID, hash, sanitização, log e validadores brasileiros.
 */

// ============================================================
// CONSTANTES CENTRALIZADAS
// ============================================================

/** Nomes das abas da Planilha Mestre */
const ABA = Object.freeze({
  FORMS:  'FORMS',
  LOGS:   'LOGS',
  CONFIG: 'CONFIG',
  FILA:   'FILA',
});

/** Status possíveis de um formulário */
const STATUS = Object.freeze({
  RASCUNHO:  'RASCUNHO',
  ATIVO:     'ATIVO',
  PAUSADO:   'PAUSADO',
  ENCERRADO: 'ENCERRADO',
});

/** Níveis de log */
const NIVEL_LOG = Object.freeze({
  INFO:  'INFO',
  WARN:  'WARN',
  ERROR: 'ERROR',
});

/** Tipos de pergunta suportados */
const TIPO_PERGUNTA = Object.freeze({
  RESPOSTA_CURTA:        'RESPOSTA_CURTA',
  PARAGRAFO:             'PARAGRAFO',
  MULTIPLA_ESCOLHA:      'MULTIPLA_ESCOLHA',
  CAIXAS_SELECAO:        'CAIXAS_SELECAO',
  LISTA_SUSPENSA:        'LISTA_SUSPENSA',
  ESCALA_LINEAR:         'ESCALA_LINEAR',
  AVALIACAO_ESTRELAS:    'AVALIACAO_ESTRELAS',
  GRADE_MULTIPLA:        'GRADE_MULTIPLA',
  GRADE_CAIXAS:          'GRADE_CAIXAS',
  DATA:                  'DATA',
  HORA:                  'HORA',
  DATA_HORA:             'DATA_HORA',
  UPLOAD_ARQUIVO:        'UPLOAD_ARQUIVO',
  SLIDER_NUMERICO:       'SLIDER_NUMERICO',
  SOMENTE_LEITURA:       'SOMENTE_LEITURA',
  ASSINATURA_CANVAS:     'ASSINATURA_CANVAS',
});

/** Tipos de validação para RESPOSTA_CURTA */
const TIPO_VALIDACAO = Object.freeze({
  LIVRE:    'LIVRE',
  EMAIL:    'EMAIL',
  TELEFONE: 'TELEFONE',
  CPF:      'CPF',
  CNPJ:     'CNPJ',
  CEP:      'CEP',
  NUMERO:   'NUMERO',
  REGEX:    'REGEX',
});

/** Status dos itens na fila de contingência */
const STATUS_FILA = Object.freeze({
  PENDENTE:   'PENDENTE',
  PROCESSADO: 'PROCESSADO',
  FALHA:      'FALHA',
});

/** Modo de notificação */
const MODO_NOTIFICACAO = Object.freeze({
  CADA_RESPOSTA: 'CADA_RESPOSTA',
  RESUMO_DIARIO: 'RESUMO_DIARIO',
  DESATIVADO:    'DESATIVADO',
});

/** Limites operacionais */
const LIMITE = Object.freeze({
  LOCK_TIMEOUT_MS:      30000,   // 30s de espera no LockService
  CACHE_SESSAO_SEGUNDOS: 1800,   // 30 min de sessão
  CACHE_NONCE_SEGUNDOS:  1800,   // 30 min para usar o nonce
  RATE_LIMIT_TENTATIVAS: 5,      // tentativas de login
  RATE_LIMIT_JANELA_S:   600,    // 10 min
  MAX_RETRIES_LOCK:      3,      // retries na escrita
  BACKOFF_BASE_MS:       500,    // backoff exponencial inicial
  MAX_FILA_TENTATIVAS:   5,      // max retries na fila
  UPLOAD_MAX_MB:         10,     // tamanho padrão de upload
});

/** Caracteres que devem ser sanitizados na planilha */
const FORMULA_INJECTION_CHARS = ['=', '+', '-', '@', '\t', '\r'];

/** Cabeçalhos das abas da Planilha Mestre */
const CABECALHO_FORMS = [
  'formId', 'titulo', 'descricao', 'status', 'urlPlanilha', 'planilhaId',
  'pastaId', 'dataCriacao', 'dataInicio', 'dataLimite', 'limiteRespostas',
  'totalRespostas', 'tema', 'configJSON', 'excluido', 'configJSONPublicado'
];

const CABECALHO_LOGS = [
  'timestamp', 'formId', 'nivel', 'mensagem', 'stack'
];

const CABECALHO_CONFIG = [
  'chave', 'valor'
];

const CABECALHO_FILA = [
  'id', 'formId', 'payload', 'tentativas', 'status', 'timestamp', 'erro'
];


// ============================================================
// UUID
// ============================================================

/**
 * Gera um UUID v4 pseudoaleatório.
 * @returns {string} UUID no formato xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
function gerarUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ============================================================
// HASH SHA-256
// ============================================================

/**
 * Calcula o hash SHA-256 de uma string.
 * Usa o serviço nativo do GAS (Utilities.computeDigest).
 * @param {string} valor - Texto a ser hasheado
 * @returns {string} Hash em hexadecimal lowercase
 */
function hashSHA256(valor) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    valor,
    Utilities.Charset.UTF_8
  );
  return bytes.map(b => {
    const hex = (b & 0xFF).toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

// ============================================================
// SANITIZAÇÃO — PREVENÇÃO DE INJEÇÃO DE FÓRMULA
// ============================================================

/**
 * Sanitiza um valor para gravação segura na planilha.
 * Prefixo apóstrofo previne interpretação como fórmula.
 * @param {*} valor - Valor a sanitizar
 * @returns {string} Valor seguro para a planilha
 */
function sanitizarCelula(valor) {
  if (valor === null || valor === undefined) return '';
  const str = String(valor);
  if (FORMULA_INJECTION_CHARS.some(c => str.startsWith(c))) {
    return "'" + str;
  }
  return str;
}

/**
 * Sanitiza um objeto de respostas recursivamente.
 * @param {Object} respostas - Mapa questionId → valor
 * @returns {Object} Mapa sanitizado
 */
function sanitizarRespostas(respostas) {
  const resultado = {};
  for (const [chave, valor] of Object.entries(respostas)) {
    if (Array.isArray(valor)) {
      resultado[chave] = valor.map(v => sanitizarCelula(v)).join(', ');
    } else {
      resultado[chave] = sanitizarCelula(valor);
    }
  }
  return resultado;
}

// ============================================================
// LOG DE EVENTOS
// ============================================================

/**
 * Grava um evento na aba LOGS da Planilha Mestre.
 * Falhas de log são silenciosas (não devem interromper o fluxo principal).
 * @param {string} formId - ID do formulário ou 'SYSTEM'
 * @param {string} nivel - NIVEL_LOG.INFO | WARN | ERROR
 * @param {string} mensagem - Descrição do evento
 * @param {string} [stack] - Stack trace resumido (opcional)
 */
function logEvento(formId, nivel, mensagem, stack) {
  try {
    const ss = obterPlanilhaMestre_();
    const aba = ss.getSheetByName(ABA.LOGS);
    if (!aba) return;

    const timestamp = formatarDataBR(new Date());
    const stackResumido = stack ? String(stack).substring(0, 500) : '';

    aba.appendRow([timestamp, formId || 'SYSTEM', nivel, mensagem, stackResumido]);
  } catch (e) {
    // Log de log falhou — silencioso para não criar loop
    console.error('Falha ao gravar log:', e.message);
  }
}

// ============================================================
// FORMATAÇÃO DE DATA
// ============================================================

/**
 * Formata uma data no fuso America/Sao_Paulo em ISO 8601.
 * @param {Date} date - Data a formatar
 * @returns {string} Data formatada ex: 2026-06-11T10:30:00-03:00
 */
function formatarDataBR(date) {
  return Utilities.formatDate(
    date,
    'America/Sao_Paulo',
    "yyyy-MM-dd'T'HH:mm:ssXXX"
  );
}

/**
 * Retorna o ano atual no fuso de São Paulo.
 * @returns {string} Ano como string ex: '2026'
 */
function anoAtual() {
  return Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy');
}

// ============================================================
// PARSER DE USER-AGENT
// ============================================================

/**
 * Converte uma string User-Agent técnica em texto legível por humanos.
 * Ex: "Mozilla/5.0 (Windows NT 10.0...) Chrome/149.0.0.0" → "Chrome 149 · Windows 10"
 *
 * @param {string} ua - String User-Agent bruta
 * @returns {string} Texto legível, ex: "Chrome 149 · Windows 10" ou "Safari · iPhone (iOS 17)"
 */
function parsearUserAgent(ua) {
  if (!ua) return '';
  ua = String(ua);

  // ── Navegador ────────────────────────────────────────────
  var navegador = 'Desconhecido';

  // Edge deve vir antes de Chrome (Edge inclui "Chrome" na UA)
  var edgeMatch = ua.match(/Edg(?:e|A|iOS)?\/(\d+)/);
  var chromeMatch = ua.match(/Chrome\/(\d+)/);
  var firefoxMatch = ua.match(/Firefox\/(\d+)/);
  var safariMatch = ua.match(/Version\/(\d+).*Safari/);
  var operaMatch = ua.match(/OPR\/(\d+)/) || ua.match(/Opera\/(\d+)/);
  var samsungMatch = ua.match(/SamsungBrowser\/(\d+)/);

  if (samsungMatch) {
    navegador = 'Samsung Internet ' + samsungMatch[1];
  } else if (operaMatch) {
    navegador = 'Opera ' + operaMatch[1];
  } else if (edgeMatch) {
    navegador = 'Edge ' + edgeMatch[1];
  } else if (firefoxMatch) {
    navegador = 'Firefox ' + firefoxMatch[1];
  } else if (safariMatch && !chromeMatch) {
    // Safari puro (sem Chrome na UA)
    navegador = 'Safari ' + safariMatch[1];
  } else if (chromeMatch) {
    navegador = 'Chrome ' + chromeMatch[1];
  }

  // ── Sistema Operacional / Dispositivo ────────────────────
  var so = '';

  if (/iPhone/.test(ua)) {
    var iosMatch = ua.match(/iPhone OS ([\d_]+)/);
    var iosVer = iosMatch ? iosMatch[1].replace(/_/g, '.') : '';
    so = 'iPhone' + (iosVer ? ' (iOS ' + iosVer.split('.')[0] + ')' : '');
  } else if (/iPad/.test(ua)) {
    var ipadMatch = ua.match(/CPU OS ([\d_]+)/);
    var ipadVer = ipadMatch ? ipadMatch[1].replace(/_/g, '.') : '';
    so = 'iPad' + (ipadVer ? ' (iOS ' + ipadVer.split('.')[0] + ')' : '');
  } else if (/Android/.test(ua)) {
    var androidMatch = ua.match(/Android ([\d.]+)/);
    var androidVer = androidMatch ? androidMatch[1].split('.')[0] : '';
    so = 'Android' + (androidVer ? ' ' + androidVer : '');
  } else if (/Windows NT/.test(ua)) {
    var winMatch = ua.match(/Windows NT ([\d.]+)/);
    var winVer = winMatch ? winMatch[1] : '';
    var winNomes = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7', '6.0': 'Vista', '5.1': 'XP' };
    so = 'Windows ' + (winNomes[winVer] || winVer);
  } else if (/Mac OS X/.test(ua)) {
    var macMatch = ua.match(/Mac OS X ([\d_]+)/);
    var macVer = macMatch ? macMatch[1].replace(/_/g, '.').split('.').slice(0, 2).join('.') : '';
    so = 'macOS' + (macVer ? ' ' + macVer : '');
  } else if (/Linux/.test(ua)) {
    so = 'Linux';
  } else if (/CrOS/.test(ua)) {
    so = 'ChromeOS';
  }

  if (so) return navegador + ' · ' + so;
  return navegador;
}

// ============================================================
// VALIDADORES BRASILEIROS
// ============================================================

/**
 * Valida CPF com verificação de dígitos verificadores.
 * @param {string} cpf - CPF (com ou sem máscara)
 * @returns {boolean}
 */
function validarCPF(cpf) {
  const limpo = String(cpf).replace(/\D/g, '');
  if (limpo.length !== 11) return false;
  if (/^(\d)\1+$/.test(limpo)) return false; // todos iguais

  let soma = 0;
  for (let i = 0; i < 9; i++) soma += parseInt(limpo[i]) * (10 - i);
  let resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(limpo[9])) return false;

  soma = 0;
  for (let i = 0; i < 10; i++) soma += parseInt(limpo[i]) * (11 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  return resto === parseInt(limpo[10]);
}

/**
 * Valida CNPJ com verificação de dígitos verificadores.
 * @param {string} cnpj - CNPJ (com ou sem máscara)
 * @returns {boolean}
 */
function validarCNPJ(cnpj) {
  const limpo = String(cnpj).replace(/\D/g, '');
  if (limpo.length !== 14) return false;
  if (/^(\d)\1+$/.test(limpo)) return false;

  const calcDigito = (base, pesos) => {
    const soma = base.reduce((acc, d, i) => acc + d * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const digits = limpo.split('').map(Number);
  const pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const pesos2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  if (calcDigito(digits.slice(0, 12), pesos1) !== digits[12]) return false;
  if (calcDigito(digits.slice(0, 13), pesos2) !== digits[13]) return false;
  return true;
}

/**
 * Valida e-mail com regex padrão.
 * @param {string} email
 * @returns {boolean}
 */
function validarEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

/**
 * Valida telefone brasileiro (fixo ou celular, com ou sem máscara).
 * Aceita: (11) 9999-9999, (11) 99999-9999, 11999999999
 * @param {string} telefone
 * @returns {boolean}
 */
function validarTelefoneBR(telefone) {
  const limpo = String(telefone).replace(/\D/g, '');
  return limpo.length === 10 || limpo.length === 11;
}

/**
 * Valida CEP brasileiro.
 * @param {string} cep
 * @returns {boolean}
 */
function validarCEP(cep) {
  const limpo = String(cep).replace(/\D/g, '');
  return limpo.length === 8;
}

/**
 * Valida se um valor é numérico (int ou float).
 * @param {*} valor
 * @returns {boolean}
 */
function validarNumero(valor) {
  return !isNaN(parseFloat(valor)) && isFinite(valor);
}

/**
 * Valida valor contra regex customizado.
 * @param {string} valor
 * @param {string} pattern - Padrão regex
 * @returns {boolean}
 */
function validarRegex(valor, pattern) {
  try {
    return new RegExp(pattern).test(String(valor));
  } catch (e) {
    return false;
  }
}

// ============================================================
// REFERÊNCIA À PLANILHA MESTRE (INTERNA)
// ============================================================

/**
 * Retorna a Planilha Mestre usando o ID armazenado em PropertiesService.
 * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet}
 * @throws {Error} Se a planilha não for encontrada
 */
function obterPlanilhaMestre_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('MASTER_SHEET_ID');
  if (!id) {
    // Fallback: usa a planilha vinculada ao projeto
    return SpreadsheetApp.getActiveSpreadsheet();
  }
  return SpreadsheetApp.openById(id);
}

/**
 * Lê todas as configurações globais da aba CONFIG.
 * @returns {Object} Mapa chave→valor
 */
function obterConfig() {
  try {
    const ss = obterPlanilhaMestre_();
    const aba = ss.getSheetByName(ABA.CONFIG);
    if (!aba) return {};

    const dados = aba.getDataRange().getValues();
    const config = {};
    dados.forEach(([chave, valor]) => {
      if (chave) config[String(chave)] = valor;
    });
    return config;
  } catch (e) {
    logEvento('SYSTEM', NIVEL_LOG.ERROR, 'Falha ao ler CONFIG: ' + e.message, e.stack);
    return {};
  }
}

/**
 * Atualiza ou insere um valor na aba CONFIG.
 * @param {string} chave
 * @param {*} valor
 */
function definirConfig(chave, valor) {
  const ss = obterPlanilhaMestre_();
  const aba = ss.getSheetByName(ABA.CONFIG);
  const dados = aba.getDataRange().getValues();
  const linha = dados.findIndex(r => r[0] === chave);
  if (linha >= 0) {
    aba.getRange(linha + 1, 2).setValue(valor);
  } else {
    aba.appendRow([chave, valor]);
  }
}

/**
 * Retorna a URL pública do Web App para gerar links de divulgação.
 * Prioriza a chave CONFIG 'urlWebApp' (URL /exec fixa definida pelo admin),
 * pois ScriptApp.getService().getUrl() pode devolver a URL /dev (HEAD) ou de
 * outra implantação. Se 'urlWebApp' não estiver definida, usa o getUrl() padrão.
 * @returns {string}
 */
function _urlWebApp_() {
  try {
    const cfg = obterConfig();
    const u = cfg && cfg['urlWebApp'];
    if (u && String(u).trim().indexOf('http') === 0) {
      return String(u).trim().replace(/\/+$/, '');
    }
  } catch (e) { /* cai no fallback */ }
  return ScriptApp.getService().getUrl();
}

/**
 * Faz parse seguro de configJSON/tema: aceita objeto (já parseado), string JSON
 * válida, ou qualquer lixo (ex.: célula corrompida "[object Object]") sem lançar.
 * @param {*} v
 * @returns {Object}
 */
function _parseConfig_(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || '{}'); } catch (e) { return {}; }
}

/**
 * ID do Google Doc usado como MODELO das fichas de inscrição (com timbre/cabeçalho).
 * Definido na aba CONFIG (chave 'idModeloFicha'). Vazio = ficha em branco (sem timbre).
 * @returns {string}
 */
function _idModeloFicha_() {
  try {
    const cfg = obterConfig();
    const id = cfg && cfg['idModeloFicha'];
    if (id && String(id).trim()) return String(id).trim();
  } catch (e) { /* sem modelo */ }
  return '';
}

/**
 * Gera um slug a partir de um texto (para IDs de formulário).
 * @param {string} texto
 * @returns {string} Slug lowercase sem acentos/espaços
 */
function gerarSlug(texto) {
  return String(texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 50);
}

/**
 * Gera um slug único verificando se já existe na aba FORMS.
 * @param {string} texto - Título do formulário
 * @returns {string} Slug único (adiciona sufixo numérico se necessário)
 */
function gerarSlugUnico(texto) {
  const base = gerarSlug(texto);
  const ss = obterPlanilhaMestre_();
  const aba = ss.getSheetByName(ABA.FORMS);
  const dados = aba.getDataRange().getValues();
  const slugsExistentes = dados.slice(1).map(r => r[0]);

  let slug = base;
  let contador = 1;
  while (slugsExistentes.includes(slug)) {
    slug = base + '-' + contador;
    contador++;
  }
  return slug;
}

/**
 * Gera um ID FIXO de formulário (letras+números), único na aba FORMS.
 * Estilo Google Forms: estável, independente do título — a URL não muda.
 * @returns {string} Ex.: 'f7k3a9d2b1'
 */
function _gerarIdFormulario_() {
  const ss = obterPlanilhaMestre_();
  const aba = ss.getSheetByName(ABA.FORMS);
  const dados = aba.getDataRange().getValues();
  const existentes = dados.slice(1).map(r => String(r[0]));
  let id;
  do {
    id = 'f' + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
  } while (existentes.includes(id));
  return id;
}

/**
 * Retorna resposta padronizada de sucesso para a API.
 * @param {*} data - Dados a retornar
 * @returns {{ok: true, data: *}}
 */
function respostaOk(data) {
  return { ok: true, data: data };
}

/**
 * Retorna resposta padronizada de erro para a API.
 * @param {string} mensagem - Mensagem amigável ao usuário
 * @param {string} [codigo] - Código de erro interno
 * @returns {{ok: false, error: string, codigo: string}}
 */
function respostaErro(mensagem, codigo) {
  return { ok: false, error: mensagem, codigo: codigo || 'ERRO_GENERICO' };
}

/**
 * Converte um array de valores em objeto usando os cabeçalhos como chaves.
 * (Definição única consolidada — usada por FormService, DashService e Triggers.)
 * @param {string[]} cabecalhos
 * @param {Array} valores
 * @returns {Object}
 */
function _arrayParaObjeto(cabecalhos, valores) {
  const obj = {};
  cabecalhos.forEach((chave, idx) => {
    obj[chave] = valores[idx] !== undefined ? valores[idx] : '';
  });
  return obj;
}

/**
 * Converte uma string de data em Date, tratando entradas datetime-local
 * (sem fuso) como horário de America/Sao_Paulo (UTC-3, sem horário de verão).
 * Aceita também ISO já com fuso. Retorna null para valor vazio/inválido.
 * @param {string} valor
 * @returns {Date|null}
 */
function parseDateInFuso(valor) {
  if (!valor) return null;
  try {
    const s = String(valor).trim();
    if (!s) return null;
    if (/[zZ]$|[+\-]\d{2}:?\d{2}$/.test(s)) {
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) {
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    const y = +m[1], mo = +m[2], da = +m[3], h = +m[4], mi = +m[5], se = m[6] ? +m[6] : 0;
    const d = new Date(Date.UTC(y, mo - 1, da, h + 3, mi, se)); // +3h: Sao Paulo = UTC-3
    return isNaN(d.getTime()) ? null : d;
  } catch (e) {
    return null;
  }
}
