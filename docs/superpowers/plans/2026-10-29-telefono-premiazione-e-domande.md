# Telefono: premiazione finale e domande — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sul telefono, la premiazione diventa "Guarda lo schermo!" seguito dalla propria posizione in grande con la classifica intera; le domande lunghe si troncano con "Leggi tutta" e quelle con immagine avvisano di guardare il maxischermo.

**Architecture:** Il server annuncia la fine della cerimonia con `game:ceremony-done`, dopo una durata calcolata dallo stesso calendario condiviso (`client/shared/final-schedule.js`) e dice a chi rientra se è già finita (`ceremonyDone`). Il telefono smette di seguire gli atti della cerimonia: segnaposto fino al segnale, poi una schermata statica. La vista domanda cambia solo lato client.

**Tech Stack:** Node.js v24, Socket.io, JS vanilla senza bundler, script di test standalone in `tools/`.

**Spec:** `docs/superpowers/specs/2026-10-29-telefono-premiazione-e-domande-design.md`

## Global Constraints

- Nessun commit senza autorizzazione esplicita dell'utente per questo lavoro (regola del progetto): i passi "Checkpoint" propongono il commit, non lo eseguono.
- La vista sala (`client/sala/`) non si tocca: la sua cerimonia resta quella attuale.
- Nuovi elementi visivi solo con token/pattern di DESIGN.md e del foglio `client/player/style.css` (bordi 4px `--ink`, ombre offset piatte `--stamp-sm`, adesivi ruotati, Quicksand 700–900).
- Testi fissati dallo spec: "Guarda lo schermo!", "Grazie per aver giocato!", "Leggi tutta", "📺 Guarda l'immagine sul maxischermo".
- Il telefono non deve mai mostrare una posizione prima di `game:ceremony-done` (o di `ceremonyDone: true` al rientro).
- Nessun modulo diverso da `server/config.js` legge `process.env`.

## Review Focus

1. **Rientro a metà cerimonia**: un telefono che si riconnette prima della fine deve vedere il segnaposto e passare alla posizione quando arriva `game:ceremony-done`, mai la classifica subito. → test in Task 1 (rejoin con `ceremonyDone === false`).
2. **Host che riavvia o termina durante la cerimonia**: il timer non deve emettere `game:ceremony-done` dentro la partita nuova. → test in Task 1 (Fase 6: nessun evento dopo `host:restart-game`).
3. **Domanda corta**: "Leggi tutta" non deve comparire se il testo sta nelle tre righe. → verifica in Task 3.
4. **Classifica lunga (20 giocatori)**: la barra fissa non deve coprire l'ultima riga della classifica. → verifica in Task 2.
5. **Giocatore che non risulta in classifica**: segnaposto o posizione non devono restare vuoti né lanciare eccezioni. → verifica in Task 2.

---

### Task 1: Fine cerimonia annunciata dal server

**Files:**
- Modify: `client/shared/final-schedule.js` (aggiunta export)
- Modify: `server/game-socket.js` (emissione `game:final` ~riga 440, `clearQuestionTimer` ~riga 69, risposta `player:rejoin` ~righe 362-368)
- Test: `tools/test-final.js`, `tools/test-socket.js`

**Interfaces:**
- Produces: `FinalSchedule.ceremonyDurationMs(playerCount: number) → number` = `buildFinalSchedule({ playerCount }).totalMs + PLAYER_LAG_MS` (0 giocatori → 0).
- Produces: evento broadcast `game:ceremony-done` (payload `{}`), una volta per partita conclusa.
- Produces: risposta di `player:rejoin` in `FINAL_LEADERBOARD` con `ceremonyDone: boolean`.

- [ ] **Step 1: Test puro in `tools/test-final.js`**

```js
assert(ceremonyDurationMs(2) === buildFinalSchedule({ playerCount: 2 }).totalMs + PLAYER_LAG_MS,
  'durata cerimonia = calendario + ritardo del telefono');
assert(ceremonyDurationMs(1) === buildFinalSchedule({ playerCount: 1 }).totalMs + PLAYER_LAG_MS,
  'durata cerimonia con un solo giocatore');
assert(ceremonyDurationMs(0) === 0, '0 giocatori → nessuna attesa');
```

- [ ] **Step 2: `node tools/test-final.js`** → FAIL (`ceremonyDurationMs` non definita).

- [ ] **Step 3: Implementa `ceremonyDurationMs` in `final-schedule.js`** ed esportala. Commento: è la durata che il server aspetta prima di liberare i telefoni.

- [ ] **Step 4: `node tools/test-final.js`** → PASS.

