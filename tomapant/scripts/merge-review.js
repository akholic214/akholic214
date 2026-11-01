'use strict';
// Rebuild data/<cat>.txt from the verified review chunks (data/review/<cat>-N.txt).
const fs = require('fs');
const path = require('path');
const { DATA_DIR, CATS, parseFile, dedupe } = require('./datalib.js');
const dir = path.join(DATA_DIR, 'review');
const collator = new Intl.Collator('ro');
let bad = false;
CATS.forEach((cat) => {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(cat + '-')).sort((a, b) => parseInt(a.split('-')[1], 10) - parseInt(b.split('-')[1], 10));
  if (!files.length) return;
  const problems = [];
  let entries = [];
  files.forEach((f) => { entries = entries.concat(parseFile(path.join(dir, f), cat, problems)); });
  const { entries: merged, dropped } = dedupe(entries, cat, problems, false);
  merged.sort((a, b) => collator.compare(a.canonical, b.canonical));
  fs.writeFileSync(path.join(DATA_DIR, cat + '.txt'), merged.map((e) => [e.canonical].concat(e.variants).join(' = ')).join('\n') + '\n');
  console.log(`${cat}: ${files.length} chunks, ${merged.length} entries, ${dropped.length} dropped as duplicates`);
  if (problems.length) { bad = true; problems.forEach((p) => console.log('  ! ' + p)); }
});
process.exit(bad ? 1 : 0);
