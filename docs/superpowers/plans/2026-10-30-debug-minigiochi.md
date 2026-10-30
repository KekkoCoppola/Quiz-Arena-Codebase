# Schermata di debug dei minigiochi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pagina `/debug`, accesa solo con `DEBUG_TOOLS=1`, che fa partire ogni minigioco con un clic con bot e telefono finto, mostrando sala e telefono affiancati.

**Architecture:** Modulo server `server/debug-tools.js` agganciato a `game-socket.js` con una riga e un `ctx` che espone solo ciò che serve; eventi host-only `debug:minigames`, `debug:prepare`, `debug:play` che usano solo le API pubbliche di `GameSession`. Pagina statica `client/debug/` montata da `server/index.js` dietro il flag, con iframe di `/sala?muto` e `/`.

**Tech Stack:** Node 24 CommonJS, Express 4, Socket.io 4, JS vanilla.

**Spec:** `docs/superpowers/specs/2026-10-30-debug-minigiochi-design.md`

## Global Constraints

- **Nessun commit** (regola utente): al posto dei passi "Commit", `git status`.
- Spenta di default: `config.debugTools = process.env.DEBUG_TOOLS === '1'`; nessun `process.env` fuori da `config.js`.
- Spenta → `/debug` non servita (cade nel router player) e nessun handler `debug:*` registrato.
- Eventi `debug:*` solo host (`requireHost`), ack `{ ok, ... }` / `{ ok: false, error }`.
- Il modulo debug non scrive lo stato di `game-socket.js` se non attraverso `ctx`.
- Testi in italiano; stile della pagina con i token del pannello admin (DESIGN.md §7).
- Node in `D:\ISTALLAZION_PROGRAMMI` (`export PATH="/d/ISTALLAZION_PROGRAMMI:$PATH"`).

## Review Focus

- **`debug:play` fuori dalla LOBBY** (partita già avviata, round in corso) → ack `ok: false` con frase leggibile, nulla cambia (Task 1, test).
- **Tipo sconosciuto in `debug:play`** → `ok: false`, la partita resta in lobby (Task 1, test).
- **Pagina aperta senza login admin nel browser** → messaggio con link al pannello, nessun errore in console (Task 3, verifica).
- **"Prova" premuto due volte di fila** → la seconda partita sostituisce la prima senza telefoni orfani né bot doppi (Task 1: `debug:prepare` ripetuto → lobby con solo i bot nuovi).
- **Sala `?muto`** → nessun suono neanche dopo un clic sulla pagina (Task 2, verifica `SalaAudio.info()`).

---

### Task 1: eventi `debug:*` sul server

**Files:**
- Create: `server/debug-tools.js`
- Modify: `server/config.js` (`debugTools`), `server/game-socket.js` (aggancio dentro `io.on('connection')`, dopo `requireHost`), `.env.example` (riga commentata)
- Test: `tools/test-socket.js` (nuova Fase 11; nel server di prova `DEBUG_TOOLS: '1'` in `startServer`)

**Interfaces:**
- Produces: `attachDebugHandlers(socket, ctx)` con
  `ctx = { ok, fail, requireHost, getSession(): GameSession|null, newSession(quiz): GameSession, spawnBots(count): number, broadcastLobby(): void, emitQuestion(): void }`.
- Eventi:
  - `debug:minigames` → `{ ok: true, list }` (`listForUi()` del registry, voce `random` compresa);
  - `debug:prepare { bots }` → `{ ok: true, players }` — partita nuova sul quiz segnaposto `{ title: 'Debug minigiochi', questions: [{ text: 'Domanda segnaposto', options: ['A', 'B'], correct_index: 0, time_limit_s: 5 }], minigames: [] }`, bot con `testBots.normalizeCount`;
  - `debug:play { type }` → da `LOBBY`: `startGame()`, `endQuestion()`, `insertMinigame(type)`, `emitQuestion()`, ack `{ ok: true }`. Errori: senza partita → `'Prepara prima la partita.'`; non in LOBBY → `'La partita di prova è già partita: premi di nuovo un minigioco per ricominciare.'`; tipo non valido → `'Minigioco sconosciuto.'` (controllo con `isValidSlotType` **prima** di `startGame`, così la lobby resta intatta).

