"""Tests for credential resolution, token refresh, and the link-don't-copy rule.

The refresh-token rotation tests are the important ones: getting rotation
wrong does not fail loudly, it silently invalidates the user's Codex CLI login
some time later.
"""

from __future__ import annotations

import asyncio
import json
import os
import stat
from pathlib import Path
from typing import List

import httpx
import pytest

from fibonacci.auth import (
    CODEX_CLIENT_ID,
    CODEX_TOKEN_ENDPOINT,
    ApiKeyAuth,
    CodexAuth,
    codex_auth_path,
    decode_jwt_claims,
    is_local_base_url,
    redact,
    resolve_auth,
)
from fibonacci.errors import AuthError, NetworkError

from .conftest import ACCOUNT_ID, access_token, make_jwt, mock_client, write_auth_json

# -- redaction ---------------------------------------------------------------


def test_redact_never_returns_the_secret() -> None:
    secret = "sk-proj-abcdefghijklmnopqrstuvwxyz"
    masked = redact(secret)
    assert secret not in masked
    assert masked == "sk-…wxyz"


def test_redact_handles_empty_and_short_secrets() -> None:
    assert redact(None) == "<unset>"
    assert redact("") == "<unset>"
    assert redact("short") == "<redacted>"


def test_reprs_do_not_leak_tokens(tmp_path: Path) -> None:
    key = "sk-proj-supersecretvalue"
    assert key not in repr(ApiKeyAuth(key))
    path = write_auth_json(tmp_path)
    record = json.loads(path.read_text(encoding="utf-8"))
    assert record["tokens"]["access_token"] not in repr(CodexAuth(auth_path=path))


# -- JWT decoding ------------------------------------------------------------


def test_decode_jwt_reads_claims_without_a_valid_signature() -> None:
    token = make_jwt(exp=123, email="a@b.c")
    assert decode_jwt_claims(token)["exp"] == 123


@pytest.mark.parametrize("bad", ["", "not-a-jwt", "a.b", "a.!!!!.c", "a." + "eyJ" + ".c"])
def test_decode_jwt_returns_empty_for_garbage(bad: str) -> None:
    """A malformed token must produce a clean 'please log in' path, not an
    exception from inside base64."""
    assert decode_jwt_claims(bad) == {}


# -- path resolution ---------------------------------------------------------


def test_codex_home_env_var_is_honoured(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "elsewhere"))
    assert codex_auth_path() == tmp_path / "elsewhere" / "auth.json"


def test_explicit_codex_home_beats_the_env_var(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "env"))
    assert codex_auth_path(tmp_path / "arg") == tmp_path / "arg" / "auth.json"


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("http://localhost:11434/v1", True),
        ("http://127.0.0.1:8080/v1", True),
        ("https://api.openai.com/v1", False),
        ("not a url", False),
    ],
)
def test_local_base_url_detection(url: str, expected: bool) -> None:
    assert is_local_base_url(url) is expected


# -- reading auth.json -------------------------------------------------------


async def test_headers_carry_bearer_and_account_id(tmp_path: Path) -> None:
    path = write_auth_json(tmp_path)
    auth = CodexAuth(auth_path=path)
    headers = await auth.headers()
    assert headers["Authorization"].startswith("Bearer ey")
    assert headers["chatgpt-account-id"] == ACCOUNT_ID


def test_missing_credentials_name_the_path_and_the_fix(tmp_path: Path) -> None:
    auth = CodexAuth(auth_path=tmp_path / "nope" / "auth.json")
    with pytest.raises(AuthError) as excinfo:
        auth.account()
    message = str(excinfo.value)
    assert "auth.json" in message
    assert "codex login" in message


def test_corrupt_credentials_are_reported_as_such(tmp_path: Path) -> None:
    path = tmp_path / "auth.json"
    path.write_text("{ not json", encoding="utf-8")
    with pytest.raises(AuthError, match="not valid JSON"):
        CodexAuth(auth_path=path).account()


