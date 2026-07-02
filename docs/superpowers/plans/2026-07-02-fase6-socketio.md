# Fase 6 — Socket.io Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Esporre la state machine di `server/game.js` via Socket.io, con player minimale e cablaggio host, validato da test integrazione automatico.

**Architecture:** Tre livelli — `index.js` (bootstrap, immutato salvo aggancio), nuovo `server/game-socket.js` (rete: eventi, timer reali, auth JWT, ciclo vita sessione singola), `game.js` (state machine pura, immutato). Spec completa: `docs/superpowers/specs/2026-07-02-fase6-socketio-design.md`.

**Tech Stack:** Node.js ≥24, Express 4, Socket.io 4.7, `socket.io-client` (solo dev/test), vanilla JS frontend.

## Global Constraints

- **MAI eseguire `git commit`, `git push` o azioni GitHub** — l'utente committa manualmente. I task NON hanno step di commit.
- Portabilità Raspberry Pi: solo JS puro, zero moduli nativi, nessun percorso Windows-specifico.
- Client Socket.io servito dal server (`/socket.io/socket.io.js`), **mai CDN**.
- Node ≥24 (`node:sqlite` integrato). Test = smoke script in `tools/` stile `test-game.js` (assert + report, niente framework).
- Copy UI in italiano. Stile codice: commenti italiani, header di file con responsabilità, `'use strict'`.
- Una sola partita globale in memoria. JWT host in `socket.handshake.auth.token`, stesso segreto REST (`config.jwtSecret`).

---

### Task 1: Dipendenza dev `socket.io-client` + npm script

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `require('socket.io-client')` disponibile per `tools/test-socket.js` (Task 2); comando `npm run test:socket`.

- [ ] **Step 1: Installa socket.io-client come devDependency**

Run: `npm install --save-dev socket.io-client`
Expected: `package.json` ottiene `"devDependencies": { "socket.io-client": "^4.x" }`, nessun modulo nativo compilato.

- [ ] **Step 2: Aggiungi npm script**

In `package.json`, sezione `scripts`, aggiungi:

```json
"test:socket": "node tools/test-socket.js"
```

- [ ] **Step 3: Verifica**

Run: `node -e "require('socket.io-client'); console.log('ok')"`
Expected: `ok`

---

### Task 2: Test di integrazione `tools/test-socket.js` (failing)

**Files:**
- Create: `tools/test-socket.js`

**Interfaces:**
- Consumes: `server/quiz-manager.js` (`initDb`, `getDb`, `closeDb`), `server/config.js` (`jwtSecret`), `socket.io-client`.
- Produces: il contratto eventi che Task 3 deve implementare (nomi evento e payload esatti sotto).

Il test: crea un DB temporaneo con un quiz precaricato, avvia il server come processo figlio su porta 3123, connette 1 host (JWT) + 2 player + 1 impostore (senza token), gioca una partita completa incluso riavvio, uccide il server, pulisce.

- [ ] **Step 1: Scrivi il test completo**

```javascript
'use strict';

/**
 * tools/test-socket.js
 *
 * Test di integrazione per server/game-socket.js (Step 6).
 * Avvia il server reale come processo figlio su un DB temporaneo,
 * connette host + player via socket.io-client e gioca una partita
 * completa: lobby, domande, risultati, classifica finale, riavvio.
 *
 * Utilizzo: node tools/test-socket.js   (oppure: npm run test:socket)
 */

const os     = require('node:os');
const fs     = require('node:fs');
const path   = require('node:path');
const { spawn } = require('node:child_process');
const jwt    = require('jsonwebtoken');
const { io: ioc } = require('socket.io-client');

const config = require('../server/config');
const db     = require('../server/quiz-manager');

const PORT = 3123;
const URL  = `http://localhost:${PORT}`;

// ─── Report ──────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✅  ${label}`); passed++; }
  else           { console.error(`  ❌  ${label}`); failed++; }
}

// ─── Helpers async ───────────────────────────────────────────────────────────────

/** Attende un singolo evento su un socket, con timeout. */
function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout in attesa di "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