- [ ] **Step 1: Test (Fase 11 in `tools/test-socket.js`)**: socket senza token → `debug:prepare` `ok:false`; host `debug:minigames` → `list` contiene `cup_game` e `morra_cinese`; `debug:prepare { bots: 3 }` → `ok` e `players.length === 3`; di nuovo `debug:prepare { bots: 2 }` → `players.length === 2`; `debug:play { type: 'inesistente' }` → `ok:false` e un successivo `debug:play` valido funziona; un player entra, `debug:play { type: 'cup_game' }` → `game:question` con `kind === 'minigame'`, `minigameType === 'cup_game'`, `stage.index === 0`; secondo `debug:play` → `ok:false`; quattro `host:skip-round` + uno → `game:results` `skipped`; `host:next-question` → `game:final`.
- [ ] **Step 2:** `node tools/test-socket.js` → la Fase 11 fallisce (timeout dell'ack).
- [ ] **Step 3: Implementa** `config.debugTools`, `server/debug-tools.js` (in testa: cos'è e come toglierlo), l'aggancio in `game-socket.js` (`if (config.debugTools) attachDebugHandlers(socket, ctx)`), dove `newSession` fa `endCurrentGame`, imposta `currentQuiz`/`currentSession` con `SESSION_OPTIONS` e trasmette la lobby.
- [ ] **Step 4:** `node tools/test-socket.js` → `0 falliti`; `node tools/test-game.js` → `0 falliti`.
- [ ] **Step 5:** `git status`.

### Task 2: sala muta con `?muto`

**Files:**
- Modify: `client/sala/app.js` (la riga `SalaAudio.arm()` a fondo file)

- [ ] **Step 1: Verifica rossa nel browser**: `/sala?muto` → `SalaAudio.info().armed === true` (oggi l'audio si arma comunque).
- [ ] **Step 2: Implementa**: con `new URLSearchParams(location.search).has('muto')` la sala non chiama `SalaAudio.arm()` (commento: prove in silenzio, pagina di debug, remote control).
- [ ] **Step 3: Verifica verde**: `/sala?muto` → `armed === false`, anche dopo un clic sulla pagina; `/sala` senza parametro → `armed === true`.
- [ ] **Step 4:** `git status`.

### Task 3: la pagina `/debug`

**Files:**
- Create: `client/debug/index.html`, `client/debug/debug.js`, `client/debug/debug.css`
- Modify: `server/index.js` (mount `/debug` dietro `config.debugTools`, prima di `app.use('/', playerRouter)`), `CLAUDE.md` (sezione breve: cos'è, come si accende, come si toglie, comando nella lista)

**Interfaces:**
- Consumes: eventi del Task 1, `host:skip-round`, `host:next-question`; JWT in `localStorage['quizzata_token']`; iframe `/sala?muto` e `/`; nel telefono `#nickname-input` e `#join-btn`.

- [ ] **Step 1: Pagina.** Barra comandi: numero di bot (default 8), un bottone per voce di `debug:minigames`, "Salta round", "Avanti", riga di stato. Sotto: iframe sala in un riquadro 16:9 (la pagina interna a 1920×1080, ridotta con `transform: scale` sulla larghezza disponibile) e iframe telefono a 390×844 ridotto. Senza token: messaggio "Accedi prima al pannello admin" con link a `/admin-console`.
- [ ] **Step 2: Flusso di un clic su un minigioco**: `debug:prepare { bots }` → ricarica l'iframe del telefono, aspetta che `#nickname-input` esista, scrive "Tu", preme `#join-btn`, aspetta il `game:lobby-update` con un giocatore in più → `debug:play { type }`. Errori come riga di stato.
- [ ] **Step 3: Mount** in `server/index.js`.
- [ ] **Step 4: Verifica in browser** (server dev con `DEBUG_TOOLS=1` nel `.env`), con screenshot inviati all'utente: pagina caricata; clic su "Morra Cinese" → sipario in sala, telefono in partita, minigioco, risultati; clic su "Tre Bicchieri" → livello 1, "Salta round" → livello 2; "Avanti" a fine minigioco → premiazione. Console senza errori; con `DEBUG_TOOLS` assente `/debug` non mostra la pagina di debug.
- [ ] **Step 5:** `node tools/test-socket.js`, `node tools/test-game.js`, `node tools/test-minigames.js` → `0 falliti`; `git status`.
