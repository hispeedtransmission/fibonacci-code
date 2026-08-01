"""Fibonacci — a typed async Python SDK for ChatGPT/Codex subscriptions and
any OpenAI-compatible endpoint.

Two ways in::

    from fibonacci import Fibonacci

    # Reuse the ChatGPT subscription the Codex CLI is already signed in to.
    async with Fibonacci.from_codex() as fib:
        print(await fib.complete("Explain tail call optimisation briefly."))

    # Or any OpenAI-compatible server, hosted or local.
    async with Fibonacci.from_openai(
        base_url="http://localhost:11434/v1", model="qwen3:8b"
    ) as fib:
        async for event in fib.stream("Write a haiku about pointers."):
            ...

The public surface is deliberately small: one client class, a handful of
dataclasses, and an exception hierarchy. Everything else is an implementation
detail and may change without a major version bump.
"""

from __future__ import annotations

from ._version import __version__
from .auth import (
    ApiKeyAuth,
    Auth,
    CodexAccount,
    CodexAuth,
    codex_auth_path,
    redact,
    resolve_auth,
)
from .client import (
    CHATGPT_MODEL,
    DEFAULT_OPENAI_BASE_URL,
    Fibonacci,
)
from .errors import (
    AuthError,
    CancelledError,
    FibonacciError,
    NetworkError,
    ProviderError,
)
from .models import (
    Completed,
    Message,
    ModelInfo,
    ReasoningDelta,
    ReasoningItem,
    ResponseStarted,
    StreamEvent,
    StreamEventT,
    TextDelta,
    Tool,
    ToolCall,
    ToolCallEvent,
    ToolResult,
    Usage,
)
from .sse import SSEEvent, iter_sse

__all__ = [
    "CHATGPT_MODEL",
    "DEFAULT_OPENAI_BASE_URL",
    "ApiKeyAuth",
    "Auth",
    "AuthError",
    "CancelledError",
    "CodexAccount",
    "CodexAuth",
    "Completed",
    "Fibonacci",
    "FibonacciError",
    "Message",
    "ModelInfo",
    "NetworkError",
    "ProviderError",
    "ReasoningDelta",
    "ReasoningItem",
    "ResponseStarted",
    "SSEEvent",
    "StreamEvent",
    "StreamEventT",
    "TextDelta",
    "Tool",
    "ToolCall",
    "ToolCallEvent",
    "ToolResult",
    "Usage",
    "__version__",
    "codex_auth_path",
    "iter_sse",
    "redact",
    "resolve_auth",
]
