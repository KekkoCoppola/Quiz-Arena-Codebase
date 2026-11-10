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
   * Conto alla rovescia che apre la partita in sala ("Pronti?", 3, 2, 1, VIA!).
   * Il server lo riserva PRIMA della prima domanda, così nessuno risponde
   * mentre la sala conta. `0` lo spegne (lo fanno i test di integrazione).
   * Default: 4000 ms, un secondo di "Pronti?" e tre di conteggio.
   */
  startCountdownMs: Number.isFinite(parseInt(process.env.START_COUNTDOWN_MS, 10))
    ? Math.max(0, parseInt(process.env.START_COUNTDOWN_MS, 10))
    : 4000,

  /**
   * Pagina di debug dei minigiochi (`/debug`, vedi server/debug-tools.js):
   * accesa solo con `DEBUG_TOOLS=1`. Spenta, la pagina non è servita e i suoi
   * eventi non esistono. Mai durante un evento: crea una partita nuova.
   */
  debugTools: process.env.DEBUG_TOOLS === '1',

  /**
   * La rete Wi-Fi della sala, come la mostra la guida sullo schermo
   * proiettato (passo 1: "Connettiti al Wi-Fi"). Il server non crea la rete:
   * la configura deploy/setup-pi.sh, che scrive qui gli stessi valori che
   * riceve con --ssid e --pass. Password vuota = rete aperta.
   */
  wifi: {
    ssid: (process.env.WIFI_SSID || '').trim() || 'QuizZata',
    password: process.env.WIFI_PASSWORD || '',
  },

  /**
   * Il nome della sala per il QR e l'indirizzo di collegamento dei giocatori.
   * Lo risolve il DNS dell'access point (deploy/setup-pi.sh: address=/quizzata.gioca/...).
   * Default: "quizzata.gioca".
   */
  joinHost: process.env.JOIN_HOST !== undefined
    ? process.env.JOIN_HOST.trim()
    : 'quizzata.gioca',

  /**
   * Licenza annuale (vedi server/license.js): accesa solo con
   * `LICENSE_REQUIRED=1`. Spenta, non c'è nessun limite e nessun controllo —
   * è lo stato del PC di sviluppo, che non ha un seriale Raspberry.
   */
  licenseRequired: process.env.LICENSE_REQUIRED === '1',

  /**
   * Numero WhatsApp di chi vende (solo cifre, col prefisso: 393331234567) per
   * il bottone "Rinnova" quando la licenza non ne porta uno suo. Facoltativo.
   */
  licenseContact: String(process.env.LICENSE_CONTACT || '').replace(/\D/g, ''),

  /** true se l'app gira in modalità sviluppo. */
  isDev: process.env.NODE_ENV !== 'production',
};

module.exports = config;
