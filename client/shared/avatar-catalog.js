'use strict';

/**
 * client/shared/avatar-catalog.js
 *
 * Cosa rende valido un avatar. Decisioni pure — nessun DOM, nessun disegno.
 *
 * L'avatar è il personaggio di mii-character.js: una divisa uguale per tutti,
 * un COLORE della pelle e un'ESPRESSIONE sulla faccia. Viaggia come una stringa
 * opaca `"<colore>:<faccia>"` (es. `"sunny_yellow:happy"`), così protocollo,
 * rientro, classifica e bot non cambiano forma: solo chi lo disegna la apre.
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

  const SEPARATOR = ':';

  const colorById = new Map(COLORS.map((c) => [c.id, c]));
  const faceById = new Map(FACES.map((f) => [f.id, f]));

  function encode(colorId, faceId) {
    return `${colorId}${SEPARATOR}${faceId}`;
  }

  /**
   * @returns {{ color: object, face: object } | null} null se la stringa non
   *   è un avatar del catalogo — mai un'eccezione: chi disegna degrada.
   */
  function parse(avatarId) {
    if (typeof avatarId !== 'string') return null;
    const parts = avatarId.split(SEPARATOR);
    if (parts.length !== 2) return null;
    const color = colorById.get(parts[0]);
    const face = faceById.get(parts[1]);
    return color && face ? { color, face } : null;
  }

  function isValid(avatarId) {
    return parse(avatarId) !== null;
  }

  /** Una combinazione a caso. `rnd` iniettabile per i test, come in GameSession. */
  function random(rnd = Math.random) {
    const color = COLORS[Math.floor(rnd() * COLORS.length)];
    const face = FACES[Math.floor(rnd() * FACES.length)];
    return encode(color.id, face.id);
  }

  return Object.freeze({ COLORS, FACES, encode, parse, isValid, random });
});
