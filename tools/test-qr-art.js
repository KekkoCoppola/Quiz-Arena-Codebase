'use strict';

/**
 * tools/test-qr-art.js
 *
 * Smoke test isolato per client/sala/qr-art.js, il QR disegnato nello stile
 * della sala. Non decodifica un'immagine: verifica le due regole da cui
 * dipende la leggibilità — il lettore campiona il centro di ogni cella, quindi
 * basta che i moduli disegnati siano ESATTAMENTE quelli scuri (meno il buco
 * del logo, che la correzione d'errore ricostruisce) e che il buco non tocchi
 * occhi, linee di temporizzazione e pattern di allineamento.
 *
 * La prova vera resta inquadrare lo schermo con un telefono.
 *
 * Utilizzo: node tools/test-qr-art.js
 */

const qrcode = require('../client/sala/vendor/qrcode.js');
const { plan, render, logoHole, EYE, MAX_LOGO_VERSION } = require('../client/sala/qr-art');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}`);
    failed++;
  }
}

function make(text, level) {
  const qr = qrcode(0, level);
  qr.addData(text);
  qr.make();
  return qr;
}

const inEye = (x, y, n) => [[0, 0], [n - EYE, 0], [0, n - EYE]]
  .some(([ex, ey]) => x >= ex && x < ex + EYE && y >= ey && y < ey + EYE);

/** I moduli disegnati coincidono con quelli scuri, esclusi occhi e buco. */
function sameGrid(qr, p) {
  const n = qr.getModuleCount();
  const drawn = new Set(p.modules.map((m) => `${m.x},${m.y}`));
  const h = p.hole;
  const inHole = (x, y) => !!h && x >= h.x && x < h.x + h.side && y >= h.y && y < h.y + h.side;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const expected = qr.isDark(y, x) && !inEye(x, y, n) && !inHole(x, y);
      if (expected !== drawn.has(`${x},${y}`)) return false;
    }
  }
  return true;
}

console.log('\n  🔳  Griglia');

const urls = ['http://192.168.4.1', 'http://192.168.1.25:3000', 'http://192.168.4.1:3000'];
for (const url of urls) {
  const qr = make(url, 'H');
  const p = plan((r, c) => qr.isDark(r, c), qr.getModuleCount(), { logo: true });
  assert(sameGrid(qr, p), `${url}: disegnati esattamente i moduli scuri (fuori da occhi e logo)`);
}

const wifi = make('WIFI:T:WPA;S:QuizZata;P:festa2026;;', 'M');
const wifiPlan = plan((r, c) => wifi.isDark(r, c), wifi.getModuleCount());
assert(sameGrid(wifi, wifiPlan) && wifiPlan.hole === null, 'senza logo: nessun buco, griglia identica');

console.log('\n  👁️  Occhi e angoli');

const qr = make('http://192.168.4.1:3000', 'H');
const n = qr.getModuleCount();
const p = plan((r, c) => qr.isDark(r, c), n, { logo: true });
assert(p.eyes.length === 3
  && p.eyes.some((e) => e.x === 0 && e.y === 0)
  && p.eyes.some((e) => e.x === n - EYE && e.y === 0)
  && p.eyes.some((e) => e.x === 0 && e.y === n - EYE), 'tre occhi, negli angoli giusti');

const set = new Set(p.modules.map((m) => `${m.x},${m.y}`));
const has = (x, y) => set.has(`${x},${y}`);
assert(p.modules.every((m) =>
  m.tl === (!has(m.x, m.y - 1) && !has(m.x - 1, m.y))
  && m.tr === (!has(m.x, m.y - 1) && !has(m.x + 1, m.y))
  && m.br === (!has(m.x, m.y + 1) && !has(m.x + 1, m.y))
  && m.bl === (!has(m.x, m.y + 1) && !has(m.x - 1, m.y))),
'si arrotondano solo gli angoli senza vicini');

console.log('\n  🖼️  Buco del logo');

for (const url of urls) {
  const q = make(url, 'H');
  const size = q.getModuleCount();
  const version = (size - 17) / 4;
  const hole = logoHole(size);
  const cells = [];
  for (let y = hole.y; y < hole.y + hole.side; y++) {
    for (let x = hole.x; x < hole.x + hole.side; x++) cells.push([x, y]);
  }
  // Occhi più la loro fascia di separazione (8×8), righe di temporizzazione.
  const nearEye = ([x, y]) => [[0, 0], [size - 8, 0], [0, size - 8]]
    .some(([ex, ey]) => x >= ex && x < ex + 8 && y >= ey && y < ey + 8);
  const onTiming = ([x, y]) => x === 6 || y === 6;
  // Versioni 2-6: un solo pattern di allineamento, centrato a (size-7, size-7).
  const onAlign = ([x, y]) => version >= 2
    && Math.abs(x - (size - 7)) <= 2 && Math.abs(y - (size - 7)) <= 2;
  assert(hole.side % 2 === 1 && hole.x === (size - hole.side) / 2, `${url}: buco dispari e centrato (v${version})`);
  assert(!cells.some((c) => nearEye(c) || onTiming(c) || onAlign(c)),
    `${url}: il buco non tocca occhi, temporizzazione, allineamento`);
  assert(hole.side * hole.side / (size * size) < 0.1,
    `${url}: il logo nasconde meno del 10% dei moduli (H ne ricostruisce il 30%)`);
}

const big = make('http://' + 'x'.repeat(120), 'H');
assert((big.getModuleCount() - 17) / 4 > MAX_LOGO_VERSION && logoHole(big.getModuleCount()) === null,
  'oltre la versione 6 niente logo: al centro c\'è un pattern di allineamento');

console.log('\n  🧾  Markup');

const svg = render(qr, { logo: '/resources/img/Logo.svg' });
assert(svg.includes(`viewBox="0 0 ${n + 4} ${n + 4}"`), 'margine di 2 moduli per lato');
assert((svg.match(/<path /g) || []).length === 1, 'un solo tracciato per tutti i moduli (niente righine)');
assert(svg.includes('href="/resources/img/Logo.svg"') && svg.includes('qa-plate'), 'targhetta e logo al centro');
assert(!render(wifi, { margin: 1 }).includes('<image'), 'senza logo nessuna immagine');

console.log(`\n${passed} passati, ${failed} falliti`);
process.exitCode = failed > 0 ? 1 : 0;
