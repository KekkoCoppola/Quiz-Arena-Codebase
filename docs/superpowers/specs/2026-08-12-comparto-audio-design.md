# Comparto audio del pannello Host (Design)

Data: 2026-08-12 · Branch: `Minigames` · Stato: in revisione

Sostituisce e assorbe la bozza `2026-08-12-soundtrack-host-design.md` (rimossa):
l'introduzione della musica di tensione a durata variabile e degli effetti sonori
rende insufficiente il design a traccia singola con solo ducking.

## Obiettivo

Dotare il pannello host di un comparto audio completo — **musica, voce narrante
ed effetti sonori** — che accompagni la partita dall'apertura della lobby alla
proclamazione del vincitore.

Divisione del lavoro concordata: **l'utente produce tutti gli asset** (voce,
effetti, musica, montaggio, livelli); questo design definisce **il sistema che li
riproduce** e il contratto che gli asset devono rispettare per entrare nel gioco
senza rilavorazione.

È il primo sistema audio del progetto: oggi `resources/` contiene solo font e
immagini, e non esiste alcun riferimento ad `<audio>` in tutto il codice.

## Fuori scope

- **Audio sui telefoni dei giocatori**: nessun suono lato player. Decisione
  esplicita — decine di dispositivi sfasati che riproducono lo stesso materiale
  in una stanza si sentono come un eco, e l'autoplay bloccato su mobile
  richiederebbe un gesto di sblocco per ogni giocatore.
- **Contenuto dinamico nel parlato**: nessuna riga vocale contiene nickname,
  punteggi o numeri variabili. Principio adottato: *quello che non sappiamo non
  lo diciamo*. Nessun TTS a runtime, nessuna sintesi sul Raspberry.
- **Produzione degli asset**: copione, registrazione, montaggio e scelta dei
  suoni sono dell'utente. Qui si definiscono solo formato, nomi e livelli.
- **Modifiche al server e al DB**: nessuna. Gli asset sono serviti dal mount
  statico esistente.

## 1. Architettura: tre canali

Modulo **`client/sala/audio.js`**, caricato con un `<script>` prima di `app.js`.
Nessun build step, nessun modulo ES: JS vanilla servito staticamente.

> **Aggiornato il 2026-08-17.** Il comparto era progettato per il pannello host,
> quando quello era anche lo schermo proiettato. Con la separazione in tre viste
> (`docs/superpowers/specs/2026-08-17-vista-sala-design.md`) l'audio è passato
> alla **vista sala**: il suono esce dal proiettore collegato al Raspberry, non
> dal tablet dell'host. Le §8 e §9 qui sotto sono riscritte di conseguenza; il
> resto del design vale immutato, perché non dipendeva da quale schermo suonasse.

> **Deviazione da CLAUDE.md, da aggiornare nello stesso commit.** CLAUDE.md
> descrive i client come "JS vanilla **single-file**". `app.js` è già a ~1.450
> righe e il comparto audio è un sottosistema autonomo con stato proprio.

Tre canali con tecnologie diverse, scelte in base a cosa devono fare:

| Canale | Tecnologia | Perché |
|---|---|---|
| **Musica** | `<audio>` | File lunghi, riprodotti in streaming, in loop. Non serve latenza zero. |
| **Voce** | `<audio>` | File di media durata, **una alla volta**. |
| **Effetti** | **Web Audio API**, `AudioBuffer` pre-decodificati | Devono partire **istantaneamente** e potersi sovrapporre. Un `<audio>` per effetto decodifica al primo play e introduce un ritardo udibile, particolarmente sul Raspberry. |

Gli effetti vengono scaricati e decodificati in memoria all'apertura della
schermata di partita, non al primo utilizzo.

## 2. Gerarchia e priorità

Con tre sorgenti che competono per lo stesso istante, la gerarchia va decisa una
volta sola nel sistema, non caso per caso.

**La voce vince sempre.** Mentre una riga vocale è in riproduzione, la musica
scende a ~10% e risale a fine battuta. Le rampe di volume sono interpolazioni
lineari di **400 ms**: un cambio istantaneo si sente come un difetto di
riproduzione, una rampa si sente come regia. Una rampa in corso viene annullata
se ne parte un'altra.

**La voce non si sovrappone mai a sé stessa.** Coda con profondità massima 1 (una
in riproduzione, una in attesa) e una regola non ovvia ma decisiva:

> **Ogni riga vocale nasce con una scadenza.** Se non è ancora partita quando la
> scadenza matura, viene **scartata**, non riprodotta in ritardo. Una battuta
> fuori tempo ("andiamo con la prima domanda" mentre siamo alla seconda) è
> peggiore di una battuta mancata.

La scadenza naturale è il **cambio di fase**: qualunque riga in coda viene
scartata quando arriva un nuovo evento di fase.

