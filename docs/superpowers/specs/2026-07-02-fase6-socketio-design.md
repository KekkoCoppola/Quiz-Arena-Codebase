# Fase 6 — Integrazione Socket.io & Test E2E Minimale

**Data:** 2026-07-02
**Branch:** Step-6
**Stato:** Approvato

## Obiettivo

Esporre la state machine di `server/game.js` (Fase 5) via eventi Socket.io, creare un
frontend player minimale e validare una partita completa end-to-end. Risolve anche il
punto aperto della roadmap: riavvio partita da `FINAL_LEADERBOARD`.

## Vincolo trasversale: portabilità Raspberry Pi

Tutto il codice deve girare nativamente su Linux/ARM senza modifiche:

- Solo JavaScript puro, zero moduli nativi.
- Il client Socket.io è servito dal server stesso (`/socket.io/socket.io.js`),
  **niente CDN**: deve funzionare offline quando il Pi fa da access point.
- `socket.io-client` (necessario solo per il tool di test) è puro JS e va in
  `devDependencies`.
- Nessun percorso o comando Windows-specifico nel codice applicativo.

## Decisioni prese

| Tema | Decisione |
|---|---|
| Sessioni simultanee | **Una sola** partita globale in memoria. Niente PIN/codici stanza (un Pi = un host = una partita). |
| Chiusura domanda | Timer `setTimeout` lato server allo scadere di `time_limit_s`, **più** chiusura anticipata se tutti i giocatori hanno risposto. |
| Riavvio da FINAL_LEADERBOARD | **Nuova `GameSession`** con lo stesso quiz, re-registrazione dei giocatori connessi. `game.js` resta immutato. Niente `resetGame()` nella state machine. |
| Player minimale | **Sostituisce** `client/player/` (index.html + app.js). Fase 7 aggiunge il design sopra la stessa logica socket. |
| Host UI | **Cablaggio minimo funzionale** della schermata game esistente. Rifiniture in Fase 7. |
| Auth host su socket | **JWT in `socket.handshake.auth.token`**, verificato con lo stesso segreto delle API REST. |
| Struttura codice | Nuovo modulo **`server/game-socket.js`** che esporta `attachGameHandlers(io)`. |

## Architettura

Tre livelli netti:

```
server/index.js        bootstrap (immutato salvo aggancio attachGameHandlers(io))
server/game-socket.js  NUOVO — rete: eventi, timer reali, auth, ciclo vita sessione
server/game.js         IMMUTATO — state machine pura
```

- Sessione: variabile di modulo `currentSession` in `game-socket.js` (singola partita).
- Room Socket.io: `players` e `host` per broadcast mirati.
- L'host è il socket che presenta un JWT valido nell'handshake.

## Protocollo eventi

### Player → Server (con ack callback)

| Evento | Payload | Ack |
|---|---|---|
| `player:join` | `{ nickname }` | `{ ok: true, playerId }` oppure `{ ok: false, error }` |
| `player:answer` | `{ optionIndex }` | `{ ok: true, correct, pointsAwarded }` oppure `{ ok: false, error }` |

### Host → Server (solo socket autenticato, con ack callback)

| Evento | Payload | Effetto |
|---|---|---|
| `host:create-game` | `{ quizId, quizType }` | Carica quiz dal DB (`quizType`: `personal` \| `preloaded`), crea `GameSession`, apre lobby. |
| `host:start-game` | — | `startGame()`, broadcast prima domanda, arma timer. |
| `host:next-question` | — | `nextQuestion()`: domanda successiva o classifica finale. |
| `host:restart-game` | — | Da `FINAL_LEADERBOARD`: nuova sessione, stesso quiz, stessi giocatori. |
| `host:end-game` | — | Distrugge la sessione, notifica e disconnette i player. |

### Server → Client (broadcast)

