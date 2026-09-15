"""Runner della modalita' push: collega il bridge locale al Cloudflare Worker.

Viene eseguito da un timer systemd, non da un processo in ascolto. A ogni giro:

1. chiede al bridge i messaggi nuovi (`GET /messages`);
2. li manda al Worker (`POST /ingest`), che li categorizza, salva in D1 e
   restituisce il digest gia' composto;
3. se il digest c'e', lo fa inoltrare su WhatsApp dal bridge (`POST /send`).

Serve quando non si dispone di un dominio per il Cloudflare Tunnel: nessuna
porta viene esposta, perche' e' sempre il server ad aprire la connessione.
Questo modulo non decide nulla sul contenuto: categorie, sintesi e digest
restano di competenza del Worker.
"""

import asyncio
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any

import httpx

from .config import Settings, get_settings
from .security import API_KEY_HEADER

logger = logging.getLogger("unichat.push")


def read_cursor(path: Path, fallback_ms: int) -> int:
    """Watermark dell'ultimo invio riuscito, in epoch ms."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        value = int(data.get("cursor", 0))
        return value if value > 0 else fallback_ms
    except (OSError, ValueError, AttributeError):
        return fallback_ms


def write_cursor(path: Path, cursor_ms: int) -> None:
    """Salva il watermark solo dopo un giro andato a buon fine."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"cursor": int(cursor_ms), "updated": int(time.time() * 1000)}),
        encoding="utf-8",
    )


async def run_once(
    settings: Settings | None = None, client: httpx.AsyncClient | None = None
) -> dict[str, Any]:
    """Esegue un giro completo e restituisce un riepilogo.

    Il cursore avanza solo se il Worker ha risposto e l'eventuale digest e'
    stato inoltrato: se qualcosa si rompe a meta', il giro successivo rilegge la
    stessa finestra. I duplicati sono impossibili perche' il Worker deduplica su
    `items.message_id` prima di comporre il digest.
    """
    cfg = settings or get_settings()
    summary: dict[str, Any] = {
        "fetched": 0,
        "relevant": 0,
        "stored": 0,
        "digest_sent": False,
        "status": "ok",
        "error": None,
    }

    if not cfg.worker_ingest_url:
        summary.update(status="error", error="WORKER_INGEST_URL non configurato")
        return summary

    state_path = Path(cfg.push_state_path)
    fallback = int(time.time() * 1000) - cfg.push_first_run_lookback_hours * 3600 * 1000
    cursor = read_cursor(state_path, fallback)

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=cfg.push_timeout_seconds)
    headers = {API_KEY_HEADER: cfg.bridge_api_key}
    bridge = cfg.bridge_self_url.rstrip("/")

    try:
        response = await http.get(
            f"{bridge}/messages",
            params={"since": cursor, "limit": cfg.max_messages_per_request},
            headers=headers,
        )
        response.raise_for_status()
        payload = response.json()
        messages = payload.get("messages", [])
        summary["fetched"] = len(messages)

        if not messages:
            return summary

        ingest = await http.post(
            cfg.worker_ingest_url,
            json={"messages": messages},
            headers={**headers, "Content-Type": "application/json"},
        )
        ingest.raise_for_status()
        result = ingest.json()

        summary["relevant"] = result.get("relevant", 0)
        summary["stored"] = result.get("stored", 0)
        if result.get("status") == "partial":
            summary["status"] = "partial"
            summary["error"] = result.get("error")

        digest = result.get("digest")
        if digest:
            sent = await http.post(f"{bridge}/send", json={"text": digest}, headers=headers)
            sent.raise_for_status()
            summary["digest_sent"] = True

        new_cursor = max(
            [cursor, *(int(m.get("timestamp") or 0) for m in messages)]
        )
        write_cursor(state_path, new_cursor)
        summary["cursor"] = new_cursor

    except httpx.HTTPStatusError as exc:
        summary.update(
            status="error",
            error=f"{exc.request.url} ha risposto {exc.response.status_code}: "
            f"{exc.response.text[:200]}",
        )
    except (httpx.HTTPError, ValueError) as exc:
        summary.update(status="error", error=str(exc))
    finally:
        if owns_client:
            await http.aclose()

    return summary


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    summary = asyncio.run(run_once())
    logger.info("push: %s", json.dumps(summary, ensure_ascii=False))
    return 1 if summary["status"] == "error" else 0


if __name__ == "__main__":
    sys.exit(main())
