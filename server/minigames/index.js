'use strict';

/**
 * server/minigames/index.js
 *
 * Registry dei minigiochi — lato REGOLE (il lato presentazione vive in
 * client/shared/minigames/).
 *
 * Cosa fa questo file:
 *   1. carica automaticamente ogni modulo minigioco presente in questa cartella;
 *   2. ne verifica il contratto all'avvio del server, fallendo rumorosamente se
 *      un modulo è malformato;
 *   3. espone il sacchetto di estrazione (shuffle bag) per la chiamata casuale.
 *
 * Perché la validazione è severa: un minigioco rotto deve fermare il server
 * all'avvio, mai comparire davanti a una sala piena durante un evento dal vivo.
 * Per questo il validatore non si limita a guardare la forma dell'oggetto:
 * esegue davvero `build()` e `resolve()` una volta, a vuoto.
 *
 * ⚠ Conseguenza per chi scrive un minigioco: `build()` e `resolve()` devono
 * essere PURE (nessun effetto collaterale, nessuno stato condiviso), perché
 * vengono invocate una volta in più all'avvio. Vedi `_TEMPLATE.js`.
 *
 * Questo modulo NON conosce Express, Socket.io o il DB: è puro, come game.js.
 */

const fs   = require('node:fs');
const path = require('node:path');

// ─── Errori ──────────────────────────────────────────────────────────────────────

/** Un modulo minigioco non rispetta il contratto: errore di programmazione. */
class MinigameContractError extends Error {
  constructor(file, message) {
    super(`Minigioco "${file}": ${message}`);
    this.name = 'MinigameContractError';
  }
}

// ─── Tipo speciale "casuale" ─────────────────────────────────────────────────────
// Non è un minigioco: è un segnaposto che significa "estrai tu". Può comparire
// in uno slot pianificato in editor o nel payload di host:insert-minigame, e
// viene risolto in un tipo concreto al momento dell'uso (game.js). I client non
// lo vedono mai: il round che ricevono porta sempre un minigameType reale.

const RANDOM_TYPE = 'random';

/** Etichetta mostrata nella UI per la voce "casuale". */
const RANDOM_LABEL = 'Minigioco casuale';

// ─── Validazione del contratto ───────────────────────────────────────────────────

/** Gli esiti che `outcomeFor()` può restituire devono avere un punteggio. */
function assertPointsTable(file, points) {
  if (!points || typeof points !== 'object' || Array.isArray(points)) {
    throw new MinigameContractError(file, '"points" deve essere un oggetto { esito: punti }.');
  }
  const keys = Object.keys(points);
  if (keys.length === 0) {
    throw new MinigameContractError(file, '"points" non può essere vuoto.');
  }
  for (const key of keys) {
    if (!Number.isFinite(points[key])) {
      throw new MinigameContractError(file, `"points.${key}" deve essere un numero.`);
    }
  }
}

/**
 * Esegue `build()` a vuoto e verifica che produca un round valido.
 * Il round di un minigioco NON deve avere `correct_index`: l'esito si decide
 * alla chiusura, non è scritto in anticipo.
 */
function assertBuildContract(file, def) {
  const round = def.build();
  if (!round || typeof round !== 'object') {
    throw new MinigameContractError(file, 'build() deve restituire un oggetto round.');
  }
  if (round.kind !== 'minigame') {
    throw new MinigameContractError(file, 'build() deve restituire kind: "minigame".');
  }
  if (round.minigameType !== def.type) {
    throw new MinigameContractError(
      file,
      `build() restituisce minigameType "${round.minigameType}", atteso "${def.type}".`
    );
  }
  if (!Array.isArray(round.options) || round.options.length !== def.options.length) {
    throw new MinigameContractError(file, 'build() deve restituire le stesse "options" del modulo.');
  }
  if (!Number.isFinite(round.time_limit_s) || round.time_limit_s <= 0) {
    throw new MinigameContractError(file, 'build() deve restituire un "time_limit_s" positivo.');
  }
  if ('correct_index' in round) {
    throw new MinigameContractError(
      file,
      'build() non deve restituire "correct_index": un minigioco si risolve in resolve(), non in editor.'
    );
  }
}

