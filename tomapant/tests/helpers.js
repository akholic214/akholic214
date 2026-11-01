'use strict';
// Shared helpers for the Playwright end-to-end test and the screenshot script.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { CATS, loadCategory, letterOf, engine } = require('../scripts/datalib.js');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'tomapant.html');

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(HTML).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/tomapant.html` }));
  });
}

/* Library index: per category, per letter, a list of canonical entries without generic words. */
const INDEX = {};
CATS.forEach((cat) => {
  INDEX[cat] = {};
  loadCategory(cat, []).forEach((e) => {
    const stripped = engine.stripGeneric(engine.normalise(e.canonical), cat);
    if (stripped !== engine.normalise(e.canonical)) return; // skip entries written with a generic word
    if (e.canonical.length > 18) return;
    const l = letterOf(e.canonical, cat);
    (INDEX[cat][l] = INDEX[cat][l] || []).push(e.canonical);
  });
});
function validWord(cat, letter, n) {
  const list = INDEX[cat][letter] || [];
  if (list.length <= n) throw new Error(`not enough ${cat} entries for letter ${letter}`);
  return list[n];
}
function otherLetterWord(cat, letter) {
  const letters = Object.keys(INDEX[cat]).filter((l) => l !== letter && /^[A-Z]$/.test(l));
  return INDEX[cat][letters[0]][0];
}
function unknownWord(letter, tag) { return letter + 'zzq' + tag; }

async function setName(page, name) { await page.fill('#player-name', name); }
async function createRoom(page, name) {
  await setName(page, name);
  await page.click('#btn-create');
  await page.waitForSelector('#screen-lobby.active');
  const code = (await page.textContent('#room-code')).trim();
  if (!/^[A-Z0-9]{5}$/.test(code)) throw new Error('bad room code ' + code);
  return code;
}
async function joinRoom(page, name, code) {
  await setName(page, name);
  await page.fill('#join-code', code);
  await page.click('#btn-join');
  await page.waitForSelector('#screen-lobby.active');
}
async function currentLetter(page) {
  await page.waitForSelector('#screen-round.active');
  return (await page.textContent('#round-letter')).trim();
}
async function typeAnswers(page, answers) {
  for (const cat of CATS) {
    const v = answers[cat] || '';
    await page.fill('#f-' + cat, v);
  }
  // blur the last field so a draft is sent
  await page.press('#f-nume', 'Tab');
}
async function pressGata(page, confirm) {
  await page.click('#btn-finish');
  if (confirm) { await page.waitForSelector('#dlg-confirm[open]'); await page.click('#confirm-yes'); }
}
/* Review: decide for every pending item according to a map "targetName|cat" -> true/false; default accept. */
async function review(page, decisions) {
  await page.waitForSelector('#screen-review.active');
  const items = await page.$$('.review-item:not(.decided)');
  for (const it of items) {
    const cat = await it.getAttribute('data-cat');
    const target = await it.getAttribute('data-target');
    const key = target + '|' + cat;
    const accept = decisions && key in decisions ? decisions[key] : true;
    await it.$eval(accept ? 'button.ok' : 'button.danger', (b) => b.click());
  }
}
/* Read a score sheet from the DOM. Returns { rows: [{letter, cells: [{word, pts}], total}], grand } */
async function readSheet(page, container, playerId) {
  return page.evaluate(([sel, pid]) => {
    const wrap = document.querySelector(sel + ' .sheet-wrap[data-player="' + pid + '"]');
    if (!wrap) return null;
    const rows = [];
    let grand = null;
    wrap.querySelectorAll('tbody tr').forEach((tr) => {
      const tds = Array.from(tr.children);
      if (tr.classList.contains('grand')) { grand = parseInt(tds[tds.length - 1].textContent, 10); return; }
      const cells = tds.slice(1, -1).map((td) => {
        const w = td.querySelector('.w'); const p = td.querySelector('.pts');
        return { word: w ? w.textContent : '', pts: p ? parseInt(p.textContent, 10) : null };
      });
      rows.push({ letter: tds[0].textContent.trim(), cells, total: tds[tds.length - 1].textContent.trim() === '' ? null : parseInt(tds[tds.length - 1].textContent, 10) });
    });
    return { rows, grand };
  }, [container, playerId]);
}
async function waitForAnimation(page) { await page.waitForTimeout(3200); }

module.exports = { CATS, startServer, validWord, otherLetterWord, unknownWord, createRoom, joinRoom, currentLetter, typeAnswers, pressGata, review, readSheet, waitForAnimation, HTML };
