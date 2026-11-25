import type { SerializedMessage } from '../../session/index.js';
import { redactSecretText } from '../../debug/log.js';
import { continueBanner, continueLabel, dimContinueBanner } from './continue-banner.js';
import { suppressedNoticeKind } from './notice-gate.js';
import { planInterimDisplay, type InterimDisplay } from './goal-interim.js';
import { parseToolResultEnvelope, toolResultBodyText, toolResultErrorText } from '../../chat/tool-render/result-text.js';
import { agentTraceLine } from '../core/agents.js';
import chalk from 'chalk';
import { renderMarkdown } from '../../render.js';
import { nextTuiErrorCard } from './error-card.js';
import { userTurnBandSgr } from './turn-band-theme.js';
import { machineGlyph, machineRowStyle, noticeFoldSummary, noticeOfRow, noticePartHead, noticePartLine, type NoticeDisplayRow } from './notice-fold.js';
import type { QueueNoticeHead, QueueNoticePart } from '../../chat/interjection.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

/** The person's own turn: «❯ » on a band (PERSON-VS-MACHINE 대표 11-24) — a machine row never carries it. */
export const USER_PROMPT_MARK = '❯ ';

// NEXT-TUI-USER-TURN-COLOR (대표 11-17): a person's turn is a band across the whole row so it stands apart from
// answers and tool rows. 대표 11-18: toned down to a neutral grey just off the terminal background — the colours are the
// theme tokens in turn-band-theme.ts (dark/light), never written here. USER_TURN_BAND_SGR is the dark token's SGR.
export const USER_TURN_BAND_SGR = userTurnBandSgr({} as NodeJS.ProcessEnv);
/** NO_COLOR keeps «> » plus the two-column indent as the only separation. */
export const userTurnBandEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !('NO_COLOR' in env) || env.NO_COLOR === '';

// MSG-SOURCE-HIERARCHY: another seat's message (from.kind agent) is a paler grey-violet band under a «⇢ SEAT · intent»
// head — clearly not the person's own turn, still readable. 출처: xterm 256-color 60 = #5f5f87; bright white on it ≈ 6:1.
export const AGENT_TURN_BAND_SGR = '48;5;60;97';
export const AGENT_MARK = '⇢';

function agentBandRow(row: string, columns: number): string {
  const pad = ' '.repeat(Math.max(0, columns - Bun.stringWidth(row)));
  const body = row.startsWith(`${AGENT_MARK} `) ? `\x1b[1m${AGENT_MARK}\x1b[22m${row.slice(AGENT_MARK.length)}` : row;
  return `\x1b[${AGENT_TURN_BAND_SGR}m${body}${pad}\x1b[0m`;
}

/** TUI-NOTICE-QUIET (대표 11-24): a scheduled/woken resume is bookkeeping — no row (the answer that follows is the surface);
 *  a goal-continue «↻ Continuing (…)» keeps its one dim line. */
function systemTurnLines(origin: string, columns: number): string[] {
  const banner = continueBanner(origin);
  if (suppressedNoticeKind(banner) === 'resume-banner') return [];
  // PERSON-VS-MACHINE — a shown internal turn is a machine row: dim, its icon from the structured origin.
  return [machineRowStyle(fitLogLine(`${machineGlyph(origin)} ${continueLabel(origin)}`, columns)), ''];
}

/** Rows for a user-role message by its structured source (never by its wording); null = the person's own turn. */
function sourcedUserLines(message: SerializedMessage, columns: number): string[] | null {
  const from = message.from;
  if (!from || from.kind === 'human') return null;
  // The harness's own turn (waker, automatic continue, mail wake): one dim line, the internal instruction stays hidden.
  if (from.kind === 'system') return systemTurnLines(from.origin ?? 'internal', columns);
  const head = [`${AGENT_MARK} ${from.seat ?? 'agent'}`, from.intent, from.due ? `due ${from.due}` : undefined, from.msgId ? `#${from.msgId}` : undefined].filter(Boolean).join(' · ');
  const rows = [...wrapLine(head, columns), ...safeLogText(message.content).split('\n').flatMap((part) => wrapLine(`  ${part}`, columns))];
  return [...(userTurnBandEnabled() ? rows.map((row) => agentBandRow(row, columns)) : rows), ''];
}

