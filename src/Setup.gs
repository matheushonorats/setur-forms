/**
 * @fileoverview Função de setup idempotente do SETUR Forms GAS.
 * Cria/verifica toda a estrutura de dados necessária.
 * Pode ser executada múltiplas vezes sem destruir dados.
 */

// ============================================================
// CONFIGURAÇÕES PADRÃO
// ============================================================

// Função (não const global) para não depender da ordem de carregamento dos
// arquivos .gs no GAS — LIMITE/Session só são acessados quando isto é chamado.
function _obterConfigPadrao() {
  return [
    ['emailAdmin', Session.getActiveUser().getEmail()],
    ['senhaHash', ''],
    ['pastaRaizId', ''],
    ['rateLimitMax', LIMITE.RATE_LIMIT_TENTATIVAS],
    ['rateLimitJanela', LIMITE.RATE_LIMIT_JANELA_S],
    ['tempoMinimoResposta', 5],
    ['mostrarIndice', 'true'],
    ['urlWebApp', ''],
    ['idModeloFicha', ''],
    ['versao', '1.0.0'],
  ];
}

// ============================================================
// SETUP PRINCIPAL
// ============================================================

/**
 * Configura toda a estrutura do SETUR Forms GAS.
 * Idempotente: seguro para executar múltiplas vezes.
 * Execute esta função UMA VEZ após criar o projeto no Apps Script.
 */
function setup() {
  try {
    console.log('🚀 Iniciando setup do SETUR Forms GAS...');

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // 1. Salvar ID da planilha mestre
    PropertiesService.getScriptProperties().setProperty(
      'MASTER_SHEET_ID',
      ss.getId()
    );
    console.log('✅ Planilha Mestre registrada: ' + ss.getId());

    // 2. Criar/verificar abas
    _criarAbaSeNaoExiste(ss, ABA.FORMS, CABECALHO_FORMS);
    _criarAbaSeNaoExiste(ss, ABA.LOGS, CABECALHO_LOGS);
    _criarAbaSeNaoExiste(ss, ABA.CONFIG, CABECALHO_CONFIG);
    _criarAbaSeNaoExiste(ss, ABA.FILA, CABECALHO_FILA);
    console.log('✅ Abas verificadas/criadas');

    // 2.5 Migração idempotente: adiciona colunas novas à aba FORMS sem apagar dados
    _adicionarColunasSeNecessario(ss, ABA.FORMS, CABECALHO_FORMS);
    console.log('✅ Colunas da aba FORMS verificadas/migradas');

    // 3. Configurações padrão (apenas insere se não existir)
    _inicializarConfig(ss);
    console.log('✅ Configurações padrão aplicadas');

    // 4. Criar pasta raiz no Drive
    const pastaRaizId = _criarPastaRaiz();
    definirConfig('pastaRaizId', pastaRaizId);
    PropertiesService.getScriptProperties().setProperty('PASTA_RAIZ_ID', pastaRaizId);
    console.log('✅ Pasta SETUR Forms criada/verificada no Drive: ' + pastaRaizId);

    // 5. Instalar triggers
    _instalarTriggers();
    console.log('✅ Triggers instalados');

    // 6. Remover aba Sheet1/Planilha1 padrão (se existir e houver outras abas)
    _removerAbaPadrao(ss);

    logEvento('SYSTEM', NIVEL_LOG.INFO, 'Setup concluído com sucesso. Versão 1.0.0');

    const url = ScriptApp.getService().getUrl();
    console.log('');
    console.log('🎉 Setup concluído com sucesso!');
    console.log('📋 URL do Web App: ' + url);
    console.log('🔧 Acesse o painel admin em: ' + url + '?page=admin');
    console.log('');
    console.log('⚠️  IMPORTANTE: Defina uma senha admin em: ' + url + '?page=admin');

    return { sucesso: true, url: url };
  } catch (e) {
    console.error('❌ Erro no setup: ' + e.message);
    console.error(e.stack);
    throw e;
  }
}

// ============================================================
// FUNÇÕES AUXILIARES DO SETUP
// ============================================================

/**
 * Cria uma aba na planilha se ela não existir.
 * Se já existir, apenas verifica/completa os cabeçalhos.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} nome - Nome da aba
 * @param {string[]} cabecalhos - Linha de cabeçalho
 */
function _criarAbaSeNaoExiste(ss, nome, cabecalhos) {
  let aba = ss.getSheetByName(nome);

  if (!aba) {
    aba = ss.insertSheet(nome);
    aba.appendRow(cabecalhos);
    _formatarCabecalho(aba);
    console.log('  📋 Aba criada: ' + nome);
  } else {
    // Verifica se cabeçalho existe
    const primeiraLinha = aba.getRange(1, 1, 1, aba.getLastColumn()).getValues()[0];
    if (!primeiraLinha[0]) {
      aba.getRange(1, 1, 1, cabecalhos.length).setValues([cabecalhos]);
      _formatarCabecalho(aba);
      console.log('  📋 Cabeçalho restaurado na aba: ' + nome);
    } else {
      console.log('  ✅ Aba já existe: ' + nome);
    }
  }
}

/**
 * Adiciona colunas que ainda não existem no cabeçalho de uma aba,
 * sem apagar dados existentes. Seguro para rodar múltiplas vezes.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} nomeAba - Nome da aba
 * @param {string[]} cabecalhosEsperados - Lista completa de colunas esperadas
 */
