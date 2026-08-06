# Fibonacci event protocol v1

The Rust core writes one JSON object per line to stdout. Every event includes
`"v": 1` and a `type` discriminator. Provider stderr is captured and surfaced only
when it explains a failed turn.

## Events

- `run_started`: provider, working directory, and resumed/new state.
- `session`: durable provider session identifier.
- `phase`: `ready`, `thinking`, `acting`, `verifying`, `stopped`, or `failed`.
- `message`: assistant content.
- `thought`: compact reasoning/progress content safe to show in the activity layer.
- `activity`: a tool or provider item, updated by stable item ID.
- `usage`: provider token accounting when available.
- `notice`: actionable non-fatal information.
- `error`: a failed turn with a direct recovery message.
- `done`: terminal outcome and elapsed time.

Unknown provider items become `activity` events rather than disappearing. Unknown
top-level provider events become dim notices only when they carry a meaningful
message. This keeps the protocol forward-compatible without flooding the UI.

## Core invocation

The prompt is read from stdin so it is not interpolated through a shell.

```bash
printf '%s' 'Inspect this repository' | \
  fibonacci-core run --cwd /path/to/repo --sandbox workspace-write
```

Resume a provider session with `--session <id>`. Send `SIGTERM` or `SIGINT` to the
core to cancel the provider child; cancellation produces a `done` event with a
stopped outcome when the signal reaches the process normally.