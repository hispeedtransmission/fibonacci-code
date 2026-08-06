import React from "react";
import { Box, Text } from "ink";

import type { TranscriptItem } from "../state/model.js";
import { palette } from "../theme.js";

interface TranscriptProps {
  items: TranscriptItem[];
}

export function Transcript({ items }: TranscriptProps) {
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <TranscriptRow key={item.id} item={item} />
      ))}
    </Box>
  );
}

function TranscriptRow({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginBottom={1}>
          <Box width={7} flexShrink={0}>
            <Text color={palette.incisionOrange} bold>
              YOU//
            </Text>
          </Box>
          <Text color={palette.phosphor}>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginBottom={1}>
          <Box width={7} flexShrink={0}>
            <Text color={palette.surgicalCyan} bold>
              FIB//
            </Text>
          </Box>
          <Text color={palette.phosphor}>{item.text}</Text>
        </Box>
      );
    case "thought":
      return (
        <Box>
          <Box width={7} flexShrink={0}>
            <Text color={palette.telemetry} bold>
              TRACE
            </Text>
          </Box>
          <Text color={palette.telemetry}>{firstParagraph(item.text)}</Text>
        </Box>
      );
    case "activity": {
      const failed = item.status === "failed";
      const color = failed
        ? palette.fault
        : item.status === "completed"
          ? palette.verified
          : palette.surgicalCyan;
      const label = failed ? "FAIL" : item.status === "completed" ? "PASS" : "LIVE";
      return (
        <Box flexDirection="column">
          <Box>
            <Box width={7} flexShrink={0}>
              <Text color={color} bold>
                {label}
              </Text>
            </Box>
            <Text color={item.status === "running" ? palette.phosphor : palette.telemetry}>
              {item.label}
            </Text>
          </Box>
          {failed && item.detail ? (
            <Box marginLeft={7}>
              <Text color={palette.fault} dimColor>
                {firstLines(item.detail, 3)}
              </Text>
            </Box>
          ) : null}
        </Box>
      );
    }
    case "notice":
      return (
        <Box>
          <Box width={7} flexShrink={0}>
            <Text
              color={item.level === "warning" ? palette.warning : palette.telemetry}
              bold
            >
              {item.level === "warning" ? "WARN" : "NOTE"}
            </Text>
          </Box>
          <Text color={item.level === "warning" ? palette.warning : palette.telemetry}>
            {item.text}
          </Text>
        </Box>
      );
    case "error":
      return (
        <Box flexDirection="column">
          <Box>
            <Box width={7} flexShrink={0}>
              <Text color={palette.fault} bold>
                FAULT
              </Text>
            </Box>
            <Text color={palette.fault}>{item.text}</Text>
          </Box>
          {item.detail ? (
            <Box marginLeft={7}>
              <Text color={palette.telemetry}>{firstLines(item.detail, 5)}</Text>
            </Box>
          ) : null}
        </Box>
      );
  }
}

function firstParagraph(value: string): string {
  return value.split(/\n\s*\n/, 1)[0] ?? value;
}

function firstLines(value: string, count: number): string {
  return value.split("\n").slice(0, count).join("\n");
}
