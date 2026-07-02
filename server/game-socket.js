'use strict';

/**
 * server/game-socket.js
 *
 * Step 6: layer di rete del motore di gioco.
 * Espone la state machine pura di game.js via eventi Socket.io.
 *
 * Responsabilità:
 *   - Ciclo di vita della sessione (UNA sola partita globale in memoria)
 *   - Autenticazione host via JWT nell'handshake (stesso segreto delle API REST)
 *   - Timer reali (setTimeout) per la chiusura domande + chiusura anticipata
 *   - Riavvio partita: nuova GameSession, stessi giocatori connessi
 *
 * NON contiene logica di gioco (→ game.js) né bootstrap (→ index.js).
 */

const jwt    = require('jsonwebtoken');
const config = require('./config');
const db     = require('./quiz-manager');
const { GameSession, STATES } = require('./game');

// ─── Room Socket.io ──────────────────────────────────────────────────────────────

const ROOM_PLAYERS = 'players';
const ROOM_HOST    = 'host';

// ─── Stato modulo (una sola partita alla volta) ──────────────────────────────────

/** @type {GameSession | null} */
let currentSession = null;
/** Quiz caricato per la sessione corrente (serve per il riavvio). */
let currentQuiz = null;
/** Handle del setTimeout della domanda corrente. */
let questionTimer = null;
/** @type {Map<string, string>} socket.id -> playerId */
const socketPlayers = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────────

function clearQuestionTimer() {
  if (questionTimer) {
    clearTimeout(questionTimer);
    questionTimer = null;
  }
}

function destroySession() {
  clearQuestionTimer();
  currentSession = null;
  currentQuiz = null;
  socketPlayers.clear();
}

/** Notifica e disconnette i giocatori della sessione corrente, poi la distrugge. */
function endCurrentGame(io) {
  if (currentSession && socketPlayers.size > 0) {
    io.to(ROOM_PLAYERS).emit('game:ended');
    for (const sockId of socketPlayers.keys()) {
      io.sockets.sockets.get(sockId)?.disconnect(true);
    }
  }
  destroySession();
}

/** Ack sicuro: i client potrebbero non passare la callback. */
function ack(cb, payload) {
  if (typeof cb === 'function') cb(payload);
}
function ok(cb, data = {})  { ack(cb, { ok: true, ...data }); }
function fail(cb, error)    { ack(cb, { ok: false, error }); }

function broadcastLobby(io) {
  io.emit('game:lobby-update', { players: currentSession.getPlayers() });
}

/**
 * Trasmette la domanda corrente (sanitizzata) e arma il timer di chiusura.
 * `endsAt` è un timestamp assoluto: i client calcolano il countdown da lì,
 * così la latenza di rete non desincronizza i timer.
 */
function emitQuestion(io) {
  const q = currentSession.getCurrentQuestion();
  const endsAt = Date.now() + q.time_limit_s * 1000;
  io.emit('game:question', { ...q, endsAt });

  clearQuestionTimer();
  questionTimer = setTimeout(() => closeQuestion(io), q.time_limit_s * 1000);
}

/** Chiude la domanda corrente (timeout o anticipata) e trasmette i risultati. */
function closeQuestion(io) {
  clearQuestionTimer();
  if (!currentSession || currentSession.state !== STATES.QUESTION) return;
  const results = currentSession.endQuestion();
  io.emit('game:results', results);
}

/** Chiusura anticipata: tutti i giocatori connessi hanno risposto. */
function maybeCloseEarly(io) {
  if (
    currentSession &&
    currentSession.state === STATES.QUESTION &&
    currentSession.currentAnswers.size >= currentSession.players.size
  ) {
    closeQuestion(io);
  }
}

// ─── Handler principali ──────────────────────────────────────────────────────────

/**
 * Aggancia tutti gli handler di gioco all'istanza Socket.io.
 * Chiamata una sola volta da index.js dopo la creazione di `io`.
 * @param {import('socket.io').Server} io
 */
