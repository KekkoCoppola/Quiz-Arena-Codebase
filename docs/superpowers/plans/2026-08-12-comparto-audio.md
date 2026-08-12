# Comparto Audio Host — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dotare il pannello host di musica (letto + tensione sincronizzata al countdown), voce narrante e effetti sonori, guidati da un manifest editabile dall'utente senza toccare il codice.

**Architecture:** Due moduli client separati che ricalcano il pattern già usato dal progetto per `server/game.js` / `server/game-socket.js`: `audio-logic.js` contiene **decisioni pure** (rotazione varianti, scadenza battute, aritmetica della tensione, validazione manifest) senza alcuna dipendenza da DOM o Web Audio, ed è testabile in Node; `audio.js` è il **motore di riproduzione** che usa quelle decisioni e parla con `<audio>` e Web Audio API. `app.js` chiama solo `audio.js`, una riga per aggancio.

**Tech Stack:** JS vanilla ES2020, nessun bundler. `HTMLAudioElement` per musica e voce, Web Audio API (`AudioContext` + `AudioBuffer`) per gli effetti. Node v24 per gli script di test.

## Global Constraints

- **MAI creare commit.** Regola esplicita dell'utente su questo progetto: i checkpoint si fanno **solo con `git add`**. Ogni step di staging in questo piano usa `git add` e nient'altro. I commit li decide l'utente.
- **Node non è nel PATH.** Eseguibile: `D:\ISTALLAZION_PROGRAMMI\node.exe` (v24.11.1, con underscore nel nome cartella). Da Bash: `export PATH="/d/ISTALLAZION_PROGRAMMI:$PATH"`.
- **Nessuna modifica a `server/`, allo schema DB o alle API REST.** Il comparto audio è interamente client-side sul pannello host. Gli asset sono serviti dal mount statico `/resources` già esistente.
- **Nessun audio lato player.** Non toccare `client/player/`.
- **Nessun contenuto dinamico nel parlato.** Nessuna riga vocale contiene nickname, punteggi o numeri variabili.
- **L'audio non deve mai poter rompere la partita.** Ogni errore è confinato nel modulo; ogni funzione pubblica è un no-op se il sottosistema è disabilitato. Nessuna eccezione può risalire agli handler socket di `app.js`.
- **Design system:** qualunque elemento visivo nuovo usa i token esistenti di [DESIGN.md](../../../DESIGN.md) — bordo Ink 4px, ombra offset senza blur, Quicksand ≥700. Nessun token nuovo.
- **Formati:** MP3 per voce ed effetti, Ogg per la musica. Nessuna conversione richiesta all'utente.
- Spec di riferimento: [2026-08-12-comparto-audio-design.md](../specs/2026-08-12-comparto-audio-design.md).

## Nota sulla strategia di test

Il progetto non ha framework di test: `tools/test-*.js` sono script standalone con un helper `assert()` locale che stampano PASS/FAIL e impostano `process.exitCode`.

Per questo il piano **separa la logica pura dal motore**. La logica pura (Task 1) ha test automatici veri in `tools/test-audio.js`, nello stile esistente. Il motore (Task 2-8) tocca DOM e Web Audio, che nessuno script Node può esercitare: lì la verifica è **manuale nel browser**, con osservazioni attese esplicite. Non ci sono test finti per il codice DOM.

## File Structure

| File | Responsabilità |
|---|---|
| `client/host/audio-logic.js` (nuovo) | Decisioni pure: costanti, rotazione varianti, scadenza VO, piano della tensione, risoluzione del guadagno, validazione manifest. Zero DOM. Esportato sia come globale browser sia come CommonJS. |
| `client/host/audio.js` (nuovo) | Motore: caricamento manifest, canale musica, canale voce con coda, canale effetti Web Audio, mute, rampe di volume. Unica superficie usata da `app.js`. |
| `tools/test-audio.js` (nuovo) | Smoke test di `audio-logic.js`, stile `tools/test-game.js`. |
| `tools/audio-calibration.html` (nuovo) | Pagina autonoma per misurare i livelli e ricavare i `gain` del manifest. |
| `resources/audio/manifest.json` (nuovo) | Catalogo asset. Editato dall'utente, mai dal codice. |
| `client/host/index.html` (modifica) | Due `<script>` e il pulsante mute. |
| `client/host/style.css` (modifica) | Stile del pulsante mute. |
| `client/host/app.js` (modifica) | Sette agganci, una riga ciascuno. |
| `CLAUDE.md` (modifica) | Correzione della riga che descrive i client come single-file. |

---

### Task 1: Logica pura e test

**Files:**
- Create: `client/host/audio-logic.js`
- Create: `tools/test-audio.js`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nulla.
- Produces: globale browser `window.AudioLogic` / export CommonJS con:
  - `CHANNEL_VOLUME = { music: 0.35, vo: 1.0, sfx: 0.8 }`
  - `MUSIC_DUCK_FACTOR = 0.10`, `RAMP_MS = 400`, `TENSION_FINAL_S = 10`, `SUSPENSE_MS = 1500`
  - `pickVariant(count, lastIndex, rnd) -> number`
  - `isStale(queuedToken, currentToken) -> boolean`
  - `tensionPlan({ endsAt, now, finalDurationS }) -> { useLoop, finalDelayMs, finalSeekS, skip }`
  - `resolveGain({ channel, assetGain, muted, ducked }) -> number`
  - `validateManifest(raw) -> { music, vo, sfx, errors }`

- [ ] **Step 1: Scrivere il test che fallisce**

Creare `tools/test-audio.js`:

