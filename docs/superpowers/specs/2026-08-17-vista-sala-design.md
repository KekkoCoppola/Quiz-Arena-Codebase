# Vista Sala — separazione delle tre superfici (Design)

Data: 2026-08-17 · Branch: `bugfixCupgame` · Stato: **implementato**, tranne la
riduzione di admin-console (§4), rinviata al redesign generale della UI.

## Perché

Fino a oggi il progetto ha due SPA, e il pannello host fa **due mestieri
incompatibili**: è insieme la plancia di comando dell'host e lo schermo che la
sala guarda. L'assunto è esplicito nel codice — `minigames.css:29` parla di
"hero → il grande reveal proiettato in sala", `_TEMPLATE.js:15` di "host
(proiettato davanti a una sala)", `PRODUCT.md:30` di "schermata di conduzione
spesso proiettata".

I patti veri sono **tre superfici**:

| Vista | Dove gira | Ruolo |
|---|---|---|
| **admin** (`/admin-console`) | tablet/PC dell'host | comandi, gestione quiz. Privata |
| **sala** (`/sala`) | **Raspberry Pi**, Chromium in kiosk → proiettore | sola lettura. **Da qui esce l'audio** |
| **player** (`/`) | telefoni | risposte |

La conseguenza pratica: la resa "grande" (QR, countdown, opzioni, reveal, podio)
oggi vive dentro admin-console e va spostata. E `PRODUCT.md:9`, che descrive
l'host su "un tablet o PC connesso allo stesso hotspot", resta vero — ma non dice
che il Pi non mostra nulla, ed è la riga che ha generato l'equivoco. Va corretta.

## 1. La scoperta che rende il lavoro economico

**Il server non va toccato, se non per servire i file.**

Tutti i broadcast di partita sono `io.emit` globali, non mirati a una room:

| | |
|---|---|
| [game-socket.js:81](server/game-socket.js:81) | `io.emit('game:lobby-update', …)` |
| [game-socket.js:93](server/game-socket.js:93) | `io.emit('game:question', …)` |
| [game-socket.js:104](server/game-socket.js:104) | `io.emit('game:results', …)` |
| [game-socket.js:297](server/game-socket.js:297) | `io.emit('game:final', …)` |

E ogni socket riceve `game:snapshot` al connect se una partita è in corso
([game-socket.js:162](server/game-socket.js:162)).

Quindi un socket che **si connette senza token e non emette mai `player:join`**
riceve già tutto e non può fare niente: è esattamente il ruolo "sala", e non
richiede una terza room né un nuovo percorso di autenticazione. Gli eventi
`host:*` sono già protetti da `requireHost()`, e senza JWT quel socket non li
supera.

Il beneficio collaterale è che il riallineamento è gratis: se il Pi si riavvia a
metà partita, la sala si riconnette e lo `snapshot` la rimette in pari.

## 2. Nessuna autenticazione — deciso

La sala è servita in chiaro su `/sala`, senza login. Deciso esplicitamente:
la rete è un access point isolato e offline, il Pi deve aprire il browser da solo
all'avvio senza che nessuno digiti credenziali davanti a una stanza piena.

**Cosa questo espone davvero** (da sapere, non da risolvere ora): chiunque sia
sull'hotspot può aprire `/sala` e vedere la partita. Non può però *agire* — nessun
evento `host:*` passa senza JWT. Il rischio reale non è il controllo, è che un
giocatore apra `/sala` sul telefono e veda ciò che lo schermo grande mostra.

**Deciso: si ignora per ora** — oggi la sala non mostra nulla che un giocatore non
veda comunque sul proiettore, quindi l'impatto è nullo. Va ripreso col Cup Game,
dove la sala conosce la posizione finale della pallina. Vedi §6.

## 3. Routing

