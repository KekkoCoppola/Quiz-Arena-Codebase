'use strict';

/**
 * server/config.js
 *
 * Modulo di configurazione centralizzato.
 * Legge le variabili d'ambiente (tramite dotenv), le valida e le ri-esporta
 * come un oggetto tipizzato e documentato.
 *
 * REGOLA: nessun altro modulo del progetto deve accedere a `process.env` direttamente.
 * Tutta la configurazione passa da qui.
 */

require('dotenv').config();

// ─── Validazione variabili obbligatorie ─────────────────────────────────────────
const REQUIRED_VARS = ['JWT_SECRET'];

const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
if (missing.length > 0) {
  console.error('\n❌ [Config] Errore: variabili d\'ambiente obbligatorie mancanti:');
  missing.forEach((v) => console.error(`   → ${v}`));
  console.error('\n   Copia .env.example in .env e compila i valori mancanti.\n');
  process.exit(1);
}

// ─── Esportazione configurazione ────────────────────────────────────────────────
const config = {
  /** Porta su cui Express ascolta le connessioni. Default: 3000. */
  port: parseInt(process.env.PORT, 10) || 3000,

  /** Percorso URL oscurato del pannello amministrativo. Default: /admin-console. */
  hostPanelPath: process.env.HOST_PANEL_PATH || '/admin-console',

  /** Segreto per la firma dei token JWT. Obbligatorio. */
  jwtSecret: process.env.JWT_SECRET,

  /** Durata del token JWT prima della scadenza. Default: 8h. */
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',

  /** Percorso assoluto o relativo del file database SQLite. */
  dbPath: process.env.DB_PATH || './server/db/database.sqlite',

  /** true se l'app gira in modalità sviluppo. */
  isDev: process.env.NODE_ENV !== 'production',
};

module.exports = config;
