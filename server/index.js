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
const { isValidImageHash } = require('./quiz-schema');
const hostRouter   = require('./routes/host');
const playerRouter = require('./routes/player');
const { lanJoinUrl } = require('./lan-url');
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

// ─── Static: Codice client condiviso fra le due SPA ──────────────────────────
// Oggi contiene i moduli di presentazione dei minigiochi, caricati sia dal
// pannello host sia dal client giocatore. Separato da /resources perché è
// codice, non asset. Va montato prima del fallback API/player, come /resources.
app.use(
  '/shared',
  express.static(path.join(__dirname, '../client/shared'))
);

// ─── Static: SPA Sala ────────────────────────────────────────────────────────
// La vista proiettata, di sola lettura, che il Raspberry apre da solo in kiosk.
// Percorso fisso e pubblico — a differenza di hostPanelPath non è oscurabile:
// non c'è nulla da nascondere (nessun comando passa da qui, gli eventi host:*
// restano dietro requireHost) e il Pi deve poterlo aprire da un URL cablato.
app.use(
  '/sala',
  express.static(path.join(__dirname, '../client/sala'))
);

// Pagina di debug dei minigiochi: servita solo con DEBUG_TOOLS=1. Spenta, /debug
// cade nel router del giocatore come qualunque percorso sconosciuto. Per
// toglierla del tutto vedi server/debug-tools.js.
if (config.debugTools) {
  app.use('/debug', express.static(path.join(__dirname, '../client/debug')));
}

// ─── API Host ─────────────────────────────────────────────────────────────────
app.use('/api/host', hostRouter);

// ─── Join info pubblica ───────────────────────────────────────────────────────
// Stessa informazione di /api/host/game/join-info, senza autenticazione: serve
// alla vista sala per disegnare il QR, e la sala non ha un token. Non espone
// nulla di riservato — è l'URL che finisce proiettato in caratteri giganti
// davanti a tutta la stanza.
app.get('/api/join-info', (_req, res) => {
  res.json({ success: true, data: { url: lanJoinUrl() } });
});

// ─── Health Check ─────────────────────────────────────────────────────────────
// Formato unificato coerente con il resto delle route ({ success, data }).
app.get('/api/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } });
});

// ─── Immagini delle domande ───────────────────────────────────────────────────
// PUBBLICA, senza autenticazione, per la stessa ragione di /api/join-info: la
// vista sala non ha un token e non può averne uno. Chi è sull'access point e
// conosce l'hash scarica l'immagine — che è comunque destinata a finire
// proiettata su un muro davanti a tutta la stanza. L'hash è a 256 bit e non si
// indovina. È una scelta dichiarata nella spec, non una dimenticanza.
//
// DEVE stare prima del fallback /api/* → 404, altrimenti risponderebbe HTML.
app.get('/api/quiz-image/:hash', (req, res) => {
  const { hash } = req.params;

  // L'hash finisce in una query parametrizzata, quindi non c'è iniezione da
  // temere: il controllo serve a rispondere 400 invece di 404 a una richiesta
  // palesemente malformata, e a non interrogare il DB per niente.
  if (!isValidImageHash(hash)) {
    return res.status(400).json({ success: false, error: 'Hash non valido.' });
  }

  const image = db.getImage(hash);
  if (!image) {
    return res.status(404).json({ success: false, error: 'Immagine non trovata.' });
  }

  // `immutable` non è ottimismo: l'URL contiene l'hash del proprio contenuto,
  // quindi per costruzione non può mai servire byte diversi. Ogni dispositivo
  // scarica un'immagine una volta sola per tutta la serata, anche se l'host
  // rigioca la stessa partita.
  res.set({
    'Content-Type':  image.mime,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag':          `"${hash}"`,
  });

  return res.send(Buffer.from(image.bytes));
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
  // Gli errori dei body-parser (payload troppo grande, JSON malformato)
  // portano già uno status e un messaggio sensati: rispondere 500 li
  // trasformerebbe in "errore interno" e il client non saprebbe cosa correggere.
  const status = Number.isInteger(err?.status) ? err.status : 500;

  if (status >= 500) {
    console.error(`[Server] Errore non gestito su ${req.method} ${req.url}:`, err);
    return res.status(500).json({ success: false, error: 'Errore interno del server.' });
  }

  console.warn(`[Server] Richiesta rifiutata su ${req.method} ${req.url}: ${err.message}`);

  // body-parser rifiuta un body troppo grande con un messaggio in inglese
  // ("request entity too large"): un host lo leggerebbe crudo in un toast
  // durante un evento. `type` è il campo che body-parser stesso imposta per
  // questo caso — più stabile da controllare del testo del messaggio, che
  // potrebbe cambiare tra versioni della libreria.
  const message = err?.type === 'entity.too.large'
    ? 'Il file caricato è troppo grande.'
    : err.message;

  return res.status(status).json({ success: false, error: message });
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
