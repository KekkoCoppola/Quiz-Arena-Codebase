'use strict';

/* eslint-disable */

/**
 * client/shared/minigames/_TEMPLATE.js
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │  MODELLO — non è un minigioco reale e non viene caricato da nessuna SPA.  │
 * │  Copialo in `<nome-gioco>.js` e riempilo. Vedi la checklist completa in   │
 * │  `server/minigames/_TEMPLATE.js`.                                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Questo è il lato PRESENTAZIONE: come il minigioco si vede sullo schermo
 * della sala (lo schermo proiettato) e sul telefono del giocatore.
 * Le regole — punti, esiti, scelta della macchina — stanno nel gemello
 * `server/minigames/<nome-gioco>.js` e non vanno duplicate qui.
 *
 * ═══ TUTTO È FACOLTATIVO TRANNE type E label ════════════════════════════════
 *
 *  Il registry completa ciò che non definisci con una presentazione generica
 *  funzionante (lettere A/B/C, reveal testuale). Puoi partire da 5 righe e
 *  arricchire dopo, un pezzo alla volta, senza mai rompere la partita.
 *
 * ═══ LE DUE REGOLE DA NON VIOLARE ═══════════════════════════════════════════
 *
 *  A. Niente DOM al caricamento. `document`, `window.getComputedStyle` e simili
 *     solo DENTRO le funzioni. Il file viene caricato anche da Node in
 *     tools/test-minigames.js, dove `document` non esiste: se lo tocchi al
 *     primo livello, il test fallisce subito (ed è voluto).
 *
 *  B. Ogni classe CSS che usi è prefissata `.mg-<tipo-con-trattini>-` e vive
 *     nella tua sezione di `minigames.css`. Non riusare le classi di un altro
 *     minigioco e non modificarne le regole.
 *
 * ═══ DUE SCHERMI, DUE ESIGENZE DIVERSE ══════════════════════════════════════
 *
 *  Host   → grande, leggibile dall'ultima fila, con un momento di attesa e un
 *           reveal che vale la pena guardare. È l'unico punto del prodotto in
 *           cui lo spettacolo è la funzione.
 *  Player → piccolo, tattile, giocabile in pochi secondi senza leggere.
 *
 *  Sono due funzioni separate proprio perché non devono somigliarsi.
 */

(function (root, factory) {
  const registry = (typeof module !== 'undefined' && module.exports)
    ? require('./index')
    : root.Minigames;
  registry.register(factory());
})(typeof self !== 'undefined' ? self : this, function () {

  // Stato privato del modulo (handle di timer, cache di asset...). Vive qui,
  // invisibile al resto del client. Ricordati di ripulirlo in stopSuspense().
  let suspenseHandle = null;

  return {
    /** DEVE combaciare con il `type` del gemello lato server. */
    type: 'nome_minigioco',

    /** Nome leggibile, usato nei fallback e nella diagnostica. */
    label: 'Nome Minigioco',

    /** Riga di stato mostrata all'host mentre il round è aperto. */
    hostStatusText: '🎲 Minigioco: Nome Minigioco in corso…',

    /** Badge mostrato al giocatore al posto del contatore "3/10". */
    playerBadge: '🎲 Nome Minigioco!',

    /**
     * Classe applicata al contenitore dei bottoni risposta sul player, se il
     * tuo minigioco vuole una disposizione diversa dalla colonna standard.
     * `null` = disposizione normale.
     */
    playerLayoutClass: null,

    /**
     * Icona della scelta `i`, usata da entrambe le SPA.
     * Restituisci `null` per ricadere sulla lettera A/B/C.
     * @returns {Node | null}
     */
    optionIcon(i) {
      return null;
    },

    /**
     * Quale riga evidenziare nella distribuzione delle risposte sull'host.
     * Il default (la scelta della macchina) va bene quasi sempre: ridefiniscila
     * solo se il tuo minigioco non ha una singola scelta "della macchina".
     */
    highlightIndex(results) {
      return results.machineChoice;
    },

    sala: {
      /**
       * Round aperto: la sala aspetta e nessuno sa ancora nulla.
       * Qui va l'animazione di attesa — è il momento di suspense.
       * @param {{ questionText: HTMLElement }} els
       * @param {object} round payload `game:question`
       */
      startSuspense(els, round) {
        els.questionText.textContent = round.text;
      },

      /**
       * Ferma l'animazione. Viene chiamata alla chiusura del round, al cambio
       * schermata e alla disconnessione: DEVE poter essere invocata più volte
       * di fila senza effetti collaterali.
       */
      stopSuspense() {
        if (suspenseHandle) {
          clearInterval(suspenseHandle);
          suspenseHandle = null;
        }
      },

      /**
       * Il reveal davanti alla sala. `els.questionText` è lo spazio grande in
       * cui hai fatto la suspense, `els.correctAnswer` la riga sotto.
       * @param {{ questionText: HTMLElement, correctAnswer: HTMLElement }} els
       * @param {object} results payload `game:results` (machineChoice, distribution…)
       * @param {string[]} options etichette del round corrente
       */
      reveal(els, results, options) {
        els.correctAnswer.textContent =
          `Il computer ha scelto: ${options[results.machineChoice] ?? '—'}`;
      },
    },

    player: {
      /**
       * Riempie il bottone di una scelta. Il click è già agganciato: qui dentro
       * si decide solo che aspetto ha.
       * Se non usi testo visibile, imposta `aria-label` — l'accessibilità non è
       * facoltativa (vedi PRODUCT.md).
       * @param {HTMLButtonElement} btn
       * @param {number} i
       * @param {string} option
       */
      renderChoice(btn, i, option) {
        btn.className = 'answer-btn';
        btn.textContent = option;
      },

      /**
       * L'esito personale sul telefono. Riusa gli sticker già esistenti:
       * `is-correct` (bene), `is-wrong` (male), `is-neutral` (né l'uno né l'altro).
       * @param {{ sticker: HTMLElement, text: HTMLElement, points: HTMLElement }} els
       * @param {object | null} mine la mia risposta, `null` se non ho risposto in tempo
       * @param {object} results payload `game:results`
       */
      reveal(els, mine, results) {
        if (!mine) {
          els.sticker.classList.add('is-neutral');
          els.text.textContent = 'Tempo scaduto!';
          els.points.textContent = '+0 punti';
          return;
        }
        els.sticker.classList.add(mine.outcome === 'win' ? 'is-correct' : 'is-wrong');
        els.text.textContent = mine.outcome === 'win' ? 'HAI VINTO!' : 'HAI PERSO';
        els.points.textContent = `+${mine.pointsAwarded} punti`;
      },
    },
  };
});
