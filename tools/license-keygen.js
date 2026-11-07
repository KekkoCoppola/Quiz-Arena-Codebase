#!/usr/bin/env node
'use strict';

/**
 * tools/license-keygen.js
 *
 * Genera, UNA VOLTA SOLA, la coppia di chiavi delle licenze:
 *   - la chiave privata va in un file sul PC di chi vende (fuori dal repo);
 *   - la chiave pubblica viene scritta in server/license-public-key.js,
 *     così ogni Pi preparato da qui in poi sa verificare le licenze.
 *
 * ⚠ La chiave privata è la cosa più preziosa del progetto:
 *   - persa: non si possono più rinnovare i Pi già venduti;
 *   - rubata: chiunque può fabbricare licenze.
 * Tienine due copie offline (chiavetta + password manager). Mai nel repo,
 * mai sul Pi. Per questo lo strumento si rifiuta di sovrascriverla.
 *
 * Utilizzo:
 *   node tools/license-keygen.js                 chiave in ~/.quizzata/licenza-privata.pem
 *   node tools/license-keygen.js --chiave <file> altro percorso
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_KEY = path.join(os.homedir(), '.quizzata', 'licenza-privata.pem');
const PUBLIC_MODULE = path.join(__dirname, '..', 'server', 'license-public-key.js');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const keyPath = path.resolve(arg('--chiave') ?? DEFAULT_KEY);

if (fs.existsSync(keyPath)) {
  console.error(`\n❌ Esiste già una chiave privata in:\n   ${keyPath}\n`);
  console.error('   Generarne un\'altra renderebbe inutilizzabili le licenze dei Pi già preparati.');
  console.error('   Se vuoi davvero ricominciare, sposta prima quel file a mano.\n');
  process.exit(1);
}

const current = require(PUBLIC_MODULE).PUBLIC_KEY;
if (current) {
  console.error('\n❌ server/license-public-key.js contiene già una chiave pubblica.');
  console.error('   Se hai perso la privata, le licenze dei Pi già venduti non si potranno più rinnovare:');
  console.error('   rimuovi la chiave da quel file a mano solo se sai cosa stai facendo.\n');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).trim();

fs.mkdirSync(path.dirname(keyPath), { recursive: true });
fs.writeFileSync(keyPath, privatePem, { mode: 0o600, flag: 'wx' });

const moduleSource = fs.readFileSync(PUBLIC_MODULE, 'utf8').replace(
  /module\.exports = \{ PUBLIC_KEY: null \};/,
  `module.exports = {\n  PUBLIC_KEY: \`${publicPem}\`,\n};`
);
fs.writeFileSync(PUBLIC_MODULE, moduleSource);

console.log('\n✅ Chiavi delle licenze generate.\n');
console.log(`   Chiave PRIVATA:  ${keyPath}`);
console.log('   Chiave pubblica: scritta in server/license-public-key.js\n');
console.log('   Adesso:');
console.log('   1. Copia la chiave privata in due posti sicuri offline (chiavetta + password manager).');
console.log('   2. Il file server/license-public-key.js va portato su ogni Pi insieme al resto del codice.');
console.log('   3. Per emettere una licenza: node tools/issue-license.js --help\n');
