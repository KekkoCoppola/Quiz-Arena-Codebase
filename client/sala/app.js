'use strict';

/**
 * client/sala/app.js
 *
 * Vista sala — lo schermo proiettato. Di sola lettura: si connette al socket
 * SENZA token, quindi non supera `requireHost()` e non può emettere alcun
 * evento `host:*`. Non ha bottoni e non attende input: ogni cambio di
 * schermata arriva da un broadcast `game:*`.
 *
 * Perché non serve un ruolo socket dedicato lato server: i broadcast di partita
 * sono `io.emit` globali, e ogni socket riceve `game:snapshot` al connect. Un
 * socket senza token che non emette mai `player:join` è già esattamente questo.
 *
 * Questo file non sa quali minigiochi esistano: chiede al registry condiviso
 * (`/shared/minigames/`) e delega.
 */

/* global io, qrcode, Minigames, AudioLogic, SalaAudio */

// ─── Elementi ────────────────────────────────────────────────────────────────

const els = {
  progress:     document.getElementById('sala-progress'),
  timer:        document.getElementById('sala-timer'),

  panels: {
    idle:     document.getElementById('sala-idle'),
    lobby:    document.getElementById('sala-lobby'),
    question: document.getElementById('sala-question'),
    results:  document.getElementById('sala-results'),
    final:    document.getElementById('sala-final'),
  },

  idleText:     document.getElementById('sala-idle-text'),

  qr:           document.getElementById('sala-qr'),
  joinUrl:      document.getElementById('sala-join-url'),
  playerCount:  document.getElementById('sala-player-count'),
  players:      document.getElementById('sala-players'),
  lobbyEmpty:   document.getElementById('sala-lobby-empty'),

  roundKicker:  document.getElementById('sala-round-kicker'),
  questionText: document.getElementById('sala-question-text'),
  questionHint: document.getElementById('sala-question-hint'),
  questionMedia:document.getElementById('sala-question-media'),
  options:      document.getElementById('sala-options'),
  answerCount:  document.getElementById('sala-answer-count'),

  reveal:       document.getElementById('sala-reveal'),
  distribution: document.getElementById('sala-distribution'),
  standings:    document.getElementById('sala-standings'),

  podium:       document.getElementById('sala-podium'),
  finalList:    document.getElementById('sala-final-list'),
};

// Elementi che la presentazione di un minigioco può disegnare. Stessi nomi del
// contratto in /shared/minigames/, così un modulo non sa su quale SPA gira.
const minigameEls = () => ({
  questionText:  els.questionText,
  correctAnswer: els.reveal,
});

// ─── Stato ───────────────────────────────────────────────────────────────────

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

// Mappa avatar: id stabile → emoji TEMPORANEA (identica alle altre due SPA).
const AVATARS = {
  volpe: '🦊', panda: '🐼', rana: '🐸', polpo: '🐙',
  leone: '🦁', pinguino: '🐧', koala: '🐨', tigre: '🐯',
  unicorno: '🦄', gufo: '🦉', granchio: '🦀', balena: '🐳',
};
const avatarOf = (id) => AVATARS[id] ?? '❓';

let currentOptions  = [];
let currentMinigame = null;
let countdownTimer  = null;
let lastPlayerCount = 0;
let suspenseTimer   = null;

/**
 * Cambia a ogni transizione di fase. Un reveal in attesa che scopre di
 * appartenere a una fase superata viene scartato invece di disegnare in
 * ritardo — stessa regola delle battute vocali in audio-logic.js.
 */
let phaseToken = 0;

// ─── Utilità di schermata ────────────────────────────────────────────────────

/** Mostra un solo pannello alla volta. */
function showPanel(name) {
  for (const [key, el] of Object.entries(els.panels)) {
    el.hidden = key !== name;
  }
}

/** Invalida qualunque reveal in sospeso e ferma l'attesa di un minigioco. */
function newPhase() {
  phaseToken++;
  if (suspenseTimer) {
    clearTimeout(suspenseTimer);
    suspenseTimer = null;
  }
  currentMinigame?.sala.stopSuspense();
  return phaseToken;
}

/**
 * @param {boolean} [reset] azzera anche il quadrante. Il countdown è leggibile
 *   solo durante una domanda: ovunque altro un numero fermo è rumore. L'unica
 *   eccezione è lo scadere naturale del tempo, dove lo `00:00` deve restare
 *   visibile — per questo il tick chiama `stopCountdown(false)`.
 */
function stopCountdown(reset = true) {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  els.timer.classList.remove('is-urgent');
  if (reset) els.timer.textContent = '--:--';
}

