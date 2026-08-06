import { readFileSync } from "node:fs";

interface PackageManifest {
  version?: unknown;
}

export function readCliVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("The Fibonacci CLI package manifest has no valid version.");
  }
  return manifest.version;
}
