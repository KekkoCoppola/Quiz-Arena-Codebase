# Quiz Game — Documento di Contesto Progetto

## Obiettivo
Gioco a quiz multiplayer locale (tipo Kahoot) che funziona **completamente offline**, hostato su un **Raspberry Pi** che funge da Access Point Wi-Fi. I giocatori si connettono col proprio mobile via browser, senza installare nulla.

---

## Hardware
- **Raspberry Pi** (Zero 2W o Pi 4) — server + access point
- I giocatori usano qualsiasi smartphone con browser
- L'host (chi conduce il gioco) usa un tablet o PC connesso allo stesso AP

---

## Stack Tecnologico (100% Gratuito & Open Source)
- **Runtime:** Node.js v24+ (gratuito)
- **Server:** Express + Socket.io (WebSocket in tempo reale, gratuito)
- **DB:** SQLite via [`node:sqlite`](https://nodejs.org/api/sqlite.html) — modulo integrato nel core di Node.js v24+, stabile, API sincrona, **zero dipendenze native e zero complicazioni SEA**. Nessun file `.node` da compilare o gestire come asset esterno.
- **Sicurezza:** Hashing delle password host via `bcryptjs` (implementazione 100% JS per evitare ulteriori dipendenze native in fase di packaging SEA).
- **Frontend:** HTML/CSS/JS vanilla (SPA leggera, nessun costo di hosting/framework)
- **Compilazione:** [Node.js Single Executable Applications (SEA)](https://nodejs.org/api/single-executable-applications.html) per produrre un binario ARM singolo (sostituto ufficiale di `pkg`, archiviato dal dicembre 2024). Grazie a `node:sqlite`, non ci sono moduli nativi esterni da includere come asset SEA.
- **Sistema:** Linux su Raspberry Pi, hotspot via `hostapd` + DNS locale via `dnsmasq` (integrati e gratuiti)

---

## Architettura di Rete
```
Raspberry Pi (Access Point "QuizZata")
  └── IP fisso: 192.168.4.1 (mappato su DNS locale via dnsmasq)
        ├── Host si connette → apre http://quizzata.gioca/admin-console (custom in .env)
        │   Fallback: http://192.168.4.1/admin-console
        └── Giocatori si connettono → aprono http://quizzata.gioca (o via QR code)
            Fallback: http://192.168.4.1 (⚠️ DNS-over-HTTPS può ignorare il DNS locale)
```
Nessun router esterno necessario. Il Pi crea la propria rete Wi-Fi isolata.

---

## Sistema di Licenza (Costo Zero Infrastruttura)
- **Modello:** SaaS ad abbonamento (licenza a tempo, gestita a costo zero)
- **Meccanismo:** GitHub API su repo privato (piano gratuito di GitHub)
- **PAT GitHub:** fine-grained, **sola lettura**, limitato al solo repo licenze, incluso nel binario SEA. Se estratto, espone tutte le licenze del repo (rischio noto, accettabile per mercato piccolo).
- **Hardware lock:** il software legge il serial univoco del Pi da `/proc/device-tree/serial-number` (preferito a `/proc/cpuinfo` che può essere sovrascritto da U-Boot) e lo confronta con il file licenza. Da testare sull'hardware reale prima di finalizzare.
- **Struttura file licenza** (`licenze/<serial_pi>.json` nel repo privato):
```json
{
  "serial": "10000000abcdef12",
  "plan": "pro",
  "expires": "2026-12-31",
  "features": {
    "max_players": 30,
    "custom_quiz": true
  }
}
```
- **Flusso check:**
  1. All'avvio → fetch GitHub API
  2. Se online → scarica e verifica licenza → salva cache locale
  3. Se offline → usa cache locale (grace period 7 giorni)
  4. Se scaduta e nessun rinnovo → blocca con messaggio
  5. Check periodico ogni 7 giorni
- **Revoca:** basta eliminare o modificare il file sul repo GitHub
- **Emissione licenza:** script locale `tools/generate-license.js` che genera il JSON e lo pusha sul repo
- **Nota sulla cache locale:** la chiave di decifrazione risiede nello stesso binario; protegge da manomissioni casuali ma non da reverse engineering mirato — accettabile per il contesto target.

---

## Struttura del Progetto
```
quiz-game/
├── server/
│   ├── index.js              # Bootstrap: avvia server (+ hook licenza in produzione)
│   ├── license.js            # (Fase Futura) GitHub API check + cache locale
│   ├── game.js               # State machine partita
│   ├── quiz-manager.js       # CRUD quiz su SQLite
│   ├── routes/
│   │   ├── host.js           # API pannello host
│   │   └── player.js         # API giocatori
│   └── db/
│       ├── schema.sql
│       └── database.sqlite
├── client/
│   ├── host/                 # Pannello controllo host
│   │   ├── index.html
│   │   └── app.js
│   └── player/               # Schermata mobile giocatori
│       ├── index.html
│       └── app.js
├── tools/
│   └── generate-license.js   # Tool interno: genera e pusha licenza su GitHub
├── .env                      # PAT GitHub + config
└── package.json
```

---

## Flusso di Gioco (State Machine)
```
LOBBY → QUESTION → RESULTS → (loop) → FINAL_LEADERBOARD
```
- **LOBBY:** i giocatori si connettono, inseriscono nickname, attendono l'host
- **QUESTION:** domanda visibile a tutti, timer countdown, i giocatori rispondono dal mobile
- **RESULTS:** mostra risposte corrette + punteggi parziali
- **Loop:** l'host avanza alla domanda successiva
- **FINAL_LEADERBOARD:** classifica finale, possibilità di riavviare

---

## Funzionalità Principali
- Account host locali salvati su SQLite (password hashate con **bcryptjs**, implementazione JS pura) per accedere in sicurezza al pannello di controllo
- L'host sceglie tra **quiz precaricati** o **quiz personalizzati** (creati dal pannello host, max 3 quiz salvabili per utente)
- Import quiz da CSV/Excel
- QR code generato automaticamente per il join rapido dei giocatori (con IP grezzo come fallback garantito)
- Punteggio basato su velocità di risposta (come Kahoot)
- Max 30 giocatori simultanei
- Tutto funziona offline, internet necessario solo per il check licenza periodico

---

## Ordine di Sviluppo Concordato (Game-First)

### Fase Attiva — Sviluppo su PC (senza hardware Pi)
1. Setup progetto Node.js — Struttura cartelle, dipendenze, `.env`, `.gitignore`
2. `quiz-manager.js` + schema SQLite (tabelle `users` con hash **bcryptjs**, `quizzes` con limite 3/utente)
3. `index.js` — bootstrap server Express + Socket.io
4. `game.js` — state machine partita (LOBBY → QUESTION → RESULTS → FINAL_LEADERBOARD)
5. Socket.io — eventi real-time tra host e giocatori
6. Frontend host (pannello controllo: login, gestione quiz, conduzione partita)
7. Frontend player (schermata mobile)

### Fase Futura — Richiede l'Hardware Raspberry Pi
8. `license.js` — check GitHub API + cache locale + hardware lock (`/proc/device-tree/serial-number`)
9. `generate-license.js` — tool emissione licenze
10. Script setup Raspberry Pi (hostapd, dnsmasq, installazione esplicita **Node.js v24+** via NodeSource o binari ufficiali, compilazione binario ARM con Node.js SEA, autostart al boot). Grazie a `node:sqlite`, non esistono moduli nativi da compilare per ARM.

---

## Note Importanti (Zero Costi di Manutenzione)
- Il binario finale verrà compilato con Node.js SEA (Single Executable Applications) → produce eseguibile ARM per Pi. `pkg` è stato archiviato (dicembre 2024) e non è più mantenuto.
- Il PAT GitHub sarà fine-grained, sola lettura, limitato al repo licenze. Se estratto dal binario, espone tutte le licenze — rischio noto, accettabile per mercato piccolo.
- **Nessun server cloud o database a pagamento:** GitHub (piano gratuito per repository privati) funge da backend licenze a costo zero. SQLite salva tutto in locale sulla SD card del Pi.
- L'unico costo effettivo del progetto è l'hardware del Raspberry Pi.
- Il Pi deve avere accesso internet (ad esempio connettendolo temporaneamente a una rete Wi-Fi domestica o hotspot mobile) almeno ogni 7 giorni per rinnovare il token di licenza cached tramite le API gratuite di GitHub.