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

  parade:       document.getElementById('sala-parade'),
  paradeCard:   document.getElementById('sala-parade-card'),
  paradeAvatar: document.getElementById('sala-parade-avatar'),
  paradeName:   document.getElementById('sala-parade-name'),
  noAnswer:     document.getElementById('sala-no-answer'),

  reveal:       document.getElementById('sala-reveal'),
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
// Timer e animazioni della scena dei risultati, tracciati per poterli annullare
// tutti insieme quando la fase cambia (vedi stopScene).
let sceneTimers     = [];
let sceneAnimations = [];

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
  stopScene();
  return phaseToken;
}

/**
 * Ferma la scena dei risultati (parata degli avatar + verdetto) e rimuove
 * tutto ciò che ha lasciato a schermo. Chiamata a ogni cambio di fase: durante
 * una serata l'host può saltare avanti in qualunque momento, e un avatar in
 * volo che atterra sulla domanda successiva sarebbe un fantasma.
 */
function stopScene() {
  for (const t of sceneTimers) clearTimeout(t);
  sceneTimers = [];
  for (const a of sceneAnimations) {
    try { a.cancel(); } catch { /* animazione già conclusa */ }
  }
  sceneAnimations = [];
  for (const el of document.querySelectorAll('.sala-flying-avatar')) el.remove();
  els.parade.hidden = true;
  els.noAnswer.hidden = true;
}

/** setTimeout tracciato, così `stopScene()` può annullarlo. */
function sceneWait(fn, ms) {
  const id = setTimeout(fn, ms);
  sceneTimers.push(id);
  return id;
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
    // Vassoio degli avatar: resta vuoto durante la domanda e si riempie a round
    // chiuso, quando i giocatori vanno a posarsi sulla risposta che hanno dato.
    const tray = document.createElement('span');
    tray.className = 'sala-option-tray';
    li.append(letter, label, tray);
    els.options.appendChild(li);
  });

  els.answerCount.textContent = 'Risposte: 0';
  renderProgress(q.index, q.total);
  startCountdown(q.endsAt);
  showPanel('question');
  SalaAudio.sfx('round-start');
}

// ─── Scena dei risultati sulle opzioni ───────────────────────────────────────
//
// A round chiuso le quattro opzioni NON spariscono: restano a schermo come se la
// domanda fosse ancora aperta, e su di esse si racconta cos'è successo, in due
// atti.
//
//   Atto 1 — la parata. Un giocatore alla volta compare in basso con nome e
//            avatar; il nome sfuma e l'avatar vola a posarsi sulla risposta che
//            ha dato. Alla fine ogni opzione porta addosso chi l'ha scelta: è la
//            distribuzione delle risposte, ma fatta di persone invece che di
//            barre.
//   Atto 2 — il verdetto. Le tre risposte sbagliate vengono timbrate con una X e
//            si spengono; resta accesa solo quella giusta.
//
// Nei round minigioco il secondo atto si ferma all'evidenziazione della mossa del
// computer: lì non esistono risposte "sbagliate", solo esiti diversi.

/** Durata complessiva della parata: si accorcia il passo se i giocatori sono tanti. */
const PARADE_TOTAL_MS = 5200;
const PARADE_MIN_STEP = 130;
const PARADE_MAX_STEP = 460;
const PARADE_FLIGHT_MS = 620;

/** Card di un'opzione per indice. */
function optionCardAt(index) {
  return els.options.children[index] ?? null;
}

/**
 * Avatar di chi ha risposto. `answers` porta già l'avatar, ma se per qualunque
 * motivo mancasse (payload di un server più vecchio, giocatore uscito a round
 * aperto) si recupera dalla classifica, che arriva nello stesso messaggio e ce
 * l'ha sempre. Meglio ripescarlo che mostrare un punto interrogativo davanti
 * alla sala.
 */
function answerAvatar(answer, results) {
  if (answer.avatar) return answer.avatar;
  const entry = results.leaderboard?.find((p) => p.id === answer.playerId);
  return entry?.avatar ?? null;
}

