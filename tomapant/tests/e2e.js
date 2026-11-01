'use strict';
/* End-to-end test: two players (two tabs, BroadcastChannel transport) play a
 * full 3-round game, then a 3-player round. Run: node tests/e2e.js */
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const H = require('./helpers.js');

const CATS = H.CATS;
let failures = 0;
function check(cond, msg) { if (!cond) { failures++; console.log('  FAIL: ' + msg); } else console.log('  ok: ' + msg); }

async function expectSheetRow(page, container, pid, roundIdx, expectedPts, label) {
  const sheet = await H.readSheet(page, container, pid);
  assert.ok(sheet, 'sheet for ' + pid + ' visible in ' + container);
  const row = sheet.rows[roundIdx];
  assert.ok(row, 'row ' + roundIdx + ' exists');
  const pts = row.cells.map((c) => c.pts);
  const sum = expectedPts.reduce((a, b) => a + b, 0);
  check(JSON.stringify(pts) === JSON.stringify(expectedPts), `${label}: cells ${JSON.stringify(pts)} == ${JSON.stringify(expectedPts)}`);
  check(row.total === sum, `${label}: round Total ${row.total} == sum of cells ${sum}`);
  return sheet;
}
function grandOf(sheet) { return sheet.rows.reduce((s, r) => s + (r.total || 0), 0); }

