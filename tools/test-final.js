'use strict';

/**
 * tools/test-final.js
 *
 * Smoke test isolato per client/shared/final-schedule.js.
 * Testa il calendario della premiazione SENZA DOM, timer o socket.
 *
 * I casi che contano sono quelli che non si incontrano mai provando in due sul
 * portatile — tre giocatori, due, uno, venticinque — e che si scoprirebbero
 * davanti a una sala piena. Più le invarianti anti-spoiler, che sono il motivo
 * per cui questo modulo esiste.
 *
 * Utilizzo: node tools/test-final.js
 */

const {
  GAP_SLOW,
  TAIL_BUDGET_MS,
  UNCOVER_DELAY_MS,
  buildFinalSchedule,
  stepsForRank,
  revealAtForRank,
} = require('../client/shared/final-schedule');

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

/** Gli istanti degli atti di un dato tipo, in ordine di calendario. */
const atsOf = (schedule, kind) =>
  schedule.steps.filter((s) => s.kind === kind).map((s) => s.at);

/** Il primo atto di un dato tipo, o null. */
const firstOf = (schedule, kind) =>
  schedule.steps.find((s) => s.kind === kind) ?? null;

// ─── Forma generale ──────────────────────────────────────────────────────────────

section('Forma del calendario');

{
  const s = buildFinalSchedule({ playerCount: 10 });
  const ats = s.steps.map((x) => x.at);
  const ordered = ats.every((at, i) => i === 0 || at >= ats[i - 1]);
  assert(ordered, 'gli istanti non tornano mai indietro');
  assert(ats.every((at) => Number.isInteger(at)), 'ogni istante è un intero di millisecondi');
  assert(s.totalMs >= ats[ats.length - 1], 'totalMs copre l\'ultimo atto');
  assert(firstOf(s, 'settle') !== null, 'la cerimonia si chiude con un fotogramma finale');
}

// ─── Ritardando della coda ───────────────────────────────────────────────────────

section('Coda in ritardando');

{
  const s = buildFinalSchedule({ playerCount: 10 });
  const tail = s.steps.filter((x) => x.kind === 'tail');

  assert(tail.length === 7, '10 giocatori → 7 posizioni in coda (dal 10° al 4°)');
  assert(
    tail.map((x) => x.rank).join(',') === '10,9,8,7,6,5,4',
    'la coda si scopre dall\'ultimo verso il podio',
  );

  // Le pause fra una riga e l'altra devono crescere: è tutta la drammaturgia.
  const gaps = tail.slice(1).map((x, i) => x.at - tail[i].at);
  const growing = gaps.every((g, i) => i === 0 || g > gaps[i - 1]);
  assert(growing, 'ogni pausa è più lunga della precedente (rallenta verso il podio)');
  assert(gaps[0] < 800, 'la coda parte svelta');
}

{
  // Il tetto esiste perché il ritardando puro, con molti giocatori, darebbe un
  // preambolo da ventitré secondi.
  const s = buildFinalSchedule({ playerCount: 25 });
  const tail = s.steps.filter((x) => x.kind === 'tail');
  const exit = firstOf(s, 'tail-exit');

  assert(tail.length === 22, '25 giocatori → 22 posizioni in coda');
  assert(exit.at <= TAIL_BUDGET_MS, `la coda sta nel tetto di ${TAIL_BUDGET_MS} ms (${exit.at} ms)`);

  const gaps = tail.slice(1).map((x, i) => x.at - tail[i].at);
  const nonDecreasing = gaps.every((g, i) => i === 0 || g >= gaps[i - 1]);
  assert(nonDecreasing, 'compressa nel tetto, la coda conserva la forma del rallentamento');
}

{
  const s = buildFinalSchedule({ playerCount: 4 });
  const tail = s.steps.filter((x) => x.kind === 'tail');
  const exit = firstOf(s, 'tail-exit');
  assert(tail.length === 1, '4 giocatori → una sola riga in coda');
  assert(exit.at === GAP_SLOW, 'con una riga sola, quella riga si prende la pausa lunga');
}

// ─── Partite piccole ─────────────────────────────────────────────────────────────

section('Partite piccole');

{
  const s = buildFinalSchedule({ playerCount: 3 });
  assert(atsOf(s, 'tail').length === 0, '3 giocatori → nessuna coda');
  assert(firstOf(s, 'tail-exit') === null, '3 giocatori → nessuna uscita di coda da animare');
  assert(firstOf(s, 'podium-3') !== null, '3 giocatori → il bronzo c\'è');
  assert(firstOf(s, 'winner') !== null, '3 giocatori → si proclama comunque');
}

{
  const s = buildFinalSchedule({ playerCount: 2 });
  assert(firstOf(s, 'podium-3') === null, '2 giocatori → niente bronzo');
  assert(firstOf(s, 'podium-2-covered') !== null, '2 giocatori → l\'argento resta coperto');
  assert(firstOf(s, 'uncover-2') !== null, '2 giocatori → e si scopre dopo il vincitore');
}

