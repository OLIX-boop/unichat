# Cloudflare Tunnel per il bridge

Il bridge ascolta **solo su `127.0.0.1:8088`**. L'unico modo in cui Cloudflare lo
raggiunge e' il Tunnel: nessuna porta aperta sul router, nessun IP pubblico esposto.

## 1. Installare cloudflared sul server

```bash
curl -L -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
cloudflared --version
```

## 2. Autenticare e creare il tunnel

```bash
cloudflared tunnel login          # apre il browser, scegli il tuo dominio
cloudflared tunnel create unichat-bridge
```

Il comando `create` stampa lo **UUID del tunnel** e salva il file credenziali in
`~/.cloudflared/<UUID>.json`. Ti servono entrambi.

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/
sudo chmod 600 /etc/cloudflared/<UUID>.json
```

> Il `.json` delle credenziali e il `cert.pem` sono segreti: il `.gitignore`
> della root li esclude gia', ma non copiarli mai dentro il repo.

## 3. Assegnare l'hostname pubblico

```bash
cloudflared tunnel route dns unichat-bridge unichat-bridge.iltuodominio.tld
```

Questo crea un record CNAME `unichat-bridge.iltuodominio.tld -> <UUID>.cfargotunnel.com`.
**Quello e' l'hostname da mettere in `BRIDGE_BASE_URL` nel Worker**, con schema
`https://`.

Se non hai un dominio su Cloudflare puoi usare un *quick tunnel*
(`cloudflared tunnel --url http://127.0.0.1:8088`), ma l'hostname cambia a ogni
riavvio: va bene per una prova, non per il cron.

## 4. Config e servizio persistente

```bash
sudo cp cloudflared-config.yml /etc/cloudflared/config.yml
sudo nano /etc/cloudflared/config.yml     # metti UUID e hostname reali
cloudflared tunnel ingress validate
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

## 5. Verifica end-to-end

```bash
# dal server, direttamente sul bridge
curl http://127.0.0.1:8088/health

# da qualunque macchina, passando da Cloudflare
curl https://unichat-bridge.iltuodominio.tld/health

# /messages senza chiave deve rispondere 401
curl -i https://unichat-bridge.iltuodominio.tld/messages
```

## 6. Difesa in profondita' (consigliata)

Nella dashboard Cloudflare, sotto **Security > WAF**, puoi aggiungere una regola
che blocca tutto il traffico verso `unichat-bridge.*` che non arrivi dai Workers,
oppure un rate limit di poche richieste al minuto: il traffico legittimo e' una
manciata di chiamate all'ora.
