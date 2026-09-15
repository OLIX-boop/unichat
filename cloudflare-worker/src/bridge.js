/**
 * Client verso il bridge locale, raggiunto attraverso il Cloudflare Tunnel.
 * L'unica parte del Worker che sa come si raggiunge WhatsApp.
 */

export class BridgeError extends Error {}

/**
 * Crea un client legato a una configurazione.
 * `fetchImpl` e' iniettabile per i test.
 */
export function createBridgeClient({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 25000 }) {
  if (!baseUrl) throw new BridgeError('BRIDGE_BASE_URL non configurato');
  if (!apiKey) throw new BridgeError('BRIDGE_API_KEY non configurato');
  const root = baseUrl.replace(/\/+$/, '');

  async function call(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(root + path, {
        ...init,
        signal: controller.signal,
        headers: {
          'X-Bridge-Key': apiKey,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
    } catch (err) {
      throw new BridgeError(`Bridge non raggiungibile (${path}): ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new BridgeError(
        `Bridge ha risposto ${response.status} su ${path}: ${body.slice(0, 200)}`,
      );
    }
    return response.json();
  }

  return {
    /**
     * Scarica i messaggi successivi a `since` (epoch ms).
     * @returns {Promise<{messages: Array, count: number, cursor: number}>}
     */
    async fetchMessages(since, limit) {
      const params = new URLSearchParams({ since: String(since) });
      if (limit) params.set('limit', String(limit));
      const data = await call(`/messages?${params.toString()}`);
      return {
        messages: Array.isArray(data.messages) ? data.messages : [],
        count: Number(data.count || 0),
        cursor: Number(data.cursor || since),
      };
    },

    /** Invia il digest gia' composto alla chat di destinazione. */
    async sendDigest(text) {
      return call('/send', { method: 'POST', body: JSON.stringify({ text }) });
    },
  };
}