- [ ] **Step 5: Test socket in `tools/test-socket.js`**
  - Fase 6, subito dopo `restartAck`: aspetta `game:ceremony-done` su `p1` per 6000 ms con un helper che risolve `null` allo scadere (es. `onceOrNull(socket, event, ms)`), e `assert(stray === null, 'host:restart-game annulla la fine cerimonia della partita chiusa')`.
  - Fase 8: memorizza l'ack di join di Zoe (`const joined3 = await emitAck(p3, 'player:join', …)`). Dopo `final8`, da un socket nuovo (aggiunto a `sockets`): `player:rejoin` con `joined3.token` → `assert(r.state === 'FINAL_LEADERBOARD' && r.ceremonyDone === false, …)`. Poi `await once(p3r, 'game:ceremony-done', 5000)` (Zoe è ora legata al socket nuovo) e un secondo rejoin → `assert(r2.ceremonyDone === true, …)`. Solo dopo, l'`host:end-game` già presente.

- [ ] **Step 6: `npm run test:socket`** → FAIL sulle nuove asserzioni.

- [ ] **Step 7: Implementa in `game-socket.js`**
  - Stato di modulo: `let ceremonyTimer = null; let ceremonyDone = false;`.
  - Dove si emette `game:final`: `ceremonyDone = false` e avvia `ceremonyTimer = setTimeout(…, FinalSchedule.ceremonyDurationMs(result.leaderboard.length))`; allo scadere `ceremonyDone = true; io.emit('game:ceremony-done', {})`. `FinalSchedule` viene da `require('../client/shared/final-schedule.js')` (modulo UMD puro, nessun DOM).
  - Annullamento: in `clearQuestionTimer()` (chiamata da riavvio e fine partita) azzera anche `ceremonyTimer`. Verifica che `host:end-game` passi da lì; se no, aggiungi la chiamata.
  - `player:rejoin`: nel ramo `FINAL_LEADERBOARD` aggiungi `data.ceremonyDone = ceremonyDone`.

- [ ] **Step 8: `npm run test:socket` e `node tools/test-final.js`** → tutti PASS.

- [ ] **Step 9: Checkpoint** — proponi il commit all'utente: `feat(final): il server annuncia la fine della cerimonia`.

---

### Task 2: Schermata finale del telefono

**Files:**
- Modify: `client/player/index.html` (sezione `#screen-final`, righe ~69-79)
- Modify: `client/player/app.js` (blocco cerimonia righe ~399-640, `game:final` ~712, `game:reset`/`game:ended`, `tryRejoin` ramo `FINAL_LEADERBOARD` ~756)
- Modify: `client/player/style.css` (regole `.me-card`, `.me-rank`, `.final-list`, `.podium*` righe ~246-323)
- Modify: `client/shared/final-schedule.js`, `tools/test-final.js` (rimozione di ciò che serviva solo al telefono)
- Modify: `CLAUDE.md` (paragrafo sulla premiazione finale)

**Interfaces:**
- Consumes: `game:ceremony-done` e `ceremonyDone` dal Task 1.
- Produces (interne a `app.js`): `showFinalPlaceholder(leaderboard)`, `renderFinalResult(leaderboard)`.

- [ ] **Step 1: Markup** — `#screen-final` contiene: un blocco segnaposto (`#final-placeholder`: icona 📺, "Guarda lo schermo!", riga secondaria "La tua posizione arriva subito dopo."), una card posizione (`#final-me-card`), la lista completa (`#final-list`), una barra fissa (`#final-bar`) con "Grazie per aver giocato!". Rimuovi `#final-podium`, `#final-me`, `#final-rest`, `#final-waiting`.

- [ ] **Step 2: Logica in `app.js`**
  - `game:final` → `showFinalPlaceholder(leaderboard)`: salva la classifica (ordinata per punteggio, `rank = i + 1`, come fa oggi `renderFinal`), mostra solo il segnaposto, `show('final')`.
  - `game:ceremony-done` → `renderFinalResult(classificaSalvata)`; ignorato se `!playerId` o se non c'è una classifica salvata.
  - `renderFinalResult`: card con `ordinale(me.rank)` in grande, avatar, nickname, punti, adesivo "su N"; per `rank <= 3` classe colore medaglia (stessi colori dei gradini attuali: 1 `--insert-coin-yellow`, 2 `--arcade-teal`, 3 `--ticket-ochre`) e `window.Confetti?.burst(...)`. Sotto, **tutti** i giocatori in `#final-list` con la riga propria evidenziata. Se il giocatore non è in classifica: niente card, solo lista.
  - `tryRejoin` in `FINAL_LEADERBOARD`: `res.ceremonyDone ? renderFinalResult(lb) : showFinalPlaceholder(lb)`.
  - Rimuovi `runCeremony`, `playBeat`, `buildMyTailCard`, `addSparkles` (se non più usata), `POP_MS`, `ceremonyTimers`/`stopCeremony` e le chiamate in `game:reset`/`game:ended` (sostituite da un azzeramento della classifica salvata).
  - Movimento ridotto: stessa logica, nessuna animazione d'ingresso né coriandoli.

