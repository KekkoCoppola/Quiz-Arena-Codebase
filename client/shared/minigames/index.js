'use strict';

/**
 * client/shared/minigames/index.js
 *
 * Registry di PRESENTAZIONE dei minigiochi, condiviso fra le due SPA
 * (host e player) e servito su `/shared`.
 *
 * Le regole di gioco non stanno qui: vivono in `server/minigames/`. Qui c'è solo
 * il "come si vede" — icone, animazione di suspense, reveal. Stesso confine fra
 * decisione e resa già usato da audio-logic.js e audio.js.
 *
 * Due garanzie che questo file offre al resto del client:
 *
 *   1. `get()` NON restituisce mai null. Un tipo sconosciuto (modulo non
 *      caricato, quiz salvato con un minigioco poi rimosso) ottiene una
 *      presentazione generica funzionante. Durante un evento dal vivo uno
 *      schermo generico è accettabile, uno schermo rotto no.
 *
 *   2. Ogni campo del contratto è facoltativo tranne `type` e `label`: una
 *      presentazione parziale viene completata con i default. Un minigioco
 *      nuovo è giocabile subito e si arricchisce dopo.
 *
 * Caricato come <script> dalle due SPA (espone window.Minigames) e come modulo
 * CommonJS da tools/test-minigames.js.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Minigames = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

  // ─── Presentazione di default ────────────────────────────────────────────────
  // È anche la documentazione eseguibile del contratto: ogni funzione qui sotto
  // mostra la firma che un modulo minigioco può sovrascrivere.

  const DEFAULT_PRESENTATION = {
    /** Testo di stato mostrato all'host durante il round. */
    hostStatusText: 'Minigioco in corso…',

    /** Badge mostrato al giocatore al posto del contatore "3/10". */
    playerBadge: '🎲 Minigioco!',

    /** Classe aggiunta al contenitore dei bottoni risposta del player. */
    playerLayoutClass: null,

    /**
     * Icona della scelta `i`, usata sia dall'host sia dal player.
     * `null` = nessuna icona, si ricade sulla lettera A/B/C.
     * @returns {Node | null}
     */
    optionIcon() {
      return null;
    },

    /**
     * Quale riga evidenziare nella distribuzione delle risposte lato host.
     * Per la quasi totalità dei minigiochi è la scelta della macchina.
     */
    highlightIndex(results) {
      return results.machineChoice;
    },

    host: {
      /**
       * Round aperto: la sala aspetta. Qui va l'animazione di attesa.
       * @param {{ questionText: HTMLElement }} els
       * @param {object} round payload game:question
       */
      startSuspense(els, round) {
        els.questionText.textContent = round.text;
      },

      /** Chiamata alla chiusura del round e a ogni cambio schermata: deve essere idempotente. */
      stopSuspense() {},

      /**
       * Reveal davanti alla sala.
       * @param {{ questionText: HTMLElement, correctAnswer: HTMLElement }} els
       * @param {object} results payload game:results
       * @param {string[]} options etichette del round corrente
       */
      reveal(els, results, options) {
        els.correctAnswer.textContent =
          `Il computer ha scelto: ${options[results.machineChoice] ?? '—'}`;
      },
    },

    player: {
      /**
       * Riempie il bottone di una scelta sul telefono del giocatore.
       * @param {HTMLButtonElement} btn bottone vuoto, già agganciato al click
       * @param {number} i indice della scelta
       * @param {string} option etichetta della scelta
       */
      renderChoice(btn, i, option) {
        btn.className = 'answer-btn';
        const letter = document.createElement('span');
        letter.className = 'letter';
        letter.textContent = LETTERS[i] ?? String(i + 1);
        const label = document.createElement('span');
        label.textContent = option;
        btn.append(letter, label);
      },

      /**
       * Esito personale sul telefono del giocatore.
       * @param {{ sticker: HTMLElement, text: HTMLElement, points: HTMLElement }} els
       *   `sticker` ha già le classi is-correct/is-wrong/is-neutral rimosse.
       * @param {object | null} mine la mia risposta, null se non ho risposto
       * @param {object} results payload game:results
       */
      reveal(els, mine, results) {
        if (!mine) {
          els.sticker.classList.add('is-neutral');
          els.text.textContent = 'Tempo scaduto!';
          els.points.textContent = '+0 punti';
          return;
        }
        if (mine.outcome === 'win') {
          els.sticker.classList.add('is-correct');
          els.text.textContent = 'HAI VINTO!';
        } else if (mine.outcome === 'lose') {
          els.sticker.classList.add('is-wrong');
          els.text.textContent = 'HAI PERSO';
        } else {
          els.sticker.classList.add('is-neutral');
          els.text.textContent = 'PAREGGIO';
        }
        els.points.textContent = `+${mine.pointsAwarded} punti`;
      },
    },
  };

  // ─── Registry ────────────────────────────────────────────────────────────────

  /** @type {Record<string, object>} */
  const registry = {};

  /**
   * Completa una presentazione parziale con i default, un livello alla volta:
   * un modulo che definisce solo `host.reveal` conserva `host.startSuspense`
   * di default invece di perderlo.
   */
  function withDefaults(def) {
    return {
      ...DEFAULT_PRESENTATION,
      ...def,
      host:   { ...DEFAULT_PRESENTATION.host,   ...(def.host   ?? {}) },
      player: { ...DEFAULT_PRESENTATION.player, ...(def.player ?? {}) },
    };
  }

  /**
   * Registra la presentazione di un minigioco. Ogni modulo si autoregistra al
   * caricamento: non esiste un elenco centrale da aggiornare.
   * @param {{ type: string, label: string }} def
   */
  function register(def) {
    if (!def || typeof def.type !== 'string' || !def.type) {
      throw new Error('Minigames.register: manca il campo "type".');
    }
    if (typeof def.label !== 'string' || !def.label) {
      throw new Error(`Minigames.register("${def.type}"): manca il campo "label".`);
    }
    registry[def.type] = withDefaults(def);
    return registry[def.type];
  }

  /** @returns {boolean} true se esiste una presentazione dedicata per questo tipo. */
  function has(type) {
    return Object.prototype.hasOwnProperty.call(registry, type);
  }

  /**
   * Presentazione di un tipo. Non fallisce mai: un tipo sconosciuto ottiene la
   * presentazione generica, con la propria `label` derivata dal tipo così
   * l'host vede comunque qualcosa di sensato a schermo.
   */
  function get(type) {
    if (has(type)) return registry[type];
    return withDefaults({
      type: type ?? 'sconosciuto',
      label: 'Minigioco',
    });
  }

  /** Tipi con una presentazione dedicata, per diagnostica. */
  function types() {
    return Object.keys(registry);
  }

  return { register, get, has, types, DEFAULT_PRESENTATION, LETTERS };
});
