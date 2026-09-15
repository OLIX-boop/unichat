import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chunk, classifyMessages, normalizeResults } from '../src/classify.js';
import { buildPrompt, parseGeminiResponse, responseSchema } from '../src/gemini.js';
import { CATEGORY_SLUGS } from '../src/config/categories.js';
import { createFakeFetch, geminiResponse, message } from './helpers.js';

const batch = [
  message('m1', 1000, "L'esame di Analisi e' il 12/10"),
  message('m2', 2000, 'ahahah grandissimo'),
  message('m3', 3000, 'Ecco le slide della lezione 4'),
];

describe('normalizeResults', () => {
  it('tiene solo le categorie rilevanti e riaggancia il messaggio originale', () => {
    const items = normalizeResults(
      [
        { ref: 1, category: 'scadenze_esami', summary: 'Esame il 12/10.', urgency: 'alta' },
        { ref: 2, category: 'rumore', summary: 'Battuta.', urgency: 'bassa' },
        { ref: 3, category: 'materiale_didattico', summary: 'Slide lezione 4.', urgency: 'bassa' },
      ],
      batch,
    );
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((i) => i.message_id),
      ['m1', 'm3'],
    );
    assert.equal(items[0].original_ts, 1000);
    assert.equal(items[0].original_text, "L'esame di Analisi e' il 12/10");
    assert.equal(items[0].sender_name, 'Mario Rossi');
  });

  it('scarta le categorie inventate dal modello', () => {
    const items = normalizeResults(
      [{ ref: 1, category: 'categoria_inesistente', summary: 'x', urgency: 'alta' }],
      batch,
    );
    assert.deepEqual(items, []);
  });

  it('scarta ref fuori range e sintesi vuote', () => {
    const items = normalizeResults(
      [
        { ref: 0, category: 'logistica', summary: 'a', urgency: 'bassa' },
        { ref: 99, category: 'logistica', summary: 'b', urgency: 'bassa' },
        { ref: 1, category: 'logistica', summary: '   ', urgency: 'bassa' },
      ],
      batch,
    );
    assert.deepEqual(items, []);
  });

  it('ignora i ref duplicati tenendo il primo', () => {
    const items = normalizeResults(
      [
        { ref: 1, category: 'logistica', summary: 'primo', urgency: 'bassa' },
        { ref: 1, category: 'logistica', summary: 'secondo', urgency: 'bassa' },
      ],
      batch,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].summary, 'primo');
  });

  it('degrada a urgenza bassa se il valore non e previsto', () => {
    const items = normalizeResults(
      [{ ref: 1, category: 'logistica', summary: 'ok', urgency: 'urgentissima' }],
      batch,
    );
    assert.equal(items[0].urgency, 'bassa');
  });
});

describe('chunk', () => {
  it('divide in blocchi della dimensione richiesta', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 10), []);
  });
});

describe('prompt e schema', () => {
  it('lo schema elenca tutte le categorie della tassonomia', () => {
    assert.deepEqual(responseSchema().items.properties.category.enum, CATEGORY_SLUGS);
  });

  it('il prompt numera i messaggi e descrive le categorie', () => {
    const prompt = buildPrompt(batch);
    assert.ok(prompt.includes('[1]'));
    assert.ok(prompt.includes('[3]'));
    assert.ok(prompt.includes('scadenze_esami:'));
    assert.ok(prompt.includes('Ecco le slide della lezione 4'));
  });
});

describe('parseGeminiResponse', () => {
  it('estrae l array dai candidati', () => {
    const parsed = parseGeminiResponse(geminiResponse([{ ref: 1 }]));
    assert.deepEqual(parsed, [{ ref: 1 }]);
  });

  it('fallisce in modo esplicito se il prompt e stato bloccato', () => {
    assert.throws(
      () => parseGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }),
      /SAFETY/,
    );
  });

  it('fallisce se il testo non e JSON', () => {
    const payload = {
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'non json' }] } }],
    };
    assert.throws(() => parseGeminiResponse(payload), /JSON non valido/);
  });
});

describe('classifyMessages', () => {
  it('spezza in piu batch e unisce i risultati', async () => {
    const { fakeFetch, calls } = createFakeFetch({
      verdicts: [{ ref: 1, category: 'logistica', summary: 'Aula cambiata.', urgency: 'media' }],
    });
    const messages = [message('a', 1, 'x'), message('b', 2, 'y'), message('c', 3, 'z')];
    const out = await classifyMessages(messages, {
      apiKey: 'k',
      model: 'gemini-3.6-flash',
      batchSize: 2,
      fetchImpl: fakeFetch,
    });
    assert.equal(calls.gemini.length, 2);
    assert.equal(out.batches, 2);
    assert.equal(out.items.length, 2);
    assert.deepEqual(out.errors, []);
  });

  it('un batch fallito non fa fallire gli altri', async () => {
    let call = 0;
    const fetchImpl = async (url, init) => {
      call += 1;
      if (call === 1) {
        return { ok: false, status: 400, async text() { return 'quota'; }, async json() { return {}; } };
      }
      const verdicts = [{ ref: 1, category: 'logistica', summary: 'Aula 4.', urgency: 'bassa' }];
      return { ok: true, status: 200, async json() { return geminiResponse(verdicts); }, async text() { return ''; } };
    };
    const out = await classifyMessages([message('a', 1, 'x'), message('b', 2, 'y')], {
      apiKey: 'k',
      model: 'gemini-3.6-flash',
      batchSize: 1,
      fetchImpl,
    });
    assert.equal(out.items.length, 1);
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0], /400/);
  });
});
