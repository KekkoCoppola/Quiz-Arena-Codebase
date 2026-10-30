'use strict';

/**
 * server/debug-tools.js
 *
 * Eventi della pagina di debug dei minigiochi (`client/debug/`): con un clic si
 * prova un minigioco con pubblico finto — sipario, minigioco, risultati e, con
 * "Avanti", la premiazione — senza creare la partita a mano.
 *
 * È un attrezzo di sviluppo, non una funzione del prodotto. Si accende solo con
 * `DEBUG_TOOLS=1` (`config.debugTools`); spento, nessun evento di questo file
 * esiste e `/debug` non è servita.
 *
 * Non scrive lo stato di game-socket.js: riceve in `ctx` solo le operazioni che
 * gli servono. E usa solo le API pubbliche di GameSession, così prova lo stesso
 * gioco che vede una sala vera.
 *
 * ── Per toglierlo del tutto ──────────────────────────────────────────────────
 *  1. cancellare questo file e la cartella `client/debug/`;
 *  2. in `server/game-socket.js`, la riga `attachDebugHandlers(...)` e il suo require;
 *  3. in `server/index.js`, il mount di `/debug`;
 *  4. in `server/config.js`, `debugTools` (e `DEBUG_TOOLS` in `.env.example`);
 *  5. la Fase 11 di `tools/test-socket.js` e `DEBUG_TOOLS` nel suo `startServer`.
 */

const minigames = require('./minigames');
const testBots = require('./test-bots');
const { STATES } = require('./game');

/**
 * Quiz della partita di prova: una domanda sola, che non viene mai mostrata.
 * Serve solo a portare la partita da LOBBY a RESULTS, l'unico stato da cui
 * `insertMinigame` può inserire il minigioco, che così diventa l'ultimo round:
 * dopo i suoi risultati "Avanti" porta alla premiazione.
 */
const DEBUG_QUIZ = Object.freeze({
  title: 'Debug minigiochi',
  questions: [
    { text: 'Domanda segnaposto', options: ['A', 'B'], correct_index: 0, time_limit_s: 5 },
  ],
  minigames: [],
});

/**
 * @param {import('socket.io').Socket} socket
 * @param {{
 *   ok: (cb: Function, data?: object) => void,
 *   fail: (cb: Function, error: string) => void,
 *   requireHost: (cb: Function) => boolean,
 *   getSession: () => (import('./game').GameSession | null),
 *   newSession: (quiz: object) => import('./game').GameSession,
 *   spawnBots: (count: number) => number,
 *   broadcastLobby: () => void,
 *   emitQuestion: () => void,
 * }} ctx
 */
function attachDebugHandlers(socket, ctx) {
  const { ok, fail, requireHost } = ctx;

  socket.on('debug:minigames', (_payload, cb) => {
    if (!requireHost(cb)) return;
    ok(cb, { list: minigames.listForUi() });
  });

  // Partita nuova sul quiz segnaposto, con i bot in lobby. Chiude quella in
  // corso: è il "ricomincia" di ogni prova.
  socket.on('debug:prepare', (payload, cb) => {
    if (!requireHost(cb)) return;
    const session = ctx.newSession(DEBUG_QUIZ);
    ctx.spawnBots(testBots.normalizeCount(payload?.bots));
    ctx.broadcastLobby();
    ok(cb, { players: session.getPlayers() });
  });

  // Dalla lobby, dritti al minigioco: la domanda segnaposto si apre e si
  // chiude senza essere trasmessa, poi il minigioco viene inserito e parte.
  socket.on('debug:play', (payload, cb) => {
    if (!requireHost(cb)) return;
    const session = ctx.getSession();
    if (!session) return fail(cb, 'Prepara prima la partita.');
    if (session.state !== STATES.LOBBY) {
      return fail(cb, 'La partita di prova è già partita: premi di nuovo un minigioco per ricominciare.');
    }
    // Controllato prima di avviare: un tipo sbagliato non deve lasciare una
    // partita avviata a metà.
    if (!minigames.isValidSlotType(payload?.type)) return fail(cb, 'Minigioco sconosciuto.');

    try {
      session.startGame();
      session.endQuestion();
      session.insertMinigame(payload.type);
    } catch (err) {
      return fail(cb, err.message);
    }
    ok(cb);
    ctx.emitQuestion();
  });
}

module.exports = { attachDebugHandlers, DEBUG_QUIZ };
