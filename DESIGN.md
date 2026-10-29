---
name: Quiz-Zata!
description: Motore di quiz multiplayer offline in stile arcade da sala giochi
colors:
  insert-coin-yellow: "#f7d708"
  primary-ink: "#4f4000"
  arcade-teal: "#90efef"
  arcade-teal-deep: "#006a6a"
  game-over-red: "#ab3425"
  terracotta-alert: "#e05a47"
  ticket-ochre: "#f2a65a"
  warm-paper: "#fff8f1"
  paper-white: "#ffffff"
  ink: "#201b0d"
  ink-muted: "#4a4731"
  outline-soft: "#7c785f"
  error-red: "#ba1a1a"
  success-green: "#2e7d32"
  # Pannello admin (client/host): palette presa dal logo, vedi §7
  logo-yellow: "#ffe500"
  electric-indigo: "#443be0"
  indigo-deep: "#2d25a8"
  indigo-soft: "#e4e2fc"
  logo-ink: "#1c1c26"
  logo-ink-2: "#4a4960"
  logo-ink-3: "#6b6a80"
  logo-amber: "#c6853a"
  admin-paper: "#f4f3fb"
  admin-paper-dot: "#d9d6f2"
  admin-surface-2: "#ecebf8"
  admin-red: "#d32f2f"
  admin-red-ink: "#a3191b"
  admin-red-soft: "#fde4e2"
  admin-green: "#1e8e4e"
  admin-green-ink: "#0c5a2f"
  admin-green-soft: "#dcf5e6"
typography:
  display:
    fontFamily: "Quicksand, system-ui, sans-serif"
    fontSize: "48px"
    fontWeight: 900
    lineHeight: "56px"
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Quicksand, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 900
    lineHeight: "32px"
  title:
    fontFamily: "Quicksand, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: "30px"
  body:
    fontFamily: "Quicksand, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: "24px"
  label:
    fontFamily: "Quicksand, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: "24px"
    letterSpacing: "0.03em"
  # Scala del pannello admin (denso, a mezzo metro dagli occhi)
  admin-caption:
    fontFamily: "Quicksand, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 700
  admin-small:
    fontFamily: "Quicksand, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
  admin-title:
    fontFamily: "Quicksand, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 900
  # Misure delle icone Material Symbols (non testo)
  icon-sm:
    fontFamily: "Material Symbols Outlined"
    fontSize: "1.125rem"
  icon-md:
    fontFamily: "Material Symbols Outlined"
    fontSize: "1.25rem"
  icon:
    fontFamily: "Material Symbols Outlined"
    fontSize: "1.375rem"
  icon-lg:
    fontFamily: "Material Symbols Outlined"
    fontSize: "1.625rem"
  icon-xl:
    fontFamily: "Material Symbols Outlined"
    fontSize: "1.875rem"
  icon-2xl:
    fontFamily: "Material Symbols Outlined"
    fontSize: "2.25rem"
rounded:
  base: "16px"
  lg: "32px"
  xl: "48px"
  full: "9999px"
  # Pannello admin
  admin-sm: "10px"
  admin-control: "12px"
  admin-base: "14px"
  admin-card: "20px"
spacing:
  unit: "8px"
  gutter: "16px"
  marginMobile: "20px"
  marginDesktop: "40px"
components:
  button-primary:
    backgroundColor: "{colors.insert-coin-yellow}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.base}"
    padding: "10px 20px"
  button-danger:
    backgroundColor: "{colors.game-over-red}"
    textColor: "#ffffff"
    rounded: "{rounded.base}"
    padding: "10px 20px"
  button-accent:
    backgroundColor: "{colors.arcade-teal}"
    textColor: "{colors.arcade-teal-deep}"
    rounded: "{rounded.base}"
    padding: "10px 20px"
  input:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.base}"
    padding: "12px 16px"
  badge:
    backgroundColor: "{colors.arcade-teal}"
    textColor: "{colors.arcade-teal-deep}"
    rounded: "{rounded.full}"
    padding: "3px 10px"
  card:
    backgroundColor: "{colors.paper-white}"
    rounded: "{rounded.lg}"
    padding: "24px"
---

# Design System: Quiz-Zata!

## 1. Overview

**Creative North Star: "Retro Street"**