```js
'use strict';

/**
 * tools/test-audio.js
 *
 * Smoke test isolato per client/host/audio-logic.js.
 * Testa le decisioni pure del comparto audio SENZA DOM/Web Audio.
 *
 * Utilizzo: node tools/test-audio.js
 */

const {
  CHANNEL_VOLUME,
  MUSIC_DUCK_FACTOR,
  TENSION_FINAL_S,
  pickVariant,
  isStale,
  tensionPlan,
  resolveGain,
  validateManifest,
} = require('../client/host/audio-logic');

// ─── Setup ───────────────────────────────────────────────────────────────────────

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

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ─── pickVariant ─────────────────────────────────────────────────────────────────

section('pickVariant — rotazione varianti');

assert(pickVariant(0, -1, () => 0) === -1, 'nessuna variante → -1');
assert(pickVariant(1, 0, () => 0) === 0, 'una sola variante → sempre 0, anche se già usata');
assert(pickVariant(3, -1, () => 0) === 0, 'prima estrazione senza precedente');

{
  // Con 3 varianti e lastIndex=1, lo spazio di scelta è [0, 2].
  const first  = pickVariant(3, 1, () => 0);
  const second = pickVariant(3, 1, () => 0.99);
  assert(first === 0,  'esclude la precedente: rnd=0 → 0');
  assert(second === 2, 'esclude la precedente: rnd=0.99 → 2');
}

{
  let everRepeated = false;
  let last = -1;
  for (let i = 0; i < 200; i++) {
    const next = pickVariant(4, last, Math.random);
    if (next === last) everRepeated = true;
    last = next;
  }
  assert(!everRepeated, 'su 200 estrazioni non ripete mai la precedente');
}

// ─── isStale ─────────────────────────────────────────────────────────────────────

section('isStale — scadenza battute vocali');

assert(isStale(3, 4) === true,  'token diverso → scaduta');
assert(isStale(4, 4) === false, 'stesso token → valida');

// ─── tensionPlan ─────────────────────────────────────────────────────────────────

section('tensionPlan — sincronia del crescendo col countdown');

{
  const now = 1_000_000;
  const plan = tensionPlan({ endsAt: now + 120_000, now, finalDurationS: TENSION_FINAL_S });
  assert(plan.useLoop === true,       '120s: usa il loop di tensione');
  assert(plan.finalDelayMs === 110_000, '120s: il crescendo parte a T-10');
  assert(plan.finalSeekS === 0,       '120s: crescendo dall’inizio');
  assert(plan.skip === false,         '120s: non salta');
}

{
  const now = 1_000_000;
  const plan = tensionPlan({ endsAt: now + 20_000, now, finalDurationS: TENSION_FINAL_S });
  assert(plan.useLoop === true,        '20s: usa il loop');
  assert(plan.finalDelayMs === 10_000, '20s: crescendo a T-10');
  assert(plan.finalSeekS === 0,        '20s: crescendo dall’inizio');
}

{
  const now = 1_000_000;
  const plan = tensionPlan({ endsAt: now + 10_000, now, finalDurationS: TENSION_FINAL_S });
  assert(plan.useLoop === false,   '10s: nessun loop, solo crescendo');
  assert(plan.finalDelayMs === 0,  '10s: crescendo immediato');
  assert(plan.finalSeekS === 0,    '10s: crescendo dall’inizio');
}

{
  const now = 1_000_000;
  const plan = tensionPlan({ endsAt: now + 5_000, now, finalDurationS: TENSION_FINAL_S });
  assert(plan.useLoop === false,  '5s: nessun loop');
  assert(plan.finalDelayMs === 0, '5s: crescendo immediato');
  assert(plan.finalSeekS === 5,   '5s: entra a metà crescendo per atterrare sullo zero');
}

{
  const now = 1_000_000;
  const plan = tensionPlan({ endsAt: now - 1, now, finalDurationS: TENSION_FINAL_S });
  assert(plan.skip === true, 'countdown già scaduto → non suona nulla');
}

// ─── resolveGain ─────────────────────────────────────────────────────────────────

section('resolveGain — volume effettivo');

assert(
  resolveGain({ channel: 'music', assetGain: 1, muted: false, ducked: false }) === CHANNEL_VOLUME.music,
  'musica non duckata → volume di canale'
);
assert(
  Math.abs(
    resolveGain({ channel: 'music', assetGain: 1, muted: false, ducked: true })
    - CHANNEL_VOLUME.music * MUSIC_DUCK_FACTOR
  ) < 1e-9,
  'musica duckata → volume di canale × fattore duck'
);
assert(
  resolveGain({ channel: 'vo', assetGain: 1, muted: false, ducked: true }) === CHANNEL_VOLUME.vo,
  'il duck non tocca la voce'
);
assert(
  resolveGain({ channel: 'music', assetGain: 1, muted: true, ducked: false }) === 0,
  'muted → 0 su qualunque canale'
);
assert(
  Math.abs(resolveGain({ channel: 'sfx', assetGain: 0.5, muted: false, ducked: false })
    - CHANNEL_VOLUME.sfx * 0.5) < 1e-9,
  'il gain per-asset moltiplica quello di canale'
);
assert(
  resolveGain({ channel: 'sfx', assetGain: 99, muted: false, ducked: false }) <= 1,
  'il risultato è sempre ≤ 1 (HTMLAudioElement.volume non accetta più)'
);

// ─── validateManifest ────────────────────────────────────────────────────────────

section('validateManifest — tollera qualunque input');

{
  const m = validateManifest(null);
  assert(m.errors.length > 0, 'null → errore segnalato');
  assert(Object.keys(m.vo).length === 0, 'null → catalogo vuoto, non esplode');
}

{
  const m = validateManifest({ music: {}, vo: {}, sfx: {} });
  assert(m.errors.length === 0, 'manifest vuoto è valido');
}

{
  const m = validateManifest({
    music: { bed: { file: 'music/bed.ogg', gain: 1 } },
    vo:    { 'lobby-qr': [{ file: 'vo/a.mp3' }] },
    sfx:   { 'player-joined': [{ file: 'sfx/j.mp3', gain: 0.5 }] },
  });
  assert(m.music.bed.file === 'music/bed.ogg', 'musica normalizzata');
  assert(m.vo['lobby-qr'].length === 1,        'voce normalizzata in array');
  assert(m.vo['lobby-qr'][0].gain === 1,       'gain assente → default 1');
  assert(m.sfx['player-joined'][0].gain === 0.5, 'gain esplicito preservato');
  assert(m.errors.length === 0,                 'nessun errore');
}

{
  // Un evento singolo (non array) va accettato e avvolto: è l'errore di scrittura
  // manuale più probabile nel manifest.
  const m = validateManifest({ vo: { 'via': { file: 'vo/via.mp3' } } });
  assert(Array.isArray(m.vo.via),   'oggetto singolo avvolto in array');
  assert(m.vo.via[0].file === 'vo/via.mp3', 'file preservato nell’avvolgimento');
}

{
  const m = validateManifest({ vo: { rotto: [{ gain: 1 }] } });
  assert(m.vo.rotto === undefined, 'voce senza "file" scartata');
  assert(m.errors.length > 0,      'voce senza "file" segnalata');
}

// ─── Esito ───────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  Passati: ${passed}   Falliti: ${failed}`);
console.log(`${'─'.repeat(50)}\n`);

process.exitCode = failed > 0 ? 1 : 0;
```

- [ ] **Step 2: Eseguire il test per verificare che fallisca**

```bash
"D:\ISTALLAZION_PROGRAMMI\node.exe" tools/test-audio.js
```

Atteso: FAIL con `Cannot find module '../client/host/audio-logic'`.

- [ ] **Step 3: Scrivere l'implementazione**

Creare `client/host/audio-logic.js`:

```js
'use strict';

