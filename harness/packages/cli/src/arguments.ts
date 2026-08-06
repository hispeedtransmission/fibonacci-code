import { isAbsolute, resolve } from "node:path";

export type CliProvider = "codex" | "openai-compatible";
export type CliSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface CliRunOptions {
  cwd: string;
  provider: CliProvider;
  model?: string;
  core?: string;
  baseUrl?: string;
  codexBin?: string;
  sandbox: CliSandbox;
}

export interface CliDoctorOptions {
  provider: CliProvider;
  core?: string;
  baseUrl?: string;
  codexBin?: string;
}

export type ParsedArguments =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "github"; action: "login" | "status"; force: boolean }
  | { kind: "doctor"; options: CliDoctorOptions }
  | { kind: "run"; options: CliRunOptions };

export function parseArguments(args: string[]): ParsedArguments {
  if (args[0] === "github") return parseGitHubArguments(args.slice(1));

  let cwd = process.cwd();
  let model: string | undefined;
  let core: string | undefined;
  let baseUrl: string | undefined;
  let codexBin: string | undefined;
  let provider: CliProvider = "codex";
  let sandbox: CliSandbox = "workspace-write";
  let doctor = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "doctor":
        doctor = true;
        break;
      case "-h":
      case "--help":
        return { kind: "help" };
      case "-V":
      case "--version":
        return { kind: "version" };
      case "-C":
      case "--cwd":
        cwd = requiredValue(args, ++index, argument);
        break;
      case "-m":
      case "--model":
        model = requiredValue(args, ++index, argument);
        break;
      case "--core":
        core = requiredValue(args, ++index, argument);
        break;
      case "--codex-bin":
        codexBin = requiredValue(args, ++index, argument);
        break;
      case "--base-url":
        baseUrl = requiredValue(args, ++index, argument);
        break;
      case "--provider": {
        const value = requiredValue(args, ++index, argument);
        if (!isProvider(value)) {
          throw new Error(
            `Unknown provider '${value}'. Expected codex or openai-compatible.`,
          );
        }
        provider = value;
        break;
      }
      case "--sandbox": {
        const value = requiredValue(args, ++index, argument);
        if (!isSandbox(value)) {
          throw new Error(
            `Unknown sandbox '${value}'. Expected read-only, workspace-write, or danger-full-access.`,
          );
        }
        sandbox = value;
        break;
      }
      default:
        throw new Error(`Unknown option '${argument}'. Use --help.`);
    }
  }

  if (doctor) {
    return {
      kind: "doctor",
      options: {
        provider,
        ...(core === undefined ? {} : { core: resolve(core) }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(codexBin === undefined ? {} : { codexBin: normalizeExecutable(codexBin) }),
      },
    };
  }

  return {
    kind: "run",
    options: {
      cwd: resolve(cwd),
      provider,
      sandbox,
      ...(model === undefined ? {} : { model }),
      ...(core === undefined ? {} : { core: resolve(core) }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(codexBin === undefined ? {} : { codexBin: normalizeExecutable(codexBin) }),
    },
  };
}

function parseGitHubArguments(args: string[]): ParsedArguments {
  const action = args[0] ?? "status";
  if (action !== "login" && action !== "status") {
    throw new Error(`Unknown GitHub action '${action}'. Expected login or status.`);
  }

  let force = false;
  for (const argument of args.slice(1)) {
    if (argument === "--force" && action === "login") force = true;
    else throw new Error(`Unknown option '${argument}' for github ${action}.`);
  }
  return { kind: "github", action, force };
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}

function normalizeExecutable(value: string): string {
  return isAbsolute(value) || value.includes("/") || value.includes("\\")
    ? resolve(value)
    : value;
}

function isProvider(value: string): value is CliProvider {
  return value === "codex" || value === "openai-compatible";
}

function isSandbox(value: string): value is CliSandbox {
  return ["read-only", "workspace-write", "danger-full-access"].includes(value);
}

export function help(): string {
  return `Fibonacci — a coding-agent terminal instrument

Usage: fibonacci [doctor] [options]
       fibonacci github login [--force]
       fibonacci github status

Commands:
  doctor                 Check the core, provider, and auth setup
  github login           Authorize via GitHub's browser/device flow and
                         configure gh as the global Git credential helper
  github status          Show the active GitHub identity

Options:
  -C, --cwd <path>       Workspace to open (default: current directory)
  -m, --model <name>     Provider model override
      --provider <name>  codex | openai-compatible
      --base-url <url>   OpenAI-compatible API base URL
      --codex-bin <path> Codex executable override
      --sandbox <mode>   read-only | workspace-write | danger-full-access
      --core <path>      fibonacci-core executable override
  -V, --version          Print version
  -h, --help             Print help
`;
}
