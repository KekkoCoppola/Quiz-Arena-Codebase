# Salta round nei minigiochi — design breve

## Perché

Durante una serata l'host deve poter accorciare un minigioco: saltare un
livello dei bicchieri che non convince, arrivare direttamente al quinto, o
togliere di mezzo una Morra Cinese. Oggi non può: mentre un round è aperto
"Prossima" è disattivato, e la filata dei livelli va avanti da sola.

## Obiettivi

- Un tasto **"Salta round"** nel pannello admin, attivo solo mentre è aperto un
  round **minigioco** (anche durante sipario e anteprima).
- Ogni pressione chiude il round in corso **senza esito e senza punti per
  nessuno**, anche per chi aveva già scelto.
- Dopo il salto:
  - **livello intermedio** di un minigioco a più livelli → parte subito il
    livello successivo (dal 1° al 2°, e così via);
  - **ultimo livello** di un minigioco a più livelli → classifica, ferma ai
    punti presi nei livelli giocati; poi l'host preme "Prossima" come sempre;
  - **minigioco a un solo round** (Morra) → nessuna classifica: si passa
    direttamente al round successivo della partita (o alla premiazione, se era
    l'ultimo).

## Non obiettivi

- Saltare le domande normali del quiz.
- Recuperare o ripetere un round saltato.

## Approcci considerati

1. **Scelto.** Il salto dell'ultimo livello arriva ai client come un normale
   `game:results` con `skipped: true`, nessuna risposta e nessun esito. Sala e
   telefoni hanno già la strada verso la classifica; serve solo un ramo che
   salti il reveal. Rientro e snapshot non cambiano, perché lo stato resta
   `RESULTS` come dopo ogni round. Costo: chi legge i risultati deve sapere che
   possono arrivare vuoti.
2. Scartato. Un evento nuovo "round saltato": significato più pulito, ma va
   cablato in tre client e il passaggio alla classifica andrebbe duplicato.

## Come (deciso)

- **Motore (`server/game.js`)**: `skipRound(now)`, puro come il resto. Richiede
  stato `QUESTION` e round `minigame` (altrimenti errore). Scarta risposte e
  risoluzione anticipata, non assegna punti. Restituisce cosa succede dopo:
  - livello intermedio → entra nel round successivo (`_enterRound`) →
    `{ next: 'round' }`;
  - ultimo livello di più livelli → stato `RESULTS`, con il payload dei
    risultati marcato `skipped: true` → `{ next: 'results', results }`;
  - minigioco a un round → avanza oltre come `nextQuestion` →
    `{ next: 'round' }` oppure `{ next: 'final', leaderboard }`.
- **Rete (`server/game-socket.js`)**: evento host-only `host:skip-round`
  (dietro `requireHost`). Annulla timer del round, dei bot e della filata
  (`clearQuestionTimer`), poi `emitQuestion`, `game:results` (con `serverNow`,
  senza `revealAt`) o `game:final` a seconda del ritorno.
- **Pannello admin**: bottone "Salta round", visibile/attivo solo a round
  minigioco aperto; disattivato fuori da quel momento.
- **Sala**: risultati con `skipped: true` → niente reveal né parata, dritti
  alla classifica.
- **Telefono**: risultati con `skipped: true` → sticker neutro "Round saltato",
  punteggio invariato, posizione come dopo ogni round.

## Lasciato a chi costruisce

Icona e posizione esatta del bottone fra i comandi di partita, testo
dell'eventuale toast, nomi interni.

## Verifica

`tools/test-game.js`: i tre casi di `skipRound` (intermedio, ultimo livello,
round unico), zero punti anche per chi aveva risposto, errore su una domanda
normale. Prova in sala con la partita di debug.
