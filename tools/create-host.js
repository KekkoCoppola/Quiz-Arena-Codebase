#!/usr/bin/env node
'use strict';

/**
 * tools/create-host.js
 *
 * Script CLI per il provisioning degli account host.
 * Eseguito SOLO dall'amministratore (tu) prima di consegnare il dispositivo al cliente.
 * NON è esposto in rete — gira localmente sul PC di sviluppo o sul Pi.
 *
 * Utilizzo:
 *   # Modalità interattiva (consigliata — la password NON compare nel terminale)
 *   node tools/create-host.js
 *
 *   # Modalità argomenti diretti (attenzione: la password è visibile nella shell history)
 *   node tools/create-host.js --username <username> --password <password>
 *
 * Requisiti:
 *   - Il file .env deve esistere nella root del progetto (o DB_PATH impostato)
 *   - Il database viene creato automaticamente se non esiste
 */

require('dotenv').config(); // legge .env dalla cwd (root del progetto)

const path                   = require('node:path');
const { createInterface }    = require('node:readline/promises');
const bcryptjs               = require('bcryptjs');
const { initDb, createUser, getUserByUsername, DuplicateUsernameError } = require('../server/quiz-manager');

// ─── Costanti ────────────────────────────────────────────────────────────────────

const BCRYPT_SALT_ROUNDS = 10;
const DB_PATH = process.env.DB_PATH || './server/db/database.sqlite';

// ─── Parsing argomenti CLI ───────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--username' && args[i + 1]) result.username = args[++i];
    if (args[i] === '--password' && args[i + 1]) result.password = args[++i];
  }
  return result;
}

// ─── Validazione ─────────────────────────────────────────────────────────────────

function validateUsername(value) {
  if (!value || value.trim().length < 3 || value.trim().length > 30) {
    return 'Username deve essere tra 3 e 30 caratteri.';
  }
  if (!/^[a-zA-Z0-9_]+$/.test(value.trim())) {
    return 'Username può contenere solo lettere, numeri e underscore.';
  }
  return null;
}

function validatePassword(value) {
  if (!value || value.length < 8) {
    return 'La password deve essere di almeno 8 caratteri.';
  }
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🎮  Quiz Arena — Creazione Account Host');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Inizializza il DB (crea il file se non esiste)
  const resolvedDb = path.resolve(DB_PATH);
  console.log(`  📂  Database: ${resolvedDb}\n`);
  initDb(DB_PATH);

  const args = parseArgs();
  const rl   = createInterface({ input: process.stdin, output: process.stdout });

  let username, password;

  try {
    // ── Username ──
    if (args.username) {
      username = args.username.trim();
      console.log(`  Username: ${username} (da argomento)`);
    } else {
      username = (await rl.question('  Username: ')).trim();
    }

    const usernameError = validateUsername(username);
    if (usernameError) {
      console.error(`\n  ❌  ${usernameError}\n`);
      process.exit(1);
    }

    // Verifica se esiste già prima di chiedere la password
    const existing = getUserByUsername(username);
    if (existing) {
      console.error(`\n  ❌  Username "${username}" già in uso. Scegli un nome diverso.\n`);
      process.exit(1);
    }

    // ── Password ──
    if (args.password) {
      password = args.password;
      console.log('  Password: *** (da argomento)');
    } else {
      password = await rl.question('  Password (min 8 caratteri): ');
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      console.error(`\n  ❌  ${passwordError}\n`);
      process.exit(1);
    }

    // ── Hashing e creazione ──
    console.log('\n  ⏳  Hashing della password in corso...');
    const hashedPassword = await bcryptjs.hash(password, BCRYPT_SALT_ROUNDS);

    const user = createUser(username, hashedPassword);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  ✅  Account host creato con successo!');
    console.log(`  ID       : ${user.id}`);
    console.log(`  Username : ${user.username}`);
    console.log(`  Creato   : ${user.created_at}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (err) {
    if (err instanceof DuplicateUsernameError) {
      console.error(`\n  ❌  ${err.message}\n`);
      process.exit(1);
    }
    console.error('\n  ❌  Errore inatteso:', err.message, '\n');
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
