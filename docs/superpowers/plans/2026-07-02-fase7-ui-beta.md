# Fase 7 — Rifinitura UI, Riconnessione e Beta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portare Quiz-Zata! alla Beta giocabile: UI Player mobile-first definitiva, riconnessione player con punteggio, schermata conduzione Host rifinita con QR code.

**Architecture:** La state machine pura (`server/game.js`) guadagna avatar e flag `connected`; il layer di rete (`server/game-socket.js`) aggiunge token di sessione e `player:rejoin`; i client restano SPA vanilla senza build. Spec approvata: `docs/superpowers/specs/2026-07-02-fase7-ui-beta-design.md`.

**Tech Stack:** Node.js v24+, Express 4, Socket.io 4, vanilla JS/CSS, `qrcode-generator` (file vendored, MIT).

## Global Constraints

- Node.js >= 24, zero moduli nativi, zero build step, zero nuove dipendenze npm runtime.
- `server/game.js` resta puro: nessun timer reale, nessuna dipendenza da rete/Socket.io/DB.
- Design system "Retro Street" (DESIGN.md): bordi Ink `#201b0d` 3-4px, ombre offset senza blur, Quicksand peso minimo 700, palette satura, WCAG AA, `prefers-reduced-motion` rispettato, niente clone Kahoot, niente side-stripe colorati.
- Avatar: id stabili lato server, resa emoji SOLO client-side (mappa sostituibile con SVG in futuro).
- Test esistenti non devono regredire: `node tools/test-game.js` e `npm run test:socket` sempre verdi a fine task.
- Lingua UI e commenti: italiano, stile dei file esistenti.
- Commit a fine task (autorizzati dall'utente per l'esecuzione di questo piano — in ogni altro contesto vale la regola "nessun commit senza richiesta").

---

### Task 1: `game.js` — avatar e flag `connected`

**Files:**
- Modify: `server/game.js`
- Test: `tools/test-game.js` (estendere)

**Interfaces:**
- Produces: `AVATAR_IDS` (array frozen di 12 stringhe), `InvalidAvatarError`, `addPlayer(nickname, avatarId = null)` → player `{ id, nickname, avatar, score, connected }`, `setPlayerConnected(playerId, connected)`, leaderboard entries con campo `avatar`.
- Consumes: nulla di nuovo.

- [ ] **Step 1: Scrivere i test che falliscono**

In `tools/test-game.js`: aggiungere `AVATAR_IDS` e `InvalidAvatarError` al require in testa, poi aggiungere in coda a `run()` (prima del report finale):

```js
// 8. Avatar e connessione (Fase 7)
console.log('\n  🦊  Fase 8: Avatar e connessione');
const g8 = new GameSession(QUIZ);
assert(Array.isArray(AVATAR_IDS) && AVATAR_IDS.length === 12, 'AVATAR_IDS: 12 avatar precaricati');
assert(Object.isFrozen(AVATAR_IDS), 'AVATAR_IDS: lista immutabile');

const pA = g8.addPlayer('Alice', 'volpe');
assert(pA.avatar === 'volpe', 'addPlayer: avatar scelto registrato');
assert(pA.connected === true, 'addPlayer: player nasce connesso');

const pB = g8.addPlayer('Bob');
assert(AVATAR_IDS.includes(pB.avatar), 'addPlayer senza avatar: assegnato un avatar valido');

assertThrows(() => g8.addPlayer('Carl', 'dinosauro'), InvalidAvatarError,
  'addPlayer: avatar sconosciuto lancia InvalidAvatarError');

g8.setPlayerConnected(pA.id, false);
assert(g8.players.get(pA.id).connected === false, 'setPlayerConnected(false) applicato');
g8.setPlayerConnected(pA.id, true);
assert(g8.players.get(pA.id).connected === true, 'setPlayerConnected(true) applicato');
assertThrows(() => g8.setPlayerConnected('id-inesistente', true), PlayerNotFoundError,
  'setPlayerConnected: player inesistente lancia PlayerNotFoundError');

g8.startGame(0);
const lb8 = g8.getLeaderboard();
assert(lb8.every((p) => typeof p.avatar === 'string'), 'getLeaderboard: include avatar');
assert(g8.getSnapshot().players.every((p) => 'connected' in p), 'getSnapshot: include connected');
```

- [ ] **Step 2: Eseguire i test e verificarne il fallimento**

Run: `node tools/test-game.js`
Expected: FAIL — ReferenceError/assert falliti in Fase 8 (`AVATAR_IDS`/`InvalidAvatarError` non esportati); fasi 1–7 verdi.

- [ ] **Step 3: Implementare in `server/game.js`**

Dopo `MAX_NICKNAME_LENGTH` aggiungere:

```js
/**
 * Avatar precaricati (Fase 7). Il server conosce solo gli id stabili;
 * la resa visiva (oggi emoji, domani SVG) è responsabilità dei client.
 */
const AVATAR_IDS = Object.freeze([
  'volpe', 'panda', 'rana', 'polpo', 'leone', 'pinguino',
  'koala', 'tigre', 'unicorno', 'gufo', 'granchio', 'balena',
]);
```

Tra le classi errore aggiungere:

```js
class InvalidAvatarError extends Error {
  constructor(message = 'Avatar non valido.') {
    super(message);
    this.name = 'InvalidAvatarError';
  }
}
```

Sostituire `addPlayer` con:

```js
  /**
   * Aggiunge un giocatore alla lobby. Consentito solo in stato LOBBY.
   * @param {string} nickname
   * @param {string | null} [avatarId] id da AVATAR_IDS; se assente ne viene assegnato uno casuale
   * @returns {{ id: string, nickname: string, avatar: string, score: number, connected: boolean }}
   */
  addPlayer(nickname, avatarId = null) {
    this._assertState(STATES.LOBBY, 'addPlayer');

    const trimmed = String(nickname ?? '').trim();
    if (!trimmed) {
      throw new InvalidNicknameError('Nickname vuoto non consentito.');
    }
    if (trimmed.length > MAX_NICKNAME_LENGTH) {
      throw new InvalidNicknameError(`Nickname troppo lungo (massimo ${MAX_NICKNAME_LENGTH} caratteri).`);
    }

    const normalized = trimmed.toLowerCase();
    for (const p of this.players.values()) {
      if (p.nickname.toLowerCase() === normalized) {
        throw new DuplicateNicknameError();
      }
    }

    let avatar = avatarId;
    if (avatar === null || avatar === undefined) {
      avatar = AVATAR_IDS[Math.floor(Math.random() * AVATAR_IDS.length)];
    } else if (!AVATAR_IDS.includes(avatar)) {
      throw new InvalidAvatarError();
    }

    const player = { id: randomUUID(), nickname: trimmed, avatar, score: 0, connected: true };
    this.players.set(player.id, player);
    return player;
  }
```

Dopo `removePlayer` aggiungere:

```js
  /**
   * Marca lo stato di connessione di un giocatore (Fase 7 — riconnessione).
   * Non rimuove il giocatore: punteggio e identità restano.
   * @param {string} playerId
   * @param {boolean} connected
   */
  setPlayerConnected(playerId, connected) {
    const player = this._getPlayerOrThrow(playerId);
    player.connected = Boolean(connected);
  }
```

In `getLeaderboard` aggiungere `avatar` alla mappa:

```js
      .map((p, i) => ({ rank: i + 1, id: p.id, nickname: p.nickname, avatar: p.avatar, score: p.score }));
```

Negli export aggiungere `AVATAR_IDS` e `InvalidAvatarError`.

(`getPlayers()`/`getSnapshot()` restituiscono già gli oggetti player: `avatar` e `connected` sono inclusi automaticamente.)

- [ ] **Step 4: Eseguire i test e verificarne il successo**

