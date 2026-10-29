'use strict';

/**
 * tools/test-avatar.js
 *
 * Il catalogo dell'avatar (client/shared/avatar-catalog.js): cosa è valido,
 * come si apre la stringa, l'estrazione a caso, l'accordo col modello 3D e
 * che ogni foto esista. Puro, nessun DOM.
 *
 * Uso: node tools/test-avatar.js  (oppure npm run test:avatar)
 */

const Catalog = require('../client/shared/avatar-catalog');
const TestBots = require('../server/test-bots');

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
}

console.log('\n  Catalogo');
assert(Catalog.COLORS.length === 8, '8 colori');
assert(Catalog.FACES.length === 12, '12 espressioni');
assert(Catalog.OUTFITS.length === 5, '5 outfit');
assert([Catalog.COLORS, Catalog.FACES, Catalog.OUTFITS].every(Object.isFrozen), 'liste immutabili');
assert(new Set(Catalog.COLORS.map((c) => c.id)).size === 8, 'id colore unici');
assert(new Set(Catalog.FACES.map((f) => f.id)).size === 12, 'id faccia unici');
assert(new Set(Catalog.OUTFITS.map((o) => o.id)).size === 5, 'id outfit unici');
assert(Catalog.COLORS.every((c) => /^#[0-9a-f]{6}$/i.test(c.hex)), 'ogni colore ha un esadecimale');
assert(Catalog.COLORS.concat(Catalog.FACES, Catalog.OUTFITS).every((x) => !x.id.includes(':')),
  'nessun id contiene il separatore');

console.log('\n  Accordo con il modello 3D');
// Un id che il modello non conosce si vedrebbe solo in sala, come divisa classica.
const Mii = require('../client/shared/mii-character');
const miiOutfits = new Set(Mii.OUTFIT_PRESETS.map((o) => o.id));
assert(Catalog.OUTFITS.every((o) => miiOutfits.has(o.id)), 'ogni outfit del catalogo ha i suoi colori nel modello');
assert(Catalog.OUTFITS[0].id === Mii.OUTFIT_PRESETS[0].id, 'il primo outfit è la divisa di default del modello');
const miiFaces = new Set(Mii.EXPRESSION_PRESETS.map((e) => e.id));
assert(Catalog.FACES.every((f) => miiFaces.has(f.id)), 'ogni espressione del catalogo è disegnata dal modello');
assert(Mii.normalizeMiiConfig({ outfit: 'elegant' }).outfit === 'elegant'
  && Mii.normalizeMiiConfig({ outfit: 'pigiama' }).outfit === 'classic', 'il modello ripiega sulla divisa classica');

console.log('\n  encode / parse / isValid');
const id = Catalog.encode('sunny_yellow', 'happy', 'sport');
assert(id === 'sunny_yellow:happy:sport', 'encode unisce colore, faccia e outfit');
const parsed = Catalog.parse(id);
assert(parsed && parsed.color.hex === '#f7d708' && parsed.face.id === 'happy' && parsed.outfit.id === 'sport',
  'parse restituisce colore, faccia e outfit');
assert(Catalog.encode('sunny_yellow', 'happy') === 'sunny_yellow:happy:classic', 'encode senza outfit → divisa classica');
const legacy = Catalog.parse('sunny_yellow:happy');
assert(legacy && legacy.outfit.id === 'classic', 'scelta salvata prima degli outfit → valida, divisa classica');
for (const bad of ['volpe', '', 'sunny_yellow', 'sunny_yellow:', ':happy', 'sunny_yellow:happy:x',
  'sunny_yellow:happy:', 'sunny_yellow:happy:sport:x', 'blu:happy', 'sunny_yellow:dinosauro',
  null, undefined, 42, {}]) {
  assert(Catalog.parse(bad) === null && !Catalog.isValid(bad), `rifiutato: ${JSON.stringify(bad)}`);
}

console.log('\n  random');
let seq = 0;
const fixed = () => [0, 0.99][seq++ % 2];
assert(Catalog.random(fixed) === 'coral_red:nervous:classic', 'random usa il generatore iniettato');
let allValid = true;
for (let i = 0; i < 500; i++) allValid = allValid && Catalog.isValid(Catalog.random());
assert(allValid, '500 estrazioni tutte valide');

console.log('\n  Ritratti PNG (tools/render-avatars.js)');
// Un file mancante non dà errori in sala: l'<img> resta rotto davanti a tutti.
// Qui si vede prima.
const Sprite = require('../client/shared/avatar-sprite');
const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');
const exists = (src) => fs.existsSync(path.join(ROOT, src));
const all = [];
for (const c of Catalog.COLORS) for (const f of Catalog.FACES) for (const o of Catalog.OUTFITS) {
  all.push(Catalog.encode(c.id, f.id, o.id));
}
// Un id rotto deve avere anche lui i suoi file: è il personaggio neutro.
all.push('volpe');
const report = (label, srcs) => {
  const missing = [...new Set(srcs)].filter((s) => !exists(s));
  assert(missing.length === 0, `${label}: ${new Set(srcs).size} file`
    + (missing.length ? ` — ne mancano ${missing.length}: ${missing.join(', ')}` : ''));
};
report('teste (face/)', all.map((a) => Sprite.url(a)));
report('corpi (body/)', all.map((a) => Sprite.layers(a).body));
report('facce (expr/)', all.map((a) => Sprite.layers(a).face));
assert(Sprite.url('sunny_yellow:happy:sport') === '/resources/img/avatars/face/sunny_yellow-happy.png',
  'url: la testa non dipende dall\'outfit');
const layers = Sprite.layers('sunny_yellow:happy:sport');
assert(layers.body === '/resources/img/avatars/body/sunny_yellow-sport.png'
  && layers.face === '/resources/img/avatars/expr/happy.png', 'layers: corpo per colore e outfit, faccia a parte');
assert(Sprite.url('volpe') === '/resources/img/avatars/face/neutral.png', 'url: id sconosciuto → personaggio neutro');
assert(Sprite.layers('volpe').body === '/resources/img/avatars/body/neutral.png', 'layers: id sconosciuto → corpo neutro');

console.log('\n  Bot');
const botAvatars = Array.from({ length: 19 }, (_, i) => TestBots.identity(i).avatar);
assert(botAvatars.every(Catalog.isValid), 'ogni bot ha un avatar del catalogo');
assert(new Set(botAvatars).size === 19, '19 bot, 19 personaggi diversi');

console.log(`\n  ${passed} PASS, ${failed} FAIL\n`);
process.exitCode = failed ? 1 : 0;
