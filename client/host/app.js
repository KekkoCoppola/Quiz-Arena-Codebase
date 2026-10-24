/**
 * client/host/app.js
 *
 * SPA Pannello Host — Quiz-Zata!
 *
 * Moduli interni (tutti in questo file, nessun bundler):
 *   1. Config & State
 *   2. Toast System
 *   3. Modal System
 *   4. API Client
 *   5. Auth Module
 *   6. Router (View Manager)
 *   7. Dashboard Module
 *   8. Editor Quiz Module (con Drag & Drop nativo HTML5)
 *   9. Game Module
 *  10. Init
 */

'use strict';

/* global io */

/* ═══════════════════════════════════════════════════════════════════════════
   1. CONFIG & STATE
   ═══════════════════════════════════════════════════════════════════════════ */

const API_BASE      = '/api/host';
const TOKEN_KEY     = 'quizzata_token';
const MAX_QUESTIONS = 20;

const state = {
  token:         null,   // JWT string
  user:          null,   // { id, username }
  quizzes:       [],     // quiz personali
  preloaded:     [],     // quiz di sistema
  currentQuiz:   null,   // quiz aperto in game view
  editingId:     null,   // id del quiz in modifica (null = nuovo)
  // Domande nell'editor. Ogni domanda può avere `_minigameAfter: string|null`,
  // campo client-only (non fa parte dello schema quiz) che marca "inserisci un
  // minigioco di questo tipo subito dopo questa domanda": viaggia con l'oggetto
  // durante drag&drop/rimozione, quindi non serve ricalcolare indici a mano.
  // In saveQuiz() viene derivato l'array `minigames` e rimosso dal payload questions.
  questions:     [],
  dragSrcIndex:  null,   // indice item draggato
  editorSnapshot: null,  // JSON di titolo+domande all'apertura editor, per rilevare modifiche non salvate
  // Catalogo minigiochi [{ type, label, description }], caricato da
  // GET /minigames — generato dal registry server. L'editor non elenca mai i
  // tipi a mano: un minigioco nuovo compare qui da solo.
  minigames:     [],

  /**
   * Peso in KB delle immagini caricate, per hash.
   *
   * Sta QUI e non dentro `q.image` perché `validateQuiz` rifiuta le chiavi
   * estranee dentro `image`: un `_kb` lì dentro farebbe fallire il salvataggio.
   * È informazione da interfaccia, non da modello dati.
   * @type {Record<string, number>}
   */
  imageWeights: {},

  /** Indice della domanda che sta aspettando un file, o null. */
  pendingImageQuestion: null,
};

/** Voce sempre presente nel menù minigioco dell'editor. */
const MINIGAME_NONE = '';

/* ═══════════════════════════════════════════════════════════════════════════
   2. TOAST SYSTEM
   ═══════════════════════════════════════════════════════════════════════════ */

const toastContainer = document.getElementById('toast-container');