Run: `node tools/test-game.js`
Expected: fasi 1–8 tutte ✅, `0 falliti`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/game.js tools/test-game.js
git commit -m "feat(game): avatar precaricati e flag connected sui player"
```

---

### Task 2: `game-socket.js` — token di sessione, rejoin, chiusura connected-aware

**Files:**
- Modify: `server/game-socket.js`
- Test: `tools/test-socket.js` (estendere)

**Interfaces:**
- Consumes: `setPlayerConnected`, `addPlayer(nickname, avatarId)`, campo `avatar` (Task 1).
- Produces (contratto eventi per i client, Task 5–7):
  - ack di `player:join` → `{ ok, playerId, token, avatar }`
  - nuovo evento `player:rejoin { token }` → ack `{ ok, playerId, token, nickname, avatar, score, state, question, leaderboard }` dove `question` = `{ index, total, text, options, time_limit_s, endsAt, alreadyAnswered } | null` (solo stato QUESTION) e `leaderboard` = array `{ rank, id, nickname, avatar, score }` | null (solo RESULTS/FINAL_LEADERBOARD)
  - `game:reset` → `{ playerId, token }`
  - `game:answer-count` → `{ answered, total }` con `total` = giocatori **connessi**
  - `game:lobby-update` → players con `avatar` e `connected`

- [ ] **Step 1: Scrivere i test che falliscono**

In `tools/test-socket.js`:

a) Fase 2 — Alice entra con avatar esplicito e l'assert verifica il nuovo ack:

```js
    const joined1 = await emitAck(p1, 'player:join', { nickname: 'Alice', avatarId: 'volpe' });
    assert(joined1.ok === true && typeof joined1.playerId === 'string'
      && typeof joined1.token === 'string' && joined1.avatar === 'volpe',
      'Alice entra in lobby (con token e avatar)');
```

b) Fase 6 — catturare anche il `game:reset` di Bob. Sostituire:

```js
    const resetPromise = once(p1, 'game:reset');
```

con:

```js
    const resetPromise = once(p1, 'game:reset');
    const resetBobPromise = once(p2, 'game:reset');
```

e dopo `const reset = await resetPromise;` aggiungere:

```js
    const resetBob = await resetBobPromise;
    const bobToken = resetBob.token;
    assert(typeof reset.token === 'string' && reset.token.length > 0,
      'game:reset: contiene il nuovo token');
```

c) Nuova Fase 6bis, tra Fase 6 e Fase 7:

```js
    // 6bis. Riconnessione con token (Fase 7)
    console.log('\n  🔌  Fase 6bis: Riconnessione con token');

    // Siamo in LOBBY dopo il riavvio. Avvia la partita.
    const q6Promise = once(p1, 'game:question');
    await emitAck(host, 'host:start-game', null);
    await q6Promise;

    // Bob (p2) si disconnette a domanda aperta: NON deve essere rimosso.
    const lobbyAfterDropPromise = once(host, 'game:lobby-update');
    p2.disconnect();
    const lobbyAfterDrop = await lobbyAfterDropPromise;
    assert(lobbyAfterDrop.players.length === 2, 'drop in partita: giocatore NON rimosso');
    assert(lobbyAfterDrop.players.some((p) => p.connected === false),
      'drop in partita: marcato disconnesso');

    // Alice risponde: il round si chiude subito perché è l'unica connessa.
    const r6Promise = once(host, 'game:results');
    await emitAck(p1, 'player:answer', { optionIndex: 0 });
    const r6 = await r6Promise;
    assert(r6.correctIndex === 0, 'chiusura anticipata conta solo i connessi');

    // Bob si riconnette da un socket nuovo con il token del suo game:reset.
    const p2bis = ioc(URL);
    sockets.push(p2bis);
    await once(p2bis, 'connect');
    const rejoined = await emitAck(p2bis, 'player:rejoin', { token: bobToken });
    assert(rejoined.ok === true, 'player:rejoin: accettato con token valido');
    assert(rejoined.nickname === 'Bob', 'player:rejoin: identità conservata');
    assert(rejoined.state === 'RESULTS', 'player:rejoin: stato corrente restituito');
    assert(Array.isArray(rejoined.leaderboard), 'player:rejoin in RESULTS: leaderboard presente');

    const badRejoin = await emitAck(p2bis, 'player:rejoin', { token: 'token-farlocco' });
    assert(badRejoin.ok === false, 'player:rejoin: token invalido rifiutato');
```

d) La Fase 7 esistente prosegue invariata: la partita è in RESULTS con p1 e p2bis connessi; `host:create-game` la sostituisce e il `game:ended` arriva a entrambi (l'assert esistente su p1 resta valido).

Nota: la Fase 6bis lascia la partita in RESULTS (non più in LOBBY come prima): l'assert di Fase 7 su `host:create-game` non dipende dallo stato, nessun'altra modifica necessaria.

- [ ] **Step 2: Eseguire i test e verificarne il fallimento**

Run: `npm run test:socket`
Expected: FAIL — assert su `token`/`avatar` in Fase 2, `reset.token` undefined in Fase 6, timeout/errore su `player:rejoin` in Fase 6bis.

- [ ] **Step 3: Implementare in `server/game-socket.js`**

In testa al file aggiungere il require:

```js
const { randomUUID } = require('node:crypto');
```

Stato modulo — sotto `socketPlayers` aggiungere:

```js
/** @type {Map<string, string>} token segreto -> playerId (riconnessione Fase 7) */
const playerTokens = new Map();
/** Scadenza assoluta (ms epoch) della domanda corrente, per il rejoin. */
let currentQuestionEndsAt = null;
```

`destroySession` — aggiungere:

```js
  playerTokens.clear();
  currentQuestionEndsAt = null;
```

`emitQuestion` — dopo `const endsAt = ...` aggiungere:

```js
  currentQuestionEndsAt = endsAt;
```

Sostituire `maybeCloseEarly` e aggiungere due helper:

```js
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
```

`player:join` — token e avatar:

```js
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
```

Nuovo evento `player:rejoin` (dopo `player:answer`):

```js
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
          ...currentSession.getCurrentQuestion(),
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
```

In `player:answer`, sostituire l'emit di `game:answer-count`:

```js
        io.to(ROOM_HOST).emit('game:answer-count', {
          answered: currentSession.currentAnswers.size,
          total: countConnected(),
        });
