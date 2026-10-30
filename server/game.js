'use strict';

/**
 * server/game.js
 *
 * Step 5: Motore di gioco — macchina a stati pura, in-memory.
 * Nessuna dipendenza da Express, Socket.io o dal database: riceve un quiz
 * già caricato (array di domande) e gestisce l'intera partita in memoria.
 *
 * Flusso: LOBBY -> QUESTION -> RESULTS -> (QUESTION | FINAL_LEADERBOARD)
 *
 * Il timer NON usa setTimeout interno: ogni metodo sensibile al tempo accetta
 * un parametro `now` (default Date.now()) così la classe resta testabile in
 * modo sincrono e deterministico, senza attese reali. Il countdown "vero"
 * (setTimeout lato server + emit Socket.io) sarà collegato in Step 6.
 *
 * NON contiene logica di rete (→ Step 6: handler Socket.io in index.js).
 *
 * Fase Minigiochi: la sequenza di gioco non è più direttamente `quiz.questions`
 * ma `this.rounds`, costruita una volta in costruttore da `buildRounds()`.
 * Un round può essere una domanda vera (`kind: 'question'`, autorata dall'host)
 * o un minigioco (`kind: 'minigame'`, generato a runtime dal registry in
 * `server/minigames/` — stessa forma di una domanda, ma senza `correct_index`
 * perché l'esito si decide alla chiusura). Questa uniformità di forma è ciò che
 * permette a `submitAnswer`/`_computeScore`/`endQuestion` di restare identici
 * per entrambi i tipi di round.
 *
 * Le REGOLE dei singoli minigiochi non stanno qui: ognuno è un modulo isolato in
 * `server/minigames/<nome>.js`, caricato e validato dal registry. Questo file
 * sa solo *orchestrare* un minigioco, non come funziona nessuno di essi.
 */

const { randomUUID } = require('node:crypto');

const minigames = require('./minigames');

const { MINIGAME_TYPES, MINIGAME_TYPE_KEYS, RANDOM_TYPE } = minigames;

// ─── Costanti di Punteggio ───────────────────────────────────────────────────────
// Stile Kahoot: punteggio massimo per risposta istantanea, minimo per risposta
// corretta arrivata all'ultimo istante utile. Risposta sbagliata o fuori tempo = 0.

const POINTS_MAX = 1000;
const POINTS_MIN = 100;

/** Lunghezza massima consentita per un nickname giocatore. */
const MAX_NICKNAME_LENGTH = 20;

/**
 * L'avatar è il personaggio (colore + espressione) come stringa opaca
 * `"<colore>:<faccia>"`. Il server la valida soltanto: il disegno è dei client.
 * Il catalogo è condiviso con loro, così il telefono non può proporre una
 * combinazione che qui verrebbe rifiutata.
 */
const AvatarCatalog = require('../client/shared/avatar-catalog');

// ─── Stati ────────────────────────────────────────────────────────────────────────

const STATES = Object.freeze({
  LOBBY: 'LOBBY',
  QUESTION: 'QUESTION',
  RESULTS: 'RESULTS',
  FINAL_LEADERBOARD: 'FINAL_LEADERBOARD',
});

// ─── Errori Custom ───────────────────────────────────────────────────────────────

class InvalidStateError extends Error {
  constructor(message = 'Operazione non consentita nello stato corrente della partita.') {
    super(message);
    this.name = 'InvalidStateError';
  }
}

class DuplicateNicknameError extends Error {
  constructor(message = 'Nickname già in uso in questa partita.') {
    super(message);
    this.name = 'DuplicateNicknameError';
  }
}

class PlayerNotFoundError extends Error {
  constructor(message = 'Giocatore non trovato in questa partita.') {
    super(message);
    this.name = 'PlayerNotFoundError';
  }
}

class AlreadyAnsweredError extends Error {
  constructor(message = 'Il giocatore ha già risposto a questa domanda.') {
    super(message);
    this.name = 'AlreadyAnsweredError';
  }
}

