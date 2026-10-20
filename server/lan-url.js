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
 * Primo indirizzo IPv4 non di loopback fra le interfacce di rete.
 * `localhost` come ripiego: inutile per un telefono, ma è meglio mostrare un
 * URL sbagliato che non mostrare nulla davanti a una sala che aspetta.
 * @returns {string} URL completo, es. "http://192.168.4.1:3000"
 */
function lanJoinUrl() {
  let ip = null;
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const net of addresses ?? []) {
      if (net.family === 'IPv4' && !net.internal) { ip = net.address; break; }
    }
    if (ip) break;
  }
  return `http://${ip ?? 'localhost'}:${config.port}`;
}

module.exports = { lanJoinUrl };
