import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harnessDirectory = resolve(cliDirectory, "../..");
const binary = process.platform === "win32" ? "fibonacci-core.exe" : "fibonacci-core";
const profile = process.argv.includes("--profile")
  ? process.argv[process.argv.indexOf("--profile") + 1]
  : "release";
const candidates = [
  resolve(harnessDirectory, "target", profile, binary),
  resolve(harnessDirectory, "target", profile === "release" ? "debug" : "release", binary),
];
const source = candidates.find((candidate) => existsSync(candidate));
if (!source) {
  throw new Error(
    `Missing ${binary}. Build the Rust core first with pnpm build:core or pnpm build:core:dev.`,
  );
}

const destination = resolve(cliDirectory, "dist", "bin", binary);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
if (process.platform !== "win32") chmodSync(destination, 0o755);
process.stdout.write(`Packaged ${source} -> ${destination}\n`);
