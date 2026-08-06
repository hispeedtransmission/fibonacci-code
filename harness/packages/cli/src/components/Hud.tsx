import React from "react";
import { homedir } from "node:os";
import { Box, Text } from "ink";

import type { AppState } from "../state/model.js";
import { palette } from "../theme.js";

interface HudProps {
  state: AppState;
  cwd: string;
  model?: string | undefined;
  sandbox: string;
  width: number;
}

export function Hud({ state, cwd, model, sandbox, width }: HudProps) {
  const wide = width >= 76;
  const context = contextLabel(state);
  const session = state.session ? state.session.slice(0, 8) : "new";

  return (
    <Box
      flexDirection="column"
      width={width}
      paddingX={1}
      borderStyle="single"
      borderColor={palette.telemetry}
    >
      <Box justifyContent="space-between">
        <Text color={palette.surgicalCyan} bold>
          SYSTEM HUD
        </Text>
        <Text color={palette.telemetry}>ctrl+m model · /help</Text>
      </Box>
      {wide ? (
        <Box justifyContent="space-between">
          <Telemetry
            label="MODEL"
            value={`[ ${truncateEnd(model ?? "configured default", Math.floor(width * 0.4))} ]`}
          />
          <Telemetry label="CONTEXT" value={context} />
        </Box>
      ) : (
        <>
          <Telemetry label="MODEL" value={`[ ${truncateEnd(model ?? "configured default", width - 14)} ]`} />
          <Telemetry label="CONTEXT" value={context} />
        </>
      )}
      <Box justifyContent="space-between">
        <Telemetry
          label="SITE"
          value={truncateMiddle(compactPath(cwd), wide ? width - 38 : width - 29)}
        />
        <Telemetry label="FIELD" value={sandbox.replaceAll("-", " ")} />
        {wide ? <Telemetry label="SESSION" value={session} /> : null}
      </Box>
      {!wide ? <Telemetry label="SESSION" value={session} /> : null}
    </Box>
  );
}

function Telemetry({ label, value }: { label: string; value: string }) {
  return (
    <Text wrap="truncate-end">
      <Text color={palette.surgicalCyan} bold>
        {label}{" "}
      </Text>
      <Text color={palette.telemetry}>{value}</Text>
    </Text>
  );
}

function contextLabel(state: AppState): string {
  if (!state.usage) return "waiting for usage";
  const parts = [`${formatCount(state.usage.inputTokens)} in`];
  if (state.usage.cachedInputTokens > 0) {
    parts.push(`${formatCount(state.usage.cachedInputTokens)} cached`);
  }
  parts.push(`${formatCount(state.usage.outputTokens)} out`);
  if (state.usage.reasoningOutputTokens > 0) {
    parts.push(`${formatCount(state.usage.reasoningOutputTokens)} reasoning`);
  }
  return parts.join(" · ");
}

function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value / 1_000)}k`;
}

function compactPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function truncateEnd(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return value.slice(0, Math.max(0, maxLength));
  return `${value.slice(0, maxLength - 1)}…`;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return truncateEnd(value, maxLength);
  const left = Math.ceil((maxLength - 1) / 2);
  const right = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}
