"""Cursore persistente: l'unico stato che il bridge ha diritto di tenere.

Serve solo a non consegnare due volte lo stesso messaggio (e a non saltarne
nessuno) quando il Worker chiama /messages. Nessuno storico a lungo termine:
quello vive in D1, lato Cloudflare.
"""

import sqlite3
import threading
import time
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS cursor_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivered (
  message_id TEXT PRIMARY KEY,
  seen_ts    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivered_seen ON delivered(seen_ts);
"""

_CURSOR_KEY = "last_timestamp_ms"


class CursorStore:
    """Wrapper su SQLite con lock: le chiamate sono poche, brevi e serializzate."""

    def __init__(self, db_path: str, retention_days: int = 14) -> None:
        path = Path(db_path)
        if path.parent and str(path.parent) not in ("", "."):
            path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.executescript(_SCHEMA)
        self._conn.commit()
        self._lock = threading.Lock()
        self._retention_ms = retention_days * 24 * 60 * 60 * 1000

    def get_cursor(self) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM cursor_state WHERE key = ?", (_CURSOR_KEY,)
            ).fetchone()
        return int(row[0]) if row else 0

    def filter_new(self, messages: list[dict]) -> list[dict]:
        """Scarta i messaggi gia' consegnati in chiamate precedenti."""
        if not messages:
            return []
        ids = [m["id"] for m in messages if m.get("id")]
        if not ids:
            return []
        placeholders = ",".join("?" * len(ids))
        with self._lock:
            rows = self._conn.execute(
                f"SELECT message_id FROM delivered WHERE message_id IN ({placeholders})",
                ids,
            ).fetchall()
        already = {row[0] for row in rows}
        return [m for m in messages if m.get("id") and m["id"] not in already]

    def mark_delivered(self, messages: list[dict]) -> None:
        """Registra gli id consegnati e avanza il cursore al timestamp massimo."""
        if not messages:
            return
        now_ms = int(time.time() * 1000)
        max_ts = max(int(m.get("timestamp") or 0) for m in messages)
        with self._lock:
            self._conn.executemany(
                "INSERT OR IGNORE INTO delivered (message_id, seen_ts) VALUES (?, ?)",
                [(m["id"], now_ms) for m in messages if m.get("id")],
            )
            row = self._conn.execute(
                "SELECT value FROM cursor_state WHERE key = ?", (_CURSOR_KEY,)
            ).fetchone()
            current = int(row[0]) if row else 0
            if max_ts > current:
                self._conn.execute(
                    "INSERT INTO cursor_state (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (_CURSOR_KEY, str(max_ts)),
                )
            self._conn.execute(
                "DELETE FROM delivered WHERE seen_ts < ?", (now_ms - self._retention_ms,)
            )
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()
