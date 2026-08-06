import { accessSync, constants, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const harnessDirectory = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  readFileSync(resolve(harnessDirectory, "packages", "cli", "package.json"), "utf8"),
);
const artifact = resolve(
  process.argv[2] ??
    resolve(
      harnessDirectory,
      "..",
      "artifacts",
      `fibonacci-cli-${manifest.version}.tgz`,
    ),
);
if (!existsSync(artifact)) {
  throw new Error(`Missing package artifact: ${artifact}`);
}

const installDirectory = mkdtempSync(resolve(tmpdir(), "fibonacci-package-smoke-"));
run(process.platform === "win32" ? "npm.cmd" : "npm", [
  "install",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--prefix",
  installDirectory,
  artifact,
]);

const bin = resolve(
  installDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "fibonacci.cmd" : "fibonacci",
);
const version = run(bin, ["--version"]).trim();
if (version !== `fibonacci ${manifest.version}`) {
  throw new Error(`Version mismatch: expected fibonacci ${manifest.version}, received ${version}`);
}

const core = resolve(
  installDirectory,
  "node_modules",
  "@fibonacci",
  "cli",
  "dist",
  "bin",
  process.platform === "win32" ? "fibonacci-core.exe" : "fibonacci-core",
);
accessSync(core, process.platform === "win32" ? constants.F_OK : constants.X_OK);
run(bin, [
  "doctor",
  "--provider",
  "openai-compatible",
  "--base-url",
  "http://127.0.0.1:1234/v1",
]);

process.stdout.write(`Verified ${basename(artifact)} (${version})\n`);

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}
