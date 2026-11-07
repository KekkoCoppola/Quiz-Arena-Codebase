'use strict';

/**
 * tools/test-license.js
 *
 * Smoke test della licenza annuale (server/license.js) e dei limiti che porta
 * nella partita (server/game.js). Puro: chiavi generate al volo in memoria,
 * nessun file, nessun DB, nessuna rete.
 *
 * Utilizzo: node tools/test-license.js  (oppure npm run test:license)
 */

const crypto = require('node:crypto');
const L = require('../server/license');
const { GameSession, GameFullError, InvalidMinigameTypeError, MINIGAME_TYPE_KEYS, RANDOM_TYPE } = require('../server/game');

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

function section(title) {
  console.log(`\n── ${title} ──`);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');

const SERIAL = '10000000a1b2c3d4';
const DAY = 86_400_000;
const base = {
  serial: SERIAL,
  customer: 'Pub Da Mario',
  validUntil: '2027-11-07',
  issuedAt: '2026-11-07',
  maxPlayers: 20,
  minigames: 'all',
  contact: '+39 333 123 4567',
};

// ─── Firma e verifica ────────────────────────────────────────────────────────────

section('Firma e verifica');

const code = L.signLicense(base, privateKey);
{
  const r = L.verifyLicense(code, publicKey);
  assert(code.startsWith('QZ1.') && code.split('.').length === 3, 'il codice ha la forma QZ1.<dati>.<firma>');
  assert(r.ok && r.license.serial === SERIAL && r.license.maxPlayers === 20, 'un codice firmato si verifica e restituisce i dati');
  assert(r.ok && r.license.contact === '393331234567', 'il numero di contatto si normalizza alle sole cifre');
}
assert(L.verifyLicense(`http://192.168.4.1/licenza#${code}`, publicKey).ok, 'si accetta anche il link intero');
assert(L.verifyLicense(`${code.slice(0, 40)}\n ${code.slice(40)}`, publicKey).ok, 'si accetta il codice spezzato su più righe');
{
  const [p, body, sig] = code.split('.');
  const data = JSON.parse(Buffer.from(body, 'base64url').toString());
  data.validUntil = '2099-12-31';
  const forged = `${p}.${Buffer.from(JSON.stringify(data)).toString('base64url')}.${sig}`;
  assert(!L.verifyLicense(forged, publicKey).ok, 'cambiare la scadenza rompe la firma');
  data.validUntil = base.validUntil;
  data.maxPlayers = 100;
  const forged2 = `${p}.${Buffer.from(JSON.stringify(data)).toString('base64url')}.${sig}`;
  assert(!L.verifyLicense(forged2, publicKey).ok, 'cambiare il numero di giocatori rompe la firma');
}
assert(!L.verifyLicense(L.signLicense(base, other.privateKey), publicKey).ok, 'una licenza firmata con un\'altra chiave non vale');
assert(!L.verifyLicense('ciao', publicKey).ok && !L.verifyLicense('', publicKey).ok, 'un testo qualunque viene rifiutato');
assert(!L.verifyLicense(code, null).ok, 'senza chiave pubblica nessun codice vale');
{
  let threw = false;
  try { L.signLicense({ ...base, validUntil: '2027-02-31' }, privateKey); } catch { threw = true; }
  assert(threw, 'non si firma una data impossibile (31 febbraio)');
}

// ─── Stato della licenza ─────────────────────────────────────────────────────────

section('Stato della licenza');

const lic = L.verifyLicense(code, publicKey).license;
const end = Date.UTC(2027, 10, 8); // fine del 7 novembre 2027
{
  const off = L.evaluateLicense({ license: null, serial: null, now: end, required: false });
  assert(off.state === 'off' && off.entitlements.maxPlayers === null, 'licenza non richiesta: nessun limite');

  const missing = L.evaluateLicense({ license: null, serial: SERIAL, now: end, required: true });
  assert(missing.state === 'missing' && missing.demo && missing.entitlements.maxPlayers === L.DEMO_ENTITLEMENTS.maxPlayers,
    'nessuna licenza: modalità demo');

  const wrong = L.evaluateLicense({ license: lic, serial: 'ffffffffffffffff', now: end - 100 * DAY, required: true });
  assert(wrong.state === 'wrong-device' && wrong.demo, 'licenza di un altro Pi (SD copiata): modalità demo');

  const active = L.evaluateLicense({ license: lic, serial: SERIAL, now: end - 100 * DAY, required: true });
  assert(active.state === 'active' && active.daysLeft === 100 && active.entitlements.maxPlayers === 20,
    'attiva: giorni rimasti e limiti della licenza');

  const expiring = L.evaluateLicense({ license: lic, serial: SERIAL, now: end - 10 * DAY, required: true });
  assert(expiring.state === 'expiring' && !expiring.demo, `negli ultimi ${L.WARN_DAYS} giorni: in scadenza, funziona ancora`);

  const lastDay = L.evaluateLicense({ license: lic, serial: SERIAL, now: end - 1000, required: true });
  assert(lastDay.state === 'expiring', 'l\'ultimo giorno vale per intero');

  const grace = L.evaluateLicense({ license: lic, serial: SERIAL, now: end + 3 * DAY, required: true });
  assert(grace.state === 'grace' && !grace.demo && grace.entitlements.maxPlayers === 20,
    `scaduta da poco: ${L.GRACE_DAYS} giorni di tolleranza con i limiti pieni`);

  const expired = L.evaluateLicense({ license: lic, serial: SERIAL, now: end + (L.GRACE_DAYS + 1) * DAY, required: true });
  assert(expired.state === 'expired' && expired.demo, 'finita la tolleranza: modalità demo');
}

section('Pacchetti');
{
  const pack = L.verifyLicense(L.signLicense({ ...base, minigames: ['morra_cinese'] }, privateKey), publicKey).license;
  const ent = L.evaluateLicense({ license: pack, serial: SERIAL, now: end - 100 * DAY, required: true }).entitlements;
  assert(L.isMinigameAllowed(ent, 'morra_cinese') && !L.isMinigameAllowed(ent, 'cup_game'), 'un pacchetto ridotto include solo i minigiochi elencati');
  assert(L.isMinigameAllowed(L.FULL_ENTITLEMENTS, 'un_minigioco_futuro'), '"tutti" comprende anche i minigiochi futuri');
}

section('Sostituzione di un codice');
{
  const newer = L.verifyLicense(L.signLicense({ ...base, validUntil: '2028-11-07' }, privateKey), publicKey).license;
  const older = L.verifyLicense(L.signLicense({ ...base, validUntil: '2026-12-01' }, privateKey), publicKey).license;
  const foreign = L.verifyLicense(L.signLicense({ ...base, serial: 'ffffffffffffffff' }, privateKey), publicKey).license;
  assert(L.canReplace(lic, newer, SERIAL).ok, 'il rinnovo sostituisce la licenza attiva');
  assert(!L.canReplace(lic, older, SERIAL).ok, 'un codice vecchio non accorcia la licenza');
  assert(!L.canReplace(lic, foreign, SERIAL).ok, 'un codice per un altro Pi si rifiuta');
  assert(L.canReplace(null, lic, SERIAL).ok, 'la prima attivazione passa');
}

// ─── Ora fidata ──────────────────────────────────────────────────────────────────

section('Ora fidata dai telefoni');
{
  const real = Date.UTC(2027, 5, 1, 20, 0);
  const piClock = real - 30 * DAY; // il Pi è indietro di un mese
  const clock = L.createTrustedClock();
  clock.observe('192.168.4.10', real, piClock);
  clock.observe('192.168.4.11', real + 20_000, piClock);
  assert(!clock.hasConsensus(piClock) && clock.now(piClock) === piClock, 'due telefoni non bastano: vale l\'orologio del Pi');
  const advanced = clock.observe('192.168.4.12', real - 15_000, piClock);
  assert(advanced && Math.abs(clock.now(piClock) - real) < 60_000, 'tre telefoni d\'accordo: l\'ora è la loro');

  const floor = clock.floor;
  const reboot = L.createTrustedClock({ floorMs: floor });
  assert(reboot.now(piClock - 300 * DAY) >= floor, 'dopo un riavvio col Pi indietro, l\'ora non torna sotto il massimo confermato');
}
{
  const real = Date.UTC(2027, 5, 1, 20, 0);
  const clock = L.createTrustedClock();
  ['a', 'b', 'c'].forEach((k, i) => clock.observe(k, real + i * 1000, real));
  clock.observe('ospite-2030', Date.UTC(2030, 0, 1), real);
  assert(Math.abs(clock.now(real) - real) < 60_000, 'un telefono con l\'ora sbagliata non sposta niente');
}
{
  const real = Date.UTC(2027, 5, 1, 20, 0);
  const clock = L.createTrustedClock();
  for (let i = 0; i < 5; i++) clock.observe('stesso-telefono', real - 400 * DAY, real);
  assert(!clock.hasConsensus(real), 'lo stesso dispositivo che si ricollega conta una volta sola');
}
{
  const real = Date.UTC(2027, 5, 1, 20, 0);
  const clock = L.createTrustedClock({ floorMs: real });
  ['a', 'b', 'c'].forEach((k) => clock.observe(k, real - 200 * DAY, real));
  assert(clock.now(real) >= real, 'telefoni tutti indietro nel tempo: il massimo confermato non scende');
}

// ─── Limiti nella partita ────────────────────────────────────────────────────────

section('Limiti nella partita');

const QUIZ = {
  title: 'Prova',
  questions: [
    { text: 'Uno?', options: ['A', 'B'], correct_index: 0, time_limit_s: 10 },
    { text: 'Due?', options: ['A', 'B'], correct_index: 1, time_limit_s: 10 },
  ],
};
{
  const s = new GameSession(QUIZ, { maxPlayers: 3 });
  ['Ada', 'Bob', 'Cleo'].forEach((n) => s.addPlayer(n));
  let full = null;
  try { s.addPlayer('Dario'); } catch (e) { full = e; }
  assert(full instanceof GameFullError && s.players.size === 3, 'oltre il massimo nessuno entra (GameFullError)');
}
{
  let limit = 1;
  const s = new GameSession(QUIZ, { maxPlayers: () => limit });
  s.addPlayer('Ada');
  let blocked = false;
  try { s.addPlayer('Bob'); } catch { blocked = true; }
  limit = 20;
  s.addPlayer('Bob');
  assert(blocked && s.players.size === 2, 'il limite letto da una funzione vale subito dopo un rinnovo in lobby');
}
{
  const s = new GameSession(QUIZ);
  for (let i = 0; i < 40; i++) s.addPlayer(`G${i}`);
  assert(s.players.size === 40, 'senza limite entrano tutti');
}
if (MINIGAME_TYPE_KEYS.length >= 2) {
  const only = MINIGAME_TYPE_KEYS[0];
  const excluded = MINIGAME_TYPE_KEYS[1];
  const planned = {
    ...QUIZ,
    minigames: [
      { afterQuestionIndex: 0, type: excluded },
      { afterQuestionIndex: 0, type: RANDOM_TYPE },
      { afterQuestionIndex: 1, type: RANDOM_TYPE },
    ],
  };
  const s = new GameSession(planned, { allowedMinigames: [only] });
  const types = s.rounds.filter((r) => r.kind === 'minigame').map((r) => r.minigameType);
  assert(types.length > 0 && types.every((t) => t === only),
    'pacchetto ridotto: gli slot casuali estraggono solo i minigiochi inclusi, quelli esclusi si saltano');

  s.addPlayer('Ada');
  s.startGame();
  s.endQuestion();
  let err = null;
  try { s.insertMinigame(excluded); } catch (e) { err = e; }
  assert(err instanceof InvalidMinigameTypeError && /licenza/.test(err.message),
    'inserire al volo un minigioco escluso dà un errore che parla di licenza');
} else {
  console.log('  (un solo minigioco registrato: test dei pacchetti saltato)');
}

// ─── Esito ───────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passati, ${failed} falliti`);
if (failed > 0) process.exitCode = 1;
