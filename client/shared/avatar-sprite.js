'use strict';

/**
 * client/shared/avatar-sprite.js
 *
 * Il ritratto dell'avatar: foto PNG del modello 3D di mii-character.js,
 * generate da tools/render-avatars.js in resources/img/avatars/:
 *
 *   face/<colore>-<faccia>.png   la testa sola, per i mini avatar
 *   body/<colore>-<outfit>.png   il personaggio intero senza la faccia disegnata
 *   expr/<faccia>.png            la faccia disegnata, da sola, nella stessa inquadratura
 *
 * Il personaggio intero (la scelta sul telefono) è body + expr sovrapposti:
 * l'espressione è una decalcomania davanti alla testa, quindi metterla sopra
 * la foto del corpo dà lo stesso disegno della foto intera. Così bastano
 * 8 × 5 corpi e 12 facce invece di 8 × 12 × 5 foto intere, e scorrere le
 * espressioni scarica solo la faccia.
 *
 * Foto e non 3D vivo, per scelta di prodotto: il telefono non scarica nulla
 * oltre alla pagina e alle sue immagini, e three.js da solo pesa 676 KB. Così
 * il personaggio è lo stesso modello che si vede nella premiazione 3D, e un
 * client mostra soltanto degli <img> che il browser tiene in cache per la serata.
 *
 * Richiede, caricato prima: avatar-catalog.js.
 *
 * API:
 *   AvatarSprite.url(avatarId)       la testa (mini avatar)
 *   AvatarSprite.layers(avatarId)    { body, face }: il personaggio intero, a strati
 *   AvatarSprite.fill(el, avatarId)  mette la TESTA (11:8) dentro `el`, alta 1,25em:
 *                                    la misura la dà il font-size che
 *                                    l'elemento aveva per l'emoji
 *   AvatarSprite.preload(src)        scarica in anticipo (frecce della scelta)
 */

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AvatarSprite = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  const BASE = '/resources/img/avatars';

  /** Id sconosciuto o rotto: il personaggio neutro, mai un'immagine rotta in sala. */
  const NEUTRAL = 'neutral';
  const NEUTRAL_FACE = 'happy';

  function parse(avatarId) {
    // Nel browser il catalogo è su window; in Node (i test) si carica a parte.
    const catalog = (root && root.AvatarCatalog)
      || (typeof require === 'function' ? require('./avatar-catalog') : null);
    return catalog ? catalog.parse(avatarId) : null;
  }

  function url(avatarId) {
    const p = parse(avatarId);
    return `${BASE}/face/${p ? `${p.color.id}-${p.face.id}` : NEUTRAL}.png`;
  }

  function layers(avatarId) {
    const p = parse(avatarId);
    return {
      body: `${BASE}/body/${p ? `${p.color.id}-${p.outfit.id}` : NEUTRAL}.png`,
      face: `${BASE}/expr/${p ? p.face.id : NEUTRAL_FACE}.png`,
    };
  }

  function fill(el, avatarId) {
    if (!el) return;
    const img = document.createElement('img');
    img.className = 'avatar-sprite';
    img.src = url(avatarId);
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.style.height = '1.25em';
    img.style.width = 'auto';
    img.style.aspectRatio = '11 / 8';
    // In un contenitore stretto (le pedine tonde) la testa si restringe invece
    // di sbordare: resta intera, solo più piccola.
    img.style.maxWidth = '100%';
    img.style.objectFit = 'contain';
    img.style.verticalAlign = 'middle';
    el.replaceChildren(img);
  }

  const preloaded = new Set();
  function preload(src) {
    if (preloaded.has(src) || typeof Image === 'undefined') return;
    preloaded.add(src);
    new Image().src = src;
  }

  return Object.freeze({ NEUTRAL, url, layers, fill, preload });
});
