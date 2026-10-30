# Salta round nei minigiochi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tasto "Salta round" nel pannello admin che chiude il round minigioco in corso con 0 punti a tutti e passa al successivo.

**Architecture:** Metodo puro `skipRound(now)` in `GameSession` che decide dove si va; evento host-only `host:skip-round` in `game-socket.js` che annulla i timer e trasmette il passo successivo (`game:question`, `game:results` con `skipped: true`, oppure `game:final`); bottone nel pannello admin e un ramo `skipped` in sala, telefono e host.

**Tech Stack:** Node 24 CommonJS, Socket.io 4, JS vanilla nei client.

**Spec:** `docs/superpowers/specs/2026-10-30-salta-round-design.md`

## Global Constraints

- **Nessun commit**: regola del progetto, si committa solo su richiesta esplicita dell'utente. Al posto dei passi "Commit" c'è "verifica `git status`".
- Solo round `kind: 'minigame'`; su una domanda del quiz il salto è un errore.
- Round saltato = 0 punti a tutti, anche a chi aveva risposto; nessun esito (`machineChoice: null`, `answers: []`).
- Livello intermedio → livello successivo; ultimo di più livelli → classifica (`RESULTS`); minigioco a un round → avanti senza classifica (round successivo o premiazione).
- Testi in italiano; nessun `process.env` fuori da `config.js`; Node in `D:\ISTALLAZION_PROGRAMMI` (`export PATH="/d/ISTALLAZION_PROGRAMMI:$PATH"`).

## Review Focus

- **Doppio clic dell'host** → deve saltare UN round, non due: il bottone si disattiva al clic e si riattiva solo al prossimo `game:question` minigioco (Task 3).
- **Salto durante sipario o mescolamento** (nessuno ha risposto, timer dei bot pendenti) → nessuna risposta tardiva di un bot sul round nuovo (Task 2, `clearQuestionTimer`).
- **Minigioco a un round come ultimo round della partita** → `game:final` con classifica, non un round inesistente (Task 1, test).
- **Telefono che rientra dopo un ultimo livello saltato** → stato `RESULTS` come sempre, nessun errore (Task 2, invariato da `player:rejoin`).
- **Salto chiesto fuori da un round minigioco** (domanda, RESULTS, lobby) → ack `{ ok: false, error }`, nulla cambia (Task 1 e 2).

---

### Task 1: `skipRound` nel motore

**Files:**
- Modify: `server/game.js` (classe `GameSession`, accanto a `nextQuestion`/`insertMinigame`; nuova classe errore accanto a `AnswersNotOpenError`; export)
- Test: `tools/test-game.js` (nuova sezione dopo "Fase 9c")

**Interfaces:**
- Produces: `skipRound(now = Date.now())` →
  `{ next: 'round' }` | `{ next: 'results', results }` | `{ next: 'final', leaderboard }`;
  `results` ha la stessa forma di `endQuestion()` con `skipped: true`, `machineChoice: null`, `revealMs: 0`, `answers: []`, `distribution` tutta a 0.
- Produces: `class NotAMinigameError extends Error` (messaggio: `'Si possono saltare solo i round dei minigiochi.'`), esportata.

- [ ] **Step 1: Scrivi i test** (sezione `🛑 Fase 9d: Salta round`), con lo stesso `QUIZ` e `GameSession(QUIZ, { rnd })`:
  - intermedio: insert `cup_game`, un giocatore risponde dopo l'anteprima, `skipRound(...)` → `next === 'round'`, `getCurrentRound().stage.index === 1`, punteggio del giocatore invariato, `state === 'QUESTION'`;
  - quattro salti di fila arrivano al 5° livello (`stage.index === 4`); il quinto salto → `next === 'results'`, `results.skipped === true`, `results.answers.length === 0`, `results.machineChoice === null`, `state === 'RESULTS'`, punteggi invariati;
  - round unico: insert `morra_cinese` a metà partita, `skipRound` → `next === 'round'` e il round corrente è la domanda successiva;
  - round unico come ultimo round: `morra_cinese` inserita dopo l'ultima domanda → `skipRound` → `next === 'final'`, `state === 'FINAL_LEADERBOARD'`;
  - errori: `skipRound` su una domanda → `NotAMinigameError`; da `RESULTS` → `InvalidStateError`.
