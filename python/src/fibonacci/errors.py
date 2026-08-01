"""Exception hierarchy for the Fibonacci SDK.

The shape mirrors the TypeScript half of this project so that error handling
reads the same in both languages. Every exception carries a message written for
the person who has to fix the problem, not for the person who wrote the code:
if there is an action the caller can take, the message names it.

Callers who want to catch everything this SDK can raise should catch
:class:`FibonacciError`. Everything else is a subclass.
"""

from __future__ import annotations

from typing import Any, Optional

__all__ = [
    "AuthError",
    "CancelledError",
    "FibonacciError",
    "NetworkError",
    "ProviderError",
]


class FibonacciError(Exception):
    """Base class for every error raised by this SDK.

    Exists so that ``except FibonacciError`` is a complete boundary: no code
    path in this package raises a bare :class:`Exception` or lets a raw
    ``httpx`` error escape.
    """


class AuthError(FibonacciError):
    """Credentials are missing, malformed, expired, or refused.

    Raised before a request goes out (no usable credential could be resolved)
    and after one comes back 401. The message should always tell the caller
    which file or environment variable to fix.
    """


class ProviderError(FibonacciError):
    """The model provider returned an error response or a failed stream.

    :param status: HTTP status code, or ``None`` when the failure was reported
        inside an otherwise-200 SSE stream (``response.failed``).
    :param code: Provider-supplied machine-readable error code, when present.
    :param body: Raw response body, truncated by the caller. Useful for
        debugging unfamiliar OpenAI-compatible servers, which vary wildly in
        how they report errors.
    """

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        code: Optional[str] = None,
        body: Optional[Any] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body

    def __str__(self) -> str:
        base = super().__str__()
        if self.status is None:
            return base
        return f"[HTTP {self.status}] {base}"


class NetworkError(FibonacciError):
    """The request never produced a usable HTTP response.

    Connection refused, DNS failure, TLS failure, timeout, or a stream that
    died mid-flight. Distinguished from :class:`ProviderError` because the
    remedy is different: retry or check connectivity, rather than fix the
    request.
    """


class CancelledError(FibonacciError):
    """The operation was cancelled by the caller.

    Deliberately *not* :class:`asyncio.CancelledError`. This SDK never catches
    or swallows the asyncio one — that would break structured concurrency and
    task cancellation. This exception represents an explicit user-facing
    cancellation, such as Ctrl-C at the ``fib`` prompt, and exists so callers
    can map it to an exit code without special-casing ``BaseException``.
    """
