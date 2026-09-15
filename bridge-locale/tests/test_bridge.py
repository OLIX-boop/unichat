"""Test del bridge con WAHA completamente finto: nessuna rete, nessun WhatsApp."""

import asyncio
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402
from app.cursor import CursorStore  # noqa: E402
from app.main import create_app  # noqa: E402
from app.waha import WahaClient, WahaError, normalize_message  # noqa: E402

API_KEY = "chiave-di-test"


class FakeWaha:
    """Sostituto di WahaClient: risponde con messaggi predefiniti."""

    def __init__(self, messages=None, fail=False):
        self.messages = messages or []
        self.fail = fail
        self.sent = []
        self.calls = []

    async def fetch_messages(self, chat_id, limit, since_ms=0):
        if self.fail:
            raise WahaError("WAHA offline")
        self.calls.append({"chat_id": chat_id, "limit": limit, "since_ms": since_ms})
        return [dict(m) for m in self.messages][:limit]

    async def send_text(self, chat_id, text):
        if self.fail:
            raise WahaError("WAHA offline")
        self.sent.append((chat_id, text))
        return "true_msg_1"

    async def resolve_digest_chat_id(self):
        return "39333111222@c.us"


def make_message(msg_id, ts_ms, text="ciao", sender="Mario"):
    return {
        "id": msg_id,
        "chat_id": "gruppo@g.us",
        "sender_id": "39320@c.us",
        "sender_name": sender,
        "timestamp": ts_ms,
        "text": text,
        "type": "chat",
    }


def make_settings(tmp_path, chats="gruppo@g.us=Gruppo Uno"):
    return Settings(
        waha_base_url="http://waha.test",
        waha_api_key="waha-key",
        waha_session="default",
        source_chat_ids=chats,
        digest_chat_id="",
        bridge_api_key=API_KEY,
        cursor_db_path=str(tmp_path / "cursor.sqlite3"),
    )


@pytest.fixture
def settings(tmp_path):
    return make_settings(tmp_path)


@pytest.fixture
def client_factory(settings, tmp_path):
    stores = []

    def build(fake):
        store = CursorStore(str(tmp_path / "cursor.sqlite3"))
        stores.append(store)
        app = create_app(settings=settings, waha=fake, cursor_store=store)
        return TestClient(app)

    yield build
    for store in stores:
        store.close()


def auth():
    return {"X-Bridge-Key": API_KEY}


# --------------------------------------------------------------------------
# Endpoint del bridge
# --------------------------------------------------------------------------


def test_messages_senza_chiave_risponde_401(client_factory):
    with client_factory(FakeWaha()) as client:
        assert client.get("/messages").status_code == 401
        assert client.get("/messages", headers={"X-Bridge-Key": "sbagliata"}).status_code == 401


def test_send_senza_chiave_risponde_401(client_factory):
    fake = FakeWaha()
    with client_factory(fake) as client:
        assert client.post("/send", json={"text": "ciao"}).status_code == 401
    assert fake.sent == []


def test_health_non_richiede_autenticazione(client_factory):
    with client_factory(FakeWaha()) as client:
        assert client.get("/health").json()["status"] == "ok"


def test_messages_restituisce_i_nuovi_e_avanza_il_cursore(client_factory):
    fake = FakeWaha([make_message("a", 1000), make_message("b", 2000)])
    with client_factory(fake) as client:
        body = client.get("/messages", headers=auth()).json()
    assert [m["id"] for m in body["messages"]] == ["a", "b"]
    assert body["count"] == 2
    assert body["cursor"] == 2000


def test_messages_non_ripete_messaggi_gia_consegnati(client_factory):
    fake = FakeWaha([make_message("a", 1000), make_message("b", 2000)])
    with client_factory(fake) as client:
        client.get("/messages", headers=auth())
        fake.messages.append(make_message("c", 3000))
        second = client.get("/messages", headers=auth()).json()
    assert [m["id"] for m in second["messages"]] == ["c"]


