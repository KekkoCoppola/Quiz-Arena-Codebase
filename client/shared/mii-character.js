'use strict';

/**
 * client/shared/mii-character.js
 *
 * Modulo 3D autonomo e riutilizzabile per il personaggio stilizzato "Blocky Toy"
 * di Quiz-Zata! (ispirato al mockup di riferimento: corpo squadrato/smussato
 * monoblocco con divisa uguale per tutti e 2 proprietà personalizzabili dal
 * giocatore e disaccoppiate dal modello 3D):
 *
 *   1. `skinColor` (Colore della Pelle): può essere qualsiasi colore esadecimale
 *      (es. Rosso Corallo `#f26b5e` come nel mockup, Giallo `#f7d708`, Turchese
 *      `#5ce1e6`, Verde `#7ed957`, Viola `#9b72cf`, Arancio `#ff914d`, Pesca
 *      `#ffb58a`, ecc.) e colora dinamicamente la testa squadrata smussata e
 *      le mani/avambracci.
 *   2. `expression` / `expressionUrl` (Espressione Facciale 2D): mockup 2D
 *      trasparente che viene "appiccicato" come decalcomania 2D sulla faccia
 *      anteriore del blocco testa (separato dalla geometria 3D). Supporta sia
 *      il catalogo di espressioni 2D integrate (`'angry'` identica al mockup
 *      di riferimento, `'happy'`, `'cool'`, `'surprised'`, `'wink'`,
 *      `'fierce'`) sia qualsiasi URL immagine/SVG 2D esterno.
 *   3. Divisa Uniforme per tutti i giocatori: camicia bianca a maniche corte
 *      con colletto 3D, cravattino geometrico con folgore, cintura con fibbia
 *      ottagonale, pantaloni squadrati con cuciture e suole grigie.
 *
 * Sicuro da caricare in Node.js con `require()` per i test unitari.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MiiCharacter3D = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Palette predefinita di colori pelle vibranti (il giocatore può comunque
   * passare qualsiasi colore CSS/Hex arbitrario in `skinColor` o `color`).
   */
  const SKIN_COLOR_PRESETS = Object.freeze([
    Object.freeze({ id: 'coral_red', label: 'Rosso Mockup', hex: '#f26b5e' }),
    Object.freeze({ id: 'sunny_yellow', label: 'Giallo Arcade', hex: '#f7d708' }),
    Object.freeze({ id: 'electric_teal', label: 'Azzurro Ciano', hex: '#5ce1e6' }),
    Object.freeze({ id: 'lime_green', label: 'Verde Lime', hex: '#7ed957' }),
    Object.freeze({ id: 'royal_purple', label: 'Viola Pop', hex: '#9b72cf' }),
    Object.freeze({ id: 'tangerine', label: 'Arancio Vivo', hex: '#ff914d' }),
    Object.freeze({ id: 'warm_peach', label: 'Pesca Classico', hex: '#ffb58a' }),
    Object.freeze({ id: 'hot_pink', label: 'Rosa Shock', hex: '#ff66b3' }),
  ]);

  /**
   * Catalogo delle espressioni facciali 2D "appiccicabili" sulla faccia del personaggio.
   */
  const EXPRESSION_PRESETS = Object.freeze([
    Object.freeze({ id: 'angry', label: 'Arrabbiato (Mockup Ref)' }),
    Object.freeze({ id: 'happy', label: 'Felice / Esultante' }),
    Object.freeze({ id: 'cool', label: 'Spavaldo / Sicuro' }),
    Object.freeze({ id: 'surprised', label: 'Sorpreso / Wow' }),
    Object.freeze({ id: 'wink', label: 'Occhiolino Furbo' }),
    Object.freeze({ id: 'fierce', label: 'Competitivo / Carico' }),
    // Aggiunte in Quiz-Zata! per la scelta dell'avatar (client/shared/avatar-catalog.js)
    Object.freeze({ id: 'laugh', label: 'Risata' }),
    Object.freeze({ id: 'love', label: 'Innamorato' }),
    Object.freeze({ id: 'sleepy', label: 'Assonnato' }),
    Object.freeze({ id: 'shades', label: 'Occhiali da sole' }),
    Object.freeze({ id: 'tongue', label: 'Linguaccia' }),
    Object.freeze({ id: 'nervous', label: 'Nervoso' }),
  ]);

  const RETRO_STREET_PALETTE = Object.freeze(
    SKIN_COLOR_PRESETS.map((p) =>
      Object.freeze({
        id: p.id,
        body: p.hex,
        trim: '#201b0d',
        text: '#201b0d',
      })
    )
  );

  const SKIN_TONES = Object.freeze(SKIN_COLOR_PRESETS.map((p) => p.hex));

  const INK_HEX = '#201b0d';
  const INK_INT = 0x201b0d;

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function extractInitials(name) {
    const cleaned = String(name || '').trim();
    if (!cleaned) return 'QZ';
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return cleaned.slice(0, 2).toUpperCase();
  }

  /**
   * Mappa un valore `expression` o `avatar` in un descrittore di espressione 2D:
   *   - Se è un URL immagine/SVG (`/path/...`, `http...`, `data:image/...`),
   *     usa `expressionType: 'image'` per appiccicare l'immagine 2D sulla faccia.
   *   - Altrimenti seleziona una delle espressioni 2D (`'angry'`, `'happy'`, `'cool'`,
   *     `'surprised'`, `'wink'`, `'fierce'`).
   */
  function resolveExpressionPreset(rawExpression, rawAvatar, index = 0) {
    const candidate = String(rawExpression || rawAvatar || '').trim();
    const lower = candidate.toLowerCase();

    if (
      EXPRESSION_PRESETS.some((p) => p.id === lower)
    ) {
      return { expressionId: lower, expressionUrl: null };
    }

    // Mappatura da emoji o parole chiave
    if (lower.includes('😠') || lower.includes('😡') || lower.includes('🔥') || lower.includes('angry')) {
      return { expressionId: 'angry', expressionUrl: null };
    }
    if (lower.includes('😄') || lower.includes('👑') || lower.includes('🌟') || lower.includes('happy')) {
      return { expressionId: 'happy', expressionUrl: null };
    }
    if (lower.includes('😎') || lower.includes('🦊') || lower.includes('cool')) {
      return { expressionId: 'cool', expressionUrl: null };
    }
    if (lower.includes('😮') || lower.includes('🚀') || lower.includes('🍕') || lower.includes('surprised')) {
      return { expressionId: 'surprised', expressionUrl: null };
    }
    if (lower.includes('😉') || lower.includes('😜') || lower.includes('🦄') || lower.includes('wink')) {
      return { expressionId: 'wink', expressionUrl: null };
    }
    if (lower.includes('⚡') || lower.includes('🎮') || lower.includes('🐯') || lower.includes('fierce')) {
      return { expressionId: 'fierce', expressionUrl: null };
    }

    // Se è un URL esplicito di una texture/mockup espressione 2D
    if (
      candidate.startsWith('http://') ||
      candidate.startsWith('https://') ||
      candidate.startsWith('data:image/') ||
      (candidate.startsWith('/') && !candidate.includes('/cup-game/') && !candidate.includes('/morra-cinese/') && !candidate.includes('Logo'))
    ) {
      return { expressionId: 'custom_image', expressionUrl: candidate };
    }

    const fallbackPreset = EXPRESSION_PRESETS[Math.max(0, Number(index) || 0) % EXPRESSION_PRESETS.length];
    return { expressionId: fallbackPreset.id, expressionUrl: null };
  }

  function detectAvatarType(rawAvatar, explicitType) {
    const val = String(rawAvatar || '').trim();
    if (!val) return 'initials';

    if (explicitType === 'image' || explicitType === 'emoji' || explicitType === 'initials' || explicitType === 'expression') {
      return explicitType;
    }

    if (
      val.startsWith('http://') ||
      val.startsWith('https://') ||
      val.startsWith('/') ||
      val.startsWith('./') ||
      val.startsWith('data:image/') ||
      /\.(svg|png|jpe?g|webp|gif)(\?.*)?$/i.test(val)
    ) {
      return 'image';
    }

    const hasNonAsciiOrEmoji = /[^\u0000-\u007F]/.test(val) && val.length <= 8;
    if (hasNonAsciiOrEmoji) {
      return 'emoji';
    }

    return 'initials';
  }

  /**
   * Normalizza la configurazione di un personaggio 3D mantenendo completamente
   * separati dal modello 3D:
   *   - `skinColor`: colore della pelle (qualsiasi colore)
   *   - `expression`: espressione facciale 2D appiccicata sulla faccia
   */
  function normalizeMiiConfig(raw = {}, index = 0) {
    const idx = Math.max(0, Number(index) || 0);
    const presetColor = SKIN_COLOR_PRESETS[idx % SKIN_COLOR_PRESETS.length].hex;
    const skinColor = String(raw.skinColor || raw.color || raw.skinTone || raw.bodyColor || presetColor).trim();
    const name = String(raw.name || `Giocatore ${idx + 1}`).trim();

    const rawAvatarInput = raw.avatar !== undefined ? raw.avatar : raw.avatarValue;
    const avatarType = detectAvatarType(rawAvatarInput, raw.avatarType);
    let avatarValue = String(rawAvatarInput || '').trim();
    if (avatarType === 'initials' && (!avatarValue || avatarValue.length > 4)) {
      avatarValue = extractInitials(name);
    } else if (avatarType === 'initials') {
      avatarValue = avatarValue.toUpperCase();
    }

    const expr = resolveExpressionPreset(raw.expression, rawAvatarInput, idx);

    return Object.freeze({
      id: String(raw.id || `mii_${idx + 1}`),
      name,
      rank: typeof raw.rank === 'number' && Number.isFinite(raw.rank) ? raw.rank : idx + 1,
      skinColor,
      skinTone: skinColor,
      bodyColor: skinColor,
      trimColor: INK_HEX,
      badgeBgColor: skinColor,
      badgeTextColor: INK_HEX,
      expression: expr.expressionId,
      expressionUrl: raw.expressionUrl || expr.expressionUrl || null,
      avatar: avatarValue,
      avatarType,
      avatarValue,
      initialsFallback: extractInitials(name),
      scale: clamp(Number(raw.scale) || 1.0, 0.5, 2.5),
      phaseOffset:
        typeof raw.phaseOffset === 'number'
          ? raw.phaseOffset
          : ((idx * 1.37) % (Math.PI * 2)),
    });
  }

  /**
   * Campana cosinusoidale C2-continua centrata in `center` con semilarghezza `halfWidth`.
   * Vale 1 in `center` e 0 (con derivata prima nulla) fuori da `[center - halfWidth, center + halfWidth]`.
   */
  function smoothBell(x, center, halfWidth) {
    if (!(halfWidth > 0)) return 0;
    const d = Math.abs(x - center) / halfWidth;
    if (d >= 1) return 0;
    return 0.5 * (1 + Math.cos(d * Math.PI));
  }

  /**
   * Calcola un ciclo di salto biomeccanico 100% C∞-continuo basato su armoniche
   * trigonometriche pure (zero rami `if/else`, zero pause piatte a terra, zero scatti
   * di scala o inclinazione tra fasi):
   *   - compressione elastica continua nel punto inferiore (`u ~ 0.00..0.11` e `u ~ 0.89..1.00`)
   *   - allungamento fluido in spinta (`u ~ 0.20..0.32`)
   *   - hang-time morbido in vetta (`u ~ 0.50`)
   *
   * @param {number} rawPhase Qualsiasi valore reale (avvolto in modo periodico in [0, 1))
   */
  function computeFluidJumpCycle(rawPhase) {
    const u = ((Number(rawPhase) || 0) % 1 + 1) % 1;
    const theta = u * Math.PI * 2;

    // Onda verticale continua sin^2(pi * u): tocca 0 dolcemente con derivata nulla
    // senza mai bloccarsi piatta per frazioni del ciclo.
    const s = 0.5 * (1 - Math.cos(theta)); // in [0, 1]
    const heightNorm = s * (0.88 + 0.12 * s);

    // Serie armonica di Fourier a 2 armoniche per lo squash & stretch:
    // - u = 0.09 -> ~0.909 (squat di caricamento)
    // - u = 0.24 -> ~1.070 (stretch di spinta in salita)
    // - u = 0.50 -> ~1.060 (morbido in vetta)
    // - u = 0.91 -> ~0.875 (ammortizzazione elastica d'atterraggio)
    const squashY =
      1.0 -
      0.105 * Math.cos(theta) -
      0.045 * Math.cos(2 * theta) +
      0.032 * Math.sin(theta);

    const scaleXZ = 1.0 / Math.sqrt(Math.max(0.75, squashY));

    // Inclinazione busto, apertura braccia e raccoglimento gambe C∞-continui
    const pitchX = -0.065 * Math.sin(theta) + 0.038 * Math.cos(theta);
    const armLift = 0.5 * (1 - Math.cos(theta - 0.18));
    const kneeTuck = heightNorm * 0.38 - 0.12 * Math.cos(theta);

    return {
      u,
      heightNorm,
      squashY,
      scaleXZ,
      pitchX,
      armLift,
      kneeTuck,
    };
  }

  /**
   * Calcola in modo puramente matematico, deterministico e C∞-continuo la posa
   * cinematica del personaggio "Blocky Toy" all'istante `tSec` (in secondi).
   *
   * Mantiene la compatibilità con tutte le chiavi (`rootY`, `leftHand`, `rightHand`,
   * `trophyAnchor`, oltre agli angoli delle braccia `leftArmRotZ`, `rightArmRotZ`,
   * `leftArmRotX`, `rightArmRotX`).
   */
  function computeMiiPose(pose = 'idle', tSec = 0, options = {}) {
    const t = Number(tSec) || 0;
    const phase = Number(options.phaseOffset) || 0;
    const intensity = clamp(
      options.intensity !== undefined ? Number(options.intensity) : 1.0,
      0,
      2.0
    );
    const extraSpin = Number(options.spinRad) || 0;
    const w = t * 4.2 + phase;

    let rootY = 0;
    let rootRotY = extraSpin;
    let bodyTiltX = 0;
    let bodyTiltZ = 0;
    let bodyScaleY = 1.0;
    let bodyScaleXZ = 1.0;

    let headPitchX = 0;
    let headYawY = 0;
    let headRollZ = 0;

    // Angoli delle braccia tozze (a riposo inclinate a ~34° verso l'esterno come nel mockup!)
    let leftArmRotZ = -0.56;
    let rightArmRotZ = 0.56;
    let leftArmRotX = 0.0;
    let rightArmRotX = 0.0;

    // Posizioni equivalenti delle mani (usate anche dai test e dall'ancoraggio)
    let leftHand = { x: -0.72, y: 0.62, z: 0.08 };
    let rightHand = { x: 0.72, y: 0.62, z: 0.08 };

    let leftFoot = { x: -0.27, y: 0.0, z: 0.0, rotX: 0 };
    let rightFoot = { x: 0.27, y: 0.0, z: 0.0, rotX: 0 };

    let trophyAnchor = { x: 0, y: 1.92, z: 0.18, rotZ: 0, scale: 1 };

    if (pose === 'podium_jump' || (pose === 'hop_in' && typeof options.jumpProgress === 'number')) {
      // Salto coreografato d'ingresso sul podio guidato da `jumpProgress` in [0, 1]
      // formulato con campane cosinusoidali sovrapposte (zero `if/else`, zero `Math.abs` e zero discontinuità!)
      const jp = clamp(Number(options.jumpProgress) || 0, 0, 1);

      const hopBell = smoothBell(jp, 0.16, 0.16); // Balzo d'approccio iniziale
      const crouchBell = smoothBell(jp, 0.39, 0.17); // Squat elastico di anticipazione
      const airBell = smoothBell(jp, 0.67, 0.25); // Grande arco di volo verso il gradino
      const landBell = smoothBell(jp, 0.93, 0.10); // Ammortizzazione morbida d'atterraggio

      // Derivata morbida dell'arco di volo (+1 in salita, 0 in vetta, -1 in discesa)
      const airVel =
        jp > 0.42 && jp < 0.92
          ? Math.sin(((0.67 - jp) / 0.25) * (Math.PI * 0.5)) * airBell
          : 0;
      const stride = Math.sin(jp * Math.PI * 4) * hopBell;

      rootY = -0.045 * crouchBell - 0.038 * landBell;
      bodyScaleY =
        1.0 +
        0.06 * hopBell -
        0.155 * crouchBell +
        0.095 * airBell -
        0.125 * landBell;
      bodyScaleXZ = 1.0 / Math.sqrt(Math.max(0.76, bodyScaleY));

      bodyTiltX =
        0.11 * hopBell +
        0.19 * crouchBell -
        0.13 * airVel +
        0.11 * landBell;
      bodyTiltZ = stride * 0.075 + Math.sin(jp * Math.PI * 2) * 0.038 * airBell;

      headPitchX =
        -0.06 * hopBell -
        0.14 * crouchBell -
        0.12 * airBell +
        0.08 * landBell;
      headRollZ = -stride * 0.05;

      leftArmRotZ =
        -0.56 -
        0.55 * hopBell +
        0.14 * crouchBell -
        1.48 * airBell -
        0.45 * landBell;
      rightArmRotZ =
        0.56 +
        0.55 * hopBell -
        0.14 * crouchBell +
        1.48 * airBell +
        0.45 * landBell;

      leftArmRotX =
        stride * 0.55 +
        0.62 * crouchBell -
        0.34 * airBell -
        0.15 * landBell;
      rightArmRotX =
        -stride * 0.55 +
        0.62 * crouchBell -
        0.34 * airBell -
        0.15 * landBell;

      const footTuck = 0.06 * hopBell + 0.10 * airBell;
      leftFoot.y = footTuck + Math.max(0, stride) * 0.04;
      rightFoot.y = footTuck + Math.max(0, -stride) * 0.04;
      leftFoot.rotX =
        -stride * 0.38 +
        0.24 * crouchBell -
        0.44 * airBell +
        0.14 * landBell;
      rightFoot.rotX =
        stride * 0.38 +
        0.24 * crouchBell -
        0.40 * airBell +
        0.14 * landBell;

      const handLift = 0.66 + 0.25 * hopBell + 0.58 * airBell;
      leftHand = { x: -0.74, y: handLift, z: 0.18 };
      rightHand = { x: 0.74, y: handLift, z: 0.18 };
    } else if (pose === 'hop_in' || pose === 'walk') {
      const cycle = computeFluidJumpCycle(t * 1.15 + phase / (Math.PI * 2));
      const stride = Math.sin(w * 1.05);
      rootY = cycle.heightNorm * 0.24 * intensity;
      bodyScaleY = 1.0 + (cycle.squashY - 1.0) * 0.58 * intensity;
      bodyScaleXZ = 1.0 / Math.sqrt(Math.max(0.78, bodyScaleY));
      bodyTiltX = (0.06 + cycle.pitchX * 0.55) * intensity;
      bodyTiltZ = stride * 0.055 * intensity;
      headPitchX = -cycle.pitchX * 0.38;
      headRollZ = -stride * 0.035;

      leftArmRotZ = -0.66 - cycle.armLift * 0.42 * intensity;
      rightArmRotZ = 0.66 + cycle.armLift * 0.42 * intensity;
      leftArmRotX = stride * 0.40 * intensity;
      rightArmRotX = -stride * 0.40 * intensity;

      leftHand = { x: -0.74, y: 0.85 + cycle.heightNorm * 0.22, z: 0.16 + stride * 0.2 };
      rightHand = { x: 0.74, y: 0.85 + cycle.heightNorm * 0.22, z: 0.16 - stride * 0.2 };

      leftFoot.rotX = -stride * 0.30 * intensity;
      rightFoot.rotX = stride * 0.30 * intensity;
      leftFoot.y = Math.max(0, cycle.kneeTuck) * 0.06 * intensity;
      rightFoot.y = Math.max(0, cycle.kneeTuck) * 0.06 * intensity;
    } else if (pose === 'cheer' || pose === 'applaud') {
      // Folla esultante: oscillazioni armoniche morbide e continue (senza fremiti rapidi!)
      const cycle = computeFluidJumpCycle(t * 0.84 + phase / (Math.PI * 2));
      const clapWave = 0.5 - 0.5 * Math.cos(w * 1.15);
      const swayWave = Math.sin(w * 0.55);

      rootY = cycle.heightNorm * 0.21 * intensity;
      bodyScaleY = 1.0 + (cycle.squashY - 1.0) * 0.48 * intensity;
      bodyScaleXZ = 1.0 / Math.sqrt(Math.max(0.80, bodyScaleY));
      bodyTiltX = cycle.pitchX * 0.40 * intensity;
      bodyTiltZ = swayWave * 0.048 * intensity;
      headPitchX = -0.06 * cycle.heightNorm;
      headRollZ = swayWave * 0.04;

      // Braccia sollevate che applaudono / esultano morbidamente a ritmo continuo
      leftArmRotZ = -1.86 + (1 - clapWave) * 0.42 - cycle.heightNorm * 0.15;
      rightArmRotZ = 1.86 - (1 - clapWave) * 0.42 + cycle.heightNorm * 0.15;
      leftArmRotX = -0.38 - 0.05 * Math.sin(w * 0.85);
      rightArmRotX = -0.38 + 0.05 * Math.sin(w * 0.85);

      leftFoot.rotX = -cycle.kneeTuck * 0.24;
      rightFoot.rotX = -cycle.kneeTuck * 0.22;
      leftFoot.y = Math.max(0, cycle.kneeTuck) * 0.05;
      rightFoot.y = Math.max(0, cycle.kneeTuck) * 0.05;

      const spreadX = (0.18 + clapWave * 0.28) * Math.max(0.5, intensity);
      const clapY = 1.04 + cycle.heightNorm * 0.16;
      leftHand = { x: -spreadX, y: clapY, z: 0.36 };
      rightHand = { x: spreadX, y: clapY, z: 0.36 };
    } else if (pose === 'podium_3rd' || pose === 'wave') {
      const cycle = computeFluidJumpCycle(t * 0.78 + phase / (Math.PI * 2));
      const wave = Math.sin(w * 1.25);

      rootY = cycle.heightNorm * 0.12 * intensity;
      bodyScaleY = 1.0 + (cycle.squashY - 1.0) * 0.38 * intensity;
      bodyScaleXZ = 1.0 / Math.sqrt(Math.max(0.84, bodyScaleY));
      bodyTiltX = cycle.pitchX * 0.28 * intensity;
      bodyTiltZ = (-0.02 + wave * 0.038) * intensity;
      headRollZ = wave * 0.04 * intensity;
      headPitchX = -0.045 * cycle.heightNorm * intensity;

      // Braccio destro alzato che saluta fluidamente, braccio sinistro morbido
      leftArmRotZ = -0.54 - cycle.heightNorm * 0.10 * intensity;
      rightArmRotZ = 0.56 + (1.74 + wave * 0.24) * Math.min(1, intensity);
      rightArmRotX = -0.15 * Math.min(1, intensity);

      leftFoot.rotX = -cycle.kneeTuck * 0.18 * intensity;
      rightFoot.rotX = -cycle.kneeTuck * 0.18 * intensity;

      leftHand = { x: -0.68, y: 0.64, z: 0.12 };
      rightHand = { x: 0.64 + wave * 0.14, y: 1.44 + cycle.heightNorm * 0.10, z: 0.20 };
    } else if (pose === 'podium_2nd') {
      const cycle = computeFluidJumpCycle(t * 0.84 + phase / (Math.PI * 2));
      const sway = Math.sin(w * 1.10);

      rootY = cycle.heightNorm * 0.14 * intensity;
      bodyScaleY = 1.0 + (cycle.squashY - 1.0) * 0.42 * intensity;
      bodyScaleXZ = 1.0 / Math.sqrt(Math.max(0.84, bodyScaleY));
      bodyTiltX = cycle.pitchX * 0.30 * intensity;
      bodyTiltZ = sway * 0.048 * intensity;
      headRollZ = -sway * 0.036 * intensity;
      headPitchX = -0.05 * cycle.heightNorm * intensity;

      leftArmRotZ = -0.56 + (-1.62 + sway * 0.18 - cycle.heightNorm * 0.12) * Math.min(1, intensity);
      rightArmRotZ = 0.56 + (1.62 + sway * 0.18 + cycle.heightNorm * 0.12) * Math.min(1, intensity);
      leftArmRotX = -0.15 * Math.min(1, intensity);
      rightArmRotX = -0.15 * Math.min(1, intensity);

      leftFoot.rotX = -cycle.kneeTuck * 0.20 * intensity;
      rightFoot.rotX = -cycle.kneeTuck * 0.20 * intensity;

      leftHand = { x: -0.62, y: 1.38 + cycle.heightNorm * 0.10, z: 0.22 };
      rightHand = { x: 0.62, y: 1.38 + cycle.heightNorm * 0.10, z: 0.22 };
    } else if (pose === 'podium_1st' || pose === 'champion_trophy') {
      const cycle = computeFluidJumpCycle(t * 0.90 + phase / (Math.PI * 2));
      const sway = Math.sin(w * 0.85);

      rootY = cycle.heightNorm * 0.16 * intensity;
      bodyScaleY = 1.0 + (cycle.squashY - 1.0) * 0.46 * intensity;
      bodyScaleXZ = 1.0 / Math.sqrt(Math.max(0.84, bodyScaleY));
      bodyTiltX = cycle.pitchX * 0.28 * intensity;
      bodyTiltZ = sway * 0.036 * intensity;
      headPitchX = -0.055 * cycle.heightNorm * intensity;
      headRollZ = sway * 0.032 * intensity;

      // Il 1° classificato impugna e solleva la Coppa d'Oro ben visibile nella mano destra!
      leftArmRotZ = -0.64 - cycle.heightNorm * 0.22 * intensity;
      rightArmRotZ = 2.02 + cycle.heightNorm * 0.14 * intensity;
      leftArmRotX = -0.12;
      rightArmRotX = -0.16;

      leftFoot.rotX = -cycle.kneeTuck * 0.20 * intensity;
      rightFoot.rotX = -cycle.kneeTuck * 0.20 * intensity;
      leftFoot.y = Math.max(0, cycle.kneeTuck) * 0.04 * intensity;
      rightFoot.y = Math.max(0, cycle.kneeTuck) * 0.04 * intensity;

      const liftY = 1.66 + cycle.heightNorm * 0.16;
      leftHand = { x: -0.62, y: liftY, z: 0.18 };
      rightHand = { x: 0.86, y: liftY, z: 0.22 };

      trophyAnchor = {
        x: 0.86,
        y: 1.76 + cycle.heightNorm * 0.12,
        z: 0.18,
        rotZ: -0.08,
        scale: 1.0,
      };
    } else {
      // 'idle': posa iconica del mockup con respiro sinusoidale continuo (senza cuspidi!)
      const breath = 0.5 - 0.5 * Math.cos(w * 0.72);
      rootY = breath * 0.026 * intensity;
      bodyScaleY = 1.0 + (breath - 0.5) * 0.026;
      bodyScaleXZ = 1.0 / Math.sqrt(bodyScaleY);
      leftArmRotZ = -0.56 - breath * 0.038;
      rightArmRotZ = 0.56 + breath * 0.038;
    }

    return {
      pose,
      rootY,
      rootRotY,
      bodyTiltX,
      bodyTiltZ,
      bodyScaleY,
      bodyScaleXZ,
      headPitchX,
      headYawY,
      headRollZ,
      leftArmRotZ,
      rightArmRotZ,
      leftArmRotX,
      rightArmRotX,
      leftHand,
      rightHand,
      leftFoot,
      rightFoot,
      trophyAnchor,
    };
  }

  function easeFluidArc(x) {
    const c = clamp(x, 0, 1);
    return 1 - Math.pow(1 - c, 2.2);
  }

  /**
   * Costruisce un `THREE.Shape` trapezoidale con angoli arrotondati centrato in X,
   * perfetto per riprodurre i blocchi smussati in stile vinile/Pixar del mockup.
   */
  function createRoundedTrapezoidShape(THREE, bottomW, topW, height, radius) {
    const shape = new THREE.Shape();
    const bw = bottomW / 2;
    const tw = topW / 2;
    const r = Math.min(radius, height * 0.3, bw * 0.3, tw * 0.3);

    shape.moveTo(-bw + r, 0);
    shape.lineTo(bw - r, 0);
    shape.quadraticCurveTo(bw, 0, bw, r);
    shape.lineTo(tw, height - r);
    shape.quadraticCurveTo(tw, height, tw - r, height);
    shape.lineTo(-tw + r, height);
    shape.quadraticCurveTo(-tw, height, -tw, height - r);
    shape.lineTo(-bw, r);
    shape.quadraticCurveTo(-bw, 0, -bw + r, 0);
    shape.closePath();
    return shape;
  }

  const geometryCacheByThree = new WeakMap();

  function getSharedGeometries(THREE) {
    if (geometryCacheByThree.has(THREE)) {
      return geometryCacheByThree.get(THREE);
    }

    const bevelOpts = {
      steps: 1,
      depth: 0.54,
      bevelEnabled: true,
      bevelThickness: 0.09,
      bevelSize: 0.075,
      bevelSegments: 4,
    };

    // 1. Blocco Testa Squadrata Smussata (parte superiore del personaggio, y = 0 .. 0.66)
    // Leggermente rastremata verso l'alto proprio come nel mockup allegato!
    const headShape = createRoundedTrapezoidShape(THREE, 1.06, 0.94, 0.64, 0.08);
    const headBlockGeo = new THREE.ExtrudeGeometry(headShape, bevelOpts);
    headBlockGeo.translate(0, 0, -bevelOpts.depth / 2);

    // 2. Blocco Camicia Bianca Uniforme (parte centrale, y = 0 .. 0.40)
    const shirtShape = createRoundedTrapezoidShape(THREE, 0.98, 1.06, 0.38, 0.05);
    const shirtBlockGeo = new THREE.ExtrudeGeometry(shirtShape, {
      ...bevelOpts,
      bevelThickness: 0.085,
      bevelSize: 0.07,
    });
    shirtBlockGeo.translate(0, 0, -bevelOpts.depth / 2);

    // 3. Cintura Uniforme + Fibbia Ottagonale 3D
    const beltShape = createRoundedTrapezoidShape(THREE, 0.98, 0.99, 0.09, 0.02);
    const beltGeo = new THREE.ExtrudeGeometry(beltShape, {
      steps: 1,
      depth: 0.56,
      bevelEnabled: true,
      bevelThickness: 0.085,
      bevelSize: 0.07,
      bevelSegments: 3,
    });
    beltGeo.translate(0, 0, -0.28);

    const buckleRimGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.06, 8);
    const buckleInnerGeo = new THREE.CylinderGeometry(0.068, 0.068, 0.07, 8);

    // 4. Colletto Camicia 3D (due alette smussate sotto il mento) + Cravattino 3D
    const collarFlapGeo = new THREE.BoxGeometry(0.44, 0.075, 0.06);

    const tieShape = new THREE.Shape();
    tieShape.moveTo(-0.055, 0.0);
    tieShape.lineTo(0.055, 0.0);
    tieShape.lineTo(0.085, -0.15);
    tieShape.lineTo(0.0, -0.24);
    tieShape.lineTo(-0.085, -0.15);
    tieShape.closePath();
    const tieGeo = new THREE.ExtrudeGeometry(tieShape, {
      steps: 1,
      depth: 0.04,
      bevelEnabled: true,
      bevelThickness: 0.015,
      bevelSize: 0.012,
      bevelSegments: 2,
    });

    // 5. Gambe Squadrate Smussate (Sinistra e Destra separate da intaglio centrale a V) + Suole
    const legShape = createRoundedTrapezoidShape(THREE, 0.36, 0.44, 0.31, 0.04);
    const legGeo = new THREE.ExtrudeGeometry(legShape, {
      steps: 1,
      depth: 0.48,
      bevelEnabled: true,
      bevelThickness: 0.07,
      bevelSize: 0.055,
      bevelSegments: 3,
    });
    legGeo.translate(0, 0, -0.24);

    const shoeShape = createRoundedTrapezoidShape(THREE, 0.35, 0.36, 0.075, 0.02);
    const shoeGeo = new THREE.ExtrudeGeometry(shoeShape, {
      steps: 1,
      depth: 0.48,
      bevelEnabled: true,
      bevelThickness: 0.065,
      bevelSize: 0.05,
      bevelSegments: 2,
    });
    shoeGeo.translate(0, 0, -0.24);

    // 6. Braccia Tozze (Manica corta bianca + Mano/Avambraccio squadrato nel colore della pelle)
    const sleeveGeo = new THREE.BoxGeometry(0.22, 0.22, 0.24);
    sleeveGeo.translate(0, -0.09, 0);

    const forearmGeo = new THREE.BoxGeometry(0.20, 0.24, 0.22);
    forearmGeo.translate(0, -0.28, 0);

    // 7. Piano Decalcomania 2D Espressione Facciale (appiccicato sulla faccia anteriore)
    const faceDecalGeo = new THREE.PlaneGeometry(0.96, 0.56);

    // 8. Ombra di contatto e Targhetta SOLO NOME sopra la testa
    const shadowDiscGeo = new THREE.CircleGeometry(0.62, 24);
    const nameTagPlaneGeo = new THREE.PlaneGeometry(1.82, 0.50);

    const cached = Object.freeze({
      headBlockGeo,
      shirtBlockGeo,
      beltGeo,
      buckleRimGeo,
      buckleInnerGeo,
      collarFlapGeo,
      tieGeo,
      legGeo,
      shoeGeo,
      sleeveGeo,
      forearmGeo,
      faceDecalGeo,
      shadowDiscGeo,
      nameTagPlaneGeo,
    });

    geometryCacheByThree.set(THREE, cached);
    return cached;
  }

  /**
   * Disegna il mockup 2D dell'espressione facciale (su sfondo 100% trasparente!)
   * che viene "appiccicato" sulla faccia del modello 3D.
   *
   * L'espressione `'angry'` riproduce fedelmente il mockup inviato dall'utente:
   *   - Sopracciglio unico corrucciato a V asimmetrica in rilievo
   *   - Grandi occhi bianchi semichiusi sotto il sopracciglio con pupille scure
   *   - Bocca trapezoidale spalancata con denti stretti e griglia dentale!
   */
  function draw2DFacialExpression(ctx, w, h, expressionId, skinColorHex) {
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const cx = w * 0.5;

    if (expressionId === 'angry') {
      // =======================================================================
      // ESPRESSIONE 1: "ANGRY" (Fedele al Mockup di riferimento!)
      // =======================================================================
      // 1. Grandi bulbi oculari bianchi tagliati in alto dal sopracciglio
      ctx.save();
      // Occhio sinistro
      ctx.beginPath();
      ctx.moveTo(cx - 165, 58);
      ctx.lineTo(cx - 12, 92);
      ctx.bezierCurveTo(cx - 12, 162, cx - 168, 162, cx - 165, 58);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#5a221d';
      ctx.stroke();

      // Pupilla sinistra
      ctx.beginPath();
      ctx.arc(cx - 74, 96, 30, 0, Math.PI * 2);
      ctx.fillStyle = '#8b433b';
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#4a1c17';
      ctx.stroke();

      // Occhio destro (più ampio sul lato esterno come nel mockup)
      ctx.beginPath();
      ctx.moveTo(cx + 12, 92);
      ctx.lineTo(cx + 175, 42);
      ctx.bezierCurveTo(cx + 185, 160, cx + 12, 162, cx + 12, 92);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#5a221d';
      ctx.stroke();

      // Pupilla destra
      ctx.beginPath();
      ctx.arc(cx + 68, 90, 32, 0, Math.PI * 2);
      ctx.fillStyle = '#8b433b';
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#4a1c17';
      ctx.stroke();
      ctx.restore();

      // 2. Sopracciglio corrucciato a V asimmetrica sopra gli occhi
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx - 182, 50);
      ctx.quadraticCurveTo(cx - 45, 92, cx + 4, 94);
      ctx.quadraticCurveTo(cx + 55, 92, cx + 115, 44);
      ctx.quadraticCurveTo(cx + 155, 22, cx + 190, 34);
      ctx.lineWidth = 22;
      ctx.strokeStyle = '#5a221d';
      ctx.stroke();

      ctx.lineWidth = 12;
      ctx.strokeStyle = '#8b433b';
      ctx.stroke();
      ctx.restore();

      // 3. Bocca digrignante trapezoidale con chiostra di denti bianchi
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx - 148, 266);
      ctx.quadraticCurveTo(cx - 132, 172, cx - 72, 168);
      ctx.quadraticCurveTo(cx, 178, cx + 76, 172);
      ctx.quadraticCurveTo(cx + 138, 178, cx + 158, 266);
      ctx.quadraticCurveTo(cx, 246, cx - 148, 266);
      ctx.closePath();

      // Interno bocca scuro
      ctx.fillStyle = '#5a221d';
      ctx.fill();
      ctx.lineWidth = 10;
      ctx.strokeStyle = '#5a221d';
      ctx.stroke();

      // Clip denti
      ctx.clip();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - 145, 168, 295, 96);

      // Linea orizzontale tra arcata superiore e inferiore + righe verticali denti
      ctx.strokeStyle = '#5a221d';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(cx - 150, 222);
      ctx.quadraticCurveTo(cx, 214, cx + 160, 224);
      ctx.stroke();

      [-92, -38, 18, 72, 118].forEach((dx) => {
        ctx.beginPath();
        ctx.moveTo(cx + dx, 165);
        ctx.lineTo(cx + dx + (dx * 0.08), 270);
        ctx.stroke();
      });
      ctx.restore();
    } else if (expressionId === 'happy') {
      // =======================================================================
      // ESPRESSIONE 2: "HAPPY" (Grande sorriso entusiasta da vincitore)
      // =======================================================================
      // Sopracciglia alte gioiose
      ctx.strokeStyle = '#201b0d';
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.arc(cx - 88, 66, 48, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + 88, 66, 48, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();

      // Grandi occhi bianchi ovali + pupille brillanti
      [-86, 86].forEach((dx) => {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.ellipse(cx + dx, 102, 54, 42, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 7;
        ctx.strokeStyle = '#201b0d';
        ctx.stroke();

        ctx.fillStyle = '#201b0d';
        ctx.beginPath();
        ctx.arc(cx + dx * 0.82, 104, 22, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(cx + dx * 0.82 - 7, 96, 7, 0, Math.PI * 2);
        ctx.fill();
      });

      // Grande sorriso aperto con denti bianchi superiori e lingua
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx - 142, 178);
      ctx.quadraticCurveTo(cx, 192, cx + 142, 178);
      ctx.bezierCurveTo(cx + 135, 286, cx - 135, 286, cx - 142, 178);
      ctx.closePath();
      ctx.fillStyle = '#4a1c17';
      ctx.fill();
      ctx.lineWidth = 9;
      ctx.strokeStyle = '#201b0d';
      ctx.stroke();
      ctx.clip();

      // Arcata dentale superiore bianca
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - 145, 170, 290, 44);
      ctx.strokeStyle = '#201b0d';
      ctx.lineWidth = 5;
      ctx.strokeRect(cx - 145, 170, 290, 44);

      // Lingua corallo
      ctx.fillStyle = '#e05a47';
      ctx.beginPath();
      ctx.ellipse(cx, 265, 68, 34, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (expressionId === 'cool') {
      // =======================================================================
      // ESPRESSIONE 3: "COOL" (Sguardo sicuro e sorriso obliquo spavaldo)
      // =======================================================================
      [-86, 86].forEach((dx, i) => {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.ellipse(cx + dx, 102, 54, 38, 0, 0, Math.PI);
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = 8;
        ctx.strokeStyle = '#201b0d';
        ctx.stroke();

        ctx.fillStyle = '#201b0d';
        ctx.beginPath();
        ctx.arc(cx + dx * 0.85, 114, 20, 0, Math.PI * 2);
        ctx.fill();

        // Sopracciglio piatto/arcuato
        ctx.beginPath();
        if (i === 0) {
          ctx.moveTo(cx - 145, 84);
          ctx.lineTo(cx - 26, 90);
        } else {
          ctx.moveTo(cx + 26, 86);
          ctx.quadraticCurveTo(cx + 88, 52, cx + 148, 76);
        }
        ctx.lineWidth = 14;
        ctx.stroke();
      });

      // Ghigno sicuro coi denti
      ctx.beginPath();
      ctx.moveTo(cx - 125, 222);
      ctx.quadraticCurveTo(cx + 15, 228, cx + 135, 182);
      ctx.quadraticCurveTo(cx + 115, 262, cx - 125, 222);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 8;
      ctx.strokeStyle = '#201b0d';
      ctx.stroke();
    } else if (expressionId === 'surprised') {
      // =======================================================================
      // ESPRESSIONE 4: "SURPRISED" (Occhi sgranati e bocca a O di stupore)
      // =======================================================================
      ctx.strokeStyle = '#201b0d';
      ctx.lineWidth = 12;
      [-92, 92].forEach((dx) => {
        ctx.beginPath();
        ctx.arc(cx + dx, 54, 46, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(cx + dx, 105, 50, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 7;
        ctx.stroke();

        ctx.fillStyle = '#201b0d';
        ctx.beginPath();
        ctx.arc(cx + dx * 0.85, 105, 18, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.fillStyle = '#4a1c17';
      ctx.beginPath();
      ctx.ellipse(cx, 224, 52, 44, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 9;
      ctx.strokeStyle = '#201b0d';
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(cx, 194, 34, 10, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (expressionId === 'wink') {
      // =======================================================================
      // ESPRESSIONE 5: "WINK" (Occhiolino furbo + linguetta)
      // =======================================================================
      // Occhio sinistro chiuso a V (occhiolino)
      ctx.strokeStyle = '#201b0d';
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(cx - 138, 82);
      ctx.lineTo(cx - 42, 106);
      ctx.lineTo(cx - 138, 132);
      ctx.stroke();

      // Occhio destro aperto
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(cx + 88, 102, 52, 44, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 7;
      ctx.stroke();

      ctx.fillStyle = '#201b0d';
      ctx.beginPath();
      ctx.arc(cx + 76, 102, 22, 0, Math.PI * 2);
      ctx.fill();

      // Sorriso con linguetta laterale
      ctx.beginPath();
      ctx.moveTo(cx - 120, 204);
      ctx.quadraticCurveTo(cx, 248, cx + 124, 198);
      ctx.lineWidth = 11;
      ctx.stroke();

      ctx.fillStyle = '#e05a47';
      ctx.beginPath();
      ctx.arc(cx + 52, 224, 28, 0, Math.PI);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 7;
      ctx.stroke();
    } else if (expressionId === 'laugh') {
      // =======================================================================
      // ESPRESSIONE 7: "LAUGH" (Occhi chiusi a ^ ^ e bocca spalancata)
      // =======================================================================
      ctx.strokeStyle = '#201b0d';
      ctx.lineWidth = 16;
      [-88, 88].forEach((dx) => {
        ctx.beginPath();
        ctx.moveTo(cx + dx - 44, 120);
        ctx.quadraticCurveTo(cx + dx, 60, cx + dx + 44, 120);
        ctx.stroke();
      });

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx - 150, 170);
      ctx.lineTo(cx + 150, 170);
      ctx.bezierCurveTo(cx + 140, 300, cx - 140, 300, cx - 150, 170);
      ctx.closePath();
      ctx.fillStyle = '#4a1c17';
      ctx.fill();
      ctx.lineWidth = 9;
      ctx.stroke();
      ctx.clip();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - 150, 166, 300, 34);
      ctx.fillStyle = '#e05a47';
      ctx.beginPath();
      ctx.ellipse(cx, 272, 70, 36, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (expressionId === 'love') {
      // =======================================================================
      // ESPRESSIONE 8: "LOVE" (Occhi a cuore e sorriso)
      // =======================================================================
      const heart = (x, y, s) => {
        ctx.beginPath();
        ctx.moveTo(x, y + s * 0.3);
        ctx.bezierCurveTo(x, y, x - s * 0.5, y, x - s * 0.5, y + s * 0.3);
        ctx.bezierCurveTo(x - s * 0.5, y + s * 0.6, x, y + s * 0.75, x, y + s);
        ctx.bezierCurveTo(x, y + s * 0.75, x + s * 0.5, y + s * 0.6, x + s * 0.5, y + s * 0.3);
        ctx.bezierCurveTo(x + s * 0.5, y, x, y, x, y + s * 0.3);
        ctx.closePath();
      };
      [-90, 90].forEach((dx) => {
        heart(cx + dx, 46, 116);
        ctx.fillStyle = '#e5383b';
        ctx.fill();
        ctx.lineWidth = 7;
        ctx.strokeStyle = '#201b0d';
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(cx + dx - 26, 78, 9, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.beginPath();
      ctx.moveTo(cx - 112, 200);
      ctx.quadraticCurveTo(cx, 282, cx + 112, 200);
      ctx.lineWidth = 12;
      ctx.strokeStyle = '#201b0d';
      ctx.stroke();
    } else if (expressionId === 'sleepy') {
      // =======================================================================
      // ESPRESSIONE 9: "SLEEPY" (Palpebre chiuse, sbadiglio e zeta)
      // =======================================================================
      ctx.strokeStyle = '#201b0d';
      ctx.lineWidth = 13;
      [-88, 88].forEach((dx) => {
        ctx.beginPath();
        ctx.moveTo(cx + dx - 48, 100);
        ctx.quadraticCurveTo(cx + dx, 142, cx + dx + 48, 100);
        ctx.stroke();
      });

      ctx.fillStyle = '#4a1c17';
      ctx.beginPath();
      ctx.ellipse(cx, 226, 34, 28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 9;
      ctx.stroke();

      // Zeta a tratti, non testo: il disegno non dipende dal font caricato.
      const zee = (x, y, s) => {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + s, y);
        ctx.lineTo(x, y + s);
        ctx.lineTo(x + s, y + s);
        ctx.stroke();
      };
      ctx.lineWidth = 9;
      zee(cx + 158, 44, 44);
      ctx.lineWidth = 7;
      zee(cx + 214, 14, 26);
    } else if (expressionId === 'shades') {
      // =======================================================================
      // ESPRESSIONE 10: "SHADES" (Occhiali da sole e ghigno)
      // =======================================================================
      const lens = (x, y, w, h, r) => {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
      };
      ctx.strokeStyle = '#201b0d';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(cx - 162, 78);
      ctx.lineTo(cx + 162, 78);
      ctx.stroke();
      [-88, 88].forEach((dx) => {
        lens(cx + dx - 70, 72, 140, 76, 22);
        ctx.fillStyle = '#201b0d';
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx + dx - 40, 92);
        ctx.lineTo(cx + dx - 14, 92);
        ctx.lineWidth = 7;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      });

      ctx.beginPath();
      ctx.moveTo(cx - 92, 214);
      ctx.quadraticCurveTo(cx + 10, 252, cx + 112, 194);
      ctx.lineWidth = 12;
      ctx.strokeStyle = '#201b0d';
      ctx.stroke();
    } else if (expressionId === 'tongue') {
      // =======================================================================
      // ESPRESSIONE 11: "TONGUE" (Occhi a > < e linguaccia)
      // =======================================================================
      ctx.strokeStyle = '#201b0d';
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(cx - 140, 74);
      ctx.lineTo(cx - 48, 104);
      ctx.lineTo(cx - 140, 134);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + 140, 74);
      ctx.lineTo(cx + 48, 104);
      ctx.lineTo(cx + 140, 134);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx - 46, 212);
      ctx.lineTo(cx - 46, 258);
      ctx.arc(cx, 258, 46, Math.PI, 0, true);
      ctx.lineTo(cx + 46, 212);
      ctx.closePath();
      ctx.fillStyle = '#e05a47';
      ctx.fill();
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, 224);
      ctx.lineTo(cx, 272);
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#5a221d';
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx - 122, 196);
      ctx.quadraticCurveTo(cx, 236, cx + 122, 196);
      ctx.lineWidth = 11;
      ctx.strokeStyle = '#201b0d';
      ctx.stroke();
    } else if (expressionId === 'nervous') {
      // =======================================================================
      // ESPRESSIONE 12: "NERVOUS" (Sopracciglia in su, bocca a zigzag, goccia)
      // =======================================================================
      ctx.strokeStyle = '#201b0d';
      ctx.lineWidth = 13;
      ctx.beginPath();
      ctx.moveTo(cx - 142, 70);
      ctx.lineTo(cx - 40, 46);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + 142, 70);
      ctx.lineTo(cx + 40, 46);
      ctx.stroke();

      [-88, 88].forEach((dx) => {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(cx + dx, 112, 40, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 7;
        ctx.stroke();
        ctx.fillStyle = '#201b0d';
        ctx.beginPath();
        ctx.arc(cx + dx, 116, 12, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.beginPath();
      ctx.moveTo(cx - 111, 220);
      [-74, -37, 0, 37, 74, 111].forEach((dx, i) => {
        ctx.lineTo(cx + dx, i % 2 === 0 ? 204 : 236);
      });
      ctx.lineWidth = 11;
      ctx.stroke();

      const x = cx + 200;
      const y = 52;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.bezierCurveTo(x + 30, y + 40, x + 22, y + 62, x, y + 62);
      ctx.bezierCurveTo(x - 22, y + 62, x - 30, y + 40, x, y);
      ctx.closePath();
      ctx.fillStyle = '#5ce1e6';
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.stroke();
    } else {
      // =======================================================================
      // ESPRESSIONE 6: "FIERCE" (Sorriso a denti stretti determinato e competitivo)
      // =======================================================================
      [-86, 86].forEach((dx, i) => {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.ellipse(cx + dx, 104, 54, 40, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 7;
        ctx.strokeStyle = '#201b0d';
        ctx.stroke();

        ctx.fillStyle = '#201b0d';
        ctx.beginPath();
        ctx.arc(cx + dx * 0.8, 104, 21, 0, Math.PI * 2);
        ctx.fill();

        // Sopracciglio inclinato determinato
        ctx.beginPath();
        if (i === 0) {
          ctx.moveTo(cx - 148, 56);
          ctx.lineTo(cx - 24, 86);
        } else {
          ctx.moveTo(cx + 24, 86);
          ctx.lineTo(cx + 148, 56);
        }
        ctx.lineWidth = 16;
        ctx.stroke();
      });

      // Grande sorriso largo coi denti stretti
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cx - 140, 188);
      ctx.quadraticCurveTo(cx, 202, cx + 140, 188);
      ctx.quadraticCurveTo(cx + 124, 264, cx, 264);
      ctx.quadraticCurveTo(cx - 124, 264, cx - 140, 188);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 9;
      ctx.strokeStyle = '#201b0d';
      ctx.stroke();
      ctx.clip();

      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(cx - 145, 226);
      ctx.lineTo(cx + 145, 226);
      ctx.stroke();
      [-80, -28, 28, 80].forEach((dx) => {
        ctx.beginPath();
        ctx.moveTo(cx + dx, 185);
        ctx.lineTo(cx + dx, 268);
        ctx.stroke();
      });
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * Crea la `CanvasTexture` trasparente per la decalcomania 2D dell'espressione
   * facciale appiccicata sulla faccia anteriore del blocco testa.
   */
  function createFaceCanvasTexture(THREE, normalizedConfig, onTextureUpdated) {
    if (typeof document === 'undefined') return null;

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 320;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const texture = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) {
      texture.colorSpace = THREE.SRGBColorSpace;
    }

    function renderExpression(loadedImg) {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      if (loadedImg) {
        ctx.drawImage(loadedImg, 16, 16, w - 32, h - 32);
      } else {
        draw2DFacialExpression(
          ctx,
          w,
          h,
          normalizedConfig.expression || 'angry',
          normalizedConfig.skinColor
        );
      }

      texture.needsUpdate = true;
      if (typeof onTextureUpdated === 'function') {
        onTextureUpdated(texture);
      }
    }

    renderExpression(null);

    if (
      normalizedConfig.expressionUrl &&
      typeof Image !== 'undefined'
    ) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        renderExpression(img);
      };
      img.src = normalizedConfig.expressionUrl;
    }

    return texture;
  }

  /**
   * Crea la texture per la Targhetta sopra la testa con SOLO IL NOME del giocatore.
   */
  function createNameOnlyTagTexture(THREE, playerName, options = {}) {
    if (typeof document === 'undefined') return null;

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 140;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const w = canvas.width;
    const h = canvas.height;
    const cleanName = String(playerName || 'Giocatore').trim().slice(0, 18);
    const rank = typeof options.rank === 'number' ? options.rank : null;
    const accent =
      options.accentColor ||
      (rank === 1
        ? '#f7d708'
        : rank === 2
        ? '#90efef'
        : rank === 3
        ? '#f2a65a'
        : '#fff8f1');

    ctx.clearRect(0, 0, w, h);

    function roundRect(x, y, rw, rh, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + rw - r, y);
      ctx.quadraticCurveTo(x + rw, y, x + rw, y + r);
      ctx.lineTo(x + rw, y + rh - r);
      ctx.quadraticCurveTo(x + rw, y + rh, x + rw - r, y + rh);
      ctx.lineTo(x + r, y + rh);
      ctx.quadraticCurveTo(x, y + rh, x, y + rh - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    const padX = 16;
    const padY = 14;
    const cardW = w - padX * 2 - 8;
    const cardH = h - padY * 2 - 8;

    ctx.fillStyle = INK_HEX;
    roundRect(padX + 8, padY + 8, cardW, cardH, 24);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    roundRect(padX, padY, cardW, cardH, 24);
    ctx.fill();
    ctx.lineWidth = 8;
    ctx.strokeStyle = INK_HEX;
    ctx.stroke();

    let textCenterX = padX + cardW / 2;
    if (rank && rank >= 1 && rank <= 3) {
      const badgeR = 32;
      const badgeX = padX + 48;
      const badgeY = padY + cardH / 2;

      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.strokeStyle = INK_HEX;
      ctx.stroke();

      ctx.font = '900 32px "Quicksand", sans-serif';
      ctx.fillStyle = INK_HEX;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${rank}°`, badgeX, badgeY + 2);

      textCenterX = padX + 88 + (cardW - 96) / 2;
    }

    const fontSize = cleanName.length > 12 ? 38 : 44;
    ctx.font = `900 ${fontSize}px "Quicksand", sans-serif`;
    ctx.fillStyle = INK_HEX;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cleanName, textCenterX, padY + cardH / 2 + 2);

    const texture = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) {
      texture.colorSpace = THREE.SRGBColorSpace;
    }
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * Costruisce il personaggio 3D "Blocky Toy" fedele al mockup di riferimento:
   *   - Modello 3D monoblocco smussato con divisa uniforme per tutti i giocatori
   *     (camicia bianca con colletto e cravattino 3D, cintura marrone con fibbia
   *     ottagonale, pantaloni squadrati con intaglio a V e suole grigie).
   *   - Colore della pelle (`skinColor`) separato dal modello e modificabile al volo
   *     con `.setSkinColor(hex)` (colora il blocco testa superiore e gli avambracci).
   *   - Espressione facciale 2D (`expression` / `expressionUrl`) separata dal modello
   *     e "appiccicata" sulla faccia anteriore con `.setExpression(expr)`.
   */
  function createMii(THREE, playerConfig = {}, options = {}) {
    let cfg = normalizeMiiConfig(playerConfig, playerConfig.index || 0);
    const geos = getSharedGeometries(THREE);
    const castShadow = Boolean(options.castShadow);

    const rootGroup = new THREE.Group();
    rootGroup.name = `Mii_${cfg.id}`;
    rootGroup.scale.setScalar(cfg.scale);

    // 1. Ombra di contatto radiale a terra
    const shadowMat = new THREE.MeshBasicMaterial({
      color: INK_INT,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });
    const shadowMesh = new THREE.Mesh(geos.shadowDiscGeo, shadowMat);
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.position.y = 0.015;
    rootGroup.add(shadowMesh);

    const bounceGroup = new THREE.Group();
    rootGroup.add(bounceGroup);

    const bodyGroup = new THREE.Group();
    bounceGroup.add(bodyGroup);

    // =========================================================================
    // MATERIALE 1 (PERSONALIZZABILE): COLORE DELLA PELLE (`skinMat`)
    // Condiviso tra il blocco Testa superiore e i due Avambracci/Mani!
    // =========================================================================
    const skinMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(cfg.skinColor),
      roughness: 0.48,
      metalness: 0.05,
    });

    // =========================================================================
    // MATERIALI DIVISA UNIFORME (Uguali per tutti i giocatori!)
    // =========================================================================
    const shirtMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.45,
      metalness: 0.04,
    });

    const collarLineMat = new THREE.MeshStandardMaterial({
      color: 0xd8dce0,
      roughness: 0.5,
      metalness: 0.05,
    });

    const tieMat = new THREE.MeshStandardMaterial({
      color: 0xe05a47,
      roughness: 0.42,
      metalness: 0.06,
    });

    const beltMat = new THREE.MeshStandardMaterial({
      color: 0x6e533c,
      roughness: 0.55,
      metalness: 0.12,
    });

    const buckleCenterMat = new THREE.MeshStandardMaterial({
      color: 0x353839,
      roughness: 0.4,
      metalness: 0.25,
    });

    const pantsMat = new THREE.MeshStandardMaterial({
      color: 0x8c6d68,
      roughness: 0.62,
      metalness: 0.05,
    });

    const shoeMat = new THREE.MeshStandardMaterial({
      color: 0x8d9499,
      roughness: 0.5,
      metalness: 0.1,
    });

    // -------------------------------------------------------------------------
    // A. GAMBE SQUADRATE + SUOLE GRIGIE (y = 0.00 .. 0.40)
    // -------------------------------------------------------------------------
    const leftLegGroup = new THREE.Group();
    leftLegGroup.position.set(-0.26, 0.0, 0);
    bodyGroup.add(leftLegGroup);

    const leftShoe = new THREE.Mesh(geos.shoeGeo, shoeMat);
    leftShoe.position.y = 0.01;
    leftLegGroup.add(leftShoe);

    const leftLegMesh = new THREE.Mesh(geos.legGeo, pantsMat);
    leftLegMesh.position.y = 0.085;
    leftLegMesh.castShadow = castShadow;
    leftLegGroup.add(leftLegMesh);

    const rightLegGroup = new THREE.Group();
    rightLegGroup.position.set(0.26, 0.0, 0);
    bodyGroup.add(rightLegGroup);

    const rightShoe = new THREE.Mesh(geos.shoeGeo, shoeMat);
    rightShoe.position.y = 0.01;
    rightLegGroup.add(rightShoe);

    const rightLegMesh = new THREE.Mesh(geos.legGeo, pantsMat);
    rightLegMesh.position.y = 0.085;
    rightLegMesh.castShadow = castShadow;
    rightLegGroup.add(rightLegMesh);

    // -------------------------------------------------------------------------
    // B. CINTURA + FIBBIA OTTAGONALE 3D (y = 0.39 .. 0.48)
    // -------------------------------------------------------------------------
    const beltMesh = new THREE.Mesh(geos.beltGeo, beltMat);
    beltMesh.position.y = 0.39;
    bodyGroup.add(beltMesh);

    const buckleRim = new THREE.Mesh(geos.buckleRimGeo, beltMat);
    buckleRim.rotation.x = Math.PI / 2;
    buckleRim.rotation.y = Math.PI / 8;
    buckleRim.position.set(0, 0.435, 0.355);
    bodyGroup.add(buckleRim);

    const buckleInner = new THREE.Mesh(geos.buckleInnerGeo, buckleCenterMat);
    buckleInner.rotation.x = Math.PI / 2;
    buckleInner.rotation.y = Math.PI / 8;
    buckleInner.position.set(0, 0.435, 0.36);
    bodyGroup.add(buckleInner);

    // -------------------------------------------------------------------------
    // C. BLOCCO CAMICIA BIANCA + COLLETTO + CRAVATTINO (y = 0.48 .. 0.86)
    // -------------------------------------------------------------------------
    const shirtMesh = new THREE.Mesh(geos.shirtBlockGeo, shirtMat);
    shirtMesh.position.y = 0.48;
    shirtMesh.castShadow = castShadow;
    bodyGroup.add(shirtMesh);

    const leftCollar = new THREE.Mesh(geos.collarFlapGeo, collarLineMat);
    leftCollar.position.set(-0.27, 0.83, 0.34);
    leftCollar.rotation.z = -0.05;
    bodyGroup.add(leftCollar);

    const rightCollar = new THREE.Mesh(geos.collarFlapGeo, collarLineMat);
    rightCollar.position.set(0.27, 0.83, 0.34);
    rightCollar.rotation.z = 0.05;
    bodyGroup.add(rightCollar);

    const tieMesh = new THREE.Mesh(geos.tieGeo, tieMat);
    tieMesh.position.set(0, 0.85, 0.345);
    bodyGroup.add(tieMesh);

    // -------------------------------------------------------------------------
    // D. BLOCCO TESTA SQUADRATA SMUSSATA + DECALCOMANIA 2D ESPRESSIONE (y = 0.86 .. 1.50)
    // -------------------------------------------------------------------------
    const headPivot = new THREE.Group();
    headPivot.position.set(0, 0.86, 0);
    bodyGroup.add(headPivot);

    const headBlockMesh = new THREE.Mesh(geos.headBlockGeo, skinMat);
    headBlockMesh.castShadow = castShadow;
    headPivot.add(headBlockMesh);

    // Decalcomania 2D dell'espressione facciale appiccicata sulla faccia anteriore!
    let faceTex = createFaceCanvasTexture(THREE, cfg, options.onTextureUpdated);
    const faceDecalMat = new THREE.MeshBasicMaterial({
      map: faceTex || null,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const faceDecalMesh = new THREE.Mesh(geos.faceDecalGeo, faceDecalMat);
    faceDecalMesh.position.set(0, 0.33, 0.368);
    headPivot.add(faceDecalMesh);

    // -------------------------------------------------------------------------
    // E. BRACCIA TOZZE INCLINATE (Manica Bianca + Avambraccio `skinMat`)
    // -------------------------------------------------------------------------
    const leftArmPivot = new THREE.Group();
    leftArmPivot.position.set(-0.56, 0.80, 0.0);
    bodyGroup.add(leftArmPivot);

    const leftSleeve = new THREE.Mesh(geos.sleeveGeo, shirtMat);
    leftArmPivot.add(leftSleeve);

    const leftForearm = new THREE.Mesh(geos.forearmGeo, skinMat);
    leftArmPivot.add(leftForearm);

    const rightArmPivot = new THREE.Group();
    rightArmPivot.position.set(0.56, 0.80, 0.0);
    bodyGroup.add(rightArmPivot);

    const rightSleeve = new THREE.Mesh(geos.sleeveGeo, shirtMat);
    rightArmPivot.add(rightSleeve);

    const rightForearm = new THREE.Mesh(geos.forearmGeo, skinMat);
    rightArmPivot.add(rightForearm);

    // -------------------------------------------------------------------------
    // F. SOCKET MANO DESTRA PER LA COPPA D'ORO 3D + TARGHETTA SOLO NOME
    // -------------------------------------------------------------------------
    // Ancoriamo `propAnchor` direttamente sulla punta della mano destra (`rightArmPivot`)
    // così il 1° classificato stringe e solleva fisicamente la Coppa d'Oro con la mano!
    const propAnchor = new THREE.Group();
    propAnchor.position.set(0.0, -0.33, 0.05);
    rightArmPivot.add(propAnchor);

    let nameTagMesh = null;
    let nameTagTex = null;
    if (options.showNameTag) {
      nameTagTex = createNameOnlyTagTexture(THREE, cfg.name, {
        rank: cfg.rank,
        accentColor: cfg.skinColor,
      });
      const tagMat = new THREE.MeshBasicMaterial({
        map: nameTagTex,
        transparent: true,
        depthTest: true,
        side: THREE.DoubleSide,
      });
      nameTagMesh = new THREE.Mesh(geos.nameTagPlaneGeo, tagMat);
      nameTagMesh.position.set(0, 1.94, 0);
      nameTagMesh.visible = false;
      bounceGroup.add(nameTagMesh);
    }

    /**
     * Cambia dinamicamente il colore della pelle del personaggio 3D (testa + mani).
     */
    function setSkinColor(nextColorHex) {
      if (!nextColorHex) return;
      cfg = normalizeMiiConfig({ ...cfg, skinColor: nextColorHex });
      controller.config = cfg;
      skinMat.color.set(nextColorHex);
    }

    /**
     * Cambia dinamicamente l'espressione facciale 2D appiccicata sulla faccia.
     */
    function setExpression(nextExpressionOrUrl) {
      if (!nextExpressionOrUrl) return;
      // expressionUrl azzerato: senza, tornando da una faccia-immagine a
      // un'espressione pronta l'immagine restava sulla faccia.
      cfg = normalizeMiiConfig({ ...cfg, expression: nextExpressionOrUrl, expressionUrl: null });
      controller.config = cfg;
      if (faceTex) faceTex.dispose();
      faceTex = createFaceCanvasTexture(THREE, cfg, options.onTextureUpdated);
      faceDecalMat.map = faceTex;
      faceDecalMat.needsUpdate = true;
    }

    function applyPose(poseName = 'idle', tSec = 0, poseOpts = {}) {
      const p = computeMiiPose(poseName, tSec, {
        phaseOffset: cfg.phaseOffset,
        ...poseOpts,
      });

      bounceGroup.position.y = p.rootY;
      rootGroup.rotation.y = p.rootRotY;

      bodyGroup.rotation.x = p.bodyTiltX;
      bodyGroup.rotation.z = p.bodyTiltZ;
      bodyGroup.scale.set(p.bodyScaleXZ, p.bodyScaleY, p.bodyScaleXZ);

      headPivot.rotation.set(p.headPitchX || 0, p.headYawY || 0, p.headRollZ || 0);

      leftArmPivot.rotation.z = p.leftArmRotZ;
      leftArmPivot.rotation.x = p.leftArmRotX;
      rightArmPivot.rotation.z = p.rightArmRotZ;
      rightArmPivot.rotation.x = p.rightArmRotX;

      leftLegGroup.position.y = p.leftFoot.y || 0;
      rightLegGroup.position.y = p.rightFoot.y || 0;
      leftLegGroup.rotation.x = p.leftFoot.rotX;
      rightLegGroup.rotation.x = p.rightFoot.rotX;

      // Mantieni la Coppa d'Oro saldamente impugnata nella mano destra e orientata verso l'alto
      propAnchor.position.set(0.0, -0.33, 0.05);
      propAnchor.rotation.x = -p.rightArmRotX;
      propAnchor.rotation.z = -p.rightArmRotZ - 0.12;

      const shadowScale = clamp(1.0 - p.rootY * 0.45, 0.55, 1.05);
      shadowMesh.scale.setScalar(shadowScale);

      return p;
    }

    function setNameTagState(visible, popScale = 1.0, cameraToFace = null) {
      if (!nameTagMesh) return;
      nameTagMesh.visible = Boolean(visible && popScale > 0.01);
      if (nameTagMesh.visible) {
        const s = Math.max(0.01, Number(popScale) || 1.0);
        nameTagMesh.scale.setScalar(s);
        nameTagMesh.position.y = 1.94;
        if (cameraToFace && cameraToFace.position) {
          nameTagMesh.lookAt(cameraToFace.position);
        }
      }
    }

    function dispose() {
      if (faceTex) faceTex.dispose();
      if (nameTagTex) nameTagTex.dispose();
      skinMat.dispose();
      shirtMat.dispose();
      collarLineMat.dispose();
      tieMat.dispose();
      beltMat.dispose();
      buckleCenterMat.dispose();
      pantsMat.dispose();
      shoeMat.dispose();
      faceDecalMat.dispose();
      shadowMat.dispose();
    }

    applyPose('idle', 0);

    const controller = {
      config: cfg,
      group: rootGroup,
      propAnchor,
      nameTagMesh,
      setSkinColor,
      setExpression,
      applyPose,
      setNameTagState,
      dispose,
    };

    rootGroup.userData.miiController = controller;
    return controller;
  }

  return Object.freeze({
    SKIN_COLOR_PRESETS,
    EXPRESSION_PRESETS,
    RETRO_STREET_PALETTE,
    SKIN_TONES,
    extractInitials,
    detectAvatarType,
    resolveExpressionPreset,
    normalizeMiiConfig,
    computeFluidJumpCycle,
    computeMiiPose,
    getSharedGeometries,
    // Esportata per chi vuole una faccia 2D senza il modello (anteprime, strumenti).
    draw2DFacialExpression,
    createFaceCanvasTexture,
    createNameOnlyTagTexture,
    createMii,
  });
});
