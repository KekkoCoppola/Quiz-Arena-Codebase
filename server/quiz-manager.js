'use strict';

/**
 * server/quiz-manager.js
 *
 * Layer dati centralizzato. UNICO punto di contatto con il database SQLite.
 * Nessun altro modulo deve interagire direttamente con node:sqlite.
 *
 * Pattern: Singleton — la connessione DB viene aperta una volta sola tramite
 * initDb() e condivisa internamente. Tutte le funzioni esportate sono sincrone
 * (node:sqlite espone DatabaseSync, niente async/await).
 *
 * Utilizzo:
 *   const db = require('./quiz-manager');
 *   db.initDb(config.dbPath);
 *   const user = db.getUserByUsername('mario');
 */

const fs   = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');

// ─── Costanti ────────────────────────────────────────────────────────────────────

/** Numero massimo di quiz personalizzati per account host. */
const MAX_QUIZZES_PER_USER = 3;

/**
 * Numero massimo di domande per quiz.
 * Deve restare allineato a `MAX_QUESTIONS` in client/host/app.js (limite lato UI).
 */
// Riesportata da quiz-schema.js, che è dove la forma di un quiz è definita:
// due copie di questo numero divergerebbero al primo cambio.
const { MAX_QUESTIONS_PER_QUIZ } = require('./quiz-schema');

// ─── Errori Custom ───────────────────────────────────────────────────────────────

/**
 * Lanciato quando un utente host tenta di creare un quiz oltre il limite consentito.
 */
class QuizLimitError extends Error {
  constructor(message = `Limite di ${MAX_QUIZZES_PER_USER} quiz personalizzati raggiunto per questo account.`) {
    super(message);
    this.name = 'QuizLimitError';
  }
}

/**
 * Lanciato quando una risorsa non viene trovata o non appartiene all'utente richiedente.
 */
