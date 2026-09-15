import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDigest, countByCategory, formatWhen } from '../src/digest.js';

const T = Date.UTC(2026, 8, 13, 12, 0, 0);

function item(overrides = {}) {
  return {
    message_id: 'm1',
    category: 'scadenze_esami',
    summary: 'Esame di Analisi il 12/10.',
    urgency: 'media',
    sender_name: 'Mario Rossi',
    original_ts: T,
    ...overrides,
  };
}

describe('buildDigest', () => {
  it('non produce nulla se non ci sono elementi rilevanti', () => {
    assert.equal(buildDigest([]), null);
    assert.equal(buildDigest(null), null);
  });

  it('raggruppa per categoria seguendo l ordine della tassonomia', () => {
    const text = buildDigest(
      [
        item({ message_id: 'a', category: 'opportunita', summary: 'Bando borse di studio.' }),
        item({ message_id: 'b', category: 'scadenze_esami', summary: 'Appello il 3/11.' }),
        item({ message_id: 'c', category: 'logistica', summary: 'Lezione spostata in aula 4.' }),
      ],
      { now: T },
    );
    const posScadenze = text.indexOf('Scadenze ed esami');
    const posLogistica = text.indexOf('Logistica');
    const posOpportunita = text.indexOf('Opportunità');
    assert.ok(posScadenze > -1 && posLogistica > posScadenze && posOpportunita > posLogistica);
  });

  it('mette gli elementi urgenti in cima alla loro sezione', () => {
    const text = buildDigest(
      [
        item({ message_id: 'a', summary: 'Informativa generica.', urgency: 'bassa' }),
        item({ message_id: 'b', summary: 'Iscrizioni chiudono domani.', urgency: 'alta' }),
      ],
      { now: T },
    );
    assert.ok(text.indexOf('Iscrizioni chiudono domani.') < text.indexOf('Informativa generica.'));
    assert.ok(text.includes('⚠️'));
  });

  it('riporta mittente, orario e conteggio dei messaggi letti', () => {
    const text = buildDigest([item()], { now: T, scannedCount: 47 });
    assert.ok(text.includes('Mario Rossi'));
    assert.ok(text.includes('1 novità utile su 47 messaggi letti'));
    assert.ok(text.includes(formatWhen(T)));
  });

  it('aggiunge il link alla dashboard solo se configurato', () => {
    assert.ok(!buildDigest([item()], { now: T }).includes('Storico completo'));
    const withLink = buildDigest([item()], { now: T, dashboardUrl: 'https://x.pages.dev' });
    assert.ok(withLink.includes('https://x.pages.dev'));
  });

  it('indica il gruppo solo quando se ne monitora piu di uno', () => {
    const soloUno = buildDigest(
      [item({ chat_name: 'Informatica' }), item({ message_id: 'b', chat_name: 'Informatica' })],
      { now: T },
    );
    assert.ok(!soloUno.includes('Informatica'));

    const due = buildDigest(
      [
        item({ message_id: 'a', chat_name: 'Informatica' }),
        item({ message_id: 'b', chat_name: 'Elettronica', category: 'logistica' }),
      ],
      { now: T },
    );
    assert.ok(due.includes('Informatica'));
    assert.ok(due.includes('Elettronica'));
  });

  it('non contiene sezioni per categorie senza elementi', () => {
    const text = buildDigest([item()], { now: T });
    assert.ok(!text.includes('Materiale didattico'));
    assert.ok(!text.includes('Rumore'));
  });

  it('non ripete data e ora su ogni riga', () => {
    const text = buildDigest([item()], { now: T });
    // La data compare una volta sola, nell'intestazione.
    const occorrenze = text.split(formatWhen(T)).length - 1;
    assert.equal(occorrenze, 1);
  });

  it('taglia per singolo elemento, non per sezione intera', () => {
    const lungo = 'x'.repeat(600);
    const items = [
      item({ message_id: '1', category: 'scadenze_esami', summary: lungo }),
      item({ message_id: '2', category: 'materiale_didattico', summary: lungo }),
      item({ message_id: '3', category: 'comunicazioni_ufficiali', summary: lungo }),
      item({ message_id: '4', category: 'logistica', summary: 'Aula 4 al posto della 12.' }),
      item({ message_id: '5', category: 'opportunita', summary: 'Bando aperto fino al 30.' }),
    ];
    const text = buildDigest(items, { now: T, maxChars: 1500 });

    assert.ok(text.length <= 1500);
    assert.ok(text.includes('elementi, esclusi'));
    // Col taglio per sezione, "Logistica" sarebbe sparita insieme alle due
    // categorie lunghe che la precedono: qui invece il suo elemento breve entra.
    assert.ok(text.includes('Aula 4 al posto della 12.'));
    assert.ok(!text.includes('Comunicazioni ufficiali'));
  });
});

describe('countByCategory', () => {
  it('conta gli elementi per categoria', () => {
    const counts = countByCategory([
      item({ category: 'logistica' }),
      item({ category: 'logistica' }),
      item({ category: 'opportunita' }),
    ]);
    assert.deepEqual(counts, { logistica: 2, opportunita: 1 });
  });
});
