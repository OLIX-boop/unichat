import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleApiRequest } from '../src/api.js';
import { buildContext } from '../src/classify.js';
import { createFakeD1, createFakeEnv, createFakeFetch, message } from './helpers.js';

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);

/** Inserisce a mano un elemento nel D1 finto, con o senza contesto. */
function seedItem(db, { id = 1, context = [{ from: 'Anna', text: 'Dove trovo le slide?', ts: NOW, self: false }] } = {}) {
  db.store.items.push({
    id,
    message_id: `m${id}`,
    chat_id: 'gruppo@g.us',
    chat_name: 'Informatica',
    category: 'materiale_didattico',
    summary: 'Le slide sono su WeBeep.',
    urgency: 'bassa',
    sender_name: 'Luca',
    original_text: 'sono su webeep',
    original_ts: NOW,
    context_json: context ? JSON.stringify(context) : null,
  });
}

function explainRequest(body, { token = 'segreto' } = {}) {
  return new Request('https://worker.test/api/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': token },
    body: JSON.stringify(body),
  });
}

function envConToken(db) {
  return { ...createFakeEnv(db), DASHBOARD_TOKEN: 'segreto' };
}

describe('buildContext', () => {
  const messaggi = [
    message('a', 1, 'primo', 'Anna'),
    message('b', 2, 'secondo', 'Bea'),
    message('c', 3, 'terzo', 'Carlo'),
    message('d', 4, 'quarto', 'Dario', { id: 'altra@g.us', name: 'Altro gruppo' }),
  ];

  it('prende i messaggi vicini e marca quello in questione', () => {
    const ctx = buildContext(messaggi[1], messaggi);
    assert.deepEqual(ctx.map((m) => m.text), ['primo', 'secondo', 'terzo']);
    assert.deepEqual(ctx.map((m) => m.self), [false, true, false]);
  });

  it('non mescola gruppi diversi', () => {
    const ctx = buildContext(messaggi[3], messaggi);
    assert.deepEqual(ctx.map((m) => m.text), ['quarto']);
  });

  it('tollera un messaggio che non sta nell elenco', () => {
    assert.deepEqual(buildContext(message('z', 9, 'ignoto'), messaggi), []);
  });
});

describe('POST /api/explain', () => {
  it('richiede il token della dashboard', async () => {
    const db = createFakeD1();
    seedItem(db);
    const response = await handleApiRequest(
      explainRequest({ item_id: 1, mode: 'chat' }, { token: 'sbagliato' }),
      envConToken(db),
    );
    assert.equal(response.status, 401);
  });

  it('rifiuta un item_id non valido', async () => {
    const db = createFakeD1();
    const response = await handleApiRequest(explainRequest({ mode: 'chat' }), envConToken(db));
    assert.equal(response.status, 400);
  });

  it('risponde 404 se l elemento non esiste', async () => {
    const db = createFakeD1();
    const response = await handleApiRequest(explainRequest({ item_id: 99 }), envConToken(db));
    assert.equal(response.status, 404);
  });

  it('spiega usando il contesto della chat e non tocca il web', async () => {
    const db = createFakeD1();
    seedItem(db);
    const { fakeFetch, calls } = createFakeFetch({ explainText: 'Anna chiedeva le slide; stanno su WeBeep.' });

    const response = await handleApiRequest(
      explainRequest({ item_id: 1, mode: 'chat' }),
      envConToken(db),
      { fetchImpl: fakeFetch },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.mode, 'chat');
    assert.match(body.text, /WeBeep/);
    assert.equal(calls.explain.length, 1);
    // Senza ricerca online non deve comparire alcuno strumento nella richiesta.
    assert.equal(calls.explain[0].body.tools, undefined);
    // Il contesto salvato deve finire nel prompt.
    assert.match(JSON.stringify(calls.explain[0].body), /Dove trovo le slide/);
  });

  it('con la verifica online spenta non chiama Gemini e lo dichiara', async () => {
    const db = createFakeD1();
    seedItem(db);
    const { fakeFetch, calls } = createFakeFetch({});

    const response = await handleApiRequest(
      explainRequest({ item_id: 1, mode: 'web' }),
      envConToken(db),
      { fetchImpl: fakeFetch },
    );
    const body = await response.json();

    assert.equal(body.disabled, true);
    assert.match(body.text, /piano a pagamento/);
    assert.equal(calls.explain.length, 0);
  });

  it('in modalita web passa lo strumento di ricerca e riporta le fonti', async () => {
    const db = createFakeD1();
    seedItem(db);
    const { fakeFetch, calls } = createFakeFetch({
      explainText: 'Attenzione: secondo il sito ufficiale il materiale sta altrove.',
      explainSources: [{ uri: 'https://polimi.it/x', title: 'Politecnico' }],
    });

    const response = await handleApiRequest(
      explainRequest({ item_id: 1, mode: 'web' }),
      { ...envConToken(db), WEB_SEARCH_ENABLED: 'true' },
      { fetchImpl: fakeFetch },
    );
    const body = await response.json();

    assert.equal(body.mode, 'web');
    assert.ok(calls.explain[0].body.tools);
    assert.deepEqual(body.sources, [{ title: 'Politecnico', url: 'https://polimi.it/x' }]);
  });

  it('la seconda richiesta usa la cache senza richiamare Gemini', async () => {
    const db = createFakeD1();
    seedItem(db);
    const primo = createFakeFetch({ explainText: 'Prima risposta.' });
    await handleApiRequest(explainRequest({ item_id: 1, mode: 'chat' }), envConToken(db), {
      fetchImpl: primo.fakeFetch,
    });

    const secondo = createFakeFetch({ explainText: 'Non deve arrivare qui.' });
    const response = await handleApiRequest(
      explainRequest({ item_id: 1, mode: 'chat' }),
      envConToken(db),
      { fetchImpl: secondo.fakeFetch },
    );
    const body = await response.json();

    assert.equal(body.text, 'Prima risposta.');
    assert.equal(body.cached, true);
    assert.equal(secondo.calls.explain.length, 0);
  });

  it('espone has_context, cosi la dashboard nasconde il pulsante inutile', async () => {
    const db = createFakeD1();
    seedItem(db, { id: 1 });
    seedItem(db, { id: 2, context: null });

    const conContesto = db.store.items.find((i) => i.id === 1);
    const senzaContesto = db.store.items.find((i) => i.id === 2);
    assert.ok(conContesto.context_json);
    assert.equal(senzaContesto.context_json, null);
  });

  it('senza contesto salvato lo dice invece di far parlare il modello a vuoto', async () => {
    const db = createFakeD1();
    seedItem(db, { context: null });
    const { fakeFetch, calls } = createFakeFetch({});

    const response = await handleApiRequest(
      explainRequest({ item_id: 1, mode: 'chat' }),
      envConToken(db),
      { fetchImpl: fakeFetch },
    );
    const body = await response.json();

    assert.equal(body.context_missing, true);
    assert.equal(calls.explain.length, 0);
  });

  it('propaga un errore di Gemini come 502', async () => {
    const db = createFakeD1();
    seedItem(db);
    const { fakeFetch } = createFakeFetch({ failOn: 'explain' });

    const response = await handleApiRequest(
      explainRequest({ item_id: 1, mode: 'chat' }),
      envConToken(db),
      { fetchImpl: fakeFetch },
    );
    assert.equal(response.status, 502);
  });
});
