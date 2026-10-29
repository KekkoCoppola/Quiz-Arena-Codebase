'use strict';

/* eslint-disable */

/**
 * server/minigames/_TEMPLATE.js
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │  MODELLO — non è un minigioco giocabile.                                  │
 * │  Il prefisso `_` lo esclude dall'autoload del registry: puoi copiarlo,    │
 * │  romperlo, riscriverlo senza che il server se ne accorga.                 │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ═══ COME AGGIUNGERE UN MINIGIOCO ═══════════════════════════════════════════
 *
 *  1. Copia questo file in `server/minigames/<nome-gioco>.js` (trattini, non
 *     underscore, nel nome del file) e riempilo. È il lato REGOLE.
 *
 *  2. Copia `client/shared/minigames/_TEMPLATE.js` in
 *     `client/shared/minigames/<nome-gioco>.js`. È il lato PRESENTAZIONE
 *     (icone, animazione di suspense, reveal su host e player).
 *
 *  3. Aggiungi una riga `<script src="/shared/minigames/<nome-gioco>.js">` in
 *     `client/host/index.html` e in `client/player/index.html`, sotto quelle
 *     già presenti. È l'unico punto del progetto in cui il nome del tuo
 *     minigioco compare fuori dai suoi due file: il browser non ha un
 *     filesystem da scandire, quindi va detto esplicitamente cosa caricare.
 *
 *  4. (facoltativo) Metti gli asset in `resources/img/<nome-gioco>/` e le regole
 *     CSS in `client/shared/minigames/minigames.css`, tutte prefissate
 *     `.mg-<tipo>-`. Usa i token colore di DESIGN.md, non inventarne.
 *
 *  5. Esegui `node tools/test-minigames.js`: il registry ricarica da solo e
 *     verifica il tuo contratto. Nessuna registrazione manuale da nessuna parte.
 *
 *  Non serve toccare game.js, game-socket.js, le route, l'editor o i due
 *  app.js: il tuo minigioco comparirà da solo nell'elenco dell'editor e nella
 *  rosa dell'estrazione casuale.
 *
 * ═══ LE DUE REGOLE DA NON VIOLARE ═══════════════════════════════════════════
 *
 *  A. `build()` e `resolve()` devono essere PURE — stesso input, stesso output,
 *     nessuno stato condiviso fra round, nessun accesso a rete/DB/orologio.
 *     Il registry le esegue una volta a vuoto all'avvio per validarle, e
 *     `resolve()` viene invocata su ogni giocatore alla chiusura del round.
 *
 *  B. Un minigioco non conosce l'esistenza degli altri. Se ti accorgi di dover
 *     scrivere `if (type === 'qualcos_altro')` da qualche parte, la struttura
 *     ti sta dicendo che quel comportamento va nel contratto, non in un ramo.
 *
 * ═══ COSA DISTINGUE UN MINIGIOCO DA UNA DOMANDA ═════════════════════════════
 *
 *  Una domanda ha una risposta corretta scritta in editor: si sa già chi ha
 *  vinto nell'istante in cui il giocatore tocca il bottone.
 *
 *  Un minigioco no. La macchina sceglie alla CHIUSURA del round: fino a quel
 *  momento nessuno sa nulla, e il reveal è un momento di spettacolo per tutta
 *  la sala. Per questo `submitAnswer` su un minigioco registra solo la scelta,
 *  e i punti vengono assegnati in `endQuestion`.
 *
 *  Se il tuo gioco ha una risposta giusta nota in anticipo, non è un minigioco:
 *  è una domanda.
 * ════════════════════════════════════════════════════════════════════════════
 */

