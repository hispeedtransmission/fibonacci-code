import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  attachProcessCleanup,
  syntheticCancellationEvents,
  findExecutable,
} from "../src/runtime/core-client.js";

describe("provider executable discovery", () => {
  it("finds an executable from the supplied PATH", () => {
    const directory = mkdtempSync(join(tmpdir(), "fibonacci-path-"));
    const executable = join(directory, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);

    expect(findExecutable("codex", { PATH: directory })).toBe(executable);
  });

  it("checks npm-global and local bin fallbacks when PATH is incomplete", () => {
    const directory = mkdtempSync(join(tmpdir(), "fibonacci-home-"));
    const executableDirectory = join(directory, ".npm-global", "bin");
    mkdirSync(executableDirectory, { recursive: true });
    const executable = join(executableDirectory, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { flag: "w" });
    chmodSync(executable, 0o755);

    expect(
      findExecutable("codex", {
        HOME: directory,
        PATH: "",
      }),
    ).toBe(executable);
  });

  it("honors PATHEXT when discovering Windows command shims", () => {
    const directory = mkdtempSync(join(tmpdir(), "fibonacci-windows-path-"));
    const executable = join(directory, "codex.cmd");
    writeFileSync(executable, "@exit /b 0\r\n");
    chmodSync(executable, 0o755);

    expect(
      findExecutable("codex", {
        PATH: directory,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      }),
    ).toBe(executable);
  });
});

describe("provider process cleanup", () => {
  it("synthesizes terminal events when cancellation kills the core first", () => {
    expect(syntheticCancellationEvents(false, false, 42)).toEqual([
      { v: 1, type: "phase", phase: "stopped", label: "Run stopped" },
      { v: 1, type: "done", outcome: "stopped", elapsed_ms: 42 },
    ]);
    expect(syntheticCancellationEvents(true, true, 42)).toEqual([]);
  });

  it("terminates the child and parent when the parent receives SIGTERM", () => {
    const exit = vi.fn();
    const parent = Object.assign(new EventEmitter(), { exit });
    const kill = vi.fn(() => true);
    const detach = attachProcessCleanup({ killed: false, kill }, parent);

    parent.emit("SIGTERM");
    detach();
    parent.emit("SIGTERM");

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(exit).toHaveBeenCalledWith(143);
  });
});
