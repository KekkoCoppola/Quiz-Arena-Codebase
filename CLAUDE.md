# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Quiz-Zata! — motore di gioco a quiz multiplayer locale in stile Kahoot, pensato per girare interamente offline su un Raspberry Pi configurato come Access Point Wi-Fi (nessuna infrastruttura esterna, nessuna dipendenza internet durante l'evento). L'host conduce la partita da un pannello dedicato; i player si uniscono da browser mobile senza installare nulla.

Il progetto è sviluppato con un approccio **Game-First**: tutto il gioco viene costruito e validato su PC/Windows prima di affrontare i vincoli hardware (licenza SaaS, Access Point) che richiedono il Raspberry Pi fisico. Vedi [DEV_ROADMAP.md](DEV_ROADMAP.md) per lo stato di avanzamento per fase ("Step N" nel codice = "Fase N" nella roadmap, stessa numerazione).

## Design Context

Registro: **product**. Contesto strategico completo in [PRODUCT.md](PRODUCT.md), sistema visivo ("Retro Street", neo-brutalismo da sala giochi: bordi 4px, ombre offset dure senza blur, badge sticker ruotati, palette calda satura, Quicksand bold 700-900) in [DESIGN.md](DESIGN.md). Il pannello admin tiene la stessa forma ma prende i colori dal logo (giallo, indaco elettrico, inchiostro): regole proprie in DESIGN.md §7. **Leggerli prima di qualunque lavoro su `client/host/`, `client/sala/` o `client/player/`.**

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
npm run test:final           # calendario della premiazione (puro), accordo con la scena 3D, invarianti anti-spoiler
npm run test:clock           # correzione dello scarto fra orologi server/client (puro)
npm run test:avatar          # catalogo dell'avatar (colori, facce, validazione) e avatar dei bot (puro)
node tools/create-host.js    # crea un account host offline (username/password) — unico modo per provisionare un host
node tools/check-quizzes.js  # valida i quiz di sistema in content/quizzes/ e stampa un referto
node tools/make-minigame-audio.js  # rigenera colonne sonore ed effetti dei minigiochi (serve ffmpeg, solo per la musica OGG)
node tools/render-avatars.js # rigenera i PNG dell'avatar dal modello 3D (poi aprire http://localhost:3999 in un browser con WebGL); `face` o `lg` come argomento per una misura sola
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

Dieci clic ravvicinati sul logo in cima alla **schermata di partita** del pannello host riempiono la lobby di giocatori finti (default 19). Non quello della barra della dashboard: finché una partita non esiste non c'è nessuna lobby da riempire — lì il gesto non potrebbe funzionare in nessun momento. Serve a provare una partita da soli — soprattutto la **premiazione finale**, che con tre persone non si vede: il pubblico intorno al podio ha senso solo con una sala piena.

`server/test-bots.js` è il modulo puro (nomi, avatar, "scegli un'opzione a caso"); il cablaggio sta in `game-socket.js`, dove vivono già i timer veri: l'evento host-only `host:spawn-bots` e, dentro `emitQuestion`, un `setTimeout` per bot che risponde a un istante casuale del round. Tre vincoli deliberati:

- **Un bot passa dalla stessa porta di un umano** — `submitAnswer`, poi `game:answer-count` e `maybeCloseEarly`. Un bot che scrivesse nella sessione per una via propria proverebbe un gioco che non esiste.
- **Solo dalla LOBBY**, come chiunque: a partita iniziata nessuno entra più, bot compresi.
- **Non hanno socket.** Esistono solo dentro la `GameSession`, quindi `countConnected()` li conta (`p.connected`, non i socket) e il round aspetta anche loro — per questo il ritardo di risposta è limitato al 60% del tempo, altrimenti terrebbero in ostaggio chi gioca davvero. Sopravvivono a `host:restart-game` (rimessi in campo con nuovi id) perché il loro scopo è provare la partita più volte di fila.

