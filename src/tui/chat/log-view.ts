import type { SerializedMessage } from '../../session/index.js';
import { redactSecretText } from '../../debug/log.js';
import { planInterimDisplay, type InterimDisplay } from './goal-interim.js';
import { parseToolResultEnvelope, toolResultBodyText, toolResultErrorText } from '../../chat/tool-render/result-text.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function safeLogText(text: string): string {
  const plain = text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
  return redactSecretText(plain);
}

function wrapLine(text: string, columns: number): string[] {
  const width = Math.max(1, columns);
  const lines: string[] = [];
  let line = '';
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const cells = Bun.stringWidth(segment);
    if (used > 0 && used + cells > width) {
      lines.push(line);
      line = '';
      used = 0;
    }
    if (cells > width) continue;
    line += segment;
    used += cells;
  }
  lines.push(line);
  return lines;
}

export function fitLogLine(text: string, columns: number): string {
  return wrapLine(safeLogText(text), columns)[0] ?? '';
}

export function safeStatusText(text: string): string {
  return safeLogText(text).replace(/\n/g, ' ');
}

/** Lines moved per wheel notch over the chat log. */
export const WHEEL_SCROLL_LINES = 3;

/**
 * Next log scroll offset after one wheel notch. `scroll` counts lines above the
 * bottom, so 0 keeps following the newest line; `maxScroll` is how far the
 * history can go up (≤ 0 means it all fits and nothing scrolls).
 */
export function wheelScroll(scroll: number, direction: 'up' | 'down', maxScroll: number, step = WHEEL_SCROLL_LINES): number {
  const limit = Math.max(0, maxScroll);
  const next = scroll + (direction === 'up' ? step : -step);
  return Math.max(0, Math.min(limit, next));
}

/** Tool output longer than this many wrapped lines renders collapsed to one line. */
export const TOOL_FOLD_LINE_LIMIT = 9;

/**
 * Collapsed single-line summary for a long tool output (the cell's «▸ 도구 <이름> · N줄 (접힘)»).
 * With `columns`, a long name is shortened with «…» so the line count and fold marker stay
 * visible; if even that cannot fit, the whole line is cut to the width.
 */
export function toolFoldSummary(toolName: string, totalLines: number, columns?: number): string {
  const prefix = '▸ 도구 ';
  const suffix = ` · ${totalLines}줄 (접힘)`;
  const name = safeStatusText(toolName);
  const full = `${prefix}${name}${suffix}`;
  if (columns === undefined || Bun.stringWidth(full) <= columns) return full;
  const room = columns - Bun.stringWidth(prefix) - Bun.stringWidth(suffix) - 1; // 1 cell for «…»
  if (room < 1) return fitLogLine(full, columns);
  let short = '';
  let used = 0;
  for (const { segment } of segmenter.segment(name)) {
    const cells = Bun.stringWidth(segment);
    if (used + cells > room) break;
    short += segment;
    used += cells;
  }
  return `${prefix}${short}…${suffix}`;
}

/**
 * What a tool block shows (TUI-NEXT-TOOL-RESULT-RENDER). The persisted result is a JSON
 * envelope string (`{"output":"…\n…","linesRead":20,…}`); showing it raw put the whole
 * file on one wrapped line with escaped `\n`, so the fold never triggered. The envelope
 * is parsed back and its human text taken with the classic renderer's own extractor
 * (chat/tool-render/result-text.ts); a short status («20줄 · 251B» · «exit 0» · «오류»)
 * stays on the header line. A plain-text result keeps the old layout (`envelope: false`).
 */
interface ToolDisplay { envelope: boolean; status: string; body: string }

function formatToolBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function toolDisplay(message: SerializedMessage): ToolDisplay {
  const raw = typeof message.toolResult === 'string' ? message.toolResult : '';
  const parsed = parseToolResultEnvelope(raw);
  if (typeof parsed.value === 'string' || parsed.value === null || typeof parsed.value !== 'object') {
    return { envelope: false, status: '', body: safeLogText(raw) };
  }
  const record = parsed.value as Record<string, unknown>;
  const error = toolResultErrorText(record);
  const status: string[] = [];
  if (error !== null) status.push('오류');
  if (typeof record.totalLines === 'number') status.push(`${record.totalLines}줄`);
  if (typeof record.totalBytes === 'number') status.push(formatToolBytes(record.totalBytes));
  if (typeof record.exitCode === 'number') status.push(`exit ${record.exitCode}`);
  if (record.truncated === true || parsed.truncated) status.push('잘림');
  const text = error ?? toolResultBodyText(record) ?? '';
  // Tabs (Read's «     1\tline» gutter) would be dropped as control characters — keep them as a space.
  return { envelope: true, status: status.join(' · '), body: safeLogText(text.replace(/\t/g, ' ')) };
}

/** Tool output that is not finished yet (no result) must never fold. */
function toolLinesUnfolded(message: SerializedMessage, columns: number): string[] {
  const label = safeLogText(message.toolName || '실행');
  const display = toolDisplay(message);
  const lines: string[] = [];
  if (display.envelope) {
    lines.push(...wrapLine(`도구: ${label}${display.status ? ` · ${display.status}` : ''}`, columns));
    for (const part of display.body.split('\n')) lines.push(...wrapLine(`  ${part}`, columns));
    return lines;
  }
  const parts = `${label} ${display.body}`.split('\n');
  for (let i = 0; i < parts.length; i++) {
    const prefix = i === 0 ? '도구: ' : '  ';
    lines.push(...wrapLine(prefix + parts[i], columns));
  }
  return lines;
}

