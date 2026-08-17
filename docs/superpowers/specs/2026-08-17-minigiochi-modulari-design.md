# Struttura modulare dei minigiochi — design

*17 agosto 2026 · branch `Minigames`*

## Problema

I minigiochi sono pensati come moduli che si aggiungono nel tempo, uno per aggiornamento. Prima di questo lavoro solo metà del sistema era modulare: il registry `MINIGAME_TYPES` esponeva già un contratto pulito (`build()`/`resolve()`/`points`), ma viveva **dentro** la state machine, e tutto il resto era cablato su Morra Cinese.

Aggiungere il secondo minigioco avrebbe richiesto di toccare 8 punti sparsi in 6 file:

| Punto | Dove stava |
|---|---|
| Registry | dentro `server/game.js` |
| Asset + `morraImg()` + suspense | `client/host/app.js` |
| Asset + `morraImg()` **duplicati** | `client/player/app.js` |
| Rami `if (isMinigame)` con testi hardcoded | entrambi gli `app.js` |
| Tipo hardcoded nel bottone host | `client/host/app.js` |
| Tipo hardcoded nell'editor | `client/host/app.js` |
| CSS `.morra-*` | entrambi gli `style.css` |

E non esisteva alcun modo di chiamare un minigioco casuale: il bottone dell'host mandava `{ type: 'morra_cinese' }` fisso.

## Obiettivo

Un minigioco = un modulo isolato e autoregistrante. Aggiungerne uno significa creare **2 file** (regole + presentazione) e aggiungere **2 righe `<script>`**; modificarne uno significa aprire i suoi 2 file e nient'altro.

Vincolo di partenza: **zero regressioni funzionali**. A fine lavoro la Morra Cinese si gioca esattamente come prima, e i tipi già salvati in `quizzes.minigames` restano stringhe identiche — nessuna migrazione DB.

## Struttura

```
server/minigames/
  index.js            Registry: autoload, validazione contratto, shuffle bag
  morra-cinese.js     ← REGOLE (opzioni, punti, resolve)
  _TEMPLATE.js        Contratto documentato riga per riga

client/shared/minigames/          ← servito su /shared
  index.js            Registry di presentazione + fallback generico
  morra-cinese.js     ← PRESENTAZIONE (icone, suspense, reveal host+player)
  minigames.css       Una sezione per gioco, prefisso .mg-<tipo>-
  _TEMPLATE.js

resources/img/morra-cinese/       Asset del gioco, nella sua cartella
```

Tre strati con lo stesso confine puro/IO già usato da `game.js` vs `game-socket.js` e da `audio-logic.js` vs `audio.js`.

## Decisioni e perché

### Il nome del file è la fonte di verità del tipo

`morra-cinese.js` → `morra_cinese`, verificato all'avvio. Cercare un tipo porta sempre al file giusto, e due moduli non possono rubarsi la stessa chiave.

### La validazione esegue davvero `build()` e `resolve()`

Il registry non si limita a controllare la forma dell'oggetto: al boot invoca `build()` una volta e `resolve()` con tre valori di `rnd`, verificando che ogni `outcomeFor(i)` restituisca una chiave presente in `points` e che `machineChoice` cada nel range delle opzioni.

Intercetta la svista più probabile di un modulo nuovo — un `outcomeFor()` che dice `'pareggio'` mentre la tabella punti dice `'draw'` — **all'avvio del server invece che davanti a una sala piena**. Il prezzo è un vincolo esplicito: `build()` e `resolve()` devono essere pure. È scritto nei due template.

Un modulo malformato impedisce l'avvio del server. È deliberato: meglio un boot fallito di un minigioco che si rompe in partita.

### `resolve(rnd)` invece di `resolve()`

Il generatore casuale è iniettabile, esattamente come il parametro `now` di `GameSession`. `GameSession` accetta un secondo argomento `{ rnd }` e lo propaga. Rende un minigioco testabile in modo deterministico senza dipendere dalla casualità reale — `tools/test-minigames.js` verifica che lo stesso seme produca lo stesso esito.

### Il segnaposto `random` è risolto al momento dell'uso

