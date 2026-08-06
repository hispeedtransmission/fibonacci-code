import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const binaryName = process.platform === "win32" ? "fibonacci-core.exe" : "fibonacci-core";
const core = process.env.FIBONACCI_CORE ?? resolve(root, "target", "debug", binaryName);
const provider = process.env.FIBONACCI_SMOKE_PROVIDER ?? "codex";
const baseUrl = process.env.FIBONACCI_OPENAI_BASE_URL ?? "http://127.0.0.1:1234/v1";
const model = process.env.FIBONACCI_OPENAI_MODEL ?? "local-model";

if (!existsSync(core)) {
  process.stderr.write(`Missing ${core}. Run pnpm build:core:dev first.\n`);
  process.exit(1);
}

function turn(prompt, session) {
  const args = [
    "run",
    "--provider",
    provider,
    "--cwd",
    root,
    "--sandbox",
    "read-only",
  ];
  if (provider === "openai-compatible") {
    args.push("--base-url", baseUrl, "--model", model);
  }
  if (session) args.push("--session", session);
  const result = spawnSync(core, args, {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 150_000,
  });
  if (result.error) throw result.error;
  const events = (result.stdout ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  return {
    status: result.status,
    events,
    session: events.find((event) => event.type === "session")?.id,
    stderr: (result.stderr ?? "").trim(),
  };
}

function summarize(run) {
  return {
    status: run.status,
    eventTypes: run.events.map((event) => event.type),
    messages: run.events
      .filter((event) => event.type === "message")
      .map((event) => event.text),
    outcomes: run.events
      .filter((event) => event.type === "done")
      .map((event) => event.outcome),
    sessionPrefix: run.session?.slice(0, 8),
    stderr: run.stderr || undefined,
  };
}

function completed(run, expectedText) {
  const done = run.events.filter((event) => event.type === "done");
  const messages = run.events
    .filter((event) => event.type === "message")
    .map((event) => event.text);
  return (
    run.status === 0 &&
    done.length === 1 &&
    done[0].outcome === "completed" &&
    messages.some((message) => message.includes(expectedText))
  );
}

const first = turn(
  provider === "codex"
    ? "Reply with exactly: Fibonacci core turn one OK. Do not use tools."
    : "Reply with exactly: local provider verified. Do not use tools.",
);
if (provider !== "codex") {
  const summary = summarize(first);
  process.stdout.write(`${JSON.stringify({ provider, run: summary }, null, 2)}\n`);
  if (!completed(first, "local provider verified")) {
    process.exitCode = 1;
  }
} else {
  if (!first.session) {
    process.stderr.write(`${JSON.stringify(summarize(first), null, 2)}\n`);
    process.exit(1);
  }
  const second = turn(
    "Reply with exactly: Fibonacci core resume OK. Do not use tools.",
    first.session,
  );

  process.stdout.write(`${JSON.stringify({ first: summarize(first), second: summarize(second) }, null, 2)}\n`);
  if (
    !completed(first, "Fibonacci core turn one OK") ||
    !completed(second, "Fibonacci core resume OK")
  ) {
    process.exitCode = 1;
  }
}