/**
 * Aiutanti per i test: un D1 finto in memoria e un `fetch` finto che imita
 * bridge e Gemini. Nessun test tocca la rete, D1 reale o WhatsApp.
 */

/**
 * Implementazione minima dell'interfaccia D1 usata da src/db.js.
 * Riconosce le query per sottostringa: sono poche e stabili.
 */
export function createFakeD1() {
  const store = {
    state: new Map(),
    items: [],
    runs: [],
    explanations: new Map(),
  };

  function execute(sql, args) {
    if (sql.includes('SELECT value FROM state')) {
      const value = store.state.get(args[0]);
      return { kind: 'first', value: value === undefined ? null : { value } };
    }
    if (sql.includes('INSERT INTO state')) {
      store.state.set(args[0], String(args[1]));
      return { kind: 'run', value: { meta: { changes: 1 } } };
    }
    if (sql.includes('INSERT INTO runs')) {
      store.runs.push({ id: args[0], started_ts: args[1], cursor_before: args[2] });
      return { kind: 'run', value: { meta: { changes: 1 } } };
    }
    if (sql.includes('UPDATE runs SET')) {
      const run = store.runs.find((r) => r.id === args[7]);
      if (run) {
        Object.assign(run, {
          finished_ts: args[0],
          cursor_after: args[1],
          fetched_count: args[2],
          relevant_count: args[3],
          digest_sent: args[4],
          status: args[5],
          error: args[6],
        });
      }
      return { kind: 'run', value: { meta: { changes: 1 } } };
    }
    if (sql.includes('SELECT message_id FROM items WHERE message_id IN')) {
      const results = store.items
        .filter((it) => args.includes(it.message_id))
        .map((it) => ({ message_id: it.message_id }));
      return { kind: 'all', value: { results } };
    }
    if (sql.includes('FROM explanations')) {
      const found = store.explanations.get(`${args[0]}:${args[1]}`);
      return { kind: 'first', value: found || null };
    }
    if (sql.includes('INSERT INTO explanations')) {
      store.explanations.set(`${args[0]}:${args[1]}`, {
        text: args[2],
        sources_json: args[3],
        created_ts: args[4],
      });
      return { kind: 'run', value: { meta: { changes: 1 } } };
    }
    if (sql.includes('FROM items WHERE id = ?')) {
      const found = store.items.find((it) => it.id === Number(args[0]));
      return { kind: 'first', value: found || null };
    }
    if (sql.includes('INSERT OR IGNORE INTO items')) {
      const exists = store.items.some((it) => it.message_id === args[0]);
      if (!exists) {
        store.items.push({
          id: store.items.length + 1,
          message_id: args[0],
          chat_id: args[1],
          chat_name: args[2],
          category: args[3],
          summary: args[4],
          urgency: args[5],
          sender_id: args[6],
          sender_name: args[7],
          original_text: args[8],
          original_ts: args[9],
          processed_ts: args[10],
          run_id: args[11],
          context_json: args[12],
        });
      }
      return { kind: 'run', value: { meta: { changes: exists ? 0 : 1 } } };
    }
    if (sql.includes('FROM items')) {
      return { kind: 'all', value: { results: store.items } };
    }
    throw new Error(`Query non gestita dal fake D1: ${sql.slice(0, 80)}`);
  }

  function makeStatement(sql, args = []) {
    return {
      sql,
      args,
      bind: (...next) => makeStatement(sql, next),
      async first() {
        return execute(sql, args).value;
      },
      async all() {
        return execute(sql, args).value;
      },
      async run() {
        return execute(sql, args).value;
      },
    };
  }

  return {
    store,
    prepare: (sql) => makeStatement(sql),
    async batch(statements) {
      const out = [];
      for (const stmt of statements) out.push(execute(stmt.sql, stmt.args).value);
      return out;
    },
  };
}

/** Risposta Gemini ben formata che contiene i verdetti passati. */
export function geminiResponse(verdicts) {
  return {
    candidates: [
      { finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(verdicts) }] } },
    ],
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

/**
 * `fetch` finto: smista su bridge (/messages, /send) e Gemini.
 * Registra tutto in `calls` per le asserzioni.
 */
export function createFakeFetch({
  messages = [],
  cursor = 0,
  verdicts = [],
  failOn = null,
  explainText = 'Spiegazione di prova.',
  explainSources = [],
}) {
  const calls = { messages: [], gemini: [], send: [], explain: [] };

  async function fakeFetch(url, init = {}) {
    const target = String(url);

    if (target.includes('/messages')) {
      calls.messages.push({ url: target, headers: init.headers });
      if (failOn === 'messages') throw new Error('bridge non raggiungibile');
      return jsonResponse({ messages, count: messages.length, cursor });
    }
    if (target.includes('/send')) {
      calls.send.push({ body: JSON.parse(init.body) });
      if (failOn === 'send') return jsonResponse({ error: 'ko' }, 500);
      return jsonResponse({ ok: true, chat_id: 'me@c.us', message_id: 'x1' });
    }
    if (target.includes('generativelanguage')) {
      const body = JSON.parse(init.body);
      // Le due chiamate si distinguono dal vincolo di schema: la classificazione
      // pretende JSON strutturato, l'approfondimento risponde in prosa.
      const isExplain = !body?.generationConfig?.responseSchema;
      if (isExplain) {
        calls.explain.push({ body });
        if (failOn === 'explain') return jsonResponse({ error: 'ko' }, 500);
        return jsonResponse({
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: explainText }] },
              groundingMetadata: {
                groundingChunks: explainSources.map((s) => ({ web: s })),
              },
            },
          ],
        });
      }
      calls.gemini.push({ body });
      if (failOn === 'gemini') return jsonResponse({ error: 'quota' }, 400);
      return jsonResponse(geminiResponse(verdicts));
    }
    throw new Error(`URL non gestito dal fake fetch: ${target}`);
  }

  return { fakeFetch, calls };
}

/** Messaggio nel formato restituito dal bridge. */
export function message(id, timestamp, text, sender = 'Mario Rossi', chat = {}) {
  return {
    id,
    chat_id: chat.id || 'gruppo@g.us',
    chat_name: chat.name || 'Informatica',
    sender_id: '39320@c.us',
    sender_name: sender,
    timestamp,
    text,
    type: 'chat',
  };
}

/** Ambiente del Worker con D1 finto e configurazione di prova. */
export function createFakeEnv(db) {
  return {
    DB: db,
    BRIDGE_BASE_URL: 'https://bridge.test',
    BRIDGE_API_KEY: 'bridge-key',
    GEMINI_API_KEY: 'gemini-key',
    GEMINI_MODEL: 'gemini-3.6-flash',
    GEMINI_BATCH_SIZE: '40',
    MAX_MESSAGES_PER_RUN: '300',
    STORE_ORIGINAL_TEXT: 'true',
    FIRST_RUN_LOOKBACK_HOURS: '24',
    DASHBOARD_URL: '',
  };
}
