'use strict';

/**
 * tools/make-sala-audio.js
 *
 * Genera i temi musicali della sala e gli effetti del tempo che scorre,
 * sintetizzandoli con gli stessi strumenti dei minigiochi.
 *
 *   node tools/make-sala-audio.js
 *
 * Cosa produce, in resources/audio/:
 *   music/quiz.ogg    il tema sotto le domande e le classifiche
 *   music/final.ogg   il tema della premiazione
 *   sfx/countdown-*   "Pronti?", i tre colpi del 3-2-1 e il "VIA!"
 *   sfx/timer-*       il tic-tac del timer, più teso verso la fine
 *   sfx/time-up, round-start, winner
 *
 * La musica della lobby (music/lobby.ogg) NON nasce qui: è una traccia vera.
 * Come ogni altro suono del progetto questi file sono SOSTITUIBILI: la sala
 * legge resources/audio/manifest.json, quindi rimpiazzarne uno con una
 * registrazione vera, tenendo lo stesso nome, non richiede toccare codice.
 *
 * Serve `ffmpeg` nel PATH, solo per gli OGG. Strumento da riga di comando,
 * non fa parte del server.
 */

const {
  RATE, midiOf, hz, seconds, makeNoise,
  pulseNote, triangleNote, kick, snare, hat, woodblock,
  mixInto, renderLoop, masterMusic, masterSfx, build, flattenMelody, writeAll,
} = require('./make-minigame-audio');

/** Accordo → fondamentale (MIDI, registro basso) e intervalli. */
const chord = (root, iv) => ({ root: midiOf(root), iv });
const MAJ = [0, 4, 7];
const MIN = [0, 3, 7];
const DOM7 = [0, 4, 7, 10];
const CHORDS = {
  Em: chord('E2', MIN), C: chord('C2', MAJ), G: chord('G2', MAJ), D: chord('D2', MAJ),
  Am: chord('A2', MIN), B7: chord('B1', DOM7), F: chord('F2', MAJ),
};

/** Piatto: rumore chiaro che si spegne piano, sugli accenti. */
function crash(seed, len = 1.1) {
  const noise = makeNoise(seed);
  let prev = 0;
  return build(len, (t) => {
    const n = noise();
    const v = (n - prev * 0.7) * Math.exp(-t * 3.6);
    prev = n;
    return v;
  });
}

// ═══ Tema del quiz ═══════════════════════════════════════════════════════════
//
// Mi minore, 116 bpm, 32 battute (66 s): un groove che "pensa". Basso
// sincopato, batteria leggera, un arpeggio in sedicesimi che fa da orologio e
// una melodia rada che lascia spazio a chi legge la domanda. A-B con melodia,
// poi otto battute di solo groove (il respiro), poi di nuovo B.

const QUIZ_BPM = 116;
const QUIZ_PROGRESSION = [
  'Em', 'Em', 'C', 'C', 'G', 'G', 'D', 'D',
  'Em', 'Em', 'C', 'C', 'Am', 'B7', 'Em', 'B7',
];
const QUIZ_MELODY_A = [
  [['B4', 2], ['E5', 2], ['G5', 1], ['F#5', 1], ['E5', 2]],
  [['R', 2], ['B4', 1], ['D5', 1], ['E5', 4]],
  [['C5', 2], ['E5', 2], ['G5', 1], ['E5', 1], ['C5', 2]],
  [['R', 2], ['G4', 1], ['C5', 1], ['E5', 2], ['D5', 2]],
  [['D5', 2], ['G5', 2], ['B5', 1], ['A5', 1], ['G5', 2]],
  [['R', 2], ['D5', 1], ['G5', 1], ['B5', 4]],
  [['A5', 2], ['F#5', 2], ['D5', 1], ['F#5', 1], ['A5', 2]],
  [['R', 2], ['A4', 1], ['D5', 1], ['F#5', 2], ['R', 2]],
];
const QUIZ_MELODY_B = [
  [['E5', 1], ['G5', 1], ['B5', 2], ['E5', 1], ['G5', 1], ['B5', 2]],
  [['A5', 1], ['G5', 1], ['F#5', 1], ['E5', 1], ['B4', 4]],
  [['E5', 1], ['G5', 1], ['C6', 2], ['E5', 1], ['G5', 1], ['C6', 2]],
  [['B5', 1], ['A5', 1], ['G5', 1], ['E5', 1], ['C5', 4]],
  [['A4', 1], ['C5', 1], ['E5', 1], ['A5', 1], ['G5', 2], ['E5', 2]],
  [['F#5', 2], ['D#5', 2], ['B4', 2], ['D#5', 1], ['F#5', 1]],
  [['G5', 2], ['E5', 2], ['B4', 2], ['E5', 2]],
  [['F#5', 2], ['A5', 2], ['B5', 2], ['R', 2]],
];
const REST_BAR = [['R', 8]];

