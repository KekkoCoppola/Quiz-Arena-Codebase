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

  // ─── Sala ──────────────────────────────────────────────────────────────────────

  /** Ultimi secondi: la bomba trema e diventa rossa. */
  const DANGER_MS = 10000;

  /** Lo stato della scena in sala: un solo round alla volta. */
  let scene = null;

  function clearScene() {
    if (!scene) return;
    clearInterval(scene.tick);
    scene.timers.forEach(clearTimeout);
    scene = null;
  }

  function formatTime(ms) {
    const sec = Math.ceil(ms / 1000);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  /** La bomba: corpo indaco, tappo, miccia che si accorcia e scintilla in cima. */
  function bombMarkup() {
    return `
      <div class="mg-coppia-scoppiata-bomb">
        <svg viewBox="0 0 220 180" aria-hidden="true">
          <path class="mg-coppia-scoppiata-fuse-bg" d="M138 52 Q160 18 196 26" />
          <path class="mg-coppia-scoppiata-fuse" d="M138 52 Q160 18 196 26" />
          <g class="mg-coppia-scoppiata-spark"><circle r="8" /><path d="M0 -15 L0 -9 M13 -7 L8 -4 M13 7 L8 4 M-12 -8 L-7 -5" /></g>
          <rect x="114" y="42" width="34" height="22" rx="4" transform="rotate(38 131 53)" class="mg-coppia-scoppiata-cap" />
          <circle cx="100" cy="108" r="66" class="mg-coppia-scoppiata-body" />
          <ellipse cx="74" cy="80" rx="14" ry="10" transform="rotate(-35 74 80)" class="mg-coppia-scoppiata-shine" />
        </svg>
        <span class="mg-coppia-scoppiata-time"></span>
      </div>`;
  }

  function playerById(players, id) {
    return (players || []).find((p) => p.id === id) ?? null;
  }

  /** Nasconde i chip che non ci stanno in una riga e mostra quanti sono in "+N". */
  function fitStrip(chips) {
    const more = chips.querySelector('.mg-coppia-scoppiata-more');
    const items = [...chips.querySelectorAll('.mg-coppia-scoppiata-chip')];
    items.forEach((el) => { el.hidden = false; });
    if (more) more.hidden = true;
    const limit = chips.clientWidth - 80; // posto per il "+N"
    let hidden = 0;
    for (const el of items) {
      if (hidden || el.offsetLeft + el.offsetWidth > limit) {
        el.hidden = true;
        hidden++;
      }
    }
    if (more) {
      more.hidden = hidden === 0;
      more.textContent = `+${hidden}`;
    }
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

    sala: {
      /**
       * Durante i 90 s: la frase, la bomba con i secondi e la miccia che si
       * accorcia, la striscia (vuota) di chi si è già salvato.
       */
      startSuspense(els, round, ctx) {
        this.stopSuspense();
        const stage = document.createElement('div');
        stage.className = 'mg-coppia-scoppiata-stage';
        stage.innerHTML = `
          <p class="mg-coppia-scoppiata-phrase"></p>
          ${bombMarkup()}
          <div class="mg-coppia-scoppiata-strip">
            <span class="mg-coppia-scoppiata-strip-label">Salvati</span>
            <div class="mg-coppia-scoppiata-chips"><span class="mg-coppia-scoppiata-more" hidden></span></div>
          </div>`;
        stage.querySelector('.mg-coppia-scoppiata-phrase').textContent = round.text;
        els.questionText.innerHTML = '';
        els.questionText.appendChild(stage);

        // `answersOpenAt` è già sull'orologio locale (la sala lo calcola alla
        // ricezione, prima del sipario): la scadenza è lì più la durata del round.
        const total = (round.time_limit_s || 90) * 1000;
        const endsAt = (ctx && ctx.answersOpenAt ? ctx.answersOpenAt : Date.now()) + total;
        const bomb = stage.querySelector('.mg-coppia-scoppiata-bomb');
        const time = stage.querySelector('.mg-coppia-scoppiata-time');
        const fuse = stage.querySelector('.mg-coppia-scoppiata-fuse');
        const spark = stage.querySelector('.mg-coppia-scoppiata-spark');
        const fuseLength = fuse.getTotalLength ? fuse.getTotalLength() : 0;

        const update = () => {
          const left = Math.max(0, endsAt - Date.now());
          const frac = Math.min(1, left / total);
          time.textContent = formatTime(left);
          // La miccia parte dal tappo: ne resta la parte vicina alla bomba, e
          // la scintilla sta dove brucia.
          if (fuseLength) {
            fuse.style.strokeDasharray = `${fuseLength * frac} ${fuseLength}`;
            const pt = fuse.getPointAtLength(fuseLength * frac);
            spark.setAttribute('transform', `translate(${pt.x} ${pt.y})`);
          }
          bomb.classList.toggle('is-danger', left > 0 && left <= DANGER_MS);
          bomb.classList.toggle('is-out', left === 0);
        };
        scene = { tick: setInterval(update, 200), timers: [], stage };
        update();
      },

      stopSuspense() {
        clearScene();
      },

      /** Ogni gruppo salvato entra in testa alla striscia, con un pop e un suono. */
      onGroupsCompleted(els, groups, ctx) {
        const root = scene ? scene.stage : els.questionText;
        const chips = root.querySelector('.mg-coppia-scoppiata-chips');
        if (!chips) return;
        for (const group of groups) {
          const chip = document.createElement('span');
          chip.className = 'mg-coppia-scoppiata-chip is-new';
          const faces = document.createElement('span');
          faces.className = 'mg-coppia-scoppiata-faces';
          const who = [];
          for (const id of group) {
            const p = playerById(ctx && ctx.players, id);
            const face = document.createElement('span');
            face.className = 'mg-coppia-scoppiata-face-mini';
            if (p && typeof AvatarSprite !== 'undefined') AvatarSprite.fill(face, p.avatar);
            faces.appendChild(face);
            who.push(p ? p.nickname : '?');
          }
          const label = document.createElement('span');
          label.className = 'mg-coppia-scoppiata-names';
          label.textContent = who.join(' + ');
          chip.append(faces, label);
          chips.insertBefore(chip, chips.firstChild);
        }
        if (ctx && ctx.sfx) ctx.sfx('saved');
        fitStrip(chips);
      },

      /**
       * A round chiuso, fino a `revealAt`: le carte di tutti si girano in tre
       * tempi — prima i gruppi salvati, poi quelli a metà, poi gli scoppiati.
       */
      playReveal(els, results, options, ctx) {
        clearScene();
        const outcomes = new Map((results.answers || []).map((a) => [a.playerId, a]));
        const names = new Map((results.leaderboard || []).map((p) => [p.id, p.nickname]));
        const ORDER = ['complete', 'half', 'burst'];
        const groups = ((results.reveal && results.reveal.groups) || []).map((g) => {
          const res = g.members.map((m) => (outcomes.get(m.playerId) || {}).outcome);
          const kind = res.includes('complete') ? 'complete' : res.includes('half') ? 'half' : 'burst';
          return Object.assign({}, g, { kind });
        });
        groups.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));

        const board = document.createElement('div');
        board.className = 'mg-coppia-scoppiata-board';
        const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(groups.length * 1.6))));
        board.style.setProperty('--cols', String(cols));
        board.style.setProperty('--rows', String(Math.max(1, Math.ceil(groups.length / cols))));
        const flips = { complete: [], half: [], burst: [] };
        for (const g of groups) {
          const tile = document.createElement('div');
          tile.className = `mg-coppia-scoppiata-tile is-${g.kind}`;
          const row = document.createElement('div');
          row.className = 'mg-coppia-scoppiata-tile-cards';
          const who = [];
          for (const m of g.members) {
            const card = buildCard({ figure: g.figure, color: m.color }, 'is-small');
            row.appendChild(card.el);
            flips[g.kind].push(() => card.faceUp(true));
            who.push(names.get(m.playerId) || '?');
          }
          const label = document.createElement('div');
          label.className = 'mg-coppia-scoppiata-tile-names';
          label.textContent = who.join(' + ');
          const verdict = document.createElement('div');
          verdict.className = 'mg-coppia-scoppiata-verdict';
          const pts = Math.max(0, ...g.members.map((m) => (outcomes.get(m.playerId) || {}).pointsAwarded || 0));
          verdict.textContent = g.kind === 'complete' ? `Salvati! +${pts}`
            : g.kind === 'half' ? `A metà · +${pts}` : 'Scoppiata!';
          tile.append(row, label, verdict);
          board.appendChild(tile);
          flips[g.kind].push(() => tile.classList.add('is-shown'));
        }
        els.questionText.innerHTML = '';
        els.questionText.appendChild(board);

        const timers = [];
        scene = { tick: null, timers, stage: board };
        const revealAt = ctx && ctx.revealAt ? ctx.revealAt : Date.now() + 9000;
        const left = Math.max(1500, revealAt - Date.now());
        const beat = (left - 600) / 3;
        const stale = () => !!(ctx && ctx.isStale && ctx.isStale());
        ORDER.forEach((kind, i) => {
          timers.push(setTimeout(() => {
            if (stale()) return;
            if (flips[kind].length && ctx && ctx.sfx) ctx.sfx('flip');
            flips[kind].forEach((fn, k) => timers.push(setTimeout(fn, k * 40)));
          }, 300 + i * beat));
        });
        timers.push(setTimeout(() => { if (!stale() && ctx && ctx.done) ctx.done(); }, left));
      },
    },

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
