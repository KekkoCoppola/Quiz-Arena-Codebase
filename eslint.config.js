'use strict';

/**
 * eslint.config.js
 *
 * Configurazione "flat" di ESLint (v9+). Serve a `npm run lint`, che prima di
 * questo file falliva con "ESLint couldn't find an eslint.config.* file": uno
 * script dichiarato che non partiva mai.
 *
 * Due scelte deliberate, nello spirito del resto del progetto:
 *
 *  - **Nessuna dipendenza nuova.** Non si importa `@eslint/js` né un preset:
 *    le regole sono scritte qui a mano. `npx eslint` scarica il solo binario
 *    al momento, e il repo non guadagna un altro pacchetto da compilare o da
 *    portare su ARM. Per la stessa ragione ESLint non è in `devDependencies`.
 *
 *  - **Tre ambienti, non uno.** Il server e gli strumenti sono CommonJS su
 *    Node; i client sono script da browser senza bundler, che si vedono fra
 *    loro attraverso `window` (`Minigames`, `AvatarSprite`, `ServerClock`…).
 *    Con un ambiente solo, metà progetto risulterebbe pieno di falsi
 *    "non definito" e il referto diventerebbe inutile da leggere.
 *
 * Le regole sono poche e tutte su errori veri (variabili inesistenti, `case`
 * che cadono uno nell'altro, `await` dentro un ciclo che non lo aspetta). Lo
 * stile non è qui: non c'è un formattatore nel progetto, e una regola di
 * stile che nessuno può applicare automaticamente è solo rumore.
 */

const NODE_GLOBALS = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  URL: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  structuredClone: 'readonly',
  fetch: 'readonly',
};

const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  performance: 'readonly',
  Image: 'readonly',
  Audio: 'readonly',
  AudioContext: 'readonly',
  webkitAudioContext: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  FileReader: 'readonly',
  ResizeObserver: 'readonly',
  IntersectionObserver: 'readonly',
  MutationObserver: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  DOMParser: 'readonly',
  XMLHttpRequest: 'readonly',
  structuredClone: 'readonly',
  getComputedStyle: 'readonly',
  matchMedia: 'readonly',
  createImageBitmap: 'readonly',
  URLSearchParams: 'readonly',
  history: 'readonly',
  CSS: 'readonly',
  // Moduli del progetto che si trovano fra loro passando da `window`,
  // perché le tre SPA sono script semplici senza bundler.
  io: 'readonly',
  qrcode: 'readonly',
  Minigames: 'readonly',
  AvatarSprite: 'readonly',
  AvatarCatalog: 'readonly',
  ServerClock: 'readonly',
  AudioLogic: 'readonly',
  SalaAudio: 'readonly',
  QrArt: 'readonly',
  StageIntro: 'readonly',
  MinigameStageIntro: 'readonly',
  FinalSchedule: 'readonly',
  PodiumCeremony: 'readonly',
  MiiCharacter3D: 'readonly',
  AnswerRoster: 'readonly',
  ImageBudget: 'readonly',
  Confetti: 'readonly',
  // I moduli condivisi girano anche in Node, dentro i test: il wrapper UMD
  // nomina `module`, `require` e `self` prima di sapere dove si trova.
  module: 'writable',
  require: 'readonly',
  self: 'readonly',
  globalThis: 'readonly',
};

/** Regole uguali ovunque: solo cose che a runtime si rompono davvero. */
const RULES = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', {
    args: 'none',
    varsIgnorePattern: '^_',
    caughtErrors: 'none',
  }],
  // `builtinGlobals: false` perché ogni file dichiara da sé, con un commento
  // `/* global X */`, i moduli che gli arrivano da un altro `<script>`: senza,
  // ogni dichiarazione onesta risultava un doppione di quelle qui sopra.
  // Le vere ridichiarazioni dentro un file restano errori.
  'no-redeclare': ['error', { builtinGlobals: false }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-self-compare': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-cond-assign': 'error',
  'no-sparse-arrays': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'require-atomic-updates': 'warn',
  eqeqeq: ['warn', 'smart'],
};

module.exports = [
  {
    // Il repo non ha un formattatore, e diversi `eslint-disable` documentano
    // una scelta (la firma a 4 argomenti dell'error handler di Express, i due
    // _TEMPLATE pieni di segnaposto). Segnalarli come "direttiva inutile" a
    // ogni giro sarebbe rumore sopra un referto che deve restare leggibile.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    ignores: [
      'node_modules/**',
      'server/db/**',
      'resources/**',
      // three.js vendorizzato e qrcode.js: codice di terzi, minificato.
      'client/shared/vendor/**',
      'client/host/vendor/**',
      'client/sala/vendor/**',
    ],
  },

  // Server e strumenti da riga di comando: CommonJS su Node.
  {
    files: ['server/**/*.js', 'tools/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: RULES,
  },

  // Le tre SPA e il codice condiviso: script da browser, nessun bundler.
  {
    files: ['client/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: BROWSER_GLOBALS,
    },
    rules: RULES,
  },
];
