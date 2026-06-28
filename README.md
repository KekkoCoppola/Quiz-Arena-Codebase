<p align="center">
  <img src="resources/img/LogoHalfWall.png" alt="Quiz-Zata! Logo" width="300" style="border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.15);">
</p>

<h1 align="center">Quiz-Zata!</h1>

<p align="center">
  <strong>Il motore di gioco a quiz multiplayer locale e in tempo reale per Raspberry Pi.</strong><br>
  Un'alternativa a Kahoot completamente offline, autonoma e self-hosted, progettata per eventi, aule scolastiche, pub e fiere.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js_v24+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="NodeJS">
  <img src="https://img.shields.io/badge/Socket.io-010101?style=for-the-badge&logo=socketdotio&logoColor=white" alt="Socket.io">
  <img src="https://img.shields.io/badge/SQLite-07405E?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite">
  <img src="https://img.shields.io/badge/Raspberry%20Pi-A22846?style=for-the-badge&logo=raspberrypi&logoColor=white" alt="Raspberry Pi">
</p>

---

## 📌 Cos'è Quiz-Zata!?

**Quiz-Zata!** è una piattaforma di quiz interattivi multiplayer in tempo reale che funziona **completamente offline**. Viene eseguita a bordo di un **Raspberry Pi** configurato come Access Point Wi-Fi isolato. 

I giocatori possono connettersi istantaneamente dal proprio smartphone inquadrando un **QR Code** o navigando all'indirizzo IP locale, senza installare alcuna applicazione o aver bisogno di una connessione internet attiva. L'host controlla la partita, le domande e la classifica in tempo reale tramite una dashboard dedicata.

---

## 🚀 Caratteristiche Principali