Il gesto è nascosto e non un bottone perché non è una funzione del prodotto ma un attrezzo. Il conteggio si azzera dopo 1,5 s di pausa: dieci clic devono essere una raffica sola, così non scatta per sbaglio davanti a una sala. A partita già avviata il gesto non fallisce in silenzio: il rifiuto del server arriva come toast e dice che si entra solo dalla lobby.

### L'avatar: il personaggio, non un'emoji

L'avatar è il personaggio di `client/shared/mii-character.js`: divisa uguale per tutti, **colore** della pelle ed **espressione** sulla faccia. Viaggia come stringa opaca `"<colore>:<faccia>"` (es. `"sunny_yellow:happy"`), quindi protocollo, rientro, classifica e bot non hanno cambiato forma. Design in [docs/superpowers/specs/2026-10-29-avatar-personaggio-design.md](docs/superpowers/specs/2026-10-29-avatar-personaggio-design.md).

- **`client/shared/avatar-catalog.js`** è l'unica definizione di avatar valido (8 colori, 12 facce), modulo puro caricato anche da `server/game.js`, che rifiuta tutto il resto con `InvalidAvatarError`. Per aggiungere un colore o una faccia si tocca il catalogo; una faccia nuova va disegnata anche in `draw2DFacialExpression` di `mii-character.js`.
- **Il ritratto è una foto PNG del modello 3D**, non il 3D vivo: il telefono non deve scaricare nulla oltre alla pagina e alle sue immagini (three.js da solo pesa 676 KB, e venti telefoni entrano insieme sul Wi-Fi del Raspberry). Le foto le genera `node tools/render-avatars.js` (apre una pagina locale che disegna con three.js ogni combinazione e salva i PNG): `resources/img/avatars/{face,lg}/<colore>-<faccia>.png`, più `neutral.png`: `face` è solo la testa (il blocco col colore e la faccia), `lg` il personaggio intero. Va rilanciato quando cambia il catalogo o il modello; `npm run test:avatar` segnala i file mancanti, perché un PNG mancante in sala non dà errori, solo un'immagine rotta.
- **`client/shared/avatar-sprite.js`** sceglie il file giusto: `AvatarSprite.fill(el, id)` è l'unico modo in cui le tre SPA mostrano un mini avatar (pedine sulle risposte, lobby, classifiche, badge): solo la testa, in orizzontale (11:8) e alta 1,25em, quindi la misura la decide il `font-size` del contenitore. A quelle misure il corpo intero era un francobollo; la testa porta già colore ed espressione. Solo la scelta sul telefono mostra il personaggio intero (`lg`). Un id sconosciuto dà il personaggio neutro, mai un errore.
- `mii-character.js` non lo carica nessuna SPA: serve allo strumento di rendering e servirà alla scena 3D della premiazione. Resta caricabile senza three, che si passa come argomento solo a `createMii`.

### Autenticazione: due canali paralleli, un solo segreto

- **REST** (`/api/host/*`): JWT in header `Authorization: Bearer <token>`, verificato da `server/middleware/auth.js` (`verifyToken`), che attacca `req.user = { userId, username }`.
- **Socket.io**: lo stesso JWT viene passato in `socket.handshake.auth.token` alla connessione; se valido, il socket diventa "host" (`socket.data.isHost = true`, entra nella room `host`) — altrimenti resta un socket "player" non privilegiato. Ogni evento host-only nel game-socket chiama `requireHost(cb)` come guardia esplicita.

Entrambi i canali condividono `config.jwtSecret` da `server/config.js`. **Nessun modulo diverso da `config.js` deve leggere `process.env` direttamente** — è una regola esplicita nel codice, non solo una convenzione.

### Rooms Socket.io e formato eventi

