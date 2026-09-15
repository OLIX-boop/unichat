"""Configurazione del bridge, interamente da variabili d'ambiente / file .env."""

from functools import cached_property, lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Impostazioni del bridge. Nessun valore sensibile ha un default."""

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    waha_base_url: str = "http://127.0.0.1:3000"
    waha_api_key: str
    waha_session: str = "default"

    source_chat_ids: str
    digest_chat_id: str = ""

    bridge_api_key: str

    resolve_sender_names: bool = True

    # --- Modalita' push (senza Cloudflare Tunnel) ---
    #: Endpoint /ingest del Worker. Vuoto = modalita' push disattivata.
    worker_ingest_url: str = ""
    #: Come il runner raggiunge il bridge: sempre loopback, mai dall'esterno.
    bridge_self_url: str = "http://127.0.0.1:8088"
    push_state_path: str = "./data/push_state.json"
    push_first_run_lookback_hours: int = 24
    push_timeout_seconds: float = 120.0

    cursor_db_path: str = "./data/cursor.sqlite3"
    max_messages_per_request: int = 200
    request_timeout_seconds: float = 30.0
    seen_retention_days: int = 14

    @cached_property
    def source_chats(self) -> list[tuple[str, str]]:
        """Chat da monitorare, come coppie (chat_id, etichetta).

        Formato di `SOURCE_CHAT_IDS`: elenco separato da virgole, dove ogni voce
        e' `<chat_id>` oppure `<chat_id>=<etichetta leggibile>`. L'etichetta
        viaggia fino al digest e alla dashboard, cosi' con piu' gruppi si capisce
        da quale arriva ogni elemento.
        """
        chats: list[tuple[str, str]] = []
        for raw in self.source_chat_ids.split(","):
            entry = raw.strip()
            if not entry:
                continue
            chat_id, _, label = entry.partition("=")
            chat_id = chat_id.strip()
            chats.append((chat_id, label.strip() or chat_id))
        return chats


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
