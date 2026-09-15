/**
 * Accesso a D1. Tutte le query stanno qui, cosi' lo schema ha un solo punto di
 * contatto con il resto del Worker.
 */

/** Legge un valore dalla tabella `state`. */
export async function getState(db, key) {
  const row = await db.prepare('SELECT value FROM state WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

/** Scrive (o sovrascrive) un valore nella tabella `state`. */
export async function setState(db, key, value) {
  await db
    .prepare(
      `INSERT INTO state (key, value, updated_ts) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_ts = excluded.updated_ts`,
    )
    .bind(key, String(value), Date.now())
    .run();
}

/**
 * Cursore dell'ultima lettura, in epoch ms.
 * Al primo run non esiste: si parte da `fallbackMs` per non ingoiare mesi di storico.
 */
export async function getCursor(db, fallbackMs) {
  const raw = await getState(db, 'last_cursor');
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallbackMs;
}

export async function setCursor(db, cursorMs) {
  await setState(db, 'last_cursor', Math.trunc(cursorMs));
}

/** Apre una riga nella tabella `runs` e ne restituisce l'id. */
export async function startRun(db, cursorBefore) {
  const id = crypto.randomUUID();
  await db
    .prepare('INSERT INTO runs (id, started_ts, cursor_before) VALUES (?, ?, ?)')
    .bind(id, Date.now(), cursorBefore)
    .run();
  return id;
}

/** Chiude la riga del run con esito e contatori. */
export async function finishRun(db, runId, fields = {}) {
  const {
    cursorAfter = null,
    fetchedCount = 0,
    relevantCount = 0,
    digestSent = false,
    status = 'ok',
    error = null,
  } = fields;
  await db
    .prepare(
      `UPDATE runs SET finished_ts = ?, cursor_after = ?, fetched_count = ?,
         relevant_count = ?, digest_sent = ?, status = ?, error = ?
       WHERE id = ?`,
    )
    .bind(
      Date.now(),
      cursorAfter,
      fetchedCount,
      relevantCount,
      digestSent ? 1 : 0,
      status,
      error,
      runId,
    )
    .run();
}

/**
 * Inserisce gli elementi rilevanti.
 * `INSERT OR IGNORE` su `message_id UNIQUE`: un run ripetuto non duplica nulla.
 * @returns {Promise<number>} righe effettivamente inserite
 */
export async function insertItems(db, runId, items, { storeOriginalText = true } = {}) {
  if (!items.length) return 0;
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO items
       (message_id, chat_id, chat_name, category, summary, urgency, sender_id,
        sender_name, original_text, original_ts, processed_ts, run_id, context_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const results = await db.batch(
    items.map((it) =>
      stmt.bind(
        it.message_id,
        it.chat_id,
        it.chat_name || '',
        it.category,
        it.summary,
        it.urgency,
        it.sender_id,
        it.sender_name,
        storeOriginalText ? it.original_text : null,
        it.original_ts,
        now,
        runId,
        it.context && it.context.length ? JSON.stringify(it.context) : null,
      ),
    ),
  );
  return results.reduce((sum, r) => sum + (r?.meta?.changes ?? 0), 0);
}

/**
 * Storico filtrato per la dashboard.
 * La ricerca testuale e' una LIKE case-insensitive su sintesi e mittente:
 * i volumi sono nell'ordine delle migliaia di righe, non serve FTS.
 */
export async function queryItems(db, filters = {}) {
  const { category, chat, from, to, q, limit = 100, offset = 0, order = 'desc' } = filters;
  const direction = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const where = [];
  const params = [];

  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  if (chat) {
    where.push('chat_id = ?');
    params.push(chat);
  }
  if (from) {
    where.push('original_ts >= ?');
    params.push(Number(from));
  }
  if (to) {
    where.push('original_ts <= ?');
    params.push(Number(to));
  }
  if (q) {
    where.push('(LOWER(summary) LIKE ? OR LOWER(sender_name) LIKE ?)');
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await db
    .prepare(
      `SELECT id, message_id, chat_id, chat_name, category, summary, urgency,
              sender_name, original_text, original_ts, processed_ts,
              context_json IS NOT NULL AS has_context
         FROM items ${clause}
        ORDER BY original_ts ${direction}
        LIMIT ? OFFSET ?`,
    )
    .bind(...params, Math.min(Number(limit) || 100, 500), Number(offset) || 0)
    .all();

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM items ${clause}`)
    .bind(...params)
    .first();

  return { items: rows.results || [], total: totalRow ? totalRow.n : 0 };
}

/** Conteggi aggregati per le intestazioni della dashboard. */
export async function getStats(db) {
  const byCategory = await db
    .prepare('SELECT category, COUNT(*) AS n FROM items GROUP BY category')
    .all();
  const byChat = await db
    .prepare('SELECT chat_id, chat_name, COUNT(*) AS n FROM items GROUP BY chat_id, chat_name')
    .all();
  const totals = await db
    .prepare('SELECT COUNT(*) AS n, MAX(original_ts) AS last_ts FROM items')
    .first();
  const lastRun = await db
    .prepare('SELECT id, started_ts, status, relevant_count, fetched_count FROM runs ORDER BY started_ts DESC LIMIT 1')
    .first();
  return {
    total: totals ? totals.n : 0,
    last_item_ts: totals ? totals.last_ts : null,
    by_category: byCategory.results || [],
    by_chat: byChat.results || [],
    last_run: lastRun || null,
  };
}

/** Ultimi run, per diagnosticare il cron dalla dashboard. */
export async function listRuns(db, limit = 20) {
  const rows = await db
    .prepare('SELECT * FROM runs ORDER BY started_ts DESC LIMIT ?')
    .bind(Math.min(Number(limit) || 20, 100))
    .all();
  return rows.results || [];
}

/**
 * Toglie dagli elementi quelli gia' presenti in D1.
 *
 * Serve a rendere il run idempotente: se un'esecuzione precedente ha salvato ed
 * inviato questi messaggi ma e' morta prima di avanzare il cursore, al giro dopo
 * non devono finire una seconda volta nel digest.
 */
export async function filterNewItems(db, items) {
  if (!items.length) return items;
  const placeholders = items.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT message_id FROM items WHERE message_id IN (${placeholders})`)
    .bind(...items.map((it) => it.message_id))
    .all();
  const known = new Set((rows.results || []).map((r) => r.message_id));
  return items.filter((it) => !known.has(it.message_id));
}

/** Elemento singolo con il suo contesto conversazionale, per "Approfondisci". */
export async function getItem(db, id) {
  const row = await db
    .prepare(
      `SELECT id, message_id, chat_id, chat_name, category, summary, urgency,
              sender_name, original_text, original_ts, context_json
         FROM items WHERE id = ?`,
    )
    .bind(Number(id))
    .first();
  if (!row) return null;

  let context = [];
  if (row.context_json) {
    try {
      context = JSON.parse(row.context_json);
    } catch {
      context = [];
    }
  }
  return { ...row, context };
}

/** Approfondimento gia' calcolato per (elemento, modalita'), se esiste. */
export async function getExplanation(db, itemId, mode) {
  const row = await db
    .prepare('SELECT text, sources_json, created_ts FROM explanations WHERE item_id = ? AND mode = ?')
    .bind(Number(itemId), mode)
    .first();
  if (!row) return null;

  let sources = [];
  if (row.sources_json) {
    try {
      sources = JSON.parse(row.sources_json);
    } catch {
      sources = [];
    }
  }
  return { text: row.text, sources, created_ts: row.created_ts, cached: true };
}

/** Salva (o sostituisce) l'approfondimento, cosi' non si ripaga la stessa domanda. */
export async function saveExplanation(db, itemId, mode, text, sources) {
  await db
    .prepare(
      `INSERT INTO explanations (item_id, mode, text, sources_json, created_ts)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(item_id, mode) DO UPDATE SET
         text = excluded.text,
         sources_json = excluded.sources_json,
         created_ts = excluded.created_ts`,
    )
    .bind(
      Number(itemId),
      mode,
      text,
      sources && sources.length ? JSON.stringify(sources) : null,
      Date.now(),
    )
    .run();
}
