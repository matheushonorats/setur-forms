const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../src');

const BUILT_INS = new Set([
  // JS Globals
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'Date', 'Math', 'String', 'Array', 'Object', 'JSON', 'RegExp', 'Error', 'Boolean', 'Number',
  'Set', 'Map', 'console', 'toString', 'String', 'Number',
  // GAS Classes/Services
  'SpreadsheetApp', 'CacheService', 'PropertiesService', 'LockService', 'Session', 'Utilities',
  'MailApp', 'ScriptApp', 'UrlFetchApp', 'HtmlService', 'DriveApp', 'Logger',
]);

const gsFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.gs'));

const declaradas = new Set();
const chamadas = [];

// Passo 1: Encontrar funções declaradas nos arquivos .gs
gsFiles.forEach(file => {
  const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
  
  // Limpar comentários multilinha e de linha simples
  const cleanContent = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  const declMatches = cleanContent.matchAll(/function\s+([a-zA-Z0-9_]+)\s*\(/g);
  for (const match of declMatches) {
    declaradas.add(match[1]);
  }
});

// Passo 2: Encontrar chamadas de funções nos arquivos .gs
gsFiles.forEach(file => {
  const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
  
  // Limpar todos os comentários do arquivo antes de quebrar em linhas
  const cleanContent = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  const lines = cleanContent.split('\n');
  
  lines.forEach((line, lineIdx) => {
    // Também limpar strings para evitar falsos positivos com texto entre aspas
    const cleanLine = line
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""')
      .replace(/`[^`]*`/g, '``');

    const calls = cleanLine.matchAll(/\b([a-zA-Z0-9_]+)\s*\(/g);
    for (const match of calls) {
      const name = match[1];
      if (!['if', 'for', 'while', 'switch', 'catch', 'typeof', 'function', 'return', 'forEach', 'map', 'filter', 'some', 'every', 'find', 'findIndex', 'reduce', 'push', 'pop', 'shift', 'unshift', 'replace', 'trim', 'test', 'match', 'split', 'join', 'toLowerCase', 'toUpperCase', 'normalize', 'substring', 'substr'].includes(name)) {
        // Verificar se é método de instância (se tem ponto antes do identificador)
        const index = match.index;
        const charAntes = cleanLine.substring(0, index).trim().slice(-1);
        if (charAntes === '.') {
          continue;
        }
        chamadas.push({ name, file, line: lineIdx + 1 });
      }
    }
  });
});

console.log('--- ANÁLISE DE DECLARAÇÕES ---');
console.log(`Funções globais declaradas: ${declaradas.size}`);

console.log('\n--- VERIFICAÇÃO DE IDENTIFICADORES NÃO-DEFINIDOS ---');
let erros = 0;
const reportados = new Set();

chamadas.forEach(({ name, file, line }) => {
  if (!declaradas.has(name) && !BUILT_INS.has(name)) {
    const reportKey = `${file}:${name}`;
    if (!reportados.has(reportKey)) {
      console.warn(`⚠️  Função possivelmente indefinida: "${name}" chamada em ${file}:${line}`);
      reportados.add(reportKey);
      erros++;
    }
  }
});

if (erros === 0) {
  console.log('🎉 Nenhuma chamada a função global não-definida encontrada!');
} else {
  console.log(`\n❌ Total de possíveis funções indefinidas reportadas: ${erros}`);
}
