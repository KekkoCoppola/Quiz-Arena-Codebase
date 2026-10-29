'use strict';

/**
 * tools/make-minigame-audio.js
 *
 * Genera colonna sonora ed effetti di ogni minigioco, sintetizzandoli.
 *
 *   node tools/make-minigame-audio.js
 *
 * Stessa filosofia di tools/make-sfx.js: niente asset scaricati né di
 * provenienza incerta, il Raspberry gira offline. Il suono è da sala giochi
 * (onde quadre, triangolari, rumore, corde pizzicate), coerente con lo stile
 * "Retro Street" dell'interfaccia. I file sono SOSTITUIBILI: ogni minigioco
 * dichiara i propri nel contratto di presentazione (`audio`), quindi
 * rimpiazzarne uno con una registrazione vera non richiede toccare codice.
 *
 * Le colonne sonore escono in OGG (serve `ffmpeg` nel PATH, solo qui: il
 * server non lo usa), gli effetti in WAV come quelli della sala. Livelli:
 * musica a -18 dBFS medi, come resources/audio/music/bed.ogg; effetti col
 * picco a circa -6 dBFS, come resources/audio/sfx/.
 *
 * Il file è uno strumento da riga di comando, non fa parte del server.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RATE = 44100;
const AUDIO_DIR = path.join(__dirname, '..', 'resources', 'audio');

/** Volume medio delle colonne sonore: lo stesso di bed.ogg (-18 dBFS). */
const MUSIC_RMS = 10 ** (-18 / 20);
/** Picco degli effetti, come quelli già in resources/audio/sfx/. */
const SFX_PEAK = 10 ** (-6 / 20);

// ─── Encoder WAV (PCM 16 bit, mono) ──────────────────────────────────────────

/**
 * @param {Float32Array} samples campioni in [-1, 1]
 * @returns {Buffer} file WAV completo
 */
function encodeWav(samples) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);         // PCM
  buf.writeUInt16LE(1, 22);         // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}

// ─── Note ────────────────────────────────────────────────────────────────────

const NOTE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'A4' → 69, 'C#5' → 73, 'Bb3' → 58. */
function midiOf(name) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error(`nota non valida: ${name}`);
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + NOTE_INDEX[m[1]] + acc;
}

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const seconds = (s) => Math.max(1, Math.round(s * RATE));

/** Rumore deterministico: stesso file a ogni esecuzione, diff stabili. */
function makeNoise(seed) {
  let v = seed >>> 0;
  return () => {
    v = (v * 1664525 + 1013904223) >>> 0;
    return (v / 0xffffffff) * 2 - 1;
  };
}

// ─── Inviluppo ───────────────────────────────────────────────────────────────

/**
 * Attacco lineare, tenuta, rilascio lineare dopo `dur`.
 * @returns {number} in [0, 1]
 */
function envelope(t, dur, attack, release) {
  if (t < attack) return t / attack;
  if (t < dur) return 1;
  return Math.max(0, 1 - (t - dur) / release);
}

// ─── Strumenti ───────────────────────────────────────────────────────────────
//
// Ogni strumento restituisce i campioni di UNA nota, coda di rilascio
// compresa. Le onde sono a banda limitata (somma di armoniche sotto Nyquist):
// un'onda quadra "ingenua" a 44,1 kHz fischia di aliasing sulle note alte.

/**
 * Onda a impulsi (quadra con `duty` 0.5): il timbro della melodia chiptune.
 * @param {number} f frequenza
 * @param {number} dur durata della nota (s), senza coda
 */
function pulseNote(f, dur, { duty = 0.5, attack = 0.005, release = 0.04, vibrato = 0, vibratoDelay = 0.12 } = {}) {
  const out = new Float32Array(seconds(dur + release));
  const harmonics = [];
  for (let n = 1; n <= 14 && n * f < RATE * 0.42; n++) {
    const a = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
    if (Math.abs(a) > 1e-4) harmonics.push([n, a]);
  }
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const vib = vibrato > 0 && t > vibratoDelay
      ? 2 ** ((vibrato * Math.sin(2 * Math.PI * 5.5 * (t - vibratoDelay))) / 12)
      : 1;
    phase += (f * vib) / RATE;
    let v = 0;
    for (const [n, a] of harmonics) v += a * Math.cos(2 * Math.PI * n * phase - Math.PI * n * duty);
    out[i] = v * 1.6 * envelope(t, dur, attack, release);
  }
  return out;
}

