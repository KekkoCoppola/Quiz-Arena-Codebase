'use strict';

/**
 * tools/test-socket.js
 *
 * Test di integrazione per server/game-socket.js (Step 6).
 * Avvia il server reale come processo figlio su un DB temporaneo,
 * connette host + player via socket.io-client e gioca una partita
 * completa: lobby, domande, risultati, classifica finale, riavvio.
 *
 * Utilizzo: node tools/test-socket.js   (oppure: npm run test:socket)
 */

const os     = require('node:os');
const fs     = require('node:fs');
const path   = require('node:path');
const { spawn } = require('node:child_process');
const jwt    = require('jsonwebtoken');
const { io: ioc } = require('socket.io-client');

// La cartella dei quiz di sistema va decisa PRIMA di caricare la config, che
// legge process.env una sola volta al require. Senza questa riga il processo
// di test sincronizzerebbe i quiz VERI del progetto invece dei propri.
const quizzesDir = require('node:path').join(
  require('node:os').tmpdir(),
  `quizzata-test-socket-quizzes-${Date.now()}`
);
process.env.QUIZZES_DIR = quizzesDir;

const config = require('../server/config');
const db     = require('../server/quiz-manager');

const PORT = 3123;
const URL  = `http://localhost:${PORT}`;

// ─── Report ──────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✅  ${label}`); passed++; }
  else           { console.error(`  ❌  ${label}`); failed++; }
}

// ─── Helpers async ───────────────────────────────────────────────────────────────

/** Attende un singolo evento su un socket, con timeout. */
function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout in attesa di "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

