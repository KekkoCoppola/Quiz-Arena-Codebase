# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Quiz-Zata! — motore di gioco a quiz multiplayer locale in stile Kahoot, pensato per girare interamente offline su un Raspberry Pi configurato come Access Point Wi-Fi (nessuna infrastruttura esterna, nessuna dipendenza internet durante l'evento). L'host conduce la partita da un pannello dedicato; i player si uniscono da browser mobile senza installare nulla.

Il progetto è sviluppato con un approccio **Game-First**: tutto il gioco viene costruito e validato su PC/Windows prima di affrontare i vincoli hardware (licenza SaaS, Access Point) che richiedono il Raspberry Pi fisico. Vedi [DEV_ROADMAP.md](DEV_ROADMAP.md) per lo stato di avanzamento per fase ("Step N" nel codice = "Fase N" nella roadmap, stessa numerazione).

## Design Context

Registro: **product**. Contesto strategico completo in [PRODUCT.md](PRODUCT.md), sistema visivo ("Retro Street", neo-brutalismo da sala giochi: bordi 4px, ombre offset dure senza blur, badge sticker ruotati, palette calda satura, Quicksand bold 700-900) in [DESIGN.md](DESIGN.md). **Leggerli prima di qualunque lavoro su `client/host/` o `client/player/`.**

## Commands

```bash
npm run dev          # avvia il server con --watch (riavvio automatico su modifica file)
npm start            # avvia il server senza watch
npm run lint         # npx eslint . — NOTA: nessuna config eslint è ancora presente nel repo
npm run test:socket  # test di integrazione Socket.io end-to-end (tools/test-socket.js)
npm run test:minigames       # registry minigiochi: autoload, contratto, shuffle bag, presentazione client
node tools/test-game.js      # smoke test puro della state machine (server/game.js), nessuna rete
node tools/test-db.js        # smoke test del layer dati SQLite (server/quiz-manager.js)
node tools/test-audio.js     # smoke test delle decisioni pure del comparto audio host
node tools/create-host.js    # crea un account host offline (username/password) — unico modo per provisionare un host
node tools/seed-preloaded.js # popola la tabella preloaded_quizzes con i quiz di sistema
```

Non esiste un framework di test (Jest/Mocha/ecc.): i file in `tools/test-*.js` sono script standalone con un helper `assert()` locale che stampano PASS/FAIL e uscita con `process.exitCode`. Per eseguire "un singolo test" in pratica si esegue lo script intero (`test-game.js` e `test-db.js` sono puri/in-memory e girano in isolamento; `test-socket.js` fa da client Socket.io reale contro un server avviato).

Setup locale: copiare `.env.example` in `.env` e valorizzare almeno `JWT_SECRET` (il server rifiuta di avviarsi senza — vedi `server/config.js`). Il DB SQLite (`server/db/database.sqlite`) viene creato/migrato automaticamente al boot, non richiede step manuali.

Node.js **v24+** è richiesto (non v22): il progetto usa `node:sqlite` (`DatabaseSync`, API sincrona), stabile solo da v24. Questa è una scelta deliberata per eliminare moduli nativi da compilare per il packaging SEA finale su ARM.

## Architecture

### Le tre "macchine" e la separazione delle responsabilità

Il backend è organizzato a strati con confini di responsabilità intenzionalmente rigidi (rispettarli quando si aggiunge codice):