/** Onda triangolare: il basso. */
function triangleNote(f, dur, { attack = 0.004, release = 0.05 } = {}) {
  const out = new Float32Array(seconds(dur + release));
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    let v = 0;
    for (let k = 0; k < 6; k++) {
      const n = 2 * k + 1;
      if (n * f >= RATE * 0.42) break;
      v += ((k % 2 === 0 ? 1 : -1) * Math.sin(2 * Math.PI * n * f * t)) / (n * n);
    }
    out[i] = v * (8 / (Math.PI * Math.PI)) * envelope(t, dur, attack, release);
  }
  return out;
}

/**
 * Fischio: sinusoide quasi pura con vibrato che entra dopo l'attacco e un
 * filo di fiato. È la melodia del duello western.
 */
function whistleNote(f, dur, seed) {
  const noise = makeNoise(seed);
  const release = 0.14;
  const out = new Float32Array(seconds(dur + release));
  let phase = 0;
  let breath = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const depth = Math.min(1, Math.max(0, (t - 0.18) / 0.35)) * 0.32;
    // Piccolo scivolo verso la nota all'attacco, come un fischio vero.
    const glide = t < 0.05 ? 2 ** ((-0.6 * (1 - t / 0.05)) / 12) : 1;
    const vib = 2 ** ((depth * Math.sin(2 * Math.PI * 5.2 * t)) / 12);
    phase += (f * vib * glide) / RATE;
    breath += (noise() - breath) * 0.08;
    const tone = Math.sin(2 * Math.PI * phase) + 0.08 * Math.sin(4 * Math.PI * phase);
    out[i] = (tone + breath * 0.25) * envelope(t, dur, 0.06, release);
  }
  return out;
}

/**
 * Corda pizzicata (Karplus-Strong): la chitarra del western. Un'eccitazione
 * di rumore che circola in un ritardo lungo un periodo e si smorza da sé.
 */
function pluckNote(f, dur, seed, brightness = 0.5) {
  const noise = makeNoise(seed);
  const period = Math.max(2, Math.round(RATE / f));
  const ring = new Float32Array(period);
  let prev = 0;
  for (let i = 0; i < period; i++) {
    // Eccitazione già un po' filtrata: meno spigolosa del rumore bianco.
    prev = prev + (noise() - prev) * brightness;
    ring[i] = prev;
  }
  const out = new Float32Array(seconds(dur + 0.3));
  const damping = 0.996;
  for (let i = 0; i < out.length; i++) {
    const j = i % period;
    const next = ring[(j + 1) % period];
    const v = ring[j];
    ring[j] = 0.5 * (v + next) * damping;
    const t = i / RATE;
    out[i] = v * (t < dur ? 1 : Math.max(0, 1 - (t - dur) / 0.3));
  }
  return out;
}

// ─── Percussioni ─────────────────────────────────────────────────────────────

/** Cassa: sinusoide che scende di tono. */
function kick(len = 0.16, from = 120, to = 42) {
  const out = new Float32Array(seconds(len));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const f = to + (from - to) * Math.exp(-t * 28);
    phase += f / RATE;
    out[i] = Math.sin(2 * Math.PI * phase) * Math.exp(-t * 16);
  }
  return out;
}

/** Rullante: rumore con un corpo di tono. */
function snare(seed, len = 0.14) {
  const noise = makeNoise(seed);
  const out = new Float32Array(seconds(len));
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const n = noise();
    lp += (n - lp) * 0.35;
    const body = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30);
    out[i] = (lp * 0.9 + body * 0.5) * Math.exp(-t * 22);
  }
  return out;
}

/** Charleston: rumore passa-alto cortissimo. */
function hat(seed, len = 0.035) {
  const noise = makeNoise(seed);
  const out = new Float32Array(seconds(len));
  let prev = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const n = noise();
    out[i] = (n - prev) * 0.5 * Math.exp(-t * 90);
    prev = n;
  }
  return out;
}

