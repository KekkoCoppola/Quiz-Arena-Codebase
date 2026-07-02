# 🚀 Quiz-Zata! - Roadmap di Sviluppo Locale (PC-First)

Questa roadmap delinea gli step per sviluppare l'intero gioco sul PC locale (Windows), ignorando momentaneamente i vincoli hardware (licenza e Access Point) che verranno affrontati in futuro quando sarà disponibile il Raspberry Pi.

> **TASSATIVO:** Tutto il codice applicativo scritto in queste fasi funzionerà in modo nativo su Linux (Raspberry Pi) senza modifiche, grazie alla natura cross-platform di Node.js e SQLite. L'unica eccezione è la fase di compilazione in binario singolo (Node.js SEA), che richiederà di essere eseguita sull'architettura ARM target.

## 🛠️ Architettura Locale di Sviluppo
- **Server:** Gira su `localhost:3000` del PC.
- **Database:** File locale `server/db/database.sqlite` (escluso dal repository Git).
- **Test Host:** Dal browser del PC navigando a `http://localhost:3000/admin-console` (o l'URL definita in `.env`).
- **Test Giocatori:** Dallo smartphone connesso al **Wi-Fi di casa**, navigando all'IP locale del PC (es. `http://192.168.1.X:3000`).

---

## 📋 Fasi di Sviluppo

### Fase 1: Setup Progetto e Struttura Base - *Completata*
- [x] Inizializzare progetto Node.js (`npm init -y`).
- [x] Creare la struttura di cartelle (`server/`, `client/host/`, `client/player/`).
- [x] Installare dipendenze core: `express`, `socket.io`, `bcryptjs`, `dotenv`, `jsonwebtoken`. Il database SQLite viene gestito da `node:sqlite` (integrato nel runtime Node.js v24+, nessuna installazione necessaria).
- [x] Configurare il file `.env` (porta del server, URL pannello host, segreto sessione).

### Fase 2: Database SQLite & Autenticazione Host - *Completata (Parziale)*
- [x] Creare lo schema SQL per le tabelle `users` (host, password hashate con **bcryptjs**) e `quizzes` (quiz salvati). *(Aggiunta anche `preloaded_quizzes`.)*
- [x] Implementare `server/quiz-manager.js` per inizializzare il DB locale.
- [x] Creare API in `server/routes/host.js` per gestire login e CRUD dei quiz.
- [x] Implementare il controllo lato server: limite di **3 quiz personalizzati** per utente host.
- [ ] **Import massivo quiz da CSV/Excel** (non ancora implementato — presente nello scope README, assente nel codice).

### Fase 3: Core del Web Server - *Completata*
- [x] Configurare Express in `server/index.js`.
- [x] Servire le pagine statiche del frontend Host e Player.
- [x] Configurare Socket.io e agganciarlo al server Express. *(Solo bootstrap: connection + ping/pong. Eventi di gioco → Fase 6.)*

### Fase 4: Sviluppo Frontend Host (UI-First) - *Completata (Parziale)*
- [x] Creare la pagina di Login per l'Host.
- [x] Dashboard: UI per visualizzare quiz precaricati, i propri salvati o crearne di nuovi.
- [x] Interfaccia di gestione partita (UI placeholder, logica e bottoni da collegare).
- [x] **Grafica:** Utilizzare CSS moderno (Vanilla) per un look premium e accattivante.
*(Nota: L'implementazione completa della UI host si sospende qui in attesa dell'engine di gioco).*

### Fase 5: Motore di Gioco (State Machine) - *Completata*
- [x] Implementare la logica "pura" in `server/game.js` (LOBBY -> QUESTION -> RESULTS -> FINAL_LEADERBOARD).
- [x] Logica in-memory testabile (senza rete o UI): registrazione giocatori, timer, calcolo dei punteggi basato su velocità e correttezza.
  *(Timer via timestamp iniettati (`now`), non `setTimeout` reale — resta puro/deterministico. Il countdown reale + eventi Socket.io arrivano in Fase 6. Smoke test: `tools/test-game.js`, 39/39 verifiche superate.)*

> **Nota terminologia:** i commenti nel codice e il README usano la parola "Step N", questa roadmap usa "Fase N" — **stessa numerazione** (Step 5 = Fase 5, ecc.). Riferimenti allineati.

### Fase 6: Integrazione Socket.io & Test E2E Minimale - *Completata*
- [x] Gestire eventi Socket.io per esporre la state machine di `game.js`.
- [x] Creare un Frontend Player **minimale** (solo bottoni base e form nome, zero design) per testare le funzionalità.
- [x] Validare una partita completa end-to-end (Host UI attuale -> Server Socket -> Player minimale).
- [x] **Riavvio partita da FINAL_LEADERBOARD** (previsto in Istructions.md, non ancora in `game.js`): valutare se aggiungere `resetGame()` a `GameSession` o istanziare una nuova sessione lato Socket.io. Da decidere qui perché la scelta dipende da come Fase 6 gestisce il ciclo di vita delle sessioni in memoria.
  *(Implementato in `server/game-socket.js` (una partita globale, timer server con chiusura anticipata, auth host JWT su handshake). Riavvio da FINAL_LEADERBOARD: nuova `GameSession` lato socket, `game.js` immutato. Test integrazione: `npm run test:socket`. Design spec: `docs/superpowers/specs/2026-07-02-fase6-socketio-design.md`.)*

### Fase 7: Rifinitura UI e Playtesting Locale
- [ ] Cablare il vero engine di gioco alla UI dell'Host (attivare controlli "disabilitati").
- [ ] Sviluppare il Frontend Player finale ("mobile first", dinamico e reattivo).
- [ ] Connettere il PC e alcuni smartphone alla stessa rete Wi-Fi.
- [ ] Giocare una partita completa per testare latenza, socket, disconnessioni.
- [ ] Bugfixing per arrivare alla versione Beta.

---

### 🔮 Fasi Future (Richiedono l'Hardware Raspberry Pi)
*(In Sospeso)*
1. Implementazione sistema di **Licenza SaaS** hardware lock (`/proc/device-tree/serial-number`, preferito a `/proc/cpuinfo` che può essere sovrascritto da U-Boot) + GitHub API con PAT **fine-grained** in sola lettura.
2. Script di deploy per sistema Linux (installazione manuale **Node.js v24+** via NodeSource o binari ufficiali, configurazione `hostapd`, `dnsmasq` con fallback IP `192.168.4.1` garantito per DNS-over-HTTPS).
3. Compilazione del server in binario ARM con **Node.js SEA** (Single Executable Applications) — sostituto ufficiale di `pkg` (archiviato, dicembre 2024). Grazie all'adozione di `node:sqlite` (integrato nel runtime), **non esistono moduli nativi da compilare per ARM o da includere come asset esterno nel binario SEA**.
