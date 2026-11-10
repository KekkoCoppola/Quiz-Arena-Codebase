'use strict';

/**
 * server/lan-url.js
 *
 * Unico punto in cui si calcola l'indirizzo a cui i giocatori si collegano.
 * Serve a due chiamanti con permessi diversi — l'API host autenticata e la
 * vista sala pubblica — e duplicare la logica significherebbe poterne
 * aggiornare una sola: sul Raspberry in access point l'interfaccia giusta da
 * scegliere è una decisione che cambierà, e deve cambiare in un posto solo.
 */

const os = require('node:os');
const config = require('./config');

/**
 * Primo indirizzo a cui i giocatori si collegano: se `config.joinHost` è impostato
 * (default "quizzata.gioca"), usa il nome di dominio risolto dal DNS locale.
 * Altrimenti ripiega sul primo IPv4 non di loopback.
 * @returns {string} URL completo, es. "http://quizzata.gioca" o "http://192.168.4.1:3000"
 */
function lanJoinUrl() {
  if (config.joinHost) {
    const port = config.port === 80 ? '' : `:${config.port}`;
    return `http://${config.joinHost}${port}`;
  }
  let ip = null;
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const net of addresses ?? []) {
      if (net.family === 'IPv4' && !net.internal) { ip = net.address; break; }
    }
    if (ip) break;
  }
  return `http://${ip ?? 'localhost'}:${config.port}`;
}

/**
 * L'indirizzo da SCRIVERE sotto il QR: il nome della sala (`config.joinHost`)
 * se c'è, altrimenti lo stesso IP del QR. Con "http://" davanti apposta: un
 * dominio come ".gioca" scritto da solo nella barra del browser finisce in
 * una ricerca, non sul sito. La porta compare solo se non è la 80.
 * @returns {string} es. "http://quizzata.gioca" o "http://192.168.4.1:3000"
 */
function displayJoinUrl() {
  return lanJoinUrl();
}

module.exports = { lanJoinUrl, displayJoinUrl };