async function twoPlayerGame(browser, url) {
  console.log('\n== Two-player game, 3 rounds ==');
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  const host = await ctx.newPage(); const guest = await ctx.newPage();
  for (const p of [host, guest]) {
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  }
  await host.goto(url + '?transport=local&rounds=3');
  await host.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await guest.goto(url + '?transport=local&rounds=3');
  const code = await H.createRoom(host, 'Gazda');
  console.log('  room code', code);
  await H.joinRoom(guest, 'Oaspete', code);
  await host.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 2);
  await guest.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 2);
  check(await guest.$eval('#set-round', (s) => s.disabled), 'guest settings are read-only');
  await host.selectOption('#set-round', '60');
  await host.selectOption('#set-grace', '5');
  await guest.waitForFunction(() => document.querySelector('#set-grace').value === '5');
  check(true, 'settings synced to guest');
  await host.click('#btn-start');

  const expected = { p1: [], p2: [] };

  /* ---- Round 1: mixed outcomes, review accept + reject, grace period ---- */
  let L = await H.currentLetter(host);
  check((await H.currentLetter(guest)) === L, 'both see letter ' + L);
  check((await host.textContent('#round-num')).trim() === '1', 'round 1 of 3 shown');
  const r1h = { tari: H.validWord('tari', L, 0), orase: H.validWord('orase', L, 0), munti: H.validWord('munti', L, 0), ape: H.unknownWord(L, 'a1'), plante: H.validWord('plante', L, 0), animale: H.otherLetterWord('animale', L), nume: H.validWord('nume', L, 0) };
  const r1g = { tari: H.validWord('tari', L, 0), orase: H.validWord('orase', L, 1), munti: '', ape: H.validWord('ape', L, 0), plante: H.unknownWord(L, 'b1'), animale: H.validWord('animale', L, 0), nume: H.validWord('nume', L, 0) };
  await H.typeAnswers(host, r1h);
  await H.typeAnswers(guest, r1g);
  const marks = await host.evaluate(() => ({ tari: document.getElementById('m-tari').className, ape: document.getElementById('m-ape').className, animale: document.getElementById('m-animale').className }));
  check(marks.tari.includes('ok') && marks.ape.includes('neutral') && marks.animale.includes('warn'), 'live feedback marks: tick, neutral, warning');
  // guest presses Gata (one empty field -> confirmation); host sees the grace banner
  await H.pressGata(guest, true);
  await host.waitForFunction(() => document.getElementById('round-banner').style.display !== 'none');
  const banner = await host.textContent('#round-banner');
  check(/Adversarul a terminat! Mai ai \d+ secunde/.test(banner), 'grace banner: ' + banner.trim());
  const t0 = Date.now();
  await host.waitForSelector('#screen-review.active', { timeout: 15000 });
  const waited = Date.now() - t0;
  check(waited >= 3500 && waited <= 9000, `round closed by grace timer after ${waited} ms (5 s grace)`);
  // review: guest reviews host's unknown (accept), host reviews guest's unknown (reject)
  await guest.waitForSelector('#screen-review.active');
  check((await guest.$$('.review-item')).length === 1 && (await host.$$('.review-item')).length === 1, 'each side has one word to review');
  await H.review(guest, {});
  await guest.waitForSelector('#review-wait', { state: 'visible' });
  check(true, 'guest waits for opponent review');
  await H.review(host, { 'p2|plante': false });
  await host.waitForSelector('#screen-results.active');
  await guest.waitForSelector('#screen-results.active');
  await H.waitForAnimation(host); await H.waitForAnimation(guest);
  expected.p1.push([5, 10, 10, 10, 10, 0, 5]); expected.p2.push([5, 10, 0, 10, 0, 10, 5]);
  let sh = await expectSheetRow(host, '#results-sheet', 'p1', 0, expected.p1[0], 'R1 host sheet (host view)');
  await expectSheetRow(host, '#results-sheet', 'p2', 0, expected.p2[0], 'R1 guest sheet (host view)');
  await expectSheetRow(guest, '#results-sheet', 'p1', 0, expected.p1[0], 'R1 host sheet (guest view)');
  let sg = await expectSheetRow(guest, '#results-sheet', 'p2', 0, expected.p2[0], 'R1 guest sheet (guest view)');
  check(sh.grand === 50 && sg.grand === 40, `grand totals after R1: ${sh.grand}/${sg.grand}`);
  const reasons = await host.evaluate(() => Array.from(document.querySelectorAll('#results-sheet .sheet-wrap[data-player="p1"] tbody tr:first-child td.cell')).map((td) => td.dataset.reason));
  check(reasons[3].startsWith('acceptat de Oaspete') && reasons[5].startsWith('nu începe cu litera') && reasons[0].includes('același răspuns'), 'cell reasons: ' + reasons.join(' | '));
  const reasonsG = await host.evaluate(() => Array.from(document.querySelectorAll('#results-sheet .sheet-wrap[data-player="p2"] tbody tr:first-child td.cell')).map((td) => td.dataset.reason));
  check(reasonsG[4].startsWith('respins de Gazda') && reasonsG[2] === 'gol', 'guest cell reasons: ' + reasonsG.join(' | '));
  check((await guest.textContent('#results-wait')).includes('Se așteaptă gazda'), 'guest sees waiting text');

  /* ---- Round 2: disconnect and reconnect mid-round, Acceptă tot ---- */
  await host.click('#btn-next-round');
  L = await H.currentLetter(host); await H.currentLetter(guest);
  check((await host.textContent('#round-num')).trim() === '2', 'round 2 started');
  const r2h = { tari: H.validWord('tari', L, 0), orase: H.validWord('orase', L, 0), munti: H.validWord('munti', L, 0), ape: H.validWord('ape', L, 0), plante: H.validWord('plante', L, 0), animale: H.validWord('animale', L, 0), nume: H.validWord('nume', L, 0) };
  const r2g = { tari: H.validWord('tari', L, 1), orase: H.validWord('orase', L, 2), munti: H.unknownWord(L, 'c2'), ape: H.unknownWord(L, 'd2'), plante: H.validWord('plante', L, 1), animale: H.validWord('animale', L, 1), nume: H.validWord('nume', L, 1) };
  await H.typeAnswers(guest, r2g);
  await guest.evaluate(() => window.__tomapantDev.disconnect());
  await guest.waitForFunction(() => document.getElementById('conn-bar').style.display !== 'none');
  check((await guest.textContent('#conn-bar')).includes('Se încearcă reconectarea'), 'guest shows reconnecting banner');
  await host.waitForFunction(() => document.querySelector('#opp-status .chip.off') !== null);
  check(true, 'host shows the guest as disconnected');
  await guest.waitForFunction(() => document.getElementById('conn-bar').style.display === 'none', { timeout: 15000 });
  await host.waitForFunction(() => document.querySelector('#opp-status .chip.off') === null);
  check((await guest.$eval('#screen-round', (s) => s.classList.contains('active'))), 'guest is back in the round after reconnect');
  check((await guest.inputValue('#f-tari')) === r2g.tari, 'guest answers kept after reconnect');
  const sheetDuring = await guest.evaluate(() => window.__tomapantDev.getState().rounds.length);
  check(sheetDuring === 2, 'guest state restored with 2 rounds');
  await H.typeAnswers(host, r2h);
  await H.pressGata(host, false);
  await H.pressGata(guest, false);
  await host.waitForSelector('#screen-review.active');
  check((await host.$$('.review-item')).length === 2, 'host has two words to review');
  await host.click('#btn-accept-all');
  await host.waitForSelector('#screen-results.active'); await guest.waitForSelector('#screen-results.active');
  await H.waitForAnimation(host); await H.waitForAnimation(guest);
  expected.p1.push([10, 10, 10, 10, 10, 10, 10]); expected.p2.push([10, 10, 10, 10, 10, 10, 10]);
  sh = await expectSheetRow(host, '#results-sheet', 'p1', 1, expected.p1[1], 'R2 host sheet');
  sg = await expectSheetRow(guest, '#results-sheet', 'p2', 1, expected.p2[1], 'R2 guest sheet (guest view)');
  check(sh.grand === 120 && sg.grand === 110, `grand totals after R2: ${sh.grand}/${sg.grand}`);
  check(sh.rows.length === 2 && grandOf(sh) === sh.grand, 'Total general equals the sum of round Totals');

  /* ---- Round 3: same unknown word on both sides, accepted by both -> 5 each ---- */
  await host.click('#btn-next-round');
  L = await H.currentLetter(host); await H.currentLetter(guest);
  const same = H.unknownWord(L, 'e3');
  const r3h = { tari: '', orase: H.validWord('orase', L, 0), munti: same, ape: H.validWord('ape', L, 0), plante: '', animale: H.validWord('animale', L, 0), nume: H.validWord('nume', L, 2) };
  const r3g = { tari: H.validWord('tari', L, 0), orase: H.validWord('orase', L, 0), munti: same, ape: '', plante: H.validWord('plante', L, 0), animale: H.validWord('animale', L, 0), nume: H.validWord('nume', L, 3) };
  await H.typeAnswers(host, r3h); await H.typeAnswers(guest, r3g);
  await H.pressGata(host, true); await H.pressGata(guest, true);
  await H.review(host, {}); await H.review(guest, {});
  await host.waitForSelector('#screen-results.active'); await guest.waitForSelector('#screen-results.active');
  await H.waitForAnimation(host); await H.waitForAnimation(guest);
  expected.p1.push([0, 5, 5, 10, 0, 5, 10]); expected.p2.push([10, 5, 5, 0, 10, 5, 10]);
  sh = await expectSheetRow(host, '#results-sheet', 'p1', 2, expected.p1[2], 'R3 host sheet');
  sg = await expectSheetRow(guest, '#results-sheet', 'p2', 2, expected.p2[2], 'R3 guest sheet');
  check(sh.grand === 155 && sg.grand === 155, `grand totals after R3 tie: ${sh.grand}/${sg.grand}`);
  check((await host.textContent('#btn-next-round')).includes('rezultatul final'), 'host button offers the final result');
  await host.click('#btn-next-round');
  await host.waitForSelector('#screen-gameover.active'); await guest.waitForSelector('#screen-gameover.active');
  check((await host.textContent('#verdict')).includes('Egalitate'), 'tie verdict on host: ' + (await host.textContent('#verdict')).trim());
  check((await guest.textContent('#verdict')).includes('Egalitate'), 'tie verdict on guest');
  const finalH = await H.readSheet(host, '#final-sheet', 'p1'); const finalG = await H.readSheet(guest, '#final-sheet', 'p2');
  check(finalH.rows.length === 3 && finalG.rows.length === 3 && finalH.grand === 155 && finalG.grand === 155, 'final sheets have 3 rows and matching grand totals');
  const accepted = await host.evaluate(() => JSON.parse(localStorage.getItem('tomapant_cuvinte_acceptate') || '{}'));
  check(accepted.munti && accepted.munti.length >= 1 && accepted.ape && accepted.ape.length >= 1, 'accepted words saved in localStorage');

  /* ---- Rematch ---- */
  await host.click('#btn-rematch');
  L = await H.currentLetter(host); await H.currentLetter(guest);
  check((await host.textContent('#round-num')).trim() === '1' && (await host.textContent('#round-grand')).trim() === '0', 'rematch: round 1 with grand total 0');
  await host.click('#round-sheet-panel summary').catch(() => {});
  const fresh = await host.evaluate(() => window.__tomapantDev.getState().rounds.length);
  check(fresh === 1, 'rematch: fresh sheet with a single (current) row');
  await H.typeAnswers(host, { tari: H.validWord('tari', L, 0) }); await H.typeAnswers(guest, { tari: H.validWord('tari', L, 1) });
  await H.pressGata(host, true); await H.pressGata(guest, true);
  await host.waitForSelector('#screen-results.active'); await H.waitForAnimation(host);
  const rr = await H.readSheet(host, '#results-sheet', 'p1');
  check(rr.rows.length === 1 && rr.grand === 10, 'rematch scores start from zero');

  /* ---- refresh resume on the guest ---- */
  await host.click('#btn-next-round');
  await H.currentLetter(host); L = await H.currentLetter(guest);
  await H.typeAnswers(guest, { orase: H.validWord('orase', L, 0) });
  await guest.waitForTimeout(500);
  await guest.reload();
  await guest.waitForSelector('#screen-round.active', { timeout: 15000 });
  check((await guest.inputValue('#f-orase')) === H.validWord('orase', L, 0), 'guest refresh: round resumed with the typed answer');
  check((await guest.evaluate(() => window.__tomapantDev.getState().rounds.length)) === 2, 'guest refresh: sheet restored');

  check(errors.length === 0, 'no console errors (' + errors.slice(0, 3).join(' / ') + ')');
  await ctx.close();
}

