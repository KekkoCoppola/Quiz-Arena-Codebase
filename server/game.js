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
 * o un minigioco (`kind: 'minigame'`, generato a runtime dal registry
 * `MINIGAME_TYPES` — stessa forma di una domanda, ma con `correct_index`
 * deciso casualmente invece che scritto in editor). Questa uniformità di forma
 * è ciò che permette a `submitAnswer`/`_computeScore`/`endQuestion` di restare
 * identici per entrambi i tipi di round.
 */

const { randomUUID } = require('node:crypto');

// ─── Costanti di Punteggio ───────────────────────────────────────────────────────
// Stile Kahoot: punteggio massimo per risposta istantanea, minimo per risposta
// corretta arrivata all'ultimo istante utile. Risposta sbagliata o fuori tempo = 0.

const POINTS_MAX = 1000;
const POINTS_MIN = 100;

/** Lunghezza massima consentita per un nickname giocatore. */
const MAX_NICKNAME_LENGTH = 20;

/**
 * Avatar precaricati (Fase 7). Il server conosce solo gli id stabili;
 * la resa visiva (oggi emoji, domani SVG) è responsabilità dei client.
 */
const AVATAR_IDS = Object.freeze([
  'volpe', 'panda', 'rana', 'polpo', 'leone', 'pinguino',
  'koala', 'tigre', 'unicorno', 'gufo', 'granchio', 'balena',
]);

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

// ─── Minigiochi ──────────────────────────────────────────────────────────────────
// Registry dei tipi di minigioco disponibili. A differenza di una domanda, un
// minigioco NON ha una risposta corretta prefissata: ha una meccanica propria che
// si risolve alla CHIUSURA del round (`resolve()`), confrontando la scelta di ogni
// giocatore con uno stato della macchina generato in quel momento (es. la mossa
// del PC a Morra Cinese). Questo modello "gioca contro il PC + reveal" è ciò che
// distingue un minigioco da una domanda camuffata:
//   - `build()`    → descrittore del round inviato ai client (senza correct_index)
//   - `resolve()`  → estrae lo stato macchina e sa dire l'esito di ogni scelta
//   - `points`     → punti per esito (vittoria/pareggio/sconfitta)
// Il punteggio confluisce nella stessa classifica delle domande. Aggiungere un
// minigioco significa registrare qui una nuova voce, senza toccare il resto.

const MINIGAME_TYPES = Object.freeze({
  morra_cinese: {
    label: 'Morra Cinese',
    defaultTimeLimitS: 8,
    prompt: 'Sasso, Carta o Forbice?',
    options: ['Sasso', 'Carta', 'Forbice'], // 0 = Sasso, 1 = Carta, 2 = Forbice
    points: { win: 500, draw: 100, lose: 0 },
    build() {
      return {
        kind: 'minigame',
        minigameType: 'morra_cinese',
        text: this.prompt,
        options: this.options,
        time_limit_s: this.defaultTimeLimitS,
        // Nessun correct_index: l'esito si decide alla chiusura in resolve().
      };
    },
    /**
     * Estrae la mossa del PC (una sola, globale per tutti i giocatori) e
     * restituisce come classificare una scelta rispetto a essa.
     */
    resolve() {
      const machineChoice = Math.floor(Math.random() * 3);
      return {
        machineChoice,
        // Regola morra: la scelta batte la macchina se è "una avanti" nel ciclo
        // Sasso(0) → Carta(1) → Forbice(2) → Sasso(0).
        outcomeFor(optionIndex) {
          const d = (optionIndex - machineChoice + 3) % 3;
          return d === 0 ? 'draw' : d === 1 ? 'win' : 'lose';
        },
      };
    },
  },
});

const MINIGAME_TYPE_KEYS = Object.freeze(Object.keys(MINIGAME_TYPES));

/**
 * Costruisce la sequenza di round di una partita: le domande del quiz, con gli
 * eventuali minigiochi pianificati in editor (`quiz.minigames`) inseriti
 * nella posizione richiesta. Lo splice avviene dal fondo verso l'inizio così
 * gli indici `afterQuestionIndex` restano validi durante l'inserimento.
 * @param {object} quiz
 * @returns {Array<object>} rounds
 */
