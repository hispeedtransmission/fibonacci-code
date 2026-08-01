"""Shared test helpers.

Every test in this suite runs offline. The transport is always an
``httpx.MockTransport``; nothing here opens a socket, so the suite is
deterministic in CI and on a plane.
"""

from __future__ import annotations

import base64
import json
import time
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Iterable, List, Optional, Sequence, Tuple

import httpx

ACCOUNT_ID = "0428f655-c630-48b6-9b3d-9d73b983f964"
AUTH_CLAIM = "https://api.openai.com/auth"
PROFILE_CLAIM = "https://api.openai.com/profile"


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def make_jwt(**claims: Any) -> str:
    """Build an unsigned JWT. The SDK never verifies signatures, by design."""
    header = b64url(json.dumps({"alg": "none", "typ": "JWT"}).encode())
    payload = b64url(json.dumps(claims).encode())
    return f"{header}.{payload}.not-a-real-signature"


def access_token(*, expires_in: int = 3600, email: str = "dev@example.com") -> str:
    return make_jwt(
        exp=int(time.time()) + expires_in,
        **{
            AUTH_CLAIM: {"chatgpt_account_id": ACCOUNT_ID, "chatgpt_plan_type": "pro"},
            PROFILE_CLAIM: {"email": email, "name": "Dev Example"},
        },
    )


def write_auth_json(
    home: Path,
    *,
    expires_in: int = 3600,
    refresh_token: str = "rt-original",
    extra: Optional[Dict[str, Any]] = None,
) -> Path:
    """Write a realistic ``auth.json`` into ``home`` and return its path."""
    home.mkdir(parents=True, exist_ok=True)
    record: Dict[str, Any] = {
        "OPENAI_API_KEY": None,
        "auth_mode": "chatgpt",
        "tokens": {
            "id_token": access_token(expires_in=expires_in),
            "access_token": access_token(expires_in=expires_in),
            "refresh_token": refresh_token,
            "account_id": ACCOUNT_ID,
        },
        "last_refresh": "2026-07-31T14:57:38.452955Z",
    }
    if extra:
        record.update(extra)
    path = home / "auth.json"
    path.write_text(json.dumps(record, indent=2), encoding="utf-8")
    return path


def sse_body(frames: Sequence[Tuple[str, Dict[str, Any]]]) -> bytes:
    """Encode ``(event_name, payload)`` pairs as an SSE stream."""
    out = []
    for name, payload in frames:
        out.append(f"event: {name}\ndata: {json.dumps(payload)}\n\n")
    return "".join(out).encode("utf-8")


def chat_body(chunks: Iterable[Dict[str, Any]]) -> bytes:
    """Encode Chat Completions chunks, including the ``[DONE]`` sentinel."""
    out = [f"data: {json.dumps(chunk)}\n\n" for chunk in chunks]
    out.append("data: [DONE]\n\n")
    return "".join(out).encode("utf-8")


def mock_client(
    handler: Any, *, requests: Optional[List[httpx.Request]] = None
) -> httpx.AsyncClient:
    """An ``httpx.AsyncClient`` wired to a mock transport, optionally recording."""

    def record(request: httpx.Request) -> httpx.Response:
        if requests is not None:
            requests.append(request)
        return handler(request)

    return httpx.AsyncClient(transport=httpx.MockTransport(record))


async def aiter_chunks(chunks: Sequence[bytes]) -> AsyncIterator[bytes]:
    """Turn a list of byte chunks into an async iterator."""
    for chunk in chunks:
        yield chunk
