"""``fib`` — the Python SDK's command-line surface.

Scope note: the npm package ``fibonacci-code`` also installs a binary called
``fib``, and that one is the full interactive coding agent. This CLI is
deliberately a *different, smaller* tool rather than a half-built imitation of
it: one-shot completions, credential inspection, and model discovery. Each of
those is genuinely useful from a shell script or a Makefile, and none of them
pretends to be the agent. The help text says so explicitly, so a user who has
both on PATH is never confused about which one answered.

Exit codes are stable and scriptable:

==== ==========================================================
0    success
2    usage error
3    authentication problem
4    network problem
5    provider returned an error
130  cancelled (Ctrl-C), matching the shell's 128+SIGINT convention
==== ==========================================================
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import datetime, timezone
from typing import List, Optional, Sequence

from ._version import __version__
from .auth import CodexAuth, codex_auth_path
from .client import CHATGPT_MODEL, Fibonacci
from .errors import AuthError, CancelledError, FibonacciError, NetworkError, ProviderError
from .models import ReasoningDelta, TextDelta

__all__ = ["main"]

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_AUTH = 3
EXIT_NETWORK = 4
EXIT_PROVIDER = 5
EXIT_CANCELLED = 130

_EFFORTS = ("low", "medium", "high", "xhigh")

_DESCRIPTION = """\
fib — one-shot completions from the Fibonacci Python SDK.

This is the SDK's CLI. For the full interactive coding agent (REPL, file
tools, approvals), install the Node package instead:

    npm i -g fibonacci-code
"""

_EPILOG = """\
examples:
  fib "explain this stack trace"        one-shot completion
  cat main.py | fib "review this"       stdin is appended to the prompt
  fib auth status                       who am I signed in as
  fib models                            what models this endpoint accepts
  fib models --base-url http://localhost:11434/v1

credentials:
  ChatGPT subscription   read through from ~/.codex/auth.json ($CODEX_HOME)
  API-key endpoints      $FIBONACCI_API_KEY, then $OPENAI_API_KEY

