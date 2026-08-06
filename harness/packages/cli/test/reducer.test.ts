import { describe, expect, it } from "vitest";

import { initialState, reducer } from "../src/state/model.js";

describe("Fibonacci state reducer", () => {
  it("upserts activity updates instead of duplicating them", () => {
    const started = reducer(initialState, {
      type: "core_event",
      event: {
        v: 1,
        type: "activity",
        id: "command-1",
        label: "pnpm test",
        status: "running",
      },
    });
    const completed = reducer(started, {
      type: "core_event",
      event: {
        v: 1,
        type: "activity",
        id: "command-1",
        label: "pnpm test",
        status: "completed",
      },
    });

    expect(completed.transcript).toHaveLength(1);
    expect(completed.transcript[0]).toMatchObject({
      id: "command-1",
      status: "completed",
    });
  });

  it("appends streamed message deltas without replacing the full response", () => {
    const started = reducer(initialState, {
      type: "core_event",
      event: {
        v: 1,
        type: "message_delta",
        id: "openai-response",
        delta: "Hello",
      },
    });
    const completed = reducer(started, {
      type: "core_event",
      event: {
        v: 1,
        type: "message_delta",
        id: "openai-response",
        delta: " world",
      },
    });

    expect(completed.transcript).toContainEqual({
      id: "openai-response",
      kind: "assistant",
      text: "Hello world",
    });
  });

  it("keeps streamed responses from separate turns distinct", () => {
    const firstUser = reducer(initialState, {
      type: "submitted",
      id: "user-1",
      text: "first",
    });
    const firstResponse = reducer(firstUser, {
      type: "core_event",
      event: {
        v: 1,
        type: "message_delta",
        id: "response-1",
        delta: "one",
      },
    });
    const ready = reducer(firstResponse, {
      type: "core_event",
      event: { v: 1, type: "done", outcome: "completed", elapsed_ms: 1 },
    });
    const secondUser = reducer(ready, {
      type: "submitted",
      id: "user-2",
      text: "second",
    });
    const secondResponse = reducer(secondUser, {
      type: "core_event",
      event: {
        v: 1,
        type: "message_delta",
        id: "response-2",
        delta: "two",
      },
    });

    expect(secondResponse.transcript).toMatchObject([
      { id: "user-1", text: "first" },
      { id: "response-1", text: "one" },
      { id: "user-2", text: "second" },
      { id: "response-2", text: "two" },
    ]);
  });

  it("preserves a provider session across turns", () => {
    const state = reducer(initialState, {
      type: "core_event",
      event: { v: 1, type: "session", id: "thread-123" },
    });

    expect(state.session).toBe("thread-123");
  });

  it("returns to ready when a turn completes", () => {
    const busy = { ...initialState, busy: true, phase: "acting" as const };
    const state = reducer(busy, {
      type: "core_event",
      event: { v: 1, type: "done", outcome: "completed", elapsed_ms: 812 },
    });

    expect(state).toMatchObject({
      busy: false,
      phase: "ready",
      lastOutcome: "completed",
      elapsedMs: 812,
    });
  });
});