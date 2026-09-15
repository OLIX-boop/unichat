# Bridge locale (Parte A)

Servizio FastAPI che gira sul server accanto a WAHA e ne espone due sole
operazioni, protette da una chiave condivisa col Cloudflare Worker.

**Cosa fa:** legge i messaggi nuovi dei gruppi configurati, invia un testo gia' composto.
**Cosa NON fa (per scelta):** categorizzare, riassumere, schedulare, conservare
storico. Tutto questo vive nel Worker e in D1.

```
timer systemd ──▶ 127.0.0.1:8088 (questo servizio) ──▶ WAHA :3000 ──▶ WhatsApp
      └──────────▶ POST /ingest al Worker ──▶ risposta col digest ──┘
```

Nella modalità **push** (predefinita, senza dominio) è il server a chiamare
Cloudflare. Con un dominio si può usare la modalità **pull**, in cui è il Cron
Trigger del Worker a chiamare `GET /messages` attraverso un Cloudflare Tunnel:
gli endpoint sono gli stessi.

## Perche' WAHA

Il motore WhatsApp e' [WAHA](https://waha.devlike.pro/): API REST, autenticazione
a chiave, immagine Docker mantenuta. Usiamo il motore **NOWEB**, che parla il
protocollo di WhatsApp senza avviare un browser — su una VM piccola fa una
differenza enorme rispetto alle soluzioni basate su Chromium.

Tutto cio' che nel bridge sa di WAHA sta in un unico file, [`app/waha.py`](app/waha.py):
cambiare motore in futuro significa riscrivere quel file, e nient'altro.

## Endpoint

| Metodo | Path        | Auth            | Descrizione |
|--------|-------------|-----------------|-------------|
| GET    | `/health`   | nessuna         | Liveness check, non espone nulla |
| GET    | `/messages` | `X-Bridge-Key`  | Messaggi nuovi dei gruppi sorgente, uniti e ordinati |
| POST   | `/send`     | `X-Bridge-Key`  | Invia un testo alla chat del digest |

### `GET /messages?since=<epoch_ms>&limit=<n>`

`since` e `limit` sono opzionali: senza `since` viene usato il cursore persistito.

```json
{
  "messages": [
    {
      "id": "false_39...@g.us_3EB0...",
      "chat_id": "39...@g.us",
      "chat_name": "Informatica Milano 26/27",
      "sender_id": "39320...@c.us",
      "sender_name": "Mario Rossi",
      "timestamp": 1757700000000,
      "text": "Ricordo che l'esame di Analisi e' il 12/10",
      "type": "chat"
    }
  ],
  "count": 1,
  "cursor": 1757700000000
}
```

I messaggi conservati dallo store NOWEB arrivano **senza nome del mittente** e
con identificativi in formato LID (`255696750829750@lid`), illeggibili in un
digest: il bridge li risolve in nomi interrogando la rubrica di WAHA
(`/api/<sessione>/contacts/<id>`) e tiene il risultato in cache, cosi' la
richiesta parte una volta sola per mittente. Si disattiva con
`RESOLVE_SENDER_NAMES=false`.

I timestamp sono in **millisecondi** (WAHA li espone in secondi: la conversione
avviene qui). Il filtro temporale viene delegato a WAHA con
`filter.timestamp.gte`, e rifatto piu' finemente dal bridge perche' quel filtro
e' inclusivo.

### `POST /send`

```json
{ "text": "testo del digest", "chat_id": "opzionale@c.us" }
```

Senza `chat_id` usa `DIGEST_CHAT_ID`; se anche quello e' vuoto risolve la chat
"Messaggi a te stesso" chiedendo a WAHA l'account della sessione.

## Setup passo-passo

### 1. Prerequisiti

- Una macchina Linux sempre accesa (qui: un container LXC Debian su Proxmox)
- Python 3.11+ (testato fino a 3.14)
- Docker, per WAHA

### 2. Avviare WAHA

```bash
mkdir -p /opt/waha && cd /opt/waha
cp /opt/unichat/bridge-locale/deploy/waha-compose.yml docker-compose.yml
```