```

Handler `disconnect` — sostituire il corpo:

```js
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
```

`host:restart-game` — conservare avatar e rigenerare token. Sostituire la costruzione di `oldNicknames` e il ciclo di re-registrazione:

```js
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
```

- [ ] **Step 4: Eseguire i test e verificarne il successo**

Run: `npm run test:socket`
Expected: tutte le fasi ✅ inclusa 6bis, `0 falliti`, exit 0. Poi `node tools/test-game.js` ancora verde.

- [ ] **Step 5: Commit**

```bash
git add server/game-socket.js tools/test-socket.js
git commit -m "feat(socket): riconnessione player con token di sessione e avatar"
```

---

### Task 3: Endpoint `GET /api/host/game/join-info`

**Files:**
- Modify: `server/routes/host.js`

**Interfaces:**
- Produces: `GET /api/host/game/join-info` (JWT richiesto) → `{ success: true, data: { url: "http://<ip-lan>:<porta>" } }`. Consumato dal client host (Task 7).
- Consumes: `verifyToken` (middleware esistente), `config.port`.

- [ ] **Step 1: Implementare l'endpoint**

In `server/routes/host.js`: aggiungere `const os = require('node:os');` accanto agli altri require; verificare che `config` sia importato (`const config = require('../config');`), altrimenti aggiungerlo. In coda alle route, prima dell'export:

```js
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
```

- [ ] **Step 2: Verificare a mano**

Server avviato (`npm run dev`), poi:

```powershell
$token = node -e "console.log(require('jsonwebtoken').sign({userId:1,username:'t'}, require('./server/config').jwtSecret))"
curl.exe -s -H "Authorization: Bearer $token" http://localhost:3000/api/host/game/join-info
curl.exe -s -o NUL -w "%{http_code}" http://localhost:3000/api/host/game/join-info
```

Expected: primo curl `{"success":true,"data":{"url":"http://192.168.x.x:3000"}}` (IP LAN reale); secondo curl `401`.

- [ ] **Step 3: Commit**

```bash
git add server/routes/host.js
git commit -m "feat(api): endpoint join-info con IP LAN per QR code lobby"
```

---

### Task 4: Vendor libreria QR

**Files:**
- Create: `client/host/vendor/qrcode.js` (copia vendored di `qrcode-generator@1.4.4`, MIT)
- Modify: `client/host/index.html` (tag script)

**Interfaces:**
- Produces: globale `qrcode(typeNumber, errorCorrectionLevel)` con `.addData(text)`, `.make()`, `.createSvgTag({ cellSize, margin, scalable })` — usato in Task 7.

- [ ] **Step 1: Scaricare il file**

```powershell
New-Item -ItemType Directory -Force client/host/vendor
Invoke-WebRequest -Uri "https://unpkg.com/qrcode-generator@1.4.4/qrcode.js" -OutFile "client/host/vendor/qrcode.js"
```

Verificare: il file contiene il banner MIT di Kazuhiko Arase e definisce `var qrcode = function(`.

- [ ] **Step 2: Includerlo nella SPA host**

In `client/host/index.html`, prima di `<script src="app.js"></script>`:

```html
  <script src="vendor/qrcode.js"></script>
```

- [ ] **Step 3: Verifica in console browser**

Aprire `/admin-console`, DevTools console: `typeof qrcode` → `"function"`.

- [ ] **Step 4: Commit**

```bash
git add client/host/vendor/qrcode.js client/host/index.html
git commit -m "chore(host): vendor qrcode-generator per QR lobby offline"
```

---

### Task 5: Player UI — markup e stile Retro Street

**Files:**
- Modify: `client/player/index.html` (riscrittura)
- Create: `client/player/style.css`

**Interfaces:**
- Produces: id DOM consumati da `app.js` (Task 6): `nickname-input`, `avatar-grid`, `join-btn`, `join-error`, `lobby-players`, `lobby-me`, `question-progress`, `question-text`, `question-countdown`, `countdown-bar`, `answer-buttons`, `answer-sent`, `feedback-sticker`, `feedback-text`, `feedback-points`, `feedback-score`, `feedback-rank`, `final-podium`, `final-rest`, `final-me`, `message-text`, `reconnect-overlay`. Classi di stato: `.is-correct`, `.is-wrong`, `.is-neutral`, `.answer-locked`, `.answer-chosen`, `.avatar-option.selected`.
- Consumes: nulla (statico).

Nota esecuzione: Task 5 e 6 cambiano markup e logica della stessa SPA; se la vecchia `app.js` va in errore col nuovo markup, eseguire i due task di seguito e committare insieme al termine del Task 6.

- [ ] **Step 1: Riscrivere `client/player/index.html`**

```html
<!DOCTYPE html>
<html lang="it">
<head>
  <link rel="icon" type="image/svg+xml" href="/resources/img/Logo.svg">
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="description" content="Quiz-Zata! — Unisciti alla partita dal tuo smartphone.">
  <meta name="theme-color" content="#fff8f1">
  <title>Quiz-Zata! — Gioca</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="player-header">
    <img class="player-logo" src="/resources/img/Logo.svg" alt="Quiz-Zata!">
  </header>

  <!-- JOIN -->
  <section id="screen-join" class="screen">
    <h1 class="screen-title">Entra in partita</h1>
    <label class="field-label" for="nickname-input">Il tuo nickname</label>
    <input id="nickname-input" class="field-input" maxlength="20"
           placeholder="Es. CapitanQuiz" autocomplete="off" enterkeyhint="go">
    <p class="field-label" id="avatar-label">Scegli il tuo avatar</p>
    <div id="avatar-grid" class="avatar-grid" role="radiogroup" aria-labelledby="avatar-label"></div>
    <button id="join-btn" class="btn btn-primary btn-block">Entra</button>
    <p id="join-error" class="form-error" role="alert" hidden></p>
  </section>

  <!-- LOBBY -->
  <section id="screen-lobby" class="screen" hidden>
    <div class="sticker sticker-teal">Sei dentro!</div>
    <div id="lobby-me" class="me-badge"></div>
    <p class="waiting-text">In attesa che l'host avvii la partita…</p>
    <h2 class="section-label">In lobby</h2>
    <ul id="lobby-players" class="player-badges"></ul>
  </section>

  <!-- QUESTION -->
  <section id="screen-question" class="screen" hidden>
    <div class="question-top">
      <span id="question-progress" class="badge badge-yellow"></span>
      <span id="question-countdown" class="countdown-num" aria-live="polite"></span>
    </div>
    <div class="countdown-track" aria-hidden="true"><div id="countdown-bar" class="countdown-bar"></div></div>
    <h1 id="question-text" class="question-text"></h1>
    <div id="answer-buttons" class="answer-stack"></div>
    <div id="answer-sent" class="sticker sticker-teal" hidden>Risposta inviata!</div>
  </section>

  <!-- FEEDBACK -->
  <section id="screen-feedback" class="screen" hidden>
    <div id="feedback-sticker" class="feedback-sticker">
      <span id="feedback-text"></span>
      <span id="feedback-points" class="feedback-points"></span>
    </div>
    <div class="scoreboard-card">
      <p class="score-line">Punteggio: <strong id="feedback-score">0</strong></p>
      <p class="rank-line" id="feedback-rank"></p>
    </div>
    <p class="waiting-text">In attesa della prossima domanda…</p>
  </section>

  <!-- FINAL -->
  <section id="screen-final" class="screen" hidden>
    <h1 class="screen-title">Classifica finale</h1>
    <div id="final-podium" class="podium"></div>
    <div id="final-me" class="me-rank" hidden></div>
    <ol id="final-rest" class="final-list"></ol>
    <p class="waiting-text">Grazie per aver giocato!</p>
  </section>

  <!-- MESSAGE -->
  <section id="screen-message" class="screen" hidden>
    <div class="sticker sticker-red" id="message-text"></div>
  </section>

  <!-- Overlay riconnessione (sopra qualunque schermata) -->
  <div id="reconnect-overlay" class="reconnect-overlay" hidden>
    <div class="reconnect-card">
      <div class="spinner" aria-hidden="true"></div>
      <p>Connessione persa, riconnessione…</p>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Creare `client/player/style.css`**

```css
/* ═══════════════════════════════════════════════════════════════════════════
   Quiz-Zata! — Player Mobile
   Design System: Neo-Brutalist "Retro Street" — foglio autonomo, stessi token
   (scelta di design: nessun CSS condiviso con l'host, vedi spec Fase 7)
   ═══════════════════════════════════════════════════════════════════════════ */

@import url('https://fonts.googleapis.com/css2?family=Quicksand:wght@700;800;900&display=swap');

:root {
  --insert-coin-yellow: #f7d708;
  --primary-ink:        #4f4000;
  --arcade-teal:        #90efef;
  --arcade-teal-deep:   #006a6a;
  --game-over-red:      #ab3425;
  --terracotta-alert:   #e05a47;
  --ticket-ochre:       #f2a65a;
  --warm-paper:         #fff8f1;
  --paper-white:        #ffffff;
  --ink:                #201b0d;
  --ink-muted:          #4a4731;
  --error-red:          #ba1a1a;
  --success-green:      #2e7d32;
  --stamp:              8px 8px 0px 0px var(--ink);
  --stamp-sm:           4px 4px 0px 0px var(--ink);
  --radius:             16px;
  --radius-lg:          32px;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: 'Quicksand', system-ui, sans-serif;
  font-weight: 700;
  color: var(--ink);
  background-color: var(--warm-paper);
  background-image: radial-gradient(var(--ink) 0.75px, transparent 0.75px);
  background-size: 24px 24px;
  min-height: 100dvh;
  padding: 16px 20px 40px;
}

[hidden] { display: none !important; }

.player-header { display: flex; justify-content: center; padding: 8px 0 16px; }
.player-logo   { width: 140px; }

.screen { max-width: 480px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }

.screen-title {
  font-size: 32px; font-weight: 900; line-height: 40px; letter-spacing: -0.02em;
  text-align: center;
}
.section-label { font-size: 16px; font-weight: 900; letter-spacing: 0.03em; text-transform: uppercase; }
.waiting-text  { color: var(--ink-muted); text-align: center; }

/* ─── Form ─────────────────────────────────────────────────────────────── */

.field-label { font-weight: 900; }

.field-input {
  width: 100%; padding: 14px 16px;
  font: inherit; font-weight: 700; color: var(--ink);
  background: var(--paper-white);
  border: 3px solid var(--ink); border-radius: var(--radius);
  min-height: 48px;
}
.field-input:focus {
  outline: none;
  border-color: var(--arcade-teal-deep);
  box-shadow: var(--stamp-sm), 0 0 0 2px var(--arcade-teal);
}

.form-error {
  color: var(--error-red); font-weight: 900;
  animation: shake 0.4s;
}
.form-error::before { content: '⚠ '; }

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-6px); }
  75% { transform: translateX(6px); }
}

/* ─── Avatar picker ────────────────────────────────────────────────────── */

.avatar-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }

.avatar-option {
  font-size: 28px; line-height: 1;
  display: grid; place-items: center;
  aspect-ratio: 1; min-height: 48px;
  background: var(--paper-white);
  border: 3px solid var(--ink); border-radius: var(--radius);
  cursor: pointer;
  transition: transform 150ms, box-shadow 150ms;
}
.avatar-option.selected {
  background: var(--insert-coin-yellow);
  transform: translate(-2px, -2px);
  box-shadow: var(--stamp-sm);
}
.avatar-option:focus-visible { outline: 3px solid var(--arcade-teal-deep); outline-offset: 2px; }

/* ─── Bottoni ──────────────────────────────────────────────────────────── */

.btn {
  font: inherit; font-size: 20px; font-weight: 700;
  padding: 14px 20px; min-height: 48px;
  border: 4px solid var(--ink); border-radius: var(--radius);
  cursor: pointer;
  transition: transform 150ms, box-shadow 150ms;
}
.btn:active { transform: translate(2px, 2px); box-shadow: none; }
.btn-primary { background: var(--insert-coin-yellow); color: var(--primary-ink); box-shadow: var(--stamp-sm); }
.btn-block   { width: 100%; }
.btn:focus-visible { outline: 3px solid var(--arcade-teal-deep); outline-offset: 2px; }

/* ─── Badge / sticker ──────────────────────────────────────────────────── */

.badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 12px; border: 2px solid var(--ink); border-radius: 9999px;
  font-weight: 700; letter-spacing: 0.03em;
}
.badge-yellow { background: var(--insert-coin-yellow); color: var(--primary-ink); }

.sticker {
  align-self: center;
  padding: 10px 24px; border: 4px solid var(--ink); border-radius: 9999px;
  font-size: 20px; font-weight: 900;
  transform: rotate(-2deg);
  box-shadow: var(--stamp-sm);
}
.sticker-teal { background: var(--arcade-teal); color: var(--arcade-teal-deep); }
.sticker-red  { background: var(--game-over-red); color: #ffffff; }

.me-badge {
  align-self: center; display: inline-flex; align-items: center; gap: 10px;
  font-size: 24px; font-weight: 900;
  padding: 8px 20px; background: var(--paper-white);
  border: 4px solid var(--ink); border-radius: var(--radius-lg);
  box-shadow: var(--stamp-sm);
}
.me-badge .avatar { font-size: 32px; }

.player-badges { list-style: none; display: flex; flex-wrap: wrap; gap: 8px; }
.player-badges li {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 12px; border: 2px solid var(--ink); border-radius: 9999px;
  background: var(--paper-white); font-weight: 700;
}
.player-badges li:nth-child(odd)  { transform: rotate(-2deg); }
.player-badges li:nth-child(even) { transform: rotate(2deg); }

/* ─── Domanda ──────────────────────────────────────────────────────────── */

.question-top { display: flex; justify-content: space-between; align-items: center; }
.countdown-num { font-size: 32px; font-weight: 900; min-width: 2ch; text-align: right; }

.countdown-track {
  height: 14px; border: 3px solid var(--ink); border-radius: 9999px;
  background: var(--paper-white); overflow: hidden;
}
.countdown-bar {
  height: 100%; width: 100%;
  background: var(--terracotta-alert);
  transform-origin: left center;
}

.question-text { font-size: 24px; font-weight: 900; line-height: 32px; }

.answer-stack { display: flex; flex-direction: column; gap: 12px; }

.answer-btn {
  display: flex; align-items: center; gap: 12px; text-align: left;
  font: inherit; font-size: 18px; font-weight: 700; color: var(--ink);
  padding: 14px 16px; min-height: 56px; width: 100%;
  border: 4px solid var(--ink); border-radius: var(--radius);
  cursor: pointer; box-shadow: var(--stamp-sm);
  transition: transform 150ms, box-shadow 150ms;
}
.answer-btn:active { transform: translate(2px, 2px); box-shadow: none; }
.answer-btn .letter {
  flex: none; display: grid; place-items: center;
  width: 36px; height: 36px; border: 3px solid var(--ink); border-radius: 9999px;
  background: var(--paper-white); font-weight: 900;
}
.answer-btn:nth-child(4n+1) { background: var(--insert-coin-yellow); color: var(--primary-ink); }
.answer-btn:nth-child(4n+2) { background: var(--arcade-teal); color: var(--arcade-teal-deep); }
.answer-btn:nth-child(4n+3) { background: var(--ticket-ochre); }
.answer-btn:nth-child(4n+4) { background: var(--paper-white); }

.answer-locked .answer-btn { opacity: 0.45; pointer-events: none; box-shadow: none; }
.answer-locked .answer-btn.answer-chosen {
  opacity: 1; transform: translate(-2px, -2px); box-shadow: var(--stamp-sm);
}

/* ─── Feedback ─────────────────────────────────────────────────────────── */

.feedback-sticker {
  align-self: center; display: flex; flex-direction: column; align-items: center; gap: 4px;
  min-width: 240px; padding: 24px 32px; margin-top: 24px;
  border: 4px solid var(--ink); border-radius: var(--radius-lg);
  font-size: 28px; font-weight: 900; text-align: center;
  transform: rotate(-2deg); box-shadow: var(--stamp);
}
.feedback-sticker.is-correct { background: var(--success-green); color: #ffffff; }
.feedback-sticker.is-correct #feedback-text::before { content: '✔ '; }
.feedback-sticker.is-wrong   { background: var(--game-over-red); color: #ffffff; }
.feedback-sticker.is-wrong #feedback-text::before { content: '✘ '; }
.feedback-sticker.is-neutral { background: var(--ticket-ochre); color: var(--ink); }
.feedback-sticker.is-neutral #feedback-text::before { content: '⏱ '; }
.feedback-points { font-size: 20px; }

.scoreboard-card {
  background: var(--paper-white); border: 4px solid var(--ink);
  border-radius: var(--radius-lg); padding: 24px; text-align: center;
}
.score-line { font-size: 20px; }
.score-line strong { font-size: 32px; font-weight: 900; }
.rank-line { color: var(--ink-muted); }

/* ─── Podio finale ─────────────────────────────────────────────────────── */

.podium { display: flex; align-items: flex-end; justify-content: center; gap: 8px; }
.podium-step {
  flex: 1; max-width: 130px;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  border: 4px solid var(--ink); border-radius: var(--radius) var(--radius) 0 0;
  padding: 12px 8px; text-align: center;
}
.podium-step .avatar   { font-size: 36px; }
.podium-step .name     { font-weight: 900; overflow-wrap: anywhere; }
.podium-step .points   { font-size: 14px; color: var(--ink-muted); }
.podium-step .medal    { font-size: 20px; font-weight: 900; }
.podium-step.rank-1 { background: var(--insert-coin-yellow); min-height: 150px; order: 2; }
.podium-step.rank-2 { background: var(--arcade-teal);        min-height: 120px; order: 1; }
.podium-step.rank-3 { background: var(--ticket-ochre);       min-height: 100px; order: 3; }

.me-rank {
  align-self: center; padding: 8px 20px;
  background: var(--paper-white); border: 3px solid var(--ink);
  border-radius: 9999px; font-weight: 900;
}

.final-list { list-style: none; display: flex; flex-direction: column; gap: 8px; }
.final-list li {
  display: flex; align-items: center; gap: 10px;
  background: var(--paper-white); border: 3px solid var(--ink);
  border-radius: var(--radius); padding: 8px 14px;
}
.final-list .pos { font-weight: 900; min-width: 2.2ch; }
.final-list .pts { margin-left: auto; font-weight: 900; }

/* ─── Overlay riconnessione ────────────────────────────────────────────── */

.reconnect-overlay {
  position: fixed; inset: 0; z-index: 50;
  display: grid; place-items: center;
  background: rgba(32, 27, 13, 0.6);
}
.reconnect-card {
  display: flex; flex-direction: column; align-items: center; gap: 16px;
  background: var(--paper-white); border: 4px solid var(--ink);
  border-radius: var(--radius-lg); padding: 32px; box-shadow: var(--stamp);
  font-weight: 900;
}
.spinner {
  width: 40px; height: 40px; border-radius: 9999px;
  border: 5px solid var(--ink); border-top-color: var(--insert-coin-yellow);
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ─── Reduced motion ───────────────────────────────────────────────────── */

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```

- [ ] **Step 3: Verifica visiva**

Run: server dev attivo, aprire `http://localhost:3000/` con viewport mobile (375px).
Expected: schermata join renderizzata con logo, titolo, input, griglia avatar (vuota finché non c'è la nuova app.js del Task 6), bottone giallo con ombra stamp. Pattern a puntini sul fondo.

- [ ] **Step 4: Commit (o rimandare al commit congiunto del Task 6, vedi nota)**

```bash
git add client/player/index.html client/player/style.css
git commit -m "feat(player): markup e stile Retro Street mobile-first"
```

---

### Task 6: Player `app.js` — avatar, countdown, rank, riconnessione

**Files:**
- Modify: `client/player/app.js` (riscrittura completa)

**Interfaces:**
- Consumes: id DOM del Task 5; eventi/ack del Task 2 (`player:join` → `{ playerId, token, avatar }`, `player:rejoin`, `game:reset` → `{ playerId, token }`).
- Produces: nulla per altri task.

- [ ] **Step 1: Riscrivere `client/player/app.js`**

```js
'use strict';

/**
 * client/player/app.js
 *
 * Fase 7: client giocatore definitivo (mobile-first, Retro Street).
 * Gestisce: join con nickname+avatar, lobby, domande con countdown,
 * feedback con posizione, podio finale, riavvio, riconnessione con token.
 */

/* global io */

// Mappa avatar: id stabile → emoji TEMPORANEA (futuri SVG: cambiare solo qui).
const AVATARS = {
  volpe: '🦊', panda: '🐼', rana: '🐸', polpo: '🐙',
  leone: '🦁', pinguino: '🐧', koala: '🐨', tigre: '🐯',
  unicorno: '🦄', gufo: '🦉', granchio: '🦀', balena: '🐳',
};
const avatarOf = (id) => AVATARS[id] ?? '❓';

const SESSION_KEY = 'quizzata-player';

const socket = io();

let playerId = null;
let selectedAvatar = null;
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
const avatarGrid        = document.getElementById('avatar-grid');
const joinBtn           = document.getElementById('join-btn');
const joinError         = document.getElementById('join-error');
const lobbyPlayers      = document.getElementById('lobby-players');
const lobbyMe           = document.getElementById('lobby-me');
const questionProgress  = document.getElementById('question-progress');
const questionText      = document.getElementById('question-text');
const questionCountdown = document.getElementById('question-countdown');
const countdownBar      = document.getElementById('countdown-bar');
const answerButtons     = document.getElementById('answer-buttons');
const answerSent        = document.getElementById('answer-sent');
const feedbackSticker   = document.getElementById('feedback-sticker');
const feedbackText      = document.getElementById('feedback-text');
const feedbackPoints    = document.getElementById('feedback-points');
const feedbackScore     = document.getElementById('feedback-score');
const feedbackRank      = document.getElementById('feedback-rank');
const finalPodium       = document.getElementById('final-podium');
const finalRest         = document.getElementById('final-rest');
const finalMe           = document.getElementById('final-me');
const messageText       = document.getElementById('message-text');
const reconnectOverlay  = document.getElementById('reconnect-overlay');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ─── Sessione persistente (riconnessione) ────────────────────────────────────

function saveSession(data) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
}
function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); }
  catch { return null; }
}
function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// ─── Helpers UI ──────────────────────────────────────────────────────────────

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

/** Countdown: numero grande + barra terracotta che si svuota. */
function startCountdown(endsAt, totalMs) {
  stopCountdown();
  const tick = () => {
    const remainingMs = Math.max(0, endsAt - Date.now());
    questionCountdown.textContent = Math.ceil(remainingMs / 1000);
    countdownBar.style.transform = `scaleX(${totalMs > 0 ? remainingMs / totalMs : 0})`;
    if (remainingMs === 0) stopCountdown();
  };
  tick();
  countdownInterval = setInterval(tick, reducedMotion ? 1000 : 100);
}

function renderMeBadge(nickname, avatar) {
  lobbyMe.innerHTML = '';
  const av = document.createElement('span');
  av.className = 'avatar';
  av.textContent = avatarOf(avatar);
  const name = document.createElement('span');
  name.textContent = nickname;
  lobbyMe.append(av, name);
}

function renderPlayerBadge(p) {
  const li = document.createElement('li');
  const av = document.createElement('span');
  av.textContent = avatarOf(p.avatar);
  const name = document.createElement('span');
  name.textContent = p.nickname;
  li.append(av, name);
  return li;
}

// ─── Avatar picker ───────────────────────────────────────────────────────────

function buildAvatarGrid() {
  const ids = Object.keys(AVATARS);
  const preselected = ids[Math.floor(Math.random() * ids.length)];
  for (const id of ids) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avatar-option';
    btn.dataset.avatarId = id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', id);
    btn.textContent = avatarOf(id);
    btn.addEventListener('click', () => selectAvatar(id));
    avatarGrid.appendChild(btn);
  }
  selectAvatar(preselected);
}

function selectAvatar(id) {
  selectedAvatar = id;
  for (const el of avatarGrid.children) {
    const selected = el.dataset.avatarId === id;
    el.classList.toggle('selected', selected);
    el.setAttribute('aria-checked', String(selected));
  }
}

// ─── Join ────────────────────────────────────────────────────────────────────

joinBtn.addEventListener('click', () => {
  const nickname = nicknameInput.value.trim();
  if (!nickname) {
    showJoinError('Inserisci un nickname.');
    return;
  }
  socket.emit('player:join', { nickname, avatarId: selectedAvatar }, (res) => {
    if (!res.ok) {
      showJoinError(res.error);
      return;
    }
    playerId = res.playerId;
    saveSession({ token: res.token, playerId, nickname, avatar: res.avatar });
    joinError.hidden = true;
    renderMeBadge(nickname, res.avatar);
    show('lobby');
  });
});

function showJoinError(text) {
  joinError.textContent = text;
  joinError.hidden = false;
  // Riavvia l'animazione shake anche su errori consecutivi.
  joinError.style.animation = 'none';
  void joinError.offsetWidth;
  joinError.style.animation = '';
}

nicknameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

// ─── Rendering domanda / risposta ────────────────────────────────────────────

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function renderQuestion(q, alreadyAnswered = false) {
  questionProgress.textContent = `${q.index + 1}/${q.total}`;
  questionText.textContent = q.text;
  answerSent.hidden = !alreadyAnswered;
  answerButtons.classList.toggle('answer-locked', alreadyAnswered);
  answerButtons.innerHTML = '';

  q.options.forEach((option, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'answer-btn';
    const letter = document.createElement('span');
    letter.className = 'letter';
    letter.textContent = LETTERS[i] ?? String(i + 1);
    const label = document.createElement('span');
    label.textContent = option;
    btn.append(letter, label);
    btn.addEventListener('click', () => submitAnswer(i, btn));
    answerButtons.appendChild(btn);
  });

  startCountdown(q.endsAt, q.time_limit_s * 1000);
  show('question');
}

function submitAnswer(optionIndex, btn) {
  socket.emit('player:answer', { optionIndex }, (res) => {
    answerButtons.classList.add('answer-locked');
    if (res.ok) {
      btn.classList.add('answer-chosen');
      answerSent.textContent = 'Risposta inviata!';
    } else {
      answerSent.textContent = res.error;
    }
    answerSent.hidden = false;
  });
}

// ─── Feedback / classifiche ──────────────────────────────────────────────────

function ordinale(n) { return `${n}°`; }

function renderFeedback({ mine, leaderboard }) {
  feedbackSticker.classList.remove('is-correct', 'is-wrong', 'is-neutral');
  if (!mine) {
    feedbackSticker.classList.add('is-neutral');
    feedbackText.textContent = 'Tempo scaduto!';
    feedbackPoints.textContent = '+0 punti';
  } else if (mine.correct) {
    feedbackSticker.classList.add('is-correct');
    feedbackText.textContent = 'GIUSTO!';
    feedbackPoints.textContent = `+${mine.pointsAwarded} punti`;
  } else {
    feedbackSticker.classList.add('is-wrong');
    feedbackText.textContent = 'SBAGLIATO';
    feedbackPoints.textContent = '+0 punti';
  }

  const me = leaderboard.find((p) => p.id === playerId);
  feedbackScore.textContent = me ? me.score : '—';
  feedbackRank.textContent = me
    ? `Sei ${ordinale(me.rank)} su ${leaderboard.length}`
    : '';
  show('feedback');
}

function renderFinal(leaderboard) {
  finalPodium.innerHTML = '';
  finalRest.innerHTML = '';
  finalMe.hidden = true;

  const MEDALS = ['🥇', '🥈', '🥉'];
  leaderboard.slice(0, 3).forEach((p, i) => {
    const step = document.createElement('div');
    step.className = `podium-step rank-${i + 1}`;

    const medal = document.createElement('span');
    medal.className = 'medal';
    medal.textContent = MEDALS[i];
    const av = document.createElement('span');
    av.className = 'avatar';
    av.textContent = avatarOf(p.avatar);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.nickname;
    const points = document.createElement('span');
    points.className = 'points';
    points.textContent = `${p.score} punti`;

    step.append(medal, av, name, points);
    finalPodium.appendChild(step);
  });

  for (const p of leaderboard.slice(3)) {
    const li = document.createElement('li');
    const pos = document.createElement('span');
    pos.className = 'pos';
    pos.textContent = String(p.rank);
    const av = document.createElement('span');
    av.textContent = avatarOf(p.avatar);
    const name = document.createElement('span');
    name.textContent = p.nickname;
    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = String(p.score);
    li.append(pos, av, name, pts);
    finalRest.appendChild(li);
  }

  const me = leaderboard.find((p) => p.id === playerId);
  if (me && me.rank > 3) {
    finalMe.textContent = `La tua posizione: ${ordinale(me.rank)}`;
    finalMe.hidden = false;
  }
  show('final');
}

// ─── Eventi di gioco ─────────────────────────────────────────────────────────

socket.on('game:lobby-update', ({ players }) => {
  if (!playerId) return;
  lobbyPlayers.innerHTML = '';
  for (const p of players) {
    lobbyPlayers.appendChild(renderPlayerBadge(p));
  }
});

socket.on('game:question', (q) => {
  if (!playerId) return;
  renderQuestion(q);
});

socket.on('game:results', (results) => {
  if (!playerId) return;
  stopCountdown();
  const mine = results.answers.find((a) => a.playerId === playerId) ?? null;
  renderFeedback({ mine, leaderboard: results.leaderboard });
});

socket.on('game:final', ({ leaderboard }) => {
  if (!playerId) return;
  stopCountdown();
  renderFinal(leaderboard);
});

socket.on('game:reset', ({ playerId: newId, token }) => {
  const session = loadSession() ?? {};
  playerId = newId;
  saveSession({ ...session, playerId: newId, token });
  show('lobby');
});

socket.on('game:ended', () => {
  playerId = null;
  clearSession();
  stopCountdown();
  showMessage('L\'host ha terminato la partita. Ricarica la pagina per giocare di nuovo.');
});

// ─── Riconnessione ───────────────────────────────────────────────────────────

/** Tenta il rejoin col token salvato; ripristina la schermata corretta. */
function tryRejoin(session) {
  socket.emit('player:rejoin', { token: session.token }, (res) => {
    reconnectOverlay.hidden = true;
    if (!res.ok) {
      playerId = null;
      clearSession();
      show('join');
      return;
    }
    playerId = res.playerId;
    saveSession({ token: res.token, playerId, nickname: res.nickname, avatar: res.avatar });
    renderMeBadge(res.nickname, res.avatar);

    if (res.state === 'LOBBY') {
      show('lobby');
    } else if (res.state === 'QUESTION' && res.question) {
      renderQuestion(res.question, res.question.alreadyAnswered);
    } else if (res.state === 'FINAL_LEADERBOARD') {
      renderFinal(res.leaderboard ?? []);
    } else {
      // RESULTS: nessun dettaglio sull'ultima risposta, mostra punteggio attuale.
      const leaderboard = res.leaderboard ?? [];
      const me = leaderboard.find((p) => p.id === playerId);
      feedbackSticker.classList.remove('is-correct', 'is-wrong');
      feedbackSticker.classList.add('is-neutral');
      feedbackText.textContent = 'Bentornato!';
      feedbackPoints.textContent = '';
      feedbackScore.textContent = me ? me.score : res.score;
      feedbackRank.textContent = me ? `Sei ${ordinale(me.rank)} su ${leaderboard.length}` : '';
      show('feedback');
    }
  });
}

socket.on('connect', () => {
  const session = loadSession();
  if (session?.token && !playerId) {
    tryRejoin(session);
  }
});

socket.on('disconnect', () => {
  if (playerId) {
    stopCountdown();
    playerId = null; // al reconnect il flusso passa da tryRejoin
    reconnectOverlay.hidden = false;
  }
});

// ─── Init ────────────────────────────────────────────────────────────────────

buildAvatarGrid();
```

- [ ] **Step 2: Verifica funzionale locale (preview)**

Run: `npm run dev`; host su `/admin-console` (login, avvia un quiz), 2 tab player su `/` (viewport 375px).
Expected:
1. Join con avatar → lobby con badge avatar.
2. Domanda → bottoni colorati A-D, barra countdown che si svuota, numero decrescente.
3. Risposta → bottoni bloccati, scelto evidenziato, sticker "Risposta inviata!".
4. Risultati → sticker verde/rosso/neutro con punti e "Sei N° su M".
5. Ultima domanda → podio con medaglie; propria posizione se > 3°.
6. Reload di un tab player a domanda aperta → overlay riconnessione → domanda ripristinata con countdown residuo e (se già risposto) bottoni bloccati; punteggio conservato al round dopo.
7. Termina partita dall'host → messaggio dedicato sul player, sessionStorage pulito.
8. Console browser senza errori. `npm run test:socket` e `node tools/test-game.js` verdi.

- [ ] **Step 3: Commit**

```bash
git add client/player/
git commit -m "feat(player): UI definitiva con avatar, countdown, podio e riconnessione"
```

---

### Task 7: Host — QR in lobby, avatar, area live Retro Street

**Files:**
- Modify: `client/host/index.html:321-341` (area live)
- Modify: `client/host/app.js` (sezione GAME MODULE, righe ~903-1117)
- Modify: `client/host/style.css` (append in coda)

**Interfaces:**
- Consumes: `GET /api/host/game/join-info` (Task 3), globale `qrcode` (Task 4), eventi Task 2 (players con `avatar`/`connected`, leaderboard con `avatar`).
- Produces: nulla per altri task.

- [ ] **Step 1: Sostituire l'area live in `client/host/index.html`**

Sostituire l'intero blocco `<div id="game-live-area">…</div>` (righe 322-341) con:

```html
            <div id="game-live-area">
              <div id="game-lobby-box" hidden>
                <div class="game-join-card">
                  <div id="game-qr" class="game-qr" role="img" aria-label="QR code per entrare in partita"></div>
                  <p id="game-join-url" class="game-join-url"></p>
                  <p class="game-join-hint">Inquadra il QR o digita l'indirizzo sul telefono</p>
                </div>
                <div class="game-lobby-players">
                  <h3 class="game-live-title">In lobby
                    <span id="game-player-count" class="game-count-bubble">0</span>
                  </h3>
                  <ul id="game-players-list" class="game-player-badges"></ul>
                </div>
              </div>
              <div id="game-question-box" hidden>
                <h3 id="game-question-text" class="game-live-question"></h3>
                <ul id="game-options-list" class="game-option-cards"></ul>
                <p id="game-answer-count" class="game-answer-counter">Risposte: 0 / 0</p>
              </div>
              <div id="game-results-box" hidden>
                <h3 class="game-live-title">Risultati</h3>
                <p id="game-correct-answer" class="game-correct-answer"></p>
                <ul id="game-distribution" class="game-distribution"></ul>
                <ol id="game-partial-leaderboard" class="game-partial-leaderboard"></ol>
              </div>
              <div id="game-final-box" hidden>
                <h3 class="game-live-title">Classifica finale</h3>
                <div id="game-final-podium" class="game-final-podium"></div>
                <ol id="game-final-leaderboard" class="game-final-list"></ol>
              </div>
            </div>
```

- [ ] **Step 2: Aggiornare la sezione GAME MODULE in `client/host/app.js`**

Aggiungere ai riferimenti DOM della sezione:

```js
const gameJoinUrl            = document.getElementById('game-join-url');
const gameQr                 = document.getElementById('game-qr');
const gamePartialLeaderboard = document.getElementById('game-partial-leaderboard');
const gameFinalPodium        = document.getElementById('game-final-podium');
```

Aggiungere sopra `openGame`:

```js
// Mappa avatar: id stabile → emoji TEMPORANEA (identica al client player).
const GAME_AVATARS = {
  volpe: '🦊', panda: '🐼', rana: '🐸', polpo: '🐙',
  leone: '🦁', pinguino: '🐧', koala: '🐨', tigre: '🐯',
  unicorno: '🦄', gufo: '🦉', granchio: '🦀', balena: '🐳',
};
const gameAvatarOf = (id) => GAME_AVATARS[id] ?? '❓';

/* global qrcode */

/** Carica l'URL LAN e disegna il QR nella lobby (una volta per partita). */
async function loadJoinInfo() {
  gameQr.innerHTML = '';
  gameJoinUrl.textContent = '';
  try {
    // Usare l'helper fetch autenticato già presente in questo file (stesso
    // pattern delle altre chiamate /api/host/*): verificarne il nome reale.
    const res = await apiFetch('/api/host/game/join-info');
    const url = res.data.url;
    gameJoinUrl.textContent = url;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    gameQr.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch {
    // Fallback: solo testo, il QR non è indispensabile.
    gameJoinUrl.textContent = `http://${location.hostname}:${location.port || 80}`;
  }
}
```

In `openGame(quiz, type)` aggiungere `loadJoinInfo();` prima di `connectGameSocket(quiz, type);`.

Sostituire `renderGameLobby`:

```js
function renderGameLobby(players) {
  gamePlayerCount.textContent = players.length;
  gamePlayersList.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.className = 'game-player-badge' + (p.connected === false ? ' is-disconnected' : '');
    const av = document.createElement('span');
    av.textContent = gameAvatarOf(p.avatar);
    const name = document.createElement('span');
    name.textContent = p.nickname;
    li.append(av, name);
    if (p.connected === false) {
      const off = document.createElement('span');
      off.className = 'material-symbols-outlined';
      off.textContent = 'wifi_off';
      off.setAttribute('aria-label', 'disconnesso');
      li.appendChild(off);
    }
    gamePlayersList.appendChild(li);
  }
  showGameBox(gameLobbyBox);
  gameStartBtn.disabled = players.length === 0;
}
```

Nel handler `game:question`, sostituire il ciclo di rendering delle opzioni:

```js
    gameOptionsList.innerHTML = '';
    const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
    q.options.forEach((option, i) => {
      const li = document.createElement('li');
      li.className = 'game-option-card';
      const letter = document.createElement('span');
      letter.className = 'game-option-letter';
      letter.textContent = LETTERS[i] ?? String(i + 1);
      const label = document.createElement('span');
      label.textContent = option;
      li.append(letter, label);
      gameOptionsList.appendChild(li);
    });
