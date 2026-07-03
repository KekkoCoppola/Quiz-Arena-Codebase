'use strict';

/**
 * client/player/app.js
 *
 * Fase 7: client giocatore definitivo (mobile-first, Retro Street).
 * Gestisce: join con nickname+avatar, lobby, domande con countdown,
 * feedback con posizione, podio finale, riavvio, riconnessione con token.
 */

/* global io */

// Mappa avatar: id stabile → emoji TEMPORANEA (futuri SVG: cambiare solo qui).
const AVATARS = {
  volpe: '🦊', panda: '🐼', rana: '🐸', polpo: '🐙',
  leone: '🦁', pinguino: '🐧', koala: '🐨', tigre: '🐯',
  unicorno: '🦄', gufo: '🦉', granchio: '🦀', balena: '🐳',
};
const avatarOf = (id) => AVATARS[id] ?? '❓';

const SESSION_KEY = 'quizzata-player';

const socket = io();

let playerId = null;
let selectedAvatar = null;
let countdownInterval = null;

// ─── Riferimenti DOM ─────────────────────────────────────────────────────────

const screens = {
  join:     document.getElementById('screen-join'),
  lobby:    document.getElementById('screen-lobby'),
  question: document.getElementById('screen-question'),
  feedback: document.getElementById('screen-feedback'),
  final:    document.getElementById('screen-final'),
  message:  document.getElementById('screen-message'),
};

const nicknameInput     = document.getElementById('nickname-input');
const avatarGrid        = document.getElementById('avatar-grid');
const joinBtn           = document.getElementById('join-btn');
const joinError         = document.getElementById('join-error');
const lobbyPlayers      = document.getElementById('lobby-players');
const lobbyMe           = document.getElementById('lobby-me');
const questionProgress  = document.getElementById('question-progress');
const questionText      = document.getElementById('question-text');
const questionCountdown = document.getElementById('question-countdown');
const countdownBar      = document.getElementById('countdown-bar');
const answerButtons     = document.getElementById('answer-buttons');
const answerSent        = document.getElementById('answer-sent');
const feedbackSticker   = document.getElementById('feedback-sticker');
const feedbackText      = document.getElementById('feedback-text');
const feedbackPoints    = document.getElementById('feedback-points');
const feedbackScore     = document.getElementById('feedback-score');
const feedbackRank      = document.getElementById('feedback-rank');
const finalPodium       = document.getElementById('final-podium');
const finalRest         = document.getElementById('final-rest');
const finalMe           = document.getElementById('final-me');
const messageText       = document.getElementById('message-text');
const reconnectOverlay  = document.getElementById('reconnect-overlay');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ─── Sessione persistente (riconnessione) ────────────────────────────────────

function saveSession(data) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
}
function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); }
  catch { return null; }
}
function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// ─── Helpers UI ──────────────────────────────────────────────────────────────

function show(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.hidden = key !== name;
  }
}

function showMessage(text) {
  messageText.textContent = text;
  show('message');
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

/** Countdown: numero grande + barra terracotta che si svuota. */
function startCountdown(endsAt, totalMs) {
  stopCountdown();
  const tick = () => {
    const remainingMs = Math.max(0, endsAt - Date.now());
    questionCountdown.textContent = Math.ceil(remainingMs / 1000);
    countdownBar.style.transform = `scaleX(${totalMs > 0 ? remainingMs / totalMs : 0})`;
    if (remainingMs === 0) stopCountdown();
  };
  tick();
  countdownInterval = setInterval(tick, reducedMotion ? 1000 : 100);
}

function renderMeBadge(nickname, avatar) {
  lobbyMe.innerHTML = '';
  const av = document.createElement('span');
  av.className = 'avatar';
  av.textContent = avatarOf(avatar);
  const name = document.createElement('span');
  name.textContent = nickname;
  lobbyMe.append(av, name);
}

function renderPlayerBadge(p) {
  const li = document.createElement('li');
  const av = document.createElement('span');
  av.textContent = avatarOf(p.avatar);
  const name = document.createElement('span');
  name.textContent = p.nickname;
  li.append(av, name);
  return li;
}

// ─── Avatar picker ───────────────────────────────────────────────────────────

function buildAvatarGrid() {
  const ids = Object.keys(AVATARS);
  const preselected = ids[Math.floor(Math.random() * ids.length)];
  for (const id of ids) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avatar-option';
    btn.dataset.avatarId = id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', id);
    btn.textContent = avatarOf(id);
    btn.addEventListener('click', () => selectAvatar(id));
    avatarGrid.appendChild(btn);
  }
  selectAvatar(preselected);
}