There is no --api-key flag on purpose: command-line arguments are visible to
every process on the machine via `ps`. Use the environment variables.
"""


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Entry point for the ``fib`` console script.

    Returns a process exit code rather than calling :func:`sys.exit`, so that
    tests can assert on it without trapping ``SystemExit``.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        return _dispatch(args)
    except KeyboardInterrupt:
        # A quiet newline, no traceback. A user who pressed Ctrl-C knows what
        # happened and does not need 30 lines of asyncio internals.
        sys.stderr.write("\n")
        return EXIT_CANCELLED
    except CancelledError:
        return EXIT_CANCELLED
    except AuthError as exc:
        return _fail(exc, EXIT_AUTH)
    except NetworkError as exc:
        return _fail(exc, EXIT_NETWORK)
    except ProviderError as exc:
        return _fail(exc, EXIT_PROVIDER)
    except FibonacciError as exc:
        return _fail(exc, EXIT_PROVIDER)


def _dispatch(args: List[str]) -> int:
    if args and args[0] in ("-V", "--version"):
        print(f"fib (fibonacci-code) {__version__}")
        return EXIT_OK
    if args and args[0] in ("-h", "--help", "help"):
        _root_parser().print_help()
        return EXIT_OK

    if not args:
        # No arguments and nothing piped in: show help rather than hanging on
        # a read() from an interactive terminal.
        if sys.stdin.isatty():
            _root_parser().print_help()
            return EXIT_OK
        return _cmd_prompt([])

    if args[0] == "auth":
        return _cmd_auth(args[1:])
    if args[0] == "models":
        return _cmd_models(args[1:])
    return _cmd_prompt(args)


# -- commands ----------------------------------------------------------------


def _cmd_prompt(args: List[str]) -> int:
    parser = argparse.ArgumentParser(prog="fib", add_help=False)
    parser.add_argument("prompt", nargs="*")
    parser.add_argument("--model")
    parser.add_argument("--base-url")
    parser.add_argument("--effort", choices=_EFFORTS, default="medium")
    parser.add_argument("--codex-home")
    parser.add_argument("--reasoning", action="store_true")
    parser.add_argument("--max-tokens", type=int)
    parsed, unknown = parser.parse_known_args(args)
    if unknown:
        sys.stderr.write(f"fib: unrecognised option: {unknown[0]}\nTry `fib --help`.\n")
        return EXIT_USAGE

    prompt = _read_prompt(parsed.prompt)
    if not prompt:
        sys.stderr.write('fib: no prompt given. Try `fib "your question"` or `fib --help`.\n')
        return EXIT_USAGE

    return asyncio.run(_stream_prompt(prompt, parsed))


async def _stream_prompt(prompt: str, parsed: argparse.Namespace) -> int:
    wrote_text = False
    ends_with_newline = False
    async with _client_for(parsed) as client:
        async for event in client.stream(
            prompt,
            reasoning_effort=parsed.effort,
            max_output_tokens=parsed.max_tokens,
        ):
            if isinstance(event, TextDelta):
                sys.stdout.write(event.text)
                sys.stdout.flush()
                wrote_text = True
                ends_with_newline = event.text.endswith("\n")
            elif isinstance(event, ReasoningDelta) and parsed.reasoning:
                # Reasoning goes to stderr so that `fib ... > out.txt` captures
                # the answer and nothing else.
                sys.stderr.write(event.text)
                sys.stderr.flush()

    if wrote_text and not ends_with_newline:
        sys.stdout.write("\n")
    return EXIT_OK


def _cmd_models(args: List[str]) -> int:
    parser = argparse.ArgumentParser(prog="fib models", add_help=False)
    parser.add_argument("--base-url")
    parser.add_argument("--codex-home")
    parsed, unknown = parser.parse_known_args(args)
    if unknown:
        sys.stderr.write(f"fib models: unrecognised option: {unknown[0]}\n")
        return EXIT_USAGE
    parsed.model = None
    parsed.effort = "medium"
    return asyncio.run(_list_models(parsed))


async def _list_models(parsed: argparse.Namespace) -> int:
    async with _client_for(parsed) as client:
        models = await client.models()
    for model in sorted(models, key=lambda m: m.id):
        if model.owned_by:
            print(f"{model.id}  ({model.owned_by})")
        else:
            print(model.id)
    return EXIT_OK


def _cmd_auth(args: List[str]) -> int:
    if not args or args[0] != "status":
        sys.stderr.write("usage: fib auth status\n")
        return EXIT_USAGE

    parser = argparse.ArgumentParser(prog="fib auth status", add_help=False)
    parser.add_argument("--codex-home")
    parsed, unknown = parser.parse_known_args(args[1:])
    if unknown:
        sys.stderr.write(f"fib auth status: unrecognised option: {unknown[0]}\n")
        return EXIT_USAGE

    auth = CodexAuth(codex_home=parsed.codex_home)
    try:
        account = auth.account()
    except AuthError:
        # No ChatGPT login. An API key in the environment is still a working
        # configuration for `--base-url`, so report that instead of failing.
        api_key_source = _env_api_key_source()
        if api_key_source is None:
            raise
        print(f"{'provider':<12} api-key")
        print(f"{'key source':<12} ${api_key_source}")
        print(
            f"{'credentials':<12} not signed in to ChatGPT ({codex_auth_path(parsed.codex_home)})"
        )
        print(f'{"hint":<12} use `fib --base-url <url> "prompt"` with this key')
        return EXIT_OK

    print(f"{'provider':<12} chatgpt (ChatGPT subscription)")
    print(f"{'account':<12} {account.email or 'unknown'}")
    print(f"{'plan':<12} {account.plan_type or 'unknown'}")
    print(f"{'account id':<12} {account.account_id or 'unknown'}")
    print(f"{'model':<12} {CHATGPT_MODEL}")
    print(f"{'credentials':<12} {account.path}")
    # Deliberately prints expiry, never the token itself.
    print(f"{'token':<12} {_describe_expiry(account.expires_at)}")
    return EXIT_OK


# -- helpers -----------------------------------------------------------------


def _client_for(parsed: argparse.Namespace) -> Fibonacci:
    """Build the client the flags describe.

    ``--base-url`` is the switch between backends: absent means the ChatGPT
    subscription, present means an OpenAI-compatible endpoint.
    """
    base_url = getattr(parsed, "base_url", None)
    if base_url:
        return Fibonacci.from_openai(base_url=base_url, model=getattr(parsed, "model", None))
    return Fibonacci.from_codex(
        model=getattr(parsed, "model", None) or CHATGPT_MODEL,
        codex_home=getattr(parsed, "codex_home", None),
        reasoning_effort=getattr(parsed, "effort", "medium"),
    )


def _read_prompt(words: Sequence[str]) -> str:
    """Combine argv words with piped stdin.

    Both together is the useful case — ``cat main.py | fib "review this"`` —
    so stdin is appended as context rather than replacing the argument.
    """
    parts: List[str] = []
    text = " ".join(words).strip()
    if text:
        parts.append(text)
    if not sys.stdin.isatty():
        piped = sys.stdin.read().strip()
        if piped:
            parts.append(piped)
    return "\n\n".join(parts)


def _env_api_key_source() -> Optional[str]:
    for name in ("FIBONACCI_API_KEY", "OPENAI_API_KEY"):
        if os.environ.get(name):
            return name
    return None


def _describe_expiry(expires_at: Optional[datetime]) -> str:
    if expires_at is None:
        return "valid (no expiry claim)"
    remaining = (expires_at - datetime.now(timezone.utc)).total_seconds()
    stamp = expires_at.strftime("%Y-%m-%d %H:%M:%S UTC")
    if remaining <= 0:
        return f"expired {stamp} — will refresh automatically on next use"
    return f"valid — expires {stamp} (in {_humanize(remaining)})"


def _humanize(seconds: float) -> str:
    minutes, _ = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    days, hours = divmod(hours, 24)
    if days:
        return f"{days}d {hours}h"
    if hours:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def _fail(exc: BaseException, code: int) -> int:
    sys.stderr.write(f"fib: {exc}\n")
    return code


def _root_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fib",
        description=_DESCRIPTION,
        epilog=_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("prompt", nargs="*", help="prompt to complete in one shot")
    parser.add_argument("--model", metavar="ID", help=f"model id (default: {CHATGPT_MODEL})")
    parser.add_argument(
        "--base-url", metavar="URL", help="OpenAI-compatible endpoint instead of the subscription"
    )
    parser.add_argument(
        "--effort", choices=_EFFORTS, default="medium", help="reasoning effort (default: medium)"
    )
    parser.add_argument("--codex-home", metavar="DIR", help="override $CODEX_HOME")
    parser.add_argument("--reasoning", action="store_true", help="stream reasoning to stderr")
    parser.add_argument("--max-tokens", type=int, metavar="N", help="cap output tokens")
    parser.add_argument("-V", "--version", action="store_true", help="print version and exit")
    return parser


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