```

Nel handler `game:results`, sostituire il rendering della distribuzione e aggiungere la classifica parziale:

```js
    const totalAnswers = results.distribution.reduce((a, b) => a + b, 0);
    gameDistribution.innerHTML = '';
    results.distribution.forEach((n, i) => {
      const li = document.createElement('li');
      li.className = 'game-dist-row' + (i === results.correctIndex ? ' is-correct' : '');
      const pct = totalAnswers > 0 ? Math.round((n / totalAnswers) * 100) : 0;
      const label = document.createElement('span');
      label.className = 'game-dist-label';
      label.textContent = currentQuestionOptions[i] ?? `Opzione ${i + 1}`;
      const track = document.createElement('div');
      track.className = 'game-dist-track';
      const bar = document.createElement('div');
      bar.className = 'game-dist-bar';
      bar.style.width = `${Math.max(pct, n > 0 ? 8 : 0)}%`;
      track.appendChild(bar);
      const count = document.createElement('span');
      count.className = 'game-dist-count';
      count.textContent = i === results.correctIndex ? `✔ ${n}` : String(n);
      li.append(label, track, count);
      gameDistribution.appendChild(li);
    });

    gamePartialLeaderboard.innerHTML = '';
    for (const p of results.leaderboard.slice(0, 5)) {
      const li = document.createElement('li');
      li.textContent = `${gameAvatarOf(p.avatar)} ${p.nickname} — ${p.score}`;
      gamePartialLeaderboard.appendChild(li);
    }