function buildRounds(quiz) {
  const rounds = quiz.questions.map((q) => ({ kind: 'question', ...q }));

  const slots = Array.isArray(quiz.minigames) ? quiz.minigames : [];
  const sortedSlots = slots.slice().sort((a, b) => b.afterQuestionIndex - a.afterQuestionIndex);
  for (const slot of sortedSlots) {
    const def = MINIGAME_TYPES[slot.type];
    if (!def) continue; // tipo sconosciuto: validato a monte in quiz-manager/routes, qui difesa in profondità
    rounds.splice(slot.afterQuestionIndex + 1, 0, def.build());
  }

  return rounds;
}

// ─── GameSession ─────────────────────────────────────────────────────────────────

class GameSession {
  /**
   * @param {{ title?: string, questions: Array<{ text: string, options: string[], correct_index: number, time_limit_s: number }> }} quiz
   */
  constructor(quiz) {
    if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      throw new EmptyQuizError();
    }

    this.quiz = quiz;
    this.rounds = buildRounds(quiz);
    this.state = STATES.LOBBY;
    this.currentRoundIndex = -1;
    this.roundStartedAt = null;

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

  // ─── Lobby ──────────────────────────────────────────────────────────────────────

  /**
   * Aggiunge un giocatore alla lobby. Consentito solo in stato LOBBY.
   * @param {string} nickname
   * @param {string | null} [avatarId] id da AVATAR_IDS; se assente ne viene assegnato uno casuale
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
      avatar = AVATAR_IDS[Math.floor(Math.random() * AVATAR_IDS.length)];
    } else if (!AVATAR_IDS.includes(avatar)) {
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
      kind: r.kind,
      minigameType: r.minigameType ?? null,
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
   * @returns {{ correct: boolean, pointsAwarded: number } | { recorded: true }}
   */
  submitAnswer(playerId, optionIndex, now = Date.now()) {
    this._assertState(STATES.QUESTION, 'submitAnswer');
    this._getPlayerOrThrow(playerId);

    if (this.currentAnswers.has(playerId)) {
      throw new AlreadyAnsweredError();
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
    if (round.kind === 'minigame') {
      const def = MINIGAME_TYPES[round.minigameType];
      const resolution = def.resolve();
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

    return {
      questionIndex: this.currentRoundIndex,
      kind: round.kind,
      minigameType: round.minigameType ?? null,
      correctIndex: round.kind === 'minigame' ? null : round.correct_index,
      machineChoice,
      distribution,
      answers: Array.from(this.currentAnswers.entries()).map(([playerId, a]) => ({
        playerId,
        nickname: this.players.get(playerId)?.nickname ?? null,
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

    const isLastRound = this.currentRoundIndex >= this.rounds.length - 1;
    if (isLastRound) {
      this.state = STATES.FINAL_LEADERBOARD;
      this.roundStartedAt = null;
      return { finished: true, leaderboard: this.getLeaderboard() };
    }

    this.currentRoundIndex++;
    this._enterRound(now);
    return { finished: false };
  }

  /**
   * Inserisce un round minigioco subito dopo quello corrente e avanza subito
   * su di esso. Consentito solo da RESULTS (mai a metà di un round attivo),
   * sia per l'inserimento pianificato in editor (già presente in `this.rounds`
   * dalla costruzione) sia per l'inserimento manuale dell'host a partita in
   * corso (questo metodo).
   * @param {string} type - chiave di MINIGAME_TYPES
   * @param {number} [now]
   * @returns {{ finished: boolean }} stesso shape di ritorno di nextQuestion()
   */
  insertMinigame(type, now = Date.now()) {
    this._assertState(STATES.RESULTS, 'insertMinigame');
    const def = MINIGAME_TYPES[type];
    if (!def) {
      throw new InvalidMinigameTypeError();
    }
    this.rounds.splice(this.currentRoundIndex + 1, 0, def.build());
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
  AVATAR_IDS,
  MINIGAME_TYPES,
  MINIGAME_TYPE_KEYS,
  InvalidStateError,
  DuplicateNicknameError,
  PlayerNotFoundError,
  AlreadyAnsweredError,
  InvalidAnswerIndexError,
  InvalidNicknameError,
  InvalidAvatarError,
  EmptyQuizError,
  NotEnoughPlayersError,
  InvalidMinigameTypeError,
};