- [ ] **Step 2:** `node tools/test-game.js` → i nuovi assert falliscono (`skipRound is not a function`).
- [ ] **Step 3: Implementa `skipRound`.** Assert stato `QUESTION`, round minigioco. Azzera `currentAnswers` e `_openResolution`. Se il round ha `stage` e `stage.index < stage.count - 1` → `currentRoundIndex++`, `_enterRound(now)`. Se ha `stage` ed è l'ultimo → `state = RESULTS`, ritorna `results` (costruito come in `endQuestion`, campi del contratto sopra, `isLastRound: this.isLastRound`, `leaderboard: this.getLeaderboard()`). Senza `stage` → come `nextQuestion` ma partendo da `QUESTION`: se `isLastRound` → `FINAL_LEADERBOARD` + `{ next: 'final', leaderboard }`, altrimenti avanza e `{ next: 'round' }`.
- [ ] **Step 4:** `node tools/test-game.js` → `0 falliti`; `node tools/test-minigames.js` → `0 falliti`.
- [ ] **Step 5:** `git status` (nessun commit).

### Task 2: evento `host:skip-round`

**Files:**
- Modify: `server/game-socket.js` (handler accanto a `host:next-question`)

**Interfaces:**
- Consumes: `currentSession.skipRound()` (Task 1).
- Produces: evento host-only `host:skip-round` `(payload, cb)` → `ok(cb)` / `fail(cb, err.message)`. Effetti: `'round'` → `emitQuestion(io)`; `'results'` → `results.serverNow = Date.now()` e `io.emit('game:results', results)` (niente `revealAt`, niente `stageTimer`); `'final'` → stesso ramo di `host:next-question` per la premiazione (`game:final` più l'annuncio di fine cerimonia, se presente lì).

- [ ] **Step 1: Implementa l'handler.** `requireHost(cb)`; sessione assente → `fail`. `clearQuestionTimer()` **prima** di `skipRound`, così timer del round, bot e filata sono annullati anche se il salto fallisce dopo. Per `'final'` riusa la stessa funzione/codice che usa `host:next-question` quando `result.finished` (estrailo in un helper se è inline).
- [ ] **Step 2: Verifica con uno script socket** (scratchpad, non nel repo): host JWT + 3 bot, partita, al primo `game:results` inserisce `cup_game`, durante il livello 1 emette `host:skip-round` → atteso `game:question` con `stage.index === 1` entro 300 ms e nessun `game:results` per il livello 1; quattro salti → `game:results` con `skipped: true`; `host:skip-round` su una domanda → ack `ok: false`. Stampa PASS/FAIL.
- [ ] **Step 3:** `npm run test:socket` → `0 falliti`.
- [ ] **Step 4:** `git status`.

### Task 3: bottone admin e ramo `skipped` nei client

**Files:**
- Modify: `client/host/index.html` (bottone in `.game-controls`, dopo `#game-next-btn`)
- Modify: `client/host/app.js` (abilitazione, clic, ramo `skipped` in `game:results`)
- Modify: `client/sala/app.js` (handler `game:results`)
- Modify: `client/player/app.js` (`renderFeedback` / handler `game:results`)

**Interfaces:**
- Consumes: `host:skip-round` (Task 2); `results.skipped` (Task 1).

- [ ] **Step 1: Pannello admin.** Bottone `#game-skip-btn` (`btn btn-accent btn-block btn-game`, icona `fast_forward`, testo "Salta round"), nascosto di default. Su `game:question`: visibile e attivo se `q.kind === 'minigame'`, altrimenti nascosto. Al clic: si disattiva subito, emette `host:skip-round`, su `ok: false` mostra l'errore col toast già usato dal pannello e si riattiva. Su `game:results` e `game:final`: nascosto. In `game:results` con `skipped: true`: stato "Round saltato: nessun punto assegnato.", niente `sala.reveal` né distribuzione, "Prossima" attivo come dopo ogni round.
- [ ] **Step 2: Sala.** In `game:results`, se `results.skipped`: `newPhase()`/`stopCountdown()` come oggi, poi direttamente `renderResults(results, token)` (niente `playReveal`, niente rullo, niente parata); nella riga reveal nessun testo.
- [ ] **Step 3: Telefono.** In `renderFeedback`, se `results?.skipped`: sticker `is-neutral`, testo "Round saltato", punti "+0 punti", senza chiamare il minigioco; posizione e attesa come per un round normale.
- [ ] **Step 4: Verifica in browser** (server dev, partita di debug con bot, `cup_game` inserito): screenshot del pannello admin con il bottone durante il livello 1; dopo un clic la sala mostra "Round 2 di 5"; quattro clic portano alla classifica in sala e "Round saltato" sul telefono; una Morra saltata passa alla domanda successiva senza classifica. Doppio clic rapido = un solo livello saltato. Console senza errori. Screenshot inviati all'utente.
- [ ] **Step 5:** `node tools/test-game.js`, `node tools/test-minigames.js`, `node tools/test-mg-cup-game.js` → tutti `0 falliti`; `git status`.
