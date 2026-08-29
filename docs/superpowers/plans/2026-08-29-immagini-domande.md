# Immagini nelle domande — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Una domanda può portare un'immagine, caricata dall'editor host e mostrata **solo sulla vista sala**, con un toggle di sfocatura per-domanda.

**Architecture:** L'immagine viene ridimensionata e ricompressa in WebP **nel browser dell'host** (Canvas — niente moduli nativi sul server, vincolo SEA/ARM), stoccata come BLOB in una tabella SQLite **indirizzata dal contenuto** (`hash` = SHA-256 dei byte), e referenziata dalla domanda con `image: { hash, blur }`. Sul socket viaggia solo il riferimento; i byte si scaricano via HTTP da un endpoint pubblico con `Cache-Control: immutable`, quindi una volta sola per dispositivo per tutta la serata.

**Tech Stack:** Node.js v24 (`node:sqlite`, `node:crypto`), Express 4, Socket.io 4, JS vanilla senza build step su tre SPA.

**Spec:** [docs/superpowers/specs/2026-08-29-immagini-domande-design.md](../specs/2026-08-29-immagini-domande-design.md)

## Global Constraints

- **Nessun modulo nativo.** Niente `sharp`, `jimp`, `canvas` lato server, né altre dipendenze con binding da compilare: il progetto usa `node:sqlite` proprio per eliminarli in vista del packaging SEA su ARM. Nessuna nuova voce in `dependencies`.
- **Node.js ≥ 24**, API `node:sqlite` **sincrona** (`DatabaseSync`). Tutte le funzioni di `quiz-manager.js` sono sincrone.
- **`server/quiz-manager.js` è l'unico modulo che tocca `node:sqlite`.** Nessun altro file importa quel modulo.
- **`server/quiz-schema.js` resta puro**: nessun DB, nessuna rete, nessun filesystem.
- **`server/game.js` resta puro**: nessuna dipendenza da Express o Socket.io.
- **Nessun modulo diverso da `server/config.js` legge `process.env`.**
- **Formato REST unificato**: successo → `{ success: true, data: {...} }`, errore → `{ success: false, error: "messaggio" }`.
- **Nessun bundler.** I moduli condivisi usano il wrapper UMD già in uso (`client/shared/server-clock.js`), caricabili sia come `<script>` sia con `require()`.
- **Cross-platform**: il codice deve girare identico su Windows (sviluppo) e Linux/ARM (produzione). Nessun percorso hardcodato con separatori di piattaforma — sempre `path.join`.
- **Valori esatti dalla spec**: lato lungo max **1280 px**; tetto **153.600 byte** (150 KiB); scala di qualità **0.80 → 0.72 → 0.65 → 0.58** con pavimento a 0.58; input accettato fino a **26.214.400 byte** (25 MiB); limite del body server **400 KiB**.
- **I commit li fa l'utente.** Ogni task termina con `git add` dei file toccati e un messaggio di commit *suggerito*. **Non eseguire `git commit`.**
- **Test**: nessun framework. Script standalone in `tools/`, con `assert()` locale che stampa ✅/❌ e imposta `process.exitCode`.
- **Tutto gira su HTTP semplice, senza TLS**, e `http://192.168.x.x` **non è un secure context** (a differenza di `http://localhost`). Verificato il 2026-08-29 sull'origine LAN reale: `createImageBitmap`, `canvas.toBlob`, `File`/`Blob`/`FileReader`, `fetch` e `OffscreenCanvas` sono **tutti disponibili**; `navigator.mediaDevices` e `navigator.clipboard` **no**. Vedi §11 della spec. **Non introdurre dipendenze da API gated su secure context**: funzionerebbero in sviluppo su localhost e fallirebbero in sala.

---

## File Structure

| File | Responsabilità |
|---|---|
| `client/shared/image-budget.js` *(nuovo)* | Decisioni pure sulla compressione: dimensioni target, scala di qualità, forma dell'hash. Nessun DOM, nessuna rete. |
| `tools/test-image.js` *(nuovo)* | Test del modulo puro sopra. |
| `server/db/schema.sql` | Tabella `quiz_images`. |
| `server/quiz-manager.js` | `putImage`, `getImage`, `gcOrphanImages`; chiamata alla raccolta in `initDb()`. |
| `server/quiz-schema.js` | Validazione della forma di `image` su ogni domanda. |
| `server/game.js` | `image` nell'allowlist di `getCurrentRound()`. |
| `server/routes/host.js` | `POST /api/host/quiz-image` (autenticato). |
| `server/index.js` | `GET /api/quiz-image/:hash` (pubblico); l'error handler globale onora `err.status`. |
| `client/sala/app.js` | `renderQuestionMedia` sulla verità del valore; classe blur. |
| `client/sala/style.css` | Correzione del ritaglio; classe blur; `pointer-events: none`. |
| `client/host/{app.js,index.html,style.css}` | Caricamento, anteprima, toggle, rimozione. |

**Non toccato: `client/player/`.** Decisione di prodotto documentata nella spec.

---

## Task 1: Il modulo puro delle decisioni di compressione

**Files:**
- Create: `client/shared/image-budget.js`
- Create: `tools/test-image.js`
- Modify: `package.json` (script `test:image`)

**Interfaces:**
- Consumes: niente (è il primo task).
- Produces: `window.ImageBudget` / `module.exports` con
  `MAX_LONG_SIDE: number`, `MAX_BYTES: number`, `MAX_INPUT_BYTES: number`,
  `QUALITY_LADDER: number[]`, `targetDimensions(width, height, maxLongSide?) -> { width, height }`,
  `nextQuality(current) -> number | null`, `isValidHash(value) -> boolean`.
  Usati da Task 7 (tutto) e replicati lato server in Task 3 (solo la regex dell'hash, vedi nota).

> **Nota sulla duplicazione della regex dell'hash.** `client/shared/` è servito ai browser, `server/quiz-schema.js` deve restare puro e senza dipendenze da `client/`. La regex `^[0-9a-f]{64}$` compare quindi in due punti. È una duplicazione accettata e va **commentata in entrambi**: sono due lati di uno stesso contratto, non due copie da tenere sincronizzate a mano per distrazione.

- [ ] **Step 1: Scrivere il test che fallisce**

Creare `tools/test-image.js`:

```js
#!/usr/bin/env node
'use strict';

/**
 * tools/test-image.js
 *
 * Smoke test di client/shared/image-budget.js — le decisioni pure del
 * comparto immagini: quali dimensioni target, quale qualità provare dopo,
 * com'è fatto un hash valido.
 *
 * Puro: nessun DOM, nessuna rete, nessun DB. La pipeline canvas vera
 * (createImageBitmap/toBlob) richiede un browser e non è coperta qui —
 * stesso confine fra audio-logic.js e audio.js.
 */

const path = require('node:path');

const ImageBudget = require(path.join(__dirname, '..', 'client', 'shared', 'image-budget'));

// ─── Setup ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}`);
    failed++;
  }
}

function assertThrows(fn, label) {
  try {
    fn();
    console.error(`  ❌  ${label} (nessuna eccezione lanciata)`);
    failed++;
  } catch {
    console.log(`  ✅  ${label}`);
    passed++;
  }
}

// ─── targetDimensions ────────────────────────────────────────────────────────

console.log('\n── image-budget: dimensioni target ──\n');

const orizzontale = ImageBudget.targetDimensions(1920, 1080);
assert(orizzontale.width === 1280 && orizzontale.height === 720, '1920x1080 → 1280x720');

const verticale = ImageBudget.targetDimensions(1080, 1920);
assert(verticale.width === 720 && verticale.height === 1280, '1080x1920 → 720x1280 (il verticale non viene ruotato né ritagliato)');

const quadrata = ImageBudget.targetDimensions(2000, 2000);
assert(quadrata.width === 1280 && quadrata.height === 1280, '2000x2000 → 1280x1280');

const piccola = ImageBudget.targetDimensions(640, 480);
assert(piccola.width === 640 && piccola.height === 480, "640x480 resta 640x480: un'immagine piccola non va ingrandita");

const alLimite = ImageBudget.targetDimensions(1280, 800);
assert(alLimite.width === 1280 && alLimite.height === 800, '1280x800 resta invariata (esattamente al limite)');

const panoramica = ImageBudget.targetDimensions(3000, 1000);
assert(panoramica.width === 1280 && panoramica.height === 427, "3000x1000 → 1280x427 (arrotondamento all'intero)");

const custom = ImageBudget.targetDimensions(1000, 500, 400);
assert(custom.width === 400 && custom.height === 200, 'maxLongSide esplicito rispettato');

assertThrows(() => ImageBudget.targetDimensions(0, 100), 'larghezza 0 rifiutata');
assertThrows(() => ImageBudget.targetDimensions(100, -5), 'altezza negativa rifiutata');
assertThrows(() => ImageBudget.targetDimensions('100', 100), 'larghezza non numerica rifiutata');

// ─── nextQuality ─────────────────────────────────────────────────────────────

console.log('\n── image-budget: scala di qualità ──\n');

assert(ImageBudget.QUALITY_LADDER[0] === 0.80, 'la scala parte da 0.80');
assert(ImageBudget.nextQuality(0.80) === 0.72, '0.80 → 0.72');
assert(ImageBudget.nextQuality(0.72) === 0.65, '0.72 → 0.65');
assert(ImageBudget.nextQuality(0.65) === 0.58, '0.65 → 0.58');
assert(ImageBudget.nextQuality(0.58) === null, '0.58 è il pavimento: sotto non si scende');
assert(ImageBudget.nextQuality(1) === 0.80, 'un valore sopra la scala entra dal primo gradino');
assert(ImageBudget.nextQuality(0.30) === null, 'un valore sotto il pavimento non risale');

