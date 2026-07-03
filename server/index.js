'use strict';

/**
 * server/index.js
 *
 * Step 3: Bootstrap del server Express, configurazione Socket.io,
 * inizializzazione database e gestione shutdown ordinata.
 *
 * Responsabilità di questo file:
 *   - Creare e configurare l'app Express
 *   - Montare middleware, router e file statici nell'ordine corretto
 *   - Creare il server HTTP e agganciare Socket.io
 *   - Inizializzare il database prima di avviare il listener
 *   - Gestire SIGINT/SIGTERM con chiusura pulita di server e DB
 *
 * NON contiene logica di gioco (→ Step 5: game.js).
 */

const path             = require('node:path');
const http             = require('node:http');
const express          = require('express');
const { Server: SocketServer } = require('socket.io');

const config       = require('./config');
const db           = require('./quiz-manager');
const hostRouter   = require('./routes/host');
const playerRouter = require('./routes/player');
const { attachGameHandlers } = require('./game-socket');

// ─── App Express ─────────────────────────────────────────────────────────────

const app = express();

// Rimuove l'header X-Powered-By: Express (fingerprinting passivo)
app.disable('x-powered-by');

// Parsing body: JSON con limite 1 MB per prevenire payload bombing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Logging minimale delle richieste — solo in sviluppo, senza dipendenze esterne
if (config.isDev) {
  app.use((req, _res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
  });
}

// ─── Static: SPA Host ────────────────────────────────────────────────────────
// Montato sul percorso oscurato definito in .env (default: /admin-console).
// Gestisce automaticamente sia /admin-console che /admin-console/ e i relativi asset.
app.use(
  config.hostPanelPath,
  express.static(path.join(__dirname, '../client/host'))
);

// ─── Static: Risorse condivise (loghi, sfondi, ecc.) ─────────────────────────
// Montato su /resources per servire gli asset grafici usati da tutte le SPA.
app.use(
  '/resources',
  express.static(path.join(__dirname, '../resources'))
);

// ─── API Host ─────────────────────────────────────────────────────────────────
app.use('/api/host', hostRouter);

// ─── Health Check ─────────────────────────────────────────────────────────────
// Formato unificato coerente con il resto delle route ({ success, data }).
app.get('/api/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } });
});

// ─── 404 per route /api/* non trovate ────────────────────────────────────────
// Intercetta chiamate API a endpoint inesistenti PRIMA del fallback statico,
// così restituisce JSON invece di HTML.
app.use('/api/*', (_req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint non trovato.' });
});

// ─── SPA Player ───────────────────────────────────────────────────────────────
// Il router player gestisce GET / (e in futuro altri endpoint REST player).
// Il middleware static serve gli asset (app.js, immagini, ecc.).
// Ordine importante: router prima, static dopo.
app.use('/', playerRouter);
app.use(express.static(path.join(__dirname, '../client/player')));

// ─── Error Handler Globale ────────────────────────────────────────────────────
// Deve essere registrato DOPO tutte le route.
// La firma a 4 argomenti è obbligatoria perché Express la usa per distinguerlo
// dai middleware normali.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(`[Server] Errore non gestito su ${req.method} ${req.url}:`, err);
  res.status(500).json({ success: false, error: 'Errore interno del server.' });
});

// ─── Server HTTP ──────────────────────────────────────────────────────────────
const httpServer = http.createServer(app);

// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new SocketServer(httpServer, {
  cors: {
    // Sviluppo: qualsiasi origin per comodità.
    // Produzione (Pi): restringere a 'http://192.168.4.1' o false (stessa origin).
    origin: config.isDev ? '*' : false,
  },
});

// Rende `io` accessibile nei moduli successivi (es. game.js — Step 5/6)
// tramite req.app.get('io') senza creare dipendenze circolari tra moduli.
app.set('io', io);

// Gestione connessioni Socket.io — solo bootstrap; nessuna logica di gioco
io.on('connection', (socket) => {
  if (config.isDev) {
    console.log(`[Socket.io] Client connesso    : ${socket.id}`);
  }

  // Ping/pong: utile per smoke test manuali (DevTools, wscat, ecc.)
  socket.on('ping', () => {
    socket.emit('pong', { time: Date.now() });
  });

  socket.on('disconnect', (reason) => {
    if (config.isDev) {
      console.log(`[Socket.io] Client disconnesso : ${socket.id} (${reason})`);
    }
  });
});

// ─── Handler di gioco (Step 6) ───────────────────────────────────────────────
// Secondo listener 'connection' sullo stesso io: Socket.io li esegue entrambi.
// Il bootstrap (log, ping/pong) resta qui sopra; la logica di gioco vive in
// game-socket.js.
attachGameHandlers(io);

// ─── Inizializzazione DB ──────────────────────────────────────────────────────
// Va chiamata prima di listen() così le route trovano il DB già pronto
// al momento della prima richiesta.
db.initDb(config.dbPath);

// ─── Avvio Server ─────────────────────────────────────────────────────────────
httpServer.listen(config.port, () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🎮  Quiz-Zata!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Ambiente   : ${config.isDev ? '🛠  Sviluppo' : '🚀 Produzione'}`);
  console.log(`  Porta      : ${config.port}`);
  console.log(`  Host path  : ${config.hostPanelPath}`);
  console.log(`  DB path    : ${config.dbPath}`);
  console.log(`  Player URL : http://localhost:${config.port}/`);
  console.log(`  Host URL   : http://localhost:${config.port}${config.hostPanelPath}`);
  console.log(`  Health     : http://localhost:${config.port}/api/health`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[Server] Ricevuto ${signal}. Chiusura in corso...`);
  httpServer.close(() => {
    db.closeDb();
    console.log('[Server] Chiuso correttamente. Nessun lock DB residuo.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