**Gli effetti non entrano mai in coda.** Sono corti (<1,5 s) e si sovrappongono
liberamente; se ne partono due insieme, suonano insieme.

**Anti-ripetizione.** Ogni evento può avere più varianti. La selezione è casuale
**escludendo l'ultima usata** per quell'evento. Costa poche righe e raddoppia la
vita percepita del materiale.

## 3. Musica: letto + tensione

Tre tracce, non una:

| Traccia | Quando | Comportamento |
|---|---|---|
| `bed` | Lobby, risultati, classifica finale | Loop, volume pieno |
| `tension-loop` | Dall'inizio della domanda fino a T-10s | Loop, sostituisce `bed` in crossfade |
| `tension-final` | Ultimi 10 secondi del countdown | Durata **fissa**, atterra sullo zero |

**Perché due file di tensione.** `TIME_OPTIONS` in
[client/host/app.js:551](client/host/app.js:551) ammette limiti da **5 a 120
secondi**. Una traccia di tensione preconfezionata non può quindi finire sullo
zero: su 5 secondi se ne sentirebbe solo l'inizio, su 120 girerebbe venti volte.
Separando un loop neutro da un crescendo a durata fissa, la sincronia col
countdown è garantita per qualunque limite senza calcoli fragili e senza una
traccia per ogni durata.

L'innesco di `tension-final` si calcola da `endsAt` (timestamp assoluto già
presente nel payload `game:question`), non da un contatore locale.

**Countdown più corto del crescendo.** Con `time_limit_s` ≤ 10, `tension-loop` è
saltato e `tension-final` parte in `seek` interno, così da atterrare comunque
sullo zero.

**Chiusura anticipata.** La domanda si chiude appena tutti hanno risposto, quindi
`tension-final` verrà spesso troncato a metà. Non è un difetto da correggere: il
taglio si copre con l'effetto del reveal che entra sopra. **Vincolo di
produzione:** il crescendo deve funzionare anche interrotto al 40%, quindi non
deve raccontare una storia che ha bisogno di concludersi.

## 4. Manifest

Gli asset sono descritti da **`resources/audio/manifest.json`**, servito dal mount
statico `/resources` già presente in `server/index.js` (punto 2 dell'ordine dei
middleware). Nessuna route nuova, nessuna modifica al server.

```json
{
  "music": {
    "bed":           { "file": "music/bed.ogg", "gain": 1.0 },
    "tension-loop":  { "file": "music/tension-loop.ogg", "gain": 1.0 },
    "tension-final": { "file": "music/tension-final.ogg", "gain": 1.0 }
  },
  "vo": {
    "lobby-qr": [
      { "file": "vo/lobby-qr-01.mp3", "gain": 0.9 }
    ],
    "reveal-rullo": [
      { "file": "vo/reveal-rullo-01.mp3", "gain": 0.9 },
      { "file": "vo/reveal-rullo-02.mp3", "gain": 1.1 }
    ]
  },
  "sfx": {
    "player-joined": [
      { "file": "sfx/player-joined-01.mp3", "gain": 1.0 }
    ]
  }
}
```

**Aggiungere una battuta o un effetto = copiare un file e aggiungere una riga al
manifest.** Nessuna modifica al codice, nessun intervento richiesto da parte
dello sviluppatore. Un evento assente dal manifest semplicemente non suona: il
sistema non si aspetta che il catalogo sia completo, e il gioco è pienamente
funzionante con un manifest vuoto.

**Formati.** MP3 per voce ed effetti — è quello che producono gli strumenti web e
il TTS online, e sul pannello host (browser desktop o Chromium sul Pi) è
universalmente supportato. Ogg solo per la musica, dove il peso conta per il
packaging SEA. **Nessuna conversione di formato è richiesta all'utente.**

## 5. Livelli e calibrazione

I file arriveranno da fonti diverse (TTS online diversi, librerie di effetti,
registrazioni) e quindi a volumi molto diversi fra loro. Il campo `gain` per
asset serve esattamente a questo.

**Il guadagno non va indovinato, va misurato.** La filiera dell'utente è
esclusivamente web, senza software installato, quindi la normalizzazione
distruttiva in produzione (`ffmpeg loudnorm`) non è praticabile.

Soluzione: una **pagina di calibrazione** — un HTML autonomo in
`tools/audio-calibration.html`, aperto nel browser, su cui trascinare i file.
Usa Web Audio API per decodificarli e misurarne il livello, e restituisce il
valore di `gain` da scrivere nel manifest per allinearli a un riferimento comune.
Non distruttiva: non riscrive né riconverte nulla.

Livelli relativi di riferimento fra canali (costanti nel modulo, non nel
manifest): voce il più alto, effetti poco sotto, musica nettamente sotto — è un
letto, non un protagonista.

