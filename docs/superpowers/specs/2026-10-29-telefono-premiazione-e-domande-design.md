# Telefono: premiazione finale e domande — design (breve)

Data: 2026-10-29 · Ramo di partenza: `cup-game`

## Perché

Oggi sul telefono la premiazione segue gli atti della cerimonia uno per uno, poi mostra il podio e l'elenco: la propria posizione non è la prima cosa che si vede. Durante le domande, invece, un testo lungo riempie lo schermo e una domanda con immagine non avvisa che c'è qualcosa da guardare sul proiettore.

La premiazione sul maxischermo verrà rifatta in 3D dall'autore (prima il podio, poi gli altri), su un lavoro separato non ancora consegnato. Questo design riguarda **solo il telefono** e il segnale che gli dice quando la sala ha finito.

## Obiettivi

1. **Durante la premiazione** il telefono mostra un segnaposto uguale per tutti: "Guarda lo schermo!". Nessun indizio sulla posizione, nemmeno per chi sta sul podio.
2. **A premiazione finita** il telefono mostra:
   - la propria posizione in grande (numero, avatar, nickname, punti, "su N"), con il colore della medaglia e i coriandoli per il podio;
   - sotto, **tutta** la classifica, scorrevole, con la propria riga evidenziata (niente blocco "vicino a te");
   - una **barra fissa in fondo** che non scorre con la pagina, con "Grazie per aver giocato!". Il bottone Condividi si aggiunge solo quando la condivisione esisterà.
3. **Chi rientra** (`player:rejoin`) durante la cerimonia vede il segnaposto e aspetta la fine. Chi rientra a cerimonia finita va dritto alla schermata della posizione.
4. **Domanda lunga**: il testo è troncato a tre righe coi puntini, con un bottone "Leggi tutta" sotto. Aperta, la domanda scorre **dentro il proprio riquadro ad altezza fissa**, e i bottoni di risposta non si spostano mai.
5. **Domanda con immagine**: sotto il testo compare un adesivo "📺 Guarda l'immagine sul maxischermo". Ordine se le due cose coincidono: testo troncato, "Leggi tutta", adesivo.

## Non obiettivi

- La premiazione in sala: resta quella attuale finché non arriva il 3D.
- La condivisione come immagine: rimandata, resta solo lo spazio nella barra.
- I minigiochi sul telefono: hanno già il loro "Guarda lo schermo!".
- Mostrare l'immagine della domanda sul telefono: resta una scelta di prodotto (CLAUDE.md, "Il player non mostra le immagini").

## Anti-obiettivi (fallimento anche se "funziona")

- Un telefono che svela una posizione prima del proiettore, compreso chi rientra a metà cerimonia.
- Un telefono che cambia aspetto solo per i premiati durante la cerimonia: la sala capirebbe chi è sul podio.
- Bottoni di risposta che si spostano quando si apre la domanda lunga.

## Approcci considerati

Come fa il telefono a sapere che il maxischermo ha finito:

- **A. Cronometro sul telefono**: parte alla ricezione di `game:final` e aspetta la durata del calendario. Nessun evento nuovo, ma chi rientra a metà cerimonia non sa quanto tempo è passato, e già oggi in quel caso svela la classifica.
- **B. Il server annuncia la fine** — **scelto**. Il server calcola la stessa durata da `client/shared/final-schedule.js`, che è UMD e già caricabile in Node, ed emette `game:ceremony-done` alla scadenza. Chi rientra sa dal server se la cerimonia è finita.
- **C. La sala avvisa il server quando il 3D finisce**: esatto qualunque sia la durata, ma la sala non ha un ruolo sul socket (chiunque potrebbe fingersi la sala) e senza sala collegata i telefoni resterebbero bloccati. Servirebbe comunque il timer di B.

Scelto B perché il calendario resta l'unica fonte dei tempi: quando arriva il 3D si aggiorna la durata in `final-schedule.js` e il telefono la segue senza modifiche.

## Come, per le parti decise

- **Server (`server/game-socket.js`)**: dove oggi si emette `game:final`, si avvia un timer di durata `buildFinalSchedule({ playerCount }).totalMs + PLAYER_LAG_MS`. Alla scadenza: `io.emit('game:ceremony-done')`. Il timer si annulla con le stesse mosse che annullano gli altri (riavvio, fine partita).
- **Rientro**: la risposta di `player:rejoin` in `FINAL_LEADERBOARD` porta un booleano `ceremonyDone`.
- **Telefono (`client/player/`)**:
  - `game:final` mostra il segnaposto e memorizza la classifica;
  - `game:ceremony-done` (o `ceremonyDone: true` al rientro) disegna la schermata della posizione;
  - la cerimonia per-atto del telefono (`runCeremony`, `playBeat`, la card che segue gli atti) viene rimossa;
  - il movimento ridotto non cambia la logica: il segnaposto resta finché non arriva la fine, cambia solo l'assenza di animazioni.
- **Domanda**: solo client. Line-clamp CSS a tre righe; "Leggi tutta" commuta una classe che toglie il clamp e dà al testo un'altezza massima con scorrimento interno. Il bottone compare solo se il testo trabocca davvero (misurato, non stimato dalla lunghezza). L'adesivo dipende da `q.image` già presente nel payload.
- **Coerenza col sistema visivo**: token e pattern di DESIGN.md (bordi 4px Ink, ombre offset piatte, adesivi ruotati).

## Lasciato a chi costruisce

- Se `stepsForRank` / `revealAtForRank` / `KINDS_BY_RANK` restano in `final-schedule.js` per la sala o per i test, o si semplificano: il telefono non li usa più.
- Dove vive il timer della cerimonia (dentro `clearQuestionTimer` o in un suo helper), purché ogni uscita da `FINAL_LEADERBOARD` lo annulli.
- Testi esatti dei segnaposto e altezza massima del riquadro della domanda aperta.
- Aggiornare i test toccati (`tools/test-final.js`, `tools/test-socket.js`) e le parti di CLAUDE.md che descrivono il telefono durante la premiazione ("mostra solo la propria posizione, `stepsForRank`").
