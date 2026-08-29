#!/usr/bin/env node
'use strict';

/**
 * tools/test-image.js
 *
 * Smoke test di client/shared/image-budget.js — le decisioni pure del
 * comparto immagini: quali dimensioni target, quale qualità provare dopo,
 * com'è fatto un hash valido.
 *
 * Puro: nessun DOM, nessuna rete, nessun DB. La pipeline canvas vera
 * (createImageBitmap/toBlob) richiede un browser e non è coperta qui —
 * stesso confine fra audio-logic.js e audio.js.
 */

const path = require('node:path');

const ImageBudget = require(path.join(__dirname, '..', 'client', 'shared', 'image-budget'));

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

function assertThrows(fn, label) {
  try {
    fn();
    console.error(`  ❌  ${label} (nessuna eccezione lanciata)`);
    failed++;
  } catch {
    console.log(`  ✅  ${label}`);
    passed++;
  }
}

// ─── targetDimensions ────────────────────────────────────────────────────────

console.log('\n── image-budget: dimensioni target ──\n');

const orizzontale = ImageBudget.targetDimensions(1920, 1080);
assert(orizzontale.width === 1280 && orizzontale.height === 720, '1920x1080 → 1280x720');

const verticale = ImageBudget.targetDimensions(1080, 1920);
assert(verticale.width === 720 && verticale.height === 1280, '1080x1920 → 720x1280 (il verticale non viene ruotato né ritagliato)');

const quadrata = ImageBudget.targetDimensions(2000, 2000);
assert(quadrata.width === 1280 && quadrata.height === 1280, '2000x2000 → 1280x1280');

const piccola = ImageBudget.targetDimensions(640, 480);
assert(piccola.width === 640 && piccola.height === 480, "640x480 resta 640x480: un'immagine piccola non va ingrandita");

const alLimite = ImageBudget.targetDimensions(1280, 800);
assert(alLimite.width === 1280 && alLimite.height === 800, '1280x800 resta invariata (esattamente al limite)');

const panoramica = ImageBudget.targetDimensions(3000, 1000);
assert(panoramica.width === 1280 && panoramica.height === 427, "3000x1000 → 1280x427 (arrotondamento all'intero)");

const custom = ImageBudget.targetDimensions(1000, 500, 400);
assert(custom.width === 400 && custom.height === 200, 'maxLongSide esplicito rispettato');

assertThrows(() => ImageBudget.targetDimensions(0, 100), 'larghezza 0 rifiutata');
assertThrows(() => ImageBudget.targetDimensions(100, -5), 'altezza negativa rifiutata');
assertThrows(() => ImageBudget.targetDimensions('100', 100), 'larghezza non numerica rifiutata');

// ─── nextQuality ─────────────────────────────────────────────────────────────

console.log('\n── image-budget: scala di qualità ──\n');

assert(ImageBudget.QUALITY_LADDER[0] === 0.80, 'la scala parte da 0.80');
assert(ImageBudget.nextQuality(0.80) === 0.72, '0.80 → 0.72');
assert(ImageBudget.nextQuality(0.72) === 0.65, '0.72 → 0.65');
assert(ImageBudget.nextQuality(0.65) === 0.58, '0.65 → 0.58');
assert(ImageBudget.nextQuality(0.58) === null, '0.58 è il pavimento: sotto non si scende');
assert(ImageBudget.nextQuality(1) === 0.80, 'un valore sopra la scala entra dal primo gradino');
assert(ImageBudget.nextQuality(0.30) === null, 'un valore sotto il pavimento non risale');

// ─── isValidHash ─────────────────────────────────────────────────────────────

console.log("\n── image-budget: forma dell'hash ──\n");

const valido = 'a'.repeat(64);
assert(ImageBudget.isValidHash(valido) === true, '64 caratteri esadecimali minuscoli accettati');
assert(ImageBudget.isValidHash('a'.repeat(63)) === false, '63 caratteri rifiutati');
assert(ImageBudget.isValidHash('a'.repeat(65)) === false, '65 caratteri rifiutati');
assert(ImageBudget.isValidHash('A'.repeat(64)) === false, 'maiuscole rifiutate (una sola forma canonica)');
assert(ImageBudget.isValidHash('g'.repeat(64)) === false, 'caratteri non esadecimali rifiutati');
assert(ImageBudget.isValidHash('../../etc/passwd') === false, 'un percorso non è un hash');
assert(ImageBudget.isValidHash(null) === false, 'null rifiutato');
assert(ImageBudget.isValidHash(undefined) === false, 'undefined rifiutato');
assert(ImageBudget.isValidHash(12345) === false, 'un numero rifiutato');

// ─── Limiti ──────────────────────────────────────────────────────────────────

console.log('\n── image-budget: limiti dichiarati ──\n');

assert(ImageBudget.MAX_LONG_SIDE === 1280, 'lato lungo massimo: 1280 px');
assert(ImageBudget.MAX_BYTES === 153600, 'tetto per immagine: 153.600 byte');
assert(ImageBudget.MAX_INPUT_BYTES === 26214400, 'input accettato: 26.214.400 byte');

// ─── Referto ─────────────────────────────────────────────────────────────────

console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passati, ${failed} falliti\n`);
process.exitCode = failed === 0 ? 0 : 1;
