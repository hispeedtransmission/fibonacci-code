# Security

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/hispeedtransmission/fibonacci-code/security/advisories/new) rather than a public issue.

Expect an acknowledgement within 72 hours.

## Threat model

Fibonacci is a coding agent: by design it reads your files, writes to them, and runs shell commands. Being precise about what that does and does not protect matters more than a list of features.

### What Fibonacci protects

**Credentials never leave the machine, and never enter a log.**
- The credential store is `~/.fibonacci/auth.json`, written `0600` via temp-file-plus-rename so an interrupted write cannot leave a partial secret.
- No token, key, or `Authorization` header is ever written to stdout, stderr, an error message, or an exception trace. `redact()` exists for the cases where something must be displayed, and shows at most 4 leading and 4 trailing characters.
- API keys are preferentially read from the environment; storing them is opt-in.

**By default, your ChatGPT tokens are not copied at all.** `fib auth login` records a *pointer* to `~/.codex/auth.json` and reads through it per request. This is a security property as well as a correctness one: there is no second copy of a live OAuth token on disk to leak or go stale.

**Tools cannot leave the workspace.** Every path is resolved and checked against the workspace root before use. This defeats `../` traversal, absolute paths, and symlinks inside the workspace that point outside it. Symlink resolution uses the real path of the deepest existing ancestor, so writes to not-yet-existing files are still checked.

**Credential-shaped files are refused even inside the workspace**, including `.env` and `.env.*` (excepting `.env.example`), `id_rsa` / `id_ed25519` / `*.pem` / `*.key`, `.npmrc`, `.pypirc`, `.aws/credentials`, anything under `.ssh/`, and the `.fibonacci/` and `.codex/` directories.

**Destructive commands are confirmed even in `full-auto`,** with the prompt defaulting to *no*. The list covers recursive/forced deletion, `sudo`, disk-level operations, force pushes, `git reset --hard`, piping a remote script into a shell, package publication, and shutdown.

**File writes are atomic.** Interrupting a run cannot truncate your source.

**Zero runtime dependencies.** There is no transitive package that could be compromised to reach your tokens or your filesystem. The only trusted code is Node itself and this repository.

### What Fibonacci does *not* protect

**There is no sandbox.** Commands run as your user, with your permissions, in your shell. If you approve a command, it runs.

**The destructive-command list is not a security boundary.** It catches plausible accidents. It cannot stop a determined adversary — `sh -c`, `env`, `xargs`, base64-decoding, and countless other forms defeat any pattern list. Treat it as a seatbelt, not a vault.

**Model output is untrusted input.** A model can be influenced by content it reads: a file in your repository, the output of a command, a fetched page. Under `full-auto`, prompt injection in any of those can become a tool call. This is the central risk of unattended agents.

**Mitigation:** run `full-auto` only against code you trust, or inside a container or a scratch clone. The default `suggest` mode exists precisely so that a human sees every write and every command before it happens.

**The workspace root is the boundary, and you choose it.** Running `fib -C /` places your entire filesystem in scope.

## Supported versions

Pre-1.0: only the latest published version receives fixes.
