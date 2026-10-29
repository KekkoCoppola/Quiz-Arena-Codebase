'use strict';

/**
 * tools/test-audio.js
 *
 * Smoke test isolato per client/sala/audio-logic.js.
 * Testa le decisioni pure del comparto audio SENZA DOM/Web Audio.
 *
 * Utilizzo: node tools/test-audio.js
 */

const {
  CHANNEL_VOLUME,
  MUSIC_DUCK_FACTOR,
  TENSION_FINAL_S,
  pickVariant,
  isStale,
  tensionPlan,
  resolveGain,
  validateManifest,
  minigameSfxKey,
  minigameManifest,
} = require('../client/sala/audio-logic');

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

// ─── pickVariant ─────────────────────────────────────────────────────────────────

section('pickVariant — rotazione varianti');

assert(pickVariant(0, -1, () => 0) === -1, 'nessuna variante → -1');
assert(pickVariant(1, 0, () => 0) === 0, 'una sola variante → sempre 0, anche se già usata');
assert(pickVariant(3, -1, () => 0) === 0, 'prima estrazione senza precedente');

{
  // Con 3 varianti e lastIndex=1, lo spazio di scelta è [0, 2].
  const first  = pickVariant(3, 1, () => 0);
  const second = pickVariant(3, 1, () => 0.99);
  assert(first === 0,  'esclude la precedente: rnd=0 → 0');
  assert(second === 2, 'esclude la precedente: rnd=0.99 → 2');
}

{
  let everRepeated = false;
  let last = -1;
  for (let i = 0; i < 200; i++) {
    const next = pickVariant(4, last, Math.random);
    if (next === last) everRepeated = true;
    last = next;
  }
  assert(!everRepeated, 'su 200 estrazioni non ripete mai la precedente');
}

{
  // Senza precedente (lastIndex=-1) l'ultimo indice deve restare raggiungibile:
  // un rnd vicino al top del range deve poter restituire count-1.
  const last = pickVariant(4, -1, () => 0.99);
  assert(last === 3, 'nessuna precedente: rnd=0.99 raggiunge l’ultimo indice');
}

{
  // Copertura completa: senza precedente, l'intero range [0, count-1] deve
  // essere raggiungibile facendo scorrere rnd sull'intero intervallo.
  const count = 4;
  const reached = new Set();
  for (let i = 0; i < count; i++) {
    reached.add(pickVariant(count, -1, () => i / count));
  }
  assert(reached.size === count, 'nessuna precedente: tutti gli indici sono raggiungibili');
}

// ─── isStale ─────────────────────────────────────────────────────────────────────

section('isStale — scadenza battute vocali');

assert(isStale(3, 4) === true,  'token diverso → scaduta');
assert(isStale(4, 4) === false, 'stesso token → valida');

// ─── tensionPlan ─────────────────────────────────────────────────────────────────

section('tensionPlan — sincronia del crescendo col countdown');

{
  const now = 1_000_000;
  const plan = tensionPlan({ endsAt: now + 120_000, now, finalDurationS: TENSION_FINAL_S });
  assert(plan.useLoop === true,       '120s: usa il loop di tensione');
  assert(plan.finalDelayMs === 110_000, '120s: il crescendo parte a T-10');
  assert(plan.finalSeekS === 0,       '120s: crescendo dall’inizio');
  assert(plan.skip === false,         '120s: non salta');
}

{
  const now = 1_000_000;
  const plan = tensionPlan({ endsAt: now + 20_000, now, finalDurationS: TENSION_FINAL_S });
  assert(plan.useLoop === true,        '20s: usa il loop');
  assert(plan.finalDelayMs === 10_000, '20s: crescendo a T-10');
  assert(plan.finalSeekS === 0,        '20s: crescendo dall’inizio');
}

{
  const now = 1_000_000;
  const plan = tensionPlan({ endsAt: now + 10_000, now, finalDurationS: TENSION_FINAL_S });
  assert(plan.useLoop === false,   '10s: nessun loop, solo crescendo');
  assert(plan.finalDelayMs === 0,  '10s: crescendo immediato');
  assert(plan.finalSeekS === 0,    '10s: crescendo dall’inizio');
}

{
  const now = 1_000_000;
  const plan = tensionPlan({ endsAt: now + 5_000, now, finalDurationS: TENSION_FINAL_S });
  assert(plan.useLoop === false,  '5s: nessun loop');
  assert(plan.finalDelayMs === 0, '5s: crescendo immediato');
  assert(plan.finalSeekS === 5,   '5s: entra a metà crescendo per atterrare sullo zero');
}

{
  const now = 1_000_000;
  const plan = tensionPlan({ endsAt: now - 1, now, finalDurationS: TENSION_FINAL_S });
  assert(plan.skip === true, 'countdown già scaduto → non suona nulla');
}

// ─── resolveGain ─────────────────────────────────────────────────────────────────

section('resolveGain — volume effettivo');

