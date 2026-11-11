'use strict';

/**
 * client/shared/minigames/coppia-scoppiata.js — LA PRESENTAZIONE della
 * Coppia Scoppiata, condivisa da sala, telefono e pannello host.
 *
 * Il telefono mostra la carta segreta del giocatore (arriva con `game:hand`):
 * coperta, si gira con "Mostra la carta"; sotto, un pallino per ogni colore
 * tranne il proprio. La sala mostra il timer gigante e la striscia di chi si
 * è già salvato, poi gira le carte gruppo per gruppo.
 *
 * Regole lato server: server/minigames/coppia-scoppiata.js.
 * Design: docs/superpowers/specs/2026-11-11-coppia-scoppiata-design.md
 */

(function (root, factory) {
  const registry = (typeof module !== 'undefined' && module.exports)
    ? require('./index')
    : root.Minigames;
  registry.register(factory());
})(typeof self !== 'undefined' ? self : this, function () {

  const IMG = '/resources/img/coppia-scoppiata';

  /**
   * Un colore per ogni opzione del modulo server, nello stesso ordine
   * (0 = Rosso … 5 = Arancio). L'indice è l'identità del colore.
   */
  const COLORS = Object.freeze(['#e5383b', '#1e88e5', '#2e7d32', '#ffd400', '#8e44c9', '#f28c28']);

  /** Audio in sala (file in resources/audio/coppia-scoppiata/, da tools/make-minigame-audio.js). */
  const AUDIO = Object.freeze({
    music: { file: 'coppia-scoppiata/music.wav', gain: 0.8 },
    sfx: {
      saved: [{ file: 'coppia-scoppiata/saved-01.wav', gain: 0.8 }],
      flip: [{ file: 'coppia-scoppiata/flip-01.wav', gain: 0.5 }],
      deal: [{ file: 'coppia-scoppiata/deal-01.wav', gain: 0.6 }],
    },
  });

  // ─── Figure (SVG inline, perché `currentColor` prenda il colore della carta) ─

  /** @type {Map<string, Promise<string>>} */
  const figureCache = new Map();

  /** Il markup SVG di una figura, scaricato una volta sola per pagina. */
  function figureSvg(id) {
    // Solo id del catalogo (lettere minuscole): niente percorsi costruiti da fuori.
    if (!/^[a-z]+$/.test(String(id))) return Promise.resolve('');
    if (!figureCache.has(id)) {
      figureCache.set(id, fetch(`${IMG}/figure/${id}.svg`)
        .then((r) => (r.ok ? r.text() : ''))
        .catch(() => ''));
    }
    return figureCache.get(id);
  }

  /** Riempie `el` con la figura, colorata col colore della carta. */
  function fillFigure(el, card) {
    el.style.color = COLORS[card.color] ?? '#1c1c26';
    figureSvg(card.figure).then((svg) => { el.innerHTML = svg; });
  }

  function reducedMotion() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /**
   * Una carta con due facce, coperta. `faceUp(true)` la gira.
   * @returns {{ el: HTMLElement, faceUp: (up: boolean) => void }}
   */
  function buildCard(card, cls) {
    const el = document.createElement('div');
    el.className = `mg-coppia-scoppiata-card ${cls ?? ''}`;
    el.innerHTML = `
      <div class="mg-coppia-scoppiata-card-inner">
        <div class="mg-coppia-scoppiata-face is-back"><img src="${IMG}/back_carta.webp" alt="" draggable="false"></div>
        <div class="mg-coppia-scoppiata-face is-front"><img src="${IMG}/front_carta.webp" alt="" draggable="false"><div class="mg-coppia-scoppiata-figure"></div></div>
      </div>`;
    fillFigure(el.querySelector('.mg-coppia-scoppiata-figure'), card);
    return {
      el,
      faceUp(up) { el.classList.toggle('is-up', up); },
    };
  }

  return {
    type: 'coppia_scoppiata',
    label: 'La Coppia Scoppiata',

    hostStatusText: '🃏 Minigioco: la sala cerca le coppie…',
    playerBadge: '🃏 Coppia Scoppiata!',
    wheelIcon: `${IMG}/figure/gatto.svg`,
    audio: AUDIO,
    COLORS,
    // In sala niente carte delle opzioni: i colori sono sul telefono, e
    // mostrarli sullo schermo non aiuterebbe nessuno.
    salaOptions: false,

    player: {
      /**
       * La carta segreta: arriva coperta "sul tavolo", si gira col bottone di
       * testo, sotto i pallini di tutti i colori tranne il proprio.
       */
      renderHand(container, card, ctx) {
        container.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'mg-coppia-scoppiata-hand';

        const { el: cardEl, faceUp } = buildCard(card, reducedMotion() ? '' : 'is-dealt');
        let up = false;

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'mg-coppia-scoppiata-toggle';
        toggle.textContent = 'Mostra la carta';
        toggle.addEventListener('click', () => {
          up = !up;
          faceUp(up);
          toggle.textContent = up ? 'Nascondi la carta' : 'Mostra la carta';
        });
        // Anche toccare la carta la gira: è il gesto che viene spontaneo.
        cardEl.addEventListener('click', () => toggle.click());

        const dots = document.createElement('div');
        dots.className = 'mg-coppia-scoppiata-dots';
        ctx.options.forEach((name, i) => {
          if (i === card.color) return;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'answer-btn mg-coppia-scoppiata-dot';
          btn.innerHTML = '<span class="mg-coppia-scoppiata-swatch"></span><span class="mg-coppia-scoppiata-name"></span>';
          btn.querySelector('.mg-coppia-scoppiata-swatch').style.background = COLORS[i];
          btn.querySelector('.mg-coppia-scoppiata-name').textContent = name;
          btn.setAttribute('aria-label', `Il colore del mio compagno è ${name}`);
          btn.addEventListener('click', () => ctx.submit(i, btn));
          dots.appendChild(btn);
        });

        wrap.append(cardEl, toggle, dots);
        container.appendChild(wrap);
      },

      /** L'esito sul telefono: coppia salvata, a metà o scoppiata. */
      reveal(els, mine) {
        if (!mine) {
          els.sticker.classList.add('is-neutral');
          els.text.textContent = 'Tempo scaduto!';
          els.points.textContent = '+0 punti';
          return;
        }
        if (mine.outcome === 'complete') {
          els.sticker.classList.add('is-correct');
          els.text.textContent = 'COPPIA SALVATA!';
        } else if (mine.outcome === 'half') {
          els.sticker.classList.add('is-neutral');
          els.text.textContent = 'HAI INDOVINATO SOLO TU';
        } else {
          els.sticker.classList.add('is-wrong');
          els.text.textContent = 'COPPIA SCOPPIATA';
        }
        els.points.textContent = `+${mine.pointsAwarded} punti`;
      },
    },

    // Usati dal ramo `sala` (Task 7) e dai test.
    _buildCard: buildCard,
  };
});