def test_messages_rispetta_il_parametro_since(client_factory):
    fake = FakeWaha([make_message("a", 1000), make_message("b", 5000)])
    with client_factory(fake) as client:
        body = client.get("/messages?since=4000", headers=auth()).json()
    assert [m["id"] for m in body["messages"]] == ["b"]


def test_messages_propaga_il_watermark_a_waha(client_factory):
    """Il filtro temporale viene delegato a WAHA, non fatto solo a valle."""
    fake = FakeWaha([make_message("b", 5000)])
    with client_factory(fake) as client:
        client.get("/messages?since=4000", headers=auth())
    assert fake.calls[0]["since_ms"] == 4000


def test_messages_scarta_i_messaggi_senza_testo(client_factory):
    fake = FakeWaha([make_message("a", 1000, text=""), make_message("b", 2000)])
    with client_factory(fake) as client:
        body = client.get("/messages", headers=auth()).json()
    assert [m["id"] for m in body["messages"]] == ["b"]


def test_messages_propaga_l_errore_waha_come_502(client_factory):
    with client_factory(FakeWaha(fail=True)) as client:
        assert client.get("/messages", headers=auth()).status_code == 502


def test_send_usa_la_self_chat_quando_non_configurata(client_factory):
    fake = FakeWaha()
    with client_factory(fake) as client:
        body = client.post("/send", json={"text": "digest"}, headers=auth()).json()
    assert body["ok"] is True
    assert fake.sent == [("39333111222@c.us", "digest")]
    assert body["chat_id"] == "39333111222@c.us"


def test_send_accetta_un_chat_id_esplicito(client_factory):
    fake = FakeWaha()
    with client_factory(fake) as client:
        client.post(
            "/send", json={"text": "x", "chat_id": "altro@c.us"}, headers=auth()
        )
    assert fake.sent == [("altro@c.us", "x")]


def test_send_rifiuta_il_testo_vuoto(client_factory):
    with client_factory(FakeWaha()) as client:
        assert client.post("/send", json={"text": ""}, headers=auth()).status_code == 422


def test_messages_con_since_esplicito_puo_rileggere_la_stessa_finestra(client_factory):
    """Il Worker avanza il cursore solo a run riuscito: deve poter ritentare."""
    fake = FakeWaha([make_message("a", 1000), make_message("b", 2000)])
    with client_factory(fake) as client:
        first = client.get("/messages?since=0", headers=auth()).json()
        second = client.get("/messages?since=0", headers=auth()).json()
    assert [m["id"] for m in first["messages"]] == ["a", "b"]
    assert [m["id"] for m in second["messages"]] == ["a", "b"]


# --------------------------------------------------------------------------
# Piu' gruppi sorgente
# --------------------------------------------------------------------------


class MultiChatWaha(FakeWaha):
    """WAHA finto con messaggi diversi per chat, e chat che possono fallire."""

    def __init__(self, per_chat, failing=()):
        super().__init__()
        self.per_chat = per_chat
        self.failing = set(failing)

    async def fetch_messages(self, chat_id, limit, since_ms=0):
        self.calls.append({"chat_id": chat_id, "limit": limit, "since_ms": since_ms})
        if chat_id in self.failing:
            raise WahaError(f"{chat_id} non raggiungibile")
        return [dict(m) for m in self.per_chat.get(chat_id, [])][:limit]


def build_client(settings, fake, tmp_path, stores):
    store = CursorStore(str(tmp_path / "cursor.sqlite3"))
    stores.append(store)
    return TestClient(create_app(settings=settings, waha=fake, cursor_store=store))


def test_messages_unisce_piu_gruppi_e_marca_la_provenienza(tmp_path):
    stores = []
    settings = make_settings(tmp_path, "uno@g.us=Informatica,due@g.us=Elettronica")
    fake = MultiChatWaha(
        {
            "uno@g.us": [make_message("a", 3000, "esame")],
            "due@g.us": [make_message("b", 1000, "aula cambiata")],
        }
    )
    try:
        with build_client(settings, fake, tmp_path, stores) as client:
            body = client.get("/messages", headers=auth()).json()
    finally:
        for store in stores:
            store.close()

    # Uniti e riordinati per timestamp, non per gruppo.
    assert [m["id"] for m in body["messages"]] == ["b", "a"]
    assert [m["chat_name"] for m in body["messages"]] == ["Elettronica", "Informatica"]
    assert body["cursor"] == 3000


