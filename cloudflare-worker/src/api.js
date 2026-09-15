/**
 * API HTTP di sola lettura che alimenta la dashboard su Cloudflare Pages.
 * Nessuna scrittura: l'unico percorso che modifica D1 e' il Cron Trigger.
 */

import { CATEGORIES, relevantCategories } from './config/categories.js';
import { getExplanation, getItem, getStats, listRuns, queryItems, saveExplanation } from './db.js';
import { explainItem } from './gemini.js';
import { readConfig } from './pipeline.js';

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Dashboard-Token',
  };
}

function json(data, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(env),
    },
  });
}

/**
 * Se il secret DASHBOARD_TOKEN e' impostato, ogni lettura deve presentarlo
 * nell'header X-Dashboard-Token (o in `?token=`). Se non e' impostato l'API e'
 * pubblica in lettura: comodo per provare, da valutare se il gruppo tratta
 * informazioni che preferisci non lasciare in chiaro su internet.
 */
function authorized(request, env) {
  const expected = env.DASHBOARD_TOKEN;
  if (!expected) return true;
  const url = new URL(request.url);
  const provided = request.headers.get('X-Dashboard-Token') || url.searchParams.get('token') || '';
  return provided === expected;
}

export async function handleApiRequest(request, env, deps = {}) {
  const url = new URL(request.url);
  const { pathname, searchParams } = url;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }
  if (pathname === '/health') {
    return json({ status: 'ok', service: 'unichat-worker' }, env);
  }
  if (!authorized(request, env)) {
    return json({ error: 'Token dashboard mancante o non valido' }, env, 401);
  }

  if (pathname === '/api/explain' && request.method === 'POST') {
    return handleExplain(request, env, deps);
  }
  if (request.method !== 'GET') {
    return json({ error: 'Metodo non consentito' }, env, 405);
  }

  if (pathname === '/api/categories') {
    return json(
      {
        categories: relevantCategories().map(({ slug, label, emoji, order }) => ({
          slug,
          label,
          emoji,
          order,
        })),
        all: CATEGORIES.map((c) => c.slug),
      },
      env,
    );
  }

  if (pathname === '/api/items') {
    const result = await queryItems(env.DB, {
      category: searchParams.get('category') || undefined,
      chat: searchParams.get('chat') || undefined,
      from: searchParams.get('from') || undefined,
      to: searchParams.get('to') || undefined,
      q: searchParams.get('q') || undefined,
      order: searchParams.get('order') || 'desc',
      limit: searchParams.get('limit') || 100,
      offset: searchParams.get('offset') || 0,
    });
    return json(result, env);
  }

  if (pathname === '/api/stats') {
    const stats = await getStats(env.DB);
    // La dashboard usa `features` per non mostrare pulsanti che non possono
    // funzionare con la configurazione attuale.
    return json(
      { ...stats, features: { web_search: readConfig(env).webSearchEnabled } },
      env,
    );
  }

  if (pathname === '/api/runs') {
    return json({ runs: await listRuns(env.DB, searchParams.get('limit') || 20) }, env);
  }

  return json({ error: 'Endpoint sconosciuto' }, env, 404);
}

/**
 * Approfondisce un elemento dello storico.
 *
 * Due modalita': `chat` ragiona solo sui messaggi del gruppo conservati come
 * contesto, `web` aggiunge la ricerca online per completare e verificare. La
 * seconda parte solo se l'utente la chiede, quindi il consumo di quota resta
 * legato a un gesto esplicito.
 *
 * Il risultato viene messo in cache per (elemento, modalita'): riaprire la
 * dashboard non ripaga la stessa domanda.
 */
async function handleExplain(request, env, deps = {}) {
  const { fetchImpl = fetch } = deps;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Corpo della richiesta non valido: atteso JSON' }, env, 400);
  }

  const itemId = Number(payload?.item_id);
  const mode = payload?.mode === 'web' ? 'web' : 'chat';
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return json({ error: 'Campo "item_id" mancante o non valido' }, env, 400);
  }

  if (!payload?.refresh) {
    const cached = await getExplanation(env.DB, itemId, mode);
    if (cached) return json({ ...cached, mode }, env);
  }

  if (mode === 'web' && !readConfig(env).webSearchEnabled) {
    return json(
      {
        mode,
        text:
          'La verifica online e\' disattivata. La ricerca Google come strumento ' +
          'di Gemini richiede il piano a pagamento: sul piano gratuito ogni ' +
          'richiesta viene rifiutata. Per attivarla: abilita la fatturazione su ' +
          'Google AI Studio e metti WEB_SEARCH_ENABLED = "true" in wrangler.toml.',
        sources: [],
        cached: false,
        disabled: true,
      },
      env,
    );
  }

  const item = await getItem(env.DB, itemId);
  if (!item) return json({ error: 'Elemento non trovato' }, env, 404);

  if (mode === 'chat' && (!item.context || item.context.length === 0)) {
    // Gli elementi salvati prima dell'introduzione del contesto non ne hanno:
    // meglio dirlo che far rispondere il modello a vuoto.
    return json(
      {
        mode,
        text:
          'Per questo elemento non e\' stato conservato il contesto della ' +
          'conversazione, quindi non c\'e\' nulla su cui approfondire. Vale solo ' +
          'per gli elementi raccolti prima che la funzione esistesse: i nuovi ' +
          'arrivano con la discussione attorno.',
        sources: [],
        cached: false,
        context_missing: true,
      },
      env,
    );
  }

  try {
    const result = await explainItem(item, {
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL || 'gemini-3.6-flash',
      useWeb: mode === 'web',
      fetchImpl,
    });
    await saveExplanation(env.DB, itemId, mode, result.text, result.sources);
    return json({ ...result, mode, cached: false }, env);
  } catch (err) {
    console.error('[unichat] approfondimento fallito:', err?.message || err);
    return json({ error: String(err?.message || err).slice(0, 300) }, env, 502);
  }
}
