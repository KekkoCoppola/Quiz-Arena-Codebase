'use strict';

/**
 * client/shared/minigames/cup-game.js
 *
 * Presentazione del minigioco "Tre Bicchieri" (cup_game) su sala, host e player.
 * Le regole (punti, esiti, estrazione di machineChoice) non stanno qui ma in
 * server/minigames/cup-game.js: questo modulo si occupa solo della messa in
 * scena (palcoscenico 3D WebGL in sala, fallback 2D automatico su host o senza
 * WebGL, bottoni di scelta e attesa sincronizzata sul telefono).
 *
 * ⚠ Nessun accesso non protetto al DOM o a WebGL al caricamento: il file viene
 * caricato con `require()` da Node in `tools/test-minigames.js` e in
 * `tools/test-mg-cup-game.js` per validare il contratto e testare la logica
 * pura del mescolamento.
 */

(function (root, factory) {
  const registry = (typeof module !== 'undefined' && module.exports)
    ? require('./index')
    : root.Minigames;
  registry.register(factory());
})(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Percorso assoluto del modulo Three.js vendorizzato nel progetto principale.
   * Non viene incluso nello zip di consegna: in produzione è servito da Express
   * sotto `/shared/vendor/three/three.module.min.js`.
   */
  const THREE_URL = '/shared/vendor/three/three.module.min.js';

  /** Asset SVG esistenti nel repository principale. */
  const CUP_ASSET = '/resources/img/cup-game/cup.svg';
  const BALL_ASSET = '/resources/img/cup-game/ball.svg';

  /**
   * Etichette allineate all'ordine del server (0 = Sinistra, 1 = Centro, 2 = Destra)
   * come le vede il pubblico davanti al proiettore.
   */
  const LABELS = ['Sinistra', 'Centro', 'Destra'];

  /**
   * Durata della pausa finale di lettura a fine reveal prima di invocare `ctx.done()`.
   * I 2000 ms garantiscono che tutta la sala legga lo sticker e veda la pallina
   * ferma sotto il bicchiere alzato prima del passaggio alla classifica.
   */
  const HOLD_MS = 2000;

  /**
   * Numero di scambi a coppie durante il mescolamento.
   * 8 scambi in ~7,3 s offrono un equilibrio ideale fra seguibilità a occhio
   * e vero senso di sfida per la sala.
   */
  const SWAP_COUNT = 8;

  /**
   * Pesi relativi della durata dei singoli scambi (lento -> veloce -> lento).
   * I primi due scambi fanno capire subito come si muovono i bicchieri, la
   * parte centrale accelera lo spettacolo e gli ultimi due rallentano per
   * consentire a chi è rimasto concentrato di agganciare la posizione finale.
   */
  const SWAP_WEIGHTS = [1.35, 1.15, 0.85, 0.75, 0.75, 0.80, 1.10, 1.25];

  /**
   * "Segui i bicchieri": lo spettacolo è diviso in due momenti, separati dalla
   * scelta dei giocatori.
   *
   * 1. ANTEPRIMA (`startSuspense`, fino a `ctx.answersOpenAt`, ~10 s): per
   *    `SHOW_MS` la pallina si vede sotto il bicchiere centrale alzato, poi la
   *    timeline `PREVIEW_PHASES` copre e mescola fino a fermarsi
   *    `SETTLE_MS` prima che si aprano le risposte. Durante la scelta i
   *    bicchieri restano fermi e coperti: chi ha seguito sa dov'è la pallina.
   * 2. REVEAL (`playReveal`, fino a `ctx.revealAt − HOLD_MS`, ~2 s): la
   *    timeline `LIFT_PHASES` alza il bicchiere giusto e poi gli altri due.
   *
   * Le soglie sono frazioni (0 -> 1) della durata attiva di ciascun momento:
   * - `coverEnd`: fine della discesa del bicchiere centrale sulla pallina;
   * - `shuffleEnd`: fine degli scambi;
   * - `pauseEnd`: fine della pausa immobile prima dell'alzata;
   * - `liftWinEnd`: fine dell'alzata del bicchiere vincente (poi gli altri).
   * Un valore fuori da [0, 1] spegne quella fase: l'anteprima non arriva mai
   * all'alzata, il reveal non ricopre e non rimescola.
   */
  const PREVIEW_PHASES = Object.freeze({ coverEnd: 0.12, shuffleEnd: 1, pauseEnd: 2, liftWinEnd: 3 });
  const LIFT_PHASES = Object.freeze({ coverEnd: -1, shuffleEnd: 0, pauseEnd: 0.2, liftWinEnd: 0.65 });

  /** Quanto si vede la pallina, prima che il bicchiere la copra. */
  const SHOW_MS = 1800;
  /** Pausa a bicchieri fermi prima che si aprano le risposte: si fissa la posizione. */
  const SETTLE_MS = 500;

  /**
   * Soglia minima del contenitore (in px) sotto cui si attiva automaticamente
   * il fallback 2D (es. la miniatura di conduzione sul tablet dell'host).
   */
  const MIN_3D_WIDTH_PX = 380;
  const MIN_3D_HEIGHT_PX = 145;

  /**
   * Soglia di frame-time medio (in ms, ~30 fps) oltre la quale la risoluzione
   * interna del canvas WebGL scende a `LOW_RES_SCALE` per proteggere il Pi 4.
   */
  const FRAME_TIME_BUDGET_MS = 33;
  const LOW_RES_SCALE = 0.75;

  /** Coordinate X delle 3 posizioni (Sinistra, Centro, Destra) nello spazio 3D. */
  const SLOT_X_3D = [-2.25, 0, 2.25];

  /** Tutte le coppie canoniche di posizioni scambiabili sul tavolo. */
  const ALL_PAIRS = [
    [0, 1],
    [1, 2],
    [0, 2],
  ];

  // ─── Stato privato del modulo ────────────────────────────────────────────────

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /**
   * Sessioni attive indicizzate per elemento `els.questionText`.
   * In produzione c'è un solo contenitore per pagina; nel banco di prova
   * permette a Sala (3D) e Host (miniatura 2D) di convivere senza conflitti,
   * mentre `stopSuspense()` pulisce tutte le sessioni in modo idempotente.
   * @type {Map<HTMLElement, { raf: number|null, timer: any, ro: ResizeObserver|null, uses3DCanvas: boolean }>}
   */
  const activeSessions = new Map();

  /** Handle del timeout di attesa sul telefono (`player.playReveal`). */
  let playerTimeout = null;

  /** Promise memorizzata dell'import dinamico di Three.js. */
  let threePromise = null;
  /** Modulo Three.js risolto, mantenuto in cache per tutta la sessione. */
  let THREE = null;
  /** Flag impostato se l'import di Three.js fallisce (attiva il fallback 2D). */
  let threeLoadFailed = false;

  /**
   * Unico `WebGLRenderer` e relativo `<canvas>`, creati in modo lazy al primo
   * utilizzo e riusati per tutti i round delle due ore di partita (§7.3).
   */
  let sharedRenderer = null;
  let sharedCanvas = null;
  /** Cache di geometrie e materiali procedurali riusati fra un round e l'altro. */
  let cachedAssets3D = null;
  /** Contatore diagnostico dei contesti WebGL creati dalla pagina (deve restare <= 1). */
  let webglContextsCreated = 0;
  /** True se il contesto WebGL è andato perso nel round corrente. */
  let contextLostInRound = false;
  /** Scala di risoluzione interna corrente (1 oppure LOW_RES_SCALE). */
  let currentResScale = 1;
  /** Media mobile esponenziale del frame-time in ms. */
  let avgFrameMs = 16.6;
  /** Contatore di frame lenti consecutivi prima di scalare a 0.75. */
  let slowFrameStreak = 0;

  /** Flag per forzare il fallback 2D dal banco di prova o da console. */
  let force2DMode = false;
  /** Ultima modalità usata dal palcoscenico principale ('3d' | '2d'). */
  let lastStageMode = '2d';

  // ─── Curve di easing ("colpo secco con leggero overshoot", §7.6) ─────────────

  /** Ease-out cubico morbido per archi di traslazione. */
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /**
   * Curva con overshoot ("arriva, supera di poco il bersaglio e si assesta con
   * un colpo secco", DESIGN.md / §7.6).
   */
  function easeOutBack(t, overshoot = 1.45) {
    const c1 = overshoot;
    const c3 = c1 + 1;
    const u = Math.max(0, Math.min(1, t)) - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  // ─── Logica pura del mescolamento (testabile in Node, §11) ───────────────────

  /** Verifica se due coppie `[a, b]` rappresentano lo stesso scambio. */
  function isSamePair(p1, p2) {
    return Boolean(p1 && p2 && p1[0] === p2[0] && p1[1] === p2[1]);
  }

  /** Restituisce la nuova posizione di un bicchiere dopo lo scambio `pair`. */
  function applyPairSwap(pos, pair) {
    if (pos === pair[0]) return pair[1];
    if (pos === pair[1]) return pair[0];
    return pos;
  }

  /**
   * Determina l'unico scambio finale che porta la pallina da `currentBallPos`
   * a `targetPos` in un solo passo (oppure, se è già lì, scambia i due
   * bicchieri vuoti lasciando ferma la pallina).
   */
  function requiredFinalPair(currentBallPos, targetPos) {
    if (currentBallPos === targetPos) {
      for (let i = 0; i < ALL_PAIRS.length; i++) {
        const p = ALL_PAIRS[i];
        if (p[0] !== targetPos && p[1] !== targetPos) return p;
      }
    }
    return currentBallPos < targetPos
      ? [currentBallPos, targetPos]
      : [targetPos, currentBallPos];
  }

  /**
   * Genera una sequenza deterministica/cosmetica di scambi che parte con la
   * pallina in `startPos` (di default 1, centro) e la fa terminare esattamente
   * in `targetPos` (`machineChoice`), garantendo che:
   *   1. non ci siano MAI due scambi identici consecutivi;
   *   2. la pallina finisca sempre in `targetPos`;
   *   3. ogni scambio abbia la propria finestra temporale normalizzata `[startU, endU]`
   *      dentro l'intervallo `[phases.coverEnd, phases.shuffleEnd]`.
   *
   * @param {number} [startPos=1] posizione iniziale della pallina (0, 1 o 2)
   * @param {number} [targetPos=1] posizione finale `machineChoice` (0, 1 o 2)
   * @param {number} [swapCount=SWAP_COUNT] numero totale di scambi (>= 3)
   * @param {() => number} [rnd=Math.random] generatore in [0, 1)
   * @param {object} [phases=PREVIEW_PHASES] timeline in cui collocare gli scambi
   * @returns {Array<{ a: number, b: number, startU: number, endU: number, frontA: boolean, ballAfter: number }>}
   */
  function generateSwapSequence(startPos = 1, targetPos = 1, swapCount = SWAP_COUNT, rnd = Math.random, phases = PREVIEW_PHASES) {
    const count = Math.max(3, Math.floor(swapCount));
    const safeStart = (startPos === 0 || startPos === 1 || startPos === 2) ? startPos : 1;
    const safeTarget = (targetPos === 0 || targetPos === 1 || targetPos === 2) ? targetPos : 1;

    const weights = [];
    let totalWeight = 0;
    for (let k = 0; k < count; k++) {
      const w = SWAP_WEIGHTS[k] ?? 1;
      weights.push(w);
      totalWeight += w;
    }

    const shuffleSpan = phases.shuffleEnd - phases.coverEnd;
    let cursorU = phases.coverEnd;

    let ballPos = safeStart;
    let lastPair = null;
    const sequence = [];

    for (let k = 0; k < count; k++) {
      let chosen = null;

      if (k === count - 1) {
        chosen = requiredFinalPair(ballPos, safeTarget);
      } else if (k === count - 2) {
        const valid = ALL_PAIRS.filter((p) => {
          if (isSamePair(p, lastPair)) return false;
          const nextBall = applyPairSwap(ballPos, p);
          const finalPair = requiredFinalPair(nextBall, safeTarget);
          return !isSamePair(p, finalPair);
        });
        const pool = valid.length > 0
          ? valid
          : ALL_PAIRS.filter((p) => !isSamePair(p, lastPair));
        chosen = pool[Math.floor(rnd() * pool.length) % pool.length];
      } else if (k === count - 3) {
        const valid = ALL_PAIRS.filter((p) => {
          if (isSamePair(p, lastPair)) return false;
          return applyPairSwap(ballPos, p) !== safeTarget;
        });
        const pool = valid.length > 0
          ? valid
          : ALL_PAIRS.filter((p) => !isSamePair(p, lastPair));
        chosen = pool[Math.floor(rnd() * pool.length) % pool.length];
      } else {
        const pool = ALL_PAIRS.filter((p) => !isSamePair(p, lastPair));
        chosen = pool[Math.floor(rnd() * pool.length) % pool.length];
      }

      ballPos = applyPairSwap(ballPos, chosen);
      lastPair = chosen;

      const spanU = (weights[k] / totalWeight) * shuffleSpan;
      const startU = cursorU;
      const endU = k === count - 1 ? phases.shuffleEnd : cursorU + spanU;
      cursorU = endU;

      sequence.push({
        a: chosen[0],
        b: chosen[1],
        startU,
        endU,
        frontA: k % 2 === 0,
        ballAfter: ballPos,
      });
    }

    return sequence;
  }

  /**
   * Calcola lo stato cinematico istantaneo dei 3 bicchieri e della pallina
   * durante il reveal in funzione della frazione temporale normalizzata `u` (0 -> 1).
   *
   * @param {number} u avanzamento normalizzato in [0, 1] fino a `landAt`
   * @param {Array} swaps sequenza prodotta da `generateSwapSequence`
   * @param {number} machineChoice indice finale vincente (0, 1 o 2)
   * @param {object} [phases=PREVIEW_PHASES] timeline (`PREVIEW_PHASES` o `LIFT_PHASES`)
   */
  function computeRevealKinematics(u, swaps, machineChoice, phases = PREVIEW_PHASES) {
    const PHASE_COVER_END = phases.coverEnd;
    const PHASE_SHUFFLE_END = phases.shuffleEnd;
    const PHASE_PAUSE_END = phases.pauseEnd;
    const PHASE_LIFT_WIN_END = phases.liftWinEnd;
    const progress = clamp01(u);

    const cupAtSlot = [0, 1, 2];
    const cups = [
      { x: -1, y: 0, z: 0, rotX: 0, rotZ: 0 },
      { x: 0, y: 0, z: 0, rotX: 0, rotZ: 0 },
      { x: 1, y: 0, z: 0, rotX: 0, rotZ: 0 },
    ];

    let ballSlot = 1;
    let ballX = 0;
    let ballY = 0;
    let ballVisible = true;
    let cameraZoom = 0;

    if (progress <= PHASE_COVER_END) {
      const localT = clamp01(progress / PHASE_COVER_END);
      const dropEase = easeOutBack(localT, 1.35);
      const lift = Math.max(0, 1 - dropEase);
      cups[1].y = lift * 1.35;
      cups[1].rotX = -lift * 0.32;
      cups[1].rotZ = lift * 0.08;
      ballX = 0;
      ballY = 0;
      ballVisible = localT < 0.92;
      return { cups, ballX, ballY, ballVisible, cameraZoom };
    }

    ballVisible = false;

    for (let k = 0; k < swaps.length; k++) {
      const s = swaps[k];
      if (progress >= s.endU) {
        const tmp = cupAtSlot[s.a];
        cupAtSlot[s.a] = cupAtSlot[s.b];
        cupAtSlot[s.b] = tmp;
        ballSlot = s.ballAfter;
      } else if (progress >= s.startU && progress < s.endU) {
        const rawT = clamp01((progress - s.startU) / Math.max(0.0001, s.endU - s.startU));
        const moveT = easeInOutCubic(rawT);
        const arcSin = Math.sin(rawT * Math.PI);

        const slotA = s.a;
        const slotB = s.b;
        const xA = slotA - 1;
        const xB = slotB - 1;
        const span = Math.abs(xB - xA);

        const cupA = cupAtSlot[slotA];
        const cupB = cupAtSlot[slotB];
        const signZ = s.frontA ? 1 : -1;

        for (let slot = 0; slot < 3; slot++) {
          const cid = cupAtSlot[slot];
          cups[cid].x = slot - 1;
          cups[cid].y = 0;
          cups[cid].z = 0;
          cups[cid].rotX = 0;
          cups[cid].rotZ = 0;
        }

        const curXA = xA + (xB - xA) * moveT;
        const curXB = xB + (xA - xB) * moveT;
        const depthAmp = 0.58 + (span - 1) * 0.25;
        const hopAmp = 0.22 + (span - 1) * 0.08;

        cups[cupA].x = curXA;
        cups[cupA].z = signZ * depthAmp * arcSin;
        cups[cupA].y = hopAmp * arcSin;
        cups[cupA].rotZ = -Math.sign(xB - xA) * 0.16 * arcSin;
        cups[cupA].rotX = signZ * 0.08 * arcSin;

        cups[cupB].x = curXB;
        cups[cupB].z = -signZ * depthAmp * arcSin;
        cups[cupB].y = hopAmp * arcSin;
        cups[cupB].rotZ = -Math.sign(xA - xB) * 0.16 * arcSin;
        cups[cupB].rotX = -signZ * 0.08 * arcSin;

        const ballCupId = cupAtSlot[ballSlot];
        ballX = cups[ballCupId].x;
        return { cups, ballX, ballY: 0, ballVisible: false, cameraZoom: 0.15 };
      }
    }

    for (let slot = 0; slot < 3; slot++) {
      const cid = cupAtSlot[slot];
      cups[cid].x = slot - 1;
      cups[cid].y = 0;
      cups[cid].z = 0;
      cups[cid].rotX = 0;
      cups[cid].rotZ = 0;
    }

    const winSlot = (machineChoice === 0 || machineChoice === 1 || machineChoice === 2)
      ? machineChoice
      : ballSlot;
    ballX = winSlot - 1;

    if (progress <= PHASE_PAUSE_END) {
      const pauseT = clamp01((progress - PHASE_SHUFFLE_END) / (PHASE_PAUSE_END - PHASE_SHUFFLE_END));
      cameraZoom = 0.15 + 0.35 * easeInOutCubic(pauseT);
      return { cups, ballX, ballY: 0, ballVisible: false, cameraZoom };
    }

    ballVisible = true;
    cameraZoom = 0.5 + 0.5 * clamp01((progress - PHASE_PAUSE_END) / (1 - PHASE_PAUSE_END));

    const winLiftT = clamp01((progress - PHASE_PAUSE_END) / (PHASE_LIFT_WIN_END - PHASE_PAUSE_END));
    const winEase = easeOutBack(winLiftT, 1.65);
    const winCupId = cupAtSlot[winSlot];

    cups[winCupId].y = winEase * 1.16;
    cups[winCupId].rotX = -winEase * 0.28;
    cups[winCupId].rotZ = (winSlot === 0 ? 1 : winSlot === 2 ? -1 : 0) * winEase * 0.08;

    const ballPopSin = Math.sin(winLiftT * Math.PI);
    ballY = Math.max(0, ballPopSin * 0.24);

    if (progress > PHASE_LIFT_WIN_END) {
      const othersT = clamp01((progress - PHASE_LIFT_WIN_END) / (1 - PHASE_LIFT_WIN_END));
      const othersEase = easeOutBack(othersT, 1.3);
      for (let slot = 0; slot < 3; slot++) {
        if (slot === winSlot) continue;
        const cid = cupAtSlot[slot];
        cups[cid].y = othersEase * 0.42;
        cups[cid].rotX = -othersEase * 0.1;
      }
    }

    return { cups, ballX, ballY, ballVisible, cameraZoom };
  }

  // ─── Helper DOM & icone SVG ──────────────────────────────────────────────────

  function createCupImg(i, cls) {
    const img = document.createElement('img');
    img.src = CUP_ASSET;
    img.alt = LABELS[i] ? `Bicchiere ${LABELS[i]}` : 'Bicchiere';
    img.className = cls;
    return img;
  }

  function isReducedMotionActive() {
    if (prefersReducedMotion) return true;
    return Boolean(
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  function isForce2DActive() {
    if (force2DMode) return true;
    return Boolean(typeof window !== 'undefined' && window.__CUP_GAME_FORCE_2D__);
  }

  function shouldUse2DFallback(container) {
    if (isForce2DActive() || isReducedMotionActive() || threeLoadFailed || contextLostInRound) {
      return true;
    }
    if (container) {
      if (
        typeof container.closest === 'function' &&
        container.closest('#host-q-text, .host-q-text, .host-question-text, .wb-host-question-box, .is-compact')
      ) {
        return true;
      }
      if (typeof container.getBoundingClientRect === 'function') {
        const rect = container.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          if (rect.width < MIN_3D_WIDTH_PX || rect.height < MIN_3D_HEIGHT_PX) {
            return true;
          }
        }
      }
    }
    return !canUseWebGL();
  }

  function canUseWebGL() {
    if (typeof document === 'undefined') return false;
    if (sharedRenderer) return true;
    try {
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl2') || probe.getContext('webgl');
      if (!gl) return false;
      return true;
    } catch {
      return false;
    }
  }

  // ─── Caricamento e risorse Three.js (§7.1, §7.2, §7.3, §7.6) ─────────────────

  function loadThree() {
    if (THREE) return Promise.resolve(THREE);
    if (threeLoadFailed) return Promise.resolve(null);
    if (!threePromise) {
      threePromise = import(THREE_URL)
        .then((mod) => {
          THREE = mod;
          return THREE;
        })
        .catch(() => {
          threeLoadFailed = true;
          return null;
        });
    }
    return threePromise;
  }

  function ensureSharedRenderer() {
    if (!THREE || typeof document === 'undefined') return null;
    if (sharedRenderer && sharedCanvas) return sharedRenderer;

    try {
      const canvas = document.createElement('canvas');
      canvas.className = 'mg-cup-game-canvas';
      canvas.setAttribute('aria-label', 'Scena 3D Tre Bicchieri');

      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        contextLostInRound = true;
      });
      canvas.addEventListener('webglcontextrestored', () => {
        contextLostInRound = false;
      });

      const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: false,
        powerPreference: 'high-performance',
      });
      renderer.setPixelRatio(1);
      if (THREE.SRGBColorSpace) {
        renderer.outputColorSpace = THREE.SRGBColorSpace;
      }

      sharedCanvas = canvas;
      sharedRenderer = renderer;
      webglContextsCreated += 1;
      return sharedRenderer;
    } catch {
      threeLoadFailed = true;
      return null;
    }
  }

  function ensureCached3DAssets() {
    if (cachedAssets3D || !THREE) return cachedAssets3D;

    const gradData = new Uint8Array([
      135, 135, 135, 255,
      215, 215, 215, 255,
      255, 255, 255, 255,
    ]);
    const gradientMap = new THREE.DataTexture(gradData, 3, 1, THREE.RGBAFormat);
    gradientMap.minFilter = THREE.NearestFilter;
    gradientMap.magFilter = THREE.NearestFilter;
    gradientMap.needsUpdate = true;

    const cupPoints = [
      new THREE.Vector2(0.76, 0.00),
      new THREE.Vector2(0.80, 0.05),
      new THREE.Vector2(0.78, 0.13),
      new THREE.Vector2(0.71, 0.16),
      new THREE.Vector2(0.68, 0.42),
      new THREE.Vector2(0.65, 0.45),
      new THREE.Vector2(0.61, 0.95),
      new THREE.Vector2(0.58, 0.99),
      new THREE.Vector2(0.53, 1.42),
      new THREE.Vector2(0.47, 1.56),
      new THREE.Vector2(0.32, 1.62),
      new THREE.Vector2(0.00, 1.62),
    ];
    const cupBodyGeo = new THREE.LatheGeometry(cupPoints, 28);

    const lipPoints = [
      new THREE.Vector2(0.74, 0.00),
      new THREE.Vector2(0.815, 0.04),
      new THREE.Vector2(0.815, 0.14),
      new THREE.Vector2(0.72, 0.16),
    ];
    const cupLipGeo = new THREE.LatheGeometry(lipPoints, 28);

    const bandPoints = [
      new THREE.Vector2(0.635, 0.68),
      new THREE.Vector2(0.615, 0.90),
    ];
    const cupBandGeo = new THREE.LatheGeometry(bandPoints, 28);

    const outlinePoints = [
      new THREE.Vector2(0.83, -0.02),
      new THREE.Vector2(0.86, 0.15),
      new THREE.Vector2(0.75, 0.45),
      new THREE.Vector2(0.65, 1.00),
      new THREE.Vector2(0.58, 1.58),
      new THREE.Vector2(0.36, 1.68),
      new THREE.Vector2(0.00, 1.68),
    ];
    const cupOutlineGeo = new THREE.LatheGeometry(outlinePoints, 28);

    const ballGeo = new THREE.SphereGeometry(0.38, 24, 18);
    const tableGeo = new THREE.BoxGeometry(7.4, 0.36, 3.3);
    const tableOutlineGeo = new THREE.BoxGeometry(7.58, 0.48, 3.48);
    const tableMatGeo = new THREE.PlaneGeometry(6.8, 2.7);
    const shadowBlobGeo = new THREE.CircleGeometry(0.84, 24);

    const matCupBody = new THREE.MeshToonMaterial({
      color: 0xe05a47,
      gradientMap,
    });
    const matCupLip = new THREE.MeshToonMaterial({
      color: 0xfff8f1,
      gradientMap,
    });
    const matCupBand = new THREE.MeshToonMaterial({
      color: 0xf7d708,
      gradientMap,
    });
    const matBall = new THREE.MeshToonMaterial({
      color: 0xf7d708,
      gradientMap,
    });
    const matTable = new THREE.MeshToonMaterial({
      color: 0xf2a65a,
      gradientMap,
    });
    const matTableTop = new THREE.MeshBasicMaterial({
      color: 0xfff8f1,
    });
    const matInkOutline = new THREE.MeshBasicMaterial({
      color: 0x201b0d,
      side: THREE.BackSide,
    });
    const matShadowBlob = new THREE.MeshBasicMaterial({
      color: 0x201b0d,
      transparent: true,
      opacity: 0.30,
      depthWrite: false,
    });

    cachedAssets3D = {
      cupBodyGeo,
      cupLipGeo,
      cupBandGeo,
      cupOutlineGeo,
      ballGeo,
      tableGeo,
      tableOutlineGeo,
      tableMatGeo,
      shadowBlobGeo,
      matCupBody,
      matCupLip,
      matCupBand,
      matBall,
      matTable,
      matTableTop,
      matInkOutline,
      matShadowBlob,
    };
    return cachedAssets3D;
  }

  function buildSceneGraph() {
    const assets = ensureCached3DAssets();
    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 40);
    camera.position.set(0, 3.95, 7.65);
    camera.lookAt(0, 0.55, 0);

    const hemiLight = new THREE.HemisphereLight(0xfff8f1, 0x4f4000, 1.15);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.35);
    dirLight.position.set(3.5, 7.5, 5.5);
    scene.add(dirLight);

    const tableGroup = new THREE.Group();
    const tableMesh = new THREE.Mesh(assets.tableGeo, assets.matTable);
    tableMesh.position.y = -0.18;
    const tableOutline = new THREE.Mesh(assets.tableOutlineGeo, assets.matInkOutline);
    tableOutline.position.y = -0.18;
    const tableMat = new THREE.Mesh(assets.tableMatGeo, assets.matTableTop);
    tableMat.rotation.x = -Math.PI / 2;
    tableMat.position.y = 0.005;
    tableGroup.add(tableMesh, tableOutline, tableMat);
    scene.add(tableGroup);

    const cupNodes = [];
    const cupShadows = [];
    for (let i = 0; i < 3; i++) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(assets.cupBodyGeo, assets.matCupBody);
      const lip = new THREE.Mesh(assets.cupLipGeo, assets.matCupLip);
      const band = new THREE.Mesh(assets.cupBandGeo, assets.matCupBand);
      const outline = new THREE.Mesh(assets.cupOutlineGeo, assets.matInkOutline);
      group.add(body, lip, band, outline);
      group.position.set(SLOT_X_3D[i], 0, 0);
      scene.add(group);
      cupNodes.push(group);

      const shadow = new THREE.Mesh(assets.shadowBlobGeo, assets.matShadowBlob);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.set(SLOT_X_3D[i], 0.015, 0);
      scene.add(shadow);
      cupShadows.push(shadow);
    }

    const ballGroup = new THREE.Group();
    const ballMesh = new THREE.Mesh(assets.ballGeo, assets.matBall);
    const ballOutline = new THREE.Mesh(assets.ballGeo, assets.matInkOutline);
    ballOutline.scale.setScalar(1.13);
    ballGroup.add(ballMesh, ballOutline);
    ballGroup.position.set(0, 0.38, 0);
    scene.add(ballGroup);

    const ballShadow = new THREE.Mesh(assets.shadowBlobGeo, assets.matShadowBlob);
    ballShadow.rotation.x = -Math.PI / 2;
    ballShadow.scale.setScalar(0.45);
    ballShadow.position.set(0, 0.016, 0);
    scene.add(ballShadow);

    return {
      scene,
      camera,
      cupNodes,
      cupShadows,
      ballGroup,
      ballShadow,
    };
  }

  function applyKinematicsTo3D(graph, state) {
    const { camera, cupNodes, cupShadows, ballGroup, ballShadow } = graph;
    const cupSpacing = 2.25;

    for (let i = 0; i < 3; i++) {
      const c = state.cups[i];
      const worldX = c.x * cupSpacing;
      const worldY = Math.max(0, c.y);
      const worldZ = c.z;

      cupNodes[i].position.set(worldX, worldY, worldZ);
      cupNodes[i].rotation.set(c.rotX, 0, c.rotZ);

      const shadowScale = Math.max(0.48, 1 - worldY * 0.24);
      cupShadows[i].position.set(worldX, 0.015, worldZ);
      cupShadows[i].scale.setScalar(shadowScale);
    }

    ballGroup.visible = Boolean(state.ballVisible);
    ballShadow.visible = Boolean(state.ballVisible);
    if (state.ballVisible) {
      const bx = state.ballX * cupSpacing;
      const by = 0.38 + Math.max(0, state.ballY);
      ballGroup.position.set(bx, by, 0);
      ballShadow.position.set(bx, 0.016, 0);
      ballShadow.scale.setScalar(Math.max(0.28, 0.46 - state.ballY * 0.25));
    }

    const zoom = state.cameraZoom || 0;
    camera.position.set(0, 3.95 - zoom * 0.25, 7.65 - zoom * 0.55);
    camera.lookAt(0, 0.55, 0);
  }

  function syncRendererSize(viewportEl, camera) {
    if (!sharedRenderer || !viewportEl) return;
    const rect = viewportEl.getBoundingClientRect();
    const w = Math.max(300, Math.floor(rect.width || 640));
    const h = Math.max(160, Math.floor(rect.height || 260));
    const renderW = Math.max(160, Math.floor(w * currentResScale));
    const renderH = Math.max(90, Math.floor(h * currentResScale));

    if (sharedCanvas.width !== renderW || sharedCanvas.height !== renderH) {
      sharedRenderer.setSize(renderW, renderH, false);
    }
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function recordFrameDelta(dtMs, viewportEl, camera) {
    if (dtMs <= 0 || dtMs > 250) return;
    avgFrameMs = avgFrameMs * 0.85 + dtMs * 0.15;
    if (avgFrameMs > FRAME_TIME_BUDGET_MS) {
      slowFrameStreak += 1;
      if (slowFrameStreak >= 12 && currentResScale > LOW_RES_SCALE) {
        currentResScale = LOW_RES_SCALE;
        syncRendererSize(viewportEl, camera);
      }
    } else {
      slowFrameStreak = 0;
    }
  }

  // ─── Costruzione e aggiornamento del Fallback 2D (§7.4) ──────────────────────

  function build2DStageDOM(viewportEl) {
    viewportEl.innerHTML = '';
    const root2d = document.createElement('div');
    root2d.className = 'mg-cup-game-2d';

    const table = document.createElement('div');
    table.className = 'mg-cup-game-2d-table';

    const ballWrap = document.createElement('div');
    ballWrap.className = 'mg-cup-game-2d-ball';
    const ballImg = document.createElement('img');
    ballImg.src = BALL_ASSET;
    ballImg.alt = 'Pallina';
    ballImg.className = 'mg-cup-game-2d-ball-img';
    ballWrap.appendChild(ballImg);

    const cupEls = [];
    const shadowEls = [];
    for (let i = 0; i < 3; i++) {
      const shadow = document.createElement('div');
      shadow.className = 'mg-cup-game-2d-shadow';
      root2d.appendChild(shadow);
      shadowEls.push(shadow);

      const cupWrap = document.createElement('div');
      cupWrap.className = 'mg-cup-game-2d-cup';
      const img = createCupImg(i, 'mg-cup-game-2d-cup-img');
      cupWrap.appendChild(img);
      root2d.appendChild(cupWrap);
      cupEls.push(cupWrap);
    }

    root2d.append(ballWrap, table);
    viewportEl.appendChild(root2d);

    return { root2d, cupEls, shadowEls, ballWrap };
  }

  function applyKinematicsTo2D(dom2d, state) {
    const { cupEls, shadowEls, ballWrap } = dom2d;
    const spreadPct = 128;

    for (let i = 0; i < 3; i++) {
      const c = state.cups[i];
      const txPct = c.x * spreadPct;
      const tyPct = -c.y * 36 - c.z * 8;
      const deg = (c.rotZ * 180) / Math.PI - (c.rotX * 35);
      const scale = 1 + c.z * 0.08;

      cupEls[i].style.transform =
        `translate3d(${txPct.toFixed(1)}%, ${tyPct.toFixed(1)}%, 0) rotate(${deg.toFixed(1)}deg) scale(${scale.toFixed(3)})`;
      cupEls[i].style.zIndex = c.z > 0.05 ? '4' : c.z < -0.05 ? '2' : '3';

      const sScale = Math.max(0.45, 1 - c.y * 0.25);
      shadowEls[i].style.transform =
        `translate3d(${txPct.toFixed(1)}%, 0, 0) scale(${sScale.toFixed(2)})`;
      shadowEls[i].style.opacity = String(Math.max(0.18, 0.42 - c.y * 0.14));
    }

    if (state.ballVisible) {
      const bxPct = state.ballX * spreadPct;
      const byPct = -state.ballY * 42;
      ballWrap.style.opacity = '1';
      ballWrap.style.transform = `translate3d(${bxPct.toFixed(1)}%, ${byPct.toFixed(1)}%, 0)`;
    } else {
      ballWrap.style.opacity = '0';
    }
  }

  // ─── Gestione e pulizia sessioni di scena (`stopSuspense`) ───────────────────

  function createOrResetSession(hostEl) {
    cleanupSessionForElement(hostEl);
    const session = {
      raf: null,
      timer: null,
      ro: null,
      uses3DCanvas: false,
    };
    if (hostEl) {
      activeSessions.set(hostEl, session);
    }
    return session;
  }

  function cleanupSessionForElement(hostEl) {
    if (!hostEl) return;
    const session = activeSessions.get(hostEl);
    if (!session) return;
    if (session.raf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(session.raf);
      session.raf = null;
    }
    if (session.timer !== null) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    if (session.ro) {
      session.ro.disconnect();
      session.ro = null;
    }
    if (session.uses3DCanvas && sharedCanvas && sharedCanvas.parentNode) {
      sharedCanvas.parentNode.removeChild(sharedCanvas);
      session.uses3DCanvas = false;
    }
    activeSessions.delete(hostEl);
  }

  function cleanupAllSessions() {
    for (const hostEl of Array.from(activeSessions.keys())) {
      cleanupSessionForElement(hostEl);
    }
    if (sharedCanvas && sharedCanvas.parentNode) {
      sharedCanvas.parentNode.removeChild(sharedCanvas);
    }
  }

  // ─── Costruzione pose di Suspense e di Reveal finale statico ─────────────────

  function computeSuspenseKinematics(elapsedMs) {
    const t = elapsedMs / 1000;
    const bounce = Math.abs(Math.sin(t * 4.2)) * 0.22;
    const sway0 = Math.sin(t * 2.4) * 0.035;
    const sway2 = Math.cos(t * 2.4) * 0.035;
    const centerFloat = 1.28 + Math.sin(t * 2.8) * 0.08;

    return {
      cups: [
        { x: -1, y: 0, z: 0, rotX: 0, rotZ: sway0 },
        { x: 0, y: centerFloat, z: 0, rotX: -0.30, rotZ: 0.08 },
        { x: 1, y: 0, z: 0, rotX: 0, rotZ: sway2 },
      ],
      ballX: 0,
      ballY: bounce,
      ballVisible: true,
      cameraZoom: 0,
    };
  }

  function computeStaticFinalKinematics(machineChoice) {
    const winSlot = (machineChoice === 0 || machineChoice === 1 || machineChoice === 2)
      ? machineChoice
      : 1;
    const cups = [
      { x: -1, y: 0.35, z: 0, rotX: -0.08, rotZ: 0 },
      { x: 0, y: 0.35, z: 0, rotX: -0.08, rotZ: 0 },
      { x: 1, y: 0.35, z: 0, rotX: -0.08, rotZ: 0 },
    ];
    cups[winSlot].y = 1.16;
    cups[winSlot].rotX = -0.28;
    cups[winSlot].rotZ = winSlot === 0 ? 0.08 : winSlot === 2 ? -0.08 : 0;

    return {
      cups,
      ballX: winSlot - 1,
      ballY: 0,
      ballVisible: true,
      cameraZoom: 1,
    };
  }

  // ─── Montaggio della scena (3D con fallback automatico a 2D) ─────────────────

  function mountStageAdapter(viewportEl, session, onReadyReRender) {
    let dom2d = build2DStageDOM(viewportEl);
    let graph3d = null;
    let using3D = false;

    const tryUpgradeTo3D = () => {
      if (shouldUse2DFallback(viewportEl) || !THREE) return false;
      const renderer = ensureSharedRenderer();
      if (!renderer || !sharedCanvas) return false;

      // Se un altro contenitore stava usando il canvas condiviso, lo stacca.
      for (const [, otherSession] of activeSessions.entries()) {
        if (otherSession !== session && otherSession.uses3DCanvas) {
          otherSession.uses3DCanvas = false;
        }
      }

      graph3d = buildSceneGraph();
      viewportEl.innerHTML = '';
      viewportEl.appendChild(sharedCanvas);
      session.uses3DCanvas = true;
      syncRendererSize(viewportEl, graph3d.camera);

      if (typeof ResizeObserver !== 'undefined') {
        if (session.ro) session.ro.disconnect();
        session.ro = new ResizeObserver(() => {
          if (using3D && graph3d) {
            syncRendererSize(viewportEl, graph3d.camera);
            if (onReadyReRender) onReadyReRender();
          }
        });
        session.ro.observe(viewportEl);
      }

      using3D = true;
      lastStageMode = '3d';
      return true;
    };

    if (!shouldUse2DFallback(viewportEl)) {
      if (THREE) {
        tryUpgradeTo3D();
      } else {
        loadThree().then((loaded) => {
          if (!loaded || !viewportEl.isConnected) return;
          if (tryUpgradeTo3D() && onReadyReRender) {
            onReadyReRender();
          }
        });
      }
    }

    return {
      paintPose(kinematics, dtMs = 16.6) {
        if (using3D && (!session.uses3DCanvas || contextLostInRound || shouldUse2DFallback(viewportEl))) {
          using3D = false;
          session.uses3DCanvas = false;
          lastStageMode = '2d';
          dom2d = build2DStageDOM(viewportEl);
        }
        if (using3D && graph3d && sharedRenderer) {
          lastStageMode = '3d';
          recordFrameDelta(dtMs, viewportEl, graph3d.camera);
          applyKinematicsTo3D(graph3d, kinematics);
          sharedRenderer.render(graph3d.scene, graph3d.camera);
        } else {
          if (!dom2d || !dom2d.root2d.isConnected) {
            dom2d = build2DStageDOM(viewportEl);
          }
          applyKinematicsTo2D(dom2d, kinematics);
        }
      },
    };
  }

  // ─── Contratto esportato al registry `Minigames` (§6.2) ──────────────────────

  return {
    type: 'cup_game',
    label: 'Tre Bicchieri',

    hostStatusText: '🥤 Minigioco: Tre Bicchieri in corso…',
    playerBadge: '🥤 Tre Bicchieri!',
    playerLayoutClass: 'mg-cup-game-choices',

    /**
     * Restituisce un `<img>` nuovo di `cup.svg` a ogni chiamata (§6.2).
     * @param {number} i indice dell'opzione (0, 1, 2)
     * @returns {HTMLImageElement}
     */
    optionIcon(i) {
      return createCupImg(i, 'mg-cup-game-icon');
    },

    /**
     * Evidenzia nella distribuzione la posizione finale della pallina.
     * @param {object} results
     * @returns {number}
     */
    highlightIndex(results) {
      return results.machineChoice;
    },

    generateSwapSequence,
    computeRevealKinematics,

    /**
     * Consente al banco di prova di forzare/ripristinare il fallback 2D (§7.4, §12.6).
     * @param {boolean} enabled
     */
    setForce2D(enabled) {
      force2DMode = Boolean(enabled);
    },

    /**
     * Diagnostica per il banco di prova (Scenario 7: verifica 1 solo canvas e
     * 1 solo contesto WebGL su 30 round consecutivi).
     */
    getDiagnostics() {
      const domCanvases = typeof document !== 'undefined'
        ? document.querySelectorAll('.mg-cup-game-canvas').length
        : 0;
      const f2d = isForce2DActive();
      return {
        threeLoaded: Boolean(THREE),
        rendererActive: Boolean(sharedRenderer),
        webglContextsCreated,
        activeCanvasCount: domCanvases,
        hasSharedRenderer: Boolean(sharedRenderer),
        lastStageMode,
        lastMode: lastStageMode,
        force2D: f2d,
        force2DMode: f2d,
        resolutionScale: currentResScale,
        avgFrameMs: Math.round(avgFrameMs * 10) / 10,
      };
    },

    sala: {
      /**
       * Fase di scelta (8 s): tavolo con tre bicchieri in fila, bicchiere
       * centrale sollevato e inclinato con la pallina che rimbalza sotto,
       * prompt in overlay DOM e avvio del caricamento di Three.js (§0.1).
       *
       * L'anteprima da seguire, PRIMA che si possa rispondere: la pallina si
       * vede sotto il bicchiere centrale, il bicchiere la copre, gli scambi
       * la portano su `round.preview.machineChoice` e si fermano poco prima
       * di `ctx.answersOpenAt`. Durante la scelta i bicchieri restano fermi.
       *
       * `round.preview` arriva solo a sala e host (il server non lo manda ai
       * telefoni). Senza, i bicchieri restano coperti e fermi: meglio una
       * scena muta che uno spettacolo che finisce nel posto sbagliato.
       *
       * @param {{ questionText: HTMLElement, correctAnswer?: HTMLElement }} els
       * @param {object} round payload `game:question`
       * @param {{ answersOpenAt: number, isStale: () => boolean }} [ctx]
       */
      startSuspense(els, round, ctx) {
        const session = createOrResetSession(els.questionText);
        contextLostInRound = false;
        loadThree();

        const machineChoice = Number.isInteger(round?.preview?.machineChoice)
          ? round.preview.machineChoice
          : null;
        const startAt = Date.now();
        const answersOpenAt = Number.isFinite(ctx?.answersOpenAt) ? ctx.answersOpenAt : startAt;
        const isStale = typeof ctx?.isStale === 'function' ? ctx.isStale : () => false;

        els.questionText.innerHTML = '';
        const stage = document.createElement('div');
        stage.className = 'mg-cup-game-stage is-suspense';

        const promptEl = document.createElement('p');
        promptEl.className = 'mg-cup-game-prompt';
        const choicePrompt = (round && round.text) ? round.text : 'Dov\'è la pallina?';

        const viewport = document.createElement('div');
        viewport.className = 'mg-cup-game-viewport';

        stage.append(promptEl, viewport);
        els.questionText.appendChild(stage);

        // Senza esito noto (o con l'anteprima già passata, es. una sala che si
        // ricollega a metà scelta) non c'è nulla da seguire: bicchieri coperti.
        const coveredPose = computeRevealKinematics(0, [], machineChoice ?? 1, LIFT_PHASES);
        const shuffleStart = startAt + SHOW_MS;
        const shuffleEnd = answersOpenAt - SETTLE_MS;
        const hasShow = machineChoice !== null && shuffleEnd - shuffleStart > 1000;

        promptEl.textContent = hasShow ? 'Segui la pallina!' : choicePrompt;
        let currentPose = hasShow ? computeSuspenseKinematics(0) : coveredPose;

        const adapter = mountStageAdapter(viewport, session, () => {
          adapter.paintPose(currentPose, 16.6);
        });
        adapter.paintPose(currentPose, 16.6);
        if (!hasShow) return;

        const settle = () => {
          currentPose = coveredPose;
          adapter.paintPose(currentPose, 16.6);
          promptEl.textContent = choicePrompt;
          stage.classList.add('is-choosing');
        };

        if (isReducedMotionActive()) {
          // Niente scambi: la pallina resta visibile dove finirà, poi si copre.
          // Chi non può guardare il movimento deve comunque poter giocare.
          currentPose = computeStaticFinalKinematics(machineChoice);
          adapter.paintPose(currentPose, 16.6);
          session.timer = setTimeout(() => {
            session.timer = null;
            if (!isStale()) settle();
          }, Math.max(0, shuffleEnd - Date.now()));
          return;
        }

        const swaps = generateSwapSequence(1, machineChoice, SWAP_COUNT);
        const shuffleMs = shuffleEnd - shuffleStart;
        let lastFrameAt = startAt;

        const tick = () => {
          if (!activeSessions.has(els.questionText) || isStale()) return;
          const now = Date.now();
          const dt = now - lastFrameAt;
          lastFrameAt = now;

          if (now >= shuffleEnd) {
            // Bicchieri fermi: il loop si spegne, la scelta dura secondi.
            session.raf = null;
            settle();
            return;
          }

          currentPose = now < shuffleStart
            ? computeSuspenseKinematics(now - startAt)
            : computeRevealKinematics((now - shuffleStart) / shuffleMs, swaps, machineChoice, PREVIEW_PHASES);
          adapter.paintPose(currentPose, dt);
          session.raf = requestAnimationFrame(tick);
        };
        tick();
      },

      /**
       * Unico hook di pulizia: cancella rAF, timer e `ResizeObserver` e stacca
       * il canvas dal DOM mantenendo però in vita `sharedRenderer` (§6.2, §7.3).
       * Idempotente: può essere chiamato più volte di fila senza effetti collaterali.
       */
      stopSuspense() {
        cleanupAllSessions();
      },

      /**
       * Spettacolo di reveal sincronizzato con `ctx.revealAt` (§0.2, §6.5).
       *
       * @param {{ questionText: HTMLElement, correctAnswer?: HTMLElement }} els
       * @param {object} results payload `game:results`
       * @param {string[]} options etichette delle opzioni
       * @param {{ revealAt: number, isStale: () => boolean, done: () => void }} ctx
       */
      playReveal(els, results, options, ctx) {
        const session = createOrResetSession(els.questionText);
        loadThree();

        const machineChoice = (results && Number.isInteger(results.machineChoice))
          ? results.machineChoice
          : 1;
        const labels = Array.isArray(options) && options.length >= 3 ? options : LABELS;

        els.questionText.innerHTML = '';
        const stage = document.createElement('div');
        stage.className = 'mg-cup-game-stage is-revealing';

        const viewport = document.createElement('div');
        viewport.className = 'mg-cup-game-viewport';

        const verdict = document.createElement('p');
        verdict.className = 'mg-cup-game-verdict';

        stage.append(viewport, verdict);
        els.questionText.appendChild(stage);

        // Il mescolamento è già avvenuto nell'anteprima: qui i bicchieri sono
        // fermi nell'ordine finale e resta solo l'alzata (`LIFT_PHASES`).
        const swaps = [];
        const startAt = Date.now();
        const landAt = Math.max(startAt, ctx.revealAt - HOLD_MS);
        const activeMs = Math.max(1, landAt - startAt);

        let lastFrameAt = startAt;
        let landed = false;
        let doneCalled = false;
        let currentPose = computeRevealKinematics(0, swaps, machineChoice, LIFT_PHASES);

        const adapter = mountStageAdapter(viewport, session, () => {
          adapter.paintPose(currentPose, 16.6);
        });

        const triggerLand = () => {
          if (landed) return;
          landed = true;
          currentPose = computeStaticFinalKinematics(machineChoice);
          adapter.paintPose(currentPose, 16.6);

          stage.classList.add('is-landed');
          verdict.innerHTML = '';
          const kicker = document.createElement('span');
          kicker.className = 'mg-cup-game-verdict-kicker';
          kicker.textContent = 'La pallina è a';
          const strong = document.createElement('strong');
          strong.textContent = (labels[machineChoice] ?? LABELS[machineChoice] ?? '—').toUpperCase();
          verdict.append(kicker, strong);

          if (typeof window !== 'undefined' && window.Confetti) {
            window.Confetti.burst({ count: 140, power: 19 });
          }
        };

        const finishReveal = () => {
          if (doneCalled) return;
          if (ctx.isStale()) {
            cleanupSessionForElement(els.questionText);
            return;
          }
          doneCalled = true;
          session.raf = null;
          session.timer = null;
          ctx.done();
        };

        if (isReducedMotionActive()) {
          triggerLand();
          const waitMs = Math.max(0, ctx.revealAt - Date.now());
          session.timer = setTimeout(finishReveal, waitMs);
          return;
        }

        const frame = () => {
          if (!activeSessions.has(els.questionText) || ctx.isStale()) {
            cleanupSessionForElement(els.questionText);
            return;
          }
          const now = Date.now();
          const dt = now - lastFrameAt;
          lastFrameAt = now;

          if (!landed && now >= landAt) {
            triggerLand();
          }

          if (landed) {
            if (now >= ctx.revealAt) {
              finishReveal();
              return;
            }
            session.raf = requestAnimationFrame(frame);
            return;
          }

          const u = clamp01((now - startAt) / activeMs);
          currentPose = computeRevealKinematics(u, swaps, machineChoice, LIFT_PHASES);
          adapter.paintPose(currentPose, dt);
          session.raf = requestAnimationFrame(frame);
        };

        frame();
      },

      /**
       * Fotogramma finale statico (§0.3, §6.3): disegna un solo frame e ferma il loop.
       *
       * @param {{ questionText: HTMLElement, correctAnswer: HTMLElement }} els
       * @param {object} results payload `game:results`
       * @param {string[]} options etichette del round
       */
      reveal(els, results, options) {
        const session = createOrResetSession(els.questionText);
        loadThree();

        const machineChoice = (results && Number.isInteger(results.machineChoice))
          ? results.machineChoice
          : 1;
        const labels = Array.isArray(options) && options.length >= 3 ? options : LABELS;
        const chosenLabel = labels[machineChoice] ?? LABELS[machineChoice] ?? '—';

        els.questionText.innerHTML = '';
        const stage = document.createElement('div');
        stage.className = 'mg-cup-game-stage is-landed';

        const viewport = document.createElement('div');
        viewport.className = 'mg-cup-game-viewport';
        stage.appendChild(viewport);
        els.questionText.appendChild(stage);

        const finalPose = computeStaticFinalKinematics(machineChoice);
        const adapter = mountStageAdapter(viewport, session, () => {
          adapter.paintPose(finalPose, 16.6);
        });
        adapter.paintPose(finalPose, 16.6);

        if (els.correctAnswer) {
          els.correctAnswer.innerHTML = '';
          els.correctAnswer.append(
            document.createTextNode('La pallina era sotto: '),
            createCupImg(machineChoice, 'mg-cup-game-icon mg-cup-game-icon-inline'),
            document.createTextNode(` ${chosenLabel}`)
          );
        }
      },
    },

    player: {
      /**
       * Riempie il bottone di scelta sul telefono (§0, §6.2, §10).
       */
      renderChoice(btn, i, option) {
        const labelText = option || LABELS[i] || String(i + 1);
        btn.className = 'answer-btn mg-cup-game-choice';
        btn.setAttribute('aria-label', labelText);
        btn.innerHTML = '';

        const img = createCupImg(i, 'mg-cup-game-icon mg-cup-game-icon-choice');
        const span = document.createElement('span');
        span.className = 'mg-cup-game-choice-label';
        span.textContent = labelText;

        btn.append(img, span);
      },

      /**
       * Attesa sincronizzata sul telefono fino a `ctx.revealAt` (§0, §6.5).
       */
      playReveal(els, mine, results, ctx) {
        if (playerTimeout !== null) {
          clearTimeout(playerTimeout);
          playerTimeout = null;
        }

        els.text.textContent = 'Guarda lo schermo!';
        els.points.innerHTML = '';

        const wrap = document.createElement('span');
        wrap.className = 'mg-cup-game-player-await';

        if (mine && Number.isInteger(mine.optionIndex)) {
          const pickedLabel = LABELS[mine.optionIndex] ?? '—';
          wrap.append(
            createCupImg(mine.optionIndex, 'mg-cup-game-icon mg-cup-game-icon-await'),
            document.createTextNode(` Hai scelto: ${pickedLabel}`)
          );
        } else {
          wrap.textContent = 'Non hai risposto in tempo — guarda lo schermo!';
        }

        els.points.appendChild(wrap);

        const waitMs = Math.max(0, ctx.revealAt - Date.now());
        playerTimeout = setTimeout(() => {
          playerTimeout = null;
          if (ctx.isStale()) return;
          ctx.done();
        }, waitMs);
      },

      /**
       * Esito personale sul telefono a `revealAt` (§0, §6.3).
       */
      reveal(els, mine, results) {
        const machineIdx = (results && Number.isInteger(results.machineChoice))
          ? results.machineChoice
          : 1;
        const machineLabel = LABELS[machineIdx] ?? '—';

        if (!mine) {
          els.sticker.classList.add('is-neutral');
          els.text.textContent = 'Tempo scaduto!';
          els.points.textContent = `La pallina era a ${machineLabel} · +0 punti`;
          return;
        }

        if (mine.outcome === 'win') {
          els.sticker.classList.add('is-correct');
          els.text.textContent = 'HAI VINTO!';
          if (typeof window !== 'undefined' && window.Confetti) {
            window.Confetti.burst({ count: 70, power: 14 });
          }
          els.points.textContent = `+${mine.pointsAwarded ?? 600} punti`;
          return;
        }

        els.sticker.classList.add('is-wrong');
        els.text.textContent = 'HAI PERSO';
        els.points.textContent = `La pallina era a ${machineLabel} · +${mine.pointsAwarded ?? 0} punti`;
      },
    },
  };
});
