# Brag Plan: Quiz-Zata!

## What is this app?
Un quiz multiplayer da festa in stile arcade che gira tutto offline su un Raspberry Pi: la sala lo vede sul proiettore, i giocatori rispondono dal telefono senza installare niente.

## The angle
Il video È una partita. Si apre con il conto alla rovescia vero della sala ("Pronti? 3, 2, 1, VIA!") e sul "VIA!" parte la musica: da lì si vive la serata in fast-forward — il QR, il personaggio scelto sul telefono, la risposta giusta (+825), il sipario 3D che estrae il minigioco, i bicchieri che si mescolano, il podio con i coriandoli. Niente mockup: tutto il footage è registrato da una partita reale con i bot sul server locale. Il vanto è tecnico e concreto: zero internet, zero app, un Raspberry Pi.

## Hook (first 2-3 seconds)
Footage a tutto schermo del conto alla rovescia della sala (fondo indaco, cerchio giallo): "Pronti?" → 3 → 2 → 1, con i bip veri della sala. Silenzio musicale. Sul "VIA!" (3,1 s) entra la musica sul suo battere forte.

## Key moments (the middle)
- La striscia "In lobby" della sala che si riempie di nomi, mentre il telefono digita "Ginevra" e cambia faccia e divisa del personaggio con le frecce.
- Il telefono tocca "Russia" e mostra "✓ GIUSTO! +825 punti" mentre in sala le risposte sbagliate prendono la X.
- La ruota del sipario 3D si ferma su "TRE BICCHIERI!", poi i bicchieri si mescolano a velocità folle.
- Il podio 3D: il 2° sale, poi il 1°, coriandoli.

## Outro / punchline
Logo Quiz-Zata! che sbatte al centro su giallo arcade, con la riga: "Il quiz da festa che gira su un Raspberry Pi."

## User flow worth showing
Entra (QR + personaggio sul telefono, la sala lo accoglie in lobby) → rispondi (tocco sul telefono, risultato in sala) → minigioco → premiazione 3D.

## Tone
- Preset: default
- Creative direction: attract mode da sala giochi — il trailer di una serata arcade
- Interpretation: ritmo alto fatto di footage che corre (velocità 2-4× nei tratti di attesa), tagli sul battere, sticker ruotati neo-brutalisti per le poche frasi; mai testo che scappa prima di essere letto.

## Format: landscape — 1920x1080
## Duration: 24.6 s

## Visual identity (from the project)
- Background: elettric indigo `#443be0` con puntinato (schermata del conto alla rovescia), carta lavanda `#f4f3fb`
- Accent: giallo logo `#ffe500` / insert-coin `#f7d708`, ocra `#f2a65a`, teal `#90efef`
- Text: inchiostro `#1c1c26`
- Display font: Quicksand 700 (file del progetto, `resources/fonts/quicksand-700.woff2`)
- Body font: Quicksand 700
- Strongest visual element: bordi inchiostro spessi + ombre offset dure senza blur, sticker ruotati, logo fumetto "QUIZ ZATA!"

## Share copy (draft)
Quiz-Zata!: la serata quiz da festa che gira su un Raspberry Pi. Niente internet, niente app: si inquadra il QR e si gioca.

## Audio direction
- Role: bed caldo ed energico + effetti VERI della sala dove l'azione è vera
- Music: `happy-beats-business-moves-vol-1-by-ende-dot-app.mp3` (120 BPM), entra al "VIA!" dal suo battere forte (16,02 s della traccia)
- Music treatment: niente musica nel gancio (solo i bip veri), ingresso secco sul VIA!, volume ~0,3, sfuma nell'ultimo secondo sotto il logo
- Music cue guidance: preset `assets/music/cues/happy-beats-business-moves-vol-1-by-ende-dot-app.music-cues.json`; con media-start 16,02 a film 3,1 la griglia cade su x,1 / x,6; tagli di scena su 3,6 · 5,6 · 9,6 · 14,1 · 18,1 · 21,6; forte: 3,1 (VIA!) e 21,6 (logo finale)
- Audio-reactive treatment: subtle — eventuale respiro leggero del puntinato/ombra sotto il logo finale, niente barre o equalizzatori
- SFX posture: moderate, quasi tutti dalla libreria del progetto (`resources/audio/sfx`, `resources/audio/cup-game`)
- Audio-coupled moments: bip del conto alla rovescia sulle cifre, "go" sul VIA!, pop sugli sticker, ingresso giocatore in lobby, "reveal" sulla risposta giusta, scambi dei bicchieri, "winner" quando il 1° sale sul podio, un colpo sul logo finale
- Restraint rule: nessun suono senza causa visibile; niente ding sintetici aggiuntivi; nessun effetto ripetuto identico più di due volte di fila