```

Nel handler `game:final`, sostituire il rendering della classifica:

```js
    gameFinalPodium.innerHTML = '';
    const MEDALS = ['🥇', '🥈', '🥉'];
    leaderboard.slice(0, 3).forEach((p, i) => {
      const step = document.createElement('div');
      step.className = `game-podium-step rank-${i + 1}`;
      const medal = document.createElement('span');
      medal.className = 'medal';
      medal.textContent = MEDALS[i];
      const av = document.createElement('span');
      av.className = 'avatar';
      av.textContent = gameAvatarOf(p.avatar);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.nickname;
      const points = document.createElement('span');
      points.className = 'points';
      points.textContent = `${p.score} punti`;
      step.append(medal, av, name, points);
      gameFinalPodium.appendChild(step);
    });

    gameFinalLeaderboard.innerHTML = '';
    for (const p of leaderboard.slice(3)) {
      const li = document.createElement('li');
      li.textContent = `${p.rank}. ${gameAvatarOf(p.avatar)} ${p.nickname} — ${p.score} punti`;
      gameFinalLeaderboard.appendChild(li);
    }
```

- [ ] **Step 3: Aggiungere gli stili in coda a `client/host/style.css`**

```css
/* ═══════════════════════════════════════════════════════════════════════════
   Fase 7 — Area live conduzione partita (lobby QR, opzioni, barre, podio)
   ═══════════════════════════════════════════════════════════════════════════ */

