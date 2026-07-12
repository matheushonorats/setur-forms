const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'assembled.html');
const html = fs.readFileSync(filePath, 'utf8');

const regex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let index = 0;

while ((match = regex.exec(html)) !== null) {
  const code = match[1];
  console.log(`\n=================== SCRIPT BLOCK #${index} (length: ${code.length}) ===================`);
  const lines = code.trim().split('\n');
  console.log('START:');
  console.log(lines.slice(0, 5).join('\n'));
  console.log('...');
  console.log('END:');
  console.log(lines.slice(-5).join('\n'));
  index++;
}
