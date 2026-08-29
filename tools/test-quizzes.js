#!/usr/bin/env node
'use strict';

/**
 * tools/test-quizzes.js
 *
 * Smoke test del comparto quiz-come-file:
 *   - server/quiz-schema.js   — cosa rende valido un quiz (puro)
 *   - server/quiz-library.js  — lettura e validazione dei file (solo filesystem)
 *
 * `syncToDatabase` non è coperto qui: tocca SQLite ed è verificato in
 * tools/test-db.js. Questo file resta puro e gira in isolamento.
 */

const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const { validateQuiz, MAX_QUESTIONS_PER_QUIZ, isValidImageHash } = require(path.join(__dirname, '..', 'server', 'quiz-schema'));

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

/** Quiz minimo valido, da deformare caso per caso. */
const base = () => ({
  title: 'Quiz valido',
  questions: [
    { text: 'Domanda', options: ['A', 'B'], correct_index: 0, time_limit_s: 20 },
  ],
  minigames: [],
});

// ─── validateQuiz ────────────────────────────────────────────────────────────

console.log('\n── quiz-schema: forma del quiz ──\n');

assert(validateQuiz(base()) === null, 'un quiz minimo valido passa');

assert(validateQuiz({ ...base(), title: '' }) !== null, 'titolo vuoto rifiutato');
assert(validateQuiz({ ...base(), title: 'x'.repeat(101) }) !== null, 'titolo oltre 100 caratteri rifiutato');
assert(validateQuiz({ ...base(), questions: [] }) !== null, 'quiz senza domande rifiutato');

const troppe = { ...base(), questions: Array.from({ length: MAX_QUESTIONS_PER_QUIZ + 1 }, () => base().questions[0]) };
assert(validateQuiz(troppe) !== null, `oltre ${MAX_QUESTIONS_PER_QUIZ} domande rifiutato`);

// Il caso che prima arrivava intatto fino alla sala: indice fuori range.
const fuoriRange = base();
fuoriRange.questions[0].correct_index = 9;
const erroreIndice = validateQuiz(fuoriRange);
assert(erroreIndice !== null, 'correct_index fuori range rifiutato');
assert(
  typeof erroreIndice === 'string' && erroreIndice.includes('Domanda 1'),
  'il messaggio indica quale domanda è sbagliata'
);

const indiceNegativo = base();
indiceNegativo.questions[0].correct_index = -1;
assert(validateQuiz(indiceNegativo) !== null, 'correct_index negativo rifiutato');

const indiceDecimale = base();
indiceDecimale.questions[0].correct_index = 0.5;
assert(validateQuiz(indiceDecimale) !== null, 'correct_index non intero rifiutato');

const unaOpzione = base();
unaOpzione.questions[0].options = ['Sola'];
assert(validateQuiz(unaOpzione) !== null, 'una sola opzione rifiutata');

const cinqueOpzioni = base();
cinqueOpzioni.questions[0].options = ['A', 'B', 'C', 'D', 'E'];
assert(validateQuiz(cinqueOpzioni) !== null, 'cinque opzioni rifiutate');

const opzioneVuota = base();
opzioneVuota.questions[0].options = ['A', '   '];
assert(validateQuiz(opzioneVuota) !== null, 'opzione vuota rifiutata');

const tempoBasso = base();
tempoBasso.questions[0].time_limit_s = 4;
assert(validateQuiz(tempoBasso) !== null, 'time_limit_s sotto il minimo rifiutato');

const tempoAlto = base();
tempoAlto.questions[0].time_limit_s = 121;
assert(validateQuiz(tempoAlto) !== null, 'time_limit_s sopra il massimo rifiutato');

// Minigiochi
const mgFantasma = { ...base(), minigames: [{ afterQuestionIndex: 0, type: 'gioco_fantasma' }] };
assert(validateQuiz(mgFantasma) !== null, 'minigioco di tipo sconosciuto rifiutato');

const mgRandom = { ...base(), minigames: [{ afterQuestionIndex: 0, type: 'random' }] };
assert(validateQuiz(mgRandom) === null, 'il segnaposto "random" è accettato');

