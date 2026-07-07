'use strict';

/**
 * server/routes/host.js
 *
 * Router Express per gli endpoint del pannello amministrativo host.
 *
 * MODELLO DI ACCESSO (closed provisioning):
 *   - Gli account host NON si creano tramite questa API.
 *   - Le credenziali vengono create offline dall'amministratore tramite:
 *       node tools/create-host.js
 *   - Questo router espone esclusivamente: login + CRUD quiz personalizzati.
 *
 * Questo router viene montato su Express in server/index.js (Step 3).
 * Prefisso di montaggio: /api/host
 *
 * Formato risposta unificato:
 *   Successo → { success: true,  data: { ... } }
 *   Errore   → { success: false, error: "Messaggio descrittivo" }
 */

const router   = require('express').Router();
const bcryptjs = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const os       = require('node:os');

const config                                          = require('../config');
const { verifyToken }                                 = require('../middleware/auth');
const { MINIGAME_TYPE_KEYS }                          = require('../game');
const {
  getUserByUsername,
  getUserById,
  getQuizzesByUser,
  getQuizById,
  createQuiz,
  updateQuiz,
  deleteQuiz,
  getPreloadedQuizzes,
  getPreloadedQuizById,
  QuizLimitError,
  NotFoundError,
  MAX_QUIZZES_PER_USER,
  MAX_QUESTIONS_PER_QUIZ,
} = require('../quiz-manager');

// ─── Helpers ─────────────────────────────────────────────────────────────────────

/**
 * Invia una risposta di errore in formato standard.
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} message
 */
function sendError(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

// ─── Validazione Input Quiz ───────────────────────────────────────────────────────

/**
 * Valida il body di una richiesta di creazione/aggiornamento quiz.
 * @param {{ title: any, questions: any, minigames?: any }} input
 * @returns {string | null} Messaggio di errore, o null se tutto è valido
 */
function validateQuizInput({ title, questions, minigames }) {
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > 100) {
    return 'Il titolo deve essere una stringa tra 1 e 100 caratteri.';
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    return 'Il quiz deve contenere almeno una domanda.';
  }
  if (questions.length > MAX_QUESTIONS_PER_QUIZ) {
    return `Il quiz può contenere al massimo ${MAX_QUESTIONS_PER_QUIZ} domande.`;
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const num = i + 1;

    if (!q || typeof q.text !== 'string' || q.text.trim().length === 0) {
      return `Domanda ${num}: il campo "text" è obbligatorio.`;
    }
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
      return `Domanda ${num}: "options" deve essere un array di 2-4 stringhe.`;
    }
    if (q.options.some((o) => typeof o !== 'string' || o.trim().length === 0)) {
      return `Domanda ${num}: ogni opzione deve essere una stringa non vuota.`;
    }
    if (
      typeof q.correct_index !== 'number' ||
      !Number.isInteger(q.correct_index) ||
      q.correct_index < 0 ||
      q.correct_index >= q.options.length
    ) {
      return `Domanda ${num}: "correct_index" deve essere un intero valido (0-${q.options.length - 1}).`;
    }
    if (
      typeof q.time_limit_s !== 'number' ||
      !Number.isInteger(q.time_limit_s) ||
      q.time_limit_s < 5 ||
      q.time_limit_s > 120
    ) {
      return `Domanda ${num}: "time_limit_s" deve essere un intero tra 5 e 120 secondi.`;
    }
  }

  if (minigames !== undefined) {
    if (!Array.isArray(minigames)) {
      return '"minigames" deve essere un array.';
    }
    for (let i = 0; i < minigames.length; i++) {
      const m = minigames[i];
      const num = i + 1;
      if (
        !m ||
        typeof m.afterQuestionIndex !== 'number' ||
        !Number.isInteger(m.afterQuestionIndex) ||
        m.afterQuestionIndex < 0 ||
        m.afterQuestionIndex >= questions.length
      ) {
        return `Minigioco ${num}: "afterQuestionIndex" deve essere un intero valido (0-${questions.length - 1}).`;
      }
      if (typeof m.type !== 'string' || !MINIGAME_TYPE_KEYS.includes(m.type)) {
        return `Minigioco ${num}: "type" non riconosciuto.`;
      }
    }
  }

  return null;
}

// ─── POST /login ─────────────────────────────────────────────────────────────────