- **🔌 100% Offline-First:** Non necessita di connessione ad internet né di router esterni. Il Raspberry Pi crea la propria rete Wi-Fi dedicata.
- **⚡ Real-Time WebSockets:** Interazioni istantanee a bassissima latenza tra host e giocatori grazie a **Socket.io**.
- **📱 Zero Barriere d'Ingresso:** I giocatori scansionano il QR Code generato a schermo e partecipano direttamente dal proprio browser mobile preferito.
- **🎯 Gamification in Stile Kahoot:** Assegnazione dei punteggi dinamica basata sulla velocità e correttezza della risposta.
- **🛠️ Gestione Quiz Flessibile:** Creazione dei quiz da interfaccia amministrativa (con account host e limite di 3 quiz personalizzati salvabili) o importazione massiva da file **CSV/Excel**.
- **🔒 Hardware Lock & Licenza SaaS:** Sistema di protezione e attivazione SaaS a tempo, vincolato al seriale hardware della CPU del Raspberry Pi (fonte preferita: `/proc/device-tree/serial-number`) verificato periodicamente tramite le API private di GitHub con PAT fine-grained in sola lettura.
- **📦 Distribuzione Singolo Binario:** Backend compilato in un unico file eseguibile per architettura ARM tramite le [Node.js Single Executable Applications (SEA)](https://nodejs.org/api/single-executable-applications.html), la via ufficialmente supportata dal runtime Node.js.

---

## 🛠️ Stack Tecnologico

- **Runtime:** Node.js (v24+)
- **Server Web:** Express.js + Socket.io (WebSocket in tempo reale)
- **Database:** SQLite via [`node:sqlite`](https://nodejs.org/api/sqlite.html) — modulo integrato nel core di Node.js v24+, stabile, API sincrona, **zero dipendenze esterne e zero moduli nativi da gestire**. Elimina completamente le problematiche di compilazione C++ e di packaging SEA che caratterizzavano `better-sqlite3`.
- **Sicurezza:** Hashing delle password host tramite `bcryptjs` (pura implementazione JavaScript, per evitare le problematiche di packaging SEA associate a moduli nativi come `bcrypt` standard).
- **Frontend:** HTML5, CSS3 Custom (Vanilla CSS con design responsive moderno), JavaScript Vanilla (SPA leggera)
- **Compilazione & Packaging:** [Node.js Single Executable Applications (SEA)](https://nodejs.org/api/single-executable-applications.html) — funzionalità integrata nel runtime, sostituto ufficiale di `pkg` (archiviato e non più mantenuto dal dicembre 2024). Grazie all'adozione di `node:sqlite`, il backend non ha moduli nativi esterni da gestire come asset SEA.
- **Sistema Host:** Linux (Debian/Raspbian OS) configurato con `hostapd` per l'Access Point Wi-Fi e `dnsmasq` per il routing DNS locale (dominio `quizzata.gioca`)

---

## 🌐 Architettura di Rete

Quiz-Zata! non richiede infrastruttura esterna. Il Raspberry Pi funge da server e da router Wi-Fi contemporaneamente:

```text
               +----------------------------------------+
               |  Raspberry Pi (Hotspot "QuizZata")    |
               |             IP: 192.168.4.1            |
               +----------------------------------------+
                                   |
         +-------------------------+-------------------------+
         |                                                   |
         v                                                   v
🌐 Dispositivo Host                               📱 Smartphone Giocatori
   Apre: http://quizzata.gioca/admin-console        Aprono: http://quizzata.gioca (o QR Code)
   Fallback: http://192.168.4.1/admin-console        Fallback: http://192.168.4.1
   (URL host oscurato e personalizzabile da .env)    (⚠️ DNS-over-HTTPS può ignorare il DNS locale)
   - Avvia e controlla i quiz                        - Inseriscono il nickname
   - Mostra domande, grafici e classifiche           - Inviano le risposte in tempo reale
```

---

## 🔄 Flusso di Gioco (State Machine)

Il flusso di una partita segue una macchina a stati solida e sincronizzata in tempo reale:

```text
   [ LOBBY ] ➔ I giocatori entrano e scelgono un nickname.
       │
       ▼
 [ QUESTION ] ➔ Domanda a schermo con countdown; risposte abilitate su mobile.
       │
       ▼
  [ RESULTS ] ➔ Mostra la risposta corretta, grafici di risposta e classifica parziale.
       │
       ├─➔ (Se ci sono altre domande, torna a QUESTION)
       ▼
[ FINAL_LEADERBOARD ] ➔ Podio finale dei vincitori e opzione di riavvio.
```

---

## 🗂️ Struttura del Progetto

Il codice è organizzato in modo modulare per separare nettamente le responsabilità di backend, frontend e strumenti interni:

```text
quiz-zata/
├── server/
│   ├── index.js              # Entrypoint: avvia il server Express/Socket.io (+ hook licenza in produzione)
│   ├── config.js             # Configurazione centralizzata: legge .env, valida, ri-esporta
│   ├── license.js            # (Fase Futura) Modulo licenza: controlli GitHub API + gestione cache locale
│   ├── game.js               # Macchina a stati di gioco e logica WebSocket
│   ├── quiz-manager.js       # Gestore database SQLite (node:sqlite) per CRUD quiz e importazioni
│   ├── routes/
│   │   ├── host.js           # Endpoint API per pannello amministratore
│   │   └── player.js         # Endpoint API per interfacce giocatori
│   └── db/
│       ├── schema.sql        # Struttura delle tabelle database SQLite
│       └── database.sqlite   # Database SQLite locale autogenerato (escluso da git)
├── client/
│   ├── host/                 # Frontend Dashboard di controllo per l'Host
│   │   ├── index.html
│   │   └── app.js
│   └── player/               # Frontend Mobile-Responsive per i Giocatori
│       ├── index.html
│       └── app.js
├── tools/
│   └── generate-license.js   # Script di utility interno per generare e caricare licenze
├── .env.example              # Template variabili d'ambiente (committato)
├── .env                      # Valori reali — escluso da git
└── package.json              # Dipendenze e script NPM del progetto
```

---

## 🔑 Flusso del Sistema di Licenza SaaS

Il software integra un meccanismo di licenza a tempo vincolato all'hardware per l'utilizzo commerciale su base abbonamento:

```
[ Raspberry Pi Boot ] ──▶ [ Controlla Connessione Internet ]
                                  │
         ┌────────────────────────┴────────────────────────┐
         ▼ SI                                              ▼ NO
[ Fetch da GitHub Repo Privato ]                  [ Leggi Cache Licenza Locale ]
         │                                                 │
         ├────────────────────────┬────────────────────────┘
         ▼                        ▼
[ Verifica Serial CPU ]  ▶  [ Verifica Scadenza ] ──▶ [ Valida (Grace period: 7gg) ]
                                                            │
                                         ┌──────────────────┴──────────────────┐
                                         ▼ OK                                  ▼ FALLITO / SCADUTO
                                  [ Avvia Quiz-Zata! ]                  [ Blocca Esecuzione ]
```

1. **GitHub come Backend:** Le licenze sono memorizzate come file JSON nella cartella `licenze/<serial_pi>.json` di un repository privato GitHub (utilizzando il piano gratuito di GitHub).
2. **Validazione Hardware:** Il server legge l'identificativo seriale unico del chip Raspberry Pi dalla fonte preferita `/proc/device-tree/serial-number` (più affidabile di `/proc/cpuinfo`, che può essere sovrascritto da U-Boot). Da testare sul modello/OS specifico prima di costruire la logica finale.
3. **Grace Period Offline:** Il sistema richiede una connessione ad internet per il rinnovo della licenza almeno una volta ogni 7 giorni. In caso di mancanza di rete, si appoggia ad una cache locale crittografata. *(Nota: la chiave di decifrazione risiede nello stesso binario, il che protegge da manomissioni casuali ma non da un reverse engineer motivato — accettabile per il mercato target.)*
4. **Costi di Infrastruttura e Manutenzione Zero:** Non sono necessari server cloud dedicati né database SaaS a pagamento. Tutto il database risiede in locale su SQLite, e GitHub gestisce la distribuzione delle licenze a costo zero. L'unico costo fisico del progetto è l'hardware del Raspberry Pi.
5. **Sicurezza del PAT:** Utilizzare un PAT **fine-grained**, limitato in scope al solo repository licenze e con permessi di **sola lettura**. Se un singolo binario viene decompilato e il PAT estratto, l'attaccante otterrebbe accesso a tutte le licenze nel repository — non solo alla propria. Tenere a mente questo rischio quando il numero di installazioni crescerà.

---

## 📋 Ordine di Sviluppo Concordato

Il progetto viene sviluppato seguendo un approccio **Game-First**: prima si costruisce e si valida l'intero gioco su PC, poi si integrano i vincoli hardware e la licenza quando il Raspberry Pi sarà disponibile.

### Fase Attiva — Sviluppo su PC (senza hardware Pi)

1. **Step 1:** Setup progetto Node.js — Struttura cartelle, dipendenze, `.env` e `.gitignore`. Database via `node:sqlite` (stabile in Node.js v24, integrato nel runtime, zero dipendenze native).
2. **Step 2:** `server/quiz-manager.js` + SQLite Schema — Tabelle `users` (host, password hashate con **bcryptjs**, implementazione JS pura) e `quizzes` (max 3 per utente), import CSV/Excel.
3. **Step 3:** `server/index.js` — Bootstrap del server Express, configurazione Socket.io.
4. **Step 4:** `server/game.js` — Logica centrale e macchina a stati del gioco (LOBBY → QUESTION → RESULTS → FINAL_LEADERBOARD).
5. **Step 5:** Socket.io Integration — Configurazione ed eventi real-time tra Host e Player.
6. **Step 6:** Frontend Host — UI della dashboard amministrativa (login, gestione quiz, conduzione partita).
7. **Step 7:** Frontend Player — Interfaccia mobile responsive, pulsanti di risposta e feedback.

### Fase Futura — Richiede l'Hardware Raspberry Pi

8. **Step 8:** `server/license.js` — Integrazione GitHub API + cache locale + hardware lock (`/proc/device-tree/serial-number`).
9. **Step 9:** `tools/generate-license.js` — Script CLI interno per generare e pushare nuove licenze.
10. **Step 10:** Script di Deploy per Pi — Automazione installazione di `hostapd`, `dnsmasq`, installazione esplicita di **Node.js v22+** (via NodeSource o binari ufficiali, per superare i limiti dell'apt di sistema), compilazione binario ARM con Node.js SEA e avvio al boot.

---

## 👨‍💻 Autore e License

<div align="center">
  <a href="https://github.com/KekkoCoppola">
    <img src="https://github.com/KekkoCoppola.png" width="80" style="border-radius: 50%; border: 3px solid #38B2AC;" alt="Avatar" />
  </a>
  <br />
  <strong>Francesco Coppola</strong>
  <br />
  <p>Progetto Proprietario - Tutti i Diritti Riservati <br> 📧 fcoppola.dev@gmail.com</p>
</div>