const mgIndiceAlto = { ...base(), minigames: [{ afterQuestionIndex: 5, type: 'random' }] };
assert(validateQuiz(mgIndiceAlto) !== null, 'minigioco dopo una domanda inesistente rifiutato');

assert(validateQuiz({ ...base(), minigames: undefined }) === null, 'minigames assente è ammesso');
assert(validateQuiz({ ...base(), minigames: 'no' }) !== null, 'minigames non-array rifiutato');

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

// ─── loadQuizFiles ───────────────────────────────────────────────────────────

console.log('\n── quiz-library: lettura dei file ──\n');

// Si lavora su una cartella temporanea, non su content/quizzes/: un test non
// deve poter toccare i contenuti veri.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quizzata-test-'));
const scriviQuiz = (nome, oggetto) =>
  fs.writeFileSync(path.join(tmp, nome), typeof oggetto === 'string' ? oggetto : JSON.stringify(oggetto));

scriviQuiz('valido-uno.json', base());
scriviQuiz('valido-due.json', { ...base(), title: 'Secondo', category: 'Prova' });
scriviQuiz('rotto-indice.json', fuoriRange);
scriviQuiz('rotto-json.json', '{ "title": "troncato"');
scriviQuiz('ignorato.txt', 'non è un json');

const lib = require(path.join(__dirname, '..', 'server', 'quiz-library'));

// loadQuizFiles accetta la cartella: si punta a quella temporanea, così il
// test non dipende dai contenuti veri e non può sporcarli.
const esito = lib.loadQuizFiles(tmp);
const slugs = esito.quizzes.map((q) => q.slug).sort();

assert(slugs.join(',') === 'valido-due,valido-uno', 'legge solo i quiz validi, in ordine di slug');
assert(esito.errors.length === 2, 'segnala esattamente i due file rotti');
assert(
  esito.errors.some((e) => e.startsWith('rotto-indice.json')),
  'il quiz con correct_index fuori range è escluso e nominato'
);
assert(
  esito.errors.some((e) => e.startsWith('rotto-json.json') && e.includes('JSON non valido')),
  'il file JSON troncato è escluso e nominato'
);
assert(
  !esito.errors.some((e) => e.includes('ignorato.txt')),
  'i file non-.json sono ignorati senza finire fra gli errori'
);

// Lo slug viene dal NOME DEL FILE, non dal titolo: è ciò che permette di
// cambiare il titolo di un quiz senza generarne un doppione.
const primo = esito.quizzes.find((q) => q.slug === 'valido-uno');
assert(primo.title === 'Quiz valido', 'il titolo viene letto dal file');
assert(primo.slug !== primo.title.toLowerCase(), 'lo slug è il nome del file, non il titolo');
assert(primo.category === 'Generale', 'categoria assente → default "Generale"');
assert(esito.quizzes.find((q) => q.slug === 'valido-due').category === 'Prova', 'categoria presente → usata');
assert(esito.quizzes.every((q) => Array.isArray(q.minigames)), 'minigames è sempre un array');
assert(esito.quizzes.every((q) => validateQuiz(q) === null), 'ogni quiz restituito supera la validazione');

// Cartella inesistente: nessuna eccezione, un errore descrittivo.
const mancante = lib.loadQuizFiles(path.join(tmp, 'non-esiste'));
assert(mancante.quizzes.length === 0, 'cartella assente → nessun quiz');
assert(mancante.errors.length === 1, 'cartella assente → un errore, non un\u0027eccezione');

// La cartella vera deve comunque essere leggibile e sana.
const veri = lib.loadQuizFiles();
assert(veri.errors.length === 0, 'i quiz veri in content/quizzes/ sono tutti validi');
assert(veri.quizzes.length > 0, 'content/quizzes/ contiene almeno un quiz');
fs.rmSync(tmp, { recursive: true, force: true });

// ─── Riepilogo ───────────────────────────────────────────────────────────────

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Risultato: ${passed} passati, ${failed} falliti`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

process.exitCode = failed === 0 ? 0 : 1;
