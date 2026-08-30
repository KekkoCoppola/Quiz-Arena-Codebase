'use strict';

/**
 * server/quiz-schema.js
 *
 * Cosa rende valido un quiz. Unico posto in cui la domanda ha una risposta.
 *
 * Viveva dentro `routes/host.js`, cioè dentro lo strato HTTP: la attraversavano
 * solo i quiz creati dall'editor, mentre quelli di sistema — scritti sul DB da
 * uno script — le passavano accanto. Il risultato era un quiz con
 * `correct_index` fuori range che si giocava regolarmente mostrando "—" al posto
 * della risposta corretta, senza un errore da nessuna parte e senza che nessuno
 * potesse vincere il round.
 *
 * Da qui la regola: **nessun quiz entra in partita senza passare di qui**,
 * qualunque sia la strada da cui arriva.
 *
 * Modulo puro: nessun DB, nessuna rete, nessun filesystem. Testabile in
 * isolamento con `tools/test-quizzes.js`.
 */

const { isValidSlotType } = require('./minigames');

// ─── Limiti ──────────────────────────────────────────────────────────────────

const MAX_QUESTIONS_PER_QUIZ = 20;
const MAX_TITLE_LENGTH       = 100;
const MIN_OPTIONS            = 2;
const MAX_OPTIONS            = 4;
const MIN_TIME_LIMIT_S       = 5;
const MAX_TIME_LIMIT_S       = 120;

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

// ─── Validazione ─────────────────────────────────────────────────────────────

/**
 * Valida la forma di un quiz.
 *
 * Restituisce il **primo** errore trovato invece di elencarli tutti: chi legge
 * deve correggere comunque una cosa alla volta, e un messaggio solo è più
 * facile da mostrare sia in un toast dell'editor sia in una riga di console.
 *
 * @param {{ title: any, questions: any, minigames?: any }} input
 * @returns {string | null} messaggio di errore, o null se il quiz è valido
 */
function validateQuiz({ title, questions, minigames }) {
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > MAX_TITLE_LENGTH) {
    return `Il titolo deve essere una stringa tra 1 e ${MAX_TITLE_LENGTH} caratteri.`;
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    return 'Il quiz deve contenere almeno una domanda.';
  }
  if (questions.length > MAX_QUESTIONS_PER_QUIZ) {
    return `Il quiz può contenere al massimo ${MAX_QUESTIONS_PER_QUIZ} domande.`;
  }

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const num = i + 1;

    if (!q || typeof q.text !== 'string' || q.text.trim().length === 0) {
      return `Domanda ${num}: il campo "text" è obbligatorio.`;
    }
    if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
      return `Domanda ${num}: "options" deve essere un array di ${MIN_OPTIONS}-${MAX_OPTIONS} stringhe.`;
    }
    if (q.options.some((o) => typeof o !== 'string' || o.trim().length === 0)) {
      return `Domanda ${num}: ogni opzione deve essere una stringa non vuota.`;
    }
    // Il controllo che, mancando, produce un round non vincibile: l'indice deve
    // puntare a un'opzione che esiste davvero.
    if (
      typeof q.correct_index !== 'number' ||
      !Number.isInteger(q.correct_index) ||
      q.correct_index < 0 ||
      q.correct_index >= q.options.length
    ) {
      return `Domanda ${num}: "correct_index" deve essere un intero valido (0-${q.options.length - 1}).`;
    }
    if (
      typeof q.time_limit_s !== 'number' ||
      !Number.isInteger(q.time_limit_s) ||
      q.time_limit_s < MIN_TIME_LIMIT_S ||
      q.time_limit_s > MAX_TIME_LIMIT_S
    ) {
      return `Domanda ${num}: "time_limit_s" deve essere un intero tra ${MIN_TIME_LIMIT_S} e ${MAX_TIME_LIMIT_S} secondi.`;
    }

    const imageError = validateQuestionImage(q.image, num);
    if (imageError) return imageError;
  }

  if (minigames !== undefined) {
    if (!Array.isArray(minigames)) {
      return '"minigames" deve essere un array.';
    }
    for (let i = 0; i < minigames.length; i++) {
      const m = minigames[i];
      const num = i + 1;
      if (
        !m ||
        typeof m.afterQuestionIndex !== 'number' ||
        !Number.isInteger(m.afterQuestionIndex) ||
        m.afterQuestionIndex < 0 ||
        m.afterQuestionIndex >= questions.length
      ) {
        return `Minigioco ${num}: "afterQuestionIndex" deve essere un intero valido (0-${questions.length - 1}).`;
      }
      // `isValidSlotType` accetta i tipi registrati e il segnaposto "random":
      // così aggiungere un minigioco non richiede di toccare questa validazione.
      if (typeof m.type !== 'string' || !isValidSlotType(m.type)) {
        return `Minigioco ${num}: "type" non riconosciuto.`;
      }
    }
  }

  return null;
}

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
 * un DB. Per i quiz dell'editor l'esistenza la verifica la route di
 * salvataggio in `routes/host.js`, che un DB ce l'ha. `quiz-library.js` (i
 * quiz di sistema) NON fa lo stesso controllo: le immagini nei file di
 * `content/quizzes/` non sono ancora un percorso supportato — vedi
 * `_TEMPLATE.json.txt` — quindi un hash che punta al vuoto lì entra senza che
 * nulla se ne accorga all'avvio.
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

module.exports = {
  validateQuiz,
  isValidImageHash,
  MAX_QUESTIONS_PER_QUIZ,
  MAX_TITLE_LENGTH,
  MIN_OPTIONS,
  MAX_OPTIONS,
  MIN_TIME_LIMIT_S,
  MAX_TIME_LIMIT_S,
};
