"""Bridge locale UniChat: due endpoint sottili sopra una sessione WAHA esistente.

Qui non c'e' nessuna categorizzazione, nessuno scheduling e nessuno storico:
quella logica vive nel Cloudflare Worker. Questo servizio esiste solo per dare
a Cloudflare un accesso autenticato e minimale a WAHA tramite il Tunnel.
"""

import logging
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, status
from pydantic import BaseModel, Field

from .config import Settings, get_settings
from .cursor import CursorStore
from .security import require_api_key
from .waha import WahaClient, WahaError

logger = logging.getLogger("unichat.bridge")


class Message(BaseModel):
    id: str
    chat_id: str
    chat_name: str = ""
    sender_id: str = ""
    sender_name: str = ""
    timestamp: int
    text: str = ""
    type: str = "chat"


class MessagesResponse(BaseModel):
    messages: list[Message]
    count: int
    cursor: int = Field(description="Timestamp in ms da ripassare come `since`")


class SendRequest(BaseModel):
    # WhatsApp accetta messaggi ben piu' lunghi; il limite qui e' solo una
    # difesa contro invii accidentali di testi enormi.
    text: str = Field(min_length=1, max_length=16000)
    chat_id: str | None = Field(
        default=None, description="Sovrascrive la destinazione configurata"
    )


class SendResponse(BaseModel):
    ok: bool
    chat_id: str
    message_id: str = ""


def create_app(
    settings: Settings | None = None,
    waha: WahaClient | None = None,
    cursor_store: CursorStore | None = None,
) -> FastAPI:
    """Costruisce l'app FastAPI.

    I tre argomenti servono ai test per iniettare un WAHA finto e un database
    temporaneo; in produzione restano None e l'app costruisce tutto da .env.
    """

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings or get_settings()
        app.state.cursor = cursor_store or CursorStore(
            app.state.settings.cursor_db_path,
            app.state.settings.seen_retention_days,
        )
        app.state.http_client = None
        if waha is not None:
            app.state.waha = waha
        else:
            app.state.http_client = httpx.AsyncClient()
            app.state.waha = WahaClient(app.state.settings, app.state.http_client)
        try:
            yield
        finally:
            if app.state.http_client is not None:
                await app.state.http_client.aclose()
            if cursor_store is None:
                app.state.cursor.close()

    app = FastAPI(
        title="UniChat bridge",
        version="1.0.0",
        description="Proxy autenticato verso una sessione WAHA esistente.",
        lifespan=lifespan,
    )

    @app.get("/health")
    async def health() -> dict[str, str]:
        """Liveness check senza autenticazione: non espone nulla di sensibile."""
        return {"status": "ok", "service": "unichat-bridge"}

    @app.get(
        "/messages",
        response_model=MessagesResponse,
        dependencies=[Depends(require_api_key)],
    )
    async def get_messages(
        since: int | None = Query(
            default=None,
            ge=0,
            description="Epoch ms: restituisce solo i messaggi successivi. "
            "Se omesso viene usato il cursore persistito.",
        ),
        limit: int | None = Query(default=None, ge=1, le=1000),
    ) -> MessagesResponse:
        """Restituisce i messaggi nuovi dei gruppi sorgente, gia' uniti e ordinati.

        Il filtro primario e' il timestamp (`since` se fornito, altrimenti il
        cursore persistito). Il filtro sugli id gia' consegnati si applica solo
        quando `since` manca: quando il chiamante porta il proprio watermark
        (come fa il Worker, che avanza il cursore in D1 solo a run riuscito) deve
        poter rileggere una finestra rimasta a meta'.
        """
        cfg: Settings = app.state.settings
        store: CursorStore = app.state.cursor
        client: WahaClient = app.state.waha

        effective_limit = limit or cfg.max_messages_per_request
        cursor = store.get_cursor()
        threshold = since if since is not None else cursor

        raw_messages: list[dict] = []
        errors: list[str] = []
        for chat_id, label in cfg.source_chats:
            try:
                batch = await client.fetch_messages(chat_id, effective_limit, threshold)
            except WahaError as exc:
                # Un gruppo irraggiungibile non deve zittire gli altri: si
                # fallisce solo se non ne risponde nessuno.
                logger.warning("Lettura di %s fallita: %s", label, exc)
                errors.append(f"{label}: {exc}")
                continue
            for message in batch:
                message["chat_name"] = label
            raw_messages.extend(batch)

        if errors and not raw_messages and len(errors) == len(cfg.source_chats):
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY, detail=" | ".join(errors)
            )

        fresh = [m for m in raw_messages if m["timestamp"] > threshold and m["text"]]
        if since is None:
            # Senza `since` il chiamante non ha un watermark proprio: filtro per id
            # gia' consegnati. Con `since` esplicito comanda il chiamante, cosi' un
            # Worker morto a meta' run puo' rileggere la stessa finestra.
            fresh = store.filter_new(fresh)
        fresh.sort(key=lambda m: m["timestamp"])
        fresh = fresh[:effective_limit]

        store.mark_delivered(fresh)
        new_cursor = max([threshold, *(m["timestamp"] for m in fresh)])

        return MessagesResponse(
            messages=[Message(**m) for m in fresh],
            count=len(fresh),
            cursor=new_cursor,
        )

    @app.post(
        "/send", response_model=SendResponse, dependencies=[Depends(require_api_key)]
    )
    async def send(payload: SendRequest) -> SendResponse:
        """Inoltra un testo gia' composto alla chat di destinazione del digest."""
        client: WahaClient = app.state.waha
        try:
            chat_id = payload.chat_id or await client.resolve_digest_chat_id()
            message_id = await client.send_text(chat_id, payload.text)
        except WahaError as exc:
            logger.warning("Invio fallito: %s", exc)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
            ) from exc
        return SendResponse(ok=True, chat_id=chat_id, message_id=message_id)

    return app


def _build_default_app() -> Any:
    return create_app()


app = _build_default_app()
