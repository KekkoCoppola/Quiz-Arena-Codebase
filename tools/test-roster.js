'use strict';

/**
 * tools/test-roster.js
 *
 * Smoke test isolato per client/sala/answer-roster.js: chi siede nella colonna
 * dei giocatori della sala durante un minigioco, e in che gruppi si dividono
 * dopo il reveal. Decisioni pure, senza DOM: il disegno lo verifica il browser.
 *
 * Utilizzo: node tools/test-roster.js
 */

const {
  seatsForRound, outcomeGroups, OUTCOME_LABELS,
} = require('../client/sala/answer-roster');

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

const ids = (list) => list.map((x) => x.id).join(',');

const players = [
  { id: 'A', nickname: 'Anna', avatar: 'coral_red:happy', connected: true },
  { id: 'B', nickname: 'Bea', avatar: 'lime_green:cool', connected: true },
  { id: 'C', nickname: 'Ciro', avatar: 'hot_pink:wink', connected: false },
];

console.log('\n  🪑  Posti della colonna');

const empty = seatsForRound(players, []);
assert(ids(empty) === 'A,B', 'un posto per ogni giocatore connesso, nell\'ordine di ingresso');
assert(empty.every((s) => s.answered === false), 'nessuno ha ancora scelto');

const afterB = seatsForRound(players, ['B']);
assert(ids(afterB) === 'A,B', 'chi sceglie non cambia posto');
assert(afterB[1].answered === true && afterB[0].answered === false, 'chi ha scelto è segnato');
assert(afterB[1].nickname === 'Bea' && afterB[1].avatar === 'lime_green:cool', 'il posto porta nome e avatar');

assert(ids(seatsForRound(players, ['C'])) === 'A,B,C',
  'chi ha scelto e poi si è disconnesso resta seduto');
assert(ids(seatsForRound(players, ['Z'])) === 'A,B',
  'un id che la sala non conosce ancora non rompe la colonna');

console.log('\n  🏁  Gruppi dopo il reveal');

const results = {
  answers: [
    { playerId: 'A', nickname: 'Anna', avatar: 'coral_red:happy', outcome: 'win', pointsAwarded: 500 },
    { playerId: 'B', nickname: 'Bea', avatar: 'lime_green:cool', outcome: 'draw', pointsAwarded: 100 },
  ],
  leaderboard: [
    { rank: 1, id: 'A', nickname: 'Anna', avatar: 'coral_red:happy', score: 500 },
    { rank: 2, id: 'B', nickname: 'Bea', avatar: 'lime_green:cool', score: 100 },
    { rank: 3, id: 'C', nickname: 'Ciro', avatar: 'hot_pink:wink', score: 0 },
  ],
};

const groups = outcomeGroups(results);
assert(groups.map((g) => g.outcome).join(',') === 'win,draw,none',
  'vinto, pareggio, poi chi non ha scelto; i gruppi vuoti non compaiono');
assert(groups[0].points === 500 && groups[1].points === 100 && groups[2].points === 0,
  'ogni gruppo porta i punti presi');
assert(ids(groups[0].players) === 'A' && ids(groups[1].players) === 'B' && ids(groups[2].players) === 'C',
  'ognuno nel gruppo del proprio esito');
assert(groups[0].label === 'Hanno vinto' && groups[1].label === 'Pareggio'
  && groups[2].label === 'Non hanno scelto', 'etichette dei gruppi');
assert(OUTCOME_LABELS.lose === 'Hanno perso', 'etichetta di chi ha perso');
assert(groups[2].players[0].nickname === 'Ciro' && groups[2].players[0].avatar === 'hot_pink:wink',
  'chi non ha scelto porta nome e avatar dalla classifica');

// Chi se n'è andato prima del round (non connesso, senza risposta) non era
// seduto: non va fra chi "non ha scelto", o un telefono spento a inizio
// serata comparirebbe in ogni Morra.
const seatedOnly = outcomeGroups(results, ['A', 'B']);
assert(seatedOnly.map((g) => g.outcome).join(',') === 'win,draw',
  'chi non era seduto alla chiusura non finisce fra chi non ha scelto');
assert(ids(outcomeGroups(results, ['A', 'B', 'C']).at(-1).players) === 'C',
  'chi era seduto e non ha scelto resta fra chi non ha scelto');

const nobody = outcomeGroups({ answers: [], leaderboard: results.leaderboard });
assert(nobody.length === 1 && nobody[0].outcome === 'none' && nobody[0].players.length === 3,
  'se nessuno ha scelto, un gruppo solo con tutti');

console.log(`\n${passed} passati, ${failed} falliti`);
if (failed > 0) process.exitCode = 1;