/**
 * Countdown calcolato localmente da un timestamp assoluto: la latenza di rete
 * non desincronizza la sala dall'host e dai telefoni.
 */
function startCountdown(endsAt) {
  stopCountdown();
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    const m = String(Math.floor(remaining / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    els.timer.textContent = `${m}:${s}`;
    els.timer.classList.toggle('is-urgent', remaining > 0 && remaining <= 10);
    if (remaining === 0) stopCountdown(false);
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

/**
 * Traccia di avanzamento: un cerchio per round, separati da barrette — la
 * forma alternata prevista dal DESIGN.md. I round fatti sono terracotta,
 * quello corrente è il cerchio grande giallo, i restanti restano spenti.
 */
function renderProgress(index, total) {
  els.progress.innerHTML = '';
  if (!Number.isInteger(total) || total <= 0) return;
  for (let i = 0; i < total; i++) {
    if (i > 0) {
      const bar = document.createElement('span');
      bar.className = 'bar' + (i <= index ? ' is-done' : '');
      els.progress.appendChild(bar);
    }
    const dot = document.createElement('span');
    dot.className = 'dot'
      + (i < index ? ' is-done' : '')
      + (i === index ? ' is-current' : '');
    els.progress.appendChild(dot);
  }
}

// ─── Lobby ───────────────────────────────────────────────────────────────────

/** Carica l'URL LAN e disegna il QR. Endpoint pubblico: la sala non ha token. */
async function loadJoinInfo() {
  els.qr.innerHTML = '';
  els.joinUrl.textContent = '';
  let url;
  try {
    const res = await fetch('/api/join-info');
    const body = await res.json();
    url = body.data.url;
  } catch {
    // Ripiego: l'indirizzo di questa pagina. Sul Pi in kiosk è "localhost" e
    // quindi inutile a un telefono, ma è meglio di uno spazio vuoto.
    url = `${location.protocol}//${location.host}`;
  }
  els.joinUrl.textContent = url;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    els.qr.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch {
    // Il QR non è indispensabile: resta l'URL scritto, leggibile a voce.
  }
}

function renderLobby(players) {
  els.playerCount.textContent = players.length;
  els.lobbyEmpty.hidden = players.length > 0;
  els.players.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.className = 'sala-player-chip' + (p.connected === false ? ' is-disconnected' : '');
    const av = document.createElement('span');
    av.className = 'avatar';
    av.textContent = avatarOf(p.avatar);
    const name = document.createElement('span');
    name.textContent = p.nickname;
    li.append(av, name);
    els.players.appendChild(li);
  }
}

// ─── Domanda ─────────────────────────────────────────────────────────────────

/**
 * Le due varianti della scheda domanda si escludono a vicenda: o la riga di
 * istruzione, o il riquadro immagine. Non convivono mai — con entrambe la
 * scheda sfonderebbe l'altezza dello schermo e le risposte uscirebbero dal
 * campo visivo, che su un proiettore significa perderle del tutto.
 *
 * A decidere è la **presenza della chiave** `image` nel round, non il suo
 * valore: `image: null` significa "domanda con immagine, immagine non ancora
 * caricata" e mostra il segnaposto, mentre una domanda senza immagine la
 * chiave non ce l'ha proprio. Serve perché il campo NON esiste ancora nel
 * modello dati — finché non lo si aggiunge all'editor, il ramo con immagine
 * si attiva solo con un payload che lo porta.
 *
 * @param {object | null} round payload del round, o null per la variante testo
 */
function renderQuestionMedia(round) {
  const hasMedia = round !== null && Object.prototype.hasOwnProperty.call(round, 'image');
  els.questionHint.hidden  = hasMedia;
  els.questionMedia.hidden = !hasMedia;
  if (!hasMedia) return;
  const image = round.image;

  // Il riquadro resta, col suo segnaposto, finché non arriva un'immagine vera.
  const existing = els.questionMedia.querySelector('img');
  if (existing) existing.remove();
  const icon = els.questionMedia.querySelector('.material-symbols-outlined');
  if (typeof image === 'string' && image !== '') {
    const img = document.createElement('img');
    img.src = image;
    img.alt = '';
    // Se l'immagine non carica si torna al segnaposto invece di lasciare un buco.
    img.addEventListener('error', () => { img.remove(); if (icon) icon.hidden = false; });
    if (icon) icon.hidden = true;
    els.questionMedia.appendChild(img);
  } else if (icon) {
    icon.hidden = false;
  }
}

function renderQuestion(q) {
  newPhase();
  currentOptions  = q.options ?? [];
  const isMinigame = q.kind === 'minigame';
  currentMinigame  = isMinigame ? Minigames.get(q.minigameType) : null;

  els.panels.question.classList.toggle('is-minigame', isMinigame);
  // Il nastro adesivo porta l'etichetta del round: la categoria del quiz non
  // arriva in `game:question`, quindi si usa l'informazione che c'è davvero.
  els.roundKicker.textContent = isMinigame
    ? (currentMinigame.label ?? 'Minigioco')
    : `Domanda ${q.index + 1} di ${q.total}`;

  // Il round minigioco porta con sé la propria attesa; la domanda vera mostra
  // semplicemente il proprio testo.
  if (isMinigame) {
    currentMinigame.sala.startSuspense(minigameEls(), q);
  } else {
    els.questionText.textContent = q.text;
  }

  // Un minigioco non ha immagine: la sua scena la disegna la presentazione.
  renderQuestionMedia(isMinigame ? null : q);

  els.options.innerHTML = '';
  els.options.classList.toggle('is-three', currentOptions.length === 3);
  currentOptions.forEach((option, i) => {
    const li = document.createElement('li');
    li.className = 'sala-option-card';
    const letter = document.createElement('span');
    letter.className = 'sala-option-letter';
    const icon = currentMinigame?.optionIcon(i);
    if (icon) letter.appendChild(icon);
    else letter.textContent = LETTERS[i] ?? String(i + 1);
    const label = document.createElement('span');
    label.className = 'sala-option-label';
    label.textContent = option;
    li.append(letter, label);
    els.options.appendChild(li);
  });

  els.answerCount.textContent = 'Risposte: 0';
  renderProgress(q.index, q.total);
  startCountdown(q.endsAt);
  showPanel('question');
  SalaAudio.sfx('round-start');
}

// ─── Risultati ───────────────────────────────────────────────────────────────

function renderResults(results) {
  const isMinigame = results.kind === 'minigame';
  const highlight = isMinigame
    ? currentMinigame?.highlightIndex(results)
    : results.correctIndex;

  if (isMinigame && currentMinigame) {
    currentMinigame.sala.reveal(minigameEls(), results, currentOptions);
  } else {
    els.reveal.textContent =
      `Risposta corretta: ${currentOptions[results.correctIndex] ?? '—'}`;
  }

  const total = results.distribution.reduce((a, b) => a + b, 0);
  els.distribution.innerHTML = '';
  results.distribution.forEach((n, i) => {
    const li = document.createElement('li');
    li.className = 'sala-dist-row' + (i === highlight ? ' is-correct' : '');
    const label = document.createElement('span');
    label.className = 'sala-dist-label';
    const optionLabel = currentOptions[i] ?? `Opzione ${i + 1}`;
    const icon = currentMinigame?.optionIcon(i);
    if (icon) label.append(icon, document.createTextNode(` ${optionLabel}`));
    else label.textContent = optionLabel;
    const count = document.createElement('span');
    count.textContent = String(n);
    const track = document.createElement('div');
    track.className = 'sala-dist-track';
    const bar = document.createElement('div');
    bar.className = 'sala-dist-bar';
    bar.style.width = `${total > 0 ? Math.round((n / total) * 100) : 0}%`;
    track.appendChild(bar);
    li.append(label, count, track);
    els.distribution.appendChild(li);
  });

  els.standings.innerHTML = '';
  for (const p of results.leaderboard.slice(0, 5)) {
    const li = document.createElement('li');
    li.textContent = `${avatarOf(p.avatar)} ${p.nickname} — ${p.score}`;
    els.standings.appendChild(li);
  }

  showPanel('results');
  SalaAudio.sfx('reveal');
}

// ─── Classifica finale ───────────────────────────────────────────────────────

/**
 * @param {Array} entries classifica. `game:final` la manda già ordinata e con
 *   `rank`; `game:snapshot` porta invece `getPlayers()`, che è grezzo — non
 *   ordinato e senza `rank`. Si normalizza qui una volta sola, così il podio è
 *   corretto da qualunque delle due strade arrivi.
 */
function renderFinal(entries) {
  newPhase();
  stopCountdown();
  const leaderboard = entries
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  const MEDALS = ['🥇', '🥈', '🥉'];
  els.podium.innerHTML = '';
  leaderboard.slice(0, 3).forEach((p, i) => {
    const step = document.createElement('div');
    step.className = `sala-podium-step rank-${i + 1}`;
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
    els.podium.appendChild(step);
  });

  els.finalList.innerHTML = '';
  for (const p of leaderboard.slice(3)) {
    const li = document.createElement('li');
    li.textContent = `${p.rank}. ${avatarOf(p.avatar)} ${p.nickname} — ${p.score} punti`;
    els.finalList.appendChild(li);
  }

  showPanel('final');
  SalaAudio.sfx('final');
}

// ─── Socket ──────────────────────────────────────────────────────────────────

// Nessun token nell'handshake: è ciò che rende questo client di sola lettura.
const socket = io('/');

socket.on('connect', () => {
  els.idleText.textContent = 'In attesa dell\'host…';
});

socket.on('disconnect', () => {
  newPhase();
  stopCountdown();
  els.idleText.textContent = 'Connessione persa. Riconnessione in corso…';
  showPanel('idle');
});

/**
 * Riallineamento dopo un riavvio del Pi o una riconnessione a metà partita.
 *
 * Lo snapshot porta `{ state, currentQuestionIndex, totalQuestions, players }`
 * ma NON il testo della domanda né `endsAt`: durante QUESTION e RESULTS la sala
 * può quindi solo dichiarare a che punto siamo, e si ripopola davvero al
 * broadcast successivo. In LOBBY e a fine partita il riallineamento è completo.
 */
socket.on('game:snapshot', (snap) => {
  newPhase();
  lastPlayerCount = snap.players?.length ?? 0;
  renderProgress(snap.currentQuestionIndex, snap.totalQuestions);
  // Lo snapshot arriva solo se una partita esiste: se il Pi si è riavviato a
  // metà evento, la musica riprende insieme alla schermata.
  SalaAudio.music('bed');

  if (snap.state === 'LOBBY') {
    renderLobby(snap.players ?? []);
    showPanel('lobby');
    return;
  }
  if (snap.state === 'FINAL_LEADERBOARD') {
    renderFinal(snap.players ?? []);
    return;
  }
  els.idleText.textContent = snap.state === 'RESULTS'
    ? 'Risultati del round…'
    : `Round ${(snap.currentQuestionIndex ?? 0) + 1} in corso…`;
  showPanel('idle');
});

socket.on('game:lobby-update', ({ players }) => {
  newPhase();
  stopCountdown();
  // Il letto musicale parte con la partita e non si ferma più fino alla fine:
  // `music()` sulla traccia già in riproduzione è un no-op, quindi ricevere
  // venti lobby-update di fila non la fa ripartire da capo.
  SalaAudio.music('bed');
  // L'effetto è legato alla crescita della lista, non all'evento: lo stesso
  // broadcast arriva anche quando qualcuno esce.
  if (players.length > lastPlayerCount) SalaAudio.sfx('player-joined');
  lastPlayerCount = players.length;
  renderLobby(players);
  showPanel('lobby');
});

socket.on('game:question', renderQuestion);

socket.on('game:answer-count', ({ answered, total }) => {
  els.answerCount.textContent = `Risposte: ${answered} / ${total}`;
});

/**
 * Il round è chiuso, ma la sala non lo mostra subito: si lascia una finestra di
 * sospensione per il rullo di tamburi, e solo dopo si rivela. Senza questa
 * pausa il suono arriverebbe a spettacolo già finito.
 *
 * La finestra è breve di proposito: i telefoni ricevono `game:results` nello
 * stesso istante, quindi ogni millisecondo di ritardo è un millisecondo in cui
 * chi guarda il proprio schermo sa l'esito prima della sala.
 */
socket.on('game:results', (results) => {
  const token = newPhase();
  stopCountdown();
  SalaAudio.sfx('suspense');
  suspenseTimer = setTimeout(() => {
    suspenseTimer = null;
    // Se nel frattempo è arrivata un'altra fase, questo reveal è vecchio.
    if (AudioLogic.isStale(token, phaseToken)) return;
    renderResults(results);
  }, AudioLogic.SUSPENSE_MS);
});

socket.on('game:final', ({ leaderboard }) => renderFinal(leaderboard));

socket.on('game:reset', () => {
  newPhase();
  stopCountdown();
  lastPlayerCount = 0;
});

socket.on('game:ended', () => {
  newPhase();
  stopCountdown();
  SalaAudio.music(null);   // in dissolvenza: la sala torna in silenzio
  els.idleText.textContent = 'Partita terminata.';
  showPanel('idle');
});

// ─── Avvio ───────────────────────────────────────────────────────────────────

// Nessun gesto utente da attendere: sul proiettore non c'è nessuno che clicca.
// Chromium va lanciato con --autoplay-policy=no-user-gesture-required; sul
// desktop di sviluppo, dove il flag non c'è, il contesto nasce sospeso e il
// primo click qualunque lo sblocca (vedi SalaAudio.arm).
SalaAudio.arm();
loadJoinInfo();
showPanel('idle');
