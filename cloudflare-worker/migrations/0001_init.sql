-- UniChat - schema iniziale D1
-- Applicalo con:
--   wrangler d1 migrations apply unichat --local     (sviluppo)
--   wrangler d1 migrations apply unichat --remote    (produzione)

-- Elementi rilevanti del digest. Il "rumore" non arriva mai qui.
CREATE TABLE IF NOT EXISTS items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id     TEXT    NOT NULL UNIQUE,   -- id del messaggio WhatsApp: rende gli insert idempotenti
  chat_id        TEXT    NOT NULL,          -- gruppo di provenienza
  chat_name      TEXT,                      -- etichetta leggibile del gruppo (da SOURCE_CHAT_IDS)
  category       TEXT    NOT NULL,          -- slug definito in src/config/categories.js
  summary        TEXT    NOT NULL,
  urgency        TEXT    NOT NULL CHECK (urgency IN ('bassa', 'media', 'alta')),
  sender_id      TEXT,
  sender_name    TEXT,
  original_text  TEXT,                      -- NULL se STORE_ORIGINAL_TEXT = "false"
  original_ts    INTEGER NOT NULL,          -- epoch ms del messaggio WhatsApp
  processed_ts   INTEGER NOT NULL,          -- epoch ms dell'elaborazione
  run_id         TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_ts     ON items (original_ts DESC);
CREATE INDEX IF NOT EXISTS idx_items_cat_ts  ON items (category, original_ts DESC);
CREATE INDEX IF NOT EXISTS idx_items_chat_ts ON items (chat_id, original_ts DESC);

-- Diario delle esecuzioni del Cron Trigger: debug e statistiche.
CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  started_ts     INTEGER NOT NULL,
  finished_ts    INTEGER,
  cursor_before  INTEGER,
  cursor_after   INTEGER,
  fetched_count  INTEGER NOT NULL DEFAULT 0,
  relevant_count INTEGER NOT NULL DEFAULT 0,
  digest_sent    INTEGER NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL DEFAULT 'running',  -- running | ok | partial | error
  error          TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_ts DESC);

-- Stato del Worker: al momento solo 'last_cursor' (epoch ms).
-- Usare D1 anche per questo evita di dover creare e configurare un namespace KV.
CREATE TABLE IF NOT EXISTS state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_ts INTEGER NOT NULL
);
