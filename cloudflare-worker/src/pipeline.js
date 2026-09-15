/**
 * Cuore del Worker: categorizzazione, scrittura su D1 e composizione del digest.
 *
 * La stessa logica serve due modalita' di funzionamento:
 *
 *  - **pull** (`runPipeline`): il Cron Trigger chiama il bridge attraverso un
 *    Cloudflare Tunnel. Richiede un dominio su Cloudflare.
 *  - **push** (`handleIngest`): e' il server a chiamare il Worker su
 *    `POST /ingest`; il digest torna nella risposta e lo invia il server.
 *    Non richiede ne' dominio ne' porte esposte.
 *
 * Cambia solo chi telefona a chi: categorie, Gemini, D1 e digest restano qui.
 */

import { createBridgeClient } from './bridge.js';
import { classifyMessages } from './classify.js';
import { buildDigest, countByCategory } from './digest.js';
import {
  filterNewItems,
  finishRun,
  getCursor,
  insertItems,
  setCursor,
  startRun,
} from './db.js';

/** Legge la configurazione da vars e secrets, applicando i default. */
export function readConfig(env) {
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    bridgeBaseUrl: env.BRIDGE_BASE_URL || '',
    bridgeApiKey: env.BRIDGE_API_KEY || '',
    geminiApiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-3.6-flash',
    batchSize: num(env.GEMINI_BATCH_SIZE, 40),
    maxMessagesPerRun: num(env.MAX_MESSAGES_PER_RUN, 300),
    storeOriginalText: String(env.STORE_ORIGINAL_TEXT ?? 'true') !== 'false',
    firstRunLookbackHours: num(env.FIRST_RUN_LOOKBACK_HOURS, 24),
    dashboardUrl: env.DASHBOARD_URL || '',
  };
}

/**
 * Classifica i messaggi, salva il rilevante e compone il digest.
 *
 * Non invia nulla e non tocca il cursore: se ne occupa il chiamante, che sa in
 * quale modalita' si trova.
 *
 * @returns {Promise<{items: Array, stored: number, digest: string|null, errors: string[]}>}
 */
export async function classifyAndStore(env, messages, { now, fetchImpl, runId }) {
  const cfg = readConfig(env);

  const { items, errors } = await classifyMessages(messages, {
    apiKey: cfg.geminiApiKey,
    model: cfg.geminiModel,
    batchSize: cfg.batchSize,
    fetchImpl,
  });

  // Gli elementi gia' presenti in D1 non vanno ne' riscritti ne' ri-annunciati:
  // e' cio' che rende innocuo un tentativo ripetuto dopo un errore.
  const fresh = await filterNewItems(env.DB, items);

  let stored = 0;
  let digest = null;
  if (fresh.length > 0) {
    stored = await insertItems(env.DB, runId, fresh, {
      storeOriginalText: cfg.storeOriginalText,
    });
    digest = buildDigest(fresh, {
      now,
      scannedCount: messages.length,
      dashboardUrl: cfg.dashboardUrl,
    });
  }

  return { items: fresh, stored, digest, errors };
}

/**
 * Modalita' pull: il cron legge dal bridge, elabora e rimanda il digest indietro.
 *
 * Il cursore in D1 avanza solo se il run arriva in fondo: un fallimento a meta'
 * fa rileggere la stessa finestra al giro successivo, e la deduplica su
 * `items.message_id` evita che gli elementi gia' inviati tornino nel digest.
 */