Quiz-Zata! è un pannello da sala giochi anni '80-'90 travestito da strumento di conduzione eventi: bordi spessi, ombre offset piatte senza sfumatura, badge che sembrano adesivi appiccicati leggermente storti su un flipper. Ogni superficie interattiva si comporta come un tasto arcade fisico — si sposta, fa "clack", non si limita a cambiare colore. La palette è calda e satura (giallo gettone, teal, rosso "game over", ocra biglietto), mai tenue o desaturata: questo è un prodotto che deve leggersi da lontano, in una stanza piena di gente durante un evento dal vivo.

Il sistema rifiuta esplicitamente due derive: l'anonimato SaaS/corporate (card grigie intercambiabili, dashboard B2B piatte) e il clone visivo di Kahoot — l'ispirazione funzionale è dichiarata, l'identità visiva no.

**Key Characteristics:**
- Bordi neri spessi (4px) su ogni superficie che l'utente può toccare
- Ombre offset dure, mai sfocate: `8px 8px 0px 0px` colore inchiostro pieno
- Badge/sticker con leggera rotazione (±2-5deg) per l'effetto "adesivo appiccicato"
- Palette calda e satura, mai tenue — leggibilità a distanza da evento dal vivo
- Interazioni tattili: hover/click spostano fisicamente l'elemento (translate + shadow), non solo colore

## 2. Colors

Palette calda, satura, da sala giochi — mai tenue, mai desaturata. Il fondo caldo (`warm-paper`) non è un beige-AI-default: è il colore proprio del brand, coerente con la carta di un vecchio biglietto arcade.

