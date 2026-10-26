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

/* global io, qrcode, Minigames, AudioLogic, SalaAudio, FinalSchedule, ServerClock */

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

  parade:       document.getElementById('sala-parade'),
  paradeCard:   document.getElementById('sala-parade-card'),
  paradeAvatar: document.getElementById('sala-parade-avatar'),
  paradeName:   document.getElementById('sala-parade-name'),
  noAnswer:     document.getElementById('sala-no-answer'),

  reveal:       document.getElementById('sala-reveal'),
  standings:    document.getElementById('sala-standings'),
  standingsBox: document.getElementById('sala-standings-box'),
  sealed:       document.getElementById('sala-sealed'),

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
// Attesa della fine dell'anteprima di un minigioco: il cronometro della
// risposta parte solo quando si può rispondere davvero.
let previewTimer    = null;
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

/** Il proiettore non lo chiede quasi mai, ma un desktop di sviluppo può. */
function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Quanto dura, al massimo, l'ingresso scaglionato di un pannello: la posa più
 * lunga di motion.css più il suo ritardo, con un margine. Serve solo a togliere
 * la classe quando ha finito — un valore un po' generoso non fa danno, un
 * valore corto taglierebbe l'animazione a metà.
 */
const PANEL_ENTER_MS = 1200;
let panelEnterTimer = null;

/**
 * Fa entrare in scena un pannello. Il movimento vero sta in motion.css, sotto
 * `.is-entering`: qui c'è solo l'interruttore.
 *
 * Il giro remove → lettura di offsetWidth → add non è superstizione: riattaccare
 * una classe nello stesso fotogramma in cui la si toglie non fa ripartire
 * nessuna animazione, perché il browser vede un solo stato finale. La lettura
 * forza un ricalcolo in mezzo, e l'animazione riparte davvero. Senza, un
 * pannello mostrato due volte di fila (succede a ogni `game:snapshot`) entra
 * una volta sola.
 */
function enterPanel(el) {
  if (panelEnterTimer) clearTimeout(panelEnterTimer);
  for (const p of Object.values(els.panels)) p.classList.remove('is-entering');
  void el.offsetWidth;
  el.classList.add('is-entering');
  panelEnterTimer = setTimeout(() => {
    el.classList.remove('is-entering');
    panelEnterTimer = null;
  }, PANEL_ENTER_MS);
}

