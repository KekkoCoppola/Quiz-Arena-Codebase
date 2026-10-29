'use strict';

/**
 * client/shared/stage-intro.js
 *
 * Modulo condiviso per l'animazione teatrale 3D di apertura dei minigiochi
 * sul Maxischermo (Sala):
 *   - Esclusivamente 3D WebGL (Three.js) per il maxischermo di Sala
 *   - Sipario Teatrale 3D con fisica del tessuto a molla-pendolo e chiusura
 *     ermetica al centro (lembi sovrapposti senza alcuna fessura centrale)
 *   - Sequenza di illuminazione drammatica: le tende si aprono sulla Ruota 3D
 *     immersa nel buio per ~1.3s, poi un faretto di LUCE BIANCA si accende con
 *     uno scatto meccanico illuminando la ruota prima che inizi a girare
 *   - Base / Piedistallo 3D riprogettato con montante posteriore a collo d'oca
 *     e pedana ribassata sotto il bordo inferiore del tamburo (zero compenetrazioni)
 *   - Architettura Ruota 100% parametrizzata e pronta per sviluppi futuri
 *     (`buildWheelSlices`, `setWheelConfig`, `registerMinigameSlice`): supporta
 *     qualsiasi numero di spicchi (6, 8, 10, 12...) con layout dello spicchio
 *     ottimizzato automaticamente per massimizzare la visibilità del logo.
 *
 * Sicuro da caricare in Node con `require()` senza bisogno del DOM.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MinigameStageIntro = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const THREE_URL = '/shared/vendor/three/three.module.min.js';
  const CENTER_LOGO_ASSET = '/resources/img/LogoNoBG.png';
  const CENTER_LOGO_FALLBACK = '/resources/img/Logo.svg';

  /**
   * Palette "Retro Street" (DESIGN.md) usata per assegnare automaticamente
   * colori distinti agli spicchi della ruota (6, 8, 10, 12+ spicchi).
   */
  const RETRO_STREET_SLICE_PALETTE = Object.freeze([
    Object.freeze({ color: '#f7d708', textColor: '#4f4000' }), // Giallo Quiz
    Object.freeze({ color: '#90efef', textColor: '#006a6a' }), // Ciano Elettrico
    Object.freeze({ color: '#e05a47', textColor: '#fff8f1' }), // Corallo
    Object.freeze({ color: '#fff8f1', textColor: '#201b0d' }), // Crema Caldo
    Object.freeze({ color: '#f2a65a', textColor: '#201b0d' }), // Arancio Street
    Object.freeze({ color: '#006a6a', textColor: '#90efef' }), // Ottanio Profondo
    Object.freeze({ color: '#c8f7c5', textColor: '#201b0d' }), // Verde Menta
    Object.freeze({ color: '#ab3425', textColor: '#fff8f1' }), // Cremisi Teatro
  ]);

  /**
   * Catalogo predefinito dei minigiochi sulla ruota: vuoto. Questo modulo non
   * nomina nessun minigioco — la sala lo riempie all'avvio dal registry di
   * presentazione (`MinigameStageIntro.setWheelConfig({ games })`), così un
   * minigioco nuovo compare sulla ruota senza toccare questo file.
   */
  const DEFAULT_MINIGAMES = Object.freeze([]);

  /**
   * Genera dinamicamente l'array degli spicchi della ruota per qualsiasi
   * `sliceCount` (>= 2) e qualsiasi lista di minigiochi `games`.
   * Se ci sono meno giochi rispetto a `sliceCount`, i giochi vengono distribuiti
   * in modo simmetrico sulla ruota e gli spicchi rimanenti restano colorati vuoti.
   *
   * @param {{
   *   sliceCount?: number,
   *   games?: Array<{ type: string, label: string, icon?: string, color?: string, textColor?: string, sliceIndex?: number }>,
   *   slices?: Array<object>
   * }} [config]
   */
  function buildWheelSlices(config = {}) {
    if (Array.isArray(config.slices) && config.slices.length >= 2) {
      const n = config.slices.length;
      const stepDeg = 360 / n;
      return Object.freeze(
        config.slices.map((s, idx) => {
          const pal = RETRO_STREET_SLICE_PALETTE[idx % RETRO_STREET_SLICE_PALETTE.length];
          const filled = Boolean(s.filled !== undefined ? s.filled : s.type);
          return Object.freeze({
            index: idx,
            centerDeg: idx * stepDeg,
            spanDeg: stepDeg,
            type: filled ? s.type : null,
            label: filled ? s.label || '' : '',
            color: s.color || pal.color,
            textColor: s.textColor || pal.textColor,
            icon: filled ? s.icon || null : null,
            filled,
          });
        })
      );
    }

    const games = Array.isArray(config.games) ? config.games : DEFAULT_MINIGAMES;
    const count = Math.max(games.length, Number(config.sliceCount) || 6, 2);
    const stepDeg = 360 / count;

    // Mappa gli indici in cui posizionare i minigiochi attivi in modo equidistante
    const placedByIndex = new Map();
    games.forEach((g, gIdx) => {
      if (!g || !g.type) return;
      let targetIdx =
        typeof g.sliceIndex === 'number'
          ? ((g.sliceIndex % count) + count) % count
          : Math.round((gIdx * count) / games.length) % count;
      while (placedByIndex.has(targetIdx)) {
        targetIdx = (targetIdx + 1) % count;
      }
      placedByIndex.set(targetIdx, g);
    });

    const result = [];
    for (let i = 0; i < count; i++) {
      const pal = RETRO_STREET_SLICE_PALETTE[i % RETRO_STREET_SLICE_PALETTE.length];
      const game = placedByIndex.get(i);
      if (game) {
        result.push(
          Object.freeze({
            index: i,
            centerDeg: i * stepDeg,
            spanDeg: stepDeg,
            type: game.type,
            label: game.label || game.type,
            color: game.color || pal.color,
            textColor: game.textColor || pal.textColor,
            icon: game.icon || null,
            filled: true,
          })
        );
      } else {
        result.push(
          Object.freeze({
            index: i,
            centerDeg: i * stepDeg,
            spanDeg: stepDeg,
            type: null,
            label: '',
            color: pal.color,
            textColor: pal.textColor,
            icon: null,
            filled: false,
          })
        );
      }
    }

    return Object.freeze(result);
  }

  let currentSlices = buildWheelSlices({ sliceCount: 6, games: DEFAULT_MINIGAMES });

  /**
   * Durata predefinita dell'intera sequenza teatrale 3D (12000 ms = 12.0s):
   * - Atto 1 (0.00 - 0.20 ->  2.40s): Chiusura ermetica delle tende 3D + discesa del
   *                                   Cartello 3D appeso con luci 3D "È L'ORA DEL MINIGIOCO!"
   * - Atto 2 (0.20 - 0.36 ->  1.92s): Il cartello risale, apertura tende su ruota AL BUIO (~1.2s)
   *                                   + accensione del faretto di LUCE BIANCA a u=0.30
   * - Atto 3 (0.36 - 0.63 ->  3.24s): Giro ruota illuminata + zoom-in telecamera 3D
   * - Atto 4 (0.63 - 0.84 ->  2.52s): Evidenziazione del gioco scelto (2.5s) + fanfara
   * - Atto 5 (0.84 - 0.92 ->  0.96s): Chiusura ermetica e proporzionata delle tende 3D
   * - Atto 6 (0.92 - 1.00 ->  0.96s): Riapertura proporzionata sul minigioco 3D
   */
  const DEFAULT_DURATION_MS = 12000;

  /** Testo predefinito del cartello 3D appeso con luci. */
  const MARQUEE_SIGN_TEXT = "È L'ORA DEL MINIGIOCO!";

  /** Angolo iniziale della ruota prima del lancio. */
  const INITIAL_WHEEL_DEG = 205;

  const TIMELINE = Object.freeze({
    curtainClose1DoneAt: 0.055,
    marqueeDropStartAt: 0.050,
    marqueeDropFullAt: 0.088,
    marqueeHoldEndAt: 0.172,
    curtainClose1End: 0.20,
    curtainOpen1DoneAt: 0.26,
    spotlightOnAt: 0.30,
    curtainOpen1End: 0.36,
    wheelSpinEnd: 0.63,
    wheelHoldEnd: 0.84,
    curtainClose2End: 0.92,
    curtainOpen2End: 1.00,
  });

  const ACTS_META = Object.freeze([
    Object.freeze({
      act: 1,
      id: 'close_1_marquee',
      label: '1. Sipario & Cartello Luci 3D',
      shortLabel: '1. Cartello 3D',
      startU: 0.00,
      endU: TIMELINE.curtainClose1End,
      color: '#ab3425',
      description: 'Le tende si chiudono ermeticamente e cala dall’alto il cartello appeso con luci 3D «È L’ORA DEL MINIGIOCO!».',
    }),
    Object.freeze({
      act: 2,
      id: 'open_spotlight',
      label: '2. Buio & Faretto Bianco',
      shortLabel: '2. Buio + Faro Bianco',
      startU: TIMELINE.curtainClose1End,
      endU: TIMELINE.curtainOpen1End,
      color: '#f2a65a',
      description: 'Il cartello risale, le tende si aprono sulla ruota al buio (~1.2s) e poi scatta il faretto di luce bianca.',
    }),
    Object.freeze({
      act: 3,
      id: 'wheel_spin',
      label: '3. Giro Ruota & Zoom 3D',
      shortLabel: '3. Giro Ruota',
      startU: TIMELINE.curtainOpen1End,
      endU: TIMELINE.wheelSpinEnd,
      color: '#90efef',
      description: 'La ruota illuminata gira con ticchettio sui pioli mentre la telecamera 3D stringe in primo piano.',
    }),
    Object.freeze({
      act: 4,
      id: 'winner_hold',
      label: '4. Gioco Scelto (2.5s)',
      shortLabel: '4. Gioco Scelto (2.5s)',
      startU: TIMELINE.wheelSpinEnd,
      endU: TIMELINE.wheelHoldEnd,
      color: '#f7d708',
      description: '2.5 secondi pieni sullo spicchio vincente per capire quale minigioco inizia, con fanfara finale.',
    }),
    Object.freeze({
      act: 5,
      id: 'close_2',
      label: '5. Chiusura Sipario',
      shortLabel: '5. Chiusura',
      startU: TIMELINE.wheelHoldEnd,
      endU: TIMELINE.curtainClose2End,
      color: '#e05a47',
      description: 'Chiusura regolare, proporzionata ed ermetica delle tende 3D davanti alla ruota.',
    }),
    Object.freeze({
      act: 6,
      id: 'open_minigame',
      label: '6. Apertura su Minigioco 3D',
      shortLabel: '6. Apertura Gioco',
      startU: TIMELINE.curtainClose2End,
      endU: TIMELINE.curtainOpen2End,
      color: '#c8f7c5',
      description: 'Riapertura regolare e proporzionata delle tende direttamente sul palco 3D del minigioco.',
    }),
  ]);

  const activeIntros = new Map();
  let introEnabled = true;

  // ─── Funzioni matematiche pure (esportate anche per i test in Node) ──────────

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function easeOutCubic(t) {
    const u = clamp01(t);
    return 1 - Math.pow(1 - u, 3);
  }

  function easeInOutCubic(t) {
    const u = clamp01(t);
    return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  }

  /**
   * Rimbalzo elastico stile cavo teatrale quando il cartello 3D raggiunge
   * il finecorsa davanti alle tende chiuse.
   */
  function easeOutBack(t) {
    const u = clamp01(t);
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
  }

  function easeInBack(t) {
    const u = clamp01(t);
    const c1 = 1.45;
    const c3 = c1 + 1;
    return c3 * u * u * u - c1 * u * u;
  }

  function easeSuspenseWheel(t) {
    const u = clamp01(t);
    if (u <= 0.92) {
      const n = u / 0.92;
      const base = 1 - Math.pow(1 - n, 3.85);
      return base * 1.0042;
    }
    const settleT = (u - 0.92) / 0.08;
    return 1.0042 - 0.0042 * easeInOutCubic(settleT);
  }

  function getSliceIndexForType(targetType = null, slices = currentSlices) {
    const found = slices.find((s) => s.type === targetType);
    return found ? found.index : 0;
  }

  function computeWheelTargetRotation(
    targetType = null,
    fullSpins = 4,
    slices = currentSlices
  ) {
    const idx = getSliceIndexForType(targetType, slices);
    const slice = slices[idx] || slices[0];
    const turns = Math.max(2, Math.floor(fullSpins));
    const alignDeg = (360 - slice.centerDeg) % 360;
    return turns * 360 + alignDeg;
  }

  /**
   * Calcola il profilo fisico deterministico del tessuto delle tende al tempo
   * normalizzato `p` in [0, 1].
   * Garantisce che quando le tende sono chiuse (da u=0.055 a u=0.20 in Atto 1 e
   * a fine Atto 5) sia la cima sia il fondo della tenda siano a `0` (chiusura ermetica).
   */
  function computeAnalyticalCurtainPhysics(p, topOpenAmount, act) {
    let railVelocity = 0;
    let pendulumLag = 0;
    let billowZ = 0;
    let settleRipple = 0;

    if (act === 1) {
      if (p <= TIMELINE.curtainClose1DoneAt) {
        const localT = clamp01(p / TIMELINE.curtainClose1DoneAt);
        railVelocity = -3.4 * Math.sin(localT * Math.PI);
        const closeEnvelope = Math.sin(localT * Math.PI) * (1 - Math.pow(localT, 3));
        pendulumLag = closeEnvelope * 0.36;
        billowZ = Math.sin(localT * Math.PI) * 0.34;
      } else {
        // Le tende sono completamente chiuse e sigillate mentre il cartello 3D
        // "È L'ORA DEL MINIGIOCO!" scende e brilla davanti al sipario
        railVelocity = 0;
        pendulumLag = 0;
        billowZ = 0;
        settleRipple = 0;
      }
    } else if (act === 2) {
      const openDuration = TIMELINE.curtainOpen1DoneAt - TIMELINE.curtainClose1End;
      if (p <= TIMELINE.curtainOpen1DoneAt) {
        const localT = clamp01((p - TIMELINE.curtainClose1End) / openDuration);
        railVelocity = 3.2 * Math.sin(localT * Math.PI);
        pendulumLag = -Math.sin(localT * Math.PI) * 0.42;
        billowZ = Math.sin(localT * Math.PI) * 0.40;
      } else {
        // Le tende sono aperte mentre il palco è al buio e poi si accende il faretto:
        // il velluto pesante oscilla come un pendolo smorzato
        const afterOpen = p - TIMELINE.curtainOpen1DoneAt;
        const decay = Math.exp(-afterOpen * 14);
        pendulumLag = -Math.cos(afterOpen * 38) * 0.16 * decay;
        billowZ = Math.sin(afterOpen * 30) * 0.14 * decay;
        settleRipple = Math.sin(afterOpen * 42) * 0.06 * decay;
      }
    } else if (act === 3 || act === 4) {
      const elapsedAfterOpen = p - TIMELINE.curtainOpen1DoneAt;
      const decay = Math.exp(-elapsedAfterOpen * 10);
      pendulumLag = Math.cos(elapsedAfterOpen * 36) * 0.12 * decay;
      billowZ = Math.sin(elapsedAfterOpen * 30) * 0.10 * decay + 0.03 * Math.sin(p * 22);
      settleRipple = Math.sin(elapsedAfterOpen * 44) * 0.05 * decay;
    } else if (act === 5) {
      const closeT = clamp01(
        (p - TIMELINE.wheelHoldEnd) / (TIMELINE.curtainClose2End - TIMELINE.wheelHoldEnd)
      );
      railVelocity = -3.0 * Math.sin(closeT * Math.PI);
      const closeEnvelope = Math.sin(closeT * Math.PI) * (1 - Math.pow(closeT, 3));
      pendulumLag = closeEnvelope * 0.36;
      billowZ = Math.sin(closeT * Math.PI) * 0.34;
    } else if (act === 6) {
      const openT = clamp01(
        (p - TIMELINE.curtainClose2End) / (TIMELINE.curtainOpen2End - TIMELINE.curtainClose2End)
      );
      railVelocity = 3.2 * Math.sin(openT * Math.PI);
      pendulumLag = -Math.sin(openT * Math.PI) * 0.42 * (1 - Math.pow(openT, 4));
      billowZ = Math.sin(openT * Math.PI) * 0.40;
      settleRipple = openT > 0.65 ? Math.sin((openT - 0.65) * 30) * (1 - openT) * 0.12 : 0;
    }

    const bottomOpenAmount =
      topOpenAmount <= 0.001 && Math.abs(pendulumLag) < 0.005
        ? 0
        : clamp01(topOpenAmount + pendulumLag * 0.78 + settleRipple);
    const gatherCompression = 1 - topOpenAmount * 0.54;
    const pleatDepthZ = 0.16 + topOpenAmount * 0.24 + Math.abs(billowZ) * 0.30;

    return {
      topOpenAmount,
      bottomOpenAmount,
      railVelocity,
      pendulumLag,
      billowZ,
      settleRipple,
      gatherCompression,
      pleatDepthZ,
    };
  }

  /**
   * Calcola lo stato istantaneo 3D + cartello 3D con luci + fisica tende + faretto bianco
   * al progresso normalizzato `u` in `[0, 1]`. Funzione pura testabile in Node.
   */
  function computeIntroStateAt(u, targetType = null) {
    const p = clamp01(u);
    const winningSliceIndex = getSliceIndexForType(targetType, currentSlices);
    const targetDeg = computeWheelTargetRotation(targetType, 4, currentSlices);

    let act = 1;
    let curtainOpenAmount = 1;
    let wheelStageVisible = false;
    let spotlightOpacity = 0;
    let stageIllumination = 0; // 0 = ruota al buio, 1 = ruota illuminata dal faretto bianco
    let wheelDeg = INITIAL_WHEEL_DEG;
    let pointerDeflectionDeg = 0;
    let badgeVisible = false;

    // Stato del Cartello 3D appeso con luci ("È L'ORA DEL MINIGIOCO!")
    let marqueeVisible = false;
    let marqueeDropAmount = 0; // 0 = nascosto sopra la mantovana, 1 = al centro davanti alle tende chiuse
    let marqueeSwingRad = 0;
    let marqueePitchRad = 0;
    let marqueeBulbPhase = 0;

    let cameraX = 0;
    let cameraZ = 6.5;
    let cameraY = 1.25;
    let cameraLookY = 1.15;
    let cameraRollRad = 0;
    let cameraFov = 45;
    let wheelYawRad = 0;
    let suspenseIntensity = 0;
    let rimChasePhase = 0;

    if (p <= TIMELINE.curtainClose1End) {
      // Atto 1 (0.00 -> 0.20):
      // - [0.000, 0.055]: Le tende 3D si chiudono ermeticamente al centro
      // - [0.050, 0.088]: Cala dall'alto il Cartello 3D con luci "È L'ORA DEL MINIGIOCO!"
      // - [0.088, 0.172]: Il Cartello 3D resta appeso davanti alle tende chiuse con le luci 3D che lampeggiano
      // - [0.172, 0.200]: Il Cartello 3D viene issato verso l'alto prima che si aprano le tende
      act = 1;
      if (p <= TIMELINE.curtainClose1DoneAt) {
        const closeT = clamp01(p / TIMELINE.curtainClose1DoneAt);
        curtainOpenAmount = 1 - easeInOutCubic(closeT);
      } else {
        curtainOpenAmount = 0;
      }

      if (p >= TIMELINE.marqueeDropStartAt && p <= TIMELINE.curtainClose1End) {
        marqueeVisible = true;
        if (p <= TIMELINE.marqueeDropFullAt) {
          const dropT = clamp01(
            (p - TIMELINE.marqueeDropStartAt) /
              (TIMELINE.marqueeDropFullAt - TIMELINE.marqueeDropStartAt)
          );
          marqueeDropAmount = easeOutBack(dropT);
          marqueeSwingRad = Math.sin(dropT * Math.PI * 2) * 0.055 * (1 - dropT * 0.4);
          marqueePitchRad = Math.sin(dropT * Math.PI) * 0.08;
        } else if (p <= TIMELINE.marqueeHoldEndAt) {
          const holdT = clamp01(
            (p - TIMELINE.marqueeDropFullAt) /
              (TIMELINE.marqueeHoldEndAt - TIMELINE.marqueeDropFullAt)
          );
          const damp = Math.exp(-holdT * 3.2);
          marqueeDropAmount = 1 + Math.sin(holdT * Math.PI * 3) * 0.015 * damp;
          marqueeSwingRad = Math.cos(holdT * Math.PI * 4) * 0.032 * damp;
          marqueePitchRad = Math.sin(holdT * Math.PI * 3) * 0.025 * damp;
        } else {
          const liftT = clamp01(
            (p - TIMELINE.marqueeHoldEndAt) /
              (TIMELINE.curtainClose1End - TIMELINE.marqueeHoldEndAt)
          );
          marqueeDropAmount = Math.max(0, 1 - easeInBack(liftT));
          marqueeSwingRad = -Math.sin(liftT * Math.PI) * 0.03;
          marqueePitchRad = -Math.sin(liftT * Math.PI) * 0.05;
          if (marqueeDropAmount <= 0.002) {
            marqueeVisible = false;
          }
        }
        marqueeBulbPhase = (p - TIMELINE.marqueeDropStartAt) * 95;
      }

      wheelStageVisible = false;
      spotlightOpacity = 0;
      stageIllumination = 0;
      cameraZ = lerp(6.55, 6.18, clamp01(p / TIMELINE.curtainClose1End));
      cameraY = 1.25;
      cameraLookY = 1.18;
    } else if (p <= TIMELINE.curtainOpen1End) {
      // Atto 2 (0.20 -> 0.36):
      // - [0.20, 0.26]: le tende si aprono sul palco BUIO (la ruota è in ombra!)
      // - [0.26, 0.30]: pausa di suspense con la ruota al buio (~1.2s totali di buio dall'inizio dell'atto)
      // - [0.30, 0.36]: CLACK! Si accende il faretto di LUCE BIANCA che illumina la ruota!
      act = 2;
      wheelStageVisible = true;
      const openPhaseT = clamp01(
        (p - TIMELINE.curtainClose1End) /
          (TIMELINE.curtainOpen1DoneAt - TIMELINE.curtainClose1End)
      );
      const easedOpen = easeInOutCubic(openPhaseT);
      curtainOpenAmount = easedOpen * 0.84;

      const actLocalT = clamp01(
        (p - TIMELINE.curtainClose1End) / (TIMELINE.curtainOpen1End - TIMELINE.curtainClose1End)
      );
      cameraX = lerp(0, -0.72, easeInOutCubic(actLocalT));
      cameraZ = lerp(6.18, 5.65, easeInOutCubic(actLocalT));
      cameraY = lerp(1.25, 1.18, actLocalT);
      cameraLookY = lerp(1.18, 1.20, actLocalT);
      wheelYawRad = lerp(0, 0.24, easeInOutCubic(actLocalT));

      if (p >= TIMELINE.spotlightOnAt) {
        const spotT = clamp01(
          (p - TIMELINE.spotlightOnAt) / (TIMELINE.curtainOpen1End - TIMELINE.spotlightOnAt)
        );
        const ignitionBoost = spotT < 0.22 ? (spotT / 0.22) * 0.92 : 1;
        spotlightOpacity = clamp01(ignitionBoost);
        stageIllumination = spotlightOpacity;
      } else {
        spotlightOpacity = 0;
        stageIllumination = 0;
      }
    } else if (p <= TIMELINE.wheelSpinEnd) {
      // Atto 3 (0.36 -> 0.63): La ruota illuminata dal faretto bianco gira con zoom 3D
      act = 3;
      wheelStageVisible = true;
      curtainOpenAmount = 0.84;
      spotlightOpacity = 1;
      stageIllumination = 1;

      const spinT = clamp01(
        (p - TIMELINE.curtainOpen1End) / (TIMELINE.wheelSpinEnd - TIMELINE.curtainOpen1End)
      );
      const eased = easeSuspenseWheel(spinT);
      wheelDeg = INITIAL_WHEEL_DEG + (targetDeg - INITIAL_WHEEL_DEG) * eased;

      const zoomEase = easeInOutCubic(clamp01(spinT * 1.05));
      cameraX = lerp(-0.72, 0, zoomEase);
      cameraZ = lerp(5.65, 3.35, zoomEase);
      cameraY = lerp(1.18, 2.04, zoomEase);
      cameraLookY = lerp(1.20, 1.96, zoomEase);
      cameraFov = lerp(45, 39, zoomEase);
      wheelYawRad = lerp(0.24, 0.03, zoomEase);

      suspenseIntensity = spinT > 0.50 ? Math.sin(clamp01((spinT - 0.50) / 0.50) * Math.PI) : 0;
      cameraRollRad = Math.sin(spinT * Math.PI * 5) * 0.018 * suspenseIntensity;
      rimChasePhase = wheelDeg / 15;

      const pegCount = Math.max(12, currentSlices.length * 2);
      const pegStepDeg = 360 / pegCount;
      const pegPhase = ((wheelDeg % pegStepDeg) + pegStepDeg) % pegStepDeg;
      const speedFactor = spinT < 0.92 ? Math.max(0.28, 1 - spinT * 0.65) : 0.15;
      if (pegPhase < pegStepDeg * 0.36) {
        pointerDeflectionDeg =
          -Math.sin((pegPhase / (pegStepDeg * 0.36)) * Math.PI) * 34 * speedFactor;
      }
    } else if (p <= TIMELINE.wheelHoldEnd) {
      // Atto 4 (0.63 -> 0.84, 2.52 secondi): Evidenziazione del minigioco scelto
      act = 4;
      wheelStageVisible = true;
      curtainOpenAmount = 0.84;
      spotlightOpacity = 1;
      stageIllumination = 1;
      wheelDeg = targetDeg;
      badgeVisible = true;

      const holdT = clamp01(
        (p - TIMELINE.wheelSpinEnd) / (TIMELINE.wheelHoldEnd - TIMELINE.wheelSpinEnd)
      );
      cameraX = Math.sin(holdT * Math.PI * 2) * 0.035;
      cameraZ = lerp(3.35, 3.16, easeOutCubic(holdT));
      cameraY = 2.04;
      cameraLookY = 1.96;
      cameraFov = 38.5;
      wheelYawRad = Math.sin(holdT * Math.PI * 2) * 0.02;
      rimChasePhase = Math.floor(holdT * 18);
    } else if (p <= TIMELINE.curtainClose2End) {
      // Atto 5 (0.84 -> 0.92): Chiusura regolare ed ermetica delle tende 3D
      act = 5;
      wheelStageVisible = true;
      badgeVisible = true;
      wheelDeg = targetDeg;
      const closeT = clamp01(
        (p - TIMELINE.wheelHoldEnd) / (TIMELINE.curtainClose2End - TIMELINE.wheelHoldEnd)
      );
      const easedClose = easeInOutCubic(closeT);
      curtainOpenAmount = 0.84 * (1 - easedClose);
      spotlightOpacity = 1 - closeT * 0.65;
      stageIllumination = spotlightOpacity;
      cameraX = 0;
      cameraZ = lerp(3.16, 5.85, easedClose);
      cameraY = lerp(2.04, 1.25, easedClose);
      cameraLookY = lerp(1.96, 1.15, easedClose);
      cameraFov = lerp(38.5, 45, easedClose);
      wheelYawRad = 0;
    } else {
      // Atto 6 (0.92 -> 1.00): Riapertura regolare sul palco 3D del minigioco
      act = 6;
      wheelStageVisible = false;
      badgeVisible = false;
      spotlightOpacity = 0;
      stageIllumination = 0;
      wheelDeg = targetDeg;
      const openT = clamp01(
        (p - TIMELINE.curtainClose2End) / (TIMELINE.curtainOpen2End - TIMELINE.curtainClose2End)
      );
      curtainOpenAmount = easeInOutCubic(openT);
      cameraX = 0;
      cameraZ = 6.2;
      cameraY = 1.25;
      cameraLookY = 1.15;
      cameraFov = 45;
      wheelYawRad = 0;
    }

    const curtainPhysics = computeAnalyticalCurtainPhysics(p, curtainOpenAmount, act);

    return {
      progress: p,
      act,
      curtainOpenAmount,
      curtainPhysics,
      marqueeVisible,
      marqueeDropAmount,
      marqueeSwingRad,
      marqueePitchRad,
      marqueeBulbPhase,
      marqueeText: MARQUEE_SIGN_TEXT,
      wheelStageVisible,
      spotlightOpacity,
      stageIllumination,
      wheelDeg,
      pointerDeflectionDeg,
      badgeVisible,
      winningSliceIndex,
      sliceCount: currentSlices.length,
      cameraX,
      cameraZ,
      cameraY,
      cameraLookY,
      cameraRollRad,
      cameraFov,
      wheelYawRad,
      suspenseIntensity,
      rimChasePhase,
    };
  }

  // ─── Motore Audio Procedurale Web Audio API (Zero dipendenze esterne) ───────

  let audioCtx = null;
  let audioMuted = false;
  let noiseBuffer = null;

  function getAudioContext() {
    if (audioMuted || typeof window === 'undefined') return null;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!audioCtx) {
      try {
        audioCtx = new Ctor();
      } catch {
        return null;
      }
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function ensureNoiseBuffer(ctx) {
    if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
    const length = Math.floor(ctx.sampleRate * 1.2);
    const buf = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.045 * white) / 1.045;
      data[i] = last * 2.8;
    }
    noiseBuffer = buf;
    return noiseBuffer;
  }

  function playSynthNote(ctx, freq, startOffset, duration, type = 'triangle', peakGain = 0.12) {
    const now = ctx.currentTime + Math.max(0, startOffset);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peakGain, now + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  function sfxCurtainMovement(mode = 'open') {
    const ctx = getAudioContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = ensureNoiseBuffer(ctx);

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.setValueAtTime(1.8, now);
      if (mode === 'open') {
        filter.frequency.setValueAtTime(260, now);
        filter.frequency.exponentialRampToValueAtTime(920, now + 0.72);
      } else {
        filter.frequency.setValueAtTime(780, now);
        filter.frequency.exponentialRampToValueAtTime(240, now + 0.68);
      }

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.16, now + 0.18);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.78);

      src.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      src.start(now);
      src.stop(now + 0.82);
    } catch {
      // Ignora se bloccato da autoplay
    }

    if (mode === 'open') {
      const notes = [
        { f: 261.63, t: 0.00, d: 0.16, g: 0.10 },
        { f: 329.63, t: 0.09, d: 0.16, g: 0.10 },
        { f: 392.00, t: 0.18, d: 0.18, g: 0.11 },
        { f: 440.00, t: 0.27, d: 0.18, g: 0.11 },
        { f: 523.25, t: 0.36, d: 0.42, g: 0.13 },
        { f: 659.25, t: 0.36, d: 0.42, g: 0.09 },
      ];
      for (const n of notes) {
        playSynthNote(ctx, n.f, n.t, n.d, 'triangle', n.g);
        playSynthNote(ctx, n.f * 0.5, n.t, n.d * 0.9, 'sawtooth', n.g * 0.35);
      }
    } else {
      playSynthNote(ctx, 392.00, 0.00, 0.22, 'triangle', 0.08);
      playSynthNote(ctx, 329.63, 0.10, 0.24, 'triangle', 0.08);
      playSynthNote(ctx, 261.63, 0.20, 0.36, 'triangle', 0.09);
    }
  }

  /**
   * Effetto sonoro per la discesa del Cartello 3D appeso con luci
   * ("È L'ORA DEL MINIGIOCO!"): carrucola teatrale + jingle luminoso Broadway.
   */
  function sfxMarqueeDrop() {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    // Glissando di discesa cavi + rimbalzo elastico
    const dropOsc = ctx.createOscillator();
    const dropGain = ctx.createGain();
    dropOsc.type = 'sine';
    dropOsc.frequency.setValueAtTime(640, now);
    dropOsc.frequency.exponentialRampToValueAtTime(195, now + 0.22);
    dropOsc.frequency.linearRampToValueAtTime(245, now + 0.30);
    dropGain.gain.setValueAtTime(0.001, now);
    dropGain.gain.linearRampToValueAtTime(0.14, now + 0.04);
    dropGain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
    dropOsc.connect(dropGain);
    dropGain.connect(ctx.destination);
    dropOsc.start(now);
    dropOsc.stop(now + 0.34);

    // Jingle scintillante delle lampadine 3D del cartello ("È l'ora del minigioco!")
    const sparkleNotes = [
      { f: 523.25, t: 0.16, d: 0.16, g: 0.12 }, // C5
      { f: 659.25, t: 0.23, d: 0.16, g: 0.12 }, // E5
      { f: 783.99, t: 0.30, d: 0.18, g: 0.13 }, // G5
      { f: 1046.50, t: 0.38, d: 0.48, g: 0.15 }, // C6
      { f: 783.99, t: 0.38, d: 0.46, g: 0.10 },  // G5
      { f: 523.25, t: 0.38, d: 0.46, g: 0.09 },  // C5
    ];
    for (const n of sparkleNotes) {
      playSynthNote(ctx, n.f, n.t, n.d, 'triangle', n.g);
      playSynthNote(ctx, n.f * 2, n.t + 0.01, n.d * 0.6, 'sine', n.g * 0.35);
    }
  }

  function sfxSpotlightIgnition() {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const clickOsc = ctx.createOscillator();
    const clickGain = ctx.createGain();
    clickOsc.type = 'square';
    clickOsc.frequency.setValueAtTime(210, now);
    clickOsc.frequency.exponentialRampToValueAtTime(48, now + 0.075);
    clickGain.gain.setValueAtTime(0.25, now);
    clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.085);
    clickOsc.connect(clickGain);
    clickGain.connect(ctx.destination);
    clickOsc.start(now);
    clickOsc.stop(now + 0.09);

    playSynthNote(ctx, 1320, 0.04, 0.045, 'triangle', 0.14);
    playSynthNote(ctx, 110, 0.05, 0.52, 'sawtooth', 0.05);
    playSynthNote(ctx, 587.33, 0.06, 0.38, 'sine', 0.09);
    playSynthNote(ctx, 880.00, 0.10, 0.45, 'sine', 0.08);
  }

  function sfxWheelPegClick(speedFactor = 1) {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const pitchBase = 520 + clamp01(1 - speedFactor) * 280;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(pitchBase, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.038);

    gain.gain.setValueAtTime(0.16, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.042);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.048);

    playSynthNote(ctx, pitchBase * 2.1, 0, 0.022, 'sine', 0.06);
  }

  function sfxWinnerFanfare() {
    const ctx = getAudioContext();
    if (!ctx) return;

    const melody = [
      { f: 392.00, t: 0.00, d: 0.15, g: 0.13 },
      { f: 523.25, t: 0.13, d: 0.15, g: 0.13 },
      { f: 659.25, t: 0.26, d: 0.15, g: 0.14 },
      { f: 783.99, t: 0.39, d: 0.30, g: 0.15 },
      { f: 659.25, t: 0.72, d: 0.16, g: 0.13 },
      { f: 783.99, t: 0.90, d: 0.95, g: 0.15 },
      { f: 1046.50, t: 0.90, d: 1.05, g: 0.14 },
      { f: 523.25, t: 0.90, d: 1.05, g: 0.11 },
    ];

    for (const n of melody) {
      playSynthNote(ctx, n.f, n.t, n.d, 'triangle', n.g);
      playSynthNote(ctx, n.f * 0.5, n.t, n.d * 0.95, 'sawtooth', n.g * 0.38);
    }
  }

  function triggerAudioCue(cueName) {
    if (cueName === 'curtain_open') sfxCurtainMovement('open');
    else if (cueName === 'curtain_close') sfxCurtainMovement('close');
    else if (cueName === 'marquee_sign') sfxMarqueeDrop();
    else if (cueName === 'spotlight') sfxSpotlightIgnition();
    else if (cueName === 'wheel_tick') sfxWheelPegClick(0.6);
    else if (cueName === 'winner_fanfare') sfxWinnerFanfare();
  }

  // ─── Motore 3D Three.js condiviso per il Palco, le Tende e la Ruota ─────────

  let THREE = null;
  let threeLoadPromise = null;
  let sharedIntroRenderer = null;
  let sharedIntroCanvas = null;
  let cachedIntro3D = null;
  let wheelFaceCanvas = null;
  let wheelFaceTexture = null;
  let hubLogoCanvas = null;
  let hubLogoTexture = null;
  let curtainVelvetCanvas = null;
  let curtainVelvetTexture = null;
  let marqueeSignCanvas = null;
  let marqueeSignTexture = null;
  const loadedIcons = new Map();
  const pendingIconUrls = new Set();

  const liveCurtainSim = {
    initialized: false,
    lastTimeMs: 0,
    prevTopOpen: 1,
    bottomOpen: 1,
    bottomVel: 0,
    midOpen: 1,
    midVel: 0,
    billowZ: 0,
    billowVel: 0,
    waveTime: 0,
  };

  function resetLiveCurtainSim(initialOpen = 1) {
    liveCurtainSim.initialized = true;
    liveCurtainSim.lastTimeMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    liveCurtainSim.prevTopOpen = initialOpen;
    liveCurtainSim.bottomOpen = initialOpen;
    liveCurtainSim.bottomVel = 0;
    liveCurtainSim.midOpen = initialOpen;
    liveCurtainSim.midVel = 0;
    liveCurtainSim.billowZ = 0;
    liveCurtainSim.billowVel = 0;
  }

  function stepLiveCurtainPhysics(targetTopOpen, analyticalPhysics, isScrubbing) {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!liveCurtainSim.initialized || isScrubbing) {
      liveCurtainSim.initialized = true;
      liveCurtainSim.lastTimeMs = nowMs;
      liveCurtainSim.prevTopOpen = targetTopOpen;
      liveCurtainSim.bottomOpen = analyticalPhysics.bottomOpenAmount;
      liveCurtainSim.midOpen =
        lerp(targetTopOpen, analyticalPhysics.bottomOpenAmount, 0.62) +
        analyticalPhysics.pendulumLag * 0.18;
      liveCurtainSim.bottomVel = 0;
      liveCurtainSim.midVel = 0;
      liveCurtainSim.billowZ = analyticalPhysics.billowZ;
      liveCurtainSim.billowVel = 0;
      liveCurtainSim.waveTime += 0.08;
      return {
        topOpen: targetTopOpen,
        midOpen: targetTopOpen <= 0.002 ? 0 : liveCurtainSim.midOpen,
        bottomOpen: targetTopOpen <= 0.002 ? 0 : liveCurtainSim.bottomOpen,
        billowZ: liveCurtainSim.billowZ,
        settleRipple: analyticalPhysics.settleRipple,
        waveTime: liveCurtainSim.waveTime,
      };
    }

    const dt = Math.min(0.05, Math.max(0.004, (nowMs - liveCurtainSim.lastTimeMs) / 1000));
    liveCurtainSim.lastTimeMs = nowMs;
    liveCurtainSim.waveTime += dt * 5.2;

    const topVel = (targetTopOpen - liveCurtainSim.prevTopOpen) / dt;
    liveCurtainSim.prevTopOpen = targetTopOpen;

    const midStiffness = 38;
    const midDamping = 5.2;
    const midForce =
      (targetTopOpen - liveCurtainSim.midOpen) * midStiffness -
      liveCurtainSim.midVel * midDamping -
      topVel * 0.45;
    liveCurtainSim.midVel += midForce * dt;
    liveCurtainSim.midOpen += liveCurtainSim.midVel * dt;

    const botStiffness = 26;
    const botDamping = 3.8;
    const botForce =
      (liveCurtainSim.midOpen - liveCurtainSim.bottomOpen) * botStiffness -
      liveCurtainSim.bottomVel * botDamping -
      topVel * 0.58;
    liveCurtainSim.bottomVel += botForce * dt;
    liveCurtainSim.bottomOpen += liveCurtainSim.bottomVel * dt;

    // Quando i binari superiori sono completamente chiusi (targetTopOpen === 0),
    // smorziamo rapidamente il lembo inferiore verso 0 per garantire tenuta ermetica
    if (targetTopOpen <= 0.005) {
      liveCurtainSim.midOpen = Math.max(0, liveCurtainSim.midOpen * 0.72);
      liveCurtainSim.bottomOpen = Math.max(0, liveCurtainSim.bottomOpen * 0.72);
      if (liveCurtainSim.bottomOpen < 0.015) {
        liveCurtainSim.midOpen = 0;
        liveCurtainSim.bottomOpen = 0;
      }
    }

    const targetBillow =
      Math.min(0.46, Math.abs(topVel) * 0.22 + Math.abs(liveCurtainSim.bottomVel) * 0.16) *
      (topVel >= 0 ? 1 : 0.9);
    const billowForce =
      (targetBillow - liveCurtainSim.billowZ) * 32 - liveCurtainSim.billowVel * 4.5;
    liveCurtainSim.billowVel += billowForce * dt;
    liveCurtainSim.billowZ += liveCurtainSim.billowVel * dt;

    return {
      topOpen: targetTopOpen,
      midOpen: liveCurtainSim.midOpen,
      bottomOpen: liveCurtainSim.bottomOpen,
      billowZ: liveCurtainSim.billowZ,
      settleRipple: (liveCurtainSim.bottomOpen - targetTopOpen) * 0.55,
      waveTime: liveCurtainSim.waveTime,
    };
  }

  function loadThree() {
    if (THREE) return Promise.resolve(THREE);
    if (threeLoadPromise) return threeLoadPromise;
    if (typeof window === 'undefined') return Promise.resolve(null);

    threeLoadPromise = import(THREE_URL)
      .then((mod) => {
        THREE = mod.default ? Object.assign({}, mod, mod.default) : mod;
        if (wheelFaceCanvas && !wheelFaceTexture) {
          buildOrUpdateWheelTextures();
        }
        return THREE;
      })
      .catch(() => null);

    return threeLoadPromise;
  }

  function preloadWheelImages() {
    if (typeof Image === 'undefined') return;

    const urls = new Set([
      CENTER_LOGO_ASSET,
      CENTER_LOGO_FALLBACK,
    ]);
    for (const s of currentSlices) {
      if (s.icon) urls.add(s.icon);
    }

    urls.forEach((url) => {
      if (!url || loadedIcons.has(url) || pendingIconUrls.has(url)) return;
      pendingIconUrls.add(url);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        pendingIconUrls.delete(url);
        loadedIcons.set(url, img);
        paintWheelFaceCanvas();
        paintHubLogoCanvas();
      };
      img.onerror = () => {
        pendingIconUrls.delete(url);
      };
      img.src = url;
    });
  }

  function paintCurtainVelvetCanvas() {
    if (typeof document === 'undefined') return null;
    if (!curtainVelvetCanvas) {
      curtainVelvetCanvas = document.createElement('canvas');
      curtainVelvetCanvas.width = 512;
      curtainVelvetCanvas.height = 512;
    }
    const ctx = curtainVelvetCanvas.getContext('2d');
    if (!ctx) return curtainVelvetCanvas;

    const w = 512;
    const h = 512;
    const folds = 10;
    const foldW = w / folds;

    for (let i = 0; i < folds; i++) {
      const x0 = i * foldW;
      const grad = ctx.createLinearGradient(x0, 0, x0 + foldW, 0);
      grad.addColorStop(0.0, '#781d13');
      grad.addColorStop(0.22, '#ab3425');
      grad.addColorStop(0.5, i % 2 === 0 ? '#e05a47' : '#c94332');
      grad.addColorStop(0.78, '#ab3425');
      grad.addColorStop(1.0, '#6e1910');
      ctx.fillStyle = grad;
      ctx.fillRect(x0, 0, foldW + 1, h);

      ctx.fillStyle = '#201b0d';
      ctx.fillRect(x0, 0, 4, h);
    }

    ctx.fillStyle = '#201b0d';
    ctx.fillRect(0, 0, 10, h);
    ctx.fillRect(w - 10, 0, 10, h);

    ctx.fillStyle = '#201b0d';
    ctx.fillRect(0, h - 42, w, 42);
    ctx.fillStyle = '#f7d708';
    ctx.fillRect(0, h - 34, w, 26);

    if (curtainVelvetTexture) {
      curtainVelvetTexture.needsUpdate = true;
    }
    return curtainVelvetCanvas;
  }

  /**
   * Disegna la texture 1024x1024 ad alta definizione del quadrante della Ruota 3D,
   * adattando automaticamente la geometria del medaglione port-logo e dell'etichetta
   * al numero di spicchi `currentSlices.length` (6, 8, 10, 12+ spicchi).
   */
  function paintWheelFaceCanvas() {
    if (typeof document === 'undefined') return null;
    if (!wheelFaceCanvas) {
      wheelFaceCanvas = document.createElement('canvas');
      wheelFaceCanvas.width = 1024;
      wheelFaceCanvas.height = 1024;
    }
    const ctx = wheelFaceCanvas.getContext('2d');
    if (!ctx) return wheelFaceCanvas;

    const size = 1024;
    const cx = size / 2;
    const cy = size / 2;
    const outerR = 492;
    const sliceCount = currentSlices.length;
    const halfSpanDeg = 180 / sliceCount;
    const halfSpanRad = (halfSpanDeg * Math.PI) / 180;

    ctx.clearRect(0, 0, size, size);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, outerR + 14, 0, Math.PI * 2);
    ctx.fillStyle = '#201b0d';
    ctx.fill();
    ctx.restore();

    // Calcolo automatico della posizione e dimensione del medaglione port-logo:
    // senza testo nello spicchio, il logo può occupare il centro geometrico ottimale
    // dello spicchio ed essere ancora più grande e leggibile anche con 8, 10 o 12 spicchi!
    const badgeRadiusDist = sliceCount <= 6 ? 296 : sliceCount <= 8 ? 308 : 322;
    const maxChordHalf = badgeRadiusDist * Math.sin(halfSpanRad);
    const badgeR = Math.min(124, Math.max(52, Math.floor(maxChordHalf * 0.78)));
    const badgeY = -badgeRadiusDist;

    for (let i = 0; i < sliceCount; i++) {
      const s = currentSlices[i];
      const startRad = ((s.centerDeg - halfSpanDeg - 90) * Math.PI) / 180;
      const endRad = ((s.centerDeg + halfSpanDeg - 90) * Math.PI) / 180;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, outerR, startRad, endRad, false);
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();

      // Fascia decorativa esterna dello spicchio
      ctx.beginPath();
      ctx.arc(cx, cy, outerR - 24, startRad + 0.02, endRad - 0.02, false);
      ctx.strokeStyle = 'rgba(32, 27, 13, 0.16)';
      ctx.lineWidth = 10;
      ctx.stroke();

      // Contorno netto color inchiostro (#201b0d)
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, outerR, startRad, endRad, false);
      ctx.closePath();
      ctx.lineWidth = sliceCount <= 8 ? 12 : 9;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#201b0d';
      ctx.stroke();
      ctx.restore();

      if (s.filled) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((s.centerDeg * Math.PI) / 180);

        // Ombra netta offset del medaglione port-logo
        ctx.beginPath();
        ctx.arc(8, badgeY + 8, badgeR, 0, Math.PI * 2);
        ctx.fillStyle = '#201b0d';
        ctx.fill();

        // Disco bianco ad alto contrasto ottimizzato esclusivamente per il logo
        ctx.beginPath();
        ctx.arc(0, badgeY, badgeR, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = Math.max(8, Math.round(badgeR * 0.095));
        ctx.strokeStyle = '#201b0d';
        ctx.stroke();

        // Anello interno sottile del colore dello spicchio per incorniciare il logo
        ctx.beginPath();
        ctx.arc(0, badgeY, badgeR - 11, 0, Math.PI * 2);
        ctx.strokeStyle = s.color === '#ffffff' || s.color === '#fff8f1' ? '#f7d708' : s.color;
        ctx.lineWidth = 4.5;
        ctx.stroke();

        const iconImg = s.icon ? loadedIcons.get(s.icon) : null;
        if (iconImg) {
          const iconSize = Math.round(badgeR * 1.44);
          ctx.drawImage(iconImg, -iconSize / 2, badgeY - iconSize / 2, iconSize, iconSize);
        } else {
          // Icona geometrica a stella/emblema di fallback finché l'immagine del logo carica
          ctx.fillStyle = s.index % 2 === 0 ? '#e05a47' : '#006a6a';
          ctx.beginPath();
          ctx.arc(0, badgeY, Math.round(badgeR * 0.48), 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = 7;
          ctx.strokeStyle = '#201b0d';
          ctx.stroke();
        }

        ctx.restore();
      } else {
        // Spicchi colorati vuoti: bollo decorativo centrato nello spicchio
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((s.centerDeg * Math.PI) / 180);
        ctx.beginPath();
        ctx.arc(0, badgeY, Math.max(16, Math.round(badgeR * 0.20)), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 248, 241, 0.48)';
        ctx.fill();
        ctx.lineWidth = 6;
        ctx.strokeStyle = '#201b0d';
        ctx.stroke();
        ctx.restore();
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 114, 0, Math.PI * 2);
    ctx.fillStyle = '#f7d708';
    ctx.fill();
    ctx.lineWidth = 12;
    ctx.strokeStyle = '#201b0d';
    ctx.stroke();
    ctx.restore();

    if (wheelFaceTexture) {
      wheelFaceTexture.needsUpdate = true;
    }
    return wheelFaceCanvas;
  }

  function paintHubLogoCanvas() {
    if (typeof document === 'undefined') return null;
    if (!hubLogoCanvas) {
      hubLogoCanvas = document.createElement('canvas');
      hubLogoCanvas.width = 512;
      hubLogoCanvas.height = 512;
    }
    const ctx = hubLogoCanvas.getContext('2d');
    if (!ctx) return hubLogoCanvas;

    const size = 512;
    const cx = size / 2;
    const cy = size / 2;
    ctx.clearRect(0, 0, size, size);

    ctx.beginPath();
    ctx.arc(cx, cy, 240, 0, Math.PI * 2);
    ctx.fillStyle = '#fff8f1';
    ctx.fill();
    ctx.lineWidth = 18;
    ctx.strokeStyle = '#201b0d';
    ctx.stroke();

    const logoImg =
      loadedIcons.get(CENTER_LOGO_ASSET) || loadedIcons.get(CENTER_LOGO_FALLBACK);
    if (logoImg) {
      const pad = 44;
      ctx.drawImage(logoImg, pad, pad, size - pad * 2, size - pad * 2);
    } else {
      ctx.fillStyle = '#f7d708';
      ctx.font = '900 72px "Quicksand", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = '#201b0d';
      ctx.lineWidth = 14;
      ctx.strokeText('QUIZ', cx, cy - 34);
      ctx.fillText('QUIZ', cx, cy - 34);
      ctx.strokeText('ZATA!', cx, cy + 42);
      ctx.fillText('ZATA!', cx, cy + 42);
    }

    if (hubLogoTexture) {
      hubLogoTexture.needsUpdate = true;
    }
    return hubLogoCanvas;
  }

  /**
   * Disegna il pannello frontale 1024x512 ad alto contrasto del Cartello 3D
   * appeso con luci: "È L'ORA DEL MINIGIOCO!" in stile Retro Street.
   */
  function paintMarqueeSignCanvas() {
    if (typeof document === 'undefined') return null;
    if (!marqueeSignCanvas) {
      marqueeSignCanvas = document.createElement('canvas');
      marqueeSignCanvas.width = 1024;
      marqueeSignCanvas.height = 512;
    }
    const ctx = marqueeSignCanvas.getContext('2d');
    if (!ctx) return marqueeSignCanvas;

    const w = 1024;
    const h = 512;
    const cx = w / 2;
    const cy = h / 2;

    ctx.clearRect(0, 0, w, h);

    // Sfondo crema caldo con raggi solari Retro Street
    ctx.fillStyle = '#fff8f1';
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(cx, cy + 20);
    const rayCount = 24;
    for (let i = 0; i < rayCount; i += 2) {
      const a0 = (i * Math.PI * 2) / rayCount;
      const a1 = ((i + 1) * Math.PI * 2) / rayCount;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 680, a0, a1);
      ctx.closePath();
      ctx.fillStyle = '#fff0c2';
      ctx.fill();
    }
    ctx.restore();

    // Cornice interna color inchiostro e filetto corallo
    ctx.strokeStyle = '#201b0d';
    ctx.lineWidth = 18;
    ctx.strokeRect(18, 18, w - 36, h - 36);

    ctx.strokeStyle = '#e05a47';
    ctx.lineWidth = 8;
    ctx.strokeRect(36, 36, w - 72, h - 72);

    // Targhetta superiore ciano elettrico: "★ COLPO DI SCENA ★"
    const pillW = 460;
    const pillH = 66;
    const pillX = cx - pillW / 2;
    const pillY = 48;

    ctx.fillStyle = '#201b0d';
    ctx.fillRect(pillX + 7, pillY + 7, pillW, pillH);
    ctx.fillStyle = '#90efef';
    ctx.fillRect(pillX, pillY, pillW, pillH);
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#201b0d';
    ctx.strokeRect(pillX, pillY, pillW, pillH);

    ctx.font = '900 34px "Quicksand", "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#006a6a';
    ctx.fillText('★ COLPO DI SCENA ★', cx, pillY + pillH / 2 + 2);

    // Funzione helper per testo 3D estruso in stile fumetto Retro Street
    function drawExtrudedText(text, x, y, fontSize, fillHex, depth = 11) {
      ctx.font = `900 ${fontSize}px "Quicksand", "Arial Black", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';

      // Ombra solida 3D estrusa
      ctx.fillStyle = '#201b0d';
      for (let d = depth; d >= 1; d--) {
        ctx.fillText(text, x + d, y + d);
      }

      // Contorno spesso color inchiostro
      ctx.lineWidth = 22;
      ctx.strokeStyle = '#201b0d';
      ctx.strokeText(text, x, y);

      // Riempimento principale
      ctx.fillStyle = fillHex;
      ctx.fillText(text, x, y);

      // Riflesso superiore sottile
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeText(text, x - 2, y - 2);
      ctx.fillStyle = fillHex;
      ctx.fillText(text, x, y);
    }

    drawExtrudedText("È L'ORA DEL", cx, 212, 102, '#f7d708', 11);
    drawExtrudedText('MINIGIOCO!', cx, 364, 128, '#e05a47', 13);

    if (marqueeSignTexture) {
      marqueeSignTexture.needsUpdate = true;
    }
    return marqueeSignCanvas;
  }

  function buildOrUpdateWheelTextures() {
    preloadWheelImages();
    paintWheelFaceCanvas();
    paintHubLogoCanvas();
    paintCurtainVelvetCanvas();
    paintMarqueeSignCanvas();

    if (THREE && wheelFaceCanvas && !wheelFaceTexture) {
      wheelFaceTexture = new THREE.CanvasTexture(wheelFaceCanvas);
      if (THREE.SRGBColorSpace) {
        wheelFaceTexture.colorSpace = THREE.SRGBColorSpace;
      }
      wheelFaceTexture.needsUpdate = true;
    }
    if (THREE && hubLogoCanvas && !hubLogoTexture) {
      hubLogoTexture = new THREE.CanvasTexture(hubLogoCanvas);
      if (THREE.SRGBColorSpace) {
        hubLogoTexture.colorSpace = THREE.SRGBColorSpace;
      }
      hubLogoTexture.needsUpdate = true;
    }
    if (THREE && curtainVelvetCanvas && !curtainVelvetTexture) {
      curtainVelvetTexture = new THREE.CanvasTexture(curtainVelvetCanvas);
      if (THREE.SRGBColorSpace) {
        curtainVelvetTexture.colorSpace = THREE.SRGBColorSpace;
      }
      curtainVelvetTexture.needsUpdate = true;
    }
    if (THREE && marqueeSignCanvas && !marqueeSignTexture) {
      marqueeSignTexture = new THREE.CanvasTexture(marqueeSignCanvas);
      if (THREE.SRGBColorSpace) {
        marqueeSignTexture.colorSpace = THREE.SRGBColorSpace;
      }
      marqueeSignTexture.needsUpdate = true;
    }
  }

  function ensureIntroRenderer() {
    if (!THREE || typeof document === 'undefined') return null;
    if (sharedIntroRenderer && sharedIntroCanvas) return sharedIntroRenderer;

    try {
      const canvas = document.createElement('canvas');
      canvas.className = 'mg-stage-intro-canvas';
      canvas.setAttribute('aria-hidden', 'true');

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
      sharedIntroCanvas = canvas;
      sharedIntroRenderer = renderer;
      return sharedIntroRenderer;
    } catch {
      return null;
    }
  }

  /**
   * Ricostruisce i pioli 3D lungo la circonferenza della ruota in base a
   * `currentSlices.length` (2 pioli per spicchio, minimo 12 pioli) così i pioli
   * cadono sempre esattamente sui confini e al centro di ogni spicchio.
   */
  function rebuildWheelPegs3D(pegsGroup, goldMat, inkSolidMat) {
    if (!THREE || !pegsGroup) return;
    while (pegsGroup.children.length > 0) {
      pegsGroup.remove(pegsGroup.children[0]);
    }
    const pegCount = Math.max(12, currentSlices.length * 2);
    const stepDeg = 360 / pegCount;
    const pegStemGeo = new THREE.CylinderGeometry(0.032, 0.032, 0.22, 10);
    pegStemGeo.rotateX(Math.PI / 2);
    const pegCapGeo = new THREE.SphereGeometry(0.048, 10, 8);

    for (let pIdx = 0; pIdx < pegCount; pIdx++) {
      const pRad = (pIdx * stepDeg * Math.PI) / 180;
      const px = Math.sin(pRad) * 1.49;
      const py = Math.cos(pRad) * 1.49;

      const pegStem = new THREE.Mesh(pegStemGeo, goldMat);
      pegStem.position.set(px, py, 0.24);

      const pegCap = new THREE.Mesh(pegCapGeo, inkSolidMat);
      pegCap.position.set(px, py, 0.34);

      pegsGroup.add(pegStem, pegCap);
    }
  }

  /**
   * Deforma ogni fotogramma i vertici 3D (X, Y, Z) della mesh del sipario.
   * IMPORTANTE: quando la tenda è chiusa (`rowOpen === 0`), i due lembi si
   * sovrappongono al centro (`overlapX = -sideSign * 0.16`) con un leggero
   * sfalsamento in Z (`seamZOffset = sideSign * 0.03`) e `bunchX` si annulla
   * sul bordo interno (`Math.sin(uFromInner * Math.PI)`), eliminando qualsiasi
   * fessura centrale!
   */
  function deformCurtainClothWing(wingObj, clothState) {
    const {
      sideSign,
      clothGeo,
      fringeGeo,
      segX,
      segY,
      height,
      outerAnchorX,
      folds,
    } = wingObj;

    const topOpen = Math.max(0, Math.min(1.12, clothState.topOpen));
    const midOpen = Math.max(0, Math.min(1.16, clothState.midOpen));
    const bottomOpen = Math.max(0, Math.min(1.18, clothState.bottomOpen));
    const billowZ = clothState.billowZ || 0;
    const waveTime = clothState.waveTime || 0;
    const shearDelta = topOpen - bottomOpen;

    const pleatDepth = 0.18 + Math.max(0, topOpen) * 0.24 + Math.abs(billowZ) * 0.24;
    const seamZOffset = sideSign * 0.032;

    const posAttr = clothGeo.attributes.position;
    const arr = posAttr.array;

    // Costante di larghezza ancoraggio esterno tende: 8.6m copre qualsiasi aspect ratio widescreen
    const outerReach = 3.85;

    for (let iy = 0; iy <= segY; iy++) {
      const v = iy / segY;
      const invV = 1 - v;
      const tieBackSwag = Math.sin(v * Math.PI) * Math.max(0, topOpen) * 0.14;
      const rowOpen = Math.max(
        0,
        invV * invV * topOpen +
          2 * invV * v * (midOpen + tieBackSwag) +
          v * v * bottomOpen
      );

      // Quando rowOpen = 0, il bordo interno oltrepassa la linea di centro (x = 0)
      // di 0.18m sul lato opposto (-sideSign * 0.18), sigillando completamente il sipario!
      const closedOverlapX = -sideSign * 0.18 * Math.max(0, 1 - rowOpen * 5);
      const innerEdgeX = closedOverlapX + sideSign * (rowOpen * outerReach);

      const verticalBelly = Math.sin(v * Math.PI);
      const rowBillowZ = billowZ * verticalBelly * 1.35;

      const catenaryLiftY =
        (Math.abs(shearDelta) * 0.42 + Math.max(0, topOpen) * 0.18) *
        Math.pow(v, 1.2);

      for (let ix = 0; ix <= segX; ix++) {
        const uFromInner = ix / segX;
        const xBase = lerp(innerEdgeX, outerAnchorX, Math.pow(uFromInner, 0.88));

        const pleatPhase =
          uFromInner * folds * Math.PI * 2 +
          shearDelta * Math.sin(v * Math.PI) * 2.2;
        const foldZ = Math.sin(pleatPhase) * pleatDepth * (0.60 + 0.40 * v);

        const edgePinFactor = Math.sin(uFromInner * Math.PI);
        const bunchX =
          Math.cos(pleatPhase) *
          0.065 *
          (0.35 + Math.max(0, topOpen) * 0.65) *
          edgePinFactor *
          sideSign;

        const scallopY =
          Math.abs(Math.sin(uFromInner * folds * Math.PI)) * 0.08 * v * Math.min(1, rowOpen * 3);

        const hemRippleZ =
          Math.sin(uFromInner * Math.PI * 3.5 + waveTime + sideSign) *
          0.08 *
          v *
          (0.45 + Math.abs(shearDelta) * 3.2);

        const overlapZ = seamZOffset * (1 - uFromInner);

        const idx = (iy * (segX + 1) + ix) * 3;
        arr[idx] = xBase + bunchX;
        arr[idx + 1] =
          (0.5 - v) * height +
          catenaryLiftY * (1 - uFromInner * 0.65) +
          scallopY;
        arr[idx + 2] =
          foldZ + rowBillowZ * (1 - uFromInner * 0.60) + hemRippleZ + overlapZ;
      }
    }

    posAttr.needsUpdate = true;
    clothGeo.computeVertexNormals();

    const fringePos = fringeGeo.attributes.position;
    const fArr = fringePos.array;
    const fringeHeight = 0.26;
    const bottomRowOffset = segY * (segX + 1) * 3;
    const swayLagX = (bottomOpen - midOpen) * 0.35 * sideSign;

    for (let fy = 0; fy <= 1; fy++) {
      for (let ix = 0; ix <= segX; ix++) {
        const srcIdx = bottomRowOffset + ix * 3;
        const dstIdx = (fy * (segX + 1) + ix) * 3;
        fArr[dstIdx] = arr[srcIdx] + fy * swayLagX;
        fArr[dstIdx + 1] = arr[srcIdx + 1] - fy * fringeHeight;
        fArr[dstIdx + 2] = arr[srcIdx + 2] + 0.03 + fy * billowZ * 0.25;
      }
    }
    fringePos.needsUpdate = true;
    fringeGeo.computeVertexNormals();
  }

  /**
   * Costruisce la scena 3D completa:
   * - Palco e Ruota partono nel BUIO TOTALE (sagoma appena percettibile) e vengono
   *   illuminati esclusivamente dall'accensione del faretto di LUCE BIANCA
   * - Piedistallo 3D della ruota con colonna posteriore e base trapezoidale
   *   completamente separata dal tamburo (zero compenetrazione geometrica)
   * - Cartello 3D appeso con cavi e 28 lampadine 3D ("È L'ORA DEL MINIGIOCO!")
   *   che cala davanti alle tende chiuse prima dell'apertura del sipario.
   */
  function ensureIntro3DScene() {
    if (cachedIntro3D || !THREE) return cachedIntro3D;

    buildOrUpdateWheelTextures();

    const gradData = new Uint8Array([
      90, 90, 90, 255,
      185, 185, 185, 255,
      255, 255, 255, 255,
    ]);
    const gradientMap = new THREE.DataTexture(gradData, 3, 1, THREE.RGBAFormat);
    gradientMap.minFilter = THREE.NearestFilter;
    gradientMap.magFilter = THREE.NearestFilter;
    gradientMap.needsUpdate = true;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 40);

    // Luce ambiente del palco: parte a 0.02 (buio quasi totale) e sale solo quando
    // il faretto di luce bianca si accende!
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x100c06, 0.02);
    scene.add(hemiLight);

    // Luce direzionale BIANCA principale del faretto teatrale
    const spotDirLight = new THREE.DirectionalLight(0xffffff, 0.0);
    spotDirLight.position.set(0.0, 6.2, 4.5);
    scene.add(spotDirLight);

    const rimLight = new THREE.DirectionalLight(0xd8f8ff, 0.0);
    rimLight.position.set(-3.5, 2.5, 1.5);
    scene.add(rimLight);

    // Materiali condivisi
    const inkOutlineMat = new THREE.MeshBasicMaterial({
      color: 0x201b0d,
      side: THREE.BackSide,
    });
    const inkSolidMat = new THREE.MeshBasicMaterial({ color: 0x201b0d });
    const stageWoodMat = new THREE.MeshToonMaterial({ color: 0x6e3b16, gradientMap });
    const stageDarkWoodMat = new THREE.MeshToonMaterial({ color: 0x47240c, gradientMap });
    const redMat = new THREE.MeshToonMaterial({ color: 0xab3425, gradientMap });
    const coralMat = new THREE.MeshToonMaterial({ color: 0xe05a47, gradientMap });
    const goldMat = new THREE.MeshToonMaterial({
      color: 0xf7d708,
      gradientMap,
      side: THREE.DoubleSide,
    });
    const creamMat = new THREE.MeshToonMaterial({ color: 0xfff8f1, gradientMap });
    const backWallMat = new THREE.MeshToonMaterial({
      color: 0x140f08,
      gradientMap,
      side: THREE.BackSide,
    });
    const velvetCurtainMat = new THREE.MeshBasicMaterial({
      map: curtainVelvetTexture,
      side: THREE.DoubleSide,
    });
    const curtainFringeMat = new THREE.MeshBasicMaterial({
      color: 0xf7d708,
      side: THREE.DoubleSide,
    });

    // ─── 1. Gruppo del Palco Teatrale + Ruota 3D (visibile negli Atti 2..5) ───
    const stageWorldGroup = new THREE.Group();
    scene.add(stageWorldGroup);

    const backWallGeo = new THREE.CylinderGeometry(
      8.2,
      8.2,
      9.0,
      36,
      1,
      true,
      Math.PI * 0.55,
      Math.PI * 0.9
    );
    const backWallMesh = new THREE.Mesh(backWallGeo, backWallMat);
    backWallMesh.position.set(0, 1.8, -0.8);
    stageWorldGroup.add(backWallMesh);

    // Pavimento in legno scuro da palcoscenico a y = -1.22
    const floorGeo = new THREE.CylinderGeometry(6.2, 6.4, 0.36, 48);
    const floorMesh = new THREE.Mesh(floorGeo, stageWoodMat);
    floorMesh.position.set(0, -1.30, 0.2);
    stageWorldGroup.add(floorMesh);

    const apronRimGeo = new THREE.CylinderGeometry(6.26, 6.30, 0.08, 48);
    const apronRimMesh = new THREE.Mesh(apronRimGeo, stageDarkWoodMat);
    apronRimMesh.position.set(0, -1.14, 0.2);
    stageWorldGroup.add(apronRimMesh);

    // Disco di LUCE BIANCA proiettato dal faretto sul pavimento del palco
    const lightPoolGeo = new THREE.CircleGeometry(2.35, 40);
    const lightPoolMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const lightPoolMesh = new THREE.Mesh(lightPoolGeo, lightPoolMat);
    lightPoolMesh.rotation.x = -Math.PI / 2;
    lightPoolMesh.position.set(0, -1.11, 0.08);
    stageWorldGroup.add(lightPoolMesh);

    // Ombra nitida sotto la base del piedistallo
    const shadowPoolGeo = new THREE.CircleGeometry(1.18, 32);
    const shadowPoolMat = new THREE.MeshBasicMaterial({
      color: 0x090704,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    const shadowPoolMesh = new THREE.Mesh(shadowPoolGeo, shadowPoolMat);
    shadowPoolMesh.rotation.x = -Math.PI / 2;
    shadowPoolMesh.position.set(0, -1.10, -0.05);
    stageWorldGroup.add(shadowPoolMesh);

    // ─── 2. Piedistallo Non-Compenetrante + Ruota TV 3D (`wheelAssemblyGroup`) ─
    const wheelAssemblyGroup = new THREE.Group();
    wheelAssemblyGroup.position.set(0, 1.26, 0);
    wheelAssemblyGroup.scale.setScalar(0.88);
    stageWorldGroup.add(wheelAssemblyGroup);

    const standGroup = new THREE.Group();

    const basePlinthGeo = new THREE.CylinderGeometry(0.96, 1.16, 0.26, 32);
    const basePlinthMesh = new THREE.Mesh(basePlinthGeo, redMat);
    basePlinthMesh.position.set(0, -2.52, -0.12);

    const baseOutlineGeo = new THREE.CylinderGeometry(1.02, 1.22, 0.32, 32);
    const baseOutlineMesh = new THREE.Mesh(baseOutlineGeo, inkOutlineMat);
    baseOutlineMesh.position.set(0, -2.52, -0.12);

    const baseGoldCollarGeo = new THREE.CylinderGeometry(0.68, 0.84, 0.14, 32);
    const baseGoldCollarMesh = new THREE.Mesh(baseGoldCollarGeo, goldMat);
    baseGoldCollarMesh.position.set(0, -2.32, -0.18);

    const rearPillarGeo = new THREE.BoxGeometry(0.42, 2.40, 0.24);
    const rearPillarMesh = new THREE.Mesh(rearPillarGeo, stageDarkWoodMat);
    rearPillarMesh.position.set(0, -1.18, -0.44);

    const rearPillarOutlineGeo = new THREE.BoxGeometry(0.50, 2.48, 0.30);
    const rearPillarOutline = new THREE.Mesh(rearPillarOutlineGeo, inkOutlineMat);
    rearPillarOutline.position.set(0, -1.18, -0.44);

    const neckStrutGeo = new THREE.BoxGeometry(0.52, 0.36, 0.44);
    const neckStrutMesh = new THREE.Mesh(neckStrutGeo, goldMat);
    neckStrutMesh.position.set(0, -2.16, -0.26);

    const axleGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.36, 20);
    axleGeo.rotateX(Math.PI / 2);
    const axleMesh = new THREE.Mesh(axleGeo, goldMat);
    axleMesh.position.set(0, 0, -0.28);

    standGroup.add(
      baseOutlineMesh,
      basePlinthMesh,
      baseGoldCollarMesh,
      rearPillarOutline,
      rearPillarMesh,
      neckStrutMesh,
      axleMesh
    );
    wheelAssemblyGroup.add(standGroup);

    // Rotore 3D della Ruota
    const wheelRotorGroup = new THREE.Group();
    wheelAssemblyGroup.add(wheelRotorGroup);

    const drumGeo = new THREE.CylinderGeometry(1.66, 1.66, 0.30, 48);
    drumGeo.rotateX(Math.PI / 2);
    const drumMesh = new THREE.Mesh(drumGeo, redMat);
    wheelRotorGroup.add(drumMesh);

    const drumOutlineGeo = new THREE.CylinderGeometry(1.77, 1.77, 0.36, 48);
    drumOutlineGeo.rotateX(Math.PI / 2);
    const drumOutlineMesh = new THREE.Mesh(drumOutlineGeo, inkOutlineMat);
    wheelRotorGroup.add(drumOutlineMesh);

    const outerBezelGeo = new THREE.TorusGeometry(1.63, 0.11, 16, 48);
    const outerBezelMesh = new THREE.Mesh(outerBezelGeo, redMat);
    outerBezelMesh.position.z = 0.11;
    wheelRotorGroup.add(outerBezelMesh);

    const innerGoldRingGeo = new THREE.TorusGeometry(1.52, 0.042, 12, 48);
    const innerGoldRingMesh = new THREE.Mesh(innerGoldRingGeo, goldMat);
    innerGoldRingMesh.position.z = 0.165;
    wheelRotorGroup.add(innerGoldRingMesh);

    const faceGeo = new THREE.CircleGeometry(1.52, 64);
    const faceMat = new THREE.MeshBasicMaterial({
      map: wheelFaceTexture,
      color: 0x090807,
    });
    const faceMesh = new THREE.Mesh(faceGeo, faceMat);
    faceMesh.position.z = 0.16;
    wheelRotorGroup.add(faceMesh);

    const bulbGeo = new THREE.SphereGeometry(0.052, 10, 8);
    const bulbMatA = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const bulbMatB = new THREE.MeshBasicMaterial({ color: 0xf7d708 });
    const rimBulbs = [];
    for (let b = 0; b < 24; b++) {
      const aRad = (b * 15 * Math.PI) / 180;
      const bx = Math.sin(aRad) * 1.63;
      const by = Math.cos(aRad) * 1.63;
      const bulbMesh = new THREE.Mesh(bulbGeo, b % 2 === 0 ? bulbMatA : bulbMatB);
      bulbMesh.position.set(bx, by, 0.21);
      wheelRotorGroup.add(bulbMesh);
      rimBulbs.push(bulbMesh);
    }

    const pegsGroup = new THREE.Group();
    wheelRotorGroup.add(pegsGroup);
    rebuildWheelPegs3D(pegsGroup, goldMat, inkSolidMat);

    // Mozzo centrale 3D con logo Quiz-Zata!
    const hubGroup = new THREE.Group();
    hubGroup.position.z = 0.21;
    const hubBossGeo = new THREE.CylinderGeometry(0.38, 0.42, 0.14, 32);
    hubBossGeo.rotateX(Math.PI / 2);
    const hubBossMesh = new THREE.Mesh(hubBossGeo, creamMat);
    const hubOutlineGeo = new THREE.CylinderGeometry(0.42, 0.46, 0.16, 32);
    hubOutlineGeo.rotateX(Math.PI / 2);
    const hubOutlineMesh = new THREE.Mesh(hubOutlineGeo, inkOutlineMat);

    const hubCapGeo = new THREE.CircleGeometry(0.36, 32);
    const hubCapMat = new THREE.MeshBasicMaterial({
      map: hubLogoTexture,
      color: 0x090807,
    });
    const hubCapMesh = new THREE.Mesh(hubCapGeo, hubCapMat);
    hubCapMesh.position.z = 0.075;

    hubGroup.add(hubOutlineMesh, hubBossMesh, hubCapMesh);
    wheelAssemblyGroup.add(hubGroup);

    // Indicatore / Piolo superiore 3D a ore 12
    const pointerBracketGroup = new THREE.Group();
    pointerBracketGroup.position.set(0, 1.78, 0.28);
    wheelAssemblyGroup.add(pointerBracketGroup);

    const bracketGeo = new THREE.BoxGeometry(0.32, 0.20, 0.22);
    const bracketMesh = new THREE.Mesh(bracketGeo, inkSolidMat);
    bracketMesh.position.set(0, 0.08, -0.04);
    pointerBracketGroup.add(bracketMesh);

    const pointerPivotGroup = new THREE.Group();
    pointerBracketGroup.add(pointerPivotGroup);

    const pointerConeGeo = new THREE.ConeGeometry(0.17, 0.46, 4);
    pointerConeGeo.rotateY(Math.PI / 4);
    pointerConeGeo.scale(1.0, 1.0, 0.45);
    pointerConeGeo.translate(0, -0.18, 0);
    const pointerMesh = new THREE.Mesh(pointerConeGeo, goldMat);

    const pointerOutlineGeo = new THREE.ConeGeometry(0.21, 0.52, 4);
    pointerOutlineGeo.rotateY(Math.PI / 4);
    pointerOutlineGeo.scale(1.0, 1.0, 0.52);
    pointerOutlineGeo.translate(0, -0.18, 0);
    const pointerOutlineMesh = new THREE.Mesh(pointerOutlineGeo, inkOutlineMat);

    const rivetGeo = new THREE.SphereGeometry(0.065, 12, 10);
    const rivetMesh = new THREE.Mesh(rivetGeo, redMat);
    rivetMesh.position.set(0, 0, 0.06);

    pointerPivotGroup.add(pointerOutlineMesh, pointerMesh, rivetMesh);

    // Cono di LUCE BIANCA volumetrico 3D del faretto dall'alto
    const spotConeGeo = new THREE.ConeGeometry(2.35, 6.4, 40, 1, true);
    const spotConeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const spotConeMesh = new THREE.Mesh(spotConeGeo, spotConeMat);
    spotConeMesh.position.set(0, 1.85, 0.16);
    stageWorldGroup.add(spotConeMesh);

    // ─── 3. Sipario Teatrale 3D con Chiusura Ermetica e Larghezza Widescreen ──
    const curtains3DGroup = new THREE.Group();
    curtains3DGroup.position.set(0, 1.05, 2.15);
    scene.add(curtains3DGroup);

    function createDeformableCurtainWing(sideSign) {
      const group = new THREE.Group();
      const segX = 52;
      const segY = 26;
      const width = 8.6;
      const height = 5.2;
      const outerAnchorX = sideSign * 8.6;
      const folds = 12;

      const clothGeo = new THREE.PlaneGeometry(width, height, segX, segY);
      const clothMesh = new THREE.Mesh(clothGeo, velvetCurtainMat);

      const fringeGeo = new THREE.PlaneGeometry(width, 0.26, segX, 1);
      const fringeMesh = new THREE.Mesh(fringeGeo, curtainFringeMat);

      group.add(clothMesh, fringeMesh);

      const wingObj = {
        sideSign,
        group,
        clothGeo,
        fringeGeo,
        segX,
        segY,
        height,
        outerAnchorX,
        folds,
      };

      deformCurtainClothWing(wingObj, {
        topOpen: 1,
        midOpen: 1,
        bottomOpen: 1,
        billowZ: 0,
        waveTime: 0,
      });

      return wingObj;
    }

    const curtainLeftWing = createDeformableCurtainWing(-1);
    const curtainRightWing = createDeformableCurtainWing(1);

    const valanceMatRed = new THREE.MeshBasicMaterial({ color: 0xab3425 });
    const valanceMatCoral = new THREE.MeshBasicMaterial({ color: 0xe05a47 });
    const valanceMatGold = new THREE.MeshBasicMaterial({ color: 0xf7d708 });
    const valance3D = new THREE.Group();
    valance3D.position.set(0, 2.34, 0.30);
    const valPleatGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.85, 14);
    for (let v = -18; v <= 18; v++) {
      const vp = new THREE.Mesh(
        valPleatGeo,
        Math.abs(v) % 2 === 0 ? valanceMatRed : valanceMatCoral
      );
      vp.position.set(v * 0.44, 0, Math.sin(v * 0.8) * 0.04);
      valance3D.add(vp);
    }
    const valGoldBarGeo = new THREE.BoxGeometry(16.8, 0.14, 0.65);
    const valGoldBar = new THREE.Mesh(valGoldBarGeo, valanceMatGold);
    valGoldBar.position.set(0, -0.42, 0.04);
    const valInkBarGeo = new THREE.BoxGeometry(16.9, 0.22, 0.70);
    const valInkBar = new THREE.Mesh(valInkBarGeo, inkOutlineMat);
    valInkBar.position.set(0, -0.42, 0.04);
    valance3D.add(valInkBar, valGoldBar);

    curtains3DGroup.add(curtainLeftWing.group, curtainRightWing.group, valance3D);

    // ─── 4. Cartello 3D Appeso con Luci 3D ("È L'ORA DEL MINIGIOCO!") ─────────
    // Posizionato a z = 2.68 (davanti alle tende chiuse che sono a z = 2.15),
    // cala dall'alto prima dell'apertura delle tende!
    const marquee3DGroup = new THREE.Group();
    marquee3DGroup.position.set(0, 4.35, 2.68);
    marquee3DGroup.visible = false;
    scene.add(marquee3DGroup);

    const mBodyMatRed = new THREE.MeshBasicMaterial({ color: 0xab3425 });
    const mBodyMatGold = new THREE.MeshBasicMaterial({ color: 0xf7d708 });
    const mBodyMatCyan = new THREE.MeshBasicMaterial({ color: 0x90efef });

    // Cavi/catene di sospensione 3D a sinistra e destra
    function createSuspensionCable(anchorX) {
      const cGroup = new THREE.Group();
      cGroup.position.set(anchorX, 0.70, 0);

      // Anello di ancoraggio in ottone sopra la cornice del cartello
      const ringGeo = new THREE.TorusGeometry(0.085, 0.026, 10, 20);
      const ringMesh = new THREE.Mesh(ringGeo, mBodyMatGold);
      ringMesh.position.set(0, 0.06, 0);
      const ringOutlineGeo = new THREE.TorusGeometry(0.085, 0.044, 10, 20);
      const ringOutline = new THREE.Mesh(ringOutlineGeo, inkSolidMat);
      ringOutline.position.set(0, 0.06, -0.01);

      // Cavo verticale 3D che sale fino alla mantovana superiore
      const rodGeo = new THREE.CylinderGeometry(0.028, 0.028, 2.40, 10);
      const rodMesh = new THREE.Mesh(rodGeo, inkSolidMat);
      rodMesh.position.set(0, 1.28, 0);

      const goldCoreGeo = new THREE.CylinderGeometry(0.016, 0.016, 2.40, 8);
      const goldCoreMesh = new THREE.Mesh(goldCoreGeo, mBodyMatGold);
      goldCoreMesh.position.set(0, 1.28, 0.012);

      // Nodi decorativi lungo la catena/cavo
      const linkGeo = new THREE.CylinderGeometry(0.052, 0.052, 0.06, 12);
      for (let k = 0; k < 5; k++) {
        const linkMesh = new THREE.Mesh(linkGeo, k % 2 === 0 ? mBodyMatGold : inkSolidMat);
        linkMesh.position.set(0, 0.32 + k * 0.42, 0.01);
        cGroup.add(linkMesh);
      }

      cGroup.add(ringOutline, ringMesh, rodMesh, goldCoreMesh);
      return cGroup;
    }

    marquee3DGroup.add(createSuspensionCable(-1.02), createSuspensionCable(1.02));

    // Ombra portata 3D offset dietro al cartello (stile Retro Street, senza alone rettangolare)
    const signW = 2.86;
    const signH = 1.38;
    const signD = 0.22;

    const marqueeShadowGeo = new THREE.BoxGeometry(signW + 0.14, signH + 0.14, 0.06);
    const marqueeGlowMat = new THREE.MeshBasicMaterial({
      color: 0x160503,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const marqueeShadowMesh = new THREE.Mesh(marqueeShadowGeo, marqueeGlowMat);
    marqueeShadowMesh.position.set(0.09, -0.09, -0.16);
    marquee3DGroup.add(marqueeShadowMesh);

    const signOutlineGeo = new THREE.BoxGeometry(signW + 0.12, signH + 0.12, signD + 0.06);
    const signOutlineMesh = new THREE.Mesh(signOutlineGeo, inkSolidMat);
    signOutlineMesh.position.set(0, 0, -0.02);
    marquee3DGroup.add(signOutlineMesh);

    const signCabinetGeo = new THREE.BoxGeometry(signW, signH, signD);
    const signCabinetMesh = new THREE.Mesh(signCabinetGeo, mBodyMatRed);
    marquee3DGroup.add(signCabinetMesh);

    // Cornice perimetrale dorata 3D in rilievo (dove sono incastonate le lampadine 3D)
    const topRailGeo = new THREE.BoxGeometry(signW - 0.08, 0.16, 0.08);
    const topRailMesh = new THREE.Mesh(topRailGeo, mBodyMatGold);
    topRailMesh.position.set(0, signH / 2 - 0.085, signD / 2 + 0.02);

    const botRailMesh = new THREE.Mesh(topRailGeo, mBodyMatGold);
    botRailMesh.position.set(0, -signH / 2 + 0.085, signD / 2 + 0.02);

    const sideRailGeo = new THREE.BoxGeometry(0.16, signH - 0.24, 0.08);
    const leftRailMesh = new THREE.Mesh(sideRailGeo, mBodyMatGold);
    leftRailMesh.position.set(-signW / 2 + 0.085, 0, signD / 2 + 0.02);

    const rightRailMesh = new THREE.Mesh(sideRailGeo, mBodyMatGold);
    rightRailMesh.position.set(signW / 2 - 0.085, 0, signD / 2 + 0.02);

    marquee3DGroup.add(topRailMesh, botRailMesh, leftRailMesh, rightRailMesh);

    // Pannello frontale con la scritta "È L'ORA DEL MINIGIOCO!"
    const signFaceGeo = new THREE.PlaneGeometry(signW - 0.36, signH - 0.36);
    const signFaceMat = new THREE.MeshBasicMaterial({
      map: marqueeSignTexture,
    });
    const signFaceMesh = new THREE.Mesh(signFaceGeo, signFaceMat);
    signFaceMesh.position.set(0, 0, signD / 2 + 0.015);
    marquee3DGroup.add(signFaceMesh);

    // 28 Lampadine 3D perimetrali con ghiera inchiostro + portalampada e bulbo sferico 3D luminoso
    const mBulbSocketGeo = new THREE.CylinderGeometry(0.064, 0.068, 0.045, 14);
    mBulbSocketGeo.rotateX(Math.PI / 2);
    const mBulbGlobeGeo = new THREE.SphereGeometry(0.050, 14, 12);

    const mBulbMatWhite = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const mBulbMatGold = new THREE.MeshBasicMaterial({ color: 0xf7d708 });
    const mBulbMatCyan = new THREE.MeshBasicMaterial({ color: 0x90efef });

    const marqueeBulbs = [];
    const bulbPositions = [];

    // 10 lampadine lungo il bordo superiore (da sinistra a destra)
    for (let i = 0; i < 10; i++) {
      const bx = lerp(-signW / 2 + 0.14, signW / 2 - 0.14, i / 9);
      bulbPositions.push({ x: bx, y: signH / 2 - 0.085 });
    }
    // 4 lampadine lungo il bordo destro (dall'alto in basso)
    for (let i = 1; i <= 4; i++) {
      const by = lerp(signH / 2 - 0.085, -signH / 2 + 0.085, i / 5);
      bulbPositions.push({ x: signW / 2 - 0.085, y: by });
    }
    // 10 lampadine lungo il bordo inferiore (da destra a sinistra)
    for (let i = 0; i < 10; i++) {
      const bx = lerp(signW / 2 - 0.14, -signW / 2 + 0.14, i / 9);
      bulbPositions.push({ x: bx, y: -signH / 2 + 0.085 });
    }
    // 4 lampadine lungo il bordo sinistro (dal basso in alto)
    for (let i = 1; i <= 4; i++) {
      const by = lerp(-signH / 2 + 0.085, signH / 2 - 0.085, i / 5);
      bulbPositions.push({ x: -signW / 2 + 0.085, y: by });
    }

    for (let bIdx = 0; bIdx < bulbPositions.length; bIdx++) {
      const pos = bulbPositions[bIdx];
      const socketMesh = new THREE.Mesh(mBulbSocketGeo, inkSolidMat);
      socketMesh.position.set(pos.x, pos.y, signD / 2 + 0.058);

      const globeMesh = new THREE.Mesh(
        mBulbGlobeGeo,
        bIdx % 2 === 0 ? mBulbMatWhite : mBulbMatGold
      );
      globeMesh.position.set(pos.x, pos.y, signD / 2 + 0.105);

      marquee3DGroup.add(socketMesh, globeMesh);
      marqueeBulbs.push(globeMesh);
    }

    cachedIntro3D = {
      scene,
      camera,
      stageWorldGroup,
      wheelAssemblyGroup,
      wheelRotorGroup,
      pegsGroup,
      hubGroup,
      pointerPivotGroup,
      faceMat,
      hubCapMat,
      spotConeMat,
      lightPoolMat,
      hemiLight,
      spotDirLight,
      rimLight,
      rimBulbs,
      bulbMatA,
      bulbMatB,
      goldMat,
      coralMat,
      inkSolidMat,
      curtainLeftWing,
      curtainRightWing,
      valance3D,
      marquee3DGroup,
      marqueeBulbs,
      marqueeGlowMat,
      mBulbMatWhite,
      mBulbMatGold,
      mBulbMatCyan,
    };
    return cachedIntro3D;
  }

  /**
   * Applica lo stato 3D + il cartello 3D con luci + l'illuminazione del faretto bianco + la fisica delle tende.
   */
  function renderIntro3DFrame(state, hostEl, isScrubbing = false) {
    const renderer = ensureIntroRenderer();
    const g = ensureIntro3DScene();
    if (!renderer || !g || !hostEl) return false;

    if (sharedIntroCanvas.parentNode !== hostEl) {
      hostEl.innerHTML = '';
      hostEl.appendChild(sharedIntroCanvas);
    }

    const rect = hostEl.getBoundingClientRect();
    const w = Math.max(300, Math.floor(rect.width || 640));
    const h = Math.max(180, Math.floor(rect.height || 300));
    if (sharedIntroCanvas.width !== w || sharedIntroCanvas.height !== h) {
      renderer.setSize(w, h, false);
    }

    g.camera.aspect = w / h;
    g.camera.fov = state.cameraFov;
    g.camera.updateProjectionMatrix();
    g.camera.position.set(state.cameraX || 0, state.cameraY, state.cameraZ);
    g.camera.lookAt(0, state.cameraLookY, 0);
    g.camera.rotation.z = state.cameraRollRad;

    g.wheelAssemblyGroup.rotation.y = state.wheelYawRad || 0;

    if (state.wheelStageVisible) {
      g.stageWorldGroup.visible = true;
      const bgLum = state.stageIllumination || 0;
      const rBg = Math.round(lerp(0x06, 0x16, bgLum));
      const gBg = Math.round(lerp(0x05, 0x11, bgLum));
      const bBg = Math.round(lerp(0x04, 0x09, bgLum));
      renderer.setClearColor((rBg << 16) | (gBg << 8) | bBg, 1);
    } else {
      g.stageWorldGroup.visible = false;
      renderer.setClearColor(0x000000, 0);
    }

    g.wheelRotorGroup.rotation.z = -(state.wheelDeg * Math.PI) / 180;
    g.pointerPivotGroup.rotation.z = -(state.pointerDeflectionDeg * Math.PI) / 180;

    // ─── Illuminazione Drammatica: Buio (0.04) -> Faretto di Luce Bianca (1.00) ───
    const illum = clamp01(state.stageIllumination);
    const faceBrightness = lerp(0.045, 1.0, illum);
    g.faceMat.color.setRGB(faceBrightness, faceBrightness, faceBrightness);
    g.hubCapMat.color.setRGB(faceBrightness, faceBrightness, faceBrightness);

    g.hemiLight.intensity = lerp(0.03, 0.78, illum);
    g.spotDirLight.intensity = lerp(0.0, 1.95, illum);
    g.rimLight.intensity = lerp(0.02, 0.45, illum);

    // Faretto conico di LUCE BIANCA pura (0xffffff)
    g.spotConeMat.opacity = state.spotlightOpacity * (0.28 + state.suspenseIntensity * 0.08);
    g.lightPoolMat.opacity = state.spotlightOpacity * 0.26;

    const bulbBrightA = lerp(0.08, 1.0, illum);
    const bulbBrightB = lerp(0.08, 1.0, illum);
    g.bulbMatA.color.setRGB(bulbBrightA, bulbBrightA, bulbBrightA);
    g.bulbMatB.color.setRGB(bulbBrightB * 0.97, bulbBrightB * 0.84, bulbBrightB * 0.03);

    const phaseInt = Math.floor(state.rimChasePhase);
    for (let i = 0; i < g.rimBulbs.length; i++) {
      const isLit = (i + phaseInt) % 2 === 0;
      g.rimBulbs[i].material = isLit ? g.bulbMatA : g.bulbMatB;
      const scale = state.badgeVisible && isLit ? 1.35 : 1.0;
      g.rimBulbs[i].scale.setScalar(scale);
    }

    // ─── Animazione del Cartello 3D Appeso con Luci ("È L'ORA DEL MINIGIOCO!") ──
    if (state.marqueeVisible && state.marqueeDropAmount > 0.002) {
      g.marquee3DGroup.visible = true;
      const dropY = lerp(4.35, 1.18, state.marqueeDropAmount);
      g.marquee3DGroup.position.set(0, dropY, 2.68);
      g.marquee3DGroup.rotation.z = state.marqueeSwingRad || 0;
      g.marquee3DGroup.rotation.x = state.marqueePitchRad || 0;

      const mPhase = Math.floor(state.marqueeBulbPhase || 0);
      g.marqueeGlowMat.opacity = 0.52;
      for (let b = 0; b < g.marqueeBulbs.length; b++) {
        const mod = (b + mPhase) % 3;
        g.marqueeBulbs[b].material =
          mod === 0 ? g.mBulbMatWhite : mod === 1 ? g.mBulbMatGold : g.mBulbMatCyan;
        const bulbPulse = mod === 0 ? 1.28 : mod === 1 ? 1.08 : 0.92;
        g.marqueeBulbs[b].scale.setScalar(bulbPulse);
      }
    } else {
      g.marquee3DGroup.visible = false;
    }

    // Fisica del tessuto delle tende 3D
    const clothSimState = stepLiveCurtainPhysics(
      state.curtainOpenAmount,
      state.curtainPhysics,
      isScrubbing
    );
    deformCurtainClothWing(g.curtainLeftWing, clothSimState);
    deformCurtainClothWing(g.curtainRightWing, clothSimState);

    if (state.act === 6) {
      g.valance3D.position.y = 2.34 + state.curtainOpenAmount * 1.45;
    } else {
      g.valance3D.position.y = 2.34;
    }

    renderer.render(g.scene, g.camera);
    return true;
  }

  // ─── Costruzione DOM Overlay 3D (Esclusivo Maxischermo Sala) ────────────────

  function buildIntroDOM(targetType, customLabel) {
    const winningIdx = getSliceIndexForType(targetType, currentSlices);
    const winningSlice = currentSlices[winningIdx] || currentSlices[0];
    const finalLabel = customLabel || winningSlice.label || 'Minigioco';

    const overlay = document.createElement('div');
    overlay.className = 'mg-stage-intro-overlay';
    overlay.setAttribute('data-testid', 'mg-stage-intro-overlay');
    overlay.setAttribute('aria-label', `Apertura minigioco: ${finalLabel}`);

    const host3D = document.createElement('div');
    host3D.className = 'mg-stage-intro-3d-host';

    const badge = document.createElement('div');
    badge.className = 'mg-stage-intro-badge';
    const badgeKicker = document.createElement('span');
    badgeKicker.className = 'mg-stage-intro-badge-kicker';
    badgeKicker.textContent = 'MINIGIOCO ESTRATTO';
    const badgeTitle = document.createElement('strong');
    badgeTitle.className = 'mg-stage-intro-badge-title';
    badgeTitle.textContent = `${finalLabel.toUpperCase()}!`;
    badge.append(badgeKicker, badgeTitle);

    overlay.append(host3D, badge);

    return {
      overlay,
      host3D,
      badge,
      badgeTitle,
    };
  }

  function applyStateToDOM(dom, state, isScrubbing = false) {
    if (THREE) {
      renderIntro3DFrame(state, dom.host3D, isScrubbing);
    }
    dom.badge.classList.toggle('is-visible', state.badgeVisible);
    dom.overlay.classList.toggle('is-wheel-landed', state.badgeVisible);
  }

  function processSessionAudioCues(session, prevU, nextU, state) {
    if (audioMuted || session.isScrubbing) return;

    if (!session.cuesFired.close1 && prevU <= 0.01 && nextU > 0.002) {
      session.cuesFired.close1 = true;
      sfxCurtainMovement('close');
    }

    if (
      !session.cuesFired.marquee &&
      prevU < TIMELINE.marqueeDropStartAt &&
      nextU >= TIMELINE.marqueeDropStartAt
    ) {
      session.cuesFired.marquee = true;
      sfxMarqueeDrop();
    }

    if (!session.cuesFired.open1 && prevU < TIMELINE.curtainClose1End && nextU >= TIMELINE.curtainClose1End) {
      session.cuesFired.open1 = true;
      sfxCurtainMovement('open');
    }

    if (!session.cuesFired.spotlight && prevU < TIMELINE.spotlightOnAt && nextU >= TIMELINE.spotlightOnAt) {
      session.cuesFired.spotlight = true;
      sfxSpotlightIgnition();
    }

    if (state.act === 3) {
      const pegCount = Math.max(12, currentSlices.length * 2);
      const pegStepDeg = 360 / pegCount;
      const currentPegIdx = Math.floor(state.wheelDeg / pegStepDeg);
      if (session.lastPegIndex === null) {
        session.lastPegIndex = currentPegIdx;
      } else if (currentPegIdx !== session.lastPegIndex) {
        session.lastPegIndex = currentPegIdx;
        const spinT = clamp01(
          (nextU - TIMELINE.curtainOpen1End) / (TIMELINE.wheelSpinEnd - TIMELINE.curtainOpen1End)
        );
        sfxWheelPegClick(spinT);
      }
    }

    if (!session.cuesFired.winner && prevU < TIMELINE.wheelSpinEnd && nextU >= TIMELINE.wheelSpinEnd) {
      session.cuesFired.winner = true;
      sfxWinnerFanfare();
    }

    if (!session.cuesFired.close2 && prevU < TIMELINE.wheelHoldEnd && nextU >= TIMELINE.wheelHoldEnd) {
      session.cuesFired.close2 = true;
      sfxCurtainMovement('close');
    }

    if (!session.cuesFired.open2 && prevU < TIMELINE.curtainClose2End && nextU >= TIMELINE.curtainClose2End) {
      session.cuesFired.open2 = true;
      sfxCurtainMovement('open');
    }
  }

  function resetAudioCuesForProgress(session, u) {
    session.cuesFired = {
      close1: u > 0.02,
      marquee: u >= TIMELINE.marqueeDropStartAt,
      open1: u >= TIMELINE.curtainClose1End,
      spotlight: u >= TIMELINE.spotlightOnAt,
      winner: u >= TIMELINE.wheelSpinEnd,
      close2: u >= TIMELINE.wheelHoldEnd,
      open2: u >= TIMELINE.curtainClose2End,
    };
    session.lastPegIndex = null;
  }

  function stopForElement(containerEl) {
    if (!containerEl) return;
    const session = activeIntros.get(containerEl);
    if (!session) return;
    if (session.raf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(session.raf);
      session.raf = null;
    }
    if (
      sharedIntroCanvas &&
      sharedIntroCanvas.parentNode &&
      session.overlay &&
      session.overlay.contains(sharedIntroCanvas)
    ) {
      sharedIntroCanvas.parentNode.removeChild(sharedIntroCanvas);
    }
    if (session.overlay && session.overlay.parentNode) {
      session.overlay.parentNode.removeChild(session.overlay);
    }
    activeIntros.delete(containerEl);
  }

  function stopAll() {
    for (const el of Array.from(activeIntros.keys())) {
      stopForElement(el);
    }
  }

  /**
   * Aggiorna la configurazione degli spicchi e dei minigiochi della Ruota 3D
   * (es. per aggiungere nuovi minigiochi o passare da 6 a 8, 10, 12 spicchi)
   * e rigenera istantaneamente la texture del quadrante e i pioli 3D.
   */
  function setWheelConfig(config = {}) {
    currentSlices = buildWheelSlices(config);
    preloadWheelImages();
    paintWheelFaceCanvas();
    if (cachedIntro3D) {
      rebuildWheelPegs3D(
        cachedIntro3D.pegsGroup,
        cachedIntro3D.goldMat,
        cachedIntro3D.inkSolidMat
      );
    }
    return currentSlices;
  }

  function seek(stageEl, u, options = {}) {
    if (!stageEl || typeof document === 'undefined') return null;

    preloadWheelImages();
    loadThree();

    const targetType = options.targetType || null;
    const clampedU = clamp01(u);
    let session = activeIntros.get(stageEl);

    if (!session || session.targetType !== targetType) {
      stopForElement(stageEl);
      const dom = buildIntroDOM(targetType, options.label);
      stageEl.appendChild(dom.overlay);
      session = {
        raf: null,
        overlay: dom.overlay,
        dom,
        targetType,
        durationMs: Math.max(1200, Number(options.durationMs) || DEFAULT_DURATION_MS),
        currentU: clampedU,
        paused: true,
        isScrubbing: true,
        keepMountedOnComplete: true,
        onProgress: options.onProgress || null,
        onComplete: options.onComplete || null,
        cuesFired: {},
        lastPegIndex: null,
      };
      activeIntros.set(stageEl, session);
    } else if (options.label && session.dom && session.dom.badgeTitle) {
      session.dom.badgeTitle.textContent = `${options.label.toUpperCase()}!`;
    }

    session.currentU = clampedU;
    session.isScrubbing = true;
    resetAudioCuesForProgress(session, clampedU);

    const state = computeIntroStateAt(clampedU, targetType);
    applyStateToDOM(session.dom, state, true);

    if (typeof session.onProgress === 'function') {
      session.onProgress(clampedU, state);
    }
    return state;
  }

  function play(stageEl, options = {}) {
    if (!stageEl || typeof document === 'undefined') return null;
    stopForElement(stageEl);

    const forcePlay = Boolean(options.forcePlay);
    if (!introEnabled && !forcePlay) {
      if (typeof options.onComplete === 'function') options.onComplete();
      return null;
    }

    if (!forcePlay) {
      const reduced =
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const inCompactHost =
        typeof stageEl.closest === 'function' &&
        Boolean(
          stageEl.closest(
            '#host-q-text, .host-q-text, .host-question-text, .wb-host-question-box, .is-compact'
          )
        );
      if (reduced || inCompactHost) {
        if (typeof options.onComplete === 'function') options.onComplete();
        return null;
      }
    }

    preloadWheelImages();
    loadThree();
    getAudioContext();

    const targetType = options.targetType || null;
    const durationMs = Math.max(1200, Number(options.durationMs) || DEFAULT_DURATION_MS);
    const startU = clamp01(Number(options.startU) || 0);
    const keepMountedOnComplete = Boolean(options.keepMountedOnComplete);
    const dom = buildIntroDOM(targetType, options.label);

    stageEl.appendChild(dom.overlay);

    const initialState = computeIntroStateAt(startU, targetType);
    resetLiveCurtainSim(initialState.curtainOpenAmount);

    const session = {
      raf: null,
      overlay: dom.overlay,
      dom,
      targetType,
      durationMs,
      currentU: startU,
      paused: false,
      isScrubbing: false,
      keepMountedOnComplete,
      onProgress: options.onProgress || null,
      onComplete: options.onComplete || null,
      cuesFired: {},
      lastPegIndex: null,
      lastFrameTime: Date.now(),
    };
    resetAudioCuesForProgress(session, startU);
    activeIntros.set(stageEl, session);

    const tick = () => {
      if (!activeIntros.has(stageEl) || !dom.overlay.isConnected) {
        stopForElement(stageEl);
        return;
      }

      // Nessun tetto al passo: il sipario va a tempo col server (la sala monta
      // il minigioco sotto le tende chiuse a un istante preciso), quindi un
      // fotogramma lento si recupera invece di far scivolare tutta la scena.
      const now = Date.now();
      const dtMs = Math.max(0, now - session.lastFrameTime);
      session.lastFrameTime = now;

      if (!session.paused) {
        const prevU = session.currentU;
        const nextU = clamp01(prevU + dtMs / session.durationMs);
        session.currentU = nextU;
        session.isScrubbing = false;

        const state = computeIntroStateAt(nextU, session.targetType);
        processSessionAudioCues(session, prevU, nextU, state);
        applyStateToDOM(dom, state, false);

        if (typeof session.onProgress === 'function') {
          session.onProgress(nextU, state);
        }

        if (nextU >= 1) {
          if (session.keepMountedOnComplete) {
            session.paused = true;
            if (typeof session.onComplete === 'function') {
              session.onComplete();
            }
            return;
          }
          stopForElement(stageEl);
          if (typeof session.onComplete === 'function') {
            session.onComplete();
          }
          return;
        }
      } else {
        const state = computeIntroStateAt(session.currentU, session.targetType);
        applyStateToDOM(dom, state, session.isScrubbing);
      }

      session.raf = requestAnimationFrame(tick);
    };

    applyStateToDOM(dom, initialState, false);
    if (startU === 0) {
      processSessionAudioCues(session, 0, 0.003, initialState);
    }
    if (typeof session.onProgress === 'function') {
      session.onProgress(startU, initialState);
    }
    session.raf = requestAnimationFrame(tick);

    return {
      cancel() {
        stopForElement(stageEl);
      },
      pause() {
        session.paused = true;
      },
      resume() {
        session.paused = false;
        session.isScrubbing = false;
        session.lastFrameTime = Date.now();
      },
      seek(newU) {
        const clamped = clamp01(newU);
        session.currentU = clamped;
        session.isScrubbing = true;
        resetAudioCuesForProgress(session, clamped);
        const st = computeIntroStateAt(clamped, session.targetType);
        applyStateToDOM(dom, st, true);
        if (typeof session.onProgress === 'function') {
          session.onProgress(clamped, st);
        }
      },
    };
  }

  return {
    get SLICES() {
      return currentSlices;
    },
    DEFAULT_MINIGAMES,
    RETRO_STREET_SLICE_PALETTE,
    TIMELINE,
    ACTS_META,
    DEFAULT_DURATION_MS,
    MARQUEE_SIGN_TEXT,
    buildWheelSlices,
    setWheelConfig,
    getWheelSlices() {
      return currentSlices;
    },
    getSliceIndexForType,
    computeWheelTargetRotation,
    computeIntroStateAt,
    computeAnalyticalCurtainPhysics,
    /**
     * Scarica in anticipo three.js e le immagini della ruota. Senza, il primo
     * sipario della serata passerebbe i suoi primi fotogrammi ad aspettare
     * l'import, e la chiusura delle tende andrebbe persa.
     */
    preload() {
      preloadWheelImages();
      return loadThree();
    },
    play,
    seek,
    stopForElement,
    stopAll,
    triggerAudioCue,
    setMuted(muted) {
      audioMuted = Boolean(muted);
    },
    isMuted() {
      return audioMuted;
    },
    setIntroEnabled(enabled) {
      introEnabled = Boolean(enabled);
      if (!introEnabled) {
        stopAll();
      }
    },
    isIntroEnabled() {
      return introEnabled;
    },
  };
});
