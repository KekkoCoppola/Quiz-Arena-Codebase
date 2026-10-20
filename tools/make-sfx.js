'use strict';

/**
 * tools/make-sfx.js
 *
 * Genera gli effetti sonori della vista sala come file WAV, sintetizzandoli.
 *
 *   node tools/make-sfx.js
 *
 * Perché sintetizzati e non scaricati: il Raspberry gira offline e il progetto
 * non vuole dipendenze esterne né asset di provenienza incerta. Questi suoni
 * sono brevi, generati da poche righe di matematica, e soprattutto sono
 * SOSTITUIBILI: il comparto audio legge `resources/audio/manifest.json`, quindi
 * rimpiazzare un file con una registrazione vera non richiede toccare codice.
 *
 * Il file è uno strumento da riga di comando, non fa parte del server.
 */

const fs = require('node:fs');
const path = require('node:path');

const RATE = 44100;
const OUT_DIR = path.join(__dirname, '..', 'resources', 'audio', 'sfx');

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
  buf.writeUInt32LE(16, 16);        // dimensione del blocco fmt
  buf.writeUInt16LE(1, 20);         // PCM
  buf.writeUInt16LE(1, 22);         // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);  // byte al secondo
  buf.writeUInt16LE(2, 32);         // allineamento di blocco
  buf.writeUInt16LE(16, 34);        // bit per campione
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}

// ─── Mattoncini di sintesi ───────────────────────────────────────────────────

const seconds = (s) => Math.floor(s * RATE);

/** Decadimento esponenziale: parte a 1 e sfuma. `k` alto = più secco. */
const decay = (t, k) => Math.exp(-k * t);

/** Smorza gli ultimi millisecondi per evitare il "click" di troncatura. */
function fadeOut(samples, ms = 8) {
  const n = Math.min(samples.length, seconds(ms / 1000));
  for (let i = 0; i < n; i++) {
    samples[samples.length - n + i] *= 1 - i / n;
  }
  return samples;
}

/**
 * Costruisce un suono campione per campione.
 * @param {number} durationS
 * @param {(t: number) => number} fn ampiezza al tempo t (secondi)
 */
function build(durationS, fn) {
  const out = new Float32Array(seconds(durationS));
  for (let i = 0; i < out.length; i++) out[i] = fn(i / RATE);
  return fadeOut(out);
}

const sine = (freq, t) => Math.sin(2 * Math.PI * freq * t);
/** Rumore deterministico: stesso file a ogni esecuzione, così i diff sono stabili. */
function noise(seedRef) {
  seedRef.v = (seedRef.v * 1664525 + 1013904223) >>> 0;
  return (seedRef.v / 0xffffffff) * 2 - 1;
}

// ─── I suoni ─────────────────────────────────────────────────────────────────

/**
 * `avatar-call` — il giocatore viene chiamato sul palco.
 * Blip cortissimo e gentile, sale di poco. Ne suonano fino a 30 di fila:
 * dev'essere leggero o diventa martellante.
 */
function avatarCall(baseFreq) {
  return build(0.13, (t) => {
    const f = baseFreq * (1 + t * 1.4);
    return sine(f, t) * decay(t, 26) * 0.32;
  });
}

/**
 * `avatar-land` — la pedina si posa sulla risposta.
 * Tocco corto e sordo, come una gettone di legno sul tavolo.
 */
function avatarLand(baseFreq) {
  const seed = { v: 12345 };
  return build(0.12, (t) => {
    const body = sine(baseFreq * (1 - t * 0.5), t) * decay(t, 34);
    const click = noise(seed) * decay(t, 190) * 0.35;
    return (body + click) * 0.4;
  });
}

/**
 * `stamp-wrong` — la X che sbatte sulla risposta sbagliata.
 * Tonfo basso con uno schiocco secco in attacco: un timbro di gomma.
 */
function stampWrong() {
  const seed = { v: 777 };
  return build(0.26, (t) => {
    const thud = sine(96 * (1 - t * 0.35), t) * decay(t, 17);
    const slap = noise(seed) * decay(t, 90) * 0.5;
    return (thud * 0.9 + slap) * 0.55;
  });
}

