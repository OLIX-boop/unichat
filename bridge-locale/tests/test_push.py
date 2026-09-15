"""Test del runner push: bridge e Worker sostituiti da un trasporto HTTP finto."""

import asyncio
import json
import sys
import time
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402
from app.push import read_cursor, run_once  # noqa: E402

WORKER_URL = "https://worker.test/ingest"

#: Timestamp realistico: il cursore non torna mai indietro, quindi valori
#: simbolici tipo 5000 (cioe' il 1970) verrebbero ignorati.
TS = int(time.time() * 1000) - 3600_000


@pytest.fixture
def settings(tmp_path):
    return Settings(
        waha_base_url="http://waha.test",
        waha_api_key="waha-key",
        source_chat_ids="gruppo@g.us=Gruppo",
        bridge_api_key="chiave-bridge",
        worker_ingest_url=WORKER_URL,
        bridge_self_url="http://127.0.0.1:8088",
        push_state_path=str(tmp_path / "push_state.json"),
        cursor_db_path=str(tmp_path / "cursor.sqlite3"),
    )


def messaggio(msg_id, ts):
    return {
        "id": msg_id,
        "chat_id": "gruppo@g.us",
        "chat_name": "Gruppo",
        "sender_id": "1@lid",
        "sender_name": "Anna",
        "timestamp": ts,
        "text": "Esame il 12",
        "type": "chat",
    }


def build(handler, settings):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return asyncio.run(run_once(settings=settings, client=client))


def test_giro_completo_inoltra_il_digest(settings, tmp_path):
    chiamate = []

    def handler(request):
        chiamate.append(str(request.url))
        if request.url.path == "/messages":
            assert request.headers["X-Bridge-Key"] == "chiave-bridge"
            return httpx.Response(200, json={"messages": [messaggio("m1", TS)], "count": 1, "cursor": TS})
        if str(request.url) == WORKER_URL:
            assert json.loads(request.content)["messages"][0]["id"] == "m1"
            return httpx.Response(200, json={"relevant": 1, "stored": 1, "status": "ok", "digest": "IL DIGEST"})
        if request.url.path == "/send":
            assert json.loads(request.content)["text"] == "IL DIGEST"
            return httpx.Response(200, json={"ok": True})
        raise AssertionError(f"URL inatteso: {request.url}")

    summary = build(handler, settings)

    assert summary["status"] == "ok"
    assert summary["fetched"] == 1
    assert summary["digest_sent"] is True
    assert [c for c in chiamate if "/send" in c]
    assert read_cursor(Path(settings.push_state_path), 0) == TS


def test_senza_messaggi_non_chiama_il_worker(settings):
    chiamate = []

    def handler(request):
        chiamate.append(str(request.url))
        if request.url.path == "/messages":
            return httpx.Response(200, json={"messages": [], "count": 0, "cursor": 0})
        raise AssertionError("non doveva chiamare altro")

    summary = build(handler, settings)

    assert summary["fetched"] == 0
    assert summary["digest_sent"] is False
    assert len(chiamate) == 1


def test_niente_digest_niente_invio(settings):
    def handler(request):
        if request.url.path == "/messages":
            return httpx.Response(200, json={"messages": [messaggio("m1", TS)], "count": 1, "cursor": TS})
        if str(request.url) == WORKER_URL:
            return httpx.Response(200, json={"relevant": 0, "stored": 0, "status": "ok", "digest": None})
        raise AssertionError("non doveva inviare nulla")

    summary = build(handler, settings)

    assert summary["digest_sent"] is False
    assert summary["status"] == "ok"


def test_worker_in_errore_non_avanza_il_cursore(settings):
    def handler(request):
        if request.url.path == "/messages":
            return httpx.Response(200, json={"messages": [messaggio("m1", TS)], "count": 1, "cursor": TS})
        return httpx.Response(500, text="boom")

    summary = build(handler, settings)

    assert summary["status"] == "error"
    assert "500" in summary["error"]
    # Nessun watermark salvato: la stessa finestra verra' riletta al giro dopo.
    assert not Path(settings.push_state_path).exists()


def test_invio_fallito_non_avanza_il_cursore(settings):
    def handler(request):
        if request.url.path == "/messages":
            return httpx.Response(200, json={"messages": [messaggio("m1", TS)], "count": 1, "cursor": TS})
        if str(request.url) == WORKER_URL:
            return httpx.Response(200, json={"relevant": 1, "stored": 1, "status": "ok", "digest": "IL DIGEST"})
        return httpx.Response(502, text="waha giu")

    summary = build(handler, settings)

    assert summary["status"] == "error"
    assert summary["digest_sent"] is False
    assert not Path(settings.push_state_path).exists()


def test_riprende_dal_cursore_salvato(settings, tmp_path):
    Path(settings.push_state_path).write_text(json.dumps({"cursor": 4242}), encoding="utf-8")
    visto = {}

    def handler(request):
        if request.url.path == "/messages":
            visto["since"] = request.url.params.get("since")
            return httpx.Response(200, json={"messages": [], "count": 0, "cursor": 4242})
        raise AssertionError("non doveva chiamare altro")

    build(handler, settings)
    assert visto["since"] == "4242"


def test_senza_worker_configurato_si_ferma_subito(tmp_path):
    settings = Settings(
        waha_api_key="k",
        source_chat_ids="g@g.us",
        bridge_api_key="b",
        worker_ingest_url="",
        push_state_path=str(tmp_path / "push_state.json"),
        cursor_db_path=str(tmp_path / "cursor.sqlite3"),
    )
    summary = asyncio.run(run_once(settings=settings))
    assert summary["status"] == "error"
    assert "WORKER_INGEST_URL" in summary["error"]
