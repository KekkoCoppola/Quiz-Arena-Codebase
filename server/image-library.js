'use strict';

/**
 * server/image-library.js
 *
 * Le immagini dei quiz di sistema come **file**, in `content/images/`.
 * Stessa forma di `server/quiz-library.js` e del registry dei minigiochi: una
 * cartella scandita all'avvio, nessun elenco centrale da aggiornare, il nome
 * del file come identità.
 *
 * ── Perché esiste ───────────────────────────────────────────────────────────
 *
 * Le immagini sono indirizzate dal contenuto: `quiz_images.hash` è lo SHA-256
 * dei byte, e una domanda ci punta con quell'hash. Funziona benissimo per
 * l'editor del pannello host, che carica la foto e riceve indietro l'hash
 * calcolato dal server — ma rende i quiz di sistema inscrivibili a mano:
 * nessuno può digitare 64 caratteri esadecimali dentro un JSON.
 *
 * Questo modulo chiude quel buco. Una domanda di un file di sistema scrive il
 * NOME del file:
 *
 *     "image": { "file": "colosseo.webp", "blur": 60 }
 *
 * e `quiz-library.js` lo traduce in `{ hash, blur }` prima della validazione.
 * Lo schema non cambia: continua a conoscere solo `hash`, che resta l'unica
 * forma che arriva alla partita. Il nome del file vive soltanto fra il disco e
 * il caricamento, esattamente come lo slug di un quiz.
 *
 * ── Puro apposta ────────────────────────────────────────────────────────────
 *
 * Qui dentro non si tocca il database: si leggono byte e si calcolano hash.
 * Serve a tenere `loadQuizFiles` eseguibile senza DB — è così che
 * `tools/check-quizzes.js` dà un referto prima di una serata e che
 * `tools/test-quizzes.js` gira in isolamento. A scrivere i byte in
 * `quiz_images` è `syncToDatabase`, che il DB ce l'ha già in mano.
 *
 * ── Quanto possono pesare ───────────────────────────────────────────────────
 *
 * Molto più di quelle dell'editor. Il tetto di 150 KiB che si impone il
 * browser dell'host serve a un upload che passa dal Wi-Fi dell'access point;
 * questi file stanno già sulla scheda SD, e a scaricarli è **solo la sala**,
 * cioè il Chromium sullo stesso Pi che serve la pagina. I telefoni ricevono
 * il riferimento ma non disegnano l'immagine. Il limite qui esiste solo per
 * non far crescere il database oltre il ragionevole.
 */

const fs   = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const config = require('./config');

/** Cartella delle immagini di sistema. Accanto a `content/quizzes/`, e fuori
 *  da `server/` per la stessa ragione: nel packaging SEA il codice finisce nel
 *  binario, i contenuti devono restare modificabili sul disco del Pi. */
const IMAGES_DIR = path.resolve(config.imagesDir);

/** Oltre questo un file viene rifiutato: è un errore di chi lo ha messo lì,
 *  non una foto. 5 MiB sono già enormi per una domanda proiettata. */
const MAX_IMAGE_FILE_BYTES = 5 * 1024 * 1024;

/** Estensioni riconosciute, con il mime che va servito al browser. */
const MIME_BY_EXT = Object.freeze({
  '.webp': 'image/webp',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
});

// ─── Misure ──────────────────────────────────────────────────────────────────

/**
 * Larghezza e altezza leggendo la sola intestazione del file.
 *
 * Scritta a mano invece di usare una libreria per la stessa ragione per cui la
 * compressione delle immagini vive nel browser dell'host e non in `sharp`: il
 * progetto ha eliminato i moduli nativi per poter impacchettare un binario
 * singolo su ARM, e un decoder completo qui non serve a nessuno. Di ogni
 * formato si leggono i pochi byte che dichiarano le misure.
 *
 * Non lancia mai: un'intestazione che non si riesce a leggere restituisce
 * `null`, e il chiamante stocca comunque l'immagine con misure sconosciute —
 * la sala disegna l'`<img>`, non questi numeri.
 *
 * @param {Buffer} buf
 * @returns {{ width: number, height: number } | null}
 */
function readImageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;

  // ── PNG: firma di 8 byte, poi il chunk IHDR con le due misure a 32 bit.
  if (buf.length >= 24 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // ── GIF: "GIF87a"/"GIF89a", poi due interi a 16 bit little-endian.
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // ── WebP: contenitore RIFF, tre varianti di payload.
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const tipo = buf.toString('ascii', 12, 16);
    // Esteso (animazioni, trasparenza, metadati): misure meno uno su 24 bit.
    if (tipo === 'VP8X') {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width: w, height: h };
    }
    // Senza perdita: 14 bit a testa, impacchettati dopo la firma 0x2f.
    if (tipo === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    // Con perdita: keyframe VP8, misure a 14 bit dopo il codice di avvio.
    if (tipo === 'VP8 ' && buf.length >= 30) {
      return {
        width:  buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    return null;
  }

  // ── JPEG: si cammina di marcatore in marcatore fino a un SOF.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      // SOF0..SOF15, saltando DHT (c4), JPG (c8) e DAC (cc), che non lo sono.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  }

  return null;
}

// ─── Lettura della cartella ──────────────────────────────────────────────────

/**
 * Legge ogni immagine della cartella e ne calcola l'hash.
 *
 * Non lancia mai, per la stessa ragione di `loadQuizFiles`: una cartella
 * assente o un file illeggibile diventano una voce in `errors`, non
 * un'eccezione. Una serata non si ferma per una foto.
 *
 * @param {string} [dir] cartella da leggere. Il default è quella vera; il
 *   parametro esiste per i test, come il `dir` di `loadQuizFiles`.
 * @returns {{ images: Map<string, object>, errors: string[] }}
 *   `images` è indicizzata per nome file (`colosseo.webp`) e porta
 *   `{ hash, mime, bytes, width, height }`.
 */
function loadImageFiles(dir = IMAGES_DIR) {
  const images = new Map();
  const errors = [];

  let files;
  try {
    files = fs.readdirSync(dir).sort();
  } catch {
    // Cartella assente: nessuna immagine di sistema, e nessun errore. È lo
    // stato normale di un'installazione che usa solo domande di testo.
    return { images, errors };
  }

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    // Un README o un .gitkeep nella cartella non sono un problema di nessuno.
    if (!mime) continue;

    let bytes;
    try {
      bytes = fs.readFileSync(path.join(dir, file));
    } catch (err) {
      errors.push(`${file}: non leggibile (${err.message})`);
      continue;
    }

    if (bytes.length === 0) {
      errors.push(`${file}: file vuoto`);
      continue;
    }
    if (bytes.length > MAX_IMAGE_FILE_BYTES) {
      errors.push(
        `${file}: ${(bytes.length / 1024 / 1024).toFixed(1)} MB, oltre il tetto di `
        + `${MAX_IMAGE_FILE_BYTES / 1024 / 1024} MB — ridimensionala prima di usarla`
      );
      continue;
    }

    const size = readImageSize(bytes) ?? { width: 0, height: 0 };
    images.set(file, {
      hash: createHash('sha256').update(bytes).digest('hex'),
      mime,
      bytes,
      width: size.width,
      height: size.height,
    });
  }

  return { images, errors };
}

module.exports = {
  loadImageFiles,
  readImageSize,
  IMAGES_DIR,
  MAX_IMAGE_FILE_BYTES,
  MIME_BY_EXT,
};