## Storyboard

### Scene 1 — Il conto alla rovescia — 3.6s (0.0–3.6)
Footage sala a tutto schermo: "Pronti?", 3, 2, 1, VIA! (1,5×).
Sequential/interaction: sì — le cifre si susseguono.
Audio intent: tensione, solo bip veri.
Audio-coupled idea: countdown-ready su Pronti?, countdown-beep su 3/2/1, countdown-go sul VIA! + ingresso musica.
Transition mood: hard → Scene 2 (sul battere 3,6)

### Scene 2 — Il logo — 2.0s (3.6–5.6)
Giallo arcade puntinato, il logo sbatte al centro; due sticker ruotati: "Zero internet." (4,0) "Zero app." (4,35), tenuti fino al taglio.
Sequential/interaction: sì — due sticker uno dopo l'altro.
Audio intent: impatto + due pop.
Transition mood: hard/whip → Scene 3

### Scene 3 — Si entra — 4.0s (5.6–9.6)
Fondo indaco. Sinistra: la sala (cornice-proiettore) con la lobby che si riempie (3×). Destra: il telefono che digita "Ginevra", cambia faccia e divisa, tocca Entra; in sala compare "Ginevra" nello stesso istante, poi entrano gli altri.
Caption sticker: "Inquadri il QR. Scegli il personaggio." (5,9–9,4)
Audio-coupled idea: player-joined sull'ingresso di Ginevra e sull'ultimo.
Transition mood: blur swap dentro le stesse cornici → Scene 4

### Scene 4 — Si risponde — 4.5s (9.6–14.1)
Stesse cornici. Sala: la domanda "Qual è il paese più grande del mondo per superficie?", poi pedine e X sulle sbagliate. Telefono: tocco su Russia → "Risposta inviata!" → "✓ GIUSTO! +825 punti" (tenuto ≥1 s).
Caption sticker: "Rispondi dal telefono." (9,9–12,6)
Audio-coupled idea: reveal sul GIUSTO.
Transition mood: la cornice della sala diventa il mondo (cresce a tutto schermo) → Scene 5

### Scene 5 — Il minigioco — 4.0s (14.1–18.1)
Footage a tutto schermo: cartello "È L'ORA DEL MINIGIOCO!" (1,2 s), ruota che si ferma su "TRE BICCHIERI!" (≥0,8 s di lettura), bicchieri che si mescolano (4×).
Audio-coupled idea: swap dei bicchieri sugli scambi visibili.
Transition mood: hard cut sul battere → Scene 6

### Scene 6 — La premiazione — 3.5s (18.1–21.6)
Footage podio 3D (2×): il 2° sale, il 1° arriva, coriandoli. Sticker: "Premiazione in 3D." (18,4–21,2)
Audio-coupled idea: winner quando il 1° tocca il podio.
Transition mood: colour flood giallo → Scene 7

### Scene 7 — Logo finale — 3.0s (21.6–24.6)
Logo al centro, sbattuto sul battere (un'iride gialla si apre dal podio 0,3 s prima); riga "Il quiz da festa su Raspberry Pi." tenuta 2,5 s e bollino "Basta un proiettore." (accorciati in montaggio per il tempo di lettura).
Audio-coupled idea: un colpo sul logo; musica in dissolvenza.

**Music mood for this video:** upbeat
**Audio summary:** tensione con i soli bip veri, esplosione musicale al VIA!, effetti veri della sala sulle azioni, chiusura col colpo sul logo e la musica che sfuma.
