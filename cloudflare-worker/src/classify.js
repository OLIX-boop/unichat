/**
 * Orchestrazione della categorizzazione: batching, validazione dell'output del
 * modello e riaggancio di ogni verdetto al messaggio originale.
 */

import { classifyBatch } from './gemini.js';
import { URGENCIES, categoryBySlug, isDiscarded } from './config/categories.js';

/** Quanti messaggi adiacenti conservare attorno a un elemento rilevante. */
export const CONTEXT_BEFORE = 8;
export const CONTEXT_AFTER = 4;

/**
 * Ritaglia la discussione attorno a un messaggio, restando nella sua chat.
 *
 * Serve ad "Approfondisci": una sintesi come "su WeBeep c'e' la sezione corsi"
 * e' incomprensibile da sola, ma diventa chiara con la domanda che l'ha
 * provocata. Si conservano solo i messaggi vicini, non l'intera cronologia.
 */
export function buildContext(message, allMessages) {
  const sameChat = allMessages
    .filter((m) => m.chat_id === message.chat_id)
    .sort((a, b) => a.timestamp - b.timestamp);
  const index = sameChat.findIndex((m) => m.id === message.id);
  if (index === -1) return [];

  return sameChat
    .slice(Math.max(0, index - CONTEXT_BEFORE), index + CONTEXT_AFTER + 1)
    .map((m) => ({
      from: m.sender_name || m.sender_id || '',
      text: String(m.text || '').slice(0, 500),
      ts: m.timestamp,
      self: m.id === message.id,
    }));
}

/** Divide un array in blocchi di dimensione massima `size`. */
export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Trasforma i verdetti grezzi in elementi pronti per D1.
 *
 * Scarta silenziosamente: categorie sconosciute (allucinazioni), `ref` fuori
 * range, sintesi vuote e tutto cio' che e' marcato come rumore.
 */
export function normalizeResults(rawResults, batch) {
  const items = [];
  const seenRefs = new Set();

  for (const raw of rawResults) {
    const ref = Number(raw?.ref);
    if (!Number.isInteger(ref) || ref < 1 || ref > batch.length) continue;
    if (seenRefs.has(ref)) continue;
    seenRefs.add(ref);

    const slug = String(raw?.category || '').trim();
    if (!categoryBySlug(slug) || isDiscarded(slug)) continue;

    const summary = String(raw?.summary || '').trim();
    if (!summary) continue;

    const urgency = URGENCIES.includes(raw?.urgency) ? raw.urgency : 'bassa';
    const message = batch[ref - 1];

    items.push({
      message_id: message.id,
      chat_id: message.chat_id,
      chat_name: message.chat_name || '',
      category: slug,
      summary,
      urgency,
      sender_id: message.sender_id || '',
      sender_name: message.sender_name || '',
      original_text: message.text || '',
      original_ts: Number(message.timestamp) || 0,
    });
  }
  return items;
}

/**
 * Classifica tutti i messaggi in batch successivi.
 *
 * Un batch fallito non fa fallire l'intero run: viene registrato in `errors` e
 * gli altri proseguono, perche' un digest parziale e' meglio di nessun digest.
 * @returns {Promise<{items: Array, errors: string[], batches: number}>}
 */
export async function classifyMessages(messages, { apiKey, model, batchSize = 40, fetchImpl = fetch }) {
  const batches = chunk(messages, batchSize);
  const items = [];
  const errors = [];

  for (const batch of batches) {
    try {
      const raw = await classifyBatch(batch, { apiKey, model, fetchImpl });
      items.push(...normalizeResults(raw, batch));
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { items, errors, batches: batches.length };
}
