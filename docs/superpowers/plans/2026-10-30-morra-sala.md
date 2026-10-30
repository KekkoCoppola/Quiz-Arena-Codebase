# Morra in sala: chi ha scelto e chi ha battuto il computer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In sala, durante la Morra, una colonna mostra chi ha già scelto (senza la mossa) e, dopo la ruota, gli stessi giocatori divisi per esito prima della classifica.

**Architecture:** Il server allarga `game:answer-count` (id di chi ha risposto, a tutti tranne i telefoni). Un modulo puro `client/sala/answer-roster.js` decide posti e gruppi; `sala/app.js` li disegna per ogni minigioco che dichiara `salaPlayers: true` nel contratto di presentazione.

**Tech Stack:** Node 24, Socket.io 4, JS vanilla (UMD come `audio-logic.js`), test standalone in `tools/`.

**Spec:** `docs/superpowers/specs/2026-10-30-morra-sala-design.md`

## Global Constraints

- Nessuna mossa di nessun giocatore visibile in sala prima della ruota; `game:answer-count` non porta mosse.
- `game:answer-count` non arriva ai telefoni (room `players`).
- Nessun `if (type === 'morra_cinese')` fuori dai file della Morra: tutto passa da `salaPlayers`.
- Telefono, pannello admin, Tre Bicchieri e domande del quiz invariati.
- Etichette dei gruppi, esatte: `Hanno vinto`, `Pareggio`, `Hanno perso`, `Non hanno scelto`. Contatore: `N / M hanno scelto`.
- Scena degli esiti 4-5 s, poi la classifica di sempre.
- Classi CSS con prefisso `.sala-roster`, token di `DESIGN.md` (bordi inchiostro, ombre piatte, niente grigio SaaS); posto in attesa leggibile dal fondo.
- Nessun commit senza autorizzazione dell'utente (i passi "Commit" si saltano).

## Review Focus

- Un giocatore che si disconnette a metà scelta senza aver risposto: il suo posto sparisce, il contatore segue il `total` del server (test in Task 2).
- Una risposta arrivata prima che la sala abbia l'elenco aggiornato (id non nel roster): non rompe la colonna, il posto non compare (test in Task 2).
- 24+ giocatori: la colonna non trabocca dalla scheda a 1920×1080 (verifica in Task 5, misurando `scrollHeight`).
- Round saltato dall'host durante la Morra: nessuna scena degli esiti, dritti alla classifica come oggi (verifica in Task 5).
- Nessuno ha risposto: la scena mostra solo "Non hanno scelto" con tutti, non un vuoto (test in Task 2).

---

### Task 1: `game:answer-count` con gli id, fuori dalla room dei telefoni

**Files:**
- Modify: `server/game-socket.js` (i due `io.to(ROOM_HOST).emit('game:answer-count', …)`, in `scheduleBotAnswers` e in `player:answer`)
- Test: `tools/test-socket.js` (Fase 3)

