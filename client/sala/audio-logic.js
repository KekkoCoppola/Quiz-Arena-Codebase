'use strict';

/**
 * client/sala/audio-logic.js
 *
 * Decisioni pure del comparto audio: nessun DOM, nessuna Web Audio API, nessun
 * timer. Ricalca la separazione già usata dal progetto fra server/game.js
 * (puro, testabile) e server/game-socket.js (I/O).
 *
 * Caricato come <script> dalla vista sala (espone window.AudioLogic) e come
 * modulo CommonJS da tools/test-audio.js.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AudioLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {

  /** Volume base per canale. La musica è un letto, non una protagonista. */
  const CHANNEL_VOLUME = { music: 0.35, vo: 1.0, sfx: 0.8 };

  /** Quanto scende la musica mentre la voce parla. */
  const MUSIC_DUCK_FACTOR = 0.10;

  /** Durata delle rampe di volume. Un salto secco si sente come un difetto. */
  const RAMP_MS = 400;

  /**
   * Le tracce della sala, una per momento della serata. I minigiochi portano
   * la propria (vedi `minigameManifest`), con il loro tipo come chiave.
   */
  const MUSIC = Object.freeze({ lobby: 'lobby', quiz: 'quiz', final: 'final' });

  /** Da quanti secondi alla fine il timer suona "urgente", e da quanti "ultimi". */
  const TIMER_URGENT_S = 10;
  const TIMER_LAST_S = 3;
  const TENSION_FINAL_S = 10;

  /**
   * Quanto accelera la musica negli ultimi secondi di un round. Con il tono
   * che sale insieme al tempo: è il "fai presto!" dei videogiochi.
   */
  const HURRY_RATE = 1.12;

  /** Quanti secondi conta il "3, 2, 1" d'apertura; prima c'è "Pronti?". */
  const START_COUNT_S = 3;

  /** Pausa fra l'arrivo di game:results e il reveal, per il rullo di tamburi. */
  const SUSPENSE_MS = 1500;

  /**
   * Sceglie una variante evitando di ripetere l'ultima usata.
   * @param {number} count numero di varianti disponibili
   * @param {number} lastIndex indice usato la volta scorsa, -1 se nessuno
   * @param {() => number} rnd generatore in [0, 1)
   * @returns {number} indice scelto, -1 se non ci sono varianti
   */
  function pickVariant(count, lastIndex, rnd) {
    if (!count || count <= 0) return -1;
    if (count === 1) return 0;
    // Senza una precedente da escludere si estrae sull'intero range: altrimenti
    // si estrae fra count-1 posizioni e si "salta" quella esclusa. Così ogni
    // variante ammessa ha la stessa probabilità, senza cicli di ritentativo.
    const pick = lastIndex >= 0
      ? Math.floor(rnd() * (count - 1))
      : Math.floor(rnd() * count);
    return lastIndex >= 0 && pick >= lastIndex ? pick + 1 : pick;
  }

  /**
   * Una battuta accodata in una fase e non ancora partita quando la fase cambia
   * è da scartare: in ritardo sarebbe peggio che assente.
   */
  function isStale(queuedToken, currentToken) {
    return queuedToken !== currentToken;
  }

  /**
   * La traccia che deve suonare in una fase della partita, per la sala che si
   * riallinea da `game:snapshot`. `null` = silenzio (nessuna partita).
   * @param {string} state stato della GameSession
   */
  function musicForState(state) {
    if (state === 'LOBBY') return MUSIC.lobby;
    if (state === 'QUESTION' || state === 'RESULTS') return MUSIC.quiz;
    if (state === 'FINAL_LEADERBOARD') return MUSIC.final;
    return null;
  }

  /**
   * Il suono del timer quando la cifra dei secondi cambia.
   *
   * Un tic-tac leggero per tutto il round, un colpo più teso negli ultimi
   * dieci secondi, uno più alto negli ultimi tre e il gong allo zero. Il primo
   * valore mostrato non suona (`previous` null): la domanda è appena comparsa
   * e ha già il suo effetto d'ingresso, e una sala che si ricollega a metà
   * round non deve annunciare un secondo qualunque.
   *
   * @param {{ remaining: number, previous: number | null }} p secondi interi
   * @returns {'timer-tick' | 'timer-urgent' | 'timer-last' | 'time-up' | null}
   */
  function timerCue({ remaining, previous }) {
    if (previous === null || previous === undefined) return null;
    if (remaining === previous) return null;
    if (remaining <= 0) return previous > 0 ? 'time-up' : null;
    if (remaining <= TIMER_LAST_S) return 'timer-last';
    if (remaining <= TIMER_URGENT_S) return 'timer-urgent';
    return 'timer-tick';
  }

  /** True negli ultimi secondi del round: la musica accelera. */
  function isHurry(remaining) {
    return remaining > 0 && remaining <= TIMER_URGENT_S;
  }

  function tensionPlan({ endsAt, now, finalDurationS }) {
    const remainingMs = endsAt - now;
    if (remainingMs <= 0) {
      return { useLoop: false, finalDelayMs: 0, finalSeekS: 0, skip: true };
    }
    const remainingS = remainingMs / 1000;
    if (remainingS > finalDurationS) {
      return {
        useLoop: true,
        finalDelayMs: Math.round((remainingS - finalDurationS) * 1000),
        finalSeekS: 0,
        skip: false,
      };
    }
    return {
      useLoop: false,
      finalDelayMs: 0,
      finalSeekS: finalDurationS - remainingS,
      skip: false,
    };
  }

  /**
   * Cosa mostra e cosa suona il conto alla rovescia d'apertura quando mancano
   * `leftMs` alla prima domanda: "Pronti?" finché c'è più tempo dei tre
   * secondi da contare, poi 3, 2, 1. Il "VIA!" è `START_GO`, a tempo scaduto.
   * @returns {{ label: string, sfx: string, word: boolean }}
   */
  function startCountdownStep(leftMs) {
    if (leftMs <= 0) return START_GO;
    if (leftMs > START_COUNT_S * 1000) return { label: 'Pronti?', sfx: 'countdown-ready', word: true };
    return { label: String(Math.ceil(leftMs / 1000)), sfx: 'countdown-beep', word: false };
  }
  const START_GO = Object.freeze({ label: 'VIA!', sfx: 'countdown-go', word: true });

  /**
   * Volume effettivo di un asset. Il duck si applica solo alla musica.
   * Il risultato è sempre in [0, 1]: HTMLAudioElement.volume rifiuta il resto.
   */
  function resolveGain({ channel, assetGain, muted, ducked }) {
    if (muted) return 0;
    const base = CHANNEL_VOLUME[channel] ?? 1;
    const gain = typeof assetGain === 'number' && assetGain >= 0 ? assetGain : 1;
    const duck = ducked && channel === 'music' ? MUSIC_DUCK_FACTOR : 1;
    return Math.min(1, base * gain * duck);
  }

  /** Una voce del catalogo è utilizzabile solo se ha un "file". */
  function normalizeEntry(entry, path, errors) {
    if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string' || !entry.file) {
      errors.push(`${path}: voce senza campo "file", ignorata`);
      return null;
    }
    const gain = typeof entry.gain === 'number' && entry.gain >= 0 ? entry.gain : 1;
    return { file: entry.file, gain };
  }

  /**
   * Normalizza il manifest tollerando qualunque input: un manifest rotto deve
   * produrre un catalogo vuoto e una lista di errori, mai un'eccezione.
   */
  function validateManifest(raw) {
    const out = { music: {}, vo: {}, sfx: {}, errors: [] };
    if (!raw || typeof raw !== 'object') {
      out.errors.push('manifest assente o non è un oggetto');
      return out;
    }

    const music = raw.music && typeof raw.music === 'object' ? raw.music : {};
    for (const key of Object.keys(music)) {
      const entry = normalizeEntry(music[key], `music.${key}`, out.errors);
      if (entry) out.music[key] = entry;
    }

    for (const channel of ['vo', 'sfx']) {
      const group = raw[channel] && typeof raw[channel] === 'object' ? raw[channel] : {};
      for (const key of Object.keys(group)) {
        // Un oggetto singolo al posto di un array è l'errore di scrittura manuale
        // più probabile: si accetta e si avvolge invece di rifiutare.
        const rawList = Array.isArray(group[key]) ? group[key] : [group[key]];
        const list = rawList
          .map((e, i) => normalizeEntry(e, `${channel}.${key}[${i}]`, out.errors))
          .filter(Boolean);
        if (list.length > 0) out[channel][key] = list;
      }
    }

    return out;
  }

  /**
   * Chiave di catalogo di un effetto di minigioco. Lo spazio dei nomi è il
   * tipo del minigioco: due giochi possono chiamare "swap" i propri effetti
   * senza pestarsi i piedi, e nessuno dei due può coprire quelli della sala.
   */
  function minigameSfxKey(type, name) {
    return `${type}/${name}`;
  }

  /**
   * Porta l'audio dichiarato da un minigioco (`audio` nel suo contratto di
   * presentazione) nella forma del manifest, dentro il suo spazio dei nomi:
   * la colonna sonora diventa `music.<tipo>`, ogni effetto
   * `sfx.<tipo>/<evento>`. Il risultato passa poi per `validateManifest` come
   * qualunque altro manifest, quindi un modulo scritto male perde le voci
   * rotte e basta.
   *
   * @param {string} type tipo del minigioco (es. 'cup_game')
   * @param {{ music?: object, sfx?: object } | null} audio
   * @returns {{ music: object, vo: object, sfx: object }}
   */
  function minigameManifest(type, audio) {
    const out = { music: {}, vo: {}, sfx: {} };
    if (typeof type !== 'string' || !type || !audio || typeof audio !== 'object') return out;
    if (audio.music) out.music[type] = audio.music;
    const sfx = audio.sfx && typeof audio.sfx === 'object' ? audio.sfx : {};
    for (const name of Object.keys(sfx)) out.sfx[minigameSfxKey(type, name)] = sfx[name];
    return out;
  }

  return {
    CHANNEL_VOLUME,
    MUSIC_DUCK_FACTOR,
    RAMP_MS,
    MUSIC,
    TIMER_URGENT_S,
    TIMER_LAST_S,
    HURRY_RATE,
    START_COUNT_S,
    START_GO,
    SUSPENSE_MS,
    TENSION_FINAL_S,
    pickVariant,
    isStale,
    tensionPlan,
    musicForState,
    timerCue,
    isHurry,
    startCountdownStep,
    resolveGain,
    validateManifest,
    minigameSfxKey,
    minigameManifest,
  };
});
