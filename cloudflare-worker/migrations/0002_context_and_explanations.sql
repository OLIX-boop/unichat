-- Contesto conversazionale e approfondimenti su richiesta.
--
-- Il digest riporta una frase per messaggio, che a volte resta oscura senza la
-- discussione attorno. Qui si conserva una finestra limitata di messaggi
-- adiacenti (solo per gli elementi rilevanti: il resto del rumore continua a
-- non essere salvato) e si mette in cache la risposta di "Approfondisci", per
-- non ripagare la stessa domanda a ogni apertura della dashboard.

ALTER TABLE items ADD COLUMN context_json TEXT;

CREATE TABLE IF NOT EXISTS explanations (
  item_id      INTEGER NOT NULL,
  -- 'chat' = solo messaggi del gruppo; 'web' = messaggi piu' ricerca online
  mode         TEXT    NOT NULL CHECK (mode IN ('chat', 'web')),
  text         TEXT    NOT NULL,
  sources_json TEXT,
  created_ts   INTEGER NOT NULL,
  PRIMARY KEY (item_id, mode)
);