/**
 * Fa volare un avatar dal palco in basso fino al vassoio della risposta scelta.
 * Il volo avviene su un elemento `position: fixed` staccato dal flusso, così non
 * sposta nulla mentre è in aria; all'atterraggio viene sostituito da una pedina
 * fissa dentro la card.
 */
function flyAvatarToOption(answer, avatarId) {
  const card = optionCardAt(answer.optionIndex);
  if (!card) return;
  const tray = card.querySelector('.sala-option-tray');
  if (!tray) return;

  // Pedina definitiva, inserita subito ma invisibile: così il vassoio ha già la
  // sua dimensione finale e la destinazione del volo non si sposta a metà strada.
  const seat = document.createElement('span');
  seat.className = 'sala-option-seat is-incoming';
  seat.textContent = avatarOf(avatarId);
  seat.title = answer.nickname ?? '';
  tray.appendChild(seat);

  const from = els.paradeAvatar.getBoundingClientRect();
  const to = seat.getBoundingClientRect();
  if (from.width === 0 || to.width === 0) { seat.classList.remove('is-incoming'); return; }

  const flyer = document.createElement('span');
  flyer.className = 'sala-flying-avatar';
  flyer.textContent = avatarOf(avatarId);
  flyer.style.left = `${from.left}px`;
  flyer.style.top = `${from.top}px`;
  flyer.style.width = `${from.width}px`;
  flyer.style.height = `${from.height}px`;
  document.body.appendChild(flyer);

  const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
  const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
  const scale = to.width / from.width;

  const anim = flyer.animate(
    [
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      // Passaggio intermedio più in alto: un arco, non una linea dritta.
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 70}px) scale(${(1 + scale) / 2})`, opacity: 1, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 1 },
    ],
    { duration: PARADE_FLIGHT_MS, easing: 'cubic-bezier(0.35, 0, 0.2, 1)', fill: 'forwards' },
  );
  sceneAnimations.push(anim);
  const land = () => {
    flyer.remove();
    seat.classList.remove('is-incoming');
  };
  anim.addEventListener('finish', land);
  // Rete di sicurezza: se la pagina non sta componendo fotogrammi (proiettore in
  // standby, scheda in background) l'animazione non arriva mai a `finish` e
  // l'avatar resterebbe appeso a mezz'aria per sempre. Il posto va occupato
  // comunque: la scena deve restare corretta anche senza animazione.
  sceneWait(land, PARADE_FLIGHT_MS + 250);
}

/** Atto 1: i giocatori sfilano e si posano sulle risposte. */
function runParade(results, token, onDone) {
  const answers = results.answers.filter((a) => Number.isInteger(a.optionIndex));
  const missing = results.leaderboard.length - answers.length;

  els.noAnswer.hidden = missing <= 0;
  if (missing > 0) {
    els.noAnswer.textContent = missing === 1
      ? '1 giocatore non ha risposto'
      : `${missing} giocatori non hanno risposto`;
  }

  if (answers.length === 0) { onDone(); return; }

  const step = Math.min(
    PARADE_MAX_STEP,
    Math.max(PARADE_MIN_STEP, Math.round(PARADE_TOTAL_MS / answers.length)),
  );

  els.parade.hidden = false;

  answers.forEach((answer, i) => {
    const avatarId = answerAvatar(answer, results);
    sceneWait(() => {
      if (AudioLogic.isStale(token, phaseToken)) return;
      els.paradeAvatar.textContent = avatarOf(avatarId);
      els.paradeName.textContent = answer.nickname ?? '';
      // Riavvia le due animazioni (entrata della card, dissolvenza del nome).
      els.paradeCard.classList.remove('is-running');
      void els.paradeCard.offsetWidth;
      els.paradeCard.classList.add('is-running');
      SalaAudio.sfx('avatar-call');
      // L'avatar parte quando il nome è ormai sfumato.
      sceneWait(() => {
        if (AudioLogic.isStale(token, phaseToken)) return;
        flyAvatarToOption(answer, avatarId);
        // Il tonfo dell'atterraggio arriva a fine volo, non alla partenza.
        sceneWait(() => {
          if (AudioLogic.isStale(token, phaseToken)) return;
          SalaAudio.sfx('avatar-land');
        }, PARADE_FLIGHT_MS - 60);
      }, Math.min(260, step * 0.6));
    }, i * step);
  });

  sceneWait(() => {
    if (AudioLogic.isStale(token, phaseToken)) return;
    els.parade.hidden = true;
    onDone();
  }, answers.length * step + PARADE_FLIGHT_MS + 150);
}

/** Atto 2: si spegne ciò che non è la risposta giusta (o si evidenzia la mossa del PC). */
function runVerdict(results, token, onDone) {
  const isMinigame = results.kind === 'minigame';
  const highlight = isMinigame
    ? currentMinigame?.highlightIndex(results)
    : results.correctIndex;

  const cards = [...els.options.children];
  const STAMP_STEP = 260;

  // Prima cadono le sbagliate, una alla volta. Nei minigiochi non ne esistono:
  // non c'è una risposta giusta, solo la mossa del computer.
  let stamped = 0;
  if (!isMinigame) {
    cards.forEach((card, i) => {
      if (i === highlight) return;
      const order = stamped++;
      sceneWait(() => {
        if (AudioLogic.isStale(token, phaseToken)) return;
        card.classList.add('is-out');
        const x = document.createElement('span');
        x.className = 'sala-option-x';
        x.setAttribute('aria-hidden', 'true');
        x.textContent = '✕';
        card.appendChild(x);
        SalaAudio.sfx('stamp-wrong');
      }, STAMP_STEP * order);
    });
  }

  // Solo quando il campo è sgombro si accende la risposta giusta, con la sua
  // fanfara. Farla suonare insieme al primo timbro sprecava entrambe le cose.
  const rightAt = stamped * STAMP_STEP + 260;
  sceneWait(() => {
    if (AudioLogic.isStale(token, phaseToken)) return;
    cards[highlight]?.classList.add('is-right');
    SalaAudio.sfx('reveal');
  }, rightAt);

  sceneWait(onDone, rightAt + 2400);
}

/** Sequenza completa: parata → verdetto → classifica. */
function runResultsScene(results, token) {
  // "Scegli l'opzione corretta prima che scada il tempo" non ha più senso: il
  // tempo è scaduto. La domanda resta, l'istruzione no.
  els.questionHint.hidden = true;
  runParade(results, token, () => {
    if (AudioLogic.isStale(token, phaseToken)) return;
    runVerdict(results, token, () => {
      if (AudioLogic.isStale(token, phaseToken)) return;
      renderResults(results, token);
    });
  });
}

// ─── Classifica animata ──────────────────────────────────────────────────────
//
// La classifica non compare già fatta: si costruisce sotto gli occhi della sala,
// in tre tempi.
//
//   1. Le righe appaiono con i punteggi di PRIMA della domanda, e accanto a
//      ciascuna spunta il "+X" appena guadagnato.
//   2. Il +X viene assorbito: le cifre del totale scorrono come un contachilometri
//      fino al nuovo punteggio.
//   3. Se qualcuno ha scavalcato qualcun altro, le righe si scambiano di posto
//      scorrendo — il sorpasso si deve VEDERE, è il momento più interessante.
//
// Il "prima" non arriva dal server: si ricava sottraendo i punti del round al
// punteggio finale. `results` porta già entrambi.

const RANK_MEDALS = ['🥇', '🥈', '🥉'];
const STANDINGS_ROWS = 5;
const DELTA_IN_MS   = 260;
const COUNT_MS      = 1300;
const REORDER_MS    = 780;

/**
 * Ricostruisce lo stato prima/dopo di ogni giocatore in classifica.
 * @returns {{ rows: Array, prevOrder: string[], nextOrder: string[] }}
 */
function buildStandingsModel(results) {
  const deltaById = new Map(
    (results.answers ?? []).map((a) => [a.playerId, a.pointsAwarded ?? 0]),
  );

  const rows = (results.leaderboard ?? []).map((p) => {
    const delta = deltaById.get(p.id) ?? 0;
    return {
      id: p.id,
      nickname: p.nickname,
      avatar: p.avatar,
      score: p.score,
      delta,
      prevScore: p.score - delta,
    };
  });

  // `leaderboard` è già ordinata per punteggio finale. Riordinandola per
  // punteggio precedente con un sort stabile, chi era a pari merito conserva
  // l'ordine relativo che aveva: nessun sorpasso inventato.
  const nextOrder = rows.map((r) => r.id);
  const prevOrder = rows
    .slice()
    .sort((a, b) => b.prevScore - a.prevScore)
    .map((r) => r.id);

  return { rows, prevOrder, nextOrder };
}

/** Riga della classifica. Il punteggio è un contachilometri a cifre. */
function buildStandingsRow(row) {
  const li = document.createElement('li');
  li.className = 'sala-rank-row';
  li.dataset.id = row.id;

  const badge = document.createElement('span');
  badge.className = 'sala-rank-badge';

  const avatar = document.createElement('span');
  avatar.className = 'sala-rank-avatar';
  avatar.textContent = avatarOf(row.avatar);

  const name = document.createElement('span');
  name.className = 'sala-rank-name';
  name.textContent = row.nickname ?? '—';

  const delta = document.createElement('span');
  delta.className = 'sala-rank-delta';
  delta.textContent = `+${row.delta}`;

  const score = document.createElement('span');
  score.className = 'sala-rank-score';

  li.append(badge, avatar, name, delta, score);
  return li;
}

/**
 * Medaglia per i primi tre, numero per gli altri — come su un podio vero.
 * La classe `is-rank-N` porta con sé il colore del metallo: assegnandola qui,
 * quando le righe si riordinano l'oro passa da solo a chi ha appena sorpassato.
 */
function setRankBadge(li, rank) {
  const badge = li.querySelector('.sala-rank-badge');
  badge.textContent = RANK_MEDALS[rank - 1] ?? String(rank);
  badge.classList.toggle('is-medal', rank <= RANK_MEDALS.length);

  li.classList.remove('is-rank-1', 'is-rank-2', 'is-rank-3');
  if (rank <= RANK_MEDALS.length) li.classList.add(`is-rank-${rank}`);
}

/**
 * Contachilometri: ogni cifra è una colonna che scorre in verticale fino al suo
 * valore finale. Le cifre basse girano veloci (un rullo sfocato), quelle alte
 * cambiano piano: è il comportamento di un contatore vero, e rende leggibile la
 * crescita anche da lontano.
 *
 * @param {HTMLElement} el contenitore del punteggio
 * @param {number} from punteggio di partenza
 * @param {number} to punteggio di arrivo
 */
function renderOdometer(el, from, to) {
  el.innerHTML = '';
  const digits = String(Math.max(to, 0)).length;
  const columns = [];

  for (let i = digits - 1; i >= 0; i--) {
    const unit = 10 ** i;
    const startDigit = Math.floor(from / unit) % 10;
    const endDigit = Math.floor(to / unit) % 10;
    // Passi effettivi di questa cifra, limitati: oltre una trentina di giri
    // l'occhio vede comunque solo una sfocatura, e la striscia resterebbe enorme.
    const raw = Math.floor(to / unit) - Math.floor(from / unit);
    const k = (endDigit - startDigit + 10) % 10;
    const steps = k + 10 * Math.floor(Math.min(Math.max(raw, 0), 30) / 10);

    const col = document.createElement('span');
    col.className = 'sala-odo-col';
    const strip = document.createElement('span');
    strip.className = 'sala-odo-strip';
    for (let s = 0; s <= steps; s++) {
      const d = document.createElement('span');
      d.className = 'sala-odo-digit';
      d.textContent = String((startDigit + s) % 10);
      strip.appendChild(d);
    }
    col.appendChild(strip);
    el.appendChild(col);
    columns.push({ strip, steps });
  }
  return columns;
}

/** Avvia lo scorrimento delle colonne già costruite da `renderOdometer`. */
function rollOdometer(columns, durationMs) {
  for (const { strip, steps } of columns) {
    if (steps === 0) continue;
    const anim = strip.animate(
      [{ transform: 'translateY(0)' }, { transform: `translateY(-${steps * 100}%)` }],
      { duration: durationMs, easing: 'cubic-bezier(0.16, 0.8, 0.28, 1)', fill: 'forwards' },
    );
    sceneAnimations.push(anim);
  }
}

/**
 * Sostituisce il contachilometri col numero finale, semplice.
 *
 * Non è solo pulizia: se la pagina non sta componendo fotogrammi (proiettore in
 * standby, scheda in background) le strisce non scorrono mai e resterebbero
 * ferme sulla cifra di partenza — la sala vedrebbe per sempre il punteggio
 * VECCHIO. Il numero giusto non può dipendere da un'animazione.
 */
function settleOdometer(el, finalScore) {
  el.textContent = String(finalScore);
}

/**
 * Riordina le righe animando lo spostamento (tecnica FLIP): si misura dov'erano,
 * si cambia l'ordine nel DOM, si misura dove sono finite e si riproduce il
 * tragitto all'indietro. È così che il sorpasso si vede invece di accadere e basta.
 */
function reorderWithFlip(listEl, orderedIds, durationMs) {
  const rows = new Map([...listEl.children].map((li) => [li.dataset.id, li]));

  const before = new Map();
  for (const [id, li] of rows) before.set(id, li.getBoundingClientRect().top);

  for (const id of orderedIds) {
    const li = rows.get(id);
    if (li) listEl.appendChild(li);
  }

  for (const [id, li] of rows) {
    const dy = before.get(id) - li.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    li.classList.add('is-moving');
    const anim = li.animate(
      [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
      { duration: durationMs, easing: 'cubic-bezier(0.22, 1, 0.3, 1)' },
    );
    sceneAnimations.push(anim);
    anim.addEventListener('finish', () => li.classList.remove('is-moving'));
    sceneWait(() => li.classList.remove('is-moving'), durationMs + 120);
  }
}

/** Sequenza completa della classifica. */
function renderStandings(results, token) {
  const { rows, prevOrder, nextOrder } = buildStandingsModel(results);
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Si mostrano le righe che erano nei primi posti PRIMA e quelle che ci sono
  // DOPO: senza le prime, chi viene scavalcato uscirebbe di scena senza che si
  // capisca da chi.
  const visible = new Set([
    ...nextOrder.slice(0, STANDINGS_ROWS),
    ...prevOrder.slice(0, STANDINGS_ROWS),
  ]);
  const startOrder = prevOrder.filter((id) => visible.has(id));
  const endOrder = nextOrder.filter((id) => visible.has(id));

  els.standings.innerHTML = '';
  const odometers = new Map();
  startOrder.forEach((id, i) => {
    const row = byId.get(id);
    const li = buildStandingsRow(row);
    setRankBadge(li, i + 1);
    li.classList.toggle('has-delta', row.delta > 0);
    els.standings.appendChild(li);
    odometers.set(id, renderOdometer(li.querySelector('.sala-rank-score'), row.prevScore, row.score));
  });

  // 1. I "+X" spuntano accanto ai punteggi ancora vecchi.
  sceneWait(() => {
    if (AudioLogic.isStale(token, phaseToken)) return;
    els.standings.classList.add('show-delta');
  }, DELTA_IN_MS);

  // 2. Il +X viene assorbito e le cifre scorrono.
  const countAt = DELTA_IN_MS + 620;
  sceneWait(() => {
    if (AudioLogic.isStale(token, phaseToken)) return;
    els.standings.classList.add('counting');
    for (const cols of odometers.values()) rollOdometer(cols, COUNT_MS);
    SalaAudio.sfx('score-count');
  }, countAt);

  // 2b. Conteggio finito: si fissa il numero definitivo e il totale torna nero.
  const settleAt = countAt + COUNT_MS;
  sceneWait(() => {
    if (AudioLogic.isStale(token, phaseToken)) return;
    els.standings.classList.remove('counting');
    for (const [id, cols] of odometers) {
      void cols;
      const li = els.standings.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (li) settleOdometer(li.querySelector('.sala-rank-score'), byId.get(id).score);
    }
  }, settleAt);

  // 3. Il riordino, con i sorpassi.
  const reorderAt = countAt + COUNT_MS + 120;
  sceneWait(() => {
    if (AudioLogic.isStale(token, phaseToken)) return;
    const changed = startOrder.some((id, i) => endOrder[i] !== id);
    reorderWithFlip(els.standings, endOrder, REORDER_MS);
    endOrder.forEach((id, i) => {
      const li = els.standings.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (li) setRankBadge(li, i + 1);
    });
    if (changed) SalaAudio.sfx('overtake');
  }, reorderAt);

  // 4. Chi è uscito dai primi posti lascia la scena, a sorpasso concluso.
  sceneWait(() => {
    if (AudioLogic.isStale(token, phaseToken)) return;
    const keep = new Set(nextOrder.slice(0, STANDINGS_ROWS));
    for (const li of [...els.standings.children]) {
      if (!keep.has(li.dataset.id)) li.classList.add('is-dropped');
    }
  }, reorderAt + REORDER_MS + 200);
}

// ─── Risultati ───────────────────────────────────────────────────────────────

function renderResults(results, token) {
  const isMinigame = results.kind === 'minigame';

  if (isMinigame && currentMinigame) {
    currentMinigame.sala.reveal(minigameEls(), results, currentOptions);
  } else {
    els.reveal.textContent =
      `Risposta corretta: ${currentOptions[results.correctIndex] ?? '—'}`;
  }

  // Nessun effetto al cambio pannello: il momento del reveal è già passato,
  // sulle opzioni, quando la risposta giusta si è accesa.
  showPanel('results');
  renderStandings(results, token);
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
 * Il round è chiuso, ma le quattro opzioni restano a schermo: è su di esse che
 * si racconta l'esito, con la scena in due atti descritta più sopra
 * (parata degli avatar → verdetto → classifica).
 *
 * Prima della scena c'è la finestra di sospensione, in due forme:
 *  - Domanda normale: breve rullo di tamburi fisso (`AudioLogic.SUSPENSE_MS`).
 *  - Minigioco con `revealAt`: il reveal temporizzato del minigioco stesso
 *    (`sala.playReveal`, es. la ruota che rallenta della Morra Cinese),
 *    sincronizzato coi telefoni sullo stesso timestamp assoluto — così la
 *    mossa del computer si scopre prima di vedere chi aveva puntato su cosa.
 */
socket.on('game:results', (results) => {
  const token = newPhase();
  stopCountdown();
  SalaAudio.sfx('suspense');

  const startScene = () => {
    // Se nel frattempo è arrivata un'altra fase, questa scena è vecchia.
    if (AudioLogic.isStale(token, phaseToken)) return;
    runResultsScene(results, token);
  };

  if (results.revealAt && currentMinigame?.sala.playReveal) {
    currentMinigame.sala.playReveal(minigameEls(), results, currentOptions, {
      revealAt: results.revealAt,
      isStale: () => AudioLogic.isStale(token, phaseToken),
      done: startScene,
    });
  } else {
    suspenseTimer = setTimeout(() => {
      suspenseTimer = null;
      startScene();
    }, AudioLogic.SUSPENSE_MS);
  }
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