/** Blocchetto di legno: il "clop" del galoppo e lo scatto della ruota. */
function woodblock(f = 1250, len = 0.07) {
  const out = new Float32Array(seconds(len));
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    out[i] = (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.52 * t)) * Math.exp(-t * 70);
  }
  return out;
}

/** Tamburo basso: il passo del duello. */
function tom(len = 0.45) {
  const out = new Float32Array(seconds(len));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    phase += (62 + 40 * Math.exp(-t * 14)) / RATE;
    out[i] = Math.sin(2 * Math.PI * phase) * Math.exp(-t * 7);
  }
  return out;
}

/** Incudine/campana: parziali inarmoniche che suonano a lungo. */
function anvil(len = 1.6) {
  const PARTIALS = [[1, 1], [2.76, 0.6], [5.4, 0.35], [8.93, 0.2]];
  const out = new Float32Array(seconds(len));
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    let v = 0;
    for (const [ratio, amp] of PARTIALS) v += amp * Math.sin(2 * Math.PI * 1180 * ratio * t) * Math.exp(-t * (2.2 + ratio));
    out[i] = v;
  }
  return out;
}

// ─── Montaggio ───────────────────────────────────────────────────────────────

/** Somma `samples` dentro `buf` a partire da `atS` secondi. */
function mixInto(buf, atS, samples, gain) {
  const start = Math.round(atS * RATE);
  for (let i = 0; i < samples.length; i++) {
    const j = start + i;
    if (j >= 0 && j < buf.length) buf[j] += samples[i] * gain;
  }
}

/**
 * Rende un loop di `lengthS` secondi. Le code che sforano la fine vengono
 * riportate all'inizio: è così che il loop si ripete senza giunture, perché
 * la nota che suona a cavallo del punto di ripresa continua invece di
 * troncarsi.
 * @param {(buf: Float32Array) => void} write chiama `mixInto` sul buffer
 */
function renderLoop(lengthS, write) {
  const length = seconds(lengthS);
  const buf = new Float32Array(length + seconds(3));
  write(buf);
  const out = buf.slice(0, length);
  for (let i = length; i < buf.length; i++) out[i - length] += buf[i];
  return out;
}

/** Toglie la componente continua e porta il volume medio a `targetRms`. */
function masterMusic(samples) {
  let mean = 0;
  for (const v of samples) mean += v;
  mean /= samples.length;
  let sq = 0;
  for (let i = 0; i < samples.length; i++) {
    samples[i] -= mean;
    sq += samples[i] * samples[i];
  }
  const k = MUSIC_RMS / Math.sqrt(sq / samples.length);
  // Il limitatore morbido arrotonda i rari picchi oltre il fondo scala invece
  // di tagliarli: tanh è quasi lineare sotto 0,5.
  for (let i = 0; i < samples.length; i++) samples[i] = Math.tanh(samples[i] * k);
  return samples;
}

/** Porta il picco di un effetto a `SFX_PEAK` e smorza la coda (niente click). */
function masterSfx(samples) {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const k = peak > 0 ? SFX_PEAK / peak : 1;
  const fade = Math.min(samples.length, seconds(0.008));
  for (let i = 0; i < samples.length; i++) samples[i] *= k;
  for (let i = 0; i < fade; i++) samples[samples.length - fade + i] *= 1 - i / fade;
  return samples;
}

/** Suono di effetto costruito campione per campione. */
function build(durationS, fn) {
  const out = new Float32Array(seconds(durationS));
  for (let i = 0; i < out.length; i++) out[i] = fn(i / RATE);
  return out;
}

// ─── Accordi ─────────────────────────────────────────────────────────────────

