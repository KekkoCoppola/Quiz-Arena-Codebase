# Hyperframes Composition Brief: Quiz-Zata!

## Objective
Create a short launch-style brag video for Quiz-Zata!, built on real footage of a real game.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080, 30 fps
- Duration: 24.6 s

## Source Material
- Project root: `D:\PROGETTI\Quiz-Arena-Codebase`
- Primary files read: CLAUDE.md, PRODUCT.md, DESIGN.md, client/player/index.html, server/game-socket.js, content/quizzes/giro-del-mondo.json, resources/audio/manifest.json
- Product name: Quiz-Zata!
- Tagline / strongest claim: offline, nessuna app, gira su un Raspberry Pi
- Key UI moments (all REAL screen recordings of a game played on the local server with test bots, captured with headless Chrome):
  - `footage/sala-question.mp4` — countdown "Pronti? 3 2 1 VIA!" (0.3–5.2 s), question (5.6–11 s), pawns + X reveal (12–18.5 s)
  - `footage/sala-lobby.mp4` — lobby guide + QR; "Ginevra" joins at ~8.7 s, bots from ~10 s
  - `footage/phone-join.mp4` — nickname typed, colour/face/outfit changed, "Entra" tapped at ~5.0 s (390x844)
  - `footage/phone-question.mp4` — tap on C "Russia" at ~7.9 s, "GIUSTO! +825 punti" from ~10.1 s
  - `footage/sala-cup.mp4` — "È L'ORA DEL MINIGIOCO!" (1–2.9 s), wheel → "TRE BICCHIERI!" (8–10.5 s), cups shuffle (14–23 s)
  - `footage/sala-podium.mp4` — 3D podium: 2nd climbs ~7–8 s, 1st ~11 s, confetti 12–14 s
  - `logo.png` — the brand's own logo (`resources/img/LogoNoBG.png`)
- Copy that must appear verbatim:
  - "Zero internet." / "Zero app."
  - "Inquadri il QR. Scegli il personaggio."
  - "Rispondi dal telefono."
  - "Premiazione in 3D."
  - "Il quiz da festa su Raspberry Pi." + "Basta un proiettore."

## Creative Direction
- Tone preset: default
- Creative direction: attract mode da sala giochi — il trailer di una serata arcade
- Interpretation: footage that runs (2–4× on waiting stretches), cuts on the beat, rotated neo-brutalist stickers for the few lines, text always held long enough to read.
- Angle: the video IS a game — the sala's own countdown opens it and the music drops on "VIA!".
- Hook: real sala countdown, full frame, only the sala's own beeps.
- Outro / punchline: logo slam on arcade yellow + "Il quiz da festa che gira su un Raspberry Pi."
- Avoid: generic SaaS language, abstract filler, invented UI, click rings, floating/pulsing titles.

## Visual Identity
- Background: indigo `#443be0` with dot grid; lavender paper `#f4f3fb`; arcade yellow `#ffe500`
- Text: ink `#1c1c26`
- Accent: yellow `#ffe500`, ochre `#f2a65a`, teal `#90efef`, red `#e05a47`
- Display/body font: Quicksand 700 via `@font-face` from `assets/fonts/quicksand-700.woff2`
- Visual references: 4–6 px ink borders, hard offset shadows with zero blur, stickers rotated ±2–4°, pill badges.

## Storyboard
See `brag-output/brag-plan.md`. Scene summary:
1. Countdown — 3.6 s — sala footage full frame
2. Logo — 2.0 s — logo slam + "Zero internet." "Zero app."
3. Join — 4.0 s — sala lobby frame + phone frame, caption
4. Answer — 4.5 s — same frames, question → GIUSTO +825, caption
5. Minigame — 4.0 s — sala frame grows to full frame: curtain sign, wheel, cups
6. Podium — 3.5 s — 3D podium footage + "Premiazione in 3D."
7. End card — 3.0 s — logo + final line

## Audio
- Audio role: warm energetic bed + the product's own SFX on real actions
- Audio arc: beeps only → music drops on VIA! → product SFX on actions → impact on logo, music fades
- Music: `assets/music/happy-beats-business-moves-vol-1-by-ende-dot-app.mp3`, media-start 16.02 at film 3.1, volume ~0.3, fade-out 1 s
- Music cue guidance: preset json in the brag skill; film beat grid x.1 / x.6; strong locks at 3.1 and 21.6
- Audio-reactive treatment: none (kept restrained; the footage carries the motion)
- SFX: the project's own `resources/audio/sfx/*` and `resources/audio/cup-game/*` (countdown-ready, countdown-beep, countdown-go, player-joined, reveal, winner, swap-01..03), plus one brag impact on the logos.
- Audio files copied into `brag-output/composition/assets/`.

## Hyperframes Instructions
Show only real UI, keep text readable, stay within 15–25 s, keep the music+SFX layer, run check before render.
