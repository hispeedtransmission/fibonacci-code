import { spawnSync } from "node:child_process";

export interface GhResult {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type GhExecutor = (args: string[]) => GhResult;

interface GitHubAuthOptions {
  execute?: GhExecutor;
  force?: boolean;
}

export interface GitHubAuthResult {
  login: string;
  authenticatedNow: boolean;
}

export interface GitHubStatus {
  authenticated: boolean;
  login?: string;
}

export function authenticateGitHub(options: GitHubAuthOptions = {}): GitHubAuthResult {
  const execute = options.execute ?? executeGh;
  const authenticated = options.force
    ? false
    : execute(["auth", "status", "--hostname", "github.com"]).status === 0;

  if (!authenticated) {
    const login = execute([
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--git-protocol",
      "https",
      "--web",
    ]);
    assertGhSucceeded(login, "GitHub device authorization failed");
  }

  const setup = execute(["auth", "setup-git", "--hostname", "github.com"]);
  assertGhSucceeded(setup, "Could not configure GitHub authentication for Git");

  const identity = execute(["api", "user", "--jq", ".login"]);
  assertGhSucceeded(identity, "Could not validate the GitHub identity");
  const login = identity.stdout.trim();
  if (!login) throw new Error("GitHub authenticated but returned no account name.");

  return { login, authenticatedNow: !authenticated };
}

export function githubStatus(options: Pick<GitHubAuthOptions, "execute"> = {}): GitHubStatus {
  const execute = options.execute ?? executeGh;
  const status = execute(["auth", "status", "--hostname", "github.com"]);
  if (status.status !== 0) return { authenticated: false };

  const identity = execute(["api", "user", "--jq", ".login"]);
  if (identity.status !== 0) return { authenticated: true };
  const login = identity.stdout.trim();
  return login ? { authenticated: true, login } : { authenticated: true };
}

export const executeGh: GhExecutor = (args) => {
  const interactive = args[0] === "auth" && args[1] === "login";
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: interactive ? "inherit" : "pipe",
  });
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    ...(result.error === undefined ? {} : { error: result.error }),
  };
};

function assertGhSucceeded(result: GhResult, context: string): void {
  if (result.status === 0) return;
  const detail = result.error?.message ?? result.stderr.trim() ?? result.stdout.trim();
  throw new Error(detail ? `${context}: ${detail}` : context);
}
