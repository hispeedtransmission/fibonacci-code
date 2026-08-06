import React from "react";
import { render } from "ink";

import { doctorReport } from "./doctor.js";
import { App } from "./App.js";
import { help, parseArguments } from "./arguments.js";
import { authenticateGitHub, githubStatus } from "./github-auth.js";
import { readCliVersion } from "./version.js";

const VERSION = readCliVersion();

function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.kind === "help") {
    process.stdout.write(help());
    return;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`fibonacci ${VERSION}\n`);
    return;
  }
  if (parsed.kind === "doctor") {
    const report = doctorReport(parsed.options);
    process.stdout.write(`${report.text}\n`);
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (parsed.kind === "github") {
    if (parsed.action === "status") {
      const status = githubStatus();
      process.stdout.write(
        status.authenticated
          ? `GitHub authenticated${status.login ? ` as ${status.login}` : ""}.\n`
          : "GitHub is not authenticated. Run `fibonacci github login`.\n",
      );
      if (!status.authenticated) process.exitCode = 1;
      return;
    }

    const result = authenticateGitHub({ force: parsed.force });
    process.stdout.write(
      `${result.authenticatedNow ? "GitHub device authorization complete" : "GitHub login reused"} for ${result.login}.\n` +
        "Global Git credential integration is configured for GitHub and Gist.\n",
    );
    return;
  }

  render(<App {...parsed.options} />, {
    exitOnCtrlC: false,
    patchConsole: false,
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
