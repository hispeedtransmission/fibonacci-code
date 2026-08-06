import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { FibonacciView } from "../src/components/FibonacciView.js";
import { showcaseState } from "../src/state/model.js";

describe("Fibonacci terminal view", () => {
  it("renders the diagnostic identity, state trace, activity, trust, and controls", () => {
    const view = render(
      <FibonacciView
        state={showcaseState}
        cwd="/tmp/fibonacci-fixture"
        model="test-model"
        sandbox="workspace-write"
        input=""
        width={88}
        focus={false}
        animate={false}
        onInput={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    const frame = view.lastFrame();
    expect(frame).toContain("FIBONACCI // AGENTIC TERMINAL");
    expect(frame).toContain("TRACE 07/07");
    expect(frame).toContain("01━01━02━03━05━08━13");
    expect(frame).toContain("[ VERIFYING ]");
    expect(frame).toContain("LINK codex::test-model");
    expect(frame).toContain("FIELD workspace write");
    expect(frame).toContain("LIVE");
    expect(frame).toContain("cargo test --workspace && pnpm check");
    expect(frame).toContain("DIRECTIVE");
    expect(frame).toContain("esc stop · ctrl+l clear · /help");
    view.unmount();
  });

  it("keeps the holodeck frame inside a narrow terminal", () => {
    const view = render(
      <FibonacciView
        state={showcaseState}
        cwd="/tmp/a-project-with-a-deliberately-long-name"
        model="a-very-long-model-name-for-layout-testing"
        sandbox="workspace-write"
        input=""
        width={56}
        focus={false}
        animate={false}
        onInput={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("[ VERIFYING ]");
    expect(frame).toContain("DIRECTIVE");
    expect(Math.max(...frame.split("\n").map((line) => line.length))).toBeLessThanOrEqual(56);
    view.unmount();
  });
});
