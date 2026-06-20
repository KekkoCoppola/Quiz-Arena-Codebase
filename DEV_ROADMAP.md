# 🚀 Quiz Arena - Roadmap di Sviluppo Locale (PC-First)

Questa roadmap delinea gli step per sviluppare l'intero gioco sul PC locale (Windows), ignorando momentaneamente i vincoli hardware (licenza e Access Point) che verranno affrontati in futuro quando sarà disponibile il Raspberry Pi.

> **TASSATIVO:** Tutto il codice applicativo scritto in queste fasi funzionerà in modo nativo su Linux (Raspberry Pi) senza modifiche, grazie alla natura cross-platform di Node.js e SQLite. L'unica eccezione è la fase di compilazione in binario singolo (Node.js SEA), che richiederà di essere eseguita sull'architettura ARM target.

## 🛠️ Architettura Locale di Sviluppo
- **Server:** Gira su `localhost:3000` del PC.
- **Database:** File locale `server/db/database.sqlite` (escluso dal repository Git).
- **Test Host:** Dal browser del PC navigando a `http://localhost:3000/admin-console` (o l'URL definita in `.env`).
- **Test Giocatori:** Dallo smartphone connesso al **Wi-Fi di casa**, navigando all'IP locale del PC (es. `http://192.168.1.X:3000`).

---

## 📋 Fasi di Sviluppo

### Fase 1: Setup Progetto e Struttura Base
- [ ] Inizializzare progetto Node.js (`npm init -y`).
- [ ] Creare la struttura di cartelle (`server/`, `client/host/`, `client/player/`).
- [ ] Installare dipendenze core: `express`, `socket.io`, `better-sqlite3`, `bcryptjs`, `dotenv`.
- [ ] Configurare il file `.env` (porta del server, URL pannello host, segreto sessione).

### Fase 2: Database SQLite & Autenticazione Host
- [ ] Creare lo schema SQL per le tabelle `users` (host, password hashate con **bcryptjs**) e `quizzes` (quiz salvati).
- [ ] Implementare `server/quiz-manager.js` per inizializzare il DB locale.
- [ ] Creare API in `server/routes/host.js` per gestire registrazione, login, creazione e salvataggio dei quiz.
- [ ] Implementare il controllo lato server: limite di **3 quiz personalizzati** per utente host.

### Fase 3: Core del Web Server
- [ ] Configurare Express in `server/index.js`.
- [ ] Servire le pagine statiche del frontend Host e Player.
- [ ] Configurare Socket.io e agganciarlo al server Express.

### Fase 4: Sviluppo Frontend Host (Il Pannello di Controllo)
- [ ] Creare la pagina di Login per l'Host.
- [ ] Dashboard: UI per visualizzare quiz precaricati, i propri salvati o crearne di nuovi.
- [ ] Interfaccia di gestione partita (avvia quiz, prossima domanda, mostra classifica).
- [ ] **Grafica:** Utilizzare CSS moderno (Vanilla) per un look premium e accattivante.

### Fase 5: Motore di Gioco (State Machine)
- [ ] Implementare la logica in `server/game.js` (LOBBY -> QUESTION -> RESULTS -> FINAL_LEADERBOARD).
- [ ] Gestire i punteggi in base alla velocità e alla correttezza delle risposte.
- [ ] Gestire eventi Socket.io per sincronizzare Host e Player in tempo reale.

### Fase 6: Sviluppo Frontend Player (Mobile)
- [ ] Creare l'interfaccia mobile per l'inserimento del Nickname.
- [ ] Schermata di attesa (Lobby).
- [ ] Schermata dinamica dei pulsanti di risposta.
- [ ] Schermata di feedback (Giusto/Sbagliato + punti).
- [ ] **Grafica:** Estremamente reattiva al tap e pensata per l'uso mobile ("mobile first").

### Fase 7: Versione Alpha & Playtesting Locale
- [ ] Connettere il PC e alcuni smartphone alla stessa rete Wi-Fi.
- [ ] Giocare una partita completa per testare latenza, socket, disconnessioni e calcolo punteggi.
- [ ] Bugfixing per arrivare alla versione Beta.

---

### 🔮 Fasi Future (Richiedono l'Hardware Raspberry Pi)
*(In Sospeso)*
1. Implementazione sistema di **Licenza SaaS** hardware lock (`/proc/device-tree/serial-number`, preferito a `/proc/cpuinfo`) + GitHub API con PAT **fine-grained** in sola lettura.
2. Script di deploy per sistema Linux (installazione manuale Node.js v22+, configurazione `hostapd`, `dnsmasq` con fallback IP `192.168.4.1` garantito per DNS-over-HTTPS).
3. Compilazione del server in binario ARM con **Node.js SEA** (Single Executable Applications) — sostituto ufficiale di `pkg` (archiviato, dicembre 2024). `better-sqlite3` è un modulo nativo C++: il suo file `.node` andrà compilato per ARM e incluso come asset esterno nel binario SEA (caricato a runtime con `process.dlopen`). Se `node:sqlite` (core di Node.js) sarà stabile a quel punto, valutare la migrazione per eliminare completamente l'asset nativo.