/**
 * Mostra un toast temporaneo.
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 */
function showToast(message, type = 'info') {
  const ICONS = {
    success: 'check_circle',
    error:   'error',
    info:    'info',
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'alert');
  toast.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${icon(ICONS[type] ?? ICONS.info)}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
    <button class="toast-close" aria-label="Chiudi notifica">${icon('close')}</button>
  `;

  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.addEventListener('click', () => dismissToast(toast));

  toastContainer.appendChild(toast);

  // Auto-dismiss dopo 3.5 secondi
  setTimeout(() => dismissToast(toast), 3500);
}

function dismissToast(toast) {
  if (toast.classList.contains('removing')) return;
  toast.classList.add('removing');
  toast.addEventListener('animationend', () => toast.remove(), { once: true });
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. MODAL SYSTEM
   ═══════════════════════════════════════════════════════════════════════════ */

const modalOverlay = document.getElementById('modal-overlay');
const modalTitle   = document.getElementById('modal-title');
const modalMessage = document.getElementById('modal-message');
const modalIcon    = document.getElementById('modal-icon');
const modalConfirm = document.getElementById('modal-confirm');
const modalCancel  = document.getElementById('modal-cancel');

let _modalConfirmCallback = null;

/**
 * Apre il modale di conferma.
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {string} [opts.icon]  nome di un'icona Material Symbols
 * @param {string} [opts.confirmLabel]
 * @param {Function} opts.onConfirm
 */
function showModal({ title, message, icon: iconName = 'warning', confirmLabel = 'Conferma', onConfirm }) {
  modalIcon.textContent    = iconName;
  modalTitle.textContent   = title;
  modalMessage.textContent = message;
  modalConfirm.textContent = confirmLabel;
  _modalConfirmCallback    = onConfirm;
  modalOverlay.classList.add('active');
  modalCancel.focus();
}

function closeModal() {
  modalOverlay.classList.remove('active');
  _modalConfirmCallback = null;
}

modalCancel.addEventListener('click', closeModal);
modalConfirm.addEventListener('click', () => {
  if (typeof _modalConfirmCallback === 'function') _modalConfirmCallback();
  closeModal();
});
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOverlay.classList.contains('active')) closeModal();
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. API CLIENT
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Wrapper fetch con JWT + gestione 401.
 * @param {string} endpoint  — relativo ad API_BASE (es. '/login')
 * @param {RequestInit} [opts]
 * @returns {Promise<{ success: boolean, data?: any, error?: string }>}
 */
async function apiFetch(endpoint, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;

  const res = await fetch(`${API_BASE}${endpoint}`, { ...opts, headers });

  if (res.status === 401) {
    // Token scaduto o non valido → auto-logout
    logout(false);
    showToast('Sessione scaduta. Effettua nuovamente il login.', 'error');
    return { success: false, error: 'Sessione scaduta.' };
  }

  return res.json();
}

const apiGet    = (ep)          => apiFetch(ep, { method: 'GET' });
const apiPost   = (ep, body)    => apiFetch(ep, { method: 'POST',   body: JSON.stringify(body) });
const apiPut    = (ep, body)    => apiFetch(ep, { method: 'PUT',    body: JSON.stringify(body) });
const apiDelete = (ep)          => apiFetch(ep, { method: 'DELETE' });

/* ═══════════════════════════════════════════════════════════════════════════
   5. AUTH MODULE
   ═══════════════════════════════════════════════════════════════════════════ */

const loginForm     = document.getElementById('login-form');
const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const loginError    = document.getElementById('login-error');
const loginBtn      = document.getElementById('login-btn');
const loginBtnText  = document.getElementById('login-btn-text');
const loginSpinner  = document.getElementById('login-spinner');

function setLoginLoading(loading) {
  loginBtn.disabled        = loading;
  loginBtnText.textContent = loading ? 'Accesso...' : 'Accedi';
  loginSpinner.style.display = loading ? 'block' : 'none';
}

function showLoginError(message) {
  loginError.textContent  = message;
  loginError.style.display = 'block';
  loginUsername.classList.add('error');
  loginPassword.classList.add('error');
  // Rimuovi la classe dopo l'animazione
  setTimeout(() => {
    loginUsername.classList.remove('error');
    loginPassword.classList.remove('error');
  }, 500);
}

function clearLoginError() {
  loginError.style.display = 'none';
  loginError.textContent   = '';
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearLoginError();

  const username = loginUsername.value.trim();
  const password = loginPassword.value;

  if (!username || !password) {
    showLoginError('Inserisci username e password.');
    return;
  }

  setLoginLoading(true);

  try {
    const res = await apiPost('/login', { username, password });
    if (res.success) {
      state.token = res.data.token;
      state.user  = res.data.user;
      localStorage.setItem(TOKEN_KEY, state.token);
      loginPassword.value = '';
      await loadDashboard();
      showView('dashboard');
    } else {
      showLoginError(res.error ?? 'Credenziali non valide.');
    }
  } catch {
    showLoginError('Errore di rete. Controlla la connessione al server.');
  } finally {
    setLoginLoading(false);
  }
});

/**
 * Esegue il logout dell'utente.
 * @param {boolean} [showMessage=true] — mostra toast di conferma
 */
function logout(showMessage = true) {
  state.token  = null;
  state.user   = null;
  state.quizzes   = [];
  state.preloaded = [];
  localStorage.removeItem(TOKEN_KEY);
  showView('login');
  if (showMessage) showToast('Logout effettuato con successo.', 'success');
}

/**
 * Controlla il token in localStorage e valida la sessione.
 * @returns {Promise<boolean>}
 */
async function checkAuth() {
  const savedToken = localStorage.getItem(TOKEN_KEY);
  if (!savedToken) return false;

  state.token = savedToken;
  try {
    const res = await apiGet('/me');
    if (res.success) {
      state.user = res.data.user;
      return true;
    }
  } catch {
    // Ignora errori di rete al bootstrap
  }
  state.token = null;
  localStorage.removeItem(TOKEN_KEY);
  return false;
}

document.getElementById('logout-btn').addEventListener('click', () => {
  showModal({
    title: 'Esci dal pannello',
    message: 'Vuoi davvero effettuare il logout?',
    icon: 'logout',
    confirmLabel: 'Esci',
    onConfirm: () => logout(true),
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. ROUTER (VIEW MANAGER)
   ═══════════════════════════════════════════════════════════════════════════ */

const VIEWS = ['login', 'dashboard', 'editor', 'game'];

/**
 * Mostra una vista SPA, nasconde le altre.
 * @param {'login'|'dashboard'|'editor'|'game'} viewName
 */
function showView(viewName) {
  VIEWS.forEach((name) => {
    const el = document.getElementById(`view-${name}`);
    if (el) {
      el.classList.remove('active');
    }
  });

  const target = document.getElementById(`view-${viewName}`);
  if (target) {
    // Force reflow per far ripartire l'animazione
    void target.offsetWidth;
    target.classList.add('active');
  }

  // Ogni vista parte dall'alto: senza, aprire l'editor da metà dashboard
  // lo mostrerebbe già scorso.
  window.scrollTo(0, 0);

  // Aggiorna navbar se autenticato
  if (viewName !== 'login' && state.user) {
    updateNavbar();
  }
}

function updateNavbar() {
  const usernameEl = document.getElementById('navbar-username');
  if (state.user) {
    usernameEl.textContent = state.user.username;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   7. DASHBOARD MODULE
   ═══════════════════════════════════════════════════════════════════════════ */

const personalGrid  = document.getElementById('personal-quiz-grid');
const preloadedGrid = document.getElementById('preloaded-quiz-grid');
const slotLabel     = document.getElementById('slot-label');

async function loadDashboard() {
  // Carica quiz personali e precaricati in parallelo
  try {
    const [personalRes, preloadedRes] = await Promise.all([
      apiGet('/quizzes'),
      apiGet('/preloaded-quizzes'),
    ]);

    state.quizzes   = personalRes.success  ? personalRes.data.quizzes   : [];
    state.preloaded = preloadedRes.success ? preloadedRes.data.quizzes  : [];
  } catch {
    showToast('Errore nel caricamento dei quiz. Riprova.', 'error');
  }

  renderPersonalSection();
  renderPreloadedSection();
}

/* ── Slot counter ── */
const MAX_PERSONAL_QUIZZES = 3;

function updateSlotCounter(used) {
  slotLabel.textContent = `${used} di ${MAX_PERSONAL_QUIZZES}`;
  slotLabel.classList.toggle('at-limit', used >= MAX_PERSONAL_QUIZZES);
}

/* ── Sezione quiz personali ── */
function renderPersonalSection() {
  const count = state.quizzes.length;
  updateSlotCounter(count);
  personalGrid.innerHTML = '';

  state.quizzes.forEach((quiz) => {
    personalGrid.appendChild(buildQuizCard(quiz, 'personal'));
  });

  // Tessera "Crea nuovo" in fondo alla griglia: dopo i quiz che esistono,
  // non davanti. A limite raggiunto resta visibile e spiega perché è ferma,
  // invece di sparire lasciando l'host a chiedersi dove sia finita.
  const atLimit = count >= MAX_PERSONAL_QUIZZES;
  const newTile = document.createElement('button');
  newTile.type = 'button';
  newTile.className = 'add-tile';
  newTile.disabled = atLimit;
  const label = atLimit ? 'Hai già 3 quiz' : (count === 0 ? 'Crea il tuo primo quiz' : 'Crea nuovo quiz');
  const note  = atLimit ? 'Eliminane uno per crearne un altro' : '';
  newTile.innerHTML = `
    ${icon(atLimit ? 'lock' : 'add')}
    <span class="add-tile-text">
      <span>${label}</span>
      ${note ? `<span class="add-tile-note">${note}</span>` : ''}
    </span>
  `;
  if (!atLimit) newTile.addEventListener('click', () => openEditor(null));
  personalGrid.appendChild(newTile);
}

/* ── Sezione quiz precaricati ── */
function renderPreloadedSection() {
  preloadedGrid.innerHTML = '';

  if (state.preloaded.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      ${icon('inventory_2')}
      <p>Nessun quiz pronto trovato.<br>Aggiungi un file in <code>content/quizzes/</code> e riavvia il server.</p>
    `;
    preloadedGrid.appendChild(empty);
    return;
  }

  state.preloaded.forEach((quiz) => {
    preloadedGrid.appendChild(buildQuizCard(quiz, 'preloaded'));
  });
}

/**
 * Costruisce una quiz card DOM.
 *
 * Una sola azione principale per scheda — "Avvia partita", larga quanto la
 * scheda — perché è quella per cui l'host apre il pannello. Modifica ed
 * Elimina sono secondarie e restano più piccole, sotto.
 *
 * @param {object} quiz
 * @param {'personal'|'preloaded'} type
 */
function buildQuizCard(quiz, type) {
  const isPersonal   = type === 'personal';
  const questionCount = Array.isArray(quiz.questions) ? quiz.questions.length : 0;

  const card = document.createElement('article');
  card.className = `quiz-card ${isPersonal ? 'is-personal' : 'is-system'}`;
  card.setAttribute('aria-label', `Quiz: ${quiz.title}`);

  const tagHtml = !isPersonal && quiz.category
    ? `<span class="quiz-card-tag">${escapeHtml(quiz.category)}</span>`
    : '';

  const toolsHtml = isPersonal ? `
    <div class="quiz-card-tools">
      <button class="btn-text" data-action="edit" data-id="${quiz.id}">
        ${icon('edit')} Modifica
      </button>
      <button class="btn-text is-danger" data-action="delete" data-id="${quiz.id}" aria-label="Elimina quiz ${escapeHtml(quiz.title)}">
        ${icon('delete')} Elimina
      </button>
    </div>
  ` : '';

  card.innerHTML = `
    <div class="quiz-card-body">
      <h3 class="quiz-card-title">${escapeHtml(quiz.title)}</h3>
      <p class="quiz-card-meta">
        <span>${icon('help')} ${questionCount} domand${questionCount === 1 ? 'a' : 'e'}</span>
        ${tagHtml}
      </p>
    </div>
    <div class="quiz-card-actions">
      <button class="btn btn-primary btn-block" data-action="play" data-type="${type}" data-id="${quiz.id}">
        ${icon('play_arrow')} Avvia partita
      </button>
      ${toolsHtml}
    </div>
  `;

  // Event delegation sulle azioni
  card.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const id     = parseInt(btn.dataset.id, 10);

    if (action === 'edit') {
      openEditor(id);
    } else if (action === 'play') {
      const quizType = btn.dataset.type;
      const quiz = quizType === 'personal'
        ? state.quizzes.find((q) => q.id === id)
        : state.preloaded.find((q) => q.id === id);
      if (quiz) openGame(quiz, quizType);
    } else if (action === 'delete') {
      const quiz = state.quizzes.find((q) => q.id === id);
      if (quiz) confirmDeleteQuiz(quiz);
    }
  });

  return card;
}