/**
 * Esegue `resolve()` a vuoto agli estremi del range casuale e verifica che ogni
 * scelta possibile produca un esito presente in `points`. È il controllo che
 * intercetta la svista più probabile: un `outcomeFor()` che restituisce un esito
 * ("pareggio") assente dalla tabella punti ("draw").
 */
function assertResolveContract(file, def) {
  for (const value of [0, 0.5, 0.999999]) {
    const resolution = def.resolve(() => value);
    if (!resolution || typeof resolution.outcomeFor !== 'function') {
      throw new MinigameContractError(file, 'resolve() deve restituire { machineChoice, outcomeFor }.');
    }
    const { machineChoice } = resolution;
    if (!Number.isInteger(machineChoice) || machineChoice < 0 || machineChoice >= def.options.length) {
      throw new MinigameContractError(
        file,
        `resolve() ha prodotto machineChoice ${machineChoice}, fuori dal range delle opzioni.`
      );
    }
    for (let i = 0; i < def.options.length; i++) {
      const outcome = resolution.outcomeFor(i);
      if (!(outcome in def.points)) {
        throw new MinigameContractError(
          file,
          `outcomeFor(${i}) ha restituito l'esito "${outcome}", assente da "points".`
        );
      }
    }
  }
}

/**
 * Verifica un modulo minigioco appena caricato. Lancia al primo problema:
 * meglio un server che non parte di un minigioco che si rompe in partita.
 * @param {object} def modulo caricato
 * @param {string} file nome del file (per i messaggi d'errore)
 * @param {string} expectedType tipo dedotto dal nome del file
 */
function validateDefinition(def, file, expectedType) {
  if (!def || typeof def !== 'object') {
    throw new MinigameContractError(file, 'il modulo deve esportare un oggetto.');
  }
  if (typeof def.type !== 'string' || !def.type) {
    throw new MinigameContractError(file, 'manca il campo "type".');
  }
  // Il nome del file è la fonte di verità del tipo: così cercare "morra_cinese"
  // porta sempre al file giusto, e due moduli non possono rubarsi la stessa chiave.
  if (def.type !== expectedType) {
    throw new MinigameContractError(
      file,
      `"type" è "${def.type}" ma il nome del file impone "${expectedType}" (i trattini diventano underscore).`
    );
  }
  if (def.type === RANDOM_TYPE) {
    throw new MinigameContractError(file, `"${RANDOM_TYPE}" è riservato al segnaposto casuale.`);
  }
  if (typeof def.label !== 'string' || !def.label) {
    throw new MinigameContractError(file, 'manca il campo "label" (nome mostrato nella UI).');
  }
  if (!Array.isArray(def.options) || def.options.length < 2) {
    throw new MinigameContractError(file, '"options" deve avere almeno 2 voci.');
  }
  if (!def.options.every((o) => typeof o === 'string' && o)) {
    throw new MinigameContractError(file, '"options" deve contenere solo stringhe non vuote.');
  }
  if (!Number.isFinite(def.defaultTimeLimitS) || def.defaultTimeLimitS <= 0) {
    throw new MinigameContractError(file, '"defaultTimeLimitS" deve essere un numero positivo.');
  }
  if (typeof def.build !== 'function' || typeof def.resolve !== 'function') {
    throw new MinigameContractError(file, 'servono entrambe le funzioni build() e resolve().');
  }

  assertPointsTable(file, def.points);
  assertBuildContract(file, def);
  assertResolveContract(file, def);
}

// ─── Autoload ────────────────────────────────────────────────────────────────────

/** `morra-cinese.js` → `morra_cinese`. Il trattino nel file, l'underscore nel tipo. */
function typeFromFilename(file) {
  return path.basename(file, '.js').replace(/-/g, '_');
}

/**
 * Carica ogni `*.js` di questa cartella tranne `index.js` e i file che iniziano
 * con `_` (riservati a template e helper non giocabili).
 * L'ordinamento alfabetico rende `MINIGAME_TYPE_KEYS` stabile fra sistemi
 * operativi diversi — conta perché l'ordine finisce nella UI dell'editor.
 */