function quizMusic() {
  const beat = 60 / QUIZ_BPM;
  const eighth = beat / 2;
  const sixteenth = beat / 4;
  const bars = 32;
  const melody = flattenMelody([
    ...QUIZ_MELODY_A, ...QUIZ_MELODY_B,
    ...Array(8).fill(REST_BAR), ...QUIZ_MELODY_B,
  ]);
  return renderLoop(bars * 4 * beat, (buf) => {
    for (let b = 0; b < bars; b++) {
      const c = CHORDS[QUIZ_PROGRESSION[b % 16]];
      const bar0 = b * 4 * beat;
      const breather = b >= 16 && b < 24;

      // Basso sincopato: 1, il levare del 2, il 3 sulla quinta, il levare del 4.
      const BASS = [[0, 0, 1.2], [3, 0, 0.8], [4, 7, 1.2], [7, 12, 0.8]];
      for (const [at8, iv, len8] of BASS) {
        mixInto(buf, bar0 + at8 * eighth, triangleNote(hz(c.root + iv), len8 * eighth), 0.6);
      }

      // L'orologio: arpeggio in sedicesimi, piano, su due ottave.
      const tones = [c.iv[0], c.iv[1], c.iv[2], 12, c.iv[2], c.iv[1]];
      for (let i = 0; i < 16; i++) {
        const iv = tones[i % tones.length];
        mixInto(buf, bar0 + i * sixteenth,
          pulseNote(hz(c.root + 24 + iv), sixteenth * 0.55, { duty: 0.125, release: 0.03 }),
          i % 4 === 0 ? 0.075 : 0.05);
      }

      // Batteria: cassa su 1 e 3 (più il levare del 3), rullante su 2 e 4.
      mixInto(buf, bar0, kick(), 0.42);
      mixInto(buf, bar0 + 2 * beat, kick(), 0.36);
      mixInto(buf, bar0 + 2.5 * beat, kick(), 0.22);
      for (const off of [1, 3]) mixInto(buf, bar0 + off * beat, snare(5000 + b * 7 + off), breather ? 0.12 : 0.2);
      for (let i = 0; i < 8; i++) mixInto(buf, bar0 + i * eighth, hat(700 + b * 8 + i), i % 2 ? 0.13 : 0.07);
      // Nel respiro, un blocchetto di legno risponde sui levare.
      if (breather) for (const at8 of [3, 7]) mixInto(buf, bar0 + at8 * eighth, woodblock(1320), 0.16);
      if (b % 8 === 0) mixInto(buf, bar0, crash(60 + b), 0.1);
    }
    for (const n of melody) {
      mixInto(buf, n.at8 * eighth,
        pulseNote(hz(n.midi), n.len8 * eighth * 0.8, { duty: 0.25, vibrato: n.len8 >= 4 ? 0.2 : 0 }), 0.17);
    }
  });
}

// ═══ Tema della premiazione ══════════════════════════════════════════════════
//
// Marcia trionfale in do maggiore, 126 bpm, 16 battute: ottoni a onda quadra
// in ottave, basso che marcia in quarti, rullante da parata e un piatto a
// ogni frase. È il tema del podio: deve suonare come una festa già vinta.

const FINAL_BPM = 126;
const FINAL_PROGRESSION = [
  'C', 'C', 'F', 'G', 'C', 'Am', 'F', 'G',
  'F', 'G', 'Em', 'Am', 'F', 'G', 'C', 'C',
];
const FINAL_MELODY = [
  [['G4', 1], ['G4', 1], ['C5', 2], ['E5', 2], ['G5', 2]],
  [['E5', 3], ['C5', 1], ['G5', 4]],
  [['A5', 2], ['A5', 1], ['G5', 1], ['F5', 2], ['A5', 2]],
  [['G5', 4], ['D5', 2], ['G5', 2]],
  [['G4', 1], ['G4', 1], ['C5', 2], ['E5', 2], ['G5', 2]],
  [['C6', 3], ['B5', 1], ['A5', 4]],
  [['A5', 2], ['G5', 1], ['F5', 1], ['E5', 2], ['F5', 2]],
  [['D5', 2], ['G5', 2], ['B5', 2], ['D6', 2]],
  [['C6', 2], ['A5', 2], ['F5', 2], ['A5', 2]],
  [['B5', 2], ['G5', 2], ['D5', 2], ['G5', 2]],
  [['B5', 3], ['G5', 1], ['E5', 4]],
  [['C6', 3], ['A5', 1], ['E5', 4]],
  [['F5', 1], ['G5', 1], ['A5', 2], ['C6', 2], ['A5', 2]],
  [['G5', 1], ['A5', 1], ['B5', 2], ['D6', 4]],
  [['C6', 4], ['G5', 2], ['E5', 2]],
  [['C5', 2], ['R', 2], ['G4', 1], ['G4', 1], ['G4', 2]],
];

