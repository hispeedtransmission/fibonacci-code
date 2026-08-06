import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseArguments } from "../src/arguments.js";

describe("Fibonacci CLI arguments", () => {
  it("parses the OpenAI-compatible provider options", () => {
    expect(
      parseArguments([
        "--provider",
        "openai-compatible",
        "--base-url",
        "http://127.0.0.1:1234/v1",
        "--model",
        "local-model",
        "--sandbox",
        "read-only",
      ]),
    ).toEqual({
      kind: "run",
      options: {
        cwd: process.cwd(),
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "local-model",
        sandbox: "read-only",
      },
    });
  });

  it("resolves path-like Codex overrides before changing the child cwd", () => {
    const parsed = parseArguments([
      "--cwd",
      "/tmp/workspace",
      "--codex-bin",
      "./tools/codex",
    ]);

    expect(parsed).toMatchObject({
      kind: "run",
      options: { codexBin: resolve("./tools/codex") },
    });
  });

  it("parses doctor as a standalone command", () => {
    expect(parseArguments(["doctor", "--provider", "codex"])).toEqual({
      kind: "doctor",
      options: { provider: "codex" },
    });
  });

  it("preserves provider overrides for doctor", () => {
    expect(
      parseArguments([
        "doctor",
        "--provider",
        "openai-compatible",
        "--base-url",
        "https://gateway.example/v1",
        "--codex-bin",
        "/custom/codex",
      ]),
    ).toEqual({
      kind: "doctor",
      options: {
        provider: "openai-compatible",
        baseUrl: "https://gateway.example/v1",
        codexBin: "/custom/codex",
      },
    });
  });

  it("parses GitHub login through the device flow", () => {
    expect(parseArguments(["github", "login"])).toEqual({
      kind: "github",
      action: "login",
      force: false,
    });
  });

  it("supports forcing a fresh GitHub login", () => {
    expect(parseArguments(["github", "login", "--force"])).toEqual({
      kind: "github",
      action: "login",
      force: true,
    });
  });

  it("parses GitHub authentication status", () => {
    expect(parseArguments(["github", "status"])).toEqual({
      kind: "github",
      action: "status",
      force: false,
    });
  });

  it("rejects unsupported GitHub actions", () => {
    expect(() => parseArguments(["github", "explode"])).toThrow(
      "Unknown GitHub action 'explode'. Expected login or status.",
    );
  });
});
