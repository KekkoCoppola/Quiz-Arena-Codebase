'use strict';

/**
 * client/shared/avatar-sprite.js
 *
 * Il ritratto dell'avatar: una foto PNG del modello 3D di mii-character.js,
 * una per combinazione colore × espressione, generate da
 * tools/render-avatars.js in resources/img/avatars/<misura>/<colore>-<faccia>.png.
 *
 * Foto e non 3D vivo, per scelta di prodotto: il telefono non scarica nulla
 * oltre alla pagina e alle sue immagini, e three.js da solo pesa 676 KB. Così
 * il personaggio è lo stesso modello che si vedrà nella premiazione 3D, e un
 * client mostra soltanto un <img> che il browser tiene in cache per la serata.
 *
 * Richiede, caricato prima: avatar-catalog.js.
 *
 * API:
 *   AvatarSprite.url(avatarId, size)   percorso del PNG ('sm' | 'lg', default 'sm')
 *   AvatarSprite.fill(el, avatarId)    mette il ritratto dentro `el`, alto 1,25em:
 *                                      la misura la dà il font-size che
 *                                      l'elemento aveva per l'emoji
 *   AvatarSprite.preload(avatarId, size)  scarica in anticipo (frecce della scelta)
 */

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AvatarSprite = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const BASE = '/resources/img/avatars';
  const SIZES = Object.freeze(['sm', 'lg']);

  /** Id sconosciuto o rotto: il personaggio neutro, mai un'immagine rotta in sala. */
  const NEUTRAL = 'neutral';

  /** Il nome del file di un avatar; esportato per il test che verifica i file. */
  function fileName(avatarId) {
    // Nel browser il catalogo è su window; in Node (i test) si carica a parte.
    const catalog = (root && root.AvatarCatalog)
      || (typeof require === 'function' ? require('./avatar-catalog') : null);
    const parsed = catalog ? catalog.parse(avatarId) : null;
    return parsed ? `${parsed.color.id}-${parsed.face.id}` : NEUTRAL;
  }

  function url(avatarId, size = 'sm') {
    const s = SIZES.includes(size) ? size : 'sm';
    return `${BASE}/${s}/${fileName(avatarId)}.png`;
  }

  function fill(el, avatarId) {
    if (!el) return;
    const img = document.createElement('img');
    img.className = 'avatar-sprite';
    img.src = url(avatarId, 'sm');
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.style.height = '1.25em';
    img.style.width = 'auto';
    img.style.aspectRatio = '4 / 5';
    img.style.verticalAlign = 'middle';
    el.replaceChildren(img);
  }

  const preloaded = new Set();
  function preload(avatarId, size = 'lg') {
    const src = url(avatarId, size);
    if (preloaded.has(src) || typeof Image === 'undefined') return;
    preloaded.add(src);
    new Image().src = src;
  }

  return Object.freeze({ SIZES, NEUTRAL, fileName, url, fill, preload });
});
