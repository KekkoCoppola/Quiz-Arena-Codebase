# Immagini nelle domande (Design)

Data: 2026-08-29 · Branch: `bugfixCupgame` · Stato: in revisione

Una domanda può portare un'immagine, che compare **solo sulla vista sala**, nel
riquadro già predisposto sotto il testo. L'host la carica dall'editor senza
preoccuparsi di formato, peso o orientamento, e può decidere di **sfocarla** per
rendere il soggetto difficile da riconoscere.

Il riquadro esiste già: `.q-media` in `client/sala/`, oggi un segnaposto
tratteggiato con un'icona al centro. Quello che manca è tutto il resto — il
campo nel modello dati, il caricamento, lo stoccaggio, la consegna.

## Obiettivo

Che l'host carichi una foto qualunque — verticale, orizzontale, da telefono, da
20 megapixel — e non debba pensare a nient'altro. Sotto il cofano l'immagine
viene ridimensionata, ricompressa e stoccata in modo che **occupi il meno
possibile sulla SD del Raspberry restando guardevole su un proiettore**.

## Fuori scope

- **Immagini sul telefono dei giocatori.** Decisione esplicita, presa sapendo
  che il player *non* è una pulsantiera muta: renderizza `q.text` e le etichette
  delle opzioni (`client/player/app.js:227`). Quindi una domanda "Che animale è
  questo?" resta, sul telefono, non rispondibile senza alzare gli occhi al
  proiettore. Si accetta perché è un gioco da sala, dove lo schermo grande è
  l'oggetto comune che tutti guardano — ed è esattamente lo stesso principio per
  cui l'audio esce dal proiettore e non dai telefoni
  (`2026-08-12-comparto-audio-design.md`, §Fuori scope).
  La scelta **non è cablata nell'architettura**: il campo `image` arriva anche ai
  telefoni dentro `game:question` (sono ~90 byte, non vale un emit per-room) e
  l'endpoint che serve i byte è pubblico. Il giorno in cui si cambia idea, è un
  `<img>` in `player/app.js`. Nessun lavoro da disfare.
- **Immagini nei quiz di sistema** (`content/quizzes/*.json`). Non esiste un
  percorso di risoluzione da nome-di-file a blob, e inventarlo qui allargherebbe
  il lavoro a un secondo sottosistema. Lo schema accetta il campo per non
  chiudere la porta; `quiz-library.js` scarta il quiz e stampa l'errore se il
  file referenzia un hash che nel DB non c'è.
- **Ritaglio, rotazione o editing** dentro l'editor. L'host carica, guarda
  l'anteprima, eventualmente ricarica un file diverso. Un editor di immagini è
  un prodotto a sé.
- **Immagini sulle opzioni di risposta.** Solo sulla domanda.
- **Compressione lato server.** Vedi §3: è una conseguenza del vincolo SEA/ARM,
  non una preferenza.

## 1. Modello dati: l'immagine sta fuori dal quiz

Nuova tabella in `server/db/schema.sql`, indirizzata dal contenuto:

