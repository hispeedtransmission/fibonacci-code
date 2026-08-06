import React, { useEffect, useState } from "react";
import { Text } from "ink";

import type { RunPhase } from "../protocol.js";
import { palette, sequence } from "../theme.js";

interface SequenceRailProps {
  phase: RunPhase;
  animate?: boolean | undefined;
}

const activeByPhase: Record<RunPhase, number> = {
  ready: 0,
  thinking: 2,
  acting: 4,
  verifying: 6,
  stopped: 0,
  failed: 6,
};

export function SequenceRail({ phase, animate = true }: SequenceRailProps) {
  const [pulse, setPulse] = useState(true);
  const activeIndex = activeByPhase[phase];
  const moving = ["thinking", "acting", "verifying"].includes(phase);

  useEffect(() => {
    if (!animate || !moving) return undefined;
    const timer = setInterval(() => setPulse((current) => !current), 460);
    return () => clearInterval(timer);
  }, [animate, moving]);

  return (
    <Text>
      <Text color={palette.surgicalCyan} bold>
        TRACE {String(activeIndex + 1).padStart(2, "0")}/07{"  "}
      </Text>
      {sequence.map((value, index) => {
        const active = index <= activeIndex;
        const cursor = moving && index === activeIndex;
        const color =
          phase === "failed" && active
            ? palette.fault
            : active
              ? phase === "verifying"
                ? palette.verified
                : phase === "acting"
                  ? palette.incisionOrange
                  : palette.surgicalCyan
              : palette.telemetry;
        return (
          <React.Fragment key={`${value}-${index}`}>
            {index > 0 ? (
              <Text color={color}>{index <= activeIndex ? "━" : "─"}</Text>
            ) : null}
            <Text
              color={color}
              bold={active && (!cursor || pulse)}
              dimColor={!active}
              inverse={cursor && pulse}
            >
              {String(value).padStart(2, "0")}
            </Text>
          </React.Fragment>
        );
      })}
    </Text>
  );
}