/** Accordo → fondamentale (MIDI, registro basso) e intervalli. */
const CHORDS = {
  Dm: { root: midiOf('D2'), iv: [0, 3, 7] },
  Gm: { root: midiOf('G2'), iv: [0, 3, 7] },
  A7: { root: midiOf('A2'), iv: [0, 4, 7, 10] },
  Bb: { root: midiOf('Bb2'), iv: [0, 4, 7] },
  Am: { root: midiOf('A2'), iv: [0, 3, 7] },
  G:  { root: midiOf('G2'), iv: [0, 4, 7] },
  F:  { root: midiOf('F2'), iv: [0, 4, 7] },
  E:  { root: midiOf('E2'), iv: [0, 4, 7] },
};

/**
 * Una melodia scritta battuta per battuta: ogni battuta è una lista di
 * [nota, durata in ottavi], 'R' è una pausa. Restituisce le note con il loro
 * istante in ottavi dall'inizio.
 */
function flattenMelody(bars) {
  const notes = [];
  bars.forEach((bar, b) => {
    let pos = 0;
    for (const [name, len] of bar) {
      if (name !== 'R') notes.push({ midi: midiOf(name), at8: b * 8 + pos, len8: len });
      pos += len;
    }
    if (pos !== 8) throw new Error(`battuta ${b + 1}: ${pos} ottavi invece di 8`);
  });
  return notes;
}

// ═══ Tre Bicchieri: l'imbonitore di strada ═══════════════════════════════════
//
// Swing da fiera in re minore, 138 bpm, 16 battute: basso "um-pa" sui tempi
// forti, accordi staccati sui deboli, melodia furbetta a onda quadra stretta.
// Il gioco delle tre carte è un trucco da marciapiede: la musica ammicca.

const CUP_BPM = 138;
const CUP_PROGRESSION = [
  'Dm', 'Dm', 'A7', 'Dm', 'Dm', 'Gm', 'A7', 'Dm',
  'Gm', 'Dm', 'A7', 'Dm', 'Bb', 'A7', 'Dm', 'A7',
];
const CUP_MELODY = [
  [['A4', 1], ['D5', 1], ['F5', 1], ['A5', 1], ['G#5', 1], ['A5', 1], ['F5', 2]],
  [['D5', 1], ['F5', 1], ['E5', 1], ['D5', 1], ['C#5', 2], ['D5', 2]],
  [['E5', 1], ['A4', 1], ['C#5', 1], ['E5', 1], ['G5', 1], ['F5', 1], ['E5', 2]],
  [['F5', 1], ['D5', 1], ['A4', 2], ['R', 2], ['A4', 1], ['Bb4', 1]],
  [['A4', 1], ['D5', 1], ['F5', 1], ['A5', 1], ['D6', 2], ['C6', 1], ['Bb5', 1]],
  [['Bb5', 1], ['G5', 1], ['D5', 1], ['G5', 1], ['Bb5', 2], ['A5', 1], ['G5', 1]],
  [['F5', 1], ['E5', 1], ['C#5', 1], ['E5', 1], ['G5', 1], ['F5', 1], ['E5', 1], ['C#5', 1]],
  [['D5', 2], ['A4', 1], ['D5', 1], ['R', 4]],
  [['G5', 1], ['R', 1], ['G5', 1], ['A5', 1], ['Bb5', 2], ['G5', 2]],
  [['F5', 1], ['R', 1], ['F5', 1], ['G5', 1], ['A5', 2], ['F5', 2]],
  [['E5', 1], ['F5', 1], ['E5', 1], ['D5', 1], ['C#5', 1], ['D5', 1], ['E5', 2]],
  [['F5', 1], ['E5', 1], ['D5', 1], ['C#5', 1], ['D5', 2], ['R', 2]],
  [['D5', 1], ['F5', 1], ['Bb5', 1], ['D6', 1], ['C6', 1], ['Bb5', 1], ['A5', 1], ['G5', 1]],
  [['A5', 2], ['E5', 1], ['G5', 1], ['F5', 1], ['E5', 1], ['C#5', 2]],
  [['D5', 1], ['F5', 1], ['A5', 1], ['D6', 1], ['A5', 1], ['F5', 1], ['D5', 1], ['A4', 1]],
  [['C#5', 1], ['E5', 1], ['A5', 1], ['G5', 1], ['F5', 1], ['E5', 1], ['C#5', 1], ['A4', 1]],
];