export async function runPipeline(env, deps = {}) {
  const { fetchImpl = fetch, now = Date.now() } = deps;
  const db = env.DB;
  const cfg = readConfig(env);

  const fallbackCursor = now - cfg.firstRunLookbackHours * 3600 * 1000;
  const cursorBefore = await getCursor(db, fallbackCursor);
  const runId = await startRun(db, cursorBefore);

  const summary = {
    run_id: runId,
    mode: 'pull',
    fetched: 0,
    relevant: 0,
    stored: 0,
    digest_sent: false,
    status: 'ok',
    error: null,
    by_category: {},
  };
  let cursorAfter = cursorBefore;

  try {
    const bridge = createBridgeClient({
      baseUrl: cfg.bridgeBaseUrl,
      apiKey: cfg.bridgeApiKey,
      fetchImpl,
    });

    const { messages, cursor } = await bridge.fetchMessages(
      cursorBefore,
      cfg.maxMessagesPerRun,
    );
    summary.fetched = messages.length;
    cursorAfter = Math.max(cursorBefore, Number(cursor) || cursorBefore);

    if (messages.length > 0) {
      const result = await classifyAndStore(env, messages, { now, fetchImpl, runId });
      if (result.errors.length) {
        summary.status = 'partial';
        summary.error = result.errors.join(' | ').slice(0, 500);
      }
      summary.relevant = result.items.length;
      summary.stored = result.stored;
      summary.by_category = countByCategory(result.items);

      if (result.digest) {
        await bridge.sendDigest(result.digest);
        summary.digest_sent = true;
      }
    }

    await setCursor(db, cursorAfter);
  } catch (err) {
    summary.status = 'error';
    summary.error = String(err?.message || err).slice(0, 500);
    console.error('[unichat] run fallito:', summary.error);
  }

  await finishRun(db, runId, {
    cursorAfter,
    fetchedCount: summary.fetched,
    relevantCount: summary.relevant,
    digestSent: summary.digest_sent,
    status: summary.status,
    error: summary.error,
  });

  console.log('[unichat] run completato', JSON.stringify(summary));
  return summary;
}

/**
 * Modalita' push: il server manda i messaggi, il Worker restituisce il digest.
 *
 * Il digest viaggia nella risposta HTTP: il Worker non ha bisogno di poter
 * raggiungere il server, ed e' cio' che rende superfluo il Cloudflare Tunnel.
 */
export async function handleIngest(request, env, deps = {}) {
  const { now = Date.now(), fetchImpl = fetch } = deps;

  const provided = request.headers.get('X-Bridge-Key') || '';
  if (!env.BRIDGE_API_KEY || provided !== env.BRIDGE_API_KEY) {
    return jsonResponse({ error: 'Chiave del bridge mancante o non valida' }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Corpo della richiesta non valido: atteso JSON' }, 400);
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : null;
  if (!messages) {
    return jsonResponse({ error: 'Campo "messages" mancante o non valido' }, 400);
  }

  const cfg = readConfig(env);
  const limited = messages.slice(0, cfg.maxMessagesPerRun);

  const summary = {
    mode: 'push',
    fetched: limited.length,
    relevant: 0,
    stored: 0,
    status: 'ok',
    error: null,
    by_category: {},
    digest: null,
  };

  // Niente messaggi: nessun run da registrare, nessuna chiamata a Gemini.
  if (limited.length === 0) {
    return jsonResponse(summary);
  }

  const cursorBefore = await getCursor(env.DB, 0);
  const runId = await startRun(env.DB, cursorBefore);
  summary.run_id = runId;

  const maxTimestamp = limited.reduce(
    (max, m) => Math.max(max, Number(m.timestamp) || 0),
    cursorBefore,
  );

  try {
    const result = await classifyAndStore(env, limited, { now, fetchImpl, runId });
    if (result.errors.length) {
      summary.status = 'partial';
      summary.error = result.errors.join(' | ').slice(0, 500);
    }
    summary.relevant = result.items.length;
    summary.stored = result.stored;
    summary.by_category = countByCategory(result.items);
    summary.digest = result.digest;

    await setCursor(env.DB, maxTimestamp);
  } catch (err) {
    summary.status = 'error';
    summary.error = String(err?.message || err).slice(0, 500);
    console.error('[unichat] ingest fallito:', summary.error);
  }

  await finishRun(env.DB, runId, {
    cursorAfter: maxTimestamp,
    fetchedCount: summary.fetched,
    relevantCount: summary.relevant,
    // In push il digest lo invia il server: qui si registra solo che e' stato prodotto.
    digestSent: Boolean(summary.digest),
    status: summary.status,
    error: summary.error,
  });

  console.log('[unichat] ingest completato', JSON.stringify({ ...summary, digest: undefined }));
  return jsonResponse(summary, summary.status === 'error' ? 500 : 200);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