/** Emit con ack promisificato. */
function emitAck(socket, event, payload, timeoutMs = 5000) {
  return socket.timeout(timeoutMs).emitWithAck(event, payload);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Setup DB temporaneo ─────────────────────────────────────────────────────────

const QUIZ_QUESTIONS = [
  { text: 'Capitale d\'Italia?', options: ['Roma', 'Milano', 'Napoli', 'Torino'], correct_index: 0, time_limit_s: 5 },
  { text: '2 + 2?',             options: ['3', '4', '5', '6'],                   correct_index: 1, time_limit_s: 5 },
];

// Quiz con un minigioco "Morra Cinese" pianificato dopo la prima domanda
// (Fase Minigiochi), usato per validare il trigger pianificato via socket.
const QUIZ_WITH_MINIGAME_QUESTIONS = [
  { text: 'Capitale della Francia?', options: ['Berlino', 'Parigi', 'Madrid', 'Roma'], correct_index: 1, time_limit_s: 5 },
  { text: '3 + 3?',                  options: ['5', '6', '7', '8'],                    correct_index: 1, time_limit_s: 5 },
];
const QUIZ_WITH_MINIGAME_SLOTS = [{ afterQuestionIndex: 0, type: 'morra_cinese' }];

const dbPath = path.join(os.tmpdir(), `quizzata-test-socket-${Date.now()}.sqlite`);

// I quiz di sistema vivono in file e il server riallinea il DB ad ogni avvio,
// cancellando le righe senza file corrispondente: seminare direttamente in
// tabella non funziona più, le fixture verrebbero spazzate via al boot del
// server figlio. Per questo il test scrive veri file JSON (vedi quizzesDir,
// dichiarata in cima al file).

function seedTempQuizzes() {
  fs.mkdirSync(quizzesDir, { recursive: true });
  fs.writeFileSync(
    path.join(quizzesDir, 'quiz-test-socket.json'),
    JSON.stringify({ title: 'Quiz Test Socket', category: 'Test', minigames: [], questions: QUIZ_QUESTIONS })
  );
  fs.writeFileSync(
    path.join(quizzesDir, 'quiz-test-socket-minigioco.json'),
    JSON.stringify({
      title: 'Quiz Test Socket — Minigioco pianificato',
      category: 'Test',
      minigames: QUIZ_WITH_MINIGAME_SLOTS,
      questions: QUIZ_WITH_MINIGAME_QUESTIONS,
    })
  );

  // initDb applica lo schema e sincronizza i file: da qui si ricavano gli id
  // veri, che non sono più prevedibili come lo erano gli INSERT in sequenza.
  db.initDb(dbPath);
  const righe = db.getDb()
    .prepare('SELECT id, slug FROM preloaded_quizzes')
    .all();
  db.closeDb();

  const trova = (slug) => righe.find((r) => r.slug === slug)?.id;
  return {
    quizId:             trova('quiz-test-socket'),
    quizWithMinigameId: trova('quiz-test-socket-minigioco'),
  };
}

// ─── Avvio server figlio ─────────────────────────────────────────────────────────

function startServer() {
  return spawn(
    process.execPath,
    [path.join(__dirname, '..', 'server', 'index.js')],
    {
      // Niente sipario prima dei minigiochi: qui si gioca a ritmo di test,
      // e i 12 s di tende terrebbero chiuse le risposte del round.
      env: {
        ...process.env, PORT: String(PORT), DB_PATH: dbPath, QUIZZES_DIR: quizzesDir,
        MINIGAME_INTRO_MS: '0',
      },
      stdio: 'ignore',
    }
  );
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${URL}/api/health`);
      if (res.ok) return;
    } catch { /* server non ancora pronto */ }
    await sleep(100);
  }
  throw new Error('Il server non ha risposto al health check entro 5 secondi.');
}

// ─── Test ────────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🧪  Quiz-Zata! — Test Integrazione: game-socket.js');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const { quizId, quizWithMinigameId } = seedTempQuizzes();
  const server = startServer();
  const sockets = [];

  try {
    await waitForHealth();
    console.log('  🎬  Server avviato su porta', PORT, '\n');

    const hostToken = jwt.sign(
      { userId: 9999, username: 'test-host' }, config.jwtSecret, { expiresIn: '1h' });

    const host     = ioc(URL, { auth: { token: hostToken } });
    const p1       = ioc(URL);
    const p2       = ioc(URL);
    const impostor = ioc(URL);
    sockets.push(host, p1, p2, impostor);

    await Promise.all([once(host, 'connect'), once(p1, 'connect'),
                       once(p2, 'connect'), once(impostor, 'connect')]);

    // 1. Autorizzazione
    console.log('  🔐  Fase 1: Autorizzazione');
    const denied = await emitAck(impostor, 'host:create-game', { quizId, quizType: 'preloaded' });
    assert(denied.ok === false, 'socket senza token: host:create-game rifiutato');

    const noGame = await emitAck(p1, 'player:join', { nickname: 'Alice' });
    assert(noGame.ok === false, 'player:join senza partita attiva rifiutato');

    // 2. Creazione partita e lobby
    console.log('\n  🎮  Fase 2: Creazione partita e lobby');
    const created = await emitAck(host, 'host:create-game', { quizId, quizType: 'preloaded' });
    assert(created.ok === true, 'host:create-game accettato con JWT valido');

    const badQuiz = await emitAck(host, 'host:create-game', { quizId: 99999, quizType: 'preloaded' });
    assert(badQuiz.ok === false, 'host:create-game con quiz inesistente rifiutato');

    // Ricrea la partita (il tentativo fallito non deve aver lasciato stato sporco)
    await emitAck(host, 'host:create-game', { quizId, quizType: 'preloaded' });

    const joined1 = await emitAck(p1, 'player:join', { nickname: 'Alice', avatarId: 'volpe' });
    assert(joined1.ok === true && typeof joined1.playerId === 'string'
      && typeof joined1.token === 'string' && joined1.avatar === 'volpe',
      'Alice entra in lobby (con token e avatar)');

    const dup = await emitAck(p2, 'player:join', { nickname: 'alice' });
    assert(dup.ok === false, 'nickname duplicato (case-insensitive) rifiutato');

    // Attende che il lobby-update di Alice sia stato consegnato all'host,
    // così la promise successiva cattura solo l'update di Bob (2 giocatori).
    await sleep(200);
    const lobbyPromise = once(host, 'game:lobby-update');
    const joined2 = await emitAck(p2, 'player:join', { nickname: 'Bob' });
    assert(joined2.ok === true, 'Bob entra in lobby');
    const lobby = await lobbyPromise;
    assert(lobby.players.length === 2, 'lobby-update: 2 giocatori');

    // 3. Domanda 1: chiusura anticipata (tutti rispondono)
    console.log('\n  ⏱️  Fase 3: Domanda 1 — chiusura anticipata');
    const q1Promise = once(p1, 'game:question');
    const startAck = await emitAck(host, 'host:start-game', null);
    assert(startAck.ok === true, 'host:start-game accettato');
    const q1 = await q1Promise;
    assert(q1.text === QUIZ_QUESTIONS[0].text, 'game:question: testo domanda 1');
    assert(q1.correct_index === undefined, 'game:question: correct_index MAI inviato');
    assert(typeof q1.endsAt === 'number' && q1.endsAt > Date.now(), 'game:question: endsAt futuro');

    const a1 = await emitAck(p1, 'player:answer', { optionIndex: 0 });
    assert(a1.ok === true && a1.correct === true && a1.pointsAwarded > 0, 'Alice: risposta corretta con punti');

    const again = await emitAck(p1, 'player:answer', { optionIndex: 1 });
    assert(again.ok === false, 'doppia risposta rifiutata');

    const resultsPromise = once(host, 'game:results');
    const closeStart = Date.now();
    const a2 = await emitAck(p2, 'player:answer', { optionIndex: 2 });
    assert(a2.ok === true && a2.correct === false && a2.pointsAwarded === 0, 'Bob: risposta sbagliata, 0 punti');

    const r1 = await resultsPromise;
    assert(Date.now() - closeStart < 1000, 'chiusura anticipata: results subito dopo ultima risposta');
    assert(r1.correctIndex === 0, 'results: correctIndex rivelato');
    assert(r1.distribution[0] === 1 && r1.distribution[2] === 1, 'results: distribuzione corretta');
    assert(r1.leaderboard[0].nickname === 'Alice', 'results: Alice in testa');

    // 4. Domanda 2: chiusura per timeout
    console.log('\n  ⏲️  Fase 4: Domanda 2 — chiusura per timeout');
    const q2Promise = once(p1, 'game:question');
    await emitAck(host, 'host:next-question', null);
    const q2 = await q2Promise;
    assert(q2.index === 1, 'game:question: indice domanda 2');

    await emitAck(p1, 'player:answer', { optionIndex: 1 }); // solo Alice risponde
    const r2 = await once(p2, 'game:results', 9000);        // Bob non risponde → si attende lo scadere dei 5s
    assert(r2.correctIndex === 1, 'results dopo timeout: correctIndex domanda 2');
    assert(r2.distribution[1] === 1, 'results dopo timeout: solo 1 risposta registrata');
    assert(r2.revealAt === undefined, 'results domanda normale: nessuna sospensione (revealAt assente)');

    // 5. Classifica finale
    console.log('\n  🏆  Fase 5: Classifica finale');
    const finalPromise = once(p1, 'game:final');
    await emitAck(host, 'host:next-question', null);
    const final = await finalPromise;
    assert(final.leaderboard.length === 2, 'game:final: classifica con 2 giocatori');
    assert(final.leaderboard[0].nickname === 'Alice', 'game:final: Alice vince');
    assert(final.leaderboard[0].score > final.leaderboard[1].score, 'game:final: punteggi ordinati');

    // 6. Riavvio partita
    console.log('\n  🔄  Fase 6: Riavvio partita');
    const resetPromise = once(p1, 'game:reset');
    const resetBobPromise = once(p2, 'game:reset');
    const lobbyAfterResetPromise = once(host, 'game:lobby-update');
    const restartAck = await emitAck(host, 'host:restart-game', null);
    assert(restartAck.ok === true, 'host:restart-game accettato da FINAL_LEADERBOARD');

    const reset = await resetPromise;
    assert(typeof reset.playerId === 'string' && reset.playerId !== joined1.playerId,
      'game:reset: nuovo playerId per Alice');
    const resetBob = await resetBobPromise;
    const bobToken = resetBob.token;
    assert(typeof reset.token === 'string' && reset.token.length > 0,
      'game:reset: contiene il nuovo token');

    const lobbyAfterReset = await lobbyAfterResetPromise;
    assert(lobbyAfterReset.players.length === 2, 'dopo riavvio: 2 giocatori in lobby');
    assert(lobbyAfterReset.players.every((p) => p.score === 0), 'dopo riavvio: punteggi azzerati');

    const restartAgain = await emitAck(host, 'host:restart-game', null);
    assert(restartAgain.ok === false, 'host:restart-game fuori da FINAL_LEADERBOARD rifiutato');

    // 6bis. Riconnessione con token (Fase 7)
    console.log('\n  🔌  Fase 6bis: Riconnessione con token');

    // Siamo in LOBBY dopo il riavvio. Avvia la partita.
    const q6Promise = once(p1, 'game:question');
    await emitAck(host, 'host:start-game', null);
    await q6Promise;

    // Bob (p2) si disconnette a domanda aperta: NON deve essere rimosso.
    const lobbyAfterDropPromise = once(host, 'game:lobby-update');
    p2.disconnect();
    const lobbyAfterDrop = await lobbyAfterDropPromise;
    assert(lobbyAfterDrop.players.length === 2, 'drop in partita: giocatore NON rimosso');
    assert(lobbyAfterDrop.players.some((p) => p.connected === false),
      'drop in partita: marcato disconnesso');

    // Alice risponde: il round si chiude subito perché è l'unica connessa.
    const r6Promise = once(host, 'game:results');
    await emitAck(p1, 'player:answer', { optionIndex: 0 });
    const r6 = await r6Promise;
    assert(r6.correctIndex === 0, 'chiusura anticipata conta solo i connessi');

    // Bob si riconnette da un socket nuovo con il token del suo game:reset.
    const p2bis = ioc(URL);
    sockets.push(p2bis);
    await once(p2bis, 'connect');
    const rejoined = await emitAck(p2bis, 'player:rejoin', { token: bobToken });
    assert(rejoined.ok === true, 'player:rejoin: accettato con token valido');
    assert(rejoined.nickname === 'Bob', 'player:rejoin: identità conservata');
    assert(rejoined.state === 'RESULTS', 'player:rejoin: stato corrente restituito');
    assert(Array.isArray(rejoined.leaderboard), 'player:rejoin in RESULTS: leaderboard presente');

    const badRejoin = await emitAck(p2bis, 'player:rejoin', { token: 'token-farlocco' });
    assert(badRejoin.ok === false, 'player:rejoin: token invalido rifiutato');

    // 7. Fine partita
    console.log('\n  🛑  Fase 7: Fine partita');

    // 7a. Una nuova host:create-game con sessione attiva e player connessi
    // deve notificare e disconnettere i vecchi player (non lasciarli orfani).
    const endedByCreatePromise = once(p1, 'game:ended');
    const createAgainAck = await emitAck(host, 'host:create-game', { quizId, quizType: 'preloaded' });
    assert(createAgainAck.ok === true, 'host:create-game con sessione attiva accettato');
    await endedByCreatePromise;
    assert(true, 'game:ended ricevuto da p1 dopo host:create-game su sessione con giocatori');

    // 7b. host:end-game per pulizia finale (nessun player connesso rimasto).
    const endGameAck = await emitAck(host, 'host:end-game', null);
    assert(endGameAck.ok === true, 'host:end-game accettato');

    // 8. Minigiochi — trigger pianificato (quiz.minigames) e manuale (host:insert-minigame)
    console.log('\n  🎲  Fase 8: Minigiochi');

    const p3 = ioc(URL);
    sockets.push(p3);
    await once(p3, 'connect');

    const createdMinigameQuiz = await emitAck(host, 'host:create-game', { quizId: quizWithMinigameId, quizType: 'preloaded' });
    assert(createdMinigameQuiz.ok === true, 'host:create-game con quiz "minigioco pianificato" accettato');
    await emitAck(p3, 'player:join', { nickname: 'Zoe' });

    // insertMinigame è consentito solo da RESULTS: rifiutato mentre la partita è ancora in LOBBY.
    const insertOutsideResults = await emitAck(host, 'host:insert-minigame', { type: 'morra_cinese' });
    assert(insertOutsideResults.ok === false, 'host:insert-minigame rifiutato fuori da RESULTS (LOBBY)');

    // 8a. Domanda 1 → il round pianificato subito dopo deve essere il minigioco.
    const q8_1Promise = once(p3, 'game:question');
    await emitAck(host, 'host:start-game', null);
    const q8_1 = await q8_1Promise;
    assert(q8_1.kind === 'question', 'game:question: round 0 è una domanda vera (kind)');

    const r8_1Promise = once(host, 'game:results');
    await emitAck(p3, 'player:answer', { optionIndex: 1 }); // unica connessa: chiusura anticipata
    await r8_1Promise;

    const q8_2Promise = once(p3, 'game:question');
    await emitAck(host, 'host:next-question', null);
    const q8_2 = await q8_2Promise;
    assert(q8_2.kind === 'minigame' && q8_2.minigameType === 'morra_cinese',
      'game:question: round pianificato riconosciuto come minigioco "morra_cinese"');
    assert(q8_2.options.length === 3 && q8_2.correct_index === undefined,
      'game:question: minigioco con 3 mosse e senza correct_index (suspense preservata)');

    // 8b. Dal minigioco: l'ack del player NON rivela l'esito; il reveal (game:results)
    // porta machineChoice. Poi l'host inserisce un secondo minigioco ad-hoc.
    const r8_2Promise = once(host, 'game:results');
    const minigameAnswerAck = await emitAck(p3, 'player:answer', { optionIndex: 2 }); // Forbice
    assert(minigameAnswerAck.recorded === true && minigameAnswerAck.correct === undefined,
      'player:answer: minigioco confermato senza rivelare l\'esito');
    const r8_2 = await r8_2Promise;
    assert(r8_2.kind === 'minigame', 'game:results: kind "minigame" propagato nel riepilogo');
    assert(Number.isInteger(r8_2.machineChoice) && r8_2.machineChoice >= 0 && r8_2.machineChoice <= 2,
      'game:results: machineChoice (mossa del PC) rivelato');
    assert(Number.isInteger(r8_2.revealAt) && r8_2.revealAt > Date.now(),
      'game:results: revealAt (timestamp sospensione ~10s) presente per il minigioco');
    assert(['win', 'draw', 'lose'].includes(r8_2.answers[0].outcome),
      'game:results: esito win/draw/lose assegnato al giocatore');

    const q8_3Promise = once(p3, 'game:question');
    const adHocAck = await emitAck(host, 'host:insert-minigame', { type: 'morra_cinese' });
    assert(adHocAck.ok === true, 'host:insert-minigame accettato da RESULTS');
    const q8_3 = await q8_3Promise;
    assert(q8_3.kind === 'minigame' && q8_3.minigameType === 'morra_cinese',
      'game:question: minigioco ad-hoc inserito manualmente riconosciuto');

    // 8c. Dopo il minigioco ad-hoc, la partita torna alla domanda 2 originariamente pianificata.
    const r8_3Promise = once(host, 'game:results');
    await emitAck(p3, 'player:answer', { optionIndex: 0 });
    await r8_3Promise;

    const q8_4Promise = once(p3, 'game:question');
    await emitAck(host, 'host:next-question', null);
    const q8_4 = await q8_4Promise;
    assert(q8_4.kind === 'question' && q8_4.text === QUIZ_WITH_MINIGAME_QUESTIONS[1].text,
      'game:question: dopo il minigioco ad-hoc la partita riprende la domanda pianificata successiva');

    const final8Promise = once(p3, 'game:final');
    await emitAck(p3, 'player:answer', { optionIndex: 1 });
    await once(host, 'game:results');
    await emitAck(host, 'host:next-question', null);
    const final8 = await final8Promise;
    assert(final8.leaderboard.length === 1, 'game:final: partita "minigioco" conclusa correttamente');

    await emitAck(host, 'host:end-game', null);

    // 9. Giocatori di prova (gesto nascosto del pannello host)
    console.log(`
  🤖  Fase 9: Giocatori di prova`);

    const impostor2 = ioc(URL); sockets.push(impostor2);
    await once(impostor2, 'connect');
    const botsDenied = await emitAck(impostor2, 'host:spawn-bots', { count: 3 });
    assert(botsDenied.ok === false, 'socket senza token: host:spawn-bots rifiutato');

    const botsNoGame = await emitAck(host, 'host:spawn-bots', { count: 3 });
    assert(botsNoGame.ok === false, 'senza partita attiva: host:spawn-bots rifiutato');

    await emitAck(host, 'host:create-game', { quizId, quizType: 'preloaded' });
    const p9 = ioc(URL); sockets.push(p9);
    await once(p9, 'connect');
    await emitAck(p9, 'player:join', { nickname: 'Umano', avatarId: 'gufo' });

    const botsAck = await emitAck(host, 'host:spawn-bots', { count: 5 });
    assert(botsAck.ok === true && botsAck.added === 5, 'host:spawn-bots: 5 giocatori aggiunti');
    assert(botsAck.total === 6, 'lobby: 5 bot + 1 umano');

    // Il conteggio arriva sporco dalla rete: non deve poter far esplodere nulla.
    const sporco = await emitAck(host, 'host:spawn-bots', { count: -4 });
    assert(sporco.ok === true && sporco.added > 0, 'conteggio non valido: si ripiega sul default');

    // La prova che conta: i bot rispondono DAVVERO. Se non lo facessero, il
    // round resterebbe aperto fino allo scadere del tempo e questa attesa
    // andrebbe in timeout invece di chiudersi in anticipo.
    const q9Promise = once(p9, 'game:question');
    await emitAck(host, 'host:start-game', null);
    const q9 = await q9Promise;
    const results9Promise = once(host, 'game:results');
    await emitAck(p9, 'player:answer', { optionIndex: 0 });
    const inizio = Date.now();
    const results9 = await results9Promise;
    const durata = Date.now() - inizio;

    assert(durata < q9.time_limit_s * 1000,
      `round chiuso in anticipo (${durata}ms < ${q9.time_limit_s * 1000}ms): i bot hanno risposto`);
    assert(results9.answers.length === results9.leaderboard.length,
      'ogni giocatore, bot compresi, risulta fra chi ha risposto');

    // Fuori dalla lobby non si entra più, bot inclusi.
    const tardi = await emitAck(host, 'host:spawn-bots', { count: 2 });
    assert(tardi.ok === false, 'a partita iniziata: host:spawn-bots rifiutato');

    await emitAck(host, 'host:end-game', null);

  } finally {
    for (const s of sockets) s.disconnect();
    server.kill();
    await sleep(300);
    try {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      fs.rmSync(quizzesDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Risultato: ${passed} superati, ${failed} falliti`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('\n  💥  Test interrotto:', err.message);
  process.exit(1);
});