/**
 * Login host.
 * Body: { username: string, password: string }
 * Risposta: { success: true, data: { token: string, user: { id, username } } }
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body ?? {};

    if (!username || !password) {
      return sendError(res, 400, 'Username e password sono obbligatori.');
    }

    const user = getUserByUsername(String(username));

    // Risposta generica per non rivelare se l'username esiste o meno
    if (!user) {
      return sendError(res, 401, 'Credenziali non valide.');
    }

    const passwordMatch = await bcryptjs.compare(String(password), user.password);
    if (!passwordMatch) {
      return sendError(res, 401, 'Credenziali non valide.');
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    return res.status(200).json({
      success: true,
      data: {
        token,
        user: { id: user.id, username: user.username },
      },
    });
  } catch (err) {
    console.error('[host/login]', err);
    return sendError(res, 500, 'Errore interno del server.');
  }
});

// ─── GET /me ─────────────────────────────────────────────────────────────────────

/**
 * Restituisce il profilo dell'host autenticato.
 * Risposta: { success: true, data: { user: { id, username, created_at } } }
 */
router.get('/me', verifyToken, (req, res) => {
  try {
    const user = getUserById(req.user.userId);
    if (!user) {
      return sendError(res, 404, 'Utente non trovato.');
    }
    return res.status(200).json({ success: true, data: { user } });
  } catch (err) {
    console.error('[host/me]', err);
    return sendError(res, 500, 'Errore interno del server.');
  }
});

// ─── GET /quizzes ─────────────────────────────────────────────────────────────────

/**
 * Lista quiz dell'host autenticato.
 * Risposta: { success: true, data: { quizzes: [], total: n, limit: MAX_QUIZZES_PER_USER } }
 */
router.get('/quizzes', verifyToken, (req, res) => {
  try {
    const quizzes = getQuizzesByUser(req.user.userId);
    return res.status(200).json({
      success: true,
      data: {
        quizzes,
        total: quizzes.length,
        limit: MAX_QUIZZES_PER_USER,
      },
    });
  } catch (err) {
    console.error('[host/quizzes GET]', err);
    return sendError(res, 500, 'Errore interno del server.');
  }
});

// ─── POST /quizzes ────────────────────────────────────────────────────────────────

/**
 * Crea un nuovo quiz per l'host autenticato (max MAX_QUIZZES_PER_USER).
 * Body: { title: string, questions: Question[], minigames?: MinigameSlot[] }
 * Risposta: { success: true, data: { quiz } }
 */
router.post('/quizzes', verifyToken, (req, res) => {
  try {
    const { title, questions, minigames } = req.body ?? {};

    const validationError = validateQuizInput({ title, questions, minigames });
    if (validationError) {
      return sendError(res, 400, validationError);
    }

    const quiz = createQuiz(req.user.userId, title.trim(), questions, minigames ?? []);
    return res.status(201).json({ success: true, data: { quiz } });
  } catch (err) {
    if (err instanceof QuizLimitError) {
      return sendError(res, 422, err.message);
    }
    console.error('[host/quizzes POST]', err);
    return sendError(res, 500, 'Errore interno del server.');
  }
});

// ─── GET /quizzes/:id ─────────────────────────────────────────────────────────────

/**
 * Dettaglio di un quiz personale dell'host autenticato (usato dall'editor per il caricamento
 * di un quiz esistente).
 * Risposta: { success: true, data: { quiz } }
 */
router.get('/quizzes/:id', verifyToken, (req, res) => {
  try {
    const quizId = parseInt(req.params.id, 10);
    if (isNaN(quizId) || quizId <= 0) {
      return sendError(res, 400, 'ID quiz non valido.');
    }

    const quiz = getQuizById(quizId, req.user.userId);
    if (!quiz) {
      return sendError(res, 404, 'Quiz non trovato o non di tua proprietà.');
    }

    return res.status(200).json({ success: true, data: { quiz } });
  } catch (err) {
    console.error('[host/quizzes/:id GET]', err);
    return sendError(res, 500, 'Errore interno del server.');
  }
});

// ─── PUT /quizzes/:id ─────────────────────────────────────────────────────────────

/**
 * Aggiorna un quiz esistente (partial update supportato: title, questions e/o minigames).
 * Body: { title?: string, questions?: Question[], minigames?: MinigameSlot[] }
 * Risposta: { success: true, data: { quiz } }
 */