/* ── Elimina quiz ── */
function confirmDeleteQuiz(quiz) {
  showModal({
    title: 'Elimina quiz',
    message: `Vuoi davvero eliminare "${quiz.title}"? Questa azione è irreversibile.`,
    icon: 'delete',
    confirmLabel: 'Elimina',
    onConfirm: async () => {
      try {
        const res = await apiDelete(`/quizzes/${quiz.id}`);
        if (res.success) {
          showToast(`"${quiz.title}" eliminato.`, 'success');
          await loadDashboard();
        } else {
          showToast(res.error ?? 'Errore durante l\'eliminazione.', 'error');
        }
      } catch {
        showToast('Errore di rete. Riprova.', 'error');
      }
    },
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   8. EDITOR QUIZ MODULE
   ═══════════════════════════════════════════════════════════════════════════ */

const editorTitle       = document.getElementById('editor-title');
const quizTitleInput    = document.getElementById('quiz-title-input');
const questionsList     = document.getElementById('questions-list');
const questionsEmpty    = document.getElementById('questions-empty');
const questionCountBadge = document.getElementById('question-count-badge');
const addQuestionBtn    = document.getElementById('add-question-btn');
const editorSaveBtn     = document.getElementById('editor-save-btn');
const editorSaveText    = document.getElementById('editor-save-text');
const editorSaveSpinner = document.getElementById('editor-save-spinner');

const OPTION_LABELS = ['A', 'B', 'C', 'D'];
const TIME_OPTIONS  = [5, 10, 15, 20, 25, 30, 45, 60, 90, 120];

/**
 * Apre la vista editor.
 * @param {number|null} quizId — null per nuovo quiz
 */
/**
 * Carica una volta sola il catalogo dei minigiochi disponibili.
 * Se la chiamata fallisce l'editor resta usabile: il menù mostrerà solo
 * "Nessuno" più i tipi già presenti nel quiz, che vengono comunque conservati.
 */
async function loadMinigameCatalog() {
  if (state.minigames.length > 0) return;
  try {
    const res = await apiGet('/minigames');
    if (res.success) state.minigames = res.data.minigames;
  } catch {
    // Silenzioso: non è un errore che debba bloccare la modifica di un quiz.
  }
}

async function openEditor(quizId) {
  state.editingId = quizId;
  state.questions = [];

  await loadMinigameCatalog();

  if (quizId !== null) {
    // Carica quiz esistente
    try {
      const res = await apiGet(`/quizzes/${quizId}`);
      if (!res.success) {
        showToast('Impossibile caricare il quiz. Riprova.', 'error');
        return;
      }
      const quiz = res.data.quiz;
      quizTitleInput.value = quiz.title;
      state.questions      = quiz.questions.map((q) => ({ ...q }));
      // Riporta gli slot minigioco pianificati (server) sulla domanda che li precede.
      for (const slot of quiz.minigames ?? []) {
        if (state.questions[slot.afterQuestionIndex]) {
          state.questions[slot.afterQuestionIndex]._minigameAfter = slot.type;
        }
      }
      editorTitle.textContent = 'Modifica quiz';
    } catch {
      showToast('Errore di rete. Riprova.', 'error');
      return;
    }
  } else {
    quizTitleInput.value    = '';
    editorTitle.textContent = 'Nuovo quiz';
    // Aggiungi una domanda vuota di default
    state.questions = [createEmptyQuestion()];
  }

  state.editorSnapshot = JSON.stringify({ title: quizTitleInput.value, questions: state.questions });

  renderQuestionList();
  showView('editor');
}

/** true se titolo/domande sono cambiati rispetto all'apertura dell'editor. */
function hasUnsavedEditorChanges() {
  if (state.editorSnapshot == null) return false;
  const current = JSON.stringify({ title: quizTitleInput.value, questions: state.questions });
  return current !== state.editorSnapshot;
}

function createEmptyQuestion() {
  return {
    text:            '',
    options:         ['', '', '', ''],
    correct_index:   0,
    time_limit_s:    20,
    image:           null,
    _minigameAfter:  null,
  };
}

/* ── Render lista domande ── */
function renderQuestionList() {
  questionsList.innerHTML = '';
  const count = state.questions.length;

  // Badge contatore
  questionCountBadge.textContent = `${count} / ${MAX_QUESTIONS}`;
  questionCountBadge.classList.toggle('at-limit', count >= MAX_QUESTIONS);

  // Stato empty
  questionsEmpty.classList.toggle('hidden', count > 0);

  // Pulsante aggiungi
  addQuestionBtn.disabled = count >= MAX_QUESTIONS;

  state.questions.forEach((q, idx) => {
    const item = buildQuestionItem(q, idx);
    questionsList.appendChild(item);
  });
}

/**
 * Costruisce il DOM di una singola domanda nell'editor.
 */
/**
 * `<option>` del menù minigioco di una domanda, costruiti dal catalogo del
 * registry: questo file non nomina mai un minigioco specifico.
 *
 * Se il quiz contiene un tipo assente dal catalogo (catalogo non caricato, o
 * minigioco rimosso da una versione futura) viene aggiunta una voce apposita:
 * salvare il quiz non deve mai cancellare in silenzio una scelta dell'host.
 *
 * @param {string|null} selected tipo attualmente impostato sulla domanda
 */
function minigameOptionsHtml(selected) {
  const current = selected ?? MINIGAME_NONE;
  const known = state.minigames.some((m) => m.type === current);

  const entries = [
    { type: MINIGAME_NONE, label: 'Nessuno' },
    ...state.minigames,
    ...(current !== MINIGAME_NONE && !known
      ? [{ type: current, label: `${current} (non disponibile)` }]
      : []),
  ];

  return entries
    .map((m) => {
      const isSelected = m.type === current ? ' selected' : '';
      const title = m.description ? ` title="${escapeHtml(m.description)}"` : '';
      return `<option value="${escapeHtml(m.type)}"${isSelected}${title}>${escapeHtml(m.label)}</option>`;
    })
    .join('');
}

function buildQuestionItem(q, idx) {
  const item = document.createElement('div');
  item.className = 'question-item';
  item.setAttribute('draggable', 'true');
  item.dataset.index = idx;
  item.setAttribute('role', 'listitem');

  // Genera le righe opzioni
  const optionsHtml = OPTION_LABELS.slice(0, q.options.length).map((letter, oIdx) => {
    const isCorrect = (q.correct_index === oIdx);
    return `
      <div class="option-row ${isCorrect ? 'correct' : ''}" data-option="${oIdx}">
        <span class="option-label-char">${letter}</span>
        <input
          type="text"
          class="form-input"
          placeholder="Risposta ${letter}"
          value="${escapeHtml(q.options[oIdx] ?? '')}"
          data-role="option-text"
          data-q="${idx}"
          data-o="${oIdx}"
          aria-label="Opzione ${letter} domanda ${idx + 1}"
        >
        <div class="option-correct-indicator"
          role="radio"
          aria-checked="${isCorrect}"
          aria-label="Risposta corretta: opzione ${letter}"
          tabindex="0"
          data-role="correct-indicator"
          data-q="${idx}"
          data-o="${oIdx}"
          title="Segna come risposta corretta"
        ></div>
      </div>
    `;
  }).join('');

  // Time options
  const timeOpts = TIME_OPTIONS.map((t) =>
    `<option value="${t}" ${q.time_limit_s === t ? 'selected' : ''}>${t} secondi</option>`
  ).join('');

  // Blocco immagine: bottone se non c'è, pannello con anteprima se c'è.
  // Una domanda senza immagine non paga pixel per una funzione che non usa.
  const weight = q.image ? state.imageWeights[q.image.hash] : null;
  const imageHtml = q.image
    ? `
      <div class="q-image-panel">
        <div class="q-image-preview ${q.image.blur ? 'is-blurred' : ''}" data-role="image-preview" data-q="${idx}">
          <img src="/api/quiz-image/${escapeHtml(q.image.hash)}" alt="">
        </div>
        <div class="q-image-actions">
          <label class="q-image-toggle">
            <input type="checkbox" data-role="image-blur" data-q="${idx}" ${q.image.blur ? 'checked' : ''}>
            <span>Sfoca immagine</span>
          </label>
          ${weight ? `<span class="q-image-weight">${weight} KB</span>` : ''}
          <button type="button" class="btn-text is-danger" data-role="image-remove" data-q="${idx}" title="Rimuovi l'immagine da questa domanda">
            ${icon('delete')} Rimuovi
          </button>
        </div>
      </div>`
    : `
      <button type="button" class="btn btn-secondary btn-sm q-image-add" data-role="image-add" data-q="${idx}">
        ${icon('add_photo_alternate')} Aggiungi immagine
      </button>`;

  item.innerHTML = `
    <div class="question-item-header" data-role="drag-handle">
      <span class="drag-handle" aria-hidden="true" title="Trascina per spostare">${icon('drag_indicator')}</span>
      <span class="question-number">Domanda ${idx + 1}</span>
      <button class="btn btn-danger-ghost btn-sm btn-icon" data-role="remove-q" data-q="${idx}" aria-label="Rimuovi domanda ${idx + 1}" title="Rimuovi questa domanda">
        ${icon('delete')}
      </button>
    </div>
    <div class="question-item-body">
      <div class="form-group">
        <label class="form-label" for="q-text-${idx}">Testo della domanda</label>
        <textarea
          id="q-text-${idx}"
          class="form-textarea"
          placeholder="Scrivi qui la domanda..."
          data-role="q-text"
          data-q="${idx}"
          rows="2"
        >${escapeHtml(q.text)}</textarea>
      </div>
      ${imageHtml}
      <div role="radiogroup" aria-labelledby="q-options-label-${idx}">
        <p class="form-label" id="q-options-label-${idx}">Risposte
          <span class="form-hint">Tocca il cerchio accanto a quella giusta</span>
        </p>
        <div class="options-grid">
          ${optionsHtml}
        </div>
      </div>
      <div class="question-settings">
        <div class="setting-field">
          <label for="q-time-${idx}">${icon('timer')} Tempo per rispondere</label>
          <select
            id="q-time-${idx}"
            class="form-select time-select"
            data-role="q-time"
            data-q="${idx}"
          >${timeOpts}</select>
        </div>
        <div class="setting-field minigame-toggle-row${q._minigameAfter ? ' is-active' : ''}">
          <label for="q-minigame-${idx}">${icon('casino')} Minigioco subito dopo</label>
          <select
            id="q-minigame-${idx}"
            class="form-select"
            data-role="q-minigame-after"
            data-q="${idx}"
          >${minigameOptionsHtml(q._minigameAfter)}</select>
        </div>
      </div>
    </div>
  `;

  attachQuestionEvents(item, idx);
  attachDragEvents(item, idx);

  return item;
}

/** Collega gli event listener agli input di una singola domanda. */
function attachQuestionEvents(item, idx) {
  // Testo domanda
  const textArea = item.querySelector('[data-role="q-text"]');
  textArea.addEventListener('input', () => {
    state.questions[idx].text = textArea.value;
  });

  // Testo opzioni
  item.querySelectorAll('[data-role="option-text"]').forEach((input) => {
    input.addEventListener('input', () => {
      const oIdx = parseInt(input.dataset.o, 10);
      state.questions[idx].options[oIdx] = input.value;
    });
  });

  // Indicatori risposta corretta (click + enter/space)
  item.querySelectorAll('[data-role="correct-indicator"]').forEach((indicator) => {
    const selectCorrect = () => {
      const oIdx = parseInt(indicator.dataset.o, 10);
      state.questions[idx].correct_index = oIdx;
      // Aggiorna visualmente solo le righe opzione di questo item
      item.querySelectorAll('.option-row').forEach((row, rIdx) => {
        const isNowCorrect = rIdx === oIdx;
        row.classList.toggle('correct', isNowCorrect);
        row.querySelector('[data-role="correct-indicator"]').setAttribute('aria-checked', isNowCorrect);
      });
    };
    indicator.addEventListener('click', selectCorrect);
    indicator.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCorrect(); }
    });
  });

  // Tempo limite
  const timeSelect = item.querySelector('[data-role="q-time"]');
  timeSelect.addEventListener('change', () => {
    state.questions[idx].time_limit_s = parseInt(timeSelect.value, 10);
  });

  // Minigioco pianificato dopo questa domanda. Il valore è una chiave del
  // registry (o `random`); stringa vuota = nessun minigioco.
  const minigameSelect = item.querySelector('[data-role="q-minigame-after"]');
  minigameSelect.addEventListener('change', () => {
    const value = minigameSelect.value;
    state.questions[idx]._minigameAfter = value === MINIGAME_NONE ? null : value;
    minigameSelect.closest('.minigame-toggle-row')
      .classList.toggle('is-active', value !== MINIGAME_NONE);
  });

  // Rimuovi domanda
  const removeBtn = item.querySelector('[data-role="remove-q"]');
  removeBtn.addEventListener('click', () => removeQuestion(idx));
}

