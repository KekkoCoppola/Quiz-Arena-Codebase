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

  const fallback = Minigames.get('tipo_mai_visto');
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

// ─── Riepilogo ───────────────────────────────────────────────────────────────────

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Risultato: ${passed} passati, ${failed} falliti`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

process.exitCode = failed === 0 ? 0 : 1;