class InvalidAnswerIndexError extends Error {
  constructor(message = 'Indice risposta non valido per questa domanda.') {
    super(message);
    this.name = 'InvalidAnswerIndexError';
  }
}

class InvalidNicknameError extends Error {
  constructor(message = 'Nickname non valido.') {
    super(message);
    this.name = 'InvalidNicknameError';
  }
}

class InvalidAvatarError extends Error {
  constructor(message = 'Avatar non valido.') {
    super(message);
    this.name = 'InvalidAvatarError';
  }
}

class EmptyQuizError extends Error {
  constructor(message = 'Impossibile avviare una partita con un quiz privo di domande.') {
    super(message);
    this.name = 'EmptyQuizError';
  }
}

class NotEnoughPlayersError extends Error {
  constructor(message = 'Servono almeno 1 giocatore in lobby per avviare la partita.') {
    super(message);
    this.name = 'NotEnoughPlayersError';
  }
}

class InvalidMinigameTypeError extends Error {
  constructor(message = 'Tipo di minigioco non valido.') {
    super(message);
    this.name = 'InvalidMinigameTypeError';
  }
}

class StaleRoundError extends Error {
  constructor(message = 'Il round è già cambiato: la risposta non vale più.') {
    super(message);
    this.name = 'StaleRoundError';
  }
}

class NotAMinigameError extends Error {
  constructor(message = 'Si possono saltare solo i round dei minigiochi.') {
    super(message);
    this.name = 'NotAMinigameError';
  }
}

class AnswersNotOpenError extends Error {
  constructor(message = 'Le risposte non sono ancora aperte: guarda lo schermo!') {
    super(message);
    this.name = 'AnswersNotOpenError';
  }
}

// ─── Minigiochi ──────────────────────────────────────────────────────────────────
// Le regole dei minigiochi vivono in `server/minigames/`, un modulo per gioco,
// caricati e validati dal registry all'avvio. Qui resta solo l'orchestrazione.
//
// A differenza di una domanda, un minigioco NON ha una risposta corretta
// prefissata: ha una meccanica propria che si risolve alla CHIUSURA del round
// (`resolve()`), confrontando la scelta di ogni giocatore con uno stato della
// macchina generato in quel momento (es. la mossa del PC a Morra Cinese).
// Questo modello "gioca contro il PC + reveal" è ciò che distingue un minigioco
// da una domanda camuffata. Il punteggio confluisce nella stessa classifica.
//
// Per aggiungere un minigioco si crea un file in `server/minigames/`: nulla in
// questo file va toccato. Vedi `server/minigames/_TEMPLATE.js`.

/**
 * Traduce il tipo richiesto in un tipo concreto: il segnaposto `random` viene
 * risolto estraendo dal sacchetto della sessione, così il round generato porta
 * sempre un `minigameType` reale e i client non vedono mai `'random'`.
 * @param {string} type chiave di MINIGAME_TYPES oppure RANDOM_TYPE
 * @param {{ next: () => (string|null) }} bag sacchetto della sessione
 * @returns {object | null} la definizione, o null se il tipo non è utilizzabile
 */
function resolveMinigameDef(type, bag) {
  const concreteType = type === RANDOM_TYPE ? bag.next() : type;
  return concreteType ? minigames.get(concreteType) : null;
}

/**
 * I round di UN minigioco. Di solito uno solo; un minigioco che dichiara
 * `stages: N` ne produce N di fila, con difficoltà crescente decisa dal suo
 * `build(stageIndex)`. Ognuno è un round vero (risposte, punti, timer propri)
 * ma porta `stage: { index, count }`: game-socket.js li concatena da solo e i
 * client mostrano la classifica solo dopo l'ultimo.
 * @param {object} def definizione del minigioco
 * @returns {Array<object>}
 */
function buildMinigameRounds(def) {
  const count = def.stages ?? 1;
  if (count === 1) return [def.build()];
  return Array.from({ length: count }, (_, index) => {
    const round = def.build(index);
    return { ...round, stage: { ...(round.stage ?? {}), index, count } };
  });
}

