'use strict';

/**
 * server/minigames/morra-cinese.js
 *
 * Regole della Morra Cinese (sasso-carta-forbice) contro il computer.
 * Questo file contiene TUTTO ciò che il server sa di questo minigioco e
 * nient'altro: per cambiarne punti, tempo o meccanica si apre solo qui.
 *
 * La resa grafica (icone, suspense, reveal) non sta qui ma in
 * client/shared/minigames/morra-cinese.js — stesso confine fra logica e
 * presentazione già usato da server/game.js e client/host/app.js.
 *
 * Contratto e regole per scriverne uno nuovo: vedi `_TEMPLATE.js`.
 */

module.exports = {
  type: 'morra_cinese',
  label: 'Morra Cinese',
  description: 'Sasso, carta o forbice contro il computer: chi indovina la mossa vincente fa punti.',

  defaultTimeLimitS: 8,
  // Durata della sospensione/reveal DOPO la chiusura del round: la sala fa girare
  // la "ruota" delle mosse e la rallenta fino a fermarsi sulla mossa del computer.
  // È un valore di timing noto al server (come defaultTimeLimitS) perché serve a
  // sincronizzare l'istante di atterraggio fra sala e telefoni (vedi revealAt in
  // game-socket.js).
  revealMs: 10000,
  prompt: 'Sasso, Carta o Forbice?',

  // L'indice è l'identità della mossa: 0 = Sasso, 1 = Carta, 2 = Forbice.
  // Lo stesso ordine è replicato dalle icone lato client — non riordinare senza
  // aggiornare anche quelle.
  options: ['Sasso', 'Carta', 'Forbice'],

  // Il pareggio vale comunque qualcosa: chi ha giocato non deve sentirsi punito
  // per un esito che non dipendeva da lui.
  points: { win: 500, draw: 100, lose: 0 },

  /**
   * Descrittore del round inviato ai client all'apertura.
   * Nessun `correct_index`: la mossa del computer non esiste ancora.
   */
  build() {
    return {
      kind: 'minigame',
      minigameType: this.type,
      text: this.prompt,
      options: this.options,
      time_limit_s: this.defaultTimeLimitS,
    };
  },

  /**
   * Estrae la mossa del computer — una sola, valida per tutti i giocatori, così
   * la sala vede un unico reveal condiviso — e restituisce come classificare
   * ogni scelta rispetto a essa.
   *
   * @param {() => number} [rnd] generatore in [0, 1), iniettabile per i test
   */
  resolve(rnd = Math.random) {
    const machineChoice = Math.floor(rnd() * this.options.length);
    return {
      machineChoice,
      // Ciclo della morra: Sasso(0) → Carta(1) → Forbice(2) → Sasso(0).
      // Una scelta vince se sta esattamente "una avanti" al computer.
      outcomeFor(optionIndex) {
        const d = (optionIndex - machineChoice + 3) % 3;
        return d === 0 ? 'draw' : d === 1 ? 'win' : 'lose';
      },
    };
  },
};
