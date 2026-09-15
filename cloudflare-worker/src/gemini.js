/**
 * Categorizzazione via Gemini API (solo API ufficiale, nessuna automazione browser).
 *
 * L'output e' vincolato con `responseSchema`, quindi la risposta e' JSON valido
 * per costruzione: niente parsing euristico di testo libero.
 */

import { CATEGORIES, CATEGORY_SLUGS, URGENCIES } from './config/categories.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiError extends Error {}

const SYSTEM_INSTRUCTION = [
  'Sei un filtro per i messaggi di un gruppo WhatsApp universitario molto rumoroso.',
  "L'utente ha silenziato il gruppo e vuole ricevere solo cio' che ha valore pratico",
  'per uno studente che non ha letto la conversazione.',
  '',
  'Regole di selezione:',
  '- Classifica OGNI messaggio ricevuto, senza saltarne nessuno.',
  '- Nel dubbio scegli "rumore": e\' molto peggio inondare di banalita\' che perdere un messaggio marginale.',
  '- I messaggi arrivano in ordine cronologico e spesso appartengono alla stessa discussione.',
  '  Una discussione deve produrre UN SOLO elemento: scegli il messaggio che contiene',
  '  l\'informazione definitiva e marca "rumore" tutti gli altri della stessa discussione,',
  '  comprese le domande che quel messaggio ha risposto.',
  '- Sono sempre "rumore": domande rimaste senza risposta, conferme ("si", "esatto", "ok"),',
  '  ringraziamenti, opinioni, lamentele, ipotesi non verificate, messaggi che commentano',
  '  un altro messaggio senza aggiungere fatti nuovi.',
  '- Se un messaggio non dice nulla di utile a chi NON ha letto la chat, e\' "rumore".',
  '',
  'Regole di scrittura della sintesi:',
  '- Una frase sola, al massimo due, in italiano.',
  '- NON nominare il mittente e non scrivere "X chiede", "X dice", "X conferma": il nome',
  '  viene gia\' mostrato a parte, ripeterlo e\' spreco. Scrivi direttamente il fatto.',
  '  Esempio sbagliato: "Joan ha fornito il link dello scadenzario".',
  '  Esempio giusto: "Scadenzario ufficiale: https://...".',
  '- Conserva i dettagli operativi: date, orari, aule, link, nomi di corsi e docenti.',
  '- Non inventare nulla che non sia nel messaggio.',
  '- Urgenza "alta" solo se c\'e\' una scadenza entro pochi giorni o un\'azione immediata da compiere;',
  '  "media" se richiede un\'azione senza urgenza; "bassa" se e\' solo informativo.',
].join('\n');

/** Descrizione della tassonomia iniettata nel prompt, generata dalla config. */
export function categoriesBlock() {
  return CATEGORIES.map((c) => `- ${c.slug}: ${c.description}`).join('\n');
}

/** Schema dell'output: un oggetto per ogni messaggio in ingresso. */
export function responseSchema() {
  return {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        ref: { type: 'INTEGER', description: 'Numero del messaggio come indicato in input' },
        category: { type: 'STRING', enum: CATEGORY_SLUGS },
        summary: { type: 'STRING', description: 'Sintesi autosufficiente di 1-2 frasi' },
        urgency: { type: 'STRING', enum: URGENCIES },
      },
      required: ['ref', 'category', 'summary', 'urgency'],
      propertyOrdering: ['ref', 'category', 'summary', 'urgency'],
    },
  };
}

/** Testo utente: elenco numerato dei messaggi da classificare. */
export function buildPrompt(messages) {
  const lines = messages.map((m, i) => {
    const when = new Date(m.timestamp).toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    const who = m.sender_name || m.sender_id || 'sconosciuto';
    const text = String(m.text || '').replace(/\s+/g, ' ').slice(0, 1200);
    return `[${i + 1}] (${when} — ${who}) ${text}`;
  });
  return [
    'Categorie disponibili:',
    categoriesBlock(),
    '',
    `Classifica i seguenti ${messages.length} messaggi e restituisci un elemento per ciascuno,`,
    'usando in "ref" il numero tra parentesi quadre.',
    '',
    lines.join('\n'),
  ].join('\n');
}

export function buildRequestBody(messages) {
  return {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: buildPrompt(messages) }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: responseSchema(),
    },
  };
}

/** Estrae e valida l'array JSON dalla risposta grezza dell'API. */
export function parseGeminiResponse(payload) {
  const candidate = payload?.candidates?.[0];
  if (!candidate) {
    const reason = payload?.promptFeedback?.blockReason || 'nessun candidato';
    throw new GeminiError(`Risposta Gemini vuota (${reason})`);
  }
  if (candidate.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
    throw new GeminiError(`Gemini ha interrotto la generazione: ${candidate.finishReason}`);
  }
  const text = (candidate.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();
  if (!text) throw new GeminiError('Gemini ha restituito un testo vuoto');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new GeminiError(`JSON non valido da Gemini: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new GeminiError('Gemini non ha restituito un array');
  }
  return parsed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Classifica un batch di messaggi.
 * Ritenta solo su errori transitori (429 e 5xx), con backoff lineare.
 * @returns {Promise<Array<{ref:number, category:string, summary:string, urgency:string}>>}
 */
export async function classifyBatch(messages, { apiKey, model, fetchImpl = fetch, retries = 2 }) {
  if (!apiKey) throw new GeminiError('GEMINI_API_KEY non configurata');
  const url = `${API_ROOT}/${model}:generateContent`;
  const body = JSON.stringify(buildRequestBody(messages));

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body,
      });
    } catch (err) {
      lastError = new GeminiError(`Gemini non raggiungibile: ${err.message}`);
      if (attempt < retries) { await sleep(1000 * (attempt + 1)); continue; }
      throw lastError;
    }

    if (response.status === 429 || response.status >= 500) {
      const detail = await response.text().catch(() => '');
      lastError = new GeminiError(`Gemini ${response.status}: ${detail.slice(0, 200)}`);
      if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
      throw lastError;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new GeminiError(`Gemini ${response.status}: ${detail.slice(0, 300)}`);
    }
    return parseGeminiResponse(await response.json());
  }
  throw lastError;
}
