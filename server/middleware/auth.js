'use strict';

/**
 * server/middleware/auth.js
 *
 * Middleware Express per la verifica dei token JWT.
 * Applicato a tutte le route del pannello host che richiedono autenticazione.
 *
 * Utilizzo nelle route:
 *   const { verifyToken } = require('../middleware/auth');
 *   router.get('/me', verifyToken, handler);
 *
 * Se il token è valido, attacca req.user = { userId, username } e chiama next().
 * Altrimenti risponde direttamente con 401 Unauthorized.
 */

const jwt    = require('jsonwebtoken');
const config = require('../config');

/**
 * Middleware di autenticazione JWT.
 *
 * Legge il token dall'header HTTP:
 *   Authorization: Bearer <token>
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Accesso negato. Token di autenticazione mancante.',
    });
  }

  const token = authHeader.slice(7); // rimuove il prefisso "Bearer "

  try {
    const payload = jwt.verify(token, config.jwtSecret);

    // Attacca i dati dell'utente alla request per i handler successivi
    req.user = {
      userId:   payload.userId,
      username: payload.username,
    };

    next();
  } catch (err) {
    const message =
      err.name === 'TokenExpiredError'
        ? 'Sessione scaduta. Effettua nuovamente il login.'
        : 'Token non valido. Effettua nuovamente il login.';

    return res.status(401).json({ success: false, error: message });
  }
}

module.exports = { verifyToken };
