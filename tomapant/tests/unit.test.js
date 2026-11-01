'use strict';
// Unit tests for the Țomapant engine: normalisation, generic words, first letter,
// inflection fallback, scoring and Total sums. Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../src/engine.js');
const { CATS, loadCategory } = require('../scripts/datalib.js');

function packLibrary() {
  const packed = {};
  const problems = [];
  CATS.forEach((cat) => {
    const file = path.join(__dirname, '..', 'data', cat + '.txt');
    if (!fs.existsSync(file)) { packed[cat] = ''; return; }
    const entries = loadCategory(cat, problems);
    packed[cat] = entries.map((e) => [e.canonical].concat(e.variants).join('=')).join('|');
  });
  assert.equal(problems.length, 0, 'data problems: ' + problems.slice(0, 5).join('; '));
  return packed;
}
const LIB = E.buildLibrary(packLibrary());
const ev = (cat, letter, text, accepted) => E.evaluate(LIB, cat, letter, text, accepted);

test('normalisation: cedilla, trim, spaces, hyphens, punctuation, lowercase', () => {
  assert.equal(E.normalise('  Timişoara '), 'timișoara');
  assert.equal(E.normalise('Piatra-Neamţ'), 'piatra neamț');
  assert.equal(E.normalise("Sfântu   Gheorghe."), 'sfântu gheorghe');
  assert.equal(E.normalise("O'Brien"), 'obrien');
  assert.equal(E.normalise('BRASOV '), 'brasov');
});

test('lookup key strips diacritics and spaces', () => {
  assert.equal(E.keyOf('Brașov', 'orase'), 'brasov');
  assert.equal(E.keyOf('Târgu Mureș', 'orase'), 'targumures');
  assert.equal(E.keyOf('Marea Neagră', 'ape'), 'neagra');
  assert.equal(E.keyOf('Munții Retezat', 'munti'), 'retezat');
  assert.equal(E.keyOf('Republica Moldova', 'tari'), 'moldova');
  assert.equal(E.keyOf('Baia Mare', 'orase'), 'baiamare');
});

test('generic words are stripped only at the start', () => {
  assert.equal(E.stripGeneric('marea neagră', 'ape'), 'neagră');
  assert.equal(E.stripGeneric('raul mare', 'ape'), 'mare');
  assert.equal(E.stripGeneric('lacul balta albă', 'ape'), 'albă');
  assert.equal(E.stripGeneric('baia mare', 'orase'), 'baia mare');
  assert.equal(E.stripGeneric('neagră marea', 'ape'), 'neagră marea');
  assert.equal(E.stripGeneric('vf moldoveanu', 'munti'), 'moldoveanu');
});

test('first letter: Ă Â count as A, Î as I, Ș and Ț stay separate', () => {
  assert.equal(E.firstLetter('ăsta'), 'A');
  assert.equal(E.firstLetter('âmbă'), 'A');
  assert.equal(E.firstLetter('întregalde'), 'I');
  assert.equal(E.firstLetter('șarpe'), 'Ș');
  assert.equal(E.firstLetter('țap'), 'Ț');
  assert.equal(E.firstLetter('brașov'), 'B');
});

test('B, Orașe: brasov, Brașov, BRASOV are valid', () => {
  ['brasov', 'Brașov', 'BRASOV '].forEach((w) => { const r = ev('orase', 'B', w); assert.equal(r.status, 'valid', w); assert.equal(r.canonical, 'Brașov'); });
});

test('T, Orașe: Timişoara with cedilla is valid', () => {
  const r = ev('orase', 'T', 'Timişoara');
  assert.equal(r.status, 'valid'); assert.equal(r.canonical, 'Timișoara');
});

test('D, Ape: Dunarea, dunăre, Fluviul Dunărea are valid and score 5 each when compared', () => {
  const rs = ['Dunarea', 'dunăre', 'Fluviul Dunărea'].map((w) => ev('ape', 'D', w));
  rs.forEach((r) => assert.equal(r.status, 'valid', JSON.stringify(r)));
  assert.equal(new Set(rs.map((r) => r.canonical)).size, 1);
  const sc = E.scoreCategory({ p1: rs[0], p2: rs[2] });
  assert.deepEqual(sc.points, { p1: 5, p2: 5 });
});

test('N, Ape: Marea Neagră valid; M, Ape: wrong letter', () => {
  assert.equal(ev('ape', 'N', 'Marea Neagră').status, 'valid');
  const m = ev('ape', 'M', 'Marea Neagră');
  assert.equal(m.status, 'wrongLetter'); assert.equal(m.reason, 'nu începe cu litera M');
});

test('R, Munți: Retezat and Munții Retezat are valid', () => {
  assert.equal(ev('munti', 'R', 'Retezat').status, 'valid');
  assert.equal(ev('munti', 'R', 'Munții Retezat').status, 'valid');
  assert.equal(ev('munti', 'R', 'Munții Retezat').canonical, ev('munti', 'R', 'Retezat').canonical);
});