- [ ] **Step 3: Stile** — `#final-bar` è `position: fixed` in fondo, larghezza della colonna `.screen` (max 480px), bordo superiore 4px `--ink`, sfondo `--insert-coin-yellow`; la schermata finale ha un `padding-bottom` pari all'altezza della barra così l'ultima riga resta visibile. Riga propria in lista: sfondo `--arcade-teal`. Elimina le regole rimaste senza markup (`.me-rank`, `.podium*`, `.me-card .podium-step*`, `.me-card-row*`).

- [ ] **Step 4: Pulizia del calendario** — in `final-schedule.js` rimuovi `stepsForRank`, `KINDS_BY_RANK`, `SHARED_KINDS` (solo il telefono li usava; la sala no). In `tools/test-final.js` rimuovi le asserzioni che usano `stepsForRank` (blocco con `mine2`/`mine1`/`mine7`), tieni quelle su `revealAtForRank` (ordine di scoperta in sala, compreso argento dopo il vincitore). `node tools/test-final.js` → PASS.

- [ ] **Step 5: CLAUDE.md** — nel paragrafo "premiazione finale": il telefono non segue più gli atti; mostra "Guarda lo schermo!" fino a `game:ceremony-done` (emesso dal server dopo `ceremonyDurationMs`), poi posizione e classifica intera. Rimuovi i riferimenti a `stepsForRank` e alla scoperta del secondo sul telefono; la regola anti-spoiler diventa "nessuna posizione sul telefono prima del segnale del server".

- [ ] **Step 6: Verifica nel browser** (`preview_start` del dev server, pannello host in una scheda, player in un'altra a viewport mobile; dieci clic sul logo della schermata di partita aggiungono 19 bot):
  - durante la premiazione il player mostra solo il segnaposto, identico che sia 1° o 15°;
  - a cerimonia finita: card posizione, lista di 20 righe con la propria evidenziata, barra fissa che non scorre, ultima riga non coperta dalla barra;
  - ricarica la pagina del player a metà cerimonia → segnaposto, poi posizione; ricarica a cerimonia finita → posizione subito;
  - console senza errori.

- [ ] **Step 7: Checkpoint** — proponi il commit: `feat(player): premiazione con segnaposto e posizione in grande`.

---

### Task 3: Domanda lunga e avviso immagine

**Files:**
- Modify: `client/player/index.html` (sezione `#screen-question`)
- Modify: `client/player/app.js` (`renderQuestion` ~riga 219)
- Modify: `client/player/style.css` (`.question-text` riga ~181 e media query ~374-396)

**Interfaces:**
- Consumes: `q.image` (oggetto `{ hash, blur }` o assente) già nel payload `game:question` / `player:rejoin`.

- [ ] **Step 1: Markup** — dopo `#question-text`: un bottone `#question-more` ("Leggi tutta", `hidden` di default) e un adesivo `#question-image-hint` ("📺 Guarda l'immagine sul maxischermo", `hidden`). Ordine: testo, bottone, adesivo, poi `#answer-buttons`.

- [ ] **Step 2: Logica in `renderQuestion`**
  - Ogni nuova domanda riparte chiusa: classe `is-clamped` sul testo, bottone nascosto.
  - Dopo aver messo il testo: se `questionText.scrollHeight > questionText.clientHeight` mostra `#question-more`. Il clic commuta `is-clamped`/`is-open` e l'etichetta ("Leggi tutta" ↔ "Chiudi").
  - `#question-image-hint.hidden = !q.image` (anche nei round minigioco resta nascosto, perché non hanno `image`).

- [ ] **Step 3: Stile**
  - `.question-text.is-clamped`: `display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;`.
  - `.question-text.is-open`: altezza massima fissa (circa 5 righe dell'interlinea corrente) e `overflow-y: auto`, bordo 3px `--ink` e sfondo `--paper-white` per far capire che scorre. Così i bottoni di risposta stanno sempre nella stessa posizione, aperta o chiusa.
  - `#question-more`: pillola piccola con bordo `--ink` e `--stamp-sm`. `#question-image-hint`: adesivo `--arcade-teal` / `--arcade-teal-deep` leggermente ruotato, come il resto degli adesivi.

- [ ] **Step 4: Verifica nel browser** (stesso setup del Task 2, con un quiz che abbia una domanda lunga e una con immagine, o un quiz personale creato dall'editor):
  - domanda corta: niente "Leggi tutta";
  - domanda lunga: tre righe coi puntini, "Leggi tutta" apre un riquadro scorrevole, la posizione dei bottoni di risposta (`getBoundingClientRect().top` del primo) è identica aperta e chiusa;
  - domanda con immagine: adesivo sotto il testo; domanda successiva senza immagine: adesivo sparito;
  - round minigioco: nessuno dei due elementi.

- [ ] **Step 5: Checkpoint** — proponi il commit: `feat(player): domande lunghe troncate e avviso immagine`.
