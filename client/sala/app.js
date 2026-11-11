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

/* global io, qrcode, Minigames, AudioLogic, SalaAudio, FinalSchedule, ServerClock, AvatarSprite, AvatarCatalog, PodiumCeremony */

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
    ended:    document.getElementById('sala-ended'),
  },

  idleText:     document.getElementById('sala-idle-text'),
  guideIdle:    document.getElementById('sala-guide-idle'),
  guideLobby:   document.getElementById('sala-guide-lobby'),

  qr:           document.getElementById('sala-qr'),
  joinUrl:      document.getElementById('sala-join-url'),
  playerCount:  document.getElementById('sala-player-count'),
  players:      document.getElementById('sala-players'),
  lobbyEmpty:   document.getElementById('sala-lobby-empty'),

  questionWrap: document.querySelector('#sala-question .q-card-wrap'),
  questionCard: document.querySelector('#sala-question .q-card'),
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

  roster:       document.getElementById('sala-roster'),
  rosterCount:  document.getElementById('sala-roster-count'),
  rosterSeats:  document.getElementById('sala-roster-seats'),

  reveal:       document.getElementById('sala-reveal'),
  standings:    document.getElementById('sala-standings'),
  standingsBox: document.getElementById('sala-standings-box'),
  sealed:       document.getElementById('sala-sealed'),

  podium:       document.getElementById('sala-podium'),
  finalList:    document.getElementById('sala-final-list'),

  startLayer:   document.getElementById('sala-start-layer'),
  startNum:     document.getElementById('sala-start-num'),
  introLayer:   document.getElementById('sala-intro-layer'),
  podiumLayer:  document.getElementById('sala-podium-layer'),
};

// Elementi che la presentazione di un minigioco può disegnare. Stessi nomi del
// contratto in /shared/minigames/, così un modulo non sa su quale SPA gira.
const minigameEls = () => ({
  questionText:  els.questionText,
  correctAnswer: els.reveal,
});

// ─── Stato ───────────────────────────────────────────────────────────────────

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

// L'avatar è il personaggio (colore + espressione): lo disegna AvatarSprite.fill,
// in ogni punto in cui prima c'era un'emoji.

let currentOptions  = [];
let currentMinigame = null;
// Il round in onda: gli eventi che arrivano a round già cambiato (es. un
// gruppo completato un attimo prima di un salto dell'host) si scartano.
let currentRoundIndex = null;
let countdownTimer  = null;
// Conto alla rovescia d'apertura ("3, 2, 1"): il giro che lo aggiorna e
// l'attesa che toglie il "VIA!" dallo schermo.
let startTimer      = null;
let startGoTimer    = null;
let lastPlayerCount = 0;
// I giocatori della partita come li manda il server (lobby e snapshot): la
// colonna dei minigiochi con `salaPlayers` ne fa i posti.
let currentPlayers  = [];
// Chi ha già scelto nel round della colonna (id, da `game:answer-count`), e se
// quel round è ancora aperto: chiuso, la colonna passa alla scena degli esiti.
let rosterAnswered  = [];
let rosterLive      = false;
let lastRosterSfxAt = 0;
let suspenseTimer   = null;
// Attesa della fine dell'anteprima di un minigioco: il cronometro della
// risposta parte solo quando si può rispondere davvero.
let previewTimer    = null;
// Montaggio della scena del minigioco sotto le tende chiuse del sipario.
let introTimer      = null;
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
  if (introTimer) {
    clearTimeout(introTimer);
    introTimer = null;
  }
  stopStartCountdown();
  MinigameStageIntro.stopAll();
  stopPodium3D();
  currentMinigame?.sala.stopSuspense();
  stopScene();
  return phaseToken;
}

// ─── Sipario dei minigiochi ──────────────────────────────────────────────────
//
// Ogni minigioco si apre con le tende che si chiudono, la ruota che lo estrae e
// le tende che si riaprono su di esso (client/shared/stage-intro.js). Il tempo
// lo riserva il server: `introEndsAt` arriva nel round e le risposte aprono
// solo dopo, quindi qui non si ruba nulla all'anteprima né alla scelta.

// La ruota mostra i minigiochi che questa pagina conosce davvero: il registry
// di presentazione, non un elenco scritto a mano. Un minigioco nuovo ci
// compare da solo.
MinigameStageIntro.setWheelConfig({
  games: Minigames.types().map((type) => {
    const mg = Minigames.get(type);
    return { type, label: mg.label, icon: mg.wheelIcon };
  }),
});
MinigameStageIntro.preload();

// ─── Audio dei minigiochi ────────────────────────────────────────────────────
//
// Ogni minigioco porta con sé colonna sonora ed effetti (`audio` nel suo
// contratto di presentazione): qui si registrano nel catalogo, ognuno nel
// proprio spazio dei nomi. Come la ruota del sipario, l'elenco viene dal
// registry: un minigioco nuovo suona senza toccare questo file.
for (const type of Minigames.types()) {
  const { audio } = Minigames.get(type);
  if (audio) SalaAudio.register(type, audio);
}

/** `ctx.sfx` di un minigioco: suona i SUOI effetti, mai quelli della sala. */
const minigameSfx = (type) => (name) => SalaAudio.sfx(AudioLogic.minigameSfxKey(type, name));

/**
 * La musica sotto un round minigioco: la sua colonna sonora se ne ha una,
 * altrimenti quella della partita. Su un livello successivo al primo la
 * traccia è già in corso e la chiamata non la fa ripartire.
 */
function playMinigameMusic(q) {
  SalaAudio.music(currentMinigame.audio?.music ? q.minigameType : AudioLogic.MUSIC.quiz);
}

// ─── Conto alla rovescia d'apertura ──────────────────────────────────────────
//
// "Pronti?", 3, 2, 1, VIA! a tutto schermo, fra la lobby e la prima domanda.
// Il tempo lo riserva il server (`startsAt` nel primo round): le risposte
// aprono solo dopo, quindi contare non toglie un secondo a nessuno. Cosa
// mostrare e cosa suonare a ogni istante lo decide `AudioLogic`; qui c'è il
// disegno.

/** Quanto resta a schermo il "VIA!" sopra la domanda appena comparsa. */
const START_GO_MS = 850;

function stopStartCountdown() {
  if (startTimer) {
    clearInterval(startTimer);
    startTimer = null;
  }
  if (startGoTimer) {
    clearTimeout(startGoTimer);
    startGoTimer = null;
  }
  els.startLayer.hidden = true;
  els.startLayer.classList.remove('is-go');
}

/** Scrive un passo del conteggio e lo fa "saltare" in scena col suo suono. */
function showStartStep(step) {
  els.startNum.textContent = step.label;
  els.startNum.classList.toggle('is-word', step.word);
  els.startNum.classList.remove('is-pop');
  void els.startNum.offsetWidth;   // fa ripartire l'animazione (vedi enterPanel)
  els.startNum.classList.add('is-pop');
  SalaAudio.sfx(step.sfx);
}

/**
 * Conta fino a `startsAt` (ora locale), poi mostra la domanda con il "VIA!"
 * sopra. La musica della lobby sfuma subito: il conteggio suona nel silenzio,
 * e il tema del quiz parte insieme alla prima domanda.
 */
function playStartCountdown(q, startsAt) {
  stopCountdown();
  SalaAudio.music(null);
  els.startLayer.hidden = false;
  const receivedAt = Date.now();
  let lastLabel = null;
  const tick = () => {
    const leftMs = ServerClock.remainingMs(startsAt);
    if (leftMs <= 0) {
      // `localDeadline` misura lo scarto fra orologi quando la si chiama: il
      // `serverNow` va fatto avanzare di quanto si è aspettato qui.
      renderQuestion(
        { ...q, startsAt: null, serverNow: q.serverNow + (Date.now() - receivedAt) },
        { fromStart: true },
      );
      // Dopo `renderQuestion`, che col suo cambio di fase ha spento lo strato.
      els.startLayer.hidden = false;
      els.startLayer.classList.add('is-go');
      showStartStep(AudioLogic.START_GO);
      startGoTimer = setTimeout(stopStartCountdown, START_GO_MS);
      return;
    }
    const step = AudioLogic.startCountdownStep(leftMs);
    if (step.label !== lastLabel) {
      lastLabel = step.label;
      showStartStep(step);
    }
  };
  startTimer = setInterval(tick, 50);
  tick();
}

