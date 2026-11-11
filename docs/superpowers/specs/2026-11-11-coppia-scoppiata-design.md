# La Coppia Scoppiata — design

Data: 2026-11-11 · Stato: bozza da approvare

**Scelte mie da controllare leggendo:** chiavi degli esiti `complete`/`half`/`miss`; regola unica di correttezza e catalogo 16 figure × 6 colori (crescita dei gruppi oltre 33 giocatori); round saltato con un solo giocatore; evento `game:groups-completed` mandato anche ai telefoni; bot che trovano il compagno al ~70%; nome sotto i pallini; lista delle 16 figure; rivelazione a durata fissa in tre tempi.

## Cos'è e perché

Un minigioco **cooperativo** da giocare in piedi. Ogni giocatore riceve sul telefono una carta segreta con una figura (animale o oggetto) di un colore; in sala c'è almeno un'altra persona con la stessa figura in un altro colore. Bisogna trovarla — parlando, girando, urlando "chi ha il gatto?" — e toccare sul telefono **il suo colore**. La coppia prende i punti pieni solo se si indovinano a vicenda.

È il primo minigioco che non si gioca "contro il PC" ma con le persone in sala: fa alzare la gente, la fa parlare, e usa lo schermo e l'audio della sala per creare tensione. La velocità non conta: conta solo trovarsi prima che scada il tempo.

**Successo:** la sala si muove e chiacchiera per 90 secondi, ogni coppia salvata è un piccolo applauso sullo schermo, e la rivelazione finale fa ridere chi ha sbagliato colore.

## Obiettivi, non-obiettivi, anti-obiettivi

- **Obiettivi:** carte davvero segrete (ogni telefono riceve solo la sua); coppie salvate visibili dal vivo in sala; rivelazione finale delle carte gruppo per gruppo; funziona con qualunque numero di giocatori ≥ 2; giocabile con i bot di prova.
- **Non-obiettivi:** punteggio legato alla velocità; più livelli (`stages`); mostrare le figure sul proiettore durante il round.
- **Anti-obiettivi:** un ramo `if (type === 'coppia_scoppiata')` in `game.js`, `game-socket.js` o nei due `app.js` (viola la regola B del template); carte leggibili da un telefono che non è il loro; un round che si rompe o resta appeso davanti alla sala per un numero dispari, un rientro o una disconnessione.

## Regole del gioco (decise con l'utente)

- **Durata:** 90 s (`defaultTimeLimitS: 90`). Chiusura anticipata quando tutti i connessi hanno risposto, come già oggi.
- **Una risposta sola**, come nelle domande. I pallini mostrano tutti i colori tranne il proprio.
- **Gruppi:** di norma coppie. Con giocatori dispari una figura esce in **trio** (tre colori). Per chi è in un trio è giusto **uno qualsiasi** dei colori degli altri due.
- **Punti:** gruppo **completo** (tutti indovinano un colore di un altro membro) → **1000** a testa. Gruppo **a metà** → **300** a chi ha indovinato, 0 agli altri. Non risponde o sbaglia → 0. Chiavi degli esiti (mia scelta): `complete` (1000), `half` (300), `miss` (0).

Mie scelte, che generalizzano le regole sopra:

