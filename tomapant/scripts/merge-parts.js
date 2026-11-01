'use strict';
// Merge data/parts/<cat>-*.txt into data/<cat>.txt, deduplicating by lookup key.
const fs = require('fs');
const path = require('path');
const { DATA_DIR, CATS, parseFile, dedupe } = require('./datalib.js');

const partsDir = path.join(DATA_DIR, 'parts');
const only = process.argv.slice(2);
const collator = new Intl.Collator('ro');
let hadProblem = false;

CATS.forEach((cat) => {
  if (only.length && !only.includes(cat)) return;
  const files = fs.readdirSync(partsDir).filter((f) => f.startsWith(cat + '-') && f.endsWith('.txt')).sort();
  if (!files.length) { console.log(`${cat}: no parts`); return; }
  const problems = [];
  let entries = [];
  files.forEach((f) => { entries = entries.concat(parseFile(path.join(partsDir, f), cat, problems)); });
  const { entries: merged, dropped } = dedupe(entries, cat, problems, false);
  merged.sort((a, b) => collator.compare(a.canonical, b.canonical));
  const lines = merged.map((e) => [e.canonical].concat(e.variants).join(' = '));
  fs.writeFileSync(path.join(DATA_DIR, cat + '.txt'), lines.join('\n') + '\n', 'utf8');
  console.log(`${cat}: ${files.length} parts, ${entries.length} lines read, ${merged.length} canonical entries written, ${dropped.length} duplicates merged/dropped`);
  if (problems.length) { hadProblem = true; problems.forEach((p) => console.log('  ! ' + p)); }
  if (process.env.SHOW_DROPPED) dropped.forEach((d) => console.log('  - ' + d));
});
process.exit(hadProblem ? 1 : 0);
