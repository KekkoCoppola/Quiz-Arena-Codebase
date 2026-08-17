'use strict';

/**
 * tools/seed-preloaded.js
 *
 * Popola la tabella `preloaded_quizzes` con quiz precaricati di sistema
 * pensati per bambini dai 4 ai 10 anni.
 *
 * Utilizzo:
 *   node tools/seed-preloaded.js
 *
 * Idempotente: controlla per titolo se il quiz esiste già prima di inserirlo.
 * Eseguire una sola volta (o ogni volta che si vuole aggiungere nuovi quiz).
 */

const path = require('node:path');

// ─── Dati quiz precaricati ────────────────────────────────────────────────────

const PRELOADED_QUIZZES = [
  {
    title: '🐾 Il mondo degli animali',
    category: 'Natura',
    // Minigioco pianificato di esempio (Fase Minigiochi): dopo la prima
    // domanda (indice 0) si inserisce un round "Morra Cinese".
    minigames: [{ afterQuestionIndex: 0, type: 'morra_cinese' }],
    questions: [
      {
        text: 'Quale animale fa "miao"?',
        options: ['Cane', 'Gatto', 'Mucca', 'Pecora'],
        correct_index: 1,
        time_limit_s: 20,
      },
      {
        text: 'Quante zampe ha un cane?',
        options: ['2', '4', '6', '8'],
        correct_index: 1,
        time_limit_s: 20,
      },
      {
        text: "Qual è l'animale più grande del mondo?",
        options: ['Elefante', 'Giraffa', 'Balena blu', 'Squalo bianco'],
        correct_index: 2,
        time_limit_s: 25,
      },
      {
        text: 'Dove vive il pesce?',
        options: ['Nel deserto', 'Sugli alberi', 'In acqua', 'Sottoterra'],
        correct_index: 2,
        time_limit_s: 15,
      },
      {
        text: 'Quale animale ha la proboscide?',
        options: ['Leone', 'Elefante', 'Zebra', 'Pinguino'],
        correct_index: 1,
        time_limit_s: 20,
      },
      {
        text: 'Quale animale produce il miele?',
        options: ['Farfalla', 'Formica', 'Ape', 'Libellula'],
        correct_index: 2,
        time_limit_s: 20,
      },
      {
        text: 'Come si chiama il piccolo della mucca?',
        options: ['Agnello', 'Vitello', 'Puledro', 'Cucciolo'],
        correct_index: 1,
        time_limit_s: 25,
      },
      {
        text: 'Quale animale non sa volare?',
        options: ['Aquila', 'Pinguino', 'Rondine', 'Piccione'],
        correct_index: 1,
        time_limit_s: 20,
      },
      {
        text: 'Dove dormono di notte i pipistrelli?',
        options: ['A testa in su', 'A testa in giù', 'Per terra', "Sull'acqua"],
        correct_index: 1,
        time_limit_s: 25,
      },
      {
        text: 'Quale animale cambia colore per mimetizzarsi?',
        options: ['Coccodrillo', 'Camaleonte', 'Tartaruga', 'Iguana'],
        correct_index: 1,
        time_limit_s: 25,
      },
    ],
  },
  {
    title: '🌈 Colori, forme e numeri',
    category: 'Logica',
    questions: [
      {
        text: 'Di che colore è il sole?',
        options: ['Verde', 'Blu', 'Giallo', 'Viola'],
        correct_index: 2,
        time_limit_s: 15,
      },
      {
        text: 'Quanti lati ha un quadrato?',
        options: ['3', '4', '5', '6'],
        correct_index: 1,
        time_limit_s: 15,
      },
      {
        text: 'Qual è il colore del cielo nelle giornate serene?',
        options: ['Grigio', 'Blu', 'Arancione', 'Rosa'],
        correct_index: 1,
        time_limit_s: 15,
      },
      {
        text: 'Quanti lati ha un triangolo?',
        options: ['2', '3', '4', '5'],
        correct_index: 1,
        time_limit_s: 15,
      },
      {
        text: 'Quanto fa 5 + 3?',
        options: ['6', '7', '8', '9'],
        correct_index: 2,
        time_limit_s: 20,
      },
      {
        text: "Di che colore è l'erba?",
        options: ['Gialla', 'Rossa', 'Verde', 'Blu'],
        correct_index: 2,
        time_limit_s: 15,
      },
      {
        text: 'Quale forma ha una pizza rotonda?',
        options: ['Quadrato', 'Triangolo', 'Cerchio', 'Rettangolo'],
        correct_index: 2,
        time_limit_s: 15,
      },
      {
        text: 'Quanto fa 10 - 4?',
        options: ['4', '5', '6', '7'],
        correct_index: 2,
        time_limit_s: 20,
      },
      {
        text: 'Di che colore è il pomodoro maturo?',
        options: ['Blu', 'Rosso', 'Viola', 'Arancione'],
        correct_index: 1,
        time_limit_s: 15,
      },
      {
        text: 'Quale numero viene dopo il 9?',
        options: ['8', '11', '10', '12'],
        correct_index: 2,
        time_limit_s: 15,
      },
    ],
  },
  {
    title: '🌍 Il mondo intorno a noi',
    category: 'Cultura Generale',
    questions: [
      {
        text: "Qual è la capitale dell'Italia?",
        options: ['Milano', 'Napoli', 'Roma', 'Venezia'],
        correct_index: 2,
        time_limit_s: 25,
      },
      {
        text: 'Quante stagioni ci sono in un anno?',
        options: ['2', '3', '4', '5'],
        correct_index: 2,
        time_limit_s: 20,
      },
      {
        text: 'In quale stagione cadono le foglie dagli alberi?',
        options: ['Primavera', 'Estate', 'Autunno', 'Inverno'],
        correct_index: 2,
        time_limit_s: 20,
      },
      {
        text: 'Quale pianeta è più vicino al Sole?',
        options: ['Terra', 'Venere', 'Mercurio', 'Marte'],
        correct_index: 2,
        time_limit_s: 30,
      },
      {
        text: 'Quanti mesi ha un anno?',
        options: ['10', '11', '12', '13'],
        correct_index: 2,
        time_limit_s: 20,
      },
      {
        text: 'Quale mezzo di trasporto vola?',
        options: ['Barca', 'Bicicletta', 'Treno', 'Aereo'],
        correct_index: 3,
        time_limit_s: 15,
      },
      {
        text: 'Di cosa è fatta la neve?',
        options: ['Sabbia', 'Zucchero', 'Acqua ghiacciata', 'Sale'],
        correct_index: 2,
        time_limit_s: 20,
      },
      {
        text: 'Come si chiama la nostra stella più vicina?',
        options: ['Luna', 'Sole', 'Marte', 'Giove'],
        correct_index: 1,
        time_limit_s: 20,
      },
      {
        text: 'Quanti giorni ci sono in una settimana?',
        options: ['5', '6', '7', '8'],
        correct_index: 2,
        time_limit_s: 15,
      },
      {
        text: "In quale mare è bagnata l'Italia?",
        options: ['Oceano Pacifico', 'Mar Mediterraneo', 'Mar Baltico', 'Oceano Atlantico'],
        correct_index: 1,
        time_limit_s: 30,
      },
    ],
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const config    = require(path.join(__dirname, '../server/config'));
  const dbManager = require(path.join(__dirname, '../server/quiz-manager'));

  dbManager.initDb(config.dbPath);

  const database = dbManager.getDb();

  const checkStmt  = database.prepare('SELECT id FROM preloaded_quizzes WHERE title = ?');
  const insertStmt = database.prepare(
    'INSERT INTO preloaded_quizzes (title, category, questions, minigames) VALUES (?, ?, ?, ?)'
  );

  let inserted = 0;
  let skipped  = 0;

  console.log('\n🌱 Seed quiz precaricati — Quiz-Zata!\n');

  for (const quiz of PRELOADED_QUIZZES) {
    const existing = checkStmt.get(quiz.title);
    if (existing) {
      console.log(`  ⏭  Già presente : "${quiz.title}"`);
      skipped++;
    } else {
      insertStmt.run(quiz.title, quiz.category, JSON.stringify(quiz.questions), JSON.stringify(quiz.minigames ?? []));
      console.log(`  ✅ Inserito       : "${quiz.title}" (${quiz.questions.length} domande)`);
      inserted++;
    }
  }

  dbManager.closeDb();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Inseriti : ${inserted}`);
  console.log(`  Saltati  : ${skipped}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main();
