'use strict';

/**
 * tools/render-avatars.js
 *
 * Genera i ritratti PNG dell'avatar dal modello 3D di client/shared/mii-character.js,
 * per ogni voce del catalogo (client/shared/avatar-catalog.js), più il personaggio
 * neutro per gli id sconosciuti. Tre serie, descritte in ALL_SIZES; come si
 * usano lo dice client/shared/avatar-sprite.js.
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
 * face: solo la testa, inquadrata da vicino — i mini avatar (pedine sulle
 *       risposte, lobby, classifiche, badge), mostrati a ~20-70 px. A quella
 *       misura il corpo intero era un francobollo; la testa porta già tutto
 *       quello che distingue un giocatore: il colore e l'espressione.
 *       Una per colore × espressione (l'outfit lì non si vede).
 * body: il personaggio intero SENZA la faccia disegnata, per la scelta sul
 *       telefono (fino a ~180 px a densità 2-3). Una per colore × outfit.
 * expr: SOLO la faccia disegnata, nella stessa inquadratura di `body`: il
 *       telefono la sovrappone al corpo. Una per espressione.
 */
const ALL_SIZES = Object.freeze([
  // Orizzontale come la testa del modello (più larga che alta): in un quadrato
  // occupava solo la fascia di mezzo e restava piccola accanto al nome.
  Object.freeze({ name: 'face', w: 176, h: 128, show: 'head' }),
  Object.freeze({ name: 'body', w: 432, h: 540, show: 'body' }),
  Object.freeze({ name: 'expr', w: 432, h: 540, show: 'decal' }),
]);

/** `node tools/render-avatars.js face` rigenera solo quella misura. */
const requested = process.argv.slice(2);
const SIZES = requested.length
  ? ALL_SIZES.filter((s) => requested.includes(s.name))
  : ALL_SIZES;
if (SIZES.length === 0) {
  console.error(`  Misura sconosciuta: ${requested.join(', ')}. Disponibili: ${ALL_SIZES.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

/** Il personaggio degli id sconosciuti, con la faccia di avatar-sprite.js. */
const NEUTRAL = Object.freeze({ name: 'neutral', hex: '#d4d2ea', face: 'happy', outfit: 'classic' });

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
const bodyCamera = new THREE.PerspectiveCamera(28, 4 / 5, 0.1, 50);
bodyCamera.position.set(0, 1.05, 4.5);
bodyCamera.lookAt(0, 0.8, 0);

// La testa da vicino, appena dall'alto: il blocco del modello va da ~0.77 a
// ~1.59 m, e girato di poco resta largo circa 1,35 m. Campo verticale scelto
// perché in 11:8 la larghezza entri con un filo di margine.
const headCamera = new THREE.PerspectiveCamera(15, 176 / 128, 0.1, 50);
headCamera.position.set(0, 1.42, 4.1);
headCamera.lookAt(0, 1.19, 0);

/** Sotto questa quota sta il corpo: nel ritratto della testa non si disegna. */
const HEAD_MIN_Y = 0.95;

/**
 * Cosa resta visibile: 'head' la testa con la faccia, 'body' tutto tranne la
 * faccia disegnata, 'decal' solo la faccia disegnata, 'all' tutto.
 */
function show(group, what) {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const center = new THREE.Vector3();
  group.traverse((o) => {
    if (!o.isMesh) return;
    const decal = o.name === 'faceDecal';
    if (what === 'head') o.visible = box.setFromObject(o).getCenter(center).y >= HEAD_MIN_Y;
    else if (what === 'body') o.visible = !decal;
    else if (what === 'decal') o.visible = decal;
    else o.visible = true;
  });
}

function jobsFor(size) {
  const { COLORS, FACES, OUTFITS } = AvatarCatalog;
  const jobs = [];
  if (size.name === 'face') {
    for (const c of COLORS) for (const f of FACES) jobs.push({ name: c.id + '-' + f.id, hex: c.hex, face: f.id });
  } else if (size.name === 'body') {
    for (const c of COLORS) for (const o of OUTFITS) jobs.push({ name: c.id + '-' + o.id, hex: c.hex, outfit: o.id });
  } else {
    // La faccia non dipende dal colore della pelle: il disegno è inchiostro su trasparente.
    for (const f of FACES) jobs.push({ name: f.id, hex: NEUTRAL.hex, face: f.id });
    return jobs;
  }
  jobs.push(NEUTRAL);
  return jobs;
}

/** Disegna un personaggio e restituisce il canvas di WebGL (letto subito dopo). */
function draw(job, size, what) {
  const mii = MiiCharacter3D.createMii(THREE, { skinColor: job.hex, expression: job.face, outfit: job.outfit });
  scene.add(mii.group);
  // La testa da sola gira meno: la faccia deve leggersi anche a 20 px.
  mii.group.rotation.y = what === 'head' ? -0.22 : -0.32;
  show(mii.group, what);
  renderer.setSize(size.w, size.h, false);
  renderer.render(scene, what === 'head' ? headCamera : bodyCamera);
  scene.remove(mii.group);
  mii.dispose();
  return renderer.domElement;
}

const total = SIZES.reduce((n, s) => n + jobsFor(s).length, 0);
let done = 0;
for (const s of SIZES) {
  for (const job of jobsFor(s)) {
    const blob = await new Promise((r) => draw(job, s, s.show).toBlob(r, 'image/png'));
    const res = await fetch('/save?size=' + s.name + '&name=' + job.name, { method: 'POST', body: blob });
    if (!res.ok) throw new Error('salvataggio rifiutato: ' + job.name);
    stato.textContent = 'Disegnati ' + (++done) + ' di ' + total;
  }
}

// Controllo della sovrapposizione: corpo + faccia devono dare la foto intera.
// Se un giorno qualcosa del modello finisse davanti alla faccia, qui si vede.
function pixels(canvases) {
  const c = document.createElement('canvas');
  c.width = 432; c.height = 540;
  const ctx = c.getContext('2d');
  for (const src of canvases) ctx.drawImage(src, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height).data;
}
function snapshot(job, what) {
  const c = document.createElement('canvas');
  c.width = 432; c.height = 540;
  c.getContext('2d').drawImage(draw(job, { w: 432, h: 540 }, what), 0, 0);
  return c;
}
const probe = { hex: '#f26b5e', face: 'laugh', outfit: 'elegant' };
const whole = pixels([snapshot(probe, 'all')]);
const stacked = pixels([snapshot(probe, 'body'), snapshot(probe, 'decal')]);
let off = 0;
for (let i = 0; i < whole.length; i += 4) {
  // Confronto premoltiplicato: sui bordi semitrasparenti il colore puro non conta.
  for (let k = 0; k < 4; k++) {
    const a = k === 3 ? 255 : whole[i + 3], b = k === 3 ? 255 : stacked[i + 3];
    if (Math.abs(whole[i + k] * a - stacked[i + k] * b) / 255 > 6) { off++; break; }
  }
}
await fetch('/done?off=' + off, { method: 'POST' });
stato.textContent = 'Fatto: ' + total + ' immagini. Si può chiudere la pagina.';
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
    const off = Number(url.searchParams.get('off'));
    console.log(off === 0
      ? '  Corpo + faccia sovrapposti = foto intera: OK'
      : `  ATTENZIONE: corpo + faccia sovrapposti differiscono dalla foto intera in ${off} pixel`);
    server.close();
    return;
  }
  res.writeHead(404).end();
});

// Solo loopback: lo strumento scrive file su richiesta di chi lo chiama.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Apri http://localhost:${PORT} in un browser con WebGL.\n`);
});