function cupMusic() {
  const beat = 60 / CUP_BPM;
  // Swing in terzine: l'ottavo in levare cade ai due terzi del battito.
  const at8 = (i) => Math.floor(i / 2) * beat + (i % 2 ? beat * (2 / 3) : 0);
  const bars = CUP_PROGRESSION.length;
  return renderLoop(bars * 4 * beat, (buf) => {
    CUP_PROGRESSION.forEach((name, b) => {
      const chord = CHORDS[name];
      const bar0 = b * 4 * beat;
      // Basso "um-pa": fondamentale sull'1, quinta sul 3.
      mixInto(buf, bar0, triangleNote(hz(chord.root), beat * 0.8), 0.55);
      mixInto(buf, bar0 + 2 * beat, triangleNote(hz(chord.root + 7), beat * 0.8), 0.5);
      // Accordi staccati sul 2 e sul 4, un'ottava e mezza sopra.
      for (const off of [1, 3]) {
        for (const iv of chord.iv.slice(0, 3)) {
          mixInto(buf, bar0 + off * beat, pulseNote(hz(chord.root + 24 + iv), beat * 0.22, { duty: 0.5, release: 0.03 }), 0.07);
        }
        mixInto(buf, bar0 + off * beat, snare(4000 + b * 7 + off), 0.18);
      }
      mixInto(buf, bar0, kick(), 0.38);
      mixInto(buf, bar0 + 2 * beat, kick(), 0.3);
      // Charleston su ogni ottavo, in swing, con l'accento in levare.
      for (let i = 0; i < 8; i++) {
        mixInto(buf, bar0 + at8(i), hat(900 + b * 8 + i), i % 2 ? 0.16 : 0.09);
      }
    });
    for (const n of flattenMelody(CUP_MELODY)) {
      const start = at8(n.at8);
      const end = at8(n.at8 + n.len8);
      // Staccato: la nota occupa due terzi del suo spazio.
      mixInto(buf, start, pulseNote(hz(n.midi), (end - start) * 0.68, { duty: 0.25, vibrato: n.len8 >= 2 ? 0.25 : 0 }), 0.2);
    }
  });
}

// ═══ Morra Cinese: il duello ═════════════════════════════════════════════════
//
// Western in la minore, 92 bpm, 16 battute: chitarra pizzicata in arpeggio,
// fischio solista, galoppo di blocchetti di legno, tamburo basso e un colpo
// d'incudine a fine frase. Due mani, tre mosse, mezzogiorno di fuoco.

const MORRA_BPM = 92;
const MORRA_PROGRESSION = [
  'Am', 'Am', 'G', 'G', 'F', 'F', 'E', 'E',
  'Am', 'Am', 'Dm', 'Dm', 'Am', 'F', 'E', 'E',
];
const MORRA_MELODY = [
  [['A4', 2], ['E5', 6]],
  [['D5', 1], ['C5', 1], ['B4', 2], ['A4', 4]],
  [['G4', 2], ['D5', 6]],
  [['C5', 1], ['B4', 1], ['A4', 2], ['G4', 4]],
  [['F4', 2], ['C5', 4], ['A4', 2]],
  [['C5', 2], ['F5', 6]],
  [['E5', 2], ['D5', 1], ['C5', 1], ['B4', 4]],
  [['G#4', 4], ['R', 2], ['E4', 2]],
  [['A4', 2], ['C5', 2], ['E5', 4]],
  [['A5', 6], ['G5', 1], ['E5', 1]],
  [['F5', 4], ['E5', 2], ['D5', 2]],
  [['A4', 6], ['R', 2]],
  [['E5', 2], ['A5', 2], ['G5', 1], ['F5', 1], ['E5', 2]],
  [['F5', 2], ['E5', 1], ['D5', 1], ['C5', 4]],
  [['B4', 2], ['C5', 1], ['D5', 1], ['E5', 2], ['G#4', 2]],
  [['B4', 4], ['R', 4]],
];

