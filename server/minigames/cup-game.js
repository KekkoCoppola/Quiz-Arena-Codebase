'use strict';

/**
 * server/minigames/cup-game.js
 *
 * Regole del minigioco "Tre Bicchieri" (gioco delle tre campanelle / cup game).
 * Questo file contiene TUTTO ciò che il server sa di questo minigioco e
 * nient'altro: per cambiarne punti, tempi o meccanica si apre solo qui.
 *
 * La resa grafica (scena 3D in sala, fallback 2D, mescolamento cosmetico,
 * icone e reveal sul telefono) non sta qui ma in
 * client/shared/minigames/cup-game.js — stesso confine netto fra logica e
 * presentazione usato da server/minigames/morra-cinese.js.
 *
 * Contratto e regole per i minigiochi: vedi `_TEMPLATE.js`.
 */

module.exports = {
  // Chiave stabile nel DB (quizzes.minigames): combacia con il nome del file
  // cup-game.js convertendo i trattini in underscore.
  type: 'cup_game',
  label: 'Tre Bicchieri',
  description: 'Tre bicchieri e una pallina: segui il mescolamento sullo schermo, poi indovina dov\'è.',

  // "Segui i bicchieri": prima si guarda, poi si sceglie. Per i primi
  // `previewMs` la sala mostra la pallina sotto il bicchiere centrale, lo
  // copre e mescola fino a fermarsi su machineChoice; le risposte restano
  // chiuse. Per questo l'esito si estrae all'APERTURA del round (game.js) e
  // non alla chiusura: lo spettacolo deve già sapere dove finire.
  previewMs: 10000,
  defaultTimeLimitS: 8,
  // Dopo la chiusura resta solo l'alzata: il bicchiere vincente si solleva e
  // il verdetto resta fermo 2 secondi. Noto al server per calcolare revealAt
  // e sincronizzare sala e telefoni.
  revealMs: 4000,
  prompt: 'Dov\'è la pallina?',

  // L'indice è l'identità della posizione vista dal pubblico davanti al
  // proiettore (e replicata nello stesso ordine da sinistra a destra sui
  // telefoni): 0 = Sinistra, 1 = Centro, 2 = Destra.
  options: ['Sinistra', 'Centro', 'Destra'],

  // Qui non esiste un esito intermedio ("draw"): sotto un bicchiere o c'è la
  // pallina o il bicchiere è vuoto. Poiché la probabilità di indovinare è 1 su 3
  // (senza il cuscinetto del pareggio da 100 punti presente nella Morra Cinese),
  // la vittoria vale 600 punti così il valore atteso per round (600 × 1/3 = 200)
  // resta bilanciato rispetto agli altri minigiochi (500 × 1/3 + 100 × 1/3 = 200).
  points: { win: 600, lose: 0 },

  /**
   * Descrittore del round inviato ai client all'apertura.
   * Nessun `correct_index`: la posizione finale della pallina viene estratta
   * solo alla chiusura del round in `resolve()`.
   * @returns {object}
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
   * Estrae la posizione finale della pallina — una sola per tutta la sala, così
   * il mescolamento proiettato ha un unico esito condiviso — e restituisce la
   * funzione pura che classifica la scelta di ciascun giocatore.
   *
   * @param {() => number} [rnd] generatore in [0, 1), iniettabile per i test
   * @returns {{ machineChoice: number, outcomeFor: (optionIndex: number) => string }}
   */
  resolve(rnd = Math.random) {
    const machineChoice = Math.floor(rnd() * this.options.length);
    return {
      machineChoice,
      outcomeFor(optionIndex) {
        return optionIndex === machineChoice ? 'win' : 'lose';
      },
    };
  },
};
