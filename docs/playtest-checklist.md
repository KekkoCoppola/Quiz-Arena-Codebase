# Checklist Playtest Wi-Fi (Fase 7)

Setup: PC con `npm run dev`, smartphone sulla stessa rete Wi-Fi.
L'URL/QR appare nella lobby della schermata di conduzione partita.

## Percorso base
- [ ] QR scansionato apre la pagina player sul telefono
- [ ] Join con nickname + avatar da 2+ telefoni diversi
- [ ] Avvio partita: la domanda appare su tutti i telefoni entro ~1s
- [ ] Countdown allineato tra telefoni e schermo host
- [ ] Risposte registrate, contatore host aggiornato in tempo reale
- [ ] Chiusura anticipata quando tutti rispondono
- [ ] Feedback corretto/sbagliato/tempo scaduto sui telefoni
- [ ] Podio finale coerente su host e telefoni

## Robustezza
- [ ] Blocco schermo del telefono a domanda aperta → sblocco → riconnessione automatica con punteggio
- [ ] Reload della pagina a metà partita → rientro nello stato corrente
- [ ] Wi-Fi del telefono spento e riacceso → riconnessione
- [ ] Telefono che sparisce del tutto → la partita prosegue, il round si chiude col timer
- [ ] Riavvia partita: tutti i telefoni tornano in lobby con punteggi azzerati
- [ ] Termina partita: messaggio di chiusura su tutti i telefoni

## Percezione
- [ ] Testi leggibili con luce forte / a distanza
- [ ] Touch target comodi con una mano
- [ ] Latenza percepita accettabile (risposta → conferma < 500ms)
