# Schermata di debug dei minigiochi — design

## Perché

Per vedere un minigioco oggi bisogna creare una partita, riempirla di bot,
avviarla, giocare una domanda e solo dai risultati inserire il minigioco.
L'utente vuole provare ogni minigioco con un clic, con pubblico finto: sipario
con la ruota, minigioco, risultati. La schermata è un attrezzo di sviluppo, non
una funzione del prodotto: deve sparire del tutto quando non serve.

## Obiettivi

- Pagina `/debug` con, in alto, un bottone per ogni minigioco del registry più
  "Casuale", il numero di bot, "Salta round" e "Avanti"; sotto, affiancati, la
  **sala** (16:9, la pagina vera `/sala`) e un **telefono finto** (la pagina
  vera `/`) che entra da solo nella partita.
- Un clic su un minigioco: partita nuova con i bot e il telefono finto →
  sipario e ruota → minigioco → risultati. "Avanti" dopo i risultati porta alla
  premiazione: il minigioco è l'ultimo round della partita di prova, quindi si
  prova anche la cerimonia con il pubblico finto.
- Tre Bicchieri gioca i suoi 5 livelli; "Salta round" funziona come nel
  pannello admin.
- **Spenta di default.** Si accende solo con `DEBUG_TOOLS=1` nel `.env`
  (letto in `server/config.js`, come ogni variabile). Spenta, la pagina non è
  servita e gli eventi `debug:*` non esistono.
- **Audio della sala spento** nella pagina di debug: chi prova è spesso in
  remote control e la sala suona dal PC.

## Non obiettivi

- Provare le domande del quiz (c'è già la partita normale).
- Cambiare il pannello admin o le regole dei minigiochi.
- Usarla durante un evento: crea una partita nuova e chiude quella in corso.

## Approcci considerati

- **A · Pagina a sé — scelto dall'utente.** Sala e telefono affiancati su uno
  schermo, si toglie cancellando una cartella, un modulo e poche righe.
- B · Sezione debug nel pannello admin che pilota la sala vera: scartato,
  sala e telefono vanno aperti a parte e tocca il pannello.

## Come (deciso)

- **Configurazione**: `config.debugTools` = `process.env.DEBUG_TOOLS === '1'`;
  riga commentata in `.env.example`.
- **Pagina**: `client/debug/` (`index.html`, `debug.js`, `debug.css`), montata
  in `server/index.js` su `/debug` **solo** se `config.debugTools`, prima del
  router player. Usa il JWT del pannello admin già salvato nel browser
  (`localStorage['quizzata_token']`, stessa origine): senza, mostra "Accedi
  prima al pannello admin" con il link.
- **Server**: `server/debug-tools.js` con `attachDebugHandlers(socket, ctx)`,
  agganciato in `game-socket.js` con una riga dietro `config.debugTools`. `ctx`
  passa solo ciò che serve (sessione corrente, creazione di una sessione nuova,
  bot, trasmissione del round, guardia host, `ok`/`fail`), così il modulo non
  tocca lo stato interno di `game-socket.js`. Eventi, tutti host-only:
  - `debug:minigames` → l'elenco del registry (`listForUi()`), per i bottoni;
  - `debug:prepare { bots }` → chiude la partita in corso e ne crea una nuova
    su un quiz segnaposto (una domanda), con i bot in lobby;
  - `debug:play { type }` → da `LOBBY`: avvia, chiude la domanda segnaposto
    senza trasmetterla, inserisce il minigioco (`insertMinigame`) e trasmette
    il round. Solo API pubbliche di `GameSession`.
- **Telefono finto**: la pagina di debug, che ha la stessa origine, compila il
  nickname e preme "Entra" dentro l'iframe del telefono dopo `debug:prepare`,
  poi chiede `debug:play`.
- **Sala muta**: `/sala?muto` non attiva l'audio (una riga in
  `client/sala/app.js`, utile anche per provare la sala in silenzio fuori dal
  debug). L'iframe della sala nella pagina di debug usa `?muto`.
- **Rimozione**: cancellare `client/debug/` e `server/debug-tools.js`, la riga
  di mount in `index.js`, la riga in `game-socket.js`, `debugTools` in
  `config.js`. Le istruzioni vanno in testa a `debug-tools.js` e nel CLAUDE.md.

## Lasciato a chi costruisce

Disposizione e stile della pagina (token del pannello admin, DESIGN.md §7),
nickname del telefono finto, gestione del ridimensionamento degli iframe.

## Verifica

`tools/test-socket.js` con `DEBUG_TOOLS=1` nel server di prova: `debug:play`
rifiutato senza token, `debug:prepare` + `debug:play cup_game` → `game:question`
minigioco al livello 1, "Avanti" dopo l'ultimo livello → `game:final`. Prova in
browser con screenshot: pagina, Morra fino ai risultati, Tre Bicchieri.
