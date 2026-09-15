/**
 * Entrypoint del Worker UniChat.
 *
 *  - `scheduled`: Cron Trigger, usato solo in modalita' pull (serve un Tunnel).
 *  - `fetch`: `POST /ingest` (modalita' push), API di lettura per la dashboard
 *    e `GET /run` per lanciare a mano la pipeline in pull.
 *
 * La logica vera sta in `pipeline.js`: qui c'e' solo lo smistamento.
 */

import { handleApiRequest } from './api.js';
import { handleIngest, runPipeline } from './pipeline.js';

export { classifyAndStore, handleIngest, readConfig, runPipeline } from './pipeline.js';

export default {
  /**
   * Cron Trigger. In modalita' push non serve: lasciarlo attivo senza
   * `BRIDGE_BASE_URL` raggiungibile produce solo run in errore, quindi il
   * `crons` va commentato in wrangler.toml quando si usa il push.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPipeline(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Modalita' push: il server manda i messaggi e riceve il digest da inoltrare.
    if (url.pathname === '/ingest' && request.method === 'POST') {
      return handleIngest(request, env);
    }

    // Esecuzione manuale della pipeline in pull, per collaudo.
    if (url.pathname === '/run') {
      const token = request.headers.get('X-Admin-Token') || url.searchParams.get('token');
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
        return new Response(JSON.stringify({ error: 'Non autorizzato' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const summary = await runPipeline(env);
      return new Response(JSON.stringify(summary, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    return handleApiRequest(request, env, ctx);
  },
};