class NotFoundError extends Error {
  constructor(message = 'Risorsa non trovata o non di tua proprietà.') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Lanciato quando si tenta di creare un utente con un username già esistente.
 */
class DuplicateUsernameError extends Error {
  constructor(message = 'Username già in uso. Scegli un nome diverso.') {
    super(message);
    this.name = 'DuplicateUsernameError';
  }
}

// ─── Istanza Singleton ───────────────────────────────────────────────────────────

/** @type {DatabaseSync | null} */
let _db = null;

/**
 * Restituisce l'istanza attiva del DB. Lancia un errore se initDb() non è stato chiamato.
 * @returns {DatabaseSync}
 */
function getDb() {
  if (!_db) {
    throw new Error(
      '[quiz-manager] Database non inizializzato. Chiama initDb(dbPath) prima di usare il DB.'
    );
  }
  return _db;
}

/**
 * Chiude la connessione al database.
 * Da chiamare alla fine di script CLI o test per rilasciare il lock sul file.
 */
function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────────

/**
 * Apre (o crea) il file database SQLite e applica lo schema.
 * Va chiamata una volta sola all'avvio del server o dello script CLI.
 *
 * @param {string} dbPath - Percorso assoluto o relativo del file .sqlite
 */
function initDb(dbPath) {
  const resolvedPath = path.resolve(dbPath);

  // Crea la directory se non esiste ancora (es. primo avvio, server/db/ vuota)
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new DatabaseSync(resolvedPath);

  // WAL mode: migliora le performance con scritture concorrenti (Socket.io)
  _db.exec('PRAGMA journal_mode = WAL;');
  // Foreign keys: vanno riabilitate ad ogni connessione in SQLite
  _db.exec('PRAGMA foreign_keys = ON;');

  // Applica lo schema (CREATE TABLE IF NOT EXISTS — operazione idempotente)
  const schemaPath = path.join(__dirname, 'db', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  _db.exec(schema);

  // Migrazione Fase Minigiochi: CREATE TABLE IF NOT EXISTS non altera tabelle
  // già esistenti, quindi i DB creati prima dell'introduzione della colonna
  // `minigames` vanno migrati esplicitamente. La build di SQLite usata da
  // node:sqlite non supporta la sintassi "ADD COLUMN IF NOT EXISTS" (verificato
  // empiricamente: syntax error nonostante SQLite >= 3.35), quindi l'idempotenza
  // si ottiene ignorando l'errore "duplicate column name" su una seconda esecuzione.
  addColumnIfMissing('quizzes', "minigames TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing('preloaded_quizzes', "minigames TEXT NOT NULL DEFAULT '[]'");

  // Migrazione Fase Quiz-come-file: identita stabile dei quiz di sistema,
  // corrispondente al nome del file in content/quizzes/. Senza UNIQUE perche
  // ALTER TABLE ADD COLUMN non lo consente su SQLite; l unicita e garantita da
  // quiz-library.js, unico modulo che scrive in questa tabella.
  addColumnIfMissing('preloaded_quizzes', 'slug TEXT');

  syncPreloadedQuizzes();

  // Raccolta degli orfani: le immagini sono condivise fra domande e fra quiz,
  // quindi cancellare una domanda non può cancellare il blob — potrebbe servire
  // altrove. Si ricalcola qui, all'avvio, quali hash sono ancora referenziati.
  //
  // Un refcount sarebbe più efficiente e più fragile: un contatore va aggiornato
  // da ogni percorso che tocca una domanda, e basta dimenticarne uno perché
  // diventi bugiardo in silenzio. Questa scansione ricalcola la verità invece di
  // ricordarla, e su un DB di questa taglia costa millisecondi.
  //
  // A differenza dei passi precedenti di initDb (SELECT, PRAGMA, CREATE TABLE
  // IF NOT EXISTS), la DELETE dentro gcOrphanImages() è una scrittura: su un
  // DB montato in sola lettura (scheda SD Raspberry degradata), a disco pieno
  // o con un lock residuo, lancia invece di restituire un conteggio. Prima di
  // questa raccolta lo stesso scenario avviava comunque il server per
  // un'intera serata, perché la partita vive in memoria e i quiz servono solo
  // in lettura: un guasto qui non deve far regredire quel comportamento.
  // Stessa filosofia di syncPreloadedQuizzes appena sopra.
  try {
    const orfane = gcOrphanImages();
    if (orfane > 0) {
      console.log(`[img] raccolta orfani: ${orfane} immagini eliminate.`);
    }
  } catch (err) {
    console.error('[img] raccolta orfani fallita, il server si avvia comunque:', err.message);
  }
}

/**
 * Riallinea i quiz di sistema ai file in content/quizzes/.
 *
 * Chiamata ad ogni avvio: i file sono la fonte di verita, il DB una copia.
 * Un quiz malformato viene **escluso, non blocca l'avvio** — e la differenza
 * con i minigiochi, dove un modulo rotto impedisce il boot: li e un bug di
 * codice, qui e un refuso di contenuto, e fermare tutta la serata perche una
 * domanda ha un indice sbagliato sarebbe sproporzionato.
 *
 * Il prezzo di quella scelta e che l'esclusione va **vista**: per questo gli
 * errori escono con console.error e non con un log discreto. Sono il momento
 * in cui ci si accorge del refuso, e deve capitare in fase di avvio invece
 * che davanti a una sala piena.
 */
function syncPreloadedQuizzes() {
  const { syncToDatabase } = require('./quiz-library');
  let esito;
  try {
    esito = syncToDatabase(_db);
  } catch (err) {
    // Nemmeno un guasto della libreria deve impedire l'avvio: senza quiz di
    // sistema il gioco resta utilizzabile con quelli personali.
    console.error('[quiz] sincronizzazione fallita, i quiz di sistema restano quelli in DB:', err.message);
    return;
  }

  for (const errore of esito.errors) {
    console.error('  \u274C  QUIZ ESCLUSO  ' + errore);
  }
  if (esito.errors.length > 0) {
    console.error('[quiz] ' + esito.errors.length + ' quiz esclusi: correggi i file in content/quizzes/ e riavvia.');
  }

  const mosse = [];
  if (esito.inserted) mosse.push(esito.inserted + ' aggiunti');
  if (esito.updated)  mosse.push(esito.updated + ' aggiornati');
  if (esito.removed)  mosse.push(esito.removed + ' rimossi');
  if (mosse.length) {
    console.log('[quiz] quiz di sistema: ' + mosse.join(', ') + '.');
  }
}

/**
 * Aggiunge una colonna a una tabella esistente, ignorando l'errore se la
 * colonna è già presente (migrazione idempotente eseguita ad ogni avvio).
 * @param {string} table
 * @param {string} columnDef - es. "minigames TEXT NOT NULL DEFAULT '[]'"
 */
function addColumnIfMissing(table, columnDef) {
  try {
    _db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef};`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) {
      throw err;
    }
  }
}

// ─── Users ───────────────────────────────────────────────────────────────────────

/**
 * Crea un nuovo utente host.
 * Usata da tools/create-host.js — non esposta in nessun endpoint HTTP pubblico.
 *
 * @param {string} username
 * @param {string} hashedPassword - Password già hashata con bcryptjs (cost ≥ 10)
 * @returns {{ id: number, username: string, created_at: string }}
 * @throws {DuplicateUsernameError}
 */
function createUser(username, hashedPassword) {
  const database = getDb();
  try {
    const stmt = database.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
    const result = stmt.run(username, hashedPassword);
    const fetchStmt = database.prepare('SELECT id, username, created_at FROM users WHERE id = ?');
    return fetchStmt.get(Number(result.lastInsertRowid));
  } catch (err) {
    if (err.code === 'ERR_SQLITE_ERROR' && err.message.includes('UNIQUE constraint failed')) {
      throw new DuplicateUsernameError();
    }
    throw err;
  }
}

/**
 * Cerca un utente per username (case-insensitive grazie a COLLATE NOCASE nello schema).
 * Restituisce anche il campo `password` (hash) per il confronto al login.
 *
 * @param {string} username
 * @returns {{ id: number, username: string, password: string, created_at: string } | null}
 */
function getUserByUsername(username) {
  const database = getDb();
  const stmt = database.prepare(
    'SELECT id, username, password, created_at FROM users WHERE username = ?'
  );
  return stmt.get(username) ?? null;
}

/**
 * Cerca un utente per ID (usato per validare il payload del token JWT).
 * NON restituisce il campo password.
 *
 * @param {number} id
 * @returns {{ id: number, username: string, created_at: string } | null}
 */
function getUserById(id) {
  const database = getDb();
  const stmt = database.prepare(
    'SELECT id, username, created_at FROM users WHERE id = ?'
  );
  return stmt.get(id) ?? null;
}

// ─── Quizzes ─────────────────────────────────────────────────────────────────────

/**
 * Deserializza i campi `questions`/`minigames` da stringa JSON ad array JS.
 * @param {object | undefined} row
 * @returns {object | null}
 */
function parseQuizRow(row) {
  if (!row) return null;
  return {
    ...row,
    questions: JSON.parse(row.questions),
    minigames: JSON.parse(row.minigames ?? '[]'),
  };
}

/**
 * Restituisce tutti i quiz di un utente, ordinati per data di aggiornamento (più recenti prima).
 *
 * @param {number} userId
 * @returns {Array<object>}
 */
function getQuizzesByUser(userId) {
  const database = getDb();
  const stmt = database.prepare(
    'SELECT id, user_id, title, questions, minigames, created_at, updated_at FROM quizzes WHERE user_id = ? ORDER BY updated_at DESC'
  );
  return stmt.all(userId).map(parseQuizRow);
}

/**
 * Recupera un singolo quiz, verificando che appartenga all'utente specificato.
 *
 * @param {number} quizId
 * @param {number} userId
 * @returns {object | null}
 */
function getQuizById(quizId, userId) {
  const database = getDb();
  const stmt = database.prepare(
    'SELECT id, user_id, title, questions, minigames, created_at, updated_at FROM quizzes WHERE id = ? AND user_id = ?'
  );
  return parseQuizRow(stmt.get(quizId, userId));
}

/**
 * Crea un nuovo quiz per l'utente.
 * Applica il limite di MAX_QUIZZES_PER_USER (difesa in profondità, il controllo
 * è presente anche nel route handler).
 *
 * @param {number} userId
 * @param {string} title
 * @param {Array<object>} questions - Array JS (serializzato internamente in JSON)
 * @param {Array<object>} [minigames] - Slot minigioco pianificati (default [])
 * @returns {object} Il quiz creato
 * @throws {QuizLimitError}
 */
function createQuiz(userId, title, questions, minigames = []) {
  const database = getDb();

  const countStmt = database.prepare('SELECT COUNT(*) AS count FROM quizzes WHERE user_id = ?');
  const { count } = countStmt.get(userId);
  if (count >= MAX_QUIZZES_PER_USER) {
    throw new QuizLimitError();
  }

  const insertStmt = database.prepare(
    'INSERT INTO quizzes (user_id, title, questions, minigames) VALUES (?, ?, ?, ?)'
  );
  const result = insertStmt.run(userId, title, JSON.stringify(questions), JSON.stringify(minigames));

  const fetchStmt = database.prepare(
    'SELECT id, user_id, title, questions, minigames, created_at, updated_at FROM quizzes WHERE id = ?'
  );
  return parseQuizRow(fetchStmt.get(Number(result.lastInsertRowid)));
}

/**
 * Aggiorna titolo, domande e/o minigiochi pianificati di un quiz esistente.
 * Verifica l'ownership prima di procedere.
 *
 * @param {number} quizId
 * @param {number} userId
 * @param {string} title
 * @param {Array<object>} questions
 * @param {Array<object>} [minigames] - Slot minigioco pianificati (default [])
 * @returns {object} Il quiz aggiornato
 * @throws {NotFoundError}
 */
function updateQuiz(quizId, userId, title, questions, minigames = []) {
  const database = getDb();

  const updateStmt = database.prepare(`
    UPDATE quizzes
       SET title      = ?,
           questions  = ?,
           minigames  = ?,
           updated_at = datetime('now')
     WHERE id = ? AND user_id = ?
  `);
  const result = updateStmt.run(title, JSON.stringify(questions), JSON.stringify(minigames), quizId, userId);

  if (result.changes === 0) {
    throw new NotFoundError('Quiz non trovato o non di tua proprietà.');
  }

  return getQuizById(quizId, userId);
}

/**
 * Elimina un quiz. Verifica l'ownership prima di procedere.
 *
 * @param {number} quizId
 * @param {number} userId
 * @throws {NotFoundError}
 */
function deleteQuiz(quizId, userId) {
  const database = getDb();

  const stmt = database.prepare('DELETE FROM quizzes WHERE id = ? AND user_id = ?');
  const result = stmt.run(quizId, userId);

  if (result.changes === 0) {
    throw new NotFoundError('Quiz non trovato o non di tua proprietà.');
  }
}

// ─── Preloaded Quizzes ────────────────────────────────────────────────────────────────────────────────────

/**
 * Restituisce tutti i quiz precaricati di sistema, ordinati per categoria e titolo.
 *
 * @returns {Array<object>}
 */
function getPreloadedQuizzes() {
  const database = getDb();
  const stmt = database.prepare(
    'SELECT id, title, category, questions, minigames, created_at FROM preloaded_quizzes ORDER BY category ASC, title ASC'
  );
  return stmt.all().map(parseQuizRow);
}

/**
 * Recupera un singolo quiz precaricato per ID.
 *
 * @param {number} quizId
 * @returns {object | null}
 */
function getPreloadedQuizById(quizId) {
  const database = getDb();
  const stmt = database.prepare(
    'SELECT id, title, category, questions, minigames, created_at FROM preloaded_quizzes WHERE id = ?'
  );
  return parseQuizRow(stmt.get(quizId));
}

// ─── Immagini delle domande ──────────────────────────────────────────────────

/**
 * Stocca i byte di un'immagine, indirizzata dal proprio contenuto.
 *
 * L'hash lo calcola SEMPRE il server dai byte ricevuti: un client non ha modo
 * di far entrare un riferimento che non corrisponda a ciò che ha caricato.
 *
 * Idempotente: ricaricare la stessa immagine non crea una seconda riga.
 * `INSERT OR IGNORE` invece di un SELECT preventivo perché la chiave primaria
 * fa già il lavoro, e in una riga sola.
 *
 * @param {Buffer|Uint8Array} bytes byte già compressi (WebP)
 * @param {string} mime
 * @param {number} width
 * @param {number} height
 * @returns {{ hash: string, width: number, height: number }}
 */
function putImage(bytes, mime, width, height) {
  const database = getDb();
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const hash = createHash('sha256').update(buffer).digest('hex');

  database
    .prepare('INSERT OR IGNORE INTO quiz_images (hash, mime, bytes, width, height) VALUES (?, ?, ?, ?, ?)')
    .run(hash, mime, buffer, width, height);

  return { hash, width, height };
}

/**
 * @param {string} hash
 * @returns {{ hash: string, mime: string, bytes: Uint8Array, width: number, height: number, created_at: string } | null}
 */
function getImage(hash) {
  const database = getDb();
  const row = database
    .prepare('SELECT hash, mime, bytes, width, height, created_at FROM quiz_images WHERE hash = ?')
    .get(hash);
  return row ?? null;
}

/**
 * Tutti gli hash referenziati da almeno una domanda, in entrambe le tabelle.
 *
 * Le domande vivono dentro un JSON serializzato, quindi non c'è una JOIN da
 * fare: si legge e si scandisce. Se una riga ha un `questions` illeggibile
 * (JSON non valido, o valido ma non un array) la scansione NON può più
 * garantire di conoscere tutti gli hash vivi. Trattare quella riga come "zero
 * hash" — l'idea originale di questa funzione — è esattamente sbagliato: fa
 * *sembrare* orfana un'immagine che invece è ancora referenziata, e chi la
 * chiama la cancellerebbe per sempre. Per questo la riga rotta non viene
 * saltata in silenzio: fa fallire l'intera raccolta, rumorosamente.
 *
 * @param {import('node:sqlite').DatabaseSync} database
 * @returns {Set<string> | null} null se almeno una riga non è stata leggibile
 *   (raccolta annullata, vedi gcOrphanImages)
 */
function collectReferencedImageHashes(database) {
  const referenced = new Set();
  let raccoltaFallita = false;

  for (const table of ['quizzes', 'preloaded_quizzes']) {
    for (const row of database.prepare(`SELECT id, questions FROM ${table}`).all()) {
      let questions;
      try {
        questions = JSON.parse(row.questions);
      } catch {
        console.error(`[img] ${table}.id=${row.id}: "questions" non è JSON valido, riga ignorata ai fini della raccolta.`);
        raccoltaFallita = true;
        continue;
      }
      if (!Array.isArray(questions)) {
        console.error(`[img] ${table}.id=${row.id}: "questions" non è un array, riga ignorata ai fini della raccolta.`);
        raccoltaFallita = true;
        continue;
      }

      for (const q of questions) {
        const hash = q?.image?.hash;
        if (typeof hash === 'string') referenced.add(hash);
      }
    }
  }

  return raccoltaFallita ? null : referenced;
}

/**
 * Elimina le immagini che nessuna domanda referenzia più.
 *
 * Se anche una sola riga di `quizzes`/`preloaded_quizzes` ha un `questions`
 * illeggibile, questa funzione NON elimina nulla e restituisce 0. L'asimmetria
 * è deliberata: cancellare un'immagine è irreversibile, mentre non cancellarla
 * costa solo un po' di spazio su una scheda SD — un file in più non raccolto
 * si ripresenta al prossimo avvio, un'immagine viva cancellata per errore è
 * persa per sempre. Stessa filosofia di quiz-library.js (un quiz malformato
 * viene escluso con un console.error, non fatto passare) e del registry
 * minigiochi (un modulo malformato blocca l'avvio): qui l'avvio del server
 * NON si blocca — si salta solo la raccolta, e il problema resta visibile nei
 * log.
 *
 * Questa protezione, però, è tutta interna e copre solo il caso di
 * `questions` illeggibile. Un errore del driver SQLite sulla DELETE (DB
 * montato in sola lettura, scheda SD piena, database bloccato) esce da questa
 * funzione come un'eccezione vera e propria: non è `gcOrphanImages` a
 * intercettarla, ma il suo chiamante `initDb()`, che avvolge la chiamata in
 * try/catch. L'avvio del server non si blocca in nessuno dei due casi, ma per
 * due ragioni diverse: qui perché la raccolta si annulla da sola, in initDb
 * perché l'errore viene loggato e ignorato.
 *
 * Idempotente quando tutte le righe sono leggibili: eseguirla due volte di
 * fila non cambia niente, come lo `syncPreloadedQuizzes` accanto a cui gira.
 *
 * @returns {number} righe eliminate, 0 se la raccolta è stata annullata
 * @throws se il driver SQLite fallisce sulla DELETE (es. DB in sola lettura o
 *   disco pieno) — vedi sopra: a intercettarlo è initDb(), non questa funzione.
 */
function gcOrphanImages() {
  const database = getDb();
  const referenced = collectReferencedImageHashes(database);

  if (referenced === null) {
    // Il dettaglio (tabella + id della riga incriminata) è già stato stampato
    // da collectReferencedImageHashes; qui si rende visibile solo l'esito.
    console.error('[img] raccolta orfani annullata: nessuna immagine eliminata in questo avvio.');
    return 0;
  }

  if (referenced.size === 0) {
    // Nessuna domanda referenzia niente: sono orfane tutte.
    return database.prepare('DELETE FROM quiz_images').run().changes;
  }

  const placeholders = Array.from(referenced, () => '?').join(', ');
  return database
    .prepare(`DELETE FROM quiz_images WHERE hash NOT IN (${placeholders})`)
    .run(...referenced).changes;
}

// ─── Exports ────────────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Init
  initDb,
  getDb,
  closeDb,
  // Users
  createUser,
  getUserByUsername,
  getUserById,
  // Quizzes
  getQuizzesByUser,
  getQuizById,
  createQuiz,
  updateQuiz,
  deleteQuiz,
  syncPreloadedQuizzes,
  // Preloaded Quizzes (sola lettura)
  getPreloadedQuizzes,
  getPreloadedQuizById,
  // Immagini delle domande
  putImage,
  getImage,
  gcOrphanImages,
  // Error classes (usate dai route handler per il mapping HTTP status)
  QuizLimitError,
  NotFoundError,
  DuplicateUsernameError,
  // Costanti
  MAX_QUIZZES_PER_USER,
  MAX_QUESTIONS_PER_QUIZ,
};
