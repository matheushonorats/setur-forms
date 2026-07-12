const fs = require('fs');
const path = require('path');
const vm = require('vm');

const srcDir = 'c:/Users/mathe/Desktop/Projetos Antigravity/SETUR Forms/src';

function getFileContent(filename) {
  return fs.readFileSync(path.join(srcDir, filename), 'utf8');
}

// 1. Load form.html
let html = getFileContent('form.html');

// 2. Perform includes
function include(nomeArquivo) {
  return getFileContent(nomeArquivo + '.html');
}

html = html.replace(/<\?!=[\s\S]*?include\('([^']+)'\)[\s\S]*?\?>/g, (match, p1) => {
  return include(p1);
});

// 3. Replace other scriptlets (using more specific non-greedy matching)
html = html.replace(/<\?=([^>]*?titulo[^>]*?)\?>/g, 'SETUR Forms — Formulário');
html = html.replace(/<\?!=([^>]*?JSON\.stringify\(formId\)[^>]*?)\?>/g, JSON.stringify('novo-formulario'));
html = html.replace(/<\?!=([^>]*?JSON\.stringify\(tokenEdicao[\s\S]*?\)[^>]*?)\?>/g, JSON.stringify(''));

// Write assembled html
fs.writeFileSync(path.join(__dirname, 'assembled.html'), html);
console.log('Assembled HTML written to scratch/assembled.html');

// 4. Validate script blocks
const regex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let index = 0;

while ((match = regex.exec(html)) !== null) {
  const code = match[1];
  try {
    new vm.Script(code, { filename: `Script Block #${index}` });
    console.log(`✅ Script Block #${index} is syntactically valid.`);
  } catch (err) {
    console.error(`\n❌ Syntax error in Script Block #${index}:`);
    console.error(err.stack || err.message);
    
    // Show context of the error
    const lines = code.split('\n');
    const errLine = err.lineNumber || 1;
    const start = Math.max(0, errLine - 10);
    const end = Math.min(lines.length, errLine + 10);
    console.log('--- Context ---');
    for (let l = start; l < end; l++) {
      console.log(`${l + 1}: ${lines[l]}`);
    }
    console.log('---------------');
  }
  index++;
}
