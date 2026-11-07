'use strict';

/**
 * server/license.js
 *
 * La licenza annuale, in forma PURA: nessun file, nessun DB, nessuna rete.
 * Come game.js, ogni decisione che dipende dal tempo riceve `now` come
 * parametro, quindi si prova in Node senza orologi finti (tools/test-license.js).
 *
 * Il dispositivo non vede mai internet, quindi la licenza non può essere
 * controllata da remoto. È un testo firmato con Ed25519:
 *
 *     QZ1.<dati in base64url>.<firma in base64url>
 *
 * - La CHIAVE PRIVATA sta solo sul PC di chi vende (tools/issue-license.js):
 *   senza, nessuno fabbrica una licenza valida.
 * - Il Pi porta solo la CHIAVE PUBBLICA, che verifica e non firma.
 * - I dati portano il seriale della scheda: lo stesso codice su un altro Pi
 *   non vale, e una SD copiata in un'altra scheda torna in modalità demo.
 * - Cambiare una sola lettera dei dati rompe la firma.
 *
 * Che giorno è lo decide `createTrustedClock`: il Pi non ha un orologio a
 * batteria e la sua ora si sposta a mano, mentre i telefoni che si collegano
 * hanno l'ora della rete cellulare. Vedi più sotto.
 */

const crypto = require('node:crypto');

// ─── Costanti ────────────────────────────────────────────────────────────────────

const PREFIX = 'QZ1';
const DAY_MS = 86_400_000;

/** Dopo la scadenza la licenza continua a funzionare ancora per questi giorni. */
const GRACE_DAYS = 14;
/** Da quanti giorni prima della scadenza il pannello avvisa. */
const WARN_DAYS = 30;

/** Senza licenza valida si gioca lo stesso, ma in pochi: basta per provarlo. */
const DEMO_ENTITLEMENTS = Object.freeze({ maxPlayers: 3, minigames: 'all' });
/** Licenza non richiesta (sviluppo, o LICENSE_REQUIRED spento): nessun limite. */
const FULL_ENTITLEMENTS = Object.freeze({ maxPlayers: null, minigames: 'all' });

const MAX_PLAYERS_LIMIT = 500;

// Ora dai telefoni: servono almeno CLOCK_QUORUM dispositivi diversi che
// concordino entro CLOCK_AGREE_MS. Un solo telefono con l'ora sbagliata (un
// ospite al 2030) non fa scadere niente, e il gestore non la falsifica con
// un telefono solo.
const CLOCK_QUORUM = 3;
const CLOCK_AGREE_MS = 10 * 60_000;
/** Un campione più vecchio di così non conta più: è di un'altra serata. */
const CLOCK_SAMPLE_TTL_MS = 6 * 60 * 60_000;

// ─── Validazione dei dati ────────────────────────────────────────────────────────

const SERIAL_RE = /^[0-9a-f]{8,16}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONTACT_RE = /^\d{6,15}$/;
const MINIGAME_ID_RE = /^[a-z0-9_]{1,40}$/;

