'use strict';

/**
 * server/routes/host.js
 *
 * Router Express per gli endpoint del pannello amministrativo host.
 *
 * Step 2+: Registrazione e login host (POST /login, POST /logout).
 * Step 3+: CRUD quiz personalizzati (GET/POST/DELETE /quizzes).
 * Step 6+: Endpoint per la conduzione della partita in tempo reale.
 *
 * Tutti gli endpoint protetti richiedono un token JWT valido nell'header:
 *   Authorization: Bearer <token>
 */

const router = require('express').Router();

// TODO (Step 2): POST /login      — autenticazione host, emette JWT
// TODO (Step 2): POST /logout     — invalida il token (opzionale con JWT stateless)
// TODO (Step 2): GET  /me         — restituisce dati utente dal token
// TODO (Step 2): GET  /quizzes    — lista quiz dell'utente autenticato
// TODO (Step 2): POST /quizzes    — crea nuovo quiz (max 3 per utente)
// TODO (Step 2): DELETE /quizzes/:id — elimina un quiz dell'utente

module.exports = router;
