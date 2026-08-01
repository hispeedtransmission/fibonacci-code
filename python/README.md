# fibonacci-code (Python SDK)

A typed, async Python SDK for talking to a model — through the **ChatGPT/Codex
subscription you already pay for**, or through **any OpenAI-compatible
endpoint** (api.openai.com, a proxy, llama.cpp, Ollama, vLLM, LM Studio).

```bash
pip install fibonacci-code
```

One runtime dependency (`httpx`). Python 3.9+. Ships type hints (PEP 561).

> This is the Python SDK. For the full interactive terminal coding agent —
> REPL, file tools, approvals — install the Node package:
> `npm i -g fibonacci-code`.

---

## Quick start

### Use your ChatGPT subscription

If you have signed in with the Codex CLI (`codex login`), you are already set
up. Nothing to configure, no API key.

```python
import asyncio
from fibonacci import Fibonacci

async def main():
    async with Fibonacci.from_codex() as fib:
        print(await fib.complete("Explain tail call optimisation in two sentences."))

asyncio.run(main())
```

### Use any OpenAI-compatible endpoint

```python
async with Fibonacci.from_openai(
    base_url="http://localhost:11434/v1",   # Ollama, llama.cpp, vLLM, LM Studio…
    model="qwen3:8b",
) as fib:
    async for event in fib.stream("Write a haiku about pointers."):
        ...
```

A hosted endpoint reads its key from `$FIBONACCI_API_KEY`, then
`$OPENAI_API_KEY`. A `localhost` base URL needs no key at all.

---

## Streaming

`stream()` is an async iterator of typed events. It always ends with exactly
one `Completed`, even if the connection drops without a terminal frame.

```python
from fibonacci import Completed, ReasoningDelta, TextDelta, ToolCallEvent

async for event in fib.stream("Refactor this function", reasoning_effort="high"):
    if isinstance(event, TextDelta):
        print(event.text, end="", flush=True)
    elif isinstance(event, ReasoningDelta):
        ...                       # the model thinking out loud
    elif isinstance(event, ToolCallEvent):
        ...                       # event.call is a complete ToolCall
    elif isinstance(event, Completed):
        print(f"\n[{event.usage.total_tokens} tokens]")
```

| Event | Meaning |
| --- | --- |
| `ResponseStarted` | The provider accepted the request. |
| `TextDelta` | A fragment of assistant-visible output. |
| `ReasoningDelta` | A fragment of reasoning summary. |
| `ToolCallEvent` | A **complete** tool call — never partial JSON. |
| `Completed` | Terminal. Carries `usage` and the provider's `items`. |

## Tool calling

`Completed.items` holds the provider's own output items. Hand them straight
back on the next turn — they pass through untouched, which is what makes a
tool loop possible without the SDK modelling every provider item type.

```python
from fibonacci import Message, Tool, ToolResult

tools = [Tool(
    name="read_file",
    description="Read a UTF-8 text file",
    parameters={
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
)]

items = [Message("user", "What is in main.py?")]
while True:
    calls, done = [], None
    async for event in fib.stream(items=items, tools=tools):
        if isinstance(event, ToolCallEvent):
            calls.append(event.call)
        elif isinstance(event, Completed):
            done = event

    items.extend(done.items)                       # echo the model's own items back
    if not calls:
        break
    for call in calls:
        args = json.loads(call.arguments)
        items.append(ToolResult(call.call_id, output=open(args["path"]).read()))
```

`ToolCall.arguments` is the raw JSON **string** the model emitted, not a parsed
object. Models occasionally emit malformed JSON; parsing it inside the SDK
would hide that from you.

---

## The `fib` command

```
fib "explain this stack trace"        one-shot completion
cat main.py | fib "review this"       stdin is appended to the prompt
fib auth status                       who am I signed in as
fib models                            what this endpoint accepts
fib --version
```

Exit codes: `0` ok, `2` usage, `3` auth, `4` network, `5` provider,
`130` cancelled.

```console
$ fib auth status
provider     chatgpt (ChatGPT subscription)
account      you@example.com
plan         pro
model        gpt-5.6-sol
credentials  /Users/you/.codex/auth.json
token        valid — expires 2026-08-08 20:17:38 UTC (in 8d 22h)
```

It never prints a token.

> The Node package installs a `fib` binary too, and that one is the full agent.
> If both are on your `PATH`, whichever comes first wins — the Python one
> always says so in `fib --help`.

---

## How credentials work: link, don't copy

This is the design decision most worth understanding.

A ChatGPT subscription is authenticated by an OAuth refresh token in
`~/.codex/auth.json` (or `$CODEX_HOME`). **That refresh token rotates**: every
refresh mints a new one and invalidates the old.

So this SDK never keeps its own copy. It reads through to that file on every
request, and writes refreshed tokens straight back into it — atomically, mode
`0600`, preserving every key it does not recognise. Copying the tokens
elsewhere and refreshing the copy would silently break your real Codex CLI
login, in a tool you did not run.

Concurrent refreshes are serialised by a lock and re-check the file under it,
so a hundred parallel requests produce exactly one token rotation.

## Model availability

A ChatGPT account may only use **`gpt-5.6-sol`** through the Codex endpoint.
Every other Codex-family id (`gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.2-codex`,
`codex-mini-latest`) returns HTTP 400. The SDK turns that into an error that
names the model that does work:

```
fibonacci.errors.ProviderError: [HTTP 400] Model 'gpt-5.2-codex' is not
available to a ChatGPT account. The Codex subscription endpoint accepts only
'gpt-5.6-sol' — pass model='gpt-5.6-sol', or use
Fibonacci.from_openai(base_url=..., api_key=...) with an API key to reach the
full model list.
```

For the full model list, use an API key with `from_openai()`.

## Errors

```
FibonacciError
├── AuthError        credentials missing, malformed, expired, or refused
├── ProviderError    the provider returned an error (.status, .code, .body)
├── NetworkError     no usable response: connection, DNS, TLS, timeout
└── CancelledError   cancelled by the caller
```

`CancelledError` is deliberately **not** `asyncio.CancelledError` — this SDK
never catches or swallows that one.

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest -q
.venv/bin/python -m ruff check src/ tests/
.venv/bin/python -m mypy
```

The whole suite runs offline against a mocked transport.

## License

MIT © Chadwycke Smith