#game-lobby-box { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }

.game-join-card {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  background: var(--surface-container-lowest);
  border: 4px solid var(--on-background); border-radius: var(--radius-lg);
  padding: 24px; box-shadow: var(--retro-shadow);
}
.game-qr svg { width: 220px; height: 220px; display: block; }
.game-join-url {
  font-size: var(--text-headline-md); font-weight: 900;
  color: var(--on-background); word-break: break-all; text-align: center;
}
.game-join-hint { color: var(--on-surface-variant); font-weight: 700; }

.game-lobby-players { flex: 1; min-width: 260px; }
.game-live-title { font-size: var(--text-headline-md); font-weight: 900; margin-bottom: 12px; }
.game-count-bubble {
  display: inline-grid; place-items: center; min-width: 40px; height: 40px;
  margin-left: 8px; padding: 0 10px;
  background: var(--primary-container); color: var(--on-primary-container);
  border: 3px solid var(--on-background); border-radius: var(--radius-full);
  font-weight: 900;
}
.game-player-badges { list-style: none; display: flex; flex-wrap: wrap; gap: 8px; padding: 0; }
.game-player-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 14px; font-weight: 700;
  background: var(--surface-container-lowest);
  border: 2px solid var(--on-background); border-radius: var(--radius-full);
}
.game-player-badge:nth-child(odd)  { transform: rotate(-2deg); }
.game-player-badge:nth-child(even) { transform: rotate(2deg); }
.game-player-badge.is-disconnected { opacity: 0.5; }
.game-player-badge .material-symbols-outlined { font-size: 18px; }