def test_messages_un_gruppo_rotto_non_ferma_gli_altri(tmp_path):
    stores = []
    settings = make_settings(tmp_path, "uno@g.us=Informatica,due@g.us=Elettronica")
    fake = MultiChatWaha(
        {"uno@g.us": [make_message("a", 3000)]}, failing={"due@g.us"}
    )
    try:
        with build_client(settings, fake, tmp_path, stores) as client:
            response = client.get("/messages", headers=auth())
    finally:
        for store in stores:
            store.close()

    assert response.status_code == 200
    assert [m["id"] for m in response.json()["messages"]] == ["a"]


def test_messages_502_solo_se_falliscono_tutti_i_gruppi(tmp_path):
    stores = []
    settings = make_settings(tmp_path, "uno@g.us=Informatica,due@g.us=Elettronica")
    fake = MultiChatWaha({}, failing={"uno@g.us", "due@g.us"})
    try:
        with build_client(settings, fake, tmp_path, stores) as client:
            response = client.get("/messages", headers=auth())
    finally:
        for store in stores:
            store.close()

    assert response.status_code == 502


def test_source_chats_accetta_voci_senza_etichetta(tmp_path):
    settings = make_settings(tmp_path, " solo@g.us , altro@g.us=Con Nome ")
    assert settings.source_chats == [
        ("solo@g.us", "solo@g.us"),
        ("altro@g.us", "Con Nome"),
    ]


# --------------------------------------------------------------------------
# Normalizzazione dei messaggi WAHA
# --------------------------------------------------------------------------


def test_normalize_message_converte_i_secondi_in_millisecondi():
    out = normalize_message(
        {
            "id": "false_123@g.us_AAA",
            "timestamp": 1_700_000_000,
            "from": "123@g.us",
            "participant": "39320@c.us",
            "fromMe": False,
            "body": "Esame il 12",
            "_data": {"notifyName": "Luca"},
        },
        "fallback@g.us",
    )
    assert out["timestamp"] == 1_700_000_000_000
    assert out["chat_id"] == "123@g.us"
    assert out["sender_id"] == "39320@c.us"
    assert out["sender_name"] == "Luca"
    assert out["text"] == "Esame il 12"


def test_normalize_message_accetta_gia_millisecondi():
    out = normalize_message({"id": "x", "timestamp": 1_700_000_000_000}, "c@g.us")
    assert out["timestamp"] == 1_700_000_000_000
    assert out["chat_id"] == "c@g.us"


def test_normalize_message_chat_diretta_usa_from_come_mittente():
    out = normalize_message(
        {"id": "x", "timestamp": 1, "from": "39320@c.us", "body": "ciao"}, "f@c.us"
    )
    assert out["sender_id"] == "39320@c.us"


# --------------------------------------------------------------------------
# Client WAHA vero, con trasporto HTTP finto
# --------------------------------------------------------------------------


def build_waha_client(handler, settings):
    transport = httpx.MockTransport(handler)
    return WahaClient(settings, httpx.AsyncClient(transport=transport))


def test_waha_client_scarica_e_filtra_i_messaggi(settings):
    captured = {}

    def handler(request):
        captured["path"] = request.url.path
        captured["params"] = dict(request.url.params)
        captured["api_key"] = request.headers.get("X-Api-Key")
        return httpx.Response(
            200,
            json=[
                {
                    "id": "m1",
                    "timestamp": 1_700_000_000,
                    "from": "gruppo@g.us",
                    "participant": "39320@c.us",
                    "fromMe": False,
                    "body": "Appello il 3/11",
                    "_data": {"notifyName": "Anna"},
                },
                {
                    "id": "m2",
                    "timestamp": 1_700_000_100,
                    "from": "gruppo@g.us",
                    "fromMe": True,
                    "body": "questo l ho scritto io",
                },
            ],
        )

    client = build_waha_client(handler, settings)
    messages = asyncio.run(client.fetch_messages("gruppo@g.us", 50, 1_699_000_000_000))

    # httpx ri-decodifica la @ perche' nel path e' un carattere lecito: quello
    # che conta e' che l'id della chat finisca in un unico segmento di path.
    assert captured["path"] == "/api/default/chats/gruppo@g.us/messages"
    assert captured["params"]["filter.timestamp.gte"] == "1699000000"
    assert captured["api_key"] == "waha-key"
    assert [m["id"] for m in messages] == ["m1"]
    assert messages[0]["sender_name"] == "Anna"


