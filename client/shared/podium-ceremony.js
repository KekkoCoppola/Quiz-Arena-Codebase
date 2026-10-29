'use strict';

/**
 * client/shared/podium-ceremony.js
 *
 * Modulo 3D indipendente per la Premiazione Finale ("Wii / Mii Podium Ceremony")
 * sul Maxischermo Sala di Quiz-Zata! Solo la sala lo carica: il telefono
 * aspetta `game:ceremony-done` e non scarica three.js.
 *
 * Non è un minigioco e non sta in client/shared/minigames/, come stage-intro.js.
 * La DURATA la detta client/shared/final-schedule.js, che il server legge per
 * liberare i telefoni: la sala passa `durationMs: FinalSchedule.DURATION_MS`, e
 * tools/test-final.js verifica che i due calendari coincidano.
 *
 * Opzioni di `play(stageEl, options)` aggiunte per la sala:
 *   - `onCue(nome)`  i momenti sonori passano all'audio della sala invece che
 *                    al sintetizzatore interno (che resta per l'uso da solo)
 *   - `onError(err)` three.js o WebGL non disponibili: la sala ripiega sul podio 2D
 *   - lo stage riempie il contenitore e segue il ridimensionamento
 *
 * Utilizza il modulo autonomo `MiiCharacter3D` (`client/shared/mii-character.js`)
 * per generare i personaggi 3D low-poly dei giocatori:
 *   - 3°, 2° e 1° classificato entrano in sequenza teatrale sul podio a 3 gradini
 *   - Sopra la testa dei premiati compare la Targhetta con SOLO IL NOME (zero punti!)
 *   - Al 1° classificato appare tra le mani sferiche la Coppa d'Oro 3D con coriandoli
 *   - Tutti i restanti classificati (dal 4° posto in giù) formano un semicerchio
 *     attorno e davanti al palco che salta e applaude a ritmo.
 *
 * Sicuro da caricare in Node.js con `require()` per i test unitari.
 */