/** "2027-11-07" valida e reale (niente 31 febbraio), oppure null. */
function parseDate(value) {
  const m = DATE_RE.exec(String(value ?? ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms;
}

/**
 * Normalizza e valida i dati di una licenza. Usata sia da chi firma (lo
 * strumento) sia da chi verifica (il Pi): una sola idea di "licenza valida".
 * @returns {{ ok: true, license: object } | { ok: false, error: string }}
 */
function normalizeLicense(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Dati della licenza mancanti.' };

  const serial = String(raw.serial ?? '').trim().toLowerCase();
  if (!SERIAL_RE.test(serial)) return { ok: false, error: 'Seriale non valido.' };

  if (parseDate(raw.validUntil) === null) return { ok: false, error: 'Data di scadenza non valida.' };
  if (raw.issuedAt !== undefined && parseDate(raw.issuedAt) === null) {
    return { ok: false, error: 'Data di emissione non valida.' };
  }

  let maxPlayers = null;
  if (raw.maxPlayers !== undefined && raw.maxPlayers !== null) {
    maxPlayers = Number(raw.maxPlayers);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > MAX_PLAYERS_LIMIT) {
      return { ok: false, error: `Numero di giocatori non valido (da 1 a ${MAX_PLAYERS_LIMIT}).` };
    }
  }

  let minigames = 'all';
  if (raw.minigames !== undefined && raw.minigames !== 'all') {
    if (!Array.isArray(raw.minigames) || !raw.minigames.every((t) => MINIGAME_ID_RE.test(String(t)))) {
      return { ok: false, error: 'Elenco dei minigiochi non valido.' };
    }
    minigames = [...new Set(raw.minigames.map(String))];
  }

  const contact = raw.contact === undefined || raw.contact === null ? null : String(raw.contact).replace(/\D/g, '');
  if (contact !== null && !CONTACT_RE.test(contact)) {
    return { ok: false, error: 'Numero di contatto non valido (solo cifre, con prefisso internazionale).' };
  }

  const customer = String(raw.customer ?? '').trim().slice(0, 80);

  return {
    ok: true,
    license: {
      v: 1,
      serial,
      customer,
      validUntil: String(raw.validUntil),
      ...(raw.issuedAt !== undefined ? { issuedAt: String(raw.issuedAt) } : {}),
      maxPlayers,
      minigames,
      ...(contact ? { contact } : {}),
    },
  };
}

// ─── Firma e verifica ────────────────────────────────────────────────────────────

/**
 * Firma una licenza. Solo per lo strumento del venditore e per i test: il Pi
 * non ha mai una chiave privata.
 * @param {object} raw dati della licenza
 * @param {crypto.KeyObject | string} privateKey chiave privata Ed25519 (PEM o KeyObject)
 * @returns {string} il codice "QZ1.…"
 */
function signLicense(raw, privateKey) {
  const norm = normalizeLicense(raw);
  if (!norm.ok) throw new Error(norm.error);
  const body = `${PREFIX}.${Buffer.from(JSON.stringify(norm.license)).toString('base64url')}`;
  const signature = crypto.sign(null, Buffer.from(body), privateKey);
  return `${body}.${signature.toString('base64url')}`;
}

/**
 * Ripulisce ciò che l'host incolla: il codice da solo, il link intero
 * (http://…/licenza#QZ1.…) o il codice spezzato su più righe da WhatsApp.
 */
function extractCode(input) {
  let text = String(input ?? '');
  const hash = text.indexOf('#');
  if (hash !== -1) text = text.slice(hash + 1);
  try { text = decodeURIComponent(text); } catch { /* resta com'è */ }
  return text.replace(/\s+/g, '');
}

/**
 * Verifica firma e contenuto di un codice.
 * @param {string} input codice o link
 * @param {crypto.KeyObject | string | null} publicKey chiave pubblica Ed25519
 * @returns {{ ok: true, license: object, code: string } | { ok: false, error: string }}
 */
function verifyLicense(input, publicKey) {
  if (!publicKey) return { ok: false, error: 'Questo dispositivo non ha la chiave per verificare le licenze.' };

  const code = extractCode(input);
  const parts = code.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, error: 'Questo non sembra un codice di licenza Quiz-Zata.' };
  }

  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: 'Codice non valido: è incompleto o è stato modificato.' };

  let raw;
  try {
    raw = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'Codice non leggibile.' };
  }
  const norm = normalizeLicense(raw);
  if (!norm.ok) return norm;
  return { ok: true, license: norm.license, code };
}

// ─── Stato della licenza ─────────────────────────────────────────────────────────

/** Fine dell'ultimo giorno di validità (la licenza vale per tutto quel giorno). */
function expiresAtMs(license) {
  return parseDate(license.validUntil) + DAY_MS;
}

function entitlementsOf(license) {
  return Object.freeze({
    maxPlayers: license.maxPlayers ?? null,
    minigames: license.minigames ?? 'all',
  });
}

/**
 * Dove sta la licenza e cosa permette, a un dato istante.
 *
 * Stati: `off` (licenza non richiesta), `missing`, `wrong-device`, `active`,
 * `expiring` (ultimi WARN_DAYS giorni), `grace` (scaduta da meno di
 * GRACE_DAYS: funziona ancora, il pannello insiste), `expired`.
 * In `missing`, `wrong-device` ed `expired` si gioca in modalità demo.
 *
 * @param {{ license: object|null, serial: string|null, now: number, required: boolean }} p
 */
function evaluateLicense({ license, serial, now, required }) {
  if (!required) {
    return { state: 'off', demo: false, entitlements: FULL_ENTITLEMENTS, daysLeft: null, validUntil: null, customer: null };
  }
  const demo = (state) => ({
    state,
    demo: true,
    entitlements: DEMO_ENTITLEMENTS,
    daysLeft: null,
    validUntil: license?.validUntil ?? null,
    customer: license?.customer ?? null,
  });

  if (!license) return demo('missing');
  if (!serial || license.serial !== serial) return demo('wrong-device');

  const end = expiresAtMs(license);
  const base = { validUntil: license.validUntil, customer: license.customer };
  if (now < end) {
    const daysLeft = Math.ceil((end - now) / DAY_MS);
    return {
      ...base,
      state: daysLeft <= WARN_DAYS ? 'expiring' : 'active',
      demo: false,
      entitlements: entitlementsOf(license),
      daysLeft,
    };
  }
  const graceEnd = end + GRACE_DAYS * DAY_MS;
  if (now < graceEnd) {
    return {
      ...base,
      state: 'grace',
      demo: false,
      entitlements: entitlementsOf(license),
      daysLeft: -Math.floor((now - end) / DAY_MS),
      graceDaysLeft: Math.ceil((graceEnd - now) / DAY_MS),
    };
  }
  return { ...demo('expired'), daysLeft: -Math.floor((now - end) / DAY_MS) };
}

/** True se il minigioco è incluso nei diritti (`'all'` comprende anche quelli futuri). */
function isMinigameAllowed(entitlements, type) {
  return entitlements.minigames === 'all' || entitlements.minigames.includes(type);
}

