'use strict';

/**
 * client/shared/minigames/index.js
 *
 * Registry di PRESENTAZIONE dei minigiochi, condiviso fra la vista sala e il
 * client player, e servito su `/shared`.
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
 * Caricato come <script> dalla vista sala e dal client player (espone
 * window.Minigames) e come modulo
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

    /**
     * Nastro sulla scheda in sala. `undefined` (default) = il nome del
     * minigioco; una stringa = quel testo; `null` = nessun nastro, quando la
     * scena si presenta da sola.
     * @type {string | null | undefined}
     */
    salaKicker: undefined,

    /**
     * Immagine del minigioco sullo spicchio della ruota che, nel sipario
     * d'apertura in sala (client/shared/stage-intro.js), lo estrae. URL di un
     * asset quadrato; `null` = lo spicchio porta un emblema generico.
     * @type {string | null}
     */
    wheelIcon: null,

    /**
     * Se in sala, sotto la scena, compaiono le carte delle scelte. `false` =
     * il minigioco è tutto palco: la scena prende anche lo spazio delle
     * carte, e a round chiuso non ci sono né la parata degli avatar (non c'è
     * dove posarli) né la riga di reveal sopra la classifica, perché l'esito
     * l'ha già messo in scena il palco. Si passa dritti alla classifica.
     * @type {boolean}
     */
    salaOptions: true,

    /**
     * Audio del minigioco in sala, con la stessa forma del manifest
     * (`resources/audio/manifest.json`) e percorsi relativi a
     * `/resources/audio/`:
     *   { music: { file, gain }, sfx: { evento: [{ file, gain }, ...] } }
     * La colonna sonora suona dall'apertura delle tende alla classifica, al
     * posto della musica della partita. Gli effetti li fa suonare il modulo
     * con `ctx.sfx('evento')` dentro `sala.startSuspense` / `sala.playReveal`:
     * `ctx.sfx` esiste solo in sala (il riquadro dell'host è muto), quindi va
     * chiamato come `ctx.sfx?.(…)`. `null` = nessun audio proprio.
     * @type {{ music?: object, sfx?: object } | null}
     */
    audio: null,

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
     * Quale riga evidenziare nella distribuzione delle risposte in sala.
     * Per la quasi totalità dei minigiochi è la scelta della macchina.
     */
    highlightIndex(results) {
      return results.machineChoice;
    },

    /**
     * Presentazione sullo schermo proiettato. Si chiama `sala` e non `host`
     * perché è la sala a vederla: sul tablet dell'host restano i comandi.
     * Il testo di stato per l'host è invece `hostStatusText`, qui sopra —
     * quello sì che è rivolto a chi conduce.
     */
    sala: {
      /**
       * Round aperto: la sala aspetta. Qui va l'animazione di attesa.
       * Chiamata anche dal pannello host, in un riquadro piccolo.
       *
       * Per un minigioco con anteprima (`previewMs` lato server), `round.preview`
       * porta l'esito già estratto (solo sala e host lo ricevono) e
       * `ctx.answersOpenAt` dice quando finisce lo spettacolo da seguire e
       * si apre la scelta, già sull'orologio locale.
       * @param {{ questionText: HTMLElement }} els
       * @param {object} round payload game:question
       * @param {{ answersOpenAt: number, isStale: () => boolean }} [ctx]
       */
      startSuspense(els, round) {
        els.questionText.textContent = round.text;
      },

      /** Chiamata alla chiusura del round e a ogni cambio schermata: deve essere idempotente. */
      stopSuspense() {},

      /**
       * OPZIONALE. Reveal animato e TEMPORIZZATO alla chiusura del round: se
       * definito, la sala lo usa al posto del breve drumroll fisso. Deve far
       * atterrare l'animazione esattamente a `ctx.revealAt` e poi chiamare
       * `ctx.done()`. Il timestamp è condiviso col telefono (payload
       * `game:results.revealAt`), così i due schermi si fermano insieme.
       * `null` = nessun reveal animato → la sala ricade sul drumroll breve.
       * @type {null | ((els: object, results: object, options: string[], ctx: { revealAt: number, isStale: () => boolean, done: () => void }) => void)}
       */
      playReveal: null,

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
       * OPZIONALE. Attesa sincronizzata sul telefono mentre in sala si svolge il
       * reveal: se definito, occupa lo schermo del giocatore fino a `ctx.revealAt`
       * e poi chiama `ctx.done()`; l'esito vero lo mostra dopo `reveal`.
       *
       * Regola: qui NON si rivela nulla dell'esito né della scelta della macchina.
       * Lo spettacolo è in sala — il telefono ci rimanda, non lo duplica.
       * Firma allineata a `reveal`: stessi argomenti più il contesto temporale.
       *
       * `null` = nessuna attesa dedicata (il player ricade su un'attesa generica
       * quando `game:results.revealAt` è presente).
       * @type {null | ((els: object, mine: object|null, results: object, ctx: { revealAt: number, isStale: () => boolean, done: () => void }) => void)}
       */
      playReveal: null,

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
   * un modulo che definisce solo `sala.reveal` conserva `sala.startSuspense`
   * di default invece di perderlo.
   */
  function withDefaults(def) {
    return {
      ...DEFAULT_PRESENTATION,
      ...def,
      sala:   { ...DEFAULT_PRESENTATION.sala,   ...(def.sala   ?? {}) },
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