router.put('/quizzes/:id', verifyToken, (req, res) => {
  try {
    const quizId = parseInt(req.params.id, 10);
    if (isNaN(quizId) || quizId <= 0) {
      return sendError(res, 400, 'ID quiz non valido.');
    }

    // Recupera il quiz corrente per supportare partial update
    const existing = getQuizById(quizId, req.user.userId);
    if (!existing) {
      return sendError(res, 404, 'Quiz non trovato o non di tua proprietà.');
    }

    // Merge: usa il valore del body se fornito, altrimenti mantieni quello esistente
    const title     = req.body?.title     !== undefined ? req.body.title     : existing.title;
    const questions = req.body?.questions !== undefined ? req.body.questions : existing.questions;
    const minigames = req.body?.minigames !== undefined ? req.body.minigames : existing.minigames;

    const validationError = validateQuizInput({ title, questions, minigames });
    if (validationError) {
      return sendError(res, 400, validationError);
    }

    const updated = updateQuiz(quizId, req.user.userId, title.trim(), questions, minigames);
    return res.status(200).json({ success: true, data: { quiz: updated } });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return sendError(res, 404, err.message);
    }
    console.error('[host/quizzes PUT]', err);
    return sendError(res, 500, 'Errore interno del server.');
  }
});

// ─── DELETE /quizzes/:id ──────────────────────────────────────────────────────────

/**
 * Elimina un quiz (solo se appartiene all'host autenticato).
 * Risposta: { success: true, data: { message: string } }
 */
router.delete('/quizzes/:id', verifyToken, (req, res) => {
  try {
    const quizId = parseInt(req.params.id, 10);
    if (isNaN(quizId) || quizId <= 0) {
      return sendError(res, 400, 'ID quiz non valido.');
    }

    deleteQuiz(quizId, req.user.userId);
    return res.status(200).json({
      success: true,
      data: { message: 'Quiz eliminato con successo.' },
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return sendError(res, 404, err.message);
    }
    console.error('[host/quizzes DELETE]', err);
    return sendError(res, 500, 'Errore interno del server.');
  }
});

// ─── GET /preloaded-quizzes ─────────────────────────────────────────────────────────────────────

/**
 * Lista quiz precaricati di sistema.
 * Risposta: { success: true, data: { quizzes: [] } }
 */
router.get('/preloaded-quizzes', verifyToken, (req, res) => {
  try {
    const quizzes = getPreloadedQuizzes();
    return res.status(200).json({ success: true, data: { quizzes } });
  } catch (err) {
    console.error('[host/preloaded-quizzes GET]', err);
    return sendError(res, 500, 'Errore interno del server.');
  }
});

// ─── GET /preloaded-quizzes/:id ─────────────────────────────────────────────────────────────

/**
 * Dettaglio di un quiz precaricato per ID.
 * Risposta: { success: true, data: { quiz } }
 */
router.get('/preloaded-quizzes/:id', verifyToken, (req, res) => {
  try {
    const quizId = parseInt(req.params.id, 10);
    if (isNaN(quizId) || quizId <= 0) {
      return sendError(res, 400, 'ID quiz non valido.');
    }
    const quiz = getPreloadedQuizById(quizId);
    if (!quiz) {
      return sendError(res, 404, 'Quiz precaricato non trovato.');
    }
    return res.status(200).json({ success: true, data: { quiz } });
  } catch (err) {
    console.error('[host/preloaded-quizzes/:id GET]', err);
    return sendError(res, 500, 'Errore interno del server.');
  }
});

// ─── GET /game/join-info ──────────────────────────────────────────────────────────

/**
 * GET /api/host/game/join-info
 * Restituisce l'URL LAN a cui i giocatori si collegano (per QR code in lobby).
 * Prende il primo indirizzo IPv4 non-loopback; fallback localhost se assente.
 */
router.get('/game/join-info', verifyToken, (_req, res) => {
  let ip = null;
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const net of addresses ?? []) {
      if (net.family === 'IPv4' && !net.internal) { ip = net.address; break; }
    }
    if (ip) break;
  }
  res.json({ success: true, data: { url: `http://${ip ?? 'localhost'}:${config.port}` } });
});

module.exports = router;
