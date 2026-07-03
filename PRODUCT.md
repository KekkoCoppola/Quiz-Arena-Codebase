# Product

## Register

product

## Users

- **Host** — organizzatore di un evento dal vivo (pub, scuola, fiera). Usa un tablet o PC connesso allo stesso hotspot Wi-Fi del Raspberry Pi per gestire i propri quiz e condurre la partita davanti a una stanza intera. Deve poter agire sotto pressione, in tempo reale, davanti a un pubblico che aspetta.
- **Player** — pubblico dell'evento, si unisce da smartphone browser inquadrando un QR code o l'IP locale. Zero installazione, zero account, nessuna competenza tecnica richiesta.

Contesto: rete Wi-Fi locale isolata (Raspberry Pi come access point), completamente offline. Nessuna connessione internet richiesta durante l'evento.

## Product Purpose

Quiz-Zata! è un motore di gioco a quiz multiplayer locale, in stile Kahoot, che gira interamente offline su Raspberry Pi. L'host crea o sceglie un quiz, conduce la partita in tempo reale (LOBBY → QUESTION → RESULTS → FINAL_LEADERBOARD) via Socket.io, i player rispondono dal proprio telefono. Successo = un evento dal vivo condotto senza intoppi tecnici, con host e pubblico concentrati sul gioco, non sullo strumento.

## Brand Personality

**Retro arcade giocoso** — energico, nostalgico anni '80-'90, atmosfera da sala giochi. Coerente con il sistema visivo neo-brutalista già presente nel codice: bordi spessi (4px), ombre offset dure (no blur), badge/sticker con leggera rotazione, palette terracotta/teal/ocra su fondo caldo, tipografia Quicksand arrotondata e bold.

## Anti-references

- **Estetica SaaS/corporate anonima**: niente card grigie generiche, gradient testo, dashboard B2B piatte e intercambiabili.
- **Clone visivo di Kahoot**: l'ispirazione funzionale è dichiarata (Istructions.md: "alternativa a Kahoot"), ma l'identità visiva deve restare propria — non è un fork estetico.

## Design Principles

1. **Controllo rapido, zero ansia** — l'host conduce un evento dal vivo sotto pressione sociale; ogni azione critica (avvia, prossima domanda, termina) deve essere inequivocabile a colpo d'occhio, mai ambigua o nascosta.
2. **Leggibile a distanza** — la schermata di conduzione partita è spesso proiettata o vista da una stanza intera, non solo dall'host da vicino: tipografia grande, contrasto alto, niente dettagli minuti che contano.
3. **Identità propria, non presa in prestito** — retro-arcade neo-brutalista distintivo, mai scivolare verso il template SaaS anonimo né verso il clone diretto di Kahoot.
4. **Zero frizione per il player** — browser mobile, nessuna installazione, funziona anche per chi non è a proprio agio con la tecnologia.
5. **Coerenza sistemica** — riusare bordi 4px, ombre offset dure, badge sticker e token colore già stabiliti in `client/host/style.css` invece di reinventare pattern ad ogni nuova feature.

## Accessibility & Inclusion

WCAG AA come standard: contrasto testo ≥4.5:1 (≥3:1 per testo grande), stati di focus sempre visibili, `prefers-reduced-motion` sempre rispettato con alternativa (crossfade/istantaneo). Nessun requisito eccezionale oltre lo standard, ma attenzione a non affidarsi solo al colore per comunicare stato (badge punteggio/corretto-sbagliato) viste le condizioni di luce variabili degli eventi dal vivo.