/** Mostra un solo pannello alla volta. */
function showPanel(name) {
  for (const [key, el] of Object.entries(els.panels)) {
    const show = key === name;
    // Chi era già a schermo non rientra: `showPanel` viene richiamata anche
    // per aggiornare un pannello che sta già mostrando (il riallineamento da
    // `game:snapshot`), e rifare l'ingresso lì sembrerebbe un glitch.
    const entering = show && el.hidden;
    el.hidden = !show;
    if (entering) enterPanel(el);
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
  // I coriandoli della premiazione sopravvivrebbero al cambio di schermata:
  // durante una serata l'host può far ripartire la partita da qualunque punto.
  window.Confetti?.stop();
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
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  els.timer.classList.remove('is-urgent');
  document.body.classList.remove('is-urgent');
  if (reset) els.timer.textContent = '--:--';
  // Fuori dalla domanda il cronometro esce di scena invece di mostrare
  // "--:--": un quadrante spento in un angolo del proiettore è rumore.
  els.timer.classList.toggle('is-idle', reset);
}

/**
 * Il colpo del countdown a ogni secondo. Lo chiama solo il tick che ha visto
 * cambiare DAVVERO la cifra: l'intervallo gira a 250ms, e un colpo quattro
 * volte al secondo non sarebbe un battito ma un tremolio.
 */
function pulseTimer() {
  els.timer.classList.remove('is-tick');
  void els.timer.offsetWidth;
  els.timer.classList.add('is-tick');
}

/**
 * Countdown calcolato localmente da un timestamp assoluto: la latenza di rete
 * non desincronizza la sala dall'host e dai telefoni.
 */
function startCountdown(endsAt, serverNow, limitS) {
  stopCountdown();
  els.timer.classList.remove('is-idle');
  const deadline = ServerClock.localDeadline(endsAt, serverNow);
  // Il pieno dell'anello è la durata della domanda: così chi si ricollega a
  // metà round (il Pi riavviato) vede l'anello già consumato in proporzione,
  // non un anello pieno su un tempo quasi scaduto. Senza durata nota, si
  // parte da quel che resta.
  const totalMs = Math.max(1, Number.isFinite(limitS) && limitS > 0
    ? limitS * 1000
    : ServerClock.remainingMs(deadline));
  const tick = () => {
    const leftMs = ServerClock.remainingMs(deadline);
    const remaining = Math.ceil(leftMs / 1000);
    const m = String(Math.floor(remaining / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    const urgent = remaining > 0 && remaining <= 10;
    // Sotto il minuto bastano i secondi: "21" si legge da in fondo alla sala,
    // "00:21" costringe a cercare la cifra che conta.
    const text = remaining >= 60 ? `${m}:${s}` : String(remaining);
    els.timer.style.setProperty('--frac', String(Math.max(0, Math.min(1, leftMs / totalMs))));
    els.timer.classList.toggle('is-long', remaining >= 60);
    if (els.timer.textContent !== text) {
      els.timer.textContent = text;
      // Negli ultimi dieci secondi il colpo si tace: il badge sta già
      // battendo da solo (`.is-urgent`), e le due animazioni si contendono
      // la stessa `transform` — il battito si interromperebbe ogni secondo
      // per far passare il colpo, che è il contrario dell'effetto voluto.
      if (!urgent) pulseTimer();
    }
    els.timer.classList.toggle('is-urgent', urgent);
    // Anche i bordi dello schermo si accendono: in sala il badge da solo è
    // un dettaglio in un angolo, e chi guarda la domanda non lo vede.
    document.body.classList.toggle('is-urgent', urgent);
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

/**
 * Chi era già in lobby all'aggiornamento precedente. Serve a distinguere
 * l'arrivo di una persona dal semplice ridisegno della lista.
 */
let shownPlayerKeys = new Set();

/**
 * Identità di un giocatore ai fini del disegno. L'id è quello buono; il
 * nickname è il ripiego per un payload che non lo portasse, e sbaglia solo nel
 * caso in cui due persone scelgano lo stesso nome — dove l'unica conseguenza è
 * un pop mancato.
 */
const playerKey = (p) => String(p.id ?? p.nickname ?? '');

function renderLobby(players) {
  els.lobbyEmpty.hidden = players.length > 0;
  // Il QR smette di pulsare appena c'è qualcuno: da lì in poi l'attenzione
  // deve andare ai nomi che compaiono, non più al codice da inquadrare.
  els.panels.lobby.classList.toggle('has-players', players.length > 0);

  // `renderLobby` ridisegna tutta la lista a ogni aggiornamento, quindi senza
  // questo confronto l'animazione d'ingresso ripartirebbe su TUTTI i chip a
  // ogni arrivo: al ventesimo giocatore sarebbe un muro che sfarfalla, e venti
  // elementi da comporre nello stesso fotogramma su un Raspberry. Si anima solo
  // chi è arrivato davvero; chi c'era già resta fermo, ed è proprio questo che
  // rende leggibile l'arrivo.
  const seen = new Set();
  let arrivals = 0;

  els.players.innerHTML = '';
  for (const p of players) {
    const key = playerKey(p);
    seen.add(key);
    const isNew = !shownPlayerKeys.has(key);
    if (isNew) arrivals++;

    const li = document.createElement('li');
    li.className = 'sala-player-chip'
      + (p.connected === false ? ' is-disconnected' : '')
      + (isNew ? ' is-new' : '');
    const av = document.createElement('span');
    av.className = 'avatar';
    av.textContent = avatarOf(p.avatar);
    const name = document.createElement('span');
    name.textContent = p.nickname;
    li.append(av, name);
    els.players.appendChild(li);
  }
  shownPlayerKeys = seen;

  // Il contatore scatta solo quando il numero sale per un arrivo vero: una
  // disconnessione lo fa scendere, e festeggiare chi se ne va è fuori luogo.
  els.playerCount.textContent = players.length;
  if (arrivals > 0) {
    els.playerCount.classList.remove('is-bumped');
    void els.playerCount.offsetWidth;
    els.playerCount.classList.add('is-bumped');
  }
}

// ─── Domanda ─────────────────────────────────────────────────────────────────

/**
 * Le due varianti della scheda domanda si escludono a vicenda: o la riga di
 * istruzione, o il riquadro immagine. Non convivono mai — con entrambe la
 * scheda sfonderebbe l'altezza dello schermo e le risposte uscirebbero dal
 * campo visivo, che su un proiettore significa perderle del tutto.
 *
 * A decidere è il VALORE di `round.image`: un oggetto `{ hash, blur }` attiva
 * il riquadro, `null` (o l'assenza del campo) la riga di istruzione. Il
 * riferimento arriva nel payload di `game:question`; i byte no — si scaricano
 * da `/api/quiz-image/<hash>`, che è cacheabile come immutable e quindi costa
 * un download solo per dispositivo per tutta la serata.
 *
 * L'immagine è mostrata SOLO qui: il telefono riceve il campo (sono ~90 byte,
 * non vale un emit per-room) ma non lo disegna. Vedi la spec
 * docs/superpowers/specs/2026-08-29-immagini-domande-design.md.
 *
 * @param {object | null} round payload del round, o null per la variante testo
 * @param {number} token fase corrente (da `newPhase()`), per scartare un
 *   `error` che arriva a round già cambiato — stesso idioma di `phaseToken` /
 *   `AudioLogic.isStale` usato altrove in questo file.
 */
function renderQuestionMedia(round, token) {
  const image = round?.image ?? null;
  const hasMedia = image !== null && typeof image === 'object' && typeof image.hash === 'string';

  els.questionHint.hidden  = hasMedia;
  els.questionMedia.hidden = !hasMedia;

  // Si riparte sempre dal riquadro pulito: l'immagine del round precedente non
  // deve comparire per un fotogramma sotto la domanda nuova, né la sua
  // sfocatura restare addosso a un'immagine che non la vuole.
  const existing = els.questionMedia.querySelector('img');
  if (existing) existing.remove();
  els.questionMedia.classList.remove('is-blurred');

  const icon = els.questionMedia.querySelector('.material-symbols-outlined');

  if (!hasMedia) {
    if (icon) icon.hidden = false;
    return;
  }

  els.questionMedia.classList.toggle('is-blurred', image.blur === true);

  const img = document.createElement('img');
  img.src = `/api/quiz-image/${image.hash}`;
  img.alt = '';
  img.decoding = 'async';
  // Se l'immagine non carica si torna al segnaposto invece di lasciare un
  // buco. Ma un `error` può arrivare dopo che la fase è già cambiata (round
  // successivo, o minigioco senza immagine): a quel punto questo <img> è già
  // stato rimosso dal riquadro pulito qui sopra, e l'`icon` che toccheremmo
  // non è più quella di questa domanda. Si scarta come qualunque reveal in
  // ritardo.
  img.addEventListener('error', () => {
    if (AudioLogic.isStale(token, phaseToken)) return;
    img.remove();
    if (icon) icon.hidden = false;
  });
  if (icon) icon.hidden = true;
  els.questionMedia.appendChild(img);
}

function renderQuestion(q) {
  const token = newPhase();
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
  // `answersOpenAt` è la fine dell'anteprima (es. i bicchieri che si
  // mescolano prima della scelta), già riportata sull'orologio locale.
  const answersOpenAt = q.answersOpenAt
    ? ServerClock.localDeadline(q.answersOpenAt, q.serverNow)
    : Date.now();
  if (isMinigame) {
    currentMinigame.sala.startSuspense(minigameEls(), q, {
      answersOpenAt,
      isStale: () => AudioLogic.isStale(token, phaseToken),
    });
  } else {
    els.questionText.textContent = q.text;
  }

  // Un minigioco non ha immagine: la sua scena la disegna la presentazione.
  renderQuestionMedia(isMinigame ? null : q, token);

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

  renderProgress(q.index, q.total);
  const previewLeftMs = ServerClock.remainingMs(answersOpenAt);
  if (previewLeftMs > 0) {
    // Durante l'anteprima non si risponde: un cronometro che scende già
    // direbbe alla sala che il tempo sta passando, e non è vero.
    stopCountdown();
    const receivedAt = Date.now();
    previewTimer = setTimeout(() => {
      previewTimer = null;
      if (AudioLogic.isStale(token, phaseToken)) return;
      // `localDeadline` misura lo scarto fra orologi nell'istante in cui la si
      // chiama: chiamata qui, a ricezione + anteprima, sposterebbe la scadenza
      // di tutta l'anteprima. Il `serverNow` va quindi fatto avanzare di quanto
      // è passato da quando il messaggio è arrivato.
      startCountdown(q.endsAt, q.serverNow + (Date.now() - receivedAt), q.time_limit_s);
    }, previewLeftMs);
  } else {
    startCountdown(q.endsAt, q.serverNow, q.time_limit_s);
  }
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

  // Oltre il tetto non si aggiungono pedine: si incrementa un contatore, e
  // l'avatar vola su quello. Con venti giocatori su una risposta sola le
  // pedine farebbero crescere la carta oltre il bordo dello schermo, e a
  // quella dimensione non si distinguono comunque una dall'altra.
  const seats = tray.querySelectorAll('.sala-option-seat').length;
  let seat;
  if (seats >= MAX_OPTION_SEATS) {
    seat = tray.querySelector('.sala-option-more');
    if (!seat) {
      seat = document.createElement('span');
      seat.className = 'sala-option-more';
      seat.dataset.extra = '0';
      tray.appendChild(seat);
    }
    const extra = Number(seat.dataset.extra) + 1;
    seat.dataset.extra = String(extra);
    seat.textContent = `+${extra}`;
  } else {
    // Pedina definitiva, inserita subito ma invisibile: così il vassoio ha già
    // la sua dimensione finale e la destinazione del volo non si sposta a metà
    // strada.
    seat = document.createElement('span');
    seat.className = 'sala-option-seat is-incoming';
    seat.textContent = avatarOf(avatarId);
    seat.title = answer.nickname ?? '';
    tray.appendChild(seat);
  }

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

/** Pedine mostrate su una risposta prima di passare al contatore "+N". */
const MAX_OPTION_SEATS = 12;

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
    // La percentuale di translateY è relativa alla STRISCIA, non a una cifra:
    // la striscia è alta `steps + 1` cifre, quindi per portare in finestra
    // l'ultima si scorre di `steps / (steps + 1)` della propria altezza.
    // Con `steps * 100%` volava fuori schermo e la finestra restava vuota fino
    // a `settleOdometer` — le cifre non si vedevano mai girare.
    const shift = (steps / (steps + 1)) * 100;
    const anim = strip.animate(
      [{ transform: 'translateY(0)' }, { transform: `translateY(-${shift}%)` }],
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

  // Dopo l'ultimo round la classifica non si mostra: la sala saprebbe chi ha
  // vinto un minuto prima della premiazione, e la cerimonia — la coda in
  // ritardando, il secondo posto tenuto coperto, la proclamazione — non
  // avrebbe più niente da svelare. Il reveal della risposta resta: quello si
  // può sapere, ed è la chiusura che l'ultima domanda merita.
  const sealed = Boolean(results.isLastRound);
  els.standingsBox.hidden = sealed;
  els.sealed.hidden = !sealed;
  if (sealed) {
    els.standings.innerHTML = '';   // niente righe del round prima, in attesa
    return;
  }

  renderStandings(results, token);
}

// ─── Classifica finale: la premiazione ───────────────────────────────────────
//
// Non una schermata ma una cerimonia in sette atti, dal fondo verso il podio.
// I tempi NON stanno qui: li detta `/shared/final-schedule.js`, lo stesso
// calendario che seguono i telefoni. È ciò che permette di proclamare il
// vincitore in sala e su ogni telefono nello stesso istante — vedi il commento
// in testa a quel file per il perché non si usa un timestamp assoluto.
//
// Qui c'è solo l'esecuzione: quale atto disegna cosa.

const SPARKLE_COUNT = 14;
const SPARKLE_GLYPHS = ['✦', '✧', '⭐'];

/** Quante righe della coda restano a schermo insieme, su un proiettore. */
const TAIL_VISIBLE_ROWS = 7;

/** Un gradino del podio, costruito completo e poi tenuto coperto. */
function buildPodiumStep(p, rank) {
  const step = document.createElement('div');
  step.className = `sala-podium-step rank-${rank} is-slot`;

  const medal = document.createElement('span');
  medal.className = 'medal';
  medal.textContent = RANK_MEDALS[rank - 1];

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

/**
 * Rimpicciolisce i nomi del podio finché stanno su una riga del loro gradino,
 * e poi porta TUTTI alla stessa scala.
 *
 * Si MISURA invece di stimare dalla lunghezza: quanto occupa un nome dipende
 * anche da quali lettere contiene e da quanto è grande il font a quella
 * risoluzione, e una soglia a occhio sbagliava proprio nei casi limite.
 *
 * La scala è comune perché il gradino d'oro parte più grande degli altri
 * (×1.15) e quindi tocca il limite per primo: fittandoli uno per uno, un nome
 * lungo lasciava il vincitore scritto più piccolo del secondo classificato.
 * Con una scala sola il primo resta il più grande, sempre.
 *
 * Va chiamata quando i gradini sono GIÀ nel documento: prima non hanno una
 * larghezza da misurare.
 */
function fitPodiumNames(container) {
  const names = [...container.querySelectorAll('.sala-podium-step .name')];
  let common = 1;

  for (const name of names) {
    if (!name.clientWidth) continue;
    let scale = 1;
    name.style.setProperty('--name-scale', '1');
    // Sotto una certa misura non si legge più da lontano: lì ci si ferma e
    // l'ellissi fa il resto.
    while (scale > 0.45 && name.scrollWidth > name.clientWidth) {
      scale -= 0.05;
      name.style.setProperty('--name-scale', scale.toFixed(2));
    }
    if (scale < common) common = scale;
  }

  for (const name of names) name.style.setProperty('--name-scale', common.toFixed(2));
}

/** Una riga della coda (dal 4° in giù). */
function buildTailRow(p) {
  const li = document.createElement('li');
  li.className = 'fc-enter';
  li.textContent = `${p.rank}. ${avatarOf(p.avatar)} ${p.nickname} — ${p.score} punti`;
  return li;
}

/**
 * Le stelline intorno al vincitore. Posizione e ritardo casuali: due
 * premiazioni non devono scintillare uguali.
 */
function addSparkles(step) {
  if (reducedMotion()) return;
  const layer = document.createElement('span');
  layer.className = 'fc-sparkles';
  layer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < SPARKLE_COUNT; i++) {
    const s = document.createElement('span');
    s.className = 'fc-sparkle';
    s.textContent = SPARKLE_GLYPHS[(Math.random() * SPARKLE_GLYPHS.length) | 0];
    s.style.setProperty('--fc-x', `${Math.random() * 100}%`);
    s.style.setProperty('--fc-y', `${Math.random() * 100}%`);
    s.style.setProperty('--fc-delay', `${Math.round(Math.random() * 700)}ms`);
    s.style.fontSize = `${1 + Math.random() * 1.4}rem`;
    layer.appendChild(s);
  }
  step.appendChild(layer);
}

/**
 * Durata dei movimenti condivisi, in millisecondi. Deve combaciare con
 * /shared/final-ceremony.css — serve solo come scadenza di sicurezza, vedi sotto.
 */
const MOTION_MS = { 'fc-pop': 620, 'fc-erupt': 900, 'fc-uncover': 520 };

/**
 * Il gradino esce dallo stato "pedana vuota" e si mostra, con la sua animazione.
 *
 * La classe di movimento si toglie a fine corsa: i keyframes finiscono con
 * `fill: both`, quindi resterebbero a `rotate(0)` e cancellerebbero la
 * rotazione da sticker che ogni gradino ha dalla sua regola .rank-N.
 *
 * Il "fine corsa" è sia l'evento sia una scadenza a tempo, e non per pignoleria:
 * se la pagina non sta componendo fotogrammi (proiettore in standby, scheda in
 * background) l'animazione non parte mai e `animationend` non arriva mai — il
 * gradino resterebbe per sempre a metà, e l'argento non riceverebbe mai il suo
 * respiro d'attesa. Stessa regola del contachilometri in `settleOdometer`:
 * quello che deve finire non può dipendere da un'animazione.
 *
 * @param {() => void} [onDone] eseguito quando l'animazione è finita.
 */
function revealStep(step, motionClass, onDone) {
  if (!step) return;
  step.classList.remove('is-slot');
  step.classList.add(motionClass);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    step.classList.remove(motionClass);
    onDone?.();
  };

  step.addEventListener('animationend', finish, { once: true });
  sceneWait(finish, (MOTION_MS[motionClass] ?? 620) + 120);
}

/**
 * Il fotogramma finale: il solo podio, assestato e vivo. Usato a cerimonia
 * conclusa, ma anche — senza passare dalla cerimonia — quando la sala si
 * riallinea da `game:snapshot` a premiazione già avvenuta, o quando il
 * dispositivo chiede movimento ridotto.
 */
function renderFinalFrame(leaderboard) {
  els.finalList.innerHTML = '';
  els.podium.innerHTML = '';
  for (const p of leaderboard.slice(0, 3)) {
    const step = buildPodiumStep(p, p.rank);
    step.classList.remove('is-slot');
    els.podium.appendChild(step);
  }
  fitPodiumNames(els.podium);
  els.podium.classList.add('is-settled');
}

/**
 * @param {Array} entries classifica. `game:final` la manda già ordinata e con
 *   `rank`; `game:snapshot` porta invece `getPlayers()`, che è grezzo — non
 *   ordinato e senza `rank`. Si normalizza qui una volta sola, così il podio è
 *   corretto da qualunque delle due strade arrivi.
 * @param {{ animate?: boolean }} [opts] `animate: false` salta la cerimonia e
 *   disegna direttamente il fotogramma finale.
 */
function renderFinal(entries, { animate = true } = {}) {
  const token = newPhase();
  stopCountdown();

  const leaderboard = entries
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  els.podium.innerHTML = '';
  els.podium.classList.remove('is-settled', 'is-hidden');
  els.finalList.innerHTML = '';
  showPanel('final');

  if (leaderboard.length === 0) return;

  // Il movimento ridotto va gestito QUI e non solo nel CSS: la cerimonia è
  // fatta di setTimeout, che nessuna media query può fermare. Senza questo
  // ramo la sala resterebbe davanti a uno schermo vuoto per quindici secondi.
  if (!animate || reducedMotion()) {
    renderFinalFrame(leaderboard);
    return;
  }

  runCeremony(leaderboard, token);
}

/** Esegue il calendario condiviso, un atto alla volta. */
function runCeremony(leaderboard, token) {
  const byRank = new Map(leaderboard.map((p) => [p.rank, p]));
  const schedule = FinalSchedule.buildFinalSchedule({ playerCount: leaderboard.length });

  // I gradini nascono tutti insieme come pedane vuote: così il podio ha già la
  // sua forma definitiva e il bronzo non salta dal centro a destra quando gli
  // altri due arrivano. Ciò che si alza, un atto alla volta, è il contenuto.
  const steps = new Map();
  for (const p of leaderboard.slice(0, 3)) {
    const step = buildPodiumStep(p, p.rank);
    steps.set(p.rank, step);
    els.podium.appendChild(step);
  }
  fitPodiumNames(els.podium);
  // Lo spazio è riservato da subito, la vista no: mostrare i piedistalli già
  // durante la coda toglierebbe all'ingresso del palco il suo momento.
  // Senza coda non c'è nessun ingresso da preparare, e il podio parte visibile.
  const conCoda = schedule.steps.some((b) => b.kind === 'tail');
  els.podium.classList.toggle('is-hidden', conCoda);

  for (const beat of schedule.steps) {
    sceneWait(() => {
      if (AudioLogic.isStale(token, phaseToken)) return;
      playBeat(beat, byRank, steps);
    }, beat.at);
  }
}

/** Cosa disegna ciascun atto. Un solo posto in cui guardare. */
function playBeat(beat, byRank, steps) {
  switch (beat.kind) {
    // ── La coda, dall'ultimo verso il podio ──
    case 'tail': {
      const p = byRank.get(beat.rank);
      if (p) els.finalList.prepend(buildTailRow(p));
      // Finestra scorrevole: con venticinque giocatori le prime posizioni
      // scoperte escono dal fondo mentre arrivano le nuove. A metà coda nessuno
      // sta più guardando il venticinquesimo, e su un proiettore lo spazio
      // verticale finisce molto prima dei nomi.
      // Chi sta già uscendo non conta: altrimenti a ogni riga nuova si
      // rimarcherebbe lo stesso nodo, ancora a schermo perché in animazione.
      const staying = [...els.finalList.children].filter((li) => !li.classList.contains('fc-exit'));
      for (const li of staying.slice(TAIL_VISIBLE_ROWS)) {
        li.classList.add('fc-exit');
        sceneWait(() => li.remove(), FinalSchedule.TAIL_EXIT_MS);
      }
      SalaAudio.sfx('avatar-land');
      break;
    }

    // ── Le righe già viste lasciano il palco ──
    case 'tail-exit':
      for (const li of els.finalList.children) li.classList.add('fc-exit');
      sceneWait(() => {
        els.finalList.innerHTML = '';
        els.podium.classList.remove('is-hidden');
      }, FinalSchedule.TAIL_EXIT_MS);
      break;

    // ── Il bronzo, rivelato per intero ──
    case 'podium-3':
      revealStep(steps.get(3), 'fc-pop');
      SalaAudio.sfx('reveal');
      break;

    // ── L'argento: in scena, ma senza nome ──
    case 'podium-2-covered': {
      const step = steps.get(2);
      // `fc-covered` subito (è la copertura, non un movimento), ma il respiro
      // dell'attesa solo a salita finita: `fc-waiting` anima anch'esso il
      // transform e vincerebbe sul pop, facendo comparire il gradino di colpo.
      step?.classList.add('fc-covered');
      revealStep(step, 'fc-pop', () => step.classList.add('fc-waiting'));
      SalaAudio.sfx('avatar-land');
      break;
    }

    // ── Il vuoto prima della proclamazione ──
    case 'suspense':
      SalaAudio.sfx('suspense');
      break;

    // ── La proclamazione ──
    case 'winner': {
      const step = steps.get(1);
      revealStep(step, 'fc-erupt');
      if (step) addSparkles(step);
      window.Confetti?.burst({ count: 140, power: 19 });
      SalaAudio.sfx('winner');
      break;
    }

    // ── E solo ORA si scopre il secondo ──
    case 'uncover-2': {
      const step = steps.get(2);
      step?.classList.remove('fc-covered', 'fc-waiting');
      revealStep(step, 'fc-uncover');
      SalaAudio.sfx('reveal');
      break;
    }

    // ── Il fotogramma finale: resta il podio, e resta vivo ──
    case 'settle':
      els.podium.classList.add('is-settled');
      break;
  }
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
    // Senza cerimonia: se il Raspberry si riavvia a premiazione conclusa, la
    // sala deve ritrovare il podio subito, non rigiocare quindici secondi di
    // proclamazione già avvenuta davanti a gente che sta uscendo.
    renderFinal(snap.players ?? [], { animate: false });
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
      revealAt: ServerClock.localDeadline(results.revealAt, results.serverNow),
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
