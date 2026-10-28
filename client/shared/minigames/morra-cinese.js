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
  /** Handle del requestAnimationFrame della ruota di reveal (sala e player). */
  let revealRaf = null;

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Ease-out cubico: gli scatti sono fitti all'inizio e via via più radi → la ruota rallenta. */
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /**
   * Quanto la mossa vincente resta ferma e leggibile PRIMA che si passi ai
   * risultati. Senza questa pausa la ruota si fermerebbe e la schermata
   * cambierebbe nello stesso istante: il pubblico non farebbe in tempo a
   * leggere la mossa, e sembrerebbe che il computer ne abbia scelta un'altra.
   */
  const HOLD_MS = 2000;

  /**
   * Scala della ruota al primo fotogramma della rotazione, in frazione della
   * sua dimensione finale. Da qui cresce fino a 1 nell'istante in cui si ferma.
   *
   * Non parte da zero di proposito: una ruota che nasce da un punto è un
   * effetto di apertura, mentre qui la crescita deve dire "sta per succedere
   * qualcosa" — la mossa dev'essere riconoscibile fin dal primo giro, altrimenti
   * la sala vede solo un puntino che si allarga e non capisce che sta girando.
   */
  const GROW_FROM = 0.42;

  /**
   * Ruota decelerante condivisa da sala e player. Fa scorrere le tre mosse con
   * scatti sempre più radi, si ferma su `machineChoice`, la tiene ferma per
   * `HOLD_MS` e solo allora chiama `ctx.done()`. L'istante di atterraggio è
   * calcolato da `ctx.revealAt`, che è lo stesso su ogni schermo.
   *
   * Ogni frame ridisegna l'icona tramite `paint(index, progress)`; `onLand` viene
   * chiamata una sola volta, all'atterraggio (è lì che vanno pop, etichetta e
   * coriandoli). Se il round viene superato (`ctx.isStale()`) l'animazione si
   * interrompe.
   *
   * `progress` è il tempo trascorso (0→1) LINEARE, non passato per
   * `easeOutCubic`: chi lo usa per far crescere la ruota vuole una crescita
   * costante fino all'ultimo scatto. Con la curva della decelerazione la
   * dimensione sarebbe quasi al massimo già a metà rotazione, e l'ultimo tratto
   * — quello in cui il pubblico guarda davvero — sembrerebbe fermo.
   *
   * @param {number} machineChoice mossa finale (0-2)
   * @param {(index: number, progress: number) => void} paint disegna la mossa `index`
   * @param {{ revealAt: number, isStale: () => boolean, done: () => void }} ctx
   * @param {() => void} [onLand] chiamata all'atterraggio, prima della pausa
   */
  function spinWheel(machineChoice, paint, ctx, onLand) {
    cancelReveal();
    const startAt = Date.now();
    // La ruota si ferma PRIMA di revealAt: l'ultimo tratto è pausa di lettura.
    const landAt = Math.max(startAt, ctx.revealAt - HOLD_MS);
    const spinMs = landAt - startAt;

    // Scatti totali: alcuni giri interi più l'offset che fa cadere l'ULTIMO
    // scatto animato su machineChoice. Il `+ 1` è essenziale: senza, l'ultimo
    // fotogramma visibile sarebbe quello PRECEDENTE alla mossa scelta
    // (con g→1⁻ l'indice si ferma a totalTicks-1), e la ruota sembrerebbe
    // fermarsi su una mossa diversa da quella annunciata.
    const CYCLES = 12;
    const totalTicks = CYCLES * ASSETS.length + machineChoice + 1;

    let landed = false;
    const land = () => {
      if (landed) return;
      landed = true;
      paint(machineChoice, 1);
      if (onLand) onLand();
    };

    const frame = () => {
      if (ctx.isStale()) { cancelReveal(); return; }
      const now = Date.now();

      if (!landed && now >= landAt) land();

      if (landed) {
        // Pausa di lettura: la mossa resta ferma finché non scade revealAt.
        if (now >= ctx.revealAt) { revealRaf = null; ctx.done(); return; }
        revealRaf = requestAnimationFrame(frame);
        return;
      }

      const t = spinMs > 0 ? Math.min(1, (now - startAt) / spinMs) : 1;
      paint(Math.floor(easeOutCubic(t) * totalTicks) % ASSETS.length, t);
      revealRaf = requestAnimationFrame(frame);
    };

    if (prefersReducedMotion) {
      // Niente lampeggio: la mossa è subito ferma e si attende comunque fino a
      // revealAt, così la sincronia con gli altri schermi resta intatta.
      land();
    }
    frame();
  }

  function cancelReveal() {
    if (revealRaf) {
      cancelAnimationFrame(revealRaf);
      revealRaf = null;
    }
  }

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
    wheelIcon: '/resources/img/morra-cinese/forbice.svg',

    optionIcon(i) {
      return moveImg(i, 'mg-morra-cinese-move');
    },

    sala: {
      /**
       * Attesa: le tre mosse si alternano rapidamente al posto del titolo,
       * così la sala capisce che il computer non ha ancora deciso.
       *
       * Stesso palcoscenico del reveal, costruito una volta: cambia solo la
       * sorgente dell'icona. Così la mossa resta nello stesso punto e alla
       * stessa misura quando l'attesa lascia il posto alla rotazione.
       */
      startSuspense(els) {
        this.stopSuspense();
        els.questionText.innerHTML = '';
        const stage = document.createElement('div');
        stage.className = 'mg-morra-cinese-stage is-suspense';
        const img = moveImg(0, 'mg-morra-cinese-move mg-morra-cinese-move-hero');
        stage.appendChild(img);
        els.questionText.appendChild(stage);
        let i = 1;
        suspenseInterval = setInterval(() => {
          img.src = ASSETS[i % ASSETS.length];
          img.alt = LABELS[i % ASSETS.length];
          i++;
        }, SUSPENSE_MS);
      },

      stopSuspense() {
        if (suspenseInterval) {
          clearInterval(suspenseInterval);
          suspenseInterval = null;
        }
        cancelReveal();
      },

      /**
       * Reveal spettacolare: alla chiusura la "ruota" delle tre mosse riparte e
       * RALLENTA fino a fermarsi sulla mossa del computer, che resta poi ferma
       * un paio di secondi prima che `ctx.done()` mostri distribuzione ed esiti.
       *
       * All'atterraggio la mossa viene annunciata in TRE modi diversi — scatto in
       * evidenza, nome scritto, coriandoli — perché in una sala il pubblico
       * guarda da lontano e di sbieco: un solo segnale si perde.
       */
      playReveal(els, results, options, ctx) {
        // Palcoscenico costruito una volta sola: durante la rotazione cambia
        // solo la sorgente dell'icona, non l'intero nodo. Così l'etichetta
        // sopravvive ai fotogrammi e l'animazione di scatto non riparte da capo.
        els.questionText.innerHTML = '';
        const stage = document.createElement('div');
        stage.className = 'mg-morra-cinese-stage';
        const img = moveImg(0, 'mg-morra-cinese-move mg-morra-cinese-move-hero');
        const verdict = document.createElement('p');
        verdict.className = 'mg-morra-cinese-verdict';
        stage.append(img, verdict);
        // Scala iniziale scritta PRIMA di attaccare la scena: senza, il primo
        // fotogramma dipinto dal browser userebbe il default della variabile
        // (1, cioè piena grandezza) e la ruota comparirebbe già enorme per poi
        // rimpicciolirsi — l'opposto della crescita che si vuole raccontare.
        stage.style.setProperty('--mg-mc-grow', String(GROW_FROM));
        els.questionText.appendChild(stage);

        // `grow` (0→1) è il tempo di rotazione trascorso. La scala vive in una
        // variabile CSS invece che in `img.style.transform` perché
        // all'atterraggio è il `@keyframes` del rimbalzo a prendere il comando
        // del transform: un transform inline verrebbe ignorato durante
        // l'animazione e tornerebbe a valere alla fine, facendo saltare la
        // mossa appena assestata. La misura resta così tutta nel CSS.
        const paint = (index, grow = 1) => {
          img.src = ASSETS[index] ?? '';
          img.alt = LABELS[index] ?? '';
          stage.style.setProperty(
            '--mg-mc-grow',
            String(GROW_FROM + (1 - GROW_FROM) * grow)
          );
        };

        spinWheel(results.machineChoice, paint, ctx, () => {
          stage.classList.add('is-landed');
          verdict.innerHTML = '';
          const kicker = document.createElement('span');
          kicker.className = 'mg-morra-cinese-verdict-kicker';
          kicker.textContent = 'Il computer ha scelto';
          const name = document.createElement('strong');
          name.textContent =
            options[results.machineChoice] ?? LABELS[results.machineChoice] ?? '—';
          verdict.append(kicker, name);
          // Il modulo dei coriandoli è facoltativo: se non è caricato, il reveal
          // resta perfettamente leggibile senza.
          if (typeof window !== 'undefined' && window.Confetti) {
            window.Confetti.burst({ count: 140, power: 19 });
          }
        });
      },

      /**
       * Stato finale: la mossa del computer resta in grande, già "atterrata".
       * Ricostruisce lo stesso palcoscenico di `playReveal` così l'immagine non
       * cambia forma passando ai risultati — e perché a questa funzione si arriva
       * anche senza rotazione (es. una sala che si riconnette a round chiuso).
       */
      reveal(els, results, options) {
        els.questionText.innerHTML = '';
        const stage = document.createElement('div');
        stage.className = 'mg-morra-cinese-stage is-landed';
        stage.appendChild(
          moveImg(results.machineChoice, 'mg-morra-cinese-move mg-morra-cinese-move-hero')
        );
        els.questionText.appendChild(stage);

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

      /**
       * Attesa sincronizzata sul telefono, mentre in sala la ruota rallenta.
       *
       * Il telefono NON rifà la ruota: mostra la mossa che il giocatore ha
       * scelto e lo manda a guardare lo schermo grande. Duplicare il reveal qui
       * dividerebbe l'attenzione proprio nel momento in cui la stanza dovrebbe
       * guardare insieme la stessa cosa — e trenta teste chine sul telefono sono
       * l'opposto dello spettacolo che il minigioco serve a creare.
       *
       * L'esito personale arriva dopo, in `reveal`, a `ctx.revealAt`.
       */
      playReveal(els, mine, results, ctx) {
        els.text.textContent = 'Guarda lo schermo!';
        els.points.innerHTML = '';

        const stage = document.createElement('span');
        stage.className = 'mg-morra-cinese-stage is-compact';

        if (mine) {
          stage.appendChild(
            moveImg(mine.optionIndex, 'mg-morra-cinese-move mg-morra-cinese-move-hero')
          );
        }

        const caption = document.createElement('span');
        caption.className = 'mg-morra-cinese-await';
        caption.textContent = mine
          ? 'La tua mossa — il computer sta scegliendo sullo schermo principale'
          : 'Non hai risposto in tempo — il computer sta scegliendo sullo schermo principale';
        stage.appendChild(caption);
        els.points.appendChild(stage);

        // Nessuna animazione da sincronizzare: basta attendere l'istante comune.
        // Un timeout invece di un loop rAF perché sono ~10 secondi su batteria.
        // `ctx.revealAt` arriva già riportato sull'orologio locale da chi
        // chiama (vedi client/shared/server-clock.js): qui si confronta con
        // Date.now() locale ed è corretto. Non ri-correggerlo.
        const wait = Math.max(0, ctx.revealAt - Date.now());
        setTimeout(() => {
          if (ctx.isStale()) return;
          ctx.done();
        }, wait);
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
          // Festa solo in caso di vittoria: se scoppiassero anche sulla sconfitta
          // i coriandoli smetterebbero di voler dire qualcosa.
          if (typeof window !== 'undefined' && window.Confetti) {
            window.Confetti.burst({ count: 70, power: 14 });
          }
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
