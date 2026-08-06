import { describe, expect, it } from "vitest";

import { authenticateGitHub, githubStatus, type GhExecutor } from "../src/github-auth.js";

function fakeGh(responses: Array<{ status: number; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  const execute: GhExecutor = (args) => {
    calls.push(args);
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    return { stdout: "", stderr: "", ...response };
  };
  return { calls, execute };
}

describe("GitHub authentication", () => {
  it("reuses an existing gh login and installs the global git credential helper", () => {
    const gh = fakeGh([
      { status: 0 },
      { status: 0 },
      { status: 0, stdout: "hispeedtransmission\n" },
    ]);

    const result = authenticateGitHub({ execute: gh.execute });

    expect(gh.calls).toEqual([
      ["auth", "status", "--hostname", "github.com"],
      ["auth", "setup-git", "--hostname", "github.com"],
      ["api", "user", "--jq", ".login"],
    ]);
    expect(result).toEqual({ login: "hispeedtransmission", authenticatedNow: false });
  });

  it("starts gh web device flow when no login exists", () => {
    const gh = fakeGh([
      { status: 1 },
      { status: 0 },
      { status: 0 },
      { status: 0, stdout: "chad\n" },
    ]);

    const result = authenticateGitHub({ execute: gh.execute });

    expect(gh.calls[1]).toEqual([
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--git-protocol",
      "https",
      "--web",
    ]);
    expect(result).toEqual({ login: "chad", authenticatedNow: true });
  });

  it("forces a fresh device flow when requested", () => {
    const gh = fakeGh([
      { status: 0 },
      { status: 0 },
      { status: 0, stdout: "chad\n" },
    ]);

    authenticateGitHub({ execute: gh.execute, force: true });

    expect(gh.calls[0]?.slice(0, 3)).toEqual(["auth", "login", "--hostname"]);
  });

  it("reports actionable login failures without exposing output", () => {
    const gh = fakeGh([
      { status: 1 },
      { status: 1, stderr: "authorization failed" },
    ]);

    expect(() => authenticateGitHub({ execute: gh.execute })).toThrow(
      "GitHub device authorization failed: authorization failed",
    );
  });

  it("returns a concise authenticated status", () => {
    const gh = fakeGh([
      { status: 0 },
      { status: 0, stdout: "hispeedtransmission\n" },
    ]);

    expect(githubStatus({ execute: gh.execute })).toEqual({
      authenticated: true,
      login: "hispeedtransmission",
    });
  });
});
