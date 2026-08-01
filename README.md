<p align="center">
  <!--
    Absolute raw URL, not a relative path: `assets/` is excluded from the npm
    tarball, so a relative src renders as a broken image on npmjs.com.
  -->
  <img src="https://raw.githubusercontent.com/hispeedtransmission/fibonacci-code/main/assets/banner.svg" alt="Fibonacci — a terminal coding agent" width="820">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/fibonacci-code"><img alt="npm" src="https://img.shields.io/npm/v/fibonacci-code?color=E9A23B&labelColor=17130F&logo=npm&logoColor=E9A23B"></a>
  <a href="https://pypi.org/project/fibonacci-code/"><img alt="PyPI" src="https://img.shields.io/pypi/v/fibonacci-code?color=E9A23B&labelColor=17130F&logo=pypi&logoColor=E9A23B"></a>
  <a href="#requirements"><img alt="node" src="https://img.shields.io/node/v/fibonacci-code?color=E9A23B&labelColor=17130F&logo=node.js&logoColor=E9A23B"></a>
  <a href="https://github.com/hispeedtransmission/fibonacci-code/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/hispeedtransmission/fibonacci-code/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-E9A23B?labelColor=17130F"></a>
  <img alt="dependencies" src="https://img.shields.io/badge/runtime%20deps-0-E9A23B?labelColor=17130F">
</p>

---

**Fibonacci is a coding agent that lives in your terminal.** It reads your files, edits them, runs your tests, and reports back — driven either by the ChatGPT subscription you already pay for, or by any OpenAI-compatible endpoint you point it at.

It ships with **zero runtime dependencies**. The install is the Node runtime you already trust and nothing else.

```console
$ fib "add retry logic to the fetch helper"

╭─ fibonacci ──────────────────────────────────────────────────────────╮
│ ~/projects/api   gpt-5.6-sol · ChatGPT subscription · suggest        │
╰──────────────────────────────────────────────────────────────────────╯

  ● grep  fetch\(                    3 matches in 2 files
  ● read  src/fetch.ts
  ● edit  src/fetch.ts

  --- src/fetch.ts
  +++ src/fetch.ts
  @@ -12,8 +12,22 @@
  +  for (let attempt = 0; attempt < retries; attempt++) {
  +    try {
  +      return await doFetch(url, init);
  +    } catch (err) {
  +      if (attempt === retries - 1) throw err;
  +      await sleep(backoff * 2 ** attempt);
  +    }
  +  }

  ● run   npm test                   ✓ 24 passed

Added exponential backoff with 3 retries. Tests pass.
4.1k in · 890 out · 1.8k cached
```

## Why

Most terminal agents want an API key, and an API key is a second bill on top of the ChatGPT subscription you are already paying for. Fibonacci's default path spends nothing extra: it reuses the OAuth login the Codex CLI already put on your machine.

When you *do* want an API key — a local model, a cheaper provider, a work account — it is one flag away, because the second backend is plain OpenAI-compatible Chat Completions and roughly everything speaks that.

## Install

```bash
npm install -g fibonacci-code      # or: pnpm add -g / yarn global add / bun add -g
pip install fibonacci-code         # Python SDK + a one-shot CLI
```