/* ── Drag & Drop ── */
function attachDragEvents(item, idx) {
  item.addEventListener('dragstart', (e) => {
    state.dragSrcIndex = idx;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', idx);
  });

  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    document.querySelectorAll('.question-item').forEach((el) => el.classList.remove('drag-over'));
  });

  item.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.question-item').forEach((el) => el.classList.remove('drag-over'));
    item.classList.add('drag-over');
  });

  item.addEventListener('dragleave', (e) => {
    if (!item.contains(e.relatedTarget)) {
      item.classList.remove('drag-over');
    }
  });

  item.addEventListener('drop', (e) => {
    e.preventDefault();
    item.classList.remove('drag-over');
    const srcIdx = state.dragSrcIndex;
    const dstIdx = idx;
    if (srcIdx === null || srcIdx === dstIdx) return;

    // Sposta l'elemento nell'array state.questions
    const [moved] = state.questions.splice(srcIdx, 1);
    state.questions.splice(dstIdx, 0, moved);
    state.dragSrcIndex = null;
    renderQuestionList();
  });
}

/* ── Aggiungi / Rimuovi domanda ── */
addQuestionBtn.addEventListener('click', () => {
  if (state.questions.length >= MAX_QUESTIONS) {
    showToast(`Limite massimo di ${MAX_QUESTIONS} domande raggiunto.`, 'error');
    return;
  }
  state.questions.push(createEmptyQuestion());
  renderQuestionList();
  // Scroll all'ultima domanda
  setTimeout(() => {
    const items = questionsList.querySelectorAll('.question-item');
    items[items.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 50);
});

function removeQuestion(idx) {
  if (state.questions.length <= 1) {
    showToast('Il quiz deve avere almeno una domanda.', 'error');
    return;
  }
  state.questions.splice(idx, 1);
  renderQuestionList();
}

/* ── Immagini ── */

/**
 * Ridimensiona e comprime un file immagine in WebP, sotto il tetto di byte.
 *
 * Tutto avviene nel browser: il server non ricomprime perché servirebbe un
 * modulo nativo, escluso dal vincolo di packaging SEA su ARM. La CPU che paga è
 * quella del tablet di chi crea il quiz, in un momento tranquillo, non quella
 * del Raspberry davanti a una sala.
 *
 * @param {File} file
 * @returns {Promise<{ blob: Blob, width: number, height: number }>}
 */
async function compressImage(file) {
  if (file.size > ImageBudget.MAX_INPUT_BYTES) {
    const mb = Math.round(ImageBudget.MAX_INPUT_BYTES / (1024 * 1024));
    throw new Error(`L'immagine supera ${mb} MB.`);
  }

  // `imageOrientation: 'from-image'` NON è opzionale: le foto da telefono
  // arrivano quasi sempre ruotate via EXIF, e senza questo flag finirebbero di
  // lato — un difetto che si manifesta solo con file veri, mai con quelli di
  // prova.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

  // Nessun ritaglio: si scala il lato lungo e si preserva il rapporto, così
  // verticale e orizzontale entrano entrambi. In sala ci pensa object-fit.
  const { width, height } = ImageBudget.targetDimensions(bitmap.width, bitmap.height);

  const canvas = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  let quality = ImageBudget.QUALITY_LADDER[0];
  let blob = await canvasToBlob(canvas, quality);

  // Un browser che non sa produrre WebP restituisce un PNG senza dirlo: il
  // server lo rifiuterebbe con un 415 poco spiegabile, meglio dirlo qui.
  if (blob.type !== 'image/webp') {
    throw new Error('Questo browser non sa produrre immagini WebP.');
  }

  while (blob.size > ImageBudget.MAX_BYTES) {
    const next = ImageBudget.nextQuality(quality);
    if (next === null) break; // pavimento: meglio un file più grande che poltiglia
    quality = next;
    blob = await canvasToBlob(canvas, quality);
  }

  return { blob, width, height };
}

/** `canvas.toBlob` come promessa. */
function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Codifica dell'immagine fallita."))),
      'image/webp',
      quality
    );
  });
}