### Primary
- **Insert-Coin Yellow** (#f7d708): superficie del bottone primario ("Avvia Partita", CTA principali) e badge dominanti. Il colore che l'occhio deve trovare per primo su ogni schermata.
- **Primary Ink** (#4f4000): testo/icone sopra le superfici gialle — bruno scuro, non nero puro, per restare nella famiglia calda.

### Secondary
- **Arcade Teal** (#90efef): superficie di badge e bottoni accento ("Avvia", conteggio domande).
- **Arcade Teal Deep** (#006a6a): testo sopra le superfici teal, link, stati attivi.

### Tertiary
- **Game Over Red** (#ab3425): bottoni distruttivi ("Elimina", "Termina Partita"), stati di pericolo.
- **Terracotta Alert** (#e05a47): accento decorativo della schermata di conduzione partita (progress bar, sticker) — variante più calda del rosso, riservata al contesto "evento live".
- **Ticket Ochre** (#f2a65a): accento decorativo secondario nella schermata di gioco, mai su testo.

### Neutral
- **Warm Paper** (#fff8f1): era lo sfondo di pagina; oggi nessuna superficie lo usa più come fondo. Sala, player e pannello admin stanno tutti sulla carta fredda del logo (`#f1f0fa`, pois `#d9d6f2`), vedi §7.
- **Paper White** (#ffffff): superficie di card, input, modali — il bianco "pulito" sopra il fondo caldo.
- **Ink** (#201b0d): testo primario e, soprattutto, **il colore di ogni bordo strutturale del sistema** — non solo testo.
- **Ink Muted** (#4a4731): testo secondario, descrizioni, placeholder scuri.
- **Outline Soft** (#7c785f): bordi sottili non strutturali, placeholder chiari.

### Stato
- **Error Red** (#ba1a1a): validazione form.
- **Success Green** (#2e7d32): conferme, toast di successo.

### Named Rules
**The Stamped-Ink Rule.** Ogni bordo strutturale (bottoni, card, badge, input, modali) è `4px solid` nel colore Ink (#201b0d), mai un grigio neutro generico. Il bordo è parte dell'identità, non un dettaglio tecnico.

**The No-Wash Rule.** Nessun colore della palette scende sotto una saturazione "da sala giochi". Se un colore sembra lavato o pastello-corporate, non appartiene a questo sistema.

## 3. Typography

**Display Font:** Quicksand (con fallback system-ui, sans-serif) — unica famiglia, in tutti i pesi da 400 a 900.

**Character:** Un solo font arrotondato e amichevole, usato in pesi estremi (700-900 quasi ovunque, anche nel body text) invece di alternare famiglie. La rotondità delle lettere richiama i tasti fisici degli arcade; il peso pesante garantisce leggibilità a distanza.

### Hierarchy
- **Display** (900, 48px/56px, letter-spacing -0.02em): titoli di pagina (h1), raramente usato — riservato ai momenti che contano.
- **Headline** (900, 24px/32px): titoli di sezione (h2), titolo del quiz nella schermata di conduzione partita.
- **Title** (700, 20px/30px): sotto-titoli (h3), corpo dei bottoni principali.
- **Body** (700, 16px/24px): testo corrente. Nota: il peso di default è **700, non 400** — questo sistema non ha un body text "leggero", per coerenza con la leggibilità a distanza da evento.
- **Label** (700, 16px/24px, letter-spacing 0.03em): badge, etichette, testo dentro pillole/chip.

### Named Rules
**The Always-Bold Rule.** Non esiste testo body a peso 400 in questo sistema. Il peso minimo utilizzato è 700. Un font sottile qui è un bug, non uno stile.

## 4. Elevation

Il sistema non usa ombre morbide o sfumate: ogni ombra è un **offset piatto e duro**, senza blur, nel colore Ink pieno — l'effetto di un adesivo timbrato sopra la superficie, non di un oggetto che fluttua sotto una luce diffusa. La profondità non è ambientale, è strutturale: comunica "questo è cliccabile", non "questo è elevato nello spazio".

### Shadow Vocabulary
- **Stamp** (`box-shadow: 8px 8px 0px 0px #201b0d`): stato di riposo/hover di card e superfici primarie — l'ombra piena "da adesivo".
- **Stamp Small** (`box-shadow: 4px 4px 0px 0px #201b0d`): badge, toast, elementi secondari.
- **Stamp Hover** (`box-shadow: 12px 12px 0px 0px #201b0d`): stato hover enfatizzato, accoppiato a `translate(-4px, -4px)`.
- **Stamp Right** (`box-shadow: 8px 0px 0px 0px #201b0d`): variante direzionale per elementi ancorati a un lato (es. sidebar).

### Named Rules
**The Flat-Stamp Rule.** Zero `blur-radius` in qualunque `box-shadow` del sistema. Se un'ombra ha una sfumatura, non è coerente con Retro Street — deve essere un offset secco.

## 5. Components

### Buttons
- **Shape:** angoli arrotondati generosi (16px, `rounded.base`), mai squadrati, mai a pillola totale (quella è riservata a badge/chip).
- **Primary:** sfondo Insert-Coin Yellow, testo Primary Ink, bordo Ink 4px, padding 10px 20px.
- **Danger:** sfondo Game Over Red, testo bianco, stesso bordo/shape.
- **Accent:** sfondo Arcade Teal, testo Arcade Teal Deep.
- **Hover / Focus:** il bottone si sposta fisicamente `translate(-2px, -2px)` e guadagna l'ombra Stamp — mai un semplice cambio di colore o opacità. Questo è il comportamento distintivo del sistema, non opzionale.

### Chips / Badge
- **Style:** sfondo pieno (Insert-Coin Yellow o Arcade Teal), testo scuro coerente col ruolo, bordo Ink 2-4px, forma a pillola (`rounded.full`).
- **State:** leggera rotazione (±2deg) per l'effetto sticker; niente stato "selezionato" con outline aggiuntivo — il colore pieno è già lo stato.

### Cards / Containers
- **Corner Style:** 32px (`rounded.lg`) — più generoso dei bottoni, per distinguere contenitore da azione.
- **Background:** Paper White su fondo Warm Paper — sempre un salto di luminosità netto, mai card-su-card dello stesso bianco.
- **Shadow Strategy:** Stamp all'hover (card cliccabili come le quiz-card), nessuna ombra a riposo su contenitori puramente statici.
- **Border:** Ink 4px sempre presente, non opzionale.
- **Internal Padding:** 24px (`spacing` scala su multipli di 8px).
- **Accent bar:** alcune card (quiz-card) usano una barra decorativa **in alto**, 4px, a tutta larghezza — non un bordo laterale colorato. Questa distinzione è intenzionale: la barra superiore è firma del sistema, il bordo laterale colorato (side-stripe) è vietato altrove (vedi Don'ts).

### Inputs / Fields
- **Style:** sfondo Paper White, bordo Ink 3px, angoli 16px, testo peso 700.
- **Focus:** bordo diventa colore Primary + doppia ombra (Stamp + anello 2px nel colore container) — mai solo un outline sottile del browser.
- **Error:** bordo Error Red + micro-animazione shake (0.4s) + anello nel colore error-container. L'errore deve "scuotersi", non solo cambiare colore.

### Navigation
- **Barra in cima, niente sidebar:** il pannello admin non ha più una barra laterale (conteneva solo "Impostazioni", che non portava a nulla, ed "Esci"). Ogni vista ha una barra in alto, fissa, con i soli comandi che le servono: logo ed "Esci" nella dashboard, "Indietro" e "Salva" nell'editor, "Termina" nella conduzione partita. Vedi §7.

### Game Badge (componente firma)
Badge a pillola usati nella schermata di conduzione partita ("2 domande", "Personale") — forma piena a pillola (mai clip-path a poligono: tagliava il testo, corretto in questa sessione), leggera rotazione alternata (±2deg) per l'effetto sticker sparpagliato, `flex-wrap` per restare leggibili anche su schermi stretti.

## 6. Do's and Don'ts

### Do:
- **Do** usare bordi Ink (#201b0d) 3-4px su ogni superficie strutturale — bottoni, card, input, badge, modali.
- **Do** far muovere fisicamente bottoni e card interattive (`translate` + ombra Stamp) invece di limitarsi a un cambio di colore su hover.
- **Do** mantenere il body text a peso 700 minimo — è la firma di leggibilità a distanza del sistema.
- **Do** usare badge a forma di pillola piena (`rounded.full`) con leggera rotazione, mai clip-path a poligono che rischia di tagliare il testo (bug corretto in questa sessione su `.game-badge`).
- **Do** riservare la barra decorativa superiore (4px, `quiz-card-accent`) come firma visiva delle card, distinta dal pattern vietato sotto.

### Don't:
- **Don't** introdurre card grigie generiche, gradient testo, o dashboard B2B piatte — è l'estetica "SaaS/corporate anonima" esplicitamente bandita in PRODUCT.md.
- **Don't** clonare visivamente Kahoot. L'ispirazione funzionale è dichiarata, l'identità visiva resta Retro Street.
- **Don't** usare `border-left`/`border-right` colorato oltre 1px come accento decorativo (side-stripe) su card o alert — pattern da rimuovere ovunque compaia nel codice esistente, non da replicare in nuovi componenti.
- **Don't** usare ombre sfocate (`blur-radius` > 0) su nessun elemento: ogni ombra di questo sistema è un offset piatto.
- **Don't** scendere sotto peso 700 per il body text, e non usare grigio chiaro per il testo — il contrasto deve reggere la lettura da lontano durante un evento dal vivo (WCAG AA, ≥4.5:1).

## 7. Superficie admin (pannello host)

Il pannello di chi conduce (`client/host/`) tiene la **forma** di Retro Street — bordi inchiostro, ombre piene senza sfocatura, Quicksand in grassetto, tasti che si abbassano sotto il dito — ma prende i **colori dal logo**: giallo delle lettere (`logo-yellow`), indaco elettrico dell'ombra (`electric-indigo`), contorno blu-nero (`logo-ink`), su un fondo carta appena freddo (`admin-paper`). La terna crema/teal/terracotta non aveva legami con il marchio ed è stata tolta da questa superficie.

**Il fondo è uno solo per tutte e tre le superfici**: carta `#f1f0fa` con pois `#d9d6f2`. Sala e player aggiungono la retinatura indaco negli angoli, il disco indaco e la stella gialla del logo (`.sala-bg-layer`, `.player-bg-layer`); sul telefono le forme stanno in angoli opposti e sbordano quasi del tutto, per non finire dietro al testo. Il pannello admin resta senza forme (vedi sotto, "Niente decorazione"). Bottoni, adesivi e risposte di sala e player restano sulla palette dei §2.

### Regole della superficie
- **Un'azione principale per schermata**, gialla. Tutto il resto è secondario (bianco) o di testo.
- **Niente decorazione**: nessuna rotazione, adesivo, sfondo a doodle o indicatore finto. Chi usa il pannello non è necessariamente pratico di tecnologia: ogni elemento a schermo è un comando o un'informazione.
- **Comandi per fase**: nella conduzione partita `data-phase` (`lobby|question|results|final`) decide quali bottoni esistono. Un comando che ora non si può usare non viene mostrato spento: non c'è.
- **Il comando è sempre a schermo**: sul telefono i comandi stanno in un pannello fisso in basso, sotto il pollice; da 1024px (o in orizzontale da 700px) diventano una colonna a destra. Mai dover scorrere per trovare "Avvia" o "Prossima domanda".
- **I colori delle risposte non seguono la palette admin**: le quattro tinte A/B/C/D (`--opt-1..4`) sono identiche a sala e player, così l'host può dire "la gialla" e intendere ciò che vede la stanza.
- **Una sola famiglia di icone**: Material Symbols Outlined, vendorizzata. Niente emoji al posto delle icone (gli avatar dei giocatori sono contenuto, non icone).
- **Mobile-first**: le regole di base sono quelle del telefono, i `min-width` aggiungono spazio. Altezze in `dvh`, margini con `env(safe-area-inset-*)`.
