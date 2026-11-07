'use strict';

/**
 * client/sala/qr-art.js
 *
 * Il QR disegnato nel linguaggio della sala: moduli che si fondono in forme
 * tonde invece dei quadratini, i tre "occhi" agli angoli come quadrati
 * arrotondati in indaco con la pupilla inchiostro, e (facoltativo) il logo su
 * una targhetta al centro. La griglia la calcola la libreria che c'era già
 * (vendor/qrcode.js, `isDark`/`getModuleCount`): qui si decide solo come
 * disegnarla, quindi nessuna dipendenza nuova da portare sul Raspberry.
 *
 * Due regole tengono il QR leggibile, e il test (tools/test-qr-art.js) le
 * controlla:
 *  · Ogni modulo scuro copre il CENTRO della sua cella e nessun modulo chiaro
 *    viene disegnato: il lettore campiona i centri, quindi vede la stessa
 *    griglia di un QR a quadratini. Gli arrotondamenti toccano solo gli
 *    angoli liberi.
 *  · Gli occhi restano scuro-chiaro-scuro (1:1:3:1:1), cioè ciò che il lettore
 *    cerca per agganciare il codice. Il giallo del marchio qui non entra:
 *    su bianco è troppo chiaro per contare come "scuro".
 *
 * I colori stanno in style.css (classi `qa-*`), come ogni altro token.
 * Puro, senza DOM: `plan()` decide, `render()` scrive il markup SVG.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QrArt = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /** Lato di un occhio (finder pattern), in moduli. */
  const EYE = 7;

  /** Raggio degli angoli liberi di un modulo: 0.5 fa di un modulo isolato un pallino. */
  const RADIUS = 0.5;

  /**
   * Oltre la versione 6 al centro del codice c'è un pattern di allineamento
   * che il lettore usa per raddrizzare l'immagine: il logo lo coprirebbe.
   */
  const MAX_LOGO_VERSION = 6;

  /** Angoli in alto a sinistra dei tre occhi. */
  function eyeOrigins(n) {
    return [{ x: 0, y: 0 }, { x: n - EYE, y: 0 }, { x: 0, y: n - EYE }];
  }

  function inEye(x, y, n) {
    return eyeOrigins(n).some((e) => x >= e.x && x < e.x + EYE && y >= e.y && y < e.y + EYE);
  }

  /**
   * Il buco per il logo: un quadrato di lato dispari (centrato sul modulo
   * centrale) di circa un quarto del lato, cioè ~6% dei moduli. Lo regge la
   * correzione d'errore H, che ne ricostruisce fino al 30%: il chiamante deve
   * generare il QR con 'H' quando chiede il logo.
   * @returns {{x:number, y:number, side:number}|null}
   */
  function logoHole(n) {
    const version = (n - 17) / 4;
    if (version > MAX_LOGO_VERSION) return null;
    let side = Math.round(n * 0.24);
    if (side % 2 === 0) side += 1;
    const start = (n - side) / 2;
    return { x: start, y: start, side };
  }

  /**
   * Cosa disegnare. `isDark(row, col)` come nella libreria.
   * Ogni modulo porta quali angoli arrotondare: quelli dove né il vicino in
   * verticale né quello in orizzontale sono pieni. Così i moduli adiacenti si
   * saldano in un'unica forma e i bordi esterni diventano tondi.
   */
  function plan(isDark, n, { logo = false } = {}) {
    const hole = logo ? logoHole(n) : null;
    const inHole = (x, y) => !!hole
      && x >= hole.x && x < hole.x + hole.side
      && y >= hole.y && y < hole.y + hole.side;
    const on = (x, y) => x >= 0 && y >= 0 && x < n && y < n
      && isDark(y, x) && !inEye(x, y, n) && !inHole(x, y);

    const modules = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!on(x, y)) continue;
        const up = on(x, y - 1);
        const down = on(x, y + 1);
        const left = on(x - 1, y);
        const right = on(x + 1, y);
        modules.push({
          x, y,
          tl: !up && !left,
          tr: !up && !right,
          br: !down && !right,
          bl: !down && !left,
        });
      }
    }
    return { n, eyes: eyeOrigins(n), modules, hole };
  }

  /** Il contorno di un modulo, con gli angoli liberi arrotondati. */
  function modulePath(m, r) {
    const { x, y } = m;
    const tl = m.tl ? r : 0;
    const tr = m.tr ? r : 0;
    const br = m.br ? r : 0;
    const bl = m.bl ? r : 0;
    let d = `M${x + tl} ${y}H${x + 1 - tr}`;
    if (tr) d += `a${r} ${r} 0 0 1 ${r} ${r}`;
    d += `V${y + 1 - br}`;
    if (br) d += `a${r} ${r} 0 0 1 ${-r} ${r}`;
    d += `H${x + bl}`;
    if (bl) d += `a${r} ${r} 0 0 1 ${-r} ${-r}`;
    d += `V${y + tl}`;
    if (tl) d += `a${r} ${r} 0 0 1 ${r} ${-r}`;
    return `${d}Z`;
  }

  /** Un occhio: anello indaco, fascia bianca, pupilla inchiostro. */
  function eyeMarkup({ x, y }) {
    return `<rect class="qa-eye-ring" x="${x}" y="${y}" width="7" height="7" rx="2.3"/>`
      + `<rect class="qa-eye-gap" x="${x + 1}" y="${y + 1}" width="5" height="5" rx="1.5"/>`
      + `<rect class="qa-eye-core" x="${x + 2}" y="${y + 2}" width="3" height="3" rx="1"/>`;
  }

  /**
   * Il markup SVG del QR.
   * @param {object} qr      oggetto della libreria, dopo `make()`
   * @param {object} [opts]
   * @param {number} [opts.margin=2]  zona di silenzio intorno, in moduli
   * @param {string} [opts.logo]      URL dell'immagine al centro (QR in 'H')
   */
  function render(qr, { margin = 2, logo = null } = {}) {
    const n = qr.getModuleCount();
    const p = plan((r, c) => qr.isDark(r, c), n, { logo: !!logo });
    const size = n + margin * 2;
    // Un solo <path> per tutti i moduli: forme adiacenti nello stesso tracciato
    // si rasterizzano insieme, senza le righine chiare che resterebbero fra
    // elementi separati.
    const dots = p.modules.map((m) => modulePath(m, RADIUS)).join('');
    let plate = '';
    if (p.hole && logo) {
      const { x, y, side } = p.hole;
      plate = `<rect class="qa-plate" x="${x + 0.35}" y="${y + 0.35}" width="${side - 0.7}" height="${side - 0.7}" rx="1.3"/>`
        + `<image href="${logo}" x="${x + 0.8}" y="${y + 0.8}" width="${side - 1.6}" height="${side - 1.6}" preserveAspectRatio="xMidYMid meet"/>`;
    }
    return `<svg class="qr-art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">`
      + `<g transform="translate(${margin} ${margin})">`
      + `<path class="qa-dot" d="${dots}"/>`
      + p.eyes.map(eyeMarkup).join('')
      + plate
      + '</g></svg>';
  }

  return { plan, render, logoHole, EYE, MAX_LOGO_VERSION };
});
