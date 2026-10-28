'use strict';

/**
 * tools/test-mg-cup-game.js
 *
 * Test standalone del minigioco "Tre Bicchieri" (cup_game):
 *   - validazione formale del contratto server tramite `validateDefinition`
 *   - verifica deterministica di `machineChoice` (0, 1, 2) e della matrice
 *     completa 3x3 di `outcomeFor` (vince solo la diagonale principale)
 *   - verifica dell'assenza di `correct_index` in `build()`
 *   - caricamento in Node senza DOM del modulo client `cup-game.js` e
 *     registrazione in `Minigames`
 *   - verifica esaustiva della logica pura di mescolamento (`generateSwapSequence`):
 *     per ogni posizione di partenza (0, 1, 2), ogni `machineChoice` (0, 1, 2)
 *     e diversi semi casuali, la pallina termina sempre in `machineChoice` e
 *     non compaiono mai due scambi identici consecutivi.
 *
 * Utilizzo (dalla radice del repository):
 *   node tools/test-mg-cup-game.js
 */

const registry = require('../server/minigames');
const def = require('../server/minigames/cup-game');

// ─── Setup ───────────────────────────────────────────────────────────────────

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

function seededRnd(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

// ─── 1. Contratto lato server ────────────────────────────────────────────────

section('Contratto lato server (server/minigames/cup-game.js)');

assert(
  (() => {
    try {
      registry.validateDefinition(def, 'cup-game.js', 'cup_game');
      return true;
    } catch (err) {
      console.error('     Errore validateDefinition:', err.message);
      return false;
    }
  })(),
  'validateDefinition(def, "cup-game.js", "cup_game") passa senza errori'
);

assert(def.type === 'cup_game', 'type è "cup_game"');
assert(def.label === 'Tre Bicchieri', 'label è "Tre Bicchieri"');
assert(def.defaultTimeLimitS === 6, 'defaultTimeLimitS è 6: la scelta di ogni livello');
assert(def.previewMs === 12000, 'previewMs è 12000: prima si seguono i bicchieri, poi si sceglie');
assert(def.revealMs === 4000, 'revealMs è 4000: dopo la chiusura resta solo l\'alzata');
assert(
  Array.isArray(def.options) &&
    def.options.length === 3 &&
    def.options[0] === 'Sinistra' &&
    def.options[1] === 'Centro' &&
    def.options[2] === 'Destra',
  'options è ["Sinistra", "Centro", "Destra"]'
);
assert(
  def.points &&
    def.points.win === 400 &&
    def.points.lose === 0 &&
    !('draw' in def.points),
  'points vale { win: 400, lose: 0 } per livello senza esito intermedio'
);

{
  const round = def.build();
  assert(round.kind === 'minigame', 'build() restituisce kind: "minigame"');
  assert(round.minigameType === 'cup_game', 'build() restituisce minigameType: "cup_game"');
  assert(!('correct_index' in round), 'build() NON contiene correct_index');
}

// ─── 2. Matrice 3x3 di resolve() e outcomeFor() ─────────────────────────────

section('Risoluzione deterministica e tabella 3x3 outcomeFor');

{
  const seeds = [
    { rndVal: 0.0, expectedChoice: 0 },
    { rndVal: 0.5, expectedChoice: 1 },
    { rndVal: 0.999999, expectedChoice: 2 },
  ];

  for (const { rndVal, expectedChoice } of seeds) {
    const res = def.resolve(() => rndVal);
    assert(
      res.machineChoice === expectedChoice,
      `resolve(() => ${rndVal}) produce machineChoice = ${expectedChoice}`
    );

    for (let playerChoice = 0; playerChoice < 3; playerChoice++) {
      const expectedOutcome = playerChoice === expectedChoice ? 'win' : 'lose';
      const actualOutcome = res.outcomeFor(playerChoice);
      assert(
        actualOutcome === expectedOutcome,
        `machineChoice=${expectedChoice}, playerChoice=${playerChoice} -> outcomeFor="${actualOutcome}" (atteso "${expectedOutcome}")`
      );
    }
  }
}

// ─── 3. Contratto lato client (caricato in Node senza DOM) ───────────────────

section('Contratto lato client in Node senza DOM (client/shared/minigames/cup-game.js)');

const Minigames = require('../client/shared/minigames');
require('../client/shared/minigames/cup-game');

assert(Minigames.has('cup_game'), 'cup-game.js si autoregistra in Minigames senza bisogno del DOM');

const clientDef = Minigames.get('cup_game');
assert(clientDef.type === 'cup_game', 'presentazione client ha type "cup_game"');
assert(clientDef.label === 'Tre Bicchieri', 'presentazione client ha label "Tre Bicchieri"');
assert(
  clientDef.playerLayoutClass === 'mg-cup-game-choices',
  'playerLayoutClass è "mg-cup-game-choices"'
);
assert(typeof clientDef.optionIcon === 'function', 'espone optionIcon(i)');
assert(typeof clientDef.sala.startSuspense === 'function', 'espone sala.startSuspense');
assert(typeof clientDef.sala.stopSuspense === 'function', 'espone sala.stopSuspense');
assert(typeof clientDef.sala.playReveal === 'function', 'espone sala.playReveal');
assert(typeof clientDef.sala.reveal === 'function', 'espone sala.reveal');
assert(typeof clientDef.player.renderChoice === 'function', 'espone player.renderChoice');
assert(typeof clientDef.player.playReveal === 'function', 'espone player.playReveal');
assert(typeof clientDef.player.reveal === 'function', 'espone player.reveal');

// Verifica che stopSuspense sia idempotente anche in assenza di DOM.
assert(
  (() => {
    clientDef.sala.stopSuspense();
    clientDef.sala.stopSuspense();
    return true;
  })(),
  'sala.stopSuspense() è idempotente e sicura fuori dal browser'
);

// ─── 4. Logica pura del mescolamento (generateSwapSequence) ──────────────────

section('Logica pura del mescolamento (generateSwapSequence)');

assert(
  typeof clientDef.generateSwapSequence === 'function',
  'il modulo client espone la funzione pura generateSwapSequence'
);

/**
 * Simula da zero una sequenza di scambi partendo da `startPos` e restituisce
 * la posizione finale della pallina e se esistono scambi consecutivi identici.
 */
function verifySwapSequence(swaps, startPos) {
  let pos = startPos;
  let hasConsecutiveDuplicate = false;
  let validPairs = true;

  for (let i = 0; i < swaps.length; i++) {
    const s = swaps[i];
    if (
      !Number.isInteger(s.a) ||
      !Number.isInteger(s.b) ||
      s.a < 0 ||
      s.b > 2 ||
      s.a >= s.b
    ) {
      validPairs = false;
    }
    if (i > 0) {
      const prev = swaps[i - 1];
      if (prev.a === s.a && prev.b === s.b) {
        hasConsecutiveDuplicate = true;
      }
    }
    if (pos === s.a) pos = s.b;
    else if (pos === s.b) pos = s.a;
  }

  return { finalPos: pos, hasConsecutiveDuplicate, validPairs };
}

{
  const rndStreams = [
    seededRnd([0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]),
    seededRnd([0.95, 0.05, 0.85, 0.15, 0.75, 0.25, 0.65, 0.35]),
    seededRnd([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
    seededRnd([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
    seededRnd([0.999, 0.999, 0.999, 0.999, 0.999, 0.999]),
  ];

  for (let startPos = 0; startPos < 3; startPos++) {
    for (let machineChoice = 0; machineChoice < 3; machineChoice++) {
      let allEndedAtTarget = true;
      let anyDuplicate = false;
      let allValid = true;

      for (let sIdx = 0; sIdx < rndStreams.length; sIdx++) {
        for (const count of [7, 8, 9]) {
          const seq = clientDef.generateSwapSequence(
            startPos,
            machineChoice,
            count,
            rndStreams[sIdx]
          );
          const check = verifySwapSequence(seq, startPos);
          if (seq.length !== count || !check.validPairs) allValid = false;
          if (check.finalPos !== machineChoice) allEndedAtTarget = false;
          if (check.hasConsecutiveDuplicate) anyDuplicate = true;
        }
      }

      assert(
        allValid && allEndedAtTarget && !anyDuplicate,
        `partenza=${startPos} -> machineChoice=${machineChoice}: finisce sempre in ${machineChoice} senza due scambi identici di fila`
      );
    }
  }
}

// ─── Riepilogo ───────────────────────────────────────────────────────────────

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Risultato: ${passed} passati, ${failed} falliti`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

process.exitCode = failed === 0 ? 0 : 1;
