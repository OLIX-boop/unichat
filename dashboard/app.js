/**
 * Dashboard UniChat: pagina statica che legge le API del Worker.
 * Niente framework, niente build step: si pubblica su Pages cosi' com'e'.
 */

// Valore iniziale dell'URL del Worker. Lasciandolo vuoto lo si imposta dalla
// pagina (pannello Impostazioni) e resta salvato in localStorage.
const DEFAULT_API_BASE = '';

const PAGE_SIZE = 50;

// All'apertura la pagina mostra solo gli ultimi giorni: aprendola dal telefono
// interessa quasi sempre cio' che non si e' ancora letto. "Azzera" toglie il
// filtro e riporta l'intero storico.
const DEFAULT_RANGE_DAYS = 3;

const state = {
  apiBase: localStorage.getItem('unichat.apiBase') || DEFAULT_API_BASE,
  token: localStorage.getItem('unichat.token') || '',
  categories: {},
  features: { web_search: false },
  offset: 0,
  total: 0,
  loading: false,
};

const $ = (id) => document.getElementById(id);
const els = {
  settings: $('settings'),
  apiBase: $('api-base'),
  apiToken: $('api-token'),
  results: $('results'),
  stats: $('stats'),
  category: $('category'),
  chat: $('chat'),
  search: $('search'),
  from: $('from'),
  to: $('to'),
  sort: $('sort'),
  count: $('count'),
  more: $('more'),
};

