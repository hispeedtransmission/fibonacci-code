import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { doctorReport } from "../src/doctor.js";

describe("doctorReport", () => {
  it("passes when the core, Codex executable, and auth marker are present", () => {
    const home = mkdtempSync(join(tmpdir(), "fibonacci-doctor-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    const core = join(bin, "fibonacci-core");
    const codex = join(bin, "codex");
    writeFileSync(core, "#!/bin/sh\nexit 0\n");
    writeFileSync(codex, "#!/bin/sh\nexit 0\n");
    chmodSync(core, 0o755);
    chmodSync(codex, 0o755);
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "auth.json"), "{}\n");

    const report = doctorReport({
      core,
      environment: { HOME: home, PATH: bin },
      provider: "codex",
    });

    expect(report.ok).toBe(true);
    expect(report.text).toContain("Codex executable: OK");
    expect(report.text).toContain("Codex auth marker: OK");
  });

  it("reports a useful failure when Codex is unavailable", () => {
    const home = mkdtempSync(join(tmpdir(), "fibonacci-doctor-"));
    const report = doctorReport({
      core: "/missing/fibonacci-core",
      environment: { HOME: home, PATH: "" },
      provider: "codex",
    });

    expect(report.ok).toBe(false);
    expect(report.text).toContain("Core executable: FAIL");
    expect(report.text).toContain("Codex executable: FAIL");
    expect(report.text).toContain("npm install --global @openai/codex");
  });

  it("uses explicit provider paths and URLs before environment defaults", () => {
    const home = mkdtempSync(join(tmpdir(), "fibonacci-doctor-"));
    const core = join(home, "fibonacci-core");
    const codex = join(home, "custom-codex");
    writeFileSync(core, "#!/bin/sh\nexit 0\n");
    writeFileSync(codex, "#!/bin/sh\nexit 0\n");
    chmodSync(core, 0o755);
    chmodSync(codex, 0o755);

    const codexReport = doctorReport({
      core,
      codexBin: codex,
      environment: { HOME: home, PATH: "" },
      provider: "codex",
    });
    const gatewayReport = doctorReport({
      core,
      baseUrl: "https://gateway.example/v1",
      environment: {
        HOME: home,
        FIBONACCI_OPENAI_BASE_URL: "not-a-url",
      },
      provider: "openai-compatible",
    });

    expect(codexReport.text).toContain(`Codex executable: OK (${codex})`);
    expect(gatewayReport.text).toContain(
      "OpenAI-compatible base URL: OK (https://gateway.example/v1)",
    );
  });
});