- **`server/game.js`** — state machine di gioco **pura**, in-memory, senza alcuna dipendenza da Express/Socket.io/rete. `GameSession` riceve un quiz già caricato e gestisce l'intero ciclo `LOBBY → QUESTION → RESULTS → (loop) → FINAL_LEADERBOARD`. Ogni metodo sensibile al tempo accetta un parametro opzionale `now` (default `Date.now()`) invece di usare `setTimeout` internamente — questo la rende testabile in modo sincrono e deterministico (vedi `tools/test-game.js`). Il punteggio è calcolato in `_computeScore`: lineare tra `POINTS_MAX` (1000, risposta istantanea) e `POINTS_MIN` (100, risposta corretta all'ultimo istante), 0 se il tempo scade o la risposta è sbagliata.
  - **Round e minigiochi**: la sequenza di gioco non è `quiz.questions` ma `this.rounds` (`currentRoundIndex`, `getCurrentRound()`), costruita in costruttore da `buildRounds()`. Un round è o una domanda vera (`kind: 'question'`, autorata, con `correct_index`) o un minigioco (`kind: 'minigame'`, dal registry in `server/minigames/`). Un minigioco **non** è una domanda camuffata: ha una meccanica propria "gioca contro il PC + reveal". Il tipo espone `build()` (round senza `correct_index`) e `resolve(rnd)` che alla **chiusura** estrae uno stato macchina (es. `machineChoice` di Morra Cinese) e classifica ogni scelta in `win`/`draw`/`lose`. Per questo lo scoring è **differito**: `submitAnswer` su un minigioco registra solo la scelta e ritorna `{ recorded: true }` (nessun esito rivelato → suspense), mentre `endQuestion` chiama `resolve()`, assegna `outcome` + `pointsAwarded` (da `points`) e li somma alla stessa classifica delle domande. Il payload di `endQuestion`/`game:results` espone `correctIndex` (domanda) **oppure** `machineChoice`+`outcome` (minigioco); l'altro è `null`. I minigiochi si inseriscono pianificati in editor (`quiz.minigames: [{ afterQuestionIndex, type }]`, applicati in `buildRounds`) o ad-hoc via `insertMinigame(type)` (solo da `RESULTS`, splice + `nextQuestion()`). In entrambi i casi `type` può essere il segnaposto `'random'` (`RANDOM_TYPE`), risolto **al momento dell'uso** dal sacchetto per-sessione `this._minigameBag`: i client ricevono sempre un `minigameType` concreto, mai `'random'`. `GameSession` accetta un secondo argomento `{ rnd }` per iniettare il generatore casuale nei test, stessa filosofia del parametro `now`.
