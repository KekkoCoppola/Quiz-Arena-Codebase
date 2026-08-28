# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Quiz-Zata! — motore di gioco a quiz multiplayer locale in stile Kahoot, pensato per girare interamente offline su un Raspberry Pi configurato come Access Point Wi-Fi (nessuna infrastruttura esterna, nessuna dipendenza internet durante l'evento). L'host conduce la partita da un pannello dedicato; i player si uniscono da browser mobile senza installare nulla.

Il progetto è sviluppato con un approccio **Game-First**: tutto il gioco viene costruito e validato su PC/Windows prima di affrontare i vincoli hardware (licenza SaaS, Access Point) che richiedono il Raspberry Pi fisico. Vedi [DEV_ROADMAP.md](DEV_ROADMAP.md) per lo stato di avanzamento per fase ("Step N" nel codice = "Fase N" nella roadmap, stessa numerazione).

## Design Context

Registro: **product**. Contesto strategico completo in [PRODUCT.md](PRODUCT.md), sistema visivo ("Retro Street", neo-brutalismo da sala giochi: bordi 4px, ombre offset dure senza blur, badge sticker ruotati, palette calda satura, Quicksand bold 700-900) in [DESIGN.md](DESIGN.md). **Leggerli prima di qualunque lavoro su `client/host/`, `client/sala/` o `client/player/`.**

## Commands

