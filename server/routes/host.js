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

const config                                          = require('../config');
const { verifyToken }                                 = require('../middleware/auth');
const { lanJoinUrl }                                  = require('../lan-url');
const { listForUi: listMinigamesForUi }               = require('../minigames');
const { validateQuiz }                                = require('../quiz-schema');
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
// La validazione NON vive più qui: sta in server/quiz-schema.js, perché deve
// valere anche per i quiz che non passano dall'HTTP (quelli di sistema, letti
// da content/quizzes/). Chiusa dentro questo file lasciava scoperta l'altra
// strada, e un quiz malformato arrivava intatto fino alla sala.

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

    const validationError = validateQuiz({ title, questions, minigames });
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

    const validationError = validateQuiz({ title, questions, minigames });
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

// ─── GET /minigames ───────────────────────────────────────────────────────────────

/**
 * Elenco dei minigiochi disponibili, con in testa la voce "casuale".
 * Generato dal registry `server/minigames/`: è l'unica fonte di verità per la
 * UI, così l'editor non deve mai elencare i tipi a mano e un minigioco appena
 * aggiunto compare da solo nel menù.
 * Risposta: { success: true, data: { minigames: [{ type, label, description }] } }
 */
router.get('/minigames', verifyToken, (_req, res) => {
  return res.status(200).json({ success: true, data: { minigames: listMinigamesForUi() } });
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
 * Il calcolo vive in server/lan-url.js perché lo condivide con /api/join-info,
 * la versione pubblica usata dalla vista sala, che non ha un token.
 */
router.get('/game/join-info', verifyToken, (_req, res) => {
  res.json({ success: true, data: { url: lanJoinUrl() } });
});

module.exports = router;