/**
 * Carica i byte compressi e restituisce il riferimento da mettere sulla domanda.
 *
 * `apiFetch` mette `Content-Type: application/json` di default, ma le opzioni
 * passate vincono sulla base: qui serve `image/webp`, altrimenti
 * `express.raw({ type: 'image/webp' })` lascerebbe il body vuoto.
 *
 * @returns {Promise<{ hash: string, width: number, height: number }>}
 */
async function uploadImage(blob, width, height) {
  const payload = await apiFetch(`/quiz-image?width=${width}&height=${height}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/webp' },
    body: blob,
  });

  if (!payload.success) {
    throw new Error(payload.error ?? "Caricamento dell'immagine fallito.");
  }
  return payload.data;
}

// Input di file unico e condiviso da tutte le domande (in fondo al body
// dell'HTML, prima di questo script). Quale domanda lo stia usando lo dice
// state.pendingImageQuestion.
const imageFileInput = document.getElementById('image-file-input');

// Non esisteva già un punto di delega dei click/change per la lista domande —
// le altre azioni per domanda (rimuovi, risposta corretta, ecc.) sono cablate
// una per una in attachQuestionEvents. Per l'immagine ne registriamo uno
// nuovo, una sola volta: nessun bottone/checkbox aggiunge il proprio listener
// a ogni render, e sopravvive a renderQuestionList() senza bisogno di essere
// ricollegato.
questionsList.addEventListener('click', (e) => {
  const target = e.target;

  // Apre il selettore di file per la domanda che ha chiesto un'immagine.
  const addBtn = target.closest('[data-role="image-add"]');
  if (addBtn) {
    state.pendingImageQuestion = Number(addBtn.dataset.q);
    imageFileInput.value = ''; // così ricaricare lo stesso file riscatena `change`
    imageFileInput.click();
    return;
  }

  const removeBtn = target.closest('[data-role="image-remove"]');
  if (removeBtn) {
    const idx = Number(removeBtn.dataset.q);
    // Il blob resta in DB: potrebbe servire a un'altra domanda. Lo eliminerà la
    // raccolta degli orfani al prossimo avvio, se davvero non lo usa nessuno.
    state.questions[idx].image = null;
    renderQuestionList();
    return;
  }
});

questionsList.addEventListener('change', (e) => {
  const target = e.target;

  const blurToggle = target.closest('[data-role="image-blur"]');
  if (blurToggle) {
    const idx = Number(blurToggle.dataset.q);
    if (state.questions[idx].image) {
      state.questions[idx].image.blur = blurToggle.checked;
      // Si aggiorna solo l'anteprima invece di ridisegnare la lista: un
      // renderQuestionList() qui rifarebbe venti schede e farebbe perdere il
      // testo in corso di scrittura in un'altra domanda.
      const preview = questionsList.querySelector(`[data-role="image-preview"][data-q="${idx}"]`);
      if (preview) preview.classList.toggle('is-blurred', blurToggle.checked);
    }
    return;
  }
});

imageFileInput.addEventListener('change', async () => {
  const file = imageFileInput.files?.[0];
  const idx  = state.pendingImageQuestion;
  state.pendingImageQuestion = null;
  if (!file || idx === null || !state.questions[idx]) return;

  // Riferimento all'OGGETTO domanda, non al suo indice `idx`. Da qui in poi ci
  // sono due `await` (compressione + upload) che su un file grande durano
  // secondi, e in quella finestra l'host può trascinare le domande
  // (attachDragEvents → splice+splice) o eliminarne una (removeQuestion →
  // splice): entrambe spostano o rimuovono elementi dall'array senza che
  // nulla qui lo sappia. Un indice catturato ora, a giochi finiti, potrebbe
  // puntare a una domanda diversa (riordino) o a niente (rimozione). L'oggetto
  // invece è lo stesso identico riferimento ovunque `state.questions` lo
  // sposti: uno `splice` cambia le posizioni, non clona gli elementi.
  // L'identità sopravvive al riordino, la posizione no.
  const question = state.questions[idx];

  // Il bottone diventa inerte: ridimensionare un file da 20MB richiede qualche
  // secondo su un tablet, e senza un segnale l'host clicca di nuovo.
  const btn = questionsList.querySelector(`[data-role="image-add"][data-q="${idx}"]`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Elaborazione…';
  }

  try {
    const { blob, width, height } = await compressImage(file);
    const saved = await uploadImage(blob, width, height);

    // Si cerca l'oggetto per identità, non l'indice per posizione: se nel
    // frattempo la domanda è stata rimossa, `question` non è più dentro
    // l'array (a prescindere da cosa sia finito all'indice `idx` ora) e non va
    // toccato nulla. Senza questo controllo l'immagine finirebbe sulla
    // domanda sbagliata (se un riordino ha messo un'altra domanda su `idx`) o
    // andrebbe persa in silenzio (se `idx` è fuori range).
    if (!state.questions.includes(question)) {
      showToast("La domanda è stata rimossa mentre l'immagine veniva caricata.", 'error');
      renderQuestionList();
      return;
    }

    question.image = { hash: saved.hash, blur: false };
    state.imageWeights[saved.hash] = Math.round(blob.size / 1024);
    renderQuestionList();
    showToast('Immagine caricata.', 'success');
  } catch (err) {
    // Stessa verifica di identità sul fallimento: senza, riassegnare tramite
    // `state.questions[idx]` su una domanda già rimossa lancerebbe qui dentro,
    // FUORI da qualunque try — una promise rejection non gestita che non
    // mostra alcun toast, smentendo il "nessuno stato a metà" sotto. Con
    // `question` la scrittura è sull'oggetto, quindi non lancia mai; la si
    // esegue solo se la domanda è ancora quella del quiz. Nessuno stato a
    // metà: la domanda, se esiste ancora, resta senza immagine.
    if (state.questions.includes(question)) {
      question.image = null;
    }
    renderQuestionList();
    // `fetch` lancia un TypeError generico "Failed to fetch" quando la
    // richiesta non arriva a destinazione (server riavviato a metà
    // caricamento, Pi momentaneamente irraggiungibile): un host non deve
    // leggere un messaggio in inglese pensato per una console di debug. Gli
    // altri errori (415 dal server, quiz pieno, ecc.) arrivano già con un
    // messaggio in italiano e restano intatti.
    const message = err instanceof TypeError && err.message === 'Failed to fetch'
      ? 'Impossibile raggiungere il server. Controlla la connessione e riprova.'
      : err.message;
    showToast(message, 'error');
  }
});

/* ── Salva quiz ── */
function setSaveLoading(loading) {
  editorSaveBtn.disabled = loading;
  editorSaveText.textContent = loading ? 'Salvataggio…' : 'Salva';
  editorSaveSpinner.classList.toggle('hidden', !loading);
}

editorSaveBtn.addEventListener('click', saveQuiz);

async function saveQuiz() {
  const title     = quizTitleInput.value.trim();
  const questions = state.questions;

  // Validazione base lato client
  if (!title) {
    quizTitleInput.classList.add('error');
    setTimeout(() => quizTitleInput.classList.remove('error'), 500);
    showToast('Inserisci un titolo per il quiz.', 'error');
    quizTitleInput.focus();
    return;
  }
  if (questions.length === 0) {
    showToast('Aggiungi almeno una domanda.', 'error');
    return;
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q.text.trim()) {
      showToast(`Domanda ${i + 1}: il testo è obbligatorio.`, 'error');
      return;
    }
    const hasEmpty = q.options.some((o) => !o.trim());
    if (hasEmpty) {
      showToast(`Domanda ${i + 1}: tutte le opzioni devono essere compilate.`, 'error');
      return;
    }
  }

  // Deriva gli slot minigioco pianificati dal flag client-only `_minigameAfter`
  // e ripulisce le domande prima di inviarle (non fa parte dello schema quiz).
  const minigames = [];
  const questionsPayload = questions.map(({ _minigameAfter, ...rest }, idx) => {
    if (_minigameAfter) minigames.push({ afterQuestionIndex: idx, type: _minigameAfter });
    return rest;
  });

  setSaveLoading(true);
  try {
    const body = { title, questions: questionsPayload, minigames };
    const res  = state.editingId !== null
      ? await apiPut(`/quizzes/${state.editingId}`, body)
      : await apiPost('/quizzes', body);

    if (res.success) {
      showToast(
        state.editingId !== null ? 'Quiz aggiornato!' : 'Quiz creato!',
        'success'
      );
      await loadDashboard();
      showView('dashboard');
    } else {
      showToast(res.error ?? 'Errore nel salvataggio. Riprova.', 'error');
    }
  } catch {
    showToast('Errore di rete. Riprova.', 'error');
  } finally {
    setSaveLoading(false);
  }
}

/* ── Pulsanti torna ── */
document.getElementById('editor-back-btn').addEventListener('click', goBackToDashboard);

function goBackToDashboard() {
  if (hasUnsavedEditorChanges()) {
    showModal({
      title: 'Modifiche non salvate',
      message: 'Hai modifiche non salvate su questo quiz. Vuoi uscire senza salvare?',
      icon: 'warning',
      confirmLabel: 'Esci senza salvare',
      onConfirm: () => showView('dashboard'),
    });
    return;
  }
  showView('dashboard');
}

/* ═══════════════════════════════════════════════════════════════════════════
   9. GAME MODULE (Step 6 — cablaggio minimo, design in Step 7)
   ═══════════════════════════════════════════════════════════════════════════ */

const gameQuizTitle     = document.getElementById('game-quiz-title');
const gameQuestionCount = document.getElementById('game-question-count');
const gameTypeBadge     = document.getElementById('game-type-badge');
const gameStatusText    = document.getElementById('game-status-text');
const gameTimerBadge    = document.getElementById('game-timer-badge');

const gameLobbyBox         = document.getElementById('game-lobby-box');
const gamePlayerCount      = document.getElementById('game-player-count');
const gamePlayersList      = document.getElementById('game-players-list');
const gameQuestionBox      = document.getElementById('game-question-box');
const gameQuestionText     = document.getElementById('game-question-text');
const gameOptionsList      = document.getElementById('game-options-list');
const gameAnswerCount      = document.getElementById('game-answer-count');
const gameResultsBox       = document.getElementById('game-results-box');
const gameCorrectAnswer    = document.getElementById('game-correct-answer');
const gameDistribution     = document.getElementById('game-distribution');
const gameFinalBox         = document.getElementById('game-final-box');
const gameFinalLeaderboard = document.getElementById('game-final-leaderboard');

const gameJoinUrl            = document.getElementById('game-join-url');
const gameQr                 = document.getElementById('game-qr');
const gamePartialLeaderboard = document.getElementById('game-partial-leaderboard');
const gameFinalPodium        = document.getElementById('game-final-podium');

const gameStartBtn    = document.getElementById('game-start-btn');
const gameNextBtn     = document.getElementById('game-next-btn');
const gameMinigameBtn = document.getElementById('game-minigame-btn');
const gameRestartBtn  = document.getElementById('game-restart-btn');

const viewGame        = document.getElementById('view-game');
const gameNextLabel   = document.getElementById('game-next-label');
const gameProgressBar = document.getElementById('game-progress-bar');
const gameAnswerBar   = document.getElementById('game-answer-bar');
const gameDock        = document.querySelector('.game-dock');
const gameBar         = document.querySelector('.game-bar');

let gameSocket = null;
let gameCountdownInterval = null;
let currentQuestionOptions = [];

/* global Minigames */

// Presentazione del minigioco del round corrente, ottenuta dal registry
// condiviso (/shared/minigames/). Questo file non sa quali minigiochi esistano
// né come si disegnano: chiede al registry e delega.
// `Minigames.get()` non restituisce mai null — un tipo sconosciuto ottiene una
// presentazione generica, così un round anomalo degrada invece di rompersi.
let currentMinigame = null;

/** Elementi che la presentazione host può disegnare durante un round minigioco. */
const minigameEls = () => ({
  questionText:  gameQuestionText,
  correctAnswer: gameCorrectAnswer,
});

/** Ferma un'eventuale animazione di attesa. Idempotente, sicura da chiamare sempre. */
function stopMinigameSuspense() {
  currentMinigame?.sala.stopSuspense();
}

// Mappa avatar: id stabile → emoji TEMPORANEA (identica al client player).
const GAME_AVATARS = {
  volpe: '🦊', panda: '🐼', rana: '🐸', polpo: '🐙',
  leone: '🦁', pinguino: '🐧', koala: '🐨', tigre: '🐯',
  unicorno: '🦄', gufo: '🦉', granchio: '🦀', balena: '🐳',
};
const gameAvatarOf = (id) => GAME_AVATARS[id] ?? '❓';

/* global qrcode */

/** Carica l'URL LAN e disegna il QR nella lobby (una volta per partita). */
async function loadJoinInfo() {
  gameQr.innerHTML = '';
  gameJoinUrl.textContent = '';
  try {
    const res = await apiFetch('/game/join-info');
    const url = res.data.url;
    gameJoinUrl.textContent = url;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    gameQr.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch {
    // Fallback: solo testo, il QR non è indispensabile.
    gameJoinUrl.textContent = `http://${location.hostname}:${location.port || 80}`;
  }
}