function morraMusic() {
  const beat = 60 / MORRA_BPM;
  const eighth = beat / 2;
  const bars = MORRA_PROGRESSION.length;
  return renderLoop(bars * 4 * beat, (buf) => {
    MORRA_PROGRESSION.forEach((name, b) => {
      const chord = CHORDS[name];
      const third = chord.iv[1];
      const r = chord.root;
      const bar0 = b * 4 * beat;
      // Arpeggio della chitarra: fondamentale, quinta, ottava, terza...
      const ARP = [0, 7, 12, 12 + third, 19, 12 + third, 12, 7];
      ARP.forEach((iv, i) => {
        mixInto(buf, bar0 + i * eighth, pluckNote(hz(r + 12 + iv), eighth * 1.6, 70 + b * 8 + i, i === 0 ? 0.6 : 0.4), i === 0 ? 0.42 : 0.3);
      });
      // Prima metà: passo lento "dum - da". Seconda metà: galoppo.
      for (let q = 0; q < 4; q++) {
        const t = bar0 + q * beat;
        const offsets = b < 8 ? [0, 0.75] : [0, 0.25, 0.5];
        offsets.forEach((o, k) => mixInto(buf, t + o * beat, woodblock(k === 0 ? 1180 : 1420), k === 0 ? 0.2 : 0.13));
      }
      if (b % 2 === 0) mixInto(buf, bar0, tom(), 0.5);
      if (b % 8 === 7) mixInto(buf, bar0 + 3 * beat, anvil(), 0.22);
    });
    flattenMelody(MORRA_MELODY).forEach((n, i) => {
      // Il fischio un'ottava sopra la scrittura: è lì che si fischia.
      mixInto(buf, n.at8 * eighth, whistleNote(hz(n.midi + 12), n.len8 * eighth * 0.92, 300 + i), 0.24);
    });
  });
}

// ═══ Effetti di Tre Bicchieri ════════════════════════════════════════════════

/** `call` — "Segui la pallina!": due colpi di campanella da imbonitore. */
function cupCall() {
  const bell = anvil(0.7);
  const out = new Float32Array(seconds(0.9));
  mixInto(out, 0, bell, 1);
  mixInto(out, 0.17, bell, 0.8);
  return out;
}

/** `cover` — il bicchiere si posa sulla pallina: tonfo sordo sul feltro. */
function cupCover() {
  const noise = makeNoise(31);
  return build(0.22, (t) => {
    const body = Math.sin(2 * Math.PI * 150 * (1 - t * 0.6) * t) * Math.exp(-t * 24);
    return body + noise() * Math.exp(-t * 170) * 0.35;
  });
}

/** `swap` — due bicchieri che strisciano sul tavolo: fruscio che sale e scende. */
function cupSwap(len, seed, bright) {
  const noise = makeNoise(seed);
  let lp = 0;
  let bp = 0;
  return build(len, (t) => {
    const p = t / len;
    const env = Math.sin(Math.PI * p) ** 1.5;
    const cut = 0.04 + bright * Math.sin(Math.PI * p);
    lp += (noise() - lp) * cut;
    bp += (lp - bp) * 0.5;
    return (lp - bp * 0.6) * env;
  });
}

/** `letters` — le lettere spuntano sui bicchieri: tre "pop" in salita. */
function cupLetters() {
  const out = new Float32Array(seconds(0.32));
  [0, 0.07, 0.14].forEach((at, i) => {
    const f0 = 620 + i * 180;
    mixInto(out, at, build(0.09, (t) => Math.sin(2 * Math.PI * f0 * (1 + t * 8) * t) * Math.exp(-t * 40)), 1);
  });
  return out;
}

/** `lift` — il bicchiere si alza: glissando in salita, sospeso. */
function cupLift() {
  let phase = 0;
  return build(0.38, (t) => {
    phase += (300 * 2 ** (t / 0.38 * 1.3)) / RATE;
    return pulseLike(phase) * Math.min(1, t / 0.02) * Math.exp(-t * 5);
  });
}

/** Onda quadra morbida (tre armoniche) per gli effetti costruiti a mano. */
function pulseLike(phase) {
  const w = 2 * Math.PI * phase;
  return Math.sin(w) + Math.sin(3 * w) / 3 + Math.sin(5 * w) / 5;
}