def test_api_key_mode_credentials_are_rejected_with_a_pointer(tmp_path: Path) -> None:
    path = tmp_path / "auth.json"
    path.write_text(json.dumps({"auth_mode": "apikey", "OPENAI_API_KEY": "sk-x"}), encoding="utf-8")
    with pytest.raises(AuthError, match="from_openai"):
        CodexAuth(auth_path=path).account()


def test_account_reports_identity_without_refreshing(tmp_path: Path) -> None:
    """`fib auth status` must be read-only: an informational command should not
    rotate the user's credentials as a side effect."""
    path = write_auth_json(tmp_path, expires_in=-60)
    before = path.read_bytes()
    account = CodexAuth(auth_path=path).account()
    assert account.email == "dev@example.com"
    assert account.plan_type == "pro"
    assert account.account_id == ACCOUNT_ID
    assert account.expired is True
    assert path.read_bytes() == before


# -- refresh -----------------------------------------------------------------


async def test_fresh_token_is_used_without_contacting_the_network(tmp_path: Path) -> None:
    path = write_auth_json(tmp_path, expires_in=3600)
    requests: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("a fresh token must not trigger a refresh")

    async with mock_client(handler, requests=requests) as http:
        await CodexAuth(auth_path=path, http=http).headers()
    assert requests == []


async def test_refresh_rotates_and_persists_without_losing_unknown_keys(tmp_path: Path) -> None:
    """The core of link-don't-copy.

    The refresh token rotates, so the new one must land in the *user's* file.
    Everything we did not write must survive untouched, because a future Codex
    release may store fields this SDK has never heard of.
    """
    path = write_auth_json(
        tmp_path,
        expires_in=-60,
        refresh_token="rt-original",
        extra={"a_future_codex_field": "keep me"},
    )
    rotated_access = access_token(expires_in=3600)
    requests: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == CODEX_TOKEN_ENDPOINT
        body = json.loads(request.content)
        assert body == {
            "client_id": CODEX_CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": "rt-original",
            "scope": "openid profile email",
        }
        return httpx.Response(
            200,
            json={
                "access_token": rotated_access,
                "id_token": make_jwt(sub="user"),
                "refresh_token": "rt-rotated",
                "expires_in": 3600,
            },
        )

    async with mock_client(handler, requests=requests) as http:
        headers = await CodexAuth(auth_path=path, http=http).headers()

    assert len(requests) == 1
    assert headers["Authorization"] == f"Bearer {rotated_access}"

    record = json.loads(path.read_text(encoding="utf-8"))
    assert record["tokens"]["refresh_token"] == "rt-rotated"
    assert record["tokens"]["access_token"] == rotated_access
    assert record["tokens"]["account_id"] == ACCOUNT_ID
    assert record["a_future_codex_field"] == "keep me"
    assert "OPENAI_API_KEY" in record
    assert record["last_refresh"].endswith("Z")


async def test_refresh_response_without_a_new_refresh_token_keeps_the_old_one(
    tmp_path: Path,
) -> None:
    """Omitting `refresh_token` means 'keep using the current one'. Writing
    None there would strand the login."""
    path = write_auth_json(tmp_path, expires_in=-60, refresh_token="rt-original")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": access_token(expires_in=3600)})

    async with mock_client(handler) as http:
        await CodexAuth(auth_path=path, http=http).headers()

    record = json.loads(path.read_text(encoding="utf-8"))
    assert record["tokens"]["refresh_token"] == "rt-original"


async def test_credential_file_is_written_owner_only(tmp_path: Path) -> None:
    path = write_auth_json(tmp_path, expires_in=-60)
    path.chmod(0o644)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": access_token(expires_in=3600)})

    async with mock_client(handler) as http:
        await CodexAuth(auth_path=path, http=http).headers()

    assert stat.S_IMODE(path.stat().st_mode) == 0o600