`RANDOM_TYPE = 'random'` è accettato ovunque si indichi un tipo: negli slot pianificati in editor e in `host:insert-minigame`. Viene risolto in `buildRounds()` e in `insertMinigame()`, quindi il round generato porta **sempre** un `minigameType` concreto: i client non vedono mai `'random'` e non hanno bisogno di saperlo.

### Shuffle bag, non `Math.random()` secca

`createShuffleBag(keys, rnd)` restituisce i tipi in ordine casuale senza ripetizioni finché non li ha esauriti tutti, poi rimescola — evitando anche di ripescare subito l'ultimo uscito, altrimenti la fine di un sacchetto e l'inizio del successivo produrrebbero lo stesso gioco due round di fila, proprio il caso che la struttura esiste per prevenire.

Il sacchetto è per-sessione (`this._minigameBag`), condiviso fra slot pianificati e inserimenti ad-hoc, e ricreato a ogni nuova `GameSession` (quindi anche a `host:restart-game`). Con un solo tipo registrato restituisce sempre quello: comportamento atteso, non un caso limite.

### `Minigames.get()` non restituisce mai null

Un tipo sconosciuto — modulo non caricato, quiz salvato con un minigioco poi rimosso — ottiene una presentazione generica funzionante (lettere A/B/C, reveal testuale). Durante un evento dal vivo uno schermo generico è accettabile, uno schermo rotto no.

Lo stesso principio nell'editor: un tipo assente dal catalogo viene mantenuto e mostrato come *"(non disponibile)"* invece di essere azzerato in silenzio. Il caso non è teorico — il DB di sviluppo contiene un quiz con `pari_dispari`, un tipo che non esiste più.

### Tutto facoltativo tranne `type` e `label`

Il registry client completa una presentazione parziale con i default, un livello alla volta (un modulo che definisce solo `host.reveal` conserva `host.startSuspense` generico). Un minigioco nuovo è giocabile con ~15 righe e si arricchisce dopo.

### Niente DOM al caricamento dei moduli client

`document` compare solo dentro le funzioni. Permette a `tools/test-minigames.js` di caricare i moduli in Node e verificarne il contratto senza jsdom, ed è la cucitura che permetterà in futuro a un `host.reveal()` di disegnare in 3D senza toccare nient'altro.

### `/shared` separato da `/resources`

Nuovo mount statico in `server/index.js`, subito dopo `/resources`. `resources/` è documentato come cartella asset (loghi, font); `client/shared/` è codice. Tenerli distinti evita che la prima diventi una discarica.

### Il colore del round resta nelle SPA

`minigames.css` contiene solo forma e dimensione. L'accento del round minigioco (`.is-minigame`) resta nei due fogli di stile perché usa token diversi: `--retro-ochre` sull'host, `--ticket-ochre` sul player. Duplicarli nel file condiviso avrebbe creato una terza fonte di verità sui colori.

## Verifica

Automatica — tutti verdi:

| Suite | Esito |
|---|---|
| `tools/test-game.js` | 80/80, **con le asserzioni immutate** — è la prova che il refactor è a comportamento invariato |
| `tools/test-minigames.js` | 45/45 (nuovo) |
| `tools/test-db.js` | 20/20 |
| `npm run test:socket` | 55/55 |

Manuale, in browser su una partita reale:

- Morra Cinese pianificata in editor: suspense, reveal, distribuzione evidenziata e punteggi identici a prima del refactor, su host e player.
- Editor: menù popolato da `GET /api/host/minigames`, valore esistente conservato e riga accesa.
- Editor con tipo rimosso (`pari_dispari`): voce *"(non disponibile)"*, scelta non persa.
- Bottone minigioco da RESULTS con `type: 'random'`: round estratto e partita che prosegue.
- Payload con `minigameType` inesistente iniettato in entrambi i client: presentazione generica, **zero errori in console**.

## Cosa NON è stato fatto

Nessun secondo minigioco giocabile: la struttura è documentata dai due `_TEMPLATE.js`, non da un esempio reale. È una scelta di scope — il primo minigioco vero scritto contro questa struttura ne sarà anche il collaudo.
