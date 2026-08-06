import { describe, expect, it } from "vitest";

import { readCliVersion } from "../src/version.js";

describe("CLI version", () => {
  it("comes from the package manifest", () => {
    expect(readCliVersion()).toBe("0.1.0");
  });
});