/** Wrapped line count of a finished tool's output alone (label and tool name excluded) — the fold measure. */
function toolOutputLineCount(message: SerializedMessage, columns: number): number {
  return toolDisplay(message).body.split('\n').reduce((sum, part) => sum + wrapLine(`  ${part}`, columns).length, 0);
}

/**
 * History view with tool-output folding. A finished tool output over
 * TOOL_FOLD_LINE_LIMIT wrapped lines renders as one collapsed summary line
 * unless its message index is in `expandedToolIndexes`; a tool block that is
 * still running (no result yet) never folds.
 */
/** One message's rendered lines (with its trailing blank separator). `display` is the goal-interim plan entry:
 *  an internal turn's input draws as its origin line (not «나: …»), and a folded interim reply as one line. */
function messageLines(
  message: SerializedMessage,
  index: number,
  columns: number,
  expandedToolIndexes: ReadonlySet<number> | undefined,
  display: InterimDisplay | undefined,
): string[] {
  if (message.role === 'tool') {
    const running = message.toolResult === undefined;
    const outputLines = running ? 0 : toolOutputLineCount(message, columns);
    if (running || outputLines <= TOOL_FOLD_LINE_LIMIT || expandedToolIndexes?.has(index)) {
      return [...toolLinesUnfolded(message, columns), ''];
    }
    return [toolFoldSummary(message.toolName || '실행', outputLines, columns), ''];
  }
  // TUI-GOAL-INTERIM-QUIET — 내부 턴 입력은 사람 머리 없이 출처 한 줄 · 이어가기 앞 중간 보고는 한 줄로 접는다.
  if (display?.kind === 'internal-input') return [fitLogLine(`↻ 자동 재개(${display.origin})`, columns), ''];
  if (display?.kind === 'folded') return [...wrapLine(`엘라누스: ${display.line}`, columns), ''];
  const lines: string[] = [];
  const label = message.role === 'user' ? '나: ' : '엘라누스: ';
  const parts = safeLogText(message.content).split('\n');
  for (let i = 0; i < parts.length; i++) {
    const prefix = i === 0 ? label : '  ';
    lines.push(...wrapLine(prefix + parts[i], columns));
  }
  lines.push('');
  return lines;
}

const isLogRole = (message: SerializedMessage): boolean =>
  message.role === 'user' || message.role === 'assistant' || message.role === 'tool';

export function logViewLines(
  messages: readonly SerializedMessage[],
  columns: number,
  expandedToolIndexes?: ReadonlySet<number>,
): string[] {
  const plan = planInterimDisplay(messages);
  const lines: string[] = [];
  for (const [index, message] of messages.entries()) {
    if (!isLogRole(message)) continue;
    lines.push(...messageLines(message, index, columns, expandedToolIndexes, plan.get(index)));
  }
  return lines.length > 0 ? lines : ['대화 기록 없음'];
}

/** Message indexes of tool blocks that would render collapsed (long + finished). */
export function toolFoldBlockStarts(messages: readonly SerializedMessage[], columns: number): number[] {
  const starts: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'tool' || message.toolResult === undefined) continue;
    if (toolOutputLineCount(message, columns) > TOOL_FOLD_LINE_LIMIT) starts.push(index);
  }
  return starts;
}

/** Keys that toggle a folded tool block while the log has focus: Enter or Tab (the cell's keys) and F. */
export function isToolFoldToggleKey(name: string | undefined): boolean {
  return name === 'return' || name === 'enter' || name === 'tab' || name === 'f';
}

/** A foldable tool block's message index and its rendered line range [start, end] in logViewLines. */
export interface ToolFoldBlockRange { index: number; start: number; end: number }

/**
 * Line ranges of the foldable tool blocks as logViewLines renders them with `expanded`.
 * Line positions match logViewLines exactly (it is the same rendering), so a caller's
 * scroll window over that history can be matched against them.
 */
export function toolFoldBlockRanges(
  messages: readonly SerializedMessage[],
  columns: number,
  expanded?: ReadonlySet<number>,
): ToolFoldBlockRange[] {
  const foldable = new Set(toolFoldBlockStarts(messages, columns));
  const plan = planInterimDisplay(messages);
  const ranges: ToolFoldBlockRange[] = [];
  let line = 0;
  for (const [index, message] of messages.entries()) {
    if (!isLogRole(message)) continue;
    // Same per-message rendering as logViewLines (lines + one blank separator), interim plan included.
    const height = messageLines(message, index, columns, expanded, plan.get(index)).length;
    if (foldable.has(index)) ranges.push({ index, start: line, end: line + height - 2 });
    line += height;
  }
  return ranges;
}

/**
 * Expand or fold the foldable tool block on screen nearest the bottom of the visible window
 * (`view.start` = first visible history line, `view.rows` = visible rows). Returns false when no
 * foldable block is on screen, so the caller can keep the key's ordinary meaning. Fold state
 * lives only in `expanded` (screen state) — the session messages are never touched.
 */
export function toggleVisibleToolFold(
  expanded: Set<number>,
  messages: readonly SerializedMessage[],
  columns: number,
  view: { start: number; rows: number },
): boolean {
  const top = view.start;
  const bottom = view.start + Math.max(0, view.rows) - 1;
  const target = toolFoldBlockRanges(messages, columns, expanded)
    .filter((range) => range.end >= top && range.start <= bottom)
    .at(-1);
  if (!target) return false;
  if (expanded.has(target.index)) expanded.delete(target.index);
  else expanded.add(target.index);
  return true;
}

/** Ephemeral reply preview until the persisted assistant message replaces it. */
export function streamReplyLines(text: string, columns: number): string[] {
  const parts = safeLogText(text).split('\n');
  const lines = parts.flatMap((part, index) => wrapLine(`${index === 0 ? '엘라누스: ' : '  '}${part}`, columns));
  return lines.slice(-80);
}
