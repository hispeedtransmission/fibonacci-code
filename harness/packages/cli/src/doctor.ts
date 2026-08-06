import { accessSync, constants, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  findCodexExecutable,
  findCoreExecutable,
  findExecutable,
} from "./runtime/core-client.js";

export interface DoctorOptions {
  provider: "codex" | "openai-compatible";
  core?: string;
  baseUrl?: string;
  codexBin?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface DoctorReport {
  ok: boolean;
  text: string;
}

export function doctorReport(options: DoctorOptions): DoctorReport {
  const environment = options.environment ?? process.env;
  const core = options.core ?? findCoreExecutable();
  const coreOk = isExecutable(core);
  const lines = [
    `Core executable: ${coreOk ? "OK" : "FAIL"} (${core})`,
  ];
  let providerOk = true;

  if (options.provider === "codex") {
    const codex = options.codexBin
      ? findExecutable(options.codexBin, environment)
      : findCodexExecutable(environment);
    providerOk = codex !== undefined;
    lines.push(
      `Codex executable: ${providerOk ? "OK" : "FAIL"} (${codex ?? "not found"})`,
    );
    const authPath = resolve(environment.HOME ?? "", ".codex", "auth.json");
    const authOk = existsSync(authPath) || Boolean(environment.OPENAI_API_KEY);
    lines.push(`Codex auth marker: ${authOk ? "OK" : "WARN"} (${authPath})`);
    if (!providerOk) {
      lines.push("Install Codex: npm install --global @openai/codex");
      lines.push("If npm global bin is not on PATH: export PATH=\"$HOME/.npm-global/bin:$PATH\"");
    }
  } else {
    const baseUrl =
      options.baseUrl ??
      environment.FIBONACCI_OPENAI_BASE_URL ??
      "http://127.0.0.1:1234/v1";
    const baseUrlOk = isHttpUrl(baseUrl);
    providerOk = baseUrlOk;
    lines.push(`OpenAI-compatible base URL: ${baseUrlOk ? "OK" : "FAIL"} (${baseUrl})`);
    if (!environment.FIBONACCI_OPENAI_API_KEY && !environment.OPENAI_API_KEY) {
      lines.push("OpenAI-compatible auth: WARN (no API key; acceptable for local endpoints)");
    } else {
      lines.push("OpenAI-compatible auth: OK (key present; value not displayed)");
    }
  }

  return {
    ok: coreOk && providerOk,
    text: [
      "Fibonacci doctor",
      ...lines,
      `Result: ${coreOk && providerOk ? "READY" : "ACTION REQUIRED"}`,
    ].join("\n"),
  };
}

function isExecutable(path: string): boolean {
  if (!path || !existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