/** Paint one wrapped user row as a band to `columns`; «❯» is bold, the body keeps normal weight. */
export function userTurnBandRow(row: string, columns: number): string {
  const pad = ' '.repeat(Math.max(0, columns - Bun.stringWidth(row)));
  const body = row.startsWith(USER_PROMPT_MARK) ? `\x1b[1m❯\x1b[22m${row.slice(1)}` : row;
  return `\x1b[${userTurnBandSgr()}m${body}${pad}\x1b[0m`;
}

export function safeLogText(text: string): string {
  const plain = text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
  return redactSecretText(plain);
}

function wrapText(text: string, columns: number, styled: boolean, resetOnWrap = true, hang = 2): string[] {
  const width = Math.max(1, columns);
  const lines: string[] = [];
  let line = '';
  let used = 0;
  let lineIndentWidth = 0;
  let activeSgr: string[] = [];
  let continuation = false;
  const nextLine = (nextCells: number): void => {
    lines.push(line + (styled && (activeSgr.length > 0 || resetOnWrap) ? '\x1b[0m' : ''));
    lineIndentWidth = Math.min(hang, Math.max(0, width - nextCells));
    line = ' '.repeat(lineIndentWidth) + (styled ? activeSgr.join('') : '');
    used = lineIndentWidth;
    continuation = true;
  };
  // Segment visible text once. An SGR sequence inside a word changes style,
  // never the word boundary at which we decide to wrap.
  let plain = text;
  const stylesAt = new Map<number, string[]>();
  if (styled) {
    plain = '';
    let from = 0;
    for (const match of text.matchAll(/\x1b\[[0-?]*[ -/]*m/g)) {
      plain += text.slice(from, match.index);
      const styles = stylesAt.get(plain.length) ?? [];
      styles.push(match[0]);
      stylesAt.set(plain.length, styles);
      from = match.index + match[0].length;
    }
    plain += text.slice(from);
  }
  const emitStyles = (index: number): void => {
    for (const style of stylesAt.get(index) ?? []) {
      line += style;
      const params = style.slice(2, -1).split(';').map((value) => Number(value || 0));
      if (params.includes(0)) activeSgr = [];
      if (params.some((value) => value !== 0)) activeSgr.push(style);
    }
  };
  const emit = (start: number, end: number): void => {
    for (let index = start; index < end; index++) {
      emitStyles(index);
      line += plain[index];
    }
  };
  const emitSkippedStyles = (start: number, end: number): void => {
    for (let index = start; index < end; index++) emitStyles(index);
  };
  const fitEmptyLine = (cells: number): void => {
    if (used !== lineIndentWidth || used + cells <= width || cells > width) return;
    lineIndentWidth = Math.max(0, width - cells);
    line = ' '.repeat(lineIndentWidth) + (styled ? activeSgr.join('') : '');
    used = lineIndentWidth;
  };
  const appendWord = (word: string, start: number): void => {
    const whitespace = /^\s+$/.test(word);
    if (whitespace && continuation && used === lineIndentWidth) {
      emitSkippedStyles(start, start + word.length);
      return;
    }
    const cells = Bun.stringWidth(word);
    if (used + cells > width && used > lineIndentWidth) {
      // TUI-IDLE-CPU-SPIN: the first grapheme matters only for an over-wide word — no segment iterator per word.
      nextLine(cells <= width ? cells
        : Bun.stringWidth(segmenter.segment(word)[Symbol.iterator]().next().value?.segment ?? word));
      if (whitespace) {
        emitSkippedStyles(start, start + word.length);
        return;
      }
    }
    fitEmptyLine(cells);
    if (used + cells <= width) {
      emit(start, start + word.length);
      used += cells;
      return;
    }
    // A single long word (or an unspaced CJK run) still has to fit the terminal.
    for (const { segment, index } of segmenter.segment(word)) {
      const segmentCells = Bun.stringWidth(segment);
      if (used + segmentCells > width && used > lineIndentWidth) nextLine(segmentCells);
      fitEmptyLine(segmentCells);
      if (used + segmentCells > width) continue;
      emit(start + index, start + index + segment.length);
      used += segmentCells;
    }
  };
  for (const { segment, index } of wordSegmenter.segment(plain)) appendWord(segment, index);
  emitStyles(plain.length);
  lines.push(line);
  return lines;
}

function wrapLine(text: string, columns: number): string[] {
  return wrapText(text, columns, false);
}

/** Only trusted classic-renderer SGR escapes pass through after sanitizing raw text. */
function wrapRenderedLine(text: string, columns: number, resetOnWrap = true, hang = 2): string[] {
  return wrapText(text, columns, true, resetOnWrap, hang);
}

/** READABILITY-PORT: bare URLs read as links (underlined accent) in the Next transcript only. Style-only —
 *  plain text and line count are unchanged; with colors off (`chalk.level === 0`) this is the identity. */
export function highlightLinks(line: string): string {
  return line.replace(/https?:\/\/[^\s)\]>"'`\x1b]+/g, (url) => chalk.underline(chalk.cyan(url)));
}

const LIST_ITEM = /^\s*(?:[-*]|\d+\.)\s/;
const FENCE = /^ {0,3}(?:`{3,}|~{3,})/;
const HEADING = /^#{1,3}\s/;
/** A line that is only bold text (optionally ending in a colon) is a sub-heading in model output. */
const BOLD_SUBHEADING = /^\s*\*\*[^*]+\*\*\s*:?\s*$/;
const isHeadingLike = (line: string): boolean => HEADING.test(line) || BOLD_SUBHEADING.test(line);

/** MARKDOWN-BLOCK-SPACING: one blank line between blocks, like classic. Dense model output
 *  («문장\n## 제목\n본문\n- 항목») gets a blank before a heading / bold sub-heading, after it, before a list
 *  that follows prose and before a code fence; runs of blank lines collapse to one. Nothing is added inside a
 *  fence, and text inside a line («① … ② …») is never touched. Display-only: the stored message is untouched
 *  and the live preview and the saved reply share this so they stay identical. */
export function breatheMarkdown(text: string): string {
  const out: string[] = [];
  let inFence = false;
  let prev = '';
  for (const line of text.split('\n')) {
    const blank = line.trim() === '';
    if (!inFence && blank && out.length > 0 && out[out.length - 1]!.trim() === '') continue; // collapse blank runs
    const fence = FENCE.test(line);
    const opensBlock = !inFence && (fence || isHeadingLike(line)
      || LIST_ITEM.test(line) && prev.trim() !== '' && !LIST_ITEM.test(prev));
    const afterHeading = !inFence && !blank && prev.trim() !== '' && isHeadingLike(prev);
    if ((opensBlock || afterHeading) && prev.trim() !== '' && out.length > 0) out.push('');
    out.push(line);
    if (fence) inFence = !inFence;
    prev = line;
  }
  return out.join('\n');
}

/** Hanging indent for a wrapped list item: continuation rows align under the item text, not under the marker.
 *  Paragraphs wrap flush-left (classic). Measured on the rendered row with colors stripped. */
export function hangingIndentFor(renderedRow: string): number {
  const plain = renderedRow.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const marker = /^(\s*)(?:[-*•]|\d+[.)])\s+/u.exec(plain);
  return marker ? Bun.stringWidth(marker[0]) : 0;
}

/** Leading blank lines are dropped so a reply starts on its first text row. Replies carry no speaker label
 *  (classic TUI: the user's input is the «>» prompt line, the answer stands alone). */
function assistantMarkdownLines(text: string, columns: number, resetOnWrap = true): string[] {
  const rendered = renderMarkdown(breatheMarkdown(safeLogText(text).replace(/^(?:[ \t]*\n)+/, '')), { columns });
  return rendered.split('\n').flatMap((part) =>
    wrapRenderedLine(highlightLinks(part), columns, resetOnWrap, hangingIndentFor(part)));
}

export function fitLogLine(text: string, columns: number): string {
  let result = '';
  let used = 0;
  for (const { segment } of segmenter.segment(safeLogText(text))) {
    const cells = Bun.stringWidth(segment);
    if (used + cells > Math.max(1, columns)) break;
    result += segment;
    used += cells;
  }
  return result;
}

/** Preserve every grapheme when a status area needs more than one terminal row. */
export function wrapLogLines(text: string, columns: number): string[] {
  return wrapLine(safeLogText(text), columns);
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
  const prefix = '▸ Tool ';
  const suffix = ` · ${totalLines} lines (folded)`;
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

function toolOutputParts(body: string): string[] {
  const parts = body.split('\n');
  if (parts.length > 1 && parts.at(-1) === '') parts.pop();
  return parts;
}

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
  if (error !== null) status.push('error');
  if (typeof record.totalLines === 'number') status.push(`${record.totalLines} lines`);
  if (typeof record.totalBytes === 'number') status.push(formatToolBytes(record.totalBytes));
  if (typeof record.exitCode === 'number') status.push(`exit ${record.exitCode}`);
  if (record.truncated === true || parsed.truncated) status.push('truncated');
  const text = error ?? toolResultBodyText(record) ?? '';
  // Tabs (Read's «     1\tline» gutter) would be dropped as control characters — keep them as a space.
  return { envelope: true, status: status.join(' · '), body: safeLogText(text.replace(/\t/g, ' ')) };
}

/** Tool output that is not finished yet (no result) must never fold. */
function toolLinesUnfolded(message: SerializedMessage, columns: number): string[] {
  const label = safeLogText(message.toolName || 'run');
  const display = toolDisplay(message);
  const lines: string[] = [];
  if (display.envelope) {
    lines.push(...wrapLine(`Tool: ${label}${display.status ? ` · ${display.status}` : ''}`, columns));
    for (const part of toolOutputParts(display.body)) lines.push(...wrapLine(`  ${part}`, columns));
    return lines;
  }
  const parts = toolOutputParts(`${label} ${display.body}`);
  for (let i = 0; i < parts.length; i++) {
    const prefix = i === 0 ? 'Tool: ' : '  ';
    lines.push(...wrapLine(prefix + parts[i], columns));
  }
  return lines;
}

/** Wrapped line count of a finished tool's output alone (label and tool name excluded) — the fold measure. */
function toolOutputLineCount(message: SerializedMessage, columns: number): number {
  return toolOutputParts(toolDisplay(message).body).reduce((sum, part) => sum + wrapLine(`  ${part}`, columns).length, 0);
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
    const agentLine = agentTraceLine(message);
    if (agentLine) return [fitLogLine(agentLine, columns), ''];
    const running = message.toolResult === undefined;
    const outputLines = running ? 0 : toolOutputLineCount(message, columns);
    if (running || expandedToolIndexes?.has(index)) {
      return [...toolLinesUnfolded(message, columns), ''];
    }
    return [toolFoldSummary(message.toolName || 'run', outputLines, columns), ''];
  }
  // NOTICE-FOLD-1LINE — an incoming notice is one summary line (a fold block like a tool call); expanded, its full text.
  const notice = noticeOfRow(message);
  if (notice) {
    // 대표 12:2x — a mail notice folds PER MESSAGE: one dim «✉ #id from · first line…» row per mail, each opens alone.
    if (notice.parts?.length) {
      const open = new Set((message as NoticeDisplayRow).noticeOpenParts ?? []);
      return [...notice.parts.flatMap((part) => noticePartRows(notice, part, columns, open.has(part.msgId))), ''];
    }
    const failed = (notice.failed ?? 0) > 0;
    const head = machineRowStyle(fitLogLine(noticeFoldSummary(notice), columns), failed);
    if (!expandedToolIndexes?.has(index)) return [head, ''];
    return [head, ...safeLogText(notice.body).split('\n').flatMap((part) => wrapLine(`  ${part}`, columns))
      .map((row) => machineRowStyle(row, failed)), ''];
  }
  // TUI-GOAL-INTERIM-QUIET — 내부 턴 입력은 사람 머리 없이 출처 한 줄 · 이어가기 앞 중간 보고는 한 줄로 접는다.
  if (message.role === 'user') {
    const sourced = sourcedUserLines(message, columns);
    if (sourced) return sourced;
  }
  if (display?.kind === 'internal-input') return systemTurnLines(display.origin, columns);
  if (display?.kind === 'folded') return [...wrapLine(`  ${display.line}`, columns), ''];
  if (message.role === 'assistant' && message.replyFailure === true) {
    return [...nextTuiErrorCard(message.content, message.replyFailureKind)
      .flatMap((line) => wrapLine(line, columns)), ''];
  }
  const lines: string[] = [];
  if (message.role === 'assistant') {
    lines.push(...assistantMarkdownLines(message.content, columns));
  } else {
    const content = safeLogText(visibleUserText(message.content));
    const parts = content.split('\n');
    const band = userTurnBandEnabled();
    for (let i = 0; i < parts.length; i++) {
      const rows = wrapLine(`${i === 0 ? USER_PROMPT_MARK : '  '}${parts[i]}`, columns);
      // A multi-line turn keeps one continuous band.
      lines.push(...(band ? rows.map((row) => userTurnBandRow(row, columns)) : rows));
    }
  }
  lines.push('');
  return lines;
}

/** One mail of a notice row: its folded line, or (open) its head and its whole text — dim, no band, never «❯». */
function noticePartRows(notice: QueueNoticeHead, part: QueueNoticePart, columns: number, open: boolean): string[] {
  const text = safeLogText(notice.body.slice(part.start, part.start + part.length));
  if (!open) return [machineRowStyle(noticePartLine(part, text, columns))];
  return [machineRowStyle(noticePartHead(part, columns)),
    ...text.split('\n').flatMap((line) => wrapLine(`  ${line}`, columns)).map((row) => machineRowStyle(row))];
}

/** Classic dashboard resume stored its runtime context inside the user turn. Show the actual question only. */
function visibleUserText(content: string): string {
  const prefix = 'Context:\nDashboard mode: browse\n\nRecent status output:\n';
  const questionMarker = '\n\nQuestion: ';
  if (!content.startsWith(prefix)) return content;
  const questionAt = content.indexOf(questionMarker, prefix.length);
  if (questionAt < prefix.length || !/(?:^|\n)  ✓ resumed local session: [a-zA-Z0-9-]+(?:\n|$)/.test(content.slice(prefix.length, questionAt))) return content;
  return content.slice(questionAt + questionMarker.length);
}

const isLogRole = (message: SerializedMessage): boolean =>
  message.role === 'user' || message.role === 'assistant' || message.role === 'tool';

// TUI-LONG-PASTE-SPIN (대표 11-25 «아예 죽는 문제 · 크리티컬») — a frame used to re-wrap EVERY saved row (4.9k rows ·
// 4 MB of tool output · ICU word segmentation) whenever the message array identity changed, and a running turn whose
// echo never retired changed it every 250 ms tick: 11–13 s per frame on the live OP seat, then a frozen loop.
// A row's rendering depends only on the row object and the inputs below, so it is kept per row object: a frame
// re-wraps only rows it has not seen (one new row per delta), whatever the array identity does.
interface RowRenderMemo { readonly key: string; readonly lines: readonly string[] }
const rowRenderMemo = new WeakMap<SerializedMessage, RowRenderMemo>();
/** Rows actually wrapped (cache misses) since load — the deterministic cost counter the perf test reads. */
let rowRenderMisses = 0;
export function logViewRowRenderMisses(): number { return rowRenderMisses; }

/** Everything outside the row that changes its pixels: colour level and the band theme (NO_COLOR · theme env). */
function rowStyleKey(): string {
  return `${chalk.level}|${userTurnBandEnabled() ? userTurnBandSgr() : 'plain'}`;
}

function memoMessageLines(
  message: SerializedMessage,
  index: number,
  columns: number,
  expandedToolIndexes: ReadonlySet<number> | undefined,
  display: InterimDisplay | undefined,
  styleKey: string,
): readonly string[] {
  const open = (message as NoticeDisplayRow).noticeOpenParts;
  const key = `${columns}|${styleKey}|${expandedToolIndexes?.has(index) ? 1 : 0}|${display ? `${display.kind}:${display.kind === 'folded' ? display.line : display.origin}` : ''}|${open ? open.join(',') : ''}`;
  const hit = rowRenderMemo.get(message);
  if (hit && hit.key === key) return hit.lines;
  rowRenderMisses += 1;
  const lines = messageLines(message, index, columns, expandedToolIndexes, display);
  rowRenderMemo.set(message, { key, lines });
  return lines;
}

/** Rendered height of each saved row (0 for a non-log row) — the same rendering as logViewLines, from the row memo. */
export function logViewRowHeights(
  messages: readonly SerializedMessage[],
  columns: number,
  expandedToolIndexes?: ReadonlySet<number>,
): number[] {
  const plan = planInterimDisplay(messages);
  const styleKey = rowStyleKey();
  return messages.map((message, index) => isLogRole(message)
    ? memoMessageLines(message, index, columns, expandedToolIndexes, plan.get(index), styleKey).length : 0);
}

export function logViewLines(
  messages: readonly SerializedMessage[],
  columns: number,
  expandedToolIndexes?: ReadonlySet<number>,
): string[] {
  return logViewLinesWithInsertions(messages, columns, expandedToolIndexes);
}

/** Render session history with ephemeral surface rows attached after a message index. */
export function logViewLinesWithInsertions(
  messages: readonly SerializedMessage[],
  columns: number,
  expandedToolIndexes?: ReadonlySet<number>,
  afterMessageIndex: ReadonlyMap<number, readonly string[]> = new Map(),
): string[] {
  const plan = planInterimDisplay(messages);
  const styleKey = rowStyleKey();
  const lines: string[] = [];
  for (const [index, message] of messages.entries()) {
    if (!isLogRole(message)) continue;
    for (const line of memoMessageLines(message, index, columns, expandedToolIndexes, plan.get(index), styleKey)) lines.push(line);
    for (const line of afterMessageIndex.get(index) ?? []) lines.push(line);
  }
  return lines.length > 0 ? lines : ['No chat history'];
}

/** Message indexes of the fold blocks: finished tool blocks and incoming notice rows (NOTICE-FOLD-1LINE). */
export function toolFoldBlockStarts(messages: readonly SerializedMessage[], columns: number): number[] {
  const starts: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (noticeOfRow(message)) { starts.push(index); continue; }
    if (message.role !== 'tool' || message.toolResult === undefined) continue;
    if (agentTraceLine(message)) continue;
    starts.push(index);
  }
  return starts;
}

/** Keys that toggle a folded tool block while the log has focus: Enter or Tab (the cell's keys) and F. */
export function isToolFoldToggleKey(name: string | undefined): boolean {
  return name === 'return' || name === 'enter' || name === 'tab' || name === 'f';
}

/** A foldable tool block's message index and its rendered line range [start, end] in logViewLines. */
export interface ToolFoldBlockRange { index: number; start: number; end: number; /** One mail of a notice row. */ part?: number }

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
  const styleKey = rowStyleKey();
  const ranges: ToolFoldBlockRange[] = [];
  let line = 0;
  for (const [index, message] of messages.entries()) {
    if (!isLogRole(message)) continue;
    // Same per-message rendering as logViewLines (lines + one blank separator), interim plan included.
    const height = memoMessageLines(message, index, columns, expanded, plan.get(index), styleKey).length;
    const notice = foldable.has(index) ? noticeOfRow(message) : null;
    if (notice?.parts?.length) {
      // NOTICE-FOLD-1LINE — each mail of the notice is its own fold target, at the rows it renders.
      const open = new Set((message as NoticeDisplayRow).noticeOpenParts ?? []);
      let at = line;
      for (const part of notice.parts) {
        const rows = noticePartRows(notice, part, columns, open.has(part.msgId)).length;
        ranges.push({ index, part: part.msgId, start: at, end: at + rows - 1 });
        at += rows;
      }
    } else if (foldable.has(index)) ranges.push({ index, start: line, end: line + height - 2 });
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
  const lines = assistantMarkdownLines(text, columns, false);
  // Source: #74912 retains the existing 80-row preview cap.
  const limit = 80;
  return lines.length <= limit ? lines : lines.slice(-limit);
}