/**
 * client/host/audio-logic.js
 *
 * Decisioni pure del comparto audio dell'host: nessun DOM, nessuna Web Audio API,
 * nessun timer. Ricalca la separazione già usata dal progetto fra server/game.js
 * (puro, testabile) e server/game-socket.js (I/O).
 *
 * Caricato come <script> nel pannello host (espone window.AudioLogic) e come
 * modulo CommonJS da tools/test-audio.js.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AudioLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /** Volume base per canale. La musica è un letto, non una protagonista. */
  const CHANNEL_VOLUME = { music: 0.35, vo: 1.0, sfx: 0.8 };

  /** Quanto scende la musica mentre la voce parla. */
  const MUSIC_DUCK_FACTOR = 0.10;

  /** Durata delle rampe di volume. Un salto secco si sente come un difetto. */
  const RAMP_MS = 400;

  /** Durata fissa del crescendo finale, deve combaciare con l'asset prodotto. */
  const TENSION_FINAL_S = 10;

  /** Pausa fra l'arrivo di game:results e il reveal, per il rullo di tamburi. */
  const SUSPENSE_MS = 1500;

  /**
   * Sceglie una variante evitando di ripetere l'ultima usata.
   * @param {number} count numero di varianti disponibili
   * @param {number} lastIndex indice usato la volta scorsa, -1 se nessuno
   * @param {() => number} rnd generatore in [0, 1)
   * @returns {number} indice scelto, -1 se non ci sono varianti
   */
  function pickVariant(count, lastIndex, rnd) {
    if (!count || count <= 0) return -1;
    if (count === 1) return 0;
    // Si estrae fra count-1 posizioni e si "salta" quella esclusa: così ogni
    // variante ammessa ha la stessa probabilità, senza cicli di ritentativo.
    const pick = Math.floor(rnd() * (count - 1));
    return pick >= lastIndex && lastIndex >= 0 ? pick + 1 : pick;
  }

  /**
   * Una battuta accodata in una fase e non ancora partita quando la fase cambia
   * è da scartare: in ritardo sarebbe peggio che assente.
   */
  function isStale(queuedToken, currentToken) {
    return queuedToken !== currentToken;
  }

  /**
   * Pianifica le due tracce di tensione perché il crescendo atterri sullo zero
   * qualunque sia il limite di tempo della domanda (TIME_OPTIONS va da 5 a 120s).
   *
   * @returns {{useLoop: boolean, finalDelayMs: number, finalSeekS: number, skip: boolean}}
   */
  function tensionPlan({ endsAt, now, finalDurationS }) {
    const remainingMs = endsAt - now;
    if (remainingMs <= 0) {
      return { useLoop: false, finalDelayMs: 0, finalSeekS: 0, skip: true };
    }
    const remainingS = remainingMs / 1000;
    if (remainingS > finalDurationS) {
      // C'è spazio per il loop neutro prima del crescendo.
      return {
        useLoop: true,
        finalDelayMs: Math.round((remainingS - finalDurationS) * 1000),
        finalSeekS: 0,
        skip: false,
      };
    }
    // Countdown più corto del crescendo: si entra a metà traccia.
    return {
      useLoop: false,
      finalDelayMs: 0,
      finalSeekS: finalDurationS - remainingS,
      skip: false,
    };
  }

  /**
   * Volume effettivo di un asset. Il duck si applica solo alla musica.
   * Il risultato è sempre in [0, 1]: HTMLAudioElement.volume rifiuta il resto.
   */
  function resolveGain({ channel, assetGain, muted, ducked }) {
    if (muted) return 0;
    const base = CHANNEL_VOLUME[channel] ?? 1;
    const gain = typeof assetGain === 'number' && assetGain >= 0 ? assetGain : 1;
    const duck = ducked && channel === 'music' ? MUSIC_DUCK_FACTOR : 1;
    return Math.min(1, base * gain * duck);
  }

  /** Una voce del catalogo è utilizzabile solo se ha un "file". */
  function normalizeEntry(entry, path, errors) {
    if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string' || !entry.file) {
      errors.push(`${path}: voce senza campo "file", ignorata`);
      return null;
    }
    const gain = typeof entry.gain === 'number' && entry.gain >= 0 ? entry.gain : 1;
    return { file: entry.file, gain };
  }

  /**
   * Normalizza il manifest tollerando qualunque input: un manifest rotto deve
   * produrre un catalogo vuoto e una lista di errori, mai un'eccezione.
   */
  function validateManifest(raw) {
    const out = { music: {}, vo: {}, sfx: {}, errors: [] };
    if (!raw || typeof raw !== 'object') {
      out.errors.push('manifest assente o non è un oggetto');
      return out;
    }

    const music = raw.music && typeof raw.music === 'object' ? raw.music : {};
    for (const key of Object.keys(music)) {
      const entry = normalizeEntry(music[key], `music.${key}`, out.errors);
      if (entry) out.music[key] = entry;
    }

    for (const channel of ['vo', 'sfx']) {
      const group = raw[channel] && typeof raw[channel] === 'object' ? raw[channel] : {};
      for (const key of Object.keys(group)) {
        // Un oggetto singolo al posto di un array è l'errore di scrittura manuale
        // più probabile: si accetta e si avvolge invece di rifiutare.
        const rawList = Array.isArray(group[key]) ? group[key] : [group[key]];
        const list = rawList
          .map((e, i) => normalizeEntry(e, `${channel}.${key}[${i}]`, out.errors))
          .filter(Boolean);
        if (list.length > 0) out[channel][key] = list;
      }
    }

    return out;
  }

  return {
    CHANNEL_VOLUME,
    MUSIC_DUCK_FACTOR,
    RAMP_MS,
    TENSION_FINAL_S,
    SUSPENSE_MS,
    pickVariant,
    isStale,
    tensionPlan,
    resolveGain,
    validateManifest,
  };
});
```

- [ ] **Step 4: Eseguire il test per verificare che passi**

```bash
"D:\ISTALLAZION_PROGRAMMI\node.exe" tools/test-audio.js
```

Atteso: tutte le righe `✅`, `Falliti: 0`, exit code 0.

- [ ] **Step 5: Aggiornare CLAUDE.md**

In `CLAUDE.md`, sezione "Frontend: due SPA vanilla separate, nessun bundler", sostituire la frase che descrive i client come single-file. Trovare:

```
`client/host/app.js` e `client/player/app.js` sono JS vanilla single-file (niente framework, niente build step) serviti come file statici.
```

Sostituire con:

```
`client/host/app.js` e `client/player/app.js` sono JS vanilla (niente framework, niente build step) serviti come file statici. Il player è single-file; l'host affianca ad `app.js` il comparto audio, diviso fra `client/host/audio-logic.js` (decisioni pure, senza DOM, testabile in Node con `tools/test-audio.js`) e `client/host/audio.js` (motore di riproduzione). La separazione ricalca quella fra `server/game.js` e `server/game-socket.js`.
```

- [ ] **Step 6: Staging**

```bash
git add client/host/audio-logic.js tools/test-audio.js CLAUDE.md
```

**NON creare commit.** Regola dell'utente su questo progetto.

---

### Task 2: Manifest e scheletro del motore

**Files:**
- Create: `resources/audio/manifest.json`
- Create: `client/host/audio.js`
- Modify: `client/host/index.html:380-382`

**Interfaces:**
- Consumes: `window.AudioLogic` da Task 1.
- Produces: globale `window.GameAudio` con `arm()`, `stop()`, `setPhase(phase)`, `toggleMute()`, `isMuted()`, `isAvailable()`. In questo task `setPhase` esiste ma non produce ancora suono: i canali arrivano nei Task 3-5.

- [ ] **Step 1: Creare il manifest iniziale vuoto**

Creare `resources/audio/manifest.json`:

```json
{
  "music": {},
  "vo": {},
  "sfx": {}
}
```

Un catalogo vuoto è uno stato legittimo e permanente: il gioco deve essere pienamente funzionante in silenzio mentre l'utente produce gli asset.

- [ ] **Step 2: Creare lo scheletro del motore**

Creare `client/host/audio.js`:

```js
'use strict';

/**
 * client/host/audio.js
 *
 * Motore audio del pannello host. Unica superficie usata da app.js.
 * Le decisioni (quale variante, quando il crescendo, che volume) stanno in
 * audio-logic.js; qui c'è solo l'I/O verso <audio> e Web Audio API.
 *
 * Principio non negoziabile: nessun errore di questo modulo può risalire agli
 * handler socket. Ogni funzione pubblica è un no-op se il comparto è disabilitato.
 */

const GameAudio = (function () {
  const L = window.AudioLogic;

  const MANIFEST_URL = '/resources/audio/manifest.json';
  const ASSET_BASE   = '/resources/audio/';
  const MUTE_KEY     = 'quizzata.audio.muted';

  const state = {
    armed: false,
    available: true,   // false = errore fatale, comparto spento in silenzio
    muted: false,
    manifest: { music: {}, vo: {}, sfx: {}, errors: [] },
    phase: null,
    phaseToken: 0,     // incrementato a ogni cambio fase, usato per scartare VO stantie
    ducked: false,
    blocked: false,    // il browser ha rifiutato la riproduzione: serve un altro click
  };

  /**
   * Segnala che l'autoplay è stato rifiutato. La UI (app.js) ascolta l'evento e
   * mette il pulsante mute in stato "bloccato": senza questo, il comparto
   * sembrerebbe semplicemente rotto.
   */
  function markBlocked() {
    if (state.blocked) return;
    state.blocked = true;
    safe(() => window.dispatchEvent(new CustomEvent('gameaudio:blocked')));
  }

  // ─── Utilità ───────────────────────────────────────────────────────────────

  function url(file) {
    return ASSET_BASE + file;
  }

  /** Esegue fn ingoiando qualunque errore: l'audio non rompe mai la partita. */
  function safe(fn) {
    try {
      return fn();
    } catch (err) {
      console.warn('[audio] errore contenuto:', err);
      return undefined;
    }
  }

  function loadMuted() {
    return safe(() => localStorage.getItem(MUTE_KEY) === '1') === true;
  }

  function saveMuted(v) {
    safe(() => localStorage.setItem(MUTE_KEY, v ? '1' : '0'));
  }

  // ─── Manifest ──────────────────────────────────────────────────────────────

  async function loadManifest() {
    try {
      const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      state.manifest = L.validateManifest(raw);
      if (state.manifest.errors.length > 0) {
        console.warn('[audio] manifest con problemi:', state.manifest.errors);
      }
    } catch (err) {
      // Manifest assente o malformato: catalogo vuoto, gioco invariato.
      console.warn('[audio] manifest non caricato, comparto silenzioso:', err);
      state.manifest = L.validateManifest(null);
    }
  }

  // ─── API pubblica ──────────────────────────────────────────────────────────

  /**
   * Va chiamata da un gestore di click reale: i browser bloccano l'audio non
   * preceduto da un gesto dell'utente. Idempotente.
   */
  function arm() {
    if (state.armed || !state.available) return;
    state.armed = true;
    state.muted = loadMuted();
    safe(() => loadManifest());
  }

  function stop() {
    if (!state.armed) return;
    state.phase = null;
    state.phaseToken++;
    // I canali agganciano qui il proprio arresto (Task 3-5).
  }

  function setPhase(phase) {
    if (!state.armed || !state.available) return;
    if (phase === state.phase) return;
    state.phase = phase;
    state.phaseToken++;   // invalida ogni battuta vocale ancora in coda
  }

  function toggleMute() {
    state.muted = !state.muted;
    saveMuted(state.muted);
    return state.muted;
  }

  function isMuted()     { return state.muted; }
  function isAvailable() { return state.available && state.armed; }

  return { arm, stop, setPhase, toggleMute, isMuted, isAvailable, _state: state };
})();
```

`_state` è esposto deliberatamente: è l'unico modo di ispezionare il motore dalla console durante la verifica manuale dei task successivi.

- [ ] **Step 3: Caricare i due script**

In `client/host/index.html`, sostituire il blocco alle righe 380-382:

```html
  <script src="/socket.io/socket.io.js"></script>
  <script src="vendor/qrcode.js"></script>
  <script src="app.js"></script>