function finalMusic() {
  const beat = 60 / FINAL_BPM;
  const eighth = beat / 2;
  const bars = FINAL_PROGRESSION.length;
  return renderLoop(bars * 4 * beat, (buf) => {
    FINAL_PROGRESSION.forEach((name, b) => {
      const c = CHORDS[name];
      const bar0 = b * 4 * beat;
      // Basso in marcia: fondamentale, quinta, fondamentale, quinta.
      [0, 7, 0, 7].forEach((iv, q) => {
        mixInto(buf, bar0 + q * beat, triangleNote(hz(c.root + iv), beat * 0.7), 0.58);
      });
      // Accordo tenuto degli ottoni di fila, ribattuto a metà battuta.
      for (const at of [0, 2]) {
        for (const iv of c.iv) {
          mixInto(buf, bar0 + at * beat, pulseNote(hz(c.root + 24 + iv), beat * 1.7, { duty: 0.5, release: 0.08 }), 0.045);
        }
      }
      // Rullante da parata: "ta, ta-ta, ta, ta-ta-ta-ta".
      const SNARE = [0, 2, 3, 4, 6, 6.5, 7, 7.5];
      SNARE.forEach((at8, i) => mixInto(buf, bar0 + at8 * eighth, snare(8000 + b * 16 + i, 0.09), at8 % 2 === 0 ? 0.2 : 0.12));
      mixInto(buf, bar0, kick(), 0.45);
      mixInto(buf, bar0 + 2 * beat, kick(), 0.38);
      if (b % 4 === 0) mixInto(buf, bar0, crash(90 + b), 0.16);
    });
    for (const n of flattenMelody(FINAL_MELODY)) {
      const len = n.len8 * eighth * 0.85;
      const opts = { duty: 0.5, attack: 0.012, release: 0.07, vibrato: n.len8 >= 3 ? 0.22 : 0 };
      // La tromba e, un'ottava sotto, il trombone che la raddoppia.
      mixInto(buf, n.at8 * eighth, pulseNote(hz(n.midi), len, opts), 0.19);
      mixInto(buf, n.at8 * eighth, pulseNote(hz(n.midi - 12), len, { ...opts, duty: 0.25 }), 0.09);
    }
  });
}

// ═══ Conto alla rovescia d'apertura ══════════════════════════════════════════

/** Un colpo intonato: il "bip" dei semafori di partenza. */
function beep(f, dur, release = 0.12) {
  const out = new Float32Array(seconds(dur + release));
  mixInto(out, 0, pulseNote(f, dur, { duty: 0.5, attack: 0.004, release }), 0.55);
  mixInto(out, 0, triangleNote(f / 2, dur, { release }), 0.6);
  return out;
}

/** `countdown-ready` — "Pronti?": un fruscio che sale e due note d'attesa. */
function countdownReady() {
  const noise = makeNoise(21);
  let lp = 0;
  const out = build(0.6, (t) => {
    lp += (noise() - lp) * (0.03 + 0.4 * t);
    return lp * Math.sin(Math.PI * Math.min(1, t / 0.6)) * 0.9;
  });
  mixInto(out, 0.22, pulseNote(hz(midiOf('E5')), 0.07, { duty: 0.25 }), 0.5);
  mixInto(out, 0.34, pulseNote(hz(midiOf('B5')), 0.16, { duty: 0.25, release: 0.1 }), 0.5);
  return out;
}

/** `countdown-beep` — 3, 2, 1: lo stesso colpo tre volte, come al semaforo. */
const countdownBeep = () => beep(hz(midiOf('A4')), 0.16);

/** `countdown-go` — "VIA!": il colpo un'ottava sopra, lungo, con l'accordo e il piatto. */
function countdownGo() {
  const out = new Float32Array(seconds(1.1));
  mixInto(out, 0, beep(hz(midiOf('A5')), 0.5, 0.35), 1);
  for (const n of ['C#5', 'E5', 'A5', 'C#6']) {
    mixInto(out, 0, pulseNote(hz(midiOf(n)), 0.45, { duty: 0.25, release: 0.4, vibrato: 0.2, vibratoDelay: 0.08 }), 0.2);
  }
  mixInto(out, 0, crash(33, 1.0), 0.5);
  mixInto(out, 0, kick(0.3, 150, 45), 0.9);
  return out;
}

