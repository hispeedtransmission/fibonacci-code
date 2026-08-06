import React from "react";
import { homedir } from "node:os";
import { Box, Text } from "ink";

import type { AppState } from "../state/model.js";
import { palette } from "../theme.js";
import { SequenceRail } from "./SequenceRail.js";

interface HeaderProps {
  state: AppState;
  cwd: string;
  model?: string | undefined;
  sandbox: string;
  width: number;
  animate?: boolean | undefined;
}

export function Header({
  state,
  cwd,
  model,
  sandbox,
  width,
  animate,
}: HeaderProps) {
  const wide = width >= 76;
  const link = `${state.provider}::${model ?? "configured"}`;
  const field = sandbox.replaceAll("-", " ");
  const session = state.session ? state.session.slice(0, 8) : "new";

  return (
    <Box
      flexDirection="column"
      width={width}
      marginBottom={1}
      paddingX={1}
      borderStyle="single"
      borderColor={phaseColor(state.phase)}
    >
      <Box justifyContent="space-between">
        <Text>
          <Text color={palette.phosphor} bold>
            FIBONACCI
          </Text>
          <Text color={palette.surgicalCyan}> // </Text>
          <Text color={palette.telemetry}>AGENTIC TERMINAL</Text>
        </Text>
        <Text color={phaseColor(state.phase)} bold>
          [ {statusLabel(state.phaseLabel)} ]
        </Text>
      </Box>
      <SequenceRail phase={state.phase} animate={animate} />
      {wide ? (
        <Box justifyContent="space-between">
          <Telemetry label="LINK" value={truncateEnd(link, Math.floor(width * 0.48))} />
          <Telemetry label="FIELD" value={field} />
        </Box>
      ) : (
        <>
          <Telemetry label="LINK" value={truncateEnd(link, width - 12)} />
          <Telemetry label="FIELD" value={field} />
        </>
      )}
      <Box justifyContent="space-between">
        <Telemetry
          label="SITE"
          value={truncateMiddle(compactPath(cwd), wide ? width - 28 : width - 22)}
        />
        <Telemetry label="SESSION" value={session} />
      </Box>
    </Box>
  );
}

function Telemetry({ label, value }: { label: string; value: string }) {
  return (
    <Text>
      <Text color={palette.surgicalCyan} bold>
        {label}{" "}
      </Text>
      <Text color={palette.telemetry}>{value}</Text>
    </Text>
  );
}

function compactPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function phaseColor(phase: AppState["phase"]): string {
  if (phase === "failed") return palette.fault;
  if (phase === "verifying" || phase === "ready") return palette.verified;
  if (phase === "stopped") return palette.warning;
  if (phase === "acting") return palette.incisionOrange;
  return palette.surgicalCyan;
}

function statusLabel(label: string): string {
  return truncateEnd(label.toUpperCase(), 12);
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