/** Emit con ack promisificato. */
function emitAck(socket, event, payload, timeoutMs = 5000) {
  return socket.timeout(timeoutMs).emitWithAck(event, payload);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Setup DB temporaneo ─────────────────────────────────────────────────────────

const QUIZ_QUESTIONS = [
  { text: 'Capitale d\'Italia?', options: ['Roma', 'Milano', 'Napoli', 'Torino'], correct_index: 0, time_limit_s: 2 },
  { text: '2 + 2?',             options: ['3', '4', '5', '6'],                   correct_index: 1, time_limit_s: 2 },
];

const dbPath = path.join(os.tmpdir(), `quizzata-test-socket-${Date.now()}.sqlite`);

function seedTempDb() {
  db.initDb(dbPath);
  const stmt = db.getDb().prepare(
    'INSERT INTO preloaded_quizzes (title, category, questions) VALUES (?, ?, ?)'
  );
  const result = stmt.run('Quiz Test Socket', 'Test', JSON.stringify(QUIZ_QUESTIONS));
  const quizId = Number(result.lastInsertRowid);
  db.closeDb();
  return quizId;
}

// ─── Avvio server figlio ─────────────────────────────────────────────────────────

function startServer() {
  return spawn(
    process.execPath,
    [path.join(__dirname, '..', 'server', 'index.js')],
    { env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath }, stdio: 'ignore' }
  );
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${URL}/api/health`);
      if (res.ok) return;
    } catch { /* server non ancora pronto */ }
    await sleep(100);
  }
  throw new Error('Il server non ha risposto al health check entro 5 secondi.');
}

// ─── Test ────────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🧪  Quiz-Zata! — Test Integrazione: game-socket.js');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const quizId = seedTempDb();
  const server = startServer();
  const sockets = [];

  try {
    await waitForHealth();
    console.log('  🎬  Server avviato su porta', PORT, '\n');

    const hostToken = jwt.sign(
      { userId: 9999, username: 'test-host' }, config.jwtSecret, { expiresIn: '1h' });

    const host     = ioc(URL, { auth: { token: hostToken } });
    const p1       = ioc(URL);
    const p2       = ioc(URL);
    const impostor = ioc(URL);
    sockets.push(host, p1, p2, impostor);

    await Promise.all([once(host, 'connect'), once(p1, 'connect'),
                       once(p2, 'connect'), once(impostor, 'connect')]);

    // 1. Autorizzazione
    console.log('  🔐  Fase 1: Autorizzazione');
    const denied = await emitAck(impostor, 'host:create-game', { quizId, quizType: 'preloaded' });
    assert(denied.ok === false, 'socket senza token: host:create-game rifiutato');

    const noGame = await emitAck(p1, 'player:join', { nickname: 'Alice' });
    assert(noGame.ok === false, 'player:join senza partita attiva rifiutato');

    // 2. Creazione partita e lobby
    console.log('\n  🎮  Fase 2: Creazione partita e lobby');
    const created = await emitAck(host, 'host:create-game', { quizId, quizType: 'preloaded' });
    assert(created.ok === true, 'host:create-game accettato con JWT valido');

    const badQuiz = await emitAck(host, 'host:create-game', { quizId: 99999, quizType: 'preloaded' });
    assert(badQuiz.ok === false, 'host:create-game con quiz inesistente rifiutato');

    // Ricrea la partita (il tentativo fallito non deve aver lasciato stato sporco)
    await emitAck(host, 'host:create-game', { quizId, quizType: 'preloaded' });

    const joined1 = await emitAck(p1, 'player:join', { nickname: 'Alice' });
    assert(joined1.ok === true && typeof joined1.playerId === 'string', 'Alice entra in lobby');

    const dup = await emitAck(p2, 'player:join', { nickname: 'alice' });
    assert(dup.ok === false, 'nickname duplicato (case-insensitive) rifiutato');

    // Attende che il lobby-update di Alice sia stato consegnato all'host,
    // così la promise successiva cattura solo l'update di Bob (2 giocatori).
    await sleep(200);
    const lobbyPromise = once(host, 'game:lobby-update');
    const joined2 = await emitAck(p2, 'player:join', { nickname: 'Bob' });
    assert(joined2.ok === true, 'Bob entra in lobby');
    const lobby = await lobbyPromise;
    assert(lobby.players.length === 2, 'lobby-update: 2 giocatori');

    // 3. Domanda 1: chiusura anticipata (tutti rispondono)
    console.log('\n  ⏱️  Fase 3: Domanda 1 — chiusura anticipata');
    const q1Promise = once(p1, 'game:question');
    const startAck = await emitAck(host, 'host:start-game', null);
    assert(startAck.ok === true, 'host:start-game accettato');
    const q1 = await q1Promise;
    assert(q1.text === QUIZ_QUESTIONS[0].text, 'game:question: testo domanda 1');
    assert(q1.correct_index === undefined, 'game:question: correct_index MAI inviato');
    assert(typeof q1.endsAt === 'number' && q1.endsAt > Date.now(), 'game:question: endsAt futuro');

    const a1 = await emitAck(p1, 'player:answer', { optionIndex: 0 });
    assert(a1.ok === true && a1.correct === true && a1.pointsAwarded > 0, 'Alice: risposta corretta con punti');

    const again = await emitAck(p1, 'player:answer', { optionIndex: 1 });
    assert(again.ok === false, 'doppia risposta rifiutata');

    const resultsPromise = once(host, 'game:results');
    const closeStart = Date.now();
    const a2 = await emitAck(p2, 'player:answer', { optionIndex: 2 });
    assert(a2.ok === true && a2.correct === false && a2.pointsAwarded === 0, 'Bob: risposta sbagliata, 0 punti');

    const r1 = await resultsPromise;
    assert(Date.now() - closeStart < 1000, 'chiusura anticipata: results subito dopo ultima risposta');
    assert(r1.correctIndex === 0, 'results: correctIndex rivelato');
    assert(r1.distribution[0] === 1 && r1.distribution[2] === 1, 'results: distribuzione corretta');
    assert(r1.leaderboard[0].nickname === 'Alice', 'results: Alice in testa');

    // 4. Domanda 2: chiusura per timeout
    console.log('\n  ⏲️  Fase 4: Domanda 2 — chiusura per timeout');
    const q2Promise = once(p1, 'game:question');
    await emitAck(host, 'host:next-question', null);
    const q2 = await q2Promise;
    assert(q2.index === 1, 'game:question: indice domanda 2');

    await emitAck(p1, 'player:answer', { optionIndex: 1 }); // solo Alice risponde
    const r2 = await once(p2, 'game:results', 4000);        // Bob non risponde → timeout 2s
    assert(r2.correctIndex === 1, 'results dopo timeout: correctIndex domanda 2');
    assert(r2.distribution[1] === 1, 'results dopo timeout: solo 1 risposta registrata');

    // 5. Classifica finale
    console.log('\n  🏆  Fase 5: Classifica finale');
    const finalPromise = once(p1, 'game:final');
    await emitAck(host, 'host:next-question', null);
    const final = await finalPromise;
    assert(final.leaderboard.length === 2, 'game:final: classifica con 2 giocatori');
    assert(final.leaderboard[0].nickname === 'Alice', 'game:final: Alice vince');
    assert(final.leaderboard[0].score > final.leaderboard[1].score, 'game:final: punteggi ordinati');

    // 6. Riavvio partita
    console.log('\n  🔄  Fase 6: Riavvio partita');
    const resetPromise = once(p1, 'game:reset');
    const lobbyAfterResetPromise = once(host, 'game:lobby-update');
    const restartAck = await emitAck(host, 'host:restart-game', null);
    assert(restartAck.ok === true, 'host:restart-game accettato da FINAL_LEADERBOARD');

    const reset = await resetPromise;
    assert(typeof reset.playerId === 'string' && reset.playerId !== joined1.playerId,
      'game:reset: nuovo playerId per Alice');

    const lobbyAfterReset = await lobbyAfterResetPromise;
    assert(lobbyAfterReset.players.length === 2, 'dopo riavvio: 2 giocatori in lobby');
    assert(lobbyAfterReset.players.every((p) => p.score === 0), 'dopo riavvio: punteggi azzerati');

    const restartAgain = await emitAck(host, 'host:restart-game', null);
    assert(restartAgain.ok === false, 'host:restart-game fuori da FINAL_LEADERBOARD rifiutato');

    // 7. Fine partita
    console.log('\n  🛑  Fase 7: Fine partita');
    const endedPromise = once(p1, 'game:ended');
    await emitAck(host, 'host:end-game', null);
    await endedPromise;
    assert(true, 'game:ended ricevuto dai player');

  } finally {
    for (const s of sockets) s.disconnect();
    server.kill();
    await sleep(300);
    try {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    } catch { /* best effort */ }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Risultato: ${passed} superati, ${failed} falliti`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('\n  💥  Test interrotto:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Esegui il test — deve fallire**

Run: `npm run test:socket`
Expected: FAIL — timeout o ack mancanti (il server non gestisce ancora `host:create-game` ecc.). Il processo esce con codice ≠ 0. Se fallisce per `JWT_SECRET` mancante, verificare che `.env` esista a root con `JWT_SECRET` valorizzato.

---

### Task 3: `server/game-socket.js` + aggancio in `index.js`

**Files:**
- Create: `server/game-socket.js`
- Modify: `server/index.js:129` (rimuovere il commento `// TODO (Step 6)` dentro il connection handler; aggiungere l'aggancio dopo il blocco, riga 130)

**Interfaces:**
- Consumes: `GameSession`, `STATES` da `server/game.js`; `getQuizById`, `getPreloadedQuizById` da `server/quiz-manager.js`; `config.jwtSecret`.
- Produces: `attachGameHandlers(io)` — unico export. Eventi server→client: `game:lobby-update {players}`, `game:question {index,total,text,options,time_limit_s,endsAt}`, `game:results` (output `endQuestion()`), `game:final {leaderboard}`, `game:reset {playerId}` (per-socket), `game:answer-count {answered,total}` (solo host), `game:ended`, `game:snapshot` (output `getSnapshot()`).

- [ ] **Step 1: Crea `server/game-socket.js`**

```javascript
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

      // Un'eventuale partita precedente viene sostituita.
      destroySession();
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
      io.to(ROOM_PLAYERS).emit('game:ended');
      for (const sockId of socketPlayers.keys()) {
        io.sockets.sockets.get(sockId)?.disconnect(true);
      }
      destroySession();
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
```

- [ ] **Step 2: Aggancia in `server/index.js`**

(a) In testa al file, dopo `const playerRouter = require('./routes/player');`, aggiungere:

```javascript
const { attachGameHandlers } = require('./game-socket');
```

(b) Rimuovere la riga 129 (`  // TODO (Step 6): agganciare qui gli handler di gioco tramite game.js`) dentro il connection handler.

(c) Dopo la chiusura del blocco `io.on('connection', ...)` (riga 130, `});`), aggiungere:

```javascript
// ─── Handler di gioco (Step 6) ───────────────────────────────────────────────
// Secondo listener 'connection' sullo stesso io: Socket.io li esegue entrambi.
// Il bootstrap (log, ping/pong) resta qui sopra; la logica di gioco vive in
// game-socket.js.
attachGameHandlers(io);
```

- [ ] **Step 3: Esegui il test — deve passare**

Run: `npm run test:socket`
Expected: PASS — tutte le verifiche superate, exit code 0.

- [ ] **Step 4: Regressione state machine**

Run: `node tools/test-game.js`
Expected: 37/37 verifiche superate (game.js non è stato toccato).

---

### Task 4: Player minimale (`client/player/`)

**Files:**
- Modify: `client/player/index.html` (riscrittura completa)
- Modify: `client/player/app.js` (riscrittura completa)

**Interfaces:**
- Consumes: eventi Socket.io di Task 3 (`player:join`, `player:answer` con ack; `game:lobby-update`, `game:question`, `game:results`, `game:final`, `game:reset`, `game:ended`, `game:snapshot`).
- Produces: client giocatore funzionante a `http://localhost:3000/`. Zero design (→ Fase 7).

- [ ] **Step 1: Riscrivi `client/player/index.html`**

```html
<!DOCTYPE html>
<html lang="it">
<head>
  <link rel="icon" type="image/svg+xml" href="/resources/img/Logo.svg">
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="description" content="Quiz-Zata! — Unisciti alla partita dal tuo smartphone.">
  <title>Quiz-Zata! — Gioca</title>
  <!--
    Step 6: client MINIMALE per il test E2E. Zero design di proposito:
    l'interfaccia mobile definitiva arriva in Step 7 sopra questa stessa logica.
  -->
  <style>
    body { font-family: system-ui, sans-serif; margin: 1rem; background: #0f0f1a; color: #e0e0ff; }
    button { display: block; width: 100%; padding: 1rem; margin: 0.5rem 0; font-size: 1.1rem; }
    input { width: 100%; padding: 0.8rem; font-size: 1.1rem; box-sizing: border-box; }
    .error { color: #ff6b6b; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <h1>Quiz-Zata!</h1>

  <section id="screen-join">
    <p>Inserisci il tuo nickname per entrare:</p>
    <input id="nickname-input" maxlength="20" placeholder="Nickname" autocomplete="off">
    <button id="join-btn">Entra</button>
    <p id="join-error" class="error" hidden></p>
  </section>

  <section id="screen-lobby" hidden>
    <p>Sei dentro! In attesa che l'host avvii la partita…</p>
    <ul id="lobby-players"></ul>
  </section>

  <section id="screen-question" hidden>
    <p id="question-progress"></p>
    <p id="question-text"></p>
    <p>Tempo: <span id="question-countdown"></span>s</p>
    <div id="answer-buttons"></div>
    <p id="answer-sent" hidden>Risposta inviata. Attendi i risultati…</p>
  </section>

  <section id="screen-feedback" hidden>
    <p id="feedback-text"></p>
    <p>Il tuo punteggio: <span id="feedback-score"></span></p>
    <p>In attesa della prossima domanda…</p>
  </section>

  <section id="screen-final" hidden>
    <h2>Classifica finale</h2>
    <ol id="final-leaderboard"></ol>
    <p>Grazie per aver giocato!</p>
  </section>

  <section id="screen-message" hidden>
    <p id="message-text"></p>
  </section>

  <script src="/socket.io/socket.io.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Riscrivi `client/player/app.js`**

```javascript
'use strict';

/**
 * client/player/app.js
 *
 * Step 6: logica giocatore MINIMALE (zero design → Step 7).
 * Gestisce: join con nickname, lobby, risposta alle domande con countdown,
 * feedback, classifica finale, riavvio partita.
 */

/* global io */

const socket = io();

let playerId = null;
let countdownInterval = null;

// ─── Riferimenti DOM ─────────────────────────────────────────────────────────

const screens = {
  join:     document.getElementById('screen-join'),
  lobby:    document.getElementById('screen-lobby'),
  question: document.getElementById('screen-question'),
  feedback: document.getElementById('screen-feedback'),
  final:    document.getElementById('screen-final'),
  message:  document.getElementById('screen-message'),
};

const nicknameInput     = document.getElementById('nickname-input');
const joinBtn           = document.getElementById('join-btn');
const joinError         = document.getElementById('join-error');
const lobbyPlayers      = document.getElementById('lobby-players');
const questionProgress  = document.getElementById('question-progress');
const questionText      = document.getElementById('question-text');
const questionCountdown = document.getElementById('question-countdown');
const answerButtons     = document.getElementById('answer-buttons');
const answerSent        = document.getElementById('answer-sent');
const feedbackText      = document.getElementById('feedback-text');
const feedbackScore     = document.getElementById('feedback-score');
const finalLeaderboard  = document.getElementById('final-leaderboard');
const messageText       = document.getElementById('message-text');

/** Mostra una sola schermata alla volta. */
function show(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.hidden = key !== name;
  }
}

function showMessage(text) {
  messageText.textContent = text;
  show('message');
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

// ─── Join ────────────────────────────────────────────────────────────────────

joinBtn.addEventListener('click', () => {
  const nickname = nicknameInput.value.trim();
  if (!nickname) {
    joinError.textContent = 'Inserisci un nickname.';
    joinError.hidden = false;
    return;
  }
  socket.emit('player:join', { nickname }, (res) => {
    if (!res.ok) {
      joinError.textContent = res.error;
      joinError.hidden = false;
      return;
    }
    playerId = res.playerId;
    joinError.hidden = true;
    show('lobby');
  });
});

nicknameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

// ─── Eventi di gioco ─────────────────────────────────────────────────────────

socket.on('game:lobby-update', ({ players }) => {
  lobbyPlayers.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.textContent = p.nickname;
    lobbyPlayers.appendChild(li);
  }
});

socket.on('game:question', (q) => {
  if (!playerId) return; // non ancora in partita
  stopCountdown();

  questionProgress.textContent = `Domanda ${q.index + 1} di ${q.total}`;
  questionText.textContent = q.text;
  answerSent.hidden = true;
  answerButtons.innerHTML = '';

  q.options.forEach((option, i) => {
    const btn = document.createElement('button');
    btn.textContent = option;
    btn.addEventListener('click', () => {
      socket.emit('player:answer', { optionIndex: i }, (res) => {
        if (!res.ok) {
          answerSent.textContent = res.error;
        } else {
          answerSent.textContent = 'Risposta inviata. Attendi i risultati…';
        }
        answerButtons.innerHTML = '';
        answerSent.hidden = false;
      });
    });
    answerButtons.appendChild(btn);
  });

  // Countdown basato su endsAt (timestamp assoluto dal server)
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((q.endsAt - Date.now()) / 1000));
    questionCountdown.textContent = remaining;
    if (remaining === 0) stopCountdown();
  };
  tick();
  countdownInterval = setInterval(tick, 250);

  show('question');
});