// ─── isValidHash ─────────────────────────────────────────────────────────────

console.log("\n── image-budget: forma dell'hash ──\n");

const valido = 'a'.repeat(64);
assert(ImageBudget.isValidHash(valido) === true, '64 caratteri esadecimali minuscoli accettati');
assert(ImageBudget.isValidHash('a'.repeat(63)) === false, '63 caratteri rifiutati');
assert(ImageBudget.isValidHash('a'.repeat(65)) === false, '65 caratteri rifiutati');
assert(ImageBudget.isValidHash('A'.repeat(64)) === false, 'maiuscole rifiutate (una sola forma canonica)');
assert(ImageBudget.isValidHash('g'.repeat(64)) === false, 'caratteri non esadecimali rifiutati');
assert(ImageBudget.isValidHash('../../etc/passwd') === false, 'un percorso non è un hash');
assert(ImageBudget.isValidHash(null) === false, 'null rifiutato');
assert(ImageBudget.isValidHash(undefined) === false, 'undefined rifiutato');
assert(ImageBudget.isValidHash(12345) === false, 'un numero rifiutato');

// ─── Limiti ──────────────────────────────────────────────────────────────────

console.log('\n── image-budget: limiti dichiarati ──\n');

assert(ImageBudget.MAX_LONG_SIDE === 1280, 'lato lungo massimo: 1280 px');
assert(ImageBudget.MAX_BYTES === 153600, 'tetto per immagine: 153.600 byte');
assert(ImageBudget.MAX_INPUT_BYTES === 26214400, 'input accettato: 26.214.400 byte');

// ─── Referto ─────────────────────────────────────────────────────────────────

console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passati, ${failed} falliti\n`);
process.exitCode = failed === 0 ? 0 : 1;
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

```bash
node tools/test-image.js
```

Atteso: crash con `Cannot find module ... image-budget`. Il modulo non esiste ancora.

- [ ] **Step 3: Scrivere il modulo**

Creare `client/shared/image-budget.js`:

```js
'use strict';

/**
 * client/shared/image-budget.js
 *
 * Le decisioni PURE del comparto immagini: quanto grande, quanto compressa,
 * com'è fatto un riferimento valido. Nessun DOM, nessuna rete, nessun canvas.
 *
 * La divisione ricalca quella fra `audio-logic.js` e `audio.js`: qui le regole,
 * in `client/host/app.js` il motore che tocca file, canvas e fetch. Così le
 * regole si testano in Node senza un browser (`tools/test-image.js`).
 *
 * Perché la compressione avviene nel browser e non sul server: il progetto ha
 * scelto `node:sqlite` proprio per non avere moduli nativi da compilare in vista
 * del packaging SEA su ARM, e `sharp` li rimetterebbe in gioco. Il ridimensiona-
 * mento lo fa il tablet di chi crea il quiz, in un momento tranquillo, non il
 * Raspberry davanti a una sala.
 *
 * Caricato come <script> dal pannello host (espone window.ImageBudget) e come
 * modulo CommonJS dai test.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ImageBudget = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Lato lungo massimo dell'immagine stoccata.
   *
   * `.q-card-wrap` in sala è `max-width: 48rem` = 768px CSS, e il proiettore
   * è 1080p a 1×: 768 pixel fisici. 1280 è già margine abbondante, e costa
   * poco perché WebP comprime bene le fotografie.
   */
  const MAX_LONG_SIDE = 1280;

  /** Tetto per immagine: 150 KiB. 20 domande illustrate ≈ 3MB per quiz. */
  const MAX_BYTES = 153600;

  /**
   * Input accettato: 25 MiB. Volutamente generoso — l'host non deve sentirsi
   * limitato, e una foto da telefono ci sta comodamente sotto.
   */
  const MAX_INPUT_BYTES = 26214400;

  /**
   * Qualità WebP da provare, in ordine.
   *
   * Si scende solo se il file supera MAX_BYTES. Sotto 0.58 NON si scende: si
   * accetta un file più grande piuttosto che proiettare artefatti su un muro.
   */
  const QUALITY_LADDER = [0.80, 0.72, 0.65, 0.58];

  /**
   * Un riferimento a immagine è l'esadecimale minuscolo di uno SHA-256.
   *
   * NOTA: questa regex esiste anche in `server/quiz-schema.js`. È deliberato:
   * quel modulo deve restare puro e senza dipendenze da `client/`, e questo
   * file è servito ai browser. Sono i due lati dello stesso contratto — se
   * cambia uno, cambia l'altro.
   */
  const HASH_RE = /^[0-9a-f]{64}$/;

  /**
   * Dimensioni a cui ridimensionare, preservando il rapporto.
   *
   * Non ritaglia MAI e non ingrandisce mai: un'immagine già sotto il limite
   * torna identica. Ritagliare per far combaciare il 16:9 del riquadro
   * significherebbe decidere noi quale parte della foto conta; ci pensa invece
   * `object-fit: contain` in sala a farla stare intera.
   *
   * @param {number} width
   * @param {number} height
   * @param {number} [maxLongSide]
   * @returns {{ width: number, height: number }}
   */
  function targetDimensions(width, height, maxLongSide = MAX_LONG_SIDE) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new RangeError('targetDimensions: larghezza e altezza devono essere numeri positivi.');
    }

    const longSide = Math.max(width, height);
    if (longSide <= maxLongSide) {
      return { width: Math.round(width), height: Math.round(height) };
    }

    const factor = maxLongSide / longSide;
    return {
      width:  Math.max(1, Math.round(width * factor)),
      height: Math.max(1, Math.round(height * factor)),
    };
  }

  /**
   * Il gradino di qualità successivo, o null se siamo al pavimento.
   *
   * Definita come "il primo valore della scala strettamente minore di
   * `current`" invece che "l'elemento dopo di me": così un valore che non
   * appartiene alla scala (1, o un residuo di una versione precedente) entra
   * comunque dal gradino giusto invece di non trovarsi.
   *
   * @param {number} current
   * @returns {number | null}
   */
  function nextQuality(current) {
    for (const q of QUALITY_LADDER) {
      if (q < current) return q;
    }
    return null;
  }

  /**
   * @param {unknown} value
   * @returns {boolean}
   */
  function isValidHash(value) {
    return typeof value === 'string' && HASH_RE.test(value);
  }

  return {
    MAX_LONG_SIDE,
    MAX_BYTES,
    MAX_INPUT_BYTES,
    QUALITY_LADDER,
    targetDimensions,
    nextQuality,
    isValidHash,
  };
});
```

- [ ] **Step 4: Eseguire il test e verificare che passi**

```bash
node tools/test-image.js
```

Atteso: tutti ✅, `0 falliti`.

- [ ] **Step 5: Registrare lo script npm**

In `package.json`, dentro `"scripts"`, dopo `"test:clock"`:

```json
    "test:image": "node tools/test-image.js",
```

- [ ] **Step 6: Verificare lo script**

```bash
npm run test:image
```

Atteso: stesso referto dello Step 4.

- [ ] **Step 7: Mettere in stage**

```bash
git add client/shared/image-budget.js tools/test-image.js package.json
```

Commit suggerito (**da fare all'utente**): `feat(immagini): decisioni pure di ridimensionamento e compressione`

---

## Task 2: La tabella, il layer dati e la raccolta degli orfani

**Files:**
- Modify: `server/db/schema.sql`
- Modify: `server/quiz-manager.js`
- Modify: `tools/test-db.js`

**Interfaces:**
- Consumes: niente da Task 1 (il server non carica `image-budget.js`).
- Produces:
  - `putImage(bytes, mime, width, height) -> { hash: string, width: number, height: number }` — `bytes` è un `Buffer`/`Uint8Array`. Idempotente: gli stessi byte producono lo stesso hash e non duplicano la riga.
  - `getImage(hash) -> { hash, mime, bytes: Uint8Array, width, height, created_at } | null`
  - `gcOrphanImages() -> number` — quante righe ha eliminato.
  Usati da Task 4 (`putImage`) e Task 5 (`getImage`).

- [ ] **Step 1: Scrivere i test che falliscono**

In `tools/test-db.js`, aggiungere `putImage`, `getImage`, `gcOrphanImages`, `getDb` alla destrutturazione dell'import da `../server/quiz-manager` (righe 17-31), poi appendere in fondo al file — **prima** del referto finale e della chiusura del DB:

```js
// ─── Immagini ────────────────────────────────────────────────────────────────

console.log('\n── quiz_images: stoccaggio indirizzato dal contenuto ──\n');

const bytesA = Buffer.from('RIFF____WEBPfinta-immagine-A', 'ascii');
const bytesB = Buffer.from('RIFF____WEBPfinta-immagine-B', 'ascii');

const salvataA = putImage(bytesA, 'image/webp', 1280, 720);
assert(typeof salvataA.hash === 'string' && salvataA.hash.length === 64, 'putImage restituisce un hash di 64 caratteri');
assert(salvataA.width === 1280 && salvataA.height === 720, 'putImage restituisce le dimensioni ricevute');

const riletta = getImage(salvataA.hash);
assert(riletta !== null, 'getImage ritrova la riga appena scritta');
assert(Buffer.from(riletta.bytes).equals(bytesA), 'i byte riletti sono identici a quelli scritti');
assert(riletta.mime === 'image/webp', 'il mime viene conservato');
assert(riletta.width === 1280 && riletta.height === 720, 'le dimensioni vengono conservate');