function selectAvatar(id) {
  selectedAvatar = id;
  for (const el of avatarGrid.children) {
    const selected = el.dataset.avatarId === id;
    el.classList.toggle('selected', selected);
    el.setAttribute('aria-checked', String(selected));
  }
}

// ─── Join ────────────────────────────────────────────────────────────────────

joinBtn.addEventListener('click', () => {
  const nickname = nicknameInput.value.trim();
  if (!nickname) {
    showJoinError('Inserisci un nickname.');
    return;
  }
  socket.emit('player:join', { nickname, avatarId: selectedAvatar }, (res) => {
    if (!res.ok) {
      showJoinError(res.error);
      return;
    }
    playerId = res.playerId;
    saveSession({ token: res.token, playerId, nickname, avatar: res.avatar });
    joinError.hidden = true;
    renderMeBadge(nickname, res.avatar);
    show('lobby');
  });
});

function showJoinError(text) {
  joinError.textContent = text;
  joinError.hidden = false;
  // Riavvia l'animazione shake anche su errori consecutivi.
  joinError.style.animation = 'none';
  void joinError.offsetWidth;
  joinError.style.animation = '';
}

nicknameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

// ─── Rendering domanda / risposta ────────────────────────────────────────────

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

function renderQuestion(q, alreadyAnswered = false) {
  questionProgress.textContent = `${q.index + 1}/${q.total}`;
  questionText.textContent = q.text;
  answerSent.hidden = !alreadyAnswered;
  answerButtons.classList.toggle('answer-locked', alreadyAnswered);
  answerButtons.innerHTML = '';

  q.options.forEach((option, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'answer-btn';
    const letter = document.createElement('span');
    letter.className = 'letter';
    letter.textContent = LETTERS[i] ?? String(i + 1);
    const label = document.createElement('span');
    label.textContent = option;
    btn.append(letter, label);
    btn.addEventListener('click', () => submitAnswer(i, btn));
    answerButtons.appendChild(btn);
  });

  startCountdown(q.endsAt, q.time_limit_s * 1000);
  show('question');
}

function submitAnswer(optionIndex, btn) {
  socket.emit('player:answer', { optionIndex }, (res) => {
    answerButtons.classList.add('answer-locked');
    if (res.ok) {
      btn.classList.add('answer-chosen');
      answerSent.textContent = 'Risposta inviata!';
    } else {
      answerSent.textContent = res.error;
    }
    answerSent.hidden = false;
  });
}

// ─── Feedback / classifiche ──────────────────────────────────────────────────

function ordinale(n) { return `${n}°`; }

function renderFeedback({ mine, leaderboard }) {
  feedbackSticker.classList.remove('is-correct', 'is-wrong', 'is-neutral');
  if (!mine) {
    feedbackSticker.classList.add('is-neutral');
    feedbackText.textContent = 'Tempo scaduto!';
    feedbackPoints.textContent = '+0 punti';
  } else if (mine.correct) {
    feedbackSticker.classList.add('is-correct');
    feedbackText.textContent = 'GIUSTO!';
    feedbackPoints.textContent = `+${mine.pointsAwarded} punti`;
  } else {
    feedbackSticker.classList.add('is-wrong');
    feedbackText.textContent = 'SBAGLIATO';
    feedbackPoints.textContent = '+0 punti';
  }

  const me = leaderboard.find((p) => p.id === playerId);
  feedbackScore.textContent = me ? me.score : '—';
  feedbackRank.textContent = me
    ? `Sei ${ordinale(me.rank)} su ${leaderboard.length}`
    : '';
  show('feedback');
}

