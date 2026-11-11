# La Coppia Scoppiata — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere il minigioco cooperativo "La Coppia Scoppiata" estendendo il contratto dei minigiochi con le carte private, senza nominare il gioco fuori dai suoi file.

**Architecture:** Il contratto regole guadagna campi facoltativi (`deal`, `progress`, `botChoice`, `minPlayers`; `resolve` riceve il contesto della distribuzione). `game.js` li gestisce in modo generico e resta puro; `game-socket.js` manda a ogni telefono solo la sua carta (`game:hand`) e a tutti i gruppi completati (`game:groups-completed`). Il contratto di presentazione guadagna `player.renderHand` e `sala.onGroupsCompleted`, chiamati dai due `app.js` solo se esistono.

**Tech Stack:** Node.js v24 (CommonJS), Socket.io, JS vanilla nel browser (moduli UMD), CSS. Nessun framework di test: script `tools/test-*.js` con `assert(cond, label)`.

**Spec:** `docs/superpowers/specs/2026-11-11-coppia-scoppiata-design.md`

## Global Constraints

- Tipo `coppia_scoppiata`, file `server/minigames/coppia-scoppiata.js` e `client/shared/minigames/coppia-scoppiata.js` (nome file = tipo).
- `defaultTimeLimitS: 90`; `points: { complete: 1000, half: 300, miss: 0 }`; `options: ['Rosso', 'Blu', 'Verde', 'Giallo', 'Viola', 'Arancio']` (l'indice è il colore).
- Catalogo figure (16 id, in quest'ordine): `gatto, cane, pesce, elefante, coniglio, tartaruga, farfalla, uccellino, mela, ombrello, bicicletta, chitarra, casa, automobile, palloncino, cappello`.
- Nessun `if (type === 'coppia_scoppiata')` in `game.js`, `game-socket.js`, `debug-tools.js`, nei tre `app.js`. Il nome compare fuori dai due file solo nelle tre righe `<script>` e in `tools/make-minigame-audio.js`.
- `deal`, `progress`, `resolve`, `botChoice` pure (solo l'`rnd` passato, mai `Math.random` diretta).
- Le carte private non passano mai da `io.emit` globale né da `io.to(ROOM_PLAYERS)`.
- Copy esatta: sala "Trova la tua coppia prima che scada il tempo!", etichetta striscia "Salvati"; telefono "Mostra la carta" / "Nascondi la carta".
- Funziona su Windows e Raspberry; nessun asset esterno; rispettare DESIGN.md (bordi 4px inchiostro, ombre piene senza blur, Quicksand 700-900).

## Review Focus

1. **Telefono che rientra a metà round** → riceve la stessa carta (mai ridistribuita) e lo stato "già risposto". Test in Task 3 e Task 4.
2. **Scollegato all'apertura che si sveglia e risponde** → conta come presente; un gruppo già annunciato "salvato" resta salvato anche se lui poi sbaglia. Test in Task 3.
3. **Risposta col proprio colore** (il telefono la nasconde, ma un client può mandarla) → esito `miss`, nessun crash. Test in Task 2.
4. **Host salta il round o inserisce/ricomincia** → carte e gruppi del round vecchio azzerati; un `game:hand` con `roundIndex` vecchio è ignorato dal telefono. Test in Task 3; controllo client in Task 6.
5. **Molti bot (19) con carte private** → passano da `submitAnswer`, una parte forma gruppi completi, la striscia si riempie. Test in Task 3 (`botChoice`) e verifica manuale in Task 7.

---

## File Structure

| File | Ruolo |
|---|---|
| `server/minigames/index.js` (mod.) | valida i campi facoltativi nuovi del contratto |
| `server/minigames/_TEMPLATE.js` (mod.) | documenta i campi nuovi |
| `server/minigames/coppia-scoppiata.js` (nuovo) | regole: distribuzione, correttezza, gruppi, scelta dei bot |
| `server/game.js` (mod.) | carte private, presenza, gruppi completati, `minPlayers` |
| `server/game-socket.js` (mod.) | `game:hand`, `game:groups-completed`, rejoin/resync, bot |
| `client/shared/minigames/index.js` + `_TEMPLATE.js` (mod.) | default dei hook nuovi |
| `client/shared/minigames/coppia-scoppiata.js` (nuovo) | presentazione telefono + sala |
| `client/shared/minigames/minigames.css` (mod.) | sezione `.mg-coppia-scoppiata-` |
| `client/player/app.js`, `client/sala/app.js` (mod.) | chiamano i hook nuovi |
| `client/{host,player,sala}/index.html` (mod.) | riga `<script>` |
| `resources/img/coppia-scoppiata/figure/*.svg` (nuovi) | 16 figure |
| `tools/make-minigame-audio.js` (mod.), `resources/audio/coppia-scoppiata/` | musica + effetti |
| `tools/test-minigames.js`, `tools/test-game.js`, `tools/test-socket.js` (mod.) | test |
| `CLAUDE.md` (mod.) | documentazione |

---

### Task 1: Contratto regole esteso nel registry

**Files:**
- Modify: `server/minigames/index.js` (`validateDefinition` ~140, `assertResolveContract` ~108)
- Modify: `server/minigames/_TEMPLATE.js`
- Test: `tools/test-minigames.js` (nuova sezione dopo "Contract validation", usa `validDef(overrides)`)

**Interfaces:**
- Produces (contratto, tutti facoltativi):
  - `minPlayers: integer >= 1` (default 1)
  - `deal(players: Array<{id: string, connected: boolean}>, rnd) → { hands: { [id]: object }, table: object }`
  - `progress(table, answers: Map<string, number>, present: Set<string>) → string[][]` (gruppi completi, id ordinati)
  - `resolve(rnd, ctx)` dove, per i moduli con `deal`, `ctx = { table, answers: Map<string, number>, completed: Set<string> }` e il ritorno è `{ machineChoice: null, outcomeFor(optionIndex, playerId) → chiave di points, reveal: object }`
  - `botChoice(table, playerId, rnd) → integer in [0, options.length)`

- [ ] **Step 1: Scrivi i test che falliscono** in una `section('Contratto: carte private')`:
  - `validDef({ deal: 'x' })` → `assertThrows(..., MinigameContractError, 'deal deve essere una funzione')`
  - `validDef({ deal: fakeDeal })` senza `progress` → throws
  - `validDef({ minPlayers: 0 })` → throws; `{ minPlayers: 2 }` → non throws
  - modulo finto valido con `deal`/`progress`/`resolve` che restituisce `machineChoice: null` → non throws (oggi fallisce sul range di `machineChoice`)
  - `deal` che dimentica un id → throws
  - `botChoice` che restituisce 99 → throws

  `fakeDeal(players)` = una carta `{ n: i }` per id, `table = { ids }`; `resolve(_, ctx)` = `{ machineChoice: null, outcomeFor: () => 'win', reveal: {} }`; `progress` = `() => []`.

- [ ] **Step 2: Esegui e verifica il fallimento**
  Run: `npm run test:minigames` — Expected: i nuovi casi ❌, gli altri ✅.

- [ ] **Step 3: Implementa** in `index.js` un `assertDealContract(file, def)` chiamato da `validateDefinition` quando `'deal' in def`: richiede `deal` e `progress` funzioni; esegue `deal` a vuoto con 2, 3 e 7 giocatori finti (l'ultimo con un `connected: false`) e `rnd` fissi (0, 0.5, 0.999999); ogni id deve avere una carta; `progress(table, new Map(), new Set(ids))` deve dare un array; `resolve(rnd, { table, answers: new Map([[ids[0], 0]]), completed: new Set() })` deve dare `machineChoice === null`, `outcomeFor(0, ids[0])` chiave di `points`, `reveal` oggetto. Per i moduli con `deal` salta il controllo di range di `machineChoice` in `assertResolveContract`. Valida `minPlayers` (intero ≥ 1) e `botChoice` (funzione; eseguita sul `table` di prova, risultato intero nel range).

- [ ] **Step 4: Aggiorna `_TEMPLATE.js`** con un blocco commentato per ciascun campo nuovo (cosa riceve, quando è chiamato, che deve essere puro), nello stile dei blocchi `previewMs`/`stages`.

- [ ] **Step 5: Verifica** — Run: `npm run test:minigames` — Expected: tutti ✅. Run: `npm start` e chiudi: il server parte (Morra e Bicchieri invariati).

- [ ] **Step 6: Commit**
```bash
git add server/minigames/index.js server/minigames/_TEMPLATE.js tools/test-minigames.js
git commit -m "feat(minigiochi): contratto con carte private (deal, progress, botChoice, minPlayers)"
```

---

### Task 2: Regole della Coppia Scoppiata

**Files:**
- Create: `server/minigames/coppia-scoppiata.js`
- Test: `tools/test-minigames.js` (nuova `section('Coppia Scoppiata: regole')`)

**Interfaces:**
- Consumes: contratto del Task 1.
- Produces:
  - export del modulo con `type: 'coppia_scoppiata'`, `label: 'La Coppia Scoppiata'`, `description`, `prompt: 'Trova la tua coppia prima che scada il tempo!'`, `options`, `points`, `defaultTimeLimitS: 90`, `revealMs: 9000`, `minPlayers: 2`, `FIGURES` (array dei 16 id).
  - carta: `{ figure: string, color: number }`
  - `table = { hands: { [id]: card }, groups: Array<{ figure: string, members: string[] }> }`
  - `reveal = { groups: Array<{ figure: string, members: Array<{ playerId: string, color: number }> }> }`

- [ ] **Step 1: Scrivi i test che falliscono** (con `seededRnd`):
  - `deal` di 2 connessi → 1 gruppo da 2, stessa figura, colori diversi.
  - `deal` di 7 connessi → 3 gruppi, taglie ordinate `[2,2,3]`.
  - `deal` di 33 connessi → 16 gruppi, figure tutte diverse; di 40 → 16 gruppi, taglie fra 2 e 3 (distribuite al più pari), mai due colori uguali in un gruppo; di 100 → ogni id ha una carta, ogni gruppo ≤ 6 e colori distinti nel gruppo.
  - 6 connessi + 2 scollegati → un gruppo fatto dai 2 scollegati; nessun connesso in un gruppo dove gli altri sono tutti scollegati.
  - 6 connessi + 1 scollegato → lo scollegato sta in un gruppo con ≥ 2 connessi.
  - correttezza: in un trio, il colore di uno qualsiasi degli altri due è giusto; il proprio colore → `miss` (Review Focus 3); un colore di un'altra figura → `miss`.
  - `progress`: coppia con risposte incrociate giuste → `[[a,b]]` (id ordinati); una sola giusta → `[]`; trio con un membro assente (fuori da `present`) e gli altri due giusti → completo; gruppo con un solo presente → mai completo.
  - `resolve`: `outcomeFor` → `complete` se l'id è in `ctx.completed` e la sua risposta è giusta; `half` se giusta ma fuori da `completed`; `miss` altrimenti. `reveal.groups` contiene ogni membro col suo colore.
  - `botChoice` su 1000 `rnd` sequenziali: circa 70% (60–80%) colori di un compagno, mai il proprio colore.
  - determinismo: stesso `rnd` → stessa distribuzione.

- [ ] **Step 2: Esegui e verifica il fallimento** — Run: `npm run test:minigames` — Expected: ❌ "modulo non trovato".

- [ ] **Step 3: Implementa il modulo.** Correttezza (una sola funzione interna, usata da `progress`, `resolve`, `botChoice`): `isCorrect(hands, playerId, optionIndex)` = esiste un altro id con la stessa `figure` e `color === optionIndex`. Gruppo completo in `progress`: almeno 2 membri in `present`, e ogni membro in `present` ha risposto giusto.

  Distribuzione (`deal`), l'unico algoritmo non ovvio:
  ```
  N = players.length
  G = N <= 96 ? min(16, floor(N / 2)) : ceil(N / 6)
  D = shuffle(scollegati), C = shuffle(connessi)
  se |D| >= 2: GD = max(1, round(G * |D| / N)) limitato a floor(|D| / 2); altrimenti GD = 0
  GC = G - GD (almeno 1 se |C| >= 2)
  gruppi = partiziona(D in GD gruppi) ++ partiziona(C in GC gruppi)   // taglie pari, le più grandi prima
  se |D| == 1: aggiungi l'unico scollegato al gruppo di connessi più piccolo
  se |C| == 1: aggiungi l'unico connesso al gruppo di scollegati più piccolo
  figure: shuffle(FIGURES), il gruppo i prende figure[i % 16]
  colori: per ogni gruppo, i primi |gruppo| di shuffle([0..5])
  ```
  `shuffle` è un Fisher–Yates con l'`rnd` passato.

- [ ] **Step 4: Verifica** — Run: `npm run test:minigames` — Expected: tutti ✅ (compresa la validazione di contratto all'autoload).

- [ ] **Step 5: Commit**
```bash
git add server/minigames/coppia-scoppiata.js tools/test-minigames.js
git commit -m "feat(minigiochi): regole della Coppia Scoppiata"
```

---

### Task 3: Carte private in `GameSession`

**Files:**
- Modify: `server/game.js` (`_enterRound` 467-487, `submitAnswer` 559-620, `endQuestion` 630-676, `_resultsSummary` 678-704, `skipRound` 749-785, `setPlayerConnected` 442-445, `_advance` 722)
- Test: `tools/test-game.js` (nuova sezione "Carte private"), quiz con `minigames: [{ afterQuestionIndex: 0, type: 'coppia_scoppiata' }]` e `{ rnd: seededRnd(...) }`

**Interfaces:**
- Consumes: Task 1, Task 2.
- Produces (`GameSession`):
  - `getHand(playerId) → object | null`
  - `getCompletedGroups() → string[][]`
  - `getBotChoice(playerId) → number | null` (`def.botChoice` sul round corrente, `null` se il modulo non ce l'ha)
  - `getCurrentRound()` aggiunge `privateHand: boolean`
  - `submitAnswer(...)` su un round con carte private → `{ recorded: true, newlyCompleted: string[][] }`
  - `_resultsSummary` aggiunge `reveal` (`null` se assente)
  - nuovo `NotEnoughPlayersError` esportato

- [ ] **Step 1: Scrivi i test che falliscono**
  - all'apertura del round: `getHand(id)` non null per ogni giocatore, anche uno con `setPlayerConnected(id, false)` prima dell'apertura; `getCurrentRound().privateHand === true`.
  - `getHand` resta identica dopo `setPlayerConnected(id, false)` e poi `true` (Review Focus 1).
  - `submitAnswer` del primo della coppia col colore giusto → `newlyCompleted` `[]`; del secondo → `[[a,b]]`; `getCompletedGroups()` lo contiene.
  - trio con un membro mai connesso nel round: gli altri due giusti → completo; `endQuestion` dà `complete` (1000) a entrambi.
  - presenza: uno scollegato all'apertura che si ricollega (`setPlayerConnected(id, true)`) durante il round conta come presente; se il suo gruppo era già completo resta completo, e se lui poi sbaglia prende `miss` mentre gli altri restano `complete` (Review Focus 2).
  - `endQuestion`: coppia a metà → 300 solo a chi ha indovinato; `results.reveal.groups` presente; `machineChoice === null`.
  - `skipRound` e il round successivo: `getHand` → `null`, `getCompletedGroups()` → `[]` (Review Focus 4).
  - partita con 1 solo giocatore: il round minigioco con `minPlayers: 2` viene saltato da `_advance` (si arriva alla domanda successiva o alla classifica); `insertMinigame('coppia_scoppiata')` con 1 giocatore → `NotEnoughPlayersError`.
  - `getBotChoice(id)` restituisce un intero diverso dal colore del giocatore.
  - regressione: Morra e Tre Bicchieri danno gli stessi risultati di prima (i test esistenti restano ✅).

- [ ] **Step 2: Esegui e verifica il fallimento** — Run: `node tools/test-game.js` — Expected: nuovi ❌.

- [ ] **Step 3: Implementa.** Stato per round, azzerato dove oggi si azzera `currentAnswers` (`_enterRound`, `skipRound`) e alla chiusura: `this._deal` (`{ hands, table } | null`), `this._present: Set`, `this._completed: string[][]`, `this._completedIds: Set`. In `_enterRound`, se il modulo ha `deal`: `_deal = def.deal([...players].map(p => ({ id, connected })), this._rnd)`, `_present` = i connessi. `setPlayerConnected(id, true)` durante `QUESTION` aggiunge a `_present`; `submitAnswer` lo aggiunge sempre. Dopo la registrazione: `progress(table, mappa id→optionIndex, _present)`, i gruppi non ancora visti vanno in `_completed`/`_completedIds` e in `newlyCompleted`. In `endQuestion` un ultimo `progress`, poi `resolve(this._rnd, { table, answers, completed: _completedIds })` e `outcomeFor(answer.optionIndex, playerId)`. `minPlayers`: in `_advance` un round minigioco il cui modulo ha `minPlayers > this.players.size` si salta insieme ai suoi livelli; `insertMinigame` lancia `NotEnoughPlayersError`.

- [ ] **Step 4: Verifica** — Run: `node tools/test-game.js` e `npm run test:minigames` — Expected: tutti ✅.

- [ ] **Step 5: Commit**
```bash
git add server/game.js tools/test-game.js
git commit -m "feat(game): carte private, presenza e gruppi completati nei minigiochi"
```

---

### Task 4: Rete — carte, gruppi, rientro, bot

**Files:**
- Modify: `server/game-socket.js` (`emitQuestion` 213-245, `scheduleBotAnswers` 255-275, `player:answer` 494-511, `player:rejoin` 447-492, `host:resync` 575-611, `host:insert-minigame`: mappare `NotEnoughPlayersError` a un `fail` leggibile)
- Test: `tools/test-socket.js`

**Interfaces:**
- Consumes: Task 3 (`getHand`, `getCompletedGroups`, `getBotChoice`, `newlyCompleted`).
- Produces (eventi):
  - `game:hand` `{ roundIndex: number, card: object }`, solo al socket del giocatore (`socketPlayers`: socket.id → playerId)
  - `game:groups-completed` `{ roundIndex: number, groups: string[][] }`, `io.emit`
  - `player:rejoin` in `QUESTION`: `question.hand` (carta o `null`) e `question.completedGroups`
  - `host:resync` in `QUESTION`: `completedGroups`

- [ ] **Step 1: Scrivi i test che falliscono** in `test-socket.js`: due player e un host; l'host inserisce `coppia_scoppiata`. Ogni player riceve `game:hand` con la propria carta e **nessun** altro socket riceve quella carta (il socket sala senza token non riceve `game:hand`); `game:question` non contiene carte. Il primo che risponde giusto → nessun `game:groups-completed`; il secondo → `game:groups-completed` con `[[a,b]]` ricevuto anche dal socket sala. Un player si disconnette e fa `player:rejoin` a metà round → `question.hand` uguale alla carta di prima e `alreadyAnswered` corretto.

- [ ] **Step 2: Esegui e verifica il fallimento** — Run: `npm run dev` in un terminale, poi `npm run test:socket` — Expected: nuovi ❌.

- [ ] **Step 3: Implementa.**
  - Dopo il `game:question` di `emitQuestion`, se `q.privateHand`: per ogni `[socketId, playerId]` di `socketPlayers` con una carta, `io.to(socketId).emit('game:hand', { roundIndex, card })`.
  - In `player:answer`, se `result.newlyCompleted?.length`, `io.emit('game:groups-completed', ...)` prima di `emitAnswerCount`.
  - I bot: `currentSession.getBotChoice(playerId) ?? testBots.pickOption(optionCount)`, e lo stesso `game:groups-completed` dopo il loro `submitAnswer`.
  - Rientro e resync con i campi sopra. Il rientro chiama già `setPlayerConnected(true)`: verifica che venga chiamato prima di leggere la carta.

- [ ] **Step 4: Verifica** — Run: `npm run test:socket` — Expected: tutti ✅.

- [ ] **Step 5: Commit**
```bash
git add server/game-socket.js tools/test-socket.js
git commit -m "feat(socket): carte private per telefono e gruppi completati in diretta"
```

---

### Task 5: Figure e audio

**Files:**
- Create: `resources/img/coppia-scoppiata/figure/<id>.svg` × 16 (id del Global Constraints)
- Modify: `tools/make-minigame-audio.js` (`OUTPUT` 611-630: chiave `'coppia-scoppiata'`)
- Create (generati): `resources/audio/coppia-scoppiata/music.ogg`, `saved.wav`, `flip.wav`, `deal.wav`
- Optional modify: `resources/img/coppia-scoppiata/back_carta.png` (354 KB)

**Interfaces:**
- Produces: SVG con `viewBox="0 0 100 100"`, contorno `stroke="#1c1c26"` 4-5 px, campiture `fill="currentColor"` (il colore della carta arriva dal CSS `color:`), dettagli (occhi, ombre) in inchiostro o bianco. Nessun testo, nessun `<image>`, ≤ 4 KB ciascuno.

- [ ] **Step 1: Disegna i 16 SVG.** Criterio: riconoscibili a un metro in un'occhiata e con sagome diverse fra loro (silhouette di profilo per gli animali, frontale per gli oggetti).
- [ ] **Step 2: Verifica visiva.** Crea una pagina di prova nella scratchpad con le 16 figure in tutti e 6 i colori (stessi valori del Task 6) su fondo `front_carta.png`, aprila nel browser pane e fai uno screenshot. Expected: tutte riconoscibili, nessun colore che sparisce.
- [ ] **Step 3: Audio.** Aggiungi a `OUTPUT` quattro generatori nello stile di `morraMusic`/`morraTick`: `music.ogg` (loop di suspense, ~90 s o loopabile), `saved.wav` (accordo breve e allegro), `flip.wav` (fruscio di carta), `deal.wav` (carta sul tavolo). Run: `node tools/make-minigame-audio.js` — Expected: i file in `resources/audio/coppia-scoppiata/`.
- [ ] **Step 4 (consigliato): alleggerisci `back_carta.png`.** Con ffmpeg, riduci all'altezza di visualizzazione (~700 px). Obiettivo ≤ 120 KB: lo scaricano tutti i telefoni insieme sul Wi-Fi del Pi.
- [ ] **Step 5: Commit**
```bash
git add resources/img/coppia-scoppiata resources/audio/coppia-scoppiata tools/make-minigame-audio.js
git commit -m "feat(coppia-scoppiata): figure SVG, carte e audio"
```

---

### Task 6: Telefono — carta, flip, pallini

**Files:**
- Modify: `client/shared/minigames/index.js` (`DEFAULT_PRESENTATION.player`: `renderHand: null`; `DEFAULT_PRESENTATION.sala`: `onGroupsCompleted: null`), `client/shared/minigames/_TEMPLATE.js` (documenta i due hook)
- Create: `client/shared/minigames/coppia-scoppiata.js` (ramo `player` + metadati: `type`, `label`, `wheelIcon: '/resources/img/coppia-scoppiata/figure/gatto.svg'`, `salaOptions: false`, `COLORS` con i 6 esadecimali, `audio`)
- Modify: `client/shared/minigames/minigames.css` (sezione `.mg-coppia-scoppiata-`)
- Modify: `client/player/app.js` (`renderQuestion` 315-360, handler socket ~677, rejoin 774-803)
- Modify: `client/host/index.html` (dopo 305), `client/player/index.html` (dopo 160), `client/sala/index.html` (dopo 231): `<script src="/shared/minigames/coppia-scoppiata.js"></script>`
- Test: `tools/test-minigames.js` (sezione presentazione 341-372)

**Interfaces:**
- Consumes: `game:hand`, `question.hand` (Task 4); carta `{ figure, color }` (Task 2).
- Produces: `player.renderHand(container: HTMLElement, card, ctx: { options: string[], submit: (optionIndex) => void, answered: boolean })`.

- [ ] **Step 1: Test che falliscono** in `test-minigames.js`: `Minigames.has('coppia_scoppiata')`; `typeof get('coppia_scoppiata').player.renderHand === 'function'`; `get('morra_cinese').player.renderHand === null`; `COLORS.length === options.length` del modulo server; il controllo audio esistente copre i file dichiarati.
- [ ] **Step 2: Run** `npm run test:minigames` — Expected: ❌.
- [ ] **Step 3: Implementa `player/app.js`.** Se `q.privateHand` e il modulo ha `renderHand`: niente griglia delle opzioni, un contenitore con il retro della carta in attesa. Su `game:hand` (scarta se `roundIndex !== currentRoundIndex`, Review Focus 4) e su `question.hand` al rientro: `renderHand(container, card, { options, submit: (i) => submitAnswer(i), answered })`. Il resto (risposta bloccata, schermata d'attesa, risultati) resta quello degli altri round.
- [ ] **Step 4: Implementa `renderHand`.** La carta arriva coperta con un'animazione "sul tavolo" (volo + leggera rotazione, ~600 ms, effetto `deal`). Un `<button>` di solo testo, senza sfondo, bordo né ombra, "Mostra la carta" / "Nascondi la carta", che fa il flip 3D (`rotateY` 180°, `backface-visibility: hidden`, ~450 ms). Fronte: `front_carta.png` + figura SVG al centro, `color:` dal colore della carta. Sotto, un pallino per ogni colore **tranne il proprio**, con il nome sotto; il tocco chiama `ctx.submit(i)`. `prefers-reduced-motion`: niente volo né rotazione, cambio di faccia secco. Le figure vanno inserite come SVG inline, non con `<img>` (che ignora `currentColor`): `fetch` + `innerHTML`, una volta sola per figura, con cache in memoria condivisa fra telefono e sala.
- [ ] **Step 5: Verifica.** `npm run test:minigames` ✅. Con `DEBUG_TOOLS=1`, apri `/debug`, clic sul bottone del minigioco. Controlla: arrivo della carta, flip nei due versi, assenza del proprio colore, invio della risposta. Screenshot del telefono coperto e girato.
- [ ] **Step 6: Commit**
```bash
git add client/shared/minigames client/player/app.js client/*/index.html tools/test-minigames.js
git commit -m "feat(coppia-scoppiata): carta privata sul telefono con flip e pallini"
```

---

### Task 7: Sala — timer gigante, striscia dei salvati, rivelazione

**Files:**
- Modify: `client/shared/minigames/coppia-scoppiata.js` (ramo `sala`: `startSuspense`, `stopSuspense`, `onGroupsCompleted`, `reveal`)
- Modify: `client/shared/minigames/minigames.css` (stessa sezione, regole sotto `@container mg-stage`)
- Modify: `client/sala/app.js` (listener `game:groups-completed` vicino a `game:answer-count` ~2276)

**Interfaces:**
- Consumes: `game:groups-completed` (Task 4), `results.reveal` e `results.answers[].outcome` (Task 3), `ServerClock.localDeadline`.
- Produces: `sala.onGroupsCompleted(els, groups: string[][], ctx: { players: Array<{id, nickname, avatar}>, sfx })`.

- [ ] **Step 1: Bozza del timer e checkpoint con l'utente.** Prepara 2-3 varianti del timer gigante in stile Retro Street, in una pagina della scratchpad o nel visual companion, e **aspetta la scelta dell'utente** prima di procedere.
- [ ] **Step 2: Implementa `startSuspense`.** Frase "Trova la tua coppia prima che scada il tempo!" in alto, il timer scelto al centro (scadenza da `ServerClock.localDeadline` con il `serverNow` del round, come spiega CLAUDE.md), la striscia "Salvati" in basso, vuota. Dimensioni in `cqh`/`cqw` dentro `mg-stage`. Musica dal campo `audio`.
- [ ] **Step 3: Implementa `onGroupsCompleted` e il listener in `sala/app.js`.** Il listener chiama `currentMinigame?.sala.onGroupsCompleted?.(minigameEls(), groups, { players, sfx })` solo se `roundIndex` è il round corrente. Ogni gruppo nuovo entra a sinistra (pop, `ctx.sfx?.('saved')`), con facce (`AvatarSprite.fill`) e nickname uniti da "+", mai figure né colori. Oltre lo spazio "+N", con la misura nello stile di `fitLobbyStrip`.
- [ ] **Step 4: Implementa `reveal`** (`revealMs` 9000), in tre tempi fissi, uno per categoria: completi (+1000), a metà (+300 a chi ha indovinato), scoppiati. Dentro una categoria tutte le carte di un gruppo si girano quasi insieme (sfasamento piccolo, `flip` sul primo). Nickname dalla `leaderboard` dei risultati. Il gruppo prende la categoria dagli `outcome` dei suoi membri: almeno un `complete` → completo; almeno un `half` → a metà; altrimenti scoppiato.
- [ ] **Step 5: Verifica dal vivo.** `/debug` e anche una partita vera con 19 bot (dieci clic sul logo del pannello). Controlla: la striscia si riempie mentre i bot rispondono, la rivelazione in tre tempi, poi la classifica. Ridimensiona la sala a 1280×720 e 1920×1080: niente traboccamenti. Screenshot di round e rivelazione.
- [ ] **Step 6: Commit**
```bash
git add client/shared/minigames client/sala/app.js
git commit -m "feat(coppia-scoppiata): timer gigante, striscia dei salvati e rivelazione in sala"
```

---

### Task 8: Documentazione

**Files:**
- Modify: `CLAUDE.md` (sezione "Aggiungere un minigioco": nuovo paragrafo "Minigiochi a carte private" accanto a `previewMs`/`stages`/`salaPlayers`; elenco eventi in "Rooms Socket.io e formato eventi": `game:hand`, `game:groups-completed`)

- [ ] **Step 1: Scrivi il paragrafo** nello stile degli altri:
  - i campi del contratto (`deal`, `progress`, `botChoice`, `minPlayers`);
  - perché le carte vanno al singolo socket e mai alla room;
  - la regola di presenza e il gruppo che resta salvato;
  - i hook di presentazione (`renderHand`, `onGroupsCompleted`);
  - il fatto che la sala non ripristina la striscia a metà round, perché un rientro a metà round mostra il cartello come per gli altri minigiochi.
- [ ] **Step 2: Verifica finale** — Run: `npm run test:minigames`, `node tools/test-game.js`, `npm run test:socket` (col server avviato), `npm run test:roster`, `npm run test:intro`. Expected: tutti ✅.
- [ ] **Step 3: Commit**
```bash
git add CLAUDE.md
git commit -m "docs: minigiochi a carte private e Coppia Scoppiata"
```