/**
 * Costruisce la sequenza di round di una partita: le domande del quiz, con gli
 * eventuali minigiochi pianificati in editor (`quiz.minigames`) inseriti
 * nella posizione richiesta. Lo splice avviene dal fondo verso l'inizio così
 * gli indici `afterQuestionIndex` restano validi durante l'inserimento.
 *
 * ⚠ Gli slot vengono ordinati per posizione decrescente prima dello splice, ma
 * l'estrazione casuale segue quell'ordine: irrilevante per l'esito (il
 * sacchetto è comunque casuale), ma è il motivo per cui due partite con gli
 * stessi slot `random` non producono la stessa sequenza.
 *
 * @param {object} quiz
 * @param {{ next: () => (string|null) }} bag sacchetto per gli slot `random`
 * @returns {Array<object>} rounds
 */
function buildRounds(quiz, bag) {
  const rounds = quiz.questions.map((q) => ({ kind: 'question', ...q }));

  const slots = Array.isArray(quiz.minigames) ? quiz.minigames : [];
  const sortedSlots = slots.slice().sort((a, b) => b.afterQuestionIndex - a.afterQuestionIndex);
  for (const slot of sortedSlots) {
    const def = resolveMinigameDef(slot.type, bag);
    if (!def) continue; // tipo sconosciuto: validato a monte in routes, qui difesa in profondità
    rounds.splice(slot.afterQuestionIndex + 1, 0, ...buildMinigameRounds(def));
  }

  return rounds;
}

// ─── GameSession ─────────────────────────────────────────────────────────────────

class GameSession {
  /**
   * @param {{ title?: string, questions: Array<{ text: string, options: string[], correct_index: number, time_limit_s: number }> }} quiz
   * @param {{ rnd?: () => number, minigameIntroMs?: number }} [options] `rnd` è
   *   il generatore casuale usato dai minigiochi (estrazione del tipo e stato
   *   macchina). Iniettabile per i test, stessa filosofia del parametro `now`:
   *   in produzione resta Math.random. `minigameIntroMs` è il sipario che apre
   *   ogni minigioco (vedi `_enterRound`); 0 di default, perché la durata è una
   *   scelta di messa in scena e la decide chi crea la sessione (game-socket.js,
   *   da config).
   */
  constructor(quiz, options = {}) {
    if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      throw new EmptyQuizError();
    }

    this._rnd = options.rnd ?? Math.random;
    this._minigameIntroMs = Math.max(0, options.minigameIntroMs ?? 0);

    /**
     * Sacchetto di estrazione dei minigiochi, condiviso fra gli slot `random`
     * pianificati in editor e gli inserimenti ad-hoc dell'host: è per-sessione,
     * quindi la varietà è garantita all'interno di una singola partita e
     * ricomincia da capo a ogni nuova GameSession (incluso il riavvio).
     */
    this._minigameBag = minigames.createShuffleBag(MINIGAME_TYPE_KEYS, this._rnd);

    this.quiz = quiz;
    this.rounds = buildRounds(quiz, this._minigameBag);
    this.state = STATES.LOBBY;
    this.currentRoundIndex = -1;
    this.roundStartedAt = null;

    /**
     * Fine del sipario che apre un minigioco. Coincide con `roundStartedAt` per
     * le domande e per i livelli successivi al primo di un minigioco a più round.
     */
    this.introEndsAt = null;

    /**
     * Istante da cui il round accetta risposte. Coincide con `roundStartedAt`
     * per le domande; per un minigioco viene dopo il sipario e, se il modulo ne
     * ha una (`previewMs`), dopo l'anteprima: lo spettacolo da seguire viene
     * prima della scelta.
     */
    this.answersOpenAt = null;

    /**
     * Risoluzione estratta all'APERTURA del round, solo per i minigiochi con
     * anteprima: la sala deve conoscere l'esito per metterlo in scena prima che
     * si scelga (es. i bicchieri che si fermano sulla pallina). `null` per tutti
     * gli altri round, che si risolvono alla chiusura come sempre.
     */
    this._openResolution = null;

    /** @type {Map<string, { id: string, nickname: string, avatar: string, score: number, connected: boolean }>} */
    this.players = new Map();

