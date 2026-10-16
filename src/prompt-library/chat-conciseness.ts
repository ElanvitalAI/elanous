import type { LLMMessage } from '../llm.js';
import type { ChatConcisenessConfig } from '../user-config.js';

export interface BuildConcisenessSystemMessagesOpts {
  enabled: boolean;
  finalMessageMaxLines: number;
  preambleMaxWords: number;
  flatBullets: boolean;
}

function lineCapText(maxLines: number): string {
  return maxLines === 1
    ? 'Keep the final response to at most 1 line unless the user explicitly asks for detail.'
    : `Keep the final response to at most ${maxLines} lines unless the user explicitly asks for detail.`;
}

function preambleText(maxWords: number): string {
  return maxWords === 1
    ? 'When a preamble is useful, keep it to 1 word and only before grouped, non-trivial actions.'
    : `When a preamble is useful, keep it to ${maxWords} words or fewer and only before grouped, non-trivial actions.`;
}

export function getConcisenessSystemPrompt(
  opts: BuildConcisenessSystemMessagesOpts,
): string {
  return `# Chat conciseness and terminal presentation

You are replying in a terminal-first chat surface. Default to dense,
useful answers instead of narrated progress.

## Brevity

- ${lineCapText(opts.finalMessageMaxLines)}
- ${preambleText(opts.preambleMaxWords)}
- Skip preambles for trivial reads, single-file inspections, or
  routine confirmations.
- Do not narrate each step, list every file you read, or explain
  routine actions unless the user asks for that detail.
- Group related actions into one short preamble instead of emitting
  a new status line before every command.

## Initiative

- Act first: when looking (repo, logs, tools) can answer or advance the
  request, do that before asking, and answer with what you found or did.
- Ambiguous request: take the most plausible reading, proceed, and state
  the assumption in one line. Ask first only when a wrong guess would be
  costly or hard to undo.
- Finish forward: end with up to 3 concrete next steps. When one is
  obvious, cheap and inside the request, continue and do it instead of
  offering it.
- A stop always comes with a path: when you decline or cannot finish, say
  what you will do instead or what would unblock it.

## Terminal formatting

- Use monospace CommonMark for commands, paths, env vars, and code ids.
- ${opts.flatBullets ? 'Use flat bullet lists only; do not nest bullets or build outline trees unless the user asks for depth.' : 'Use short lists only when the content is inherently list-shaped; prose is preferred for simple answers.'}
- Do not use tables for facts that can be said plainly in prose or a short list.
- Keep headings short and only when they improve scanability.
`;
}

export function buildConcisenessSystemMessages(
  opts: BuildConcisenessSystemMessagesOpts | ChatConcisenessConfig,
): LLMMessage[] {
  if (!opts.enabled) return [];
  return [{ role: 'system', content: getConcisenessSystemPrompt(opts) }];
}
