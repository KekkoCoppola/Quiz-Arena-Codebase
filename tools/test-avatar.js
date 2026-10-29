'use strict';

/**
 * tools/test-avatar.js
 *
 * Il catalogo dell'avatar (client/shared/avatar-catalog.js): cosa è valido,
 * come si apre la stringa, l'estrazione a caso. Puro, nessun DOM.
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
assert(Object.isFrozen(Catalog.COLORS) && Object.isFrozen(Catalog.FACES), 'liste immutabili');
assert(new Set(Catalog.COLORS.map((c) => c.id)).size === 8, 'id colore unici');
assert(new Set(Catalog.FACES.map((f) => f.id)).size === 12, 'id faccia unici');
assert(Catalog.COLORS.every((c) => /^#[0-9a-f]{6}$/i.test(c.hex)), 'ogni colore ha un esadecimale');
assert(Catalog.COLORS.concat(Catalog.FACES).every((x) => !x.id.includes(':')), 'nessun id contiene il separatore');

console.log('\n  encode / parse / isValid');
const id = Catalog.encode('sunny_yellow', 'happy');
assert(id === 'sunny_yellow:happy', 'encode unisce colore e faccia');
const parsed = Catalog.parse(id);
assert(parsed && parsed.color.hex === '#f7d708' && parsed.face.id === 'happy', 'parse restituisce colore e faccia');
for (const bad of ['volpe', '', 'sunny_yellow', 'sunny_yellow:', ':happy', 'sunny_yellow:happy:x',
  'blu:happy', 'sunny_yellow:dinosauro', null, undefined, 42, {}]) {
  assert(Catalog.parse(bad) === null && !Catalog.isValid(bad), `rifiutato: ${JSON.stringify(bad)}`);
}

console.log('\n  random');
let seq = 0;
const fixed = () => [0, 0.99][seq++ % 2];
assert(Catalog.random(fixed) === 'coral_red:nervous', 'random usa il generatore iniettato');
let allValid = true;
for (let i = 0; i < 500; i++) allValid = allValid && Catalog.isValid(Catalog.random());
assert(allValid, '500 estrazioni tutte valide');

console.log('\n  Ritratti PNG (tools/render-avatars.js)');
// Un file mancante non dà errori in sala: l'<img> resta rotto davanti a tutti.
// Qui si vede prima.
const Sprite = require('../client/shared/avatar-sprite');
const path = require('node:path');
const fs = require('node:fs');
const AVATAR_DIR = path.join(__dirname, '..', 'resources', 'img', 'avatars');
const names = [Sprite.NEUTRAL];
for (const c of Catalog.COLORS) for (const f of Catalog.FACES) names.push(`${c.id}-${f.id}`);
for (const size of Sprite.SIZES) {
  const missing = names.filter((n) => !fs.existsSync(path.join(AVATAR_DIR, size, `${n}.png`)));
  assert(missing.length === 0, `${size}: ${names.length} ritratti presenti` + (missing.length ? ` — mancano: ${missing.join(', ')}` : ''));
}
assert(Sprite.url('sunny_yellow:happy', 'lg') === '/resources/img/avatars/lg/sunny_yellow-happy.png', 'url: percorso del ritratto');
assert(Sprite.url('volpe') === '/resources/img/avatars/sm/neutral.png', 'url: id sconosciuto → personaggio neutro');
assert(Sprite.url('sunny_yellow:happy', 'xl').includes('/sm/'), 'url: misura sconosciuta → sm');

console.log('\n  Bot');
const botAvatars = Array.from({ length: 19 }, (_, i) => TestBots.identity(i).avatar);
assert(botAvatars.every(Catalog.isValid), 'ogni bot ha un avatar del catalogo');
assert(new Set(botAvatars).size === 19, '19 bot, 19 personaggi diversi');

console.log(`\n  ${passed} PASS, ${failed} FAIL\n`);
process.exitCode = failed ? 1 : 0;
