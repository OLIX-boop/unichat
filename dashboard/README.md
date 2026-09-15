# Dashboard (Parte C)

Pagina statica che mostra lo storico salvato in D1, leggendolo dalle API del
Worker. Tre file, nessun framework, nessun build step.

| File | Ruolo |
|---|---|
| `index.html` | Struttura della pagina |
| `app.js` | Chiamate all'API, filtri, rendering |
| `styles.css` | Stile, con tema chiaro/scuro automatico |

## Funzioni

- Filtro per gruppo (compare da solo quando i gruppi monitorati sono piu' di uno)
- Filtro per categoria (l'elenco arriva da `/api/categories`, quindi segue la
  tassonomia del Worker senza doppioni da mantenere qui)
- Intervallo di date: all'apertura mostra gli ultimi 3 giorni (si cambia in `DEFAULT_RANGE_DAYS`
  dentro `app.js`); il pulsante **Azzera** toglie il filtro e mostra tutto lo storico
- Ricerca testuale su sintesi e mittente
- Ordinamento crescente/decrescente per data
- Paginazione "Carica altri" a blocchi di 50
- Messaggio originale a scomparsa (se `STORE_ORIGINAL_TEXT` e' attivo nel Worker)
- **Approfondisci**: Gemini rilegge la discussione salvata attorno al messaggio e
  spiega in poche righe cosa significa, dichiarando apertamente quando il
  contesto non basta invece di inventare
- **Verifica online**: come sopra, piu' ricerca Google. Il pulsante compare solo
  se il Worker ha `WEB_SEARCH_ENABLED=true`, perche' quella funzione richiede il
  piano a pagamento di Gemini

## Prova in locale

Serve un server HTTP qualsiasi (aprendo `index.html` con `file://` il browser
blocca le chiamate all'API):

```bash
cd dashboard
python3 -m http.server 8000
```

Apri <http://localhost:8000>, premi **Impostazioni** e incolla l'URL del Worker
(es. `https://unichat-worker.tuo-account.workers.dev`). Se hai impostato il
secret `DASHBOARD_TOKEN`, incolla anche quello. I due valori restano nel
`localStorage` del browser.

## Pubblicazione su Cloudflare Pages

### Con Wrangler

```bash
cd dashboard
npx wrangler pages project create unichat --production-branch main
```

> Da settembre 2026 Cloudflare Pages e' confluito in Workers: questo comando
> crea il progetto **e lo pubblica subito**, restituendo un indirizzo del tipo
> `https://unichat.<account>.workers.dev` invece del vecchio `*.pages.dev`.
> Per gli aggiornamenti successivi si usa `npx wrangler deploy` dalla cartella
> `dashboard/`.

### Collegando il repository GitHub

Dashboard Cloudflare → **Workers & Pages** → *Create* → *Pages* → *Connect to Git*:

| Campo | Valore |
|---|---|
| Build command | *(lasciare vuoto)* |
| Build output directory | `dashboard` |
| Framework preset | None |

Ogni push su `main` ripubblica la pagina.

## Dopo la pubblicazione

1. In `cloudflare-worker/wrangler.toml` restringi la CORS al dominio reale:

   ```toml
   ALLOWED_ORIGIN = "https://unichat.pages.dev"
   ```

2. Se vuoi il link alla dashboard in fondo a ogni digest:

   ```toml
   DASHBOARD_URL = "https://unichat.pages.dev"
   ```

3. Ridistribuisci il Worker: `npx wrangler deploy`.

## Nota sulla visibilita'

Una pagina su Pages e' pubblica. La pagina in se' non contiene dati (li chiede
al Worker), ma se non imposti `DASHBOARD_TOKEN` chiunque conosca l'URL del
Worker puo' leggere le sintesi dei messaggi del gruppo. Con `DASHBOARD_TOKEN`
impostato, il token resta comunque nel browser di chi lo digita: e' una
protezione da occhi casuali, non un sistema di autenticazione. Per qualcosa di
piu' solido si puo' mettere la pagina dietro
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/),
anch'esso incluso nel piano gratuito.

## Problemi frequenti

| Sintomo | Causa |
|---|---|
| "Il Worker ha risposto 401" | `DASHBOARD_TOKEN` impostato e token mancante o errato |
| Errore CORS in console | `ALLOWED_ORIGIN` non corrisponde al dominio della pagina |
| "Failed to fetch" | URL del Worker sbagliato, o pagina aperta con `file://` |
| Lista vuota ma il digest arriva | Il cron ha scritto su un D1 diverso da quello interrogato dal Worker |
