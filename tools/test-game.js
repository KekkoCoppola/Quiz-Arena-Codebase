'use strict';

/**
 * tools/test-game.js
 *
 * Smoke test isolato per server/game.js.
 * Testa la macchina a stati in-memory SENZA rete/UI — eseguibile subito dopo Step 5.
 *
 * Utilizzo: node tools/test-game.js
 * (Non committato — escluso da .gitignore)
 */

const {
  GameSession,
  STATES,
  POINTS_MAX,
  POINTS_MIN,
  MAX_NICKNAME_LENGTH,
  MINIGAME_TYPE_KEYS,
  InvalidStateError,
  DuplicateNicknameError,
  PlayerNotFoundError,
  AlreadyAnsweredError,
  InvalidAnswerIndexError,
  InvalidNicknameError,
  EmptyQuizError,
  NotEnoughPlayersError,
  AVATAR_IDS,
  InvalidAvatarError,
  InvalidMinigameTypeError,
  AnswersNotOpenError,
} = require('../server/game');

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

function assertThrows(fn, ErrorClass, label) {
  try {
    fn();
    console.error(`  ❌  ${label} (nessuna eccezione lanciata)`);
    failed++;
  } catch (err) {
    if (err instanceof ErrorClass) {
      console.log(`  ✅  ${label}`);
      passed++;
    } else {
      console.error(`  ❌  ${label} (errore inatteso: ${err.constructor.name}: ${err.message})`);
      failed++;
    }
  }
}

const QUIZ = {
  title: 'Quiz Test',
  questions: [
    { text: 'Domanda 1', options: ['A', 'B', 'C', 'D'], correct_index: 0, time_limit_s: 10 },
    { text: 'Domanda 2', options: ['Sì', 'No'], correct_index: 1, time_limit_s: 10 },
  ],
};

// ─── Test ────────────────────────────────────────────────────────────────────────