/**
 * Fase della schermata di partita, letta dal CSS (`data-phase`) per decidere
 * quali comandi mostrare: un bottone che ora non si può premere non c'è,
 * invece di restare lì spento a confondere.
 */
const GAME_PHASE_OF_BOX = new Map([
  [gameLobbyBox,    'lobby'],
  [gameQuestionBox, 'question'],
  [gameResultsBox,  'results'],
  [gameFinalBox,    'final'],
]);

/** Mostra un solo box dell'area live alla volta. */
function showGameBox(box) {
  for (const el of [gameLobbyBox, gameQuestionBox, gameResultsBox, gameFinalBox]) {
    el.hidden = el !== box;
  }
  viewGame.dataset.phase = GAME_PHASE_OF_BOX.get(box) ?? 'lobby';
}

/** Barra di avanzamento sotto la testata: round corrente sul totale. */
function setGameProgress(done, total) {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  gameProgressBar.style.width = `${pct}%`;
}

function stopGameCountdown() {
  if (gameCountdownInterval) {
    clearInterval(gameCountdownInterval);
    gameCountdownInterval = null;
  }
  gameTimerBadge.textContent = '00:00';
  gameTimerBadge.classList.remove('is-urgent');
}

function startGameCountdown(endsAt, serverNow) {
  const deadline = ServerClock.localDeadline(endsAt, serverNow);
  stopGameCountdown();
  const tick = () => {
    const remaining = Math.ceil(ServerClock.remainingMs(deadline) / 1000);
    const m = String(Math.floor(remaining / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    gameTimerBadge.textContent = `${m}:${s}`;
    gameTimerBadge.classList.toggle('is-urgent', remaining > 0 && remaining <= 5);
    if (remaining === 0) stopGameCountdown();
  };
  tick();
  gameCountdownInterval = setInterval(tick, 250);
}

/**
 * Apre la schermata di conduzione partita e crea la sessione sul server.
 * @param {object} quiz
 * @param {'personal'|'preloaded'} type
 */
function openGame(quiz, type) {
  state.currentQuiz = quiz;

  const count = Array.isArray(quiz.questions) ? quiz.questions.length : 0;

  gameQuizTitle.textContent     = quiz.title;
  gameQuestionCount.textContent = `${count} domand${count === 1 ? 'a' : 'e'}`;
  gameTypeBadge.textContent = type === 'preloaded'
    ? (quiz.category ?? 'Quiz pronto')
    : 'Quiz personale';

  // Stato iniziale della schermata: nessuna fase a schermo finché il server
  // non conferma la lobby, ma i comandi sono già quelli della lobby.
  for (const el of [gameLobbyBox, gameQuestionBox, gameResultsBox, gameFinalBox]) el.hidden = true;
  viewGame.dataset.phase = 'lobby';
  gameStatusText.textContent = 'Connessione al server di gioco…';
  gameStartBtn.disabled = true;
  setGameProgress(0, 0);

  loadJoinInfo();
  connectGameSocket(quiz, type);
  showView('game');
}

function connectGameSocket(quiz, type) {
  disconnectGameSocket();

  gameSocket = io('/', { auth: { token: state.token } });

  gameSocket.on('connect', () => {
    gameSocket.emit('host:create-game', { quizId: quiz.id, quizType: type }, (res) => {
      if (!res.ok) {
        showToast(res.error, 'error');
        gameStatusText.textContent = `Errore: ${res.error}`;
        return;
      }
      gameStatusText.textContent = 'Lobby aperta: i giocatori possono entrare dal telefono.';
      renderGameLobby([]);
    });
  });

  gameSocket.on('game:lobby-update', ({ players }) => renderGameLobby(players));

  gameSocket.on('game:question', (q) => {
    currentQuestionOptions = q.options;
    stopMinigameSuspense();
    const isMinigame = q.kind === 'minigame';
    // Il round minigioco porta con sé la propria presentazione; una domanda no.
    currentMinigame = isMinigame ? Minigames.get(q.minigameType) : null;

    gameQuestionBox.classList.toggle('is-minigame', isMinigame);
    gameStatusText.textContent = isMinigame
      ? currentMinigame.hostStatusText
      : `Domanda ${q.index + 1} di ${q.total} in corso…`;

    // Minigioco: il titolo è affidato alla sua animazione di attesa; la domanda
    // vera mostra semplicemente il proprio testo.
    if (isMinigame) {
      currentMinigame.sala.startSuspense(minigameEls(), q);
    } else {
      gameQuestionText.textContent = q.text;
    }

    // Opzioni a solo scopo visualizzativo: l'host non risponde. Il minigioco può
    // sostituire la lettera A/B/C con una propria icona.
    gameOptionsList.innerHTML = '';
    const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
    q.options.forEach((option, i) => {
      const li = document.createElement('li');
      li.className = 'game-option-card';
      const letter = document.createElement('span');
      letter.className = 'game-option-letter';
      const icon = currentMinigame?.optionIcon(i);
      if (icon) {
        letter.appendChild(icon);
      } else {
        letter.textContent = LETTERS[i] ?? String(i + 1);
      }
      const label = document.createElement('span');
      label.textContent = option;
      li.append(letter, label);
      gameOptionsList.appendChild(li);
    });
    gameAnswerCount.textContent = 'Risposte: 0 / ?';
    gameAnswerBar.style.width = '0%';
    setGameProgress(q.index + 1, q.total);
    startGameCountdown(q.endsAt, q.serverNow);
    showGameBox(gameQuestionBox);
    gameStartBtn.disabled = true;
    gameNextBtn.disabled = true;
    gameMinigameBtn.disabled = true;
    gameRestartBtn.disabled = true;
  });

  gameSocket.on('game:answer-count', ({ answered, total }) => {
    gameAnswerCount.textContent = `Risposte: ${answered} / ${total}`;
    gameAnswerBar.style.width = `${total > 0 ? Math.min(100, (answered / total) * 100) : 0}%`;
  });

  gameSocket.on('game:results', (results) => {
    stopGameCountdown();
    stopMinigameSuspense();
    const isMinigame = results.kind === 'minigame';
    gameStatusText.textContent = 'Round chiuso: risultati sul tabellone.';

    // Reveal: la domanda mostra la risposta corretta; il minigioco disegna il
    // proprio (ferma l'attesa e rivela lo stato della macchina). La riga da
    // evidenziare nella distribuzione la decide il minigioco stesso, perché non
    // tutti hanno una nozione di "riga corretta".
    const machineIndex = isMinigame
      ? currentMinigame.highlightIndex(results)
      : results.correctIndex;

    if (isMinigame) {
      currentMinigame.sala.reveal(minigameEls(), results, currentQuestionOptions);
    } else {
      gameCorrectAnswer.textContent =
        `Risposta corretta: ${currentQuestionOptions[results.correctIndex] ?? '—'}`;
    }

    const totalAnswers = results.distribution.reduce((a, b) => a + b, 0);
    gameDistribution.innerHTML = '';
    results.distribution.forEach((n, i) => {
      const li = document.createElement('li');
      // Domanda: evidenzia la riga corretta. Minigioco: evidenzia la mossa del PC.
      li.className = 'game-dist-row' + (i === machineIndex ? ' is-correct' : '');
      const pct = totalAnswers > 0 ? Math.round((n / totalAnswers) * 100) : 0;
      const label = document.createElement('span');
      label.className = 'game-dist-label';
      const optionLabel = currentQuestionOptions[i] ?? `Opzione ${i + 1}`;
      // Stesso segno della domanda (lettera colorata, o icona del minigioco):
      // la riga si riconosce a colpo d'occhio senza rileggere il testo.
      const chip = document.createElement('span');
      chip.className = 'game-option-letter';
      const distIcon = currentMinigame?.optionIcon(i);
      if (distIcon) {
        chip.appendChild(distIcon);
      } else {
        chip.textContent = OPTION_LABELS[i] ?? String(i + 1);
      }
      const text = document.createElement('span');
      text.textContent = optionLabel;
      label.append(chip, text);
      const track = document.createElement('div');
      track.className = 'game-dist-track';
      const bar = document.createElement('div');
      bar.className = 'game-dist-bar';
      bar.style.width = `${Math.max(pct, n > 0 ? 8 : 0)}%`;
      track.appendChild(bar);
      const count = document.createElement('span');
      count.className = 'game-dist-count';
      if (i === machineIndex) count.innerHTML = icon('check');
      count.append(String(n));
      li.append(label, track, count);
      gameDistribution.appendChild(li);
    });

    gamePartialLeaderboard.innerHTML = '';
    results.leaderboard.slice(0, 5).forEach((p, i) => {
      gamePartialLeaderboard.appendChild(buildLeaderboardRow(p, p.rank ?? i + 1));
    });

    // All'ultimo round "avanti" non porta a una domanda ma alla premiazione:
    // il bottone lo dice, così l'host sa cosa sta per comparire in sala.
    gameNextLabel.textContent = results.isLastRound ? 'Classifica finale' : 'Prossima domanda';

    showGameBox(gameResultsBox);
    gameNextBtn.disabled = false;
    gameMinigameBtn.disabled = false;
  });

  gameSocket.on('game:final', ({ leaderboard }) => {
    stopGameCountdown();
    stopMinigameSuspense();
    gameStatusText.textContent = 'Partita conclusa!';
    setGameProgress(1, 1);
    gameFinalPodium.innerHTML = '';
    leaderboard.slice(0, 3).forEach((p, i) => {
      const step = document.createElement('div');
      step.className = `game-podium-step rank-${i + 1}`;
      const medal = document.createElement('span');
      medal.className = 'podium-rank';
      medal.textContent = String(i + 1);
      const av = document.createElement('span');
      av.className = 'avatar';
      av.textContent = gameAvatarOf(p.avatar);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.nickname;
      const points = document.createElement('span');
      points.className = 'points';
      points.textContent = `${p.score} punti`;
      step.append(medal, av, name, points);
      gameFinalPodium.appendChild(step);
    });

    gameFinalLeaderboard.innerHTML = '';
    leaderboard.slice(3).forEach((p, i) => {
      gameFinalLeaderboard.appendChild(buildLeaderboardRow(p, p.rank ?? i + 4));
    });
    showGameBox(gameFinalBox);
    gameNextBtn.disabled = true;
    gameMinigameBtn.disabled = true;
    gameRestartBtn.disabled = false;
  });

  gameSocket.on('connect_error', () => {
    gameStatusText.textContent = 'Connessione al server di gioco fallita.';
    showToast('Connessione al server di gioco fallita.', 'error');
  });
}

function disconnectGameSocket() {
  stopGameCountdown();
  stopMinigameSuspense();
  if (gameSocket) {
    gameSocket.disconnect();
    gameSocket = null;
  }
}

// ─── Giocatori di prova (gesto nascosto) ─────────────────────────────────────
//
// Dieci clic sul logo in cima alla schermata di partita riempiono la lobby di
// giocatori finti. Serve a provare una partita — e soprattutto la premiazione,
// che con tre persone non si vede davvero — senza radunare venti amici.
//
// Il logo è QUESTO e non quello della barra della dashboard: finché una
// partita non esiste non c'è nessuna lobby da riempire. Il logo della
// schermata di partita invece è a schermo esattamente quando serve.
//
// Nascosto e non un bottone perché non è una funzione del prodotto: è un
// attrezzo. Dieci clic ravvicinati non capitano per sbaglio, e chi non sa che
// esiste non lo troverà mai.

const BOT_GESTURE_CLICKS = 10;
/** Oltre questa pausa il conteggio riparte: dieci clic devono essere UNA raffica. */
const BOT_GESTURE_GAP_MS = 1500;

let botGestureCount = 0;
let botGestureLast = 0;

document.querySelector('.game-logo-wrapper')?.addEventListener('click', () => {
  const now = Date.now();
  botGestureCount = now - botGestureLast > BOT_GESTURE_GAP_MS ? 1 : botGestureCount + 1;
  botGestureLast = now;
  if (botGestureCount < BOT_GESTURE_CLICKS) return;
  botGestureCount = 0;
  spawnTestPlayers();
});

function spawnTestPlayers() {
  // Rete di sicurezza: il logo vive dentro la schermata di partita, quindi un
  // socket c'è sempre. Se la partita è già iniziata è il server a rifiutare,
  // spiegando che si entra solo dalla lobby.
  if (!gameSocket) {
    showToast('Apri prima una partita: i giocatori di prova entrano in lobby.', 'info');
    return;
  }
  gameSocket.emit('host:spawn-bots', null, (res) => {
    if (!res?.ok) {
      showToast(res?.error ?? 'Impossibile aggiungere i giocatori di prova.', 'error');
      return;
    }
    showToast(`${res.added} giocatori di prova aggiunti — ${res.total} in lobby.`, 'success');
  });
}

/** Riga di classifica: posizione, avatar, nome, punti. */
function buildLeaderboardRow(p, rank) {
  const li = document.createElement('li');
  li.className = 'lb-row';
  const cells = [
    ['lb-rank',   `${rank}.`],
    ['lb-avatar', gameAvatarOf(p.avatar)],
    ['lb-name',   p.nickname],
    ['lb-score',  `${p.score}`],
  ];
  for (const [cls, text] of cells) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    li.appendChild(span);
  }
  return li;
}

function renderGameLobby(players) {
  gamePlayerCount.textContent = players.length;
  gamePlayersList.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.className = 'game-player-badge' + (p.connected === false ? ' is-disconnected' : '');
    const av = document.createElement('span');
    av.textContent = gameAvatarOf(p.avatar);
    const name = document.createElement('span');
    name.textContent = p.nickname;
    li.append(av, name);
    if (p.connected === false) {
      const off = document.createElement('span');
      off.className = 'material-symbols-outlined';
      off.textContent = 'wifi_off';
      off.setAttribute('aria-label', 'disconnesso');
      li.appendChild(off);
    }
    gamePlayersList.appendChild(li);
  }
  // Cambia vista solo se non c'è una fase di gioco a schermo: il lobby-update
  // arriva anche in partita (es. disconnessioni) e non deve coprire
  // domanda, risultati o podio.
  if (gameQuestionBox.hidden && gameResultsBox.hidden && gameFinalBox.hidden) {
    showGameBox(gameLobbyBox);
  }
  gameStartBtn.disabled = players.length === 0;
}

