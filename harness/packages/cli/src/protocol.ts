export type RunPhase =
  | "ready"
  | "thinking"
  | "acting"
  | "verifying"
  | "stopped"
  | "failed";

export type ActivityStatus = "running" | "completed" | "failed";
export type Outcome = "completed" | "stopped" | "failed";

type VersionedEvent = { v: 1 };

export type CoreEvent = VersionedEvent &
  (
    | { type: "run_started"; provider: string; cwd: string; resumed: boolean }
    | { type: "session"; id: string }
    | { type: "phase"; phase: RunPhase; label: string }
    | { type: "message"; id: string; text: string }
    | { type: "message_delta"; id: string; delta: string }
    | { type: "thought"; id: string; text: string }
    | {
        type: "activity";
        id: string;
        label: string;
        detail?: string;
        status: ActivityStatus;
      }
    | {
        type: "usage";
        input_tokens: number;
        cached_input_tokens: number;
        output_tokens: number;
        reasoning_output_tokens: number;
      }
    | { type: "notice"; level: "info" | "warning"; text: string }
    | { type: "error"; code: string; message: string; detail?: string }
    | { type: "done"; outcome: Outcome; elapsed_ms: number }
  );

const EVENT_TYPES = new Set([
  "run_started",
  "session",
  "phase",
  "message",
  "message_delta",
  "thought",
  "activity",
  "usage",
  "notice",
  "error",
  "done",
]);

export function parseCoreEvent(line: string): CoreEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (
      typeof value !== "object" ||
      value === null ||
      !("v" in value) ||
      value.v !== 1 ||
      !("type" in value) ||
      typeof value.type !== "string" ||
      !EVENT_TYPES.has(value.type)
    ) {
      return undefined;
    }
    return value as CoreEvent;
  } catch {
    return undefined;
  }
}