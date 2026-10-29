'use strict';

/**
 * tools/test-final.js
 *
 * Smoke test isolato per client/shared/final-schedule.js, e per il suo accordo
 * con la coreografia di client/shared/podium-ceremony.js.
 * Nessun DOM, timer o socket: la scena 3D si carica in Node solo per leggerne
 * i tempi e la disposizione, senza disegnare nulla.
 *
 * Il calendario esiste perché il server ne legge la durata per liberare i
 * telefoni: se la scena 3D durasse più di quanto il server aspetta, un telefono
 * mostrerebbe la posizione mentre in sala manca ancora il vincitore.
 *
 * Utilizzo: node tools/test-final.js  (oppure npm run test:final)
 */

const {
  DURATION_MS,
  REVEAL_AT,
  PLAYER_LAG_MS,
  ceremonyDurationMs,
  revealAtForRank,
} = require('../client/shared/final-schedule');
const Podium = require('../client/shared/podium-ceremony');

// ─── Setup ───────────────────────────────────────────────────────────────────────

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

// ─── Il calendario e la scena 3D dicono la stessa cosa ──────────────────────────

section('Accordo con la scena 3D');

assert(Podium.DEFAULT_DURATION_MS === DURATION_MS,
  `la scena 3D dura quanto il calendario (${DURATION_MS} ms)`);
assert(REVEAL_AT[3] === Podium.TIMELINE.thirdLandAt, 'il 3° si rivela quando atterra sul podio');
assert(REVEAL_AT[2] === Podium.TIMELINE.secondLandAt, 'il 2° si rivela quando atterra sul podio');
assert(REVEAL_AT[1] === Podium.TIMELINE.firstLandAt, 'il 1° si rivela quando atterra in vetta');
assert(Podium.TIMELINE.act5End === 1, 'la coreografia finisce esattamente a fine durata');

// ─── Ordine delle rivelazioni ────────────────────────────────────────────────────

section('Ordine della premiazione');

for (const n of [3, 4, 10, 25]) {
  assert(
    revealAtForRank(3, n) < revealAtForRank(2, n) && revealAtForRank(2, n) < revealAtForRank(1, n),
    `${n} giocatori: prima il 3°, poi il 2°, il vincitore per ultimo`,
  );
}
assert(revealAtForRank(4, 10) === 0 && revealAtForRank(10, 10) === 0,
  'dal 4° in giù si è in scena fin dall\'inizio, tra il pubblico');
assert(revealAtForRank(1, 1) > 0, 'con un giocatore solo il vincitore non esplode nell\'istante zero');
assert(revealAtForRank(3, 2) === null, '2 giocatori: nessun 3° da rivelare');
assert(revealAtForRank(0, 5) === null && revealAtForRank(6, 5) === null && revealAtForRank(1.5, 5) === null,
  'un posto che non esiste non ha un istante');

// ─── Durata che il server aspetta prima di liberare i telefoni ──────────────────

section('Segnale ai telefoni (anti-spoiler)');

for (const n of [1, 2, 3, 20]) {
  assert(ceremonyDurationMs(n) === DURATION_MS + PLAYER_LAG_MS,
    `${n} giocatori: il server aspetta la cerimonia intera più ${PLAYER_LAG_MS} ms`);
  assert(ceremonyDurationMs(n) > revealAtForRank(1, n),
    `${n} giocatori: il telefono non può mostrare la posizione prima della proclamazione`);
}
assert(ceremonyDurationMs(0) === 0, '0 giocatori → nessuna attesa');
const bad = [undefined, null, NaN, -3, 'sette', {}];
assert(bad.every((v) => ceremonyDurationMs(v) === 0),
  'un conteggio non valido dà un\'attesa nulla, non un\'eccezione');

// ─── Disposizione della scena ────────────────────────────────────────────────────

section('Disposizione del podio e del pubblico');

{
  const players = Array.from({ length: 20 }, (_, i) => ({
    id: `p${i}`, name: `G${i + 1}`, rank: i + 1, skinColor: '#f7d708', expression: 'happy',
  }));
  const layout = Podium.computeCrowdLayout(players);
  assert(layout.podium.first.name === 'G1' && layout.podium.second.name === 'G2'
    && layout.podium.third.name === 'G3', '20 giocatori: i primi tre salgono sul podio');
  assert(layout.crowd.length === 17, '20 giocatori: gli altri 17 fanno da pubblico');
}
{
  const layout = Podium.computeCrowdLayout([{ name: 'Solo', rank: 1, skinColor: '#5ce1e6', expression: 'laugh' }]);
  assert(layout.podium.first.name === 'Solo' && !layout.podium.second && !layout.podium.third
    && layout.crowd.length === 0, '1 giocatore: solo il vincitore, nessun pubblico');
  assert(layout.podium.first.expression === 'laugh', 'le espressioni aggiunte al catalogo arrivano alla scena');
}

// ─── Esito ───────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passati, ${failed} falliti`);
if (failed > 0) process.exitCode = 1;
