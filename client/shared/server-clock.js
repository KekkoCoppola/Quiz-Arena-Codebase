'use strict';

/**
 * client/shared/server-clock.js
 *
 * Converte una scadenza espressa nell'orologio del SERVER in una scadenza
 * valida sull'orologio LOCALE di chi la riceve.
 *
 * ═══ Il problema ═══════════════════════════════════════════════════════════
 *
 * Il server manda scadenze assolute (`endsAt` di una domanda, `revealAt` di un
 * minigioco) prese dal proprio `Date.now()`. Finché ogni client le confronta
 * col PROPRIO `Date.now()`, il countdown è sbagliato di quanto i due orologi
 * sono distanti fra loro — e due dispositivi qualunque lo sono: il Raspberry
 * gira senza rete durante l'evento, quindi senza NTP, mentre i telefoni hanno
 * l'ora della rete cellulare. Bastano pochi secondi di scarto perché in sala
 * manchino quattro secondi e sul telefono il tempo sia già scaduto.
 *
 * ═══ La correzione ═════════════════════════════════════════════════════════
 *
 * Insieme alla scadenza il server manda anche il proprio `serverNow`. La
 * DIFFERENZA fra i due è un intervallo, non un istante: è la stessa in
 * qualunque orologio la si misuri. Sommandola all'ora locale di ricezione si
 * ottiene la scadenza nell'orologio di chi la riceve, e lo scarto sparisce.
 *
 * Resta fuori solo la latenza di rete in andata — millisecondi su una LAN, e
 * comunque sempre nella direzione giusta: il client si ferma un attimo dopo il
 * server, mai prima.
 *
 * Caricato come <script> dalle tre SPA (espone window.ServerClock) e come
 * modulo CommonJS dai test.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ServerClock = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * La scadenza, riportata sull'orologio locale.
   *
   * @param {number} endsAt scadenza secondo l'orologio del server
   * @param {number} [serverNow] `Date.now()` del server al momento dell'invio
   * @param {number} [now] ora locale di ricezione (iniettabile nei test)
   * @returns {number} scadenza da confrontare col `Date.now()` locale
   */
  function localDeadline(endsAt, serverNow, now = Date.now()) {
    if (!Number.isFinite(endsAt)) return now;
    // Senza `serverNow` non c'è correzione possibile: si usa la scadenza così
    // com'è. È il comportamento di prima — sbagliato quanto gli orologi sono
    // distanti, ma mai peggio, e tiene in piedi un client più vecchio del server.
    if (!Number.isFinite(serverNow)) return endsAt;
    return now + (endsAt - serverNow);
  }

  /**
   * Quanto manca, in millisecondi, mai negativo.
   *
   * @param {number} deadline scadenza già riportata all'orologio locale
   * @param {number} [now]
   */
  function remainingMs(deadline, now = Date.now()) {
    if (!Number.isFinite(deadline)) return 0;
    return Math.max(0, deadline - now);
  }

  return { localDeadline, remainingMs };
});
