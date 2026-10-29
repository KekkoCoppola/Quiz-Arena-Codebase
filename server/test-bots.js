'use strict';

/**
 * server/test-bots.js
 *
 * Giocatori finti per provare una partita da soli — soprattutto la premiazione
 * finale, che con tre persone non si vede davvero: la coda in ritardando, il
 * tetto sulla sua durata e il podio hanno senso solo con una sala piena.
 *
 * Si attivano da un gesto nascosto nel pannello host (dieci clic sul logo) e
 * non esistono in nessun altro modo: non c'è un endpoint, non c'è un flag di
 * configurazione, e restano dietro `requireHost()` come ogni comando di gioco.
 *
 * Modulo **puro**: nomi, avatar e la sola "decisione" di un bot — un'opzione a
 * caso. Nessun socket, nessun timer, nessuna dipendenza da game.js. Chi li fa
 * rispondere davvero, e quando, è game-socket.js: lì vivono i timer veri.
 *
 * Un bot non è furbo di proposito. Serve una classifica sparpagliata, non un
 * avversario: tira a indovinare e basta.
 */

/** Quanti bot aggiunge il gesto, se non viene chiesto altro. */
const DEFAULT_COUNT = 19;

/** Tetto di sicurezza: il gesto è nascosto, ma un payload arriva dalla rete. */
const MAX_COUNT = 60;

const NOMI = [
  'Giulia', 'Marco', 'Sara', 'Luca', 'Elena', 'Dario', 'Chiara', 'Paolo',
  'Nina', 'Simone', 'Alice', 'Matteo', 'Sofia', 'Andrea', 'Viola',
  'Tommaso', 'Beatrice', 'Filippo', 'Martina', 'Riccardo', 'Anna', 'Davide',
];

/** Lo stesso catalogo che valida l'avatar di un umano. */
const AvatarCatalog = require('../client/shared/avatar-catalog');

/**
 * Avatar dell'i-esimo bot: colore, faccia e outfit avanzano a passi diversi
 * (7 è primo con 12), così una sala piena di bot non è un muro di personaggi
 * uguali.
 */
function botAvatar(i) {
  const { COLORS, FACES, OUTFITS } = AvatarCatalog;
  return AvatarCatalog.encode(
    COLORS[i % COLORS.length].id,
    FACES[(i * 7) % FACES.length].id,
    OUTFITS[i % OUTFITS.length].id,
  );
}

/**
 * Quanti bot creare davvero, qualunque cosa arrivi nel payload.
 * @param {unknown} requested
 */
function normalizeCount(requested) {
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_COUNT;
  return Math.min(n, MAX_COUNT);
}

/**
 * Nome e avatar dell'i-esimo bot. Oltre la rosa dei nomi si aggiunge un numero,
 * perché `addPlayer` rifiuta i nickname duplicati.
 * @param {number} i indice a partire da 0
 */
function identity(i) {
  const giro = Math.floor(i / NOMI.length);
  return {
    nickname: NOMI[i % NOMI.length] + (giro > 0 ? ` ${giro + 1}` : ''),
    avatar: botAvatar(i),
  };
}

/**
 * La risposta di un bot: un'opzione a caso. È tutto qui, ed è voluto.
 *
 * @param {number} optionCount quante opzioni ha il round
 * @param {() => number} [rnd] generatore in [0, 1), iniettabile nei test —
 *   stessa filosofia del parametro `now` in game.js
 * @returns {number} indice scelto, 0 se il round non ha opzioni
 */
function pickOption(optionCount, rnd = Math.random) {
  if (!Number.isFinite(optionCount) || optionCount <= 0) return 0;
  return Math.floor(rnd() * optionCount);
}

/**
 * Quando risponde un bot, in millisecondi dall'inizio della domanda.
 *
 * Sparsi invece che tutti insieme, per un motivo solo: in sala il contatore
 * delle risposte deve salire a scaglioni come con delle persone, non scattare
 * da 0 a 19 in un fotogramma. Non è un'imitazione del pensiero.
 *
 * Il tetto al 60% del tempo non è estetica: un bot in ritardo terrebbe in
 * ostaggio il round di chi sta giocando davvero.
 *
 * @param {number} timeLimitS limite del round in secondi
 * @param {() => number} [rnd]
 */
function answerDelayMs(timeLimitS, rnd = Math.random) {
  const limite = Math.max(1, Number(timeLimitS) || 20) * 1000;
  return Math.round(300 + rnd() * Math.min(limite * 0.6, 7000));
}

module.exports = {
  DEFAULT_COUNT,
  MAX_COUNT,
  NOMI,
  normalizeCount,
  identity,
  pickOption,
  answerDelayMs,
};
