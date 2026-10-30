'use strict';

/**
 * client/debug/debug.js
 *
 * Pagina di debug dei minigiochi. Un clic su un minigioco:
 *   1. `debug:prepare` — partita nuova con i bot (chiude quella in corso);
 *   2. il telefono finto entra in lobby (la pagina vera del giocatore, in un
 *      iframe della stessa origine, compilata da qui);
 *   3. `debug:play` — la partita parte direttamente dal minigioco.
 * Da lì sala e telefono si muovono da soli; "Salta round" e "Avanti" sono gli
 * stessi comandi del pannello admin.
 *
 * Usa il JWT del pannello admin già salvato in questo browser: la pagina non
 * ha un login suo. Esiste solo con DEBUG_TOOLS=1 (vedi server/debug-tools.js).
 */

/* global io */

/** Chiave del JWT del pannello admin (client/host/app.js, TOKEN_KEY). */
const TOKEN_KEY = 'quizzata_token';
/** Nickname del telefono finto: corto, si legge bene fra i bot. */
const PHONE_NICKNAME = 'Tu';
/** Misure reali delle due pagine, prima della riduzione in scala. */
const SALA_W = 1920;
const PHONE_W = 390;
const PHONE_H = 844;
/** Quanto si aspetta il telefono finto prima di dichiararlo bloccato. */
const PHONE_TIMEOUT_MS = 8000;

const $ = (id) => document.getElementById(id);
const statusEl = $('dbg-status');
const salaFrame = $('dbg-sala');
const phoneFrame = $('dbg-phone');
const skipBtn = $('dbg-skip');
const nextBtn = $('dbg-next');

/** Etichette dei minigiochi per la riga di stato, dal registry. */
const labels = new Map();

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('is-error', isError);
}

// ─── Scala degli iframe ──────────────────────────────────────────────────────

/** La sala e il telefono girano alla loro misura vera, ridotti a riquadro. */
function fitFrames() {
  const salaBox = $('dbg-sala-box');
  salaFrame.style.transform = `scale(${salaBox.clientWidth / SALA_W})`;
  // Il telefono è alto quanto la sala, così stanno su una riga.
  const phoneW = Math.max(220, Math.round(salaBox.clientHeight * (PHONE_W / PHONE_H)));
  document.documentElement.style.setProperty('--phone-w', `${phoneW}px`);
  phoneFrame.style.transform = `scale(${$('dbg-phone-box').clientWidth / PHONE_W})`;
}

new ResizeObserver(fitFrames).observe($('dbg-sala-box'));
window.addEventListener('resize', fitFrames);
fitFrames();

// ─── Telefono finto ──────────────────────────────────────────────────────────

function waitFor(condition, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (condition()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** Ricarica la pagina del giocatore nell'iframe e la fa entrare in lobby. */
async function joinPhone() {
  // La sessione del telefono di una prova precedente (sessionStorage, condiviso
  // fra gli iframe della scheda) farebbe partire un rientro che, rifiutato,
  // butta fuori il telefono subito dopo l'ingresso. Si riparte puliti.
  // Chiave: SESSION_KEY in client/player/app.js.
  try { sessionStorage.removeItem('quizzata-player'); } catch { /* storage bloccato */ }
  await new Promise((resolve) => {
    phoneFrame.onload = resolve;
    phoneFrame.src = '/';
  });
  const doc = () => phoneFrame.contentDocument;
  const shown = (id) => {
    const el = doc()?.getElementById(id);
    return Boolean(el) && !el.hidden;
  };

  if (!await waitFor(() => shown('screen-join') && doc().getElementById('join-btn'), PHONE_TIMEOUT_MS)) {
    throw new Error('Il telefono finto non mostra la schermata d\'ingresso.');
  }
  const input = doc().getElementById('nickname-input');
  input.value = PHONE_NICKNAME;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  doc().getElementById('join-btn').click();

  if (!await waitFor(() => shown('screen-lobby'), PHONE_TIMEOUT_MS)) {
    throw new Error('Il telefono finto non è riuscito a entrare in lobby.');
  }
}

// ─── Socket host ─────────────────────────────────────────────────────────────

let token = null;
try {
  token = localStorage.getItem(TOKEN_KEY);
} catch {
  token = null;
}

if (!token) {
  $('dbg-login').hidden = false;
  setStatus('Nessun accesso admin in questo browser.', true);
} else {
  start(token);
}

function start(authToken) {
  const socket = io('/', { auth: { token: authToken } });
  const emit = (event, payload) => new Promise((resolve) => {
    socket.emit(event, payload ?? null, (res) => resolve(res ?? { ok: false, error: 'Nessuna risposta.' }));
  });

  let busy = false;
  const minigameButtons = [];
  const setBusy = (value) => {
    busy = value;
    for (const btn of minigameButtons) btn.disabled = value;
  };

  async function play(type) {
    if (busy) return;
    setBusy(true);
    try {
      const bots = Number.parseInt($('dbg-bots').value, 10);
      setStatus('Preparo la partita di prova…');
      const prep = await emit('debug:prepare', { bots });
      if (!prep.ok) throw new Error(prep.error);

      setStatus('Il telefono finto entra in partita…');
      await joinPhone();

      setStatus(`Parte ${labels.get(type) ?? type}…`);
      const res = await emit('debug:play', { type });
      if (!res.ok) throw new Error(res.error);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  async function loadMinigames() {
    const res = await emit('debug:minigames');
    if (!res.ok) {
      // Token scaduto o non host: il server l'ha accettato come socket
      // qualunque, e gli eventi host sono rifiutati.
      $('dbg-login').hidden = false;
      setStatus(res.error ?? 'Accesso admin non valido.', true);
      return;
    }
    const box = $('dbg-minigames');
    box.innerHTML = '';
    minigameButtons.length = 0;
    for (const mg of res.list) {
      const isRandom = mg.type === 'random';
      const label = isRandom ? 'Casuale' : mg.label;
      labels.set(mg.type, label);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `dbg-btn ${isRandom ? 'is-random' : 'is-minigame'}`;
      btn.textContent = label;
      btn.title = mg.description ?? '';
      btn.addEventListener('click', () => play(mg.type));
      box.appendChild(btn);
      minigameButtons.push(btn);
    }
    setStatus('Scegli un minigioco da provare.');
  }

  skipBtn.addEventListener('click', async () => {
    const res = await emit('host:skip-round');
    if (!res.ok) setStatus(res.error, true);
  });

  nextBtn.addEventListener('click', async () => {
    const res = await emit('host:next-question');
    if (!res.ok) setStatus(res.error, true);
  });

  let loaded = false;
  socket.on('connect', () => {
    if (loaded) return;
    loaded = true;
    loadMinigames();
  });
  socket.on('connect_error', () => setStatus('Server non raggiungibile.', true));

  // La riga di stato racconta dove si trova la partita di prova.
  socket.on('game:question', (q) => {
    if (q.kind !== 'minigame') {
      setStatus(`Domanda ${q.index + 1}: è finita la parte di prova, premi un minigioco per ricominciare.`);
      return;
    }
    const name = labels.get(q.minigameType) ?? q.minigameType;
    const level = q.stage ? ` — livello ${q.stage.index + 1} di ${q.stage.count}` : '';
    setStatus(`In corso: ${name}${level}`);
  });
  socket.on('game:results', (r) => {
    const last = !r.stage || r.stage.index === r.stage.count - 1;
    setStatus(last ? 'Risultati. "Avanti" porta alla premiazione.' : 'Risultati del livello, il prossimo parte da solo.');
  });
  socket.on('game:final', () => setStatus('Premiazione in corso.'));
}
