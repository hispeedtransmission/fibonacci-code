"""Credential resolution for both backends.

The important design decision in this module is **link, don't copy**.

A ChatGPT subscription is authenticated by an OAuth refresh token stored in
``~/.codex/auth.json``. That refresh token *rotates*: every refresh returns a
new one and invalidates the old. So if this SDK copied the tokens into its own
config file and refreshed the copy, the next refresh would invalidate the token
the real Codex CLI still holds — silently breaking the user's login in a tool
they did not run and cannot easily connect to the breakage.

Therefore :class:`CodexAuth` treats ``~/.codex/auth.json`` as the single source
of truth: it re-reads the file on every request, and writes refreshed tokens
straight back into that same file — atomically, mode 0600, preserving every key
it does not understand. Two processes refreshing concurrently is safe because
the write is a rename, and the merge re-reads immediately before writing.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import os
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Union

import httpx

from .errors import AuthError, NetworkError

__all__ = [
    "ApiKeyAuth",
    "Auth",
    "CodexAccount",
    "CodexAuth",
    "codex_auth_path",
    "decode_jwt_claims",
    "is_local_base_url",
    "redact",
    "resolve_auth",
]

#: Public OAuth client id used by the Codex CLI. Not a secret — it identifies
#: the application to the authorization server and appears in every token
#: request the CLI makes.
CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token"

#: Refresh this many seconds before the access token actually expires, so a
#: request in flight cannot expire between the check and the server's clock.
REFRESH_LEEWAY_SECONDS = 300

_AUTH_CLAIM = "https://api.openai.com/auth"
_PROFILE_CLAIM = "https://api.openai.com/profile"
_ENV_API_KEYS = ("FIBONACCI_API_KEY", "OPENAI_API_KEY")
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "0.0.0.0"})

PathLike = Union[str, "os.PathLike[str]"]


def redact(secret: Optional[str]) -> str:
    """Render a secret as a short, non-reversible fingerprint.

    Used by every ``__repr__`` in this package. Tokens must never reach a log
    file, a traceback, or a bug report: this SDK's transcripts are routinely
    pasted into issues, and a leaked refresh token is a full account
    compromise. Enough characters are kept to tell two credentials apart while
    remaining useless to anyone who intercepts the output.
    """
    if not secret:
        return "<unset>"
    if len(secret) <= 8:
        return "<redacted>"
    return f"{secret[:3]}…{secret[-4:]}"


def decode_jwt_claims(token: str) -> Dict[str, Any]:
    """Decode a JWT payload **without verifying the signature**.

    This is not a security decision and must never be treated as one. The only
    use is scheduling: reading the ``exp`` claim to decide when to refresh, and
    reading the profile claims to display who is logged in. The server verifies
    the signature; a forged token here would simply be rejected upstream.

    Returns an empty mapping for anything that is not a decodable JWT, because
    a malformed token should produce a clean "please log in again" path rather
    than an exception from deep inside base64.
    """
    parts = token.split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1]
    payload += "=" * (-len(payload) % 4)
    try:
        raw = base64.urlsafe_b64decode(payload)
        claims = json.loads(raw)
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return {}
    return claims if isinstance(claims, dict) else {}


def codex_auth_path(codex_home: Optional[PathLike] = None) -> Path:
    """Locate ``auth.json``, honouring ``$CODEX_HOME`` like the Codex CLI does."""
    if codex_home is not None:
        return Path(codex_home).expanduser() / "auth.json"
    env_home = os.environ.get("CODEX_HOME")
    if env_home:
        return Path(env_home).expanduser() / "auth.json"
    return Path.home() / ".codex" / "auth.json"


def is_local_base_url(base_url: str) -> bool:
    """Report whether a base URL points at this machine.

    Local inference servers (llama.cpp, Ollama, LM Studio, vLLM) accept any
    key or none at all, so requiring one would be friction with no security
    benefit on a loopback socket.
    """
    try:
        host = httpx.URL(base_url).host
    except (httpx.InvalidURL, ValueError):
        return False
    return host in _LOCAL_HOSTS


class Auth:
    """Strategy for attaching credentials to an outgoing request.

    Subclasses implement :meth:`headers`, which is awaited immediately before
    every request rather than once at construction — a token can expire between
    two calls of a long-running agent loop, and refreshing lazily at send time
    is the only way to be correct without a background task.
    """

    #: Short identifier surfaced by ``fib auth status``.
    provider = "none"

    async def headers(self) -> Dict[str, str]:
        """Return the headers that authenticate one request."""
        raise NotImplementedError

    async def aclose(self) -> None:
        """Release anything the strategy owns. Safe to call more than once."""


class ApiKeyAuth(Auth):
    """Bearer-token auth for OpenAI-compatible endpoints.

    ``api_key`` may be ``None``: a loopback server needs no credential, and
    sending ``Authorization: Bearer None`` would be worse than sending nothing.
    """

    provider = "api-key"

    def __init__(self, api_key: Optional[str] = None) -> None:
        self.api_key = api_key

    async def headers(self) -> Dict[str, str]:
        if not self.api_key:
            return {}
        return {"Authorization": f"Bearer {self.api_key}"}

    def __repr__(self) -> str:
        return f"ApiKeyAuth(api_key={redact(self.api_key)})"


@dataclass(frozen=True)
class CodexAccount:
    """Non-secret facts about a signed-in ChatGPT account, for display."""

    account_id: Optional[str]
    email: Optional[str]
    plan_type: Optional[str]
    expires_at: Optional[datetime]
    path: Path

    @property
    def expired(self) -> bool:
        """True when the access token is past its expiry (ignoring leeway)."""
        if self.expires_at is None:
            return False
        return self.expires_at <= datetime.now(timezone.utc)


class CodexAuth(Auth):
    """ChatGPT-subscription auth backed by the Codex CLI's own credential file.

    Reads through to ``auth.json`` on every request and writes refreshed tokens
    back into it. See the module docstring for why copying instead would break
    the user's Codex CLI login.
    """

    provider = "chatgpt"

    def __init__(
        self,
        *,
        codex_home: Optional[PathLike] = None,
        auth_path: Optional[PathLike] = None,
        http: Optional[httpx.AsyncClient] = None,
        leeway_seconds: int = REFRESH_LEEWAY_SECONDS,
    ) -> None:
        self.path = Path(auth_path) if auth_path is not None else codex_auth_path(codex_home)
        self.leeway_seconds = leeway_seconds
        self._http = http
        self._owns_http = http is None
        # Created lazily inside the running loop: constructing an asyncio.Lock
        # at __init__ time binds it to whatever loop happens to exist then,
        # which on 3.9 is not necessarily the loop that later awaits it.
        self._lock: Optional[asyncio.Lock] = None

    # -- public API ----------------------------------------------------------

    async def headers(self) -> Dict[str, str]:
        """Return Authorization plus the account routing header.

        ``chatgpt-account-id`` is required by the subscription endpoint; it
        selects which of the account's workspaces the request is billed to.
        """
        record = self._read()
        token = await self._valid_access_token(record)
        account_id = self._account_id(record, token)
        headers = {"Authorization": f"Bearer {token}"}
        if account_id:
            headers["chatgpt-account-id"] = account_id
        return headers

    async def access_token(self) -> str:
        """Return a non-expired access token, refreshing first if needed."""
        return await self._valid_access_token(self._read())

    def account(self) -> CodexAccount:
        """Read non-secret account details for display.

        Does not refresh: ``fib auth status`` should report what is on disk,
        including "expired", rather than silently mutating the user's
        credential file as a side effect of an informational command.
        """
        record = self._read()
        tokens = self._tokens(record)
        claims = decode_jwt_claims(str(tokens.get("access_token") or ""))
        if not claims:
            claims = decode_jwt_claims(str(tokens.get("id_token") or ""))
        auth_claim = claims.get(_AUTH_CLAIM) or {}
        profile = claims.get(_PROFILE_CLAIM) or {}
        exp = claims.get("exp")
        return CodexAccount(
            account_id=tokens.get("account_id") or auth_claim.get("chatgpt_account_id"),
            email=profile.get("email"),
            plan_type=auth_claim.get("chatgpt_plan_type"),
            expires_at=(
                datetime.fromtimestamp(float(exp), tz=timezone.utc)
                if isinstance(exp, (int, float))
                else None
            ),
            path=self.path,
        )

    async def aclose(self) -> None:
        if self._owns_http and self._http is not None:
            await self._http.aclose()
            self._http = None

    def __repr__(self) -> str:
        return f"CodexAuth(path={str(self.path)!r})"

    # -- credential file -----------------------------------------------------

    def _read(self) -> Dict[str, Any]:
        """Load and validate ``auth.json``.

        Synchronous on purpose: the file is a couple of kilobytes on local
        disk, so a thread hop per request would cost more than the read.
        """
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            raise AuthError(
                f"No Codex credentials found at {self.path}. "
                "Sign in with `codex login`, or set CODEX_HOME if your "
                "credentials live elsewhere."
            ) from None
        except OSError as exc:
            raise AuthError(f"Could not read {self.path}: {exc}") from exc

        try:
            record = json.loads(raw)
        except ValueError as exc:
            raise AuthError(
                f"{self.path} is not valid JSON ({exc}). Re-run `codex login` to rewrite it."
            ) from exc
        if not isinstance(record, dict):
            raise AuthError(f"{self.path} should contain a JSON object, got {type(record).__name__}.")

        mode = record.get("auth_mode")
        if mode not in (None, "chatgpt"):
            raise AuthError(
                f"{self.path} is in '{mode}' mode, not 'chatgpt'. "
                "Use Fibonacci.from_openai(api_key=...) for API-key access, "
                "or run `codex login` to sign in with a ChatGPT account."
            )
        return record

    def _tokens(self, record: Mapping[str, Any]) -> Dict[str, Any]:
        tokens = record.get("tokens")
        if not isinstance(tokens, dict) or not tokens.get("access_token"):
            raise AuthError(
                f"{self.path} contains no ChatGPT access token. Run `codex login` to sign in."
            )
        return dict(tokens)

    def _account_id(self, record: Mapping[str, Any], token: str) -> Optional[str]:
        tokens = record.get("tokens")
        if isinstance(tokens, dict) and tokens.get("account_id"):
            return str(tokens["account_id"])
        claim = decode_jwt_claims(token).get(_AUTH_CLAIM) or {}
        account_id = claim.get("chatgpt_account_id")
        return str(account_id) if account_id else None

    def _persist_tokens(self, refreshed: Mapping[str, Any]) -> None:
        """Merge refreshed tokens into ``auth.json`` without losing anything.

        Re-reads immediately before writing so that concurrent writers (the
        real Codex CLI, another Fibonacci process) do not get clobbered, and
        preserves every key we do not recognise — including ``OPENAI_API_KEY``
        and any field a future Codex release adds.
        """
        try:
            record = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(record, dict):
                record = {}
        except (OSError, ValueError):
            record = {}

        tokens = dict(record.get("tokens") or {})
        # Only overwrite with values the server actually returned. A refresh
        # response that omits `refresh_token` means "keep using the old one";
        # writing None there would strand the login.
        for key in ("access_token", "id_token", "refresh_token", "account_id"):
            value = refreshed.get(key)
            if value:
                tokens[key] = value

        record["tokens"] = tokens
        record.setdefault("auth_mode", "chatgpt")
        record["last_refresh"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        _write_private_json(self.path, record)

    # -- refresh -------------------------------------------------------------

    def _expires_at(self, token: str) -> Optional[float]:
        exp = decode_jwt_claims(token).get("exp")
        return float(exp) if isinstance(exp, (int, float)) else None

    def _is_fresh(self, token: str) -> bool:
        expires_at = self._expires_at(token)
        if expires_at is None:
            # No decodable expiry: assume usable and let a 401 be the signal.
            # Refreshing on every request would rotate the token needlessly.
            return True
        return expires_at - self.leeway_seconds > time.time()

    async def _valid_access_token(self, record: Mapping[str, Any]) -> str:
        token = str(self._tokens(record)["access_token"])
        if self._is_fresh(token):
            return token

        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            # Re-read under the lock: another coroutine may have refreshed
            # while we waited, and rotating a second time would invalidate the
            # token it just wrote.
            tokens = self._tokens(self._read())
            current = str(tokens["access_token"])
            if self._is_fresh(current):
                return current
            return await self._refresh(tokens)

    async def _refresh(self, tokens: Mapping[str, Any]) -> str:
        refresh_token = tokens.get("refresh_token")
        if not refresh_token:
            raise AuthError(
                f"The access token in {self.path} has expired and there is no refresh token "
                "to renew it. Run `codex login` to sign in again."
            )

        http = self._client()
        try:
            response = await http.post(
                CODEX_TOKEN_ENDPOINT,
                json={
                    "client_id": CODEX_CLIENT_ID,
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "scope": "openid profile email",
                },
                headers={"Content-Type": "application/json"},
            )
        except httpx.HTTPError as exc:
            raise NetworkError(f"Could not reach {CODEX_TOKEN_ENDPOINT} to refresh credentials: {exc}") from exc

        if response.status_code >= 400:
            raise AuthError(
                f"auth.openai.com rejected the refresh token (HTTP {response.status_code}). "
                "Your ChatGPT session has ended — run `codex login` to sign in again."
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise AuthError(f"Token refresh returned a non-JSON response: {exc}") from exc
        if not isinstance(payload, dict) or not payload.get("access_token"):
            raise AuthError("Token refresh succeeded but returned no access token.")

        # Persist before returning. The refresh token rotates, so a crash
        # between here and the next request would otherwise strand the login
        # with a token the server has already invalidated.
        self._persist_tokens(payload)
        return str(payload["access_token"])

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))
            self._owns_http = True
        return self._http


def _write_private_json(path: Path, record: Mapping[str, Any]) -> None:
    """Write JSON atomically with owner-only permissions.

    Atomic because a half-written credential file locks the user out of both
    this SDK and the Codex CLI; 0600 because the file holds a refresh token.
    The temp file is created in the destination directory so that
    :func:`os.replace` is a same-filesystem rename, which is atomic; a temp
    file in ``/tmp`` could land on a different device and fall back to a
    non-atomic copy.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".auth-", suffix=".tmp")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(record, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        # Never leave a partial credential file behind, including on Ctrl-C.
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def resolve_auth(
    *,
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
    codex_home: Optional[PathLike] = None,
    http: Optional[httpx.AsyncClient] = None,
) -> Auth:
    """Pick the credential strategy for a backend.

    ``base_url is None`` means the ChatGPT-subscription backend, which only
    ever authenticates from ``auth.json`` — falling back to an API key there
    would send a key to an endpoint that does not accept one and produce a
    confusing 401.

    With a ``base_url`` set, the order is: explicit ``api_key``, then
    ``$FIBONACCI_API_KEY``, then ``$OPENAI_API_KEY``, then no credential at all
    if the URL is loopback.
    """
    if base_url is None:
        return CodexAuth(codex_home=codex_home, http=http)

    if api_key:
        return ApiKeyAuth(api_key)
    for name in _ENV_API_KEYS:
        value = os.environ.get(name)
        if value:
            return ApiKeyAuth(value)
    if is_local_base_url(base_url):
        return ApiKeyAuth(None)

    raise AuthError(
        f"No API key for {base_url}. Pass api_key=..., or set "
        f"{' or '.join(_ENV_API_KEYS)} in the environment."
    )
