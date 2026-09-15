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

// ---------------------------------------------------------------------------
// Approfondimento di un singolo elemento ("Approfondisci" nella dashboard)
// ---------------------------------------------------------------------------

const EXPLAIN_CHAT = [
  'Spieghi a uno studente un elemento estratto dal suo gruppo WhatsApp universitario.',
  '',
  'Usa ESCLUSIVAMENTE i messaggi del gruppo che ti vengono forniti: sono la',
  'discussione attorno al messaggio, ed e\' li\' che sta la risposta se esiste.',
  'Non attingere a conoscenze generali e non fare supposizioni.',
  '',
  '- Rispondi in italiano, al massimo 120 parole, senza preamboli.',
  '- Ricostruisci il senso: chi ha chiesto cosa, cosa e\' stato risposto, cosa resta aperto.',
  '- Se i messaggi NON bastano a chiarire, rispondi solo con:',
  '  "I messaggi del gruppo non bastano per approfondire." seguito da una riga',
  '  che dice quale informazione manca.',
].join('\n');

const EXPLAIN_WEB = [
  'Spieghi a uno studente un elemento estratto dal suo gruppo WhatsApp universitario.',
  '',
  'Procedi in questo ordine:',
  '1. Parti dai messaggi del gruppo forniti: sono la fonte primaria.',
  '2. Usa la ricerca web per completare cio\' che i messaggi non dicono e per',
  '   VERIFICARE quanto affermato nel gruppo.',
  '3. Se la ricerca contraddice quanto scritto nel gruppo, dillo apertamente,',
  '   iniziando la frase con "Attenzione:" e indicando la fonte.',
  '',
  '- Rispondi in italiano, al massimo 150 parole, senza preamboli.',
  '- Distingui sempre cio\' che viene dai messaggi da cio\' che viene dal web.',
  '- Se nemmeno la ricerca chiarisce, dillo invece di inventare.',
].join('\n');

/** Testo utente per l'approfondimento: elemento piu' discussione attorno. */
export function buildExplainPrompt(item, context = []) {
  const quando = new Date(item.original_ts).toLocaleString('it-IT', {
    timeZone: 'Europe/Rome',
  });
  const righe = (context || []).map((m) => {
    const marker = m.self ? '>>' : '  ';
    return `${marker} [${m.from || 'anonimo'}] ${m.text}`;
  });

  return [
    `Gruppo: ${item.chat_name || item.chat_id}`,
    `Categoria assegnata: ${item.category}`,
    `Sintesi nel digest: ${item.summary}`,
    `Messaggio originale (${item.sender_name || 'anonimo'}, ${quando}):`,
    item.original_text || '(testo non conservato)',
    '',
    righe.length
      ? `Discussione attorno a quel messaggio (>> indica il messaggio in questione):\n${righe.join('\n')}`
      : 'Nessun messaggio di contorno disponibile per questo elemento.',
  ].join('\n');
}

/**
 * Riassume un errore dell'API in una riga leggibile.
 *
 * I 429 di Gemini hanno un messaggio lunghissimo e generico, mentre l'unica
 * informazione che serve — quale limite e' stato superato — sta in fondo,
 * dentro `details`. Senza questa estrazione si finisce a leggere tre righe di
 * link alla documentazione senza capire cosa e' successo.
 */
export function describeApiError(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return String(raw).replace(/\s+/g, ' ').slice(0, 200);
  }

  const error = parsed?.error || {};
  const pezzi = [error.status || '', String(error.message || '').slice(0, 120)];

  for (const d of error.details || []) {
    for (const v of d.violations || []) {
      pezzi.push(`limite: ${v.quotaId || v.quotaMetric || 'sconosciuto'}${v.quotaValue ? ` (${v.quotaValue})` : ''}`);
    }
    if (d.retryDelay) pezzi.push(`riprovare fra ${d.retryDelay}`);
  }
  return pezzi.filter(Boolean).join(' — ');
}

/** Estrae le fonti citate dalla risposta, qualunque forma abbia il payload. */
function extractSources(payload) {
  const candidate = payload?.candidates?.[0];
  const chunks = candidate?.groundingMetadata?.groundingChunks || [];
  const fromChunks = chunks
    .map((c) => c?.web)
    .filter(Boolean)
    .map((w) => ({ title: w.title || w.uri, url: w.uri }));

  const annotations = (candidate?.content?.parts || [])
    .flatMap((p) => p.annotations || [])
    .map((a) => a.url_citation || a)
    .filter((a) => a && a.url)
    .map((a) => ({ title: a.title || a.url, url: a.url }));

  const tutte = [...fromChunks, ...annotations];
  const viste = new Set();
  return tutte.filter((s) => (viste.has(s.url) ? false : viste.add(s.url)));
}

/**
 * Chiede a Gemini di approfondire un elemento.
 *
 * Con `useWeb` attivo aggiunge la ricerca Google come strumento: il formato del
 * campo `tools` e' cambiato fra le versioni dell'API, quindi si prova quello
 * attuale e, se viene rifiutato, si ripiega sul precedente.
 *
 * @returns {Promise<{text: string, sources: Array<{title: string, url: string}>}>}
 */
export async function explainItem(item, { apiKey, model, useWeb = false, fetchImpl = fetch }) {
  if (!apiKey) throw new GeminiError('GEMINI_API_KEY non configurata');

  const base = {
    systemInstruction: { parts: [{ text: useWeb ? EXPLAIN_WEB : EXPLAIN_CHAT }] },
    contents: [{ role: 'user', parts: [{ text: buildExplainPrompt(item, item.context) }] }],
    generationConfig: { temperature: 0.2 },
  };

  // Il nome del campo per la ricerca Google cambia fra le versioni dell'API:
  // si provano le forme note in ordine, tenendo traccia di tutti gli errori.
  const varianti = useWeb
    ? [
        { ...base, tools: [{ googleSearch: {} }] },
        { ...base, tools: [{ google_search: {} }] },
        { ...base, tools: [{ type: 'google_search' }] },
      ]
    : [base];

  const errori = [];
  for (const body of varianti) {
    const response = await fetchImpl(`${API_ROOT}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      errori.push(`${response.status}: ${describeApiError(detail)}`);
      continue;
    }

    const payload = await response.json();
    const text = (payload?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('')
      .trim();
    if (!text) {
      errori.push('risposta vuota');
      continue;
    }
    return { text, sources: extractSources(payload) };
  }

  throw new GeminiError(`Gemini ha rifiutato tutte le varianti — ${errori.join(' || ')}`);
}