/**
 * `reveal` — la risposta giusta si accende.
 * Arpeggio ascendente in tre note: la terza tenuta un attimo di più.
 */
function reveal() {
  const NOTES = [659.25, 830.61, 1174.66]; // Mi5 · Sol#5 · Re6
  const STEP = 0.085;
  return build(0.62, (t) => {
    let v = 0;
    NOTES.forEach((f, i) => {
      const start = i * STEP;
      if (t < start) return;
      const local = t - start;
      const k = i === NOTES.length - 1 ? 5.5 : 11;
      v += sine(f, local) * decay(local, k);
    });
    return v * 0.26;
  });
}

/**
 * `suspense` — l'attesa prima che si sappia com'è andata.
 * Rullo: rumore filtrato che cresce, con un battito che accelera.
 */
function suspense() {
  const seed = { v: 4242 };
  let smooth = 0;
  return build(1.45, (t) => {
    // Passa-basso a un polo sul rumore: da "sss" a "rrr".
    smooth += (noise(seed) - smooth) * 0.045;
    const swell = Math.min(1, t / 1.2) ** 2;
    const beatHz = 7 + t * 9;
    const beat = 0.5 + 0.5 * Math.sin(2 * Math.PI * beatHz * t);
    return smooth * swell * (0.55 + 0.45 * beat) * 1.9;
  });
}

/**
 * `score-count` — le cifre della classifica che scorrono.
 * Ronzio granuloso che sale di tono e si spegne: accompagna il contatore senza
 * coprirlo. Dura quanto il conteggio (1.3s).
 */
function scoreCount() {
  return build(1.35, (t) => {
    const p = t / 1.35;
    // Salita di un'ottava, che rallenta come il contatore.
    const f = 220 * (1 + 1.0 * (1 - Math.pow(1 - p, 3)));
    // I "denti" del rullo: modulazione veloce che dirada verso la fine.
    const teeth = 0.55 + 0.45 * Math.sin(2 * Math.PI * (34 - 22 * p) * t);
    const env = Math.min(1, t / 0.06) * Math.min(1, (1.35 - t) / 0.25);
    return sine(f, t) * teeth * env * 0.16;
  });
}

/**
 * `overtake` — un giocatore ne scavalca un altro.
 * Sibilo breve che sale: il "whoosh" di chi passa avanti.
 */
function overtake() {
  const seed = { v: 909 };
  let smooth = 0;
  return build(0.42, (t) => {
    smooth += (noise(seed) - smooth) * (0.06 + 0.5 * t);
    const env = Math.sin(Math.PI * Math.min(1, t / 0.42));
    return smooth * env * 1.5;
  });
}

// ─── Scrittura ───────────────────────────────────────────────────────────────

const FILES = [
  // Tre varianti: il motore audio evita di ripetere la stessa due volte di fila,
  // così una parata di trenta giocatori non suona come un metronomo.
  ['avatar-call-01.wav', avatarCall(520)],
  ['avatar-call-02.wav', avatarCall(590)],
  ['avatar-call-03.wav', avatarCall(660)],
  ['avatar-land-01.wav', avatarLand(300)],
  ['avatar-land-02.wav', avatarLand(340)],
  ['avatar-land-03.wav', avatarLand(265)],
  ['stamp-wrong-01.wav', stampWrong()],
  ['reveal-01.wav', reveal()],
  ['suspense-01.wav', suspense()],
  ['score-count-01.wav', scoreCount()],
  ['overtake-01.wav', overtake()],
];

fs.mkdirSync(OUT_DIR, { recursive: true });
let total = 0;
for (const [name, samples] of FILES) {
  const wav = encodeWav(samples);
  fs.writeFileSync(path.join(OUT_DIR, name), wav);
  total += wav.length;
  console.log(`  ✅  ${name.padEnd(22)} ${(wav.length / 1024).toFixed(1)} KB`);
}
console.log(`\n  ${FILES.length} file, ${(total / 1024).toFixed(1)} KB in resources/audio/sfx/`);
console.log('  Ricorda: vanno dichiarati in resources/audio/manifest.json.');
