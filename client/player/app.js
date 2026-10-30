'use strict';

/**
 * client/player/app.js
 *
 * Fase 7: client giocatore definitivo (mobile-first, Retro Street).
 * Gestisce: join con nickname+avatar, lobby, domande con countdown,
 * feedback con posizione, podio finale, riavvio, riconnessione con token.
 */

/* global io, Minigames, ServerClock, AvatarCatalog, AvatarSprite */

// L'avatar è il personaggio (colore + espressione, client/shared/avatar-catalog.js):
// lo disegna AvatarSprite.fill, ovunque prima c'era un'emoji.

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
/** Indice del round mostrato: accompagna ogni risposta (vedi submitAnswer). */
let currentRoundIndex = null;
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
const avatarPortrait    = document.getElementById('avatar-portrait');
const avatarBody        = document.getElementById('avatar-body');
const avatarFace        = document.getElementById('avatar-face');
const avatarPrev        = document.getElementById('avatar-prev');
const avatarNext        = document.getElementById('avatar-next');
const outfitPrev        = document.getElementById('outfit-prev');
const outfitNext        = document.getElementById('outfit-next');
const avatarColors      = document.getElementById('avatar-colors');
const joinBtn           = document.getElementById('join-btn');
const joinError         = document.getElementById('join-error');
const lobbyPlayers      = document.getElementById('lobby-players');
const lobbyMe           = document.getElementById('lobby-me');
const questionProgress  = document.getElementById('question-progress');
const questionText      = document.getElementById('question-text');
const questionMore      = document.getElementById('question-more');
const questionImageHint = document.getElementById('question-image-hint');
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
const finalPlaceholder  = document.getElementById('final-placeholder');
const finalMeCard       = document.getElementById('final-me-card');
const finalList         = document.getElementById('final-list');
const finalBar          = document.getElementById('final-bar');
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
  AvatarSprite.fill(av, avatar);
  const name = document.createElement('span');
  name.textContent = nickname;
  lobbyMe.append(av, name);
}

function renderPlayerBadge(p) {
  const li = document.createElement('li');
  const av = document.createElement('span');
  AvatarSprite.fill(av, p.avatar);
  const name = document.createElement('span');
  name.textContent = p.nickname;
  li.append(av, name);
  return li;
}

// ─── Scelta del personaggio ──────────────────────────────────────────────────
// Le frecce ai lati della faccia scorrono le espressioni, quelle ai lati del
// corpo gli outfit (in cerchio), i pallini sotto scelgono il colore. Si parte
// dall'ultima scelta fatta su questo telefono, o da una combinazione a caso:
// chi va di fretta tocca "Entra" e basta.

const AVATAR_KEY = 'quizzata-avatar';

const avatarPick = { color: 0, face: 0, outfit: 0 };

function loadAvatarChoice() {
  try { return AvatarCatalog.parse(localStorage.getItem(AVATAR_KEY)); }
  catch { return null; }
}
function saveAvatarChoice(id) {
  try { localStorage.setItem(AVATAR_KEY, id); }
  catch { /* senza memoria la prossima volta si riparte a caso: va bene */ }
}

function buildAvatarPicker() {
  const { COLORS, FACES, OUTFITS } = AvatarCatalog;
  const start = loadAvatarChoice() ?? AvatarCatalog.parse(AvatarCatalog.random());
  avatarPick.color = COLORS.indexOf(start.color);
  avatarPick.face = FACES.indexOf(start.face);
  avatarPick.outfit = OUTFITS.indexOf(start.outfit);

  COLORS.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'avatar-swatch';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', c.label);
    btn.style.setProperty('--swatch', c.hex);
    btn.addEventListener('click', () => { avatarPick.color = i; renderAvatarPick(); });
    avatarColors.appendChild(btn);
  });

  const step = (key, list, delta) => {
    avatarPick[key] = (avatarPick[key] + delta + list.length) % list.length;
    renderAvatarPick();
  };
  avatarPrev.addEventListener('click', () => step('face', FACES, -1));
  avatarNext.addEventListener('click', () => step('face', FACES, 1));
  outfitPrev.addEventListener('click', () => step('outfit', OUTFITS, -1));
  outfitNext.addEventListener('click', () => step('outfit', OUTFITS, 1));

  renderAvatarPick();
}

