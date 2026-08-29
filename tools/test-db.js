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
  getDb,
  closeDb,
  createUser,
  getUserByUsername,
  getUserById,
  getQuizzesByUser,
  createQuiz,
  updateQuiz,
  deleteQuiz,
  putImage,
  getImage,
  gcOrphanImages,
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

  // ─── Immagini ────────────────────────────────────────────────────────────────

  console.log('\n── quiz_images: stoccaggio indirizzato dal contenuto ──\n');

  const bytesA = Buffer.from('RIFF____WEBPfinta-immagine-A', 'ascii');
  const bytesB = Buffer.from('RIFF____WEBPfinta-immagine-B', 'ascii');

  const salvataA = putImage(bytesA, 'image/webp', 1280, 720);
  assert(typeof salvataA.hash === 'string' && salvataA.hash.length === 64, 'putImage restituisce un hash di 64 caratteri');
  assert(salvataA.width === 1280 && salvataA.height === 720, 'putImage restituisce le dimensioni ricevute');

  const riletta = getImage(salvataA.hash);
  assert(riletta !== null, 'getImage ritrova la riga appena scritta');
  assert(Buffer.from(riletta.bytes).equals(bytesA), 'i byte riletti sono identici a quelli scritti');
  assert(riletta.mime === 'image/webp', 'il mime viene conservato');
  assert(riletta.width === 1280 && riletta.height === 720, 'le dimensioni vengono conservate');

  assert(getImage('f'.repeat(64)) === null, 'getImage su un hash inesistente restituisce null');

  // Deduplicazione: gli stessi byte non creano una seconda riga.
  const conteggioImmagini = () =>
    getDb().prepare('SELECT COUNT(*) AS n FROM quiz_images').get().n;

  const salvataBis = putImage(bytesA, 'image/webp', 1280, 720);
  assert(salvataBis.hash === salvataA.hash, 'gli stessi byte producono lo stesso hash');
  assert(conteggioImmagini() === 1, 'gli stessi byte non duplicano la riga');

  // ─── Raccolta degli orfani ───────────────────────────────────────────────────

  console.log('\n── quiz_images: raccolta degli orfani ──\n');

  const salvataB = putImage(bytesB, 'image/webp', 800, 600);
  assert(conteggioImmagini() === 2, 'due immagini distinte, due righe');

  // Un quiz che referenzia SOLO la prima immagine.
  const utenteImg = createUser(`img_${Date.now()}`, 'hash-finto-non-usato-per-il-login');
  createQuiz(utenteImg.id, 'Quiz con immagine', [
    {
      text: 'Che animale è questo?',
      options: ['A', 'B'],
      correct_index: 0,
      time_limit_s: 20,
      image: { hash: salvataA.hash, blur: false },
    },
  ]);

  const eliminate = gcOrphanImages();
  assert(eliminate === 1, "la raccolta elimina esattamente l'immagine orfana");
  assert(getImage(salvataA.hash) !== null, "l'immagine referenziata da un quiz sopravvive");
  assert(getImage(salvataB.hash) === null, "l'immagine che nessuno referenzia sparisce");

  assert(gcOrphanImages() === 0, 'la raccolta è idempotente: la seconda passata non elimina nulla');

  // ─── Raccolta degli orfani: copre anche preloaded_quizzes ───────────────────

  console.log('\n── quiz_images: la raccolta scandisce anche preloaded_quizzes ──\n');

  const salvataC = putImage(Buffer.from('RIFF____WEBPfinta-immagine-C', 'ascii'), 'image/webp', 640, 480);
  assert(conteggioImmagini() === 2, 'immagine C salvata (A sopravvissuta sopra, ora anche C)');

  // Nessuna funzione pubblica scrive in preloaded_quizzes (la tabella è
  // riallineata da quiz-library.js ad ogni avvio): per il test si inserisce a
  // mano con una prepared statement grezza, come farebbe la sincronizzazione.
  getDb()
    .prepare('INSERT INTO preloaded_quizzes (slug, title, category, questions) VALUES (?, ?, ?, ?)')
    .run(
      `quiz-precaricato-test-${Date.now()}`,
      'Quiz precaricato con immagine',
      'Test',
      JSON.stringify([
        {
          text: 'Domanda con immagine precaricata',
          options: ['A', 'B'],
          correct_index: 0,
          time_limit_s: 20,
          image: { hash: salvataC.hash, blur: false },
        },
      ])
    );

  // Se la raccolta non leggesse anche preloaded_quizzes, C sembrerebbe orfana
  // (nessuna riga di `quizzes` la referenzia) e sparirebbe qui sotto.
  assert(gcOrphanImages() === 0, "gcOrphanImages: C è referenziata solo da preloaded_quizzes, non è orfana");
  assert(getImage(salvataC.hash) !== null, "l'immagine referenziata solo da preloaded_quizzes sopravvive alla raccolta");

  // ─── Raccolta degli orfani: una riga con `questions` illeggibile annulla tutto ──

  console.log('\n── quiz_images: una riga con questions illeggibile annulla la raccolta ──\n');

  const salvataD = putImage(Buffer.from('RIFF____WEBPfinta-immagine-D', 'ascii'), 'image/webp', 400, 300);
  assert(conteggioImmagini() === 3, "immagine D salvata: un'orfana vera, di quelle che la raccolta normalmente eliminerebbe");

  // createQuiz non può mai produrre questo stato: serializza sempre con
  // JSON.stringify. Si bypassa con una prepared statement grezza, esattamente
  // come nella riproduzione del difetto: una riga con `questions` non-JSON.
  getDb()
    .prepare('INSERT INTO quizzes (user_id, title, questions) VALUES (?, ?, ?)')
    .run(utenteImg.id, 'Quiz con questions corrotto (test)', '{questo non è JSON valido');

  const eliminateDopoCorruzione = gcOrphanImages();
  assert(eliminateDopoCorruzione === 0, 'gcOrphanImages: una riga illeggibile annulla la raccolta, zero eliminazioni');
  assert(getImage(salvataD.hash) !== null, "l'immagine D (un'orfana vera) sopravvive perché la raccolta intera è annullata");
  assert(getImage(salvataA.hash) !== null, 'anche le immagini regolarmente referenziate (A) restano intatte');
  assert(getImage(salvataC.hash) !== null, 'anche le immagini regolarmente referenziate (C) restano intatte');
  assert(conteggioImmagini() === 3, 'nessuna riga di quiz_images viene toccata quando la raccolta è annullata');

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
