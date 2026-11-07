'use strict';

/**
 * client/licenza/app.js
 *
 * La pagina che apre il link di rinnovo (http://192.168.4.1/licenza#QZ1.…):
 * se l'indirizzo porta un codice lo attiva subito, senza login né digitazione;
 * altrimenti mostra lo stato della licenza, il seriale da mandare a chi vende
 * e il bottone "Rinnova su WhatsApp".
 */

const $ = (id) => document.getElementById(id);

const STATE_UI = {
  off:            { badge: 'Non richiesta', tone: 'is-off' },
  active:         { badge: 'Attiva',        tone: 'is-ok' },
  expiring:       { badge: 'In scadenza',   tone: 'is-warn' },
  grace:          { badge: 'Scaduta',       tone: 'is-warn' },
  expired:        { badge: 'Scaduta',       tone: 'is-bad' },
  missing:        { badge: 'Demo',          tone: 'is-bad' },
  'wrong-device': { badge: 'Demo',          tone: 'is-bad' },
};

function formatDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function statusSentence(s) {
  const demoPlayers = s.entitlements?.maxPlayers;
  switch (s.state) {
    case 'off':      return 'Su questo dispositivo la licenza non è richiesta.';
    case 'active':   return `Licenza attiva fino al ${formatDate(s.validUntil)}.`;
    case 'expiring': return `La licenza scade tra ${plural(s.daysLeft, 'giorno', 'giorni')}: rinnovala per non fermarti.`;
    case 'grace':    return `La licenza è scaduta il ${formatDate(s.validUntil)}. Funziona ancora per ${plural(s.graceDaysLeft, 'giorno', 'giorni')}, poi passa alla versione demo.`;
    case 'expired':  return `La licenza è scaduta il ${formatDate(s.validUntil)}: versione demo, al massimo ${demoPlayers} giocatori.`;
    case 'missing':  return `Nessuna licenza attiva: versione demo, al massimo ${demoPlayers} giocatori.`;
    case 'wrong-device': return `La licenza salvata è di un altro Quiz-Zata: versione demo, al massimo ${demoPlayers} giocatori.`;
    default:         return '';
  }
}

function renderStatus(s) {
  const ui = STATE_UI[s.state] ?? STATE_UI.missing;
  const badge = $('status-badge');
  badge.textContent = ui.badge;
  badge.className = `status-badge ${ui.tone}`;
  $('status-text').textContent = statusSentence(s);

  $('row-customer').hidden = !s.customer;
  $('d-customer').textContent = s.customer ?? '';
  $('row-until').hidden = !s.validUntil;
  $('d-until').textContent = formatDate(s.validUntil);
  const ent = s.entitlements ?? {};
  $('d-players').textContent = ent.maxPlayers ? `al massimo ${ent.maxPlayers}` : 'nessun limite';
  $('d-minigames').textContent = ent.minigames === 'all' ? 'tutti' : (ent.minigames ?? []).length;
  $('d-serial').value = s.serial ?? 'non disponibile';
  $('copy-serial').hidden = !s.serial;

  // Rinnovo: il messaggio è già scritto, il cliente deve solo premere invio.
  const renew = $('renew');
  if (s.contact && s.state !== 'off') {
    const lines = [
      'Ciao, vorrei rinnovare la licenza Quiz-Zata.',
      `Seriale: ${s.serial ?? '—'}`,
      s.customer ? `Cliente: ${s.customer}` : null,
      s.validUntil ? `Scadenza attuale: ${formatDate(s.validUntil)}` : null,
    ].filter(Boolean);
    renew.href = `https://wa.me/${s.contact}?text=${encodeURIComponent(lines.join('\n'))}`;
    renew.hidden = false;
  } else {
    renew.hidden = true;
  }

  $('status').hidden = false;
}

async function loadStatus() {
  try {
    const res = await fetch('/api/license').then((r) => r.json());
    if (res.success) renderStatus(res.data);
  } catch {
    $('status-text').textContent = 'Impossibile leggere lo stato della licenza.';
    $('status').hidden = false;
  }
}

async function activate(code) {
  const res = await fetch('/api/license/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }).then((r) => r.json());
  return res;
}

function showActivation(ok, text) {
  const box = $('activation');
  box.className = `card ${ok ? 'is-ok' : 'is-bad'}`;
  $('activation-text').textContent = text;
  box.hidden = false;
}

/** Il codice arriva nel frammento del link: lo si attiva e lo si toglie dall'indirizzo. */
async function activateFromLink() {
  const fragment = location.hash.slice(1);
  if (!fragment) return;
  history.replaceState(null, '', location.pathname);
  showActivation(true, 'Attivo la licenza…');
  try {
    const res = await activate(fragment);
    if (res.success) {
      showActivation(true, `✓ Fatto! Licenza attiva fino al ${formatDate(res.data.validUntil)}.`);
    } else {
      showActivation(false, res.error);
    }
  } catch {
    showActivation(false, 'Il dispositivo non risponde: sei collegato alla rete QuizZata?');
  }
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('code').value.trim();
  const err = $('form-error');
  err.hidden = true;
  if (!code) {
    err.textContent = 'Incolla qui il codice ricevuto.';
    err.hidden = false;
    return;
  }
  try {
    const res = await activate(code);
    if (res.success) {
      $('code').value = '';
      showActivation(true, `✓ Fatto! Licenza attiva fino al ${formatDate(res.data.validUntil)}.`);
      renderStatus(res.data);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      err.textContent = res.error;
      err.hidden = false;
    }
  } catch {
    err.textContent = 'Il dispositivo non risponde: sei collegato alla rete QuizZata?';
    err.hidden = false;
  }
});

// La pagina è servita in http sulla rete locale: niente navigator.clipboard
// (vuole https), si seleziona il campo e si usa il comando di copia classico.
$('copy-serial').addEventListener('click', () => {
  const input = $('d-serial');
  input.select();
  input.setSelectionRange(0, input.value.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  $('copy-serial').textContent = ok ? 'Copiato' : 'Selezionato';
  setTimeout(() => { $('copy-serial').textContent = 'Copia'; }, 1800);
});

(async () => {
  await activateFromLink();
  await loadStatus();
})();
