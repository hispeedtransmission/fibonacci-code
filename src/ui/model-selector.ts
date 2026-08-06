import type { ModelInfo, Provider } from '../providers/types.ts';
import { FibonacciError } from '../errors.ts';
import { sanitizeInline, Style, supportsUnicode, visibleWidth } from './ansi.ts';

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function truncateRight(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  const ellipsis = supportsUnicode() ? '…' : '...';
  const budget = Math.max(0, width - visibleWidth(ellipsis));
  if (budget === 0) return ellipsis.slice(0, width);
  let kept = '';
  let used = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const charWidth = visibleWidth(segment);
    if (used + charWidth > budget) break;
    kept += segment;
    used += charWidth;
  }
  return kept + ellipsis;
}

/** Render a compact, responsive menu suitable for stderr in an interactive REPL. */
export function modelMenu(models: ModelInfo[], current: string, terminalColumns: number): string {
  const width = Math.max(1, terminalColumns);
  const lines = [Style.bold(truncateRight('FBNC / MODEL INDEX · Select a model', width))];
  const currentIndex = models.findIndex((model) => model.id === current);
  const visible = models.slice(0, 18).map((model, catalogIndex) => ({ model, catalogIndex }));
  if (currentIndex >= visible.length && visible.length > 0) {
    visible[visible.length - 1] = { model: models[currentIndex]!, catalogIndex: currentIndex };
  }

  for (const { model, catalogIndex } of visible) {
    const safeId = sanitizeInline(model.id);
    const marker = model.id === current ? Style.green(supportsUnicode() ? '●' : '*') : ' ';
    if (width < 12) {
      const rawPrefix = `${catalogIndex + 1}${marker} `;
      const prefix = truncateRight(rawPrefix, width);
      const remaining = width - visibleWidth(prefix);
      lines.push(remaining > 0 ? `${prefix}${truncateRight(safeId, remaining)}` : prefix);
      continue;
    }

    const suffix = model.id === current && width >= 24 ? '  current' : '';
    const prefix = `  ${catalogIndex + 1} ${marker} `;
    const idWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
    lines.push(`${prefix}${truncateRight(safeId, idWidth)}${Style.dim(suffix)}`);
  }

  const hidden = models.length - visible.length;
  const hint =
    width <= 24
      ? hidden > 0
        ? `${hidden} more · q cancel`
        : 'q cancel · # or id'
      : hidden > 0
        ? `${hidden} more · enter exact model id · q cancel`
        : 'Enter a number or model id · q to cancel';
  lines.push(Style.dim(truncateRight(hint, width)));
  return lines.join('\n');
}

/** Turn selector input into a model id. Empty input keeps the current model. */
export function resolveModelChoice(input: string, models: ModelInfo[], current: string): string | undefined {
  const choice = input.trim();
  if (choice === '') return current;

  if (/^\d+$/.test(choice)) {
    const selected = models[Number.parseInt(choice, 10) - 1];
    if (selected) return selected.id;
  } else {
    const selected = models.find((model) => model.id === choice);
    if (selected) return selected.id;
    if (/^(q|quit|cancel|esc)$/i.test(choice)) return undefined;
  }

  throw new FibonacciError(`Unknown model selection "${choice}".`);
}

/** Validate a direct model id only when the provider promises a complete catalog. */
export async function resolveRequestedModel(provider: Provider, requested: string): Promise<string> {
  const model = requested.trim();
  if (model === '') throw new FibonacciError('Model id cannot be empty.');
  if (!provider.modelListIsAuthoritative) return model;

  const models = await provider.listModels();
  if (!models.some((candidate) => candidate.id === model)) {
    throw new FibonacciError(`Model "${model}" is not available for ${provider.label}.`);
  }
  return model;
}
