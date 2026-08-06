import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const harnessDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliDirectory = resolve(harnessDirectory, "packages", "cli");
const artifactDirectory = resolve(harnessDirectory, "..", "artifacts");
mkdirSync(artifactDirectory, { recursive: true });

const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--pack-destination", artifactDirectory],
  { cwd: cliDirectory, stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
