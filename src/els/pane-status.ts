// ELS-PANE-STATUS (0.3.30 P0 · OP orders/ELS-OP-SMALLWINS-1119.md #1): `els status <pane>` — what the pane is doing,
// read from the PTY the els server owns (never by scraping herdr). Pure: the server hands in the rendered screen, whether
// the PTY is alive, when it last produced output and the clock, so every rule here is a literal test.
//
// Anything this cannot tell is `unknown` with a reason — a guess would send OP the wrong way.

export type PaneActivity = 'working' | 'idle' | 'exited' | 'unknown';

export interface PaneStatus {
  readonly pane: string;
  readonly state: PaneActivity;
  /** Why the state is what it is (the screen line that decided it, or why it is unknown). */
  readonly reason: string;
  /** The prompt line is empty (true) · has text (false) · no prompt line recognised (unknown). */
  readonly inputEmpty: boolean | 'unknown';
  /** Seconds since the PTY last produced output; null = not known. */
  readonly lastOutputAgoSec: number | null;
  /** The tool the working row names, and the elapsed time that row shows; null = no tool row. */
  readonly tool: { readonly name: string; readonly elapsed: string } | null;
}

export interface PaneStatusInput {
  readonly pane: string;
  readonly alive: boolean;
  readonly exited: boolean;
  /** The rendered screen (plain text); undefined = the render failed. */
  readonly screen: string | undefined;
  readonly lastOutputAt: number | undefined;
  readonly now: number;
}

// 출처: src/tui/chat/working-row.ts — eln's working row is `<spinner> <Verb> (<elapsed> • esc to interrupt)`, and
// «Running Name(target)» while a tool runs; codex and Claude Code show the same «esc to interrupt» hint while busy.
const WORKING_HINT = /esc to interrupt/i;
// 출처: src/els/core.ts BUSY_SCREEN — eln's status line says «Turn running» (Korean UI «응답 중») during a turn.
const TURN_RUNNING = /Turn running|응답 중/;
const TOOL_ROW = /Running ([A-Za-z][\w.-]*)(?:\([^)]*\))?\s*\(([^•)]+?)\s*•\s*esc to interrupt/i;
// 출처: src/tui/input/composer.ts — eln's prompt row starts with «❯ »; Claude Code's box prompt is «│ > ».
// eln's transcript also marks a person's past lines with «❯ » (log-view USER_PROMPT_MARK · 대표 11-24); the composer is the
// bottom-most «❯» row, and lastPromptText reads from the bottom up, so a past line never stands in for it.
const PROMPT_ROW = /^(?:❯|│\s*>)\s?(.*?)\s*│?\s*$/;

function lastPromptText(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = PROMPT_ROW.exec(lines[i]!.trimEnd());
    if (match) return match[1] ?? '';
  }
  return undefined;
}

export function paneStatus(input: PaneStatusInput): PaneStatus {
  const lastOutputAgoSec = input.lastOutputAt === undefined ? null : Math.max(0, Math.floor((input.now - input.lastOutputAt) / 1000));
  const base = { pane: input.pane, lastOutputAgoSec };
  if (input.exited) return { ...base, state: 'exited', reason: 'the pane process has ended', inputEmpty: 'unknown', tool: null };
  if (!input.alive) return { ...base, state: 'unknown', reason: 'no live PTY (restored after restart: cwd only)', inputEmpty: 'unknown', tool: null };
  if (input.screen === undefined) return { ...base, state: 'unknown', reason: 'the screen could not be rendered', inputEmpty: 'unknown', tool: null };
  const lines = input.screen.split('\n');
  const prompt = lastPromptText(lines);
  const inputEmpty = prompt === undefined ? 'unknown' as const : prompt.length === 0;
  const toolMatch = lines.map((line) => TOOL_ROW.exec(line)).find((match) => match !== null);
  const tool = toolMatch ? { name: toolMatch[1]!, elapsed: toolMatch[2]!.trim() } : null;
  const busyLine = lines.find((line) => WORKING_HINT.test(line) || TURN_RUNNING.test(line));
  if (busyLine !== undefined) return { ...base, state: 'working', reason: `screen: ${busyLine.trim().slice(0, 120)}`, inputEmpty, tool };
  if (prompt !== undefined) return { ...base, state: 'idle', reason: 'prompt shown, no working row', inputEmpty, tool: null };
  return { ...base, state: 'unknown', reason: 'no working row and no prompt recognised on screen', inputEmpty, tool: null };
}

/** One line for a person: `ws/pane working · Bash 1m 05s · input empty · last output 3s ago`. */
export function formatPaneStatus(status: PaneStatus): string {
  const parts = [`${status.pane} ${status.state}`];
  if (status.tool) parts.push(`${status.tool.name} ${status.tool.elapsed}`);
  parts.push(status.inputEmpty === 'unknown' ? 'input unknown' : status.inputEmpty ? 'input empty' : 'input has text');
  parts.push(status.lastOutputAgoSec === null ? 'last output unknown' : `last output ${status.lastOutputAgoSec}s ago`);
  if (status.state === 'unknown') parts.push(`(${status.reason})`);
  return parts.join(' · ');
}
