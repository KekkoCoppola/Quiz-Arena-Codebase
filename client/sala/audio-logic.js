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

  /** Durata fissa del crescendo finale, deve combaciare con l'asset prodotto. */
  const TENSION_FINAL_S = 10;

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
   * Pianifica le due tracce di tensione perché il crescendo atterri sullo zero
   * qualunque sia il limite di tempo della domanda (TIME_OPTIONS va da 5 a 120s).
   *
   * @returns {{useLoop: boolean, finalDelayMs: number, finalSeekS: number, skip: boolean}}
   */
  function tensionPlan({ endsAt, now, finalDurationS }) {
    const remainingMs = endsAt - now;
    if (remainingMs <= 0) {
      return { useLoop: false, finalDelayMs: 0, finalSeekS: 0, skip: true };
    }
    const remainingS = remainingMs / 1000;
    if (remainingS > finalDurationS) {
      // C'è spazio per il loop neutro prima del crescendo.
      return {
        useLoop: true,
        finalDelayMs: Math.round((remainingS - finalDurationS) * 1000),
        finalSeekS: 0,
        skip: false,
      };
    }
    // Countdown più corto del crescendo: si entra a metà traccia.
    return {
      useLoop: false,
      finalDelayMs: 0,
      finalSeekS: finalDurationS - remainingS,
      skip: false,
    };
  }

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
    TENSION_FINAL_S,
    SUSPENSE_MS,
    pickVariant,
    isStale,
    tensionPlan,
    resolveGain,
    validateManifest,
    minigameSfxKey,
    minigameManifest,
  };
});