assert(
  resolveGain({ channel: 'music', assetGain: 1, muted: false, ducked: false }) === CHANNEL_VOLUME.music,
  'musica non duckata → volume di canale'
);
assert(
  Math.abs(
    resolveGain({ channel: 'music', assetGain: 1, muted: false, ducked: true })
    - CHANNEL_VOLUME.music * MUSIC_DUCK_FACTOR
  ) < 1e-9,
  'musica duckata → volume di canale × fattore duck'
);
assert(
  resolveGain({ channel: 'vo', assetGain: 1, muted: false, ducked: true }) === CHANNEL_VOLUME.vo,
  'il duck non tocca la voce'
);
assert(
  resolveGain({ channel: 'music', assetGain: 1, muted: true, ducked: false }) === 0,
  'muted → 0 su qualunque canale'
);
assert(
  Math.abs(resolveGain({ channel: 'sfx', assetGain: 0.5, muted: false, ducked: false })
    - CHANNEL_VOLUME.sfx * 0.5) < 1e-9,
  'il gain per-asset moltiplica quello di canale'
);
assert(
  resolveGain({ channel: 'sfx', assetGain: 99, muted: false, ducked: false }) <= 1,
  'il risultato è sempre ≤ 1 (HTMLAudioElement.volume non accetta più)'
);

// ─── validateManifest ────────────────────────────────────────────────────────────

section('validateManifest — tollera qualunque input');

{
  const m = validateManifest(null);
  assert(m.errors.length > 0, 'null → errore segnalato');
  assert(Object.keys(m.vo).length === 0, 'null → catalogo vuoto, non esplode');
}

{
  const m = validateManifest({ music: {}, vo: {}, sfx: {} });
  assert(m.errors.length === 0, 'manifest vuoto è valido');
}

{
  const m = validateManifest({
    music: { bed: { file: 'music/bed.ogg', gain: 1 } },
    vo:    { 'lobby-qr': [{ file: 'vo/a.mp3' }] },
    sfx:   { 'player-joined': [{ file: 'sfx/j.mp3', gain: 0.5 }] },
  });
  assert(m.music.bed.file === 'music/bed.ogg', 'musica normalizzata');
  assert(m.vo['lobby-qr'].length === 1,        'voce normalizzata in array');
  assert(m.vo['lobby-qr'][0].gain === 1,       'gain assente → default 1');
  assert(m.sfx['player-joined'][0].gain === 0.5, 'gain esplicito preservato');
  assert(m.errors.length === 0,                 'nessun errore');
}

{
  // Un evento singolo (non array) va accettato e avvolto: è l'errore di scrittura
  // manuale più probabile nel manifest.
  const m = validateManifest({ vo: { 'via': { file: 'vo/via.mp3' } } });
  assert(Array.isArray(m.vo.via),   'oggetto singolo avvolto in array');
  assert(m.vo.via[0].file === 'vo/via.mp3', 'file preservato nell’avvolgimento');
}

{
  const m = validateManifest({ vo: { rotto: [{ gain: 1 }] } });
  assert(m.vo.rotto === undefined, 'voce senza "file" scartata');
  assert(m.errors.length > 0,      'voce senza "file" segnalata');
}

// ─── Audio dei minigiochi ────────────────────────────────────────────────────────

section('minigameManifest — l\'audio di un minigioco nel suo spazio dei nomi');

{
  const m = validateManifest(minigameManifest('cup_game', {
    music: { file: 'cup-game/music.ogg', gain: 0.9 },
    sfx: { swap: [{ file: 'cup-game/swap-01.wav' }], ball: { file: 'cup-game/ball-01.wav' } },
  }));
  assert(m.music.cup_game.file === 'cup-game/music.ogg', 'la colonna sonora prende il nome del tipo');
  assert(m.sfx['cup_game/swap'].length === 1,           'gli effetti stanno sotto <tipo>/<evento>');
  assert(Array.isArray(m.sfx['cup_game/ball']),          'un effetto singolo viene avvolto come nel manifest');
  assert(m.sfx.swap === undefined,                       'un effetto di minigioco non occupa il nome nudo della sala');
  assert(m.errors.length === 0,                          'nessun errore');
}

{
  assert(minigameSfxKey('morra_cinese', 'tick') === 'morra_cinese/tick', 'chiave di un effetto: <tipo>/<evento>');
  const empty = validateManifest(minigameManifest('morra_cinese', null));
  assert(Object.keys(empty.music).length === 0 && Object.keys(empty.sfx).length === 0,
    'un minigioco senza audio non aggiunge nulla al catalogo');
  const broken = validateManifest(minigameManifest('x', { sfx: { rotto: [{ gain: 1 }] } }));
  assert(broken.sfx['x/rotto'] === undefined && broken.errors.length > 0,
    'una voce rotta di un minigioco si scarta e si segnala, come nel manifest');
}

// ─── Esito ───────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  Passati: ${passed}   Falliti: ${failed}`);
console.log(`${'─'.repeat(50)}\n`);

process.exitCode = failed > 0 ? 1 : 0;