{
  const s = buildFinalSchedule({ playerCount: 1 });
  assert(firstOf(s, 'podium-3') === null, '1 giocatore → niente bronzo');
  assert(firstOf(s, 'podium-2-covered') === null, '1 giocatore → niente argento');
  assert(firstOf(s, 'suspense') === null, '1 giocatore → nessuna sospensione da reggere');
  assert(firstOf(s, 'winner') !== null, '1 giocatore → viene comunque proclamato');
  assert(firstOf(s, 'winner').at > 0, 'e non esplode nell\'istante zero: la scena ha un respiro');
}

{
  const s = buildFinalSchedule({ playerCount: 0 });
  assert(s.steps.length === 0, '0 giocatori → nessun atto, nessun timer da avviare');
  assert(s.totalMs === 0, '0 giocatori → durata nulla');
}

{
  // Il calendario non deve poter esplodere su un input sporco: arriva da una
  // lunghezza di array, ma un giorno potrebbe arrivare da altro.
  const bad = [undefined, null, NaN, -3, 'sette', {}];
  const survives = bad.every((v) => buildFinalSchedule({ playerCount: v }).steps.length === 0);
  assert(survives, 'un conteggio non valido produce un calendario vuoto, non un\'eccezione');
  assert(buildFinalSchedule().steps.length === 0, 'chiamata senza argomenti: nessun atto');
}

// ─── Invarianti anti-spoiler ─────────────────────────────────────────────────────
//
// Sono il motivo per cui questo modulo esiste come pezzo separato e testato:
// se cadono, la premiazione si rovina davanti a tutti e non c'è modo di
// accorgersene rileggendo il codice.

section('Anti-spoiler');

for (const n of [2, 3, 4, 10, 25]) {
  const s = buildFinalSchedule({ playerCount: n });
  const winner = firstOf(s, 'winner');
  const uncover = firstOf(s, 'uncover-2');

  assert(
    uncover.at === winner.at + UNCOVER_DELAY_MS,
    `${n} giocatori: il secondo si scopre DOPO il vincitore, mai prima`,
  );
  assert(
    revealAtForRank(s, 2) > revealAtForRank(s, 1),
    `${n} giocatori: il 2° non è deducibile prima della proclamazione`,
  );
}

{
  const s = buildFinalSchedule({ playerCount: 10 });

  // Il telefono del secondo riceve atti PRIMA di scoprirsi (il gradino coperto,
  // la sospensione): è voluto, deve stare in tensione quanto la sala. Ciò che
  // non deve accadere è che uno di quegli atti lo riveli.
  const mine2 = stepsForRank(s, 2);
  const revealing2 = mine2.filter((x) => x.kind === 'uncover-2');
  assert(revealing2.length === 1, 'il 2° ha un solo atto che lo rivela');
  // Gli atti che mettono un nome su uno schermo. Tutto il resto è scenografia.
  const REVEALING = ['tail', 'podium-3', 'winner', 'uncover-2'];
  const beforeUncover = mine2.filter((x) => x.at < revealing2[0].at);
  assert(
    beforeUncover.every((x) => !REVEALING.includes(x.kind)),
    'prima della scopertura al 2° arrivano solo atti che NON lo rivelano',
  );
  assert(
    mine2.some((x) => x.kind === 'podium-2-covered') && mine2.some((x) => x.kind === 'suspense'),
    'il 2° resta in sospeso quanto la sala, col gradino coperto',
  );

  // Il vincitore non deve avere nulla addosso prima della proclamazione: se il
  // suo telefono si accendesse durante la sospensione, la sala lo leggerebbe
  // sulla sua faccia.
  const mine1 = stepsForRank(s, 1);
  const firstOwn = mine1.find((x) => x.kind !== 'tail-exit');
  assert(firstOwn.kind === 'winner', 'al vincitore non arriva nulla prima della proclamazione');

  // Un giocatore in coda vede la propria riga e non quelle degli altri.
  const mine7 = stepsForRank(s, 7);
  const tails7 = mine7.filter((x) => x.kind === 'tail');
  assert(tails7.length === 1 && tails7[0].rank === 7, 'chi è 7° vede solo la propria riga');
  assert(
    revealAtForRank(s, 7) < revealAtForRank(s, 4),
    'in coda ci si scopre dall\'ultimo in su',
  );
  assert(
    mine7.some((x) => x.kind === 'settle'),
    'a tutti arriva il fotogramma finale, qualunque sia la posizione',
  );
}

{
  // Il 3° si scopre per intero, e prima dei due sopra di lui.
  const s = buildFinalSchedule({ playerCount: 10 });
  assert(
    revealAtForRank(s, 3) < revealAtForRank(s, 1),
    'il bronzo si scopre prima della proclamazione',
  );
  assert(
    revealAtForRank(s, 4) < revealAtForRank(s, 3),
    'e comunque dopo l\'ultima riga della coda',
  );
}

// ─── Esito ───────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passati, ${failed} falliti`);
if (failed > 0) process.exitCode = 1;
