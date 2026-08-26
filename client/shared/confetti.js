'use strict';

/**
 * client/shared/confetti.js
 *
 * Coriandoli su canvas, per i momenti di festa: l'atterraggio di un minigioco,
 * una vittoria sul telefono, un podio.
 *
 * Perché scritto a mano invece di una libreria: il Raspberry gira senza rete
 * durante l'evento, quindi nessuna CDN. Sono ~100 righe, non vale una
 * dipendenza da servire e aggiornare.
 *
 * Regole rispettate (DESIGN.md):
 *   - Palette calda e satura del brand, niente colori nuovi.
 *   - Coriandoli rettangolari "di carta", non cerchietti generici.
 *   - `prefers-reduced-motion` disattiva l'effetto invece di attenuarlo: qui
 *     non c'è informazione, solo festa, quindi togliendolo non si perde nulla.
 *
 * ⚠ Nessun accesso al DOM al caricamento: il canvas nasce alla prima esplosione.
 * È ciò che rende il modulo caricabile anche fuori da un browser.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Confetti = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // Token di DESIGN.md: giallo gettone, teal arcade, rosso game-over, ocra
  // biglietto, bianco carta. Nessun colore fuori palette.
  const COLORS = ['#f7d708', '#90efef', '#ab3425', '#f2a65a', '#ffffff'];

  const GRAVITY = 0.45;
  const DRAG = 0.992;
  const FADE_AFTER_MS = 1400;

  let canvas = null;
  let ctx2d = null;
  let particles = [];
  let raf = null;

  function reducedMotion() {
    return typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** Canvas a tutto schermo, creato una volta sola e mai interattivo. */
  function ensureCanvas() {
    if (canvas) return canvas;
    canvas = document.createElement('canvas');
    canvas.className = 'confetti-canvas';
    // Inline invece che in un foglio di stile: il modulo deve funzionare anche
    // se chi lo carica non ha incluso CSS aggiuntivi.
    canvas.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999';
    document.body.appendChild(canvas);
    ctx2d = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    return canvas;
  }

  function resize() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function tick() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx2d.clearRect(0, 0, w, h);

    const now = Date.now();
    particles = particles.filter((p) => {
      p.vx *= DRAG;
      p.vy = p.vy * DRAG + GRAVITY;
      p.x += p.vx;
      p.y += p.vy;
      p.spin += p.spinRate;

      const age = now - p.bornAt;
      const alpha = age < FADE_AFTER_MS
        ? 1
        : Math.max(0, 1 - (age - FADE_AFTER_MS) / 900);
      if (alpha <= 0 || p.y > h + 40) return false;

      ctx2d.save();
      ctx2d.translate(p.x, p.y);
      ctx2d.rotate(p.spin);
      ctx2d.globalAlpha = alpha;
      ctx2d.fillStyle = p.color;
      // Lo "sfarfallio" della carta: il rettangolo si assottiglia ruotando.
      ctx2d.fillRect(-p.w / 2, -p.h / 2, p.w * Math.abs(Math.cos(p.spin)) + 1, p.h);
      ctx2d.restore();
      return true;
    });

    if (particles.length > 0) {
      raf = requestAnimationFrame(tick);
    } else {
      raf = null;
      ctx2d.clearRect(0, 0, w, h);
    }
  }

  /**
   * Esplosione di coriandoli.
   * @param {object} [opts]
   * @param {number} [opts.count] quante particelle (default 90)
   * @param {number} [opts.x] origine X in px (default: centro schermo)
   * @param {number} [opts.y] origine Y in px (default: un terzo dall'alto)
   * @param {number} [opts.spread] apertura orizzontale (default 14)
   * @param {number} [opts.power] spinta verso l'alto (default 16)
   */
  function burst(opts) {
    if (reducedMotion()) return;
    const o = opts || {};
    ensureCanvas();

    const count = o.count ?? 90;
    const originX = o.x ?? window.innerWidth / 2;
    const originY = o.y ?? window.innerHeight / 3;
    const spread = o.spread ?? 14;
    const power = o.power ?? 16;
    const now = Date.now();

    for (let i = 0; i < count; i++) {
      particles.push({
        x: originX + (Math.random() - 0.5) * 60,
        y: originY + (Math.random() - 0.5) * 20,
        vx: (Math.random() - 0.5) * spread,
        // Quasi tutte verso l'alto: l'esplosione deve "sbocciare", non colare.
        vy: -power * (0.55 + Math.random() * 0.75),
        w: 7 + Math.random() * 7,
        h: 10 + Math.random() * 8,
        spin: Math.random() * Math.PI,
        spinRate: (Math.random() - 0.5) * 0.32,
        color: COLORS[(Math.random() * COLORS.length) | 0],
        bornAt: now,
      });
    }

    if (!raf) raf = requestAnimationFrame(tick);
  }

  /** Ferma e pulisce: usata quando si cambia schermata di colpo. */
  function stop() {
    particles = [];
    if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    if (ctx2d) ctx2d.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }

  return { burst, stop, COLORS };
});