// ─── Controlli host ──────────────────────────────────────────────────────────

// NB: payload sempre presente (null) prima dell'ack — firma server (_payload, cb).
gameStartBtn.addEventListener('click', () => {
  gameSocket?.emit('host:start-game', null, (res) => {
    if (!res.ok) showToast(res.error, 'error');
  });
});

gameNextBtn.addEventListener('click', () => {
  gameSocket?.emit('host:next-question', null, (res) => {
    if (!res.ok) showToast(res.error, 'error');
  });
});

// Minigioco ad-hoc durante la partita: l'host non sceglie il tipo, lo estrae il
// server dal sacchetto della sessione. Un bottone solo, nessun menù da navigare
// davanti a una sala che aspetta.
gameMinigameBtn.addEventListener('click', () => {
  gameSocket?.emit('host:insert-minigame', { type: 'random' }, (res) => {
    if (!res.ok) showToast(res.error, 'error');
  });
});

gameRestartBtn.addEventListener('click', () => {
  gameSocket?.emit('host:restart-game', null, (res) => {
    if (!res.ok) { showToast(res.error, 'error'); return; }
    gameStatusText.textContent = 'Partita riavviata: giocatori di nuovo in lobby.';
    setGameProgress(0, 0);
    showGameBox(gameLobbyBox);
    gameStartBtn.disabled = false;
    gameRestartBtn.disabled = true;
  });
});

