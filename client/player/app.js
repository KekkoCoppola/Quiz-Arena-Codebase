'use strict';

/**
 * client/player/app.js
 *
 * Fase 7: client giocatore definitivo (mobile-first, Retro Street).
 * Gestisce: join con nickname+avatar, lobby, domande con countdown,
 * feedback con posizione, podio finale, riavvio, riconnessione con token.
 */

/* global io, Minigames, FinalSchedule, ServerClock */

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
/** Attesa della fine dell'anteprima di un minigioco, prima di aprire le risposte. */
let previewTimer = null;
// Round corrente, per il reveal del feedback (il payload game:results non
// ripete le opzioni): tipo di round + opzioni mostrate.
let currentRoundKind = 'question';
let currentRoundOptions = [];
// Presentazione del minigioco in corso, dal registry condiviso
// (/shared/minigames/). Null durante una domanda normale. Questo file non sa
// quali minigiochi esistano: chiede al registry e delega.
let currentMinigame = null;
// Cresce a ogni nuova fase (domanda, risultati, reset, fine): un "trattieni" del
// reveal minigioco ancora in corso si accorge di essere superato e si ferma.
let revealToken = 0;

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
const feedbackWaiting   = document.getElementById('feedback-waiting');
const finalPodium       = document.getElementById('final-podium');
const finalRest         = document.getElementById('final-rest');
const finalMe           = document.getElementById('final-me');
const meCard            = document.getElementById('final-me-card');
const finalWaiting      = document.getElementById('final-waiting');
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
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