```bash
npm run dev          # avvia il server con --watch (riavvio automatico su modifica file)
npm start            # avvia il server senza watch
npm run lint         # npx eslint . — NOTA: nessuna config eslint è ancora presente nel repo
npm run test:socket  # test di integrazione Socket.io end-to-end (tools/test-socket.js)
npm run test:minigames       # registry minigiochi: autoload, contratto, shuffle bag, presentazione client
node tools/test-game.js      # smoke test puro della state machine (server/game.js), nessuna rete
node tools/test-db.js        # smoke test del layer dati SQLite (server/quiz-manager.js)
node tools/test-audio.js     # smoke test delle decisioni pure del comparto audio (vista sala)
npm run test:final           # calendario della premiazione finale (puro) + invarianti anti-spoiler
npm run test:clock           # correzione dello scarto fra orologi server/client (puro)
node tools/create-host.js    # crea un account host offline (username/password) — unico modo per provisionare un host
node tools/check-quizzes.js  # valida i quiz di sistema in content/quizzes/ e stampa un referto
npm run test:quizzes         # schema del quiz + lettura dei file (puro, nessun DB)
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
- **`server/quiz-schema.js`** — cosa rende valido un quiz. Modulo puro, senza DB né rete, usato sia dalle route HTTP sia dal caricamento dei file: è l'unica definizione di "quiz valido" del progetto.
- **`server/quiz-library.js`** — i quiz di sistema come file in `content/quizzes/`, con la sincronizzazione verso il DB all'avvio. Ricalca `server/minigames/index.js`.
- **`server/quiz-manager.js`** — **unico** punto di contatto con SQLite (`node:sqlite`, pattern singleton via `initDb()`/`getDb()`). Nessun altro modulo deve toccare `node:sqlite` direttamente. Tutte le funzioni sono sincrone. Le domande (`questions`) e gli slot minigioco pianificati (`minigames`) sono salvati come colonne TEXT con JSON serializzato e vengono deserializzati in `parseQuizRow`. Le migrazioni di colonna su tabelle già esistenti (es. l'aggiunta di `minigames`) vanno fatte con `ALTER TABLE ADD COLUMN` avvolto in try/catch che ignora "duplicate column name" (`addColumnIfMissing`) — la build SQLite di `node:sqlite` non supporta `ADD COLUMN IF NOT EXISTS` nonostante la versione lo consenta in astratto.

Non aggirare questi confini: nuova logica di gioco va in `game.js` (deve restare testabile senza rete), nuova logica di rete/socket va in `game-socket.js`, nuovo accesso dati va in `quiz-manager.js`.

### Provisioning host (closed, non self-service)

Gli account host **non** si creano via API pubblica: `server/routes/host.js` espone solo login + CRUD quiz. Le credenziali vengono create offline dall'amministratore con `node tools/create-host.js`. Tenerlo a mente prima di aggiungere un endpoint di registrazione: è una scelta di prodotto (evento controllato da un unico host per sessione), non una svista.

### Giocatori di prova (gesto nascosto)

Dieci clic ravvicinati sul logo in cima alla **schermata di partita** del pannello host riempiono la lobby di giocatori finti (default 19). Non quello della sidebar: la sidebar sparisce appena una partita esiste, e finché non esiste non c'è nessuna lobby da riempire — lì il gesto non poteva funzionare in nessun momento. Serve a provare una partita da soli — soprattutto la **premiazione finale**, che con tre persone non si vede: la coda in ritardando, il tetto sulla sua durata e il podio hanno senso solo con una sala piena.

`server/test-bots.js` è il modulo puro (nomi, avatar, "scegli un'opzione a caso"); il cablaggio sta in `game-socket.js`, dove vivono già i timer veri: l'evento host-only `host:spawn-bots` e, dentro `emitQuestion`, un `setTimeout` per bot che risponde a un istante casuale del round. Tre vincoli deliberati:

- **Un bot passa dalla stessa porta di un umano** — `submitAnswer`, poi `game:answer-count` e `maybeCloseEarly`. Un bot che scrivesse nella sessione per una via propria proverebbe un gioco che non esiste.
- **Solo dalla LOBBY**, come chiunque: a partita iniziata nessuno entra più, bot compresi.
- **Non hanno socket.** Esistono solo dentro la `GameSession`, quindi `countConnected()` li conta (`p.connected`, non i socket) e il round aspetta anche loro — per questo il ritardo di risposta è limitato al 60% del tempo, altrimenti terrebbero in ostaggio chi gioca davvero. Sopravvivono a `host:restart-game` (rimessi in campo con nuovi id) perché il loro scopo è provare la partita più volte di fila.

Il gesto è nascosto e non un bottone perché non è una funzione del prodotto ma un attrezzo. Il conteggio si azzera dopo 1,5 s di pausa: dieci clic devono essere una raffica sola, così non scatta per sbaglio davanti a una sala. A partita già avviata il gesto non fallisce in silenzio: il rifiuto del server arriva come toast e dice che si entra solo dalla lobby.

### Autenticazione: due canali paralleli, un solo segreto

- **REST** (`/api/host/*`): JWT in header `Authorization: Bearer <token>`, verificato da `server/middleware/auth.js` (`verifyToken`), che attacca `req.user = { userId, username }`.
- **Socket.io**: lo stesso JWT viene passato in `socket.handshake.auth.token` alla connessione; se valido, il socket diventa "host" (`socket.data.isHost = true`, entra nella room `host`) — altrimenti resta un socket "player" non privilegiato. Ogni evento host-only nel game-socket chiama `requireHost(cb)` come guardia esplicita.

Entrambi i canali condividono `config.jwtSecret` da `server/config.js`. **Nessun modulo diverso da `config.js` deve leggere `process.env` direttamente** — è una regola esplicita nel codice, non solo una convenzione.

### Rooms Socket.io e formato eventi

Due room: `players` (tutti i giocatori) e `host` (socket con JWT valido). Gli handler seguono la convenzione `<ruolo>:<azione>` per gli eventi in ingresso (`player:join`, `player:answer`, `host:start-game`, `host:next-question`, `host:insert-minigame`, `host:restart-game`, `host:end-game`) e `game:<evento>` per il broadcast in uscita (`game:lobby-update`, `game:question`, `game:results`, `game:final`, `game:snapshot`, `game:reset`, `game:ended`). Gli ack callback usano sempre la forma `{ ok: true, ...data }` / `{ ok: false, error }` tramite gli helper `ok()`/`fail()` — anche gli eventi senza payload (`host:start-game`, ecc.) mantengono la firma `(payload, cb)` per uniformità lato client. I payload `game:question`/`game:results` includono sempre `kind`/`minigameType` così i client distinguono una domanda vera da un round minigioco.

I timer delle domande viaggiano come timestamp assoluto (`endsAt = Date.now() + time_limit_s * 1000`), non come durata relativa, così la latenza di rete non desincronizza l'host dai player. Lo stesso `endsAt` viene ripresentato in `player:rejoin` per riallineare un client che si riconnette a metà domanda.

**Ma un timestamp del server da solo non basta**, ed è stato un difetto vero: ogni client lo confrontava col PROPRIO `Date.now()`, quindi il countdown sbagliava di quanto i due orologi erano distanti — in sala mancavano quattro secondi e sul telefono il tempo era già scaduto. Durante l'evento il Raspberry gira senza rete, quindi senza NTP, mentre i telefoni hanno l'ora della rete cellulare: qualche secondo di scarto è la norma, non l'eccezione. Per questo ogni scadenza viaggia accompagnata dal `serverNow` di chi la manda (`game:question`, `game:results`, `player:rejoin`): la DIFFERENZA fra i due è un intervallo, uguale in qualunque orologio la si misuri, e `client/shared/server-clock.js` la riporta sull'ora locale di chi riceve. Chiunque aggiunga una nuova scadenza assoluta deve mandarci accanto `serverNow` e passare da `ServerClock.localDeadline()`, mai da `endsAt - Date.now()`.

### Routing HTTP e ordine dei middleware in `server/index.js`

L'ordine di montaggio è significativo e va preservato quando si aggiungono route:
1. Static SPA host su `config.hostPanelPath` (default `/admin-console`, oscurabile via `.env` — **non** hardcodare questo path altrove, sempre da `config`).
2. Static `/resources` (loghi, font, audio, asset dei minigiochi condivisi tra le SPA).
3. Static `/shared` (`client/shared/`): **codice** client condiviso fra vista sala e player, oggi i moduli di presentazione dei minigiochi. Separato da `/resources` perché è codice, non asset.
4. Static `/sala` (`client/sala/`): la vista proiettata. Percorso **fisso e pubblico**, a differenza di `hostPanelPath`: non c'è nulla da nascondere (nessun comando passa da qui) e il Pi deve poterlo aprire da un URL cablato nel kiosk.
5. API host (`/api/host`), health check (`/api/health`) e `GET /api/join-info` — versione **pubblica** dell'URL LAN per il QR, perché la vista sala non ha token. Il calcolo sta in `server/lan-url.js`, unico punto di verità condiviso con la route host autenticata.
6. Fallback `/api/*` → 404 JSON (deve stare **prima** dello static player, altrimenti un endpoint API inesistente restituirebbe HTML).
7. Router player (`GET /`) + static player — quest'ordine (router prima, static dopo) è voluto.
8. Error handler globale a 4 argomenti, registrato per ultimo.

Formato risposta REST unificato in tutto `routes/`: successo → `{ success: true, data: {...} }`, errore → `{ success: false, error: "messaggio" }`.

### Frontend: tre SPA vanilla separate, nessun bundler

Tre superfici distinte, non due — e la distinzione è di prodotto, non tecnica:

| SPA | Percorso | Gira su | Ruolo |
|---|---|---|---|
| **admin** | `client/host/` → `config.hostPanelPath` | tablet/PC dell'host | comandi e gestione quiz. Privata |
| **sala** | `client/sala/` → `/sala` | Raspberry, Chromium in kiosk → proiettore | sola lettura. **Da qui esce l'audio** |
| **player** | `client/player/` → `/` | telefoni | risposte |

Tutte e tre sono JS vanilla (niente framework, niente build step) servite come file statici.

**La vista sala non richiede alcun ruolo socket dedicato.** I broadcast di partita in `game-socket.js` sono `io.emit` globali e ogni socket riceve `game:snapshot` al connect: un socket senza token che non emette mai `player:join` riceve già tutto e non può fare nulla, perché gli eventi `host:*` restano dietro `requireHost()`. È anche ciò che rende gratuito il riallineamento se il Pi si riavvia a metà partita.

Il comparto audio vive in `client/sala/`, diviso fra `audio-logic.js` (decisioni pure, senza DOM, testabile in Node con `tools/test-audio.js`) e `audio.js` (motore di riproduzione: SFX via Web Audio, musica via `<audio>` in crossfade). La separazione ricalca quella fra `server/game.js` e `server/game-socket.js`. Sta sulla sala e non su admin-console perché il suono esce dal proiettore collegato al Pi, non dal tablet dell'host — e per lo stesso motivo `arm()` è chiamata **al caricamento della pagina**, non da un gesto utente: sul proiettore non c'è nessuno che clicca. In produzione Chromium va lanciato con `--autoplay-policy=no-user-gesture-required`; sul desktop di sviluppo un ripiego sblocca il contesto al primo click.

La **premiazione finale** è l'altra cosa condivisa fra le due superfici, e l'unica sincronizzata fra loro. `client/shared/final-schedule.js` è il **calendario** della cerimonia (modulo puro, wrapper UMD, testato da `tools/test-final.js`): dice a che istante accade ogni atto — la coda in ritardando dall'ultimo al 4°, il bronzo, l'argento coperto, la proclamazione, la scopertura dell'argento. `client/shared/final-ceremony.css` porta i keyframes e il contratto di classi `.fc-*`, mentre misure e colori restano a ciascuna SPA coi propri token.

**La sincronia NON usa un timestamp assoluto**, a differenza di `endsAt` e `revealAt`. Quelli si confrontano col `Date.now()` di ogni dispositivo: per un countdown lo scarto fra orologi è cosmetico, per una proclamazione è fatale — un telefono avanti di tre secondi urlerebbe il vincitore prima del proiettore. Qui invece `game:final` è un unico `io.emit` e ogni client fa partire la cerimonia **da quando lo riceve**, così lo scarto fra orologi esce dal problema; il telefono aggiunge poi `PLAYER_LAG_MS` a ogni atto, e per arrivare in anticipo dovrebbe ricevere la trasmissione 300 ms prima della sala. Il telefono mostra **solo la propria posizione** (`stepsForRank`), e chi è secondo la scopre insieme alla sala, mai prima: se il suo telefono lo sapesse durante la sospensione, la sua faccia rovinerebbe il finale a tutta la stanza. Entrambi i `renderFinal` accettano `{ animate: false }` per disegnare il fotogramma finale senza cerimonia — serve a `game:snapshot`/`player:rejoin` a premiazione conclusa e al movimento ridotto, perché una media query non ferma dei `setTimeout`.

`client/shared/minigames/` contiene il **registry di presentazione** dei minigiochi, condiviso da vista sala e player e servito su `/shared`. Ogni modulo si autoregistra su `window.Minigames` con lo stesso wrapper UMD di `audio-logic.js`, quindi è caricabile anche in Node per i test. Il contratto (`optionIcon`, `highlightIndex`, `sala.startSuspense`/`stopSuspense`/`reveal`, `player.renderChoice`/`reveal`) è interamente **facoltativo tranne `type` e `label`**: il registry completa il resto con una presentazione generica. `Minigames.get(type)` **non restituisce mai null** — un tipo sconosciuto ottiene il fallback, così un round anomalo degrada invece di rompersi durante un evento dal vivo. Né `sala/app.js` né `player/app.js` nominano un minigioco specifico: chiedono al registry e delegano. Il ramo si chiama `sala` e non `host` perché è la sala a vederlo; `hostStatusText` resta invece con quel nome, perché è davvero la riga di stato del pannello di chi conduce.

Il client player mantiene la sessione di riconnessione in `localStorage` (token opaco + playerId) e la ripresenta al reconnect Socket.io via `player:rejoin` per recuperare nickname, avatar, punteggio e stato di gioco corrente. Il client host mantiene il JWT in `localStorage` e lo inietta sia negli header REST sia in `socket.handshake.auth.token` alla `connectGameSocket()`. Qualunque nuovo elemento visivo deve rispettare i token/pattern già stabiliti in [DESIGN.md](DESIGN.md) (bordi Ink 4px, ombre offset piatte, niente grigio SaaS generico) invece di introdurne di nuovi.

### Aggiungere un minigioco

Un minigioco è un **modulo isolato**: due file che portano il suo nome, più due righe di `<script>`. Nient'altro nel progetto va toccato — non `game.js`, non `game-socket.js`, non le route, non l'editor, non i due `app.js`. Il nuovo tipo comparirà da solo nel menù dell'editor e nella rosa dell'estrazione casuale.

1. `server/minigames/<nome-gioco>.js` — le **regole**. Copiare `server/minigames/_TEMPLATE.js`, che documenta il contratto riga per riga.
2. `client/shared/minigames/<nome-gioco>.js` — la **presentazione**. Copiare `client/shared/minigames/_TEMPLATE.js`.
3. Una riga `<script src="/shared/minigames/<nome-gioco>.js">` in `client/sala/index.html` **e** in `client/player/index.html`. È l'unico punto in cui il nome compare fuori dai suoi file: il browser non ha un filesystem da scandire, va detto cosa caricare.
4. Facoltativi: asset in `resources/img/<nome-gioco>/`, regole CSS in `client/shared/minigames/minigames.css` — una sezione per minigioco, tutte le classi prefissate `.mg-<tipo-con-trattini>-`.
5. `npm run test:minigames` — il registry ricarica da solo e valida il contratto.

Le tre regole che tengono in piedi la struttura:

- **Il nome del file è la fonte di verità del tipo** (`morra-cinese.js` → `morra_cinese`). Il registry lo verifica all'avvio.
- **`build()` e `resolve()` devono essere pure**: il registry le esegue una volta a vuoto per validarle.
- **Un minigioco non conosce l'esistenza degli altri.** Se serve scrivere `if (type === '...')` da qualche parte, quel comportamento va nel contratto, non in un ramo.

Gli stili specifici di un minigioco non stanno nei fogli delle SPA: là resta solo l'accento generico `.is-minigame` del round, che usa i token propri di ciascuna (`--retro-ochre` in sala, `--ticket-ochre` sul player).

### Aggiungere o modificare un quiz di sistema

I quiz di sistema sono **file**, uno per quiz, in `content/quizzes/`. Stessa forma dei minigiochi: una cartella scandita all'avvio, nessun elenco centrale da aggiornare.

1. Crea (o modifica) `content/quizzes/<nome-quiz>.json`.
2. Riavvia il server. `server/quiz-library.js` riallinea la tabella `preloaded_quizzes`: inserisce i nuovi, **aggiorna quelli cambiati**, elimina quelli il cui file è sparito.
3. `npm run quizzes` per un referto senza avviare nulla — utile prima di una serata.

Le tre regole che tengono in piedi la struttura:

- **Il nome del file è l'identità del quiz** (`il-mondo-degli-animali.json` → slug `il-mondo-degli-animali`), non il titolo. Cambiare il titolo aggiorna il quiz esistente invece di crearne un doppione.
- **`preloaded_quizzes` è una copia derivata, non la fonte di verità.** Modificarla a mano non serve: al riavvio successivo viene sovrascritta dai file.
- **Un quiz non valido viene escluso, non blocca l'avvio.** È la differenza deliberata con i minigiochi, dove un modulo rotto impedisce il boot: lì è un bug di codice, qui è un refuso di contenuto, e fermare tutta la serata perché una domanda ha l'indice sbagliato sarebbe sproporzionato. Il prezzo è che l'esclusione va vista: viene stampata con `console.error` all'avvio, nominando file e problema.

**La validazione è una sola per tutti.** `server/quiz-schema.js` definisce cosa rende valido un quiz, ed è usato sia dall'editor via HTTP sia dal caricamento dei file. Viveva dentro `routes/host.js`, cioè dietro l'HTTP: i quiz di sistema le passavano accanto, e un `correct_index` fuori range arrivava fino alla sala producendo un round giocabile ma **non vincibile**, senza un errore da nessuna parte. Non rimettere validazioni di quiz altrove.

I **quiz personali dell'host** restano invece nel DB, creati dall'editor: li scrive chi non tocca file. Il tetto è `MAX_QUIZZES_PER_USER` (3).

### Vincolo cross-platform

Tutto il codice applicativo (server + client) deve restare eseguibile senza modifiche sia su Windows (sviluppo) sia su Linux/Raspberry Pi (produzione), grazie alla natura cross-platform di Node.js e `node:sqlite`. L'unica eccezione nota è la futura compilazione in binario singolo via Node.js SEA, che dovrà avvenire sull'architettura ARM target.
