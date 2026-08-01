# Contributing

Thanks for taking a look.

## Setup

```bash
git clone https://github.com/hispeedtransmission/fibonacci-code
cd fibonacci-code
npm install

npm run build        # tsc -> dist/
npm test             # node:test
npm run typecheck

# Run from source with no build step:
node --experimental-strip-types src/cli.ts "hello"
```

> **Node version note.** The package `engines` floor is **20.10**, and that is real — the shipped `dist/` is plain JS and CI builds and smoke-tests the CLI on exactly that version. But `npm test` needs **Node ≥ 22.6**, because running the TypeScript sources directly relies on `--experimental-strip-types`, which does not exist on 20.x. Develop on 22+; the floor is for users, not contributors.

Python side:

```bash
cd python
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/pytest
.venv/bin/ruff check src/
```

## The one rule that is not negotiable

**The TypeScript package has zero runtime dependencies, and that is a feature, not an accident.**

This tool holds an OAuth token that bills a paid subscription, and it has read/write access to the user's source tree and their shell. Every transitive dependency is another party with a path to all three. A PR that adds a runtime dependency needs to argue that the functionality is impossible to write in a reasonable amount of code against Node built-ins — and "impossible", not "tedious".

`devDependencies` are unconstrained. The Python package has exactly one runtime dependency (`httpx`), because streaming HTTP is genuinely not in the standard library.

## Code style

- **Comments explain why, not what.** `// increment i` is noise; `// full jitter, or concurrent retries collide forever` is the reason a reader can't reconstruct from the code.
- **Each module opens with a block comment naming the design tension it resolves.** Read `src/net/sse.ts` or `src/agent/tools/fs.ts` for the shape.
- Relative imports use the `.ts` extension. `rewriteRelativeImportExtensions` rewrites them at build time; this is what lets the source run unbuilt under `--experimental-strip-types`.
- Strict TypeScript, including `noUncheckedIndexedAccess`. Indexing yields `T | undefined` — handle it.
- Errors go through the `src/errors.ts` hierarchy and carry a `hint` with the *concrete next command* where one exists.

## Tests

`node:test` and `node:assert/strict`. No framework.

Test the edge case, not the happy path. The suite's centre of gravity is deliberately: SSE chunk boundaries, path-escape vectors, transcript balance after cancellation, and retry semantics. If you fix a bug, the regression test should fail against the old code for the *specific* reason the bug existed.

Tests must not touch the network or the developer's real credentials. Set `FIBONACCI_HOME` to a temp directory and script the provider (see `test/agent.test.ts`).

## Adding a provider

1. Implement `Provider` from `src/providers/types.ts`.
2. Normalize to the `Item` transcript and the `StreamEvent` union. The agent loop must not learn which backend it is talking to.
3. Add a preset to `BUILTIN_PROFILES` in `src/config.ts`.
4. Wire it in `createProvider` in `src/providers/index.ts`.
5. Add round-trip serialization tests, both directions.

If the backend is OpenAI-compatible, you almost certainly do not need a new provider — add a profile with a `baseUrl` instead.

## Adding a tool

Implement `Tool` from `src/agent/tools/types.ts`. Then, before opening the PR:

- Re-validate every argument with the `arg*` helpers. The JSON Schema is documentation the model may ignore.
- Return a readable error string instead of throwing when the failure is something the model could correct — a tool error is a recoverable turn, not a crash.
- Route every path through `resolveInWorkspace` and `assertNotSensitive`.
- Decide `needsApproval` deliberately, and say why in a comment.
- Cap the output. `truncateForModel` exists because one unbounded `grep` ends a conversation.

## Commits and PRs

Conventional-ish subjects (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`). Explain *why* in the body; the diff already shows what.

CI must be green: typecheck, tests on Node 20.10/22/24 across Linux/macOS/Windows, Python 3.9/3.11/3.13, and the packaging job that verifies the published tarball actually runs and contains no sources or credentials.