```

con:

```html
  <script src="/socket.io/socket.io.js"></script>
  <script src="vendor/qrcode.js"></script>
  <script src="audio-logic.js"></script>
  <script src="audio.js"></script>
  <script src="app.js"></script>
```

L'ordine è vincolante: `audio.js` legge `window.AudioLogic` al momento della definizione, e `app.js` usa `window.GameAudio`.

- [ ] **Step 4: Verifica manuale nel browser**

Avviare il dev server (`preview_start` sulla configurazione "Quiz-Zata Server (dev)") e aprire `/admin-console`. Nella console del browser:

```js
GameAudio.isAvailable()   // → false (non ancora armato)
GameAudio.arm()
GameAudio._state.manifest // → { music: {}, vo: {}, sfx: {}, errors: [] }
GameAudio.toggleMute()    // → true
```

Ricaricare la pagina, poi `GameAudio.arm(); GameAudio.isMuted()` → deve restituire `true` (stato persistito).

Atteso inoltre: nessun errore in console, e la dashboard host funziona esattamente come prima.

- [ ] **Step 5: Verifica del percorso degradato**

Rinominare temporaneamente `resources/audio/manifest.json` in `manifest.json.bak`, ricaricare, `GameAudio.arm()`. Atteso: un `console.warn` (non un errore), `_state.manifest` con catalogo vuoto, dashboard invariata. Ripristinare il nome.

- [ ] **Step 6: Staging**

```bash
git add resources/audio/manifest.json client/host/audio.js client/host/index.html
```

**NON creare commit.**

---

### Task 3: Canale musica (letto + tensione)

**Files:**
- Modify: `client/host/audio.js`

**Interfaces:**
- Consumes: `L.tensionPlan`, `L.resolveGain`, `L.RAMP_MS`, `L.TENSION_FINAL_S` da Task 1; `state`, `safe()`, `url()` da Task 2.
- Produces: `setPhase('lobby'|'results'|'final')` fa suonare `bed`; `startQuestionMusic(endsAt)` avvia loop + crescendo; `setDucked(bool)` per il Task 4.

Chiavi manifest usate: `music.bed`, `music.tension-loop`, `music.tension-final`.

- [ ] **Step 1: Aggiungere il canale musica**

In `client/host/audio.js`, inserire prima del blocco `// ─── API pubblica ───`:

```js
  // ─── Canale musica ─────────────────────────────────────────────────────────

  const music = {
    el: null,          // <audio> corrente
    key: null,         // chiave manifest in riproduzione
    ramp: null,        // id requestAnimationFrame della rampa in corso
    finalTimer: null,  // setTimeout per l'ingresso del crescendo
  };

  function musicTarget(key) {
    const entry = state.manifest.music[key];
    if (!entry) return 0;
    return L.resolveGain({
      channel: 'music', assetGain: entry.gain, muted: state.muted, ducked: state.ducked,
    });
  }

  /** Rampa lineare del volume. Una rampa in corso viene annullata dalla nuova. */
  function rampTo(el, target, ms, onDone) {
    if (music.ramp) cancelAnimationFrame(music.ramp);
    const from = el.volume;
    const t0 = performance.now();
    if (ms <= 0 || from === target) {
      el.volume = Math.min(1, Math.max(0, target));
      if (onDone) onDone();
      return;
    }
    function frame(t) {
      const k = Math.min(1, (t - t0) / ms);
      el.volume = Math.min(1, Math.max(0, from + (target - from) * k));
      if (k < 1) music.ramp = requestAnimationFrame(frame);
      else { music.ramp = null; if (onDone) onDone(); }
    }
    music.ramp = requestAnimationFrame(frame);
  }

  function clearFinalTimer() {
    if (music.finalTimer) { clearTimeout(music.finalTimer); music.finalTimer = null; }
  }

  /**
   * Sostituisce la traccia in riproduzione con quella indicata, in crossfade.
   * @param {string} key chiave del manifest
   * @param {{loop?: boolean, seekS?: number}} opts
   */
  function playMusic(key, opts = {}) {
    const entry = state.manifest.music[key];
    if (!entry) { stopMusic(); return; }
    if (music.key === key && music.el && !music.el.paused) return;

    const previous = music.el;
    const el = new Audio(url(entry.file));
    el.loop = opts.loop !== false;
    el.volume = 0;
    el.addEventListener('error', () => {
      console.warn(`[audio] traccia non disponibile: ${entry.file}`);
      if (music.el === el) { music.el = null; music.key = null; }
    });
    if (opts.seekS) {
      el.addEventListener('loadedmetadata', () => safe(() => { el.currentTime = opts.seekS; }), { once: true });
    }

    music.el = el;
    music.key = key;

    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        console.warn('[audio] riproduzione musica rifiutata:', err);
        markBlocked();
      });
    }
    rampTo(el, musicTarget(key), L.RAMP_MS);

    if (previous) {
      // Il crossfade usa una rampa propria: rampTo() governa un solo elemento.
      fadeOutAndStop(previous);
    }
  }

  function fadeOutAndStop(el) {
    const from = el.volume;
    const t0 = performance.now();
    function frame(t) {
      const k = Math.min(1, (t - t0) / L.RAMP_MS);
      el.volume = Math.max(0, from * (1 - k));
      if (k < 1) requestAnimationFrame(frame);
      else safe(() => { el.pause(); el.src = ''; });
    }
    requestAnimationFrame(frame);
  }

  function stopMusic() {
    clearFinalTimer();
    if (music.ramp) { cancelAnimationFrame(music.ramp); music.ramp = null; }
    if (music.el) { fadeOutAndStop(music.el); music.el = null; music.key = null; }
  }

  /** Avvia loop di tensione e crescendo sincronizzato sulla fine del countdown. */
  function startQuestionMusic(endsAt) {
    clearFinalTimer();
    const plan = L.tensionPlan({
      endsAt, now: Date.now(), finalDurationS: L.TENSION_FINAL_S,
    });
    if (plan.skip) { stopMusic(); return; }

    if (plan.useLoop) {
      playMusic('tension-loop', { loop: true });
      music.finalTimer = setTimeout(() => {
        playMusic('tension-final', { loop: false });
      }, plan.finalDelayMs);
    } else {
      playMusic('tension-final', { loop: false, seekS: plan.finalSeekS });
    }
  }

  /** Applica il volume corrente alla traccia in riproduzione (mute/duck cambiati). */
  function refreshMusicVolume() {
    if (music.el && music.key) rampTo(music.el, musicTarget(music.key), L.RAMP_MS);
  }

  function setDucked(v) {
    if (state.ducked === v) return;
    state.ducked = v;
    refreshMusicVolume();
  }
```