.game-live-question { font-size: var(--text-headline-md); font-weight: 900; margin-bottom: 16px; }
.game-option-cards {
  list-style: none; padding: 0;
  display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;
}
.game-option-card {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; font-weight: 700;
  background: var(--surface-container-lowest);
  border: 3px solid var(--on-background); border-radius: var(--radius-base);
}
.game-option-letter {
  flex: none; display: grid; place-items: center;
  width: 36px; height: 36px; font-weight: 900;
  background: var(--primary-container); color: var(--on-primary-container);
  border: 3px solid var(--on-background); border-radius: var(--radius-full);
}
.game-answer-counter { font-size: var(--text-headline-md); font-weight: 900; margin-top: 16px; }

.game-correct-answer { font-weight: 900; margin-bottom: 12px; }
.game-distribution { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.game-dist-row {
  display: grid; grid-template-columns: minmax(120px, 1fr) 2fr 3.5rem;
  align-items: center; gap: 12px; font-weight: 700;
}
.game-dist-track {
  height: 24px; background: var(--surface-container-lowest);
  border: 3px solid var(--on-background); border-radius: var(--radius-full);
  overflow: hidden;
}
.game-dist-bar { height: 100%; background: var(--retro-ochre); }
.game-dist-row.is-correct .game-dist-bar { background: var(--success); }
.game-dist-row.is-correct .game-dist-count { color: var(--success); font-weight: 900; }
.game-dist-count { text-align: right; font-weight: 900; }

.game-partial-leaderboard { margin-top: 16px; padding-left: 24px; font-weight: 700; }

.game-final-podium {
  display: flex; align-items: flex-end; justify-content: center;
  gap: 12px; margin-bottom: 16px;
}
.game-podium-step {
  flex: 1; max-width: 160px;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  border: 4px solid var(--on-background);
  border-radius: var(--radius-base) var(--radius-base) 0 0;
  padding: 16px 8px; text-align: center; font-weight: 700;
}
.game-podium-step .avatar { font-size: 40px; }
.game-podium-step .name   { font-weight: 900; overflow-wrap: anywhere; }
.game-podium-step .medal  { font-size: 24px; }
.game-podium-step .points { color: var(--on-surface-variant); }
.game-podium-step.rank-1 { background: var(--primary-container);   min-height: 170px; order: 2; }
.game-podium-step.rank-2 { background: var(--secondary-container); min-height: 135px; order: 1; }
.game-podium-step.rank-3 { background: var(--retro-ochre);         min-height: 110px; order: 3; }
.game-final-list { padding-left: 24px; font-weight: 700; }
```

- [ ] **Step 4: Verifica funzionale (preview)**

Run: `npm run dev`, partita completa host + 2 player.
Expected: lobby con QR scansionabile e URL LAN grande; badge giocatori con avatar (opachi + icona `wifi_off` se disconnessi a partita in corso); opzioni come card A-D; barre distribuzione con la corretta in verde e ✔; classifica parziale top 5; podio finale con medaglie. Nessun errore console. `npm run test:socket` ancora verde.

- [ ] **Step 5: Commit**

```bash
git add client/host/
git commit -m "feat(host): lobby con QR code, avatar e area live Retro Street"
```

---

### Task 8: Playtest E2E, docs e chiusura Fase 7

**Files:**
- Create: `docs/playtest-checklist.md`
- Modify: `DEV_ROADMAP.md` (Fase 7)

- [ ] **Step 1: Playtest locale completo**

Con browser preview: partita host + 2 player, tutte le transizioni, riconnessione (reload a domanda aperta, reload in RESULTS, reload in FINAL_LEADERBOARD), riavvio partita, termina partita, ri-creazione partita. Ogni anomalia → fix immediato + ri-run di `node tools/test-game.js` e `npm run test:socket`.

- [ ] **Step 2: Creare `docs/playtest-checklist.md`**

```markdown
# Checklist Playtest Wi-Fi (Fase 7)

Setup: PC con `npm run dev`, smartphone sulla stessa rete Wi-Fi.
L'URL/QR appare nella lobby della schermata di conduzione partita.

## Percorso base
- [ ] QR scansionato apre la pagina player sul telefono
- [ ] Join con nickname + avatar da 2+ telefoni diversi
- [ ] Avvio partita: la domanda appare su tutti i telefoni entro ~1s
- [ ] Countdown allineato tra telefoni e schermo host
- [ ] Risposte registrate, contatore host aggiornato in tempo reale
- [ ] Chiusura anticipata quando tutti rispondono
- [ ] Feedback corretto/sbagliato/tempo scaduto sui telefoni
- [ ] Podio finale coerente su host e telefoni

## Robustezza
- [ ] Blocco schermo del telefono a domanda aperta → sblocco → riconnessione automatica con punteggio
- [ ] Reload della pagina a metà partita → rientro nello stato corrente
- [ ] Wi-Fi del telefono spento e riacceso → riconnessione
- [ ] Telefono che sparisce del tutto → la partita prosegue, il round si chiude col timer
- [ ] Riavvia partita: tutti i telefoni tornano in lobby con punteggi azzerati
- [ ] Termina partita: messaggio di chiusura su tutti i telefoni

## Percezione
- [ ] Testi leggibili con luce forte / a distanza
- [ ] Touch target comodi con una mano
- [ ] Latenza percepita accettabile (risposta → conferma < 500ms)
```

- [ ] **Step 3: Aggiornare `DEV_ROADMAP.md`**

Aggiornare la sezione Fase 7 (stile delle Fasi 5/6):

```markdown
### Fase 7: Rifinitura UI e Playtesting Locale - *Completata (playtest Wi-Fi a carico dell'utente)*
- [x] Cablare il vero engine di gioco alla UI dell'Host (attivare controlli "disabilitati").
- [x] Sviluppare il Frontend Player finale ("mobile first", dinamico e reattivo).
- [ ] Connettere il PC e alcuni smartphone alla stessa rete Wi-Fi. *(Checklist: `docs/playtest-checklist.md`.)*
- [ ] Giocare una partita completa per testare latenza, socket, disconnessioni.
- [x] Bugfixing per arrivare alla versione Beta.
  *(Aggiunte Fase 7: avatar precaricati (emoji temporanee dietro `avatarId` stabile), riconnessione player con token e punteggio conservato, QR code in lobby host via `GET /api/host/game/join-info` + `qrcode-generator` vendored. Design spec: `docs/superpowers/specs/2026-07-02-fase7-ui-beta-design.md`.)*
```

- [ ] **Step 4: Verifica finale completa**

Run: `node tools/test-game.js && npm run test:socket && npm run lint`
Expected: tutto verde, exit 0.

- [ ] **Step 5: Commit**

```bash
git add DEV_ROADMAP.md docs/playtest-checklist.md
git commit -m "docs: chiusura Fase 7 — checklist playtest e roadmap aggiornata"
```

---

## Self-Review (eseguita)

- **Copertura spec:** Player UI (Task 5-6), avatar (Task 1, 5-7), riconnessione (Task 2, 6), QR + endpoint (Task 3-4, 7), area live host (Task 7), error handling (fallback join-info Task 7, overlay riconnessione Task 5-6), testing/playtest (Task 1-2 test estesi, Task 8). Percorso endpoint: la spec dice `/api/game/join-info`, il piano usa `/api/host/game/join-info` per riusare router e middleware esistenti — deviazione minima intenzionale.
- **Placeholder:** nessun TBD/TODO; unico rimando dichiarato: verifica del nome reale dell'helper fetch autenticato in `client/host/app.js` (Task 7 Step 2), istruzione esplicita su dove trovarlo.
- **Coerenza tipi:** ack `player:join` `{ playerId, token, avatar }` e `game:reset` `{ playerId, token }` coerenti tra Task 2 (server), Task 6 (player) e test; campi player `avatar`/`connected` coerenti tra Task 1, 2, 6, 7; `AVATARS`/`GAME_AVATARS` = stessi 12 id di `AVATAR_IDS`; classi CSS del Task 5 usate identiche nel Task 6, classi del Task 7 Step 3 usate identiche nello Step 2.
