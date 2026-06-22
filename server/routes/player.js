'use strict';

/**
 * server/routes/player.js
 *
 * Step 3: Serve la SPA mobile del giocatore.
 *
 * GET / → restituisce client/player/index.html (entry point della SPA).
 * Gli asset statici (app.js, CSS, immagini) vengono serviti dal middleware
 * express.static registrato in index.js subito dopo questo router.
 *
 * Step 5+: Aggiungere qui eventuali endpoint REST player
 *          (es. GET /api/player/state per recuperare lo stato corrente del gioco).
 * La logica real-time (join, risposta, classifica) avviene via Socket.io in game.js.
 */

const path   = require('node:path');
const router = require('express').Router();

// GET / → SPA player (entry point)
router.get('/', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '../../client/player/index.html'));
});

module.exports = router;
