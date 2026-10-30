'use strict';

/**
 * client/sala/answer-roster.js
 *
 * La colonna dei giocatori della sala durante un minigioco che la chiede
 * (`salaPlayers` nel contratto di presentazione): chi siede, chi ha già scelto,
 * e dopo il reveal in che gruppi si dividono. Solo decisioni, senza DOM: il
 * disegno sta in `sala/app.js`, come le decisioni audio stanno in
 * `audio-logic.js` e la riproduzione in `audio.js`. Testato da
 * tools/test-roster.js.
 *
 * Chi ha scelto si sa, cosa ha scelto no: qui non entra nessuna mossa prima
 * dei risultati.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AnswerRoster = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /** Ordine dei gruppi dopo il reveal: prima chi festeggia. */
  const OUTCOME_ORDER = ['win', 'draw', 'lose', 'none'];

  const OUTCOME_LABELS = Object.freeze({
    win: 'Hanno vinto',
    draw: 'Pareggio',
    lose: 'Hanno perso',
    none: 'Non hanno scelto',
  });

  /**
   * I posti della colonna per il round in corso: un posto per ogni giocatore
   * connesso, più chi ha già scelto e poi si è disconnesso (la sua scelta
   * vale). L'ordine è quello d'ingresso in partita e non cambia quando
   * qualcuno sceglie: con le facce che si spostano a ogni risposta la sala non
   * ritroverebbe nessuno. Un id che la sala non conosce ancora (risposta
   * arrivata prima dell'elenco aggiornato) si ignora.
   *
   * @param {Array<{ id: string, nickname: string, avatar: string, connected?: boolean }>} players
   * @param {string[]} answeredIds
   * @returns {Array<{ id: string, nickname: string, avatar: string, answered: boolean }>}
   */
  function seatsForRound(players, answeredIds) {
    const answered = new Set(answeredIds);
    return players
      .filter((p) => p.connected !== false || answered.has(p.id))
      .map((p) => ({
        id: p.id,
        nickname: p.nickname,
        avatar: p.avatar,
        answered: answered.has(p.id),
      }));
  }

  /**
   * I gruppi dopo il reveal, nell'ordine di `OUTCOME_ORDER`, senza quelli
   * vuoti. Chi non ha scelto non compare fra le risposte: lo si ricava dalla
   * classifica, che elenca tutti i giocatori della partita — anche chi se n'è
   * andato a inizio serata. Per questo `seatedIds` (i posti della colonna alla
   * chiusura) limita "non hanno scelto" a chi era davvero seduto; senza,
   * valgono tutti.
   *
   * @param {{ answers: Array<{ playerId: string, nickname: string, avatar: string, outcome: string, pointsAwarded: number }>, leaderboard: Array<{ id: string, nickname: string, avatar: string }> }} results
   * @param {string[]} [seatedIds]
   * @returns {Array<{ outcome: string, label: string, points: number, players: Array<{ id: string, nickname: string, avatar: string }> }>}
   */
  function outcomeGroups(results, seatedIds) {
    const seated = seatedIds ? new Set(seatedIds) : null;
    const byOutcome = new Map(OUTCOME_ORDER.map((o) => [o, { players: [], points: 0 }]));
    const answeredIds = new Set();

    for (const a of results.answers ?? []) {
      const group = byOutcome.get(a.outcome);
      if (!group) continue;
      answeredIds.add(a.playerId);
      group.players.push({ id: a.playerId, nickname: a.nickname, avatar: a.avatar });
      group.points = a.pointsAwarded ?? 0;
    }
    for (const p of results.leaderboard ?? []) {
      if (answeredIds.has(p.id) || (seated && !seated.has(p.id))) continue;
      byOutcome.get('none').players.push({ id: p.id, nickname: p.nickname, avatar: p.avatar });
    }

    return OUTCOME_ORDER
      .filter((o) => byOutcome.get(o).players.length > 0)
      .map((o) => ({
        outcome: o,
        label: OUTCOME_LABELS[o],
        points: o === 'none' ? 0 : byOutcome.get(o).points,
        players: byOutcome.get(o).players,
      }));
  }

  return { seatsForRound, outcomeGroups, OUTCOME_LABELS, OUTCOME_ORDER };
});