(function (root, factory) {
  let miiModule = root && root.MiiCharacter3D ? root.MiiCharacter3D : null;
  if (!miiModule && typeof require === 'function') {
    try {
      miiModule = require('./mii-character.js');
    } catch (_) {
      miiModule = null;
    }
  }
  const api = factory(miiModule);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.PodiumCeremony = api;
  }
})(typeof self !== 'undefined' ? self : this, function (injectedMiiModule) {
  const THREE_URL = '/shared/vendor/three/three.module.min.js';

  function getMiiModule() {
    if (injectedMiiModule) return injectedMiiModule;
    if (typeof window !== 'undefined' && window.MiiCharacter3D) {
      return window.MiiCharacter3D;
    }
    throw new Error('MiiCharacter3D non caricato. Includere /shared/mii-character.js prima di podium-ceremony.js.');
  }

  /** Durata predefinita della cerimonia completa prima del loop celebrativo (14.5s). */
  const DEFAULT_DURATION_MS = 14500;

  /** Coordinate geometriche del Podio Olimpico 3D sul mini-palco. */
  const PODIUM_STEPS = Object.freeze({
    first: Object.freeze({
      rank: 1,
      x: 0.0,
      z: -0.55,
      height: 0.98,
      width: 1.65,
      depth: 1.45,
      color: '#f7d708',
      trimColor: '#4f4000',
      label: '1°',
    }),
    second: Object.freeze({
      rank: 2,
      x: -1.85,
      z: -0.35,
      height: 0.72,
      width: 1.52,
      depth: 1.35,
      color: '#90efef',
      trimColor: '#006a6a',
      label: '2°',
    }),
    third: Object.freeze({
      rank: 3,
      x: 1.85,
      z: -0.35,
      height: 0.50,
      width: 1.52,
      depth: 1.35,
      color: '#f2a65a',
      trimColor: '#4f4000',
      label: '3°',
    }),
    stageDeckY: 0.22,
  });

  /** Timeline normalizzata (u in [0, 1]) dei 5 Atti della Premiazione 3D. */
  const TIMELINE = Object.freeze({
    act1End: 0.16, // 0.00 - 0.16 (0.0s - 2.3s): Panoramica palco + folla semicircolare in festa
    thirdLandAt: 0.25, // Il 3° atterra sul gradino di destra
    act2End: 0.38, // 0.16 - 0.38 (2.3s - 5.5s): Ingresso + targhetta nome 3° classificato
    secondLandAt: 0.47, // Il 2° atterra sul gradino di sinistra
    act3End: 0.60, // 0.38 - 0.60 (5.5s - 8.7s): Ingresso + targhetta nome 2° classificato
    firstJumpStartAt: 0.66, // Fine rullo di tamburi, salto del 1° classificato
    firstLandAt: 0.73, // Il 1° atterra in vetta al podio centrale
    trophyPopAt: 0.76, // La Coppa d'Oro 3D si materializza tra le mani del 1°
    act4End: 0.86, // 0.60 - 0.86 (8.7s - 12.5s): Suspense, 1° posto, Targhetta Nome e Coppa d'Oro
    act5End: 1.00, // 0.86 - 1.00 (12.5s - 14.5s+): Gran Finale con vista d'insieme e coriandoli
  });

  const ACTS_META = Object.freeze([
    Object.freeze({
      act: 1,
      id: 'crowd_intro',
      label: '1. Palco & Folla in Festa',
      shortLabel: '1. Palco & Folla',
      startU: 0.0,
      endU: TIMELINE.act1End,
      color: '#90efef',
      description:
        'Carrellata sul mini-palco 3D mentre i restanti classificati disposti a semicerchio saltano e applaudono.',
    }),
    Object.freeze({
      act: 2,
      id: 'enter_3rd',
      label: '2. Ingresso 3° Classificato',
      shortLabel: '2. Ingresso 3°',
      startU: TIMELINE.act1End,
      endU: TIMELINE.act2End,
      color: '#f2a65a',
      description:
        'Il 3° classificato entra a balzi sul gradino di destra, saluta il pubblico e appare la targhetta col solo nome.',
    }),
    Object.freeze({
      act: 3,
      id: 'enter_2nd',
      label: '3. Ingresso 2° Classificato',
      shortLabel: '3. Ingresso 2°',
      startU: TIMELINE.act2End,
      endU: TIMELINE.act3End,
      color: '#c8f7c5',
      description:
        'Il 2° classificato compie un salto acrobatico sul gradino di sinistra ed espone la targhetta col solo nome.',
    }),
    Object.freeze({
      act: 4,
      id: 'enter_1st_trophy',
      label: '4. 1° Posto & Coppa d’Oro 3D',
      shortLabel: '4. 1° + Coppa 3D',
      startU: TIMELINE.act3End,
      endU: TIMELINE.act4End,
      color: '#f7d708',
      description:
        'Rullo di tamburi, balzo trionfale del 1° classificato, targhetta col solo nome e Coppa d’Oro 3D tra le mani!',
    }),
    Object.freeze({
      act: 5,
      id: 'grand_finale',
      label: '5. Gran Finale & Celebrazione',
      shortLabel: '5. Gran Finale',
      startU: TIMELINE.act4End,
      endU: TIMELINE.act5End,
      color: '#ab3425',
      description:
        'Inquadratura panoramica su 1°, 2° e 3° con la Coppa sollevata, pioggia di coriandoli e applauso di tutta la sala.',
    }),
  ]);

  /** Lista giocatori demo predefinita (usata se non vengono passati giocatori). */
  const DEFAULT_PLAYERS = Object.freeze([
    Object.freeze({ id: 'p1', name: 'Marco', rank: 1, skinColor: '#f26b5e', expression: 'angry', avatar: '/resources/img/cup-game/cup.svg', color: '#f26b5e' }),
    Object.freeze({ id: 'p2', name: 'Giulia', rank: 2, skinColor: '#5ce1e6', expression: 'happy', avatar: '🦊', color: '#5ce1e6' }),
    Object.freeze({ id: 'p3', name: 'Lorenzo', rank: 3, skinColor: '#f7d708', expression: 'cool', avatar: 'LR', color: '#f7d708' }),
    Object.freeze({ id: 'p4', name: 'Sofia', rank: 4, skinColor: '#7ed957', expression: 'surprised', avatar: '/resources/img/morra-cinese/forbice.svg', color: '#7ed957' }),
    Object.freeze({ id: 'p5', name: 'Alessandro', rank: 5, skinColor: '#9b72cf', expression: 'wink', avatar: '🍕', color: '#9b72cf' }),
    Object.freeze({ id: 'p6', name: 'Chiara', rank: 6, skinColor: '#ff914d', expression: 'fierce', avatar: 'CH', color: '#ff914d' }),
    Object.freeze({ id: 'p7', name: 'Matteo', rank: 7, skinColor: '#ffb58a', expression: 'happy', avatar: '🚀', color: '#ffb58a' }),
    Object.freeze({ id: 'p8', name: 'Elena', rank: 8, skinColor: '#ff66b3', expression: 'angry', avatar: '/resources/img/morra-cinese/carta.svg', color: '#ff66b3' }),
    Object.freeze({ id: 'p9', name: 'Davide', rank: 9, skinColor: '#f26b5e', expression: 'cool', avatar: 'DV', color: '#f26b5e' }),
    Object.freeze({ id: 'p10', name: 'Alice', rank: 10, skinColor: '#5ce1e6', expression: 'surprised', avatar: '⚡', color: '#5ce1e6' }),
    Object.freeze({ id: 'p11', name: 'Federico', rank: 11, skinColor: '#f7d708', expression: 'wink', avatar: '/resources/img/morra-cinese/sasso.svg', color: '#f7d708' }),
    Object.freeze({ id: 'p12', name: 'Martina', rank: 12, skinColor: '#7ed957', expression: 'fierce', avatar: '🎮', color: '#7ed957' }),
    Object.freeze({ id: 'p13', name: 'Simone', rank: 13, skinColor: '#9b72cf', expression: 'happy', avatar: 'SM', color: '#9b72cf' }),
    Object.freeze({ id: 'p14', name: 'Beatrice', rank: 14, skinColor: '#ff914d', expression: 'angry', avatar: '🦄', color: '#ff914d' }),
  ]);

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function lerp(a, b, t) {
    return a + (b - a) * clamp(t, 0, 1);
  }

  function easeOutCubic(t) {
    const x = clamp(t, 0, 1);
    return 1 - Math.pow(1 - x, 3);
  }

  function easeInOutCubic(t) {
    const x = clamp(t, 0, 1);
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }

  function easeOutBack(t) {
    const x = clamp(t, 0, 1);
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  }

  /**
   * Calcola la disposizione spaziale del podio (1°, 2°, 3°) e la distribuzione
   * a semicerchio attorno e davanti al palco per tutti i restanti classificati (4°+).
   *
   * I giocatori del pubblico sono disposti su archi concentrici ai lati e davanti
   * al palco, lasciando un corridoio visivo centrale libero per la telecamera e
   * ruotando ogni Mii affinché guardi direttamente verso il centro del podio.
   *
   * @param {Array<object>} [rawPlayers]
   */
  function computeCrowdLayout(rawPlayers) {
    const Mii = getMiiModule();
    const list =
      Array.isArray(rawPlayers) && rawPlayers.length > 0 ? rawPlayers : DEFAULT_PLAYERS;

    const normalized = list.map((p, idx) => Mii.normalizeMiiConfig(p, idx));
    const sorted = [...normalized].sort((a, b) => a.rank - b.rank);

    const first = sorted[0] ? { ...sorted[0], rank: 1 } : null;
    const second = sorted[1] ? { ...sorted[1], rank: 2 } : null;
    const third = sorted[2] ? { ...sorted[2], rank: 3 } : null;
    const rest = sorted.slice(3);

    // Distribuiamo i restanti classificati su anelli semicircolari attorno al palco
    // (raggio base 4.55m, incremento 1.15m per fila), divisi in ala sinistra e ala destra/frontale
    // con un piccolo varco centrale di ±14° così nessuno copre i gradini del podio alla vista.
    const crowdPlacements = [];
    const perRowBase = 10;

    rest.forEach((player, i) => {
      const row = Math.floor(i / perRowBase);
      const indexInRow = i % perRowBase;
      const countInThisRow = Math.min(perRowBase, rest.length - row * perRowBase);

      // Dividiamo la fila in lato sinistro (angoli negativi) e lato destro (angoli positivi)
      const isLeftWing = indexInRow % 2 === 0;
      const wingIndex = Math.floor(indexInRow / 2);
      const wingTotal = Math.max(1, Math.ceil(countInThisRow / 2));

      // Angolo rispetto all'asse +Z (frontale alla camera):
      // da 0.24 rad (~14°) fino a 1.38 rad (~79°) per avvolgere il davanti e i fianchi del palco
      const tWing = wingTotal === 1 ? 0.45 : wingIndex / (wingTotal - 1);
      const angleMag = lerp(0.24, 1.36, tWing) + (row % 2) * 0.06;
      const angle = isLeftWing ? -angleMag : angleMag;

      const radius = 4.55 + row * 1.18 + (indexInRow % 3) * 0.08;
      const x = Math.sin(angle) * radius;
      const z = Math.cos(angle) * radius - 0.25;
      const y = 0;

      // Orientiamo il Mii del pubblico affinché guardi verso il centro del podio (0, 0, -0.45)
      const dx = 0 - x;
      const dz = -0.45 - z;
      const lookYaw = Math.atan2(dx, dz);

      crowdPlacements.push(
        Object.freeze({
          player,
          crowdIndex: i,
          row,
          angleRad: angle,
          radius,
          x: Number(x.toFixed(3)),
          y,
          z: Number(z.toFixed(3)),
          rotY: Number(lookYaw.toFixed(3)),
        })
      );
    });

    return Object.freeze({
      podium: Object.freeze({
        first,
        second,
        third,
      }),
      crowd: Object.freeze(crowdPlacements),
      totalPlayers: sorted.length,
    });
  }

  /**
   * Calcola lo stato completo e deterministico della Cerimonia di Premiazione 3D
   * al progresso normalizzato `u` in `[0, 1]`.
   * Se `options.elapsedSec` viene fornito (es. durante l'idle infinito del Gran Finale
   * quando `u = 1`), le animazioni cicliche (personaggi, coppa, faretti, coriandoli,
   * respiro camera) proseguono all'infinito senza mai fermarsi.
   *
   * @param {number} u Valore in [0, 1]
   * @param {{ durationMs?: number, elapsedSec?: number }} [options]
   */
  function computeCeremonyStateAt(u, options = {}) {
    const progress = clamp(Number(u) || 0, 0, 1);
    const durationMs = Math.max(1000, Number(options.durationMs) || DEFAULT_DURATION_MS);
    const timelineSec = (progress * durationMs) / 1000;
    const elapsedSec =
      typeof options.elapsedSec === 'number' && Number.isFinite(options.elapsedSec)
        ? Math.max(0, options.elapsedSec)
        : timelineSec;
    const isFinaleIdle = progress >= 0.999 && elapsedSec > timelineSec + 0.01;
    const finaleIdleSec = Math.max(0, elapsedSec - durationMs / 1000);

    const deckY = PODIUM_STEPS.stageDeckY;
    const top1Y = deckY + PODIUM_STEPS.first.height;
    const top2Y = deckY + PODIUM_STEPS.second.height;
    const top3Y = deckY + PODIUM_STEPS.third.height;

    // Determiniamo l'Atto attivo (1..5)
    let act = 5;
    if (progress < TIMELINE.act1End) act = 1;
    else if (progress < TIMELINE.act2End) act = 2;
    else if (progress < TIMELINE.act3End) act = 3;
    else if (progress < TIMELINE.act4End) act = 4;

    function smootherstep(x) {
      const c = clamp(x, 0, 1);
      return c * c * c * (c * (c * 6 - 15) + 10);
    }

    function smoothBell(x, center, halfWidth) {
      if (!(halfWidth > 0)) return 0;
      const d = Math.abs(x - center) / halfWidth;
      if (d >= 1) return 0;
      return 0.5 * (1 + Math.cos(d * Math.PI));
    }

    /**
     * Calcola una traiettoria di salto sul podio 100% continua e ininterrotta (C2-smooth,
     * zero rami `if/else`, zero soste statiche sul posto):
     *   - Progressione orizzontale morbida continua dall'ala del palco attraverso lo
     *     staging fino alla vetta del gradino (senza mai bloccarsi a metà!)
     *   - Doppio arco verticale armonico (`hopArc` + `leapArc`) con hang-time naturale
     */
    function computeFluidPodiumJumpTrajectory(uJump, cfg) {
      const uJ = clamp(uJump, 0, 1);
      const {
        startX,
        startY,
        startZ,
        stagingX,
        stagingY,
        stagingZ,
        targetX,
        targetY,
        targetZ,
        startYaw,
        peakArcHeight,
        spinTurns = 0,
      } = cfg;

      // Progressione orizzontale sovrapposta: mentre `s1` decelera dolcemente verso il punto
      // di stacco (`staging`), `s2` sta già accelerando verso la cima del gradino (`target`),
      // così la velocità orizzontale non cade mai a zero fino a uJ = 1.0!
      const s1 = smootherstep(clamp(uJ / 0.44, 0, 1));
      const s2 = smootherstep(clamp((uJ - 0.32) / 0.68, 0, 1));

      const x = startX + (stagingX - startX) * s1 + (targetX - stagingX) * s2;
      const z = startZ + (stagingZ - startZ) * s1 + (targetZ - stagingZ) * s2;

      // Elevazione di base + 2 campane cosinusoidali morbide (balzo d'approccio + grande salto fino a uJ = 1.0)
      const elevS2 = smootherstep(clamp((uJ - 0.36) / 0.64, 0, 1));
      const baseY = startY + (stagingY - startY) * s1 + (targetY - stagingY) * elevS2;
      const hopArc = smoothBell(uJ, 0.17, 0.17) * 0.38;
      const leapBell = smoothBell(uJ, 0.68, 0.32);
      const leapArc = leapBell * (0.88 + 0.12 * leapBell) * peakArcHeight;
      const y = baseY + hopArc + leapArc;

      // Allineamento progressivo dello yaw + eventuale piroetta acrobatica in volo
      const yawAlign = 1 - smootherstep(clamp(uJ / 0.48, 0, 1));
      const spinS = spinTurns ? smootherstep(clamp((uJ - 0.38) / 0.60, 0, 1)) : 0;
      const rotY = startYaw * yawAlign + spinS * Math.PI * 2 * spinTurns;

      return {
        x,
        y,
        z,
        rotY,
        jumpProgress: uJ,
      };
    }

    // -------------------------------------------------------------------------
    // 1. CINEMATICA 3° CLASSIFICATO (Atto 2: entra da destra e sale sul gradino 3°)
    // -------------------------------------------------------------------------
    let thirdState = {
      visible: false,
      x: 4.8,
      y: 0,
      z: 0.9,
      rotY: -0.6,
      pose: 'idle',
      poseIntensity: 1.0,
      jumpProgress: undefined,
      nameTagVisible: false,
      nameTagScale: 0,
      spotlightIntensity: 0,
    };

    if (progress >= TIMELINE.act1End) {
      thirdState.visible = true;
      const enterSpan = TIMELINE.thirdLandAt - TIMELINE.act1End;
      const tEnter = clamp((progress - TIMELINE.act1End) / enterSpan, 0, 1);

      if (tEnter < 1) {
        const traj3 = computeFluidPodiumJumpTrajectory(tEnter, {
          startX: 4.5,
          startY: 0,
          startZ: 1.15,
          stagingX: PODIUM_STEPS.third.x + 1.05,
          stagingY: deckY,
          stagingZ: PODIUM_STEPS.third.z + 0.68,
          targetX: PODIUM_STEPS.third.x,
          targetY: top3Y,
          targetZ: PODIUM_STEPS.third.z,
          startYaw: -0.85,
          peakArcHeight: 1.05,
          spinTurns: 0,
        });
        thirdState.x = traj3.x;
        thirdState.y = traj3.y;
        thirdState.z = traj3.z;
        thirdState.rotY = traj3.rotY;
        thirdState.pose = 'podium_jump';
        thirdState.poseIntensity = 1.0;
        thirdState.jumpProgress = traj3.jumpProgress;
        thirdState.spotlightIntensity = lerp(0.25, 1.0, easeOutCubic(tEnter));
      } else {
        const settle3 = smootherstep(clamp((progress - TIMELINE.thirdLandAt) / 0.045, 0, 1));
        thirdState.x = PODIUM_STEPS.third.x;
        thirdState.y = top3Y;
        thirdState.z = PODIUM_STEPS.third.z;
        thirdState.rotY = 0;
        thirdState.pose = 'podium_3rd';
        thirdState.poseIntensity = lerp(0.25, 1.0, settle3);
        thirdState.jumpProgress = undefined;
        const tagT = clamp((progress - TIMELINE.thirdLandAt) / 0.045, 0, 1);
        thirdState.nameTagVisible = true;
        thirdState.nameTagScale = easeOutBack(tagT);
        const dim3 = smootherstep(clamp((progress - TIMELINE.act2End) / 0.05, 0, 1));
        thirdState.spotlightIntensity = lerp(1.0, 0.72, dim3);
      }
    }

    // -------------------------------------------------------------------------
    // 2. CINEMATICA 2° CLASSIFICATO (Atto 3: entra da sinistra con piroetta sul 2°)
    // -------------------------------------------------------------------------
    let secondState = {
      visible: false,
      x: -4.8,
      y: 0,
      z: 0.9,
      rotY: 0.6,
      pose: 'idle',
      poseIntensity: 1.0,
      jumpProgress: undefined,
      nameTagVisible: false,
      nameTagScale: 0,
      spotlightIntensity: 0,
    };

    if (progress >= TIMELINE.act2End) {
      secondState.visible = true;
      const enterSpan = TIMELINE.secondLandAt - TIMELINE.act2End;
      const tEnter = clamp((progress - TIMELINE.act2End) / enterSpan, 0, 1);

      if (tEnter < 1) {
        const traj2 = computeFluidPodiumJumpTrajectory(tEnter, {
          startX: -4.5,
          startY: 0,
          startZ: 1.15,
          stagingX: PODIUM_STEPS.second.x - 1.05,
          stagingY: deckY,
          stagingZ: PODIUM_STEPS.second.z + 0.68,
          targetX: PODIUM_STEPS.second.x,
          targetY: top2Y,
          targetZ: PODIUM_STEPS.second.z,
          startYaw: 0.85,
          peakArcHeight: 1.28,
          spinTurns: 1,
        });
        secondState.x = traj2.x;
        secondState.y = traj2.y;
        secondState.z = traj2.z;
        secondState.rotY = traj2.rotY;
        secondState.pose = 'podium_jump';
        secondState.poseIntensity = 1.0;
        secondState.jumpProgress = traj2.jumpProgress;
        secondState.spotlightIntensity = lerp(0.25, 1.0, easeOutCubic(tEnter));
      } else {
        const settle2 = smootherstep(clamp((progress - TIMELINE.secondLandAt) / 0.045, 0, 1));
        secondState.x = PODIUM_STEPS.second.x;
        secondState.y = top2Y;
        secondState.z = PODIUM_STEPS.second.z;
        secondState.rotY = 0;
        secondState.pose = 'podium_2nd';
        secondState.poseIntensity = lerp(0.25, 1.0, settle2);
        secondState.jumpProgress = undefined;
        const tagT = clamp((progress - TIMELINE.secondLandAt) / 0.045, 0, 1);
        secondState.nameTagVisible = true;
        secondState.nameTagScale = easeOutBack(tagT);
        const dim2 = smootherstep(clamp((progress - TIMELINE.act3End) / 0.05, 0, 1));
        secondState.spotlightIntensity = lerp(1.0, 0.75, dim2);
      }
    }

    // -------------------------------------------------------------------------
    // 3. CINEMATICA 1° CLASSIFICATO + COPPA D'ORO 3D (Atto 4 & Idle Infinito)
    // -------------------------------------------------------------------------
    let firstState = {
      visible: false,
      x: 0,
      y: deckY,
      z: -2.2,
      rotY: 0,
      pose: 'idle',
      poseIntensity: 1.0,
      jumpProgress: undefined,
      nameTagVisible: false,
      nameTagScale: 0,
      trophyVisible: false,
      trophyScale: 0,
      trophySpinY: 0,
      spotlightIntensity: 0,
    };

    if (progress >= TIMELINE.act3End) {
      // Tra act3End (0.60) e firstJumpStartAt (0.66): rullo di tamburi e faretto sul 1° gradino
      const drumT = clamp(
        (progress - TIMELINE.act3End) / (TIMELINE.firstJumpStartAt - TIMELINE.act3End),
        0,
        1
      );
      firstState.spotlightIntensity = lerp(0.3, 1.0, drumT);

      if (progress >= TIMELINE.firstJumpStartAt) {
        firstState.visible = true;
        const jumpSpan = TIMELINE.firstLandAt - TIMELINE.firstJumpStartAt;
        const tJump = clamp((progress - TIMELINE.firstJumpStartAt) / jumpSpan, 0, 1);

        if (tJump < 1) {
          const traj1 = computeFluidPodiumJumpTrajectory(tJump, {
            startX: 0,
            startY: deckY,
            startZ: -2.15,
            stagingX: 0,
            stagingY: deckY,
            stagingZ: -1.35,
            targetX: PODIUM_STEPS.first.x,
            targetY: top1Y,
            targetZ: PODIUM_STEPS.first.z,
            startYaw: 0,
            peakArcHeight: 1.72,
            spinTurns: 1,
          });
          firstState.x = traj1.x;
          firstState.y = traj1.y;
          firstState.z = traj1.z;
          firstState.rotY = traj1.rotY;
          firstState.pose = 'podium_jump';
          firstState.poseIntensity = 1.0;
          firstState.jumpProgress = traj1.jumpProgress;
        } else {
          const settle1 = smootherstep(clamp((progress - TIMELINE.firstLandAt) / 0.045, 0, 1));
          firstState.x = PODIUM_STEPS.first.x;
          firstState.y = top1Y;
          firstState.z = PODIUM_STEPS.first.z;
          firstState.rotY = 0;
          firstState.pose = 'champion_trophy';
          firstState.poseIntensity = lerp(0.35, 1.0, settle1);
          firstState.jumpProgress = undefined;

          const tagT = clamp((progress - TIMELINE.firstLandAt) / 0.04, 0, 1);
          firstState.nameTagVisible = true;
          firstState.nameTagScale = easeOutBack(tagT);

          if (progress >= TIMELINE.trophyPopAt) {
            const cupT = clamp((progress - TIMELINE.trophyPopAt) / 0.055, 0, 1);
            firstState.trophyVisible = true;
            firstState.trophyScale = Math.max(0.01, easeOutBack(cupT));
            firstState.trophySpinY = (1 - cupT) * Math.PI * 1.5 + Math.sin(elapsedSec * 2.4) * 0.22;
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 4. FOLLA SEMICIRCOLARE, CORIANDOLI & FARETTI 3D CHE GIRANO NEL BUIO
    // -------------------------------------------------------------------------
    // Transizione morbida C2 dell'intensità d'esultanza del pubblico (zero scatti tra atti!)
    const cheerRampAct2 = smootherstep(clamp((progress - (TIMELINE.act1End - 0.03)) / 0.06, 0, 1));
    const cheerRampChamp = smootherstep(
      clamp((progress - (TIMELINE.firstLandAt - 0.03)) / 0.06, 0, 1)
    );
    const crowdCheerIntensity = 0.85 + 0.18 * cheerRampAct2 + 0.27 * cheerRampChamp;

    const confettiActive = progress >= TIMELINE.trophyPopAt;
    const confettiProgress = confettiActive
      ? clamp((progress - TIMELINE.trophyPopAt) / (1 - TIMELINE.trophyPopAt), 0, 1)
      : 0;

    // Calcolo posizioni target dei 3 Faretti Motorizzati 3D:
    // - Prima girano nel buio sulla folla e sul palco ("sweep")
    // - Poi si posizionano sui giocatori 3°, 2° e 1° per illuminarli!
    const sweep3X = 3.2 * Math.cos(elapsedSec * 2.3 + 0.4);
    const sweep3Z = 2.0 + 1.8 * Math.sin(elapsedSec * 2.3 + 0.4);
    const sweep2X = -3.2 * Math.cos(elapsedSec * 2.1 + 1.9);
    const sweep2Z = 2.0 + 1.8 * Math.sin(elapsedSec * 2.1 + 1.9);
    const sweep1X = 3.5 * Math.sin(elapsedSec * 1.85);
    const sweep1Z = 1.6 + 1.7 * Math.cos(elapsedSec * 3.7);

    // Faretto 3° Classificato ( Destra - Bronzo/Ambra )
    let spotRight = {
      x: sweep3X,
      y: 0.05,
      z: sweep3Z,
      intensity: 0.95,
      locked: false,
    };
    if (progress >= TIMELINE.act1End) {
      const lock3 = easeOutCubic(clamp((progress - TIMELINE.act1End) / 0.05, 0, 1));
      const idlePulse3 = isFinaleIdle ? Math.sin(elapsedSec * 2.6 + 1.2) * 0.1 : 0;
      spotRight = {
        x: lerp(sweep3X, thirdState.x, lock3),
        y: lerp(0.05, thirdState.y, lock3),
        z: lerp(sweep3Z, thirdState.z, lock3),
        intensity: (act === 2 ? 1.45 : 1.15) + idlePulse3,
        locked: lock3 >= 0.99,
      };
    }

    // Faretto 2° Classificato ( Sinistra - Ciano/Argento )
    let spotLeft = {
      x: sweep2X,
      y: 0.05,
      z: sweep2Z,
      intensity: 0.85,
      locked: false,
    };
    if (progress >= TIMELINE.act2End) {
      const lock2 = easeOutCubic(clamp((progress - TIMELINE.act2End) / 0.05, 0, 1));
      const idlePulse2 = isFinaleIdle ? Math.sin(elapsedSec * 2.4 + 0.5) * 0.1 : 0;
      spotLeft = {
        x: lerp(sweep2X, secondState.x, lock2),
        y: lerp(0.05, secondState.y, lock2),
        z: lerp(sweep2Z, secondState.z, lock2),
        intensity: (act === 3 ? 1.45 : 1.15) + idlePulse2,
        locked: lock2 >= 0.99,
      };
    }

    // Faretto 1° Classificato ( Centro - Oro )
    let spotCenter = {
      x: sweep1X,
      y: 0.05,
      z: sweep1Z,
      intensity: 0.9,
      locked: false,
    };
    if (progress >= TIMELINE.act3End && progress < TIMELINE.firstJumpStartAt) {
      // Durante il rullo di tamburi: i fasci dorati girano vorticosamente attorno al podio!
      const drumSpin = elapsedSec * 9.5;
      spotCenter = {
        x: 2.35 * Math.cos(drumSpin),
        y: deckY,
        z: -0.35 + 1.55 * Math.sin(drumSpin),
        intensity: 1.35,
        locked: false,
      };
    } else if (progress >= TIMELINE.firstJumpStartAt) {
      const lock1 = easeOutCubic(clamp((progress - TIMELINE.firstJumpStartAt) / 0.04, 0, 1));
      const idlePulse1 = isFinaleIdle ? Math.sin(elapsedSec * 3.1) * 0.14 : 0;
      spotCenter = {
        x: lerp(0, firstState.x, lock1),
        y: lerp(deckY, firstState.y, lock1),
        z: lerp(-0.55, firstState.z, lock1),
        intensity: 1.65 + idlePulse1,
        locked: true,
      };
    }

    // Due fari secondari che continuano a ruotare morbidamente sulla folla nel buio anche nell'idle infinito
    const spotCrowdLeft = {
      x: -4.2 + Math.sin(elapsedSec * 1.4) * 1.65,
      y: 0.0,
      z: 2.6 + Math.cos(elapsedSec * 1.4) * 1.45,
      intensity: progress >= TIMELINE.firstLandAt ? 0.98 : 0.65,
    };
    const spotCrowdRight = {
      x: 4.2 + Math.cos(elapsedSec * 1.55) * 1.65,
      y: 0.0,
      z: 2.6 + Math.sin(elapsedSec * 1.55) * 1.45,
      intensity: progress >= TIMELINE.firstLandAt ? 0.98 : 0.65,
    };

    // -------------------------------------------------------------------------
    // 5. COREOGRAFIA TELECAMERA 3D (Zoom sugli ingressi 3 -> 2 -> 1 + Vista Finale & Idle Infinito)
    // -------------------------------------------------------------------------
    let cam = {
      x: 0,
      y: 4.8,
      z: 9.8,
      lookX: 0,
      lookY: 1.9,
      lookZ: -0.3,
      fov: 45,
    };

    if (progress < TIMELINE.act1End) {
      // Atto 1: Carrellata d'apertura nel buio coi faretti che girano sulla folla e sul palco
      const t = easeInOutCubic(progress / TIMELINE.act1End);
      cam = {
        x: lerp(0.0, 0.8, t),
        y: lerp(6.2, 4.2, t),
        z: lerp(11.8, 9.2, t),
        lookX: lerp(0.0, 0.4, t),
        lookY: lerp(1.5, 1.8, t),
        lookZ: -0.4,
        fov: 46,
      };
    } else if (progress < TIMELINE.act2End) {
      // Atto 2: Stringe sul gradino destro (3° classificato illuminato dal faretto)
      const t = easeInOutCubic((progress - TIMELINE.act1End) / (TIMELINE.act2End - TIMELINE.act1End));
      const focusT = easeOutCubic(Math.min(1, t * 1.5));
      cam = {
        x: lerp(0.8, 2.05, focusT),
        y: lerp(4.2, 2.75, focusT),
        z: lerp(9.2, 6.85, focusT),
        lookX: lerp(0.4, PODIUM_STEPS.third.x, focusT),
        lookY: lerp(1.8, top3Y + 1.15, focusT),
        lookZ: PODIUM_STEPS.third.z,
        fov: 44,
      };
    } else if (progress < TIMELINE.act3End) {
      // Atto 3: Panoramica fluida verso il gradino sinistro (2° classificato illuminato dal faretto)
      const t = easeInOutCubic((progress - TIMELINE.act2End) / (TIMELINE.act3End - TIMELINE.act2End));
      const focusT = easeOutCubic(Math.min(1, t * 1.5));
      cam = {
        x: lerp(2.05, -2.05, focusT),
        y: lerp(2.75, 2.95, focusT),
        z: lerp(6.85, 6.95, focusT),
        lookX: lerp(PODIUM_STEPS.third.x, PODIUM_STEPS.second.x, focusT),
        lookY: lerp(top3Y + 1.15, top2Y + 1.18, focusT),
        lookZ: PODIUM_STEPS.second.z,
        fov: 44,
      };
    } else if (progress < TIMELINE.act4End) {
      // Atto 4: Zoom al centro per il 1° classificato con la Coppa d'Oro in mano + Impalcatura Logo Quiz-Zata!
      const t = easeInOutCubic((progress - TIMELINE.act3End) / (TIMELINE.act4End - TIMELINE.act3End));
      const focusT = easeOutCubic(Math.min(1, t * 1.4));
      cam = {
        x: lerp(-2.05, 0.0, focusT),
        y: lerp(2.95, 3.45, focusT),
        z: lerp(6.95, 8.15, focusT),
        lookX: lerp(PODIUM_STEPS.second.x, 0.0, focusT),
        lookY: lerp(top2Y + 1.18, 2.52, focusT),
        lookZ: lerp(PODIUM_STEPS.second.z, -0.92, focusT),
        fov: 47,
      };
    } else {
      // Atto 5 + Idle Infinito: Inquadratura panoramica con Impalcatura & Logo 1:1 Quiz-Zata!, Podio e Folla
      const t = easeInOutCubic((progress - TIMELINE.act4End) / (TIMELINE.act5End - TIMELINE.act4End));
      const idleSwayX = isFinaleIdle ? Math.sin(finaleIdleSec * 0.65) * 0.95 : 0;
      const idleSwayY = isFinaleIdle ? Math.sin(finaleIdleSec * 1.1) * 0.10 : 0;
      const idleZoomZ = isFinaleIdle ? (1 - Math.cos(finaleIdleSec * 0.65)) * 0.35 : 0;
      cam = {
        x: lerp(0.0, 0.0, t) + idleSwayX,
        y: lerp(3.45, 4.02, t) + idleSwayY,
        z: lerp(8.15, 10.85, t) - idleZoomZ,
        lookX: idleSwayX * 0.18,
        lookY: lerp(2.52, 2.44, t),
        lookZ: lerp(-0.92, -0.55, t),
        fov: 48,
      };
    }

    return {
      progress,
      act,
      elapsedSec,
      isFinaleIdle,
      third: thirdState,
      second: secondState,
      first: firstState,
      spotlights: {
        first: spotCenter,
        second: spotLeft,
        third: spotRight,
        crowdLeft: spotCrowdLeft,
        crowdRight: spotCrowdRight,
      },
      crowdCheerIntensity,
      confettiActive,
      confettiProgress,
      camera: cam,
    };
  }

  // ===========================================================================
  // MOTORE SONORO PROCEDURALE WEB AUDIO API (Premiazione Finale)
  // ===========================================================================
  let sharedAudioCtx = null;
  let audioMuted = false;

  function getAudioContext() {
    if (audioMuted || typeof window === 'undefined') return null;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!sharedAudioCtx) {
      try {
        sharedAudioCtx = new AudioCtx();
      } catch (_) {
        return null;
      }
    }
    if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
  }

  function playTone(ctx, freq, startOffset, duration, type = 'triangle', peakGain = 0.12) {
    const now = ctx.currentTime + startOffset;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  /**
   * Esegue uno degli effetti sonori procedurali della Premiazione Finale:
   *   - `'crowd_cheer'`: Applauso ritmico e boato caldo del pubblico
   *   - `'mii_hop'`: Effetto salto elastico "boing" in stile Wii
   *   - `'bronze_3rd'`: Jingle brillante per il 3° classificato
   *   - `'silver_2nd'`: Jingle armonico per il 2° classificato
   *   - `'drumroll_1st'`: Rullo di tamburi in crescendo per la suspense del 1° posto
   *   - `'trophy_fanfare'`: Fanfara trionfale + scintillio Coppa d'Oro 3D!
   */
  function triggerAudioCue(cueName) {
    const ctx = getAudioContext();
    if (!ctx) return;

    try {
      if (cueName === 'mii_hop') {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(240, now);
        osc.frequency.exponentialRampToValueAtTime(580, now + 0.16);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.14, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.2);
      } else if (cueName === 'crowd_cheer') {
        // Impulsi morbidi di applauso + accordo caldo di folla
        for (let i = 0; i < 6; i++) {
          playTone(ctx, 320 + (i % 3) * 80, i * 0.065, 0.08, 'triangle', 0.06);
        }
        playTone(ctx, 261.63, 0.02, 0.45, 'sine', 0.07);
        playTone(ctx, 329.63, 0.04, 0.45, 'sine', 0.07);
        playTone(ctx, 392.0, 0.06, 0.45, 'sine', 0.07);
      } else if (cueName === 'bronze_3rd') {
        // Arpeggio 3° classificato (Sol - Si - Re5)
        playTone(ctx, 392.0, 0.0, 0.18, 'triangle', 0.13);
        playTone(ctx, 493.88, 0.11, 0.18, 'triangle', 0.13);
        playTone(ctx, 587.33, 0.22, 0.42, 'triangle', 0.16);
      } else if (cueName === 'silver_2nd') {
        // Arpeggio 2° classificato (La - Do#5 - Mi5 - La5)
        playTone(ctx, 440.0, 0.0, 0.15, 'triangle', 0.13);
        playTone(ctx, 554.37, 0.1, 0.15, 'triangle', 0.13);
        playTone(ctx, 659.25, 0.2, 0.16, 'triangle', 0.14);
        playTone(ctx, 880.0, 0.31, 0.48, 'triangle', 0.17);
      } else if (cueName === 'drumroll_1st') {
        // Rullo di tamburi crescente
        for (let i = 0; i < 12; i++) {
          const t = i * 0.055;
          const g = 0.03 + (i / 12) * 0.09;
          playTone(ctx, 115 + (i % 2) * 14, t, 0.06, 'sawtooth', g);
        }
      } else if (cueName === 'trophy_fanfare') {
        // Fanfara Reale + Scintillio Coppa d'Oro
        const notes = [
          { f: 523.25, t: 0.0, d: 0.16 }, // Do5
          { f: 523.25, t: 0.14, d: 0.14 }, // Do5
          { f: 523.25, t: 0.26, d: 0.14 }, // Do5
          { f: 659.25, t: 0.40, d: 0.30 }, // Mi5
          { f: 783.99, t: 0.66, d: 0.28 }, // Sol5
          { f: 1046.5, t: 0.92, d: 0.75 }, // Do6
        ];
        notes.forEach((n) => {
          playTone(ctx, n.f, n.t, n.d, 'sawtooth', 0.12);
          playTone(ctx, n.f * 0.5, n.t, n.d, 'triangle', 0.10);
        });
      } else if (cueName === 'confetti_cannon') {
        // Cannone coriandoli dall'alto: "pop" pneumatico + cascata di scintille cristalline
        playTone(ctx, 185, 0.0, 0.11, 'triangle', 0.16);
        playTone(ctx, 95, 0.01, 0.14, 'sine', 0.15);
        const sparkleFreqs = [1046.5, 1318.5, 1567.98, 2093.0, 1760.0, 2349.32];
        sparkleFreqs.forEach((f, idx) => {
          playTone(ctx, f, 0.04 + idx * 0.035, 0.22, 'sine', 0.065);
        });
      }
    } catch (_) {
      // Ignora errori autoplay browser
    }
  }

  function setMuted(val) {
    audioMuted = Boolean(val);
  }

  function isMuted() {
    return audioMuted;
  }

  // ===========================================================================
  // PARTICLE EFFECT CONTROLLER: TOP-OF-SCREEN CONFETTI EXPLOSION
  // ===========================================================================
  const CONFETTI_PALETTE = [
    '#f7d708', // Giallo Quiz-Zata!
    '#90efef', // Ciano Elettrico
    '#e05a47', // Rosso Corallo
    '#c8f7c5', // Verde Menta
    '#f2a65a', // Arancio Oro
    '#ffffff', // Bianco Luce
    '#ff85c0', // Rosa Festa
  ];

  const CONFETTI_SHAPES = ['ribbon', 'star', 'streamer', 'disc'];

  // 5 ugelli posizionati lungo il bordo superiore dello schermo (normY = 0.0)
  const TOP_SCREEN_EMITTERS = [
    { normX: 0.12, normY: 0.0, worldX: -3.6, worldY: 6.45, worldZ: 0.35, spreadAngle: 0.22 },
    { normX: 0.31, normY: 0.0, worldX: -1.8, worldY: 6.55, worldZ: 0.25, spreadAngle: 0.10 },
    { normX: 0.50, normY: 0.0, worldX: 0.0, worldY: 6.65, worldZ: 0.15, spreadAngle: 0.0 },
    { normX: 0.69, normY: 0.0, worldX: 1.8, worldY: 6.55, worldZ: 0.25, spreadAngle: -0.10 },
    { normX: 0.88, normY: 0.0, worldX: 3.6, worldY: 6.45, worldZ: 0.35, spreadAngle: -0.22 },
  ];

  /**
   * Crea un controller per l'effetto particellare di esplosione coriandoli dall'alto dello schermo
   * ("Confetti Explosion") attivato quando il 1° classificato solleva la Coppa d'Oro 3D
   * e durante l'Atto Finale / Idle Infinito.
   */
  function createConfettiExplosionController(options = {}) {
    const maxParticles = Math.max(40, Number(options.maxParticles) || 260);
    const defaultBurstCount = Math.max(24, Number(options.burstCount) || 95);
    const particles = [];
    let burstsTriggered = 0;
    let lastBurstElapsedSec = -999;
    let lastSyncedU = 0;
    let trophyLiftBurstFired = false;
    let finalActBurstFired = false;
    let nextIdleBurstAtSec = 0;
    let seedCounter = 1;

    function pseudoRandom() {
      seedCounter = (seedCounter * 1664525 + 1013904223) >>> 0;
      return (seedCounter & 0x0fffffff) / 0x10000000;
    }

    function triggerExplosion(burstOptions = {}) {
      const count = Math.max(12, Number(burstOptions.count) || defaultBurstCount);
      const intensity = clamp(Number(burstOptions.intensity) || 1.0, 0.4, 2.0);
      const nowSec = Number.isFinite(burstOptions.elapsedSec) ? Number(burstOptions.elapsedSec) : 0;
      const playAudio = burstOptions.playAudio !== false;

      burstsTriggered += 1;
      lastBurstElapsedSec = nowSec;

      if (playAudio) {
        triggerAudioCue('confetti_cannon');
      }

      for (let i = 0; i < count; i++) {
        if (particles.length >= maxParticles) {
          particles.shift();
        }
        const emitter = TOP_SCREEN_EMITTERS[i % TOP_SCREEN_EMITTERS.length];
        const r1 = pseudoRandom();
        const r2 = pseudoRandom();
        const r3 = pseudoRandom();
        const r4 = pseudoRandom();
        const r5 = pseudoRandom();

        // Posizione iniziale sul bordo superiore dello schermo (normY vicinissimo a 0)
        const jitterX = (r1 - 0.5) * 0.14;
        const normX = clamp(emitter.normX + jitterX, 0.03, 0.97);
        const normY = -0.015 + r2 * 0.03; // Parte esattamente dalla cima dello schermo!

        // Angolo di lancio verso il basso a ventaglio (0 = giù verticale)
        const fanAngle = emitter.spreadAngle + (r3 - 0.5) * 1.18;
        const launchSpeed = (0.42 + r4 * 0.58) * intensity;

        const vx = Math.sin(fanAngle) * launchSpeed * 0.68;
        const vy = Math.max(0.22, Math.cos(fanAngle) * launchSpeed); // Esplosione rapida verso il basso

        // Coordinate 3D per i coriandoli nella scena Three.js (partono dall'alto y ~ 6.5)
        const worldX = emitter.worldX + (r1 - 0.5) * 1.35;
        const worldY = emitter.worldY + (r2 - 0.5) * 0.35;
        const worldZ = emitter.worldZ + (r3 - 0.5) * 1.8;

        particles.push({
          id: `${burstsTriggered}_${i}`,
          normX,
          normY,
          vx,
          vy,
          worldX,
          worldY,
          worldZ,
          worldVx: vx * 4.5,
          worldVy: -vy * 5.2,
          worldVz: (r5 - 0.5) * 2.2,
          gravity: 0.36 + r2 * 0.24,
          drag: 1.45 + r3 * 0.75,
          flutterAmp: 0.14 + r4 * 0.22,
          flutterFreq: 3.2 + r5 * 4.5,
          flutterPhase: r1 * Math.PI * 2,
          rotation: r2 * Math.PI * 2,
          rotationSpeed: (r3 - 0.5) * 9.5,
          tiltPhase: r4 * Math.PI * 2,
          tiltSpeed: 4.5 + r5 * 6.5,
          sizePx: 8 + (i % 5) * 2.2,
          color: CONFETTI_PALETTE[i % CONFETTI_PALETTE.length],
          shape: CONFETTI_SHAPES[i % CONFETTI_SHAPES.length],
          ageSec: 0,
          maxLifeSec: 2.6 + r1 * 1.6,
          opacity: 1,
        });
      }

      return getDiagnostics();
    }

    function step(dtSec) {
      const dt = clamp(Number(dtSec) || 0, 0, 0.25);
      if (dt <= 0 || particles.length === 0) return;

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.ageSec += dt;
        if (p.ageSec >= p.maxLifeSec || p.normY > 1.18) {
          particles.splice(i, 1);
          continue;
        }

        // Resistenza aerodinamica (frena lo sprint esplosivo iniziale trasformandolo in caduta fluttuante)
        const damp = Math.exp(-p.drag * dt);
        p.vx *= damp;
        p.vy = p.vy * damp + p.gravity * dt;

        const flutter = Math.sin(p.ageSec * p.flutterFreq + p.flutterPhase) * p.flutterAmp;
        p.normX += (p.vx + flutter) * dt;
        p.normY += p.vy * dt;

        // Fisica 3D coordinata dall'alto dello schermo (y ~ 6.5 -> pavimento y ~ 0)
        p.worldVx *= damp;
        p.worldVy = p.worldVy * damp - p.gravity * 4.8 * dt;
        p.worldX += (p.worldVx + flutter * 3.2) * dt;
        p.worldY += p.worldVy * dt;
        p.worldZ += p.worldVz * dt;

        p.rotation += p.rotationSpeed * dt;
        p.tiltPhase += p.tiltSpeed * dt;

        const lifeRatio = p.ageSec / p.maxLifeSec;
        p.opacity = lifeRatio > 0.78 ? clamp(1 - (lifeRatio - 0.78) / 0.22, 0, 1) : 1;
      }
    }

    function reset() {
      particles.length = 0;
      burstsTriggered = 0;
      lastBurstElapsedSec = -999;
      lastSyncedU = 0;
      trophyLiftBurstFired = false;
      finalActBurstFired = false;
      nextIdleBurstAtSec = 0;
      seedCounter = 1;
    }

    /**
     * Sincronizza il controller con la timeline `u` in [0, 1] e il tempo `elapsedSec`.
     * Quando il vincitore solleva la Coppa d'Oro (`TIMELINE.trophyPopAt = 0.76`) o
     * all'ingresso nell'Atto Finale (`TIMELINE.act4End = 0.86`), innesca l'esplosione dall'alto.
     */
    function syncToTimeline(uVal, elapsedSec = 0, durationMs = DEFAULT_DURATION_MS, optionsSync = {}) {
      const clampedU = clamp(Number(uVal) || 0, 0, 1);
      const isSeek = Boolean(optionsSync.isSeek);
      const totalDurationSec = Math.max(2, (Number(durationMs) || DEFAULT_DURATION_MS) / 1000);

      if (clampedU < TIMELINE.trophyPopAt - 0.02) {
        if (trophyLiftBurstFired || finalActBurstFired) {
          reset();
        }
        lastSyncedU = clampedU;
        return getDiagnostics();
      }

      if (isSeek) {
        // Ricostruzione deterministica per lo scrubbing della timeline
        reset();
        const trophySec = TIMELINE.trophyPopAt * totalDurationSec;
        const act5Sec = TIMELINE.act4End * totalDurationSec;
        const currentSec = Number.isFinite(elapsedSec) ? elapsedSec : clampedU * totalDurationSec;

        if (clampedU >= TIMELINE.trophyPopAt) {
          trophyLiftBurstFired = true;
          triggerExplosion({ count: defaultBurstCount, intensity: 1.15, elapsedSec: trophySec, playAudio: false });
          const dtSinceTrophy = clamp(currentSec - trophySec, 0.08, 2.2);

          if (clampedU >= TIMELINE.act4End) {
            const dtToAct5 = clamp(act5Sec - trophySec, 0.05, 1.8);
            step(dtToAct5);
            finalActBurstFired = true;
            triggerExplosion({ count: Math.round(defaultBurstCount * 1.1), intensity: 1.25, elapsedSec: act5Sec, playAudio: false });
            const dtSinceAct5 = clamp(currentSec - act5Sec, 0.12, 1.4);
            step(dtSinceAct5);
          } else {
            step(dtSinceTrophy);
          }
        }
        lastSyncedU = clampedU;
        return getDiagnostics();
      }

      // Avvio automatico durante la riproduzione quando il 1° classificato solleva la Coppa!
      if (!trophyLiftBurstFired && clampedU >= TIMELINE.trophyPopAt) {
        trophyLiftBurstFired = true;
        triggerExplosion({
          count: defaultBurstCount,
          intensity: 1.18,
          elapsedSec,
          playAudio: true,
        });
      }

      // Seconda ondata esplosiva dall'alto all'inizio del Gran Finale (Atto 5)
      if (!finalActBurstFired && clampedU >= TIMELINE.act4End) {
        finalActBurstFired = true;
        nextIdleBurstAtSec = elapsedSec + 3.1;
        triggerExplosion({
          count: Math.round(defaultBurstCount * 1.12),
          intensity: 1.25,
          elapsedSec,
          playAudio: true,
        });
      }

      // Nell'Idle Finale Infinito (u >= 1.0), spara una nuova ondata dall'alto ogni ~3.2s
      if (clampedU >= 0.999 && elapsedSec >= nextIdleBurstAtSec && nextIdleBurstAtSec > 0) {
        nextIdleBurstAtSec = elapsedSec + 3.2;
        triggerExplosion({
          count: Math.round(defaultBurstCount * 0.85),
          intensity: 1.08,
          elapsedSec,
          playAudio: false,
        });
      }

      lastSyncedU = clampedU;
      return getDiagnostics();
    }

    function applyTo3DMeshes(confettiPieces, tSec = 0) {
      if (!Array.isArray(confettiPieces) || confettiPieces.length === 0) return;
      for (let i = 0; i < confettiPieces.length; i++) {
        const piece = confettiPieces[i];
        const p = particles[i % Math.max(1, particles.length)];
        if (p) {
          piece.mesh.position.set(
            p.worldX,
            Math.max(0.15, p.worldY),
            p.worldZ
          );
          piece.mesh.rotation.set(
            p.tiltPhase,
            p.rotation,
            p.rotation * 0.65
          );
        } else {
          // Fallback cascata dall'alto dello schermo (y = 6.5 -> 0.4)
          const fall = ((tSec * piece.speed + piece.offset) % 6.1);
          piece.mesh.position.y = 6.5 - fall;
          piece.mesh.position.x = piece.baseX + Math.sin(tSec * 2.5 + i) * 0.28;
          piece.mesh.rotation.x = tSec * piece.rotSpeedX;
          piece.mesh.rotation.y = tSec * piece.rotSpeedY;
        }
      }
    }

    function renderOverlay2D(ctx, width, height) {
      if (!ctx || !width || !height) return;
      ctx.clearRect(0, 0, width, height);
      if (particles.length === 0) return;

      ctx.save();
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const x = p.normX * width;
        const y = p.normY * height;
        if (y < -30 || y > height + 30 || x < -30 || x > width + 30) continue;

        const tiltScaleY = Math.max(0.22, Math.abs(Math.cos(p.tiltPhase)));
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(p.rotation);
        ctx.scale(1, tiltScaleY);
        ctx.globalAlpha = p.opacity;

        ctx.fillStyle = p.color;
        ctx.strokeStyle = '#201b0d';
        ctx.lineWidth = 1.8;

        const s = p.sizePx;
        if (p.shape === 'ribbon') {
          ctx.beginPath();
          ctx.roundRect(-s * 0.65, -s * 0.36, s * 1.3, s * 0.72, 2.5);
          ctx.fill();
          ctx.stroke();
        } else if (p.shape === 'streamer') {
          ctx.beginPath();
          ctx.roundRect(-s * 0.95, -s * 0.24, s * 1.9, s * 0.48, 2);
          ctx.fill();
          ctx.stroke();
        } else if (p.shape === 'disc') {
          ctx.beginPath();
          ctx.arc(0, 0, s * 0.46, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          // Stella a 4 punte stile festa TV Show
          ctx.beginPath();
          const outer = s * 0.68;
          const inner = s * 0.28;
          for (let k = 0; k < 8; k++) {
            const r = k % 2 === 0 ? outer : inner;
            const ang = (k * Math.PI) / 4;
            const px = Math.cos(ang) * r;
            const py = Math.sin(ang) * r;
            if (k === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.restore();
    }

    function getDiagnostics() {
      return {
        activeParticles: particles.length,
        burstsTriggered,
        isExploding: particles.length > 0,
        trophyLiftBurstFired,
        finalActBurstFired,
        lastBurstElapsedSec,
        sampleTopParticles: particles.slice(0, 5).map((p) => ({
          normX: Number(p.normX.toFixed(3)),
          normY: Number(p.normY.toFixed(3)),
          vy: Number(p.vy.toFixed(3)),
          worldY: Number(p.worldY.toFixed(2)),
          shape: p.shape,
          color: p.color,
        })),
      };
    }

    return {
      triggerExplosion,
      step,
      reset,
      syncToTimeline,
      applyTo3DMeshes,
      renderOverlay2D,
      getDiagnostics,
      getParticles: () => particles,
    };
  }

  // ===========================================================================
  // COSTRUZIONE MODELLI 3D DEL PALCO, PODIO E COPPA D'ORO
  // ===========================================================================

  /**
   * Crea la Coppa d'Oro 3D composita (6 parti distinte con outline #201b0d):
   *   1. Base ottagonale a gradino in ebano/inchiostro (#201b0d)
   *   2. Targhetta dorata frontale sulla base
   *   3. Calice tornito (`LatheGeometry`) in oro lucido
   *   4. Manico ad arco sinistro (`TorusGeometry`)
   *   5. Manico ad arco destro (`TorusGeometry`)
   *   6. Stella/Emblema in vetta + Outline cartoon
   */
  function createGoldenTrophyCup(THREE) {
    const group = new THREE.Group();
    group.name = 'GoldenTrophyCup3D';

    const goldMat = new THREE.MeshStandardMaterial({
      color: 0xffdf00,
      emissive: 0xd49b00,
      emissiveIntensity: 0.38,
      roughness: 0.25,
      metalness: 0.22,
    });

    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x201b0d,
      roughness: 0.5,
      metalness: 0.2,
    });

    const outlineMat = new THREE.MeshBasicMaterial({
      color: 0x201b0d,
      side: THREE.BackSide,
    });

    // 1. Base a piedistallo
    const baseGeo = new THREE.CylinderGeometry(0.18, 0.22, 0.14, 12);
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.position.y = 0.07;
    group.add(baseMesh);

    // 2. Anello dorato sopra la base
    const ringGeo = new THREE.CylinderGeometry(0.15, 0.17, 0.05, 16);
    const ringMesh = new THREE.Mesh(ringGeo, goldMat);
    ringMesh.position.y = 0.16;
    group.add(ringMesh);

    // 3. Stelo + Coppa tornita (`LatheGeometry`)
    const cupPoints = [
      new THREE.Vector2(0.001, 0.18),
      new THREE.Vector2(0.08, 0.18),
      new THREE.Vector2(0.055, 0.30),
      new THREE.Vector2(0.09, 0.38),
      new THREE.Vector2(0.22, 0.52),
      new THREE.Vector2(0.26, 0.72),
      new THREE.Vector2(0.28, 0.80),
      new THREE.Vector2(0.24, 0.80),
      new THREE.Vector2(0.18, 0.54),
      new THREE.Vector2(0.001, 0.44),
    ];
    const cupGeo = new THREE.LatheGeometry(cupPoints, 24);
    const cupMesh = new THREE.Mesh(cupGeo, goldMat);
    group.add(cupMesh);

    const cupOutline = new THREE.Mesh(cupGeo, outlineMat);
    cupOutline.scale.setScalar(1.07);
    group.add(cupOutline);

    // 4. Doppi manici laterali ad arco
    const handleGeo = new THREE.TorusGeometry(0.12, 0.028, 10, 20, Math.PI * 1.15);

    const leftHandle = new THREE.Mesh(handleGeo, goldMat);
    leftHandle.position.set(-0.21, 0.62, 0);
    leftHandle.rotation.z = Math.PI * 0.48;
    group.add(leftHandle);

    const rightHandle = new THREE.Mesh(handleGeo, goldMat);
    rightHandle.position.set(0.21, 0.62, 0);
    rightHandle.rotation.z = -Math.PI * 0.48;
    rightHandle.rotation.y = Math.PI;
    group.add(rightHandle);

    return group;
  }

  /**
   * Crea la targa frontale per ciascuno dei 3 gradini del podio ("1°", "2°", "3°").
   */
  function createStepNumberTexture(THREE, labelText, bgColor, textColor) {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(128, 128, 104, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#201b0d';
    ctx.stroke();

    ctx.fillStyle = bgColor;
    ctx.beginPath();
    ctx.arc(128, 128, 84, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '900 104px "Quicksand", sans-serif';
    ctx.fillStyle = textColor || '#201b0d';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, 128, 134);

    const tex = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Crea la texture 1:1 (quadrata 512x512, zero distorsione/stretch!) per il Medaglione
   * Centrale dell'Impalcatura 3D con il Logo Ufficiale Quiz-Zata! (`/resources/img/LogoNoBG.png`).
   */
  function createQuizzataRearBannerTexture(THREE, onTextureUpdated) {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const tex = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;

    function drawLogoBoard(logoImg) {
      const w = canvas.width;
      const h = canvas.height;
      // Sfondo 100% trasparente così il logo sagomato poggia direttamente sui tralicci 3D!
      ctx.clearRect(0, 0, w, h);

      if (logoImg && logoImg.width > 0 && logoImg.height > 0) {
        // Proporzioni rigorosamente 1:1 native di LogoNoBG.png (zero stretch!)
        const pad = 44;
        const maxW = w - pad * 2;
        const maxH = h - pad * 2;
        const scale = Math.min(maxW / logoImg.width, maxH / logoImg.height);
        const drawW = logoImg.width * scale;
        const drawH = logoImg.height * scale;
        const dx = (w - drawW) / 2;
        const dy = (h - drawH) / 2;

        // Alone luminoso dorato sagomato sul profilo del fumetto per staccarlo dal traliccio scuro
        ctx.save();
        ctx.shadowColor = 'rgba(247, 215, 8, 0.85)';
        ctx.shadowBlur = 28;
        ctx.drawImage(logoImg, dx, dy, drawW, drawH);
        ctx.restore();

        ctx.drawImage(logoImg, dx, dy, drawW, drawH);
      } else {
        ctx.font = '900 130px "Quicksand", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 24;
        ctx.strokeStyle = '#201b0d';
        ctx.strokeText('QUIZ', w / 2, h / 2 - 75);
        ctx.strokeText('ZATA!', w / 2, h / 2 + 75);
        ctx.fillStyle = '#f7d708';
        ctx.fillText('QUIZ', w / 2, h / 2 - 75);
        ctx.fillText('ZATA!', w / 2, h / 2 + 75);
      }

      tex.needsUpdate = true;
      if (typeof onTextureUpdated === 'function') {
        onTextureUpdated();
      }
    }

    drawLogoBoard(null);

    if (typeof Image !== 'undefined') {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => drawLogoBoard(img);
      img.src = '/resources/img/LogoNoBG.png';
    }

    return tex;
  }

  /**
   * Crea un Faretto Motorizzato 3D completo di:
   *  - Proiettore cilindrico appeso in alto (`sourcePos`)
   *  - Cono di luce volumetrica 3D semitrasparente (`ConeGeometry` con gradiente additivo)
   *  - Cerchio luminoso a terra/gradino (`floorSpot`)
   *  - `THREE.PointLight` reale che illumina il personaggio inquadrato dal faretto
   */
  function createMovingSpotlightUnit(THREE, colorHex, sourceX, sourceY, sourceZ) {
    const unitGroup = new THREE.Group();
    const colorObj = new THREE.Color(colorHex);

    // 1. Snodo motorizzato in alto (`headPivot`): contiene cilindro faretto, ghiera, sfera luminosa
    //    e cono volumetrico tutti perfettamente coassiali (x = 0, z = 0) così ruotano SEMPRE insieme
    //    senza mai compenetrarsi!
    const headPivot = new THREE.Group();
    headPivot.name = 'SpotlightCoaxialHeadPivot';
    headPivot.position.set(sourceX, sourceY, sourceZ);
    unitGroup.add(headPivot);

    // Staffa superiore d'aggancio (yoke)
    const yokeGeo = new THREE.CylinderGeometry(0.08, 0.12, 0.16, 12);
    const housingMat = new THREE.MeshStandardMaterial({
      color: 0x453a6b,
      emissive: 0x1c1633,
      emissiveIntensity: 0.35,
      roughness: 0.35,
      metalness: 0.55,
    });
    const yokeMesh = new THREE.Mesh(yokeGeo, housingMat);
    yokeMesh.position.set(0, 0.22, 0);
    headPivot.add(yokeMesh);

    // Corpo cilindrico del faretto (coassiale sull'asse Y locale di headPivot)
    const housingGeo = new THREE.CylinderGeometry(0.18, 0.26, 0.44, 20);
    const housingMesh = new THREE.Mesh(housingGeo, housingMat);
    housingMesh.position.set(0, 0.0, 0);
    headPivot.add(housingMesh);

    // Ghiera anulare frontale sulla bocca del faretto (y = -0.22, raggio = 0.25)
    const rimRingGeo = new THREE.TorusGeometry(0.245, 0.024, 10, 24);
    const rimRingMat = new THREE.MeshStandardMaterial({
      color: 0x201b0d,
      roughness: 0.4,
      metalness: 0.5,
    });
    const rimRingMesh = new THREE.Mesh(rimRingGeo, rimRingMat);
    rimRingMesh.rotation.x = Math.PI / 2;
    rimRingMesh.position.set(0, -0.22, 0);
    headPivot.add(rimRingMesh);

    // Bulbo / Lente sferica luminosa: 100% centrata sull'asse (x = 0, z = 0) dentro la bocca del faretto!
    // Si muove e ruota solidalmente con headPivot e col cono di luce.
    const lensGeo = new THREE.SphereGeometry(0.175, 16, 12);
    const lensMat = new THREE.MeshBasicMaterial({ color: colorObj });
    const lensMesh = new THREE.Mesh(lensGeo, lensMat);
    lensMesh.scale.set(1.0, 0.68, 1.0);
    lensMesh.position.set(0, -0.19, 0);
    headPivot.add(lensMesh);

    // 2. Texture gradiente morbido per il cono volumetrico 3D
    let beamTex = null;
    let poolTex = null;
    if (typeof document !== 'undefined') {
      const bc = document.createElement('canvas');
      bc.width = 64;
      bc.height = 256;
      const bctx = bc.getContext('2d');
      if (bctx) {
        const g = bctx.createLinearGradient(0, 0, 0, 256);
        g.addColorStop(0.0, 'rgba(255,255,255,0.52)');
        g.addColorStop(0.45, 'rgba(255,255,255,0.22)');
        g.addColorStop(0.85, 'rgba(255,255,255,0.08)');
        g.addColorStop(1.0, 'rgba(255,255,255,0.0)');
        bctx.fillStyle = g;
        bctx.fillRect(0, 0, 64, 256);
        beamTex = new THREE.CanvasTexture(bc);
      }

      const pc = document.createElement('canvas');
      pc.width = 128;
      pc.height = 128;
      const pctx = pc.getContext('2d');
      if (pctx) {
        const rg = pctx.createRadialGradient(64, 64, 4, 64, 64, 60);
        rg.addColorStop(0.0, 'rgba(255,255,255,0.75)');
        rg.addColorStop(0.55, 'rgba(255,255,255,0.28)');
        rg.addColorStop(1.0, 'rgba(255,255,255,0.0)');
        pctx.fillStyle = rg;
        pctx.fillRect(0, 0, 128, 128);
        poolTex = new THREE.CanvasTexture(pc);
      }
    }

    // Tronco di cono volumetrico (raggio superiore 0.235 pari alla bocca del faretto,
    // così avvolge esattamente la sfera luminosa senza mai compenetrarla!)
    const nozzleOffsetY = -0.22;
    const coneGeo = new THREE.CylinderGeometry(0.235, 1.15, 1.0, 28, 1, true);
    coneGeo.translate(0, -0.5, 0);
    const coneMat = new THREE.MeshBasicMaterial({
      color: colorObj,
      map: beamTex,
      transparent: true,
      opacity: 0.36,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const beamMesh = new THREE.Mesh(coneGeo, coneMat);
    beamMesh.position.set(0, nozzleOffsetY, 0);
    headPivot.add(beamMesh);

    // 3. Cerchio di luce proiettato sul pavimento / gradino
    const poolGeo = new THREE.CircleGeometry(1.25, 28);
    const poolMat = new THREE.MeshBasicMaterial({
      color: colorObj,
      map: poolTex,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const poolMesh = new THREE.Mesh(poolGeo, poolMat);
    poolMesh.rotation.x = -Math.PI / 2;
    unitGroup.add(poolMesh);

    // 4. Luce puntiforme 3D reale che illumina il giocatore
    const pointLight = new THREE.PointLight(colorObj, 2.2, 7.5, 1.4);
    unitGroup.add(pointLight);

    const sourceVec = new THREE.Vector3(sourceX, sourceY, sourceZ);
    const targetVec = new THREE.Vector3();
    const dirVec = new THREE.Vector3();
    const downAxis = new THREE.Vector3(0, -1, 0);

    function aimAt(tx, ty, tz, intensity = 1.0) {
      targetVec.set(tx, ty, tz);
      dirVec.subVectors(targetVec, sourceVec);
      const dist = Math.max(0.6, dirVec.length());
      dirVec.normalize();

      // Ruota l'intero gruppo coassiale (corpo faretto + sfera bulbo + cono di luce) in blocco!
      headPivot.position.copy(sourceVec);
      headPivot.quaternion.setFromUnitVectors(downAxis, dirVec);

      // Scala solo la lunghezza del fascio lungo l'asse ottico -Y a partire dalla bocca del faretto
      const beamLength = Math.max(0.35, dist - Math.abs(nozzleOffsetY));
      beamMesh.scale.set(1.0, beamLength, 1.0);

      poolMesh.position.set(tx, ty + 0.03, tz);
      const poolScale = clamp(intensity * 0.9, 0.5, 1.35);
      poolMesh.scale.setScalar(poolScale);

      coneMat.opacity = clamp(0.32 * intensity, 0.10, 0.62);
      poolMat.opacity = clamp(0.62 * intensity, 0.18, 0.90);

      // Posiziona la PointLight leggermente sopra e davanti al bersaglio per illuminare faccia e busto!
      pointLight.position.set(tx * 0.88, ty + 1.55, tz + 0.85);
      pointLight.intensity = 2.4 * intensity;
    }

    return {
      group: unitGroup,
      headPivot,
      housingMesh,
      lensMesh,
      beamMesh,
      aimAt,
    };
  }

  /**
   * Costruisce il Mini-Palco 3D, il Podio a 3 Gradini e l'Impalcatura Scenografica a Traliccio
   * rimodulata ad hoc attorno al Logo 1:1 di Quiz-Zata! (zero stretch).
   */
  function createStageAndPodiumGroup(THREE, onTextureUpdated) {
    const stageGroup = new THREE.Group();
    stageGroup.name = 'MiniStageAndPodium3D';

    const inkMat = new THREE.MeshBasicMaterial({ color: 0x201b0d, side: THREE.BackSide });

    // 1. Pavimento Arena da Studio TV (indaco/viola reale luminoso che fa risaltare sia i personaggi sia i faretti!)
    const arenaFloorGeo = new THREE.CircleGeometry(15, 56);
    const arenaFloorMat = new THREE.MeshStandardMaterial({
      color: 0x3d2c7a,
      emissive: 0x1f1547,
      emissiveIntensity: 0.38,
      roughness: 0.42,
      metalness: 0.16,
    });
    const arenaFloor = new THREE.Mesh(arenaFloorGeo, arenaFloorMat);
    arenaFloor.rotation.x = -Math.PI / 2;
    arenaFloor.position.y = -0.01;
    arenaFloor.receiveShadow = true;
    stageGroup.add(arenaFloor);

    // Tappeto circolare interno più chiaro sotto la folla e il palco
    const innerCarpetGeo = new THREE.CircleGeometry(7.2, 56);
    const innerCarpetMat = new THREE.MeshStandardMaterial({
      color: 0x4d3996,
      emissive: 0x261a54,
      emissiveIntensity: 0.32,
      roughness: 0.45,
      metalness: 0.12,
    });
    const innerCarpet = new THREE.Mesh(innerCarpetGeo, innerCarpetMat);
    innerCarpet.rotation.x = -Math.PI / 2;
    innerCarpet.position.set(0, -0.002, -0.25);
    stageGroup.add(innerCarpet);

    // Anelli LED luminosi sul pavimento che guidano il semicerchio del pubblico
    [4.45, 5.65, 6.85].forEach((r, idx) => {
      const ringGeo = new THREE.RingGeometry(r - 0.06, r + 0.06, 56);
      const ringMat = new THREE.MeshBasicMaterial({
        color: idx === 0 ? 0xf7d708 : idx === 1 ? 0x90efef : 0xe05a47,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.78,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0, 0.005 + idx * 0.002, -0.25);
      stageGroup.add(ring);
    });

    // 2. Pedana Mini-Palco circolare rialzata
    const deckH = PODIUM_STEPS.stageDeckY;
    const stageOutlineGeo = new THREE.CylinderGeometry(3.68, 3.78, deckH + 0.02, 40);
    const stageOutline = new THREE.Mesh(stageOutlineGeo, inkMat);
    stageOutline.position.set(0, deckH / 2, -0.45);
    stageGroup.add(stageOutline);

    const stageDeckGeo = new THREE.CylinderGeometry(3.58, 3.66, deckH, 40);
    const stageDeckMat = new THREE.MeshStandardMaterial({
      color: 0x5b42a8,
      emissive: 0x281b59,
      emissiveIntensity: 0.32,
      roughness: 0.38,
      metalness: 0.16,
    });
    const stageDeck = new THREE.Mesh(stageDeckGeo, stageDeckMat);
    stageDeck.position.set(0, deckH / 2 + 0.015, -0.45);
    stageDeck.receiveShadow = true;
    stageGroup.add(stageDeck);

    // Fascia bordo frontale rossa teatro + lampadine perimetrali sul mini-palco
    const trimRingGeo = new THREE.CylinderGeometry(3.61, 3.61, 0.10, 40, 1, true);
    const trimRingMat = new THREE.MeshStandardMaterial({
      color: 0xab3425,
      roughness: 0.4,
    });
    const trimRing = new THREE.Mesh(trimRingGeo, trimRingMat);
    trimRing.position.set(0, deckH - 0.05, -0.45);
    stageGroup.add(trimRing);

    const bulbGeo = new THREE.SphereGeometry(0.065, 10, 8);
    const bulbMat = new THREE.MeshStandardMaterial({
      color: 0xf7d708,
      emissive: 0xf7d708,
      emissiveIntensity: 1.1,
      roughness: 0.2,
    });
    for (let i = 0; i < 18; i++) {
      const a = -Math.PI * 0.75 + (i / 17) * Math.PI * 1.5;
      const bulb = new THREE.Mesh(bulbGeo, bulbMat);
      bulb.position.set(Math.sin(a) * 3.63, deckH - 0.05, -0.45 + Math.cos(a) * 3.63);
      stageGroup.add(bulb);
    }

    // 3. I 3 Gradini del Podio Olimpico (1° Centro, 2° Sinistra, 3° Destra)
    const stepsConfig = [PODIUM_STEPS.first, PODIUM_STEPS.second, PODIUM_STEPS.third];
    stepsConfig.forEach((step) => {
      const stepGroup = new THREE.Group();
      stepGroup.position.set(step.x, deckH, step.z);

      const outGeo = new THREE.BoxGeometry(step.width + 0.10, step.height + 0.06, step.depth + 0.10);
      const outMesh = new THREE.Mesh(outGeo, inkMat);
      outMesh.position.y = step.height / 2;
      stepGroup.add(outMesh);

      const boxGeo = new THREE.BoxGeometry(step.width, step.height, step.depth);
      const boxMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(step.color),
        emissive: new THREE.Color(step.color),
        emissiveIntensity: 0.12,
        roughness: 0.35,
        metalness: step.rank === 1 ? 0.22 : 0.08,
      });
      const boxMesh = new THREE.Mesh(boxGeo, boxMat);
      boxMesh.position.y = step.height / 2 + 0.01;
      boxMesh.receiveShadow = true;
      stepGroup.add(boxMesh);

      const topCapGeo = new THREE.BoxGeometry(step.width + 0.06, 0.08, step.depth + 0.06);
      const topCapMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.35,
      });
      const topCap = new THREE.Mesh(topCapGeo, topCapMat);
      topCap.position.y = step.height + 0.02;
      stepGroup.add(topCap);

      const numTex = createStepNumberTexture(THREE, step.label, step.color, '#201b0d');
      const badgeRadius = step.rank === 1 ? 0.38 : 0.31;
      const badgeGeo = new THREE.CircleGeometry(badgeRadius, 24);
      const badgeMat = new THREE.MeshBasicMaterial({
        map: numTex,
        transparent: true,
      });
      const badgeMesh = new THREE.Mesh(badgeGeo, badgeMat);
      badgeMesh.position.set(0, step.height * 0.52, step.depth / 2 + 0.06);
      stepGroup.add(badgeMesh);

      stageGroup.add(stepGroup);
    });

    // 4. IMPALCATURA SCENOGRAFICA A TRALICCIO 3D RIMODULATA AD HOC PER IL LOGO 1:1 QUIZ-ZATA!
    const archGroup = new THREE.Group();
    archGroup.name = 'CustomLogoScaffolding3D';
    archGroup.position.set(0, deckH, -2.28);

    const trussSteelMat = new THREE.MeshStandardMaterial({
      color: 0x7c8ec4,
      emissive: 0x2c365e,
      emissiveIntensity: 0.42,
      roughness: 0.28,
      metalness: 0.62,
    });
    const trussGoldMat = new THREE.MeshStandardMaterial({
      color: 0xf7d708,
      emissive: 0xd49b00,
      emissiveIntensity: 0.34,
      roughness: 0.28,
      metalness: 0.35,
    });
    const trussRedMat = new THREE.MeshStandardMaterial({
      color: 0xab3425,
      emissive: 0x3a0c06,
      emissiveIntensity: 0.35,
      roughness: 0.38,
    });

    // 4a. Torri Verticali a Traliccio (Sinistra x = -3.12, Destra x = +3.12)
    const towerH = 4.38;
    const poleGeo = new THREE.CylinderGeometry(0.065, 0.065, towerH, 10);
    const rungGeo = new THREE.CylinderGeometry(0.036, 0.036, 0.32, 8);
    rungGeo.rotateZ(Math.PI / 2);
    const diagTowerGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.68, 8);
    const baseFootGeo = new THREE.BoxGeometry(0.56, 0.16, 0.44);

    [-3.12, 3.12].forEach((tx) => {
      const foot = new THREE.Mesh(baseFootGeo, trussGoldMat);
      foot.position.set(tx, 0.08, 0);
      archGroup.add(foot);

      const leftChord = new THREE.Mesh(poleGeo, trussSteelMat);
      leftChord.position.set(tx - 0.15, towerH / 2, 0);
      archGroup.add(leftChord);

      const rightChord = new THREE.Mesh(poleGeo, trussSteelMat);
      rightChord.position.set(tx + 0.15, towerH / 2, 0);
      archGroup.add(rightChord);

      for (let stepIdx = 0; stepIdx < 7; stepIdx++) {
        const ry = 0.42 + stepIdx * 0.62;
        const rung = new THREE.Mesh(rungGeo, trussGoldMat);
        rung.position.set(tx, ry, 0);
        archGroup.add(rung);

        if (stepIdx < 6) {
          const diag = new THREE.Mesh(diagTowerGeo, trussSteelMat);
          diag.position.set(tx, ry + 0.31, 0);
          diag.rotation.z = stepIdx % 2 === 0 ? 0.46 : -0.46;
          archGroup.add(diag);
        }
      }

      // Capitello luminoso in cima alla torre
      const cap = new THREE.Mesh(baseFootGeo, trussRedMat);
      cap.position.set(tx, towerH + 0.04, 0);
      archGroup.add(cap);
    });

    // 4b. Traliccio Orizzontale Continuo da Torre a Torre (x da -3.12 a +3.12)
    const fullSpanW = 6.24;
    const spanChordGeo = new THREE.CylinderGeometry(0.056, 0.056, fullSpanW, 12);
    spanChordGeo.rotateZ(Math.PI / 2);
    const wingPostGeo = new THREE.CylinderGeometry(0.036, 0.036, 0.74, 8);
    const wingDiagGeo = new THREE.CylinderGeometry(0.032, 0.032, 0.92, 8);

    const botSpanChord = new THREE.Mesh(spanChordGeo, trussSteelMat);
    botSpanChord.position.set(0, 3.58, 0);
    archGroup.add(botSpanChord);

    const topSpanChord = new THREE.Mesh(spanChordGeo, trussSteelMat);
    topSpanChord.position.set(0, 4.32, 0);
    archGroup.add(topSpanChord);

    // Pioli verticali e diagonali reticolari lungo tutta la travatura orizzontale
    for (let i = 0; i < 11; i++) {
      const px = -2.80 + i * 0.56;
      const vPost = new THREE.Mesh(wingPostGeo, trussGoldMat);
      vPost.position.set(px, 3.95, 0);
      archGroup.add(vPost);

      if (i < 10) {
        const dBar = new THREE.Mesh(wingDiagGeo, trussSteelMat);
        dBar.position.set(px + 0.28, 3.95, 0);
        dBar.rotation.z = i % 2 === 0 ? 0.66 : -0.66;
        archGroup.add(dBar);
      }

      // Lampadine da spettacolo sulle ali laterali del traliccio
      if (Math.abs(px) > 1.25) {
        const wingBulb = new THREE.Mesh(bulbGeo, bulbMat);
        wingBulb.position.set(px, 3.95, 0.10);
        archGroup.add(wingBulb);
      }
    }

    // 4c. CORONA A TRALICCIO SAGOMATA AD HOC SULLA NUVOLA DEL LOGO 1:1 QUIZ-ZATA!
    // Un anello reticolare ottagonale + staffe radiali 3D che sostengono direttamente il logo scontornato
    const logoCenterY = 4.22;
    const rx = 1.42; // Semiasse orizzontale su misura per la nuvola fumetto
    const ry = 1.18; // Semiasse verticale su misura per la nuvola fumetto
    const octPts = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      octPts.push({
        x: Math.cos(a) * rx,
        y: logoCenterY + Math.sin(a) * ry,
      });
    }

    const clampBarGeo = new THREE.CylinderGeometry(0.036, 0.036, 1.0, 8);
    for (let i = 0; i < 8; i++) {
      const pA = octPts[i];
      const pB = octPts[(i + 1) % 8];
      const mx = (pA.x + pB.x) / 2;
      const my = (pA.y + pB.y) / 2;
      const segLen = Math.hypot(pB.x - pA.x, pB.y - pA.y);
      const segAngle = Math.atan2(pB.y - pA.y, pB.x - pA.x);

      // Trave perimetrale dell'ottagono ad hoc
      const segGeo = new THREE.CylinderGeometry(0.055, 0.055, segLen + 0.06, 10);
      segGeo.rotateZ(Math.PI / 2);
      const segMesh = new THREE.Mesh(segGeo, i % 2 === 0 ? trussGoldMat : trussRedMat);
      segMesh.position.set(mx, my, 0.08);
      segMesh.rotation.z = segAngle;
      archGroup.add(segMesh);

      // Staffa radiale 3D che aggancia il logo al traliccio
      const rLen = Math.hypot(pA.x, pA.y - logoCenterY);
      const rAngle = Math.atan2(pA.y - logoCenterY, pA.x);
      const rStrut = new THREE.Mesh(clampBarGeo, trussSteelMat);
      rStrut.scale.set(1, rLen, 1);
      rStrut.position.set(pA.x * 0.5, logoCenterY + (pA.y - logoCenterY) * 0.5, 0.06);
      rStrut.rotation.z = rAngle - Math.PI / 2;
      archGroup.add(rStrut);

      // Lampadina 3D su ciascun vertice e punto medio della corona sagomata
      const vBulb = new THREE.Mesh(bulbGeo, bulbMat);
      vBulb.position.set(pA.x, pA.y, 0.16);
      archGroup.add(vBulb);

      const mBulb = new THREE.Mesh(bulbGeo, bulbMat);
      mBulb.position.set(mx, my, 0.16);
      archGroup.add(mBulb);
    }

    // Pannello Frontale Scontornato 1:1 (2.68m x 2.68m) con il Logo Ufficiale QUIZ-ZATA! (`/resources/img/LogoNoBG.png`)
    const logoSize = 2.68; // Rigorosamente 1:1 (quadrato) per zero distorsione!
    const logoTex = createQuizzataRearBannerTexture(THREE, onTextureUpdated);
    const logoPlaneGeo = new THREE.PlaneGeometry(logoSize, logoSize);
    const logoPlaneMat = new THREE.MeshBasicMaterial({
      map: logoTex,
      transparent: true,
      alphaTest: 0.02,
    });
    const logoPlane = new THREE.Mesh(logoPlaneGeo, logoPlaneMat);
    logoPlane.position.set(0, logoCenterY, 0.22);
    archGroup.add(logoPlane);

    // Luce dedicata per illuminare l'impalcatura e il logo nel buio dell'arena
    const logoPointLight = new THREE.PointLight(0xfff4cc, 1.95, 5.8, 1.3);
    logoPointLight.position.set(0, logoCenterY, 1.35);
    archGroup.add(logoPointLight);

    stageGroup.add(archGroup);

    return stageGroup;
  }

  // ===========================================================================
  // GESTIONE RENDERER 3D, INSTANCE POOL E CONTROLLO RIPRODUZIONE
  // ===========================================================================
  let threeModulePromise = null;
  function loadThreeModule() {
    if (typeof window !== 'undefined' && window.THREE) {
      return Promise.resolve(window.THREE);
    }
    if (!threeModulePromise) {
      threeModulePromise = import(/* @vite-ignore */ THREE_URL).then((mod) => {
        const T = mod.default || mod;
        if (typeof window !== 'undefined') window.THREE = T;
        return T;
      });
    }
    return threeModulePromise;
  }

  function detectSoftwareWebGL() {
    if (typeof document === 'undefined') return true;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param) || '');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    } catch (_) {
      return true;
    }
  }

  const activeInstancesByElement = new WeakMap();
  const activeInstancesSet = new Set();

  function createOrUpdateCeremonyInstance(stageEl, options = {}) {
    if (!stageEl || typeof document === 'undefined') return null;

    let inst = activeInstancesByElement.get(stageEl);
    if (inst && !options.rebuildActors) {
      return inst;
    }
    if (inst && options.rebuildActors) {
      inst.destroy();
    }

    const hostBox = document.createElement('div');
    hostBox.className = 'qz-podium-ceremony-host';
    hostBox.setAttribute('data-testid', 'podium-ceremony-3d-host');
    // Riempie il contenitore: in sala è uno strato a tutto schermo. Lo sfondo è
    // pieno da subito, prima che three.js arrivi, così sotto non si intravede
    // nulla della schermata precedente.
    hostBox.style.cssText =
      'position:relative;width:100%;height:100%;overflow:hidden;background:radial-gradient(circle at 50% 28%,#6e52c7 0%,#463091 52%,#2c1c63 100%);';

    // Overlay 2D dedicato per l'Esplosione di Coriandoli dall'Alto dello Schermo ("Confetti Explosion")
    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.className = 'qz-confetti-explosion-overlay';
    overlayCanvas.setAttribute('data-testid', 'confetti-explosion-overlay');
    overlayCanvas.width = 960;
    overlayCanvas.height = 460;
    overlayCanvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3;display:block;';
    const overlayCtx = overlayCanvas.getContext('2d');

    stageEl.innerHTML = '';
    stageEl.appendChild(hostBox);
    hostBox.appendChild(overlayCanvas);

    const initialU = clamp(Number(options.startU) || 0, 0, 1);
    const initialDurationMs = Math.max(2000, Number(options.durationMs) || DEFAULT_DURATION_MS);

    const state = {
      destroyed: false,
      paused: false,
      u: initialU,
      durationMs: initialDurationMs,
      elapsedSec: (initialU * initialDurationMs) / 1000,
      completedFired: false,
      players: Array.isArray(options.players) ? options.players : DEFAULT_PLAYERS,
      onProgress: options.onProgress || null,
      onComplete: options.onComplete || null,
      onCue: typeof options.onCue === 'function' ? options.onCue : null,
      onError: typeof options.onError === 'function' ? options.onError : null,
      resizeObserver: null,
      renderer: null,
      scene: null,
      camera: null,
      overlayCanvas,
      overlayCtx,
      particleController: createConfettiExplosionController(),
      isSoftwareGl: detectSoftwareWebGL(),
      frameId: 0,
      lastTickMs: 0,
      cuesFired: new Set(),
      actors: {
        first: null,
        second: null,
        third: null,
        trophy: null,
        crowd: [],
        confettiGroup: null,
        confettiPieces: [],
        spot1: null,
        spot2: null,
        spot3: null,
        spotCrowdL: null,
        spotCrowdR: null,
      },
      layout: null,
    };

    function applyStateTo3DScene(uVal, tSecOverride, syncOpts = {}) {
      const effectiveElapsedSec =
        tSecOverride !== undefined ? tSecOverride : state.elapsedSec;
      const snap = computeCeremonyStateAt(uVal, {
        durationMs: state.durationMs,
        elapsedSec: effectiveElapsedSec,
      });
      const tSec = snap.elapsedSec;

      if (state.camera) {
        state.camera.position.set(snap.camera.x, snap.camera.y, snap.camera.z);
        state.camera.fov = snap.camera.fov;
        state.camera.updateProjectionMatrix();
        state.camera.lookAt(snap.camera.lookX, snap.camera.lookY, snap.camera.lookZ);
      }

      // Aggiorna i Faretti 3D coassiali che girano e puntano sui giocatori!
      if (snap.spotlights) {
        if (state.actors.spot3) {
          state.actors.spot3.aimAt(
            snap.spotlights.third.x,
            snap.spotlights.third.y,
            snap.spotlights.third.z,
            snap.spotlights.third.intensity
          );
        }
        if (state.actors.spot2) {
          state.actors.spot2.aimAt(
            snap.spotlights.second.x,
            snap.spotlights.second.y,
            snap.spotlights.second.z,
            snap.spotlights.second.intensity
          );
        }
        if (state.actors.spot1) {
          state.actors.spot1.aimAt(
            snap.spotlights.first.x,
            snap.spotlights.first.y,
            snap.spotlights.first.z,
            snap.spotlights.first.intensity
          );
        }
        if (state.actors.spotCrowdL) {
          state.actors.spotCrowdL.aimAt(
            snap.spotlights.crowdLeft.x,
            snap.spotlights.crowdLeft.y,
            snap.spotlights.crowdLeft.z,
            snap.spotlights.crowdLeft.intensity
          );
        }
        if (state.actors.spotCrowdR) {
          state.actors.spotCrowdR.aimAt(
            snap.spotlights.crowdRight.x,
            snap.spotlights.crowdRight.y,
            snap.spotlights.crowdRight.z,
            snap.spotlights.crowdRight.intensity
          );
        }
      }

      // 3° Classificato (con jumpProgress e poseIntensity continui)
      if (state.actors.third) {
        const m3 = state.actors.third;
        m3.group.visible = snap.third.visible;
        if (snap.third.visible) {
          m3.group.position.set(snap.third.x, snap.third.y, snap.third.z);
          m3.applyPose(snap.third.pose, tSec, {
            spinRad: snap.third.rotY,
            jumpProgress: snap.third.jumpProgress,
            intensity: snap.third.poseIntensity ?? 1.0,
          });
          m3.setNameTagState(snap.third.nameTagVisible, snap.third.nameTagScale, state.camera);
        }
      }

      // 2° Classificato (con jumpProgress e poseIntensity continui)
      if (state.actors.second) {
        const m2 = state.actors.second;
        m2.group.visible = snap.second.visible;
        if (snap.second.visible) {
          m2.group.position.set(snap.second.x, snap.second.y, snap.second.z);
          m2.applyPose(snap.second.pose, tSec, {
            spinRad: snap.second.rotY,
            jumpProgress: snap.second.jumpProgress,
            intensity: snap.second.poseIntensity ?? 1.0,
          });
          m2.setNameTagState(snap.second.nameTagVisible, snap.second.nameTagScale, state.camera);
        }
      }

      // 1° Classificato + Coppa d'Oro 3D tenuta saldamente nella mano destra!
      if (state.actors.first) {
        const m1 = state.actors.first;
        m1.group.visible = snap.first.visible;
        if (snap.first.visible) {
          m1.group.position.set(snap.first.x, snap.first.y, snap.first.z);
          m1.applyPose(snap.first.pose, tSec, {
            spinRad: snap.first.rotY,
            jumpProgress: snap.first.jumpProgress,
            intensity: snap.first.poseIntensity ?? 1.0,
          });
          m1.setNameTagState(snap.first.nameTagVisible, snap.first.nameTagScale, state.camera);
        }
        if (state.actors.trophy) {
          state.actors.trophy.visible = snap.first.trophyVisible;
          if (snap.first.trophyVisible) {
            state.actors.trophy.scale.setScalar(snap.first.trophyScale * 0.78);
            state.actors.trophy.rotation.y = snap.first.trophySpinY;
          }
        }
      }

      // Semicerchio del Pubblico (4° classificato in poi)
      state.actors.crowd.forEach((item) => {
        item.mii.applyPose('cheer', tSec, {
          intensity: snap.crowdCheerIntensity,
          spinRad: item.placement.rotY,
        });
      });

      // Sincronizzazione e rendering Particle Effect Controller (Esplosione Coriandoli dall'Alto)
      if (state.particleController) {
        state.particleController.syncToTimeline(uVal, tSec, state.durationMs, syncOpts);
        const pDiag = state.particleController.getDiagnostics();
        snap.confettiExplosion = pDiag;

        const anyConfetti = snap.confettiActive || pDiag.isExploding;
        if (state.actors.confettiGroup) {
          state.actors.confettiGroup.visible = anyConfetti;
          if (anyConfetti) {
            state.particleController.applyTo3DMeshes(state.actors.confettiPieces, tSec);
          }
        }

        if (state.overlayCtx && state.overlayCanvas) {
          state.particleController.renderOverlay2D(
            state.overlayCtx,
            state.overlayCanvas.width,
            state.overlayCanvas.height
          );
        }
      }

      if (state.renderer && state.scene && state.camera) {
        state.renderer.render(state.scene, state.camera);
      }

      return snap;
    }

    function checkAndFireAudioCues(uVal) {
      if (state.paused) return;
      const milestones = [
        { u: 0.02, id: 'crowd_intro', cue: 'crowd_cheer' },
        { u: 0.17, id: 'hop_3', cue: 'mii_hop' },
        { u: TIMELINE.thirdLandAt, id: 'land_3', cue: 'bronze_3rd' },
        { u: 0.39, id: 'hop_2', cue: 'mii_hop' },
        { u: TIMELINE.secondLandAt, id: 'land_2', cue: 'silver_2nd' },
        { u: TIMELINE.act3End + 0.01, id: 'drum_1', cue: 'drumroll_1st' },
        { u: TIMELINE.firstJumpStartAt, id: 'hop_1', cue: 'mii_hop' },
        { u: TIMELINE.trophyPopAt, id: 'trophy_1', cue: 'trophy_fanfare' },
      ];
      milestones.forEach((m) => {
        if (uVal >= m.u && !state.cuesFired.has(m.id)) {
          state.cuesFired.add(m.id);
          if (state.onCue) state.onCue(m.cue);
          else triggerAudioCue(m.cue);
        }
      });
    }

    function scheduleNextFrame(cb) {
      if (state.destroyed) return;
      state.frameId = window.requestAnimationFrame(cb);
    }

    function tick() {
      if (state.destroyed || state.paused) return;
      const now = performance.now();
      const rawDtMs = state.lastTickMs ? clamp(now - state.lastTickMs, 4, 50) : 16.67;
      state.lastTickMs = now;
      // Filtro esponenziale morbido sul delta-time per eliminare micro-jitter del timer browser
      state.smoothedDtMs = state.smoothedDtMs
        ? state.smoothedDtMs * 0.75 + rawDtMs * 0.25
        : rawDtMs;
      const dtMs = state.smoothedDtMs;
      const dtSec = dtMs / 1000;

      // Il clock continuo avanza all'infinito anche dopo u = 1.0 (Idle Finale Infinito!)
      state.elapsedSec += dtSec;

      if (state.u < 1) {
        state.u = clamp(state.u + dtMs / state.durationMs, 0, 1);
        checkAndFireAudioCues(state.u);
      }

      if (state.particleController) {
        state.particleController.step(dtSec);
      }

      const snap = applyStateTo3DScene(state.u, state.elapsedSec, { isSeek: false });
      if (typeof state.onProgress === 'function') {
        state.onProgress(state.u, snap);
      }

      if (state.u >= 1 && !state.completedFired) {
        state.completedFired = true;
        if (typeof state.onComplete === 'function') {
          state.onComplete();
        }
      }

      // Non fermiamo mai il loop sul finale: se non è stato messo in pausa,
      // prosegue all'infinito in modalità Idle Celebrativo!
      if (!state.destroyed && !state.paused) {
        scheduleNextFrame(tick);
      }
    }

    // Inizializzazione asincrona Three.js
    loadThreeModule()
      .then((THREE) => {
        if (state.destroyed) return;
        const Mii = getMiiModule();

        const width = Math.max(320, hostBox.clientWidth || 960);
        const height = Math.max(280, hostBox.clientHeight || 460);
        overlayCanvas.width = width;
        overlayCanvas.height = height;

        const renderer = new THREE.WebGLRenderer({
          antialias: !state.isSoftwareGl,
          alpha: true,
          powerPreference: 'high-performance',
        });
        if (THREE.SRGBColorSpace) {
          renderer.outputColorSpace = THREE.SRGBColorSpace;
        }
        if (THREE.ACESFilmicToneMapping) {
          renderer.toneMapping = THREE.ACESFilmicToneMapping;
          renderer.toneMappingExposure = 1.12;
        }
        renderer.setPixelRatio(state.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height);
        renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;position:relative;z-index:1;';
        hostBox.insertBefore(renderer.domElement, overlayCanvas);

        const scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(0x382578, 0.014);
        const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 60);

        const requestAsyncRedraw = () => {
          if (!state.destroyed && state.renderer && state.scene && state.camera) {
            applyStateTo3DScene(state.u, state.elapsedSec, { isSeek: false });
          }
        };

        // Illuminazione da studio TV Show vibrante (colori ricchi ma luminosi, con i faretti ben visibili!)
        const hemiLight = new THREE.HemisphereLight(0xfff8e7, 0x4c3691, 0.78);
        scene.add(hemiLight);

        const keyLight = new THREE.DirectionalLight(0xfff4d6, 0.68);
        keyLight.position.set(4.0, 9.0, 7.5);
        scene.add(keyLight);

        const rimLight = new THREE.DirectionalLight(0x90efef, 0.52);
        rimLight.position.set(-5.0, 6.0, -4.5);
        scene.add(rimLight);

        // Palco + Podio a 3 gradini + Impalcatura a Traliccio Ad Hoc col Logo 1:1 Quiz-Zata!
        const stageAndPodium = createStageAndPodiumGroup(THREE, requestAsyncRedraw);
        scene.add(stageAndPodium);

        // 5 Faretti Motorizzati 3D Coassiali (3 per il Podio 1°/2°/3° + 2 per la Folla)
        const spot1 = createMovingSpotlightUnit(THREE, '#f7d708', 0.0, 6.8, 0.45);
        const spot2 = createMovingSpotlightUnit(THREE, '#90efef', -3.6, 6.2, 1.6);
        const spot3 = createMovingSpotlightUnit(THREE, '#f2a65a', 3.6, 6.2, 1.6);
        const spotCrowdL = createMovingSpotlightUnit(THREE, '#9b72cf', -5.4, 6.0, 3.8);
        const spotCrowdR = createMovingSpotlightUnit(THREE, '#e05a47', 5.4, 6.0, 3.8);
        scene.add(spot1.group);
        scene.add(spot2.group);
        scene.add(spot3.group);
        scene.add(spotCrowdL.group);
        scene.add(spotCrowdR.group);
        state.actors.spot1 = spot1;
        state.actors.spot2 = spot2;
        state.actors.spot3 = spot3;
        state.actors.spotCrowdL = spotCrowdL;
        state.actors.spotCrowdR = spotCrowdR;

        // Layout Podio + Semicerchio Pubblico
        const layout = computeCrowdLayout(state.players);
        state.layout = layout;

        // Creazione Mii 3°, 2° e 1° classificato (con Targhetta SOLO NOME abilitata!)
        if (layout.podium.third) {
          const m3 = Mii.createMii(THREE, layout.podium.third, {
            showNameTag: true,
            includeOutline: true,
            onTextureUpdated: requestAsyncRedraw,
          });
          scene.add(m3.group);
          state.actors.third = m3;
        }

        if (layout.podium.second) {
          const m2 = Mii.createMii(THREE, layout.podium.second, {
            showNameTag: true,
            includeOutline: true,
            onTextureUpdated: requestAsyncRedraw,
          });
          scene.add(m2.group);
          state.actors.second = m2;
        }

        if (layout.podium.first) {
          const m1 = Mii.createMii(THREE, layout.podium.first, {
            showNameTag: true,
            includeOutline: true,
            onTextureUpdated: requestAsyncRedraw,
          });
          const trophy = createGoldenTrophyCup(THREE);
          // Posizioniamo lo stelo della Coppa d'Oro direttamente nel pugno della mano destra (`propAnchor`)!
          trophy.position.set(0.08, -0.18, 0.06);
          m1.propAnchor.add(trophy);
          scene.add(m1.group);
          state.actors.first = m1;
          state.actors.trophy = trophy;
        }

        // Creazione Mii del Pubblico in Semicerchio (dal 4° classificato in giù)
        layout.crowd.forEach((placement) => {
          const crowdMii = Mii.createMii(THREE, placement.player, {
            showNameTag: false,
            includeOutline: true,
            onTextureUpdated: requestAsyncRedraw,
          });
          crowdMii.group.position.set(placement.x, placement.y, placement.z);
          crowdMii.group.rotation.y = placement.rotY;
          scene.add(crowdMii.group);
          state.actors.crowd.push({ mii: crowdMii, placement });
        });

        // Coriandoli 3D per il 1° classificato e Gran Finale
        const confettiGroup = new THREE.Group();
        const confGeo = new THREE.PlaneGeometry(0.14, 0.24);
        const confColors = [0xf7d708, 0x90efef, 0xe05a47, 0xc8f7c5, 0xf2a65a, 0xffffff];
        const confMats = confColors.map(
          (c) => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide })
        );
        for (let i = 0; i < 48; i++) {
          const mesh = new THREE.Mesh(confGeo, confMats[i % confMats.length]);
          const baseX = ((i * 0.73) % 7.2) - 3.6;
          const baseZ = ((i * 0.51) % 4.4) - 2.0;
          mesh.position.set(baseX, 6.2 + (i % 5) * 0.25, baseZ);
          confettiGroup.add(mesh);
          state.actors.confettiPieces.push({
            mesh,
            baseX,
            speed: 1.1 + (i % 5) * 0.25,
            offset: (i * 0.37) % 4.8,
            rotSpeedX: 2.2 + (i % 4),
            rotSpeedY: 1.8 + (i % 3),
          });
        }
        confettiGroup.visible = false;
        scene.add(confettiGroup);
        state.actors.confettiGroup = confettiGroup;

        state.renderer = renderer;
        state.scene = scene;
        state.camera = camera;

        // La misura del contenitore non è fissa (finestra ridimensionata, sala
        // aperta su un monitor diverso dal proiettore): renderer, camera e
        // strato dei coriandoli la seguono, altrimenti la scena si deforma.
        if (typeof ResizeObserver === 'function') {
          state.resizeObserver = new ResizeObserver(() => {
            if (state.destroyed) return;
            const w = Math.max(320, hostBox.clientWidth || width);
            const h = Math.max(280, hostBox.clientHeight || height);
            renderer.setSize(w, h);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            overlayCanvas.width = w;
            overlayCanvas.height = h;
            requestAsyncRedraw();
          });
          state.resizeObserver.observe(hostBox);
        }

        const initialSnap = applyStateTo3DScene(state.u, state.elapsedSec, {
          isSeek: state.u >= TIMELINE.trophyPopAt,
        });
        if (typeof state.onProgress === 'function') {
          state.onProgress(state.u, initialSnap);
        }

        if (!state.paused) {
          state.lastTickMs = performance.now();
          scheduleNextFrame(tick);
        }
      })
      .catch((err) => {
        // Senza three.js o senza WebGL resterebbe un riquadro vuoto davanti a
        // tutta la sala: chi ci ha chiamati decide il ripiego.
        if (state.destroyed) return;
        if (state.onError) state.onError(err);
      });

    const controller = {
      pause() {
        state.paused = true;
        if (state.frameId) {
          window.cancelAnimationFrame(state.frameId);
          window.clearTimeout(state.frameId);
          state.frameId = 0;
        }
      },
      resume() {
        if (state.destroyed) return;
        state.paused = false;
        state.lastTickMs = performance.now();
        scheduleNextFrame(tick);
      },
      seek(targetU) {
        state.u = clamp(Number(targetU) || 0, 0, 1);
        state.elapsedSec = (state.u * state.durationMs) / 1000;
        if (state.u < 1) {
          state.completedFired = false;
        }
        const snap = applyStateTo3DScene(state.u, state.elapsedSec, { isSeek: true });
        if (typeof state.onProgress === 'function') {
          state.onProgress(state.u, snap);
        }
        return snap;
      },
      triggerConfettiExplosion(burstOpts = {}) {
        if (state.destroyed || !state.particleController) return null;
        const diag = state.particleController.triggerExplosion({
          elapsedSec: state.elapsedSec,
          ...burstOpts,
        });
        // Se la scena è in pausa, avanza di un piccolo frame così l'esplosione dall'alto è subito visibile!
        if (state.paused) {
          state.particleController.step(0.08);
        }
        const snap = applyStateTo3DScene(state.u, state.elapsedSec, { isSeek: false });
        if (typeof state.onProgress === 'function') {
          state.onProgress(state.u, snap);
        }
        return diag;
      },
      getParticleDiagnostics() {
        return state.particleController ? state.particleController.getDiagnostics() : null;
      },
      cancel() {
        controller.destroy();
      },
      destroy() {
        if (state.destroyed) return;
        state.destroyed = true;
        state.paused = true;
        if (state.frameId) {
          window.cancelAnimationFrame(state.frameId);
          window.clearTimeout(state.frameId);
          state.frameId = 0;
        }
        if (state.resizeObserver) state.resizeObserver.disconnect();
        if (state.actors.first) state.actors.first.dispose();
        if (state.actors.second) state.actors.second.dispose();
        if (state.actors.third) state.actors.third.dispose();
        state.actors.crowd.forEach((c) => c.mii.dispose());
        if (state.renderer) {
          state.renderer.dispose();
          // Il contesto WebGL va rilasciato subito: il browser ne regge pochi,
          // e la sala apre anche il sipario e Tre Bicchieri nella stessa serata.
          state.renderer.forceContextLoss?.();
        }
        hostBox.remove();
        activeInstancesByElement.delete(stageEl);
        activeInstancesSet.delete(controller);
      },
    };

    activeInstancesByElement.set(stageEl, controller);
    activeInstancesSet.add(controller);
    return controller;
  }

  /**
   * Avvia l'animazione 3D della Premiazione Finale in un elemento DOM contenitore.
   */
  function play(stageEl, options = {}) {
    if (!stageEl) return null;
    const ctrl = createOrUpdateCeremonyInstance(stageEl, {
      ...options,
      rebuildActors: true,
    });
    return ctrl;
  }

  /**
   * Posiziona istantaneamente la scena 3D della Premiazione al punto `u` in `[0, 1]`.
   */
  function seek(stageEl, u, options = {}) {
    const clamped = clamp(Number(u) || 0, 0, 1);
    const snap = computeCeremonyStateAt(clamped, options);
    if (!stageEl) return snap;

    let ctrl = activeInstancesByElement.get(stageEl);
    if (!ctrl) {
      ctrl = createOrUpdateCeremonyInstance(stageEl, {
        ...options,
        startU: clamped,
        rebuildActors: true,
      });
      if (ctrl) ctrl.pause();
    } else {
      ctrl.pause();
      ctrl.seek(clamped);
    }
    return snap;
  }

  function triggerConfettiExplosion(stageEl, burstOpts = {}) {
    if (!stageEl) return null;
    const ctrl = activeInstancesByElement.get(stageEl);
    if (ctrl && typeof ctrl.triggerConfettiExplosion === 'function') {
      return ctrl.triggerConfettiExplosion(burstOpts);
    }
    return null;
  }

  function stopForElement(stageEl) {
    const ctrl = activeInstancesByElement.get(stageEl);
    if (ctrl) ctrl.destroy();
  }

  function stopAll() {
    Array.from(activeInstancesSet).forEach((ctrl) => ctrl.destroy());
    activeInstancesSet.clear();
  }

  return Object.freeze({
    ACTS_META,
    TIMELINE,
    PODIUM_STEPS,
    DEFAULT_DURATION_MS,
    DEFAULT_PLAYERS,
    computeCrowdLayout,
    computeCeremonyStateAt,
    createConfettiExplosionController,
    createMovingSpotlightUnit,
    createGoldenTrophyCup,
    play,
    seek,
    triggerConfettiExplosion,
    stopForElement,
    stopAll,
    triggerAudioCue,
    setMuted,
    isMuted,
  });
});