Crea il file `.env` **accanto al compose** (non e' il `.env` del bridge):

```bash
cat > /opt/waha/.env <<EOF
WAHA_API_KEY=$(openssl rand -hex 24)
WAHA_DASHBOARD_USERNAME=admin
WAHA_DASHBOARD_PASSWORD=$(openssl rand -hex 12)
EOF
chmod 600 /opt/waha/.env && cat /opt/waha/.env
```

Annota i tre valori stampati, poi avvia:

```bash
docker compose up -d && docker compose logs -f
```

### 3. Creare la sessione con lo store attivo

**Questo passaggio va fatto prima di scansionare il QR.** Il motore NOWEB, di
default, non conserva nulla: senza `store.enabled` l'endpoint che legge i
messaggi di una chat torna vuoto, e cambiare l'impostazione dopo l'accoppiamento
fa perdere lo storico.

```bash
curl -X POST http://127.0.0.1:3000/api/sessions \
  -H "X-Api-Key: LA_TUA_WAHA_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"default","start":true,"config":{"noweb":{"store":{"enabled":true,"fullSync":false}}}}'
```

`fullSync: false` tiene circa tre mesi di storico: piu' che sufficiente per un
digest orario, e molto piu' leggero di `true` (che emula un client desktop e
sincronizza fino a un anno).

### 4. Collegare WhatsApp (una volta sola)

Apri `http://<ip-della-macchina>:3000/dashboard` dal browser, entra con le
credenziali generate al passo 2, apri la sessione `default` (stato
`SCAN_QR_CODE`) e inquadra il QR con il telefono: WhatsApp → *Impostazioni* →
*Dispositivi collegati* → *Collega dispositivo*.

Verifica che la sessione sia attiva:

```bash
curl -s -H "X-Api-Key: LA_TUA_WAHA_API_KEY" http://127.0.0.1:3000/api/sessions/default/me
```

Deve rispondere con il tuo numero: `{"id":"39...@c.us","pushName":"..."}`.

> La sessione vive in `/opt/waha/waha-sessions`: e' l'unica cosa da salvare per
> non dover rifare il QR. Non finisce su git.

### 5. Installare il bridge

