import React, { useCallback, useMemo, useReducer, useRef, useState } from "react";
import { randomUUID } from "node:crypto";
import { useApp, useInput } from "ink";

import { FibonacciView } from "./components/FibonacciView.js";
import {
  CoreClient,
  findCodexExecutable,
  type RunHandle,
  type RunRequest,
} from "./runtime/core-client.js";
import { initialState, reducer } from "./state/model.js";

export interface AppOptions {
  cwd: string;
  provider: "codex" | "openai-compatible";
  model?: string | undefined;
  core?: string | undefined;
  baseUrl?: string | undefined;
  codexBin?: string | undefined;
  sandbox: RunRequest["sandbox"];
}

const HELP = [
  "/help          show this reference",
  "/clear         clear the visible transcript",
  "/new           start a fresh provider session",
  "/model <name>  change the model for the next turn",
  "/quit          exit Fibonacci",
  "Esc            stop an active turn",
].join("\n");

export function App(options: AppOptions) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, initialState);
  const [input, setInput] = useState("");
  const [model, setModel] = useState<string | undefined>(options.model);
  const [width, setWidth] = useState(() => terminalWidth());
  const activeRun = useRef<RunHandle | undefined>(undefined);
  const client = useMemo(() => new CoreClient(options.core), [options.core]);

  React.useEffect(() => {
    const resize = () => setWidth(terminalWidth());
    process.stdout.on("resize", resize);
    return () => {
      process.stdout.off("resize", resize);
    };
  }, []);

  React.useEffect(
    () => () => {
      activeRun.current?.cancel();
    },
    [],
  );

  const notice = useCallback(
    (text: string, level: "info" | "warning" = "info") => {
      dispatch({ type: "notice", id: randomUUID(), level, text });
    },
    [],
  );

  const submit = useCallback(
    (raw: string) => {
      const prompt = raw.trim();
      if (!prompt || state.busy) return;
      setInput("");

      if (prompt.startsWith("/")) {
        const [command, ...args] = prompt.slice(1).split(/\s+/);
        switch (command?.toLowerCase()) {
          case "help":
            notice(HELP);
            return;
          case "clear":
            dispatch({ type: "clear" });
            return;
          case "new":
            dispatch({ type: "new_session" });
            return;
          case "model": {
            const nextModel = args.join(" ").trim();
            if (!nextModel) {
              notice(`Model: ${model ?? "configured Codex default"}`);
              return;
            }
            setModel(nextModel);
            notice(`Model set to ${nextModel} for the next turn.`);
            return;
          }
          case "quit":
          case "exit":
            exit();
            return;
          default:
            notice(`Unknown command: /${command ?? ""}. Use /help.`, "warning");
            return;
        }
      }

      dispatch({ type: "submitted", id: randomUUID(), text: prompt });
      try {
        const handle = client.run(
          {
            prompt,
            cwd: options.cwd,
            sandbox: options.sandbox,
            provider: options.provider,
            ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
            ...(options.codexBin === undefined
              ? (() => {
                  const codexBin = findCodexExecutable();
                  return codexBin === undefined ? {} : { codexBin };
                })()
              : { codexBin: options.codexBin }),
            ...(model === undefined ? {} : { model }),
            ...(state.session === undefined ? {} : { session: state.session }),
          },
          (event) => dispatch({ type: "core_event", event }),
        );
        activeRun.current = handle;
        void handle.done
          .catch((error: unknown) => {
            dispatch({
              type: "local_error",
              id: randomUUID(),
              text: "The Fibonacci core stopped unexpectedly.",
              detail: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            activeRun.current = undefined;
          });
      } catch (error) {
        dispatch({
          type: "local_error",
          id: randomUUID(),
          text: "The Fibonacci core could not start.",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [client, exit, model, notice, options.cwd, options.sandbox, state.busy, state.session],
  );

  useInput((character, key) => {
    if (state.busy && (key.escape || (key.ctrl && character === "c"))) {
      dispatch({ type: "cancel_requested" });
      activeRun.current?.cancel();
      return;
    }
    if (key.ctrl && character === "l") {
      dispatch({ type: "clear" });
      return;
    }
    if (!state.busy && key.ctrl && character === "d" && input.length === 0) {
      exit();
      return;
    }
    if (!state.busy && key.ctrl && character === "c") {
      if (input.length > 0) setInput("");
      else exit();
    }
  });

  return (
    <FibonacciView
      state={state}
      cwd={options.cwd}
      model={model}
      sandbox={options.sandbox}
      input={input}
      width={width}
      onInput={setInput}
      onSubmit={submit}
    />
  );
}

function terminalWidth(): number {
  return Math.max(56, Math.min(process.stdout.columns ?? 92, 120));
}
