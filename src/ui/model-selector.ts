import type { ModelInfo } from '../providers/types.ts';
import { FibonacciError } from '../errors.ts';
import { Style, supportsUnicode, visibleWidth } from './ansi.ts';

function truncateRight(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  const ellipsis = supportsUnicode() ? '…' : '...';
  const budget = Math.max(0, width - visibleWidth(ellipsis));
  let kept = '';
  let used = 0;
  for (const char of text) {
    const charWidth = visibleWidth(char);
    if (used + charWidth > budget) break;
    kept += char;
    used += charWidth;
  }
  return kept + ellipsis;
}

/** Render a compact, responsive menu suitable for stderr in an interactive REPL. */
export function modelMenu(models: ModelInfo[], current: string, terminalColumns: number): string {
  const width = Math.max(20, terminalColumns);
  const lines = [Style.bold('Select a model')];

  for (const [index, model] of models.entries()) {
    const marker = model.id === current ? Style.green(supportsUnicode() ? '●' : '*') : ' ';
    const suffix = model.id === current ? '  current' : '';
    const prefix = `  ${index + 1} ${marker} `;
    const idWidth = Math.max(4, width - visibleWidth(prefix) - visibleWidth(suffix));
    lines.push(`${prefix}${truncateRight(model.id, idWidth)}${Style.dim(suffix)}`);
  }

  lines.push(Style.dim('Enter a number or model id · q to cancel'));
  return lines.map((line) => truncateRight(line, width)).join('\n');
}

/** Turn selector input into a model id. Empty input keeps the current model. */
export function resolveModelChoice(input: string, models: ModelInfo[], current: string): string | undefined {
  const choice = input.trim();
  if (choice === '') return current;
  if (/^(q|quit|cancel|esc)$/i.test(choice)) return undefined;

  if (/^\d+$/.test(choice)) {
    const selected = models[Number.parseInt(choice, 10) - 1];
    if (selected) return selected.id;
  } else {
    const selected = models.find((model) => model.id === choice);
    if (selected) return selected.id;
  }

  throw new FibonacciError(`Unknown model selection "${choice}".`);
}
