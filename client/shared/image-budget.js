'use strict';

/**
 * client/shared/image-budget.js
 *
 * Le decisioni PURE del comparto immagini: quanto grande, quanto compressa,
 * com'è fatto un riferimento valido. Nessun DOM, nessuna rete, nessun canvas.
 *
 * La divisione ricalca quella fra `audio-logic.js` e `audio.js`: qui le regole,
 * in `client/host/app.js` il motore che tocca file, canvas e fetch. Così le
 * regole si testano in Node senza un browser (`tools/test-image.js`).
 *
 * Perché la compressione avviene nel browser e non sul server: il progetto ha
 * scelto `node:sqlite` proprio per non avere moduli nativi da compilare in vista
 * del packaging SEA su ARM, e `sharp` li rimetterebbe in gioco. Il ridimensiona-
 * mento lo fa il tablet di chi crea il quiz, in un momento tranquillo, non il
 * Raspberry davanti a una sala.
 *
 * Caricato come <script> dal pannello host (espone window.ImageBudget) e come
 * modulo CommonJS dai test.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ImageBudget = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Lato lungo massimo dell'immagine stoccata.
   *
   * `.q-card-wrap` in sala è `max-width: 48rem` = 768px CSS, e il proiettore
   * è 1080p a 1×: 768 pixel fisici. 1280 è già margine abbondante, e costa
   * poco perché WebP comprime bene le fotografie.
   */
  const MAX_LONG_SIDE = 1280;

  /** Tetto per immagine: 150 KiB. 20 domande illustrate ≈ 3MB per quiz. */
  const MAX_BYTES = 153600;

  /**
   * Input accettato: 25 MiB. Volutamente generoso — l'host non deve sentirsi
   * limitato, e una foto da telefono ci sta comodamente sotto.
   */
  const MAX_INPUT_BYTES = 26214400;

  /**
   * Qualità WebP da provare, in ordine.
   *
   * Si scende solo se il file supera MAX_BYTES. Sotto 0.58 NON si scende: si
   * accetta un file più grande piuttosto che proiettare artefatti su un muro.
   */
  const QUALITY_LADDER = [0.80, 0.72, 0.65, 0.58];

  /**
   * Un riferimento a immagine è l'esadecimale minuscolo di uno SHA-256.
   *
   * NOTA: questa regex esiste anche in `server/quiz-schema.js`. È deliberato:
   * quel modulo deve restare puro e senza dipendenze da `client/`, e questo
   * file è servito ai browser. Sono i due lati dello stesso contratto — se
   * cambia uno, cambia l'altro.
   */
  const HASH_RE = /^[0-9a-f]{64}$/;

  /**
   * Dimensioni a cui ridimensionare, preservando il rapporto.
   *
   * Non ritaglia MAI e non ingrandisce mai: un'immagine già sotto il limite
   * torna identica. Ritagliare per far combaciare il 16:9 del riquadro
   * significherebbe decidere noi quale parte della foto conta; ci pensa invece
   * `object-fit: contain` in sala a farla stare intera.
   *
   * @param {number} width
   * @param {number} height
   * @param {number} [maxLongSide]
   * @returns {{ width: number, height: number }}
   */
  function targetDimensions(width, height, maxLongSide = MAX_LONG_SIDE) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new RangeError('targetDimensions: larghezza e altezza devono essere numeri positivi.');
    }

    const longSide = Math.max(width, height);
    if (longSide <= maxLongSide) {
      return { width: Math.round(width), height: Math.round(height) };
    }

    const factor = maxLongSide / longSide;
    return {
      width:  Math.max(1, Math.round(width * factor)),
      height: Math.max(1, Math.round(height * factor)),
    };
  }

  /**
   * Il gradino di qualità successivo, o null se siamo al pavimento.
   *
   * Definita come "il primo valore della scala strettamente minore di
   * `current`" invece che "l'elemento dopo di me": così un valore che non
   * appartiene alla scala (1, o un residuo di una versione precedente) entra
   * comunque dal gradino giusto invece di non trovarsi.
   *
   * @param {number} current
   * @returns {number | null}
   */
  function nextQuality(current) {
    for (const q of QUALITY_LADDER) {
      if (q < current) return q;
    }
    return null;
  }

  /**
   * @param {unknown} value
   * @returns {boolean}
   */
  function isValidHash(value) {
    return typeof value === 'string' && HASH_RE.test(value);
  }

  return {
    MAX_LONG_SIDE,
    MAX_BYTES,
    MAX_INPUT_BYTES,
    QUALITY_LADDER,
    targetDimensions,
    nextQuality,
    isValidHash,
  };
});
