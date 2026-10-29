'use strict';

/**
 * client/sala/audio.js
 *
 * Motore di riproduzione del comparto audio. Vive sulla vista sala e non su
 * admin-console perché il suono esce dal proiettore collegato al Raspberry, non
 * dal tablet dell'host. Consuma le decisioni pure di audio-logic.js (che non
 * tocca DOM né Web Audio) e le esegue sul browser: stessa separazione fra
 * server/game.js e server/game-socket.js.
 *
 * PRINCIPIO NON NEGOZIABILE: l'audio non può rompere la partita. Ogni funzione
 * pubblica è un no-op quando il sottosistema è spento, e nessuna eccezione può
 * risalire agli handler socket di app.js — che non devono mai sapere se l'audio
 * funziona.
 *
 * Stato: canale SFX (Web Audio, buffer pre-decodificati). Musica e voce, che
 * usano <audio>, entrano dagli stessi punti di aggancio senza cambiare l'API.
 */

(function (root) {

  const MANIFEST_URL = '/resources/audio/manifest.json';

  const state = {
    /** Catalogo normalizzato da AudioLogic.validateManifest, null finché non caricato. */
    catalog: null,
    /** false se il manifest è assente o illeggibile: il comparto resta muto in silenzio. */
    enabled: false,
    /** AudioContext, creato solo dentro un gesto utente (vedi arm()). */
    ctx: null,
    armed: false,
    muted: false,
    /** file -> AudioBuffer. Un file assente dalla mappa è indisponibile: gli altri suonano. */
    buffers: new Map(),
    /** evento -> ultimo indice di variante usato, per l'anti-ripetizione. */
    lastVariant: new Map(),
    /**
     * Canale musica. Usa <audio> e non Web Audio: sono file lunghi riprodotti in
     * streaming e in loop, dove la latenza di partenza non conta — al contrario
     * degli effetti, che devono scattare istantaneamente.
     */
    music: {
      /** { key, el, gain } della traccia in riproduzione, null se silenzio. */
      current: null,
      /** Chiave da riprovare quando l'autoplay si sblocca. */
      pending: null,
    },
  };

  /** Il log è l'unico effetto ammesso in caso di guasto: mai un throw. */
  function warn(msg, err) {
    try { console.warn(`[audio] ${msg}`, err ?? ''); } catch { /* console indisponibile */ }
  }

  /** audio-logic.js è caricato da un <script> separato: se manca, si resta muti. */
  function logic() {
    return root.AudioLogic ?? null;
  }

  // ---------------------------------------------------------------- manifest

  /**
   * Carica e normalizza il manifest. Parte al caricamento della pagina: è una
   * fetch, non richiede il gesto utente che serve invece alla riproduzione.
   */
  async function loadManifest() {
    const L = logic();
    if (!L) {
      warn('audio-logic.js non caricato: comparto disattivato');
      return;
    }
    let raw = null;
    try {
      const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.json();
    } catch (err) {
      // Manifest assente o malformato: disattivazione silenziosa, gioco invariato.
      warn('manifest non caricabile: comparto disattivato', err);
      return;
    }
    // validateManifest non lancia mai: un input rotto dà catalogo vuoto + errori.
    const catalog = L.validateManifest(raw);
    for (const e of catalog.errors) warn(`manifest: ${e}`);
    state.catalog = catalog;
    state.enabled = true;
  }

  // -------------------------------------------------------------- precarico

  /**
   * Scarica e decodifica un file in un AudioBuffer. Un fallimento marca
   * indisponibile quel singolo asset senza toccare gli altri.
   */
  async function preloadFile(file) {
    if (state.buffers.has(file)) return;
    try {
      const res = await fetch(`/resources/audio/${file}`, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      const buffer = await state.ctx.decodeAudioData(bytes);
      state.buffers.set(file, buffer);
    } catch (err) {
      warn(`asset non disponibile: ${file}`, err);
    }
  }

  /**
   * Gli effetti si decodificano all'apertura della partita, non al primo uso:
   * un <audio> che decodifica al play introduce un ritardo udibile, tanto più
   * sul Raspberry.
   */
  function preloadSfx(sfx = state.catalog.sfx) {
    const files = new Set();
    for (const list of Object.values(sfx)) {
      for (const entry of list) files.add(entry.file);
    }
    // Nessun await: il precarico non deve trattenere l'apertura della schermata.
    for (const file of files) preloadFile(file);
  }

  // ---------------------------------------------------------- minigiochi

  /**
   * Aggiunge al catalogo l'audio dichiarato da un minigioco (`audio` nel suo
   * contratto di presentazione), nel suo spazio dei nomi: la colonna sonora
   * diventa la traccia `<tipo>`, gli effetti `<tipo>/<evento>`. Il manifest
   * resta della sala; un minigioco porta il proprio audio con sé, come le
   * proprie immagini, e nessun elenco centrale va aggiornato.
   *
   * Se la sala è già armata gli effetti si decodificano subito; altrimenti
   * ci pensa `armNow`, che precarica l'intero catalogo.
   */
  function registerNow(type, audio) {
    const L = logic();
    if (!state.enabled || !L) return;
    const part = L.validateManifest(L.minigameManifest(type, audio));
    for (const e of part.errors) warn(`minigioco ${type}: ${e}`);
    Object.assign(state.catalog.music, part.music);
    Object.assign(state.catalog.sfx, part.sfx);
    if (state.armed) preloadSfx(part.sfx);
  }

  // ------------------------------------------------------------------ armo

  /**
   * Sblocca la riproduzione. Chiamata al caricamento della pagina, non da un
   * click: **sul proiettore non c'è nessuno che clicca**. In produzione il
   * Raspberry lancia Chromium con
   *
   *     --kiosk --autoplay-policy=no-user-gesture-required
   *
   * e il contesto nasce già in stato "running".
   *
   * Sul desktop di sviluppo, dove il flag non c'è, il contesto nasce sospeso e
   * si registra un ripiego che lo sblocca al primo click o tasto qualunque.
   * Nessun overlay "clicca per attivare l'audio": davanti a una sala non deve
   * mai comparire, e in produzione non servirebbe a nulla.
   */
  function armNow() {
    if (state.armed || !state.enabled) return;
    const Ctx = root.AudioContext ?? root.webkitAudioContext;
    if (!Ctx) {
      warn('Web Audio non supportato: effetti disattivati');
      return;
    }
    try {
      state.ctx = new Ctx();
    } catch (err) {
      warn('AudioContext non creabile: effetti disattivati', err);
      return;
    }
    state.armed = true;
    if (state.ctx.state === 'suspended') resumeOnFirstGesture();
    preloadSfx();
  }

  /**
   * Ripiego di sviluppo: si stacca da solo appena il contesto riparte. In
   * produzione non scatta mai, perché col flag di Chromium il contesto non
   * nasce sospeso.
   */
  function resumeOnFirstGesture() {
    const EVENTS = ['pointerdown', 'keydown'];
    const detach = () => {
      for (const ev of EVENTS) root.removeEventListener(ev, unlock);
    };
    function unlock() {
      state.ctx?.resume()
        .then(detach)
        .catch((err) => warn('resume rifiutato', err));
      // Lo stesso gesto sblocca anche <audio>: se una traccia era stata
      // rifiutata dall'autoplay, è ora che riparte.
      if (state.music.pending) musicNow(state.music.pending);
    }
    for (const ev of EVENTS) root.addEventListener(ev, unlock);
  }

  // ------------------------------------------------------------ produzione

  function ready() {
    return state.enabled && state.armed && state.ctx !== null && logic() !== null;
  }

  /**
   * Riproduce un effetto. Un evento assente dal manifest semplicemente non suona:
   * il catalogo può riempirsi nel tempo senza toccare il codice.
   * @param {string} key chiave dell'evento nel manifest (es. 'player-joined')
   */
  function sfxNow(key) {
    try {
      if (!ready()) return;
      const list = state.catalog.sfx[key];
      if (!list || list.length === 0) return;

      const L = logic();
      const last = state.lastVariant.has(key) ? state.lastVariant.get(key) : -1;
      const index = L.pickVariant(list.length, last, Math.random);
      if (index < 0) return;
      state.lastVariant.set(key, index);

      const entry = list[index];
      const buffer = state.buffers.get(entry.file);
      if (!buffer) return; // asset indisponibile: silenzio, non errore

      const gain = L.resolveGain({
        channel: 'sfx',
        assetGain: entry.gain,
        muted: state.muted,
        ducked: false,
      });
      if (gain <= 0) return;

      // Gli effetti non entrano mai in coda: se ne partono due insieme, suonano insieme.
      const source = state.ctx.createBufferSource();
      source.buffer = buffer;
      const gainNode = state.ctx.createGain();
      gainNode.gain.value = gain;
      source.connect(gainNode).connect(state.ctx.destination);
      source.start();
    } catch (err) {
      warn(`riproduzione fallita: sfx/${key}`, err);
    }
  }

  // ------------------------------------------------------------------ musica

  /** Passo della rampa di volume. 25 ms è sotto la soglia a cui si sente a scatti. */
  const FADE_STEP_MS = 25;

  /**
   * Rampa lineare del volume di un <audio>. Un cambio istantaneo si sente come
   * un difetto di riproduzione, una rampa si sente come regia. Una rampa in
   * corso sullo stesso elemento viene annullata da quella che le subentra.
   *
   * Usa `setInterval` e non `requestAnimationFrame` di proposito: rAF non
   * scatta quando la pagina non sta disegnando, e una dissolvenza audio ferma
   * a metà lascerebbe la musica bloccata al volume sbagliato — a zero, se si
   * stava alzando. Sul Pi succede appena lo schermo va in blank. Il tempo si
   * legge comunque dall'orologio, non dal numero di tick, quindi un timer
   * rallentato accorcia la rampa invece di allungarla.
   */
  function fade(el, to, ms, done) {
    if (el._fadeId) clearInterval(el._fadeId);
    const from = el.volume;
    const start = Date.now();
    const apply = (v) => { el.volume = Math.min(1, Math.max(0, v)); };
    el._fadeId = setInterval(() => {
      const t = ms > 0 ? Math.min(1, (Date.now() - start) / ms) : 1;
      apply(from + (to - from) * t);
      if (t >= 1) {
        clearInterval(el._fadeId);
        el._fadeId = null;
        apply(to);          // il valore finale è esatto, non interpolato
        if (done) done();
      }
    }, FADE_STEP_MS);
  }

  /** Spegne una traccia in dissolvenza e ne libera l'elemento. */
  function retire(entry, ms) {
    if (!entry) return;
    fade(entry.el, 0, ms, () => {
      try { entry.el.pause(); entry.el.removeAttribute('src'); entry.el.load(); }
      catch { /* elemento già smontato */ }
    });
  }

  /**
   * Porta la musica sulla traccia `key`, in crossfade con quella corrente.
   * Una chiave assente dal manifest non suona e non è un errore: il catalogo
   * può riempirsi nel tempo senza toccare il codice.
   *
   * @param {string | null} key chiave in `music` del manifest; null = silenzio
   */
  function musicNow(key) {
    try {
      const L = logic();
      if (!state.enabled || !L) return;
      const ms = L.RAMP_MS;

      if (key === null) {
        retire(state.music.current, ms);
        state.music.current = null;
        state.music.pending = null;
        return;
      }
      // Già su questa traccia: non si riparte da capo, si lascia girare.
      if (state.music.current && state.music.current.key === key) return;

      const entry = state.catalog.music[key];
      if (!entry) return;

      const gain = L.resolveGain({
        channel: 'music',
        assetGain: entry.gain,
        muted: state.muted,
        ducked: false,
      });

      const el = new Audio(`/resources/audio/${entry.file}`);
      el.loop = true;
      el.volume = 0;
      el.preload = 'auto';

      const previous = state.music.current;
      el.play().then(() => {
        state.music.pending = null;
        state.music.current = { key, el, gain };
        fade(el, gain, ms);
        retire(previous, ms);
      }).catch((err) => {
        // Autoplay bloccato: non si insiste, si riprova al primo gesto utile.
        // In produzione non accade — Chromium parte col flag che lo consente.
        state.music.pending = key;
        warn(`musica "${key}" bloccata dall'autoplay, riprovo al primo gesto`, err);
      });
    } catch (err) {
      warn(`musica "${key}" non riproducibile`, err);
    }
  }

  /** Ferma tutto — musica compresa — e libera il contesto. */
  function stop() {
    try {
      musicNow(null);
      if (!state.ctx) return;
      state.ctx.close().catch(() => { /* già chiuso */ });
    } catch (err) {
      warn('chiusura contesto fallita', err);
    } finally {
      state.ctx = null;
      state.armed = false;
      state.buffers.clear();
      state.lastVariant.clear();
    }
  }

  // ------------------------------------------------------------- avvio e API

  /**
   * Il manifest si carica con una fetch, quindi il catalogo NON esiste ancora
   * quando app.js chiama `arm()` alla valutazione dello script. Senza questa
   * coda ogni chiamata fatta nei primi millisecondi di vita della pagina
   * cadrebbe nel vuoto: `arm()` in particolare, che parte proprio lì.
   *
   * A manifest già caricato `.then()` risolve sul microtask successivo — un
   * ritardo non misurabile, irrilevante anche per gli effetti.
   */
  const manifestReady = loadManifest();

  function whenReady(fn) {
    manifestReady.then(fn).catch((err) => warn('avvio del comparto fallito', err));
  }

  /**
   * Fotografia leggibile dello stato. Serve a rispondere in dieci secondi alla
   * domanda che conta davvero durante un evento — "perché non si sente niente?"
   * — da `SalaAudio.info()` nella console, senza rileggere il codice.
   */
  function info() {
    const m = state.music.current;
    return {
      enabled: state.enabled,
      armed: state.armed,
      ctxState: state.ctx ? state.ctx.state : null,
      music: m ? m.key : null,
      musicVolume: m ? Number(m.el.volume.toFixed(3)) : null,
      musicPaused: m ? m.el.paused : null,
      musicPending: state.music.pending,
      sfxCaricati: state.buffers.size,
      muted: state.muted,
    };
  }

  root.SalaAudio = {
    arm:   ()    => whenReady(armNow),
    sfx:   (key) => whenReady(() => sfxNow(key)),
    music: (key) => whenReady(() => musicNow(key)),
    register: (type, audio) => whenReady(() => registerNow(type, audio)),
    stop,
    info,
  };

})(typeof self !== 'undefined' ? self : this);