/** Chiamata GET alle API del Worker, con token se configurato. */
async function api(path, params = {}) {
  if (!state.apiBase) throw new Error('Configura prima l’URL del Worker.');
  const url = new URL(path, state.apiBase);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== '' && v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  const response = await fetch(url, {
    headers: state.token ? { 'X-Dashboard-Token': state.token } : {},
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Il Worker ha risposto ${response.status}. ${detail.slice(0, 140)}`);
  }
  return response.json();
}

/** Chiamata POST alle API del Worker (solo /api/explain, per ora). */
async function apiPost(path, body) {
  if (!state.apiBase) throw new Error('Configura prima l’URL del Worker.');
  const response = await fetch(new URL(path, state.apiBase), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { 'X-Dashboard-Token': state.token } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Il Worker ha risposto ${response.status}.`);
  return data;
}

const dateFmt = new Intl.DateTimeFormat('it-IT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Data di N giorni fa nel formato accettato da <input type="date">. */
function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

/** Filtri correnti tradotti nei parametri accettati dall'API. */
function currentFilters() {
  const toEndOfDay = (value) => (value ? new Date(`${value}T23:59:59`).getTime() : '');
  const toStartOfDay = (value) => (value ? new Date(`${value}T00:00:00`).getTime() : '');
  return {
    category: els.category.value,
    chat: els.chat.value,
    q: els.search.value.trim(),
    from: toStartOfDay(els.from.value),
    to: toEndOfDay(els.to.value),
    order: els.sort.value,
  };
}

function renderItem(item) {
  const cat = state.categories[item.category];
  const label = cat ? `${cat.emoji} ${cat.label}` : item.category;
  const original = item.original_text
    ? `<details><summary>Messaggio originale</summary><pre>${escapeHtml(item.original_text)}</pre></details>`
    : '';
  return `
    <article class="item" data-urgency="${escapeHtml(item.urgency)}">
      <div class="item-head">
        <span class="item-category">${escapeHtml(label)}</span>
        <span>urgenza ${escapeHtml(item.urgency)}</span>
        <span>${escapeHtml(item.sender_name || 'anonimo')}</span>
        ${item.chat_name ? `<span>${escapeHtml(item.chat_name)}</span>` : ''}
        <span>${dateFmt.format(new Date(item.original_ts))}</span>
      </div>
      <p class="item-summary">${escapeHtml(item.summary)}</p>
      ${original}
      <div class="item-actions">
        <button class="ghost small" data-explain="chat" data-id="${item.id}">Approfondisci</button>
        ${state.features.web_search
          ? `<button class="ghost small" data-explain="web" data-id="${item.id}">Verifica online</button>`
          : ''}
      </div>
      <div class="explain" id="explain-${item.id}" hidden></div>
    </article>`;
}

function renderError(message) {
  els.results.innerHTML = `<p class="error">${escapeHtml(message)}</p>`;
  els.count.textContent = '';
  els.more.hidden = true;
}

async function loadStats() {
  try {
    const stats = await api('/api/stats');
    state.features = stats.features || { web_search: false };
    const chips = [`<span class="chip">${stats.total} elementi in archivio</span>`];
    if (stats.last_item_ts) {
      chips.push(
        `<span class="chip">ultimo: ${dateFmt.format(new Date(stats.last_item_ts))}</span>`,
      );
    }
    for (const row of stats.by_category || []) {
      const cat = state.categories[row.category];
      chips.push(
        `<span class="chip">${escapeHtml(cat ? cat.emoji + ' ' + cat.label : row.category)}: ${row.n}</span>`,
      );
    }
    if (stats.last_run) {
      chips.push(`<span class="chip">ultimo run: ${escapeHtml(stats.last_run.status)}</span>`);
    }
    els.stats.innerHTML = chips.join('');
    populateChatFilter(stats.by_chat || []);
  } catch (err) {
    els.stats.innerHTML = `<span class="chip">statistiche non disponibili</span>`;
  }
}

/** Il filtro per gruppo compare solo se i gruppi monitorati sono piu' di uno. */
function populateChatFilter(rows) {
  if (rows.length < 2) {
    els.chat.hidden = true;
    return;
  }
  const selected = els.chat.value;
  els.chat.innerHTML = '<option value="">Tutti i gruppi</option>';
  for (const row of rows) {
    const option = document.createElement('option');
    option.value = row.chat_id;
    option.textContent = `${row.chat_name || row.chat_id} (${row.n})`;
    els.chat.append(option);
  }
  els.chat.value = selected;
  els.chat.hidden = false;
}

async function loadCategories() {
  const data = await api('/api/categories');
  state.categories = {};
  els.category.innerHTML = '<option value="">Tutte le categorie</option>';
  for (const cat of data.categories) {
    state.categories[cat.slug] = cat;
    const option = document.createElement('option');
    option.value = cat.slug;
    option.textContent = `${cat.emoji} ${cat.label}`;
    els.category.append(option);
  }
}

async function loadItems({ append = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (!append) {
    state.offset = 0;
    els.results.innerHTML = '<p class="empty">Caricamento…</p>';
  }

  try {
    const data = await api('/api/items', {
      ...currentFilters(),
      limit: PAGE_SIZE,
      offset: state.offset,
    });
    state.total = data.total;
    const html = data.items.map(renderItem).join('');

    if (!append) {
      const vuoto = els.from.value
        ? '<p class="empty">Nessun elemento in questo periodo.<br>Premi <strong>Azzera</strong> per vedere tutto lo storico.</p>'
        : '<p class="empty">Nessun elemento con questi filtri.</p>';
      els.results.innerHTML = html || vuoto;
    } else {
      els.results.insertAdjacentHTML('beforeend', html);
    }

    state.offset += data.items.length;
    els.count.textContent = state.total
      ? `${state.offset} di ${state.total} elementi`
      : '';
    els.more.hidden = state.offset >= state.total;
  } catch (err) {
    renderError(err.message);
  } finally {
    state.loading = false;
  }
}

/**
 * Chiede l'approfondimento di un elemento e lo mostra sotto di esso.
 * `chat` usa solo i messaggi del gruppo, `web` aggiunge la ricerca online.
 */
async function explain(itemId, mode, button) {
  const box = document.getElementById(`explain-${itemId}`);
  if (!box) return;

  box.hidden = false;
  box.innerHTML = `<p class="explain-loading">${
    mode === 'web' ? 'Cerco online e confronto coi messaggi…' : 'Rileggo la discussione…'
  }</p>`;
  button.disabled = true;

  try {
    const data = await apiPost('/api/explain', { item_id: Number(itemId), mode });
    const fonti = (data.sources || []).length
      ? `<ul class="explain-sources">${data.sources
          .map((s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a></li>`)
          .join('')}</ul>`
      : '';
    const etichetta = mode === 'web' ? 'Con ricerca online' : 'Dai messaggi del gruppo';
    const quando = data.cached ? ' · già calcolato' : '';
    box.innerHTML = `
      <p class="explain-label">${etichetta}${quando}</p>
      <p class="explain-text">${escapeHtml(data.text).replace(/\n/g, '<br>')}</p>
      ${fonti}`;
  } catch (err) {
    box.innerHTML = `<p class="explain-error">${escapeHtml(err.message)}</p>`;
  } finally {
    button.disabled = false;
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function wireEvents() {
  $('toggle-settings').addEventListener('click', () => {
    els.settings.hidden = !els.settings.hidden;
  });

  $('save-settings').addEventListener('click', () => {
    state.apiBase = els.apiBase.value.trim().replace(/\/+$/, '');
    state.token = els.apiToken.value.trim();
    localStorage.setItem('unichat.apiBase', state.apiBase);
    localStorage.setItem('unichat.token', state.token);
    els.settings.hidden = true;
    init();
  });

  els.search.addEventListener('input', debounce(() => loadItems(), 300));
  [els.category, els.chat, els.from, els.to, els.sort].forEach((el) =>
    el.addEventListener('change', () => loadItems()),
  );

  $('reset').addEventListener('click', () => {
    els.search.value = '';
    els.category.value = '';
    els.chat.value = '';
    els.from.value = '';
    els.to.value = '';
    els.sort.value = 'desc';
    loadItems();
  });

  els.more.addEventListener('click', () => loadItems({ append: true }));

  // Delega: i pulsanti nascono e muoiono a ogni rendering della lista.
  els.results.addEventListener('click', (event) => {
    const button = event.target.closest('[data-explain]');
    if (button) explain(button.dataset.id, button.dataset.explain, button);
  });
}

async function init() {
  els.apiBase.value = state.apiBase;
  els.apiToken.value = state.token;
  if (!els.from.value) els.from.value = isoDaysAgo(DEFAULT_RANGE_DAYS);

  if (!state.apiBase) {
    els.settings.hidden = false;
    renderError('Imposta l’URL del Worker per vedere lo storico.');
    return;
  }
  try {
    await loadCategories();
  } catch (err) {
    renderError(err.message);
    return;
  }
  // Le statistiche vanno lette prima della lista: dicono quali funzioni sono
  // disponibili, e da quelle dipendono i pulsanti disegnati su ogni elemento.
  await loadStats();
  await loadItems();
}

wireEvents();
init();
