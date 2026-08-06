import React from "react";
import { Box, Text } from "ink";

import { palette } from "../theme.js";

export function EmptyState() {
  return (
    <Box flexDirection="column" marginY={1} paddingX={1}>
      <Text>
        <Text color={palette.surgicalCyan} bold>
          NO ACTIVE TRACE
        </Text>
        <Text color={palette.telemetry}> / SYSTEM READY</Text>
      </Text>
      <Text color={palette.phosphor}>
        State the outcome. Fibonacci maps the field, acts, and verifies.
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color={palette.incisionOrange}>SEED 01  </Text>
          <Text color={palette.telemetry}>Fix the failing test and explain the cause</Text>
        </Text>
        <Text>
          <Text color={palette.incisionOrange}>SEED 02  </Text>
          <Text color={palette.telemetry}>Map this repository before changing anything</Text>
        </Text>
      </Box>
    </Box>
  );
}