function renderFinal(leaderboard) {
  finalPodium.innerHTML = '';
  finalRest.innerHTML = '';
  finalMe.hidden = true;

  const MEDALS = ['🥇', '🥈', '🥉'];
  leaderboard.slice(0, 3).forEach((p, i) => {
    const step = document.createElement('div');
    step.className = `podium-step rank-${i + 1}`;

    const medal = document.createElement('span');
    medal.className = 'medal';
    medal.textContent = MEDALS[i];
    const av = document.createElement('span');
    av.className = 'avatar';
    av.textContent = avatarOf(p.avatar);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.nickname;
    const points = document.createElement('span');
    points.className = 'points';
    points.textContent = `${p.score} punti`;

    step.append(medal, av, name, points);
    finalPodium.appendChild(step);
  });

  for (const p of leaderboard.slice(3)) {
    const li = document.createElement('li');
    const pos = document.createElement('span');
    pos.className = 'pos';
    pos.textContent = String(p.rank);
    const av = document.createElement('span');
    av.textContent = avatarOf(p.avatar);
    const name = document.createElement('span');
    name.textContent = p.nickname;
    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = String(p.score);
    li.append(pos, av, name, pts);
    finalRest.appendChild(li);
  }

  const me = leaderboard.find((p) => p.id === playerId);
  if (me && me.rank > 3) {
    finalMe.textContent = `La tua posizione: ${ordinale(me.rank)}`;
    finalMe.hidden = false;
  }
  show('final');
}

// ─── Eventi di gioco ─────────────────────────────────────────────────────────

socket.on('game:lobby-update', ({ players }) => {
  if (!playerId) return;
  lobbyPlayers.innerHTML = '';
  for (const p of players) {
    lobbyPlayers.appendChild(renderPlayerBadge(p));
  }
});

socket.on('game:question', (q) => {
  if (!playerId) return;
  renderQuestion(q);
});

socket.on('game:results', (results) => {
  if (!playerId) return;
  stopCountdown();
  const mine = results.answers.find((a) => a.playerId === playerId) ?? null;
  renderFeedback({ mine, leaderboard: results.leaderboard });
});

socket.on('game:final', ({ leaderboard }) => {
  if (!playerId) return;
  stopCountdown();
  renderFinal(leaderboard);
});

socket.on('game:reset', ({ playerId: newId, token }) => {
  const session = loadSession() ?? {};
  playerId = newId;
  saveSession({ ...session, playerId: newId, token });
  show('lobby');
});

socket.on('game:ended', () => {
  playerId = null;
  clearSession();
  stopCountdown();
  showMessage('L\'host ha terminato la partita. Ricarica la pagina per giocare di nuovo.');
});

// ─── Riconnessione ───────────────────────────────────────────────────────────

/** Tenta il rejoin col token salvato; ripristina la schermata corretta. */
function tryRejoin(session) {
  socket.emit('player:rejoin', { token: session.token }, (res) => {
    reconnectOverlay.hidden = true;
    if (!res.ok) {
      playerId = null;
      clearSession();
      show('join');
      return;
    }
    playerId = res.playerId;
    saveSession({ token: res.token, playerId, nickname: res.nickname, avatar: res.avatar });
    renderMeBadge(res.nickname, res.avatar);

    if (res.state === 'LOBBY') {
      show('lobby');
    } else if (res.state === 'QUESTION' && res.question) {
      renderQuestion(res.question, res.question.alreadyAnswered);
    } else if (res.state === 'FINAL_LEADERBOARD') {
      renderFinal(res.leaderboard ?? []);
    } else {
      // RESULTS: nessun dettaglio sull'ultima risposta, mostra punteggio attuale.
      const leaderboard = res.leaderboard ?? [];
      const me = leaderboard.find((p) => p.id === playerId);
      feedbackSticker.classList.remove('is-correct', 'is-wrong');
      feedbackSticker.classList.add('is-neutral');
      feedbackText.textContent = 'Bentornato!';
      feedbackPoints.textContent = '';
      feedbackScore.textContent = me ? me.score : res.score;
      feedbackRank.textContent = me ? `Sei ${ordinale(me.rank)} su ${leaderboard.length}` : '';
      show('feedback');
    }
  });
}

socket.on('connect', () => {
  const session = loadSession();
  if (session?.token && !playerId) {
    tryRejoin(session);
  }
});

socket.on('disconnect', () => {
  if (playerId) {
    stopCountdown();
    playerId = null; // al reconnect il flusso passa da tryRejoin
    reconnectOverlay.hidden = false;
  }
});

// ─── Init ────────────────────────────────────────────────────────────────────

buildAvatarGrid();