// ═══ Il timer ════════════════════════════════════════════════════════════════

/** `timer-tick` — un secondo che passa: "tic" (alto) e "toc" (basso) alternati. */
function timerTick(f) {
  const noise = makeNoise(Math.round(f));
  const wood = woodblock(f, 0.06);
  return build(0.06, (t) => wood[Math.min(wood.length - 1, Math.round(t * RATE))] + noise() * Math.exp(-t * 500) * 0.3);
}

/** `timer-urgent` — ultimi dieci secondi: il tic con un battito sotto. */
function timerUrgent() {
  const out = new Float32Array(seconds(0.2));
  mixInto(out, 0, timerTick(2100), 1);
  mixInto(out, 0, kick(0.18, 110, 50), 0.8);
  return out;
}

/** `timer-last` — ultimi tre secondi: un colpo intonato, impossibile da ignorare. */
const timerLast = () => beep(hz(midiOf('E5')), 0.1, 0.1);

/** `time-up` — tempo scaduto: due note che scendono e un tonfo. */
function timeUp() {
  const out = new Float32Array(seconds(0.9));
  mixInto(out, 0, pulseNote(hz(midiOf('E4')), 0.16, { duty: 0.5, release: 0.05 }), 0.6);
  mixInto(out, 0.2, pulseNote(hz(midiOf('A3')), 0.4, { duty: 0.5, release: 0.25 }), 0.65);
  mixInto(out, 0.2, triangleNote(hz(midiOf('A2')), 0.4, { release: 0.25 }), 0.7);
  mixInto(out, 0.2, kick(0.3, 120, 40), 0.7);
  return out;
}

// ═══ Momenti della partita ═══════════════════════════════════════════════════

/** `round-start` — una domanda nuova entra in scena: fruscio e due note in salita. */
function roundStart() {
  const noise = makeNoise(55);
  let lp = 0;
  const out = build(0.42, (t) => {
    lp += (noise() - lp) * (0.05 + 0.6 * t);
    return lp * Math.sin(Math.PI * Math.min(1, t / 0.3)) * (t < 0.3 ? 0.7 : 0);
  });
  mixInto(out, 0.12, pulseNote(hz(midiOf('G5')), 0.06, { duty: 0.25 }), 0.5);
  mixInto(out, 0.2, pulseNote(hz(midiOf('D6')), 0.12, { duty: 0.25, release: 0.09 }), 0.5);
  return out;
}

/** `winner` — la coppa al primo: squillo in arpeggio, accordo tenuto, piatto. */
function winner() {
  const out = new Float32Array(seconds(2.2));
  ['G4', 'C5', 'E5', 'G5'].forEach((n, i) => {
    mixInto(out, i * 0.1, pulseNote(hz(midiOf(n)), 0.085, { duty: 0.5, release: 0.04 }), 0.55);
  });
  for (const n of ['C4', 'G4', 'C5', 'E5', 'G5', 'C6']) {
    mixInto(out, 0.42, pulseNote(hz(midiOf(n)), 1.1, { duty: 0.5, attack: 0.01, release: 0.6, vibrato: 0.22, vibratoDelay: 0.15 }), 0.22);
  }
  mixInto(out, 0.42, triangleNote(hz(midiOf('C3')), 1.1, { release: 0.6 }), 0.5);
  mixInto(out, 0.42, crash(77, 1.7), 0.45);
  mixInto(out, 0.42, kick(0.35, 140, 42), 0.8);
  return out;
}

// ─── Scrittura ───────────────────────────────────────────────────────────────

writeAll({
  music: {
    'quiz.ogg': () => masterMusic(quizMusic()),
    'final.ogg': () => masterMusic(finalMusic()),
  },
  sfx: {
    'countdown-ready-01.wav': () => masterSfx(countdownReady()),
    'countdown-beep-01.wav': () => masterSfx(countdownBeep()),
    'countdown-go-01.wav': () => masterSfx(countdownGo()),
    'timer-tick-01.wav': () => masterSfx(timerTick(1750)),
    'timer-tick-02.wav': () => masterSfx(timerTick(1320)),
    'timer-urgent-01.wav': () => masterSfx(timerUrgent()),
    'timer-last-01.wav': () => masterSfx(timerLast()),
    'time-up-01.wav': () => masterSfx(timeUp()),
    'round-start-01.wav': () => masterSfx(roundStart()),
    'winner-01.wav': () => masterSfx(winner()),
  },
});
console.log('\n  Vanno dichiarati in resources/audio/manifest.json.');
