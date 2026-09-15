"""Autenticazione a chiave condivisa per gli endpoint del bridge."""

import secrets

from fastapi import Header, HTTPException, Request, status

API_KEY_HEADER = "X-Bridge-Key"


async def require_api_key(
    request: Request,
    x_bridge_key: str = Header(default="", alias=API_KEY_HEADER),
) -> None:
    """Blocca la richiesta se l'header X-Bridge-Key non combacia.

    Il confronto usa compare_digest per non esporre la chiave a timing attack:
    l'endpoint e' raggiungibile da internet tramite il Cloudflare Tunnel.
    """
    expected = request.app.state.settings.bridge_api_key
    if not x_bridge_key or not secrets.compare_digest(x_bridge_key, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Chiave API mancante o non valida",
        )