function renderAvatarPick() {
  const { COLORS, FACES, OUTFITS } = AvatarCatalog;
  const color = COLORS[avatarPick.color];
  const face = FACES[avatarPick.face];
  const outfit = OUTFITS[avatarPick.outfit];
  selectedAvatar = AvatarCatalog.encode(color.id, face.id, outfit.id);
  const layers = AvatarSprite.layers(selectedAvatar);
  avatarBody.src = layers.body;
  avatarFace.src = layers.face;
  avatarPortrait.setAttribute('aria-label',
    `Il tuo personaggio: ${face.label}, ${color.label}, outfit ${outfit.label}`);
  // Le facce e gli outfit accanto si scaricano adesso: al tocco della freccia
  // sono già qui.
  const near = (list, i, d) => list[(i + d + list.length) % list.length].id;
  for (const d of [-1, 1]) {
    AvatarSprite.preload(AvatarSprite.layers(
      AvatarCatalog.encode(color.id, near(FACES, avatarPick.face, d), outfit.id)).face);
    AvatarSprite.preload(AvatarSprite.layers(
      AvatarCatalog.encode(color.id, face.id, near(OUTFITS, avatarPick.outfit, d))).body);
  }
  [...avatarColors.children].forEach((el, i) => {
    const selected = i === avatarPick.color;
    el.classList.toggle('selected', selected);
    el.setAttribute('aria-checked', String(selected));
  });
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
    saveAvatarChoice(res.avatar);
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
  currentRoundIndex = q.index;
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
  // Ogni domanda riparte chiusa; "Leggi tutta" compare solo se il testo
  // trabocca davvero dalle tre righe (misurato, non stimato dalla lunghezza).
  questionText.classList.remove('is-open');
  questionText.classList.add('is-clamped');
  questionText.style.maxHeight = '';
  questionMore.textContent = 'Leggi tutta';
  questionImageHint.hidden = !q.image;
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
  // Misurabile solo a schermata visibile: nascosta, ogni altezza vale zero.
  questionMore.hidden = questionText.scrollHeight <= questionText.clientHeight;
}

questionMore.addEventListener('click', () => {
  // Aperta, la domanda tiene l'altezza che aveva chiusa e scorre dentro:
  // più alta spingerebbe giù i bottoni di risposta sotto il pollice.
  const closedHeight = questionText.clientHeight;
  const open = questionText.classList.toggle('is-open');
  questionText.classList.toggle('is-clamped', !open);
  questionText.style.maxHeight = open ? `${closedHeight}px` : '';
  if (!open) questionText.scrollTop = 0;
  questionMore.textContent = open ? 'Chiudi' : 'Leggi tutta';
});