function loadDefinitions() {
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.js') && f !== 'index.js' && !f.startsWith('_'))
    .sort();

  const registry = {};
  for (const file of files) {
    const expectedType = typeFromFilename(file);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const def = require(path.join(__dirname, file));
    validateDefinition(def, file, expectedType);
    registry[def.type] = Object.freeze(def);
  }
  return Object.freeze(registry);
}

const MINIGAME_TYPES = loadDefinitions();
const MINIGAME_TYPE_KEYS = Object.freeze(Object.keys(MINIGAME_TYPES));

// ─── Interrogazione del registry ─────────────────────────────────────────────────

/** @returns {object | null} la definizione, o null se il tipo non esiste. */
function get(type) {
  return MINIGAME_TYPES[type] ?? null;
}

/**
 * Un tipo è valido in uno slot pianificato o in un inserimento ad-hoc se è un
 * minigioco registrato **oppure** il segnaposto casuale.
 * Usare questa funzione al posto di `MINIGAME_TYPE_KEYS.includes(...)` nelle
 * validazioni: aggiungere un minigioco non deve richiedere di toccare le route.
 */
function isValidSlotType(type) {
  return type === RANDOM_TYPE || Object.prototype.hasOwnProperty.call(MINIGAME_TYPES, type);
}

/**
 * Elenco per la UI (editor host), con la voce "casuale" in testa.
 * È l'unica fonte di verità: nessuna schermata deve elencare i minigiochi a mano.
 */
function listForUi() {
  return [
    { type: RANDOM_TYPE, label: RANDOM_LABEL, description: 'Il gioco ne estrae uno a sorte fra quelli disponibili.' },
    ...MINIGAME_TYPE_KEYS.map((type) => ({
      type,
      label: MINIGAME_TYPES[type].label,
      description: MINIGAME_TYPES[type].description ?? '',
    })),
  ];
}

// ─── Shuffle bag ─────────────────────────────────────────────────────────────────

/** Fisher-Yates su una copia: l'array sorgente non viene mai toccato. */
function shuffled(items, rnd) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Sacchetto di estrazione: restituisce i tipi in ordine casuale senza ripetizioni
 * finché non li ha esauriti tutti, poi rimescola. Serve a garantire varietà in
 * una singola partita, cosa che una `Math.random()` secca non fa.
 *
 * Alla rimescolata evita anche di ripescare subito l'ultimo tipo uscito: senza
 * questo accorgimento la fine di un sacchetto e l'inizio del successivo possono
 * produrre lo stesso minigioco due round di fila, che è proprio il caso che
 * questa struttura esiste per prevenire.
 *
 * Con un solo tipo registrato restituisce sempre quello (comportamento atteso,
 * non un caso limite da trattare).
 *
 * @param {string[]} keys tipi disponibili
 * @param {() => number} [rnd] generatore in [0, 1) — iniettabile per i test,
 *   stessa filosofia del parametro `now` di GameSession
 * @returns {{ next: () => (string|null), size: number }}
 */
function createShuffleBag(keys, rnd = Math.random) {
  const source = Array.from(keys);
  let pool = [];
  let last = null;

  return {
    get size() {
      return source.length;
    },
    next() {
      if (source.length === 0) return null;
      if (pool.length === 0) {
        pool = shuffled(source, rnd);
        // `pool` si consuma dal fondo: se l'ultimo elemento è quello appena
        // uscito, lo si scambia con la testa.
        if (pool.length > 1 && pool[pool.length - 1] === last) {
          [pool[0], pool[pool.length - 1]] = [pool[pool.length - 1], pool[0]];
        }
      }
      last = pool.pop();
      return last;
    },
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────────

module.exports = {
  MINIGAME_TYPES,
  MINIGAME_TYPE_KEYS,
  RANDOM_TYPE,
  RANDOM_LABEL,
  get,
  isValidSlotType,
  listForUi,
  createShuffleBag,
  MinigameContractError,
  // Esportata per i test: permette di validare un modulo finto senza scriverlo su disco.
  validateDefinition,
};
