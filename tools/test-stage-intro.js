'use strict';

/**
 * tools/test-stage-intro.js
 *
 * Smoke test isolato per client/shared/stage-intro.js, il sipario che apre
 * ogni minigioco in sala.
 *
 * Non prova la grafica (è WebGL, si guarda in sala) ma le tre promesse su cui
 * client/sala/app.js costruisce il proprio tempismo:
 *   1. le tende sono CHIUSE nell'istante in cui la sala monta il minigioco
 *      sotto di loro (`TIMELINE.curtainClose2End`), altrimenti lo si vedrebbe
 *      comparire di colpo;
 *   2. a sipario finito sono del tutto aperte;
 *   3. la ruota si ferma sullo spicchio del minigioco che il server ha estratto.
 *
 * Utilizzo: node tools/test-stage-intro.js   (oppure: npm run test:intro)
 */

const Intro = require('../client/shared/stage-intro');

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

// ─── Nessun minigioco cablato ────────────────────────────────────────────────────

section('Ruota');

assert(
  Intro.getWheelSlices().every((s) => !s.filled),
  'senza configurazione la ruota non nomina nessun minigioco'
);

const GAMES = [
  { type: 'gioco_uno', label: 'Uno', icon: null },
  { type: 'gioco_due', label: 'Due', icon: null },
  { type: 'gioco_tre', label: 'Tre', icon: null },
];
Intro.setWheelConfig({ games: GAMES });
const slices = Intro.getWheelSlices();

assert(
  GAMES.every((g) => slices.some((s) => s.type === g.type)),
  'setWheelConfig: ogni minigioco del registry ha il suo spicchio'
);

for (const g of GAMES) {
  const slice = slices[Intro.getSliceIndexForType(g.type)];
  const landing = (Intro.computeWheelTargetRotation(g.type) + slice.centerDeg) % 360;
  const final = Intro.computeIntroStateAt(1, g.type);
  assert(
    landing === 0 && final.winningSliceIndex === slice.index,
    `la ruota si ferma sullo spicchio di "${g.type}"`
  );
}

// ─── Tempismo delle tende ────────────────────────────────────────────────────────

section('Tende');

const T = Intro.TIMELINE;

assert(
  Intro.computeIntroStateAt(T.curtainClose2End, 'gioco_due').curtainOpenAmount === 0,
  'tende chiuse quando la sala monta il minigioco sotto di loro'
);
assert(
  Intro.computeIntroStateAt(1, 'gioco_due').curtainOpenAmount === 1,
  'tende del tutto aperte a sipario finito'
);
assert(
  !Intro.computeIntroStateAt(1, 'gioco_due').wheelStageVisible,
  'a sipario finito la ruota non è più in scena: si vede il minigioco'
);

let monotone = true;
let prev = -1;
for (const key of Object.keys(T)) {
  if (T[key] < 0 || T[key] > 1) monotone = false;
}
for (const key of ['curtainClose1End', 'curtainOpen1End', 'wheelSpinEnd', 'wheelHoldEnd', 'curtainClose2End', 'curtainOpen2End']) {
  if (T[key] <= prev) monotone = false;
  prev = T[key];
}
assert(monotone, 'gli atti si susseguono in ordine dentro [0, 1]');

// ─── Riepilogo ───────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passati, ${failed} falliti\n`);
process.exitCode = failed > 0 ? 1 : 0;
