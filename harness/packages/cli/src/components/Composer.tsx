import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

import type { AppState } from "../state/model.js";
import { palette } from "../theme.js";

interface ComposerProps {
  state: AppState;
  input: string;
  width: number;
  focus: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}

export function Composer({
  state,
  input,
  width,
  focus,
  onChange,
  onSubmit,
}: ComposerProps) {
  return (
    <Box flexDirection="column" marginTop={1} width={width}>
      <Box
        flexDirection="column"
        width={width}
        paddingX={1}
        borderStyle="single"
        borderColor={state.busy ? palette.surgicalCyan : palette.incisionOrange}
      >
        <Box justifyContent="space-between">
          <Text color={palette.incisionOrange} bold>
            DIRECTIVE
          </Text>
          <Text color={state.busy ? palette.surgicalCyan : palette.verified} bold>
            [ {state.busy ? "BUSY" : "ARMED"} ]
          </Text>
        </Box>
        <Box>
          <Text
            color={state.busy ? palette.telemetry : palette.incisionOrange}
            bold
          >
            ›{" "}
          </Text>
          {state.busy ? (
            <Text color={palette.telemetry}>Trace active. Esc stops this turn.</Text>
          ) : (
            <TextInput
              value={input}
              onChange={onChange}
              onSubmit={onSubmit}
              placeholder="State the outcome"
              focus={focus}
            />
          )}
        </Box>
      </Box>
      <Box justifyContent="space-between">
        <Text color={palette.telemetry} dimColor>
          esc stop · ctrl+l clear · /help
        </Text>
        <Text color={palette.telemetry} dimColor>
          {usageLabel(state)}
        </Text>
      </Box>
    </Box>
  );
}

function usageLabel(state: AppState): string {
  const parts: string[] = [];
  if (state.usage) {
    parts.push(
      `${formatCount(state.usage.inputTokens)} in`,
      `${formatCount(state.usage.outputTokens)} out`,
    );
  }
  if (state.elapsedMs !== undefined) {
    parts.push(`${(state.elapsedMs / 1000).toFixed(1)}s`);
  }
  return parts.length > 0 ? parts.join(" · ") : "protocol v1";
}

function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value / 1_000)}k`;
}