Due room: `players` (tutti i giocatori) e `host` (socket con JWT valido). Gli handler seguono la convenzione `<ruolo>:<azione>` per gli eventi in ingresso (`player:join`, `player:answer`, `host:start-game`, `host:next-question`, `host:insert-minigame`, `host:restart-game`, `host:end-game`) e `game:<evento>` per il broadcast in uscita (`game:lobby-update`, `game:question`, `game:results`, `game:final`, `game:snapshot`, `game:reset`, `game:ended`). Gli ack callback usano sempre la forma `{ ok: true, ...data }` / `{ ok: false, error }` tramite gli helper `ok()`/`fail()` — anche gli eventi senza payload (`host:start-game`, ecc.) mantengono la firma `(payload, cb)` per uniformità lato client. I payload `game:question`/`game:results` includono sempre `kind`/`minigameType` così i client distinguono una domanda vera da un round minigioco. `game:lobby-update` arriva anche a partita in corso (ogni disconnessione e rientro) e porta `state`: un client cambia schermata verso la lobby solo se vale `LOBBY`, altrimenti aggiorna solo l'elenco — la sala, senza questo controllo, abbandonava il round a ogni telefono che si spegneva.

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

**Ogni minigioco porta il proprio audio.** Il campo `audio` del contratto di presentazione ha la forma del manifest (`{ music: { file, gain }, sfx: { evento: [...] } }`, percorsi relativi a `/resources/audio/`). `sala/app.js` lo registra all'avvio con `SalaAudio.register(tipo, audio)`, che lo mette nel catalogo **nel suo spazio dei nomi** (`AudioLogic.minigameManifest`: la traccia si chiama `<tipo>`, gli effetti `<tipo>/<evento>`), così nessun minigioco può coprire i suoni della sala né quelli di un altro. La musica della partita sfuma all'inizio del sipario, la colonna sonora del minigioco parte quando le tende si riaprono, e la classifica riporta la musica della partita. Gli effetti li suona il modulo con `ctx.sfx('evento')`, che la sala passa a `startSuspense` e `playReveal`: il riquadro dell'host e il telefono non lo passano, quindi si chiama sempre `ctx.sfx?.(…)`. Gli effetti agganciati all'animazione (scambi dei bicchieri, scatti della ruota) suonano nel fotogramma che li disegna; quelli che devono accadere comunque (la pallina scoperta, il colpo d'arrivo) stanno sui timer d'orologio come l'atterraggio. I file di oggi li sintetizza `tools/make-minigame-audio.js` e sono sostituibili con registrazioni vere tenendo lo stesso nome; `npm run test:minigames` verifica che ogni file dichiarato esista, perché un file mancante in sala non dà errori: il minigioco è solo muto.

La **premiazione finale** la recita la sala; il telefono la aspetta. In sala è una **scena 3D** (`client/shared/podium-ceremony.js`, three.js, **solo vista sala**: il telefono non la scarica) a tutto schermo su uno strato proprio, `#sala-podium-layer`: il 3° e il 2° salgono sul podio con la targhetta del nome, poi il 1° con la coppa e i coriandoli, mentre dal 4° in giù fanno da pubblico intorno al palco. I personaggi sono quelli di `mii-character.js`, con il colore e l'espressione scelti all'ingresso. `client/shared/final-schedule.js` è il **calendario** (modulo puro, wrapper UMD, testato da `tools/test-final.js`): la durata (`DURATION_MS`, 14,5 s, uguale per qualunque numero di giocatori) e l'istante in cui ciascuno dei tre sale sul podio. La coreografia sta nella scena, i tempi qui: la sala passa `DURATION_MS` alla scena, e `test-final.js` verifica che i due coincidano. I momenti sonori della scena passano dall'audio della sala (`onCue`), non dal suo sintetizzatore interno. Finita la cerimonia la scena resta in festa all'infinito: la spegne `newPhase()`, cioè qualunque cambio di schermata, e lo spegnimento libera il contesto WebGL. Il **podio 2D** di prima resta solo come ripiego: movimento ridotto, three.js o WebGL non disponibili (`onError`). `client/shared/final-ceremony.css` porta ancora i keyframes `.fc-*` che usa il telefono.

**La sala NON usa un timestamp assoluto**, a differenza di `endsAt` e `revealAt`: `game:final` è un unico `io.emit` e la cerimonia parte **da quando lo riceve**, così lo scarto fra orologi esce dal problema. **Il telefono non segue gli atti**: durante la cerimonia mostra "Guarda lo schermo!", uguale per tutti — se cambiasse solo per i premiati, la sala capirebbe chi sta sul podio dal telefono prima di vederlo sullo schermo. La fine la annuncia il **server** con `game:ceremony-done`, dopo `FinalSchedule.ceremonyDurationMs(n)` (durata del calendario più `PLAYER_LAG_MS`) da quando ha emesso `game:final`; solo allora il telefono mostra la propria posizione in grande e, sotto, la classifica intera. Il segnale è del server e non un cronometro sul telefono perché chi si riconnette a metà cerimonia non saprebbe quanto ne resta: `player:rejoin` in `FINAL_LEADERBOARD` porta `ceremonyDone`, e il timer si annulla con ogni riavvio o chiusura (`clearQuestionTimer`). Regola anti-spoiler: **nessuna posizione sul telefono prima del segnale del server**. Il `renderFinal` della sala accetta `{ animate: false }` per aprire la scena direttamente sul gran finale, senza proclamazione né suoni — serve a `game:snapshot` a premiazione conclusa. Il movimento ridotto va gestito lì e non nel CSS, perché una media query non ferma un'animazione WebGL: in quel caso si disegna il podio 2D fermo.

`client/shared/minigames/` contiene il **registry di presentazione** dei minigiochi, condiviso da vista sala e player e servito su `/shared`. Ogni modulo si autoregistra su `window.Minigames` con lo stesso wrapper UMD di `audio-logic.js`, quindi è caricabile anche in Node per i test. Il contratto (`optionIcon`, `highlightIndex`, `sala.startSuspense`/`stopSuspense`/`reveal`, `player.renderChoice`/`reveal`) è interamente **facoltativo tranne `type` e `label`**: il registry completa il resto con una presentazione generica. `Minigames.get(type)` **non restituisce mai null** — un tipo sconosciuto ottiene il fallback, così un round anomalo degrada invece di rompersi durante un evento dal vivo. Né `sala/app.js` né `player/app.js` nominano un minigioco specifico: chiedono al registry e delegano. Il ramo si chiama `sala` e non `host` perché è la sala a vederlo; `hostStatusText` resta invece con quel nome, perché è davvero la riga di stato del pannello di chi conduce.

Il client player mantiene la sessione di riconnessione in `localStorage` (token opaco + playerId) e la ripresenta al reconnect Socket.io via `player:rejoin` per recuperare nickname, avatar, punteggio e stato di gioco corrente. Il client host mantiene il JWT in `localStorage` e lo inietta sia negli header REST sia in `socket.handshake.auth.token` alla `connectGameSocket()`. Qualunque nuovo elemento visivo deve rispettare i token/pattern già stabiliti in [DESIGN.md](DESIGN.md) (bordi Ink 4px, ombre offset piatte, niente grigio SaaS generico) invece di introdurne di nuovi.

**Disposizione della domanda in sala.** Di norma scheda sopra e risposte sotto. Quando la scheda non ci sta (domanda lunga, immagine) il testo finiva sotto le carte delle risposte: `fitQuestionLayout` in `sala/app.js` lo **misura** (il CSS non può saperlo) e passa il pannello a due colonne (`.is-split`: domanda a sinistra, risposte impilate a destra); se nemmeno così ci sta, rimpicciolisce a passi solo la colonna che trabocca (`--q-fit` / `--o-fit`, mai sotto 0,6). Due accortezze della misura (`.is-fitting`): conta già una fila di pedine nei vassoi degli avatar, perché la disposizione non può cambiare a metà parata, e spegne le animazioni d'ingresso, il cui `translateY` gonfiava `scrollHeight` e faceva sembrare traboccante ogni domanda.

### Aggiungere un minigioco

Un minigioco è un **modulo isolato**: due file che portano il suo nome, più due righe di `<script>`. Nient'altro nel progetto va toccato — non `game.js`, non `game-socket.js`, non le route, non l'editor, non i due `app.js`. Il nuovo tipo comparirà da solo nel menù dell'editor e nella rosa dell'estrazione casuale.

1. `server/minigames/<nome-gioco>.js` — le **regole**. Copiare `server/minigames/_TEMPLATE.js`, che documenta il contratto riga per riga.
2. `client/shared/minigames/<nome-gioco>.js` — la **presentazione**. Copiare `client/shared/minigames/_TEMPLATE.js`.
3. Una riga `<script src="/shared/minigames/<nome-gioco>.js">` in `client/sala/index.html`, `client/player/index.html` **e** `client/host/index.html` (anche il pannello host disegna l'attesa del round, in un riquadro piccolo). È l'unico punto in cui il nome compare fuori dai suoi file: il browser non ha un filesystem da scandire, va detto cosa caricare.
4. Facoltativi: asset in `resources/img/<nome-gioco>/`, audio in `resources/audio/<nome-gioco>/` dichiarato nel campo `audio` del contratto di presentazione (vedi sotto), regole CSS in `client/shared/minigames/minigames.css` — una sezione per minigioco, tutte le classi prefissate `.mg-<tipo-con-trattini>-`.
5. `npm run test:minigames` — il registry ricarica da solo e valida il contratto.

Le tre regole che tengono in piedi la struttura:

- **Il nome del file è la fonte di verità del tipo** (`morra-cinese.js` → `morra_cinese`). Il registry lo verifica all'avvio.
- **`build()` e `resolve()` devono essere pure**: il registry le esegue una volta a vuoto per validarle.
- **Un minigioco non conosce l'esistenza degli altri.** Se serve scrivere `if (type === '...')` da qualche parte, quel comportamento va nel contratto, non in un ramo.

**Minigiochi "guarda e poi scegli" (`previewMs`).** Di default un minigioco si sceglie subito e la macchina decide alla chiusura. Un modulo che dichiara `previewMs > 0` (oggi Tre Bicchieri, `cup-game.js`) rovescia l'ordine: `GameSession._enterRound` chiama `resolve()` all'**apertura**, `submitAnswer` rifiuta con `AnswersNotOpenError` fino a `answersOpenAt`, ed `endQuestion` riusa quella risoluzione invece di estrarne un'altra che smentirebbe lo spettacolo. In `emitQuestion` l'esito viaggia come `preview: { machineChoice }` **solo** fuori dalla room `players` (`io.except`): sala e host lo mettono in scena, i telefoni non lo ricevono mai. Il tempo di risposta parte da `answersOpenAt`, e i client lo ricevono accanto a `serverNow` come ogni altra scadenza. Attenzione rimandando un countdown: `ServerClock.localDeadline` misura lo scarto nell'istante della chiamata, quindi chi la chiama in ritardo deve far avanzare `serverNow` del tempo trascorso dalla ricezione (vedi `renderQuestion` in sala e player). three.js (`client/shared/vendor/three/`, r170 dal pacchetto npm ufficiale) è caricato con `import()` dinamico solo dal modulo che lo usa.

**Minigiochi a più livelli (`stages`).** Un modulo con `stages: N` viene inserito come N round consecutivi (`buildMinigameRounds` in `game.js`), ognuno da `build(stageIndex)` e marcato `stage: { index, count, ... }`: risposte, esito e punti restano per round, così niente del ciclo di vita cambia. A fare la "filata" è `closeQuestion` in `game-socket.js`: chiuso un livello intermedio, `stageTimer` avvia il successivo dopo `revealMs + STAGE_GAP_MS` senza aspettare l'host (qualunque mossa dell'host lo annulla, via `clearQuestionTimer`). Sala e player riconoscono il livello intermedio da `results.stage` e saltano parata e classifica, che arrivano solo dopo l'ultimo. Tre Bicchieri usa 5 livelli a 400 punti, con gli scambi (`stage.swaps`) da 6 a 14. Si sceglie per lettera (`options: ['A', 'B', 'C']`, da sinistra a destra): a bicchieri fermi le lettere compaiono sopra ciascun bicchiere in sala (posizionate sulla proiezione della scena, 3D o 2D), e sul telefono ogni lettera porta sotto una freccia ←, —, → con lo stesso colore della carta opzione. Un minigioco può anche nascondere il nastro col proprio nome sulla scheda in sala con `salaKicker: null`.

Gli stili specifici di un minigioco non stanno nei fogli delle SPA: là resta solo l'accento generico `.is-minigame` del round, che usa i token propri di ciascuna (`--retro-ochre` in sala, `--ticket-ochre` sul player).

**Il palco in sala (`mg-stage`).** In un round minigioco `client/sala/style.css` allarga la scheda e rende il titolo un contenitore di misura chiamato `mg-stage`. Con le carte delle scelte il palco prende la colonna larga a sinistra a tutta altezza e le carte si impilano a destra (`.is-split`, lo stesso layout delle domande lunghe); un minigioco che dichiara `salaOptions: false` nel contratto di presentazione (oggi Tre Bicchieri) è invece tutto palco (`.is-stage-only`): niente carte, e a round chiuso niente parata degli avatar né riga di reveal, si passa dritti alla classifica — l'esito l'ha già raccontato la scena. Un minigioco si dimensiona sul palco con `@container mg-stage (min-width: 0px) { … }` in `minigames.css`, usando unità `cqh`/`cqw`, non `vh`: misurato sulla finestra restava un riquadro piccolo in mezzo a uno schermo vuoto. Fuori dalla sala (il riquadro dell'host) quel contenitore non esiste e le regole non si applicano, quindi l'host resta com'è. Tutto ciò che compare a metà round (verdetti, avvisi) va sovrapposto in posizione assoluta, così la scena non salta. Tre Bicchieri inoltre riposiziona la camera a ogni cambio di misura (`fitCamera`): con una camera fissa un canvas più largo mostrava solo più sfondo.

**Il sipario d'apertura.** Ogni minigioco, in sala, si apre con tende 3D a tutto schermo (su uno strato proprio, `#sala-intro-layer`, fuori dal palco e sopra la testata) che si chiudono, un cartello "È l'ora del minigioco!", una ruota che estrae il gioco e le tende che si riaprono su di esso (`client/shared/stage-intro.js` + `stage-intro.css`, three.js, solo vista sala; `npm run test:intro`). Non è un minigioco e non sta in `client/shared/minigames/`: lo mette in scena `sala/app.js` per tutti, e nessun modulo minigioco lo nomina. Tre vincoli:

- **Il tempo lo riserva il server.** `config.minigameIntroMs` (env `MINIGAME_INTRO_MS`, default 12000, `0` lo spegne) entra in `GameSession` come opzione; `_enterRound` mette `introEndsAt` PRIMA dell'anteprima e delle risposte, solo al primo livello di un minigioco (`stage.index === 0`). Il round espone `introMs`, `emitQuestion` manda `introEndsAt` accanto a `serverNow`. Un sipario solo lato client coprirebbe l'anteprima dei bicchieri, cioè la cosa da seguire.
- **Il minigioco si monta sotto le tende chiuse**, a tempo d'orologio (`TIMELINE.curtainClose2End`), non agganciato all'animazione: se il sipario non parte (movimento ridotto, niente WebGL) il minigioco comincia comunque quando il server se lo aspetta. Per lo stesso motivo il passo dell'animazione non ha tetto: un fotogramma lento si recupera invece di far scivolare la scena. L'host non lo mostra (riquadro troppo piccolo) ma aspetta la stessa fine prima di avviare l'attesa del minigioco.
- **La ruota si riempie dal registry**: `sala/app.js` chiama `setWheelConfig` con `Minigames.types()`, e lo spicchio usa il campo facoltativo `wheelIcon` del contratto di presentazione. Un minigioco nuovo ci compare da solo.

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

### Immagini nelle domande

Una domanda può portare un'immagine, che compare **solo sulla vista sala**. Il design completo sta in [docs/superpowers/specs/2026-08-29-immagini-domande-design.md](docs/superpowers/specs/2026-08-29-immagini-domande-design.md).

Quattro decisioni da non ribaltare per distrazione:

- **L'immagine non viaggia sul socket.** Nel round c'è solo `image: { hash, blur }`; i byte si scaricano da `GET /api/quiz-image/<hash>`, pubblico come `/api/join-info` perché la sala non ha token. L'URL contiene l'hash del contenuto, quindi è servito con `Cache-Control: immutable` e ogni dispositivo lo scarica una volta sola per tutta la serata. `emitQuestion` è un `io.emit` globale: un base64 nel payload sarebbe ~2,4MB per domanda con venti telefoni sull'access point, senza cache possibile.
- **La compressione avviene nel browser dell'host**, mai sul server: `client/shared/image-budget.js` (decisioni pure, testabili in Node) più la pipeline Canvas in `client/host/app.js`. Stessa separazione di `audio-logic.js` / `audio.js`. Il motivo non è il gusto ma il vincolo: `sharp` e simili sono moduli nativi, e il progetto li ha eliminati per il packaging SEA su ARM. Il tetto è 150 KiB (`MAX_BYTES`, 153.600 byte), ma è un obiettivo e non una garanzia: la scala di qualità (`QUALITY_LADDER`) si ferma a 0,58, e un file ancora sopra il tetto a quel gradino viene accettato così com'è invece di essere compresso oltre — un 1254×1254 reale è arrivato a 159 KB. Meglio un file un po' più pesante che artefatti proiettati su un muro.
- **Lo stoccaggio è indirizzato dal contenuto.** `quiz_images.hash` è lo SHA-256 dei byte, calcolato **dal server**, mai dal client. La stessa foto in due quiz occupa una riga sola. Le immagini che nessuna domanda referenzia più vengono eliminate da `gcOrphanImages()` a ogni avvio — non c'è refcount da tenere coerente, si ricalcola la verità invece di ricordarla.
- **Il blur è una classe CSS, non una seconda copia.** Un blob per immagine, e il toggle resta reversibile. Che l'originale sia nel DOM è irrilevante: in sala c'è un Chromium in kiosk collegato a un proiettore, senza nessuno che lo tocchi — ed è lo stesso motivo per cui l'`<img>` ha `pointer-events: none`.

**Il player non mostra le immagini.** Il campo `image` arriva anche ai telefoni (sono ~90 byte, non vale un emit per-room) ma `client/player/app.js` non lo legge. È una scelta di prodotto, non un limite tecnico: il telefono renderizza già testo e opzioni, quindi una domanda visiva resta rispondibile solo guardando il proiettore — che è l'oggetto comune del gioco, come per l'audio. Cambiare idea costa un `<img>`.

### Vincolo cross-platform

Tutto il codice applicativo (server + client) deve restare eseguibile senza modifiche sia su Windows (sviluppo) sia su Linux/Raspberry Pi (produzione), grazie alla natura cross-platform di Node.js e `node:sqlite`. L'unica eccezione nota è la futura compilazione in binario singolo via Node.js SEA, che dovrà avvenire sull'architettura ARM target.
