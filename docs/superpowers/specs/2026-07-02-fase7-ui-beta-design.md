# Fase 7 — Rifinitura UI, Riconnessione e Beta (Design)

Data: 2026-07-02 · Branch: `Step-7` · Stato: approvato dall'utente

## Obiettivo

Portare Quiz-Zata! alla versione Beta giocabile dal vivo: UI Player definitiva
mobile-first, riconnessione dei giocatori con conservazione del punteggio,
rifinitura della schermata di conduzione partita Host con QR code di ingresso,
playtest locale e su Wi-Fi reale.

Ordine di lavoro concordato: **Player prima, poi Host**.

## Fuori scope

- Schema DB, API REST, dashboard/editor host, flusso di login: invariati.
- Import CSV/Excel (residuo Fase 2), licenza SaaS, deploy Raspberry Pi.
- Refactor del CSS host in token condivisi (valutabile in futuro).

## 1. Player UI (mobile-first, Retro Street)

**File:** `client/player/index.html` riscritto; nuovo `client/player/style.css`
autonomo che replica i token del design system (DESIGN.md): palette calda satura,
bordi Ink 4px, ombre stamp senza blur, Quicksand peso minimo 700. Nessun foglio
condiviso con l'host per evitare regressioni sul CSS esistente (scelta esplicita).
`client/player/app.js` esteso mantenendo la struttura a schermate e gli eventi
socket già validati in Fase 6.

**Schermate** (una visibile alla volta):

| Schermata | Contenuto |
|---|---|
| Join | Logo, input nickname (bordo Ink 3px, focus con anello), **selettore avatar** (griglia di ~12 animali, selezione con bordo/ombra stamp), CTA gialla Insert-Coin. Errore: shake + rosso + icona (mai solo colore). |
| Lobby | Sticker ruotato "Sei dentro!", avatar + nickname propri in evidenza, giocatori come badge pillola con avatar, attesa host. |
| Domanda | Badge progresso "3/10", testo domanda headline 900, countdown = barra terracotta che si svuota + numero grande. Opzioni: bottoni arcade full-width in stack verticale, lettera A–D, superfici a colori alternati della palette (giallo/teal/ocra/bianco), bordo 4px, ombra stamp, press = translate fisico. Dopo la risposta: bottoni bloccati, il proprio evidenziato, sticker "Risposta inviata!". |
| Feedback | Sticker grande con icona: verde "GIUSTO! +N" / rosso "SBAGLIATO" / neutro "Tempo scaduto". Punteggio totale + posizione ("Sei 4° su 12"). |
| Finale | Podio top 3 (1° al centro, più alto) + propria posizione se fuori podio. Nessun bottone: il riavvio è dell'host (`game:reset` → lobby). |
| Messaggio / Riconnessione | "Connessione persa, riconnessione…" con spinner; se il rejoin fallisce, invito a ricaricare. |

**Avatar (precaricati):**
- Set fisso di ~12 animali identificati da **`avatarId` stabile** (`volpe`, `panda`,
  `rana`, `polpo`, …). Il server valida e memorizza solo l'id; la resa visiva è
  responsabilità del client.
- Resa attuale: mappa client `avatarId → emoji` (temporanea). In futuro l'utente
  fornirà SVG propri: si sostituirà solo la mappa (`avatarId → file SVG`), senza
  toccare server, eventi o dati salvati.
- Scelto al join (griglia sotto il nickname, uno preselezionato a caso).
  Duplicati permessi: l'identità resta il nickname (già unico).
- L'avatar appare ovunque appaia il giocatore: lobby (player e host), contatore
  risposte no, classifiche parziali/finali, podio, feedback personale.
- `game.js`: `addPlayer(nickname, avatarId)` con validazione contro la lista
  degli id consentiti (esportata dal modulo); il player guadagna campo `avatar`.
  `player:join` accetta `{ nickname, avatarId }`; avatar conservato al rejoin e
  al restart.

**Vincoli:** la domanda e le opzioni complete si leggono sul telefono (funziona
senza proiettore — scelta esplicita); WCAG AA (contrasto ≥4.5:1, focus visibile);
`prefers-reduced-motion` rispettato con alternativa istantanea; zero blur nelle
ombre; identità propria, niente simboli geometrici alla Kahoot.

## 2. Riconnessione con punteggio (token di sessione)

Scelta rispetto al rejoin per nickname: il token segreto impedisce il furto di
identità tra giocatori.

