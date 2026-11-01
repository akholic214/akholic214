'use strict';
// Assemble tomapant.html from src/ and data/.
const fs = require('fs');
const path = require('path');
const { ROOT, CATS, loadCategory } = require('./datalib.js');

const problems = [];
const packed = {};
CATS.forEach((cat) => {
  const entries = loadCategory(cat, problems);
  packed[cat] = entries.map((e) => [e.canonical].concat(e.variants).join('=')).join('|');
});
if (problems.length) {
  problems.forEach((p) => console.error('! ' + p));
  console.error(`Build aborted: ${problems.length} data problem(s).`);
  process.exit(1);
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const peer = fs.readFileSync(path.join(ROOT, 'node_modules/peerjs/dist/peerjs.min.js'), 'utf8')
  .replace(/\/\/# sourceMappingURL=.*$/m, '');
const engine = read('src/engine.js');
const app = read('src/app.js');
const css = read('src/styles.css');
let html = read('src/template.html');

const dataJs = 'var TOMAPANT_DATA = ' + JSON.stringify(packed) + ';';
const guard = (s) => s.replace(/<\/script/gi, '<\\/script');
html = html
  .replace('/*__CSS__*/', () => css)
  .replace('/*__PEERJS__*/', () => guard(peer))
  .replace('/*__DATA__*/', () => guard(dataJs))
  .replace('/*__ENGINE__*/', () => guard(engine))
  .replace('/*__APP__*/', () => guard(app));
if (/__(CSS|PEERJS|DATA|ENGINE|APP)__/.test(html)) { console.error('Template placeholder left unfilled'); process.exit(1); }
fs.writeFileSync(path.join(ROOT, 'tomapant.html'), html, 'utf8');
const size = fs.statSync(path.join(ROOT, 'tomapant.html')).size;
console.log(`tomapant.html written (${(size / 1024).toFixed(0)} KB). Entries: ` +
  CATS.map((c) => `${c} ${packed[c].split('|').length}`).join(', '));