assert(getImage('f'.repeat(64)) === null, 'getImage su un hash inesistente restituisce null');

// Deduplicazione: gli stessi byte non creano una seconda riga.
const conteggioImmagini = () =>
  getDb().prepare('SELECT COUNT(*) AS n FROM quiz_images').get().n;

const salvataBis = putImage(bytesA, 'image/webp', 1280, 720);
assert(salvataBis.hash === salvataA.hash, 'gli stessi byte producono lo stesso hash');
assert(conteggioImmagini() === 1, 'gli stessi byte non duplicano la riga');

// ─── Raccolta degli orfani ───────────────────────────────────────────────────

console.log('\n── quiz_images: raccolta degli orfani ──\n');

const salvataB = putImage(bytesB, 'image/webp', 800, 600);
assert(conteggioImmagini() === 2, 'due immagini distinte, due righe');

// Un quiz che referenzia SOLO la prima immagine.
const utenteImg = createUser(`img_${Date.now()}`, 'hash-finto-non-usato-per-il-login');
createQuiz(utenteImg.id, 'Quiz con immagine', [
  {
    text: 'Che animale è questo?',
    options: ['A', 'B'],
    correct_index: 0,
    time_limit_s: 20,
    image: { hash: salvataA.hash, blur: false },
  },
]);

const eliminate = gcOrphanImages();
assert(eliminate === 1, "la raccolta elimina esattamente l'immagine orfana");
assert(getImage(salvataA.hash) !== null, "l'immagine referenziata da un quiz sopravvive");
assert(getImage(salvataB.hash) === null, "l'immagine che nessuno referenzia sparisce");

assert(gcOrphanImages() === 0, 'la raccolta è idempotente: la seconda passata non elimina nulla');
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

```bash
node tools/test-db.js
```

Atteso: crash su `putImage is not a function`.

- [ ] **Step 3: Aggiungere la tabella allo schema**

In `server/db/schema.sql`, in fondo al file:

```sql
-- ─── Tabella: quiz_images ───────────────────────────────────────────────────────
-- Immagini delle domande, indirizzate dal CONTENUTO.
--
-- La chiave primaria e lo SHA-256 esadecimale dei byte stoccati, non un id
-- progressivo. Tre conseguenze volute:
--   1. la stessa foto usata in due quiz occupa una riga sola;
--   2. l URL /api/quiz-image/<hash> non puo mai servire byte diversi, quindi e
--      cacheabile come "immutable" e ogni dispositivo la scarica una volta sola;
--   3. un client non puo inventarsi un hash: lo calcola il server dai byte.
--
-- I byte sono WebP gia ridimensionato e compresso dal browser dell host (lato
-- lungo <= 1280px, <= 153.600 byte). Il server non ricomprime: farlo
-- richiederebbe un modulo nativo, escluso dal vincolo di packaging SEA su ARM.
--
-- NESSUNA foreign key verso le domande: una domanda vive dentro il JSON della
-- colonna `questions`, non in una tabella. Il legame lo ricostruisce
-- gcOrphanImages() in quiz-manager.js, che gira ad ogni avvio.
CREATE TABLE IF NOT EXISTS quiz_images (
    hash        TEXT    PRIMARY KEY,          -- SHA-256 esadecimale minuscolo dei byte
    mime        TEXT    NOT NULL,
    bytes       BLOB    NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: Scrivere il layer dati**

In `server/quiz-manager.js`:

**(a)** In cima, accanto agli altri import di Node:

```js
const { createHash } = require('node:crypto');
```

**(b)** In `initDb()`, subito **dopo** `syncPreloadedQuizzes();`:

```js
  // Raccolta degli orfani: le immagini sono condivise fra domande e fra quiz,
  // quindi cancellare una domanda non può cancellare il blob — potrebbe servire
  // altrove. Si ricalcola qui, all'avvio, quali hash sono ancora referenziati.
  //
  // Un refcount sarebbe più efficiente e più fragile: un contatore va aggiornato
  // da ogni percorso che tocca una domanda, e basta dimenticarne uno perché
  // diventi bugiardo in silenzio. Questa scansione ricalcola la verità invece di
  // ricordarla, e su un DB di questa taglia costa millisecondi.
  const orfane = gcOrphanImages();
  if (orfane > 0) {
    console.log(`[img] raccolta orfani: ${orfane} immagini eliminate.`);
  }
```

**(c)** Una nuova sezione prima di `// ─── Exports ───`:

```js
// ─── Immagini delle domande ──────────────────────────────────────────────────

/**
 * Stocca i byte di un'immagine, indirizzata dal proprio contenuto.
 *
 * L'hash lo calcola SEMPRE il server dai byte ricevuti: un client non ha modo
 * di far entrare un riferimento che non corrisponda a ciò che ha caricato.
 *
 * Idempotente: ricaricare la stessa immagine non crea una seconda riga.
 * `INSERT OR IGNORE` invece di un SELECT preventivo perché la chiave primaria
 * fa già il lavoro, e in una riga sola.
 *
 * @param {Buffer|Uint8Array} bytes byte già compressi (WebP)
 * @param {string} mime
 * @param {number} width
 * @param {number} height
 * @returns {{ hash: string, width: number, height: number }}
 */
function putImage(bytes, mime, width, height) {
  const database = getDb();
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const hash = createHash('sha256').update(buffer).digest('hex');

  database
    .prepare('INSERT OR IGNORE INTO quiz_images (hash, mime, bytes, width, height) VALUES (?, ?, ?, ?, ?)')
    .run(hash, mime, buffer, width, height);

  return { hash, width, height };
}

/**
 * @param {string} hash
 * @returns {{ hash: string, mime: string, bytes: Uint8Array, width: number, height: number, created_at: string } | null}
 */
function getImage(hash) {
  const database = getDb();
  const row = database
    .prepare('SELECT hash, mime, bytes, width, height, created_at FROM quiz_images WHERE hash = ?')
    .get(hash);
  return row ?? null;
}

/**
 * Tutti gli hash referenziati da almeno una domanda, in entrambe le tabelle.
 *
 * Le domande vivono dentro un JSON serializzato, quindi non c'è una JOIN da
 * fare: si legge e si scandisce. Un `questions` illeggibile viene saltato senza
 * far fallire la raccolta — se quel quiz è rotto lo dirà chi lo carica, e
 * intanto è più prudente NON considerare orfane le sue immagini.
 *
 * @param {import('node:sqlite').DatabaseSync} database
 * @returns {Set<string>}
 */
function collectReferencedImageHashes(database) {
  const referenced = new Set();

  for (const table of ['quizzes', 'preloaded_quizzes']) {
    for (const row of database.prepare(`SELECT questions FROM ${table}`).all()) {
      let questions;
      try {
        questions = JSON.parse(row.questions);
      } catch {
        continue;
      }
      if (!Array.isArray(questions)) continue;

      for (const q of questions) {
        const hash = q?.image?.hash;
        if (typeof hash === 'string') referenced.add(hash);
      }
    }
  }

  return referenced;
}

/**
 * Elimina le immagini che nessuna domanda referenzia più.
 *
 * Idempotente: eseguirla due volte di fila non cambia niente, come lo
 * `syncPreloadedQuizzes` accanto a cui gira.
 *
 * @returns {number} righe eliminate
 */
function gcOrphanImages() {
  const database = getDb();
  const referenced = collectReferencedImageHashes(database);

  if (referenced.size === 0) {
    // Nessuna domanda referenzia niente: sono orfane tutte.
    return database.prepare('DELETE FROM quiz_images').run().changes;
  }

  const placeholders = Array.from(referenced, () => '?').join(', ');
  return database
    .prepare(`DELETE FROM quiz_images WHERE hash NOT IN (${placeholders})`)
    .run(...referenced).changes;
}
```

**(d)** In `module.exports`, dopo il blocco `// Preloaded Quizzes (sola lettura)`:

```js
  // Immagini delle domande
  putImage,
  getImage,
  gcOrphanImages,
```

- [ ] **Step 5: Eseguire il test e verificare che passi**

```bash
node tools/test-db.js
```

Atteso: tutti ✅ compresi i nuovi. Se fallisce con "no such table: quiz_images", il DB di test preesistente non ha la tabella nuova: cancellare `server/db/test_smoke.sqlite` e rieseguire (lo schema si applica al boot).

- [ ] **Step 6: Verificare che il server parta e migri il DB reale**

```bash
npm start
```

Atteso: avvio senza errori. Il DB esistente riceve `quiz_images` da `CREATE TABLE IF NOT EXISTS`; non c'è niente da raccogliere, quindi nessuna riga `[img]`. Fermare con Ctrl+C.

- [ ] **Step 7: Mettere in stage**

```bash
git add server/db/schema.sql server/quiz-manager.js tools/test-db.js
```

Commit suggerito: `feat(immagini): tabella quiz_images e raccolta degli orfani`

---

## Task 3: Il campo entra nel modello dati

**Files:**
- Modify: `server/quiz-schema.js`
- Modify: `server/game.js:348-360` (`getCurrentRound`)
- Modify: `tools/test-quizzes.js`
- Modify: `tools/test-game.js`

**Interfaces:**
- Consumes: niente.
- Produces:
  - `isValidImageHash(value) -> boolean` esportata da `server/quiz-schema.js`, usata da Task 5.
  - `validateQuiz` accetta/rifiuta `image` su ogni domanda.
  - `getCurrentRound()` include `image: { hash, blur } | null`, consumato da Task 6.