/** `ball` — la pallina è lì: "ta-da!" in arpeggio e accordo tenuto. */
function cupBall() {
  const out = new Float32Array(seconds(1.1));
  ['C5', 'E5', 'G5'].forEach((n, i) => {
    mixInto(out, i * 0.07, pulseNote(hz(midiOf(n)), 0.06, { duty: 0.5, release: 0.04 }), 0.6);
  });
  for (const n of ['C5', 'G5', 'C6', 'E6']) {
    mixInto(out, 0.22, pulseNote(hz(midiOf(n)), 0.45, { duty: 0.25, release: 0.4, vibrato: 0.2, vibratoDelay: 0.05 }), 0.35);
  }
  return out;
}

// ═══ Effetti della Morra Cinese ══════════════════════════════════════════════

/** `tick` — uno scatto della ruota: clic di legno secco. */
function morraTick(f) {
  const noise = makeNoise(f);
  const wood = woodblock(f, 0.05);
  return build(0.05, (t) => wood[Math.min(wood.length - 1, Math.round(t * RATE))] + noise() * Math.exp(-t * 400) * 0.4);
}

/** `land` — la ruota si ferma: colpo di cassa, schianto e accordo di la. */
function morraLand() {
  const noise = makeNoise(77);
  const out = new Float32Array(seconds(0.9));
  mixInto(out, 0, kick(0.4, 140, 38), 1);
  let lp = 0;
  mixInto(out, 0, build(0.6, (t) => {
    lp += (noise() - lp) * 0.25;
    return lp * Math.exp(-t * 7);
  }), 0.6);
  for (const n of ['A3', 'E4', 'A4']) {
    mixInto(out, 0.01, pulseNote(hz(midiOf(n)), 0.35, { duty: 0.5, release: 0.35 }), 0.22);
  }
  return out;
}

// ─── Scrittura ───────────────────────────────────────────────────────────────

/** Scrive un OGG Vorbis passando da un WAV temporaneo. */
function writeOgg(file, samples) {
  const tmp = path.join(os.tmpdir(), `qz-${process.pid}-${path.basename(file, '.ogg')}.wav`);
  fs.writeFileSync(tmp, encodeWav(samples));
  const res = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-c:a', 'libvorbis', '-q:a', '5', file]);
  fs.rmSync(tmp, { force: true });
  if (res.error || res.status !== 0) {
    throw new Error(`ffmpeg non disponibile o fallito per ${file}: ${res.error?.message ?? res.stderr}`);
  }
}

const OUTPUT = {
  'cup-game': {
    'music.ogg': () => masterMusic(cupMusic()),
    'call-01.wav': () => masterSfx(cupCall()),
    'cover-01.wav': () => masterSfx(cupCover()),
    'swap-01.wav': () => masterSfx(cupSwap(0.24, 11, 0.18)),
    'swap-02.wav': () => masterSfx(cupSwap(0.2, 12, 0.24)),
    'swap-03.wav': () => masterSfx(cupSwap(0.28, 13, 0.14)),
    'letters-01.wav': () => masterSfx(cupLetters()),
    'lift-01.wav': () => masterSfx(cupLift()),
    'ball-01.wav': () => masterSfx(cupBall()),
  },
  'morra-cinese': {
    'music.ogg': () => masterMusic(morraMusic()),
    'tick-01.wav': () => masterSfx(morraTick(1500)),
    'tick-02.wav': () => masterSfx(morraTick(1660)),
    'land-01.wav': () => masterSfx(morraLand()),
  },
};

for (const [game, files] of Object.entries(OUTPUT)) {
  const dir = path.join(AUDIO_DIR, game);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, make] of Object.entries(files)) {
    const file = path.join(dir, name);
    const samples = make();
    if (name.endsWith('.ogg')) writeOgg(file, samples);
    else fs.writeFileSync(file, encodeWav(samples));
    const kb = fs.statSync(file).size / 1024;
    console.log(`  ✅  ${game}/${name.padEnd(16)} ${(samples.length / RATE).toFixed(1).padStart(5)} s  ${kb.toFixed(1)} KB`);
  }
}
console.log('\n  I file vanno dichiarati nel campo `audio` del minigioco (client/shared/minigames/).');