async function threePlayerRound(browser, url) {
  console.log('\n== Three-player round ==');
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const pages = [];
  for (let i = 0; i < 3; i++) { const p = await ctx.newPage(); await p.goto(url + '?transport=local&rounds=1'); pages.push(p); }
  await pages[0].evaluate(() => { localStorage.clear(); });
  const code = await H.createRoom(pages[0], 'Ana');
  await H.joinRoom(pages[1], 'Bogdan', code); await H.joinRoom(pages[2], 'Carmen', code);
  await pages[0].waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 3);
  await pages[0].click('#btn-start');
  const L = await H.currentLetter(pages[0]);
  for (const p of pages.slice(1)) await H.currentLetter(p);
  const unk = H.unknownWord(L, 'm3');
  const answers = [
    { tari: H.validWord('tari', L, 0), orase: H.validWord('orase', L, 0), munti: unk, ape: H.validWord('ape', L, 0), plante: '', animale: H.validWord('animale', L, 0), nume: H.validWord('nume', L, 0) },
    { tari: H.validWord('tari', L, 0), orase: H.validWord('orase', L, 1), munti: '', ape: H.validWord('ape', L, 0), plante: '', animale: H.validWord('animale', L, 1), nume: H.validWord('nume', L, 1) },
    { tari: H.validWord('tari', L, 0), orase: H.validWord('orase', L, 2), munti: '', ape: H.validWord('ape', L, 1), plante: '', animale: H.validWord('animale', L, 2), nume: H.validWord('nume', L, 2) }
  ];
  for (let i = 0; i < 3; i++) await H.typeAnswers(pages[i], answers[i]);
  await H.pressGata(pages[1], true);
  await pages[0].waitForFunction(() => document.getElementById('round-banner').style.display !== 'none');
  check((await pages[0].textContent('#round-banner')).includes('Bogdan a terminat!'), 'banner names the player who finished');
  await H.pressGata(pages[0], true); await H.pressGata(pages[2], true);
  // Ana's unknown word is reviewed by Bogdan (reject) and Carmen (accept): tie -> accepted
  await H.review(pages[1], { 'p1|munti': false });
  await H.review(pages[2], { 'p1|munti': true });
  for (const p of pages) await p.waitForSelector('#screen-results.active', { timeout: 15000 });
  await H.waitForAnimation(pages[0]);
  await pages[0].click('#btn-next-round');
  for (const p of pages) await p.waitForSelector('#screen-gameover.active', { timeout: 15000 });
  const s1 = await H.readSheet(pages[0], '#final-sheet', 'p1'); const s2 = await H.readSheet(pages[0], '#final-sheet', 'p2'); const s3 = await H.readSheet(pages[2], '#final-sheet', 'p3');
  check(JSON.stringify(s1.rows[0].cells.map((c) => c.pts)) === JSON.stringify([5, 10, 10, 5, 0, 10, 10]), 'Ana: shared with 3 -> 5, tie review -> accepted: ' + JSON.stringify(s1.rows[0].cells.map((c) => c.pts)));
  check(JSON.stringify(s2.rows[0].cells.map((c) => c.pts)) === JSON.stringify([5, 10, 0, 5, 0, 10, 10]), 'Bogdan row');
  check(JSON.stringify(s3.rows[0].cells.map((c) => c.pts)) === JSON.stringify([5, 10, 0, 10, 0, 10, 10]), 'Carmen row');
  check((await pages[0].textContent('#verdict')).includes('Ai câștigat'), 'Ana wins: ' + (await pages[0].textContent('#verdict')).trim());
  check((await pages[1].textContent('#verdict')).includes('Ai pierdut'), 'Bogdan loses');
  await ctx.close();
}

(async () => {
  const { server, url } = await H.startServer();
  const browser = await chromium.launch();
  try {
    await twoPlayerGame(browser, url);
    await threePlayerRound(browser, url);
  } catch (e) { failures++; console.log('  ERROR: ' + (e.stack || e)); }
  await browser.close(); server.close();
  console.log(failures ? `\nE2E: ${failures} failure(s)` : '\nE2E: all checks passed');
  process.exit(failures ? 1 : 0);
})();