```sql
CREATE TABLE IF NOT EXISTS quiz_images (
    hash        TEXT    PRIMARY KEY,          -- SHA-256 esadecimale dei byte stoccati
    mime        TEXT    NOT NULL,
    bytes       BLOB    NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

Sulla domanda compare un campo solo:

```json
{
  "text": "Che animale è questo?",
  "options": ["Il fenicottero", "Il koala", "Il polpo", "La rana"],
  "correct_index": 1,
  "time_limit_s": 20,
  "image": { "hash": "3f2a…", "blur": false }
}
```

`image` vale `null`, oppure è assente, quando la domanda non ha immagine. Le due
cose sono equivalenti: **il ramo si sceglie sulla verità del valore, non sulla
presenza della chiave.**

> Questo è un cambiamento rispetto a `client/sala/app.js:270`, che oggi decide
> con `hasOwnProperty('image')` e tratta `image: null` come "immagine prevista ma
> non ancora caricata". Era un ponteggio sensato finché il campo non esisteva nel
> modello dati: serviva ad attivare il ramo con un payload finto. Ora il campo
> esiste, e a partita in corso lo stato "prevista ma assente" non vuol dire
> niente — o c'è un'immagine o non c'è. Il ponteggio va via, e con lui il commento
> che lo spiegava.

### Perché indirizzata dal contenuto, e non in base64 dentro `questions`

Mettere i byte dentro il JSON di `questions` è la strada più corta e sbaglia tre
volte:

1. `getQuizzesByUser` fa `SELECT … questions …` per costruire la **lista** dei
   quiz nell'editor (`quiz-manager.js:283`). Con i base64 inline, aprire
   l'elenco tirerebbe su ogni immagine di ogni quiz per mostrare tre titoli.
2. `hasUnsavedEditorChanges` (`client/host/app.js:623`) fa
   `JSON.stringify(state.questions)` per decidere se mostrare un asterisco.
   Serializzare megabyte a ogni controllo per quella domanda è sproporzionato.
3. Base64 costa **+33%** di byte rispetto ai byte grezzi, su ogni copia.

Con l'hash, ogni domanda porta ~90 byte. In più si ottengono due cose gratis:
la stessa foto usata in due quiz occupa **una riga sola**, e l'hash **è** la
chiave di cache HTTP (vedi §2).

### `getCurrentRound()`

`server/game.js:348` è già una **allowlist esplicita** di campi — non uno spread —
proprio perché da lì passa la sanificazione che tiene `correct_index` lontano dai
client. Si aggiunge `image: r.image ?? null` a quell'elenco. Nessun'altra modifica
al motore di gioco: un round con immagine è un round come gli altri.

## 2. Consegna: due endpoint, e la cache fa il resto

| Metodo | Percorso | Auth | Dove |
|---|---|---|---|
| `POST` | `/api/host/quiz-image` | JWT host | `server/routes/host.js` |
| `GET` | `/api/quiz-image/:hash` | **nessuna** | `server/index.js` |

Il GET è **pubblico** per la stessa ragione già scritta in CLAUDE.md per
`GET /api/join-info`: la vista sala non ha token e non può averne uno. Va montato
accanto a quello, cioè al punto 5 dell'ordine dei middleware — **prima** del
fallback `/api/*` → 404, altrimenti risponderebbe HTML.

Risposta del GET:

```
Content-Type:  image/webp
Cache-Control: public, max-age=31536000, immutable
ETag:          "<hash>"
```

`immutable` non è ottimismo: **l'URL contiene l'hash del proprio contenuto**,
quindi per costruzione non può mai servire byte diversi. La conseguenza pratica è
che ogni dispositivo scarica un'immagine **una volta sola per tutta la serata**,
anche se l'host rigioca la stessa partita con `host:restart-game`.

È anche il motivo per cui l'immagine **non viaggia sul socket**. `emitQuestion`
(`game-socket.js:131`) è un `io.emit` globale: un base64 da 150KB dentro il
payload verrebbe ritrasmesso a ogni socket a ogni domanda — con venti telefoni in
sala, ~2,4MB sull'access point del Pi per ogni domanda, senza alcuna possibilità
di cache. Sul socket viaggia il riferimento; i byte se li prende chi li vuole,
via HTTP, una volta.

### Il POST non si fida del client

La compressione avviene nel browser (§3), ma è un'**ottimizzazione, non un
controllo**. L'endpoint autenticato applica comunque:

- `express.raw({ type: 'image/webp', limit: '400kb' })`, montato **solo su questa
  route** — il resto delle API continua a parlare JSON;
- verifica dei magic bytes: `RIFF` ai byte 0-3 e `WEBP` ai byte 8-11. Un
  `Content-Type` è un'affermazione del client, i primi dodici byte no;
- `width`/`height` arrivano nella query string e vengono validati come interi
  positivi entro i limiti attesi.

Il server calcola lui l'hash (`node:crypto`, `createHash('sha256')`), fa INSERT
se assente, e risponde `{ success: true, data: { hash, width, height } }` — il
formato REST unificato del progetto. Un hash che il client si fosse inventato non
avrebbe modo di entrare.

### Nota di sicurezza, dichiarata e accettata

Chiunque sia sull'access point può scaricare qualunque immagine di cui conosca
l'hash, senza autenticarsi. L'hash è a 256 bit e non si indovina; la rete è
quella chiusa di un evento; e le immagini sono destinate a essere proiettate su
un muro davanti a tutti. È una scelta, non una svista: l'alternativa
(autenticare il GET) renderebbe la vista sala impossibile senza inventarle un
token, che è precisamente ciò che il progetto ha deciso di non fare.

## 3. Compressione: nel browser dell'host

`sharp`, `jimp` con binding nativi e simili sono **esclusi**. CLAUDE.md è
esplicito: `node:sqlite` è stato scelto proprio "per eliminare moduli nativi da
compilare per il packaging SEA finale su ARM". Introdurre ora una dipendenza
nativa per ridimensionare foto rimetterebbe in gioco quella decisione per una
funzione secondaria.

Il lavoro lo fa quindi **Canvas nel browser di chi crea il quiz** — un tablet o
un PC, in un momento tranquillo, non il Raspberry davanti a una sala.

### La pipeline

```
<input type="file" accept="image/*">
  → createImageBitmap(file, { imageOrientation: 'from-image' })
  → canvas ridimensionato (lato lungo ≤ 1280px, rapporto preservato)
  → canvas.toBlob('image/webp', q) con q che scende finché byte ≤ tetto
  → POST /api/host/quiz-image
```

| Parametro | Valore | Perché |
|---|---|---|
| Lato lungo max | **1280 px** | `.q-card-wrap` è `max-width: 48rem` = 768px CSS; su un proiettore 1080p a 1× sono 768 pixel fisici. 1280 è già margine abbondante. |
| Qualità iniziale | **0.80** | WebP a 0.80 è visivamente pulito su fotografie; sotto 0.65 iniziano gli artefatti visibili in proiezione. |
| Scala di ripiego | 0.80 → 0.72 → 0.65 → 0.58 | Si scende solo se serve. Sotto 0.58 non si scende: si accetta il file più grande piuttosto che proiettare poltiglia. |
| Tetto | **153.600 byte** (150 KiB) | 20 domande illustrate ≈ 3MB per quiz. Su una SD è nulla, e sull'AP è un download che si fa una volta. |
| Input accettato | fino a **25 MB** | "Non si senta limitato". Una foto da telefono sta comodamente sotto. |

### Tre dettagli che non sono dettagli

- **Nessun ritaglio, mai.** Si scala il lato lungo e si preserva il rapporto.
  Verticale, orizzontale e quadrato entrano tutti, e in sala ci pensa
  `object-fit: contain` a farli stare interi nel riquadro (§5). Ritagliare per
  far combaciare il 16:9 significherebbe decidere noi cosa dell'immagine conta.
- **`imageOrientation: 'from-image'` è obbligatorio.** Le foto da telefono
  arrivano quasi sempre ruotate via EXIF: senza quel flag finiscono di lato, e il
  bug si manifesterebbe solo con file veri, mai con quelli di prova.
- **Il ri-encode via canvas butta via i metadati**, coordinate GPS comprese.
  Effetto collaterale gradito, e vale la pena saperlo: una foto scattata in casa
  non porta l'indirizzo di casa dentro il DB.

### Dove sta il codice

La separazione ricalca quella di `audio-logic.js` / `audio.js`, già stabilita nel
progetto:

- **`client/shared/image-budget.js`** — le **decisioni pure**, senza DOM: quali
  dimensioni target per una data coppia larghezza/altezza, quale qualità provare
  dopo un tentativo troppo pesante, com'è fatto un hash valido. Wrapper UMD come
  gli altri moduli condivisi, quindi caricabile in Node e testabile
  (`tools/test-image.js`, `npm run test:image`).
- **`client/host/app.js`** — il **motore**: `<input type="file">`, canvas,
  `toBlob`, POST, anteprima. Tutto ciò che tocca il DOM o la rete.

Il modulo puro sta in `client/shared/` e non in `client/host/` perché è servito
dal mount `/shared` già esistente e non richiede un nuovo montaggio statico. Lo
usa oggi solo l'editor.

## 4. Blur: una classe CSS, non un secondo file

Il toggle **non** genera e stocca una copia sfocata. In sala, l'`<img>` prende
una classe che applica `filter: blur(...)`.

Tre ragioni, in ordine di peso:

1. **Il toggle resta reversibile.** L'host cambia idea, togliendo una classe.
   Con una copia cotta, tornare indietro richiederebbe di aver conservato anche
   l'originale — cioè due blob per immagine, esattamente il contrario
   dell'obiettivo di §Obiettivo.
2. **Occupazione invariata.** Un blob per immagine, sempre.
3. Il costo di rendering è un `filter` su un'immagine statica: si dipinge una
   volta all'ingresso nel round, non a ogni frame.

L'obiezione ovvia è che l'immagine nitida resta nel DOM e chiunque apra i
DevTools la vede. In sala non c'è nessuno che apra i DevTools: è un proiettore
collegato a un Chromium in kiosk, senza tastiera e senza mouse. Ed è precisamente
il punto 3 della richiesta — **nessun click sull'immagine deve fare niente** —
che si soddisfa da sé: l'`<img>` non ha handler, non è dentro un `<a>` né un
`<button>`, e prende `pointer-events: none` più `user-select: none` per non
diventare per sbaglio bersaglio di un drag o di una selezione.

Il blur è **per-domanda** e vive dentro `image.blur`, non è uno stato globale: due
domande dello stesso quiz possono averne una sfocata e una no.

## 5. Il ritaglio da riparare, che è un prerequisito

`client/sala/style.css:454` dà all'`<img>` `width: 100%; height: 100%;
object-fit: contain`, dentro un `.q-media` che è `display: grid` con
`aspect-ratio: 16/9` e `max-height`. **La percentuale non si risolve come
sembra**: `height: 100%` si misura contro la traccia di riga della griglia, non
contro il `max-height` del contenitore, e degrada ad `auto`. L'immagine tiene
allora il proprio rapporto alla larghezza piena e sfonda in altezza; il
contenitore, che ha `overflow: hidden`, la taglia.

Misurato dal vivo con il logo del progetto (1254×1254) nel container reale:

| | valore |
|---|---|
| `.q-media` | 704 × **187,2 px** |
| `<img>` calcolato | 696 × **696 px** |

`object-fit: contain` non ha modo di intervenire: l'elemento *è* quadrato, ed è
il contenitore a ritagliarlo.

La correzione toglie le percentuali dal gioco:

```css
.q-media     { position: relative; }
.q-media img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
```

Verificata nel browser: l'`<img>` passa a 696 × 179,188 px e l'immagine entra
intera, in letterbox.

Non è scope creep, è il **prerequisito**: senza questa riga *ogni* immagine
caricata verrebbe tagliata, e la §3 (nessun ritaglio, mai) sarebbe una bugia. Il
segnaposto attuale non lo rivela perché l'icona è un glifo di font a dimensione
fissa, non un elemento sostituito: passa indenne. Il difetto si vede solo con
un'immagine vera — cioè mai, finché il campo non esiste.

## 6. Raccolta degli orfani

Le immagini sono condivise fra domande e fra quiz, quindi cancellare una domanda
**non può** cancellare il blob: potrebbe servire altrove.

Raccolta all'avvio, in `initDb()` subito dopo `syncPreloadedQuizzes()`: si
eliminano le righe di `quiz_images` il cui hash non compare in nessun `questions`
né di `quizzes` né di `preloaded_quizzes`.

Un refcount sarebbe più efficiente e più fragile: un contatore va aggiornato da
ogni percorso che tocca una domanda, e basta dimenticarne uno perché diventi
bugiardo in modo silenzioso. Con al massimo tre quiz per utente e venti domande
per quiz, la scansione completa costa millisecondi e **non può disallinearsi**,
perché ricalcola la verità invece di ricordarla.

Come lo `syncPreloadedQuizzes` accanto a cui gira, la raccolta è idempotente:
riavviare due volte non cambia niente.

## 7. Interfaccia dell'editor

Dentro la scheda di ogni domanda (`buildQuestionItem`, `client/host/app.js:692`),
sotto il testo:

**Stato vuoto** — un bottone `Aggiungi immagine` con l'icona FontAwesome, nello
stile dei bottoni già presenti. Nessun riquadro, nessun ingombro: una domanda
senza immagine è il caso normale e non deve pagare pixel per una funzione che non
usa.

**Durante l'elaborazione** — il bottone diventa inerte e mostra l'avanzamento.
Ridimensionare un file da 20MB richiede qualche secondo su un tablet, e senza un
segnale l'host clicca di nuovo.

**A immagine caricata** — l'anteprima **nelle proporzioni esatte del riquadro di
sala**, con lo stesso `object-fit: contain`: quello che l'host vede è quello che
vedrà la stanza. Accanto:

- un toggle **`Sfoca immagine`**, che applica il blur **all'anteprima** — se non
  si vede l'effetto, non si può decidere se è quello giusto;
- un bottone **`Rimuovi`**, che azzera `image` sulla domanda (il blob resta in
  DB fino alla raccolta di §6);
- il peso finale in KB, in piccolo. Non serve all'host per decidere niente, ma
  rende visibile che sotto il cofano è successo qualcosa — ed è l'unico posto in
  cui il lavoro di §3 diventa osservabile.

**In errore** — file non decodificabile, troppo grande, rete caduta: un toast con
il motivo, e la domanda resta senza immagine. Nessuno stato a metà.

## 8. Validazione

`server/quiz-schema.js` è l'unica definizione di "quiz valido" del progetto e
resta tale. Si aggiunge, per ogni domanda:

- `image` assente o `null` → valida, nessuna immagine;
- altrimenti dev'essere un oggetto con `hash` stringa di **esattamente 64
  caratteri esadecimali minuscoli** e `blur` booleano. Niente altre chiavi.

Il controllo è **sulla forma, non sull'esistenza**: `quiz-schema.js` è un modulo
puro, senza DB, e deve restare tale. Che l'hash corrisponda a una riga esistente
lo verifica chi ha un DB sotto — la route di salvataggio per i quiz dell'editor,
`quiz-library.js` per i file di sistema.

## 9. Test

Nessun framework: script standalone con `assert()` locale, come tutti gli altri.

- **`tools/test-image.js`** (nuovo, `npm run test:image`) — puro, nessun DOM,
  nessuna rete: dimensioni target per orizzontale / verticale / quadrato / già
  piccolo (che non dev'essere ingrandito), discesa della scala di qualità e suo
  pavimento, forma dell'hash.
- **`tools/test-quizzes.js`** (esteso) — lo schema accetta `image` assente, `null`
  e un oggetto valido; rifiuta hash di lunghezza sbagliata, hash con caratteri
  non esadecimali, `blur` non booleano, chiavi estranee.
- **`tools/test-db.js`** (esteso) — scrittura e rilettura di un blob;
  deduplicazione (due `putImage` con gli stessi byte → una riga); la raccolta
  elimina l'orfano e **non** tocca quello referenziato.

Non coperto da test automatici, perché richiederebbe un browser vero: la pipeline
canvas (`createImageBitmap`/`toBlob`). Si verifica a mano caricando una foto
verticale e una orizzontale e guardando il risultato in sala. È lo stesso confine
già accettato per `audio.js` rispetto ad `audio-logic.js`.

## 10. File toccati

**Nuovi**

- `client/shared/image-budget.js`
- `tools/test-image.js`

**Server**

- `db/schema.sql` — tabella `quiz_images`
- `quiz-manager.js` — `putImage`, `getImage`, `gcOrphanImages`; chiamata alla
  raccolta in `initDb()`
- `quiz-schema.js` — validazione di `image`
- `game.js` — `image` nell'allowlist di `getCurrentRound()`
- `index.js` — `GET /api/quiz-image/:hash`
- `routes/host.js` — `POST /api/host/quiz-image`

**Client**

- `host/app.js`, `host/index.html`, `host/style.css` — caricamento, anteprima,
  toggle
- `sala/app.js` — `renderQuestionMedia` sulla verità del valore, classe blur
- `sala/style.css` — correzione §5, classe blur, `pointer-events: none`

**Contorno**

- `content/quizzes/_TEMPLATE.json.txt` — documentare il campo e il fatto che nei
  quiz di sistema non è ancora utilizzabile
- `package.json` — `test:image`
- `CLAUDE.md` — il nuovo sottosistema, con la decisione sala-only e il perché
- `tools/test-quizzes.js`, `tools/test-db.js`

**Non toccato: `client/player/`.** Vedi §Fuori scope.

## 11. Verificato: la pipeline funziona su HTTP semplice

La domanda era legittima e non ovvia: tutto gira in locale, senza TLS, e molte
API moderne del browser sono **gated su secure context**. Per di più
`http://localhost` *è* un secure context mentre `http://192.168.x.x` **non lo è**
— una dipendenza sbagliata funzionerebbe in sviluppo e fallirebbe in sala, che è
il momento peggiore per scoprirlo.

Misurato il 2026-08-29 su `http://192.168.1.25:3000` (`isSecureContext: false`),
non su localhost:

| API | esito |
|---|---|
| `createImageBitmap` | disponibile |
| `canvas.toBlob` | disponibile |
| `File` / `Blob` / `FileReader` | disponibili |
| `fetch` | disponibile |
| `OffscreenCanvas` | disponibile |
| `navigator.mediaDevices` | **undefined** |
| `navigator.clipboard` | **undefined** |

Le ultime due sono la **controprova**: sono davvero gated, e infatti mancano.
Il test non sta dando un falso negativo.

Pipeline eseguita per intero sulla stessa origine, con un PNG sintetico
3000×1000 da 2.463.334 byte:

| passo | risultato |
|---|---|
| `createImageBitmap(file, { imageOrientation: 'from-image' })` | 3000×1000 |
| `targetDimensions` | 1280×427 |
| `toBlob('image/webp', 0.80)` | **34.090 byte** |
| 0.72 / 0.65 / 0.58 | 29.676 / 28.300 / 26.864 byte |

Il primo gradino sta già a un quarto del tetto: la scala di qualità è una rete
per le foto rumorose, non il caso normale.

**Conseguenze da ricordare**, tutte figlie del `isSecureContext: false`:

- **Niente `getUserMedia`.** Un eventuale "scatta la foto adesso" dentro il
  pannello non funzionerebbe sull'access point. Ma `<input type="file"
  accept="image/*">` su tablet o telefono apre il selettore **del sistema
  operativo**, che la fotocamera la offre già: quella strada resta aperta.
- **Niente `navigator.clipboard`.** Un "incolla un'immagine" dovrebbe passare
  dall'evento `paste` e da `clipboardData.items`, che invece funzionano.
- **Il server deve essere in esecuzione quando si crea il quiz**, perché
  l'immagine finisce nel suo DB. Vale già per salvare un quiz, ma con le
  immagini pesa di più accorgersene tardi.

## Rischi noti

| Rischio | Mitigazione |
|---|---|
| `toBlob('image/webp')` non supportato dal browser dell'host | Chromium e Firefox lo supportano da anni, Safari da 14. Se `toBlob` restituisce un blob `image/png`, si rileva dal `type` e si mostra un errore chiaro invece di caricare un PNG spacciato per WebP. |
| Foto molto grandi che saturano la memoria del tablet durante il decode | Il tetto di 25MB in input; `createImageBitmap` decodifica fuori dal thread principale, quindi l'interfaccia non si blocca comunque. |
| Il blur CSS su un Raspberry rallenta l'ingresso nel round | È un `filter` su un'immagine statica, dipinto una volta. Da verificare sull'hardware vero prima della serata, insieme al resto. |
| Il DB cresce senza che nessuno se ne accorga | La raccolta di §6 all'avvio, più il peso mostrato in editor (§7). |
