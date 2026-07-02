'use strict';

/**
 * client/player/app.js
 *
 * Step 6: logica giocatore MINIMALE (zero design → Step 7).
 * Gestisce: join con nickname, lobby, risposta alle domande con countdown,
 * feedback, classifica finale, riavvio partita.
 */

/* global io */

const socket = io();

let playerId = null;
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
const joinBtn           = document.getElementById('join-btn');
const joinError         = document.getElementById('join-error');
const lobbyPlayers      = document.getElementById('lobby-players');
const questionProgress  = document.getElementById('question-progress');
const questionText      = document.getElementById('question-text');
const questionCountdown = document.getElementById('question-countdown');
const answerButtons     = document.getElementById('answer-buttons');
const answerSent        = document.getElementById('answer-sent');
const feedbackText      = document.getElementById('feedback-text');
const feedbackScore     = document.getElementById('feedback-score');
const finalLeaderboard  = document.getElementById('final-leaderboard');
const messageText       = document.getElementById('message-text');

/** Mostra una sola schermata alla volta. */
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

// ─── Join ────────────────────────────────────────────────────────────────────

joinBtn.addEventListener('click', () => {
  const nickname = nicknameInput.value.trim();
  if (!nickname) {
    joinError.textContent = 'Inserisci un nickname.';
    joinError.hidden = false;
    return;
  }
  socket.emit('player:join', { nickname }, (res) => {
    if (!res.ok) {
      joinError.textContent = res.error;
      joinError.hidden = false;
      return;
    }
    playerId = res.playerId;
    joinError.hidden = true;
    show('lobby');
  });
});

nicknameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

// ─── Eventi di gioco ─────────────────────────────────────────────────────────

socket.on('game:lobby-update', ({ players }) => {
  lobbyPlayers.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.textContent = p.nickname;
    lobbyPlayers.appendChild(li);
  }
});

socket.on('game:question', (q) => {
  if (!playerId) return; // non ancora in partita
  stopCountdown();

  questionProgress.textContent = `Domanda ${q.index + 1} di ${q.total}`;
  questionText.textContent = q.text;
  answerSent.hidden = true;
  answerButtons.innerHTML = '';

  q.options.forEach((option, i) => {
    const btn = document.createElement('button');
    btn.textContent = option;
    btn.addEventListener('click', () => {
      socket.emit('player:answer', { optionIndex: i }, (res) => {
        if (!res.ok) {
          answerSent.textContent = res.error;
        } else {
          answerSent.textContent = 'Risposta inviata. Attendi i risultati…';
        }
        answerButtons.innerHTML = '';
        answerSent.hidden = false;
      });
    });
    answerButtons.appendChild(btn);
  });

  // Countdown basato su endsAt (timestamp assoluto dal server)
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((q.endsAt - Date.now()) / 1000));
    questionCountdown.textContent = remaining;
    if (remaining === 0) stopCountdown();
  };
  tick();
  countdownInterval = setInterval(tick, 250);

  show('question');
});

socket.on('game:results', (results) => {
  if (!playerId) return;
  stopCountdown();

  const mine = results.answers.find((a) => a.playerId === playerId);
  if (!mine) {
    feedbackText.textContent = 'Tempo scaduto! Non hai risposto. +0 punti';
  } else if (mine.correct) {
    feedbackText.textContent = `Giusto! +${mine.pointsAwarded} punti`;
  } else {
    feedbackText.textContent = 'Sbagliato! +0 punti';
  }

  const me = results.leaderboard.find((p) => p.id === playerId);
  feedbackScore.textContent = me ? me.score : '—';
  show('feedback');
});

socket.on('game:final', ({ leaderboard }) => {
  if (!playerId) return;
  stopCountdown();
  finalLeaderboard.innerHTML = '';
  for (const p of leaderboard) {
    const li = document.createElement('li');
    li.textContent = `${p.nickname} — ${p.score} punti`;
    finalLeaderboard.appendChild(li);
  }
  show('final');
});

socket.on('game:reset', ({ playerId: newId }) => {
  playerId = newId;
  show('lobby');
});

socket.on('game:ended', () => {
  playerId = null;
  stopCountdown();
  showMessage('L\'host ha terminato la partita. Ricarica la pagina per giocare di nuovo.');
});

socket.on('disconnect', () => {
  if (playerId) {
    stopCountdown();
    showMessage('Connessione persa. Ricarica la pagina.');
  }
});
