import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { parseCoreEvent, type CoreEvent } from "../protocol.js";

export interface RunRequest {
  prompt: string;
  cwd: string;
  model?: string;
  session?: string;
  provider?: "codex" | "openai-compatible";
  baseUrl?: string;
  codexBin?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

export interface RunHandle {
  cancel: () => void;
  done: Promise<void>;
}

interface ProcessEventSource {
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  exit?(code?: number): unknown;
}

interface ChildSignalTarget {
  killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
}

export function attachProcessCleanup(
  child: ChildSignalTarget,
  parent: ProcessEventSource = process,
): () => void {
  const terminate = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };
  const onExit = () => terminate("SIGTERM");
  const onSigint = () => {
    terminate("SIGINT");
    parent.exit?.(130);
  };
  const onSigterm = () => {
    terminate("SIGTERM");
    parent.exit?.(143);
  };
  parent.once("exit", onExit);
  parent.once("SIGINT", onSigint);
  parent.once("SIGTERM", onSigterm);
  return () => {
    parent.off("exit", onExit);
    parent.off("SIGINT", onSigint);
    parent.off("SIGTERM", onSigterm);
  };
}

export function syntheticCancellationEvents(
  sawStoppedPhase: boolean,
  sawDone: boolean,
  elapsedMs: number,
): CoreEvent[] {
  const events: CoreEvent[] = [];
  if (!sawStoppedPhase) {
    events.push({
      v: 1,
      type: "phase",
      phase: "stopped",
      label: "Run stopped",
    });
  }
  if (!sawDone) {
    events.push({ v: 1, type: "done", outcome: "stopped", elapsed_ms: elapsedMs });
  }
  return events;
}

export class CoreClient {
  readonly executable: string;

  constructor(executable = findCoreExecutable()) {
    this.executable = executable;
  }

  run(request: RunRequest, onEvent: (event: CoreEvent) => void): RunHandle {
    const args = [
      "run",
      "--provider",
      request.provider ?? "codex",
      "--cwd",
      request.cwd,
      "--sandbox",
      request.sandbox,
    ];
    if (request.model) args.push("--model", request.model);
    if (request.session) args.push("--session", request.session);
    if (request.baseUrl) args.push("--base-url", request.baseUrl);
    if (request.codexBin) args.push("--codex-bin", request.codexBin);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.executable, args, {
        cwd: request.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw coreStartError(this.executable, error);
    }

    const detachCleanup = attachProcessCleanup(child);
    const startedAt = Date.now();
    let cancellationRequested = false;
    let sawStoppedPhase = false;
    let sawDone = false;
    const stderr: string[] = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr.push(chunk);
      if (stderr.length > 8) stderr.shift();
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const event = parseCoreEvent(line);
      if (!event) return;
      sawStoppedPhase ||= event.type === "phase" && event.phase === "stopped";
      sawDone ||= event.type === "done";
      onEvent(event);
    });

    child.stdin.end(request.prompt);

    const done = new Promise<void>((fulfill, reject) => {
      child.once("error", (error) => {
        detachCleanup();
        reject(coreStartError(this.executable, error));
      });
      child.once("close", (code, signal) => {
        detachCleanup();
        lines.close();
        if (cancellationRequested) {
          for (const event of syntheticCancellationEvents(
            sawStoppedPhase,
            sawDone,
            Date.now() - startedAt,
          )) {
            onEvent(event);
          }
          fulfill();
          return;
        }
        if (code === 0) {
          fulfill();
          return;
        }
        const detail = stderr.join("").trim();
        reject(
          new Error(
            detail ||
              `Fibonacci core exited with ${code === null ? signal : `code ${code}`}.`,
          ),
        );
      });
    });

    return {
      cancel: () => {
        cancellationRequested = true;
        if (!child.killed) child.kill("SIGINT");
      },
      done,
    };
  }
}

export function findCoreExecutable(): string {
  const configured = process.env.FIBONACCI_CORE;
  if (configured) return configured;

  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const binary = process.platform === "win32" ? "fibonacci-core.exe" : "fibonacci-core";
  const candidates = [
    resolve(moduleDirectory, "bin", binary),
    resolve(moduleDirectory, binary),
    resolve(moduleDirectory, "..", binary),
    resolve(moduleDirectory, "..", "..", "..", "target", "debug", binary),
    resolve(moduleDirectory, "..", "..", "..", "target", "release", binary),
    resolve(moduleDirectory, "..", "..", "..", "..", "target", "debug", binary),
    resolve(moduleDirectory, "..", "..", "..", "..", "target", "release", binary),
  ];

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory, binary);
    if (isExecutable(candidate)) return candidate;
  }

  // Return the conventional name so Node's spawn error contains the platform detail.
  return binary;
}

export function findCodexExecutable(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = environment.FIBONACCI_CODEX;
  if (configured) return findExecutable(configured, environment);
  return findExecutable("codex", environment);
}

export function findExecutable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    return isExecutable(name) ? name : undefined;
  }

  const home = environment.HOME;
  const fallbackDirectories = home
    ? [
        resolve(home, ".npm-global", "bin"),
        resolve(home, ".local", "bin"),
        resolve(home, ".cargo", "bin"),
      ]
    : [];
  const directories = [
    ...(environment.PATH ?? "").split(delimiter).filter(Boolean),
    ...fallbackDirectories,
  ];
  const extensions = executableExtensions(name, environment);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = resolve(directory, `${name}${extension}`);
      if (isExecutable(candidate)) return candidate;
    }
  }

  return undefined;
}

function executableExtensions(
  name: string,
  environment: NodeJS.ProcessEnv,
): string[] {
  if (/\.[^/\\]+$/.test(name)) return [""];
  const pathExt = environment.PATHEXT;
  if (!pathExt) return [""];
  const extensions = pathExt
    .split(";")
    .filter(Boolean)
    .flatMap((extension) => [extension.toLowerCase(), extension]);
  return ["", ...new Set(extensions)];
}

function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function coreStartError(executable: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `Could not start ${executable}. Build it with \`pnpm build:core:dev\`. ${detail}`,
  );
}