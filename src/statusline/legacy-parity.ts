import type { NextTuiStatusLineInput } from '../tui/chat/status-line.js';
import { formatNextTuiStatusLine } from '../tui/chat/status-line.js';
import { renderStatusline, type StatuslineSnapshot } from './evaluate.js';
import { parseStatuslineYaml } from './load.js';
import { DEFAULT_STATUSLINE_YAML } from './default-definition.js';
import type { StatuslineDefinition } from './schema.js';

function seconds(elapsedMs: number | undefined): string | undefined {
  if (elapsedMs === undefined) return undefined;
  return `${(Math.max(0, elapsedMs) / 1000).toFixed(1)}s`;
}

function tokens(input: NextTuiStatusLineInput): string {
  const usage = input.measuredUsage;
  const estimate = input.estimatedOutputTokens;
  if (usage?.outputTokens === undefined && estimate !== undefined && Number.isSafeInteger(estimate) && estimate >= 0) {
    return usage?.inputTokens !== undefined ? `${usage.inputTokens}/est.${estimate}` : `est.${estimate}`;
  }
  return `${usage?.inputTokens ?? '?'}/${usage?.outputTokens ?? '?'}`;
}

/** Same facts the current footer prints, shaped as a stage-1 snapshot. */
export function snapshotFromLegacyStatus(input: NextTuiStatusLineInput): StatuslineSnapshot {
  const queued = Math.max(0, Math.floor(input.queued));
  const steering = Math.min(queued, Math.max(0, Math.floor(input.steering ?? 0)));
  return {
    session: {
      // The footer as the old formatter draws it for this width (with every width fallback it has).
      facts: formatNextTuiStatusLine(input),
      turn: input.turnState,
      model: input.model,
      ...(seconds(input.elapsedMs) !== undefined ? { elapsed: seconds(input.elapsedMs) } : {}),
      tokens: tokens(input),
      queue: steering > 0 ? `Steer ${steering} · Queue ${queued - steering}` : queued,
      background: Math.max(0, Math.floor(input.backgroundTasks)),
    },
  };
}

let cached: StatuslineDefinition | undefined;

export function defaultStatuslineDefinition(): StatuslineDefinition {
  if (cached) return cached;
  const parsed = parseStatuslineYaml(DEFAULT_STATUSLINE_YAML);
  if (!parsed.ok) throw new Error(parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
  cached = parsed.definition;
  return cached;
}

/** The old formatter's line and what the new engine draws first for the same input (its `facts` segment). */
export function renderLegacyFacts(input: NextTuiStatusLineInput): { readonly legacy: string; readonly declarative: string } {
  const legacy = formatNextTuiStatusLine(input);
  // The old sentence is the wide layout's first segment (lg); narrower footers use the short clause instead.
  const frame = renderStatusline(defaultStatuslineDefinition(), snapshotFromLegacyStatus(input), input.width, 'lg');
  return { legacy, declarative: frame.lines[0]?.[0]?.text ?? '' };
}
