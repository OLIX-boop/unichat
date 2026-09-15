"""Client minimale verso un'istanza WAHA (WhatsApp HTTP API) gia' in esecuzione.

Questo modulo non conosce categorie, digest o storage: traduce soltanto le
risposte di WAHA nel formato normalizzato che il Worker si aspetta. E' l'unico
punto del progetto legato a uno specifico motore WhatsApp: sostituirlo con un
altro backend significa riscrivere questo file e nient'altro.
"""

from typing import Any
from urllib.parse import quote

import httpx

from .config import Settings


class WahaError(RuntimeError):
    """Errore di comunicazione con WAHA (rete, HTTP non 2xx, payload inatteso)."""


def _to_epoch_ms(raw: Any) -> int:
    """Normalizza il timestamp in millisecondi.

    WAHA espone i timestamp in secondi; il confronto sull'ordine di grandezza
    lascia passare indenni eventuali valori gia' in millisecondi.
    """
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 0
    return value if value > 10_000_000_000 else value * 1000


def normalize_message(raw: dict[str, Any], fallback_chat_id: str) -> dict[str, Any]:
    """Riduce un messaggio WAHA ai soli campi usati a valle.

    Nei gruppi `from` e' l'id del gruppo e il mittente reale sta in
    `participant`; il nome visualizzato vive dentro `_data`, con chiavi che
    cambiano a seconda del motore (NOWEB, WEBJS, GOWS), da cui i vari fallback.
    """
    data = raw.get("_data") or {}
    if not isinstance(data, dict):
        data = {}

    chat_id = str(raw.get("from") or fallback_chat_id)
    sender_id = (
        raw.get("participant")
        or data.get("participant")
        or raw.get("author")
        or (chat_id if not chat_id.endswith("@g.us") else "")
    )
    sender_name = (
        data.get("notifyName")
        or data.get("pushName")
        or raw.get("notifyName")
        or raw.get("pushName")
        or ""
    )

    return {
        "id": str(raw.get("id") or ""),
        "chat_id": chat_id,
        "sender_id": str(sender_id or ""),
        "sender_name": str(sender_name),
        "timestamp": _to_epoch_ms(raw.get("timestamp") or raw.get("t")),
        "text": str(raw.get("body") or ""),
        "type": str(raw.get("type") or "chat"),
    }


class WahaClient:
    """Wrapper sulle poche route WAHA che servono al bridge."""

    #: Tetto di risoluzioni nome per singola chiamata, per non allungare troppo
    #: la risposta quando arriva una raffica di mittenti mai visti.
    MAX_NAME_LOOKUPS = 50

    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self._settings = settings
        self._client = client
        self._cached_self_chat_id: str | None = None
        self._contact_names: dict[str, str] = {}

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> Any:
        url = self._settings.waha_base_url.rstrip("/") + path
        try:
            response = await self._client.request(
                method,
                url,
                params=params,
                json=json,
                headers={"X-Api-Key": self._settings.waha_api_key},
                timeout=self._settings.request_timeout_seconds,
            )
        except httpx.HTTPError as exc:
            raise WahaError(f"WAHA non raggiungibile su {url}: {exc}") from exc

        if response.status_code >= 400:
            raise WahaError(
                f"WAHA ha risposto {response.status_code} su {path}: "
                f"{response.text[:200]}"
            )
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise WahaError(f"Risposta non JSON da WAHA su {path}") from exc

    async def fetch_messages(
        self, chat_id: str, limit: int, since_ms: int = 0
    ) -> list[dict[str, Any]]:
        """Scarica i messaggi del gruppo successivi a `since_ms`, normalizzati.

        Il filtro temporale viene applicato da WAHA (`filter.timestamp.gte`, in
        secondi): il bridge ne rifa' comunque uno piu' fine in millisecondi,
        perche' `gte` e' inclusivo e rischierebbe di riconsegnare il messaggio
        esattamente sul confine.
        """
        session = quote(self._settings.waha_session, safe="")
        path = f"/api/{session}/chats/{quote(chat_id, safe='')}/messages"
        params: dict[str, Any] = {
            "limit": limit,
            "downloadMedia": "false",
        }
        if since_ms > 0:
            params["filter.timestamp.gte"] = since_ms // 1000

        raw = await self._request("GET", path, params=params)
        if raw is None:
            return []
        if not isinstance(raw, list):
            raise WahaError("Formato inatteso: attesa una lista di messaggi")

        messages = [
            normalize_message(item, chat_id)
            for item in raw
            if isinstance(item, dict) and not item.get("fromMe")
        ]
        if self._settings.resolve_sender_names:
            await self._fill_sender_names(messages)
        return messages

    async def _fill_sender_names(self, messages: list[dict[str, Any]]) -> None:
        """Completa i nomi dei mittenti interrogando la rubrica di WAHA.

        I messaggi salvati nello store NOWEB arrivano senza `pushName` e con
        mittenti in formato LID (`1234@lid`), illeggibili in un digest. WAHA sa
        risolverli uno per uno: la cache in memoria evita di richiederli a ogni
        polling, e i fallimenti vengono memorizzati come stringa vuota per non
        insistere su contatti che non espongono un nome.
        """
        session = quote(self._settings.waha_session, safe="")
        unknown = {
            m["sender_id"]
            for m in messages
            if m["sender_id"] and not m["sender_name"]
        }
        for sender_id in list(unknown - self._contact_names.keys())[: self.MAX_NAME_LOOKUPS]:
            try:
                contact = await self._request(
                    "GET", f"/api/{session}/contacts/{quote(sender_id, safe='')}"
                )
            except WahaError:
                contact = None
            name = ""
            if isinstance(contact, dict):
                name = str(
                    contact.get("pushname") or contact.get("name") or ""
                ).strip()
            self._contact_names[sender_id] = name

        for message in messages:
            if not message["sender_name"]:
                message["sender_name"] = self._contact_names.get(
                    message["sender_id"], ""
                )

    async def send_text(self, chat_id: str, text: str) -> str:
        """Invia un messaggio di testo e restituisce l'id assegnato da WhatsApp."""
        result = await self._request(
            "POST",
            "/api/sendText",
            json={
                "session": self._settings.waha_session,
                "chatId": chat_id,
                "text": text,
            },
        )
        if isinstance(result, dict):
            raw_id = result.get("id")
            if isinstance(raw_id, dict):
                return str(raw_id.get("_serialized") or "")
            return str(raw_id or "")
        return ""

    async def self_chat_id(self) -> str:
        """Risolve la chat "Messaggi a te stesso" dall'account autenticato.

        Il valore viene memorizzato: non cambia finche' la sessione WAHA resta
        la stessa.
        """
        if self._cached_self_chat_id:
            return self._cached_self_chat_id

        session = quote(self._settings.waha_session, safe="")
        result = await self._request("GET", f"/api/sessions/{session}/me")
        account_id = ""
        if isinstance(result, dict):
            account_id = str(result.get("id") or "")
        if not account_id:
            raise WahaError(
                "WAHA non ha restituito l'account della sessione "
                f"'{self._settings.waha_session}': o non e' autenticata, "
                "oppure imposta DIGEST_CHAT_ID esplicitamente nel .env"
            )
        self._cached_self_chat_id = account_id
        return account_id

    async def resolve_digest_chat_id(self) -> str:
        """Destinazione del digest: quella configurata, altrimenti la self-chat."""
        configured = self._settings.digest_chat_id.strip()
        return configured or await self.self_chat_id()