- [ ] **Step 1: Scrivere i test dello schema che falliscono**

In `tools/test-quizzes.js`, estendere l'import in cima:

```js
const { validateQuiz, MAX_QUESTIONS_PER_QUIZ, isValidImageHash } = require(path.join(__dirname, '..', 'server', 'quiz-schema'));
```

E appendere dopo i test di `validateQuiz` esistenti:

```js
// ─── Immagine sulla domanda ──────────────────────────────────────────────────

console.log('\n── quiz-schema: immagine sulla domanda ──\n');

const HASH_OK = 'a1b2c3d4'.repeat(8); // 64 caratteri esadecimali

const conImmagine = (image) => {
  const q = base();
  q.questions[0].image = image;
  return q;
};

assert(validateQuiz(base()) === null, 'una domanda senza chiave "image" resta valida');
assert(validateQuiz(conImmagine(null)) === null, '"image": null è valido (nessuna immagine)');
assert(validateQuiz(conImmagine({ hash: HASH_OK, blur: false })) === null, 'immagine ben formata accettata');
assert(validateQuiz(conImmagine({ hash: HASH_OK, blur: true })) === null, 'blur true accettato');

assert(validateQuiz(conImmagine({ hash: 'a'.repeat(63), blur: false })) !== null, 'hash di 63 caratteri rifiutato');
assert(validateQuiz(conImmagine({ hash: 'A'.repeat(64), blur: false })) !== null, 'hash maiuscolo rifiutato');
assert(validateQuiz(conImmagine({ hash: 'z'.repeat(64), blur: false })) !== null, 'hash non esadecimale rifiutato');
assert(validateQuiz(conImmagine({ hash: HASH_OK })) !== null, '"blur" mancante rifiutato');
assert(validateQuiz(conImmagine({ hash: HASH_OK, blur: 'sì' })) !== null, '"blur" non booleano rifiutato');
assert(validateQuiz(conImmagine({ blur: false })) !== null, '"hash" mancante rifiutato');
assert(validateQuiz(conImmagine({ hash: HASH_OK, blur: false, extra: 1 })) !== null, 'chiavi estranee rifiutate');
assert(validateQuiz(conImmagine('/api/quiz-image/x')) !== null, 'una stringa non è un oggetto immagine');
assert(validateQuiz(conImmagine([HASH_OK])) !== null, 'un array non è un oggetto immagine');

// isValidImageHash, esportata perché la usa anche la route pubblica.
assert(isValidImageHash(HASH_OK) === true, 'isValidImageHash accetta un hash valido');
assert(isValidImageHash('../../etc/passwd') === false, 'isValidImageHash rifiuta un percorso');
assert(isValidImageHash(null) === false, 'isValidImageHash rifiuta null');
```

- [ ] **Step 2: Eseguire e verificare che fallisca**

```bash
npm run test:quizzes
```

Atteso: `isValidImageHash is not a function`, oppure ❌ sui casi che ora passerebbero indebitamente.

- [ ] **Step 3: Estendere lo schema**

In `server/quiz-schema.js`:

**(a)** Sotto il blocco `// ─── Limiti ───`:

```js
/**
 * Un riferimento a immagine è l'esadecimale minuscolo di uno SHA-256.
 *
 * NOTA: la stessa regex vive in `client/shared/image-budget.js`. È deliberato —
 * questo modulo deve restare puro e senza dipendenze da `client/`, e quello è
 * servito ai browser. Sono i due lati dello stesso contratto.
 */
const IMAGE_HASH_RE = /^[0-9a-f]{64}$/;

/** Le uniche chiavi ammesse dentro `image`. */
const IMAGE_KEYS = ['hash', 'blur'];
```

**(b)** Dopo `validateQuiz`, le due funzioni ausiliarie:

```js
/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidImageHash(value) {
  return typeof value === 'string' && IMAGE_HASH_RE.test(value);
}

/**
 * Valida la forma di `image` su una domanda.
 *
 * Controlla la FORMA, non l'esistenza: che l'hash corrisponda a una riga di
 * `quiz_images` non si può sapere da qui, perché questo modulo è puro e non ha
 * un DB. Lo verifica chi ne ha uno — la route di salvataggio per i quiz
 * dell'editor, `quiz-library.js` per i file di sistema.
 *
 * Le chiavi estranee vengono rifiutate invece che ignorate: un `blurred: true`
 * scritto per errore al posto di `blur` deve dare un errore, non sparire in
 * silenzio lasciando un'immagine nitida davanti a una sala.
 *
 * @param {any} image
 * @param {number} num numero della domanda (1-based) per il messaggio
 * @returns {string | null}
 */
function validateQuestionImage(image, num) {
  if (image === undefined || image === null) return null;

  if (typeof image !== 'object' || Array.isArray(image)) {
    return `Domanda ${num}: "image" deve essere un oggetto { hash, blur } oppure null.`;
  }

  const extra = Object.keys(image).filter((k) => !IMAGE_KEYS.includes(k));
  if (extra.length > 0) {
    return `Domanda ${num}: "image" contiene chiavi non previste (${extra.join(', ')}).`;
  }

  if (!isValidImageHash(image.hash)) {
    return `Domanda ${num}: "image.hash" deve essere un SHA-256 esadecimale di 64 caratteri minuscoli.`;
  }

  if (typeof image.blur !== 'boolean') {
    return `Domanda ${num}: "image.blur" deve essere true o false.`;
  }

  return null;
}
```

**(c)** Dentro il ciclo `for` di `validateQuiz`, subito dopo il controllo su `time_limit_s`:

```js
    const imageError = validateQuestionImage(q.image, num);
    if (imageError) return imageError;
```

**(d)** In `module.exports`, aggiungere `isValidImageHash,`.

- [ ] **Step 4: Eseguire e verificare che passi**

```bash
npm run test:quizzes
```

Atteso: tutti ✅.

- [ ] **Step 5: Scrivere il test del round che fallisce**

In `tools/test-game.js`, appendere una sezione (la forma di `assert` e il nome di `GameSession` sono già quelli usati nel file):

```js
// ─── Immagine nel round ──────────────────────────────────────────────────────

console.log("\n── game: l'immagine arriva nel round ──\n");

const HASH_IMG = 'b'.repeat(64);

const quizConImmagine = {
  title: 'Quiz illustrato',
  questions: [
    {
      text: 'Che animale è questo?',
      options: ['A', 'B'],
      correct_index: 0,
      time_limit_s: 20,
      image: { hash: HASH_IMG, blur: true },
    },
    {
      text: 'Domanda senza immagine',
      options: ['A', 'B'],
      correct_index: 1,
      time_limit_s: 20,
    },
  ],
  minigames: [],
};

const sessioneImg = new GameSession(quizConImmagine);
sessioneImg.addPlayer('Tester', 'volpe');
sessioneImg.startGame();

const round0 = sessioneImg.getCurrentRound();
assert(round0.image !== null && round0.image !== undefined, 'il round porta il campo image');
assert(round0.image.hash === HASH_IMG, "l'hash arriva intatto");
assert(round0.image.blur === true, 'il flag blur arriva intatto');
assert(round0.correct_index === undefined, 'il round resta sanificato: nessun correct_index');

sessioneImg.endQuestion();
sessioneImg.nextQuestion();
const round1 = sessioneImg.getCurrentRound();
assert(round1.image === null, 'una domanda senza immagine espone image: null, non undefined');
```

- [ ] **Step 6: Eseguire e verificare che fallisca**

```bash
node tools/test-game.js
```

Atteso: ❌ su "il round porta il campo image" — `getCurrentRound` non lo espone.

- [ ] **Step 7: Aggiungere `image` all'allowlist**

In `server/game.js`, dentro `getCurrentRound()`, dopo `minigameType`:

```js
      // Un round minigioco non ha immagine: `r.image` è undefined e diventa
      // null, che è la stessa cosa che dice una domanda senza immagine.
      // Il campo arriva anche ai telefoni — sono ~90 byte, e non vale un emit
      // per-room — ma solo la vista sala lo disegna. Vedi la spec
      // docs/superpowers/specs/2026-08-29-immagini-domande-design.md.
      image: r.image ?? null,
```

- [ ] **Step 8: Eseguire e verificare che passi**

```bash
node tools/test-game.js
```

Atteso: tutti ✅.

- [ ] **Step 9: Mettere in stage**

```bash
git add server/quiz-schema.js server/game.js tools/test-quizzes.js tools/test-game.js
```

Commit suggerito: `feat(immagini): campo image nello schema quiz e nel round`

---

## Task 4: L'endpoint di caricamento

**Files:**
- Modify: `server/index.js:121-124` (error handler globale)
- Modify: `server/routes/host.js`

**Interfaces:**
- Consumes: `putImage` (Task 2).
- Produces: `POST /api/host/quiz-image?width=<int>&height=<int>` con body binario `image/webp` → `201 { success: true, data: { hash, width, height } }`. Consumato da Task 7.

> **Perché toccare l'error handler globale, e perché prima.** `express.raw({ limit })` rifiuta un body troppo grande lanciando un errore con `err.status = 413`. L'handler attuale (`server/index.js:121`) risponde 500 a qualunque errore, quindi un file oltre il limite arriverebbe al client come "errore interno" invece che "troppo grande" — e l'editor non potrebbe dire all'host cosa è successo. La modifica onora `err.status` quando c'è, e resta 500 quando non c'è.

- [ ] **Step 1: Rendere l'error handler capace di dire 413**

In `server/index.js`, sostituire il corpo dell'error handler globale:

```js
app.use((err, req, res, _next) => {
  // Gli errori dei body-parser (payload troppo grande, JSON malformato)
  // portano già uno status e un messaggio sensati: rispondere 500 li
  // trasformerebbe in "errore interno" e il client non saprebbe cosa correggere.
  const status = Number.isInteger(err?.status) ? err.status : 500;

  if (status >= 500) {
    console.error(`[Server] Errore non gestito su ${req.method} ${req.url}:`, err);
    return res.status(500).json({ success: false, error: 'Errore interno del server.' });
  }

  console.warn(`[Server] Richiesta rifiutata su ${req.method} ${req.url}: ${err.message}`);
  return res.status(status).json({ success: false, error: err.message });
});
```

- [ ] **Step 2: Scrivere la route**

In `server/routes/host.js`:

**(a)** In cima, accanto agli altri import:

```js
const express = require('express');
```

> **Non** importare `createHash` qui. L'hash lo calcola `putImage`: il layer dati è l'unico posto che decide come si chiama un'immagine, e duplicare quel calcolo nella route aprirebbe la porta a due nomi diversi per gli stessi byte.

**(b)** Aggiungere `putImage` alla destrutturazione da `../quiz-manager`.

**(c)** Sotto le costanti in cima al file:

```js
/**
 * Tetto del body accettato dall'endpoint di caricamento.
 *
 * Più alto del tetto che il client si impone (153.600 byte, in
 * client/shared/image-budget.js): la compressione lato browser è
 * un'OTTIMIZZAZIONE, non un controllo di sicurezza, e questo margine copre un
 * client vecchio o una foto che non si comprime bene senza aprire la porta a
 * un upload arbitrario.
 */
const MAX_IMAGE_UPLOAD_BYTES = 400 * 1024;

/** Limite di sanità sulle dimensioni dichiarate. */
const MAX_IMAGE_SIDE = 4096;

/**
 * I primi dodici byte di un file WebP: "RIFF", quattro byte di lunghezza,
 * "WEBP". Un header `Content-Type` è un'affermazione del client; questi no.
 */
function isWebpBuffer(buf) {
  return Buffer.isBuffer(buf)
    && buf.length >= 12
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP';
}
```

**(d)** La route, accanto alle altre route dei quiz:

```js
/**
 * Carica l'immagine di una domanda.
 *
 * Body: byte WebP grezzi (Content-Type: image/webp), già ridimensionati e
 * compressi dal browser dell'host.
 * Query: width, height — le dimensioni reali dell'immagine compressa.
 * Risposta: { success: true, data: { hash, width, height } }
 *
 * Il server NON ricomprime: servirebbe un modulo nativo, escluso dal vincolo di
 * packaging SEA su ARM. Ma non si fida nemmeno: verifica taglia, magic bytes e
 * dimensioni, e calcola lui l'hash dai byte ricevuti — un riferimento che il
 * client si fosse inventato non ha modo di entrare nel DB.
 */
router.post(
  '/quiz-image',
  verifyToken,
  express.raw({ type: 'image/webp', limit: MAX_IMAGE_UPLOAD_BYTES }),
  (req, res) => {
    try {
      const bytes = req.body;

      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        return sendError(res, 400, 'Corpo della richiesta vuoto. Attesi byte WebP con Content-Type: image/webp.');
      }

      if (!isWebpBuffer(bytes)) {
        return sendError(res, 415, "Il file caricato non è un'immagine WebP.");
      }

      const width  = Number.parseInt(req.query.width, 10);
      const height = Number.parseInt(req.query.height, 10);
      const validSide = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_IMAGE_SIDE;

      if (!validSide(width) || !validSide(height)) {
        return sendError(res, 400, `Dimensioni mancanti o fuori range (1-${MAX_IMAGE_SIDE}).`);
      }

      const saved = putImage(bytes, 'image/webp', width, height);
      return res.status(201).json({ success: true, data: saved });
    } catch (err) {
      console.error('[host/quiz-image]', err);
      return sendError(res, 500, 'Errore interno del server.');
    }
  }
);
```

- [ ] **Step 3: Verificare a mano che rifiuti ciò che deve rifiutare**

Avviare il server (`npm run dev`). Serve un token host: se non esiste un account, crearlo con `node tools/create-host.js`, poi ottenerlo con il login.

```bash
curl -s -X POST http://localhost:3000/api/host/login -H "Content-Type: application/json" -d "{\"username\":\"<utente>\",\"password\":\"<password>\"}"
```

Senza token (atteso: 401):

```bash
curl -s -w "\n%{http_code}\n" -X POST "http://localhost:3000/api/host/quiz-image?width=10&height=10" -H "Content-Type: image/webp" --data-binary "RIFF____WEBPxx"
```

Con token ma non-WebP (atteso: 415):

```bash
curl -s -w "\n%{http_code}\n" -X POST "http://localhost:3000/api/host/quiz-image?width=10&height=10" -H "Authorization: Bearer <token>" -H "Content-Type: image/webp" --data-binary "questo-non-e-un-webp"
```

Con token e finto-WebP valido (atteso: 201 e un hash di 64 caratteri — **annotarlo**, serve in Task 5):

```bash
curl -s -w "\n%{http_code}\n" -X POST "http://localhost:3000/api/host/quiz-image?width=10&height=10" -H "Authorization: Bearer <token>" -H "Content-Type: image/webp" --data-binary "RIFF____WEBPcontenuto-di-prova"
```

Dimensioni assurde (atteso: 400):

```bash
curl -s -w "\n%{http_code}\n" -X POST "http://localhost:3000/api/host/quiz-image?width=99999&height=10" -H "Authorization: Bearer <token>" -H "Content-Type: image/webp" --data-binary "RIFF____WEBPcontenuto-di-prova"
```

- [ ] **Step 4: Verificare che il 413 arrivi come 413**

Generare un file oltre il limite:

```bash
node -e "require('node:fs').writeFileSync(process.argv[1], Buffer.concat([Buffer.from('RIFF____WEBP'), Buffer.alloc(500*1024)]))" "grosso.webp"
```

```bash
curl -s -w "\n%{http_code}\n" -X POST "http://localhost:3000/api/host/quiz-image?width=10&height=10" -H "Authorization: Bearer <token>" -H "Content-Type: image/webp" --data-binary "@grosso.webp"
```

Atteso: `413` e un JSON `{ success: false, error: ... }`, **non** 500. Se arriva 500, lo Step 1 non è stato applicato.

Poi cancellare il file di prova:

```bash
node -e "require('node:fs').rmSync('grosso.webp', { force: true })"
```

- [ ] **Step 5: Verificare la raccolta sul DB reale**

Le righe inserite dai curl non sono referenziate da nessun quiz. Riavviare il server: deve comparire `[img] raccolta orfani: N immagini eliminate.` È anche la prova che la raccolta di Task 2 funziona fuori dai test.

- [ ] **Step 6: Mettere in stage**

```bash
git add server/routes/host.js server/index.js
```

Commit suggerito: `feat(immagini): endpoint autenticato di caricamento`

---

## Task 5: L'endpoint pubblico che serve i byte

**Files:**
- Modify: `server/index.js` (dopo `/api/health`, **prima** del fallback `/api/*`)

**Interfaces:**
- Consumes: `getImage` (Task 2), `isValidImageHash` (Task 3).
- Produces: `GET /api/quiz-image/:hash` → i byte con `Cache-Control: immutable`. Consumato da Task 6 e Task 7.

- [ ] **Step 1: Aggiungere l'import**

In `server/index.js`, accanto agli altri require:

```js
const { isValidImageHash } = require('./quiz-schema');
```

Il modulo `quiz-manager` è già importato in questo file: usare il nome della costante già presente (nel codice attuale è `db`) invece di aggiungerne un secondo.

- [ ] **Step 2: Scrivere la route**

Subito **dopo** il blocco `/api/health` e **prima** di `app.use('/api/*', ...)`:

```js
// ─── Immagini delle domande ───────────────────────────────────────────────────
// PUBBLICA, senza autenticazione, per la stessa ragione di /api/join-info: la
// vista sala non ha un token e non può averne uno. Chi è sull'access point e
// conosce l'hash scarica l'immagine — che è comunque destinata a finire
// proiettata su un muro davanti a tutta la stanza. L'hash è a 256 bit e non si
// indovina. È una scelta dichiarata nella spec, non una dimenticanza.
//
// DEVE stare prima del fallback /api/* → 404, altrimenti risponderebbe HTML.
app.get('/api/quiz-image/:hash', (req, res) => {
  const { hash } = req.params;

  // L'hash finisce in una query parametrizzata, quindi non c'è iniezione da
  // temere: il controllo serve a rispondere 400 invece di 404 a una richiesta
  // palesemente malformata, e a non interrogare il DB per niente.
  if (!isValidImageHash(hash)) {
    return res.status(400).json({ success: false, error: 'Hash non valido.' });
  }

  const image = db.getImage(hash);
  if (!image) {
    return res.status(404).json({ success: false, error: 'Immagine non trovata.' });
  }

  // `immutable` non è ottimismo: l'URL contiene l'hash del proprio contenuto,
  // quindi per costruzione non può mai servire byte diversi. Ogni dispositivo
  // scarica un'immagine una volta sola per tutta la serata, anche se l'host
  // rigioca la stessa partita.
  res.set({
    'Content-Type':  image.mime,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag':          `"${hash}"`,
  });

  return res.send(Buffer.from(image.bytes));
});
```

- [ ] **Step 3: Verificare a mano**

