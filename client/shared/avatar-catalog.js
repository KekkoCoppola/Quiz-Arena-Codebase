'use strict';

/**
 * client/shared/avatar-catalog.js
 *
 * Cosa rende valido un avatar. Decisioni pure — nessun DOM, nessun disegno.
 *
 * L'avatar è il personaggio di mii-character.js: un COLORE della pelle,
 * un'ESPRESSIONE sulla faccia e un OUTFIT (la stessa divisa, in altri colori).
 * Viaggia come una stringa opaca `"<colore>:<faccia>:<outfit>"` (es.
 * `"sunny_yellow:happy:sport"`), così protocollo, rientro, classifica e bot non
 * cambiano forma: solo chi lo disegna la apre.
 *
 * Caricato come <script> dalle tre SPA (espone window.AvatarCatalog) e come
 * modulo CommonJS da server/game.js, che è l'unico a decidere se un avatar
 * ricevuto è accettabile. Una copia per parte divergerebbe al primo colore
 * aggiunto, e il server rifiuterebbe una scelta che il telefono propone.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AvatarCatalog = api;
})(typeof self !== 'undefined' ? self : this, function () {
  /** I colori della pelle: gli stessi preset di mii-character.js. */
  const COLORS = Object.freeze([
    Object.freeze({ id: 'coral_red',     label: 'Corallo',   hex: '#f26b5e' }),
    Object.freeze({ id: 'sunny_yellow',  label: 'Giallo',    hex: '#f7d708' }),
    Object.freeze({ id: 'electric_teal', label: 'Azzurro',   hex: '#5ce1e6' }),
    Object.freeze({ id: 'lime_green',    label: 'Verde',     hex: '#7ed957' }),
    Object.freeze({ id: 'royal_purple',  label: 'Viola',     hex: '#9b72cf' }),
    Object.freeze({ id: 'tangerine',     label: 'Arancio',   hex: '#ff914d' }),
    Object.freeze({ id: 'warm_peach',    label: 'Pesca',     hex: '#ffb58a' }),
    Object.freeze({ id: 'hot_pink',      label: 'Rosa',      hex: '#ff66b3' }),
  ]);

  /**
   * Le espressioni, nell'ordine in cui le scorrono le frecce. Le prime sei
   * vengono dal modulo originale, le altre sei sono state aggiunte qui: il
   * disegno di ognuna sta in draw2DFacialExpression di mii-character.js.
   */
  const FACES = Object.freeze([
    Object.freeze({ id: 'happy',     label: 'Felice' }),
    Object.freeze({ id: 'cool',      label: 'Spavaldo' }),
    Object.freeze({ id: 'wink',      label: 'Occhiolino' }),
    Object.freeze({ id: 'surprised', label: 'Sorpreso' }),
    Object.freeze({ id: 'fierce',    label: 'Carico' }),
    Object.freeze({ id: 'angry',     label: 'Arrabbiato' }),
    Object.freeze({ id: 'laugh',     label: 'Risata' }),
    Object.freeze({ id: 'love',      label: 'Innamorato' }),
    Object.freeze({ id: 'sleepy',    label: 'Assonnato' }),
    Object.freeze({ id: 'shades',    label: 'Occhiali da sole' }),
    Object.freeze({ id: 'tongue',    label: 'Linguaccia' }),
    Object.freeze({ id: 'nervous',   label: 'Nervoso' }),
  ]);

  /**
   * Gli outfit, nell'ordine delle frecce sul corpo. Il primo è la divisa del
   * modello originale. I colori di ognuno stanno in OUTFIT_PRESETS di
   * mii-character.js, con lo stesso id.
   */
  const OUTFITS = Object.freeze([
    Object.freeze({ id: 'classic',  label: 'Classico' }),
    Object.freeze({ id: 'sport',    label: 'Sportivo' }),
    Object.freeze({ id: 'denim',    label: 'Jeans' }),
    Object.freeze({ id: 'explorer', label: 'Esploratore' }),
    Object.freeze({ id: 'elegant',  label: 'Elegante' }),
  ]);

  const SEPARATOR = ':';

  const colorById = new Map(COLORS.map((c) => [c.id, c]));
  const faceById = new Map(FACES.map((f) => [f.id, f]));
  const outfitById = new Map(OUTFITS.map((o) => [o.id, o]));

  function encode(colorId, faceId, outfitId = OUTFITS[0].id) {
    return [colorId, faceId, outfitId].join(SEPARATOR);
  }

  /**
   * @returns {{ color: object, face: object, outfit: object } | null} null se
   *   la stringa non è un avatar del catalogo — mai un'eccezione: chi disegna
   *   degrada. `"<colore>:<faccia>"` senza outfit è ancora valido, con la divisa
   *   classica: è la scelta che i telefoni hanno salvato prima degli outfit.
   */
  function parse(avatarId) {
    if (typeof avatarId !== 'string') return null;
    const parts = avatarId.split(SEPARATOR);
    if (parts.length !== 2 && parts.length !== 3) return null;
    const color = colorById.get(parts[0]);
    const face = faceById.get(parts[1]);
    const outfit = parts.length === 2 ? OUTFITS[0] : outfitById.get(parts[2]);
    return color && face && outfit ? { color, face, outfit } : null;
  }

  function isValid(avatarId) {
    return parse(avatarId) !== null;
  }

  /** Una combinazione a caso. `rnd` iniettabile per i test, come in GameSession. */
  function random(rnd = Math.random) {
    const color = COLORS[Math.floor(rnd() * COLORS.length)];
    const face = FACES[Math.floor(rnd() * FACES.length)];
    const outfit = OUTFITS[Math.floor(rnd() * OUTFITS.length)];
    return encode(color.id, face.id, outfit.id);
  }

  return Object.freeze({ COLORS, FACES, OUTFITS, encode, parse, isValid, random });
});
