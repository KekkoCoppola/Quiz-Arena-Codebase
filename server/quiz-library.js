'use strict';

/**
 * server/quiz-library.js
 *
 * I quiz di sistema come **file**, uno per quiz, in `content/quizzes/`.
 * Stessa forma del registry dei minigiochi (`server/minigames/index.js`): una
 * cartella scandita all'avvio, nessun elenco centrale da aggiornare, il nome
 * del file come identità.
 *
 * Prima vivevano in un array dentro `tools/seed-preloaded.js`, con tre
 * conseguenze che questo modulo elimina:
 *
 *   1. Aggiungerne uno significava editare un attrezzo, in mezzo alla logica DB.
 *   2. Rilanciare il seed **saltava** i quiz già presenti — confrontava i titoli
 *      — quindi correggere un refuso non aveva alcun effetto.
 *   3. Nessuna validazione: il seed scriveva SQL grezzo, e un `correct_index`
 *      fuori range arrivava intatto fino alla sala.
 *
 * ── Le tre regole ───────────────────────────────────────────────────────────
 *
 *   • **Il nome del file è l'identità del quiz** (`il-mondo-degli-animali.json`
 *     → slug `il-mondo-degli-animali`), non il titolo. Rinominare il titolo
 *     aggiorna il quiz esistente invece di crearne un doppione.
 *
 *   • **Un quiz non valido viene escluso, non blocca l'avvio.** È la differenza
 *     con i minigiochi, dove un modulo rotto impedisce il boot: lì è un bug di
 *     codice, qui è un refuso di contenuto, e fermare tutta la serata perché una
 *     domanda ha l'indice sbagliato è sproporzionato. Gli altri quiz restano
 *     giocabili e l'esclusione viene stampata a chiare lettere.
 *
 *   • **Un quiz non conosce gli altri.** Nessun indice, nessun ordine da
 *     mantenere a mano.
 *
 * ── Perché JSON e non JS ────────────────────────────────────────────────────
 *
 * Perché questi file vanno modificati sul Raspberry, spesso da chi non
 * programma, e un domani da una schermata di amministrazione che li scriva da
 * sola. JSON non esegue nulla: un file corrotto è un errore di lettura, non
 * codice arbitrario che parte al boot.
 */

const fs   = require('node:fs');
const path = require('node:path');

const config = require('./config');
const { validateQuiz } = require('./quiz-schema');
const { loadImageFiles } = require('./image-library');

/** Cartella dei contenuti. Fuori da `server/` di proposito: nel packaging SEA
 *  il codice finisce dentro il binario, questi file devono restare sul disco
 *  del Pi per poter essere modificati senza ricompilare nulla — per questo il
 *  percorso e configurabile (QUIZZES_DIR) e non cablato. */
const QUIZZES_DIR = path.resolve(config.quizzesDir);

// ─── Immagini riferite per nome ──────────────────────────────────────────────

/**
 * Traduce `image: { file: "colosseo.webp", blur: 60 }` in `{ hash, blur }`.
 *
 * Nessuno può scrivere a mano lo SHA-256 dei byte dentro un JSON, quindi un
 * file di sistema nomina l'immagine e la traduzione avviene qui, **prima**
 * della validazione: `quiz-schema.js` continua a conoscere solo `hash`, e
 * resta l'unica definizione di quiz valido. Il nome del file vive fra il disco
 * e il caricamento, come lo slug del quiz.
 *
 * Un'immagine che non c'è **non esclude il quiz**: la domanda perde la foto e
 * si gioca come una domanda di testo, e la cosa viene annunciata all'avvio.
 * È la stessa scelta che regola tutto questo modulo — davanti a una sala un
 * quiz che gioca senza una foto vale infinitamente più di un quiz che non
 * c'è. Ed è anche ciò che permette di scrivere le domande prima di avere le
 * immagini, e lasciarle cadere al loro posto quando arrivano.
 *
 * @param {Array<object>} questions domande grezze dal file
 * @param {Map<string, object>} images da `loadImageFiles`
 * @param {string} file nome del quiz, per i messaggi
 * @param {string[]} warnings accumulatore, modificato sul posto
 * @returns {Array<object>} domande con `image` risolto, o senza
 */
function resolveQuestionImages(questions, images, file, warnings) {
  if (!Array.isArray(questions)) return questions;

  return questions.map((q, i) => {
    const img = q?.image;
    // Niente immagine, o già in forma di hash (un quiz esportato dall'editor):
    // non c'è nulla da tradurre.
    if (!img || typeof img !== 'object' || typeof img.file !== 'string') return q;

    const trovata = images.get(img.file);
    if (!trovata) {
      warnings.push(
        `${file}: domanda ${i + 1} chiede l'immagine "${img.file}", che non è in `
        + `content/images/ — la domanda si gioca senza foto`
      );
      const { image: _scartata, ...resto } = q;
      return resto;
    }

    // `blur` resta com'era scritto: a validarlo è lo schema, qui si cambia
    // solo il modo di nominare l'immagine.
    return { ...q, image: { hash: trovata.hash, blur: img.blur ?? false } };
  });
}

// ─── Lettura ─────────────────────────────────────────────────────────────────

/**
 * Legge e valida ogni `*.json` della cartella.
 *
 * Non lancia mai: un file illeggibile o malformato diventa una voce in
 * `errors`, non un'eccezione. L'avvio del server non deve dipendere da un
 * refuso in una domanda.
 *
 * @param {string} [dir] cartella da leggere. Il default e quella vera; il
 *   parametro esiste per i test — stessa filosofia del `now` di game.js e del
 *   `rnd` di GameSession: iniettare invece di cablare.
 * @returns {{ quizzes: Array<object>, errors: string[] }}
 *   `quizzes` ordinati per slug, ciascuno con `{ slug, title, category, questions, minigames }`.
 */
