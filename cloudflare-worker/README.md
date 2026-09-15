# Cloudflare Worker (Parte B)

Tutta l'intelligenza del progetto: fa categorizzare i messaggi a Gemini, salva
il rilevante in D1 e compone un unico digest raggruppato. Espone anche le API di
sola lettura che alimentano la dashboard.

Funziona in due modalita', che condividono tutto tranne chi inizia la
conversazione.

**push** (predefinita, non richiede un dominio): e' il server a chiamare.

```
POST /ingest  (dal server, con X-Bridge-Key)
   │
   ├─▶ POST Gemini (batch, output JSON vincolato da schema)
   ├─▶ INSERT OR IGNORE INTO items     (il "rumore" viene scartato qui)
   ├─▶ UPDATE state.last_cursor
   └─▶ risponde { digest, relevant, stored }   il server lo inoltra su WhatsApp
```

**pull** (richiede un dominio e un Cloudflare Tunnel): comanda il Cron Trigger.

```
Cron (ogni ora)
   │
   ├─▶ GET  https://<tunnel>/messages?since=<cursore D1>
   ├─▶ POST Gemini (batch, output JSON vincolato da schema)
   ├─▶ INSERT OR IGNORE INTO items          (il "rumore" viene scartato qui)
   ├─▶ POST https://<tunnel>/send           (solo se c'e' almeno un elemento)
   └─▶ UPDATE state.last_cursor             (solo se il run arriva in fondo)
```

## Struttura

| File | Ruolo |
|---|---|
| `src/index.js` | Entrypoint: smista `scheduled`, `POST /ingest`, `/run` e le API |
| `src/pipeline.js` | Cuore comune alle due modalita': classificazione, D1, digest |
| `src/config/categories.js` | **La tassonomia.** Unico file da editare per cambiare le categorie |
| `src/bridge.js` | Client HTTP verso il bridge locale |
| `src/gemini.js` | Prompt, `responseSchema`, chiamata e parsing |
| `src/classify.js` | Batching, validazione dei verdetti, scarto del rumore |
| `src/digest.js` | Composizione del messaggio WhatsApp |
| `src/db.js` | Tutte le query D1 |
| `src/api.js` | `/api/items`, `/api/categories`, `/api/stats`, `/api/runs` |
| `migrations/0001_init.sql` | Schema D1 |

## Setup passo-passo

### 1. Prerequisiti