module.exports = {
  /**
   * Chiave stabile del minigioco. DEVE combaciare con il nome del file, con i
   * trattini convertiti in underscore: `testa-o-croce.js` → `testa_o_croce`.
   * Finisce nel DB dentro `quizzes.minigames`, quindi cambiarla dopo il rilascio
   * romperebbe i quiz già salvati.
   */
  type: 'nome_minigioco',

  /** Nome mostrato all'host nell'editor e nella schermata di conduzione. */
  label: 'Nome Minigioco',

  /** Una riga di spiegazione per l'editor. Cosa deve aspettarsi l'host. */
  description: 'Descrizione breve della meccanica.',

  /**
   * Durata del round in secondi. Tienila corta: un minigioco è un intermezzo,
   * non una domanda. La Morra Cinese usa 8 secondi.
   */
  defaultTimeLimitS: 8,

  /**
   * FACOLTATIVO. Millisecondi di anteprima PRIMA che si possa rispondere.
   * Serve ai giochi "guarda e poi scegli" (es. Tre Bicchieri: si segue il
   * mescolamento, poi si indica la pallina). Se è > 0:
   *   - `resolve()` viene chiamata all'APERTURA del round, non alla chiusura,
   *     perché lo spettacolo deve sapere dove andare a finire;
   *   - `machineChoice` arriva in anteprima a sala e host (`round.preview`),
   *     MAI ai telefoni: leggerlo dal payload vorrebbe dire barare;
   *   - le risposte sono rifiutate finché l'anteprima non è finita, e i
   *     `defaultTimeLimitS` secondi partono da lì.
   * Ometterlo (o 0) = il comportamento classico: si sceglie subito, la
   * macchina decide alla chiusura.
   */
  // previewMs: 10000,

  /**
   * FACOLTATIVO. Quanti round di fila produce il minigioco (default 1).
   * Con `stages: N` l'inserimento aggiunge N round, ognuno costruito da
   * `build(stageIndex)` (0..N-1) e marcato `stage: { index, count }` — qui
   * si alza la difficoltà, e `build` può mettere in `stage` i propri
   * parametri (es. `{ swaps: 12 }`) e un `previewMs` per livello.
   * Fra un livello e l'altro il server riparte da solo dopo il reveal; sala
   * e telefoni mostrano la classifica solo dopo l'ultimo. Ogni livello ha
   * risposte, esito e punti propri.
   */
  // stages: 5,

  /** Testo mostrato all'apertura del round. */
  prompt: 'La domanda che vede il giocatore.',

  /**
   * Le scelte possibili. Servono almeno 2 voci.
   * ⚠ L'INDICE è l'identità della scelta in tutto il sistema: viaggia nei
   * payload socket, finisce nella distribuzione delle risposte e indicizza le
   * icone lato client. Riordinare questo array dopo il rilascio cambia il
   * significato dei dati.
   */
  options: ['Prima', 'Seconda', 'Terza'],

  /**
   * Punti per esito. Le chiavi sono libere ma devono coprire OGNI valore che
   * `outcomeFor()` può restituire — il registry lo verifica all'avvio.
   * Consiglio di prodotto: non lasciare a zero l'esito intermedio, chi ha
   * giocato non deve sentirsi punito per un caso sfortunato.
   */
  points: { win: 500, draw: 100, lose: 0 },

  /**
   * Descrittore del round inviato ai client all'apertura.
   * NON deve contenere `correct_index`: l'esito non esiste ancora.
   * @returns {object}
   */
  build() {
    return {
      kind: 'minigame',
      minigameType: this.type,
      text: this.prompt,
      options: this.options,
      time_limit_s: this.defaultTimeLimitS,
    };
  },

  /**
   * Chiamata UNA volta alla chiusura del round. Estrae lo stato della macchina
   * (la mossa del computer, la faccia del dado, il numero della ruota...) e
   * restituisce come giudicare ogni scelta rispetto a esso.
   *
   * Lo stato estratto è unico per tutta la sala: un solo reveal condiviso, non
   * un esito privato per giocatore.
   *
   * @param {() => number} [rnd] generatore in [0, 1). Usa SEMPRE questo e mai
   *   `Math.random()` diretta: è ciò che rende il minigioco testabile in modo
   *   deterministico, come il parametro `now` di GameSession.
   * @returns {{ machineChoice: number, outcomeFor: (i: number) => string }}
   *   `machineChoice` è un indice valido di `options` e viene mostrato ai client
   *   come esito della macchina; `outcomeFor` restituisce una chiave di `points`.
   */
  resolve(rnd = Math.random) {
    const machineChoice = Math.floor(rnd() * this.options.length);
    return {
      machineChoice,
      outcomeFor(optionIndex) {
        if (optionIndex === machineChoice) return 'draw';
        return optionIndex > machineChoice ? 'win' : 'lose';
      },
    };
  },
};