    /**
     * Risposte per la domanda corrente.
     * @type {Map<string, { optionIndex: number, correct: boolean, pointsAwarded: number, answeredAt: number }>}
     */
    this.currentAnswers = new Map();
  }

  // ─── Helpers interni ────────────────────────────────────────────────────────────

  _assertState(expected, methodName) {
    if (this.state !== expected) {
      throw new InvalidStateError(
        `${methodName}: richiede stato ${expected}, stato attuale ${this.state}.`
      );
    }
  }

  _getPlayerOrThrow(playerId) {
    const player = this.players.get(playerId);
    if (!player) {
      throw new PlayerNotFoundError();
    }
    return player;
  }

  get currentRound() {
    return this.rounds[this.currentRoundIndex] ?? null;
  }

  /**
   * True se il round corrente è l'ultimo in programma.
   *
   * Serve a due cose che devono restare d'accordo: `nextQuestion`, per decidere
   * se chiudere la partita, e il payload di `endQuestion`, per dire ai client
   * che dopo questi risultati viene la premiazione — così sala e telefoni
   * possono NON mostrare la classifica, che a quel punto proclamerebbe il
   * vincitore prima della cerimonia. È la stessa domanda: una condizione sola,
   * non due copie libere di divergere.
   *
   * Non è una promessa definitiva: l'host può ancora inserire un minigioco
   * ad-hoc da RESULTS, e allora l'ultimo round diventa un altro. Il prezzo è
   * una classifica nascosta a vuoto per un pannello, non un errore.
   */
  get isLastRound() {
    return this.currentRoundIndex >= this.rounds.length - 1;
  }

  // ─── Lobby ──────────────────────────────────────────────────────────────────────

  /**
   * Aggiunge un giocatore alla lobby. Consentito solo in stato LOBBY.
   * @param {string} nickname
   * @param {string | null} [avatarId] avatar del catalogo (`"<colore>:<faccia>"`); se assente ne viene estratto uno a caso
   * @returns {{ id: string, nickname: string, avatar: string, score: number, connected: boolean }}
   */
  addPlayer(nickname, avatarId = null) {
    this._assertState(STATES.LOBBY, 'addPlayer');

    const trimmed = String(nickname ?? '').trim();
    if (!trimmed) {
      throw new InvalidNicknameError('Nickname vuoto non consentito.');
    }
    if (trimmed.length > MAX_NICKNAME_LENGTH) {
      throw new InvalidNicknameError(`Nickname troppo lungo (massimo ${MAX_NICKNAME_LENGTH} caratteri).`);
    }

    const normalized = trimmed.toLowerCase();
    for (const p of this.players.values()) {
      if (p.nickname.toLowerCase() === normalized) {
        throw new DuplicateNicknameError();
      }
    }

    let avatar = avatarId;
    if (avatar === null || avatar === undefined) {
      // Math.random e non this._rnd: il generatore iniettato è delle decisioni
      // di gioco, e un giocatore in più non deve spostarne la sequenza nei test.
      avatar = AvatarCatalog.random();
    } else if (!AvatarCatalog.isValid(avatar)) {
      throw new InvalidAvatarError();
    }

    const player = { id: randomUUID(), nickname: trimmed, avatar, score: 0, connected: true };
    this.players.set(player.id, player);
    return player;
  }

  /**
   * Rimuove un giocatore dalla partita (in qualsiasi stato: gestisce le disconnessioni).
   * @param {string} playerId
   */
  removePlayer(playerId) {
    this._getPlayerOrThrow(playerId);
    this.players.delete(playerId);
    this.currentAnswers.delete(playerId);
  }

  /**
   * Marca lo stato di connessione di un giocatore (Fase 7 — riconnessione).
   * Non rimuove il giocatore: punteggio e identità restano.
   * @param {string} playerId
   * @param {boolean} connected
   */
  setPlayerConnected(playerId, connected) {
    const player = this._getPlayerOrThrow(playerId);
    player.connected = Boolean(connected);
  }

  getPlayers() {
    return Array.from(this.players.values());
  }

  // ─── Question ───────────────────────────────────────────────────────────────────

  /**
   * Avvia la partita: LOBBY -> QUESTION sulla prima domanda.
   * @param {number} [now]
   */
  startGame(now = Date.now()) {
    this._assertState(STATES.LOBBY, 'startGame');
    if (this.players.size < 1) {
      throw new NotEnoughPlayersError();
    }

    this.currentRoundIndex = 0;
    this._enterRound(now);
  }

  _enterRound(now) {
    this.state = STATES.QUESTION;
    this.roundStartedAt = now;
    this.currentAnswers = new Map();

    // Minigioco con anteprima: l'esito si estrae ORA, non alla chiusura, perché
    // lo spettacolo che lo racconta viene prima della scelta. Le risposte
    // restano chiuse finché l'anteprima non è finita.
    // Un minigioco a più round può dare a ogni livello un'anteprima sua
    // (`round.previewMs` da `build(stageIndex)`); altrimenti vale quella del modulo.
    const def = this._currentMinigameDef();
    const previewMs = def ? (this.currentRound.previewMs ?? def.previewMs ?? 0) : 0;
    this._openResolution = previewMs > 0 ? def.resolve(this._rnd) : null;

    // Il sipario apre il minigioco una volta sola: i livelli successivi di un
    // minigioco a più round sono la stessa scena che continua.
    const stage = this.currentRound.stage;
    const opensMinigame = def !== null && (!stage || stage.index === 0);
    this.introEndsAt = now + (opensMinigame ? this._minigameIntroMs : 0);
    this.answersOpenAt = this.introEndsAt + previewMs;
  }

  /** Definizione del minigioco del round corrente, `null` per una domanda. */
  _currentMinigameDef() {
    const round = this.currentRound;
    return round?.kind === 'minigame' ? minigames.get(round.minigameType) : null;
  }

  /**
   * Stato macchina già estratto per un minigioco con anteprima, da mostrare
   * SOLO alla sala e all'host (game-socket.js non lo manda ai telefoni:
   * leggerlo sarebbe conoscere la risposta). `null` per ogni altro round.
   * @returns {{ machineChoice: number } | null}
   */
  getRoundPreview() {
    this._assertState(STATES.QUESTION, 'getRoundPreview');
    return this._openResolution
      ? { machineChoice: this._openResolution.machineChoice }
      : null;
  }

  /**
   * Restituisce il round corrente sanitizzato (senza `correct_index`),
   * sicuro da inviare ai client giocatore mentre il round è aperto.
   * `kind`/`minigameType` permettono ai client di distinguere una domanda
   * vera da un round minigioco e mostrare una schermata diversa.
   */
  getCurrentRound() {
    this._assertState(STATES.QUESTION, 'getCurrentRound');
    const r = this.currentRound;
    return {
      index: this.currentRoundIndex,
      total: this.rounds.length,
      text: r.text,
      options: r.options,
      time_limit_s: r.time_limit_s,
      // Sipario che apre il minigioco (0 per domande e livelli successivi),
      // poi l'anteprima prima che si possa rispondere (0 = si risponde subito).
      // Il countdown di `time_limit_s` parte dopo entrambi.
      introMs: this.introEndsAt - this.roundStartedAt,
      previewMs: this.answersOpenAt - this.introEndsAt,
      kind: r.kind,
      minigameType: r.minigameType ?? null,
      // Round di un minigioco a più livelli: `{ index, count, ... }`, con i
      // parametri di difficoltà che il modulo ha messo in `build(stageIndex)`.
      stage: r.stage ?? null,
      // Un round minigioco non ha immagine: `r.image` è undefined e diventa
      // null, che è la stessa cosa che dice una domanda senza immagine.
      // Il campo arriva anche ai telefoni — sono ~90 byte, e non vale un emit
      // per-room — ma solo la vista sala lo disegna. Vedi la spec
      // docs/superpowers/specs/2026-08-29-immagini-domande-design.md.
      image: r.image ?? null,
    };
  }

  /**
   * Registra la risposta di un giocatore. Consentito solo in stato QUESTION,
   * una sola risposta per giocatore per round (domanda o minigioco).
   *
   * Domanda: l'esito (correct/punti) è noto subito e viene calcolato qui.
   * Minigioco: l'esito dipende dallo stato macchina che esiste solo alla
   * chiusura, quindi qui si registra solo la scelta — nessun esito rivelato,
   * così la suspense del reveal resta intatta.
   * @param {string} playerId
   * @param {number} optionIndex
   * @param {number} [now]
   * @param {number} [roundIndex] il round a cui il telefono stava rispondendo.
   *   Se c'è e non è il round corrente, la risposta è "in volo" da un round
   *   chiuso nel frattempo (es. saltato dall'host verso una domanda che accetta
   *   risposte subito) e viene scartata invece di valere per il round nuovo.
   * @returns {{ correct: boolean, pointsAwarded: number } | { recorded: true }}
   */
  submitAnswer(playerId, optionIndex, now = Date.now(), roundIndex) {
    this._assertState(STATES.QUESTION, 'submitAnswer');
    this._getPlayerOrThrow(playerId);

    if (roundIndex !== undefined && roundIndex !== this.currentRoundIndex) {
      throw new StaleRoundError();
    }

    if (this.currentAnswers.has(playerId)) {
      throw new AlreadyAnsweredError();
    }

    if (now < this.answersOpenAt) {
      throw new AnswersNotOpenError();
    }

    const round = this.currentRound;
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= round.options.length) {
      throw new InvalidAnswerIndexError();
    }

    if (round.kind === 'minigame') {
      // Esito e punti differiti a endQuestion (resolve dello stato macchina).
      this.currentAnswers.set(playerId, {
        optionIndex,
        correct: null,
        outcome: null,
        pointsAwarded: 0,
        answeredAt: now,
      });
      return { recorded: true };
    }

    const correct = optionIndex === round.correct_index;
    const pointsAwarded = correct ? this._computeScore(round, now) : 0;

    this.currentAnswers.set(playerId, {
      optionIndex,
      correct,
      outcome: null,
      pointsAwarded,
      answeredAt: now,
    });

    return { correct, pointsAwarded };
  }

  /**
   * Calcola il punteggio in stile Kahoot: massimo per risposta istantanea,
   * minimo per risposta corretta all'ultimo istante, 0 se il tempo è scaduto.
   */
  _computeScore(question, now) {
    const timeLimitMs = question.time_limit_s * 1000;
    const elapsedMs = now - this.roundStartedAt;
    const ratio = Math.max(0, Math.min(1, 1 - elapsedMs / timeLimitMs));
    if (ratio === 0) return 0; // tempo scaduto
    return Math.round(POINTS_MIN + (POINTS_MAX - POINTS_MIN) * ratio);
  }

  // ─── Results ────────────────────────────────────────────────────────────────────

  /**
   * Chiude il round corrente: QUESTION -> RESULTS.
   * Per un minigioco, prima risolve lo stato macchina (es. la mossa del PC) e
   * assegna a ogni scelta l'esito (vittoria/pareggio/sconfitta) con i relativi
   * punti; per una domanda i punti sono già stati calcolati in submitAnswer.
   * In entrambi i casi i punti confluiscono nella stessa classifica.
   * Il riepilogo restituito espone `correctIndex` (domanda) oppure `machineChoice`
   * (minigioco); l'altro campo è `null`.
   * @param {number} [now]
   */
  endQuestion(now = Date.now()) {
    this._assertState(STATES.QUESTION, 'endQuestion');

    const round = this.currentRound;
    const distribution = new Array(round.options.length).fill(0);

    // Risoluzione minigioco: estrai lo stato macchina e assegna esito + punti a
    // ogni risposta PRIMA del loop di somma dei punteggi.
    let machineChoice = null;
    // Durata della sospensione/reveal post-chiusura (0 = nessuna). Un valore di
    // timing dichiarato dal modulo del minigioco; game-socket.js lo converte nel
    // timestamp assoluto `revealAt` per sincronizzare sala e telefoni.
    let revealMs = 0;
    if (round.kind === 'minigame') {
      const def = minigames.get(round.minigameType);
      revealMs = def.revealMs ?? 0;
      // Con anteprima l'esito esiste già ed è quello che la sala ha mostrato:
      // estrarne un altro qui smentirebbe lo spettacolo.
      const resolution = this._openResolution ?? def.resolve(this._rnd);
      this._openResolution = null;
      machineChoice = resolution.machineChoice;
      for (const answer of this.currentAnswers.values()) {
        answer.outcome = resolution.outcomeFor(answer.optionIndex);
        answer.pointsAwarded = def.points[answer.outcome];
      }
    }

    for (const player of this.players.values()) {
      const answer = this.currentAnswers.get(player.id);
      if (answer) {
        distribution[answer.optionIndex]++;
        player.score += answer.pointsAwarded;
      }
      // Giocatori senza risposta: nessun incremento punteggio (equivalente a 0 punti).
    }

    this.state = STATES.RESULTS;

    return this._resultsSummary(round, { machineChoice, revealMs, distribution });
  }

  /**
   * Riepilogo di un round chiuso, come lo ricevono i client in `game:results`.
   * Un'unica forma per il round chiuso normalmente e per quello saltato
   * dall'host: un campo aggiunto qui arriva a entrambi.
   * @param {object} round il round appena chiuso
   * @param {{ machineChoice: number|null, revealMs: number, distribution: number[] }} esito
   */
  _resultsSummary(round, { machineChoice, revealMs, distribution }) {
    return {
      questionIndex: this.currentRoundIndex,
      kind: round.kind,
      minigameType: round.minigameType ?? null,
      stage: round.stage ?? null,
      correctIndex: round.kind === 'minigame' ? null : round.correct_index,
      machineChoice,
      revealMs,
      // Dopo questi risultati viene la premiazione: i client sigillano la
      // classifica invece di mostrarla (vedi il getter `isLastRound`).
      isLastRound: this.isLastRound,
      distribution,
      answers: Array.from(this.currentAnswers.entries()).map(([playerId, a]) => ({
        playerId,
        nickname: this.players.get(playerId)?.nickname ?? null,
        // La sala mostra ogni giocatore che "va a posarsi" sulla risposta scelta:
        // le serve l'avatar, non solo il nickname.
        avatar: this.players.get(playerId)?.avatar ?? null,
        optionIndex: a.optionIndex,
        correct: a.correct,
        outcome: a.outcome,
        pointsAwarded: a.pointsAwarded,
      })),
      leaderboard: this.getLeaderboard(),
    };
  }

  /**
   * Avanza al round successivo (RESULTS -> QUESTION) oppure, se era
   * l'ultimo round, chiude la partita (RESULTS -> FINAL_LEADERBOARD).
   * @param {number} [now]
   */
  nextQuestion(now = Date.now()) {
    this._assertState(STATES.RESULTS, 'nextQuestion');
    return this._advance(now);
  }

  /**
   * Il passo avanti comune a `nextQuestion` e `skipRound`: il round successivo,
   * oppure la premiazione se quello appena lasciato era l'ultimo.
   * @param {number} now
   * @returns {{ finished: true, leaderboard: Array } | { finished: false }}
   */
  _advance(now) {
    if (this.isLastRound) {
      this.state = STATES.FINAL_LEADERBOARD;
      this.roundStartedAt = null;
      return { finished: true, leaderboard: this.getLeaderboard() };
    }

    this.currentRoundIndex++;
    this._enterRound(now);
    return { finished: false };
  }

  /**
   * L'host chiude il round minigioco in corso: niente esito e 0 punti a tutti,
   * anche a chi aveva già scelto. Serve ad accorciare un minigioco durante la
   * serata, non a correggerlo: un round saltato non si recupera.
   *
   * Dove si va dopo dipende dal minigioco:
   *  - livello intermedio di uno a più livelli → il livello successivo;
   *  - ultimo livello → la classifica (`RESULTS`), ferma ai punti dei livelli
   *    giocati, con un riepilogo marcato `skipped` e senza risposte;
   *  - minigioco a un round → avanti come `nextQuestion`, senza classifica:
   *    i punti non sono cambiati, mostrarla non direbbe niente.
   * Le domande del quiz non si saltano.
   * @param {number} [now]
   * @returns {{ next: 'round' } | { next: 'results', results: object } | { next: 'final', leaderboard: Array }}
   */
  skipRound(now = Date.now()) {
    this._assertState(STATES.QUESTION, 'skipRound');
    const round = this.currentRound;
    if (round.kind !== 'minigame') {
      throw new NotAMinigameError();
    }

    this.currentAnswers = new Map();
    this._openResolution = null;

    // Ultimo livello di un minigioco a più livelli: si chiude sulla classifica,
    // che porta i punti dei livelli giocati. Le risposte sono già state
    // scartate, quindi il riepilogo esce vuoto.
    const { stage } = round;
    if (stage && stage.index === stage.count - 1) {
      this.state = STATES.RESULTS;
      const results = this._resultsSummary(round, {
        machineChoice: null,
        revealMs: 0,
        distribution: new Array(round.options.length).fill(0),
      });
      return { next: 'results', results: { ...results, skipped: true } };
    }

    // Livello intermedio (mai l'ultimo round della partita: dopo c'è il
    // livello successivo) o minigioco a un round: si va avanti come "Prossima".
    const next = this._advance(now);
    return next.finished
      ? { next: 'final', leaderboard: next.leaderboard }
      : { next: 'round' };
  }

  /**
   * Inserisce un round minigioco subito dopo quello corrente e avanza subito
   * su di esso. Consentito solo da RESULTS (mai a metà di un round attivo),
   * sia per l'inserimento pianificato in editor (già presente in `this.rounds`
   * dalla costruzione) sia per l'inserimento manuale dell'host a partita in
   * corso (questo metodo).
   * @param {string} type - chiave di MINIGAME_TYPES, oppure `'random'` per
   *   lasciar estrarre al sacchetto della sessione
   * @param {number} [now]
   * @returns {{ finished: boolean }} stesso shape di ritorno di nextQuestion()
   */
  insertMinigame(type, now = Date.now()) {
    this._assertState(STATES.RESULTS, 'insertMinigame');
    const def = resolveMinigameDef(type, this._minigameBag);
    if (!def) {
      throw new InvalidMinigameTypeError();
    }
    this.rounds.splice(this.currentRoundIndex + 1, 0, ...buildMinigameRounds(def));
    return this.nextQuestion(now);
  }

  // ─── Leaderboard ────────────────────────────────────────────────────────────────

  /**
   * Classifica ordinata per punteggio decrescente (a parità, ordine di iscrizione).
   */
  getLeaderboard() {
    return this.getPlayers()
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((p, i) => ({ rank: i + 1, id: p.id, nickname: p.nickname, avatar: p.avatar, score: p.score }));
  }

  /**
   * Snapshot serializzabile dello stato corrente, utile per riallineare
   * un client che si riconnette (usato in Step 6).
   */
  getSnapshot() {
    return {
      state: this.state,
      currentQuestionIndex: this.currentRoundIndex,
      totalQuestions: this.rounds.length,
      players: this.getPlayers(),
    };
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  GameSession,
  STATES,
  POINTS_MAX,
  POINTS_MIN,
  MAX_NICKNAME_LENGTH,
  // Riesportati dal registry (`server/minigames/`) per comodità dei consumer
  // storici — routes/host.js e i test importavano già questi nomi da qui.
  MINIGAME_TYPES,
  MINIGAME_TYPE_KEYS,
  RANDOM_TYPE,
  InvalidStateError,
  DuplicateNicknameError,
  PlayerNotFoundError,
  AlreadyAnsweredError,
  InvalidAnswerIndexError,
  AnswersNotOpenError,
  NotAMinigameError,
  StaleRoundError,
  InvalidNicknameError,
  InvalidAvatarError,
  EmptyQuizError,
  NotEnoughPlayersError,
  InvalidMinigameTypeError,
};