| Evento | Payload | Quando |
|---|---|---|
| `game:lobby-update` | `{ players }` | Ogni join/leave in lobby (e dopo riavvio). |
| `game:question` | `{ index, total, text, options, time_limit_s, endsAt }` | Inizio round. Domanda sanitizzata via `getCurrentQuestion()` — **mai** `correct_index`. `endsAt` = timestamp assoluto fine round per countdown client. |
| `game:results` | Output di `endQuestion()` (correctIndex, distribution, answers, leaderboard) | Chiusura round. |
| `game:final` | `{ leaderboard }` | Ultima domanda chiusa. |
| `game:reset` | `{ playerId }` (per-socket: ogni giocatore riceve il proprio nuovo id; segue `game:lobby-update` broadcast) | Dopo `host:restart-game`. |
| `game:answer-count` | `{ answered, total }` (solo room host) | Dopo ogni risposta valida. |
| `game:ended` | — | Host ha terminato la partita. |
| `game:snapshot` | Output di `getSnapshot()` | Al connect di un client se esiste una sessione (riallineamento/riconnessione). |

## Timer e chiusura domanda

- Su `host:start-game` / `host:next-question`: chiamata alla state machine, broadcast
  `game:question`, `setTimeout(time_limit_s * 1000)`.
- Dopo ogni `player:answer` riuscito: se `currentAnswers.size === players.size`,
  chiusura anticipata.
- Chiusura (timeout o anticipata): `clearTimeout`, `endQuestion()`, broadcast
  `game:results`.
- Ogni transizione cancella i timer pendenti — mai doppie chiusure.

## Riavvio partita

`host:restart-game` (valido solo in `FINAL_LEADERBOARD`):

1. Crea `new GameSession(stessoQuiz)`.
2. Re-registra ogni giocatore ancora connesso con lo stesso nickname (nuovo `playerId`).
3. Comunica i nuovi id via `game:reset`, broadcast lobby.

La state machine non cambia: la logica di riavvio vive nel layer che possiede il ciclo
di vita delle sessioni.

## Errori e disconnessioni

- Errori della state machine (nickname duplicato, già risposto, stato invalido, ecc.)
  → catturati e ritornati nell'ack `{ ok: false, error: message }`. Mai crash.
- Disconnect player → `removePlayer()` + `game:lobby-update`; se era l'ultimo che
  mancava per rispondere, chiusura anticipata del round.
- Disconnect host → la partita resta viva; al riconnect l'host si riallinea via
  `game:snapshot`.
- Evento host da socket non autenticato → `{ ok: false, error: 'Non autorizzato' }`.

## Frontend

### Player minimale (`client/player/`)

Una pagina, zero design (→ Fase 7), sezioni mostrate/nascoste in base allo stato:

1. Form nickname (validazione base, errori da ack).
2. Attesa lobby (lista giocatori).
3. Domanda: 4 bottoni risposta + countdown testuale (da `endsAt`).
4. Feedback: giusto/sbagliato + punti.
5. Classifica finale.

Client Socket.io da `/socket.io/socket.io.js` (servito dal server, no CDN).

### Host (schermata game esistente, cablaggio minimo)

- All'apertura della schermata: `host:create-game`.
- Lobby: lista giocatori live, bottone Avvia.
- Round: domanda corrente, conteggio risposte live.
- Results: distribuzione risposte, classifica, bottone Prossima.
- Final: classifica, bottoni Riavvia / Termina.
- JWT da `localStorage` (già presente dopo login) passato in `socket.handshake.auth`.

## Testing

- **`tools/test-socket.js`** (automatico, stile `test-game.js`): connette 1 host
  (JWT reale via login o token generato con lo stesso segreto) + 2 player con
  `socket.io-client`, gioca una partita completa — join, start, risposte, results,
  next, final, restart — e verifica eventi e payload con assert + report finale.
- **E2E manuale**: host da browser PC, player da smartphone sulla stessa rete Wi-Fi.
  Chiude la Fase 6 della roadmap.

## Fuori scope (→ Fase 7)

- Design/UX del player mobile.
- Rifinitura grafica dei controlli host.
- Gestione avanzata riconnessione a metà round (il player rientra alla domanda
  successiva; lo snapshot basta per riallineare la vista).
- Playtesting multi-dispositivo approfondito, latenza, bugfixing beta.
