-- ═══════════════════════════════════════════════════════════════════════════════
-- Quiz-Zata! — Schema Database SQLite
-- Versione : 1.0
-- Creato   : Step 1 (struttura dati) — applicato a runtime da quiz-manager.js (Step 2)
-- Runtime  : node:sqlite (integrato in Node.js v24+, zero dipendenze esterne)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Abilita il supporto alle foreign key (disabilitato di default in SQLite).
PRAGMA foreign_keys = ON;

-- ─── Tabella: users ─────────────────────────────────────────────────────────────
-- Account degli host che accedono al pannello di controllo.
-- Le password sono hashate con bcryptjs (implementazione JS pura, nessun binding nativo).
CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE          COLLATE NOCASE,
    password    TEXT    NOT NULL,                -- hash bcryptjs (fattore costo ≥ 10)
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─── Tabella: quizzes ───────────────────────────────────────────────────────────
-- Quiz personalizzati creati dagli host.
--
-- NOTA SUL LIMITE:
--   Il limite di 3 quiz per utente NON è un vincolo DB (CHECK non è pratico qui).
--   Viene applicato a livello applicativo in server/quiz-manager.js per poter
--   restituire messaggi di errore user-friendly all'interfaccia host.
--
-- NOTA SU `questions`:
--   Array JSON serializzato. Struttura di ogni elemento:
--   {
--     "text":          "Testo della domanda",
--     "options":       ["Opzione A", "Opzione B", "Opzione C", "Opzione D"],
--     "correct_index": 0,          -- indice (0-based) dell'opzione corretta
--     "time_limit_s":  30          -- secondi a disposizione per rispondere
--   }
--
-- NOTA SU `minigames` (Fase Minigiochi):
--   Array JSON serializzato di minigiochi pianificati tra le domande. Ogni
--   elemento: { "afterQuestionIndex": 0, "type": "pari_dispari" }.
--   `afterQuestionIndex` è l'indice (0-based) della domanda in `questions`
--   dopo la quale inserire il minigioco. `type` deve essere una delle chiavi
--   di MINIGAME_TYPES in server/game.js (unica fonte di verità sui tipi validi).
CREATE TABLE IF NOT EXISTS quizzes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    title       TEXT    NOT NULL,
    questions   TEXT    NOT NULL DEFAULT '[]',
    minigames   TEXT    NOT NULL DEFAULT '[]',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ─── Indici ─────────────────────────────────────────────────────────────────────
-- Ottimizza la query più frequente: recupero di tutti i quiz di un dato utente.
CREATE INDEX IF NOT EXISTS idx_quizzes_user_id ON quizzes(user_id);

-- ─── Tabella: preloaded_quizzes ──────────────────────────────────────────────────
-- Quiz precaricati di sistema (non modificabili dagli host dal pannello).
--
-- ATTENZIONE — questa tabella e una COPIA DERIVATA, non la fonte di verita.
-- I quiz di sistema vivono come file in content/quizzes/, uno per quiz, e
-- server/quiz-library.js riallinea questa tabella ad ogni avvio: inserisce i
-- nuovi, aggiorna quelli cambiati, elimina quelli il cui file e sparito.
-- Modificare le righe a mano non serve a niente: al riavvio successivo vengono
-- sovrascritte. Per cambiare un quiz si modifica il suo file.
--
-- "slug" e l identita stabile e corrisponde al nome del file senza estensione
-- (il-mondo-degli-animali.json -> "il-mondo-degli-animali"). Non e il titolo:
-- cosi rinominare il titolo aggiorna il quiz invece di crearne un doppione.
--
-- La struttura di `questions` è identica alla tabella `quizzes`:
--   {
--     "text":          "Testo della domanda",
--     "options":       ["Opzione A", "Opzione B", "Opzione C", "Opzione D"],
--     "correct_index": 0,
--     "time_limit_s":  30
--   }
CREATE TABLE IF NOT EXISTS preloaded_quizzes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT    UNIQUE,
    title       TEXT    NOT NULL,
    category    TEXT    NOT NULL DEFAULT 'Generale',
    questions   TEXT    NOT NULL DEFAULT '[]',
    minigames   TEXT    NOT NULL DEFAULT '[]',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_preloaded_category ON preloaded_quizzes(category);

-- ─── Tabella: quiz_images ───────────────────────────────────────────────────────
-- Immagini delle domande, indirizzate dal CONTENUTO.
--
-- La chiave primaria e lo SHA-256 esadecimale dei byte stoccati, non un id
-- progressivo. Tre conseguenze volute:
--   1. la stessa foto usata in due quiz occupa una riga sola;
--   2. l URL /api/quiz-image/<hash> non puo mai servire byte diversi, quindi e
--      cacheabile come "immutable" e ogni dispositivo la scarica una volta sola;
--   3. un client non puo inventarsi un hash: lo calcola il server dai byte.
--
-- I byte sono WebP ridimensionato e compresso dal browser dell host, che PROVA
-- a restare entro lato lungo 1280px e 153.600 byte: e un obiettivo lato
-- client, non una garanzia su cosa e stoccato qui. La scala di qualita ha un
-- pavimento (0.58) e accetta un file piu pesante pur di non degradare oltre
-- (un caso reale, 1254x1254, e arrivato a 159 KB); il server dal canto suo
-- accetta fino a MAX_IMAGE_SIDE lato e 400 KB di body. Il server non
-- ricomprime: farlo richiederebbe un modulo nativo, escluso dal vincolo di
-- packaging SEA su ARM.
--
-- NESSUNA foreign key verso le domande: una domanda vive dentro il JSON della
-- colonna `questions`, non in una tabella. Il legame lo ricostruisce
-- gcOrphanImages() in quiz-manager.js, che gira ad ogni avvio.
CREATE TABLE IF NOT EXISTS quiz_images (
    hash        TEXT    PRIMARY KEY,          -- SHA-256 esadecimale minuscolo dei byte
    mime        TEXT    NOT NULL,
    bytes       BLOB    NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
