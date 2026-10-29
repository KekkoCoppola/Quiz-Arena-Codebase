'use strict';

/**
 * client/shared/final-schedule.js
 *
 * Il calendario della premiazione finale: quanto dura la cerimonia e in che
 * istante la sala rivela ciascun posto del podio. Decisioni pure — nessun DOM,
 * nessun timer, nessun suono. Ricalca la separazione già usata dal progetto
 * fra server/game.js (puro) e server/game-socket.js (I/O).
 *
 * La cerimonia la recita la scena 3D di client/shared/podium-ceremony.js (solo
 * in sala): il 3° e il 2° salgono sul podio, poi il 1° con la coppa, mentre
 * dal 4° in giù fanno da pubblico intorno al palco. La coreografia sta lì;
 * qui ci sono solo i tempi che servono a chi NON la vede.
 *
 * Caricato come <script> dalla vista sala (espone window.FinalSchedule) e come
 * modulo CommonJS da server/game-socket.js e da tools/test-final.js.
 *
 * ═══ Perché il calendario è CONDIVISO e non duplicato ═══════════════════════
 *
 * La sala recita la cerimonia; il server ne legge la durata per dire ai
 * telefoni quando passare dal "Guarda lo schermo!" alla propria posizione
 * (`game:ceremony-done`). Due copie dei tempi divergerebbero al primo ritocco,
 * e un telefono svelerebbe la classifica prima del proiettore. La sala passa
 * DURATION_MS alla scena 3D, e tools/test-final.js verifica che gli istanti di
 * questo file coincidano con la coreografia di podium-ceremony.js.
 *
 * ═══ Come si tiene la sincronia (e perché NON con `revealAt`) ═══════════════
 *
 * Il resto del progetto sincronizza i client su timestamp assoluti (`endsAt`,
 * `revealAt`) che ogni dispositivo confronta col proprio `Date.now()`. Per un
 * countdown lo scarto fra orologi è cosmetico. Qui sarebbe fatale: un telefono
 * avanti di tre secondi proclamerebbe il vincitore tre secondi PRIMA del
 * proiettore, e la sala sentirebbe l'urlo prima di vedere il nome.
 *
 * Quindi niente orologio: `game:final` è un unico io.emit, e la sala fa
 * partire la cerimonia dal momento in cui LO RICEVE. Il segnale di fine per i
 * telefoni parte dal server allo stesso istante, dopo la durata del calendario
 * più PLAYER_LAG_MS: per arrivare in anticipo un telefono dovrebbe ricevere il
 * segnale 300 ms prima che la sala chiuda l'ultimo atto, che sul Raspberry
 * (sala praticamente in loopback, telefoni un salto Wi-Fi più in là) non
 * accade. Lo sbilanciamento è dalla parte sicura per costruzione.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FinalSchedule = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Durata della cerimonia 3D, dal primo fotogramma al gran finale. Dopo, la
   * scena resta viva in festa finché la partita non si chiude o riparte.
   * Non dipende dal numero di giocatori: il pubblico è in scena tutto insieme.
   */
  const DURATION_MS = 14500;

  /**
   * Istanti di atterraggio sul podio, come frazione della durata: gli stessi
   * di `PodiumCeremony.TIMELINE` (thirdLandAt, secondLandAt, firstLandAt).
   * È lì che ogni premiato diventa riconoscibile, targhetta col nome compresa.
   */
  const REVEAL_AT = Object.freeze({ 3: 0.25, 2: 0.47, 1: 0.73 });

  /**
   * Margine aggiunto alla fine della cerimonia prima di liberare i telefoni.
   * È ciò che rende strutturalmente impossibile un anticipo sul proiettore.
   */
  const PLAYER_LAG_MS = 300;

  /** Numero di giocatori utilizzabile, qualunque cosa arrivi. */
  function normalizeCount(playerCount) {
    const n = Math.floor(playerCount);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * Quanto il server aspetta, da `game:final`, prima di annunciare ai telefoni
   * che la cerimonia è finita (`game:ceremony-done`). È la durata della
   * cerimonia più il ritardo di cortesia del telefono: il segnale non può
   * arrivare prima che la sala abbia chiuso l'ultimo atto.
   *
   * @param {number} playerCount giocatori in classifica
   * @returns {number} millisecondi; 0 se non c'è nessuno da premiare
   */
  function ceremonyDurationMs(playerCount) {
    return normalizeCount(playerCount) === 0 ? 0 : DURATION_MS + PLAYER_LAG_MS;
  }

  /**
   * L'istante, in millisecondi da `game:final`, in cui la sala rivela un dato
   * posto. Dal 4° in giù si è in scena fin dal primo fotogramma, tra il
   * pubblico: 0. Null se quel posto non esiste in questa partita.
   *
   * @param {number} rank posizione in classifica (1 = vincitore)
   * @param {number} playerCount giocatori in classifica
   */
  function revealAtForRank(rank, playerCount) {
    const n = normalizeCount(playerCount);
    if (!Number.isInteger(rank) || rank < 1 || rank > n) return null;
    return rank <= 3 ? Math.round(REVEAL_AT[rank] * DURATION_MS) : 0;
  }

  return Object.freeze({
    DURATION_MS,
    REVEAL_AT,
    PLAYER_LAG_MS,
    ceremonyDurationMs,
    revealAtForRank,
  });
});
