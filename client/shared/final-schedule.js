'use strict';

/**
 * client/shared/final-schedule.js
 *
 * Il calendario della premiazione finale: a che istante accade ogni atto della
 * cerimonia. Decisioni pure — nessun DOM, nessun timer, nessun suono.
 * Ricalca la separazione già usata dal progetto fra server/game.js (puro) e
 * server/game-socket.js (I/O), e fra audio-logic.js e audio.js.
 *
 * Caricato come <script> dalla vista sala (espone window.FinalSchedule) e come
 * modulo CommonJS da server/game-socket.js e da tools/test-final.js.
 *
 * ═══ Perché il calendario è CONDIVISO e non duplicato ═══════════════════════
 *
 * La sala recita la cerimonia; il server ne legge la durata per dire ai
 * telefoni quando passare dal "Guarda lo schermo!" alla propria posizione
 * (`game:ceremony-done`). Due copie dei tempi divergerebbero al primo ritocco,
 * e un telefono svelerebbe la classifica prima del proiettore. Qui c'è una
 * fonte sola.
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

  // ─── Ritmo della coda (dall'ultimo al 4°) ──────────────────────────────────

  /** Pausa dopo la prima riga della coda. */
  const GAP_FAST = 650;

  /** Pausa dopo l'ultima riga prima del podio: la più lunga, la più carica. */
  const GAP_SLOW = 1700;

  /**
   * Curvatura del ritardando. >1 concentra il rallentamento verso il podio:
   * la coda scorre via svelta e si impunta solo quando conta.
   */
  const TAIL_CURVE = 1.7;

  /**
   * Tetto complessivo della coda. Con venticinque giocatori il ritardando puro
   * darebbe un preambolo da ventitré secondi: la sala si distrae e il podio
   * arriva a festa già finita. Oltre il tetto le pause si comprimono in blocco,
   * conservando la forma del rallentamento.
   */
  const TAIL_BUDGET_MS = 11000;

  // ─── Atti del podio ────────────────────────────────────────────────────────

  /** Uscita di scena delle righe già rivelate. */
  const TAIL_EXIT_MS = 550;

  /** Il palco vuoto prende il centro prima che si alzi il primo gradino. */
  const STAGE_IN_MS = 450;

  /** Quanto il bronzo resta solo in scena. Va letto, non intravisto. */
  const BRONZE_HOLD_MS = 2200;

  /** Salita del gradino d'argento, ancora coperto. */
  const SILVER_COVER_MS = 700;

  /**
   * Il vuoto prima della proclamazione: argento coperto, gradino d'oro ancora
   * vuoto, due nomi possibili. È il punto più teso della serata — accorciarlo
   * è la prima cosa da NON fare per far stare la cerimonia in meno tempo.
   */
  const SUSPENSE_HOLD_MS = 3000;

  /**
   * Ritardo con cui l'argento si scopre DOPO il vincitore. Deve restare
   * positivo: è ciò che impedisce di annunciare il primo per esclusione.
   */
  const UNCOVER_DELAY_MS = 400;

  /** Respiro prima che la scena si assesti nel fotogramma finale. */
  const SETTLE_DELAY_MS = 650;

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
   * Le pause della coda, in ordine di rivelazione (ultimo classificato per
   * primo). Crescenti: il ritardando è tutta la drammaturgia dell'atto.
   *
   * @param {number} tailCount quante posizioni compongono la coda
   * @returns {number[]} pausa DOPO ciascuna riga
   */
  function tailGaps(tailCount) {
    if (tailCount <= 0) return [];
    // Con una riga sola non c'è nessun rallentamento da distribuire: quella
    // riga è già "l'ultima prima del podio" e si prende la pausa lunga.
    if (tailCount === 1) return [GAP_SLOW];

    const gaps = [];
    for (let i = 0; i < tailCount; i++) {
      const t = i / (tailCount - 1);
      gaps.push(GAP_FAST + (GAP_SLOW - GAP_FAST) * Math.pow(t, TAIL_CURVE));
    }

    const total = gaps.reduce((sum, g) => sum + g, 0);
    if (total <= TAIL_BUDGET_MS) return gaps.map(Math.round);

    // Compressione proporzionale: la coda sta nel tetto senza perdere la forma.
    const scale = TAIL_BUDGET_MS / total;
    return gaps.map((g) => Math.round(g * scale));
  }

  /**
   * Il calendario completo della cerimonia.
   *
   * Ogni atto è uno scarto in millisecondi dall'inizio, MAI una pausa relativa
   * all'atto precedente: chi lo esegue pianifica tutto da una base sola, così
   * quindici secondi di setTimeout concatenati non accumulano deriva.
   *
   * @param {{ playerCount: number }} params
   * @returns {{ steps: Array<{at: number, kind: string, rank: number|null}>, totalMs: number }}
   */
  function buildFinalSchedule({ playerCount } = {}) {
    const n = normalizeCount(playerCount);
    const steps = [];
    if (n === 0) return { steps, totalMs: 0 };

    let t = 0;
    const push = (kind, rank = null) => steps.push({ at: Math.round(t), kind, rank });

    // ── Atto 1: la coda, dall'ultimo al 4°, in ritardando ──
    const tailCount = Math.max(0, n - 3);
    const gaps = tailGaps(tailCount);
    for (let i = 0; i < tailCount; i++) {
      push('tail', n - i);
      t += gaps[i];
    }

    // ── Atto 2: la coda esce, il palco prende il centro ──
    if (tailCount > 0) {
      push('tail-exit');
      t += TAIL_EXIT_MS;
    }
    t += STAGE_IN_MS;

    // ── Atto 3: il bronzo, rivelato per intero ──
    if (n >= 3) {
      push('podium-3', 3);
      t += BRONZE_HOLD_MS;
    }

    // ── Atto 4: l'argento coperto, poi il vuoto. Il picco. ──
    if (n >= 2) {
      push('podium-2-covered', 2);
      t += SILVER_COVER_MS;
      push('suspense');
      t += SUSPENSE_HOLD_MS;
    }

    // ── Atto 5: la proclamazione ──
    push('winner', 1);

    // ── Atto 6: e solo ORA si scopre il secondo ──
    if (n >= 2) {
      t += UNCOVER_DELAY_MS;
      push('uncover-2', 2);
    }

    // ── Atto 7: il fotogramma finale ──
    t += SETTLE_DELAY_MS;
    push('settle');

    return { steps, totalMs: Math.round(t) };
  }

  /**
   * Quanto il server aspetta, da `game:final`, prima di annunciare ai telefoni
   * che la cerimonia è finita (`game:ceremony-done`). È la durata del calendario
   * più il ritardo di cortesia del telefono: il segnale non può arrivare prima
   * che la sala abbia chiuso l'ultimo atto.
   *
   * @param {number} playerCount giocatori in classifica
   * @returns {number} millisecondi; 0 se non c'è nessuno da premiare
   */
  function ceremonyDurationMs(playerCount) {
    const { totalMs } = buildFinalSchedule({ playerCount });
    return normalizeCount(playerCount) === 0 ? 0 : totalMs + PLAYER_LAG_MS;
  }

  /**
   * L'istante in cui la sala rivela una data posizione, o null se quel
   * giocatore non viene mai rivelato (classifica vuota). Usata dal test per
   * dimostrare l'ordine anti-spoiler della cerimonia in sala.
   */
  function revealAtForRank(schedule, rank) {
    const revealing = { 1: 'winner', 2: 'uncover-2', 3: 'podium-3' };
    const kind = revealing[rank] ?? 'tail';
    const step = (schedule?.steps ?? []).find(
      (s) => s.kind === kind && (kind !== 'tail' || s.rank === rank),
    );
    return step ? step.at : null;
  }

  return {
    GAP_FAST,
    GAP_SLOW,
    TAIL_CURVE,
    TAIL_BUDGET_MS,
    TAIL_EXIT_MS,
    STAGE_IN_MS,
    BRONZE_HOLD_MS,
    SILVER_COVER_MS,
    SUSPENSE_HOLD_MS,
    UNCOVER_DELAY_MS,
    SETTLE_DELAY_MS,
    PLAYER_LAG_MS,
    buildFinalSchedule,
    ceremonyDurationMs,
    revealAtForRank,
  };
});