Avviare il server e ricaricare un'immagine di prova (il POST di Task 4, Step 3), perché la raccolta ha cancellato le precedenti. Usare l'hash restituito.

```bash
curl -s -D - -o NUL -w "\n%{http_code}\n" "http://localhost:3000/api/quiz-image/<hash>"
```

Atteso negli header: `Content-Type: image/webp`, `Cache-Control: public, max-age=31536000, immutable`, `ETag`. Status `200`.

Hash inesistente ma ben formato (atteso 404 JSON):

```bash
curl -s -w "\n%{http_code}\n" "http://localhost:3000/api/quiz-image/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
```

Hash malformato (atteso 400 JSON, **non** HTML — se arriva HTML, la route è finita dopo il fallback `/api/*`):

```bash
curl -s -w "\n%{http_code}\n" "http://localhost:3000/api/quiz-image/non-un-hash"
```

- [ ] **Step 4: Verificare il 304**

```bash
curl -s -w "\n%{http_code}\n" -o NUL -H "If-None-Match: \"<hash>\"" "http://localhost:3000/api/quiz-image/<hash>"
```

Atteso: `304`. È Express a gestirlo dall'`ETag`; se arriva 200, l'ETag non è impostato correttamente.

- [ ] **Step 5: Mettere in stage**

```bash
git add server/index.js
```

Commit suggerito: `feat(immagini): endpoint pubblico con cache immutable`

---

## Task 6: La vista sala disegna l'immagine

**Files:**
- Modify: `client/sala/style.css:438-458`
- Modify: `client/sala/app.js:252-291` (`renderQuestionMedia` e il commento sopra)

**Interfaces:**
- Consumes: `round.image` da `game:question` (Task 3), `GET /api/quiz-image/:hash` (Task 5).
- Produces: niente per i task successivi.

> Questo task contiene anche la **correzione del ritaglio** descritta nella §5 della spec. Non è un extra: senza, ogni immagine caricata verrebbe tagliata e la promessa "nessun ritaglio, mai" sarebbe falsa.

- [ ] **Step 1: Correggere il CSS del riquadro**

In `client/sala/style.css`, sostituire i blocchi `.q-media` e `.q-media img`:

```css
/* Variante CON immagine.
   `position: relative` non è decorativo: senza, l'<img> figlia non ha un
   contenitore contro cui risolvere `inset: 0` — vedi il commento sotto. */
.q-media {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  /* Il 16:9 vale finché c'è spazio: oltre, l'altezza vince sul rapporto e
     l'immagine si adatta con object-fit invece di sfondare il layout. */
  max-height: 34vh;
  margin: 1rem 0 0;
  border: 4px dashed var(--retro-dark);
  border-radius: var(--radius-lg);
  background: rgba(216, 218, 220, 0.3);
  display: grid;
  place-items: center;
  overflow: hidden;
}

/* L'immagine è posizionata in modo ASSOLUTO, non dimensionata in percentuale.
   Con `width/height: 100%` su un figlio di questa griglia, il 100% in altezza
   si misura contro la TRACCIA DI RIGA e non contro il `max-height` del
   contenitore: degrada ad `auto`, l'immagine tiene il proprio rapporto alla
   larghezza piena, sfonda in altezza e `overflow: hidden` la ritaglia.
   Misurato: un'immagine 1254x1254 diventava 696x696 in un riquadro alto 187px.
   Con `inset: 0` il riquadro è il riferimento, e `object-fit: contain` può
   finalmente fare il suo lavoro.

   `pointer-events: none` è deliberato: in sala nessun click deve attivare
   niente, perché il proiettore del Raspberry non ha nessuno che lo tocchi. */
.q-media img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
}

/* Sfocatura, decisa per-domanda dall'host in fase di creazione.
   È una classe e non una seconda copia dell'immagine: un blob solo in DB, e il
   toggle resta reversibile. Il valore scala con l'altezza dello schermo perché
   lo stesso blur in px su un proiettore 1080p e su un monitor da sviluppo non
   nasconde la stessa quantità di soggetto. */
.q-media.is-blurred img {
  filter: blur(clamp(8px, 2.2vh, 26px));
}
```

- [ ] **Step 2: Riscrivere `renderQuestionMedia`**

In `client/sala/app.js`, sostituire il commento sopra la funzione e la funzione stessa:

```js
/**
 * Le due varianti della scheda domanda si escludono a vicenda: o la riga di
 * istruzione, o il riquadro immagine. Non convivono mai — con entrambe la
 * scheda sfonderebbe l'altezza dello schermo e le risposte uscirebbero dal
 * campo visivo, che su un proiettore significa perderle del tutto.
 *
 * A decidere è il VALORE di `round.image`: un oggetto `{ hash, blur }` attiva
 * il riquadro, `null` (o l'assenza del campo) la riga di istruzione. Il
 * riferimento arriva nel payload di `game:question`; i byte no — si scaricano
 * da `/api/quiz-image/<hash>`, che è cacheabile come immutable e quindi costa
 * un download solo per dispositivo per tutta la serata.
 *
 * L'immagine è mostrata SOLO qui: il telefono riceve il campo (sono ~90 byte,
 * non vale un emit per-room) ma non lo disegna. Vedi la spec
 * docs/superpowers/specs/2026-08-29-immagini-domande-design.md.
 *
 * @param {object | null} round payload del round, o null per la variante testo
 */
function renderQuestionMedia(round) {
  const image = round?.image ?? null;
  const hasMedia = image !== null && typeof image === 'object' && typeof image.hash === 'string';

  els.questionHint.hidden  = hasMedia;
  els.questionMedia.hidden = !hasMedia;

  // Si riparte sempre dal riquadro pulito: l'immagine del round precedente non
  // deve comparire per un fotogramma sotto la domanda nuova, né la sua
  // sfocatura restare addosso a un'immagine che non la vuole.
  const existing = els.questionMedia.querySelector('img');
  if (existing) existing.remove();
  els.questionMedia.classList.remove('is-blurred');

  const icon = els.questionMedia.querySelector('.material-symbols-outlined');

  if (!hasMedia) {
    if (icon) icon.hidden = false;
    return;
  }

  els.questionMedia.classList.toggle('is-blurred', image.blur === true);

  const img = document.createElement('img');
  img.src = `/api/quiz-image/${image.hash}`;
  img.alt = '';
  img.decoding = 'async';
  // Se l'immagine non carica si torna al segnaposto invece di lasciare un buco.
  img.addEventListener('error', () => { img.remove(); if (icon) icon.hidden = false; });
  if (icon) icon.hidden = true;
  els.questionMedia.appendChild(img);
}
```

- [ ] **Step 3: Verificare le tre varianti nel browser**

```bash
npm run dev
```

Aprire `http://localhost:3000/sala`. Nella console del browser, con un hash reale caricato in Task 4:

```js
const now = Date.now();
renderQuestion({ kind:'question', index:0, total:3, text:'Senza immagine',
  options:['A','B','C','D'], image:null, endsAt:now+600000, serverNow:now });
```

```js
const now = Date.now();
renderQuestion({ kind:'question', index:1, total:3, text:'Con immagine',
  options:['A','B','C','D'], image:{ hash:'<hash-reale>', blur:false },
  endsAt:now+600000, serverNow:now });
```

```js
const now = Date.now();
renderQuestion({ kind:'question', index:2, total:3, text:'Sfocata',
  options:['A','B','C','D'], image:{ hash:'<hash-reale>', blur:true },
  endsAt:now+600000, serverNow:now });
```

Da verificare, in quest'ordine:
1. Nella seconda l'immagine si vede **intera**, in letterbox. Se è tagliata, lo Step 1 non è stato applicato.
2. Tornando alla prima, il riquadro sparisce e ricompare la riga di istruzione.
3. Nella terza il soggetto non è riconoscibile.
4. Passando dalla terza alla seconda la sfocatura **sparisce** (la classe viene tolta a ogni render).
5. Cliccando sull'immagine non succede niente e non parte una selezione.

Controllo numerico che il ritaglio sia davvero risolto:

```js
const box = document.getElementById('sala-question-media');
const img = box.querySelector('img');
console.log(getComputedStyle(img).height, getComputedStyle(box).height);
```

Atteso: l'altezza dell'`<img>` è **minore o uguale** a quella del box. Se è molto maggiore (es. 696px contro 187px), il ritaglio c'è ancora.

- [ ] **Step 4: Verificare che il download avvenga una volta sola**

Nel pannello Network del browser, ricaricare la pagina e rieseguire due volte il round con immagine. La seconda richiesta a `/api/quiz-image/<hash>` deve risultare servita dalla cache (o `304`).

- [ ] **Step 5: Mettere in stage**

```bash
git add client/sala/app.js client/sala/style.css
```

Commit suggerito: `feat(immagini): la vista sala disegna l'immagine, con blur opzionale`

Vale la pena menzionare nel corpo del commit anche la correzione del ritaglio, che è un bugfix indipendente e viaggia qui: *l'immagine in sala non viene più ritagliata — le percentuali si risolvevano contro la traccia di griglia.*

---

## Task 7: L'editor host carica, comprime, mostra

**Files:**
- Modify: `client/host/index.html` (`<script>` di `image-budget.js`, input file condiviso)
- Modify: `client/host/app.js` (`createEmptyQuestion`, `state`, `buildQuestionItem`, gestori eventi, compressione e caricamento)
- Modify: `client/host/style.css` (pannello immagine)

**Interfaces:**
- Consumes: `ImageBudget` (Task 1), `POST /api/host/quiz-image` (Task 4), `GET /api/quiz-image/:hash` (Task 5).
- Produces: le domande salvate portano `image: { hash, blur } | null`, letto da Task 3 e Task 6.

