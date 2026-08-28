'use strict';

/**
 * tools/test-clock.js
 *
 * Smoke test isolato per client/shared/server-clock.js.
 *
 * Verifica la sola cosa che conta: che una scadenza del server valga lo stesso
 * intervallo su qualunque orologio la si legga. È un difetto che non si vede
 * provando in locale — dove server e client hanno per forza la stessa ora — e
 * che salta fuori solo davanti a una sala, con i telefoni sull'ora della rete
 * cellulare e il Raspberry senza NTP.
 *
 * Utilizzo: node tools/test-clock.js
 */

const { localDeadline, remainingMs } = require('../client/shared/server-clock');

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

// ─── Correzione dello scarto ─────────────────────────────────────────────────────

section('Scarto fra orologi');

{
  const serverNow = 1_000_000;
  const endsAt = serverNow + 20_000;   // 20 secondi di domanda

  // Tre dispositivi con orologi molto diversi devono contare gli stessi 20s.
  const casi = [
    ['telefono in pari col server', 1_000_000],
    ['telefono avanti di 30 s',     1_030_000],
    ['telefono indietro di 45 s',     955_000],
    ['telefono avanti di un\'ora',  4_600_000],
  ];

  for (const [etichetta, oraLocale] of casi) {
    const scadenza = localDeadline(endsAt, serverNow, oraLocale);
    const restano = remainingMs(scadenza, oraLocale);
    assert(restano === 20_000, `${etichetta}: restano comunque 20 s`);
  }
}

{
  // È il caso che il progetto aveva davvero: senza correzione, un telefono
  // avanti di 4 s vede il tempo scaduto mentre in sala ne mancano ancora 4.
  const serverNow = 1_000_000;
  const endsAt = serverNow + 4_000;
  const oraLocale = 1_004_000;   // telefono avanti di 4 s

  const senzaCorrezione = Math.max(0, endsAt - oraLocale);
  const conCorrezione = remainingMs(localDeadline(endsAt, serverNow, oraLocale), oraLocale);

  assert(senzaCorrezione === 0, 'senza correzione il telefono è già scaduto (il difetto)');
  assert(conCorrezione === 4_000, 'con la correzione mancano ancora 4 s, come in sala');
}

// ─── Robustezza ──────────────────────────────────────────────────────────────────

section('Ingressi imperfetti');

{
  const endsAt = 5_000;
  assert(localDeadline(endsAt, undefined, 100) === endsAt,
    'senza serverNow si ripiega sulla scadenza grezza (client più vecchio del server)');
  assert(localDeadline(endsAt, null, 100) === endsAt, 'serverNow null: stesso ripiego');
  assert(localDeadline(undefined, 1, 100) === 100, 'senza scadenza si considera già scaduta');
  assert(remainingMs(undefined) === 0, 'scadenza assente → nessun tempo residuo');
}

{
  assert(remainingMs(1_000, 5_000) === 0, 'una scadenza passata non torna mai negativa');
  assert(remainingMs(5_000, 1_000) === 4_000, 'una scadenza futura conta i millisecondi giusti');
}

{
  // La latenza di rete resta fuori dalla correzione, ma nella direzione giusta:
  // il client riceve DOPO, quindi la sua scadenza cade dopo quella del server.
  const serverNow = 1_000_000;
  const endsAt = serverNow + 10_000;
  const latenzaMs = 40;
  const scadenza = localDeadline(endsAt, serverNow, serverNow + latenzaMs);
  assert(scadenza === endsAt + latenzaMs,
    'la latenza sposta la scadenza in avanti, mai indietro: il client non scade prima del server');
}

// ─── Esito ───────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passati, ${failed} falliti`);
if (failed > 0) process.exitCode = 1;