def test_waha_client_risolve_i_nomi_dei_mittenti_una_volta_sola(settings):
    """I messaggi dello store arrivano senza nome: va chiesto alla rubrica."""
    chiamate = {"messaggi": 0, "contatti": 0}

    def handler(request):
        if "/contacts/" in request.url.path:
            chiamate["contatti"] += 1
            return httpx.Response(200, json={"id": "111@lid", "pushname": "Gabi"})
        chiamate["messaggi"] += 1
        return httpx.Response(
            200,
            json=[
                {
                    "id": f"m{chiamate['messaggi']}",
                    "timestamp": 1_700_000_000,
                    "from": "gruppo@g.us",
                    "participant": "111@lid",
                    "fromMe": False,
                    "body": "ciao",
                }
            ],
        )

    client = build_waha_client(handler, settings)
    primo = asyncio.run(client.fetch_messages("gruppo@g.us", 10))
    secondo = asyncio.run(client.fetch_messages("gruppo@g.us", 10))

    assert primo[0]["sender_name"] == "Gabi"
    assert secondo[0]["sender_name"] == "Gabi"
    # Due letture di messaggi, ma una sola interrogazione della rubrica.
    assert chiamate == {"messaggi": 2, "contatti": 1}


def test_waha_client_sopravvive_a_una_rubrica_che_non_risponde(settings):
    def handler(request):
        if "/contacts/" in request.url.path:
            return httpx.Response(500, text="boom")
        return httpx.Response(
            200,
            json=[
                {
                    "id": "m1",
                    "timestamp": 1_700_000_000,
                    "from": "gruppo@g.us",
                    "participant": "111@lid",
                    "fromMe": False,
                    "body": "ciao",
                }
            ],
        )

    client = build_waha_client(handler, settings)
    messaggi = asyncio.run(client.fetch_messages("gruppo@g.us", 10))
    assert messaggi[0]["sender_name"] == ""
    assert messaggi[0]["sender_id"] == "111@lid"


def test_waha_client_invia_il_testo(settings):
    captured = {}

    def handler(request):
        import json as jsonlib

        captured["path"] = request.url.path
        captured["body"] = jsonlib.loads(request.content)
        return httpx.Response(201, json={"id": {"_serialized": "true_abc"}})

    client = build_waha_client(handler, settings)
    message_id = asyncio.run(client.send_text("io@c.us", "digest"))

    assert captured["path"] == "/api/sendText"
    assert captured["body"] == {
        "session": "default",
        "chatId": "io@c.us",
        "text": "digest",
    }
    assert message_id == "true_abc"


def test_waha_client_risolve_la_self_chat(settings):
    def handler(request):
        assert request.url.path == "/api/sessions/default/me"
        return httpx.Response(200, json={"id": "39333@c.us", "pushName": "Andrea"})

    client = build_waha_client(handler, settings)
    assert asyncio.run(client.resolve_digest_chat_id()) == "39333@c.us"


def test_waha_client_sessione_non_autenticata_alza_errore(settings):
    def handler(request):
        return httpx.Response(200, json=None)

    client = build_waha_client(handler, settings)
    with pytest.raises(WahaError, match="non e' autenticata"):
        asyncio.run(client.self_chat_id())


def test_waha_client_traduce_gli_errori_http(settings):
    def handler(request):
        return httpx.Response(401, text="Unauthorized")

    client = build_waha_client(handler, settings)
    with pytest.raises(WahaError, match="401"):
        asyncio.run(client.fetch_messages("gruppo@g.us", 10))
