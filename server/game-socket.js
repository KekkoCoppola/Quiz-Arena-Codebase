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

const { randomUUID } = require('node:crypto');
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
/** @type {Map<string, string>} token segreto -> playerId (riconnessione Fase 7) */
const playerTokens = new Map();
/** Scadenza assoluta (ms epoch) della domanda corrente, per il rejoin. */
let currentQuestionEndsAt = null;

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
  playerTokens.clear();
  currentQuestionEndsAt = null;
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
  const q = currentSession.getCurrentRound();
  const endsAt = Date.now() + q.time_limit_s * 1000;
  currentQuestionEndsAt = endsAt;
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

/** Conta i giocatori attualmente connessi. */
function countConnected() {
  let n = 0;
  for (const p of currentSession.players.values()) {
    if (p.connected) n++;
  }
  return n;
}

/** True se ogni giocatore CONNESSO ha risposto (i disconnessi non bloccano il round). */
function allConnectedAnswered() {
  let connected = 0;
  for (const p of currentSession.players.values()) {
    if (!p.connected) continue;
    connected++;
    if (!currentSession.currentAnswers.has(p.id)) return false;
  }
  return connected > 0;
}

/** Chiusura anticipata: tutti i giocatori connessi hanno risposto. */
function maybeCloseEarly(io) {
  if (
    currentSession &&
    currentSession.state === STATES.QUESTION &&
    allConnectedAnswered()
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
        const player = currentSession.addPlayer(payload?.nickname, payload?.avatarId ?? null);
        const token = randomUUID();
        playerTokens.set(token, player.id);
        socketPlayers.set(socket.id, player.id);
        socket.join(ROOM_PLAYERS);
        ok(cb, { playerId: player.id, token, avatar: player.avatar });
        broadcastLobby(io);
      } catch (err) {
        fail(cb, err.message);
      }
    });

    // Riconnessione: il client presenta il token ricevuto al join/reset e
    // riottiene identità, punteggio e stato corrente della partita.
    socket.on('player:rejoin', (payload, cb) => {
      const token = payload?.token;
      const playerId = token ? playerTokens.get(token) : undefined;
      if (!currentSession || !playerId || !currentSession.players.has(playerId)) {
        return fail(cb, 'Sessione non valida o scaduta.');
      }

      socketPlayers.set(socket.id, playerId);
      socket.join(ROOM_PLAYERS);
      currentSession.setPlayerConnected(playerId, true);
      const player = currentSession.players.get(playerId);

      const data = {
        playerId,
        token,
        nickname: player.nickname,
        avatar: player.avatar,
        score: player.score,
        state: currentSession.state,
        question: null,
        leaderboard: null,
      };
      if (currentSession.state === STATES.QUESTION) {
        data.question = {
          ...currentSession.getCurrentRound(),
          endsAt: currentQuestionEndsAt,
          alreadyAnswered: currentSession.currentAnswers.has(playerId),
        };
      } else if (
        currentSession.state === STATES.RESULTS ||
        currentSession.state === STATES.FINAL_LEADERBOARD
      ) {
        data.leaderboard = currentSession.getLeaderboard();
      }

      ok(cb, data);
      broadcastLobby(io);
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
          total: countConnected(),
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

    // Inserimento manuale di un minigioco ad-hoc (non pianificato in editor),
    // consentito solo mentre l'host guarda i risultati dell'ultimo round.
    socket.on('host:insert-minigame', (payload, cb) => {
      if (!requireHost(cb)) return;
      if (!currentSession) return fail(cb, 'Nessuna partita attiva.');
      try {
        const result = currentSession.insertMinigame(payload?.type);
        ok(cb);
        // insertMinigame ha appena aggiunto un round: non può mai risultare "finished".
        if (!result.finished) emitQuestion(io);
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

      // Identità dei giocatori ancora connessi, dalla sessione uscente.
      const oldIdentities = new Map(); // socket.id -> { nickname, avatar }
      for (const [sockId, playerId] of socketPlayers) {
        const player = currentSession.players.get(playerId);
        if (player) oldIdentities.set(sockId, { nickname: player.nickname, avatar: player.avatar });
      }

      currentSession = new GameSession(currentQuiz);
      socketPlayers.clear();
      playerTokens.clear();

      // Re-registra i giocatori connessi con nuovi id/token e li notifica singolarmente.
      for (const [sockId, identity] of oldIdentities) {
        const playerSocket = io.sockets.sockets.get(sockId);
        if (!playerSocket) continue; // disconnesso nel frattempo
        const player = currentSession.addPlayer(identity.nickname, identity.avatar);
        const token = randomUUID();
        playerTokens.set(token, player.id);
        socketPlayers.set(sockId, player.id);
        playerSocket.emit('game:reset', { playerId: player.id, token });
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

      if (currentSession.state === STATES.LOBBY) {
        // In lobby la rimozione è definitiva: token invalidato.
        for (const [token, pid] of playerTokens) {
          if (pid === playerId) playerTokens.delete(token);
        }
        try {
          currentSession.removePlayer(playerId);
        } catch {
          // Giocatore già rimosso (es. sessione appena riavviata): nessuna azione.
        }
      } else {
        // In partita il giocatore resta (punteggio conservato) in attesa di rejoin.
        try {
          currentSession.setPlayerConnected(playerId, false);
        } catch {
          // Giocatore già rimosso: nessuna azione.
        }
      }
      broadcastLobby(io);
      // Se era l'ultimo che mancava per rispondere, chiudi il round.
      maybeCloseEarly(io);
    });
  });
}

module.exports = { attachGameHandlers };