```bash
cd /opt/unichat/bridge-locale
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### 6. Configurare il bridge

```bash
cp .env.example .env
chmod 600 .env
.venv/bin/python -c "import secrets; print(secrets.token_hex(32))"   # BRIDGE_API_KEY
nano .env
```

Come trovare il `chatId` del gruppo:

```bash
curl -s -H "X-Api-Key: LA_TUA_WAHA_API_KEY" "http://127.0.0.1:3000/api/default/groups" | head -c 2000
```

Cerca i gruppi per nome e copia i campi `id` (finiscono in `@g.us`) in `SOURCE_CHAT_IDS`, separati da virgola e con un'etichetta dopo l'`=` per riconoscerli nel digest.
In alternativa lo trovi nella dashboard di WAHA, sezione *Chats*.

### 7. Prova manuale

```bash
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8088
```

In un'altra shell:

```bash
curl http://127.0.0.1:8088/health
curl -H "X-Bridge-Key: LA_TUA_BRIDGE_KEY" "http://127.0.0.1:8088/messages?since=0"
```

> La prima chiamata senza `since` consuma i messaggi disponibili e avanza il
> cursore. Per provare senza "bruciarli", usa `?since=<timestamp recente>`.

### 8. Servizio persistente

```bash
sudo cp deploy/unichat-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now unichat-bridge
journalctl -u unichat-bridge -f
```

Adatta `User`, `WorkingDirectory` ed `ExecStart` nel file `.service` se non usi
`/opt/unichat` e l'utente `unichat`.

### 9. Modalita push

Dopo aver fatto il deploy del Worker (vedi
[`../cloudflare-worker/README.md`](../cloudflare-worker/README.md)), aggiungi al
`.env` l'indirizzo del suo endpoint `/ingest`:

```
WORKER_INGEST_URL=https://unichat-worker.tuo-account.workers.dev/ingest
```

Prova un giro a mano, senza aspettare il timer:

```bash
sudo -u unichat .venv/bin/python -m app.push
```

Stampa un riepilogo tipo
`{"fetched": 34, "relevant": 3, "stored": 3, "digest_sent": true, "status": "ok"}`.
Se `digest_sent` e' `true`, il messaggio e' gia' arrivato su WhatsApp.

Poi attiva il timer orario:

```bash
sudo cp deploy/unichat-push.service deploy/unichat-push.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now unichat-push.timer
systemctl list-timers unichat-push.timer
```

Per vedere cosa ha fatto l'ultimo giro:

```bash
journalctl -u unichat-push.service -n 30 --no-pager
```

Il watermark sta in `data/push_state.json` e avanza **solo** a giro completato:
se il Worker o WhatsApp non rispondono, la stessa finestra viene riletta al giro
successivo, e la deduplica lato Worker impedisce digest doppi.

### 10. Tunnel (solo per la modalita pull)

Serve unicamente se hai un dominio su Cloudflare e preferisci che sia il Cron
Trigger a comandare: vedi [deploy/README-tunnel.md](deploy/README-tunnel.md).
L'hostname che ottieni li' va messo in `BRIDGE_BASE_URL` nel Worker, e in quel
caso il timer push va disattivato
(`sudo systemctl disable --now unichat-push.timer`).

## Variabili `.env`

| Variabile | Obbligatoria | Default | Note |
|---|---|---|---|
| `WAHA_BASE_URL` | no | `http://127.0.0.1:3000` | URL dell'API WAHA |
| `WAHA_API_KEY` | **si** | — | Header `X-Api-Key` verso WAHA |
| `WAHA_SESSION` | no | `default` | Nome della sessione WAHA |
| `SOURCE_CHAT_IDS` | **si** | — | Gruppi da monitorare separati da virgola, `<id>` o `<id>=<etichetta>` |
| `DIGEST_CHAT_ID` | no | vuoto | Vuoto = "Messaggi a te stesso" |
| `BRIDGE_API_KEY` | **si** | — | Chiave condivisa col Worker |
| `RESOLVE_SENDER_NAMES` | no | `true` | Risolve i mittenti LID in nomi leggibili via rubrica WAHA |
| `CURSOR_DB_PATH` | no | `./data/cursor.sqlite3` | Escluso da git |
| `MAX_MESSAGES_PER_REQUEST` | no | `200` | |
| `REQUEST_TIMEOUT_SECONDS` | no | `30` | |
| `SEEN_RETENTION_DAYS` | no | `14` | Retention degli id anti-duplicato |
| `WORKER_INGEST_URL` | solo push | vuoto | Endpoint `/ingest` del Worker; vuoto = push disattivata |
| `BRIDGE_SELF_URL` | no | `http://127.0.0.1:8088` | Come il runner raggiunge il bridge |
| `PUSH_STATE_PATH` | no | `./data/push_state.json` | Watermark della modalita' push |
| `PUSH_FIRST_RUN_LOOKBACK_HOURS` | no | `24` | Storico letto al primo giro |
| `PUSH_TIMEOUT_SECONDS` | no | `120` | Timeout verso Worker e bridge |

## Test

```bash
.venv/bin/pytest tests/ -v
```

Su Windows, per lanciarli senza installare nulla di permanente:

```powershell
py -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt; .\.venv\Scripts\pytest tests/ -v
```

34 test: endpoint del bridge (uno o piu' gruppi) con un WAHA finto, il client WAHA
vero contro un
trasporto HTTP simulato, e il runner push con bridge e Worker simulati.
Non toccano la rete ne' WhatsApp.

## Problemi frequenti

| Sintomo | Causa probabile |
|---|---|
| `502` su `/messages` | WAHA spento, URL o `X-Api-Key` sbagliati |
| `401` su tutto | `X-Bridge-Key` assente o diverso da `BRIDGE_API_KEY` |
| `WAHA ha risposto 404` | Nome sessione errato (`WAHA_SESSION`) o `SOURCE_CHAT_ID` inesistente |
| `count: 0` sempre | `SOURCE_CHAT_ID` errato, cursore gia' avanti (`?since=0` per verificare), oppure la sessione e' stata creata **senza** `store.enabled` (vedi passo 3) |
| `non e' autenticata` su `/send` | La sessione WAHA e' scaduta: rifai il QR dalla dashboard |
| Sessione persa a ogni riavvio | Manca il volume `waha-sessions` o `WHATSAPP_RESTART_ALL_SESSIONS` |
