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
const testBots = require('./test-bots');

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
/** Istante assoluto da cui la domanda corrente accetta risposte, per il rejoin. */
let currentAnswersOpenAt = null;
/**
 * Giocatori finti della sessione corrente (vedi server/test-bots.js). Non hanno
 * socket: esistono solo dentro la GameSession, e rispondono da qui.
 * @type {Set<string>} playerId
 */
const botPlayers = new Set();
/** Handle dei setTimeout con cui i bot rispondono alla domanda corrente. */
let botTimers = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────────

function clearQuestionTimer() {
  if (questionTimer) {
    clearTimeout(questionTimer);
    questionTimer = null;
  }
  // Le risposte dei bot appartengono alla domanda che sta chiudendo: una in
  // ritardo arriverebbe sul round successivo.
  for (const t of botTimers) clearTimeout(t);
  botTimers = [];
}

function destroySession() {
  clearQuestionTimer();
  currentSession = null;
  currentQuiz = null;
  socketPlayers.clear();
  playerTokens.clear();
  botPlayers.clear();
  currentQuestionEndsAt = null;
  currentAnswersOpenAt = null;
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
 * Aggiunge `count` giocatori finti alla sessione corrente.
 * Usato dal gesto nascosto e dal riavvio, che li rimette in campo.
 * @returns {number} quanti ne sono entrati davvero
 */
function spawnBots(count) {
  let entrati = 0;
  for (let i = 0; i < count; i++) {
    const { nickname, avatar } = testBots.identity(i);
    try {
      const player = currentSession.addPlayer(nickname, avatar);
      botPlayers.add(player.id);
      entrati++;
    } catch {
      // Nickname già preso da una persona vera: si salta e si va avanti.
    }
  }
  return entrati;
}

/**
 * Trasmette la domanda corrente (sanitizzata) e arma il timer di chiusura.
 * `endsAt` è un timestamp assoluto: i client calcolano il countdown da lì,
 * così la latenza di rete non desincronizza i timer.
 */
function emitQuestion(io) {
  const q = currentSession.getCurrentRound();
  const now = Date.now();
  // Un minigioco con anteprima (es. i bicchieri da seguire) mostra prima lo
  // spettacolo e solo dopo apre le risposte: il tempo per rispondere parte da
  // `answersOpenAt`, non dall'apertura del round.
  const answersOpenAt = now + q.previewMs;
  const endsAt = answersOpenAt + q.time_limit_s * 1000;
  currentQuestionEndsAt = endsAt;
  currentAnswersOpenAt = answersOpenAt;
  // `serverNow` viaggia insieme a `endsAt`: da soli, due orologi distanti
  // fanno scadere il tempo in sala e sul telefono in momenti diversi.
  // Vedi client/shared/server-clock.js.
  const payload = { ...q, answersOpenAt, endsAt, serverNow: now };

  // L'anteprima porta l'esito (dove finisce la pallina): la sala e l'host ne
  // hanno bisogno per metterla in scena, i telefoni no — leggerla dal payload
  // vorrebbe dire conoscere la risposta. Per questo si manda a tutti TRANNE la
  // room dei giocatori. La sala non entra mai in quella room, l'host nemmeno.
  const preview = currentSession.getRoundPreview();
  if (preview) {
    io.to(ROOM_PLAYERS).emit('game:question', payload);
    io.except(ROOM_PLAYERS).emit('game:question', { ...payload, preview });
  } else {
    io.emit('game:question', payload);
  }

  clearQuestionTimer();
  questionTimer = setTimeout(() => closeQuestion(io), endsAt - now);
  scheduleBotAnswers(io, q);
}

/**
 * Fa rispondere i giocatori finti, se ce ne sono.
 *
 * Ogni bot passa esattamente per la stessa porta di un umano — `submitAnswer`,
 * poi il conteggio risposte e la chiusura anticipata — perché un bot che
 * scrivesse nella sessione per una via tutta sua proverebbe un gioco che non
 * esiste. La sola differenza è che non c'è un socket a monte.
 */
function scheduleBotAnswers(io, round) {
  if (botPlayers.size === 0) return;
  const optionCount = round.options?.length ?? 0;

  for (const playerId of botPlayers) {
    // Come un umano, un bot non può rispondere durante l'anteprima.
    const delay = round.previewMs + testBots.answerDelayMs(round.time_limit_s);
    botTimers.push(setTimeout(() => {
      if (!currentSession || currentSession.state !== STATES.QUESTION) return;
      try {
        currentSession.submitAnswer(playerId, testBots.pickOption(optionCount));
      } catch {
        // Round già chiuso o bot non più in partita: non c'è nulla da fare.
        return;
      }
      io.to(ROOM_HOST).emit('game:answer-count', {
        answered: currentSession.currentAnswers.size,
        total: countConnected(),
      });
      maybeCloseEarly(io);
    }, delay));
  }
}

/** Chiude la domanda corrente (timeout o anticipata) e trasmette i risultati. */
function closeQuestion(io) {
  clearQuestionTimer();
  if (!currentSession || currentSession.state !== STATES.QUESTION) return;
  const results = currentSession.endQuestion();
  // Sospensione post-chiusura (es. la ruota della Morra Cinese): come per `endsAt`,
  // si trasmette un timestamp assoluto così sala e telefoni fanno atterrare il
  // reveal nello stesso istante nonostante la latenza di rete.
  results.serverNow = Date.now();
  if (results.revealMs > 0) {
    results.revealAt = results.serverNow + results.revealMs;
  }
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
        // Chi rientra fra l'ultima domanda e la premiazione non deve leggere
        // la propria posizione: la scoprirà dalla cerimonia, come tutti.
        isLastRound: false,
      };
      if (currentSession.state === STATES.QUESTION) {
        data.question = {
          ...currentSession.getCurrentRound(),
          answersOpenAt: currentAnswersOpenAt,
          endsAt: currentQuestionEndsAt,
          serverNow: Date.now(),
          alreadyAnswered: currentSession.currentAnswers.has(playerId),
        };
      } else if (
        currentSession.state === STATES.RESULTS ||
        currentSession.state === STATES.FINAL_LEADERBOARD
      ) {
        data.leaderboard = currentSession.getLeaderboard();
        data.isLastRound =
          currentSession.state === STATES.RESULTS && currentSession.isLastRound;
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

      // I bot rientrano: il loro motivo di esistere è provare la partita più
      // volte di fila, e rifare il gesto a ogni giro sarebbe una seccatura
      // proprio nel caso d'uso che li giustifica.
      const quantiBot = botPlayers.size;
      botPlayers.clear();
      if (quantiBot > 0) spawnBots(quantiBot);

      ok(cb);
      broadcastLobby(io);
    });

    /**
     * Gesto nascosto del pannello host (dieci clic sul logo): riempie la lobby
     * di giocatori finti per poter provare una partita — e soprattutto la
     * premiazione — senza radunare venti persone.
     *
     * Solo dalla LOBBY: a partita iniziata nessuno entra più, e i bot non
     * possono essere l'eccezione che prova un gioco diverso da quello vero.
     */
    socket.on('host:spawn-bots', (payload, cb) => {
      if (!requireHost(cb)) return;
      if (!currentSession) return fail(cb, 'Nessuna partita attiva.');
      if (currentSession.state !== STATES.LOBBY) {
        return fail(cb, 'I giocatori di prova si aggiungono solo dalla lobby.');
      }

      const count = testBots.normalizeCount(payload?.count);
      const added = spawnBots(count);
      broadcastLobby(io);
      ok(cb, { added, total: currentSession.getPlayers().length });
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