- [ ] **Step 2: Collegare le fasi al canale**

Sostituire il corpo di `setPhase` e `stop` con:

```js
  function stop() {
    if (!state.armed) return;
    state.phase = null;
    state.phaseToken++;
    stopMusic();
  }

  function setPhase(phase) {
    if (!state.armed || !state.available) return;
    if (phase === state.phase) return;
    state.phase = phase;
    state.phaseToken++;   // invalida ogni battuta vocale ancora in coda
    clearFinalTimer();

    if (phase === 'lobby' || phase === 'results' || phase === 'final') {
      playMusic('bed', { loop: true });
    }
    // 'question' non passa di qui: la musica di tensione ha bisogno di endsAt e
    // viene avviata da startQuestionMusic().
  }
```

Aggiungere anche la ripartenza dopo un blocco dell'autoplay:

```js
  /**
   * Riprova dopo un rifiuto dell'autoplay. Va chiamata da un gestore di click:
   * il click stesso è il gesto che il browser pretende.
   */
  function retry() {
    if (!state.blocked) return;
    state.blocked = false;
    const phase = state.phase;
    state.phase = null;      // forza setPhase a non uscire per fase invariata
    if (phase) setPhase(phase);
  }
```

Aggiungere `startQuestionMusic`, `setDucked` e `retry` all'oggetto restituito:

```js
  return {
    arm, stop, setPhase, toggleMute, isMuted, isAvailable,
    startQuestionMusic, setDucked, retry,
    _state: state,
  };
```

- [ ] **Step 3: Aggiornare `toggleMute` perché agisca subito**

Sostituire `toggleMute` con:

```js
  function toggleMute() {
    state.muted = !state.muted;
    saveMuted(state.muted);
    refreshMusicVolume();
    return state.muted;
  }
```

- [ ] **Step 4: Preparare tre asset di prova**

Il canale non è verificabile senza file. Generare tre tracce segnaposto **qualsiasi** (anche tre toni diversi esportati da un qualunque strumento web) e salvarle come `resources/audio/music/bed.ogg`, `tension-loop.ogg`, `tension-final.ogg`, con `tension-final.ogg` di **esattamente 10 secondi**. Sono materiale di lavoro, non asset finali.

Scrivere in `resources/audio/manifest.json`:

```json
{
  "music": {
    "bed":           { "file": "music/bed.ogg", "gain": 1.0 },
    "tension-loop":  { "file": "music/tension-loop.ogg", "gain": 1.0 },
    "tension-final": { "file": "music/tension-final.ogg", "gain": 1.0 }
  },
  "vo": {},
  "sfx": {}
}
```

- [ ] **Step 5: Verifica manuale della sincronia**

Nella console del pannello host, dopo `GameAudio.arm()`:

```js
GameAudio.setPhase('lobby')                              // bed parte in dissolvenza
GameAudio.startQuestionMusic(Date.now() + 20000)         // loop, poi crescendo a T-10
GameAudio.startQuestionMusic(Date.now() + 5000)          // solo crescendo, entra a metà
GameAudio.setDucked(true)                                // volume crolla
GameAudio.setDucked(false)                               // risale
```

Atteso, cronometro alla mano: con `+20000` il passaggio da loop a crescendo avviene a **10 secondi** dalla chiamata, e il crescendo finisce a 20. Con `+5000` il crescendo parte subito già a metà e finisce a 5. Ogni cambio di volume è una rampa udibile, mai un salto.

- [ ] **Step 6: Verifica del percorso degradato**

Rimuovere `tension-final` dal manifest e ripetere `startQuestionMusic(Date.now() + 20000)`. Atteso: il loop suona, il crescendo non arriva, **nessun errore in console**, nessun blocco.

- [ ] **Step 7: Staging**

```bash
git add client/host/audio.js resources/audio/manifest.json resources/audio/music/
```

**NON creare commit.**

---

### Task 4: Canale voce con coda e scadenza

**Files:**
- Modify: `client/host/audio.js`

**Interfaces:**
- Consumes: `L.pickVariant`, `L.isStale`, `L.resolveGain` da Task 1; `setDucked` da Task 3.
- Produces: `say(eventKey)` — accoda una battuta; `sayNow(eventKey)` — interrompe quella in corso. Chiavi manifest: qualunque chiave sotto `vo`.

- [ ] **Step 1: Aggiungere il canale voce**

In `client/host/audio.js`, inserire dopo il canale musica:

```js
  // ─── Canale voce ───────────────────────────────────────────────────────────

  const vo = {
    el: null,              // battuta in riproduzione
    queued: null,          // { key, token } — profondità massima 1
    lastIndex: {},         // chiave evento → indice ultima variante usata
  };

  function pickVoEntry(key) {
    const list = state.manifest.vo[key];
    if (!list || list.length === 0) return null;
    const last = vo.lastIndex[key] ?? -1;
    const idx = L.pickVariant(list.length, last, Math.random);
    if (idx < 0) return null;
    vo.lastIndex[key] = idx;
    return list[idx];
  }

  function finishVo() {
    vo.el = null;
    const next = vo.queued;
    vo.queued = null;
    if (next && !L.isStale(next.token, state.phaseToken)) {
      startVo(next.key);
    } else {
      setDucked(false);
    }
  }

  function startVo(key) {
    const entry = pickVoEntry(key);
    if (!entry) { setDucked(false); return; }

    const el = new Audio(url(entry.file));
    el.volume = L.resolveGain({
      channel: 'vo', assetGain: entry.gain, muted: state.muted, ducked: false,
    });
    el.addEventListener('ended', finishVo, { once: true });
    el.addEventListener('error', () => {
      console.warn(`[audio] battuta non disponibile: ${entry.file}`);
      finishVo();
    }, { once: true });

    vo.el = el;
    setDucked(true);

    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => { console.warn('[audio] voce rifiutata:', err); markBlocked(); finishVo(); });
    }
  }

  function stopVo() {
    vo.queued = null;
    if (vo.el) {
      const el = vo.el;
      vo.el = null;
      safe(() => { el.pause(); el.src = ''; });
    }
    setDucked(false);
  }

  /**
   * Accoda una battuta. Profondità massima 1: se c'è già un'attesa, la nuova la
   * sostituisce. Ogni battuta porta il token della fase in cui è nata e viene
   * scartata se la fase è cambiata prima che parta.
   */
  function say(key) {
    if (!state.armed || !state.available || state.muted) return;
    if (!state.manifest.vo[key]) return;
    if (vo.el) { vo.queued = { key, token: state.phaseToken }; return; }
    startVo(key);
  }

  /** Interrompe la battuta in corso e parte subito. Per gli eventi che non aspettano. */
  function sayNow(key) {
    if (!state.armed || !state.available || state.muted) return;
    if (!state.manifest.vo[key]) return;
    stopVo();
    startVo(key);
  }
```

- [ ] **Step 2: Fermare la voce ai cambi di fase e allo stop**

In `setPhase`, aggiungere `stopVo();` subito dopo `clearFinalTimer();`.
In `stop`, aggiungere `stopVo();` subito dopo `stopMusic();`.

In `toggleMute`, aggiungere `if (state.muted) stopVo();` prima del `return state.muted;` — mutare durante una battuta deve zittirla, non solo abbassarla.

Aggiungere all'oggetto restituito:

```js
  return {
    arm, stop, setPhase, toggleMute, isMuted, isAvailable,
    startQuestionMusic, setDucked, retry, say, sayNow,
    _state: state,
  };
```

- [ ] **Step 3: Preparare due battute di prova**

Generare due file vocali qualsiasi (anche da TTS online) e salvarli come
`resources/audio/vo/test-01.mp3` e `resources/audio/vo/test-02.mp3`. Aggiungere al manifest sotto `vo`:

```json
  "vo": {
    "test": [
      { "file": "vo/test-01.mp3", "gain": 1.0 },
      { "file": "vo/test-02.mp3", "gain": 1.0 }
    ]
  },
```

- [ ] **Step 4: Verifica manuale della coda e del ducking**

Con `GameAudio.arm()` e `setPhase('lobby')` (musica in corso):

```js
GameAudio.say('test')            // la musica scende, la voce parla, la musica risale
GameAudio.say('test'); GameAudio.say('test')   // la seconda parte dopo la prima, mai sovrapposte
```

Poi la verifica della scadenza — è il comportamento centrale del canale:

```js
GameAudio.say('test'); GameAudio.say('test'); GameAudio.setPhase('results')
```

Atteso: la battuta in corso si interrompe, **quella in coda non suona mai**. La musica torna a volume pieno.

Verificare infine che ripetendo `GameAudio.say('test')` una decina di volte non esca mai la stessa variante due volte di fila.

- [ ] **Step 5: Staging**

```bash
git add client/host/audio.js resources/audio/manifest.json resources/audio/vo/
```

**NON creare commit.**

---

### Task 5: Canale effetti (Web Audio)

**Files:**
- Modify: `client/host/audio.js`

**Interfaces:**
- Consumes: `L.pickVariant`, `L.resolveGain` da Task 1.
- Produces: `sfx(eventKey)` — riproduzione istantanea e sovrapponibile. Chiavi manifest: qualunque chiave sotto `sfx`.

Gli effetti usano Web Audio invece di `<audio>` perché devono partire senza ritardo percepibile e potersi sovrapporre: un `<audio>` decodifica alla prima riproduzione, e il ritardo è udibile soprattutto sul Raspberry.

- [ ] **Step 1: Aggiungere il canale effetti**

In `client/host/audio.js`, inserire dopo il canale voce:

```js
  // ─── Canale effetti ────────────────────────────────────────────────────────

  const sfxState = {
    ctx: null,
    buffers: new Map(),   // "chiave#indice" → AudioBuffer
    lastIndex: {},
  };

  function ensureContext() {
    if (sfxState.ctx) return sfxState.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { console.warn('[audio] Web Audio non disponibile, effetti disattivati'); return null; }
    sfxState.ctx = safe(() => new Ctx()) || null;
    return sfxState.ctx;
  }

  /** Scarica e decodifica tutti gli effetti del manifest. Ogni fallimento è isolato. */
  async function preloadSfx() {
    const ctx = ensureContext();
    if (!ctx) return;
    const jobs = [];
    for (const key of Object.keys(state.manifest.sfx)) {
      state.manifest.sfx[key].forEach((entry, i) => {
        jobs.push((async () => {
          try {
            const res = await fetch(url(entry.file));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const bytes = await res.arrayBuffer();
            const buf = await ctx.decodeAudioData(bytes);
            sfxState.buffers.set(`${key}#${i}`, buf);
          } catch (err) {
            console.warn(`[audio] effetto non caricato: ${entry.file}`, err);
          }
        })());
      });
    }
    await Promise.all(jobs);
  }

  /** Riproduce un effetto. Nessuna coda: le sovrapposizioni sono ammesse. */
  function sfx(key) {
    if (!state.armed || !state.available || state.muted) return;
    const list = state.manifest.sfx[key];
    if (!list || list.length === 0) return;
    const ctx = sfxState.ctx;
    if (!ctx) return;

    const last = sfxState.lastIndex[key] ?? -1;
    const idx = L.pickVariant(list.length, last, Math.random);
    if (idx < 0) return;
    sfxState.lastIndex[key] = idx;

    const buf = sfxState.buffers.get(`${key}#${idx}`);
    if (!buf) return;   // non caricato: silenzio, non errore

    safe(() => {
      if (ctx.state === 'suspended') ctx.resume();
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      src.buffer = buf;
      gain.gain.value = L.resolveGain({
        channel: 'sfx', assetGain: list[idx].gain, muted: state.muted, ducked: false,
      });
      src.connect(gain).connect(ctx.destination);
      src.start(0);
    });
  }
```

- [ ] **Step 2: Avviare il precaricamento in `arm()`**

Sostituire il corpo di `arm()` con:

```js
  function arm() {
    if (state.armed || !state.available) return;
    state.armed = true;
    state.muted = loadMuted();
    // Il precaricamento degli effetti deve seguire il manifest, non precederlo.
    safe(() => loadManifest().then(() => preloadSfx()));
  }
```

Aggiungere `sfx` all'oggetto restituito:

```js
  return {
    arm, stop, setPhase, toggleMute, isMuted, isAvailable,
    startQuestionMusic, setDucked, retry, say, sayNow, sfx,
    _state: state,
  };
```

- [ ] **Step 3: Preparare due effetti di prova**

Salvare due suoni brevi qualsiasi come `resources/audio/sfx/test-01.mp3` e `test-02.mp3`, e aggiungerli al manifest sotto `sfx`:

```json
  "sfx": {
    "test": [
      { "file": "sfx/test-01.mp3", "gain": 1.0 },
      { "file": "sfx/test-02.mp3", "gain": 1.0 }
    ]
  }
```

- [ ] **Step 4: Verifica manuale**

Ricaricare, `GameAudio.arm()`, attendere un istante, poi nella console:

```js
GameAudio._state.manifest.sfx           // deve contenere "test"
GameAudio.sfx('test')                   // suono immediato, nessun ritardo
for (let i = 0; i < 5; i++) GameAudio.sfx('test')   // cinque suoni sovrapposti
```

Atteso: la **prima** riproduzione è istantanea quanto le successive — è il motivo per cui si usa Web Audio. Le sovrapposizioni non si troncano a vicenda.

- [ ] **Step 5: Verifica del percorso degradato**

Aggiungere al manifest un effetto che punta a un file inesistente, ricaricare. Atteso: un `console.warn` in fase di precaricamento, `GameAudio.sfx('chiave-rotta')` silenzioso, tutti gli altri effetti funzionanti.

- [ ] **Step 6: Staging**

```bash
git add client/host/audio.js resources/audio/manifest.json resources/audio/sfx/
```

**NON creare commit.**

---

### Task 6: Pulsante mute nell'header

**Files:**
- Modify: `client/host/index.html:301-303`
- Modify: `client/host/style.css` (dopo la regola `.game-timer-badge`, riga ~1921)

**Interfaces:**
- Consumes: `GameAudio.toggleMute()`, `GameAudio.isMuted()` da Task 2-3.
- Produces: elemento `#game-mute-btn`, cablato in `app.js` nel Task 7.

- [ ] **Step 1: Aggiungere il pulsante**

In `client/host/index.html`, sostituire il blocco righe 301-303:

```html
          <div class="game-timer-wrapper">
            <div class="game-timer-badge" id="game-timer-badge">00:00</div>
          </div>
```

con:

```html
          <div class="game-timer-wrapper">
            <button type="button" id="game-mute-btn" class="game-mute-btn"
                    aria-label="Disattiva l'audio" aria-pressed="false">
              <i class="fas fa-volume-high" aria-hidden="true"></i>
            </button>
            <div class="game-timer-badge" id="game-timer-badge">00:00</div>
          </div>
```

- [ ] **Step 2: Aggiungere lo stile**

In `client/host/style.css`, subito dopo la chiusura di `.game-timer-badge` (riga ~1921), inserire:

```css
/* ── Toggle mute audio ── */
.game-mute-btn {
  background: var(--surface);
  color: var(--retro-dark);
  font-family: var(--font-family);
  font-size: var(--text-body-lg, 1rem);
  line-height: 1;
  padding: 0.5rem 0.7rem;
  border-radius: var(--radius-base);
  border: 4px solid var(--retro-dark);
  box-shadow: var(--retro-shadow-sm);
  transform: rotate(-2deg);
  cursor: pointer;
  transition: transform 0.08s ease, box-shadow 0.08s ease;
}

.game-mute-btn:active {
  transform: rotate(-2deg) translate(2px, 2px);
  box-shadow: none;
}

/* Stato mutato: superficie spenta, coerente con i badge disattivati */
.game-mute-btn[aria-pressed="true"] {
  background: var(--surface-dim);
  color: var(--retro-dark);
  opacity: 0.75;
}

/* Autoplay bloccato dal browser: invita al click invece di sembrare rotto */
.game-mute-btn.is-blocked {
  background: var(--retro-yellow, var(--surface));
  animation: mute-blocked-pulse 1.2s ease-in-out infinite;
}

@keyframes mute-blocked-pulse {
  0%, 100% { transform: rotate(-2deg) scale(1); }
  50%      { transform: rotate(-2deg) scale(1.06); }
}

@media (prefers-reduced-motion: reduce) {
  .game-mute-btn.is-blocked { animation: none; }
}
```

Se `--retro-yellow` o `--surface-dim` non esistono con questi nomi, usare i token equivalenti già presenti nel file: **non introdurre token nuovi**. Verificare con una ricerca di `--retro-` in cima a `style.css`.

- [ ] **Step 3: Verifica manuale**

Aprire una partita nel pannello host. Atteso: il pulsante compare a sinistra del timer, con bordo 4px e ombra piatta coerenti con `.game-timer-badge`; alla pressione si abbassa di 2px e perde l'ombra; `prefers-reduced-motion` attivo annulla la pulsazione.

Verificare il contrasto del testo sull'icona in entrambi gli stati (WCAG AA, ≥4.5:1) con lo strumento di ispezione del browser.

- [ ] **Step 4: Staging**

```bash
git add client/host/index.html client/host/style.css
```

**NON creare commit.**

---

### Task 7: Agganci in `app.js`

**Files:**
- Modify: `client/host/app.js` — righe 1078, 1111, 1113, 1156, 1160, 1224, 1267

**Interfaces:**
- Consumes: l'intera superficie `GameAudio` dei Task 2-5, `#game-mute-btn` dal Task 6, `L.SUSPENSE_MS` dal Task 1.
- Produces: nulla — è il task che chiude il cablaggio.

Chiavi evento introdotte qui (da riempire nel manifest quando gli asset esisteranno): VO `lobby-qr`, `game-start`, `first-question`, `reveal-rullo`, `winner`; SFX `player-joined`, `answer-received`, `reveal`, `podium`.

- [ ] **Step 1: Armare l'audio all'apertura della partita**

In `openGame()` (riga 1078), dopo `state.currentQuiz = quiz;` aggiungere:

```js
  // Il click che ha aperto la partita è il gesto utente che sblocca l'autoplay.
  GameAudio.arm();
```

- [ ] **Step 2: Lobby, ingresso giocatori, voce di benvenuto**

Sostituire la riga 1111:

```js
  gameSocket.on('game:lobby-update', ({ players }) => renderGameLobby(players));
```

con:

```js
  let lastPlayerCount = 0;
  gameSocket.on('game:lobby-update', ({ players }) => {
    renderGameLobby(players);
    GameAudio.setPhase('lobby');
    // Effetto solo sugli ingressi, non sulle uscite né sul primo render.
    if (players.length > lastPlayerCount) GameAudio.sfx('player-joined');
    lastPlayerCount = players.length;
  });
```

Nell'ack di `host:create-game` (riga ~1106), dopo `renderGameLobby([]);` aggiungere:

```js
      GameAudio.setPhase('lobby');
      GameAudio.say('lobby-qr');
```

- [ ] **Step 3: Domanda — tensione e voce**

Dentro l'handler `game:question` (riga 1113), subito dopo `startGameCountdown(q.endsAt);` aggiungere:

```js
    GameAudio.setPhase('question');
    GameAudio.startQuestionMusic(q.endsAt);
    // Nessun contenuto dinamico: "prima domanda" è una riga fissa, distinta
    // solo dall'indice del round.
    if (q.index === 0) GameAudio.say('first-question');
```

`setPhase('question')` non avvia musica da sé (vedi Task 3): serve a incrementare il token di fase e a scartare le battute stantie.

- [ ] **Step 4: Effetto sulle risposte in arrivo**

Sostituire l'handler `game:answer-count` (riga 1156):

```js
  gameSocket.on('game:answer-count', ({ answered, total }) => {
    gameAnswerCount.textContent = `Risposte: ${answered} / ${total}`;
  });
```

con:

```js
  let lastAnswered = 0;
  gameSocket.on('game:answer-count', ({ answered, total }) => {
    gameAnswerCount.textContent = `Risposte: ${answered} / ${total}`;
    if (answered > lastAnswered) GameAudio.sfx('answer-received');
    lastAnswered = answered;
  });
```

Reimpostare il contatore all'inizio di ogni domanda: dentro l'handler `game:question`, accanto a `gameAnswerCount.textContent = 'Risposte: 0 / ?';`, aggiungere `lastAnswered = 0;`.

- [ ] **Step 5: Sospensione e reveal**

Nell'handler `game:results` (riga 1160), avvolgere il corpo esistente in una pausa. Sostituire l'apertura:

```js
  gameSocket.on('game:results', (results) => {
    stopGameCountdown();
    stopMinigameSuspense();
```

con:

```js
  gameSocket.on('game:results', (results) => {
    stopGameCountdown();
    stopMinigameSuspense();
    // Rullo di tamburi: breve sospensione prima di scoprire la risposta.
    // Nota: i player vedono il proprio esito sul telefono subito, quindi la
    // finestra è volutamente corta (vedi §7 dello spec).
    GameAudio.say('reveal-rullo');
    setTimeout(() => revealResults(results), AudioLogic.SUSPENSE_MS);
  });

  function revealResults(results) {
```

e chiudere: la parentesi finale dell'handler originale — `});` — diventa `}`, perché ora chiude una funzione dichiarata e non più un callback.

All'interno di `revealResults`, subito dopo `gameStatusText.textContent = 'Round chiuso: risultati sul tabellone.';` aggiungere:

```js
    GameAudio.setPhase('results');
    GameAudio.sfx('reveal');
```

> **Attenzione al refactor:** `revealResults` è dichiarata dentro `connectGameSocket` per restare nella stessa chiusura di `currentQuestionOptions`, `gameCorrectAnswer` e delle altre variabili che il corpo usa. Non spostarla fuori.

- [ ] **Step 6: Classifica finale**

Nell'handler `game:final` (riga 1224), all'inizio del corpo aggiungere:

```js
    GameAudio.setPhase('final');
    GameAudio.sfx('podium');
    // La frase si ferma prima del nome: il vincitore lo mostra il podio.
    GameAudio.say('winner');
```

- [ ] **Step 7: Arresto all'uscita**

In `disconnectGameSocket()` (riga 1267), come prima istruzione del corpo:

```js
  GameAudio.stop();
```

- [ ] **Step 8: Cablare il pulsante mute**

Accanto agli altri riferimenti DOM in cima al file, aggiungere:

```js
const gameMuteBtn = document.getElementById('game-mute-btn');
```

e, vicino agli altri `addEventListener` di inizializzazione:

```js
if (gameMuteBtn) {
  gameMuteBtn.addEventListener('click', () => {
    // Se il browser aveva rifiutato l'autoplay, questo click È il gesto utente
    // che mancava: si riparte invece di mutare.
    if (gameMuteBtn.classList.contains('is-blocked')) {
      gameMuteBtn.classList.remove('is-blocked');
      GameAudio.retry();
      return;
    }
    const muted = GameAudio.toggleMute();
    gameMuteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    gameMuteBtn.setAttribute('aria-label', muted ? "Riattiva l'audio" : "Disattiva l'audio");
    gameMuteBtn.querySelector('i').className = muted ? 'fas fa-volume-xmark' : 'fas fa-volume-high';
  });

  window.addEventListener('gameaudio:blocked', () => {
    gameMuteBtn.classList.add('is-blocked');
    gameMuteBtn.setAttribute('aria-label', "Audio bloccato dal browser: clicca per attivarlo");
  });
}
```

