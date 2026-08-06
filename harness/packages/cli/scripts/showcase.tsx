import React from "react";
import { render } from "ink-testing-library";

import { FibonacciView } from "../src/components/FibonacciView.js";
import { showcaseState } from "../src/state/model.js";

const view = render(
  <FibonacciView
    state={showcaseState}
    cwd="/Users/you/Projects/remarkable-product"
    model="gpt-5.6-codex"
    sandbox="workspace-write"
    input=""
    width={92}
    focus={false}
    animate={false}
    onInput={() => undefined}
    onSubmit={() => undefined}
  />,
);

process.stdout.write(`${view.lastFrame()}\n`);
view.unmount();