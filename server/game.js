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
    this.state = STATES.LOBBY;
    this.currentQuestionIndex = -1;
    this.questionStartedAt = null;

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

  get currentQuestion() {
    return this.quiz.questions[this.currentQuestionIndex] ?? null;
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

    this.currentQuestionIndex = 0;
    this._enterQuestion(now);
  }

  _enterQuestion(now) {
    this.state = STATES.QUESTION;
    this.questionStartedAt = now;
    this.currentAnswers = new Map();
  }

  /**
   * Restituisce la domanda corrente sanitizzata (senza `correct_index`),
   * sicura da inviare ai client giocatore mentre il round è aperto.
   */
  getCurrentQuestion() {
    this._assertState(STATES.QUESTION, 'getCurrentQuestion');
    const q = this.currentQuestion;
    return {
      index: this.currentQuestionIndex,
      total: this.quiz.questions.length,
      text: q.text,
      options: q.options,
      time_limit_s: q.time_limit_s,
    };
  }

  /**
   * Registra la risposta di un giocatore. Consentito solo in stato QUESTION,
   * una sola risposta per giocatore per domanda.
   * @param {string} playerId
   * @param {number} optionIndex
   * @param {number} [now]
   * @returns {{ correct: boolean, pointsAwarded: number }}
   */
  submitAnswer(playerId, optionIndex, now = Date.now()) {
    this._assertState(STATES.QUESTION, 'submitAnswer');
    this._getPlayerOrThrow(playerId);

    if (this.currentAnswers.has(playerId)) {
      throw new AlreadyAnsweredError();
    }

    const q = this.currentQuestion;
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= q.options.length) {
      throw new InvalidAnswerIndexError();
    }

    const correct = optionIndex === q.correct_index;
    const pointsAwarded = correct ? this._computeScore(q, now) : 0;

    this.currentAnswers.set(playerId, {
      optionIndex,
      correct,
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
    const elapsedMs = now - this.questionStartedAt;
    const ratio = Math.max(0, Math.min(1, 1 - elapsedMs / timeLimitMs));
    if (ratio === 0) return 0; // tempo scaduto
    return Math.round(POINTS_MIN + (POINTS_MAX - POINTS_MIN) * ratio);
  }

  // ─── Results ────────────────────────────────────────────────────────────────────

  /**
   * Chiude la domanda corrente: QUESTION -> RESULTS.
   * Assegna 0 punti ai giocatori che non hanno risposto, aggiorna i punteggi
   * totali e restituisce un riepilogo con distribuzione risposte e classifica.
   * @param {number} [now]
   */
  endQuestion(now = Date.now()) {
    this._assertState(STATES.QUESTION, 'endQuestion');

    const q = this.currentQuestion;
    const distribution = new Array(q.options.length).fill(0);

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
      questionIndex: this.currentQuestionIndex,
      correctIndex: q.correct_index,
      distribution,
      answers: Array.from(this.currentAnswers.entries()).map(([playerId, a]) => ({
        playerId,
        nickname: this.players.get(playerId)?.nickname ?? null,
        optionIndex: a.optionIndex,
        correct: a.correct,
        pointsAwarded: a.pointsAwarded,
      })),
      leaderboard: this.getLeaderboard(),
    };
  }

  /**
   * Avanza alla domanda successiva (RESULTS -> QUESTION) oppure, se era
   * l'ultima domanda, chiude la partita (RESULTS -> FINAL_LEADERBOARD).
   * @param {number} [now]
   */
  nextQuestion(now = Date.now()) {
    this._assertState(STATES.RESULTS, 'nextQuestion');

    const isLastQuestion = this.currentQuestionIndex >= this.quiz.questions.length - 1;
    if (isLastQuestion) {
      this.state = STATES.FINAL_LEADERBOARD;
      this.questionStartedAt = null;
      return { finished: true, leaderboard: this.getLeaderboard() };
    }

    this.currentQuestionIndex++;
    this._enterQuestion(now);
    return { finished: false };
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
      currentQuestionIndex: this.currentQuestionIndex,
      totalQuestions: this.quiz.questions.length,
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
  InvalidStateError,
  DuplicateNicknameError,
  PlayerNotFoundError,
  AlreadyAnsweredError,
  InvalidAnswerIndexError,
  InvalidNicknameError,
  InvalidAvatarError,
  EmptyQuizError,
  NotEnoughPlayersError,
};