/**
 * Mette in scena il sipario a tutto schermo e monta il minigioco SOTTO le
 * tende nell'istante in cui si chiudono per l'ultima volta: la riapertura
 * finale lo scopre, invece di scoprire un palco vuoto.
 *
 * Le tende stanno su uno strato proprio (`#sala-intro-layer`), non dentro il
 * pannello della domanda: chiuse dentro la scheda erano un teatrino in mezzo
 * allo schermo, mentre il sipario deve coprire l'intero proiettore.
 *
 * Il montaggio è a tempo di orologio, non legato all'animazione: se il sipario
 * non parte (movimento ridotto, niente WebGL) il minigioco comincia comunque
 * quando il server se lo aspetta.
 *
 * @param {object} q payload `game:question`
 * @param {number} leftMs quanto manca alla fine del sipario, ora locale
 * @param {() => void} mountScene avvia l'attesa del minigioco
 * @param {number} token fase corrente
 */
function playMinigameIntro(q, leftMs, mountScene, token) {
  const totalMs = Math.max(leftMs, q.introMs);
  const reopenMs = totalMs * (1 - MinigameStageIntro.TIMELINE.curtainClose2End);
  // Le tende hanno la loro fanfara: la musica della partita sfuma e lascia il
  // posto a quella del minigioco, che parte quando si riaprono su di lui.
  SalaAudio.music(null);
  MinigameStageIntro.play(els.introLayer, {
    targetType: q.minigameType,
    label: currentMinigame.label,
    durationMs: totalMs,
    // Una sala che si ricollega a sipario in corso lo riprende da dov'è.
    startU: 1 - leftMs / totalMs,
  });
  introTimer = setTimeout(() => {
    introTimer = null;
    if (AudioLogic.isStale(token, phaseToken)) return;
    mountScene();
  }, Math.max(0, leftMs - reopenMs));
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
  SalaAudio.hurry(false);
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

let currentCountdownLimitS = null;

/**
 * Countdown calcolato localmente da un timestamp assoluto: la latenza di rete
 * non desincronizza la sala dall'host e dai telefoni.
 */
function startCountdown(endsAt, serverNow, limitS) {
  stopCountdown();
  currentCountdownLimitS = limitS ?? currentCountdownLimitS;
  els.timer.classList.remove('is-idle', 'is-paused');
  const deadline = ServerClock.localDeadline(endsAt, serverNow);
  // Il pieno dell'anello è la durata della domanda: così chi si ricollega a
  // metà round (il Pi riavviato) vede l'anello già consumato in proporzione,
  // non un anello pieno su un tempo quasi scaduto. Senza durata nota, si
  // parte da quel che resta.
  const totalMs = Math.max(1, Number.isFinite(limitS) && limitS > 0
    ? limitS * 1000
    : ServerClock.remainingMs(deadline));
  // L'ultima cifra dei secondi che ha suonato: il timer si SENTE scorrere,
  // un tic a ogni secondo, più teso verso la fine (vedi AudioLogic.timerCue).
  let lastSecond = null;
  const tick = () => {
    const leftMs = ServerClock.remainingMs(deadline);
    // Mai più del tempo del round: al via mancano 6,00x s e il ceil darebbe 7.
    const remaining = Math.min(Math.ceil(leftMs / 1000), Math.ceil(totalMs / 1000));
    const m = String(Math.floor(remaining / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    const urgent = AudioLogic.isHurry(remaining);
    const cue = AudioLogic.timerCue({ remaining, previous: lastSecond });
    if (cue) SalaAudio.sfx(cue);
    lastSecond = remaining;
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
    // Negli ultimi secondi anche la musica corre.
    SalaAudio.hurry(urgent);
    if (remaining === 0) stopCountdown(false);
  };
  tick();
  countdownTimer = setInterval(tick, 250);
}

function pauseCountdown(remainingMs) {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  els.timer.classList.add('is-paused');
  els.timer.classList.remove('is-urgent');
  document.body.classList.remove('is-urgent');
  // Tempo fermo: niente tic (il giro è spento) e la musica torna al suo passo.
  SalaAudio.hurry(false);
  if (typeof remainingMs === 'number') {
    const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
    const m = String(Math.floor(remaining / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    els.timer.textContent = remaining >= 60 ? `${m}:${s}` : String(remaining);
  }
}

function resumeCountdown(endsAt, serverNow) {
  els.timer.classList.remove('is-paused');
  startCountdown(endsAt, serverNow, currentCountdownLimitS);
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

// ─── Attesa ──────────────────────────────────────────────────────────────────

/**
 * Il pannello d'attesa ha due facce: con `guide` la guida in quattro passi a
 * tutto schermo e il cartello piccolo sotto (si aspetta l'host: è il momento
 * in cui la gente entra nella rete); senza, il logo grande e il cartello come
 * unico messaggio (connessione persa, partita finita, rientro a metà round —
 * lì la guida direbbe di entrare in una partita in cui non si entra).
 */
function setIdle(text, { guide = false } = {}) {
  els.idleText.textContent = text;
  els.panels.idle.classList.toggle('is-guide', guide);
}

// ─── Guida "come si entra" ───────────────────────────────────────────────────
//
// Quattro passi, a tutto schermo in attesa dell'host e sulla sinistra in
// lobby, accanto al QR. Le due copie nascono dallo stesso elenco: cambia solo
// la riga sotto il titolo dove la guida indica qualcosa che in attesa non c'è
// ancora (il QR, la striscia dei nomi).

/** Un elemento con classe e, facoltativo, testo. */
function guideNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Una riga sotto il titolo; `icon` la chiude con un simbolo (una freccia). */
function guideLine(text, icon) {
  const p = guideNode('p', 'sala-guide-sub', text);
  if (icon) {
    const i = guideNode('span', 'material-symbols-outlined', icon);
    i.setAttribute('aria-hidden', 'true');
    p.append(' ', i);
  }
  return p;
}

const GUIDE_STEPS = [
  {
    icon: 'wifi',
    title: 'Connettiti al Wi-Fi',
    // Nome, password e QR della rete arrivano da /api/join-info (applyWifi):
    // qui solo i posti dove scriverli.
    lines: () => {
      const net = guideNode('p', 'sala-guide-sub', 'Rete ');
      net.append(guideNode('b', 'sala-guide-chip sala-guide-ssid', 'QuizZata'));
      const pass = guideNode('p', 'sala-guide-sub sala-guide-pass', 'Password ');
      pass.append(guideNode('b', 'sala-guide-chip sala-guide-pw'));
      pass.hidden = true;
      return [net, pass];
    },
    extra: () => {
      const qr = guideNode('div', 'sala-guide-wifi-qr');
      qr.setAttribute('role', 'img');
      qr.setAttribute('aria-label', 'QR code per collegarsi al Wi-Fi');
      qr.hidden = true;
      return qr;
    },
  },
  {
    icon: 'qr_code_scanner',
    title: 'Scannerizza il QR code',
    lines: (where) => [where === 'lobby'
      ? guideLine('Quello grande qui accanto', 'arrow_forward')
      : guideLine('Compare qui quando l\'host apre la partita')],
  },
  {
    // Il personaggio vero, non un'icona: è lui che si sta per scegliere.
    avatar: 'sunny_yellow:wink:sport',
    title: 'Personalizza il tuo personaggio',
    lines: () => [guideLine('Nome, colore, faccia e outfit')],
  },
  {
    icon: 'sports_esports',
    title: 'Sei pronto a giocare!',
    lines: (where) => [where === 'lobby'
      ? guideLine('Il tuo nome compare qui sotto', 'arrow_downward')
      : guideLine('Si parte quando l\'host avvia il quiz')],
  },
];

/**
 * Dove il sentiero entra (`in`) ed esce (`out`) da ogni scheda: lato e
 * frazione lungo quel lato (da sinistra, o dall'alto). Lontano dall'angolo in
 * alto a destra, dove sta il bollino che coprirebbe il tratto.
 */
const GUIDE_PINS = [
  { out: { side: 'top', f: 0.42 } },
  { in: { side: 'top', f: 0.32 }, out: { side: 'right', f: 0.55 } },
  { in: { side: 'top', f: 0.5 }, out: { side: 'bottom', f: 0.55 } },
  { in: { side: 'bottom', f: 0.45 } },
];

/** Un attacco come frazioni della scheda: { x, y } fra 0 e 1. */
function pinXY({ side, f }) {
  if (side === 'top') return { x: f, y: 0 };
  if (side === 'bottom') return { x: f, y: 1 };
  if (side === 'left') return { x: 0, y: f };
  return { x: 1, y: f };
}

/** Disegna la guida dentro `slot`. `where`: 'idle' | 'lobby'. */
function renderGuide(slot, where) {
  const list = guideNode('ol', 'sala-guide');
  list.setAttribute('aria-label', 'Come si entra in partita');
  GUIDE_STEPS.forEach((step, i) => {
    const li = guideNode('li', `sala-guide-step is-step-${i + 1}`);
    li.style.setProperty('--i', i);

    const disc = guideNode('span', 'sala-guide-disc');
    disc.setAttribute('aria-hidden', 'true');
    if (step.avatar) {
      const head = guideNode('span', 'sala-guide-head');
      AvatarSprite.fill(head, step.avatar);
      disc.append(head);
    } else {
      disc.append(guideNode('span', 'material-symbols-outlined', step.icon));
    }

    // "Passo N" grande in testa, il titolo sottolineato, poi i dettagli (col
    // QR del Wi-Fi accanto, dove c'è: in colonna la scheda crescerebbe troppo).
    const detail = guideNode('div', 'sala-guide-detail');
    const lines = guideNode('div', 'sala-guide-lines');
    lines.append(...step.lines(where));
    detail.append(lines);
    if (step.extra) detail.append(step.extra(where));

    const body = guideNode('div', 'sala-guide-body');
    body.append(
      guideNode('p', 'sala-guide-kicker', `Passo ${i + 1}`),
      guideNode('p', 'sala-guide-title', step.title),
      detail,
    );

    li.append(disc, body);
    // I pallini dove il sentiero entra ed esce dalla scheda: stessa tabella
    // di drawGuideTrail, in percentuale, quindi reggono qualunque misura.
    for (const pin of Object.values(GUIDE_PINS[i])) {
      const { x, y } = pinXY(pin);
      const dot = guideNode('span', 'sala-guide-pin');
      dot.setAttribute('aria-hidden', 'true');
      dot.style.left = `${x * 100}%`;
      dot.style.top = `${y * 100}%`;
      li.append(dot);
    }
    list.append(li);
  });
  list.prepend(guideTrail(where));
  slot.replaceChildren(list);
  // Il sentiero dipende da dove stanno le schede: si ridisegna a ogni cambio
  // di misura. Lo stesso osservatore sa quando il pannello compare (da zero a
  // una misura vera) e quando sparisce: lì parte e si ferma lo spettacolo.
  const show = { list, gen: 0, running: false, trail: null, anims: [] };
  new ResizeObserver(() => onGuideResize(show)).observe(list);
}

/* ── Il sentiero da mappa del tesoro fra i passi ──────────────────────────
   Una linea tratteggiata, ondulata e con qualche giro su sé stessa, che va dal
   passo 1 al 2, dal 2 al 3 e dal 3 al 4. Sta SOTTO le schede: passa negli
   spazi fra l'una e l'altra e da dietro le schede ne "esce" da sola. È un
   unico tracciato, quindi la maschera animata in motion.css lo percorre come
   un serpente: la testa arriva al 4, poi la coda si ritira dall'inizio. */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgNode(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function guideTrail(where) {
  const svg = svgNode('svg', { class: 'sala-guide-trail', 'aria-hidden': 'true' });
  const maskId = `sala-guide-trail-mask-${where}`;
  // I riccioli possono uscire dal riquadro della lista: la maschera copre largo.
  const mask = svgNode('mask', {
    id: maskId, maskUnits: 'userSpaceOnUse', x: '-50%', y: '-50%', width: '200%', height: '200%',
  });
  mask.append(svgNode('path', { class: 'sala-guide-trail-mask', pathLength: '1' }));
  svg.append(svgNode('defs'), svgNode('path', { class: 'sala-guide-trail-line', mask: `url(#${maskId})` }));
  svg.firstChild.append(mask);
  return svg;
}

/**
 * Un tratto fra due bordi: parte da `a` uscendo nella direzione `da`, arriva
 * in `b` entrando nella direzione opposta a `db`. La base è una curva di
 * Bézier; sopra ci gira un punto su una circonferenza (una trocoide), e
 * quando il giro va all'indietro più veloce di quanto la base vada avanti
 * nasce un ricciolo. L'inviluppo sin(πu) tiene ferme le due estremità.
 */
function trailLeg(a, da, b, db, { loops, radius = 0, curl, maxRadius, wave, reach }) {
  const c1 = { x: a.x + da.x * reach, y: a.y + da.y * reach };
  const c2 = { x: b.x + db.x * reach, y: b.y + db.y * reach };
  const at = (u) => {
    const v = 1 - u;
    return {
      x: v * v * v * a.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * b.x,
      y: v * v * v * a.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * b.y,
    };
  };
  // `curl`: quanto il giro supera la soglia del ricciolo (raggio = lunghezza
  // della base / 2π·giri). Sopra 1 ogni giro fa un occhiello vero; sotto,
  // solo una gobba. Senza `curl` vale `radius` così com'è.
  let baseLen = 0;
  for (let k = 1, prev = a; k <= 40; k++) {
    const p = at(k / 40);
    baseLen += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  const R = curl && loops ? Math.min(maxRadius ?? Infinity, (curl * baseLen) / (2 * Math.PI * loops)) : radius;
  const pts = [];
  const N = 40 + loops * 40;
  for (let k = 0; k <= N; k++) {
    const u = k / N;
    const p = at(u);
    const q = at(Math.min(1, u + 0.01));
    const r = at(Math.max(0, u - 0.01));
    let tx = q.x - r.x, ty = q.y - r.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    const nx = -ty, ny = tx;
    const env = Math.sin(Math.PI * u);
    // Fase un po' storta: giri tutti uguali sembravano il bordo di una nuvola.
    const phi = 2 * Math.PI * loops * (u + 0.07 * Math.sin(2 * Math.PI * u));
    const d = R * env;
    const w = wave * env * Math.sin(Math.PI * 3 * u);
    pts.push({
      x: p.x + d * (Math.sin(phi) * nx - (1 - Math.cos(phi)) * tx) + w * nx,
      y: p.y + d * (Math.sin(phi) * ny - (1 - Math.cos(phi)) * ty) + w * ny,
    });
  }
  return pts;
}

function drawGuideTrail(list) {
  const svg = list.querySelector('.sala-guide-trail');
  const cards = [...list.querySelectorAll('.sala-guide-step')];
  if (!svg || cards.length < 4 || list.offsetWidth === 0) return;

  // offsetLeft/Top: la posizione di layout, senza le trasformazioni
  // dell'entrata animata (relative a `.sala-guide`, che è posizionata).
  const box = cards.map((c) => ({ x: c.offsetLeft, y: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight }));
  const [b1, b2, b3, b4] = box;
  const em = parseFloat(getComputedStyle(list).fontSize) || 16;
  const rowGap = b3.y - (b1.y + b1.h);

  const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  // Il punto di attacco sul bordo, dalla stessa tabella che posa i pallini.
  const at = (b, pin) => {
    const { x, y } = pinXY(pin);
    return { x: b.x + b.w * x, y: b.y + b.h * y };
  };
  const [p1, p2, p3, p4] = GUIDE_PINS;
  const UP = { x: 0, y: -1 }, DOWN = { x: 0, y: 1 }, RIGHT = { x: 1, y: 0 };

  // Il sentiero gira FUORI dalle schede, dove c'è spazio per i riccioli:
  //   1 → 2  esce dal bordo alto del 1, fa un arco sopra e scende sul 2;
  //   2 → 3  esce a destra del 2, scende lungo il fianco e torna a sinistra
  //          ondeggiando nel corridoio fra le righe, fino al bordo alto del 3;
  //   3 → 4  esce dal bordo basso del 3, passa sotto e risale nel 4.
  // Gli attacchi stanno lontano dai bollini, che sono sugli angoli in alto a
  // destra e coprirebbero il tratto.
  // Riccioli veri (curl > 1) nei tratti lunghi; il fianco del 2 solo ondeggia,
  // perché a destra in lobby c'è subito il QR.
  const over = { loops: 2, curl: 1.9, maxRadius: em * 2.2, wave: em * 1.2, reach: em * 3.4 };
  const under = { loops: 2, curl: 1.9, maxRadius: em * 1.9, wave: em * 1, reach: em * 2.4 };
  const flank = { loops: 0, wave: em * 0.35, reach: em * 1.6 };
  const across = { loops: 3, curl: 1.5, maxRadius: em * 1.6, wave: rowGap * 0.3, reach: rowGap * 1.3 };

  // Il punto in cui il sentiero gira l'angolo in basso a destra del 2: ci
  // arriva scendendo verso sinistra e riparte nella stessa direzione.
  const turn = { x: b2.x + b2.w + em * 1.3, y: b2.y + b2.h + rowGap * 0.5 };
  const v = { x: -0.92, y: 0.38 };

  const leg12 = trailLeg(at(b1, p1.out), UP, at(b2, p2.in), UP, over);
  const leg23a = trailLeg(at(b2, p2.out), RIGHT, turn, { x: -v.x, y: -v.y }, flank);
  const leg23b = trailLeg(turn, v, at(b3, p3.in), UP, across);
  const leg34 = trailLeg(at(b3, p3.out), DOWN, at(b4, p4.in), DOWN, under);

  // Un tracciato solo: fra un tratto e l'altro passa dal centro della scheda
  // (dietro di lei, invisibile). `stops`: a che frazione della lunghezza il
  // sentiero arriva sul bordo del 2, del 3 e del 4.
  const parts = [[center(b1)], leg12, [center(b2)], leg23a, leg23b, [center(b3)], leg34, [center(b4)]];
  const arrivals = new Set([leg12, leg23b, leg34]);
  const pts = [];
  const reached = [];
  let length = 0;
  for (const part of parts) {
    for (const p of part) {
      const prev = pts[pts.length - 1];
      if (prev) length += Math.hypot(p.x - prev.x, p.y - prev.y);
      pts.push(p);
    }
    if (arrivals.has(part)) reached.push(length);
  }
  const d = 'M' + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L');
  for (const path of svg.querySelectorAll('path')) path.setAttribute('d', d);
  return { length, stops: reached.map((l) => l / length) };
}

/* ── Lo spettacolo della guida ────────────────────────────────────────────
   All'apertura: compare il passo 1, il sentiero parte e quando arriva al 2
   compare il 2; aspetta 2 s e prosegue verso il 3, che compare; lo stesso per
   il 4. Poi le schede restano e solo il sentiero continua, in loop: la coda si
   ritira dall'inizio come un serpente, la testa riparte dal 1 e ritorna al 4,
   e ogni bollino dà un colpo quando la testa arriva alla sua scheda.

   È JavaScript (Web Animations) e non solo CSS perché i tempi dipendono da
   dove sta il sentiero: la scheda compare quando la testa la raggiunge, e la
   lunghezza di ogni tratto cambia con lo schermo. Il sentiero si mostra con
   la maschera: un tratto pieno lungo `pathLength = 1`; il pezzo visibile
   [s, e] è `stroke-dasharray: (e−s) 2` con `stroke-dashoffset: −s`. */

const GUIDE_SHOW = Object.freeze({
  popMs: 480,          // entrata di una scheda
  firstLegDelayMs: 600,
  waitMs: 2000,        // sosta del sentiero su ogni passo
  pxPerSec: 560,       // velocità della testa durante l'apertura
  minLegMs: 1100,
  maxLegMs: 2600,
  loopDelayMs: 1500,   // a sentiero completo, prima che parta il loop
  loopMs: 9000,
  // Fasi del loop, in frazione del ciclo: pieno, la coda si ritira, vuoto,
  // la testa ridisegna fino al 4, pieno.
  retractFrom: 0.12, retractTo: 0.5, drawFrom: 0.56, drawTo: 0.94,
});

function onGuideResize(show) {
  if (show.list.offsetWidth === 0) {
    stopGuideShow(show);
    return;
  }
  show.trail = drawGuideTrail(show.list) || show.trail;
  if (!show.running) startGuideShow(show);
}

function stopGuideShow(show) {
  show.gen++;
  show.running = false;
  for (const a of show.anims) a.cancel();
  show.anims = [];
}

function setTrailSpan(mask, s, e) {
  mask.style.strokeDasharray = `${Math.max(0, e - s)} 2`;
  mask.style.strokeDashoffset = `${-s}`;
}

async function startGuideShow(show) {
  show.running = true;
  const gen = ++show.gen;
  const alive = () => gen === show.gen;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const track = (a) => { show.anims.push(a); return a; };

  const cards = [...show.list.querySelectorAll('.sala-guide-step')];
  const discs = cards.map((c) => c.querySelector('.sala-guide-disc'));
  const mask = show.list.querySelector('.sala-guide-trail-mask');

  // Movimento ridotto: tutto fermo e visibile, sentiero intero.
  if (reducedMotion() || !show.trail) {
    for (const c of cards) c.style.opacity = '';
    mask.style.strokeDasharray = '';
    mask.style.strokeDashoffset = '';
    return;
  }

  const beat = (disc) => track(disc.animate([
    { transform: 'none' },
    { transform: 'scale(1.18) rotate(-10deg)', offset: 0.45 },
    { transform: 'none' },
  ], { duration: 420, easing: 'ease-out' }));
  const pop = (i) => {
    cards[i].style.opacity = '';
    track(cards[i].animate([
      { opacity: 0, transform: 'translateY(1.2em) scale(0.85) rotate(-3deg)' },
      { opacity: 1, transform: 'translateY(-0.15em) scale(1.04) rotate(1deg)', offset: 0.65 },
      { opacity: 1, transform: 'none' },
    ], { duration: GUIDE_SHOW.popMs, easing: 'ease-out' }));
    beat(discs[i]);
  };

  for (const c of cards) c.style.opacity = '0';
  setTrailSpan(mask, 0, 0);
  pop(0);
  await sleep(GUIDE_SHOW.firstLegDelayMs);
  if (!alive()) return;

  let from = 0;
  for (let i = 1; i < cards.length; i++) {
    const to = show.trail.stops[i - 1];
    const ms = Math.min(GUIDE_SHOW.maxLegMs, Math.max(GUIDE_SHOW.minLegMs,
      ((to - from) * show.trail.length / GUIDE_SHOW.pxPerSec) * 1000));
    const leg = track(mask.animate([
      { strokeDasharray: `${from} 2`, strokeDashoffset: '0' },
      { strokeDasharray: `${to} 2`, strokeDashoffset: '0' },
    ], { duration: ms, easing: 'ease-in-out', fill: 'forwards' }));
    await leg.finished.catch(() => {});
    if (!alive()) return;
    setTrailSpan(mask, 0, to);
    leg.cancel();
    pop(i);
    from = to;
    if (i < cards.length - 1) {
      await sleep(GUIDE_SHOW.waitMs);
      if (!alive()) return;
    }
  }

  await sleep(GUIDE_SHOW.loopDelayMs);
  if (!alive()) return;
  startTrailLoop(show, mask, discs);
}

function startTrailLoop(show, mask, discs) {
  const S = GUIDE_SHOW;
  const full = { strokeDasharray: '1 2', strokeDashoffset: '0' };
  setTrailSpan(mask, 0, 1);
  show.anims.push(mask.animate([
    { offset: 0, ...full },
    { offset: S.retractFrom, ...full, easing: 'ease-in-out' },
    { offset: S.retractTo, strokeDasharray: '0 2', strokeDashoffset: '-1' },
    // A tratto nullo il salto dell'offset non si vede (estremità piatte).
    { offset: S.drawFrom, strokeDasharray: '0 2', strokeDashoffset: '0' },
    { offset: S.drawTo, ...full },
    { offset: 1, ...full },
  ], { duration: S.loopMs, iterations: Infinity }));

  // Il colpo di ogni bollino, nel momento in cui la testa (che nella fase di
  // disegno va a velocità costante) raggiunge la sua scheda.
  const stops = [0, ...show.trail.stops];
  discs.forEach((disc, i) => {
    const at = S.drawFrom + (S.drawTo - S.drawFrom) * stops[i];
    show.anims.push(disc.animate([
      { offset: 0, transform: 'none' },
      { offset: at, transform: 'none' },
      { offset: at + 0.02, transform: 'scale(1.18) rotate(-10deg)' },
      { offset: Math.min(1, at + 0.045), transform: 'none' },
      { offset: 1, transform: 'none' },
    ], { duration: S.loopMs, iterations: Infinity }));
  });
}

/**
 * Il testo di un QR "Wi-Fi" (lo standard che le fotocamere di Android e iOS
 * riconoscono: inquadrato, il telefono propone di collegarsi). I caratteri
 * speciali del formato vanno protetti con la barra rovesciata.
 */
function wifiQrText({ ssid, password }) {
  const esc = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
  return password
    ? `WIFI:T:WPA;S:${esc(ssid)};P:${esc(password)};;`
    : `WIFI:T:nopass;S:${esc(ssid)};;`;
}

/** Scrive nome, password e QR della rete in entrambe le copie della guida. */
function applyWifi(wifi) {
  if (!wifi?.ssid) return;
  let svg = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(wifiQrText(wifi));
    qr.make();
    svg = QrArt.render(qr, { margin: 1 });
  } catch {
    // Senza QR resta il nome della rete scritto, che basta.
  }
  for (const n of document.querySelectorAll('.sala-guide-ssid')) n.textContent = wifi.ssid;
  for (const n of document.querySelectorAll('.sala-guide-pw')) n.textContent = wifi.password ?? '';
  for (const n of document.querySelectorAll('.sala-guide-pass')) n.hidden = !wifi.password;
  for (const n of document.querySelectorAll('.sala-guide-wifi-qr')) {
    n.innerHTML = svg;
    n.hidden = !svg;
  }
}

// ─── Lobby ───────────────────────────────────────────────────────────────────

/**
 * Carica l'URL LAN e la rete Wi-Fi, disegna il QR della partita e completa la
 * guida. Endpoint pubblico: la sala non ha token.
 */
async function loadJoinInfo() {
  els.qr.innerHTML = '';
  els.joinUrl.textContent = '';
  let url;
  let label = null;
  let wifi = null;
  try {
    const res = await fetch('/api/join-info');
    const body = await res.json();
    url = body.data.url;
    // Sotto il QR il nome della sala, se il server ne ha uno (JOIN_HOST):
    // si detta e si digita meglio dell'IP. Il QR resta sull'IP.
    label = body.data.label ?? null;
    wifi = body.data.wifi ?? null;
  } catch {
    // Ripiego: l'indirizzo di questa pagina. Sul Pi in kiosk è "localhost" e
    // quindi inutile a un telefono, ma è meglio di uno spazio vuoto.
    url = `${location.protocol}//${location.host}`;
  }
  els.joinUrl.textContent = label || url;
  applyWifi(wifi);
  try {
    // Livello H: la correzione d'errore ricostruisce i moduli coperti dal
    // logo al centro (vedi qr-art.js, che lo toglie se il codice è troppo
    // grande per averne uno).
    const qr = qrcode(0, 'H');
    qr.addData(url);
    qr.make();
    els.qr.innerHTML = QrArt.render(qr, { logo: '/resources/img/Logo.svg' });
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

  // La striscia in basso ha una riga sola: l'ultimo arrivato va in testa,
  // dove lo si vede comparire, e chi non ci sta più è il primo entrato
  // (fitLobbyStrip lo riassume in "+N").
  els.players.innerHTML = '';
  for (const p of [...players].reverse()) {
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
    AvatarSprite.fill(av, p.avatar);
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

  // Si misura a pannello visibile: chi chiama mostra la lobby subito dopo.
  requestAnimationFrame(fitLobbyStrip);
}

/**
 * La striscia dei giocatori è una riga sola: i chip che sbordano si
 * nascondono e un ultimo chip dice quanti sono. Va misurata, perché dipende
 * dalla lunghezza dei nomi. Le misure ignorano le trasformazioni, quindi il
 * pop d'ingresso in corso non le falsa.
 */
function fitLobbyStrip() {
  const list = els.players;
  list.querySelector('.sala-player-more')?.remove();
  const chips = [...list.querySelectorAll('.sala-player-chip')];
  for (const c of chips) c.hidden = false;
  if (!list.clientWidth) return;   // pannello nascosto: si rifà al prossimo giro

  const fits = (node) => node.offsetLeft + node.offsetWidth <= list.clientWidth;
  let visible = chips.filter(fits).length;
  if (visible === chips.length) return;

  const more = document.createElement('li');
  more.className = 'sala-player-more';
  list.appendChild(more);
  // Il "+N" deve starci anche lui: si toglie un chip alla volta finché entra.
  do {
    for (let i = 0; i < chips.length; i++) chips[i].hidden = i >= visible;
    more.textContent = `+${chips.length - visible}`;
    if (fits(more)) break;
    visible--;
  } while (visible > 0);
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
/** Applica la sfocatura percentuale (0-100) all'immagine della domanda corrente. */
function setMediaBlur(blurValue) {
  if (!els.questionMedia) return;
  const num = typeof blurValue === 'number'
    ? Math.max(0, Math.min(100, Math.round(blurValue)))
    : (blurValue ? 60 : 0);
  if (num > 0) {
    els.questionMedia.classList.add('is-blurred');
    const factor = (num / 100).toFixed(3);
    els.questionMedia.style.setProperty('--img-blur', `blur(calc(${factor} * clamp(8px, 2.2vh, 26px)))`);
  } else {
    els.questionMedia.classList.remove('is-blurred');
    els.questionMedia.style.removeProperty('--img-blur');
  }
}

function renderQuestionMedia(round, token) {
  const image = round?.image ?? null;
  const hasMedia = image !== null && typeof image === 'object' && typeof image.hash === 'string';

  // La riga "scegli l'opzione corretta" parla di una risposta giusta: in un
  // minigioco (`round` null) non ce n'è una, e la scena ha già la sua regia.
  els.questionHint.hidden  = hasMedia || round === null;
  els.questionMedia.hidden = !hasMedia;

  // Si riparte sempre dal riquadro pulito: l'immagine del round precedente non
  // deve comparire per un fotogramma sotto la domanda nuova, né la sua
  // sfocatura restare addosso a un'immagine che non la vuole.
  const existing = els.questionMedia.querySelector('img');
  if (existing) existing.remove();
  setMediaBlur(0);

  const icon = els.questionMedia.querySelector('.material-symbols-outlined');

  if (!hasMedia) {
    if (icon) icon.hidden = false;
    return;
  }

  setMediaBlur(image.blur);

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

function renderQuestion(q, { fromStart = false } = {}) {
  // Primo round della partita: prima si conta, la domanda arriva al "VIA!".
  if (!fromStart && q.startsAt) {
    const startsAt = ServerClock.localDeadline(q.startsAt, q.serverNow);
    if (ServerClock.remainingMs(startsAt) > 0) {
      newPhase();
      playStartCountdown(q, startsAt);
      return;
    }
  }
  const token = newPhase();
  currentOptions  = q.options ?? [];
  currentRoundIndex = q.index;
  const isMinigame = q.kind === 'minigame';
  currentMinigame  = isMinigame ? Minigames.get(q.minigameType) : null;

  els.panels.question.classList.toggle('is-minigame', isMinigame);
  // Colonna dei giocatori al posto delle carte (`salaPlayers`): chi ha scelto,
  // e a round chiuso chi ha vinto. Prende la colonna destra come le carte.
  const hasRoster = isMinigame && currentMinigame.salaPlayers === true;
  els.panels.question.classList.toggle('has-roster', hasRoster);
  // Minigioco tutto palco (`salaOptions: false`, senza colonna): le carte
  // delle scelte non compaiono e la scena si prende anche il loro spazio.
  els.panels.question.classList.toggle('is-stage-only',
    isMinigame && currentMinigame.salaOptions === false && !hasRoster);
  rosterAnswered = [];
  rosterLive = hasRoster;
  els.roster.hidden = !hasRoster;
  els.roster.classList.remove('is-outcome');
  els.panels.question.classList.remove('is-outcome');
  if (hasRoster) renderRoster();
  // Il nastro adesivo porta l'etichetta del round: la categoria del quiz non
  // arriva in `game:question`, quindi si usa l'informazione che c'è davvero.
  // Un minigioco può chiedere un nastro diverso dal proprio nome, o nessun
  // nastro (`salaKicker: null`) quando la sua scena si racconta da sola.
  const kicker = isMinigame
    ? (currentMinigame.salaKicker === undefined
      ? (currentMinigame.label ?? 'Minigioco')
      : currentMinigame.salaKicker)
    : `Domanda ${q.index + 1} di ${q.total}`;
  els.roundKicker.textContent = kicker ?? '';
  els.roundKicker.hidden = !kicker;

  // Il round minigioco porta con sé la propria attesa; la domanda vera mostra
  // semplicemente il proprio testo.
  // `answersOpenAt` è la fine dell'anteprima (es. i bicchieri che si
  // mescolano prima della scelta), già riportata sull'orologio locale.
  const answersOpenAt = q.answersOpenAt
    ? ServerClock.localDeadline(q.answersOpenAt, q.serverNow)
    : Date.now();
  if (isMinigame) {
    const mountScene = () => {
      playMinigameMusic(q);
      currentMinigame.sala.startSuspense(minigameEls(), q, {
        answersOpenAt,
        isStale: () => AudioLogic.isStale(token, phaseToken),
        sfx: minigameSfx(q.minigameType),
      });
    };
    const introEndsAt = q.introEndsAt
      ? ServerClock.localDeadline(q.introEndsAt, q.serverNow)
      : 0;
    const introLeftMs = introEndsAt ? ServerClock.remainingMs(introEndsAt) : 0;
    if (introLeftMs > 0) {
      // Finché le tende non si chiudono l'ultima volta, sotto non c'è nulla.
      els.questionText.textContent = '';
      playMinigameIntro(q, introLeftMs, mountScene, token);
    } else {
      mountScene();
    }
  } else {
    els.questionText.textContent = q.text;
    // Il tema del quiz: parte con la prima domanda e torna dopo un
    // minigioco; se è già in corso la chiamata non lo tocca.
    SalaAudio.music(AudioLogic.MUSIC.quiz);
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
  if (q.isPaused) {
    pauseCountdown(q.remainingMs);
  }
  showPanel('question');
  // Dopo `showPanel`: un pannello nascosto non ha misure da prendere.
  fitQuestionLayout();
  // Al "VIA!" suona già il conto alla rovescia.
  if (!fromStart) SalaAudio.sfx('round-start');
}

// ─── Colonna dei giocatori (minigiochi con `salaPlayers`) ────────────────────
//
// Durante la scelta lo schermo non sapeva niente della stanza: tutto succedeva
// sui telefoni. Qui ogni giocatore ha il suo posto e, appena sceglie, mostra la
// faccia con la spunta — senza la mossa, che si scopre solo con la ruota. Chi
// siede e in che ordine lo decide `AnswerRoster` (client/sala/answer-roster.js).

/** Oltre questo numero di posti i nomi non ci stanno più: restano le facce. */
const ROSTER_NAMES_MAX = 24;
/** Con venti bot che scelgono insieme, un tocco per ognuno sarebbe un ronzio. */
const ROSTER_SFX_GAP_MS = 120;

/** Colonne della griglia dei posti per `n` giocatori: più sono, più stretti. */
function rosterColumns(n) {
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  if (n <= 20) return 4;
  if (n <= 30) return 5;
  return 6;
}

/**
 * Dimensiona la griglia per `n` giocatori: colonne, righe e (oltre
 * `ROSTER_NAMES_MAX`) niente nomi. La misura del singolo posto la ricava il
 * CSS da qui, sullo spazio vero della colonna.
 * @param {number} n
 */
function sizeRoster(n) {
  const cols = rosterColumns(n);
  els.roster.style.setProperty('--roster-cols', String(cols));
  els.roster.style.setProperty('--roster-rows', String(Math.max(1, Math.ceil(n / cols))));
  els.roster.classList.toggle('is-crowded', n > ROSTER_NAMES_MAX);
}

/** Sotto questa scala un posto non si legge più dal fondo della sala. */
const ROSTER_MIN_FIT = 0.5;

/**
 * La misura dei posti la stima il CSS da righe e colonne, ma quanto occupa
 * davvero un posto dipende dal font e dai nomi: qui si MISURA, e se la colonna
 * trabocca si rimpicciolisce a passi (`--roster-fit`), come `fitQuestionLayout`
 * fa con le domande. Su un pannello nascosto non c'è niente da misurare: ci
 * pensa `fitQuestionLayout` appena il pannello compare.
 */
function fitRoster() {
  const box = els.rosterSeats;
  let fit = 1;
  els.roster.style.setProperty('--roster-fit', '1');
  while (fit > ROSTER_MIN_FIT && box.scrollHeight > box.clientHeight + 1) {
    fit = Math.max(ROSTER_MIN_FIT, fit - 0.05);
    els.roster.style.setProperty('--roster-fit', fit.toFixed(2));
  }
}

/**
 * Un posto della colonna: la testa del giocatore (o "?" finché non sceglie),
 * il nome e, se ha scelto, la spunta.
 * @param {{ nickname: string, avatar: string }} player
 * @param {{ answered?: boolean, isNew?: boolean }} [state]
 */
function buildRosterSeat(player, { answered = true, isNew = false } = {}) {
  const li = document.createElement('li');
  li.className = 'sala-roster-seat';
  li.classList.toggle('is-waiting', !answered);
  li.classList.toggle('is-new', isNew);
  const face = document.createElement('span');
  face.className = 'sala-roster-face';
  if (answered) AvatarSprite.fill(face, player.avatar);
  else face.textContent = '?';
  const name = document.createElement('span');
  name.className = 'sala-roster-name';
  name.textContent = player.nickname ?? '';
  li.append(face, name);
  if (answered) {
    const check = document.createElement('span');
    check.className = 'sala-roster-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = '✓';
    li.appendChild(check);
  }
  return li;
}

/**
 * Ridisegna la colonna durante la scelta. `freshIds` sono quelli che hanno
 * appena scelto: solo loro fanno lo scatto, gli altri restano fermi al loro
 * posto. Il totale è quello dei posti a schermo, così "N / M" torna sempre con
 * quello che la sala vede.
 * @param {string[]} [freshIds]
 */
function renderRoster(freshIds = []) {
  const seats = AnswerRoster.seatsForRound(currentPlayers, rosterAnswered);
  const fresh = new Set(freshIds);
  const answered = seats.filter((s) => s.answered).length;
  els.rosterCount.textContent = `${answered} / ${seats.length} hanno scelto`;
  sizeRoster(seats.length);
  els.rosterSeats.innerHTML = '';
  for (const seat of seats) {
    els.rosterSeats.appendChild(buildRosterSeat(seat, {
      answered: seat.answered,
      isNew: fresh.has(seat.id),
    }));
  }
  fitRoster();
}

// ─── Disposizione della domanda ──────────────────────────────────────────────
//
// Di norma la scheda sta sopra e le risposte sotto. Una domanda lunga (o con
// immagine) però non ci sta: la scheda cedeva spazio come previsto, ma il testo
// proseguiva oltre il suo bordo e finiva sotto le carte delle risposte. Il CSS
// non sa quando un testo trabocca, quindi qui lo si misura: se la scheda non ci
// sta il pannello passa a due colonne (`.is-split`: domanda a sinistra,
// risposte a destra), e se nemmeno così ci sta si rimpicciolisce a passi la
// sola colonna che trabocca: il testo della domanda (`--q-fit`) o quello delle
// risposte (`--o-fit`). Con una scala sola, quattro risposte lunghe
// rimpicciolivano anche una domanda che aveva spazio da vendere.

/** Sotto questa scala il testo non si legge più dal fondo della sala. */
const MIN_QUESTION_FIT = 0.6;
const QUESTION_FIT_STEP = 0.05;

/** true se la scheda della domanda trabocca dal suo spazio. */
function questionCardOverflows() {
  const card = els.questionCard;
  return card.offsetHeight > els.questionWrap.clientHeight + 1
    || card.scrollHeight > card.clientHeight + 1;
}

/** true se le risposte traboccano dalla loro colonna (solo in `.is-split`). */
function questionOptionsOverflow() {
  return els.options.scrollHeight > els.options.clientHeight + 1;
}

/** Rimpicciolisce `prop` a passi finché `overflows()` smette di essere vero. */
function shrinkToFit(prop, overflows) {
  let fit = 1;
  while (fit > MIN_QUESTION_FIT && overflows()) {
    fit = Math.max(MIN_QUESTION_FIT, fit - QUESTION_FIT_STEP);
    els.panels.question.style.setProperty(prop, fit.toFixed(2));
  }
}

/**
 * Sceglie la disposizione del pannello della domanda per il round corrente.
 * Si misura coi vassoi degli avatar già occupati da una fila (`.is-fitting`):
 * a round chiuso le pedine fanno crescere le carte, e la disposizione va
 * scelta per allora, non cambiata a metà parata con gli avatar in volo.
 */
function fitQuestionLayout() {
  const panel = els.panels.question;
  panel.classList.remove('is-split');
  panel.style.removeProperty('--q-fit');
  panel.style.removeProperty('--o-fit');
  if (panel.hidden) return;

  // Un minigioco ha la sua scena, che si dimensiona da sé sul palco: niente
  // da misurare. Se ha le carte delle scelte, stanno in colonna a destra e il
  // palco si prende tutta l'altezza — sotto la scena, in una fascia, le carte
  // lasciavano un palco basso e larghissimo con la mossa piccola in mezzo.
  if (panel.classList.contains('is-minigame')) {
    panel.classList.toggle('is-split', !panel.classList.contains('is-stage-only'));
    // La colonna dei giocatori si misura solo ora che ha la sua colonna.
    if (panel.classList.contains('has-roster')) fitRoster();
    return;
  }

  panel.classList.add('is-fitting');
  try {
    if (!questionCardOverflows()) return;
    panel.classList.add('is-split');
    shrinkToFit('--q-fit', questionCardOverflows);
    shrinkToFit('--o-fit', questionOptionsOverflow);
  } finally {
    panel.classList.remove('is-fitting');
  }
}

// Il font del titolo può arrivare dopo la prima domanda e cambiarne l'altezza;
// la finestra cambia misura solo sul desktop di sviluppo, ma costa poco.
window.addEventListener('resize', fitQuestionLayout);
window.addEventListener('resize', fitLobbyStrip);
document.fonts?.ready.then(fitQuestionLayout);

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
    AvatarSprite.fill(seat, avatarId);
    seat.title = answer.nickname ?? '';
    tray.appendChild(seat);
  }

  const from = els.paradeAvatar.getBoundingClientRect();
  const to = seat.getBoundingClientRect();
  if (from.width === 0 || to.width === 0) { seat.classList.remove('is-incoming'); return; }

  const flyer = document.createElement('span');
  flyer.className = 'sala-flying-avatar';
  AvatarSprite.fill(flyer, avatarId);
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
      AvatarSprite.fill(els.paradeAvatar, avatarId);
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

/** Un gruppo nuovo della scena degli esiti ogni tanto: abbastanza per leggerlo. */
const OUTCOME_GROUP_STEP_MS = 700;
/** Durata della scena degli esiti, poi la classifica. */
const OUTCOME_SCENE_MS = 4500;

/**
 * Dopo la ruota: la colonna dei giocatori si ridivide per esito, un gruppo alla
 * volta (prima chi ha battuto il computer), con i punti presi. Chi ha battuto
 * il computer si vede subito, senza fare i conti mossa per mossa — e anche chi
 * in classifica non entra fra i primi trova il proprio esito sullo schermo.
 */
function runOutcomeScene(results, token, onDone) {
  // "Gli stessi posti" della scelta: chi era seduto alla chiusura. Chi ha
  // lasciato la partita prima del round non finisce fra chi non ha scelto.
  const seatedIds = AnswerRoster
    .seatsForRound(currentPlayers, (results.answers ?? []).map((a) => a.playerId))
    .map((s) => s.id);
  const groups = AnswerRoster.outcomeGroups(results, seatedIds);
  // La colonna si allarga e il palco, che ormai mostra solo la mossa del
  // computer, si stringe: i gruppi hanno bisogno di righe in più.
  els.panels.question.classList.add('is-outcome');
  els.roster.hidden = false;
  els.roster.classList.add('is-outcome');
  els.rosterCount.textContent = 'Com\'è andata';
  // Nei gruppi i posti sono compatti e vanno a capo da soli: la misura la
  // trova `fitRoster`, partendo dalla più grande.
  sizeRoster(groups.reduce((n, g) => n + g.players.length, 0));

  // Tutti i gruppi subito, ancora invisibili: la misura va presa sulla scena
  // completa, o la colonna cambierebbe taglia a ogni gruppo che entra.
  els.rosterSeats.innerHTML = '';
  const items = groups.map((group) => {
    const li = document.createElement('li');
    li.className = `sala-roster-group is-${group.outcome} is-pending`;
    const title = document.createElement('p');
    title.className = 'sala-roster-group-title';
    title.textContent = `${group.label} · +${group.points}`;
    const seats = document.createElement('ul');
    seats.className = 'sala-roster-group-seats';
    for (const player of group.players) seats.appendChild(buildRosterSeat(player));
    li.append(title, seats);
    els.rosterSeats.appendChild(li);
    return li;
  });
  // Qui il nome serve più che durante la scelta: è il modo di ritrovarsi fra
  // venti facce. Si tiene finché rimpicciolendo ci sta, e si toglie solo se
  // nemmeno alla misura minima la scena entra nella colonna.
  els.roster.classList.remove('is-crowded');
  fitRoster();
  if (els.rosterSeats.scrollHeight > els.rosterSeats.clientHeight + 1) {
    els.roster.classList.add('is-crowded');
    fitRoster();
  }

  // Movimento ridotto: i gruppi compaiono già fatti, tutti insieme.
  const step = reducedMotion() ? 0 : OUTCOME_GROUP_STEP_MS;
  items.forEach((li, i) => {
    sceneWait(() => {
      if (AudioLogic.isStale(token, phaseToken)) return;
      li.classList.remove('is-pending');
      if (step > 0 || i === 0) SalaAudio.sfx(groups[i].outcome === 'win' ? 'reveal' : 'avatar-land');
    }, i * step);
  });

  sceneWait(() => {
    if (AudioLogic.isStale(token, phaseToken)) return;
    onDone();
  }, Math.max(OUTCOME_SCENE_MS, groups.length * OUTCOME_GROUP_STEP_MS + 1500));
}

/** Sequenza completa: parata → verdetto → classifica. */
function runResultsScene(results, token) {
  // "Scegli l'opzione corretta prima che scada il tempo" non ha più senso: il
  // tempo è scaduto. La domanda resta, l'istruzione no.
  els.questionHint.hidden = true;
  // Minigioco con la colonna dei giocatori: niente carte né parata, la colonna
  // si ridivide per esito e poi si va alla classifica.
  if (currentMinigame?.salaPlayers === true) {
    runOutcomeScene(results, token, () => renderResults(results, token));
    return;
  }
  // Minigioco tutto palco: non ci sono carte su cui far posare gli avatar né
  // risposte da timbrare, e l'esito l'ha già raccontato la scena. Dritti
  // alla classifica.
  if (currentMinigame?.salaOptions === false) {
    renderResults(results, token);
    return;
  }
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
  AvatarSprite.fill(avatar, row.avatar);

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
  // Sopra la classifica di un minigioco tutto palco non si ripete l'esito:
  // la scena l'ha già mostrato, livello per livello.
  // Un round saltato non ha esito: nessuna riga di reveal, qualunque minigioco sia.
  const stageOnly = isMinigame
    && (currentMinigame?.salaOptions === false || Boolean(results.skipped));
  els.reveal.hidden = stageOnly;
  // La classifica è della partita: se suonava la colonna sonora di un
  // minigioco, qui finisce e torna il tema del quiz.
  SalaAudio.music(AudioLogic.MUSIC.quiz);

  if (stageOnly) {
    els.reveal.textContent = '';
  } else if (isMinigame && currentMinigame) {
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
// La recita la scena 3D di `/shared/podium-ceremony.js`, a tutto schermo su uno
// strato proprio (`#sala-podium-layer`): il 3° e il 2° salgono sul podio, poi
// il 1° con la coppa, mentre dal 4° in giù fanno da pubblico intorno al palco.
// La durata la detta `/shared/final-schedule.js`, lo stesso calendario che il
// server legge per liberare i telefoni — vedi il commento in testa a quel file
// per il perché non si usa un timestamp assoluto.
//
// Il podio 2D qui sotto resta come ripiego: movimento ridotto, three.js o
// WebGL non disponibili. Una sala davanti a uno schermo vuoto a fine serata è
// il guaio peggiore che possa capitare.

/** I momenti sonori della scena 3D, sui suoni della sala. Quelli assenti tacciono. */
const PODIUM_CUE_SFX = Object.freeze({
  bronze_3rd: 'reveal',
  silver_2nd: 'reveal',
  drumroll_1st: 'suspense',
  trophy_fanfare: 'winner',
});

/** Un gradino del podio 2D (il ripiego). */
function buildPodiumStep(p, rank) {
  const step = document.createElement('div');
  step.className = `sala-podium-step rank-${rank}`;

  const medal = document.createElement('span');
  medal.className = 'medal';
  medal.textContent = RANK_MEDALS[rank - 1];

  const av = document.createElement('span');
  av.className = 'avatar fc-avatar';
  AvatarSprite.fill(av, p.avatar);

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

/** Il podio 2D, fermo: il ripiego quando la scena 3D non può partire. */
function renderFinalFrame(leaderboard) {
  els.finalList.innerHTML = '';
  els.podium.innerHTML = '';
  for (const p of leaderboard.slice(0, 3)) {
    els.podium.appendChild(buildPodiumStep(p, p.rank));
  }
  fitPodiumNames(els.podium);
  els.podium.classList.add('is-settled');
}

/** Il giocatore come lo vuole la scena 3D: nome, posto, colore, espressione e outfit. */
function podiumPlayer(p) {
  const parsed = AvatarCatalog.parse(p.avatar);
  return {
    id: p.id,
    name: p.nickname,
    rank: p.rank,
    skinColor: parsed ? parsed.color.hex : '#d4d2ea',
    expression: parsed ? parsed.face.id : 'happy',
    outfit: parsed ? parsed.outfit.id : 'classic',
  };
}

/**
 * @param {Array} entries classifica. `game:final` la manda già ordinata e con
 *   `rank`; `game:snapshot` porta invece `getPlayers()`, che è grezzo — non
 *   ordinato e senza `rank`. Si normalizza qui una volta sola, così il podio è
 *   corretto da qualunque delle due strade arrivi.
 * @param {{ animate?: boolean }} [opts] `animate: false` (la sala si riallinea
 *   a premiazione già avvenuta) apre la scena direttamente sul gran finale.
 */
function renderFinal(entries, { animate = true } = {}) {
  const token = newPhase();
  stopCountdown();
  // La premiazione ha il suo tema, che prende il posto di qualunque cosa
  // stesse suonando: il quiz, o la colonna sonora di un minigioco saltato
  // dall'host come ultimo round.
  SalaAudio.music(AudioLogic.MUSIC.final);

  const leaderboard = entries
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  els.podium.innerHTML = '';
  els.podium.classList.remove('is-settled');
  els.finalList.innerHTML = '';
  showPanel('final');

  if (leaderboard.length === 0) return;

  // Il movimento ridotto va gestito QUI e non nel CSS: la scena 3D anima
  // all'infinito, e nessuna media query la ferma.
  if (reducedMotion() || !window.PodiumCeremony) {
    renderFinalFrame(leaderboard);
    return;
  }

  playPodium3D(leaderboard, { animate, token });
}

/**
 * La scena 3D. `animate: false` parte dal gran finale: niente proclamazione
 * rigiocata davanti a gente che sta uscendo, e quindi nessun suono.
 */
function playPodium3D(leaderboard, { animate, token }) {
  const stage = document.createElement('div');
  stage.className = 'sala-podium-stage';
  els.podiumLayer.replaceChildren(stage);

  PodiumCeremony.play(stage, {
    players: leaderboard.map(podiumPlayer),
    durationMs: FinalSchedule.DURATION_MS,
    startU: animate ? 0 : 1,
    onCue: (cue) => {
      if (AudioLogic.isStale(token, phaseToken)) return;
      const sfx = PODIUM_CUE_SFX[cue];
      if (sfx) SalaAudio.sfx(sfx);
    },
    onError: () => {
      if (AudioLogic.isStale(token, phaseToken)) return;
      stopPodium3D();
      renderFinalFrame(leaderboard);
    },
  });
}

/**
 * Chiude la scena 3D e libera il suo contesto WebGL. Finita la cerimonia la
 * scena resta in festa all'infinito: è OGNI cambio di fase a spegnerla.
 */
function stopPodium3D() {
  window.PodiumCeremony?.stopAll();
  els.podiumLayer.replaceChildren();
}

// ─── Socket ──────────────────────────────────────────────────────────────────

// Nessun token nell'handshake: è ciò che rende questo client di sola lettura.
const socket = io('/');

socket.on('connect', () => {
  setIdle('In attesa dell\'host…', { guide: true });
});

socket.on('disconnect', () => {
  newPhase();
  stopCountdown();
  setIdle('Connessione persa. Riconnessione in corso…');
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
  currentPlayers = snap.players ?? [];
  rosterLive = false;
  renderProgress(snap.currentQuestionIndex, snap.totalQuestions);
  // Lo snapshot arriva solo se una partita esiste: se il Pi si è riavviato a
  // metà evento, la musica riprende insieme alla schermata, col tema della
  // fase in cui si è (lobby, quiz o premiazione).
  SalaAudio.music(AudioLogic.musicForState(snap.state));

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
  setIdle(snap.state === 'RESULTS'
    ? 'Risultati del round…'
    : `Round ${(snap.currentQuestionIndex ?? 0) + 1} in corso…`);
  showPanel('idle');
});

socket.on('game:lobby-update', ({ players, state }) => {
  // Il server lo manda anche a partita in corso, a ogni telefono che si
  // disconnette o rientra (uno schermo che si spegne basta). Prima la sala
  // tornava alla lobby nel mezzo di un round: scena del minigioco, cronometro
  // e reveal spariti dal proiettore. Fuori dalla lobby si aggiorna solo il
  // conteggio; `state` assente vale come lobby, per un server più vecchio.
  currentPlayers = players;
  if (state && state !== 'LOBBY') {
    lastPlayerCount = players.length;
    // Un telefono che cade a metà scelta lascia il posto (se non aveva
    // ancora scelto): la colonna segue chi c'è davvero.
    if (rosterLive) renderRoster();
    return;
  }
  newPhase();
  stopCountdown();
  // La musica della lobby accompagna l'attesa finché la partita non parte:
  // `music()` sulla traccia già in riproduzione è un no-op, quindi ricevere
  // venti lobby-update di fila non la fa ripartire da capo.
  SalaAudio.music(AudioLogic.MUSIC.lobby);
  // L'effetto è legato alla crescita della lista, non all'evento: lo stesso
  // broadcast arriva anche quando qualcuno esce.
  if (players.length > lastPlayerCount) SalaAudio.sfx('player-joined');
  lastPlayerCount = players.length;
  renderLobby(players);
  showPanel('lobby');
});

socket.on('game:question', (q) => renderQuestion(q));

/**
 * Qualcuno ha scelto. Arriva per ogni risposta, umana o dei bot, con gli id di
 * tutti quelli che hanno già scelto: mai cosa. Conta solo se il round in corso
 * ha la colonna dei giocatori.
 */
/**
 * Minigiochi a carte private: un gruppo si è appena completato. Lo racconta il
 * minigioco (es. la striscia dei "salvati"), se sa come; la sala non sa chi
 * fosse in coppia con chi, e non le serve.
 */
socket.on('game:groups-completed', ({ roundIndex, groups } = {}) => {
  if (roundIndex !== currentRoundIndex || !Array.isArray(groups)) return;
  currentMinigame?.sala.onGroupsCompleted?.(minigameEls(), groups, {
    players: currentPlayers,
    sfx: minigameSfx(currentMinigame.type),
  });
});

socket.on('game:answer-count', ({ playerIds } = {}) => {
  if (!rosterLive || !Array.isArray(playerIds)) return;
  const before = new Set(rosterAnswered);
  const fresh = playerIds.filter((id) => !before.has(id));
  rosterAnswered = playerIds;
  renderRoster(fresh);
  const now = Date.now();
  if (fresh.length > 0 && now - lastRosterSfxAt >= ROSTER_SFX_GAP_MS) {
    lastRosterSfxAt = now;
    SalaAudio.sfx('avatar-land');
  }
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
  // Il round è chiuso: nessuna risposta in più nella colonna, che resta ferma
  // finché non la riprende la scena degli esiti.
  rosterLive = false;

  // Round saltato dall'host: niente da rivelare né da festeggiare, e nessun
  // rullo di tamburi che prometta un esito. Dritti alla classifica.
  if (results.skipped) {
    renderResults(results, token);
    return;
  }

  SalaAudio.sfx('suspense');

  const startScene = () => {
    // Se nel frattempo è arrivata un'altra fase, questa scena è vecchia.
    if (AudioLogic.isStale(token, phaseToken)) return;
    // Livello intermedio di un minigioco a più round: niente parata né
    // classifica, il server riparte da solo col livello successivo. Resta a
    // schermo il verdetto del reveal; la scena completa arriva dopo l'ultimo.
    const stage = results.stage;
    if (stage && stage.index < stage.count - 1) return;
    runResultsScene(results, token);
  };

  if (results.revealAt && currentMinigame?.sala.playReveal) {
    currentMinigame.sala.playReveal(minigameEls(), results, currentOptions, {
      revealAt: ServerClock.localDeadline(results.revealAt, results.serverNow),
      isStale: () => AudioLogic.isStale(token, phaseToken),
      sfx: minigameSfx(results.minigameType),
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
  rosterLive = false;
});

socket.on('game:blur-update', ({ blur }) => {
  setMediaBlur(blur);
});

socket.on('game:timer-paused', ({ remainingMs }) => {
  pauseCountdown(remainingMs);
});

socket.on('game:timer-resumed', ({ endsAt, serverNow }) => {
  resumeCountdown(endsAt, serverNow);
});

socket.on('game:ended', () => {
  newPhase();
  stopCountdown();
  rosterLive = false;
  SalaAudio.music(null);   // in dissolvenza: la sala torna in silenzio
  showPanel('ended');
});

// ─── Avvio ───────────────────────────────────────────────────────────────────

// Nessun gesto utente da attendere: sul proiettore non c'è nessuno che clicca.
// Chromium va lanciato con --autoplay-policy=no-user-gesture-required; sul
// desktop di sviluppo, dove il flag non c'è, il contesto nasce sospeso e il
// primo click qualunque lo sblocca (vedi SalaAudio.arm).
// Con `/sala?muto` l'audio non si arma affatto: serve a provare la sala in
// silenzio (la pagina di debug, chi lavora in remote control col PC che suona).
// Non basta non armare: la musica passa da <audio>, e sipario e premiazione
// hanno un sintetizzatore loro. Per questo si azzera anche ognuno di quelli.
if (new URLSearchParams(location.search).has('muto')) {
  SalaAudio.setMuted(true);
  MinigameStageIntro.setMuted(true);
  if (typeof PodiumCeremony !== 'undefined') PodiumCeremony.setMuted(true);
} else {
  SalaAudio.arm();
}
renderGuide(els.guideIdle, 'idle');
renderGuide(els.guideLobby, 'lobby');
loadJoinInfo();
showPanel('idle');