function run() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🧪  Quiz-Zata! — Smoke Test: game.js');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 1. Costruzione
  console.log('  🎬  Fase 1: Costruzione');
  assertThrows(() => new GameSession(null), EmptyQuizError, 'constructor: lancia EmptyQuizError per quiz nullo');
  assertThrows(() => new GameSession({ questions: [] }), EmptyQuizError, 'constructor: lancia EmptyQuizError per quiz senza domande');

  const game = new GameSession(QUIZ);
  assert(game.state === STATES.LOBBY, 'constructor: stato iniziale LOBBY');

  // 2. Lobby
  console.log('\n  👥  Fase 2: Lobby');
  assertThrows(() => game.startGame(1000), NotEnoughPlayersError, 'startGame: lancia NotEnoughPlayersError senza giocatori');

  const alice = game.addPlayer('Alice');
  assert(alice.id && alice.nickname === 'Alice' && alice.score === 0, 'addPlayer: crea giocatore con score 0');

  const bob = game.addPlayer('Bob');
  assert(bob.id !== alice.id, 'addPlayer: ID univoci per giocatori diversi');

  assertThrows(() => game.addPlayer('alice'), DuplicateNicknameError, 'addPlayer: lancia DuplicateNicknameError (case-insensitive)');
  assertThrows(() => game.addPlayer('   '), InvalidNicknameError, 'addPlayer: lancia InvalidNicknameError per nickname vuoto');
  assertThrows(() => game.addPlayer('X'.repeat(MAX_NICKNAME_LENGTH + 1)), InvalidNicknameError, 'addPlayer: lancia InvalidNicknameError per nickname troppo lungo');
  assert(game.getPlayers().length === 2, 'getPlayers: restituisce 2 giocatori');

  // 3. Avvio partita + Domanda 1
  console.log('\n  ▶️   Fase 3: Avvio partita e Domanda 1');
  game.startGame(1000);
  assert(game.state === STATES.QUESTION, 'startGame: transizione a QUESTION');
  assertThrows(() => game.startGame(1000), InvalidStateError, 'startGame: lancia InvalidStateError se già avviata');

  const q1 = game.getCurrentRound();
  assert(q1.text === 'Domanda 1' && q1.correct_index === undefined, 'getCurrentRound: sanitizzata, senza correct_index');
  assert(q1.total === 2, 'getCurrentRound: total corretto');

  assertThrows(() => game.addPlayer('Carol'), InvalidStateError, 'addPlayer: bloccato fuori da LOBBY');

  // Alice risponde subito e giusto (1500ms dopo start, su 10s => ratio alto)
  const resAlice = game.submitAnswer(alice.id, 0, 1500);
  assert(resAlice.correct === true, 'submitAnswer: Alice risposta corretta');
  assert(resAlice.pointsAwarded > POINTS_MIN && resAlice.pointsAwarded <= POINTS_MAX, 'submitAnswer: punteggio Alice nel range atteso (risposta rapida)');

  assertThrows(() => game.submitAnswer(alice.id, 1, 1600), AlreadyAnsweredError, 'submitAnswer: lancia AlreadyAnsweredError su doppia risposta');
  assertThrows(() => game.submitAnswer(bob.id, 99, 2000), InvalidAnswerIndexError, 'submitAnswer: lancia InvalidAnswerIndexError per indice fuori range');
  assertThrows(() => game.submitAnswer('id-inesistente', 0, 2000), PlayerNotFoundError, 'submitAnswer: lancia PlayerNotFoundError per giocatore ignoto');

  // Bob risponde sbagliato, tardi (10500ms dopo start, su 10s)
  const resBob = game.submitAnswer(bob.id, 1, 10500);
  assert(resBob.correct === false && resBob.pointsAwarded === 0, 'submitAnswer: Bob risposta sbagliata => 0 punti');

  // 4. Risultati Domanda 1
  console.log('\n  📊  Fase 4: Risultati Domanda 1');
  const results1 = game.endQuestion(11000);
  assert(game.state === STATES.RESULTS, 'endQuestion: transizione a RESULTS');
  assert(results1.correctIndex === 0, 'endQuestion: correctIndex esposto correttamente');
  assert(results1.revealMs === 0, 'endQuestion: domanda normale senza sospensione (revealMs 0)');
  assert(results1.distribution[0] === 1 && results1.distribution[1] === 1, 'endQuestion: distribuzione risposte corretta');
  assert(alice.score === resAlice.pointsAwarded, 'endQuestion: punteggio Alice aggiornato sul player');
  assert(bob.score === 0, 'endQuestion: punteggio Bob invariato (0)');
  assert(results1.leaderboard[0].nickname === 'Alice', 'endQuestion: leaderboard ordinata correttamente');
  assert(results1.isLastRound === false, 'endQuestion: isLastRound false a metà partita');

  assertThrows(() => game.submitAnswer(alice.id, 0, 11500), InvalidStateError, 'submitAnswer: bloccato fuori da QUESTION');

  // 5. Domanda 2 (Bob non risponde => tempo scaduto)
  console.log('\n  ⏭️   Fase 5: Domanda 2 (Bob non risponde)');
  const advance = game.nextQuestion(12000);
  assert(advance.finished === false, 'nextQuestion: partita non ancora finita');
  assert(game.state === STATES.QUESTION, 'nextQuestion: transizione a QUESTION');
  assert(game.currentRoundIndex === 1, 'nextQuestion: indice round incrementato');

  game.submitAnswer(alice.id, 1, 12500); // corretta

  const results2 = game.endQuestion(22000); // tempo scaduto, Bob non ha risposto
  assert(results2.answers.length === 1, 'endQuestion: solo le risposte pervenute sono incluse');
  assert(bob.score === 0, 'endQuestion: Bob senza risposta resta a 0 punti');
  // Il flag che dice ai client di NON mostrare la classifica: dopo questi
  // risultati viene la premiazione, e mostrarla proclamerebbe il vincitore.
  assert(results2.isLastRound === true, 'endQuestion: isLastRound true sull\'ultimo round');

  // 6. Fine partita
  console.log('\n  🏆  Fase 6: Fine partita');
  const finalAdvance = game.nextQuestion(23000);
  assert(finalAdvance.finished === true, 'nextQuestion: segnala fine partita sull\'ultima domanda');
  assert(game.state === STATES.FINAL_LEADERBOARD, 'nextQuestion: transizione a FINAL_LEADERBOARD');
  assert(finalAdvance.leaderboard[0].nickname === 'Alice', 'FINAL_LEADERBOARD: Alice in testa alla classifica');

  assertThrows(() => game.nextQuestion(24000), InvalidStateError, 'nextQuestion: bloccato dopo FINAL_LEADERBOARD');

  // 7. removePlayer
  console.log('\n  🚪  Fase 7: Rimozione giocatore');
  game.removePlayer(bob.id);
  assert(game.getPlayers().length === 1, 'removePlayer: rimuove correttamente il giocatore');
  assertThrows(() => game.removePlayer('id-inesistente'), PlayerNotFoundError, 'removePlayer: lancia PlayerNotFoundError per ID ignoto');

  // 8. Avatar e connessione (Fase 7)
  console.log('\n  🦊  Fase 8: Avatar e connessione');
  const g8 = new GameSession(QUIZ);
  assert(Array.isArray(AVATAR_IDS) && AVATAR_IDS.length === 12, 'AVATAR_IDS: 12 avatar precaricati');
  assert(Object.isFrozen(AVATAR_IDS), 'AVATAR_IDS: lista immutabile');

  const pA = g8.addPlayer('Alice', 'volpe');
  assert(pA.avatar === 'volpe', 'addPlayer: avatar scelto registrato');
  assert(pA.connected === true, 'addPlayer: player nasce connesso');

  const pB = g8.addPlayer('Bob');
  assert(AVATAR_IDS.includes(pB.avatar), 'addPlayer senza avatar: assegnato un avatar valido');

  assertThrows(() => g8.addPlayer('Carl', 'dinosauro'), InvalidAvatarError,
    'addPlayer: avatar sconosciuto lancia InvalidAvatarError');

  g8.setPlayerConnected(pA.id, false);
  assert(g8.players.get(pA.id).connected === false, 'setPlayerConnected(false) applicato');
  g8.setPlayerConnected(pA.id, true);
  assert(g8.players.get(pA.id).connected === true, 'setPlayerConnected(true) applicato');
  assertThrows(() => g8.setPlayerConnected('id-inesistente', true), PlayerNotFoundError,
    'setPlayerConnected: player inesistente lancia PlayerNotFoundError');

  g8.startGame(0);
  const lb8 = g8.getLeaderboard();
  assert(lb8.every((p) => typeof p.avatar === 'string'), 'getLeaderboard: include avatar');
  assert(g8.getSnapshot().players.every((p) => 'connected' in p), 'getSnapshot: include connected');

  // 9a. Minigioco pianificato in editor (quiz.minigames) — Morra Cinese
  console.log('\n  🎲  Fase 9a: Minigioco pianificato (Morra Cinese)');
  const QUIZ_WITH_MINIGAME = {
    title: 'Quiz con minigioco pianificato',
    questions: [
      { text: 'Q1', options: ['A', 'B'], correct_index: 0, time_limit_s: 10 },
      { text: 'Q2', options: ['A', 'B'], correct_index: 1, time_limit_s: 10 },
    ],
    minigames: [{ afterQuestionIndex: 0, type: 'morra_cinese' }],
  };

  assert(MINIGAME_TYPE_KEYS.includes('morra_cinese'), 'MINIGAME_TYPE_KEYS: espone morra_cinese');

  const g9 = new GameSession(QUIZ_WITH_MINIGAME);
  assert(g9.rounds.length === 3, 'buildRounds: inserisce il minigioco pianificato nella sequenza (3 round totali)');
  assert(
    g9.rounds[0].kind === 'question' && g9.rounds[1].kind === 'minigame' && g9.rounds[2].kind === 'question',
    'buildRounds: ordine round atteso (domanda, minigioco, domanda)'
  );
  assert(g9.rounds[1].minigameType === 'morra_cinese', 'buildRounds: minigameType propagato sul round generato');
  assert(g9.rounds[1].correct_index === undefined, 'buildRounds: il round minigioco NON ha correct_index');

  const dan = g9.addPlayer('Dan');
  g9.startGame(0);
  assert(g9.getCurrentRound().kind === 'question', 'getCurrentRound: round 0 è una domanda vera');

  g9.submitAnswer(dan.id, 0, 500);
  g9.endQuestion(1000);
  const toMinigame = g9.nextQuestion(1000);
  assert(toMinigame.finished === false, 'nextQuestion: avanza sul round pianificato senza terminare la partita');

  const minigameRound = g9.getCurrentRound();
  assert(
    minigameRound.kind === 'minigame' && minigameRound.minigameType === 'morra_cinese',
    'getCurrentRound: round 1 riconosciuto come minigioco pianificato'
  );
  assert(
    minigameRound.options.length === 3 && minigameRound.correct_index === undefined,
    'getCurrentRound: minigioco con 3 opzioni e senza correct_index'
  );

  // Suspense preservata: submitAnswer su minigioco registra la scelta senza rivelare l'esito.
  const danMinigameAnswer = g9.submitAnswer(dan.id, 2, 1500); // Dan sceglie Forbice
  assert(
    danMinigameAnswer.recorded === true && danMinigameAnswer.correct === undefined,
    'submitAnswer: minigioco ritorna { recorded: true } senza rivelare l\'esito'
  );
  assert(
    g9.currentAnswers.get(dan.id).outcome === null,
    'submitAnswer: esito ancora nullo prima della chiusura (suspense)'
  );

  const scoreBeforeMinigame = dan.score;
  const minigameResults = g9.endQuestion(1000);
  assert(minigameResults.kind === 'minigame', 'endQuestion: kind minigame nel riepilogo');
  assert(minigameResults.correctIndex === null, 'endQuestion: minigioco senza correctIndex');
  assert(
    Number.isInteger(minigameResults.machineChoice) && minigameResults.machineChoice >= 0 && minigameResults.machineChoice <= 2,
    'endQuestion: machineChoice è una mossa valida (0-2)'
  );
  assert(minigameResults.revealMs === 10000, 'endQuestion: minigioco espone revealMs (durata sospensione) 10000');

  // Verifica deterministica anche con randomness: ricalcolo l'esito atteso dalla
  // mossa macchina rivelata e assertisco la coerenza esito ↔ punti (500/100/0).
  const danResult = minigameResults.answers.find((a) => a.playerId === dan.id);
  const d = (2 - minigameResults.machineChoice + 3) % 3; // 2 = mossa di Dan (Forbice)
  const expectedOutcome = d === 0 ? 'draw' : d === 1 ? 'win' : 'lose';
  const expectedPoints = { win: 500, draw: 100, lose: 0 }[expectedOutcome];
  assert(danResult.outcome === expectedOutcome, `endQuestion: esito coerente con la mossa macchina (${expectedOutcome})`);
  assert(danResult.pointsAwarded === expectedPoints, `endQuestion: punti coerenti con l'esito (${expectedPoints})`);
  assert(dan.score === scoreBeforeMinigame + expectedPoints, 'endQuestion: punti del minigioco sommati alla classifica');

  const toQ2 = g9.nextQuestion(1000);
  assert(toQ2.finished === false, 'nextQuestion: dal minigioco avanza alla domanda successiva pianificata');
  assert(g9.getCurrentRound().kind === 'question', 'getCurrentRound: round 2 torna a essere una domanda vera');

  g9.submitAnswer(dan.id, 1, 1500);
  g9.endQuestion(1000);
  const finalAdvance9 = g9.nextQuestion(1000);
  assert(finalAdvance9.finished === true, 'nextQuestion: la partita termina regolarmente dopo l\'ultimo round pianificato');

  // 9b. Minigioco manuale ad-hoc (insertMinigame, invocato dall'host durante RESULTS)
  console.log('\n  🎰  Fase 9b: Minigioco manuale ad-hoc (insertMinigame)');
  const g9b = new GameSession(QUIZ);
  assertThrows(() => g9b.insertMinigame('morra_cinese'), InvalidStateError,
    'insertMinigame: bloccato fuori da RESULTS (LOBBY)');

  const eve = g9b.addPlayer('Eve');
  g9b.startGame(0);
  assertThrows(() => g9b.insertMinigame('morra_cinese'), InvalidStateError,
    'insertMinigame: bloccato fuori da RESULTS (QUESTION)');

  g9b.submitAnswer(eve.id, 0, 500);
  g9b.endQuestion(1000); // -> RESULTS

  assertThrows(() => g9b.insertMinigame('tipo_inesistente'), InvalidMinigameTypeError,
    'insertMinigame: lancia InvalidMinigameTypeError per tipo sconosciuto');

  const roundsBeforeInsert = g9b.rounds.length;
  const insertResult = g9b.insertMinigame('morra_cinese', 2000);
  assert(g9b.rounds.length === roundsBeforeInsert + 1, 'insertMinigame: aggiunge un round alla sequenza');
  assert(insertResult.finished === false, 'insertMinigame: avanza subito sul round appena inserito');
  assert(g9b.state === STATES.QUESTION, 'insertMinigame: la partita torna in stato QUESTION');

  const insertedRound = g9b.getCurrentRound();
  assert(
    insertedRound.kind === 'minigame' && insertedRound.minigameType === 'morra_cinese',
    'insertMinigame: il round corrente è il minigioco appena inserito'
  );

  g9b.submitAnswer(eve.id, 0, 2500);
  const insertedResults = g9b.endQuestion(1000);
  assert(
    ['win', 'draw', 'lose'].includes(insertedResults.answers.find((a) => a.playerId === eve.id).outcome),
    'endQuestion: il minigioco ad-hoc assegna un esito valido'
  );
  // Il sigillo si ricalcola sulla sequenza reale, non sul piano iniziale: il
  // minigioco inserito a mano ha allungato la partita, quindi qui la classifica
  // torna a essere mostrabile.
  assert(insertedResults.isLastRound === false, 'endQuestion: isLastRound false dopo un inserimento ad-hoc a metà partita');
  const afterInsertedMinigame = g9b.nextQuestion(1000);
  assert(afterInsertedMinigame.finished === false, 'nextQuestion: dopo il minigioco ad-hoc avanza alla domanda successiva pianificata');

  g9b.submitAnswer(eve.id, 1, 1500);
  g9b.endQuestion(1000);
  const finalAfterInsert = g9b.nextQuestion(1000);
  assert(finalAfterInsert.finished === true, 'nextQuestion: la partita termina regolarmente dopo l\'inserimento ad-hoc');

  // ─── Minigioco con anteprima (Tre Bicchieri) ─────────────────────────────────
  // Lo spettacolo da seguire viene PRIMA della scelta: l'esito si estrae
  // all'apertura, le risposte restano chiuse per `previewMs`, e la chiusura
  // non deve estrarre un secondo esito che smentisca quello mostrato.

  console.log('\n  🥤  Fase 9c: Minigioco con anteprima (Tre Bicchieri)\n');

  // Generatore che restituisce 0.99 alla prima estrazione (→ Destra) e 0 dopo:
  // se la chiusura estraesse di nuovo, il risultato cambierebbe in Sinistra.
  let estrazioni = 0;
  const g9c = new GameSession(QUIZ, { rnd: () => (estrazioni++ === 0 ? 0.99 : 0) });
  const fay = g9c.addPlayer('Fay');
  g9c.startGame(0);
  g9c.submitAnswer(fay.id, 0, 500);
  g9c.endQuestion(1000);
  g9c.insertMinigame('cup_game', 2000);

  const cupRound = g9c.getCurrentRound();
  assert(cupRound.previewMs === 12000, 'getCurrentRound: il round con anteprima dichiara previewMs');
  assert(g9c.answersOpenAt === 14000, 'answersOpenAt: le risposte aprono dopo l\'anteprima');
  assert(
    cupRound.machineChoice === undefined && !('preview' in cupRound),
    'getCurrentRound: il round pubblico non contiene l\'esito'
  );
  assert(
    g9c.getRoundPreview()?.machineChoice === 2,
    'getRoundPreview: l\'esito è già estratto all\'apertura'
  );
  assertThrows(() => g9c.submitAnswer(fay.id, 2, 5000), AnswersNotOpenError,
    'submitAnswer: rifiutata durante l\'anteprima');
  g9c.submitAnswer(fay.id, 2, 14500);
  const cupResults = g9c.endQuestion(17000);
  assert(cupResults.machineChoice === 2, 'endQuestion: riusa l\'esito dell\'apertura, non ne estrae un altro');
  assert(
    cupResults.answers[0].outcome === 'win' && cupResults.answers[0].pointsAwarded === 400,
    'endQuestion: chi ha seguito la pallina vince 400 punti al livello'
  );
  assert(cupResults.revealMs === 4000, 'endQuestion: dopo l\'anteprima resta solo l\'alzata (revealMs)');

  // ─── Minigioco a più livelli ─────────────────────────────────────────────────
  // `stages: 5` → l'inserimento aggiunge cinque round di fila, ognuno con il
  // proprio livello; la difficoltà (scambi) cresce e l'anteprima si accorcia
  // dopo il primo, che apre con l'avviso.
  const cupStages = g9c.rounds.filter((r) => r.minigameType === 'cup_game');
  assert(cupStages.length === 5, 'stages: l\'inserimento di cup_game aggiunge 5 round');
  assert(
    cupStages.every((r, i) => r.stage.index === i && r.stage.count === 5),
    'stages: ogni round porta il proprio { index, count }'
  );
  assert(
    cupStages.every((r, i) => i === 0 || r.stage.swaps > cupStages[i - 1].stage.swaps),
    'stages: gli scambi crescono a ogni livello'
  );
  assert(cupResults.stage?.index === 0 && cupResults.stage?.count === 5,
    'endQuestion: i risultati dicono a che livello si è');
  g9c.nextQuestion(19000);
  assert(g9c.getCurrentRound().previewMs === 9000 && g9c.answersOpenAt === 28000,
    'stages: dal secondo livello l\'anteprima è più corta');
  assert(g9c.getRoundPreview() !== null, 'stages: ogni livello estrae il proprio esito all\'apertura');

  // ─── Sipario prima del minigioco ─────────────────────────────────────────────
  // In sala ogni minigioco si apre con le tende e la ruota: il server riserva
  // quel tempo PRIMA dell'anteprima e delle risposte, una volta sola anche per
  // un minigioco a più livelli. Le domande non hanno sipario.

  console.log('\n  🎭  Fase 9d: Sipario prima del minigioco\n');

  const g9d = new GameSession(QUIZ, { rnd: () => 0, minigameIntroMs: 12000 });
  const gus = g9d.addPlayer('Gus');
  g9d.startGame(0);
  assert(g9d.getCurrentRound().introMs === 0 && g9d.answersOpenAt === 0,
    'sipario: una domanda non ce l\'ha, si risponde subito');
  g9d.submitAnswer(gus.id, 0, 500);
  g9d.endQuestion(1000);

  g9d.insertMinigame('morra_cinese', 2000);
  const morraRound = g9d.getCurrentRound();
  assert(morraRound.introMs === 12000 && morraRound.previewMs === 0,
    'sipario: un minigioco senza anteprima dichiara solo il sipario');
  assert(g9d.answersOpenAt === 14000, 'sipario: le risposte aprono a sipario finito');
  assertThrows(() => g9d.submitAnswer(gus.id, 0, 8000), AnswersNotOpenError,
    'sipario: risposta rifiutata a tende ancora in scena');
  g9d.submitAnswer(gus.id, 0, 14000);
  g9d.endQuestion(20000);

  g9d.insertMinigame('cup_game', 30000);
  const cupFirst = g9d.getCurrentRound();
  assert(cupFirst.introMs === 12000 && cupFirst.previewMs === 12000,
    'sipario: col sipario l\'anteprima resta intera, non si accorcia');
  assert(g9d.introEndsAt === 42000 && g9d.answersOpenAt === 54000,
    'sipario: prima le tende, poi l\'anteprima, poi le risposte');
  g9d.endQuestion(60000);
  g9d.nextQuestion(65000);
  assert(g9d.getCurrentRound().stage.index === 1 && g9d.getCurrentRound().introMs === 0,
    'sipario: dal secondo livello niente tende, la scena continua');
  assert(g9d.answersOpenAt === 65000 + 9000, 'sipario: al secondo livello resta solo l\'anteprima');


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

  // ─── Riepilogo ──────────────────────────────────────────────────────────────────

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Risultato: ${passed} passati, ${failed} falliti`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  process.exit(failed > 0 ? 1 : 0);
}

run();