> **Trappola da conoscere prima di iniziare.** `validateQuiz` rifiuta le chiavi estranee dentro `image` (Task 3), quindi il peso in KB **non può** essere memorizzato come `image._kb`: il salvataggio del quiz fallirebbe con un errore di validazione. Va tenuto in una mappa separata lato client, indicizzata per hash.

- [ ] **Step 1: Caricare il modulo puro nel pannello host**

In `client/host/index.html`, prima del `<script>` di `app.js`:

```html
<script src="/shared/image-budget.js"></script>
```

E, in fondo al `<body>`, l'input condiviso:

```html
<!-- Input di caricamento condiviso da tutte le domande: quale domanda lo stia
     usando lo dice state.pendingImageQuestion. Venti input nascosti nel DOM per
     venti domande sarebbero venti nodi in più per la stessa identica funzione. -->
<input type="file" id="image-file-input" accept="image/*" hidden>
```

- [ ] **Step 2: Aggiungere lo stato e il campo alla domanda vuota**

In `client/host/app.js`:

**(a)** In `createEmptyQuestion()`, aggiungere `image: null,` prima di `_minigameAfter`.

**(b)** Accanto agli altri campi di `state`:

```js
  /**
   * Peso in KB delle immagini caricate, per hash.
   *
   * Sta QUI e non dentro `q.image` perché `validateQuiz` rifiuta le chiavi
   * estranee dentro `image`: un `_kb` lì dentro farebbe fallire il salvataggio.
   * È informazione da interfaccia, non da modello dati.
   * @type {Record<string, number>}
   */
  imageWeights: {},

  /** Indice della domanda che sta aspettando un file, o null. */
  pendingImageQuestion: null,
```

- [ ] **Step 3: Aggiungere il blocco immagine alla scheda domanda**

In `buildQuestionItem`, prima della composizione di `item.innerHTML`:

```js
  // Blocco immagine: bottone se non c'è, pannello con anteprima se c'è.
  // Una domanda senza immagine non paga pixel per una funzione che non usa.
  const weight = q.image ? state.imageWeights[q.image.hash] : null;
  const imageHtml = q.image
    ? `
      <div class="q-image-panel">
        <div class="q-image-preview ${q.image.blur ? 'is-blurred' : ''}" data-role="image-preview" data-q="${idx}">
          <img src="/api/quiz-image/${escapeHtml(q.image.hash)}" alt="">
        </div>
        <div class="q-image-actions">
          <label class="q-image-toggle">
            <input type="checkbox" data-role="image-blur" data-q="${idx}" ${q.image.blur ? 'checked' : ''}>
            <span>Sfoca immagine</span>
          </label>
          ${weight ? `<span class="q-image-weight">${weight} KB</span>` : ''}
          <button type="button" class="btn btn-danger btn-sm" data-role="image-remove" data-q="${idx}" title="Rimuovi l'immagine da questa domanda">
            <i class="fas fa-trash"></i> Rimuovi
          </button>
        </div>
      </div>`
    : `
      <button type="button" class="btn btn-secondary btn-sm q-image-add" data-role="image-add" data-q="${idx}">
        <i class="fas fa-image"></i> Aggiungi immagine
      </button>`;
```

E inserire `${imageHtml}` dentro `.question-item-body`, subito dopo il `form-group` del testo della domanda.

- [ ] **Step 4: Scrivere la compressione e il caricamento**

Accanto alle altre funzioni dell'editor:

```js
/* ── Immagini ── */

/**
 * Ridimensiona e comprime un file immagine in WebP, sotto il tetto di byte.
 *
 * Tutto avviene nel browser: il server non ricomprime perché servirebbe un
 * modulo nativo, escluso dal vincolo di packaging SEA su ARM. La CPU che paga è
 * quella del tablet di chi crea il quiz, in un momento tranquillo, non quella
 * del Raspberry davanti a una sala.
 *
 * @param {File} file
 * @returns {Promise<{ blob: Blob, width: number, height: number }>}
 */
async function compressImage(file) {
  if (file.size > ImageBudget.MAX_INPUT_BYTES) {
    const mb = Math.round(ImageBudget.MAX_INPUT_BYTES / (1024 * 1024));
    throw new Error(`L'immagine supera ${mb} MB.`);
  }

  // `imageOrientation: 'from-image'` NON è opzionale: le foto da telefono
  // arrivano quasi sempre ruotate via EXIF, e senza questo flag finirebbero di
  // lato — un difetto che si manifesta solo con file veri, mai con quelli di
  // prova.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

  // Nessun ritaglio: si scala il lato lungo e si preserva il rapporto, così
  // verticale e orizzontale entrano entrambi. In sala ci pensa object-fit.
  const { width, height } = ImageBudget.targetDimensions(bitmap.width, bitmap.height);

  const canvas = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  let quality = ImageBudget.QUALITY_LADDER[0];
  let blob = await canvasToBlob(canvas, quality);

  // Un browser che non sa produrre WebP restituisce un PNG senza dirlo: il
  // server lo rifiuterebbe con un 415 poco spiegabile, meglio dirlo qui.
  if (blob.type !== 'image/webp') {
    throw new Error('Questo browser non sa produrre immagini WebP.');
  }

  while (blob.size > ImageBudget.MAX_BYTES) {
    const next = ImageBudget.nextQuality(quality);
    if (next === null) break; // pavimento: meglio un file più grande che poltiglia
    quality = next;
    blob = await canvasToBlob(canvas, quality);
  }

  return { blob, width, height };
}

/** `canvas.toBlob` come promessa. */
function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Codifica dell'immagine fallita."))),
      'image/webp',
      quality
    );
  });
}

/**
 * Carica i byte compressi e restituisce il riferimento da mettere sulla domanda.
 *
 * `apiFetch` mette `Content-Type: application/json` di default, ma le opzioni
 * passate vincono sulla base: qui serve `image/webp`, altrimenti
 * `express.raw({ type: 'image/webp' })` lascerebbe il body vuoto.
 *
 * @returns {Promise<{ hash: string, width: number, height: number }>}
 */
