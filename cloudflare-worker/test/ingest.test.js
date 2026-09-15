import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleIngest } from '../src/pipeline.js';
import { createFakeD1, createFakeEnv, createFakeFetch, message } from './helpers.js';

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);

const MESSAGES = [
  message('m1', NOW - 3600_000, "L'esame di Analisi e' il 12/10"),
  message('m2', NOW - 1800_000, 'ahahahah'),
];

const VERDICTS = [
  { ref: 1, category: 'scadenze_esami', summary: 'Esame di Analisi il 12/10.', urgency: 'alta' },
  { ref: 2, category: 'rumore', summary: 'Risata.', urgency: 'bassa' },
];

function ingestRequest(messages, { key = 'bridge-key' } = {}) {
  return new Request('https://worker.test/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Key': key },
    body: JSON.stringify({ messages }),
  });
}

describe('handleIngest', () => {
  it('rifiuta chi non presenta la chiave del bridge', async () => {
    const db = createFakeD1();
    const { fakeFetch } = createFakeFetch({});
    const senzaChiave = new Request('https://worker.test/ingest', {
      method: 'POST',
      body: '{"messages":[]}',
    });

    const r1 = await handleIngest(senzaChiave, createFakeEnv(db), { fetchImpl: fakeFetch });
    const r2 = await handleIngest(ingestRequest([], { key: 'sbagliata' }), createFakeEnv(db), {
      fetchImpl: fakeFetch,
    });

    assert.equal(r1.status, 401);
    assert.equal(r2.status, 401);
    assert.equal(db.store.runs.length, 0);
  });

  it('rifiuta un corpo senza il campo messages', async () => {
    const db = createFakeD1();
    const request = new Request('https://worker.test/ingest', {
      method: 'POST',
      headers: { 'X-Bridge-Key': 'bridge-key' },
      body: JSON.stringify({ roba: 1 }),
    });

    const response = await handleIngest(request, createFakeEnv(db));
    assert.equal(response.status, 400);
  });

  it('restituisce il digest e salva solo il rilevante', async () => {
    const db = createFakeD1();
    const { fakeFetch, calls } = createFakeFetch({ verdicts: VERDICTS });

    const response = await handleIngest(ingestRequest(MESSAGES), createFakeEnv(db), {
      fetchImpl: fakeFetch,
      now: NOW,
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.mode, 'push');
    assert.equal(body.fetched, 2);
    assert.equal(body.relevant, 1);
    assert.equal(body.stored, 1);
    assert.ok(body.digest.includes('Scadenze ed esami'));
    assert.ok(!body.digest.includes('Risata'));

    assert.equal(db.store.items.length, 1);
    assert.equal(db.store.items[0].category, 'scadenze_esami');
    // Il Worker non deve chiamare il bridge: in push non sa nemmeno dove sia.
    assert.equal(calls.send.length, 0);
  });

  it('non produce digest se e tutto rumore', async () => {
    const db = createFakeD1();
    const { fakeFetch } = createFakeFetch({
      verdicts: MESSAGES.map((_, i) => ({
        ref: i + 1,
        category: 'rumore',
        summary: 'niente',
        urgency: 'bassa',
      })),
    });

    const response = await handleIngest(ingestRequest(MESSAGES), createFakeEnv(db), {
      fetchImpl: fakeFetch,
      now: NOW,
    });
    const body = await response.json();

    assert.equal(body.relevant, 0);
    assert.equal(body.digest, null);
    assert.equal(db.store.items.length, 0);
  });

  it('non richiama Gemini quando non arrivano messaggi', async () => {
    const db = createFakeD1();
    const { fakeFetch, calls } = createFakeFetch({});

    const response = await handleIngest(ingestRequest([]), createFakeEnv(db), {
      fetchImpl: fakeFetch,
    });
    const body = await response.json();

    assert.equal(body.fetched, 0);
    assert.equal(calls.gemini.length, 0);
    assert.equal(db.store.runs.length, 0);
  });

  it('un reinvio degli stessi messaggi non rigenera il digest', async () => {
    const db = createFakeD1();
    const env = createFakeEnv(db);

    const primo = createFakeFetch({ verdicts: VERDICTS });
    await handleIngest(ingestRequest(MESSAGES), env, {
      fetchImpl: primo.fakeFetch,
      now: NOW,
    });

    const secondo = createFakeFetch({ verdicts: VERDICTS });
    const response = await handleIngest(ingestRequest(MESSAGES), env, {
      fetchImpl: secondo.fakeFetch,
      now: NOW,
    });
    const body = await response.json();

    assert.equal(body.relevant, 0);
    assert.equal(body.digest, null);
    assert.equal(db.store.items.length, 1);
  });

  it('registra il run e avanza il cursore', async () => {
    const db = createFakeD1();
    const { fakeFetch } = createFakeFetch({ verdicts: VERDICTS });

    await handleIngest(ingestRequest(MESSAGES), createFakeEnv(db), {
      fetchImpl: fakeFetch,
      now: NOW,
    });

    assert.equal(db.store.runs.length, 1);
    assert.equal(db.store.runs[0].status, 'ok');
    assert.equal(db.store.state.get('last_cursor'), String(NOW - 1800_000));
  });
});
