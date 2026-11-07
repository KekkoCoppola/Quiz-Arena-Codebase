'use strict';

/**
 * server/license-service.js
 *
 * La licenza del dispositivo, collegata al mondo: legge il seriale della
 * scheda, conserva il codice attivo e l'ora fidata nel DB (via quiz-manager,
 * unico punto di contatto con SQLite) e risponde a chi chiede "cosa si può
 * fare adesso". Le decisioni stanno tutte in server/license.js, che è puro:
 * stessa separazione di game.js / game-socket.js.
 */

const fs = require('node:fs');
const config = require('./config');
const db = require('./quiz-manager');
const License = require('./license');
const { PUBLIC_KEY } = require('./license-public-key');

const KEY_CODE = 'license.code';
const KEY_FLOOR = 'license.clockFloor';
/** L'ora fidata si salva al più ogni tanto: cresce a ogni telefono che entra. */
const FLOOR_SAVE_EVERY_MS = 10 * 60_000;

let serial = null;
let license = null;
let clock = License.createTrustedClock();
let lastFloorSave = 0;

/**
 * Seriale della scheda Raspberry Pi: lo stesso che il cliente legge nella
 * pagina Licenza e che finisce dentro il codice. `/proc/device-tree` è la
 * fonte più affidabile; `/proc/cpuinfo` il ripiego. Su Windows non c'è: null.
 */
function readSerial() {
  try {
    const s = fs.readFileSync('/proc/device-tree/serial-number', 'utf8').replace(/\0/g, '').trim().toLowerCase();
    if (/^[0-9a-f]{8,16}$/.test(s)) return s;
  } catch { /* non è un Raspberry, o il kernel non lo espone */ }
  try {
    const m = /^Serial\s*:\s*([0-9a-f]{8,16})\s*$/im.exec(fs.readFileSync('/proc/cpuinfo', 'utf8'));
    if (m) return m[1].toLowerCase();
  } catch { /* idem */ }
  return null;
}

/** Va chiamata dopo db.initDb(). */
function init() {
  serial = readSerial();
  const stored = db.getSetting(KEY_CODE);
  if (stored) {
    const r = License.verifyLicense(stored, PUBLIC_KEY);
    license = r.ok ? r.license : null;
  }
  clock = License.createTrustedClock({ floorMs: Number(db.getSetting(KEY_FLOOR)) || 0 });

  if (config.licenseRequired) {
    if (!PUBLIC_KEY) {
      console.error('❌ [Licenza] LICENSE_REQUIRED=1 ma nessuna chiave pubblica: il dispositivo resta in demo.');
      console.error('   Genera le chiavi con: node tools/license-keygen.js');
    }
    if (!serial) console.error('❌ [Licenza] Seriale della scheda non leggibile: il dispositivo resta in demo.');
    const s = status();
    console.log(`  Licenza    : ${s.state}${s.validUntil ? ` (fino al ${s.validUntil})` : ''}, seriale ${serial ?? '—'}`);
  }
}

/** Stato completo, anche per la pagina pubblica /licenza. */
function status() {
  const ev = License.evaluateLicense({
    license,
    serial,
    now: clock.now(),
    required: config.licenseRequired,
  });
  return {
    required: config.licenseRequired,
    ...ev,
    serial,
    contact: license?.contact || config.licenseContact || null,
  };
}

/** Cosa permette la licenza adesso: `{ maxPlayers, minigames }`. */
function entitlements() {
  return status().entitlements;
}

/**
 * Attiva un codice (o un link) di licenza.
 * @returns {{ ok: true, status: object } | { ok: false, error: string }}
 */
function activate(input) {
  const r = License.verifyLicense(input, PUBLIC_KEY);
  if (!r.ok) return r;
  const can = License.canReplace(license, r.license, serial);
  if (!can.ok) return can;
  db.setSetting(KEY_CODE, r.code);
  license = r.license;
  console.log(`[Licenza] attivata: ${license.customer || '—'}, fino al ${license.validUntil}`);
  return { ok: true, status: status() };
}

/**
 * Un dispositivo si è collegato e ha detto che ore sono per lui.
 * @param {string} deviceKey indirizzo del dispositivo
 * @param {number} clientNowMs ora dichiarata
 */
function observeClientTime(deviceKey, clientNowMs) {
  if (!clock.observe(deviceKey, Number(clientNowMs))) return;
  const now = Date.now();
  if (now - lastFloorSave >= FLOOR_SAVE_EVERY_MS || lastFloorSave === 0) {
    lastFloorSave = now;
    try {
      db.setSetting(KEY_FLOOR, String(Math.round(clock.floor)));
    } catch (err) {
      console.error('[Licenza] ora fidata non salvata:', err.message);
    }
  }
}

module.exports = { init, status, entitlements, activate, observeClientTime };