Both install a `fib` binary. The npm package is the full interactive agent; the PyPI package is a typed async SDK for embedding Fibonacci in Python, plus a one-shot CLI. See [Python SDK](#python-sdk).

> **On pnpm and yarn:** they are package *managers*, not registries — they install from npm. One `npm publish` covers all of them.

### Requirements

- **Node.js ≥ 20.10** for the CLI
- **Python ≥ 3.9** for the SDK
- For the subscription path: a ChatGPT account and the [Codex CLI](https://github.com/openai/codex) signed in (`codex login`)

## Quickstart

```bash
fib auth login          # links your existing ChatGPT login
fib                     # start an interactive session
```

```console
$ fib auth login
✓ Linked to your Codex CLI login.
  Reading through /Users/you/.codex/auth.json — no second copy of your tokens is stored.

  Account   you@example.com
  Plan      pro
  Expires   10/08/2026, 14:57:38
```

That's it. No key to paste, no second subscription.

<details>
<summary><b>Using an API key instead</b></summary>

```bash
export OPENAI_API_KEY=sk-...
fib -P openai "explain this codebase"

# or store it (0600, in ~/.fibonacci/auth.json)
fib auth login --api-key --profile openai
```
</details>

## Usage

```bash
fib                                        # interactive session
fib "why does the build fail?"             # one-shot
fib -y "add tests for src/parser.ts"       # unattended (auto-approve)
git diff | fib "review this change"        # pipe context in
fib -P ollama -m qwen3-coder               # local model
fib "summarize the architecture" > NOTES.md
```

**Assistant prose goes to stdout; everything else — banner, tool lines, spinner, token counts — goes to stderr.** So `fib "..." > out.md` gives you a clean file and `fib "..." | pbcopy` copies just the answer, while interactively you see it all interleaved as normal.

### Options

| Flag | Description |
|---|---|
| `-p, --prompt <text>` | One-shot prompt |
| `-P, --profile <name>` | Profile to use (default `codex`) |
| `-m, --model <id>` | Model id |
| `--base-url <url>` | Override endpoint for OpenAI-compatible profiles |
| `-a, --approval <mode>` | `suggest` · `auto-edit` · `full-auto` |
| `-y, --yes` | Shorthand for `--approval full-auto` |
| `--effort <level>` | `none` · `low` · `medium` · `high` · `xhigh` |
| `--max-turns <n>` | Cap model round-trips per message (default 40) |
| `-C, --cwd <dir>` | Workspace root |
| `-q, --quiet` | Suppress banner and progress chrome |
| `--no-color` | Disable colour (also honours `NO_COLOR`) |

### Commands

| Command | Description |
|---|---|
| `fib auth login` | Sign in — links your Codex login by default |
| `fib auth status` | Who you are signed in as, and from where |
| `fib auth logout` | Remove stored credentials |
| `fib models` | Models available on the current profile |
| `fib config` | Resolved config **and which file produced each value** |

## Providers

`codex` is the default. Everything else is OpenAI-compatible Chat Completions, so any server speaking that protocol works — these are just presets.

| Profile | Endpoint | Auth |
|---|---|---|
| `codex` | ChatGPT subscription | Your Codex login |
| `openai` | `api.openai.com/v1` | `OPENAI_API_KEY` |
| `ollama` | `localhost:11434/v1` | none |
| `lmstudio` | `localhost:1234/v1` | none |
| `groq` | `api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `together` | `api.together.xyz/v1` | `TOGETHER_API_KEY` |
| `openrouter` | `openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |

Anything else is one flag: `fib --base-url http://my-server/v1 -m my-model`.

> **Subscription model limits are real.** A ChatGPT account may use `gpt-5.6-sol`. API-only models (`gpt-5-codex`, `codex-mini-latest`) are rejected by that endpoint with an explicit error — not a Fibonacci restriction. Use `-P openai` with a key to reach those.

## Safety model

An agent that edits files and runs shell commands should be honest about what protects you. Three things do, and one thing does not.

**Approval modes** — the main control:

| Mode | Reads | Writes | Commands |
|---|---|---|---|
| `suggest` *(default)* | automatic | ask | ask |
| `auto-edit` | automatic | automatic | ask |
| `full-auto` | automatic | automatic | automatic\* |

\* Commands matching a destructive-shape list (`rm -rf`, `sudo`, force push, `curl … \| sh`, `npm publish`, …) are confirmed **even in `full-auto`**, and that prompt defaults to *no*.

**Workspace containment** — every path a tool touches is resolved and checked against the workspace root, defeating `../../etc/passwd`, absolute paths, and symlinks pointing outside the tree. Credential-shaped files (`.env`, `id_rsa`, `.npmrc`, `~/.aws/credentials`, `.ssh/*`) are refused even inside the workspace.

**Atomic writes** — every file write goes to a temp file and is renamed, so an interrupted run cannot truncate your source.

**What does *not* protect you:** there is no sandbox. Commands run as you, with your permissions. The destructive-command list catches the plausible accident, not a determined adversary — `sh -c`, `env`, `xargs` and a hundred other forms defeat any such list. If you run `full-auto` on untrusted input, you are trusting the model. Use a container or a scratch clone for that.

## Configuration

Precedence, highest first: **CLI flags → environment → project config → user config → defaults**. `fib config` prints the result *and its sources*, which is usually the fastest way to answer "why is it using that model?".

```jsonc
// ~/.fibonacci/config.json  — or ./.fibonacci/config.json for one project
{
  "defaultProfile": "codex",
  "approval": "suggest",
  "reasoningEffort": "medium",
  "maxTurns": 40,
  "profiles": {
    "work": {
      "provider": "openai",
      "baseUrl": "https://my-gateway.internal/v1",
      "apiKeyEnv": "WORK_LLM_KEY"
    }
  }
}
```

Environment: `FIBONACCI_PROFILE`, `FIBONACCI_MODEL`, `FIBONACCI_APPROVAL`, `FIBONACCI_MAX_TURNS`, `FIBONACCI_API_KEY`, `FIBONACCI_HOME`, plus `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `NO_COLOR`.

### Project instructions

Fibonacci reads the first of `FIBONACCI.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules` it finds in the workspace and appends it to the system prompt — so a repo that already documents its conventions for another agent works here unchanged.

## Tools

| Tool | Purpose |
|---|---|
| `find_files` | Glob search, gitignore-aware |
| `search_text` | Regex across file contents |
| `read_file` | Read with line numbers, offset/limit |
| `write_file` | Create or replace a file |
| `edit_file` | Exact-string replacement, uniqueness-checked |
| `list_dir` | Directory listing |
| `run_command` | Shell, with timeout and output cap |

`edit_file` requires the target string to appear **exactly once**. Ambiguous or stale matches are refused rather than guessed — a refusal costs one cheap retry, a wrong guess costs your source code.

## Python SDK

```python
import asyncio
from fibonacci import Fibonacci

async def main():
    async with Fibonacci.from_codex() as fib:          # reuses your ChatGPT login
        async for chunk in fib.stream("Explain this repo's layout"):
            print(chunk, end="", flush=True)

asyncio.run(main())
```

Point it anywhere OpenAI-compatible:

```python
async with Fibonacci.from_openai(base_url="http://localhost:11434/v1") as fib:
    print(await fib.complete("Write a haiku about backpressure"))
```

The PyPI package also installs a one-shot `fib`:

```bash
fib "explain this error" < traceback.txt
fib auth status
```

Fully typed, `py.typed` shipped, one runtime dependency (`httpx`).

## Architecture

```
src/
  cli.ts              argument parsing (node:util.parseArgs), dispatch
  commands/           run · auth · models · config
  agent/
    loop.ts           tool-calling loop, turn cap, transcript-safe cancellation
    prompt.ts         the system prompt, as reviewable data
    tools/            fs · search · shell, with approval + containment
  providers/
    types.ts          Provider + StreamEvent contract
    chatgpt.ts        ChatGPT subscription (OpenAI Responses API)
    openai.ts         OpenAI-compatible Chat Completions
  auth/               link-mode Codex sharing, API keys, 0600 atomic store
  net/                SSE parser, retry with full jitter + Retry-After
  fsx/                path containment, unified diff, gitignore walker
  ui/                 zero-dep ANSI, banner, spinner, diff colouring
```

Two design notes worth surfacing:

**Link mode, not copy mode.** OAuth public clients rotate the refresh token on every use. If Fibonacci copied your Codex tokens and later refreshed its copy, the tokens still sitting in `~/.codex/auth.json` would be dead and your actual Codex CLI would silently break. So Fibonacci reads that file through on every call and writes rotated tokens *back into it*, in Codex's own schema. One source of truth, no possible desync. (`--copy` exists if you want an isolated snapshot, and warns you about this.)

**One transcript, two wire formats.** The Responses API is stateful with `call_id`-keyed tool calls and reasoning items that must be replayed verbatim; Chat Completions is stateless with tool calls on the assistant message. Both normalize to one `Item[]` transcript, so the agent loop never learns which backend it is talking to.

## Development

```bash
git clone https://github.com/hispeedtransmission/fibonacci-code
cd fibonacci-code
npm install
npm run build          # tsc -> dist/
npm test               # node:test, zero deps
npm run typecheck

node --experimental-strip-types src/cli.ts "hello"   # run from source, no build

cd python && pip install -e ".[dev]" && pytest
```

## Limitations

Stated plainly, because a README that only lists strengths is a sales page.

- **No sandbox.** See [Safety model](#safety-model).
- **One model on the subscription path.** That is the endpoint's restriction, not ours.
- **No image or multimodal input yet.**
- **Sessions are not persisted** across restarts; `/clear` resets, but closing the terminal loses history.
- **Not affiliated with OpenAI.** This is an independent client that interoperates with a login you already have. Your own subscription, your own machine, your own terms.

## License

MIT © Chadwycke Smith