- Node.js 21+ (i glob di `node --test` richiedono la 21)
- Un account Cloudflare (piano gratuito)
- Una chiave Gemini da [Google AI Studio](https://aistudio.google.com/apikey)
- Il bridge gia' installato e funzionante (vedi [`../bridge-locale/`](../bridge-locale/README.md)).
  In modalita' push non serve che sia raggiungibile dall'esterno; in pull serve il Tunnel.

```bash
cd cloudflare-worker
npm install
npx wrangler login
```

### 2. Creare il database D1

```bash
npx wrangler d1 create unichat
```

Il comando stampa qualcosa come:

```
database_id = "a1b2c3d4-...."
```

Copia quell'id in `wrangler.toml`, al posto di `INCOLLA_QUI_L_ID_RESTITUITO_DA_WRANGLER_D1_CREATE`.

### 3. Applicare lo schema

```bash
npx wrangler d1 migrations apply unichat --local    # database di sviluppo
npx wrangler d1 migrations apply unichat --remote   # database di produzione
```

Verifica:

```bash
npx wrangler d1 execute unichat --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

Devi vedere `items`, `runs`, `state`.

### 4. Variabili e segreti

Le variabili non sensibili stanno in `wrangler.toml`, sotto `[vars]`. In
modalita' push vanno bene i default; `BRIDGE_BASE_URL` serve solo in pull, dove
va messo l'hostname del Tunnel.

I segreti **non vanno mai nel repo**:

```bash
npx wrangler secret put GEMINI_API_KEY     # chiave di Google AI Studio
npx wrangler secret put BRIDGE_API_KEY     # identica a BRIDGE_API_KEY nel .env del bridge
npx wrangler secret put ADMIN_TOKEN        # facoltativo: abilita GET /run
npx wrangler secret put DASHBOARD_TOKEN    # facoltativo: protegge le API in lettura
```

Per lo sviluppo locale usa invece `.dev.vars` (copiato da `.dev.vars.example`).

| Nome | Dove | Obbligatorio | Default |
|---|---|---|---|
| `BRIDGE_BASE_URL` | `[vars]` | solo pull | — |
| `GEMINI_MODEL` | `[vars]` | no | `gemini-3.6-flash` |
| `GEMINI_BATCH_SIZE` | `[vars]` | no | `40` |
| `MAX_MESSAGES_PER_RUN` | `[vars]` | no | `300` |
| `STORE_ORIGINAL_TEXT` | `[vars]` | no | `true` |
| `FIRST_RUN_LOOKBACK_HOURS` | `[vars]` | no | `24` |
| `DASHBOARD_URL` | `[vars]` | no | vuoto |
| `ALLOWED_ORIGIN` | `[vars]` | no | `*` |
| `GEMINI_API_KEY` | secret | **si** | — |
| `BRIDGE_API_KEY` | secret | **si** | — |
| `ADMIN_TOKEN` | secret | no | disattiva `/run` |
| `DASHBOARD_TOKEN` | secret | no | API pubbliche in lettura |

### 5. Deploy

```bash
npx wrangler deploy
```

In `wrangler.toml` il blocco `[triggers]` e' **commentato**: in modalita' push la
sveglia sta sul server, e un cron attivo senza Tunnel produrrebbe solo run in
errore ogni ora. Togli il commento solo se passi alla modalita' pull.

L'URL del Worker stampato dal deploy (`https://unichat-worker.<account>.workers.dev`)
e' quello da mettere in `WORKER_INGEST_URL` nel `.env` del bridge, con `/ingest`
in fondo.

### 6. Primo collaudo

In **modalita' push** il collaudo si fa dal server, lanciando un giro a mano
(vedi [`../bridge-locale/README.md`](../bridge-locale/README.md#9-modalita-push)):

```bash
sudo -u unichat /opt/unichat/bridge-locale/.venv/bin/python -m app.push
```

In **modalita' pull**, invece, si chiede al Worker di eseguire subito la pipeline:

```bash
curl "https://unichat-worker.<tuo-account>.workers.dev/run?token=IL_TUO_ADMIN_TOKEN"
```

Risposta tipica:

```json
{
  "run_id": "3f2a...",
  "fetched": 41,
  "relevant": 6,
  "stored": 6,
  "digest_sent": true,
  "status": "ok",
  "by_category": { "scadenze_esami": 2, "logistica": 4 }
}
```

Log in tempo reale:

```bash
npx wrangler tail
```

## API di lettura

| Endpoint | Parametri | Descrizione |
|---|---|---|
| `GET /api/items` | `category`, `chat`, `from`, `to` (epoch ms), `q`, `order`, `limit`, `offset` | Storico filtrato |
| `GET /api/categories` | — | Tassonomia corrente |
| `GET /api/stats` | — | Totali, conteggi per categoria, ultimo run |
| `GET /api/runs` | `limit` | Ultime esecuzioni del cron |
| `GET /health` | — | Stato del Worker |
| `GET /run` | `token` | Esecuzione manuale della pipeline in modalita' pull |
| `POST /ingest` | header `X-Bridge-Key` | Modalita' push: riceve i messaggi, risponde col digest |

Se `DASHBOARD_TOKEN` e' impostato, ogni chiamata `/api/*` deve includere
l'header `X-Dashboard-Token` (o `?token=`).

## Modificare la tassonomia

Edita solo `src/config/categories.js`: enum dello schema Gemini, prompt, ordine
delle sezioni del digest e filtri della dashboard derivano da li'.

- **Non cambiare** lo `slug` di una categoria gia' usata: le righe in D1 restano
  legate al vecchio valore (in quel caso fai una `UPDATE items SET category=...`).
- Aggiungere una categoria richiede solo il deploy del Worker, nessuna migrazione.

## Test

```bash
npm test
```

37 test: logica pura (composizione del digest, validazione dei verdetti, scarto
del rumore) e flusso completo in entrambe le modalita', con bridge, Gemini e D1
finti. Nessuna chiamata di rete, nessun consumo di quota.

## Consumi e limiti del piano gratuito

Con un cron orario e un gruppo da qualche centinaio di messaggi al giorno:

- **Workers**: 24 invocazioni cron/giorno, su 100.000 richieste/giorno incluse.
- **Gemini Flash**: 1-2 chiamate per run con `GEMINI_BATCH_SIZE=40`, cioe' poche
  decine al giorno, ben dentro il tier gratuito.
- **D1**: qualche migliaio di righe l'anno, contro 5 GB inclusi.

`MAX_MESSAGES_PER_RUN` limita i danni in caso di ondata anomala di messaggi.

## Problemi frequenti

| Sintomo | Dove guardare |
|---|---|
| `status: "error"`, `Bridge non raggiungibile` | Tunnel giu', `BRIDGE_BASE_URL` sbagliato |
| `Bridge ha risposto 401` | `BRIDGE_API_KEY` diversa fra Worker e `.env` del bridge |
| `status: "partial"` | Gemini ha rifiutato un batch: `npx wrangler tail` per il dettaglio. Il cursore avanza comunque, quindi i messaggi di quel batch non vengono rielaborati: e' una scelta per non ripetere all'infinito un batch che continua a fallire bruciando quota |
| `Gemini 429` | Quota gratuita esaurita: alza l'intervallo del cron o abbassa il batch |
| Digest mai inviato ma `relevant > 0` | Guarda `runs.error`; probabile errore su `POST /send` |
| Digest doppio | Non dovrebbe accadere: la deduplica e' su `items.message_id`; controlla di non avere due Worker deployati sullo stesso D1 |