socket.on('game:results', (results) => {
  if (!playerId) return;
  stopCountdown();

  const mine = results.answers.find((a) => a.playerId === playerId);
  if (!mine) {
    feedbackText.textContent = 'Tempo scaduto! Non hai risposto. +0 punti';
  } else if (mine.correct) {
    feedbackText.textContent = `Giusto! +${mine.pointsAwarded} punti`;
  } else {
    feedbackText.textContent = 'Sbagliato! +0 punti';
  }

  const me = results.leaderboard.find((p) => p.id === playerId);
  feedbackScore.textContent = me ? me.score : '—';
  show('feedback');
});

socket.on('game:final', ({ leaderboard }) => {
  if (!playerId) return;
  stopCountdown();
  finalLeaderboard.innerHTML = '';
  for (const p of leaderboard) {
    const li = document.createElement('li');
    li.textContent = `${p.nickname} — ${p.score} punti`;
    finalLeaderboard.appendChild(li);
  }
  show('final');
});

socket.on('game:reset', ({ playerId: newId }) => {
  playerId = newId;
  show('lobby');
});

socket.on('game:ended', () => {
  playerId = null;
  stopCountdown();
  showMessage('L\'host ha terminato la partita. Ricarica la pagina per giocare di nuovo.');
});

socket.on('disconnect', () => {
  if (playerId) {
    stopCountdown();
    showMessage('Connessione persa. Ricarica la pagina.');
  }
});
```

- [ ] **Step 3: Verifica manuale rapida**

Avviare il server (preview su porta 3000), aprire `http://localhost:3000/`:
- Senza partita attiva: join → errore "Nessuna partita attiva." visibile sotto il form.
- Console browser senza errori.