- [ ] **Step 9: Verifica manuale — partita completa**

Creare un host se non esiste (`node tools/create-host.js`), avviare il dev server, aprire `/admin-console`, avviare una partita con **almeno due domande di durata diversa** (una da 5s e una da 20s) e unirsi da una seconda finestra come giocatore.

Verificare in sequenza:

1. All'apertura della partita: musica di lobby, battuta `lobby-qr` (se presente nel manifest).
2. All'ingresso del giocatore: effetto `player-joined`.
3. Alla domanda: la musica passa alla tensione; con 20s il crescendo entra a T-10; con 5s parte subito a metà.
4. Rispondendo dal telefono: effetto `answer-received`, e la domanda si chiude in anticipo troncando il crescendo — il taglio deve risultare coperto, non brutale.
5. `game:results`: **1,5 secondi** fra la fine della domanda e la comparsa della risposta corretta sul pannello host.
6. Alla fine: `podium` e `winner`, musica di lobby ripristinata.
7. Riavviando la partita (`host:restart-game`): si torna alla musica di lobby senza intervento.
8. Uscendo dalla partita: la musica sfuma e si ferma.
9. Il pulsante mute zittisce tutto, l'icona cambia, e lo stato sopravvive a un refresh.
10. **Autoplay bloccato:** nelle impostazioni del sito in Chrome impostare "Suono → Blocca" per `localhost:3000`, ricaricare e aprire una partita. Atteso: il pulsante mute passa in stato `is-blocked` (pulsante giallo che pulsa) e un click lo riporta a suonare invece di mutare. Ripristinare poi il permesso.

- [ ] **Step 10: Verifica con manifest vuoto — la più importante**

Riportare `resources/audio/manifest.json` a `{ "music": {}, "vo": {}, "sfx": {} }` e rigiocare una partita intera dall'inizio alla fine.

Atteso: **zero errori in console**, nessun blocco, tutti i tempi di gioco invariati tranne la sospensione di 1,5s prima del reveal, che resta anche senza asset. Questo è lo stato in cui il progetto vive finché l'utente non produce il materiale, quindi deve essere impeccabile.

- [ ] **Step 11: Staging**

```bash
git add client/host/app.js
```

**NON creare commit.**

---

### Task 8: Pagina di calibrazione dei livelli

**Files:**
- Create: `tools/audio-calibration.html`

**Interfaces:**
- Consumes: nulla — pagina autonoma, non fa parte dell'applicazione servita.
- Produces: nulla per il codice; produce i valori `gain` che l'utente scrive a mano nel manifest.

Serve perché la filiera di produzione dell'utente è solo web, senza software installato: la normalizzazione distruttiva (`ffmpeg loudnorm`) non è praticabile, quindi i livelli si allineano con un guadagno per-asset **misurato**, non indovinato.

- [ ] **Step 1: Creare la pagina**

Creare `tools/audio-calibration.html`:

```html
<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>Quiz-Zata! — Calibrazione livelli audio</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 60rem; margin: 2rem auto;
         padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  #drop { border: 4px dashed #333; border-radius: 8px; padding: 3rem 1rem;
          text-align: center; color: #555; margin: 1.5rem 0; }
  #drop.over { background: #f2f2f2; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid #ddd; padding: 0.5rem; text-align: left;
           font-variant-numeric: tabular-nums; }
  th { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.03em; }
  code { background: #f2f2f2; padding: 0.1rem 0.3rem; border-radius: 3px; }
  .hint { color: #666; font-size: 0.9rem; }
</style>
</head>
<body>

<h1>Calibrazione livelli audio</h1>

<p class="hint">
  Trascina qui i file audio (MP3, OGG, WAV). La pagina ne misura il volume percepito
  e calcola il <code>gain</code> da scrivere nel manifest perché suonino tutti allo
  stesso livello. Non modifica né riconverte i file: lavora solo in lettura.
</p>

<div id="drop">Trascina qui i file audio</div>

<p class="hint">
  Riferimento: <strong>il file più silenzioso resta a gain 1.0</strong> e gli altri
  vengono abbassati. Così nessun guadagno supera 1 e nulla va in distorsione.
</p>

<table id="out">
  <thead>
    <tr><th>File</th><th>RMS (dBFS)</th><th>Picco (dBFS)</th><th>gain</th></tr>
  </thead>
  <tbody></tbody>
</table>

<script>
const ctx  = new (window.AudioContext || window.webkitAudioContext)();
const drop = document.getElementById('drop');
const tbody = document.querySelector('#out tbody');
const measured = [];

drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  for (const file of e.dataTransfer.files) await measure(file);
  render();
});

/**
 * RMS su tutti i canali: approssima il volume percepito molto meglio del picco,
 * che è dominato da singoli transienti.
 */
async function measure(file) {
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    let sum = 0, count = 0, peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        sum += v * v;
        count++;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
    }
    const rms = Math.sqrt(sum / count);
    measured.push({ name: file.name, rms, peak });
  } catch (err) {
    measured.push({ name: file.name, error: String(err) });
  }
}

const dbfs = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

function render() {
  // Il file più silenzioso è il riferimento: tutti gli altri scendono verso di lui.
  const quietest = Math.min(...measured.filter((m) => !m.error).map((m) => m.rms));
  tbody.innerHTML = '';
  for (const m of measured) {
    const tr = document.createElement('tr');
    if (m.error) {
      tr.innerHTML = `<td>${m.name}</td><td colspan="3">non leggibile: ${m.error}</td>`;
    } else {
      const gain = Math.min(1, quietest / m.rms);
      tr.innerHTML =
        `<td>${m.name}</td>` +
        `<td>${dbfs(m.rms).toFixed(1)}</td>` +
        `<td>${dbfs(m.peak).toFixed(1)}</td>` +
        `<td><code>${gain.toFixed(3)}</code></td>`;
    }
    tbody.appendChild(tr);
  }
}
</script>

</body>
</html>
```

- [ ] **Step 2: Verifica manuale**

Aprire il file direttamente nel browser (doppio click, non serve il server) e trascinarci i file di prova dei Task 3-5.

Atteso: una riga per file con RMS, picco e guadagno; il file più silenzioso ha `gain` **1.000**; nessun guadagno supera 1. Trascinando un file non audio (per esempio un `.txt` rinominato) la riga riporta l'errore e le altre restano leggibili.

- [ ] **Step 3: Prova d'uso reale**

Prendere due file volutamente sbilanciati (uno molto più forte dell'altro), leggere i guadagni suggeriti, scriverli nel manifest e riascoltare nel pannello host. Atteso: i due suonano ora a volume percepito simile.

- [ ] **Step 4: Staging**

```bash
git add tools/audio-calibration.html
```

**NON creare commit.**

---

## Riepilogo verifica finale

Al termine degli otto task, con il manifest riempito con gli asset di prova:

```bash
"D:\ISTALLAZION_PROGRAMMI\node.exe" tools/test-audio.js
```

Atteso: `Falliti: 0`.

Poi una partita completa nel browser con due domande di durata diversa, un giocatore reale, e infine la **rigiocata con manifest vuoto** — quest'ultima è la verifica che protegge il progetto: finché l'utente non produce gli asset, il gioco vive in quello stato e deve essere indistinguibile da oggi tranne che per la sospensione prima del reveal.

## Cosa resta all'utente

Il piano consegna il sistema, non il contenuto. Restano da produrre:

- `music/bed.ogg`, `music/tension-loop.ogg`, `music/tension-final.ogg` (quest'ultimo di **10 secondi esatti**, e capace di reggere l'interruzione a metà).
- Le battute vocali per `lobby-qr`, `game-start`, `first-question`, `reveal-rullo`, `winner` — almeno 4 varianti per `reveal-rullo`, che si sente a ogni domanda.
- Gli effetti per `player-joined`, `answer-received`, `reveal`, `podium` — `answer-received` va tenuto brevissimo o omesso, è l'evento più frequente di tutti.

Ogni aggiunta è **un file più una riga nel manifest**: nessuna modifica al codice.
