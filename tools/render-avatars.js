'use strict';

/**
 * tools/render-avatars.js
 *
 * Genera i ritratti PNG dell'avatar dal modello 3D di client/shared/mii-character.js:
 * una foto per ogni combinazione colore × espressione del catalogo
 * (client/shared/avatar-catalog.js), più il personaggio neutro per gli id
 * sconosciuti, in due misure.
 *
 *   node tools/render-avatars.js
 *   → apre un server su http://localhost:3999 : aprire quell'indirizzo in un
 *     browser con WebGL (Chrome, Edge). La pagina disegna, rimanda i PNG qui e
 *     lo strumento si chiude da solo.
 *
 * Perché delle foto e non il 3D vivo: il telefono non deve scaricare nulla
 * oltre alla pagina e alle sue immagini (three.js da solo pesa 676 KB, e venti
 * telefoni entrano tutti insieme sul Wi-Fi del Raspberry). Il modello 3D si
 * disegna qui, una volta, sul PC di chi sviluppa; i client mostrano un <img>.
 *
 * Va rilanciato quando cambia il catalogo o il modello: `npm run test:avatar`
 * segnala i file mancanti. Strumento da riga di comando, non fa parte del server.
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'resources', 'img', 'avatars');
const PORT = 3999;

/**
 * sm: liste, pedine, classifiche (mostrato a ~30-60 px).
 * lg: la scelta sul telefono e il podio (fino a ~180 px a densità 2-3).
 */
const SIZES = Object.freeze([
  Object.freeze({ name: 'sm', w: 128, h: 160 }),
  Object.freeze({ name: 'lg', w: 432, h: 540 }),
]);

/** Il personaggio degli id sconosciuti: lo stesso grigio di avatar-sprite.js. */
const NEUTRAL = Object.freeze({ name: 'neutral', hex: '#d4d2ea', face: 'happy' });

const FILES = {
  '/three.js': path.join(ROOT, 'client', 'shared', 'vendor', 'three', 'three.module.min.js'),
  '/mii.js': path.join(ROOT, 'client', 'shared', 'mii-character.js'),
  '/catalog.js': path.join(ROOT, 'client', 'shared', 'avatar-catalog.js'),
};

const PAGE = `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>Ritratti avatar</title></head>
<body style="margin:0;padding:24px;font:700 16px system-ui;background:#f1f0fa;color:#201b0d">
<p id="stato">Disegno in corso…</p>
<script src="/catalog.js"></script>
<script src="/mii.js"></script>
<script type="module">
import * as THREE from '/three.js';
const SIZES = ${JSON.stringify(SIZES)};
const NEUTRAL = ${JSON.stringify(NEUTRAL)};
const stato = document.getElementById('stato');

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setClearColor(0x000000, 0);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x9d99c9, 1.7));
const key = new THREE.DirectionalLight(0xffffff, 2.1);
key.position.set(2.5, 4, 5);
scene.add(key);

// Di tre quarti appena accennati: si vede che è un solido, e la faccia resta leggibile.
const camera = new THREE.PerspectiveCamera(28, 4 / 5, 0.1, 50);
camera.position.set(0, 1.05, 4.5);
camera.lookAt(0, 0.8, 0);

const jobs = [];
for (const c of AvatarCatalog.COLORS) {
  for (const f of AvatarCatalog.FACES) jobs.push({ name: c.id + '-' + f.id, hex: c.hex, face: f.id });
}
jobs.push(NEUTRAL);

let done = 0;
for (const job of jobs) {
  const mii = MiiCharacter3D.createMii(THREE, { skinColor: job.hex, expression: job.face });
  mii.group.rotation.y = -0.32;
  scene.add(mii.group);
  for (const s of SIZES) {
    renderer.setSize(s.w, s.h, false);
    renderer.render(scene, camera);
    const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
    const res = await fetch('/save?size=' + s.name + '&name=' + job.name, { method: 'POST', body: blob });
    if (!res.ok) throw new Error('salvataggio rifiutato: ' + job.name);
  }
  scene.remove(mii.group);
  mii.dispose();
  stato.textContent = 'Disegnati ' + (++done) + ' di ' + jobs.length;
}
await fetch('/done', { method: 'POST' });
stato.textContent = 'Fatto: ' + jobs.length + ' personaggi. Si può chiudere la pagina.';
</script>
</body></html>`;

const SAFE_NAME = /^[a-z_]+(-[a-z_]+)?$/;
const SIZE_NAMES = new Set(SIZES.map((s) => s.name));

for (const s of SIZES) fs.mkdirSync(path.join(OUT_DIR, s.name), { recursive: true });

let saved = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (req.method === 'GET' && FILES[url.pathname]) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    fs.createReadStream(FILES[url.pathname]).pipe(res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/save') {
    const size = url.searchParams.get('size');
    const name = url.searchParams.get('name');
    if (!SIZE_NAMES.has(size) || !SAFE_NAME.test(name || '')) {
      res.writeHead(400).end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      fs.writeFileSync(path.join(OUT_DIR, size, `${name}.png`), Buffer.concat(chunks));
      saved++;
      res.writeHead(204).end();
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/done') {
    res.writeHead(204).end();
    console.log(`  Salvati ${saved} PNG in ${path.relative(ROOT, OUT_DIR)}`);
    server.close();
    return;
  }
  res.writeHead(404).end();
});

// Solo loopback: lo strumento scrive file su richiesta di chi lo chiama.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Apri http://localhost:${PORT} in un browser con WebGL.\n`);
});