## 6. Catalogo eventi

Punti di innesco che il sistema espone. L'utente decide **quali riempire**: un
evento senza asset nel manifest è silenzioso.

| Evento | Canali | Note |
|---|---|---|
| Apertura partita / lobby | VO, musica | Istruzioni QR. Evento raro: può essere teatrale e lungo. |
| Ingresso di un giocatore | SFX | Frequente e ravvicinato: suono **molto** corto, o nessuno. |
| Via al gioco | VO, SFX | Una volta a partita. |
| Inizio domanda | VO, musica | La riga "prima domanda" si distingue con `q.index === 0` — nessun contenuto dinamico. Le domande successive: riga breve o silenzio. |
| Risposta ricevuta | SFX | Molto frequente. Valutare se sonorizzarlo affatto. |
| Ultimi 10 secondi | Musica | `tension-final`. |
| Sospensione pre-reveal | VO, SFX | Rullo di tamburi. Vedi §7. |
| Reveal risultato | SFX | Sting che copre il taglio della tensione. |
| Classifica finale | VO, SFX, musica | Proclamazione. La frase si ferma **prima** del nome, che compare sul podio. |
| Minigioco | SFX | La suspense visiva esiste già: `startMinigameSuspense()` in [app.js:1124](client/host/app.js:1124). |

**Budget di frequenza** (regola di contenuto, non di codice): gli eventi rari
possono permettersi righe lunghe con una variante sola; gli eventi a ogni
domanda vogliono righe corte e **almeno 4 varianti**; gli eventi continui
prendono solo effetti, **mai voce**.

## 7. Nodo aperto: la pausa prima del reveal

Il rullo di tamburi richiede un intervallo fra l'arrivo di `game:results` e la
visualizzazione della risposta corretta, che oggi è immediata.

**C'è un effetto collaterale da conoscere:** i giocatori ricevono `game:results`
nello stesso istante dell'host e vedono subito il proprio esito sul telefono.
Ritardando il pannello host, chi guarda il telefono conosce l'esito prima dello
schermo grande.

Trattamento adottato: **finestra di sospensione breve, ~1,5 s**, costante
configurabile. È sufficiente per un rullo secco e abbastanza contenuta da non
trasformarsi in uno spoiler sistematico.

La soluzione pulita — ritardare `game:results` verso i player — richiede una
modifica a `game-socket.js` ed è **fuori dallo scope di questo lavoro**. Va
riconsiderata se in prova la sfasatura risulta fastidiosa.

## 8. Punti di aggancio in `client/sala/app.js`

Handler già esistenti; ogni aggancio è una riga.

| Punto | Uso |
|---|---|
| avvio del modulo | `arm()` — vedi §9, **non** un gesto utente |
| `game:snapshot` | musica `bed` se una partita è già in corso |
| `game:lobby-update` | musica `bed`, SFX ingresso giocatore (solo se la lista **cresce**) |
| `game:question` | SFX inizio round, tensione, VO inizio |
| `game:answer-count` | SFX risposta ricevuta |
| `game:results` | SFX sospensione, poi reveal dopo `SUSPENSE_MS` |
| `game:final` | proclamazione |
| `game:ended` | `music(null)`, dissolvenza in uscita |

**Restart partita:** dopo `host:restart-game` il server rimanda
`game:lobby-update`, quindi il ritorno alla fase lobby è automatico e non
richiede codice dedicato.

**Ingresso giocatore:** `game:lobby-update` arriva anche quando qualcuno *esce*.
L'effetto è legato alla crescita della lista, non all'evento.

## 9. Autoplay

**Sul proiettore non c'è nessuno che clicca.** Il presupposto originale — `arm()`
agganciata al click dell'host su "Avvia partita" — è caduto con lo spostamento
sulla vista sala: quella pagina la apre il Raspberry da solo, in kiosk, e nessuno
la tocca per tutta la serata.

La soluzione non è codice, è la riga di lancio:

```
chromium-browser --kiosk --autoplay-policy=no-user-gesture-required http://localhost:3000/sala
```

Con quel flag il contesto nasce già in stato `running` e `arm()` può essere
chiamata al caricamento della pagina. Sul desktop di sviluppo, dove il flag non
c'è, il contesto nasce sospeso e un ripiego lo sblocca al primo click o tasto
qualunque, staccandosi da solo. **Nessun overlay "clicca per attivare l'audio":**
davanti a una sala non deve mai comparire, e in produzione non servirebbe.

Due insidie emerse costruendolo, entrambe risolte, entrambe silenziose:

- **`arm()` correva contro il caricamento del manifest.** `loadManifest()` è una
  fetch; `arm()` parte alla valutazione dello script e trovava il catalogo
  ancora vuoto, uscendo senza fare nulla. Ogni chiamata pubblica si accoda ora
  alla promise del manifest.
