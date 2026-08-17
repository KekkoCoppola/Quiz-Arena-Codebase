'use strict';

/**
 * tools/test-db.js
 *
 * Smoke test isolato per server/quiz-manager.js.
 * Testa il layer dati SENZA Express — eseguibile subito dopo Step 2.
 *
 * Utilizzo: node tools/test-db.js
 * (Non committato — escluso da .gitignore)
 */

require('dotenv').config();

const path = require('node:path');
const fs   = require('node:fs');
const {
  initDb,
  closeDb,
  createUser,
  getUserByUsername,
  getUserById,
  getQuizzesByUser,
  createQuiz,
  updateQuiz,
  deleteQuiz,
  QuizLimitError,
  NotFoundError,
  DuplicateUsernameError,
  MAX_QUIZZES_PER_USER,
} = require('../server/quiz-manager');

// ─── Setup ───────────────────────────────────────────────────────────────────────

const TEST_DB_PATH = './server/db/test_smoke.sqlite';

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

function assertThrows(fn, ErrorClass, label) {
  try {
    fn();
    console.error(`  ❌  ${label} (nessuna eccezione lanciata)`);
    failed++;
  } catch (err) {
    if (err instanceof ErrorClass) {
      console.log(`  ✅  ${label}`);
      passed++;
    } else {
      console.error(`  ❌  ${label} (errore inatteso: ${err.constructor.name}: ${err.message})`);
      failed++;
    }
  }
}

// ─── Test ────────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🧪  Quiz-Zata! — Smoke Test: quiz-manager.js');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Pulizia file test precedente
  const resolvedPath = path.resolve(TEST_DB_PATH);
  if (fs.existsSync(resolvedPath)) fs.unlinkSync(resolvedPath);

  // 1. Init
  console.log('  📦  Fase 1: Inizializzazione DB');
  initDb(TEST_DB_PATH);
  assert(fs.existsSync(resolvedPath), 'Il file database viene creato');

  // 2. Creazione utenti
  console.log('\n  👤  Fase 2: Utenti');
  const user = createUser('testhost', '$2a$10$FAKEHASH'); // hash fittizio per il test
  assert(user && user.id > 0, 'createUser: restituisce un utente con ID');
  assert(user.username === 'testhost', 'createUser: username corretto');

  assertThrows(
    () => createUser('testhost', '$2a$10$FAKEHASH'),
    DuplicateUsernameError,
    'createUser: lancia DuplicateUsernameError per username duplicato'
  );

  const found = getUserByUsername('testhost');
  assert(found !== null, 'getUserByUsername: trova l\'utente');
  assert(found.password !== undefined, 'getUserByUsername: include il campo password');

  const notFound = getUserByUsername('chiesonononesiste');
  assert(notFound === null, 'getUserByUsername: restituisce null se non trovato');

  const byId = getUserById(user.id);
  assert(byId !== null, 'getUserById: trova l\'utente');
  assert(byId.password === undefined, 'getUserById: NON include il campo password');

  // 3. CRUD Quiz
  console.log('\n  📋  Fase 3: Quiz CRUD');
  const q1 = createQuiz(user.id, 'Quiz Uno', [
    { text: 'Domanda 1', options: ['A', 'B', 'C', 'D'], correct_index: 0, time_limit_s: 30 },
  ]);
  assert(q1 && q1.id > 0, 'createQuiz: restituisce quiz con ID');
  assert(Array.isArray(q1.questions), 'createQuiz: questions è un array JS (deserializzato)');

  const q2 = createQuiz(user.id, 'Quiz Due', [
    { text: 'Domanda 2', options: ['Sì', 'No'], correct_index: 1, time_limit_s: 15 },
  ]);
  assert(q2 && q2.id > 0, 'createQuiz: crea secondo quiz');

  const q3 = createQuiz(user.id, 'Quiz Tre', [
    { text: 'Domanda 3', options: ['X', 'Y', 'Z'], correct_index: 2, time_limit_s: 20 },
  ]);
  assert(q3 && q3.id > 0, 'createQuiz: crea terzo quiz');

  // 4. Limite quiz
  console.log('\n  🚧  Fase 4: Limite quiz');
  assertThrows(
    () => createQuiz(user.id, 'Quiz Quattro (oltre limite)', [
      { text: 'D', options: ['A', 'B'], correct_index: 0, time_limit_s: 10 },
    ]),
    QuizLimitError,
    `createQuiz: lancia QuizLimitError al ${MAX_QUIZZES_PER_USER + 1}° tentativo`
  );

  // 5. getQuizzesByUser
  console.log('\n  📂  Fase 5: Recupero quiz');
  const quizzes = getQuizzesByUser(user.id);
  assert(quizzes.length === 3, 'getQuizzesByUser: restituisce 3 quiz');

  // 6. Update
  console.log('\n  ✏️   Fase 6: Aggiornamento quiz');
  const updated = updateQuiz(q1.id, user.id, 'Quiz Uno Aggiornato', q1.questions);
  assert(updated.title === 'Quiz Uno Aggiornato', 'updateQuiz: titolo aggiornato');

  assertThrows(
    () => updateQuiz(9999, user.id, 'Titolo', []),
    NotFoundError,
    'updateQuiz: lancia NotFoundError per ID inesistente'
  );

  // 7. Delete
  console.log('\n  🗑️   Fase 7: Eliminazione quiz');
  deleteQuiz(q1.id, user.id);
  assert(getQuizzesByUser(user.id).length === 2, 'deleteQuiz: quiz rimosso correttamente');

  assertThrows(
    () => deleteQuiz(q1.id, user.id),
    NotFoundError,
    'deleteQuiz: lancia NotFoundError per quiz già eliminato'
  );

  assertThrows(
    () => deleteQuiz(q2.id, 9999),
    NotFoundError,
    'deleteQuiz: lancia NotFoundError per ownership errata'
  );

  // ─── Riepilogo ──────────────────────────────────────────────────────────────────

  // Chiude la connessione prima di eliminare il file (necessario su Windows)
  closeDb();
  if (fs.existsSync(resolvedPath)) fs.unlinkSync(resolvedPath);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Risultato: ${passed} passati, ${failed} falliti`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('\n  ❌  Errore inatteso durante il test:', err);
  process.exit(1);
});
