'use strict';
// Shared helpers for the data scripts: parsing the plain-text word lists.
const fs = require('fs');
const path = require('path');
const engine = require('../src/engine.js');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CATS = engine.CATEGORIES.map((c) => c.id);

function parseFile(file, cat, problems) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const entries = [];
  lines.forEach((raw, idx) => {
    const where = `${path.relative(ROOT, file)}:${idx + 1}`;
    if (raw.trim() === '' ) {
      if (raw !== '') problems.push(`${where}: whitespace-only line`);
      return;
    }
    if (raw.trimStart().startsWith('#')) return;
    if (/[ŞşŢţ]/.test(raw)) problems.push(`${where}: cedilla character in "${raw}"`);
    if (raw !== raw.trim()) problems.push(`${where}: stray whitespace in "${raw}"`);
    if (/\t/.test(raw)) problems.push(`${where}: tab character in "${raw}"`);
    if (/[|]/.test(raw)) problems.push(`${where}: pipe character in "${raw}"`);
    const parts = raw.split('=').map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length === 0) { problems.push(`${where}: empty entry`); return; }
    entries.push({ canonical: parts[0], variants: parts.slice(1), where });
  });
  return entries;
}

/* Build the deduplicated entry list for a category. Returns { entries, dropped }.
 * Later duplicates of an existing key are merged (same canonical) or dropped. */
function dedupe(entries, cat, problems, strict) {
  const byKey = new Map(); // key -> entry
  const out = [];
  const dropped = [];
  entries.forEach((e) => {
    const ck = engine.keyOf(e.canonical, cat);
    if (!ck) { problems.push(`${e.where}: canonical "${e.canonical}" has an empty key`); return; }
    let target = byKey.get(ck);
    if (target) {
      if (strict) problems.push(`${e.where}: duplicate key "${ck}" ("${e.canonical}" vs "${target.canonical}")`);
      dropped.push(`${e.where}: "${e.canonical}" merged into "${target.canonical}"`);
    } else {
      target = { canonical: e.canonical, variants: [], keys: new Set([ck]), where: e.where };
      byKey.set(ck, target);
      out.push(target);
    }
    e.variants.forEach((v) => {
      const vk = engine.keyOf(v, cat);
      if (!vk) { problems.push(`${e.where}: variant "${v}" has an empty key`); return; }
      if (target.keys.has(vk)) {
        if (strict) problems.push(`${e.where}: variant "${v}" repeats key "${vk}" of "${target.canonical}"`);
        return;
      }
      const other = byKey.get(vk);
      if (other) {
        if (strict) problems.push(`${e.where}: variant "${v}" collides with "${other.canonical}"`);
        dropped.push(`${e.where}: variant "${v}" collides with "${other.canonical}"`);
        return;
      }
      byKey.set(vk, target);
      target.keys.add(vk);
      target.variants.push(v);
    });
  });
  return { entries: out, dropped };
}

function loadCategory(cat, problems) {
  const file = path.join(DATA_DIR, cat + '.txt');
  const entries = parseFile(file, cat, problems);
  return dedupe(entries, cat, problems, true).entries;
}

function letterOf(canonical, cat) {
  return engine.firstLetter(engine.stripGeneric(engine.normalise(canonical), cat));
}

module.exports = { ROOT, DATA_DIR, CATS, parseFile, dedupe, loadCategory, letterOf, engine };