test('L, Animale: lup, lupi, lupul are valid (inflection fallback)', () => {
  ['lup', 'lupi', 'lupul'].forEach((w) => { const r = ev('animale', 'L', w); assert.equal(r.status, 'valid', w); assert.equal(r.canonical, 'lup'); });
});

test('T, Plante: trandafiri is valid', () => {
  const r = ev('plante', 'T', 'trandafiri'); assert.equal(r.status, 'valid'); assert.equal(r.canonical, 'trandafir');
});

test('plural fallback: vulpi, flori, cireșe', () => {
  assert.equal(ev('animale', 'V', 'vulpi').canonical, 'vulpe');
  assert.equal(ev('plante', 'F', 'flori').status, 'valid');
  assert.equal(ev('plante', 'C', 'cireșe').status, 'valid');
});

test('S, Animale: șarpe and sarpe are both wrong letter', () => {
  ['șarpe', 'sarpe'].forEach((w) => { const r = ev('animale', 'S', w); assert.equal(r.status, 'wrongLetter', w); });
  assert.equal(ev('animale', 'Ș', 'sarpe').status, 'valid');
});

test('A, Nume: Ana and " ana " are valid', () => {
  if (!LIB.nume || LIB.nume.size === 0) { return; }
  ['Ana', ' ana '].forEach((w) => assert.equal(ev('nume', 'A', w).status, 'valid', w));
});

test('O, Țări: Olanda valid; Olanda and Țările de Jos share a canonical entry', () => {
  const a = ev('tari', 'O', 'Olanda'); const b = ev('tari', 'Ț', 'Țările de Jos');
  assert.equal(a.status, 'valid'); assert.equal(b.status, 'valid'); assert.equal(a.canonical, b.canonical);
  assert.equal(ev('tari', 'O', 'Țările de Jos').status, 'wrongLetter');
});

test('blank answers score 0 with no review; unknown words with the right letter go to review', () => {
  const blank = ev('orase', 'B', '   '); assert.equal(blank.status, 'blank'); assert.equal(blank.reason, 'gol');
  const unk = ev('orase', 'B', 'Bzzzzzorașul'); assert.equal(unk.status, 'unknown');
  const unkWrong = ev('orase', 'B', 'Qzzzz'); assert.equal(unkWrong.status, 'wrongLetter');
  const sc = E.scoreCategory({ p1: blank, p2: unk });
  assert.deepEqual(sc.points, { p1: 0, p2: 0 });
});

test('previously accepted words are valid', () => {
  const acc = (cat, key) => cat === 'nume' && key === 'zorbel';
  assert.equal(ev('nume', 'Z', 'Zorbel', acc).status, 'valid');
  assert.equal(ev('nume', 'Z', 'Zorbel').status, 'unknown');
});

test('scoring: 10 unique, 5 shared, 0 blank/invalid, works for 3 players', () => {
  const v = (c) => ({ status: 'valid', canonical: c });
  const sc = E.scoreCategory({ p1: v('Brașov'), p2: v('Brașov'), p3: v('Bacău') });
  assert.deepEqual(sc.points, { p1: 5, p2: 5, p3: 10 });
  const sc2 = E.scoreCategory({ p1: v('Brașov'), p2: { status: 'rejected', canonical: '~bzz' }, p3: { status: 'blank' } });
  assert.deepEqual(sc2.points, { p1: 10, p2: 0, p3: 0 });
});

test('round Total equals the sum of its seven cells; Total general equals the sum of round Totals', () => {
  const v = (c) => ({ status: 'valid', canonical: c });
  const mk = (words) => { const o = {}; E.CATEGORIES.forEach((c, i) => { o[c.id] = words[i] ? v(words[i]) : { status: 'blank' }; }); return o; };
  const r1 = E.scoreRound({ p1: mk(['Austria', 'Arad', 'Alpi', 'Argeș', 'Arțar', 'Arici', 'Ana']), p2: mk(['Austria', 'Alba Iulia', '', 'Argeș', 'Alun', '', 'Andrei']) });
  const sum = (cells) => E.CATEGORIES.reduce((s, c) => s + cells[c.id].points, 0);
  assert.equal(r1.p1.total, sum(r1.p1.cells)); assert.equal(r1.p1.total, 5 + 10 + 10 + 5 + 10 + 10 + 10);
  assert.equal(r1.p2.total, sum(r1.p2.cells)); assert.equal(r1.p2.total, 5 + 10 + 0 + 5 + 10 + 0 + 10);
  const r2 = E.scoreRound({ p1: mk(['Belgia']), p2: mk(['Belgia']) });
  const rounds = [{ scores: r1 }, { scores: r2 }];
  assert.equal(E.sumTotals(rounds, 'p1'), r1.p1.total + r2.p1.total);
  assert.equal(E.sumTotals(rounds, 'p2'), r1.p2.total + r2.p2.total);
});

test('library build is fast', () => {
  assert.ok(LIB.__buildMs < 1500, 'build took ' + LIB.__buildMs + ' ms in Node');
});
