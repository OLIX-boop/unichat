/**
 * Tassonomia del digest: UNICO punto da editare per aggiungere, rinominare o
 * eliminare una categoria.
 *
 * Da qui derivano automaticamente: l'enum del responseSchema di Gemini, le
 * descrizioni nel prompt, l'ordine delle sezioni del digest e i filtri della
 * dashboard. Nessun altro file contiene slug hardcoded.
 *
 * Campi:
 *  - slug        identificatore salvato in D1 (non cambiarlo dopo il primo run)
 *  - label       nome mostrato nel digest e nella dashboard
 *  - emoji       intestazione di sezione nel digest
 *  - order       ordine delle sezioni (crescente)
 *  - discard     se true, i messaggi di questa categoria non entrano mai in D1
 *  - description istruzione data a Gemini: piu' e' concreta, meno errori fa
 */
export const CATEGORIES = [
  {
    slug: 'scadenze_esami',
    label: 'Scadenze ed esami',
    emoji: '📅',
    order: 1,
    description:
      "Date di esami, appelli, prove parziali, consegne di progetti o elaborati, " +
      'apertura e chiusura delle iscrizioni, scadenze di tasse o domande.',
  },
  {
    slug: 'materiale_didattico',
    label: 'Materiale didattico',
    emoji: '📚',
    order: 2,
    description:
      'Condivisione o richiesta di slide, dispense, appunti, registrazioni, libri, ' +
      'esercitazioni, temi d\'esame passati, link a repository o drive di corso.',
  },
  {
    slug: 'comunicazioni_ufficiali',
    label: 'Comunicazioni ufficiali',
    emoji: '🏛️',
    order: 3,
    description:
      'Avvisi provenienti da segreteria, docenti, tutor o rappresentanti: ' +
      'circolari, modifiche di regolamento, pubblicazione di esiti, verbalizzazioni.',
  },
  {
    slug: 'logistica',
    label: 'Logistica',
    emoji: '📍',
    order: 4,
    description:
      'Aule, orari, spostamenti o annullamenti di lezione, cambi di docente, ' +
      'lezioni online, indicazioni pratiche su dove e quando presentarsi.',
  },
  {
    slug: 'opportunita',
    label: 'Opportunità',
    emoji: '🎯',
    order: 5,
    description:
      'Tirocini, stage, borse di studio, bandi, concorsi, eventi, seminari, ' +
      'offerte di lavoro o progetti a cui candidarsi.',
  },
  {
    slug: 'rumore',
    label: 'Rumore/Off-topic',
    emoji: '🗑️',
    order: 99,
    discard: true,
    description:
      'Tutto il resto: saluti, meme, battute, ringraziamenti, "+1", reazioni, ' +
      'chiacchiere personali, messaggi troppo vaghi per essere utili a chi non ' +
      'segue la conversazione, e qualsiasi cosa che non rientri nelle altre categorie.',
  },
];

/** Livelli di urgenza ammessi, dal meno al piu' urgente. */
export const URGENCIES = ['bassa', 'media', 'alta'];

/** Slug validi per il modello (tutti, incluso quello da scartare). */
export const CATEGORY_SLUGS = CATEGORIES.map((c) => c.slug);

/** Slug che non devono mai finire in D1 ne' nel digest. */
export const DISCARD_SLUGS = CATEGORIES.filter((c) => c.discard).map((c) => c.slug);

/** Categorie che compaiono nel digest e nella dashboard, gia' ordinate. */
export function relevantCategories() {
  return CATEGORIES.filter((c) => !c.discard).sort((a, b) => a.order - b.order);
}

/** Definizione di una categoria dato lo slug, o undefined se sconosciuto. */
export function categoryBySlug(slug) {
  return CATEGORIES.find((c) => c.slug === slug);
}

/** True se lo slug corrisponde a una categoria da scartare silenziosamente. */
export function isDiscarded(slug) {
  return DISCARD_SLUGS.includes(slug);
}