- **`server/minigames/`** — registry dei minigiochi, **un file per gioco**. `index.js` carica automaticamente ogni `*.js` della cartella (esclusi `index.js` e i file `_*`), ne valida il contratto **all'avvio** — eseguendo davvero `build()` e `resolve()` a vuoto, quindi entrambe devono essere pure — ed espone `MINIGAME_TYPES`, `MINIGAME_TYPE_KEYS`, `RANDOM_TYPE`, `get()`, `isValidSlotType()`, `listForUi()`, `createShuffleBag()`. Un modulo malformato **impedisce l'avvio del server**: è deliberato, meglio un boot fallito di un minigioco che si rompe davanti a una sala. Il nome del file è la fonte di verità del tipo (`morra-cinese.js` → `morra_cinese`). Per le validazioni usare `isValidSlotType()`, mai `MINIGAME_TYPE_KEYS.includes()` a mano.
- **`server/game-socket.js`** — layer di rete che espone `GameSession` via eventi Socket.io. Gestisce **una sola partita globale in memoria** (`currentSession`), l'autenticazione host via JWT nell'handshake del socket (`socket.handshake.auth.token`, stesso segreto delle API REST), i timer reali (`setTimeout`) per la chiusura domande con chiusura anticipata quando tutti i connessi hanno risposto, e la riconnessione player tramite token opachi (`playerTokens: Map<token, playerId>`) che sopravvivono a un `disconnect` durante la partita (il punteggio resta, solo `connected` cambia). In `LOBBY` invece la disconnessione rimuove il giocatore definitivamente.
- **`server/quiz-manager.js`** — **unico** punto di contatto con SQLite (`node:sqlite`, pattern singleton via `initDb()`/`getDb()`). Nessun altro modulo deve toccare `node:sqlite` direttamente. Tutte le funzioni sono sincrone. Le domande (`questions`) e gli slot minigioco pianificati (`minigames`) sono salvati come colonne TEXT con JSON serializzato e vengono deserializzati in `parseQuizRow`. Le migrazioni di colonna su tabelle già esistenti (es. l'aggiunta di `minigames`) vanno fatte con `ALTER TABLE ADD COLUMN` avvolto in try/catch che ignora "duplicate column name" (`addColumnIfMissing`) — la build SQLite di `node:sqlite` non supporta `ADD COLUMN IF NOT EXISTS` nonostante la versione lo consenta in astratto.

Non aggirare questi confini: nuova logica di gioco va in `game.js` (deve restare testabile senza rete), nuova logica di rete/socket va in `game-socket.js`, nuovo accesso dati va in `quiz-manager.js`.

### Provisioning host (closed, non self-service)

Gli account host **non** si creano via API pubblica: `server/routes/host.js` espone solo login + CRUD quiz. Le credenziali vengono create offline dall'amministratore con `node tools/create-host.js`. Tenerlo a mente prima di aggiungere un endpoint di registrazione: è una scelta di prodotto (evento controllato da un unico host per sessione), non una svista.

### Autenticazione: due canali paralleli, un solo segreto

- **REST** (`/api/host/*`): JWT in header `Authorization: Bearer <token>`, verificato da `server/middleware/auth.js` (`verifyToken`), che attacca `req.user = { userId, username }`.
- **Socket.io**: lo stesso JWT viene passato in `socket.handshake.auth.token` alla connessione; se valido, il socket diventa "host" (`socket.data.isHost = true`, entra nella room `host`) — altrimenti resta un socket "player" non privilegiato. Ogni evento host-only nel game-socket chiama `requireHost(cb)` come guardia esplicita.

Entrambi i canali condividono `config.jwtSecret` da `server/config.js`. **Nessun modulo diverso da `config.js` deve leggere `process.env` direttamente** — è una regola esplicita nel codice, non solo una convenzione.

### Rooms Socket.io e formato eventi

Due room: `players` (tutti i giocatori) e `host` (socket con JWT valido). Gli handler seguono la convenzione `<ruolo>:<azione>` per gli eventi in ingresso (`player:join`, `player:answer`, `host:start-game`, `host:next-question`, `host:insert-minigame`, `host:restart-game`, `host:end-game`) e `game:<evento>` per il broadcast in uscita (`game:lobby-update`, `game:question`, `game:results`, `game:final`, `game:snapshot`, `game:reset`, `game:ended`). Gli ack callback usano sempre la forma `{ ok: true, ...data }` / `{ ok: false, error }` tramite gli helper `ok()`/`fail()` — anche gli eventi senza payload (`host:start-game`, ecc.) mantengono la firma `(payload, cb)` per uniformità lato client. I payload `game:question`/`game:results` includono sempre `kind`/`minigameType` così i client distinguono una domanda vera da un round minigioco.

I timer delle domande sono sincronizzati per timestamp assoluto (`endsAt = Date.now() + time_limit_s * 1000`), non per durata relativa: i client calcolano il countdown localmente da `endsAt`, così la latenza di rete non desincronizza l'host dai player. Questo stesso `endsAt` viene ripresentato in `player:rejoin` per riallineare un client che si riconnette a metà domanda.

### Routing HTTP e ordine dei middleware in `server/index.js`

L'ordine di montaggio è significativo e va preservato quando si aggiungono route:
1. Static SPA host su `config.hostPanelPath` (default `/admin-console`, oscurabile via `.env` — **non** hardcodare questo path altrove, sempre da `config`).
2. Static `/resources` (loghi, font, asset dei minigiochi condivisi tra le due SPA).
3. Static `/shared` (`client/shared/`): **codice** client condiviso fra le due SPA, oggi i moduli di presentazione dei minigiochi. Separato da `/resources` perché è codice, non asset.
4. API host (`/api/host`) e health check (`/api/health`).
5. Fallback `/api/*` → 404 JSON (deve stare **prima** dello static player, altrimenti un endpoint API inesistente restituirebbe HTML).
6. Router player (`GET /`) + static player — quest'ordine (router prima, static dopo) è voluto.
7. Error handler globale a 4 argomenti, registrato per ultimo.

Formato risposta REST unificato in tutto `routes/`: successo → `{ success: true, data: {...} }`, errore → `{ success: false, error: "messaggio" }`.

### Frontend: due SPA vanilla separate, nessun bundler

`client/host/app.js` e `client/player/app.js` sono JS vanilla (niente framework, niente build step) serviti come file statici. Il player è single-file; l'host affianca ad `app.js` il comparto audio, diviso fra `client/host/audio-logic.js` (decisioni pure, senza DOM, testabile in Node con `tools/test-audio.js`) e `client/host/audio.js` (motore di riproduzione). La separazione ricalca quella fra `server/game.js` e `server/game-socket.js`.

`client/shared/minigames/` contiene il **registry di presentazione** dei minigiochi, condiviso dalle due SPA e servito su `/shared`. Ogni modulo si autoregistra su `window.Minigames` con lo stesso wrapper UMD di `audio-logic.js`, quindi è caricabile anche in Node per i test. Il contratto (`optionIcon`, `highlightIndex`, `host.startSuspense`/`stopSuspense`/`reveal`, `player.renderChoice`/`reveal`) è interamente **facoltativo tranne `type` e `label`**: il registry completa il resto con una presentazione generica. `Minigames.get(type)` **non restituisce mai null** — un tipo sconosciuto ottiene il fallback, così un round anomalo degrada invece di rompersi durante un evento dal vivo. Né `host/app.js` né `player/app.js` nominano un minigioco specifico: chiedono al registry e delegano.

Il client player mantiene la sessione di riconnessione in `localStorage` (token opaco + playerId) e la ripresenta al reconnect Socket.io via `player:rejoin` per recuperare nickname, avatar, punteggio e stato di gioco corrente. Il client host mantiene il JWT in `localStorage` e lo inietta sia negli header REST sia in `socket.handshake.auth.token` alla `connectGameSocket()`. Qualunque nuovo elemento visivo deve rispettare i token/pattern già stabiliti in [DESIGN.md](DESIGN.md) (bordi Ink 4px, ombre offset piatte, niente grigio SaaS generico) invece di introdurne di nuovi.

### Aggiungere un minigioco

Un minigioco è un **modulo isolato**: due file che portano il suo nome, più due righe di `<script>`. Nient'altro nel progetto va toccato — non `game.js`, non `game-socket.js`, non le route, non l'editor, non i due `app.js`. Il nuovo tipo comparirà da solo nel menù dell'editor e nella rosa dell'estrazione casuale.

1. `server/minigames/<nome-gioco>.js` — le **regole**. Copiare `server/minigames/_TEMPLATE.js`, che documenta il contratto riga per riga.
2. `client/shared/minigames/<nome-gioco>.js` — la **presentazione**. Copiare `client/shared/minigames/_TEMPLATE.js`.
3. Una riga `<script src="/shared/minigames/<nome-gioco>.js">` in `client/host/index.html` **e** in `client/player/index.html`. È l'unico punto in cui il nome compare fuori dai suoi file: il browser non ha un filesystem da scandire, va detto cosa caricare.
4. Facoltativi: asset in `resources/img/<nome-gioco>/`, regole CSS in `client/shared/minigames/minigames.css` — una sezione per minigioco, tutte le classi prefissate `.mg-<tipo-con-trattini>-`.
5. `npm run test:minigames` — il registry ricarica da solo e valida il contratto.

Le tre regole che tengono in piedi la struttura:

- **Il nome del file è la fonte di verità del tipo** (`morra-cinese.js` → `morra_cinese`). Il registry lo verifica all'avvio.
- **`build()` e `resolve()` devono essere pure**: il registry le esegue una volta a vuoto per validarle.
- **Un minigioco non conosce l'esistenza degli altri.** Se serve scrivere `if (type === '...')` da qualche parte, quel comportamento va nel contratto, non in un ramo.

Gli stili specifici di un minigioco non stanno nei fogli delle due SPA: là resta solo l'accento generico `.is-minigame` del round, che usa i token propri di ciascuna SPA (`--retro-ochre` sull'host, `--ticket-ochre` sul player).

### Vincolo cross-platform

Tutto il codice applicativo (server + client) deve restare eseguibile senza modifiche sia su Windows (sviluppo) sia su Linux/Raspberry Pi (produzione), grazie alla natura cross-platform di Node.js e `node:sqlite`. L'unica eccezione nota è la futura compilazione in binario singolo via Node.js SEA, che dovrà avvenire sull'architettura ARM target.