function submitAnswer(optionIndex, btn) {
  // La risposta porta il round a cui appartiene: se l'host salta il round
  // mentre il tocco è in viaggio, il server la scarta invece di contarla sul
  // round dopo. Per lo stesso motivo una conferma che arriva quando il round
  // è già cambiato non deve bloccare i bottoni di quello nuovo.
  const roundIndex = currentRoundIndex;
  socket.emit('player:answer', { optionIndex, roundIndex }, (res) => {
    if (roundIndex !== currentRoundIndex) return;
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

  if (results?.skipped) {
    // L'host ha saltato il round: non c'è un esito da raccontare, nemmeno a
    // chi aveva già scelto. Lo si dice e basta.
    feedbackSticker.classList.add('is-neutral');
    feedbackText.textContent = 'Round saltato';
    feedbackPoints.textContent = '+0 punti';
  } else if (kind === 'minigame') {
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
// Durante la cerimonia il telefono non mostra nessuna posizione: invita a
// guardare il proiettore, uguale per tutti — se cambiasse solo per i premiati,
// la sala capirebbe chi sta sul podio prima di vederlo. La fine la annuncia il
// server con `game:ceremony-done`, a una durata presa dallo stesso calendario
// della sala (/shared/final-schedule.js): solo allora compaiono la propria
// posizione e la classifica intera.

const MEDALS = ['🥇', '🥈', '🥉'];
const FINAL_SPARKLES = 10;
const SPARKLE_GLYPHS = ['✦', '✧', '⭐'];

/** Coriandoli del podio a cerimonia finita: più ricchi salendo. */
const PODIUM_CONFETTI = { 1: { count: 120, power: 18 }, 2: { count: 70, power: 15 }, 3: { count: 50, power: 13 } };

/** Classifica di `game:final`, tenuta finché il server non dice che la sala ha finito. */
let finalLeaderboard = null;

function clearFinal() {
  finalLeaderboard = null;
  window.Confetti?.stop();
}

function rankLeaderboard(entries) {
  return entries
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ ...p, rank: i + 1 }));
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

/** La propria posizione: il numero prima di tutto, poi chi si è. */
function buildMyResultCard(me, total) {
  const card = document.createElement('div');
  card.className = me.rank <= 3 ? `final-me-card rank-${me.rank}` : 'final-me-card';

  const corner = document.createElement('span');
  corner.className = 'sticker sticker-red final-corner';
  corner.textContent = `su ${total}`;
  const label = document.createElement('span');
  label.className = 'final-me-label';
  label.textContent = 'La tua posizione';
  const rank = document.createElement('span');
  rank.className = 'final-me-rank';
  rank.textContent = me.rank <= 3 ? `${MEDALS[me.rank - 1]} ${ordinale(me.rank)}` : ordinale(me.rank);

  const who = document.createElement('div');
  who.className = 'final-me-who';
  const av = document.createElement('span');
  av.className = 'avatar';
  AvatarSprite.fill(av, me.avatar);
  const text = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = me.nickname;
  const pts = document.createElement('div');
  pts.className = 'points';
  pts.textContent = `${me.score} punti`;
  text.append(name, pts);
  who.append(av, text);

  card.append(corner, label, rank, who);
  return card;
}

/** Durante la cerimonia: solo l'invito a guardare lo schermo. */
function showFinalPlaceholder(entries) {
  // Un esito di minigioco ancora trattenuto fino a `revealAt` (l'host può
  // chiudere la partita durante la sospensione) coprirebbe il segnaposto.
  revealToken++;
  finalLeaderboard = rankLeaderboard(entries);
  finalPlaceholder.hidden = false;
  finalMeCard.hidden = true;
  finalList.hidden = true;
  finalBar.hidden = true;
  screens.final.classList.remove('has-bar');
  show('final');
}

/** A cerimonia finita: posizione in grande, classifica intera, barra del grazie. */
function renderFinalResult(entries) {
  revealToken++;
  const leaderboard = rankLeaderboard(entries);
  finalLeaderboard = leaderboard;
  const me = leaderboard.find((p) => p.id === playerId);

  finalMeCard.replaceChildren();
  if (me) {
    const card = buildMyResultCard(me, leaderboard.length);
    if (!reducedMotion) card.classList.add('fc-pop');
    finalMeCard.append(card);
  }

  finalList.replaceChildren();
  for (const p of leaderboard) {
    const li = document.createElement('li');
    if (p.id === playerId) li.className = 'is-me';
    const pos = document.createElement('span');
    pos.className = 'pos';
    pos.textContent = String(p.rank);
    const av = document.createElement('span');
    AvatarSprite.fill(av, p.avatar);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.nickname;
    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = String(p.score);
    li.append(pos, av, name, pts);
    finalList.appendChild(li);
  }

  finalPlaceholder.hidden = true;
  finalMeCard.hidden = !me;
  finalList.hidden = leaderboard.length === 0;
  finalBar.hidden = false;
  screens.final.classList.add('has-bar');
  show('final');

  if (me && me.rank <= 3 && !reducedMotion) {
    if (me.rank === 1) addSparkles(finalMeCard.firstElementChild);
    window.Confetti?.burst(PODIUM_CONFETTI[me.rank]);
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
  showFinalPlaceholder(leaderboard);
});

socket.on('game:ceremony-done', () => {
  if (!playerId || !finalLeaderboard) return;
  renderFinalResult(finalLeaderboard);
});

socket.on('game:reset', ({ playerId: newId, token }) => {
  revealToken++; // ferma un eventuale trattieni in corso
  clearFinal();
  const session = loadSession() ?? {};
  playerId = newId;
  saveSession({ ...session, playerId: newId, token });
  show('lobby');
});

socket.on('game:ended', () => {
  revealToken++; // ferma un eventuale trattieni in corso
  clearFinal();
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
      // Il server sa se la sala ha già finito: chi rientra a metà cerimonia
      // torna al "Guarda lo schermo!", chi rientra dopo trova la posizione.
      if (res.ceremonyDone) renderFinalResult(res.leaderboard ?? []);
      else showFinalPlaceholder(res.leaderboard ?? []);
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

buildAvatarPicker();
