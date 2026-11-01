'use strict';
// Split each merged category file into review chunks (data/review/<cat>-N.txt)
// so that independent verifier agents can check and edit them in parallel.
const fs = require('fs');
const path = require('path');
const { DATA_DIR, CATS } = require('./datalib.js');
const SIZE = parseInt(process.env.CHUNK || '900', 10);
const outDir = path.join(DATA_DIR, 'review');
fs.mkdirSync(outDir, { recursive: true });
fs.readdirSync(outDir).forEach((f) => fs.unlinkSync(path.join(outDir, f)));
CATS.forEach((cat) => {
  const lines = fs.readFileSync(path.join(DATA_DIR, cat + '.txt'), 'utf8').split('\n').filter((l) => l.trim());
  let n = 0;
  for (let i = 0; i < lines.length; i += SIZE) {
    n++;
    fs.writeFileSync(path.join(outDir, `${cat}-${n}.txt`), lines.slice(i, i + SIZE).join('\n') + '\n');
  }
  console.log(`${cat}: ${lines.length} entries -> ${n} chunk(s)`);
});
