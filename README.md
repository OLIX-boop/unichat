# UniChat

Filtra uno o piu' gruppi WhatsApp universitari rumorosi e ne ricava un digest periodico
con le sole informazioni utili — scadenze, materiale, comunicazioni ufficiali,
logistica, opportunità — così si possono silenziare senza perdere nulla.

Il digest arriva su WhatsApp (di norma nella chat "Messaggi a te stesso") e lo
storico resta consultabile da una dashboard web.

## Come funziona

```
   ┌───────────────── Server di casa (container LXC su Proxmox) ────────────────┐
   │                                                                            │
   │   Gruppi WhatsApp ──▶ WAHA :3000 (NOWEB) ──▶ bridge FastAPI :8088          │
   │                                                   │   ▲                    │
   │                          timer systemd ───────────┘   │ digest da inviare  │
   │                          (ogni ora)                   │                    │
   │                                 │                     │                    │
   └─────────────────────────────────┼─────────────────────┼────────────────────┘
                                     │ POST /ingest        │
                                     │ messaggi nuovi      │ risposta HTTP
                                     │ + X-Bridge-Key      │
   ┌─────────────────── Cloudflare ──▼─────────────────────┴────────────────────┐
   │                                                                            │
   │   Worker                                                                   │
   │     1. Gemini Flash classifica in batch (JSON vincolato da schema)          │
   │     2. scarta il "rumore", salva il resto in D1                            │
   │     3. compone il digest raggruppato e lo restituisce nella risposta        │
   │                                                                            │
   │   D1 (items · runs · state) ──▶ /api/items ──▶ Pages: dashboard            │
   └────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                        Gemini API (tier gratuito)
```

### Due modalità, stessa logica

| | **push** (predefinita) | **pull** |
|---|---|---|
| Chi chiama chi | il server chiama il Worker | il Worker chiama il server |
| Sveglia | timer systemd sul server | Cron Trigger di Cloudflare |
| Serve un dominio? | **no** | sì, per il Cloudflare Tunnel |
| Porte esposte | nessuna | nessuna (solo il Tunnel) |

Categorizzazione, tassonomia, D1, digest e dashboard stanno su Cloudflare in
entrambi i casi: cambia solo chi alza la cornetta. Il codice è lo stesso
([`src/pipeline.js`](cloudflare-worker/src/pipeline.js)), e si passa da una
modalità all'altra cambiando configurazione, senza toccare una riga.

Il confine è netto: **il bridge locale non sa nulla di categorie, digest o
storico**, è solo un proxy autenticato verso WAHA. Tutta la logica e i dati
stanno su Cloudflare. Il motore WhatsApp è isolato in un solo file
([`app/waha.py`](bridge-locale/app/waha.py)): sostituirlo non tocca nient'altro.

## Le tre parti

| Cartella | Cosa contiene | Dove gira |
|---|---|---|
| [`bridge-locale/`](bridge-locale/README.md) | FastAPI + systemd + WAHA + config del Tunnel | Il tuo server |
| [`cloudflare-worker/`](cloudflare-worker/README.md) | Cron Trigger, Gemini, D1, API | Cloudflare Workers |
| [`dashboard/`](dashboard/README.md) | Pagina statica dello storico, con approfondimenti | Cloudflare Pages |

## Prerequisiti

- Un server sempre acceso (nel mio caso un container LXC su Proxmox) con
  Python 3.11+ e Docker
