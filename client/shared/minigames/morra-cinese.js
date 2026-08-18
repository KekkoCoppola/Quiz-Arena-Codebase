'use strict';

/**
 * client/shared/minigames/morra-cinese.js
 *
 * Presentazione della Morra Cinese su host e player.
 * Le regole (punti, esiti, mossa del computer) non stanno qui ma in
 * server/minigames/morra-cinese.js: questo file sa solo come si vede.
 *
 * Per modificare l'aspetto della Morra Cinese — icone, animazione di attesa,
 * reveal — si apre solo questo file e la sua sezione in `minigames.css`.
 *
 * ⚠ Nessun accesso al DOM al caricamento: `document` compare solo dentro le
 * funzioni. È ciò che permette a tools/test-minigames.js di caricare il modulo
 * in Node e verificarne il contratto senza un browser.
 */

(function (root, factory) {
  const registry = (typeof module !== 'undefined' && module.exports)
    ? require('./index')
    : root.Minigames;
  registry.register(factory());
})(typeof self !== 'undefined' ? self : this, function () {

  // Indici allineati al server (0 = Sasso, 1 = Carta, 2 = Forbice).
  // Riordinare qui senza riordinare anche server/minigames/morra-cinese.js
  // significherebbe mostrare la mossa sbagliata.
  const LABELS = ['Sasso', 'Carta', 'Forbice'];
  const ASSETS = [
    '/resources/img/morra-cinese/sasso.svg',
    '/resources/img/morra-cinese/carta.svg',
    '/resources/img/morra-cinese/forbice.svg',
  ];

  /** Velocità del ciclo di suspense: abbastanza rapido da leggersi come "sta scegliendo". */
  const SUSPENSE_MS = 150;

  /** Handle dell'animazione di attesa. Vive qui perché è un dettaglio di questo minigioco. */
  let suspenseInterval = null;

  /**
   * Crea un <img> per la mossa `i`.
   * @param {number} i indice della mossa
   * @param {string} cls classi CSS (definite in minigames.css)
   */
  function moveImg(i, cls) {
    const img = document.createElement('img');
    img.src = ASSETS[i] ?? '';
    img.alt = LABELS[i] ?? '';
    img.className = cls;
    return img;
  }

  return {
    type: 'morra_cinese',
    label: 'Morra Cinese',

    hostStatusText: '🎲 Minigioco: Morra Cinese in corso…',
    playerBadge: '🎲 Morra Cinese!',
    playerLayoutClass: 'mg-morra-cinese-choices',

    optionIcon(i) {
      return moveImg(i, 'mg-morra-cinese-move');
    },

    sala: {
      /**
       * Attesa: le tre mosse si alternano rapidamente al posto del titolo,
       * così la sala capisce che il computer non ha ancora deciso.
       */
      startSuspense(els) {
        this.stopSuspense();
        let i = 0;
        suspenseInterval = setInterval(() => {
          els.questionText.innerHTML = '';
          els.questionText.appendChild(
            moveImg(i % ASSETS.length, 'mg-morra-cinese-move mg-morra-cinese-move-hero')
          );
          i++;
        }, SUSPENSE_MS);
      },

      stopSuspense() {
        if (suspenseInterval) {
          clearInterval(suspenseInterval);
          suspenseInterval = null;
        }
      },

      /** Reveal: il ciclo si ferma sulla mossa del computer, in grande. */
      reveal(els, results, options) {
        els.questionText.innerHTML = '';
        els.questionText.appendChild(
          moveImg(results.machineChoice, 'mg-morra-cinese-move mg-morra-cinese-move-hero')
        );
        els.correctAnswer.innerHTML = '';
        els.correctAnswer.append(
          document.createTextNode('Il computer ha scelto: '),
          moveImg(results.machineChoice, 'mg-morra-cinese-move mg-morra-cinese-move-inline'),
          document.createTextNode(` ${options[results.machineChoice] ?? '—'}`)
        );
      },
    },

    player: {
      /**
       * Sul telefono la scelta è un grande bottone rotondo con la sola icona:
       * niente testo, si gioca d'istinto in 8 secondi. L'etichetta resta
       * disponibile ai lettori di schermo via aria-label.
       */
      renderChoice(btn, i, option) {
        btn.className = 'answer-btn mg-morra-cinese-choice';
        btn.setAttribute('aria-label', option);
        btn.appendChild(moveImg(i, 'mg-morra-cinese-move-choice'));
      },

      /** Esito personale: confronto fra la mia mossa e quella del computer. */
      reveal(els, mine, results) {
        const machine = moveImg(results.machineChoice, 'mg-morra-cinese-move mg-morra-cinese-move-inline');

        if (!mine) {
          els.sticker.classList.add('is-neutral');
          els.text.textContent = 'Tempo scaduto!';
          els.points.innerHTML = '';
          els.points.append(
            document.createTextNode('Il PC ha scelto '),
            machine,
            document.createTextNode(' · +0 punti')
          );
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

        els.points.innerHTML = '';
        els.points.append(
          moveImg(mine.optionIndex, 'mg-morra-cinese-move mg-morra-cinese-move-inline'),
          document.createTextNode(' vs '),
          machine,
          document.createTextNode(` · +${mine.pointsAwarded} punti`)
        );
      },
    },
  };
});
