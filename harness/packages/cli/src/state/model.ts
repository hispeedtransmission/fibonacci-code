import type {
  ActivityStatus,
  CoreEvent,
  Outcome,
  RunPhase,
} from "../protocol.js";

export type TranscriptItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "thought"; text: string }
  | {
      id: string;
      kind: "activity";
      label: string;
      detail?: string;
      status: ActivityStatus;
    }
  | { id: string; kind: "notice"; level: "info" | "warning"; text: string }
  | { id: string; kind: "error"; text: string; detail?: string };

export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface AppState {
  transcript: TranscriptItem[];
  phase: RunPhase;
  phaseLabel: string;
  busy: boolean;
  provider: string;
  session: string | undefined;
  usage: Usage | undefined;
  lastOutcome: Outcome | undefined;
  elapsedMs: number | undefined;
}

export type AppAction =
  | { type: "submitted"; id: string; text: string }
  | { type: "core_event"; event: CoreEvent }
  | { type: "notice"; id: string; level?: "info" | "warning"; text: string }
  | { type: "local_error"; id: string; text: string; detail?: string }
  | { type: "clear" }
  | { type: "new_session" }
  | { type: "cancel_requested" };

export const initialState: AppState = {
  transcript: [],
  phase: "ready",
  phaseLabel: "Ready",
  busy: false,
  provider: "codex",
  session: undefined,
  usage: undefined,
  lastOutcome: undefined,
  elapsedMs: undefined,
};

export const showcaseState: AppState = {
  transcript: [
    {
      id: "showcase-user",
      kind: "user",
      text: "Repair the provider resume path, then prove the session survives.",
    },
    {
      id: "showcase-thought",
      kind: "thought",
      text: "Transport isolated. The session ID is dropped at the process boundary.",
    },
    {
      id: "showcase-tool-1",
      kind: "activity",
      label: "Patched Rust → JSONL session handoff",
      status: "completed",
    },
    {
      id: "showcase-tool-2",
      kind: "activity",
      label: "cargo test --workspace && pnpm check",
      status: "running",
    },
  ],
  phase: "verifying",
  phaseLabel: "Verifying",
  busy: true,
  provider: "codex",
  session: undefined,
  usage: {
    inputTokens: 12_840,
    cachedInputTokens: 9_120,
    outputTokens: 1_477,
    reasoningOutputTokens: 603,
  },
  lastOutcome: undefined,
  elapsedMs: undefined,
};

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "submitted":
      return {
        ...state,
        transcript: [
          ...state.transcript,
          { id: action.id, kind: "user", text: action.text },
        ],
        phase: "thinking",
        phaseLabel: "Starting",
        busy: true,
        lastOutcome: undefined,
        elapsedMs: undefined,
      };
    case "core_event":
      return reduceCoreEvent(state, action.event);
    case "notice":
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            id: action.id,
            kind: "notice",
            level: action.level ?? "info",
            text: action.text,
          },
        ],
      };
    case "local_error":
      return {
        ...state,
        busy: false,
        phase: "failed",
        phaseLabel: "Could not start",
        transcript: [
          ...state.transcript,
          {
            id: action.id,
            kind: "error",
            text: action.text,
            ...(action.detail === undefined ? {} : { detail: action.detail }),
          },
        ],
      };
    case "clear":
      return { ...state, transcript: [] };
    case "new_session":
      return {
        ...state,
        session: undefined,
        usage: undefined,
        lastOutcome: undefined,
        elapsedMs: undefined,
        transcript: [
          ...state.transcript,
          {
            id: `new-session-${Date.now()}`,
            kind: "notice",
            level: "info",
            text: "New provider session. The visible transcript is unchanged.",
          },
        ],
      };
    case "cancel_requested":
      return { ...state, phaseLabel: "Stopping" };
  }
}

function reduceCoreEvent(state: AppState, event: CoreEvent): AppState {
  switch (event.type) {
    case "run_started":
      return { ...state, provider: event.provider, busy: true };
    case "session":
      return { ...state, session: event.id };
    case "phase":
      return {
        ...state,
        phase: event.phase,
        phaseLabel: event.label,
        busy: !["ready", "stopped", "failed"].includes(event.phase),
      };
    case "message":
      return {
        ...state,
        transcript: upsert(state.transcript, {
          id: event.id,
          kind: "assistant",
          text: event.text,
        }),
      };
    case "message_delta":
      return {
        ...state,
        transcript: appendMessageDelta(
          state.transcript,
          event.id,
          event.delta,
        ),
      };
    case "thought":
      return {
        ...state,
        transcript: upsert(state.transcript, {
          id: event.id,
          kind: "thought",
          text: event.text,
        }),
      };
    case "activity":
      return {
        ...state,
        transcript: upsert(state.transcript, {
          id: event.id,
          kind: "activity",
          label: event.label,
          status: event.status,
          ...(event.detail === undefined ? {} : { detail: event.detail }),
        }),
      };
    case "usage":
      return {
        ...state,
        usage: {
          inputTokens: event.input_tokens,
          cachedInputTokens: event.cached_input_tokens,
          outputTokens: event.output_tokens,
          reasoningOutputTokens: event.reasoning_output_tokens,
        },
      };
    case "notice":
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            id: `notice-${state.transcript.length}`,
            kind: "notice",
            level: event.level,
            text: event.text,
          },
        ],
      };
    case "error":
      return {
        ...state,
        phase: "failed",
        phaseLabel: "Failed",
        transcript: [
          ...state.transcript,
          {
            id: `error-${event.code}-${state.transcript.length}`,
            kind: "error",
            text: event.message,
            ...(event.detail === undefined ? {} : { detail: event.detail }),
          },
        ],
      };
    case "done":
      return {
        ...state,
        busy: false,
        phase:
          event.outcome === "completed"
            ? "ready"
            : event.outcome === "stopped"
              ? "stopped"
              : "failed",
        phaseLabel:
          event.outcome === "completed"
            ? "Ready"
            : event.outcome === "stopped"
              ? "Stopped"
              : "Failed",
        lastOutcome: event.outcome,
        elapsedMs: event.elapsed_ms,
      };
  }
}

function appendMessageDelta(
  transcript: TranscriptItem[],
  id: string,
  delta: string,
): TranscriptItem[] {
  const index = transcript.findIndex((candidate) => candidate.id === id);
  if (index === -1) {
    return [...transcript, { id, kind: "assistant", text: delta }];
  }
  return transcript.map((candidate, candidateIndex) => {
    if (candidateIndex !== index || candidate.kind !== "assistant") {
      return candidate;
    }
    return { ...candidate, text: candidate.text + delta };
  });
}

function upsert(
  transcript: TranscriptItem[],
  item: TranscriptItem,
): TranscriptItem[] {
  const index = transcript.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...transcript, item];
  return transcript.map((candidate, candidateIndex) =>
    candidateIndex === index ? item : candidate,
  );
}