- **WAHA** ([WhatsApp HTTP API](https://waha.devlike.pro/)) in esecuzione via
  Docker, motore NOWEB, con la sessione già accoppiata al telefono. Il bridge
  ne è solo un client: la configurazione pronta è in
  [`bridge-locale/deploy/waha-compose.yml`](bridge-locale/deploy/waha-compose.yml)
- Un account **Cloudflare** gratuito. Nessun dominio necessario in modalità
  push: il Worker è raggiungibile sul suo `*.workers.dev`. Un dominio serve solo
  se vuoi la modalità pull col Tunnel
- Una chiave **Gemini API** (tier gratuito, [Google AI Studio](https://aistudio.google.com/apikey))
- Node.js 21+ sulla macchina da cui fai il deploy e giri i test

## Installazione, in ordine

1. **WAHA e bridge** — [`bridge-locale/README.md`](bridge-locale/README.md):
   avvio di WAHA, accoppiamento col telefono, `.env`, servizio systemd.
2. **Worker** — [`cloudflare-worker/README.md`](cloudflare-worker/README.md):
   crea D1, applica le migrazioni, imposta i secret, `wrangler deploy`.
3. **Timer push** — [`bridge-locale/README.md`](bridge-locale/README.md#modalita-push):
   `WORKER_INGEST_URL` nel `.env` e attivazione di `unichat-push.timer`.
4. **Dashboard** — [`dashboard/README.md`](dashboard/README.md):
   pubblica su Pages e restringi `ALLOWED_ORIGIN`.

Solo se usi la modalità pull, fra il punto 1 e il 2 ci va il
[Cloudflare Tunnel](bridge-locale/deploy/README-tunnel.md).

## Categorie

Definite in un unico file,
[`cloudflare-worker/src/config/categories.js`](cloudflare-worker/src/config/categories.js):

| Categoria | Cosa ci finisce |
|---|---|
| 📅 Scadenze ed esami | Appelli, consegne, iscrizioni, tasse |
| 📚 Materiale didattico | Slide, dispense, registrazioni, temi d'esame |
| 🏛️ Comunicazioni ufficiali | Segreteria, docenti, tutor, esiti |
| 📍 Logistica | Aule, orari, lezioni spostate o annullate |
| 🎯 Opportunità | Tirocini, borse, bandi, eventi |
| 🗑️ Rumore/Off-topic | **Scartato**: non entra né in D1 né nel digest |

Prompt, schema JSON, sezioni del digest e filtri della dashboard derivano tutti
da quel file: aggiungere una categoria significa editarlo e ridistribuire il
Worker, senza migrazioni.

## Scelte di progetto

- **Segreti mai nel repo.** Il bridge legge un `.env` (escluso da git), il Worker
  usa `wrangler secret put`. Nel repo ci sono solo `.env.example` e `.dev.vars.example`.
- **Il bridge non è esposto su internet.** Ascolta su `127.0.0.1` e nella
  modalità predefinita nessuno lo raggiunge da fuori: è lui ad aprire la
  connessione verso Cloudflare. Entrambi gli endpoint richiedono comunque
  `X-Bridge-Key`, e lo stesso segreto protegge `/ingest` sul Worker.
- **Niente digest vuoti, niente notifica per messaggio.** Un solo messaggio per
  run, raggruppato per categoria, e solo se c'è almeno un elemento rilevante.
- **Più gruppi, un solo digest.** `SOURCE_CHAT_IDS` accetta un elenco di gruppi
  con etichetta (`<id>=<nome>`): i messaggi vengono uniti e ordinati per data, e
  la provenienza compare nel digest solo quando i gruppi monitorati sono più
  d'uno — con uno solo sarebbe rumore.
- **Idempotenza a due livelli.** Il cursore in D1 avanza solo a run completato e
  `items.message_id` è `UNIQUE`: un'esecuzione fallita a metà non genera né
  buchi né digest doppi.
- **Output del modello vincolato.** Gemini risponde con un `responseSchema`, e i
  verdetti con categorie inventate o riferimenti fuori range vengono scartati
  prima di toccare il database.
- **Ritmo umano.** Cron orario (non sotto i pochi minuti) e un solo messaggio
  inviato per run: è un'automazione non ufficiale su WhatsApp e va usata con
  volumi simili a quelli di una persona. Usarla resta una tua responsabilità e
  può violare i termini di servizio di WhatsApp.

## Test

```bash
cd bridge-locale && pytest tests/ -v      # WAHA finto
cd cloudflare-worker && npm test          # bridge, Gemini e D1 finti
```

Nessun test tocca la rete, WhatsApp o la quota Gemini.

## Licenza

[MIT](LICENSE).