---

### Task 5: Cablaggio host (schermata game)

**Files:**
- Modify: `client/host/index.html:316-339` (area status/controlli della view game), riga 302 (id timer), riga 347 (script socket.io)
- Modify: `client/host/app.js:901-938` (sezione 9: GAME PLACEHOLDER MODULE → GAME MODULE)

**Interfaces:**
- Consumes: eventi host di Task 3 (`host:create-game`, `host:start-game`, `host:next-question`, `host:restart-game`, `host:end-game` con ack; broadcast `game:*`). Da app.js esistente: `state.token`, `showToast`, `showModal`, `showView`, `escapeHtml`.
- Produces: conduzione partita funzionante dalla schermata game esistente.

- [ ] **Step 1: Aggiorna `client/host/index.html`**

(a) Prima di `<script src="app.js"></script>` (riga 347) aggiungere:

```html
  <script src="/socket.io/socket.io.js"></script>
```

(b) Aggiungere `id="game-timer-badge"` al timer esistente (riga 302):

```html
          <div class="game-timer-badge" id="game-timer-badge">00:00</div>
```

(c) Sostituire il blocco righe 316–339 (da `<div id="game-status-note"...` fino alla chiusura di `.game-controls-grid` inclusa) con:

```html
            <div id="game-status-note" class="game-status-note" role="status">
              <i class="fas fa-hourglass-half" aria-hidden="true"></i>
              <span id="game-status-text">Connessione al server di gioco…</span>
            </div>

            <!-- Area live (Step 6, markup minimale — design in Step 7) -->
            <div id="game-live-area">
              <div id="game-lobby-box" hidden>
                <h3>Giocatori in lobby (<span id="game-player-count">0</span>)</h3>
                <ul id="game-players-list"></ul>
              </div>
              <div id="game-question-box" hidden>
                <h3 id="game-question-text"></h3>
                <p id="game-answer-count">Risposte: 0 / 0</p>
              </div>
              <div id="game-results-box" hidden>
                <h3>Risultati</h3>
                <p id="game-correct-answer"></p>
                <ul id="game-distribution"></ul>
              </div>
              <div id="game-final-box" hidden>
                <h3>Classifica finale</h3>
                <ol id="game-final-leaderboard"></ol>
              </div>
            </div>

            <div class="game-controls-grid">
              <button id="game-start-btn" class="btn-game-control btn-game-primary btn-start-game btn-game-primary--dominant" disabled>
                <span class="material-symbols-outlined">play_arrow</span> Avvia Partita
              </button>
              <div class="game-controls-secondary">
                <button id="game-next-btn" class="btn-game-control btn-game-secondary" disabled>
                  <span class="material-symbols-outlined">skip_next</span> Prossima Domanda
                </button>
                <button id="game-restart-btn" class="btn-game-control btn-game-tertiary" disabled>
                  <span class="material-symbols-outlined">replay</span> Riavvia Partita
                </button>
              </div>
              <button id="game-back-btn-2" class="btn-game-control btn-game-danger btn-game-danger--demoted">
                <span class="material-symbols-outlined">close</span> Termina Partita
              </button>
            </div>
```

