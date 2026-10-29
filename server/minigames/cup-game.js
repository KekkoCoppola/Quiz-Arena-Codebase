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

/**
 * Scambi per livello: sono loro a fare la difficoltà. Il primo livello va
 * piano (≈1,3 s a scambio) per far capire il gioco; l'ultimo è quasi il
 * triplo più veloce (≈0,4 s a scambio) ed è lì che si decide chi segue davvero.
 */
const STAGE_SWAPS = [6, 8, 10, 12, 14];

/** Anteprima dei livelli dopo il primo: solo un avviso breve, poi si mescola. */
const STAGE_PREVIEW_MS = 9000;

module.exports = {
  // Chiave stabile nel DB (quizzes.minigames): combacia con il nome del file
  // cup-game.js convertendo i trattini in underscore.
  type: 'cup_game',
  label: 'Tre Bicchieri',
  description: 'Tre bicchieri e una pallina: segui il mescolamento sullo schermo, poi indovina dov\'è.',

  // Cinque round di fila, sempre più difficili: game.js li inserisce insieme e
  // game-socket.js li concatena senza aspettare l'host. La classifica si vede
  // solo dopo l'ultimo.
  stages: 5,

  // "Segui i bicchieri": prima si guarda, poi si sceglie. Per i primi
  // `previewMs` la sala mostra la pallina sotto il bicchiere centrale, lo
  // copre e mescola fino a fermarsi su machineChoice; le risposte restano
  // chiuse. Per questo l'esito si estrae all'APERTURA del round (game.js) e
  // non alla chiusura: lo spettacolo deve già sapere dove finire.
  // È la durata del primo livello, che apre con l'avviso "Segui la pallina!";
  // i successivi usano STAGE_PREVIEW_MS (vedi build).
  previewMs: 12000,
  defaultTimeLimitS: 6,
  // Dopo la chiusura resta solo l'alzata: il bicchiere vincente si solleva e
  // il verdetto resta fermo 2 secondi. Noto al server per calcolare revealAt
  // e sincronizzare sala e telefoni.
  revealMs: 4000,
  prompt: 'Dov\'è la pallina?',

  // L'indice è l'identità della posizione vista dal pubblico davanti al
  // proiettore (e replicata nello stesso ordine da sinistra a destra sui
  // telefoni): 0 = sinistra, 1 = centro, 2 = destra. Si sceglie per lettera:
  // in sala, a bicchieri fermi, la lettera compare sopra ciascun bicchiere, e
  // sul telefono una freccia sotto la lettera ricorda dove sta.
  options: ['A', 'B', 'C'],

  // Qui non esiste un esito intermedio ("draw"): sotto un bicchiere o c'è la
  // pallina o il bicchiere è vuoto. Punti fissi per livello (scelta di
  // prodotto): chi segue bene tutti e cinque i mescolamenti prende 2000.
  points: { win: 400, lose: 0 },

  /**
   * Descrittore di un livello. La difficoltà cresce col numero di scambi
   * (`stage.swaps`) eseguiti in un tempo quasi uguale: i bicchieri vanno
   * sempre più veloci. Dal secondo livello niente avviso lungo, quindi
   * un'anteprima più corta.
   * Nessun `correct_index`: la posizione finale la estrae `resolve()`.
   * @param {number} [stageIndex=0] livello, da 0 a `stages - 1`
   * @returns {object}
   */
  build(stageIndex = 0) {
    const level = Math.max(0, Math.min(STAGE_SWAPS.length - 1, stageIndex));
    return {
      kind: 'minigame',
      minigameType: this.type,
      text: this.prompt,
      options: this.options,
      time_limit_s: this.defaultTimeLimitS,
      previewMs: level === 0 ? this.previewMs : STAGE_PREVIEW_MS,
      stage: { swaps: STAGE_SWAPS[level] },
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
