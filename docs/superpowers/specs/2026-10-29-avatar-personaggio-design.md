# Avatar personaggio al posto delle emoji

**Data:** 2026-10-29 · **Stato:** approvato a voce, in lavorazione

## Perché

L'avatar di un giocatore è oggi una di 12 emoji. L'utente ha un personaggio proprio
(modulo `mii-character.js`, portato da un altro progetto: corpo squadrato con divisa
uguale per tutti, **colore** della pelle e **espressione** 2D appiccicata sulla faccia)
e vuole che diventi l'avatar del gioco: scelto all'ingresso, visto ovunque.

## Decisioni dell'utente

- Niente 3D vivo sul telefono: i giocatori si collegano in rete locale senza scaricare
  librerie. Il personaggio è una foto PNG del modello 3D, più realistica di un disegno 2D.
- Schermata d'ingresso **minimal, senza riquadri**: il personaggio sta sullo sfondo
  dell'app; due frecce nude ai lati della faccia scorrono le espressioni; sotto il
  personaggio una fila di pallini per il colore. Bozza approvata:
  `.superpowers/brainstorm/4387-1793285396/content/scelta-avatar-minimal.html`.
- Molte espressioni, ben diverse. Outfit **fuori** per ora (divisa uguale per tutti).
- Il personaggio sostituisce l'emoji **ovunque**: lobby e classifica sul telefono,
  sala (pedine, parata, podio, classifica), pannello host.
- Fuori: la scena 3D della premiazione (luci, coppa, confetti) — l'utente ci sta lavorando.

## Proposte mie, accettate

- 12 espressioni: le 6 del modulo (`angry happy cool surprised wink fierce`) + 6 nuove
  nello stesso stile (`laugh love sleepy shades tongue nervous`).
- 8 colori: i preset del modulo.
- Combinazione iniziale a caso; frecce circolari; il telefono ricorda l'ultima scelta.

## Come è fatto

### Il dato
L'avatar resta una **stringa opaca** che il server valida, così protocollo, rejoin,
classifica e bot non cambiano forma: `"<colore>:<faccia>"`, es. `"sunny_yellow:happy"`.

- `client/shared/avatar-catalog.js` — **puro**, UMD (come `final-schedule.js`), caricato
  anche dal server: `COLORS`, `FACES`, `encode`, `parse`, `isValid`, `random(rnd)`.
  È l'unica definizione di "avatar valido".
- `server/game.js` — `addPlayer` valida con il catalogo; senza avatar ne estrae uno a caso.
  `AVATAR_IDS` sparisce. `server/test-bots.js` estrae combinazioni dal catalogo.

### Il disegno
- `client/shared/mii-character.js` — il modulo dell'utente, con: le 6 facce nuove in
  `draw2DFacialExpression` (esportata), e tre correzioni (vedi sotto). Resta caricabile
  senza three.js: three si passa come argomento solo a `createMii`.
- **Foto PNG del modello 3D** (decisione dell'utente, dopo una prima versione disegnata in
  2D su canvas): il telefono non deve scaricare nulla oltre alla pagina e alle sue
  immagini, quindi niente three.js sui client. `tools/render-avatars.js` apre una pagina
  locale che disegna con three.js ogni combinazione (96 + il neutro) e salva i PNG in
  `resources/img/avatars/{face,lg}/<colore>-<faccia>.png`: `face` 176×128, **solo la
  testa** (decisione dell'utente: nei mini avatar — pedine sulle risposte, liste,
  badge — il corpo intero era troppo piccolo per leggersi), `lg` 432×540 (~60 KB, il
  personaggio intero per la scelta sul telefono). Si rilancia quando cambia il
  catalogo o il modello.
- `client/shared/avatar-sprite.js` — sceglie il file: `AvatarSprite.fill(el, id)` mette un
  `<img>` alto ~1,25em nell'elemento, quindi ogni punto che aveva
  `el.textContent = avatarOf(id)` cambia di una riga e la misura la dà ancora il
  `font-size` già impostato. Id sconosciuto → `neutral.png`, mai un'immagine rotta.
  `preload()` scarica in anticipo le facce accanto, per le frecce della scelta.

### Correzioni al modulo
1. `setSkinColor`/`setExpression` aggiornano anche `controller.config` (prima restava vecchio).
2. Tornare da una faccia-immagine a un'espressione pronta toglie l'immagine.
3. Rimosso un commento JSDoc rimasto a metà.

### La schermata d'ingresso (`client/player/`)
La griglia di emoji diventa: personaggio grande al centro, `‹` `›` come `<button>` senza
fondo né bordo ai lati della faccia (`aria-label` "Espressione precedente/successiva"),
pallini colore come radiogroup. Scelta salvata in `localStorage` (try/catch).

### Test
- `tools/test-avatar.js` (nuovo, `npm run test:avatar`): catalogo puro, avatar dei bot, e
  che esista un PNG per ogni combinazione in entrambe le misure.
- `tools/test-game.js`, `tools/test-socket.js`: dagli id emoji agli id del catalogo.
- `npm run test:minigames`, `test:final` invariati, da rieseguire.

## Lasciato a chi costruisce
Disegno esatto delle 6 facce nuove e proporzioni del corpo 2D, dentro lo stile del modulo.