**`server/game.js`** (resta puro):
- Player: nuovo campo `connected: true`.
- Nuovo metodo `setPlayerConnected(playerId, bool)`.
- `getPlayers()` / `getSnapshot()` espongono il flag. Nessun timer, nessuna rete.

**`server/game-socket.js`:**
- Al join il server genera un token (`randomUUID`); ack: `{ playerId, token }`.
  Mappa modulo `playerTokens: token → playerId`.
- Disconnect in `LOBBY`: rimozione immediata come oggi, token invalidato.
- Disconnect in partita: `setPlayerConnected(false)`; il player resta con il suo
  punteggio. Grace period = fino a fine partita (nessun timer di rimozione).
- `maybeCloseEarly` conta solo i player connessi; se i connessi sono 0 non chiude
  (chiude il timer della domanda).
- Nuovo evento `player:rejoin { token }`: valida il token, riassocia il socket,
  `setPlayerConnected(true)`, ack con lo stato per ridisegnare la schermata:
  `state`, domanda corrente + `endsAt` (memorizzato a livello modulo), flag "ho
  già risposto", punteggio proprio, leaderboard se `FINAL_LEADERBOARD`.
- Restart: i player riregistrati ricevono un nuovo token dentro `game:reset`.
  `endCurrentGame` svuota la mappa token.

**Client player:**
- `{ token, playerId, nickname }` in `sessionStorage` (sopravvive al reload della
  pagina e al retry automatico di Socket.io, resta isolato per scheda).
- Su ogni `connect` con token salvato → `player:rejoin`; successo = schermata
  ripristinata (incluso countdown residuo da `endsAt`); fallimento = storage
  pulito, ritorno al join. Durante il retry: schermata "Riconnessione…".
- `game:ended` pulisce lo storage.

**Host:** invariato lato riconnessione (riceve già lo snapshot al connect); la
lobby host mostra i player disconnessi in grigio con icona.

## 3. Schermata conduzione Host + QR code

**QR code (feature core README, oggi assente):**
- Nuovo endpoint `GET /api/game/join-info` (autenticato host): legge
  `os.networkInterfaces()`, restituisce `{ url: "http://<ip-lan>:<porta>" }`.
- Libreria QR **vendored** (un solo file, licenza MIT, es. `qrcode-generator`)
  in `client/host/vendor/` — zero build, zero CDN (vincolo offline-first).
- In lobby host: card grande con QR + URL in tipografia display, leggibile a
  distanza da una stanza intera.

**Area live host** (solo restyling in `client/host/style.css`, logica già
cablata in Fase 6):
- Lobby: QR + contatore giocatori grande + badge pillola con avatar + nickname,
  disconnessi in grigio.
- Domanda: testo headline, opzioni come card lettera A–D (solo visualizzazione),
  contatore risposte grande "5/12".
- Risultati: distribuzione risposte come barre orizzontali (larghezza % CSS,
  conteggio visibile), barra della risposta corretta in verde + icona,
  classifica parziale top 5.
- Finale: podio top 3 + lista completa.

## 4. Error handling

- Ack falliti e `connect_error`: toast (già presenti, si mantengono).
- `join-info` fallito: fallback testuale con solo URL.
- Socket host caduto: retry automatico Socket.io + snapshot al reconnect (già
  gestito dal server); stato visivo "riconnessione" sull'host.

## 5. Testing e playtest

1. `tools/test-socket.js` esteso con scenari rejoin: disconnessione in QUESTION,
   rejoin con punteggio conservato, token invalido, rejoin dopo restart
   (`npm run test:socket`).
2. Playtest locale multi-tab (host + 2 player) con browser preview: partita
   completa + drop forzato del socket.
3. Playtest su Wi-Fi reale con smartphone (a carico dell'utente) con checklist:
   latenza, blocco schermo, reload, uscita dal Wi-Fi.
4. Bugfix → versione Beta.

## Decisioni registrate

| Decisione | Scelta | Alternativa scartata |
|---|---|---|
| Ordine di lavoro | Player prima, poi Host | Host prima; in parallelo |
| QR code | In Fase 7, lobby host | Rimandato |
| Contenuto telefono in QUESTION | Domanda + opzioni complete | Solo pulsantiera |
| Riconnessione | Token di sessione con punteggio | Nickname-based; solo lobby |
| CSS player | Foglio autonomo, stessi token | Token condivisi estratti |
| Avatar | Emoji temporanee dietro `avatarId` stabile, SVG futuri dell'utente | Solo nickname; SVG subito |
