const fs = require('fs');
const path = require('path');

const assetsDir = 'c:\\Users\\mathe\\Desktop\\Projetos Antigravity\\Votacao Ave Simbolo\\assets';
const files = fs.readdirSync(assetsDir);

files.forEach(f => {
  const stat = fs.statSync(path.join(assetsDir, f));
  console.log(f, stat.size, 'bytes');
});