function loadQuizFiles(dir = QUIZZES_DIR, imagesDir = undefined) {
  const quizzes  = [];
  const errors   = [];
  const warnings = [];

  // Le immagini si leggono una volta sola per tutta la cartella: lo stesso
  // file può servire a più quiz, e rileggerlo per ciascuno vorrebbe dire
  // ricalcolarne lo SHA-256 ogni volta.
  const { images, errors: erroriImmagini } = loadImageFiles(imagesDir);
  for (const e of erroriImmagini) warnings.push(`immagini: ${e}`);

  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    // Cartella assente: nessun quiz di sistema. Il gioco resta funzionante con
    // i soli quiz personali, esattamente come con un manifest audio vuoto.
    return { quizzes, errors: [`cartella ${dir} non leggibile: ${err.message}`], warnings, images };
  }

  for (const file of files) {
    const slug = path.basename(file, '.json');
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      errors.push(`${file}: JSON non valido (${err.message})`);
      continue;
    }

    // Prima della validazione, non dopo: lo schema conosce solo `hash`, e qui
    // le domande arrivano col nome del file.
    const questions = resolveQuestionImages(raw.questions, images, file, warnings);

    // Stessa validazione dell'editor: una sola definizione di "quiz valido".
    const problema = validateQuiz({
      title:     raw.title,
      questions,
      minigames: raw.minigames,
    });
    if (problema) {
      errors.push(`${file}: ${problema}`);
      continue;
    }

    quizzes.push({
      slug,
      title:     raw.title.trim(),
      category:  typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'Generale',
      questions,
      minigames: raw.minigames ?? [],
    });
  }

  return { quizzes, errors, warnings, images };
}

// ─── Sincronizzazione ────────────────────────────────────────────────────────

/**
 * Allinea la tabella `preloaded_quizzes` ai file.
 *
 * I file sono la fonte di verità; il DB è una copia derivata, che esiste solo
 * perché il resto dell'applicazione legge i quiz da lì. Di conseguenza la
 * sincronizzazione è nei due sensi: un quiz il cui file è sparito viene
 * rimosso, e uno il cui contenuto è cambiato viene **aggiornato** — che è
 * proprio ciò che il vecchio seed non faceva.
 *
 * @param {import('node:sqlite').DatabaseSync} database
 * @returns {{ inserted: number, updated: number, removed: number, errors: string[] }}
 */
function syncToDatabase(database) {
  const { quizzes, errors, warnings, images } = loadQuizFiles();

  // Solo le immagini che una domanda usa davvero: `gcOrphanImages()` gira
  // subito dopo questa sincronizzazione e cancella quelle che nessuno
  // referenzia, quindi stoccare l'intera cartella sarebbe scrivere nel
  // database righe destinate a sparire nella stessa accensione.
  const usati = new Set();
  for (const q of quizzes) {
    for (const d of q.questions) {
      if (d?.image?.hash) usati.add(d.image.hash);
    }
  }
  const referencedImages = [...images.values()].filter((img) => usati.has(img.hash));

  // Righe senza slug: sono quelle scritte dal vecchio seed, che non aveva il
  // concetto di identità stabile. Vanno via subito, altrimenti si sommerebbero
  // a quelle rigenerate dai file e ogni quiz comparirebbe due volte nel menù.
  // Nessuna perdita: il contenuto vive nei file, il DB è solo una copia.
  const legacy = database.prepare(
    "DELETE FROM preloaded_quizzes WHERE slug IS NULL OR slug = ''"
  ).run();

  const esistenti = new Map(
    database.prepare('SELECT id, slug FROM preloaded_quizzes').all()
      .map((r) => [r.slug, r.id])
  );

  const insert = database.prepare(
    'INSERT INTO preloaded_quizzes (slug, title, category, questions, minigames) VALUES (?, ?, ?, ?, ?)'
  );
  const update = database.prepare(
    'UPDATE preloaded_quizzes SET title = ?, category = ?, questions = ?, minigames = ? WHERE slug = ?'
  );

  let inserted = 0;
  let updated  = 0;

  for (const q of quizzes) {
    const domande   = JSON.stringify(q.questions);
    const minigiochi = JSON.stringify(q.minigames);
    if (esistenti.has(q.slug)) {
      update.run(q.title, q.category, domande, minigiochi, q.slug);
      updated++;
    } else {
      insert.run(q.slug, q.title, q.category, domande, minigiochi);
      inserted++;
    }
    esistenti.delete(q.slug);
  }

  // Quel che resta nella mappa non ha più un file: il quiz è stato cancellato o
  // rinominato. Non va lasciato in giro, altrimenti ricompare nel menù dell'host
  // senza che nessuna modifica ai file possa più toglierlo.
  let removed = 0;
  const del = database.prepare('DELETE FROM preloaded_quizzes WHERE slug = ?');
  for (const slug of esistenti.keys()) {
    del.run(slug);
    removed++;
  }

  return {
    inserted,
    updated,
    removed: removed + Number(legacy.changes ?? 0),
    errors,
    warnings,
    // I byte li scrive il chiamante (`quiz-manager.syncPreloadedQuizzes`) con
    // `putImage`: è lì che vive l'unico punto di contatto con SQLite per le
    // immagini, e quella funzione calcola già l'hash dai byte come fa per
    // l'editor. Qui si dice solo QUALI servono.
    referencedImages,
  };
}

module.exports = { loadQuizFiles, syncToDatabase, QUIZZES_DIR };