async function uploadImage(blob, width, height) {
  const payload = await apiFetch(`/quiz-image?width=${width}&height=${height}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/webp' },
    body: blob,
  });

  if (!payload.success) {
    throw new Error(payload.error ?? "Caricamento dell'immagine fallito.");
  }
  return payload.data;
}
```

- [ ] **Step 5: Collegare i gestori di evento**

Nel punto in cui l'editor delega i `click` della lista domande (accanto ai gestori di `remove-q`, `correct-indicator`, ecc.):

```js
  // Apre il selettore di file per la domanda che ha chiesto un'immagine.
  const addBtn = target.closest('[data-role="image-add"]');
  if (addBtn) {
    state.pendingImageQuestion = Number(addBtn.dataset.q);
    imageFileInput.value = ''; // così ricaricare lo stesso file riscatena `change`
    imageFileInput.click();
    return;
  }

  const removeBtn = target.closest('[data-role="image-remove"]');
  if (removeBtn) {
    const idx = Number(removeBtn.dataset.q);
    // Il blob resta in DB: potrebbe servire a un'altra domanda. Lo eliminerà la
    // raccolta degli orfani al prossimo avvio, se davvero non lo usa nessuno.
    state.questions[idx].image = null;
    renderQuestionList();
    return;
  }
```

Fra i gestori di `change` della lista:

```js
  const blurToggle = target.closest('[data-role="image-blur"]');
  if (blurToggle) {
    const idx = Number(blurToggle.dataset.q);
    if (state.questions[idx].image) {
      state.questions[idx].image.blur = blurToggle.checked;
      // Si aggiorna solo l'anteprima invece di ridisegnare la lista: un
      // renderQuestionList() qui rifarebbe venti schede e farebbe perdere il
      // testo in corso di scrittura in un'altra domanda.
      const preview = questionsList.querySelector(`[data-role="image-preview"][data-q="${idx}"]`);
      if (preview) preview.classList.toggle('is-blurred', blurToggle.checked);
    }
    return;
  }
```

E il gestore dell'input file, registrato una volta sola all'avvio:

```js
const imageFileInput = document.getElementById('image-file-input');

imageFileInput.addEventListener('change', async () => {
  const file = imageFileInput.files?.[0];
  const idx  = state.pendingImageQuestion;
  state.pendingImageQuestion = null;
  if (!file || idx === null || !state.questions[idx]) return;

  // Il bottone diventa inerte: ridimensionare un file da 20MB richiede qualche
  // secondo su un tablet, e senza un segnale l'host clicca di nuovo.
  const btn = questionsList.querySelector(`[data-role="image-add"][data-q="${idx}"]`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Elaborazione…';
  }

  try {
    const { blob, width, height } = await compressImage(file);
    const saved = await uploadImage(blob, width, height);

    state.questions[idx].image = { hash: saved.hash, blur: false };
    state.imageWeights[saved.hash] = Math.round(blob.size / 1024);
    renderQuestionList();
    showToast('Immagine caricata.', 'success');
  } catch (err) {
    // Nessuno stato a metà: la domanda resta senza immagine.
    state.questions[idx].image = null;
    renderQuestionList();
    showToast(err.message, 'error');
  }
});
```

- [ ] **Step 6: Aggiungere il CSS del pannello**

In `client/host/style.css`, seguendo i token già in uso nel pannello (bordi Ink, ombre offset piatte — vedi DESIGN.md; se esistono già variabili per il bordo, usare quelle invece del valore letterale):

```css
/* ── Immagine della domanda ─────────────────────────────────────────────── */

.q-image-panel {
  margin-top: 0.75rem;
}

/* Stesso rapporto e stesso object-fit del riquadro in sala: quello che l'host
   vede qui è quello che vedrà la stanza. Se i due divergono, l'anteprima mente. */
.q-image-preview {
  position: relative;
  width: 100%;
  max-width: 22rem;
  aspect-ratio: 16 / 9;
  border: 3px solid var(--ink, #2a2a2a);
  border-radius: 0.5rem;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.04);
}

.q-image-preview img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* Il blur mostrato all'host è lo stesso che vedrà la sala: se non si vede
   l'effetto, non si può decidere se è quello giusto. Il valore è più basso
   perché l'anteprima è molto più piccola del riquadro proiettato. */
.q-image-preview.is-blurred img {
  filter: blur(10px);
}

.q-image-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.5rem;
  flex-wrap: wrap;
}

.q-image-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 700;
  cursor: pointer;
}

.q-image-weight {
  font-size: 0.8rem;
  opacity: 0.6;
}
```

- [ ] **Step 7: Provare il giro completo nell'editor**

Avviare il server, aprire il pannello host, fare login, aprire l'editor di un quiz.

Da verificare, in quest'ordine:
1. `Aggiungi immagine` apre il selettore di file.
2. Caricando una foto **orizzontale**: il bottone diventa "Elaborazione…", poi compare l'anteprima intera con il peso in KB. Il peso deve essere **≤ 150 KB**.
3. Caricando una foto **verticale** su un'altra domanda: entra intera, in letterbox, **non ruotata di lato**. Se è di lato, `imageOrientation` non è stato applicato.
4. Il toggle `Sfoca immagine` sfoca l'anteprima e **non** ridisegna la lista: scrivere del testo in un'altra domanda, poi premere il toggle — il testo non deve perdersi.
5. `Rimuovi` riporta al bottone.
6. **Salvare il quiz e riaprirlo**: immagine e stato del blur sono ancora lì. Se il salvataggio fallisce con un errore di validazione, controllare che nessuna chiave estranea sia finita dentro `image` (vedi la trappola in testa al task).
7. Caricare un file **non immagine** (un `.txt` rinominato `.png`): toast di errore, domanda senza immagine, nessuno stato a metà.

- [ ] **Step 8: Provare la partita vera, capo a capo**

Avviare una partita con il quiz appena creato, con la vista sala aperta in una seconda finestra e il player in una terza.

Da verificare:
1. Alla domanda con immagine, il riquadro in sala mostra l'immagine intera.
2. Se il blur è attivo, in sala è sfocata.
3. Sul **player** (`http://localhost:3000/`) la domanda compare **senza** immagine, con testo e opzioni normali. Nessun errore in console.
4. Alla domanda successiva senza immagine, in sala torna la riga di istruzione.
5. Ricaricare la pagina della sala a metà domanda: `game:snapshot` la riporta nello stato giusto, immagine compresa.

- [ ] **Step 9: Mettere in stage**

```bash
git add client/host/app.js client/host/index.html client/host/style.css
```

Commit suggerito: `feat(immagini): caricamento, anteprima e toggle blur nell'editor`

---

## Task 8: Documentazione

**Files:**
- Modify: `content/quizzes/_TEMPLATE.json.txt`
- Modify: `CLAUDE.md`

**Interfaces:** nessuna.

- [ ] **Step 1: Aggiornare il template dei quiz di sistema**

In `content/quizzes/_TEMPLATE.json.txt`, nel blocco REGOLE, dopo la riga `time_limit_s`:

```
                   image          facoltativo. Riferimento a un'immagine già
                                  caricata: { "hash": "<64 caratteri esadecimali>",
                                  "blur": false }. Oppure null.

                                  ATTENZIONE: oggi le immagini si caricano SOLO
                                  dall'editor del pannello host, che le comprime
                                  e le stocca nel database. Un file di sistema
                                  può referenziare un hash solo se quell'immagine
                                  è già nel DB — altrimenti il quiz viene
                                  ESCLUSO all'avvio. In pratica: nei quiz di
                                  sistema, per ora, lascia perdere questo campo.

                                  L'immagine compare solo sullo schermo della
                                  SALA, mai sul telefono dei giocatori.
```

- [ ] **Step 2: Documentare il sottosistema in CLAUDE.md**

In `CLAUDE.md`, una nuova sottosezione dentro **Architecture**, dopo "Aggiungere o modificare un quiz di sistema":

```markdown
### Immagini nelle domande

Una domanda può portare un'immagine, che compare **solo sulla vista sala**. Il
design completo sta in
[docs/superpowers/specs/2026-08-29-immagini-domande-design.md](docs/superpowers/specs/2026-08-29-immagini-domande-design.md).

Quattro decisioni da non ribaltare per distrazione:

- **L'immagine non viaggia sul socket.** Nel round c'è solo
  `image: { hash, blur }`; i byte si scaricano da `GET /api/quiz-image/<hash>`,
  pubblico come `/api/join-info` perché la sala non ha token. L'URL contiene
  l'hash del contenuto, quindi è servito con `Cache-Control: immutable` e ogni
  dispositivo lo scarica una volta sola per tutta la serata. `emitQuestion` è un
  `io.emit` globale: un base64 nel payload sarebbe ~2,4MB per domanda con venti
  telefoni sull'access point, senza cache possibile.
- **La compressione avviene nel browser dell'host**, mai sul server:
  `client/shared/image-budget.js` (decisioni pure, testabili in Node) più la
  pipeline Canvas in `client/host/app.js`. Stessa separazione di
  `audio-logic.js` / `audio.js`. Il motivo non è il gusto ma il vincolo: `sharp`
  e simili sono moduli nativi, e il progetto li ha eliminati per il packaging
  SEA su ARM.
- **Lo stoccaggio è indirizzato dal contenuto.** `quiz_images.hash` è lo SHA-256
  dei byte, calcolato **dal server**, mai dal client. La stessa foto in due quiz
  occupa una riga sola. Le immagini che nessuna domanda referenzia più vengono
  eliminate da `gcOrphanImages()` a ogni avvio — non c'è refcount da tenere
  coerente, si ricalcola la verità invece di ricordarla.
- **Il blur è una classe CSS, non una seconda copia.** Un blob per immagine, e
  il toggle resta reversibile. Che l'originale sia nel DOM è irrilevante: in
  sala c'è un Chromium in kiosk collegato a un proiettore, senza nessuno che lo
  tocchi — ed è lo stesso motivo per cui l'`<img>` ha `pointer-events: none`.

**Il player non mostra le immagini.** Il campo `image` arriva anche ai telefoni
(sono ~90 byte, non vale un emit per-room) ma `client/player/app.js` non lo
legge. È una scelta di prodotto, non un limite tecnico: il telefono renderizza
già testo e opzioni, quindi una domanda visiva resta rispondibile solo guardando
il proiettore — che è l'oggetto comune del gioco, come per l'audio. Cambiare
idea costa un `<img>`.
```

- [ ] **Step 3: Verificare che la suite intera passi**

```bash
npm run test:image && npm run test:quizzes && npm run test:minigames && npm run test:final && npm run test:clock
```

```bash
node tools/test-game.js && node tools/test-db.js && node tools/check-quizzes.js
```

Atteso: tutti verdi, nessun quiz di sistema escluso.

- [ ] **Step 4: Mettere in stage**

```bash
git add CLAUDE.md content/quizzes/_TEMPLATE.json.txt
```

Commit suggerito: `docs(immagini): documentare il sottosistema e il campo image`

---

## Autoverifica del piano

**Copertura della spec** — ogni sezione ha un task:

| Spec | Task |
|---|---|
| §1 modello dati, tabella | 2 |
| §1 campo `image`, `getCurrentRound` | 3 |
| §2 POST autenticato | 4 |
| §2 GET pubblico, cache immutable | 5 |
| §3 compressione, modulo puro | 1, 7 |
| §4 blur come classe CSS | 6 (sala), 7 (anteprima) |
| §5 correzione del ritaglio | 6 |
| §6 raccolta degli orfani | 2 |
| §7 interfaccia dell'editor | 7 |
| §8 validazione | 3 |
| §9 test | 1, 2, 3 |
| §10 documentazione | 8 |

**Coerenza dei nomi** — `putImage` / `getImage` / `gcOrphanImages` (Task 2) sono usati con la stessa firma in Task 4 e 5; `isValidImageHash` (Task 3) in Task 5; `ImageBudget.targetDimensions` / `nextQuality` / `MAX_BYTES` / `MAX_INPUT_BYTES` / `QUALITY_LADDER` (Task 1) in Task 7; la classe `.is-blurred` è la stessa in sala (Task 6) e nell'anteprima dell'editor (Task 7).

**Trappole segnalate esplicitamente:**
- il peso in KB non può stare dentro `image` (Task 7, nota in testa) — `validateQuiz` rifiuta le chiavi estranee;
- l'error handler globale va toccato **prima** della route di upload (Task 4, Step 1), altrimenti il 413 arriva come 500;
- il DB di test va cancellato se non ha la tabella nuova (Task 2, Step 5);
- `createHash` **non** va importato nella route (Task 4, Step 2a): il layer dati è l'unico posto che decide come si chiama un'immagine;
- `apiFetch` mette `Content-Type: application/json` di default, e va sovrascritto con `image/webp` (Task 7, Step 4) altrimenti `express.raw` lascia il body vuoto.
