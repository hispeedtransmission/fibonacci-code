# Fibonacci

Fibonacci is a coding-agent harness designed as a terminal instrument: fast, calm,
legible, and visibly alive while work is happening.

The working slice pairs a Rust process/event core with a TypeScript Ink UI. The
core currently ships with two provider adapters:

- `codex` — launches the authenticated Codex CLI and supports session resume.
- `openai-compatible` — streams Chat Completions SSE from local runtimes or
  OpenAI-compatible gateways.

The UI never parses provider-specific JSON. Rust turns provider output into
Fibonacci’s versioned event protocol, contains stderr noise, and owns process
cancellation.

## Requirements

- Rust stable and Cargo
- Node.js 22+
- pnpm 11.7.0 (the workspace-pinned release)
- For the default provider: an authenticated `codex` CLI

Install the Codex CLI if it is not already available:

```bash
npm install --global @openai/codex
codex login
```

Fibonacci also searches common user-local binary directories such as
`~/.npm-global/bin` and `~/.local/bin`. Override the executable explicitly with
`FIBONACCI_CODEX` or `--codex-bin` when needed.

## Develop from source

```bash
pnpm install
pnpm doctor
pnpm dev -- --cwd /path/to/a/project
```

`pnpm doctor` checks the bundled core, provider executable, and non-secret auth
marker without printing credential contents.

Useful commands inside Fibonacci:

- `/help` shows the command reference.
- `/clear` clears the visible transcript.
- `/new` starts a fresh provider session.
- `/model <name>` changes the model for the next turn.
- `/quit` exits.
- `Esc` or `Ctrl+C` stops an active turn.
- `Ctrl+L` clears the visible transcript.
- `Ctrl+D` exits from an empty prompt.

## OpenAI-compatible provider

The adapter accepts streaming Chat Completions responses. It defaults to a
local LM Studio-style endpoint and does not require an API key for localhost:

```bash
FIBONACCI_OPENAI_BASE_URL=http://127.0.0.1:1234/v1 \
FIBONACCI_OPENAI_MODEL=local-model \
pnpm dev -- --provider openai-compatible
```

For a remote gateway, set `FIBONACCI_OPENAI_API_KEY` or `OPENAI_API_KEY`; the key
is read by the Rust process and is never included in normalized events.

## Verify it

```bash
pnpm check
pnpm showcase
pnpm doctor
pnpm package
```

`pnpm showcase` renders a deterministic terminal frame without calling a model.
`pnpm package` builds the release Rust core, bundles it into the JS CLI, and
writes `../artifacts/fibonacci-cli-0.1.0.tgz`.

The live smoke harness supports both provider paths:

```bash
# Codex: new turn plus resume
PATH="$HOME/.npm-global/bin:$PATH" pnpm smoke:core

# OpenAI-compatible: use a local streaming endpoint
FIBONACCI_SMOKE_PROVIDER=openai-compatible \
FIBONACCI_OPENAI_BASE_URL=http://127.0.0.1:1234/v1 \
pnpm smoke:core
```

## Architecture

```text
TypeScript / Ink UI
        │ typed JSONL events
        ▼
Rust process core
        ├── Codex CLI adapter
        └── OpenAI-compatible SSE adapter
```

See [docs/PRODUCT.md](docs/PRODUCT.md) and [docs/PROTOCOL.md](docs/PROTOCOL.md).
