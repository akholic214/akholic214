'use strict';
/* Takes screenshots of every screen at phone and laptop sizes, light and dark.
 * Run: node tests/screenshots.js  -> screenshots/*.png */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const H = require('./helpers.js');

const OUT = path.join(__dirname, '..', 'screenshots');
const VIEWPORTS = [{ name: 'iphone', width: 390, height: 844, mobile: true }, { name: 'android', width: 360, height: 800, mobile: true }, { name: 'laptop', width: 1366, height: 768, mobile: false }];

async function shoot(page, name, full) { await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: !!full }); }

async function run(browser, url, vp, scheme) {
  const tag = `${vp.name}-${scheme}`;
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: 2, colorScheme: scheme });
  const host = await ctx.newPage(); const guest = await ctx.newPage();
  await host.goto(url + '?transport=local&rounds=3'); await host.evaluate(() => { localStorage.clear(); });
  await guest.goto(url + '?transport=local&rounds=3');
  await host.fill('#player-name', 'Paul');
  await shoot(host, `${tag}-1-start`);
  const code = await H.createRoom(host, 'Paul');
  await H.joinRoom(guest, 'Andrei', code);
  await host.waitForFunction(() => document.querySelectorAll('#lobby-players li').length === 2);
  await shoot(host, `${tag}-2-lobby`);
  await shoot(guest, `${tag}-2-lobby-guest`);
  await host.click('#btn-start');
  const words = (L, n) => ({ tari: H.validWord('tari', L, n), orase: H.validWord('orase', L, n), munti: H.validWord('munti', L, n), ape: H.validWord('ape', L, n), plante: H.validWord('plante', L, n), animale: H.validWord('animale', L, n), nume: H.validWord('nume', L, n) });
  // round 1 and 2: quick
  for (let r = 0; r < 2; r++) {
    const L = await H.currentLetter(host); await H.currentLetter(guest);
    const hw = words(L, 0); const gw = words(L, 1); gw.tari = hw.tari; gw.munti = ''; if (r === 1) gw.ape = H.unknownWord(L, 's' + r);
    await H.typeAnswers(host, hw); await H.typeAnswers(guest, gw);
    if (r === 0) { await shoot(host, `${tag}-3-round`); }
    await H.pressGata(host, false); await H.pressGata(guest, true);
    if (r === 1) {
      await host.waitForSelector('#screen-review.active');
      await shoot(host, `${tag}-5-review`);
      await H.review(host, {});
    }
    await host.waitForSelector('#screen-results.active'); await guest.waitForSelector('#screen-results.active');
    await H.waitForAnimation(host);
    if (r === 1) { await shoot(host, `${tag}-6-results`); await shoot(guest, `${tag}-6-results-guest`); }
    await host.click('#btn-next-round');
  }
  // round 3: show the sheet with two scored rows during the round
  const L3 = await H.currentLetter(host); await H.currentLetter(guest);
  await H.typeAnswers(host, { tari: H.validWord('tari', L3, 0), orase: H.validWord('orase', L3, 0) });
  if (vp.mobile) {
    await host.click('#round-sheet-panel summary'); await host.waitForTimeout(300);
    await host.evaluate(() => { document.getElementById('round-sheet-panel').scrollIntoView(); const sc = document.querySelector('#round-sheet .sheet-scroll'); if (sc) sc.scrollLeft = 220; });
    const overflow = await host.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) console.log('WARNING: horizontal page overflow at', tag);
  }
  await shoot(host, `${tag}-4-sheet`, vp.mobile);
  await H.typeAnswers(host, words(L3, 0)); await H.typeAnswers(guest, words(L3, 1));
  await H.pressGata(host, false); await H.pressGata(guest, false);
  await host.waitForSelector('#screen-results.active'); await H.waitForAnimation(host);
  await host.click('#btn-next-round');
  await host.waitForSelector('#screen-gameover.active'); await guest.waitForSelector('#screen-gameover.active');
  await host.waitForTimeout(1200);
  await shoot(host, `${tag}-7-gameover`, true);
  await shoot(guest, `${tag}-7-gameover-guest`);
  await ctx.close();
}

(async () => {
  fs.readdirSync(OUT).forEach((f) => fs.unlinkSync(path.join(OUT, f)));
  const { server, url } = await H.startServer();
  const browser = await chromium.launch();
  for (const vp of VIEWPORTS) for (const scheme of ['light', 'dark']) { await run(browser, url, vp, scheme); console.log('done', vp.name, scheme); }
  await browser.close(); server.close();
})();
