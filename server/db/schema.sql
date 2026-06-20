-- ═══════════════════════════════════════════════════════════════════════════════
-- Quiz Arena — Schema Database SQLite
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
CREATE TABLE IF NOT EXISTS quizzes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    title       TEXT    NOT NULL,
    questions   TEXT    NOT NULL DEFAULT '[]',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ─── Indici ─────────────────────────────────────────────────────────────────────
-- Ottimizza la query più frequente: recupero di tutti i quiz di un dato utente.
CREATE INDEX IF NOT EXISTS idx_quizzes_user_id ON quizzes(user_id);
