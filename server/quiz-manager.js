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

// ─── Costanti ────────────────────────────────────────────────────────────────────

/** Numero massimo di quiz personalizzati per account host. */
const MAX_QUIZZES_PER_USER = 3;

/**
 * Numero massimo di domande per quiz.
 * Deve restare allineato a `MAX_QUESTIONS` in client/host/app.js (limite lato UI).
 */
const MAX_QUESTIONS_PER_QUIZ = 20;

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
  // Preloaded Quizzes (sola lettura)
  getPreloadedQuizzes,
  getPreloadedQuizById,
  // Error classes (usate dai route handler per il mapping HTTP status)
  QuizLimitError,
  NotFoundError,
  DuplicateUsernameError,
  // Costanti
  MAX_QUIZZES_PER_USER,
  MAX_QUESTIONS_PER_QUIZ,
};