function _adicionarColunasSeNecessario(ss, nomeAba, cabecalhosEsperados) {
  const aba = ss.getSheetByName(nomeAba);
  if (!aba || aba.getLastColumn() === 0) return;

  const cabecalhosAtuais = aba.getRange(1, 1, 1, aba.getLastColumn()).getValues()[0].map(String);

  cabecalhosEsperados.forEach(function(coluna) {
    if (!cabecalhosAtuais.includes(coluna)) {
      const novaColIdx = aba.getLastColumn() + 1;
      aba.getRange(1, novaColIdx).setValue(coluna);
      console.log('  ➕ Coluna adicionada em ' + nomeAba + ': ' + coluna);
    }
  });

  // Reformatar cabeçalho com o novo intervalo
  _formatarCabecalho(aba);
}


function _formatarCabecalho(aba) {
  if (aba.getLastColumn() === 0) return;
  const range = aba.getRange(1, 1, 1, aba.getLastColumn());
  range.setBackground('#1a73e8')
       .setFontColor('#ffffff')
       .setFontWeight('bold')
       .setFontSize(11);
  aba.setFrozenRows(1);
}

/**
 * Insere configurações padrão na aba CONFIG sem sobrescrever existentes.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 */
function _inicializarConfig(ss) {
  const aba = ss.getSheetByName(ABA.CONFIG);
  const dadosExistentes = aba.getDataRange().getValues();
  const chavesExistentes = dadosExistentes.slice(1).map(r => r[0]);

  _obterConfigPadrao().forEach(([chave, valor]) => {
    if (!chavesExistentes.includes(chave)) {
      aba.appendRow([chave, valor]);
    }
  });
}

/**
 * Cria (ou encontra) a pasta raiz "SETUR Forms" no Drive.
 * @returns {string} ID da pasta raiz
 */
function _criarPastaRaiz() {
  // Verifica se já temos o ID salvo
  const props = PropertiesService.getScriptProperties();
  const idSalvo = props.getProperty('PASTA_RAIZ_ID');

  if (idSalvo) {
    try {
      DriveApp.getFolderById(idSalvo);
      return idSalvo; // Pasta ainda existe
    } catch (e) {
      // Pasta foi deletada, criar novamente
    }
  }

  // Verifica se existe uma pasta com esse nome na raiz
  const pastas = DriveApp.getFoldersByName('SETUR Forms');
  if (pastas.hasNext()) {
    return pastas.next().getId();
  }

  // Cria a pasta
  const pasta = DriveApp.createFolder('SETUR Forms');
  return pasta.getId();
}

/**
 * Instala os triggers periódicos necessários.
 * Remove triggers duplicados antes de instalar.
 */
function _instalarTriggers() {
  const TRIGGERS_GERENCIADOS = [
    'processarFila',
    'verificarEncerramentoProgramado',
    'enviarNotificacoesPendentes',
    'reconciliarIntencoes',
  ];

  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (TRIGGERS_GERENCIADOS.includes(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  // Processa fila de contingência a cada 5 minutos
  ScriptApp.newTrigger('processarFila')
    .timeBased()
    .everyMinutes(5)
    .create();

  // Verifica encerramento/ativação programada a cada 10 minutos
  ScriptApp.newTrigger('verificarEncerramentoProgramado')
    .timeBased()
    .everyMinutes(10)
    .create();

  // Envia notificações agrupadas diariamente às 8h
  ScriptApp.newTrigger('enviarNotificacoesPendentes')
    .timeBased()
    .atHour(8)
    .everyDays(1)
    .create();

  // Reconcilia intenções de gravação que podem ter sido perdidas (a cada 10 min)
  ScriptApp.newTrigger('reconciliarIntencoes')
    .timeBased()
    .everyMinutes(10)
    .create();
}

/**
 * Remove a aba padrão criada pelo Google Sheets (Sheet1/Planilha1).
 * Só remove se houver outras abas além dela.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 */
function _removerAbaPadrao(ss) {
  const nomesPadrao = ['Sheet1', 'Planilha1', 'Página1'];
  const todasAbas = ss.getSheets();

  if (todasAbas.length <= 1) return; // Não remove se for a única

  nomesPadrao.forEach(nome => {
    const aba = ss.getSheetByName(nome);
    if (aba && aba.getDataRange().getValues().flat().every(v => v === '')) {
      ss.deleteSheet(aba);
      console.log('  🗑️ Aba padrão removida: ' + nome);
    }
  });
}

/**
 * Diagnóstico: verifica saúde de toda a estrutura.
 * Útil para rodar após problemas.
 */
function diagnostico() {
  const resultado = {
    planilhaMestre: false,
    abas: {},
    pastaRaiz: false,
    triggers: [],
  };

  try {
    const ss = obterPlanilhaMestre_();
    resultado.planilhaMestre = true;

    [ABA.FORMS, ABA.LOGS, ABA.CONFIG, ABA.FILA].forEach(nome => {
      resultado.abas[nome] = !!ss.getSheetByName(nome);
    });

    const pastaRaizId = PropertiesService.getScriptProperties().getProperty('PASTA_RAIZ_ID');
    if (pastaRaizId) {
      try {
        DriveApp.getFolderById(pastaRaizId);
        resultado.pastaRaiz = true;
      } catch (e) {
        resultado.pastaRaiz = false;
      }
    }

    ScriptApp.getProjectTriggers().forEach(t => {
      resultado.triggers.push(t.getHandlerFunction());
    });

    console.log('📊 Diagnóstico:', JSON.stringify(resultado, null, 2));
  } catch (e) {
    console.error('❌ Erro no diagnóstico:', e.message);
  }

  return resultado;
}