/**
 * Si può attivare `next` al posto di `current` su questo dispositivo?
 * Un codice per un altro Pi è un errore di chi lo manda; uno con scadenza
 * precedente a quella attiva accorcerebbe la licenza (un vecchio messaggio
 * WhatsApp riaperto per sbaglio), quindi si rifiuta.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function canReplace(current, next, serial) {
  if (!serial || next.serial !== serial) {
    return { ok: false, error: 'Questo codice è per un altro Quiz-Zata: controlla il seriale.' };
  }
  if (current && current.serial === serial && parseDate(next.validUntil) < parseDate(current.validUntil)) {
    return { ok: false, error: `Questo codice scade prima di quello già attivo (${current.validUntil}): è un codice vecchio.` };
  }
  return { ok: true };
}

// ─── Ora fidata ──────────────────────────────────────────────────────────────────

/**
 * L'ora vera, ricavata dai dispositivi che si collegano.
 *
 * Ogni telefono (o il tablet dell'host) dichiara la propria ora alla
 * connessione; se ne tiene lo SCARTO rispetto all'orologio del Pi, uno per
 * dispositivo. Quando almeno CLOCK_QUORUM dispositivi diversi concordano entro
 * CLOCK_AGREE_MS, la loro mediana è l'ora vera. Il massimo mai confermato
 * (`floor`) si salva e non torna indietro: ripristinare una copia vecchia
 * della SD non riporta indietro il calendario, perché alla prima partita i
 * telefoni ridicono che giorno è.
 *
 * Senza ancora un accordo (Pi appena acceso) vale il più alto fra `floor` e
 * l'orologio del Pi: spostarlo avanti farebbe solo scadere prima la licenza.
 *
 * @param {{ floorMs?: number, quorum?: number, agreeMs?: number, ttlMs?: number }} [opts]
 */
function createTrustedClock(opts = {}) {
  const quorum = opts.quorum ?? CLOCK_QUORUM;
  const agreeMs = opts.agreeMs ?? CLOCK_AGREE_MS;
  const ttlMs = opts.ttlMs ?? CLOCK_SAMPLE_TTL_MS;
  /** @type {Map<string, { offset: number, seenAt: number }>} */
  const samples = new Map();
  let floor = Number.isFinite(opts.floorMs) ? opts.floorMs : 0;

  function prune(localNow) {
    for (const [key, s] of samples) {
      if (localNow - s.seenAt > ttlMs || s.seenAt > localNow) samples.delete(key);
    }
  }

  /** Mediana del gruppo più numeroso di scarti vicini, se raggiunge il quorum. */
  function consensusOffset() {
    const offsets = [...samples.values()].map((s) => s.offset).sort((a, b) => a - b);
    let best = null;
    for (let i = 0, j = 0; j < offsets.length; j++) {
      while (offsets[j] - offsets[i] > agreeMs) i++;
      const size = j - i + 1;
      // A parità di dimensione vince il gruppo più avanti nel tempo: nel dubbio
      // la licenza scade prima, mai dopo.
      if (size >= quorum && (!best || size >= best.size)) best = { size, from: i, to: j };
    }
    if (!best) return null;
    const group = offsets.slice(best.from, best.to + 1);
    return group[Math.floor(group.length / 2)];
  }

  return {
    /**
     * Registra l'ora dichiarata da un dispositivo.
     * @param {string} deviceKey identità del dispositivo (l'indirizzo IP)
     * @param {number} clientNowMs ora del dispositivo
     * @param {number} [localNow] orologio del Pi
     * @returns {boolean} true se l'ora fidata è avanzata (da salvare)
     */
    observe(deviceKey, clientNowMs, localNow = Date.now()) {
      if (!Number.isFinite(clientNowMs) || !deviceKey) return false;
      samples.set(String(deviceKey), { offset: clientNowMs - localNow, seenAt: localNow });
      prune(localNow);
      const offset = consensusOffset();
      if (offset === null) return false;
      const t = localNow + offset;
      if (t > floor) {
        floor = t;
        return true;
      }
      return false;
    },
    /** L'ora fidata adesso. */
    now(localNow = Date.now()) {
      prune(localNow);
      const offset = consensusOffset();
      if (offset !== null) return Math.max(floor, localNow + offset);
      return Math.max(floor, localNow);
    },
    /** True se c'è un accordo fra dispositivi in questo momento. */
    hasConsensus(localNow = Date.now()) {
      prune(localNow);
      return consensusOffset() !== null;
    },
    get floor() {
      return floor;
    },
  };
}

module.exports = {
  PREFIX,
  GRACE_DAYS,
  WARN_DAYS,
  DEMO_ENTITLEMENTS,
  FULL_ENTITLEMENTS,
  CLOCK_QUORUM,
  normalizeLicense,
  signLicense,
  verifyLicense,
  extractCode,
  evaluateLicense,
  isMinigameAllowed,
  canReplace,
  createTrustedClock,
};