Un solo mount statico in `server/index.js`, da inserire **prima** dello static
player (l'ordine dei middleware è significativo — vedi CLAUDE.md):

```
1. static host su config.hostPanelPath
2. static /resources
3. static /shared
4. static /sala               ← nuovo
5. API host + health + GET /api/join-info   ← nuovo
6. fallback /api/* → 404
7. router player + static player
```

`/sala` è un percorso fisso e pubblico: non passa da `config`, a differenza di
`hostPanelPath` che è oscurabile. Non c'è nulla da nascondere, e il Pi deve
poterlo aprire da un URL cablato nella configurazione kiosk.

**Una correzione a §1:** il server *va* toccato, di un soffio. La sala disegna il
QR e per farlo le serve l'URL LAN, che oggi arriva da `/api/host/game/join-info`
— autenticata. Serve una versione pubblica, `GET /api/join-info`, e il calcolo è
stato estratto in `server/lan-url.js` per non averne due copie che divergono. Non
espone nulla di riservato: è l'indirizzo che finisce proiettato in caratteri
giganti davanti a tutta la stanza.

## 4. Cosa si sposta e cosa resta

### Va alla sala

QR + URL di ingresso · lista giocatori in lobby · testo della domanda in grande ·
le option card · countdown · contatore risposte · distribuzione · risposta
corretta · classifica parziale · podio + classifica finale · **presentazione hero
dei minigiochi** (`startSuspense` / `reveal`) · **tutto l'audio**.

### Resta ad admin-console

I quattro comandi (`game-start-btn`, `game-next-btn`, `game-minigame-btn`,
`game-restart-btn`) e l'uscita, più titolo e metadati del quiz.

In lobby la sala mostra **il QR e i giocatori che entrano con il proprio avatar**
(deciso): l'ingresso via via che la stanza si riempie è metà dello spettacolo
d'apertura, non un dettaglio amministrativo.

### Decisione: admin-console tiene un mirror compatto — confermato

**Sì.** L'host non deve essere costretto a girarsi verso il proiettore per sapere
quando premere "prossima domanda". Restano ad admin-console, in piccolo:

- quanti giocatori sono in lobby
- il countdown
- "risposte: 7 / 12" — è il dato su cui l'host decide se chiudere in anticipo
- lo stato corrente (lobby / domanda / risultati)

È coerente con PRODUCT.md:29, "controllo rapido, zero ansia". Ciò che **non**
resta è la resa spettacolare: niente QR gigante, niente podio, niente reveal.

## 5. Audio

L'engine era già scritto e verificato, ma nel posto sbagliato. **Spostato**
intero, senza riscritture:

```
client/sala/audio-logic.js   ← da client/host/ (aggiornare il require in tools/test-audio.js)
client/sala/audio.js         ← da client/host/
```

Gli agganci in `client/host/app.js` (4 righe: `arm`, `sfx`, `stop`, contatore
lobby) si rifanno sugli handler della sala e si rimuovono da admin-console.

### L'autoplay cambia premessa

§9 del design audio si appoggia a un gesto utente — il click dell'host su "Avvia
partita". **Sulla sala non c'è nessuno che clicca il proiettore.**

La soluzione non è codice, è la riga di lancio del kiosk:

```
chromium-browser --kiosk --autoplay-policy=no-user-gesture-required http://localhost:3000/sala
```

`arm()` va quindi chiamata **al caricamento della pagina**, non su un click. Il
percorso col gesto resta come ripiego per lo sviluppo su desktop, dove il flag non
c'è: se il contesto nasce sospeso, il primo click qualunque sulla pagina lo
sblocca. Nessun overlay "clicca per attivare l'audio" — davanti a una sala non
deve mai comparire.

§9 del design audio va riscritta di conseguenza.

## 6. Il contratto dei minigiochi: `host.*` → `sala.*` — **fatto**

Il ramo di presentazione si chiamava `host.startSuspense` / `host.reveal`. Con
tre superfici quel nome era sbagliato: quella presentazione va sulla **sala**,
non sulla plancia dell'host. È stato rinominato in `sala.*` — costava pochi
minuti con **un solo** minigioco (`morra-cinese.js`) e i due `_TEMPLATE.js`, e
sarebbe diventato un debito fastidioso a cinque minigiochi.

**`hostStatusText` è rimasto com'era**, di proposito: quella è davvero la riga di
stato del pannello di chi conduce, non qualcosa che la sala mostri. La
distinzione fra i due nomi ora dice qualcosa di vero.

**Nota per il Cup Game.** Il piano B.2.3 chiedeva "dati che l'host vede e il
telefono no" e proponeva di filtrare il payload per room. Con tre superfici la
domanda si riformula meglio — è **la sala** che deve vedere la coreografia, non
l'host — ma il meccanismo resta identico, e §2 spiega perché non è gratis: oggi
`io.emit` manda tutto a tutti, e `/sala` è aperta. Fuori scope qui.

## 7. Costo

| | |
|---|---|
| Server | un mount statico. Nessun cambiamento ai socket |
| `client/sala/` | nuova SPA: HTML + CSS + app.js di sola lettura |
| `client/host/` | rimozione della resa grande, mirror compatto al suo posto |
| Audio | spostamento file + agganci rifatti + §9 riscritta |
| Minigiochi | `host.*` → `sala.*` in 3 file |
| Docs | PRODUCT.md:9 e :30, CLAUDE.md, design audio §9 |

## 8. Verifica

- Aprire `/sala` **senza token**: la partita si vede per intero, dalla lobby al podio.
- Aprire `/sala` a metà partita: lo `snapshot` riallinea senza ricaricare.
- Da `/sala`, provare a emettere un `host:*`: deve fallire con "Non autorizzato".
- Audio: parte sulla sala **senza alcun click**, con Chromium avviato col flag.
- Admin-console: nessun suono, e i comandi restano usabili senza guardare il proiettore.
- `npm run test:socket` e `npm run test:minigames` invariati — il server non cambia.
