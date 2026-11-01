'use strict';
// Print totals and per-letter counts for each category; fail if minimums are not met.
const { CATS, loadCategory, letterOf, engine } = require('./datalib.js');

const MIN_TOTAL = { tari: 280, orase: 4000, munti: 1000, ape: 2500, plante: 2500, animale: 3000, nume: 5000 };
const MIN_LETTER = { orase: 80, munti: 15, ape: 30, plante: 40, animale: 40, nume: 80 };
// Every real country per default letter: the smallest counts come from the UN list.
const MIN_TARI_LETTER = { A: 11, B: 16, C: 18, D: 4, E: 7, F: 4, G: 10, H: 2, I: 8, J: 2, L: 6, M: 18, N: 9, O: 2, P: 8, R: 3, S: 20, T: 10, U: 3, V: 3, Z: 2 };
const LETTERS = engine.DEFAULT_LETTERS;
const ALL_LETTERS = LETTERS.concat(engine.HARD_LETTERS);

let failed = false;
const problems = [];
const summary = {};
CATS.forEach((cat) => {
  const entries = loadCategory(cat, problems);
  const counts = {};
  let variants = 0;
  entries.forEach((e) => {
    const l = letterOf(e.canonical, cat) || '?';
    counts[l] = (counts[l] || 0) + 1;
    variants += e.variants.length;
  });
  summary[cat] = { total: entries.length, variants, counts };
  const minT = MIN_TOTAL[cat];
  const okTotal = entries.length >= minT;
  if (!okTotal) failed = true;
  console.log(`\n${cat.toUpperCase()}: ${entries.length} canonical entries (+${variants} variants), minimum ${minT} ${okTotal ? 'OK' : 'NOT MET'}`);
  const row = ALL_LETTERS.map((l) => {
    const n = counts[l] || 0;
    let min = MIN_LETTER[cat] || 0;
    if (cat === 'tari') min = MIN_TARI_LETTER[l] || 0;
    const required = LETTERS.includes(l);
    const bad = required && n < min;
    if (bad) failed = true;
    return `${l}:${n}${bad ? '!' : ''}`;
  });
  console.log('  ' + row.join('  '));
  const other = Object.keys(counts).filter((l) => !ALL_LETTERS.includes(l));
  if (other.length) console.log('  other letters: ' + other.map((l) => `${l}:${counts[l]}`).join(' '));
});
if (problems.length) {
  failed = true;
  console.log('\nData problems:');
  problems.forEach((p) => console.log('  ! ' + p));
}
if (process.env.STATS_JSON) require('fs').writeFileSync(process.env.STATS_JSON, JSON.stringify(summary, null, 2));
console.log(failed ? '\nSTATS: FAILED (minimums not met or data problems)' : '\nSTATS: OK');
process.exit(failed ? 1 : 0);