function attachGameHandlers(io) {
  io.on('connection', (socket) => {
    // ── Autenticazione host (JWT opzionale nell'handshake) ──
    const token = socket.handshake.auth?.token;
    if (token) {
      try {
        const payload = jwt.verify(token, config.jwtSecret);
        socket.data.isHost = true;
        socket.data.userId = payload.userId;
        socket.join(ROOM_HOST);
      } catch {
        // Token invalido/scaduto: il socket resta non privilegiato (player).
      }
    }

    // ── Riallineamento: snapshot al connect se esiste una partita ──
    if (currentSession) {
      socket.emit('game:snapshot', currentSession.getSnapshot());
    }

    /** Guardia per gli eventi host. */
    function requireHost(cb) {
      if (!socket.data.isHost) {
        fail(cb, 'Non autorizzato.');
        return false;
      }
      return true;
    }

    // ═══ Eventi Player ═══════════════════════════════════════════════════════

    socket.on('player:join', (payload, cb) => {
      if (!currentSession) return fail(cb, 'Nessuna partita attiva.');
      try {
        const player = currentSession.addPlayer(payload?.nickname);
        socketPlayers.set(socket.id, player.id);
        socket.join(ROOM_PLAYERS);
        ok(cb, { playerId: player.id });
        broadcastLobby(io);
      } catch (err) {
        fail(cb, err.message);
      }
    });

    socket.on('player:answer', (payload, cb) => {
      if (!currentSession) return fail(cb, 'Nessuna partita attiva.');
      const playerId = socketPlayers.get(socket.id);
      if (!playerId) return fail(cb, 'Non sei registrato in questa partita.');
      try {
        const result = currentSession.submitAnswer(playerId, payload?.optionIndex);
        ok(cb, result);
        io.to(ROOM_HOST).emit('game:answer-count', {
          answered: currentSession.currentAnswers.size,
          total: currentSession.players.size,
        });
        maybeCloseEarly(io);
      } catch (err) {
        fail(cb, err.message);
      }
    });

    // ═══ Eventi Host ═════════════════════════════════════════════════════════

    socket.on('host:create-game', (payload, cb) => {
      if (!requireHost(cb)) return;

      const { quizId, quizType } = payload ?? {};
      let quiz = null;
      try {
        quiz = quizType === 'preloaded'
          ? db.getPreloadedQuizById(quizId)
          : db.getQuizById(quizId, socket.data.userId);
      } catch (err) {
        return fail(cb, err.message);
      }
      if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
        return fail(cb, 'Quiz non trovato o senza domande.');
      }

      // Un'eventuale partita precedente viene sostituita: i giocatori
      // ancora connessi vanno notificati e disconnessi, non solo scartati.
      endCurrentGame(io);
      currentQuiz = quiz;
      currentSession = new GameSession(quiz);
      ok(cb);
      broadcastLobby(io);
    });

    // NB: i client emettono sempre un payload (anche null) prima dell'ack,
    // quindi la firma è uniforme (_payload, cb) anche per gli eventi senza dati.
    socket.on('host:start-game', (_payload, cb) => {
      if (!requireHost(cb)) return;
      if (!currentSession) return fail(cb, 'Nessuna partita attiva.');
      try {
        currentSession.startGame();
        ok(cb);
        emitQuestion(io);
      } catch (err) {
        fail(cb, err.message);
      }
    });

    socket.on('host:next-question', (_payload, cb) => {
      if (!requireHost(cb)) return;
      if (!currentSession) return fail(cb, 'Nessuna partita attiva.');
      try {
        const result = currentSession.nextQuestion();
        ok(cb);
        if (result.finished) {
          io.emit('game:final', { leaderboard: result.leaderboard });
        } else {
          emitQuestion(io);
        }
      } catch (err) {
        fail(cb, err.message);
      }
    });

    socket.on('host:restart-game', (_payload, cb) => {
      if (!requireHost(cb)) return;
      if (!currentSession || currentSession.state !== STATES.FINAL_LEADERBOARD) {
        return fail(cb, 'Riavvio consentito solo dalla classifica finale.');
      }

      clearQuestionTimer();

      // Nickname dei giocatori ancora connessi, dalla sessione uscente.
      const oldNicknames = new Map(); // socket.id -> nickname
      for (const [sockId, playerId] of socketPlayers) {
        const player = currentSession.players.get(playerId);
        if (player) oldNicknames.set(sockId, player.nickname);
      }

      currentSession = new GameSession(currentQuiz);
      socketPlayers.clear();

      // Re-registra i giocatori connessi con nuovi id e li notifica singolarmente.
      for (const [sockId, nickname] of oldNicknames) {
        const playerSocket = io.sockets.sockets.get(sockId);
        if (!playerSocket) continue; // disconnesso nel frattempo
        const player = currentSession.addPlayer(nickname);
        socketPlayers.set(sockId, player.id);
        playerSocket.emit('game:reset', { playerId: player.id });
      }

      ok(cb);
      broadcastLobby(io);
    });

    socket.on('host:end-game', (_payload, cb) => {
      if (!requireHost(cb)) return;
      endCurrentGame(io);
      ok(cb);
    });

    // ═══ Disconnessione ══════════════════════════════════════════════════════

    socket.on('disconnect', () => {
      const playerId = socketPlayers.get(socket.id);
      socketPlayers.delete(socket.id);
      if (!playerId || !currentSession) return;

      try {
        currentSession.removePlayer(playerId);
      } catch {
        // Giocatore già rimosso (es. sessione appena riavviata): nessuna azione.
      }
      broadcastLobby(io);
      // Se era l'ultimo che mancava per rispondere, chiudi il round.
      maybeCloseEarly(io);
    });
  });
}

module.exports = { attachGameHandlers };
