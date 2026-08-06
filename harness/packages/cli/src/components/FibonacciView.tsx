import React from "react";
import { Box } from "ink";

import type { AppState } from "../state/model.js";
import { Composer } from "./Composer.js";
import { EmptyState } from "./EmptyState.js";
import { Header } from "./Header.js";
import { Transcript } from "./Transcript.js";

interface FibonacciViewProps {
  state: AppState;
  cwd: string;
  model?: string | undefined;
  sandbox: string;
  input: string;
  width: number;
  focus?: boolean | undefined;
  animate?: boolean | undefined;
  onInput: (value: string) => void;
  onSubmit: (value: string) => void;
}

export function FibonacciView({
  state,
  cwd,
  model,
  sandbox,
  input,
  width,
  focus = true,
  animate = true,
  onInput,
  onSubmit,
}: FibonacciViewProps) {
  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Header
        state={state}
        cwd={cwd}
        model={model}
        sandbox={sandbox}
        width={Math.max(52, width - 2)}
        animate={animate}
      />
      {state.transcript.length === 0 ? (
        <EmptyState />
      ) : (
        <Transcript items={state.transcript} />
      )}
      <Composer
        state={state}
        input={input}
        width={Math.max(20, width - 2)}
        focus={focus}
        onChange={onInput}
        onSubmit={onSubmit}
      />
    </Box>
  );
}
