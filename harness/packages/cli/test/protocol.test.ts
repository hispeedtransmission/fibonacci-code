import { describe, expect, it } from "vitest";

import { parseCoreEvent } from "../src/protocol.js";

describe("parseCoreEvent", () => {
  it("accepts a v1 event", () => {
    expect(
      parseCoreEvent('{"v":1,"type":"phase","phase":"thinking","label":"Thinking"}'),
    ).toEqual({ v: 1, type: "phase", phase: "thinking", label: "Thinking" });
  });

  it("rejects unknown or malformed events", () => {
    expect(parseCoreEvent("not json")).toBeUndefined();
    expect(parseCoreEvent('{"v":2,"type":"phase"}')).toBeUndefined();
    expect(parseCoreEvent('{"v":1,"type":"future"}')).toBeUndefined();
  });
});