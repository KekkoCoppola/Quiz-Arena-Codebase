# Morra Cinese in sala: chi ha scelto, e chi ha battuto il computer — design

## Perché

In sala la Morra mostra oggi tre carte Sasso/Carta/Forbice accanto al palco,
poi fa volare gli avatar sulla carta della mossa scelta e chiude con la riga
"Il computer ha scelto: X" sopra la classifica. Le carte ripetono i bottoni del
telefono, la riga ripete la ruota appena fermata, e gli avatar divisi per mossa
costringono la sala a fare il conto ("Carta batte Sasso, quindi…"). Durante la
scelta lo schermo non sa niente della stanza: il numero di risposte arriva solo
all'host. E la classifica mostra le prime cinque righe, quindi con venti
giocatori quindici non vedono mai il proprio esito.

## Cosa si vede (schermata B, scelta dall'utente)

**Durante la scelta.** Palco a sinistra come oggi (la mossa che cicla). A
destra, dove c'erano le carte, una colonna con i giocatori:

- in alto il contatore **"7 / 12 hanno scelto"**;
- sotto, un posto per ogni giocatore: chi ha scelto mostra la sua faccia
  (`AvatarSprite.fill`), il nome e una spunta verde, **senza dire cosa ha
  scelto**; chi deve ancora scegliere è un posto tratteggiato con "?" e il
  nome, leggibile (il grigio chiaro della bozza era sotto contrasto: va reso
  leggibile dal fondo della sala).

**Dopo la ruota.** Quando la ruota si è fermata sulla mossa del computer e la
sua pausa di lettura è finita, la sala si ferma qualche secondo a mostrare chi
ha battuto il computer e chi no, poi passa alla classifica come oggi.

**Tolti:** le carte delle scelte, la parata degli avatar sulle carte, la riga
"Il computer ha scelto: X" sopra la classifica. Resta la scritta sotto la
ruota quando si ferma: è la ruota stessa, non una ripetizione.

## Obiettivi

- La colonna "chi ha scelto" in sala per tutta la durata della scelta,
  aggiornata a ogni risposta (anche dei bot).
- La scena degli esiti dopo la ruota, poi la classifica.
- Nessun indizio sulla mossa di nessuno prima della ruota.
- Funziona con il pubblico di una serata vera: venti giocatori e oltre.

## Non obiettivi

- Telefono e pannello admin: restano come sono.
- Tre Bicchieri e le domande del quiz: invariati.
- Una sala che si riconnette a metà round: oggi mostra "Round N in corso…"
  fino al round dopo, e resta così.

## Approcci considerati

1. **Scelto (mia proposta).** Un campo nuovo nel contratto di presentazione,
   `salaPlayers: true`: la colonna dei giocatori e la scena degli esiti le
   disegna `sala/app.js` per qualunque minigioco che lo chiede, come oggi fa
   con le carte e la parata. La Morra dichiara `salaPlayers: true` (e
   `salaOptions: false`, che già spegne carte e riga di reveal).
2. **Scartato.** Tutto dentro `morra-cinese.js`. Il modulo dovrebbe conoscere
   l'elenco dei giocatori e ascoltare le risposte, cose che oggi un minigioco
   non vede; e la regola del progetto è che un comportamento che un altro
   minigioco potrebbe volere va nel contratto, non in un ramo.

## Come si costruisce

**Server: chi ha risposto.** L'evento `game:answer-count` oggi va solo alla
room `host` con `{ answered, total }`. Diventa
`{ answered, total, playerIds }` (gli id di chi ha risposto, in ordine
d'arrivo) e va a **tutti tranne la room `players`** (`io.except`, come
l'anteprima dei bicchieri): lo ricevono sala e host, i telefoni no. Non porta
nessuna mossa. Vale per le risposte vere e per quelle dei bot, che passano già
dallo stesso punto.

**Sala: l'elenco dei giocatori.** La sala tiene l'elenco che riceve già da
`game:lobby-update` e `game:snapshot` (oggi ne conserva solo il conteggio).
I posti della colonna sono i giocatori connessi all'apertura del round più
chiunque risponda; il totale del contatore è quello del server.

**Contratto.** `salaPlayers` (default `false`) in
`client/shared/minigames/index.js`, documentato come gli altri campi; la Morra
lo mette a `true`. `npm run test:minigames` lo verifica.

## Scelte mie, da correggere se non vanno

- **I posti non si rimescolano.** Ognuno ha il suo posto, nell'ordine di
  ingresso in partita, e si "gira" lì quando sceglie (piccolo scatto). Con le
  facce che cambiano posto a ogni risposta la sala non ritroverebbe nessuno.
- **La scena degli esiti sta nella stessa colonna.** I posti si ridividono in
  gruppi uno dopo l'altro: **Hanno vinto**, **Pareggio**, **Hanno perso**, e
  in coda **Non hanno scelto** se c'è qualcuno. Ogni gruppo porta i punti presi
  (+500, +100, +0, dai punti del round), i gruppi vuoti non compaiono. A
  sinistra la mossa del computer resta ferma. Circa 4-5 secondi, poi la
  classifica.
- **Molti giocatori.** I posti si rimpiccioliscono con il numero, fino a una
  misura che si legge ancora dal fondo; oltre, restano le facce e i nomi si
  tolgono. Con 24 giocatori i nomi devono starci a 1920×1080.
- **Suoni:** riusano quelli della sala (un tocco leggero per ogni scelta, con
  un limite per non fare un ronzio con venti bot insieme; il suono del reveal
  sul gruppo dei vincitori).
- **Movimento ridotto:** i gruppi compaiono già fatti, senza animazione.

## Lasciato a chi costruisce

Misure, animazioni, tempi esatti della scena (entro i 4-5 secondi), le classi
CSS (prefisso `.sala-`, token di `DESIGN.md`).

## Come si verifica

- `tools/test-socket.js`: un socket senza ruolo riceve `game:answer-count` con
  `playerIds` a ogni risposta; un telefono no.
- `npm run test:minigames`: default `salaPlayers: false`, Morra `true`.
- Browser, pagina `/debug` con la Morra e 19 bot: la colonna si riempie, i
  gruppi dopo la ruota corrispondono agli esiti dei telefoni, poi classifica.
  Screenshot all'utente, audio spento.