/** Countdown: numero grande + barra terracotta che si svuota. */
function startCountdown(endsAt, totalMs, serverNow) {
  stopCountdown();
  const deadline = ServerClock.localDeadline(endsAt, serverNow);
  const tick = () => {
    const remainingMs = ServerClock.remainingMs(deadline);
    // Mai più del tempo del round: al via mancano 6,00x s e il ceil darebbe 7.
    questionCountdown.textContent = Math.min(Math.ceil(remainingMs / 1000), Math.ceil(totalMs / 1000));
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
  const isMinigame = q.kind === 'minigame';
  currentRoundKind = q.kind;
  currentRoundOptions = q.options;

  // La classe di layout del minigioco precedente va rimossa prima di applicare
  // quella nuova: due minigiochi possono chiedere disposizioni diverse.
  if (currentMinigame?.playerLayoutClass) {
    answerButtons.classList.remove(currentMinigame.playerLayoutClass);
  }
  currentMinigame = isMinigame ? Minigames.get(q.minigameType) : null;

  screens.question.classList.toggle('is-minigame', isMinigame);
  questionProgress.textContent = isMinigame ? currentMinigame.playerBadge : `${q.index + 1}/${q.total}`;
  questionProgress.classList.toggle('badge-yellow', !isMinigame);
  questionProgress.classList.toggle('badge-ochre', isMinigame);
  questionText.textContent = q.text;
  answerSent.hidden = !alreadyAnswered;
  answerButtons.classList.toggle('answer-locked', alreadyAnswered);
  if (currentMinigame?.playerLayoutClass) {
    answerButtons.classList.add(currentMinigame.playerLayoutClass);
  }
  answerButtons.innerHTML = '';

  q.options.forEach((option, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.addEventListener('click', () => submitAnswer(i, btn));

    if (isMinigame) {
      // Il minigioco decide che aspetto ha la sua scelta (icona, forma, testo).
      currentMinigame.player.renderChoice(btn, i, option);
    } else {
      btn.className = 'answer-btn';
      const letter = document.createElement('span');
      letter.className = 'letter';
      letter.textContent = LETTERS[i] ?? String(i + 1);
      const label = document.createElement('span');
      label.textContent = option;
      btn.append(letter, label);
    }

    answerButtons.appendChild(btn);
  });

  // Minigioco con anteprima (es. i bicchieri da seguire): prima si guarda lo
  // schermo grande, poi si sceglie. Il server rifiuterebbe comunque una
  // risposta anticipata; qui la si rende impossibile invece che sbagliata.
  const openAt = q.answersOpenAt
    ? ServerClock.localDeadline(q.answersOpenAt, q.serverNow)
    : 0;
  const previewLeftMs = openAt ? ServerClock.remainingMs(openAt) : 0;
  if (!alreadyAnswered && previewLeftMs > 0) {
    stopCountdown();
    answerButtons.classList.add('answer-locked');
    answerSent.textContent = 'Guarda lo schermo!';
    answerSent.hidden = false;
    // Il tempo per rispondere non è ancora partito: si mostra pieno e fermo.
    questionCountdown.textContent = q.time_limit_s;
    countdownBar.style.transform = 'scaleX(1)';
    const receivedAt = Date.now();
    previewTimer = setTimeout(() => {
      previewTimer = null;
      answerButtons.classList.remove('answer-locked');
      answerSent.hidden = true;
      // `localDeadline` misura lo scarto fra orologi nell'istante in cui la si
      // chiama: qui `serverNow` va fatto avanzare di quanto è passato dalla
      // ricezione, o la scadenza slitterebbe di tutta l'anteprima.
      startCountdown(q.endsAt, q.time_limit_s * 1000, q.serverNow + (Date.now() - receivedAt));
    }, previewLeftMs);
  } else {
    if (alreadyAnswered) answerSent.textContent = 'Risposta inviata!';
    startCountdown(q.endsAt, q.time_limit_s * 1000, q.serverNow);
  }
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

// Dopo l'ultimo round il telefono NON dice la posizione. Chi è primo lo
// scoprirebbe qui, da solo, un minuto prima che la sala lo proclami — e la sua
// faccia rovinerebbe il finale a tutta la stanza, che è esattamente ciò che il
// secondo posto tenuto coperto durante la cerimonia esiste per evitare.
// Il punteggio resta: è solo il proprio, e da solo non dice dove si è arrivati.
const WAIT_NEXT  = 'In attesa della prossima domanda…';
const WAIT_FINAL = 'Attendi la premiazione 🏆';
const WAIT_STAGE = 'Prossimo round in arrivo…';

/**
 * Livello intermedio di un minigioco a più round: il server riparte da solo
 * col livello successivo, e la classifica arriva solo dopo l'ultimo.
 */
function isIntermediateStage(results) {
  const stage = results?.stage;
  return Boolean(stage) && stage.index < stage.count - 1;
}

/** Riga d'attesa in fondo al feedback: prossima domanda, livello o premiazione. */
function setWaiting(isLastRound, stageNext = false) {
  feedbackWaiting.textContent = stageNext ? WAIT_STAGE : (isLastRound ? WAIT_FINAL : WAIT_NEXT);
}

/**
 * @param {object} p
 * @param {object|null} p.mine la mia risposta, null se non ho risposto in tempo
 * @param {Array} p.leaderboard classifica dal payload game:results
 * @param {string} [p.kind] 'question' | 'minigame'
 * @param {object|null} [p.results] payload game:results completo, passato tale
 *   e quale al minigioco: è lui a sapere quali campi gli servono
 * @param {boolean} [p.isLastRound] dopo questi risultati viene la premiazione:
 *   la posizione in classifica resta coperta
 */
function renderFeedback({
  mine, leaderboard, kind = 'question', results = null, isLastRound = false,
}) {
  feedbackSticker.classList.remove('is-correct', 'is-wrong', 'is-neutral');

  if (kind === 'minigame') {
    // Il minigioco disegna il proprio esito: sa lui cosa significa "vinto" e
    // come mostrarlo. Qui si passano solo gli elementi su cui può scrivere.
    // Se il round è arrivato senza che sia passato da renderQuestion (es. un
    // rientro a metà partita), si ricade sulla presentazione generica.
    const presentation = currentMinigame ?? Minigames.get(results?.minigameType);
    presentation.player.reveal(
      { sticker: feedbackSticker, text: feedbackText, points: feedbackPoints },
      mine,
      results ?? {}
    );
  } else if (!mine) {
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
  const stageNext = isIntermediateStage(results);
  if (isLastRound) {
    feedbackRank.textContent = 'Classifica sigillata';
  } else if (stageNext) {
    // Fra un livello e l'altro la posizione non si dice: si scopre alla fine
    // dei cinque round, insieme alla sala.
    feedbackRank.textContent = '';
  } else {
    feedbackRank.textContent = me
      ? `Sei ${ordinale(me.rank)} su ${leaderboard.length}`
      : '';
  }
  setWaiting(isLastRound, stageNext);
  show('feedback');
}

// ─── Premiazione ─────────────────────────────────────────────────────────────
//
// Il telefono non è una seconda classifica: mostra SOLO la propria posizione, e
// la scopre nell'istante in cui la sala la proclama. I tempi li detta
// `/shared/final-schedule.js`, lo stesso calendario che segue il proiettore —
// più PLAYER_LAG_MS, il margine che rende impossibile arrivare in anticipo.
// La classifica completa compare solo alla fine: prima sarebbe uno spoiler.

const MEDALS = ['🥇', '🥈', '🥉'];
const FINAL_SPARKLES = 10;
const SPARKLE_GLYPHS = ['✦', '✧', '⭐'];

/** Durata di `fc-pop` in /shared/final-ceremony.css: solo come scadenza. */
const POP_MS = 620;

/** Timer della cerimonia, tracciati per poterli spegnere tutti insieme. */
let ceremonyTimers = [];

function stopCeremony() {
  for (const t of ceremonyTimers) clearTimeout(t);
  ceremonyTimers = [];
  window.Confetti?.stop();
}

/** Un gradino del podio. Usato sia per la propria card sia per il podio finale. */
function buildPodiumStep(p, rank) {
  const step = document.createElement('div');
  step.className = `podium-step rank-${rank}`;

  const medal = document.createElement('span');
  medal.className = 'medal';
  medal.textContent = MEDALS[rank - 1];
  const av = document.createElement('span');
  av.className = 'avatar fc-avatar';
  av.textContent = avatarOf(p.avatar);
  const name = document.createElement('span');
  name.className = 'name fc-name';
  name.textContent = p.nickname;
  const points = document.createElement('span');
  points.className = 'points fc-points';
  points.textContent = `${p.score} punti`;

  step.append(medal, av, name, points);
  return step;
}

/** La propria posizione fuori dal podio: una fascia grande, leggibile al volo. */
function buildMyTailCard(p) {
  const card = document.createElement('div');
  card.className = 'me-card-row';

  const pos = document.createElement('span');
  pos.className = 'pos';
  pos.textContent = ordinale(p.rank);
  const av = document.createElement('span');
  av.className = 'avatar fc-avatar';
  av.textContent = avatarOf(p.avatar);
  const name = document.createElement('span');
  name.className = 'name fc-name';
  name.textContent = p.nickname;
  const pts = document.createElement('span');
  pts.className = 'points fc-points';
  pts.textContent = `${p.score} punti`;

  card.append(pos, av, name, pts);
  return card;
}

/** Le stelline del vincitore, come in sala. */
function addSparkles(el) {
  if (reducedMotion) return;
  const layer = document.createElement('span');
  layer.className = 'fc-sparkles';
  layer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < FINAL_SPARKLES; i++) {
    const s = document.createElement('span');
    s.className = 'fc-sparkle';
    s.textContent = SPARKLE_GLYPHS[(Math.random() * SPARKLE_GLYPHS.length) | 0];
    s.style.setProperty('--fc-x', `${Math.random() * 100}%`);
    s.style.setProperty('--fc-y', `${Math.random() * 100}%`);
    s.style.setProperty('--fc-delay', `${Math.round(Math.random() * 700)}ms`);
    s.style.fontSize = `${0.8 + Math.random() * 1}rem`;
    layer.appendChild(s);
  }
  el.appendChild(layer);
}

/** La classifica completa: podio, propria posizione, resto. Solo a fine corsa. */
function renderFinalFrame(leaderboard) {
  finalPodium.innerHTML = '';
  finalRest.innerHTML = '';

  for (const p of leaderboard.slice(0, 3)) {
    finalPodium.appendChild(buildPodiumStep(p, p.rank));
  }

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

  finalPodium.hidden = false;
  finalRest.hidden = leaderboard.length <= 3;
  finalWaiting.textContent = 'Grazie per aver giocato!';
  finalWaiting.classList.remove('fc-pending');
}

/**
 * @param {Array} entries classifica finale.
 * @param {{ animate?: boolean }} [opts] `animate: false` salta la cerimonia —
 *   serve a chi rientra da `player:rejoin` a premiazione già avvenuta, che deve
 *   ritrovare la classifica e non una proclamazione in ritardo.
 */
function renderFinal(entries, { animate = true } = {}) {
  const token = ++revealToken;
  stopCeremony();

  const leaderboard = entries
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  meCard.innerHTML = '';
  finalPodium.hidden = true;
  finalRest.hidden = true;
  finalMe.hidden = true;
  show('final');

  const me = leaderboard.find((p) => p.id === playerId);

  // Senza cerimonia anche se non ci si ritrova in classifica: non deve capitare,
  // ma restare davanti a uno schermo vuoto sarebbe il modo peggiore di scoprirlo.
  if (!animate || reducedMotion || !me) {
    renderFinalFrame(leaderboard);
    return;
  }

  runCeremony(leaderboard, me, token);
}

/**
 * Esegue solo gli atti che riguardano il proprietario del telefono.
 *
 * Ogni atto è pianificato come scarto dalla RICEZIONE di `game:final`, mai da un
 * orario: sala e telefoni partono dalla stessa trasmissione, quindi lo scarto
 * fra gli orologi dei dispositivi esce dal problema. Il ritardo aggiunto è ciò
 * che garantisce che il telefono non possa mai precedere il proiettore.
 */
function runCeremony(leaderboard, me, token) {
  const schedule = FinalSchedule.buildFinalSchedule({ playerCount: leaderboard.length });
  const mine = FinalSchedule.stepsForRank(schedule, me.rank);

  finalWaiting.textContent = 'La premiazione è iniziata…';
  finalWaiting.classList.add('fc-pending');

  for (const beat of mine) {
    const id = setTimeout(() => {
      if (token !== revealToken) return;
      playBeat(beat, leaderboard, me);
    }, beat.at + FinalSchedule.PLAYER_LAG_MS);
    ceremonyTimers.push(id);
  }
}

/** Cosa mostra ciascun atto sul telefono di chi lo riceve. */
function playBeat(beat, leaderboard, me) {
  switch (beat.kind) {
    // ── La propria riga in coda ──
    case 'tail':
      meCard.replaceChildren(buildMyTailCard(me));
      meCard.firstElementChild.classList.add('fc-enter');
      break;

    // ── Sul podio, ma senza nome: si resta in sospeso quanto la sala ──
    case 'podium-2-covered': {
      const step = buildPodiumStep(me, 2);
      step.classList.add('fc-covered', 'fc-pop');
      meCard.replaceChildren(step);
      // Il respiro dell'attesa arriva a salita finita: `fc-waiting` anima anche
      // lui il transform e vincerebbe sul pop. "Finita" è l'evento OPPURE una
      // scadenza: a schermo bloccato l'animazione non parte e `animationend`
      // non arriverebbe mai, lasciando la card immobile fino alla scopertura.
      let armed = false;
      const breathe = () => {
        if (armed) return;
        armed = true;
        step.classList.remove('fc-pop');
        step.classList.add('fc-waiting');
      };
      step.addEventListener('animationend', breathe, { once: true });
      ceremonyTimers.push(setTimeout(breathe, POP_MS + 120));
      break;
    }

    // ── Il bronzo ──
    case 'podium-3': {
      const step = buildPodiumStep(me, 3);
      step.classList.add('fc-pop');
      meCard.replaceChildren(step);
      window.Confetti?.burst({ count: 50, power: 13 });
      break;
    }

    // ── La proclamazione ──
    case 'winner': {
      const step = buildPodiumStep(me, 1);
      step.classList.add('fc-erupt');
      meCard.replaceChildren(step);
      addSparkles(step);
      window.Confetti?.burst({ count: 120, power: 18 });
      break;
    }

    // ── E solo ORA il secondo scopre di essere secondo ──
    case 'uncover-2': {
      const step = meCard.firstElementChild;
      if (!step) break;
      step.classList.remove('fc-covered', 'fc-waiting');
      step.classList.add('fc-uncover');
      window.Confetti?.burst({ count: 70, power: 15 });
      break;
    }

    // ── Il fotogramma finale: adesso si può vedere tutta la classifica ──
    case 'settle':
      // La card grande sparisce: ha fatto il suo lavoro durante la cerimonia,
      // ma accanto al podio mostrerebbe due volte la stessa persona.
      meCard.replaceChildren();
      renderFinalFrame(leaderboard);
      break;
  }
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
  revealToken++; // un eventuale reveal in sospeso è ormai superato
  renderQuestion(q);
});

socket.on('game:results', (results) => {
  if (!playerId) return;
  stopCountdown();
  const mine = results.answers.find((a) => a.playerId === playerId) ?? null;

  const doReveal = () => renderFeedback({
    mine,
    leaderboard: results.leaderboard,
    kind: results.kind,
    results,
    isLastRound: Boolean(results.isLastRound),
  });

  // Minigioco con sospensione sincronizzata: si TRATTIENE l'esito fino a
  // `revealAt`, così il telefono non lo svela prima che in sala il reveal si
  // compia. L'istante è lo stesso timestamp assoluto per tutti gli schermi.
  if (results.revealAt) {
    const myToken = ++revealToken;
    const presentation = currentMinigame ?? Minigames.get(results.minigameType);
    const ctx = {
      revealAt: ServerClock.localDeadline(results.revealAt, results.serverNow),
      isStale: () => myToken !== revealToken,
      done: () => { if (myToken === revealToken) doReveal(); },
    };

    feedbackSticker.classList.remove('is-correct', 'is-wrong', 'is-neutral');
    feedbackSticker.classList.add('is-neutral');
    feedbackScore.textContent = '—';
    feedbackRank.textContent = '';
    setWaiting(Boolean(results.isLastRound), isIntermediateStage(results));
    show('feedback');

    if (presentation.player.playReveal) {
      presentation.player.playReveal(
        { sticker: feedbackSticker, text: feedbackText, points: feedbackPoints },
        mine,
        results,
        ctx,
      );
    } else {
      // Fallback generico: attesa neutra fino a revealAt, senza svelare nulla.
      feedbackText.textContent = 'Guarda lo schermo!';
      feedbackPoints.textContent = '';
      setTimeout(ctx.done, ServerClock.remainingMs(
        ServerClock.localDeadline(results.revealAt, results.serverNow)));
    }
    return;
  }

  doReveal();
});

socket.on('game:final', ({ leaderboard }) => {
  if (!playerId) return;
  stopCountdown();
  renderFinal(leaderboard);
});

socket.on('game:reset', ({ playerId: newId, token }) => {
  revealToken++; // ferma un eventuale trattieni in corso
  stopCeremony();
  const session = loadSession() ?? {};
  playerId = newId;
  saveSession({ ...session, playerId: newId, token });
  show('lobby');
});

socket.on('game:ended', () => {
  revealToken++; // ferma un eventuale trattieni in corso
  stopCeremony();
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
      // Chi rientra a premiazione conclusa trova la classifica, non una
      // proclamazione in ritardo di mezzo minuto.
      renderFinal(res.leaderboard ?? [], { animate: false });
    } else {
      // RESULTS: nessun dettaglio sull'ultima risposta, mostra punteggio attuale.
      const leaderboard = res.leaderboard ?? [];
      const me = leaderboard.find((p) => p.id === playerId);
      feedbackSticker.classList.remove('is-correct', 'is-wrong');
      feedbackSticker.classList.add('is-neutral');
      feedbackText.textContent = 'Bentornato!';
      feedbackPoints.textContent = '';
      feedbackScore.textContent = me ? me.score : res.score;
      // Rientrare fra l'ultima domanda e la premiazione non è una scorciatoia
      // per sapere come è andata: vale lo stesso silenzio di chi è rimasto.
      if (res.isLastRound) {
        feedbackRank.textContent = 'Classifica sigillata';
      } else {
        feedbackRank.textContent = me ? `Sei ${ordinale(me.rank)} su ${leaderboard.length}` : '';
      }
      setWaiting(Boolean(res.isLastRound));
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
