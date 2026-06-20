'use strict';

/**
 * server/index.js
 *
 * Entrypoint del server Quiz Arena.
 *
 * Step 1: Verifica che la configurazione venga caricata correttamente
 *         e stampa un banner di avvio. Il server Express/Socket.io
 *         verrà integrato allo Step 3.
 *
 * Step 3+: Bootstrap di Express, Socket.io e hook licenza (fase futura).
 */

const config = require('./config');

// ─── Banner di avvio ────────────────────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  🎮  Quiz Arena');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Ambiente   : ${config.isDev ? '🛠  Sviluppo' : '🚀 Produzione'}`);
console.log(`  Porta      : ${config.port}`);
console.log(`  Host path  : ${config.hostPanelPath}`);
console.log(`  DB path    : ${config.dbPath}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  ✅  Configurazione caricata con successo.');
console.log('  ℹ️   Server Express verrà avviato allo Step 3.\n');

// TODO (Step 3): creare app Express, montare router, agganciare Socket.io, listen()
