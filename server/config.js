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

  /**
   * Cartella dei quiz di sistema, un file JSON per quiz.
   * Configurabile perche deve poter stare FUORI dal codice: col packaging SEA
   * il server diventa un binario, mentre questi file devono restare sul disco
   * del Raspberry per poter essere modificati senza ricompilare nulla.
   */
  quizzesDir: process.env.QUIZZES_DIR || './content/quizzes',

  /**
   * Durata del sipario che apre ogni minigioco in sala (tende, ruota che
   * estrae il gioco, tende che si riaprono su di esso). Il server la riserva
   * PRIMA dell'anteprima e delle risposte, così nessuno sceglie mentre la sala
   * guarda le tende. `0` la spegne (lo fanno i test di integrazione).
   * Default: 12000 ms, la durata per cui è stata scritta la sequenza.
   */
  minigameIntroMs: Number.isFinite(parseInt(process.env.MINIGAME_INTRO_MS, 10))
    ? Math.max(0, parseInt(process.env.MINIGAME_INTRO_MS, 10))
    : 12000,

  /**
   * Pagina di debug dei minigiochi (`/debug`, vedi server/debug-tools.js):
   * accesa solo con `DEBUG_TOOLS=1`. Spenta, la pagina non è servita e i suoi
   * eventi non esistono. Mai durante un evento: crea una partita nuova.
   */
  debugTools: process.env.DEBUG_TOOLS === '1',

  /** true se l'app gira in modalità sviluppo. */
  isDev: process.env.NODE_ENV !== 'production',
};

module.exports = config;