- **Regola unica di correttezza:** è giusto qualunque colore posseduto da un **altro** giocatore con la tua stessa figura. Copre coppie, trio e i casi sotto senza eccezioni.
- **Distribuzione:** gruppi da 2 (uno da 3 se dispari) finché bastano le figure. Catalogo: **16 figure × 6 colori**. Oltre 33 giocatori i gruppi crescono (figure distribuite il più uniformemente possibile, mai due colori uguali nello stesso gruppo) fino a 6 per figura = 96 giocatori. Oltre 96 una figura si ripete in un secondo gruppo con colori diversi: la regola unica resta valida. Caso rarissimo, accettato.
- **Un giocatore solo:** il round si salta con 0 punti (stessa via di `skipRound`).
- **Chi riceve la carta (deciso con l'utente): tutti i giocatori in partita**, anche chi all'apertura è scollegato (telefono addormentato): se si risveglia entro i 90 s trova la sua carta e gioca. Due regole perché un assente non rovini il round a chi c'è:
  - nella distribuzione gli scollegati si mettono in coppia **fra loro** per primi; se ne avanza uno, diventa il terzo di una coppia di collegati, mai l'unico compagno di chi è presente;
  - chi **non si collega mai** durante il round non conta per il completamento del suo gruppo: in un trio con un assente, gli altri due prendono 1000 se si trovano. (Chi si collega anche solo per un momento conta.) Quindi `deal` riceve anche lo stato di connessione, e `game.js` tiene traccia di chi si è collegato durante il round.
- **Disconnessioni durante il round:** la risposta già data da chi si scollega vale. Se il compagno si scollega senza rispondere, chi ha indovinato prende 300. Al rientro (`player:rejoin`) il telefono riceve di nuovo la sua carta e il suo stato (risposto o no).

## Approcci considerati

1. **Estendere il contratto dei minigiochi con le "carte private" (scelto dall'utente).** Campi facoltativi nel contratto, gestiti in modo generico da `game.js`/`game-socket.js`. Più lavoro oggi, ma rispetta "un minigioco non conosce gli altri" e un futuro gioco a carte private (es. "trova l'impostore") ci si appoggia senza toccare altro.
2. **Ramo dedicato in `game.js`/`game-socket.js`.** Più veloce, ma viola la regola B del template e verrebbe copiato dal prossimo gioco simile. Scartato.
3. **Tutte le carte nel payload pubblico, ogni telefono mostra la sua.** Server quasi invariato, ma chiunque apra gli strumenti del browser vede tutte le carte. Scartato.

## Il contratto esteso (lato regole, `server/minigames/`)

Tutti facoltativi; un minigioco senza questi campi si comporta esattamente come oggi.

- **`deal(players, rnd)`** — pura. Chiamata all'**apertura** del round (in `_enterRound`) con tutti i giocatori in partita, `[{ id, connected }]`, così può accoppiare gli scollegati fra loro. Restituisce:
  - `hands: { [playerId]: card }` — la carta privata di ciascuno (qui `{ figure, color }`, con `color` = indice in `options`);
  - `table` — stato completo e opaco che serve a `resolve` e `progress` (qui: i gruppi).
- **`resolve(rnd, table)`** — quando il modulo ha `deal`, riceve `table` e restituisce `outcomeFor(optionIndex, playerId)` (secondo argomento nuovo; i moduli esistenti lo ignorano) e un `reveal` pubblico (qui: i gruppi con le carte, per id giocatore) che finisce in `game:results`. `machineChoice` resta `null`.
- `outcomeFor` e `progress` ricevono anche l'insieme di chi si è collegato almeno una volta durante il round (`present`), per applicare la regola "chi non c'è mai stato non conta".
- **`progress(table, answers, present)`** — pura. Data la mappa `playerId → optionIndex` delle risposte finora, restituisce i gruppi **completati** (array di array di playerId). Chiamata dopo ogni risposta accettata.

Validazione all'avvio (`server/minigames/index.js`): se c'è `deal`, si esegue a vuoto con id finti (2, 3, 7 giocatori) e si controlla che ogni id riceva una carta, che `resolve` accetti `table` e che `progress` restituisca un array. Un modulo malformato blocca il boot, come oggi.

`options` del modulo = i 6 nomi dei colori (`['Rosso', 'Blu', 'Verde', 'Giallo', 'Viola', 'Arancio']`): l'indice è l'identità del colore in tutto il sistema, come richiede il template.

## `game.js` (resta puro e testabile senza rete)

- `_enterRound`: se il modulo ha `deal`, chiama `deal(idsInPartita, this._rnd)` e conserva `hands`/`table` per il round. Con meno di 2 giocatori il round si salta.
- Nuovo `getHand(playerId)` → carta del giocatore o `null`.
- `submitAnswer`: scoring differito invariato. Dopo la registrazione, se c'è `progress`, ricalcola i gruppi completati e restituisce `{ recorded: true, newlyCompleted: [[...ids]] }` (solo quelli nuovi).
- `endQuestion`: passa `table` a `resolve`, usa `outcomeFor(optionIndex, playerId)`, mette `reveal` nel riepilogo.
- Test in `tools/test-game.js` (coppie, trio, dispari, 1 giocatore, gruppo a metà, `newlyCompleted` non ripetuto) e in `npm run test:minigames` (contratto esteso).

## `game-socket.js` (rete)

- `emitQuestion`: il round pubblico parte come oggi (nessuna carta dentro). Poi, se la sessione ha carte private, a **ogni socket giocatore** si manda solo la sua con `game:hand` (`{ roundIndex, card }`). Come trovare il socket di un playerId: scelta del builder.
- `player:rejoin` durante il round: la risposta include `hand`.
- Dopo ogni risposta con `newlyCompleted` non vuoto: `game:groups-completed` (`{ roundIndex, groups: [{ playerIds }] }`) **a tutti**. Va bene anche ai telefoni: in un gioco cooperativo sapere chi è già salvato aiuta a restringere la ricerca, e la risposta data non si può più cambiare. Nome generico, non del gioco.
- `game:snapshot` / `host:resync` a metà round includono i gruppi già completati, così la sala che si riavvia ritrova la striscia.
- **Bot di prova:** un bot con una carta privata non tira a caso: con probabilità ~70% sceglie il colore di un compagno di gruppo, altrimenti un colore a caso diverso dal suo. Passa comunque da `submitAnswer`. Senza questo, con 19 bot la striscia dei salvati resta vuota e la scena non si prova. La strategia sta in `server/test-bots.js` (pura).

## Presentazione (`client/shared/minigames/coppia-scoppiata.js` + CSS)

Il contratto di presentazione guadagna i campi facoltativi corrispondenti (nomi definitivi al builder), per esempio `player.renderHand(card, ctx)` e `sala.onGroupsCompleted(groups, ctx)`. `player/app.js` e `sala/app.js` li chiamano se esistono, senza nominare il gioco.

### Sala (durante i 90 s)

```
┌────────────────────────────────────────────────┐
│ [QUIZ ZATA!]      [Coppia Scoppiata]           │
│   Trova la tua coppia prima che scada il tempo! │
│                 ( TIMER GIGANTE )               │
│                                                │
│ SALVATI  (Luca + Ema) (Ale + Sara) (…) +2      │
└────────────────────────────────────────────────┘
```

- La frase sopra, il **timer gigante** al centro, la **striscia dei salvati in basso** (scelta dell'utente).
- **Il timer va ridisegnato**: l'utente vuole rivederlo esteticamente. Il cerchio giallo della bozza è un segnaposto; la forma definitiva si propone con una bozza visiva prima di chiuderla, dentro il sistema "Retro Street" (DESIGN.md).
- Striscia: l'ultimo gruppo salvato entra a sinistra con un "pop" + effetto sonoro, i più vecchi scorrono, oltre lo spazio "+N" (logica misurata come `fitLobbyStrip`). Facce (`AvatarSprite.fill`) e nickname, **mai figure né colori**.
- `salaOptions: false`. Niente colonna `salaPlayers`.
- Audio: colonna sonora di suspense (campo `audio` del contratto, file da `tools/make-minigame-audio.js`) + effetto `saved` per ogni gruppo salvato.

### Sala (rivelazione)

Le carte si girano gruppo per gruppo: prima i gruppi **completi** (+1000), poi quelli **a metà** (chi ha preso +300), poi quelli **scoppiati**. Poi la classifica come sempre. Figure = SVG del catalogo nel colore della carta.

Durata (mia scelta): `revealMs` **fisso** del modulo, come oggi. Tre tempi, uno per categoria (completi, a metà, scoppiati); dentro una categoria i gruppi si girano insieme con un piccolo sfasamento, così 3 gruppi o 16 stanno nello stesso tempo. Niente modifiche a `endQuestion` per una durata variabile.

### Telefono

```
   ┌─────────┐
   │  [QZ!]  │   ← carta coperta (back_carta.png)
   └─────────┘
  Mostra la carta        ← solo testo, niente sfondo né contenitore
  ● Rosso  ● Blu  ● Verde
  ● Viola  ● Arancio     ← il proprio colore non c'è
```

- All'apertura una breve animazione: la carta "arriva sul tavolo" coperta.
- Un pulsante **solo testo**, senza sfondo né contenitore: "Mostra la carta" / "Nascondi la carta". Toggle che **gira la carta** con un flip nei due versi. Fronte: `front_carta.png` con la figura SVG al centro, nel colore della carta.
- Sotto, **pallini** dei colori, con il nome sotto ognuno (mia scelta: per chi distingue male i colori, e in sala si dirà "sono il gatto giallo"). Il proprio colore non compare.
- Toccato un pallino, la risposta parte e si blocca ("Risposta inviata: guarda lo schermo!"), come negli altri round.
- `prefers-reduced-motion`: niente volo né flip, la carta cambia faccia e basta.

## Figure (asset)

**16 SVG semplici e super riconoscibili** in `resources/img/coppia-scoppiata/figure/`, disegnati dal builder (decisione dell'utente). Una figura = un file: contorno inchiostro + campiture in un unico colore sostituibile (`currentColor` o classe), così 16 file coprono tutti i colori. Proposta di lista (mia, si cambia liberamente): gatto, cane, pesce, elefante, coniglio, tartaruga, farfalla, uccellino, mela, ombrello, bicicletta, chitarra, casa, automobile, palloncino, cappello. Criterio: riconoscibile in un'occhiata a un metro, sagome diverse fra loro, nulla che dipenda dal colore per essere capito.

I 6 colori devono distinguersi bene fra loro sul telefono e sul proiettore e avere un nome comune; valori dai token di DESIGN.md dove possibile.

## Cosa resta al builder

- Nomi definitivi dei campi del contratto e degli eventi (purché generici).
- Come ricavare il socket di un playerId in `game-socket.js`.
- Valori esatti dei 6 colori e disegno delle 16 figure.
- Disegno del timer gigante (da mostrare all'utente in bozza prima di chiuderlo).
- Durate delle animazioni (arrivo carta, flip, pop della striscia, rivelazione).
- Colonna sonora ed effetti da `tools/make-minigame-audio.js`.
- Aggiornare CLAUDE.md (contratto con carte private, nuovo evento) e i due `_TEMPLATE.js`.

## Vincoli

- Le tre regole dei minigiochi in CLAUDE.md (nome file = tipo, funzioni del contratto pure, nessun minigioco nominato fuori dai suoi file tranne le tre righe `<script>`).
- `game.js` senza rete.
- Le carte private non passano mai da un `io.emit` globale né dalla room `players` in blocco.
- Funziona offline sul Raspberry: nessun asset esterno, SVG leggeri, animazioni CSS sul telefono.
