#!/usr/bin/env node
'use strict';

/**
 * tools/issue-license.js
 *
 * Emette una licenza firmata per un Pi, sul PC di chi vende. Stampa il
 * messaggio pronto da mandare al cliente su WhatsApp: un link che, toccato
 * mentre il telefono è sulla rete del Pi, attiva la licenza da solo.
 *
 * Ogni licenza emessa si aggiunge al registro ~/.quizzata/licenze-emesse.csv.
 *
 * Esempi:
 *   node tools/issue-license.js --seriale 10000000a1b2c3d4 --cliente "Pub Da Mario" --anni 1
 *   node tools/issue-license.js --seriale 10000000a1b2c3d4 --cliente "Pub Da Mario" \
 *        --anni 1 --dal 2027-11-07 --giocatori 20 --minigiochi morra_cinese,cup_game
 *
 * Opzioni:
 *   --seriale <hex>        seriale del Pi (lo legge il cliente nella pagina Licenza)   obbligatorio
 *   --cliente <nome>       nome del cliente, compare nel pannello
 *   --scadenza AAAA-MM-GG  ultimo giorno di validità, oppure:
 *   --anni <n>             durata in anni a partire da --dal (default: oggi).
 *                          Per un rinnovo usa --dal con la VECCHIA scadenza: chi
 *                          rinnova in anticipo non perde giorni.
 *   --giocatori <n>        massimo di giocatori (default: nessun limite)
 *   --minigiochi <elenco>  tipi separati da virgola, oppure "tutti" (default)
 *   --whatsapp <numero>    il tuo numero col prefisso (es. 393331234567): il bottone
 *                          "Rinnova su WhatsApp" del Pi scriverà a questo numero
 *   --chiave <file>        chiave privata (default ~/.quizzata/licenza-privata.pem)
 *   --host <indirizzo>     indirizzo del Pi nel link (default 192.168.4.1)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const License = require('../server/license');
const { MINIGAME_TYPE_KEYS } = require('../server/minigames');

const QUIZZATA_DIR = path.join(os.homedir(), '.quizzata');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function die(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (process.argv.includes('--help') || process.argv.length <= 2) {
  const src = fs.readFileSync(__filename, 'utf8');
  const doc = src.slice(src.indexOf('/**') + 3, src.indexOf('*/'));
  console.log(doc.split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n').trim());
  process.exit(0);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Ultimo giorno di validità: `anni` dopo `dal`, meno un giorno. */
function addYears(fromIso, years) {
  const [y, m, d] = fromIso.split('-').map(Number);
  const end = new Date(Date.UTC(y + years, m - 1, d));
  end.setUTCDate(end.getUTCDate() - 1);
  return isoDate(end);
}

const serial = arg('--seriale');
if (!serial) die('Manca --seriale (il cliente lo trova nella pagina Licenza del suo Quiz-Zata).');

let validUntil = arg('--scadenza');
if (!validUntil) {
  const years = Number(arg('--anni') ?? 1);
  if (!Number.isInteger(years) || years < 1 || years > 10) die('--anni deve essere un numero intero da 1 a 10.');
  const from = arg('--dal') ?? isoDate(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) die('--dal deve essere una data AAAA-MM-GG.');
  validUntil = addYears(from, years);
}

let minigames = 'all';
const mgArg = arg('--minigiochi');
if (mgArg && mgArg !== 'tutti' && mgArg !== 'all') {
  minigames = mgArg.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = minigames.filter((t) => !MINIGAME_TYPE_KEYS.includes(t));
  if (unknown.length) {
    die(`Minigiochi sconosciuti: ${unknown.join(', ')}\n   Disponibili: ${MINIGAME_TYPE_KEYS.join(', ')}`);
  }
}

const keyPath = path.resolve(arg('--chiave') ?? path.join(QUIZZATA_DIR, 'licenza-privata.pem'));
if (!fs.existsSync(keyPath)) die(`Chiave privata non trovata in ${keyPath}\n   La prima volta: node tools/license-keygen.js`);
const privateKey = fs.readFileSync(keyPath, 'utf8');

const raw = {
  serial,
  customer: arg('--cliente') ?? '',
  validUntil,
  issuedAt: isoDate(new Date()),
  maxPlayers: arg('--giocatori') !== undefined ? Number(arg('--giocatori')) : null,
  minigames,
  ...(arg('--whatsapp') ? { contact: arg('--whatsapp') } : {}),
};

let code;
try {
  code = License.signLicense(raw, privateKey);
} catch (err) {
  die(err.message);
}

const host = arg('--host') ?? '192.168.4.1';
const link = `http://${host}/licenza#${code}`;
const lic = License.verifyLicense(code, require('node:crypto').createPublicKey(privateKey)).license;
const [yy, mm, dd] = lic.validUntil.split('-');

// Registro delle licenze emesse: chi, cosa, fino a quando.
fs.mkdirSync(QUIZZATA_DIR, { recursive: true });
const registry = path.join(QUIZZATA_DIR, 'licenze-emesse.csv');
if (!fs.existsSync(registry)) {
  fs.writeFileSync(registry, 'emessa;seriale;cliente;scadenza;giocatori;minigiochi;codice\n');
}
const csv = (v) => `"${String(v).replace(/"/g, '""')}"`;
fs.appendFileSync(registry, [
  lic.issuedAt, lic.serial, csv(lic.customer), lic.validUntil,
  lic.maxPlayers ?? 'tutti', csv(lic.minigames === 'all' ? 'tutti' : lic.minigames.join(',')), code,
].join(';') + '\n');

console.log('\n✅ Licenza emessa');
console.log(`   Seriale:    ${lic.serial}`);
console.log(`   Cliente:    ${lic.customer || '—'}`);
console.log(`   Valida fino al ${dd}/${mm}/${yy} compreso`);
console.log(`   Giocatori:  ${lic.maxPlayers ?? 'nessun limite'}`);
console.log(`   Minigiochi: ${lic.minigames === 'all' ? 'tutti' : lic.minigames.join(', ')}`);
console.log(`   Registro:   ${registry}`);
console.log('\n── Messaggio da mandare al cliente ─────────────────────────────\n');
console.log(`Ecco la tua licenza Quiz-Zata, valida fino al ${dd}/${mm}/${yy}.`);
console.log('Collegati alla rete QuizZata e tocca questo link:');
console.log(link);
console.log('\n────────────────────────────────────────────────────────────────');
console.log('\nSolo il codice (se il link non si apre, va incollato nella pagina Licenza):');
console.log(code + '\n');