async def test_no_temp_files_are_left_behind(tmp_path: Path) -> None:
    path = write_auth_json(tmp_path, expires_in=-60)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": access_token(expires_in=3600)})

    async with mock_client(handler) as http:
        await CodexAuth(auth_path=path, http=http).headers()

    assert sorted(os.listdir(tmp_path)) == ["auth.json"]


async def test_concurrent_callers_refresh_only_once(tmp_path: Path) -> None:
    """Without the lock, every in-flight request would rotate the token and
    all but the last would be invalidated."""
    path = write_auth_json(tmp_path, expires_in=-60)
    requests: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": access_token(expires_in=3600)})

    async with mock_client(handler, requests=requests) as http:
        auth = CodexAuth(auth_path=path, http=http)
        await asyncio.gather(auth.headers(), auth.headers(), auth.headers())

    assert len(requests) == 1


async def test_rejected_refresh_tells_the_user_to_log_in_again(tmp_path: Path) -> None:
    path = write_auth_json(tmp_path, expires_in=-60)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "invalid_grant"})

    async with mock_client(handler) as http:
        with pytest.raises(AuthError, match="codex login"):
            await CodexAuth(auth_path=path, http=http).headers()


async def test_unreachable_auth_server_is_a_network_error(tmp_path: Path) -> None:
    path = write_auth_json(tmp_path, expires_in=-60)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    async with mock_client(handler) as http:
        with pytest.raises(NetworkError):
            await CodexAuth(auth_path=path, http=http).headers()


async def test_expired_token_with_no_refresh_token_is_actionable(tmp_path: Path) -> None:
    path = tmp_path / "auth.json"
    path.write_text(
        json.dumps(
            {"auth_mode": "chatgpt", "tokens": {"access_token": access_token(expires_in=-60)}}
        ),
        encoding="utf-8",
    )
    with pytest.raises(AuthError, match="codex login"):
        await CodexAuth(auth_path=path).headers()


async def test_token_without_an_exp_claim_is_assumed_usable(tmp_path: Path) -> None:
    """Refreshing on every request would rotate the token needlessly; a 401
    from the server is the correct signal instead."""
    path = tmp_path / "auth.json"
    path.write_text(
        json.dumps({"auth_mode": "chatgpt", "tokens": {"access_token": make_jwt(sub="u")}}),
        encoding="utf-8",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("must not refresh a token with no expiry claim")

    async with mock_client(handler) as http:
        headers = await CodexAuth(auth_path=path, http=http).headers()
    assert headers["Authorization"].startswith("Bearer ")


# -- resolve_auth ------------------------------------------------------------


def test_resolve_auth_prefers_the_explicit_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-from-env")
    auth = resolve_auth(base_url="https://api.openai.com/v1", api_key="sk-explicit")
    assert isinstance(auth, ApiKeyAuth)
    assert auth.api_key == "sk-explicit"


def test_resolve_auth_prefers_fibonacci_env_over_openai(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FIBONACCI_API_KEY", "sk-fib")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-openai")
    auth = resolve_auth(base_url="https://api.openai.com/v1")
    assert isinstance(auth, ApiKeyAuth)
    assert auth.api_key == "sk-fib"


async def test_resolve_auth_allows_an_unauthenticated_local_server(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("FIBONACCI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    auth = resolve_auth(base_url="http://localhost:11434/v1")
    assert await auth.headers() == {}


def test_resolve_auth_without_a_key_names_the_env_vars(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FIBONACCI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(AuthError, match="FIBONACCI_API_KEY"):
        resolve_auth(base_url="https://api.openai.com/v1")


def test_resolve_auth_without_base_url_uses_the_subscription(tmp_path: Path) -> None:
    """An API key must never be sent to the subscription endpoint: it does not
    accept one, and the resulting 401 would be baffling."""
    auth = resolve_auth(codex_home=tmp_path)
    assert isinstance(auth, CodexAuth)