**Interfaces:**
- Produces: evento `game:answer-count` `{ answered: number, total: number, playerIds: string[] }` (id in ordine d'arrivo), emesso con `io.except(ROOM_PLAYERS)`; helper `emitAnswerCount(io)` in `game-socket.js` usato da entrambi i punti.

- [ ] **Step 1: Test.** In Fase 3, prima della risposta di Alice, `const countPromise = once(impostor, 'game:answer-count')` e un ascoltatore su `p2` che segna `phoneGotCount = true`. Dopo la risposta di Alice:
  - `assert(count.answered === 1 && count.playerIds.length === 1 && count.playerIds[0] === alice.playerId, 'game:answer-count: arriva anche a un socket senza ruolo (la sala) con gli id di chi ha risposto')` (usare l'id di Alice dal suo ack di join già presente nel test);
  - dopo i risultati: `assert(phoneGotCount === false, 'game:answer-count: i telefoni non lo ricevono')`.
- [ ] **Step 2:** `node tools/test-socket.js` → FAIL sulle due asserzioni nuove.
- [ ] **Step 3:** `emitAnswerCount(io)` con `playerIds: [...currentSession.currentAnswers.keys()]`, sostituito ai due emit.
- [ ] **Step 4:** `node tools/test-socket.js` → tutto verde.

### Task 2: modulo puro dei posti e dei gruppi

**Files:**
- Create: `client/sala/answer-roster.js` (UMD come `client/sala/audio-logic.js`, `window.AnswerRoster`)
- Create: `tools/test-roster.js`; `package.json`: `"test:roster": "node tools/test-roster.js"`

**Interfaces:**
- Produces:
  - `seatsForRound(players, answeredIds) → Array<{ id, nickname, avatar, answered: boolean }>`: un posto per ogni giocatore connesso o presente in `answeredIds`, nell'ordine di `players` (ingresso in partita); id sconosciuti ignorati.
  - `outcomeGroups(results) → Array<{ outcome: 'win'|'draw'|'lose'|'none', label, points: number, players: Array<{ id, nickname, avatar }> }>`: ordine win, draw, lose, none; gruppi vuoti omessi; `points` = `pointsAwarded` delle risposte del gruppo (0 per `none`); `none` = voci di `results.leaderboard` (campo `id`) senza risposta in `results.answers` (campo `playerId`).
  - `OUTCOME_LABELS = { win: 'Hanno vinto', draw: 'Pareggio', lose: 'Hanno perso', none: 'Non hanno scelto' }`.

- [ ] **Step 1: Test** in `tools/test-roster.js` (helper `assert` locale come gli altri `tools/test-*.js`), con tre giocatori A, B (connessi), C (`connected: false`):
  - `seatsForRound(players, [])` → id `['A','B']`, tutti `answered: false`;
  - `seatsForRound(players, ['B'])` → B `answered: true`, ordine invariato `['A','B']`;
  - `seatsForRound(players, ['C'])` → C compare (ha risposto prima di cadere), ordine `['A','B','C']`;
  - `seatsForRound(players, ['Z'])` → id sconosciuto ignorato, nessun errore;
  - `outcomeGroups` con A win (500), B draw (100), C senza risposta → `[win:[A] points 500, draw:[B] points 100, none:[C] points 0]`, nessun gruppo `lose`, label esatte;
  - `outcomeGroups` senza risposte → un solo gruppo `none` con tutti;
  - risultato saltato (`answers: []`, `skipped: true`) non è compito del modulo: nessun test.
- [ ] **Step 2:** `node tools/test-roster.js` → FAIL (modulo assente).
- [ ] **Step 3:** implementare il modulo.
- [ ] **Step 4:** `npm run test:roster` → verde.

### Task 3: campo `salaPlayers` nel contratto, Morra lo dichiara

**Files:**
- Modify: `client/shared/minigames/index.js` (`DEFAULT_PRESENTATION`), `client/shared/minigames/morra-cinese.js`, `client/shared/minigames/_TEMPLATE.js` (riga di documentazione), `tools/test-minigames.js:355`

**Interfaces:**
- Produces: `presentation.salaPlayers: boolean` (default `false`). Morra: `salaOptions: false`, `salaPlayers: true`.

- [ ] **Step 1: Test.** L'asserzione di riga 355 (`morra.salaOptions === true`) diventa sul fallback: `Minigames.get('tipo_mai_visto').salaOptions === true`; nuove: `fallback.salaPlayers === false` ('senza dichiararlo, un minigioco non mostra la colonna dei giocatori'), `morra.salaPlayers === true && morra.salaOptions === false` ('la Morra mostra in sala chi ha scelto, non le carte').
- [ ] **Step 2:** `npm run test:minigames` → FAIL sulle nuove.
- [ ] **Step 3:** campo documentato in `DEFAULT_PRESENTATION` come gli altri (cosa mostra durante il round e cosa a round chiuso); Morra lo dichiara; riga nel template.
- [ ] **Step 4:** `npm run test:minigames` → verde.

### Task 4: la colonna durante la scelta

**Files:**
- Modify: `client/sala/index.html` (dentro `#sala-question`, dopo `#sala-options`: `<div class="sala-roster" id="sala-roster" hidden><p class="sala-roster-count" id="sala-roster-count"></p><ul class="sala-roster-seats" id="sala-roster-seats"></ul></div>`; `<script src="answer-roster.js">` prima di `app.js`)
- Modify: `client/sala/app.js`, `client/sala/style.css`

**Interfaces:**
- Consumes: `AnswerRoster.seatsForRound` (Task 2), `salaPlayers` (Task 3), `game:answer-count` (Task 1).
- Produces in `app.js`: `currentPlayers` (array, aggiornato da `game:lobby-update` e `game:snapshot`), `rosterAnswered` (array di id del round), `renderRoster(total)`; classe `has-roster` su `#sala-question`.

- [ ] **Step 1:** `renderQuestion`: con `salaPlayers` → `has-roster` e niente `is-stage-only` (anche se `salaOptions` è `false`), niente carte, `rosterAnswered = []`, `renderRoster()`; altrimenti `#sala-roster` nascosto. `newPhase` non deve cancellare `currentPlayers`.
- [ ] **Step 2:** `socket.on('game:answer-count', …)`: solo se il round corrente ha `has-roster`; aggiorna `rosterAnswered`, ridisegna; i posti appena girati prendono una classe di scatto (`is-new`); effetto `SalaAudio.sfx('avatar-land')` al massimo uno ogni 120 ms. `game:lobby-update` in partita ridisegna la colonna se presente.
- [ ] **Step 3:** posto: `AvatarSprite.fill` + nome + spunta verde se ha scelto; tratteggiato con "?" e nome se no. Contatore `${answered} / ${total} hanno scelto` (`total` dal server, prima della prima risposta = numero di posti).
- [ ] **Step 4: CSS.** `#sala-question.has-roster`: stessa griglia di `.is-minigame.is-split` con `.sala-roster` al posto di `.sala-options`; la misura dei posti scende col numero (`--seat-count` impostata da `renderRoster`), con 24 posti i nomi ci stanno, oltre si tolgono i nomi (`.is-crowded`). `fitQuestionLayout`: `has-roster` passa a `is-split` come un minigioco con carte.
- [ ] **Step 5: Verifica.** Server del worktree su 3001 con `DEBUG_TOOLS=1` (il server dell'utente su 3000 non va toccato), `/debug`, Morra con 19 bot: la colonna si riempie durante la scelta, il contatore arriva a `20 / 20`, console pulita. Con 30 bot: `scrollHeight <= clientHeight` della colonna.

### Task 5: la scena degli esiti dopo la ruota

**Files:**
- Modify: `client/sala/app.js` (`runResultsScene`), `client/sala/style.css`, `CLAUDE.md`

**Interfaces:**
- Consumes: `AnswerRoster.outcomeGroups`, `OUTCOME_LABELS` (Task 2).
- Produces: `runOutcomeScene(results, token, onDone)`; costanti `OUTCOME_GROUP_STEP_MS = 700`, `OUTCOME_SCENE_MS = 4500`.

- [ ] **Step 1:** in `runResultsScene`, prima del ramo `salaOptions === false`: con `salaPlayers` → `runOutcomeScene(results, token, () => renderResults(results, token))`.
- [ ] **Step 2:** `runOutcomeScene` svuota la colonna e la riempie di gruppi (titolo + punti, es. `Hanno vinto · +500`, poi i posti), uno ogni `OUTCOME_GROUP_STEP_MS`, con `sceneWait` e controllo `AudioLogic.isStale`; `SalaAudio.sfx('reveal')` sul gruppo dei vincitori, `'avatar-land'` sugli altri; `onDone` a `OUTCOME_SCENE_MS`. Movimento ridotto: gruppi già fatti, nessuna animazione.
- [ ] **Step 3: CSS** dei gruppi (`.sala-roster-group`, colore d'accento per esito con i token della sala).
- [ ] **Step 4: CLAUDE.md:** nel paragrafo "Il palco in sala" una frase su `salaPlayers` (colonna di chi ha scelto via `game:answer-count` con `playerIds`, scena degli esiti); nella sezione eventi, `game:answer-count` va a tutti tranne i telefoni.
- [ ] **Step 5: Verifica** su `/debug` (3001): dopo la ruota i gruppi corrispondono agli esiti (confronto con `results.answers` in console), poi classifica; "Salta round" sulla Morra → classifica senza scena; Tre Bicchieri invariato. Screenshot all'utente, sala `?muto`.
- [ ] **Step 6:** suite completa: `test-game`, `test-socket`, `test-minigames`, `test-roster`, `test-audio`, `test-final`, `test-clock`, `test-avatar`, `test-quizzes`, `test-db`, `test-stage-intro` → tutte verdi.
