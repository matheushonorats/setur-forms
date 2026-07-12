const fs = require('fs');
const path = require('path');
const vm = require('vm');

const srcDir = 'c:/Users/mathe/Desktop/Projetos Antigravity/SETUR Forms/src';
console.log('Checking directory:', srcDir);

function checkJsSyntax(code, filename) {
  try {
    let cleanCode = code
      .replace(/<\?!=[\s\S]*?\?>/g, '"placeholder_scriptlet_raw"')
      .replace(/<\?=[\s\S]*?\?>/g, '"placeholder_scriptlet_val"')
      .replace(/<\?[\s\S]*?\?>/g, '/* placeholder_scriptlet_exec */');
    
    new vm.Script(cleanCode, { filename });
    return null;
  } catch (err) {
    return err;
  }
}

function checkHtmlFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const regex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let index = 0;
  
  while ((match = regex.exec(content)) !== null) {
    const scriptCode = match[1];
    const err = checkJsSyntax(scriptCode, `${path.basename(filePath)} [Script #${index}]`);
    if (err) {
      console.error(`\n❌ Syntax error in ${path.basename(filePath)} (Script Block #${index}):`);
      console.error(err.stack || err.message);
    }
    index++;
  }
}

function checkGsFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const err = checkJsSyntax(content, path.basename(filePath));
  if (err) {
    console.error(`\n❌ Syntax error in ${path.basename(filePath)}:`);
    console.error(err.stack || err.message);
  }
}

// Read all files in src
const files = fs.readdirSync(srcDir);
files.forEach(file => {
  if (file.endsWith('.html')) {
    checkHtmlFile(path.join(srcDir, file));
  } else if (file.endsWith('.gs')) {
    checkGsFile(path.join(srcDir, file));
  }
});

console.log('Syntax check completed.');