- **Le dissolvenze non possono usare `requestAnimationFrame`.** rAF non scatta
  quando la pagina non sta disegnando: basta che lo schermo del Pi vada in blank
  durante una dissolvenza in entrata e la musica resta inchiodata a volume zero,
  senza errori. Le rampe usano `setInterval` e applicano il valore finale esatto.

Se `play()` viene rifiutata il modulo non insiste e non lancia: la traccia resta
in `pending` e riparte al primo gesto utile.

## 10. Controllo host

**Da riprogettare.** Il toggle era previsto nell'header della schermata di gioco
dell'host, quando lì c'era anche l'audio. Ora il suono esce dalla sala, che è di
sola lettura e non ha comandi: un mute cliccabile lì non ha senso — nessuno
raggiunge quello schermo.

Il principio resta valido e vale la pena tenerlo: **un singolo mute per tutto**,
perché durante un evento dal vivo la richiesta "abbassa quella musica" deve
essere a un click di distanza, non a una scelta fra tre cursori. Ma il comando
deve stare su admin-console e viaggiare come evento verso la sala. Da definire
insieme al redesign del pannello host.

`SalaAudio.info()` in console resta intanto il modo per capire in dieci secondi
perché non si sente niente.

## 11. Gestione errori

**Principio non negoziabile: l'audio non deve mai poter rompere la partita.**

| Situazione | Comportamento |
|---|---|
| `play()` rifiutata (autoplay) | Catturata, toggle in stato "bloccato", riprovabile |
| Manifest assente o malformato | Comparto disattivato in silenzio, gioco invariato |
| File assente / 404 / decodifica fallita | Quel singolo asset è marcato indisponibile, il resto funziona |
| `AudioContext` non creabile | Effetti disattivati, musica e voce continuano |

Ogni chiamata pubblica è un no-op quando il sottosistema corrispondente è
disabilitato. Nessuna eccezione può risalire agli handler socket di `app.js`, che
non devono mai sapere se l'audio funziona.

## 12. Verifica

Le decisioni pure di `audio-logic.js` sono coperte da `tools/test-audio.js` (42
asserzioni). Il solo motore di riproduzione (`audio.js`) tocca DOM e Web Audio e
richiede verifica manuale sul dev server:

1. Transizioni musicali fra le fasi con rampe udibili, non a scatto.
2. `tension-final` atterra sullo zero con `time_limit_s` = 5, 20 e 120.
3. Chiusura anticipata: il taglio della tensione è coperto dal reveal.
4. Voce: nessuna sovrapposizione; una riga resa obsoleta da un cambio di fase
   viene scartata e non suona in ritardo.
5. Effetti: nessun ritardo alla prima riproduzione; sovrapposizioni pulite.
6. Anti-ripetizione: la stessa variante non esce due volte di fila.
7. Mute persistente al refresh.
8. **Manifest vuoto e manifest assente**: la partita si gioca dall'inizio alla
   fine, in silenzio, senza errori in console.

## 13. Note di produzione

Per il lavoro dell'utente sugli asset, non vincoli di sistema:

- **Il countdown è più teso in silenzio.** Se c'è un punto dove non mettere voce,
  è quello.
- **Il crescendo deve reggere l'interruzione** (§3).
- **Registrazione con voce umana**, se si sceglierà quella strada: una sola
  seduta, stesso microfono, stessa distanza, stessa stanza; tre take per riga;
  **30 secondi di stanza vuota in silenzio**, che servono alla riduzione del
  rumore e sono l'unica cosa non recuperabile dopo.
- **TTS come traccia di servizio**: generare le righe col TTS, montarle, giocare
  una partita vera, e solo dopo congelare il copione per un'eventuale
  registrazione umana. Evita di bruciare una sessione di registrazione su
  battute che si riveleranno fuori tempo o ripetitive.
- **Loop non seamless:** una traccia lunga con `loop` produce uno stacco udibile
  al riavvolgimento. Si risolve con un montaggio loop-friendly, non con codice.

## 14. Decisioni note

- **Licenza degli asset.** La traccia di partenza fornita (`Gunma-chanGambol.ogg`)
  sembra provenire da un'opera di terzi. Irrilevante per un uso privato, ma la
  roadmap prevede una licenza SaaS e col packaging SEA l'audio finirebbe *dentro
  il binario distribuito*. Il design è costruito perché la sostituzione sia
  indolore: nomi file generici, nessun riferimento al titolo nel codice, tutto
  passa dal manifest. Decisione aperta, **non blocca l'implementazione**.
- **Peso complessivo.** Molti effetti e molte varianti vocali sommano rapidamente.
  Vale la pena tenere d'occhio il totale di `resources/audio/` in vista del
  binario SEA su ARM.