document.getElementById('game-back-btn-2').addEventListener('click', () => {
  showModal({
    title: 'Termina partita',
    message: 'Vuoi davvero terminare la partita e tornare ai quiz? I giocatori collegati verranno disconnessi.',
    icon: 'stop_circle',
    confirmLabel: 'Termina partita',
    onConfirm: () => {
      gameSocket?.emit('host:end-game', null, () => {});
      disconnectGameSocket();
      showView('dashboard');
    },
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   UTILITY
   ═══════════════════════════════════════════════════════════════════════════ */

/** Sfugge caratteri HTML per prevenire XSS nelle interpolazioni. */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Icona Material Symbols (unico sistema di icone del pannello).
 * @param {string} name nome dell'icona, es. 'play_arrow'
 */
function icon(name) {
  return `<span class="material-symbols-outlined" aria-hidden="true">${name}</span>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   MISURE DELLA SCHERMATA DI PARTITA
   Sul telefono il pannello comandi è fisso in basso e la sua altezza cambia
   con la fase (un bottone, due, il contatore risposte): la scena deve
   lasciargli sotto esattamente quello spazio, né di più né di meno.
   ═══════════════════════════════════════════════════════════════════════════ */

if ('ResizeObserver' in window) {
  new ResizeObserver(() => {
    viewGame.style.setProperty('--dock-h', `${gameDock.offsetHeight}px`);
    viewGame.style.setProperty('--game-bar-h', `${gameBar.offsetHeight}px`);
  }).observe(gameDock);
}

/* ═══════════════════════════════════════════════════════════════════════════
   10. INIT
   ═══════════════════════════════════════════════════════════════════════════ */

async function init() {
  const isAuthenticated = await checkAuth();
  if (isAuthenticated) {
    await loadDashboard();
    showView('dashboard');
  } else {
    showView('login');
  }
}

init();