- [ ] **Step 2: Riscrivi la sezione 9 di `client/host/app.js`**

(a) Sotto `'use strict';` (riga 19) aggiungere:

```javascript
/* global io */
```

(b) Sostituire l'intera sezione `9. GAME PLACEHOLDER MODULE` (righe 901–938: dal commento di sezione fino al listener di `game-back-btn-2` incluso) con:

```javascript
/* ═══════════════════════════════════════════════════════════════════════════
   9. GAME MODULE (Step 6 — cablaggio minimo, design in Step 7)
   ═══════════════════════════════════════════════════════════════════════════ */

const gameQuizTitle     = document.getElementById('game-quiz-title');
const gameQuestionCount = document.getElementById('game-question-count');
const gameTypeBadge     = document.getElementById('game-type-badge');
const gameStatusText    = document.getElementById('game-status-text');
const gameTimerBadge    = document.getElementById('game-timer-badge');

const gameLobbyBox         = document.getElementById('game-lobby-box');
const gamePlayerCount      = document.getElementById('game-player-count');
const gamePlayersList      = document.getElementById('game-players-list');
const gameQuestionBox      = document.getElementById('game-question-box');
const gameQuestionText     = document.getElementById('game-question-text');
const gameAnswerCount      = document.getElementById('game-answer-count');
const gameResultsBox       = document.getElementById('game-results-box');
const gameCorrectAnswer    = document.getElementById('game-correct-answer');
const gameDistribution     = document.getElementById('game-distribution');
const gameFinalBox         = document.getElementById('game-final-box');
const gameFinalLeaderboard = document.getElementById('game-final-leaderboard');

const gameStartBtn   = document.getElementById('game-start-btn');
const gameNextBtn    = document.getElementById('game-next-btn');
const gameRestartBtn = document.getElementById('game-restart-btn');

let gameSocket = null;
let gameCountdownInterval = null;
let currentQuestionOptions = [];

/** Mostra un solo box dell'area live alla volta. */
function showGameBox(box) {
  for (const el of [gameLobbyBox, gameQuestionBox, gameResultsBox, gameFinalBox]) {
    el.hidden = el !== box;
  }
}

function stopGameCountdown() {
  if (gameCountdownInterval) {
    clearInterval(gameCountdownInterval);
    gameCountdownInterval = null;
  }
  gameTimerBadge.textContent = '00:00';
}

function startGameCountdown(endsAt) {
  stopGameCountdown();
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    const m = String(Math.floor(remaining / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    gameTimerBadge.textContent = `${m}:${s}`;
    if (remaining === 0) stopGameCountdown();
  };
  tick();
  gameCountdownInterval = setInterval(tick, 250);
}

/**
 * Apre la schermata di conduzione partita e crea la sessione sul server.
 * @param {object} quiz
 * @param {'personal'|'preloaded'} type
 */
function openGame(quiz, type) {
  state.currentQuiz = quiz;

  const count = Array.isArray(quiz.questions) ? quiz.questions.length : 0;

  gameQuizTitle.textContent     = quiz.title;
  gameQuestionCount.textContent = `${count} domand${count === 1 ? 'a' : 'e'}`;
  gameTypeBadge.innerHTML = type === 'preloaded'
    ? `<span aria-hidden="true"><i class="fas fa-star"></i></span> <span>Sistema${quiz.category ? ` · ${escapeHtml(quiz.category)}` : ''}</span>`
    : `<span aria-hidden="true"><i class="fas fa-wand-magic-sparkles"></i></span> <span>Personale</span>`;

  connectGameSocket(quiz, type);
  showView('game');
}

function connectGameSocket(quiz, type) {
  disconnectGameSocket();

  gameSocket = io('/', { auth: { token: state.token } });

  gameSocket.on('connect', () => {
    gameSocket.emit('host:create-game', { quizId: quiz.id, quizType: type }, (res) => {
      if (!res.ok) {
        showToast(res.error, 'error');
        gameStatusText.textContent = `Errore: ${res.error}`;
        return;
      }
      gameStatusText.textContent = 'Lobby aperta: i giocatori possono entrare dal telefono.';
      renderGameLobby([]);
    });
  });

  gameSocket.on('game:lobby-update', ({ players }) => renderGameLobby(players));

  gameSocket.on('game:question', (q) => {
    currentQuestionOptions = q.options;
    gameStatusText.textContent = `Domanda ${q.index + 1} di ${q.total} in corso…`;
    gameQuestionText.textContent = q.text;
    gameAnswerCount.textContent = 'Risposte: 0 / ?';
    startGameCountdown(q.endsAt);
    showGameBox(gameQuestionBox);
    gameStartBtn.disabled = true;
    gameNextBtn.disabled = true;
    gameRestartBtn.disabled = true;
  });

  gameSocket.on('game:answer-count', ({ answered, total }) => {
    gameAnswerCount.textContent = `Risposte: ${answered} / ${total}`;
  });

  gameSocket.on('game:results', (results) => {
    stopGameCountdown();
    gameStatusText.textContent = 'Round chiuso: risultati sul tabellone.';
    gameCorrectAnswer.textContent =
      `Risposta corretta: ${currentQuestionOptions[results.correctIndex] ?? '—'}`;

    gameDistribution.innerHTML = '';
    results.distribution.forEach((n, i) => {
      const li = document.createElement('li');
      li.textContent = `${currentQuestionOptions[i] ?? `Opzione ${i + 1}`}: ${n} rispost${n === 1 ? 'a' : 'e'}`;
      gameDistribution.appendChild(li);
    });

    showGameBox(gameResultsBox);
    gameNextBtn.disabled = false;
  });

  gameSocket.on('game:final', ({ leaderboard }) => {
    stopGameCountdown();
    gameStatusText.textContent = 'Partita conclusa!';
    gameFinalLeaderboard.innerHTML = '';
    for (const p of leaderboard) {
      const li = document.createElement('li');
      li.textContent = `${p.nickname} — ${p.score} punti`;
      gameFinalLeaderboard.appendChild(li);
    }
    showGameBox(gameFinalBox);
    gameNextBtn.disabled = true;
    gameRestartBtn.disabled = false;
  });

  gameSocket.on('connect_error', () => {
    gameStatusText.textContent = 'Connessione al server di gioco fallita.';
    showToast('Connessione al server di gioco fallita.', 'error');
  });
}

function disconnectGameSocket() {
  stopGameCountdown();
  if (gameSocket) {
    gameSocket.disconnect();
    gameSocket = null;
  }
}

function renderGameLobby(players) {
  gamePlayerCount.textContent = players.length;
  gamePlayersList.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.textContent = p.nickname;
    gamePlayersList.appendChild(li);
  }
  showGameBox(gameLobbyBox);
  gameStartBtn.disabled = players.length === 0;
}

// ─── Controlli host ──────────────────────────────────────────────────────────

// NB: payload sempre presente (null) prima dell'ack — firma server (_payload, cb).
gameStartBtn.addEventListener('click', () => {
  gameSocket?.emit('host:start-game', null, (res) => {
    if (!res.ok) showToast(res.error, 'error');
  });
});

gameNextBtn.addEventListener('click', () => {
  gameSocket?.emit('host:next-question', null, (res) => {
    if (!res.ok) showToast(res.error, 'error');
  });
});

gameRestartBtn.addEventListener('click', () => {
  gameSocket?.emit('host:restart-game', null, (res) => {
    if (!res.ok) { showToast(res.error, 'error'); return; }
    gameStatusText.textContent = 'Partita riavviata: giocatori di nuovo in lobby.';
    gameStartBtn.disabled = false;
    gameRestartBtn.disabled = true;
  });
});

document.getElementById('game-back-btn-2').addEventListener('click', () => {
  showModal({
    title: 'Termina partita',
    message: 'Vuoi davvero terminare la partita e tornare alla dashboard? I giocatori collegati verranno disconnessi.',
    icon: '<i class="fas fa-triangle-exclamation"></i>',
    confirmLabel: 'Termina partita',
    onConfirm: () => {
      gameSocket?.emit('host:end-game', null, () => {});
      disconnectGameSocket();
      showView('dashboard');
    },
  });
});
```

