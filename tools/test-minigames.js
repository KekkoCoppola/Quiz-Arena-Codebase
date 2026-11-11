'use strict';

/**
 * tools/test-minigames.js
 *
 * Smoke test della struttura modulare dei minigiochi:
 *   - autoload e validazione del contratto (server/minigames/)
 *   - sacchetto di estrazione per la chiamata casuale
 *   - risoluzione del segnaposto `random` dentro GameSession
 *   - registry di presentazione lato client (client/shared/minigames/),
 *     caricato in Node senza DOM: è la prova che i moduli client non toccano
 *     `document` al caricamento.
 *
 * Non copre la resa grafica (serve un browser): quella si verifica a mano
 * seguendo docs/superpowers/specs/2026-08-17-minigiochi-modulari-design.md.
 *
 * Utilizzo: node tools/test-minigames.js
 */

const registry = require('../server/minigames');
const { GameSession, STATES } = require('../server/game');

const {
  MINIGAME_TYPES,
  MINIGAME_TYPE_KEYS,
  RANDOM_TYPE,
  get,
  isValidSlotType,
  listForUi,
  createShuffleBag,
  validateDefinition,
  MinigameContractError,
} = registry;

// ─── Setup ───────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}`);
    failed++;
  }
}

function assertThrows(fn, ErrorClass, label) {
  try {
    fn();
    console.error(`  ❌  ${label} (nessun errore lanciato)`);
    failed++;
  } catch (err) {
    if (err instanceof ErrorClass) {
      console.log(`  ✅  ${label}`);
      passed++;
    } else {
      console.error(`  ❌  ${label} (atteso ${ErrorClass.name}, ricevuto ${err.name})`);
      failed++;
    }
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

/** Generatore deterministico: cicla sui valori forniti. */
function seededRnd(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

/** Definizione minima e valida, base per i test negativi sul contratto. */
function validDef(overrides = {}) {
  return {
    type: 'finto_gioco',
    label: 'Finto Gioco',
    description: 'Solo per i test.',
    defaultTimeLimitS: 8,
    prompt: 'Scegli.',
    options: ['A', 'B'],
    points: { win: 100, lose: 0 },
    build() {
      return {
        kind: 'minigame',
        minigameType: this.type,
        text: this.prompt,
        options: this.options,
        time_limit_s: this.defaultTimeLimitS,
      };
    },
    resolve(rnd = Math.random) {
      const machineChoice = Math.floor(rnd() * this.options.length);
      return {
        machineChoice,
        outcomeFor(i) {
          return i === machineChoice ? 'win' : 'lose';
        },
      };
    },
    ...overrides,
  };
}

// ─── Autoload ────────────────────────────────────────────────────────────────────

section('Autoload del registry');

assert(MINIGAME_TYPE_KEYS.includes('morra_cinese'), 'carica morra-cinese.js come tipo "morra_cinese"');
assert(!MINIGAME_TYPE_KEYS.includes('TEMPLATE'), 'ignora i file con prefisso _ (_TEMPLATE.js non è giocabile)');
assert(!MINIGAME_TYPE_KEYS.includes(RANDOM_TYPE), '"random" non è un minigioco registrato');
assert(
  MINIGAME_TYPE_KEYS.every((k) => MINIGAME_TYPES[k].type === k),
  'ogni definizione dichiara il tipo con cui è registrata'
);
assert(
  MINIGAME_TYPE_KEYS.join(',') === MINIGAME_TYPE_KEYS.slice().sort().join(','),
  'ordine dei tipi stabile (alfabetico), indipendente dal filesystem'
);
assert(Object.isFrozen(MINIGAME_TYPES), 'il registry è congelato: nessuno può iniettare tipi a runtime');
assert(get('morra_cinese') !== null && get('tipo_inesistente') === null, 'get() risolve i tipi noti e restituisce null per gli altri');

// ─── Validazione del contratto ───────────────────────────────────────────────────

section('Validazione del contratto (un modulo rotto ferma il server)');

assert(
  (() => {
    try {
      validateDefinition(validDef(), 'finto-gioco.js', 'finto_gioco');
      return true;
    } catch {
      return false;
    }
  })(),
  'una definizione corretta passa la validazione'
);

assertThrows(
  () => validateDefinition(validDef(), 'nome-sbagliato.js', 'nome_sbagliato'),
  MinigameContractError,
  'rifiuta un "type" che non combacia con il nome del file'
);

assertThrows(
  () => validateDefinition(validDef({ label: '' }), 'finto-gioco.js', 'finto_gioco'),
  MinigameContractError,
  'rifiuta una definizione senza "label"'
);

assertThrows(
  () => validateDefinition(validDef({ options: ['Sola'] }), 'finto-gioco.js', 'finto_gioco'),
  MinigameContractError,
  'rifiuta un minigioco con meno di 2 opzioni'
);

assertThrows(
  () => validateDefinition(validDef({ type: RANDOM_TYPE }), 'random.js', 'random'),
  MinigameContractError,
  'rifiuta "random" come tipo: è riservato al segnaposto'
);

assertThrows(
  () =>
    validateDefinition(
      validDef({
        build() {
          return { kind: 'minigame', minigameType: this.type, text: '', options: this.options, time_limit_s: 8, correct_index: 0 };
        },
      }),
      'finto-gioco.js',
      'finto_gioco'
    ),
  MinigameContractError,
  'rifiuta un build() che include correct_index (sarebbe una domanda, non un minigioco)'
);

assertThrows(
  () =>
    validateDefinition(
      validDef({
        resolve(rnd = Math.random) {
          const machineChoice = Math.floor(rnd() * 2);
          // "pareggio" non esiste in points: è la svista che questo test intercetta.
          return { machineChoice, outcomeFor: () => 'pareggio' };
        },
      }),
      'finto-gioco.js',
      'finto_gioco'
    ),
  MinigameContractError,
  'rifiuta un outcomeFor() che restituisce un esito assente da "points"'
);

assertThrows(
  () =>
    validateDefinition(
      validDef({
        resolve(rnd = Math.random) {
          return { machineChoice: 99, outcomeFor: () => 'win' };
        },
      }),
      'finto-gioco.js',
      'finto_gioco'
    ),
  MinigameContractError,
  'rifiuta un machineChoice fuori dal range delle opzioni'
);

// ─── Contratto: carte private ────────────────────────────────────────────────────

section('Contratto: carte private (deal, progress, botChoice, minPlayers)');

/** Una carta per giocatore, il tavolo ricorda solo gli id. */
function fakeDeal(players) {
  const hands = {};
  players.forEach((p, i) => { hands[p.id] = { n: i }; });
  return { hands, table: { ids: players.map((p) => p.id) } };
}

/** Modulo a carte private minimo e valido. */
function handDef(overrides = {}) {
  return validDef({
    deal: fakeDeal,
    progress: () => [],
    resolve(_rnd, _ctx) {
      return { machineChoice: null, outcomeFor: () => 'win', reveal: {} };
    },
    ...overrides,
  });
}

const tryValidate = (def) => () => validateDefinition(def, 'finto-gioco.js', 'finto_gioco');

assertThrows(tryValidate(handDef({ deal: 'x' })), MinigameContractError,
  'deal deve essere una funzione');
assertThrows(tryValidate(handDef({ progress: undefined })), MinigameContractError,
  'un modulo con deal deve avere anche progress');
assertThrows(tryValidate(validDef({ minPlayers: 0 })), MinigameContractError,
  'minPlayers deve essere un intero >= 1');
{
  let threw = false;
  try { validateDefinition(validDef({ minPlayers: 2 }), 'finto-gioco.js', 'finto_gioco'); } catch { threw = true; }
  assert(!threw, 'minPlayers: 2 è accettato');
}
{
  let threw = null;
  try { validateDefinition(handDef(), 'finto-gioco.js', 'finto_gioco'); } catch (err) { threw = err; }
  assert(threw === null, `un modulo a carte private valido (machineChoice: null) passa${threw ? ` — ${threw.message}` : ''}`);
}
assertThrows(
  tryValidate(handDef({
    deal(players) {
      const { hands, table } = fakeDeal(players);
      delete hands[players[0].id];
      return { hands, table };
    },
  })),
  MinigameContractError,
  'deal che dimentica un giocatore viene rifiutato'
);
assertThrows(tryValidate(handDef({ botChoice: () => 99 })), MinigameContractError,
  'botChoice fuori dal range delle opzioni viene rifiutato');
assertThrows(tryValidate(handDef({ progress: () => 'nope' })), MinigameContractError,
  'progress deve restituire un array');

// ─── Coppia Scoppiata: regole ────────────────────────────────────────────────────

section('Coppia Scoppiata: regole');

/** Generatore pseudo-casuale deterministico (LCG), per le prove statistiche. */
function lcg(seed = 42) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

let coppia = null;
try {
  coppia = require('../server/minigames/coppia-scoppiata');
} catch (err) {
  assert(false, `server/minigames/coppia-scoppiata.js si carica (${err.message.split('\n')[0]})`);
}

if (coppia) {
  const roster = (nConn, nDisc = 0) => [
    ...Array.from({ length: nConn }, (_, i) => ({ id: `c${i}`, connected: true })),
    ...Array.from({ length: nDisc }, (_, i) => ({ id: `d${i}`, connected: false })),
  ];
  const sizes = (table) => table.groups.map((g) => g.members.length).sort((a, b) => a - b);
  const colorsDistinct = (table) => table.groups.every((g) => {
    const cs = g.members.map((id) => table.hands[id].color);
    return new Set(cs).size === cs.length;
  });
  const sameFigure = (table) => table.groups.every((g) =>
    g.members.every((id) => table.hands[id].figure === g.figure));

  assert(coppia.type === 'coppia_scoppiata' && coppia.defaultTimeLimitS === 90 && coppia.minPlayers === 2,
    'tipo, durata 90 s e minPlayers 2');
  assert(JSON.stringify(coppia.points) === JSON.stringify({ complete: 1000, half: 300, miss: 0 }),
    'punti: complete 1000, half 300, miss 0');
  assert(coppia.FIGURES.length === 16 && coppia.options.length === 6, '16 figure, 6 colori');

  {
    const { hands, table } = coppia.deal(roster(2), lcg(1));
    assert(table.groups.length === 1 && hands.c0.figure === hands.c1.figure && hands.c0.color !== hands.c1.color,
      '2 giocatori: una coppia, stessa figura, colori diversi');
  }
  {
    const { table } = coppia.deal(roster(7), lcg(2));
    assert(JSON.stringify(sizes(table)) === '[2,2,3]' && sameFigure(table) && colorsDistinct(table),
      '7 giocatori: due coppie e un trio');
  }
  {
    const { table } = coppia.deal(roster(33), lcg(3));
    const figs = new Set(table.groups.map((g) => g.figure));
    assert(table.groups.length === 16 && figs.size === 16, '33 giocatori: 16 gruppi, figure tutte diverse');
  }
  {
    const { table } = coppia.deal(roster(40), lcg(4));
    const s = sizes(table);
    assert(table.groups.length === 16 && s[0] >= 2 && s[s.length - 1] <= 3 && colorsDistinct(table),
      '40 giocatori: 16 gruppi da 2-3, colori distinti nel gruppo');
  }
  {
    const players = roster(100);
    const { hands, table } = coppia.deal(players, lcg(5));
    assert(players.every((p) => hands[p.id]) && sizes(table).every((n) => n <= 6) && colorsDistinct(table),
      '100 giocatori: tutti hanno una carta, gruppi <= 6, colori distinti');
  }
  {
    const { table } = coppia.deal(roster(6, 2), lcg(6));
    const isDisc = (id) => id.startsWith('d');
    const discGroup = table.groups.find((g) => g.members.every(isDisc));
    const strandedConnected = table.groups.some((g) => {
      const conn = g.members.filter((id) => !isDisc(id));
      return conn.length === 1 && g.members.length > 1;
    });
    assert(discGroup && discGroup.members.length === 2 && !strandedConnected,
      '6 connessi + 2 scollegati: gli scollegati in coppia fra loro, nessun connesso solo con assenti');
  }
  {
    const { table } = coppia.deal(roster(6, 1), lcg(7));
    const g = table.groups.find((x) => x.members.includes('d0'));
    assert(g.members.filter((id) => id.startsWith('c')).length >= 2,
      '6 connessi + 1 scollegato: lo scollegato sta con almeno 2 connessi');
  }
  {
    const a = JSON.stringify(coppia.deal(roster(9, 3), lcg(8)));
    const b = JSON.stringify(coppia.deal(roster(9, 3), lcg(8)));
    assert(a === b, 'stesso rnd, stessa distribuzione');
  }

  // Correttezza, progress e resolve su un tavolo costruito a mano:
  // coppia a/b (gatto rosso, gatto blu), trio x/y/z (mela verde, gialla, viola).
  const hands = {
    a: { figure: 'gatto', color: 0 }, b: { figure: 'gatto', color: 1 },
    x: { figure: 'mela', color: 2 }, y: { figure: 'mela', color: 3 }, z: { figure: 'mela', color: 4 },
  };
  const table = { hands, groups: [
    { figure: 'gatto', members: ['a', 'b'] },
    { figure: 'mela', members: ['x', 'y', 'z'] },
  ] };
  const all = new Set(Object.keys(hands));

  assert(JSON.stringify(coppia.progress(table, new Map([['a', 1], ['b', 0]]), all)) === '[["a","b"]]',
    'progress: coppia con risposte incrociate giuste è completa');
  assert(coppia.progress(table, new Map([['a', 1], ['b', 2]]), all).length === 0,
    'progress: una sola giusta non completa la coppia');
  assert(JSON.stringify(coppia.progress(table, new Map([['x', 4], ['y', 2]]), new Set(['a', 'b', 'x', 'y'])))
    === '[["x","y"]]', 'progress: trio con un assente, gli altri due giusti → completo');
  assert(coppia.progress(table, new Map([['a', 1]]), new Set(['a'])).length === 0,
    'progress: un gruppo con un solo presente non è mai completo');

  {
    const answers = new Map([['a', 1], ['b', 0], ['x', 3], ['y', 2], ['z', 4]]);
    const res = coppia.resolve(lcg(9), { table, answers, completed: new Set(['a', 'b']) });
    assert(res.machineChoice === null, 'resolve: machineChoice null');
    assert(res.outcomeFor(1, 'a') === 'complete' && res.outcomeFor(0, 'b') === 'complete',
      'resolve: membri di un gruppo completato → complete');
    assert(res.outcomeFor(3, 'x') === 'half', 'resolve: giusta ma gruppo non completo → half');
    assert(res.outcomeFor(4, 'z') === 'miss', 'resolve: il proprio colore → miss');
    assert(res.outcomeFor(0, 'x') === 'miss', 'resolve: colore di un\'altra figura → miss');
    const zRow = res.reveal.groups.find((g) => g.figure === 'mela').members.find((m) => m.playerId === 'z');
    assert(zRow && zRow.color === 4, 'reveal: ogni membro col suo colore');
  }
  {
    const rnd = lcg(10);
    let partner = 0; let own = 0;
    for (let i = 0; i < 1000; i++) {
      const c = coppia.botChoice(table, 'x', rnd);
      if (c === 3 || c === 4) partner++;
      if (c === 2) own++;
    }
    assert(partner >= 600 && partner <= 860 && own === 0,
      `botChoice: ~70% colori di un compagno (${partner}/1000), mai il proprio`);
  }
}

// ─── Shuffle bag ─────────────────────────────────────────────────────────────────

section('Shuffle bag — estrazione casuale con varietà garantita');

{
  const bag = createShuffleBag(['a', 'b', 'c'], seededRnd([0, 0.5, 0.99]));
  const firstCycle = [bag.next(), bag.next(), bag.next()];
  assert(
    new Set(firstCycle).size === 3,
    'un ciclo completo restituisce ogni tipo esattamente una volta'
  );

  const secondCycle = [bag.next(), bag.next(), bag.next()];
  assert(new Set(secondCycle).size === 3, 'dopo l\'esaurimento il sacchetto si rimescola e ricomincia');
  assert(
    secondCycle[0] !== firstCycle[2],
    'alla rimescolata non ripesca il tipo appena uscito (niente doppioni a cavallo dei cicli)'
  );
}

{
  const bag = createShuffleBag(['solo'], Math.random);
  assert(
    [bag.next(), bag.next(), bag.next()].every((t) => t === 'solo'),
    'con un solo tipo registrato restituisce sempre quello (caso attuale del progetto)'
  );
}

{
  const bag = createShuffleBag([], Math.random);
  assert(bag.next() === null, 'un sacchetto vuoto restituisce null invece di lanciare');
  assert(bag.size === 0, 'size riflette i tipi disponibili');
}

{
  // Il sorgente non deve essere mutato: il registry lo riusa per ogni sessione.
  const keys = ['a', 'b', 'c'];
  const bag = createShuffleBag(keys, Math.random);
  bag.next();
  bag.next();
  assert(keys.join(',') === 'a,b,c', 'non muta l\'array di tipi ricevuto');
}

// ─── isValidSlotType / listForUi ─────────────────────────────────────────────────

section('Interrogazione del registry per la UI e le validazioni');

assert(isValidSlotType('morra_cinese'), 'isValidSlotType accetta un tipo registrato');
assert(isValidSlotType(RANDOM_TYPE), 'isValidSlotType accetta il segnaposto "random"');
assert(!isValidSlotType('tipo_inventato'), 'isValidSlotType rifiuta un tipo sconosciuto');
assert(!isValidSlotType('constructor'), 'isValidSlotType non si fa ingannare dalle proprietà ereditate da Object');

{
  const list = listForUi();
  assert(list[0].type === RANDOM_TYPE, 'listForUi mette "casuale" in testa');
  assert(list.length === MINIGAME_TYPE_KEYS.length + 1, 'listForUi elenca tutti i tipi più la voce casuale');
  assert(
    list.every((e) => typeof e.label === 'string' && e.label.length > 0),
    'ogni voce esposta alla UI ha un\'etichetta leggibile'
  );
}

// ─── Integrazione con GameSession ────────────────────────────────────────────────

section('Slot "random" risolto dentro GameSession');

const QUIZ = {
  title: 'Quiz di prova',
  questions: [
    { text: 'D1', options: ['a', 'b'], correct_index: 0, time_limit_s: 10 },
    { text: 'D2', options: ['a', 'b'], correct_index: 1, time_limit_s: 10 },
  ],
};

{
  const g = new GameSession({ ...QUIZ, minigames: [{ afterQuestionIndex: 0, type: RANDOM_TYPE }] });
  const round = g.rounds[1];
  assert(round.kind === 'minigame', 'uno slot "random" pianificato genera davvero un round minigioco');
  assert(
    MINIGAME_TYPE_KEYS.includes(round.minigameType),
    'il round porta un tipo concreto: i client non vedono mai "random"'
  );
  assert(round.correct_index === undefined, 'il round generato non ha correct_index');
}

{
  const g = new GameSession(QUIZ);
  g.addPlayer('Tester');
  g.startGame(0);
  g.endQuestion(100);

  const result = g.insertMinigame(RANDOM_TYPE, 200);
  assert(result.finished === false, 'insertMinigame("random") avanza sul round appena inserito');
  assert(g.state === STATES.QUESTION, 'la partita entra in QUESTION sul minigioco estratto');
  assert(
    MINIGAME_TYPE_KEYS.includes(g.currentRound.minigameType),
    'anche l\'inserimento ad-hoc casuale produce un tipo concreto'
  );
}

{
  // `rnd` iniettabile: stesso seme, stesso esito. È ciò che rende un minigioco
  // testabile senza dipendere dalla casualità reale.
  const withSeed = (seed) => {
    const g = new GameSession(
      { ...QUIZ, minigames: [{ afterQuestionIndex: 0, type: 'morra_cinese' }] },
      { rnd: seededRnd([seed]) }
    );
    g.addPlayer('Tester');
    g.startGame(0);
    g.endQuestion(50);
    g.nextQuestion(100);
    g.submitAnswer(g.getPlayers()[0].id, 0, 150);
    return g.endQuestion(200);
  };

  const a = withSeed(0);
  const b = withSeed(0);
  assert(a.machineChoice === b.machineChoice, 'con lo stesso rnd il minigioco produce lo stesso stato macchina');
  assert(a.answers[0].outcome === b.answers[0].outcome, 'con lo stesso rnd l\'esito del giocatore è riproducibile');
  assert(
    withSeed(0.99).machineChoice !== a.machineChoice,
    'semi diversi producono stati macchina diversi (rnd davvero usato)'
  );
}

// ─── Registry di presentazione (client) ──────────────────────────────────────────

section('Registry di presentazione lato client, caricato senza DOM');

{
  // Se un modulo client toccasse `document` al caricamento, questo require
  // lancerebbe: è esattamente il vincolo che vogliamo far rispettare.
  const Minigames = require('../client/shared/minigames');
  require('../client/shared/minigames/morra-cinese');

  assert(Minigames.has('morra_cinese'), 'morra-cinese.js si autoregistra senza bisogno di un DOM');

  const morra = Minigames.get('morra_cinese');
  assert(morra.label === 'Morra Cinese', 'get() restituisce la presentazione registrata');
  assert(typeof morra.sala.reveal === 'function', 'la presentazione host espone reveal()');
  assert(typeof morra.player.reveal === 'function', 'la presentazione player espone reveal()');
  assert(morra.salaPlayers === true && morra.salaOptions === false,
    'la Morra mostra in sala chi ha scelto, non le carte');

  const fallback = Minigames.get('tipo_mai_visto');
  assert(fallback.salaOptions === true, 'senza dichiararlo, un minigioco mostra in sala le carte delle scelte');
  assert(fallback.salaPlayers === false, 'senza dichiararlo, un minigioco non mostra la colonna dei giocatori');
  assert(fallback !== null && fallback !== undefined, 'get() su un tipo sconosciuto non restituisce null');
  assert(
    typeof fallback.sala.reveal === 'function' && typeof fallback.player.reveal === 'function',
    'il fallback espone il contratto completo: uno schermo generico, mai uno rotto'
  );

  assertThrows(
    () => Minigames.register({ label: 'Senza tipo' }),
    Error,
    'register() rifiuta una presentazione senza "type"'
  );
}

section('Presentazione della Coppia Scoppiata');
{
  const Minigames = require('../client/shared/minigames');
  require('../client/shared/minigames/morra-cinese');
  let loaded = true;
  try { require('../client/shared/minigames/coppia-scoppiata'); } catch (err) {
    loaded = false;
    assert(false, `client/shared/minigames/coppia-scoppiata.js si carica (${err.message.split('\n')[0]})`);
  }
  if (loaded) {
    const pres = Minigames.get('coppia_scoppiata');
    assert(Minigames.has('coppia_scoppiata'), 'registrata nel registry di presentazione');
    assert(typeof pres.player.renderHand === 'function', 'player.renderHand è una funzione');
    assert(Minigames.get('morra_cinese').player.renderHand === null, 'la Morra non ha renderHand (default null)');
    assert(Minigames.get('morra_cinese').sala.onGroupsCompleted === null, 'la Morra non ha sala.onGroupsCompleted (default null)');
    assert(Array.isArray(pres.COLORS) && pres.COLORS.length === get('coppia_scoppiata').options.length,
      'un colore esadecimale per ogni opzione del modulo server');
    assert(pres.salaOptions === false, 'in sala niente carte delle opzioni');
    assert(typeof pres.sala.onTimerPaused === 'function' && typeof pres.sala.onTimerResumed === 'function',
      'la bomba ascolta pausa e ripresa del timer');
    assert(Minigames.get('morra_cinese').sala.onTimerPaused === null, 'la Morra non ha onTimerPaused (default null)');
    const t = { endsAt: 10000, pausedLeft: null };
    assert(pres._remaining(t, 4000) === 6000, 'tempo che resta: scadenza meno adesso');
    t.pausedLeft = 6000;
    assert(pres._remaining(t, 9000) === 6000, 'in pausa il tempo resta fermo');
    t.pausedLeft = null; t.endsAt = 15000;
    assert(pres._remaining(t, 9000) === 6000, 'alla ripresa riparte dalla nuova scadenza');
  }
}

section('Audio dei minigiochi: ogni file dichiarato esiste');

{
  // Un file audio mancante non rompe nulla (il motore lo salta in silenzio),
  // ed è proprio per questo che va controllato qui: in sala nessuno se ne
  // accorgerebbe, il minigioco sarebbe solo muto.
  const fs = require('node:fs');
  const path = require('node:path');
  const Minigames = require('../client/shared/minigames');
  for (const file of fs.readdirSync(path.join(__dirname, '../client/shared/minigames'))) {
    if (file.endsWith('.js') && file !== 'index.js' && !file.startsWith('_')) {
      require(`../client/shared/minigames/${file}`);
    }
  }
  for (const type of Minigames.types()) {
    const audio = Minigames.get(type).audio;
    if (!audio) continue;
    const entries = [
      ...(audio.music ? [audio.music] : []),
      ...Object.values(audio.sfx ?? {}).flatMap((e) => (Array.isArray(e) ? e : [e])),
    ];
    const missing = entries
      .map((e) => e.file)
      .filter((f) => !fs.existsSync(path.join(__dirname, '../resources/audio', f)));
    assert(entries.length > 0 && missing.length === 0,
      `${type}: ${entries.length} file audio dichiarati, tutti presenti${missing.length ? ` (mancano: ${missing.join(', ')})` : ''}`);
  }
}

// ─── Riepilogo ───────────────────────────────────────────────────────────────────

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Risultato: ${passed} passati, ${failed} falliti`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

process.exitCode = failed === 0 ? 0 : 1;
