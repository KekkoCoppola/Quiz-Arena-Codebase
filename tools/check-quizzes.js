#!/usr/bin/env node
'use strict';

/**
 * tools/check-quizzes.js
 *
 * Controlla i quiz di sistema in `content/quizzes/` e stampa un referto.
 * **Non tocca il database**: si limita a leggere e validare.
 *
 * Sostituisce `tools/seed-preloaded.js`, che non serve più: i quiz non vanno
 * più "seminati": vivono nei file e il server riallinea il DB da solo ad ogni
 * avvio (vedi server/quiz-library.js).
 *
 * Questo attrezzo serve a una cosa sola, ma importante: **sapere prima di una
 * serata se un file ha un refuso**, invece di scoprirlo dai log di avvio o,
 * peggio, da una domanda che nessuno riesce a vincere.
 *
 * Utilizzo:
 *   node tools/check-quizzes.js
 *
 * Codice di uscita: 0 se tutti i quiz sono validi, 1 se almeno uno è escluso —
 * così è utilizzabile anche in uno script di deploy.
 */

const path = require('node:path');
const { loadQuizFiles, QUIZZES_DIR } = require(path.join(__dirname, '..', 'server', 'quiz-library'));

const { quizzes, errors, warnings } = loadQuizFiles();

console.log('');
console.log('🔍  Quiz di sistema — ' + path.relative(process.cwd(), QUIZZES_DIR));
console.log('');

for (const q of quizzes) {
  const domande = q.questions.length;
  const minigiochi = q.minigames.length;
  const extra = minigiochi > 0 ? `, ${minigiochi} minigioc${minigiochi === 1 ? 'o' : 'hi'}` : '';
  const conFoto = q.questions.filter((d) => d.image).length;
  const foto = conFoto > 0 ? `, ${conFoto} con foto` : '';
  console.log(`  ✅  ${q.slug.padEnd(28)} "${q.title}"  (${domande} domande${extra}${foto})`);
}

// Un'immagine che manca non esclude il quiz: la domanda si gioca come una
// domanda di testo. Va però detto, perché è la differenza fra "ho dimenticato
// di copiare il file" e "quella domanda non doveva avere una foto".
if (warnings.length > 0) {
  console.log('');
  for (const w of warnings) console.log(`  ⚠️   ${w}`);
}

if (errors.length > 0) {
  console.log('');
  for (const e of errors) console.log(`  ❌  ${e}`);
}

console.log('');
console.log('━'.repeat(60));
const avvisi = warnings.length > 0 ? `   Avvisi: ${warnings.length}` : '';
console.log(`  Validi: ${quizzes.length}   Esclusi: ${errors.length}${avvisi}`);
console.log('━'.repeat(60));
console.log('');

if (errors.length > 0) {
  console.log('  I quiz esclusi non compariranno nel menù dell\'host.');
  console.log('  Correggi i file e rilancia questo controllo.');
  console.log('');
}

process.exitCode = errors.length > 0 ? 1 : 0;
