import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runPipeline } from '../src/pipeline.js';
import { createFakeD1, createFakeEnv, createFakeFetch, message } from './helpers.js';

const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);

const MESSAGES = [
  message('m1', NOW - 3600_000, "Ricordo che l'esame di Analisi e' il 12/10"),
  message('m2', NOW - 1800_000, 'ahahahah'),
  message('m3', NOW - 900_000, 'Slide della lezione 4 nel drive'),
];

const VERDICTS = [
  { ref: 1, category: 'scadenze_esami', summary: 'Esame di Analisi il 12/10.', urgency: 'alta' },
  { ref: 2, category: 'rumore', summary: 'Risata.', urgency: 'bassa' },
  { ref: 3, category: 'materiale_didattico', summary: 'Slide della lezione 4 sul drive.', urgency: 'bassa' },
];

describe('runPipeline', () => {
  it('salva solo i messaggi rilevanti e invia un unico digest', async () => {
    const db = createFakeD1();
    const { fakeFetch, calls } = createFakeFetch({
      messages: MESSAGES,
      cursor: NOW - 900_000,
      verdicts: VERDICTS,
    });

    const summary = await runPipeline(createFakeEnv(db), { fetchImpl: fakeFetch, now: NOW });

    assert.equal(summary.status, 'ok');
    assert.equal(summary.fetched, 3);
    assert.equal(summary.relevant, 2);
    assert.equal(summary.stored, 2);
    assert.equal(summary.digest_sent, true);

    // Il rumore non entra mai in D1.
    assert.equal(db.store.items.length, 2);
    assert.ok(!db.store.items.some((i) => i.category === 'rumore'));

    // Un solo invio, con entrambe le sezioni.
    assert.equal(calls.send.length, 1);
    const text = calls.send[0].body.text;
    assert.ok(text.includes('Scadenze ed esami'));
    assert.ok(text.includes('Materiale didattico'));
    assert.ok(!text.includes('Risata'));

    // Il cursore avanza al timestamp restituito dal bridge.
    assert.equal(db.store.state.get('last_cursor'), String(NOW - 900_000));
  });

  it('non invia nulla se tutti i messaggi sono rumore', async () => {
    const db = createFakeD1();
    const { fakeFetch, calls } = createFakeFetch({
      messages: MESSAGES,
      cursor: NOW,
      verdicts: MESSAGES.map((_, i) => ({
        ref: i + 1,
        category: 'rumore',
        summary: 'niente di utile',
        urgency: 'bassa',
      })),
    });

    const summary = await runPipeline(createFakeEnv(db), { fetchImpl: fakeFetch, now: NOW });

    assert.equal(summary.relevant, 0);
    assert.equal(summary.digest_sent, false);
    assert.equal(calls.send.length, 0);
    assert.equal(db.store.items.length, 0);
    // Il cursore avanza comunque: quei messaggi sono stati valutati.
    assert.equal(db.store.state.get('last_cursor'), String(NOW));
  });

  it('non chiama Gemini se non ci sono messaggi nuovi', async () => {
    const db = createFakeD1();
    const { fakeFetch, calls } = createFakeFetch({ messages: [], cursor: NOW });

    const summary = await runPipeline(createFakeEnv(db), { fetchImpl: fakeFetch, now: NOW });

    assert.equal(summary.fetched, 0);
    assert.equal(calls.gemini.length, 0);
    assert.equal(calls.send.length, 0);
    assert.equal(summary.status, 'ok');
  });

  it('non avanza il cursore se il bridge e irraggiungibile', async () => {
    const db = createFakeD1();
    const { fakeFetch } = createFakeFetch({ failOn: 'messages' });

    const summary = await runPipeline(createFakeEnv(db), { fetchImpl: fakeFetch, now: NOW });

    assert.equal(summary.status, 'error');
    assert.match(summary.error, /Bridge non raggiungibile/);
    assert.equal(db.store.state.get('last_cursor'), undefined);
    assert.equal(db.store.runs[0].status, 'error');
  });

  it('un run ripetuto sugli stessi messaggi non manda un secondo digest', async () => {
    const db = createFakeD1();
    const first = createFakeFetch({ messages: MESSAGES, cursor: NOW, verdicts: VERDICTS });
    await runPipeline(createFakeEnv(db), { fetchImpl: first.fakeFetch, now: NOW });

    const second = createFakeFetch({ messages: MESSAGES, cursor: NOW, verdicts: VERDICTS });
    const summary = await runPipeline(createFakeEnv(db), { fetchImpl: second.fakeFetch, now: NOW });

    assert.equal(summary.relevant, 0);
    assert.equal(summary.digest_sent, false);
    assert.equal(second.calls.send.length, 0);
    assert.equal(db.store.items.length, 2);
  });

  it('segna il run come parziale se Gemini fallisce ma continua', async () => {
    const db = createFakeD1();
    const { fakeFetch, calls } = createFakeFetch({
      messages: MESSAGES,
      cursor: NOW,
      failOn: 'gemini',
    });

    const summary = await runPipeline(createFakeEnv(db), { fetchImpl: fakeFetch, now: NOW });

    assert.equal(summary.status, 'partial');
    assert.equal(summary.relevant, 0);
    assert.equal(calls.send.length, 0);
    // Il cursore avanza: rileggere gli stessi messaggi rischierebbe di bruciare
    // la quota Gemini a ogni ora su un batch che continua a fallire.
    assert.equal(db.store.state.get('last_cursor'), String(NOW));
  });

  it('conserva il gruppo di provenienza fino a D1 e al digest', async () => {
    const db = createFakeD1();
    const messaggi = [
      message('m1', NOW - 3600_000, 'Esame il 12/10', 'Anna', { id: 'uno@g.us', name: 'Informatica' }),
      message('m2', NOW - 1800_000, 'Aula spostata', 'Luca', { id: 'due@g.us', name: 'Elettronica' }),
    ];
    const { fakeFetch, calls } = createFakeFetch({
      messages: messaggi,
      cursor: NOW,
      verdicts: [
        { ref: 1, category: 'scadenze_esami', summary: 'Esame il 12/10.', urgency: 'alta' },
        { ref: 2, category: 'logistica', summary: 'Aula spostata in 4.', urgency: 'media' },
      ],
    });

    await runPipeline(createFakeEnv(db), { fetchImpl: fakeFetch, now: NOW });

    assert.deepEqual(
      db.store.items.map((i) => i.chat_name).sort(),
      ['Elettronica', 'Informatica'],
    );
    const text = calls.send[0].body.text;
    assert.ok(text.includes('Informatica'));
    assert.ok(text.includes('Elettronica'));
  });

  it('rispetta STORE_ORIGINAL_TEXT = false', async () => {
    const db = createFakeD1();
    const { fakeFetch } = createFakeFetch({ messages: MESSAGES, cursor: NOW, verdicts: VERDICTS });
    const env = { ...createFakeEnv(db), STORE_ORIGINAL_TEXT: 'false' };

    await runPipeline(env, { fetchImpl: fakeFetch, now: NOW });

    assert.ok(db.store.items.every((i) => i.original_text === null));
  });
});