- [ ] **Step 3: Verifica sintassi**

Run: `npm run lint`
Expected: nessun nuovo errore ESLint su `client/host/app.js` e `client/player/app.js`.

- [ ] **Step 4: Regressione test socket**

Run: `npm run test:socket`
Expected: PASS (il backend non è cambiato, conferma che nulla si è rotto).

---

### Task 6: Verifica E2E + aggiornamento roadmap e spec

**Files:**
- Modify: `DEV_ROADMAP.md:49-53` (spunta checkbox Fase 6)
- Modify: `docs/superpowers/specs/2026-07-02-fase6-socketio-design.md` (allineare protocollo: `game:reset {playerId}` per-socket, aggiunta `game:answer-count`)

**Interfaces:**
- Consumes: tutto quanto sopra.
- Produces: Fase 6 chiusa e documentata.

- [ ] **Step 1: E2E con preview**

1. Avviare il server con preview (porta 3000).
2. Aprire `/admin-console`, login, scegliere un quiz, "Avvia" → schermata game, lobby aperta.
3. In una seconda pagina aprire `/` (player), inserire nickname, verificare che compaia nella lobby host.
4. Avvia Partita → il player vede la domanda coi bottoni; rispondere → host vede conteggio; alla chiusura entrambi vedono risultati.
5. Prossima Domanda fino alla classifica finale; Riavvia Partita → player torna in lobby; Termina Partita → player vede messaggio di fine.
6. Console browser e log server senza errori.

- [ ] **Step 2: Aggiorna la spec**

Nella tabella "Server → Client" della spec: `game:reset` diventa payload `{ playerId }` inviato per-socket (seguito da `game:lobby-update` broadcast); aggiungere riga `game:answer-count` `{ answered, total }` — solo room host, dopo ogni risposta valida.

- [ ] **Step 3: Spunta la roadmap**

In `DEV_ROADMAP.md`, Fase 6: marcare `[x]` le quattro voci e aggiungere in coda alla sezione la nota:

```markdown
  *(Implementato in `server/game-socket.js` (una partita globale, timer server con chiusura anticipata, auth host JWT su handshake). Riavvio da FINAL_LEADERBOARD: nuova `GameSession` lato socket, `game.js` immutato. Test integrazione: `npm run test:socket`.)*
```

- [ ] **Step 4: Test finale completo**

Run: `node tools/test-game.js && npm run test:socket`
Expected: entrambi PASS. **Non committare** — segnalare all'utente che la Fase 6 è pronta per la sua revisione.
