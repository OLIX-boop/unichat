/**
 * Composizione del digest WhatsApp: un solo messaggio raggruppato per categoria.
 * Nessuna notifica per singolo messaggio, nessun digest vuoto.
 */

import { URGENCIES, relevantCategories } from './config/categories.js';

const TZ = 'Europe/Rome';

/** Data e ora brevi in fuso italiano, es. "13/09 14:20". */
export function formatWhen(timestampMs, timeZone = TZ) {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('it-IT', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function urgencyRank(urgency) {
  const i = URGENCIES.indexOf(urgency);
  return i === -1 ? 0 : i;
}

function urgencyMark(urgency) {
  // Un solo segno fuori dall'ordinario, riservato a cio' che ha una scadenza
  // stretta: se ogni riga avesse il suo simbolo, nessuna risalterebbe.
  return urgency === 'alta' ? '⚠️ ' : '• ';
}

/**
 * Costruisce il testo del digest.
 *
 * @param {Array} items elementi rilevanti (gia' privi di "rumore")
 * @param {{now?:number, scannedCount?:number, dashboardUrl?:string, maxChars?:number}} opts
 * @returns {string|null} null se non c'e' nulla da inviare
 */
export function buildDigest(items, opts = {}) {
  if (!Array.isArray(items) || items.length === 0) return null;

  const { now = Date.now(), scannedCount = 0, dashboardUrl = '', maxChars = 6000 } = opts;

  const count = items.length;
  const cosa = count === 1 ? 'novità utile' : 'novità utili';
  const header = [
    `📋 *Digest · ${formatWhen(now)}*`,
    scannedCount
      ? `_${count} ${cosa} su ${scannedCount} messaggi letti_`
      : `_${count} ${cosa}_`,
  ].join('\n');

  // Con un solo gruppo monitorato indicarne il nome a ogni riga e' rumore;
  // con due o piu' e' l'informazione che dice subito di cosa si sta parlando.
  const groups = new Set(items.map((it) => it.chat_name || it.chat_id || ''));
  const showGroup = groups.size > 1;

  const sections = [];
  let rendered = 0;

  for (const category of relevantCategories()) {
    const group = items
      .filter((it) => it.category === category.slug)
      .sort(
        (a, b) =>
          urgencyRank(b.urgency) - urgencyRank(a.urgency) || a.original_ts - b.original_ts,
      );
    if (group.length === 0) continue;

    const lines = group.map((it) => {
      const who = it.sender_name || it.sender_id || 'anonimo';
      const where = showGroup && (it.chat_name || it.chat_id)
        ? ` · ${it.chat_name || it.chat_id}`
        : '';
      // Solo nome (ed eventuale gruppo): data e ora sono rumore in un digest
      // che copre poche ore, e la sintesi non ripete il mittente.
      return `${urgencyMark(it.urgency)}${it.summary}\n   _${who}${where}_`;
    });
    rendered += group.length;
    // Il conteggio accanto al titolo dice subito se la sezione merita lettura.
    const suffix = group.length > 1 ? ` · ${group.length}` : '';
    sections.push({ title: `${category.emoji} *${category.label}*${suffix}`, lines });
  }

  if (sections.length === 0) return null;

  const footer = dashboardUrl ? `\n\n🔎 Storico completo: ${dashboardUrl}` : '';
  const budget = maxChars - footer.length - 80;

  // Il taglio avviene per singolo elemento, non per sezione intera: meglio
  // perdere qualche riga sparsa che un'intera categoria (magari proprio quella
  // con la scadenza importante).
  let body = header;
  let omitted = 0;

  for (const section of sections) {
    let opened = false;
    for (const line of section.lines) {
      const cost = (opened ? 0 : `\n\n${section.title}`.length) + `\n${line}`.length;
      if (body.length + cost > budget) {
        omitted += 1;
        continue;
      }
      if (!opened) {
        body += `\n\n${section.title}`;
        opened = true;
      }
      body += `\n${line}`;
    }
  }

  if (omitted > 0) {
    body += `\n\n… e altri ${omitted} elementi, esclusi per non allungare troppo il messaggio.`;
  }

  return body + footer;
}

/** Conteggio per categoria, usato nei log del run. */
export function countByCategory(items) {
  return items.reduce((acc, it) => {
    acc[it.category] = (acc[it.category] || 0) + 1;
    return acc;
  }, {});
}
