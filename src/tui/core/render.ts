import type { SerializedMessage } from '../../session/index.js';
import type { MessageBlock } from '../../conv-substrate/message-block.js';
import { dimContinueBanner } from '../chat/continue-banner.js';
import { parseToolResultEnvelope } from '../../chat/tool-render/result-text.js';
import { fitLogLine, logViewLines, logViewLinesWithInsertions, toolFoldBlockRanges, wrapLogLines } from '../chat/log-view.js';
import { isToolActivityLine } from '../chat/tool-activity.js';
import { isWorkingRow } from '../chat/working-row.js';
import { messageBlockDetailLines, nextMessageBlockDetailLevel, type TuiDetailLevel } from '../chat/message-block-view.js';

const HIDDEN_INTERNAL_TOOL_NAMES = new Set(['AgentOutput', 'AgentList', 'TaskGet', 'TaskList', 'update_goal', 'UpdateGoal']);
const HIDDEN_INTERNAL_TOOL_CALLS = new Set(['Agent', 'AgentOutput', 'AgentList', 'TaskGet', 'TaskList', 'update_goal', 'UpdateGoal']);

/** A finished activity can disappear only after its result has a visible, saved detail row. */
export function hasDisplayableCompletedToolBlock(
  callId: string,
  blocks: readonly MessageBlock[],
  messages: readonly SerializedMessage[],
): boolean {
  return blocks.some((block) => {
    if (block.body.kind !== 'tool-call' || block.body.toolCallId !== callId
      || (block.body.status !== '완료' && block.body.status !== '실패')
      || HIDDEN_INTERNAL_TOOL_CALLS.has(block.body.title)) return false;
    const ref = block.detail?.rawRef;
    return Boolean(ref && block.id === ref.blockId && messages.some((message) =>
      message.role === 'tool' && message.surfaceRunId === ref.runId && message.toolCallId === callId));
  });
}

function isHiddenInternalTool(name: string | undefined): boolean {
  return HIDDEN_INTERNAL_TOOL_NAMES.has(name ?? '');
}

function hasToolError(result: unknown): boolean {
  const value = typeof result === 'string' ? parseToolResultEnvelope(result).value : result;
  if (typeof value === 'string') return /^error\s*:/i.test(value.trim());
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const error = (value as Record<string, unknown>).error;
  if (typeof error === 'string') return error.trim().length > 0;
  return error !== null && error !== undefined && error !== false;
}

function normalizeStructuredToolError(result: unknown): unknown {
  const serialized = typeof result === 'string';
  const value = serialized ? parseToolResultEnvelope(result).value : result;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== 'object') return result;
  const errorText = typeof (error as Record<string, unknown>).message === 'string'
    ? String((error as Record<string, unknown>).message)
    : JSON.stringify(error);
  const normalized = { ...(value as Record<string, unknown>), error: errorText };
  return JSON.stringify(normalized);
}

// The Next TUI's log controls share the same rendering rules as its history view.
export { fitLogLine, wrapLogLines, isToolFoldToggleKey, safeLogText, safeStatusText,
  logViewLines, streamReplyLines, toggleVisibleToolFold, toolFoldBlockRanges, toolFoldBlockStarts, wheelScroll } from '../chat/log-view.js';

export interface NextTuiLogFrameInput {
  readonly messages: readonly SerializedMessage[];
  /** Screen-only turn endings anchored to session message indexes. */
  readonly turnEndMarkers?: readonly { readonly afterMessageIndex: number; readonly text: string }[];
  readonly messageBlocks?: readonly { readonly block: MessageBlock; readonly level?: TuiDetailLevel; readonly rawText?: string; readonly afterMessageIndex?: number }[];
  readonly columns: number;
  readonly rows: number;
  readonly header: readonly string[];
  readonly footer: readonly string[];
  readonly promptLine: string;
  readonly promptLines?: readonly string[];
  /** Rows under the input — the last rows of the screen (the status line at `position: bottom`, DESIGN §2b). */
  readonly belowPrompt?: readonly string[];
  readonly notices: readonly string[];
  readonly activity: readonly string[];
  /** Plain rows shown right after a history message index (e.g. a settled turn's tool rows). */
  readonly inlineInsertions?: ReadonlyMap<number, readonly string[]>;
  /** Lines above the bottom; zero follows new output. */
  readonly scroll: number;
  readonly expandedToolIndexes: ReadonlySet<number>;
}

export interface NextTuiLogFrame {
  readonly lines: string[];
  readonly body: string[];
  readonly promptRow: number;
  readonly scroll: number;
  readonly maxScroll: number;
  readonly logWindow: { start: number; rows: number; columns: number; bodyTop: number; leadingBlankRows: number; foldTargets: readonly ({ kind: 'message'; id: string; start: number; end: number } | { kind: 'tool'; index: number; start: number; end: number })[] };
}

export type NextTuiFoldTarget = { kind: 'message'; id: string; start: number; end: number }
  | { kind: 'tool'; index: number; start: number; end: number };

/** Advance visible MessageBlocks fairly before returning to ordinary tool rows. */
export function nextVisibleFoldTarget(
  targets: readonly NextTuiFoldTarget[],
  blocks: readonly MessageBlock[],
  levels: ReadonlyMap<string, TuiDetailLevel>,
  lastKey: string | null,
): NextTuiFoldTarget | undefined {
  if (!targets.length) return undefined;
  const key = (target: NextTuiFoldTarget): string => target.kind === 'message' ? `message:${target.id}` : `tool:${target.index}`;
  const visibleMessages = targets.filter((target): target is Extract<NextTuiFoldTarget, { kind: 'message' }> => target.kind === 'message');
  const tools = targets.filter((target): target is Extract<NextTuiFoldTarget, { kind: 'tool' }> => target.kind === 'tool');
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const incomplete = visibleMessages.filter(({ id }) => (levels.get(id) ?? 0) < (byId.get(id)?.detail?.level ?? 1));
  const expanded = visibleMessages.filter(({ id }) => (levels.get(id) ?? 0) > 0);
  const nextAfterLast = <T extends NextTuiFoldTarget>(items: readonly T[]): T | undefined => {
    if (!items.length) return undefined;
    const index = items.findIndex((item) => key(item) === lastKey);
    return index < 0 ? items[0] : items[(index + 1) % items.length];
  };
  const lastMessageId = lastKey?.startsWith('message:') ? lastKey.slice('message:'.length) : undefined;
  const lastMessageWasFolded = lastMessageId !== undefined && (levels.get(lastMessageId) ?? 0) === 0;
  if (lastMessageWasFolded && expanded.length === 0 && tools.length) return nextAfterLast(tools);
  if (lastMessageWasFolded && expanded.length) return nextAfterLast(expanded);
  if (incomplete.length) return nextAfterLast(incomplete);
  if (expanded.length) return nextAfterLast(expanded);

  return nextAfterLast(targets);
}

interface PreparedHistory {
  lines: string[];
  foldTargets: NextTuiFoldTarget[];
}

function prepareHistory(input: NextTuiLogFrameInput): PreparedHistory {
  // Tool payloads used only to manage lifecycle and have no human result are not conversation content.
  // Keep their indexes stable for message blocks and tool fold targets, but omit those rows.
  const lifecycleToolCalls = HIDDEN_INTERNAL_TOOL_CALLS;
  const isLifecycleText = (text: string): boolean =>
    /^(?:agent\s+(?:started|running|spawned)(?:\s*[:#-]\s*[\w.-]+)?|(?:started|running|spawned)\s+(?:agent|child agent)(?:\s*[:#-]\s*[\w.-]+)?|agent\s+(?:finished|completed|failed)|(?:finished|completed|failed)\s+(?:agent|child agent))$/i.test(text.trim())
    || /^\(running in background — taskId=[^\r\n)]+\)$/.test(text.trim());
  const hasSubstantiveAgentValue = (value: unknown): boolean => {
    if (typeof value === 'string') return value.trim().length > 0 && !isLifecycleText(value);
    if (Array.isArray(value)) return value.some(hasSubstantiveAgentValue);
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim().length > 0) return true;
    return ['output', 'answer', 'result', 'summary', 'content', 'response', 'text']
      .some((key) => hasSubstantiveAgentValue(record[key]));
  };
  const hasAgentResult = (result: unknown): boolean => {
    const value = typeof result === 'string' ? parseToolResultEnvelope(result).value : result;
    if (typeof value === 'string') return hasSubstantiveAgentValue(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return hasSubstantiveAgentValue(value);
    const record = value as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim().length > 0) return true;
    return hasSubstantiveAgentValue(record.output)
      || ['answer', 'result', 'summary', 'content', 'response', 'text'].some((key) => hasSubstantiveAgentValue(record[key]));
  };
  const serializableAgentResult = (result: unknown): string => {
    const value = typeof result === 'string' ? parseToolResultEnvelope(result).value : result;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = { ...(value as Record<string, unknown>) };
      if (typeof record.error === 'string' && record.error.trim().length === 0) delete record.error;
      return JSON.stringify(record);
    }
    return typeof result === 'string' ? result : JSON.stringify(result) ?? String(result);
  };
  // A live detail block already owns this tool's visible summary and expandable
  // result. Pair by run as well as call ID: an old saved trace must remain visible
  // when a later run happens to reuse the same call ID.
  const detailedTools = new Set((input.messageBlocks ?? []).flatMap(({ block }) =>
    block.body.kind === 'tool-call' && block.detail?.rawRef && block.id === block.detail.rawRef.blockId
      ? [`${block.detail.rawRef.runId}\u0000${block.body.toolCallId}`] : []));
  const historyMessages = input.messages.map((message) => {
    if (message.role !== 'tool') return message;
    if (message.surfaceRunId && message.toolCallId
      && detailedTools.has(`${message.surfaceRunId}\u0000${message.toolCallId}`)) {
      return { ...message, role: 'system', content: '' } as SerializedMessage;
    }
    if (isHiddenInternalTool(message.toolName) && hasToolError(message.toolResult)) {
      return { ...message, toolResult: normalizeStructuredToolError(message.toolResult) };
    }
    if ((isHiddenInternalTool(message.toolName) && !hasToolError(message.toolResult))
      || (message.toolName === 'Agent' && !hasAgentResult(message.toolResult))) {
      // Keep the saved index stable for MessageBlock anchors and fold state; system rows are not transcript rows.
      return { ...message, role: 'system', content: '' } as SerializedMessage;
    }
    // Agent traces intentionally collapse to lifecycle status in log-view; use a result label so
    // substantive output remains available without editing the shared renderer.
    if (message.toolName !== 'Agent') return message;
    const toolResult = serializableAgentResult(message.toolResult);
    return { ...message, toolName: 'Agent result', toolResult };
  });
  const visibleMessageBlocks = (input.messageBlocks ?? []).filter(({ block }) =>
    block.body.kind !== 'tool-call' || !lifecycleToolCalls.has(block.body.title));
  const insertions = new Map<number, string[]>();
  for (const [anchor, rows] of input.inlineInsertions ?? []) {
    if (anchor >= 0 && anchor < input.messages.length && rows.length > 0) insertions.set(anchor, [...rows]);
  }
  const blockRanges: Array<{ kind: 'message'; id: string; start: number; end: number; anchor: number }> = [];
  let priorBlockLines = 0;
  for (const { block, level, rawText, afterMessageIndex } of visibleMessageBlocks) {
    if (block.body.kind === 'assistant' || block.body.kind === 'user') continue;
    const anchor = Math.min(input.messages.length - 1, Math.max(0, afterMessageIndex ?? input.messages.length - 1));
    const rows = insertions.get(anchor) ?? [];
    const rendered = messageBlockDetailLines(block, level, input.columns, rawText);
    const prefixLines = (anchor >= 0 ? logViewLines(historyMessages.slice(0, anchor + 1), input.columns, input.expandedToolIndexes).length : 0)
      + inlineRowsAt(input, anchor + 1, anchor);
    if (rendered.length > 0) blockRanges.push({ kind: 'message', id: block.id,
      start: prefixLines + priorBlockLines, end: prefixLines + priorBlockLines + rendered.length - 1, anchor });
    rows.push(...rendered);
    priorBlockLines += rendered.length;
    insertions.set(anchor, rows);
  }
  for (const marker of input.turnEndMarkers ?? []) {
    if (marker.afterMessageIndex < 0 || marker.afterMessageIndex >= input.messages.length) continue;
    const rows = insertions.get(marker.afterMessageIndex) ?? [];
    // Fit the trusted marker before applying its color; fitLogLine strips ANSI SGR.
    rows.push(`\x1b[34m${fitLogLine(marker.text, input.columns)}\x1b[0m`);
    // Separate the marker from the next turn's user row; the latest marker needs no trailing blank.
    if (marker.afterMessageIndex < input.messages.length - 1) rows.push('');
    insertions.set(marker.afterMessageIndex, rows);
  }
  const foldTargets: Array<{ kind: 'message'; id: string; start: number; end: number } | { kind: 'tool'; index: number; start: number; end: number }> = [
    ...blockRanges.map(({ kind, id, start, end }) => ({ kind, id, start, end })),
    ...toolFoldBlockRanges(historyMessages, input.columns, input.expandedToolIndexes).map((range) => {
      const offset = blockRanges.filter((block) => block.anchor < range.index).reduce((sum, block) => sum + block.end - block.start + 1, 0)
        + inlineRowsAt(input, range.index);
      return { kind: 'tool' as const, index: range.index, start: range.start + offset, end: range.end + offset };
    }),
  ];
  foldTargets.sort((left, right) => left.end - right.end);
  const lines = logViewLinesWithInsertions(historyMessages, input.columns, input.expandedToolIndexes, insertions);
  // An empty transcript is normal on a new session; do not render the shared history placeholder in Next TUI.
  return { foldTargets, lines: lines.length === 1 && lines[0] === "No chat history" ? [] : lines };
}

/** Inline rows that render before history message `index` (anchors strictly below it, plus same-anchor rows first). */
function inlineRowsAt(input: NextTuiLogFrameInput, index: number, markersBefore = index): number {
  let sum = 0;
  for (const [anchor, rows] of input.inlineInsertions ?? []) {
    if (anchor >= 0 && anchor < input.messages.length && anchor < index) sum += rows.length;
  }
  for (const marker of input.turnEndMarkers ?? []) {
    const anchor = marker.afterMessageIndex;
    // Markers follow message blocks at the same anchor; count each marker row plus its separator.
    if (anchor >= 0 && anchor < input.messages.length && anchor < markersBefore)
      sum += 1 + Number(anchor < input.messages.length - 1);
  }
  return sum;
}

/** Cache the expensive history and fold ranges while only the viewport or prompt changes. */
export function createNextTuiHistoryCache(): (input: NextTuiLogFrameInput) => PreparedHistory {
  let previous: { messages: NextTuiLogFrameInput['messages']; length: number; last: SerializedMessage | undefined;
    columns: number; expanded: string; markers: NextTuiLogFrameInput['turnEndMarkers'];
    blocks: NonNullable<NextTuiLogFrameInput['messageBlocks']>;
    inline: NextTuiLogFrameInput['inlineInsertions']; prepared: PreparedHistory } | null = null;
  return (input) => {
    const expanded = [...input.expandedToolIndexes].sort((a, b) => a - b).join(',');
    const blocks = input.messageBlocks ?? [];
    if (previous && previous.messages === input.messages && previous.length === input.messages.length
      && previous.last === input.messages.at(-1) && previous.columns === input.columns && previous.expanded === expanded
      && previous.inline === input.inlineInsertions
      && previous.markers?.length === input.turnEndMarkers?.length
      && (input.turnEndMarkers ?? []).every((marker, index) => {
        const prior = previous!.markers![index]!;
        return prior.afterMessageIndex === marker.afterMessageIndex && prior.text === marker.text;
      })
      && previous.blocks.length === blocks.length && blocks.every((entry, index) => {
        const prior = previous!.blocks[index]!;
        return prior.block === entry.block && prior.level === entry.level && prior.rawText === entry.rawText
          && prior.afterMessageIndex === entry.afterMessageIndex;
      })) return previous.prepared;
    const prepared = prepareHistory(input);
    previous = { messages: input.messages, length: input.messages.length, last: input.messages.at(-1),
      columns: input.columns, expanded, markers: input.turnEndMarkers?.map((marker) => ({ ...marker })),
      blocks: blocks.map((entry) => ({ ...entry })), inline: input.inlineInsertions, prepared };
    return prepared;
  };
}

/** Fit an activity row; tool rows («⏺ Read(file)» / «✓ Read(file) 3s») render dim so they read as progress, not reply text.
 *  The color is applied after fitting because fitLogLine strips SGR (same as the turn-end marker). */
export function nextTuiActivityRow(line: string, columns: number): string {
  const fitted = fitLogLine(line, columns);
  return isToolActivityLine(fitted) || isWorkingRow(fitted) ? `\x1b[2m${fitted}\x1b[22m` : fitted;
}

/** Activity as screen rows: a tool or working row stays one fitted row (it is progress); any other line is information
 *  (a slash command's answer such as «/memory list») and wraps to the width, never cut at the edge. */
export function nextTuiActivityRows(line: string, columns: number): string[] {
  const fitted = fitLogLine(line, columns);
  if (isToolActivityLine(fitted) || isWorkingRow(fitted)) return [nextTuiActivityRow(line, columns)];
  return wrapLogLines(line, columns);
}

/** Pure Next TUI log layout. The session messages and fold state are never changed. */
export function renderNextTuiLogFrame(input: NextTuiLogFrameInput, prepared = prepareHistory(input)): NextTuiLogFrame {
  const { foldTargets } = prepared;
  const promptLines = (input.promptLines?.length ? input.promptLines : [input.promptLine]).slice(-Math.max(1, input.rows));
  const history = [
    ...prepared.lines,
    // A notice (slash command output, a refusal) is information: wrapped to the width, never cut off at the edge.
    ...input.notices.flatMap((line) => wrapLogLines(line, input.columns).map((row) => dimContinueBanner(row))),
    ...input.activity.flatMap((line) => nextTuiActivityRows(line, input.columns)),
  ];
  // A picker or health line may grow the header. Keep the prompt, the footer and the row(s) under the prompt visible.
  const below = (input.belowPrompt ?? []).slice(0, Math.max(0, input.rows - promptLines.length));
  const footer = input.footer.slice(0, Math.max(0, Math.min(input.footer.length, input.rows - promptLines.length - below.length)));
  const headerBudget = Math.max(0, input.rows - footer.length - promptLines.length - below.length);
  const header = input.header.slice(0, headerBudget);
  const bodyRows = Math.max(0, input.rows - header.length - footer.length - promptLines.length - below.length);
  const maxScroll = bodyRows > 0 ? Math.max(0, history.length - bodyRows) : 0;
  const scroll = Math.max(0, Math.min(input.scroll, maxScroll));
  const start = Math.max(0, history.length - bodyRows - scroll);
  const visibleHistory = history.slice(start, start + bodyRows);
  // Conversation starts under the header and grows downward. Reserve unused
  // rows after it so the footer and input remain pinned until history fills.
  const leadingBlankRows = 0;
  const trailingBlankRows = Math.max(0, bodyRows - visibleHistory.length);
  const body = [...visibleHistory, ...Array.from({ length: trailingBlankRows }, () => '')];
  const lines = [...header, ...body, ...footer, ...promptLines, ...below];
  return { lines, body, promptRow: lines.length - below.length - promptLines.length + 1, scroll, maxScroll,
    logWindow: { start, rows: bodyRows, columns: input.columns, bodyTop: header.length + 1, leadingBlankRows, foldTargets } };
}

/** Resolve a terminal's one-based click row to the visible fold target under it. */
export function foldTargetAtScreenRow(
  targets: readonly NextTuiFoldTarget[],
  window: { start: number; bodyTop: number; leadingBlankRows: number; rows: number },
  screenRow: number,
): NextTuiFoldTarget | undefined {
  const bodyRow = screenRow - window.bodyTop;
  if (bodyRow < 0 || bodyRow >= window.rows) return undefined;
  const historyRow = window.start + bodyRow - window.leadingBlankRows;
  if (historyRow < 0) return undefined;
  return targets.find((target) => target.start <= historyRow && target.end >= historyRow);
}

/** Configured height at or below which informational status lines are hidden. */
export const NEXT_TUI_TITLE = 'elanous';

export function nextTuiCompactHeight(value = process.env.ELANOUS_NEXT_TUI_COMPACT_HEIGHT, configuredHeight?: number): number {
  const parsed = Number(value);
  if (value !== undefined && Number.isInteger(parsed) && parsed >= 8 && parsed <= 100) return parsed;
  return typeof configuredHeight === 'number' && Number.isInteger(configuredHeight)
    && configuredHeight >= 8 && configuredHeight <= 100 ? configuredHeight : 24;
}

export function nextTuiStatusAfterWelcome(value: string): string {
  return value.split(' · ').filter((part) => !/^(?:Enter 전송|Esc 취소|Ctrl\+Q 종료)$/.test(part)).join(' · ');
}

/** Compact mode drops only ambient chrome; failures and next actions stay visible. */
export function nextTuiCompactActionStatus(value: string): string {
  const status = value.trim();
  return /^(?:Enter 전송|응답 중|응답 완료|입력 포커스)$/.test(status) ? '' : status;
}

export function isNextTuiContextCountStatus(value: string): boolean {
  return /^ctx\s+[\d,]+\s+chars(?:\s*\/\s*[\d,]+)?$/i.test(value.trim());
}

/** Render all logical history without a fixed viewport; the painter owns visible rows. */
export function renderNextTuiCompactFrame(input: NextTuiLogFrameInput, prepared = prepareHistory(input)): NextTuiLogFrame {
  const promptLines = (input.promptLines?.length ? input.promptLines : [input.promptLine]).slice(-Math.max(1, input.rows));
  const body = [
    ...prepared.lines,
    // A notice (slash command output, a refusal) is information: wrapped to the width, never cut off at the edge.
    ...input.notices.flatMap((line) => wrapLogLines(line, input.columns).map((row) => dimContinueBanner(row))),
    ...input.activity.flatMap((line) => nextTuiActivityRows(line, input.columns)),
  ];
  // A fresh session still answers «what is on screen»: keep the one-row history placeholder on the
  // compact primary screen so the pinned header, every prompt row of a multiline composer and the
  // editing cursor keep their places (the log view keeps its empty-transcript layout untouched).
  if (body.length === 0) body.push('No chat history');
  const below = input.belowPrompt ?? [];
  const bodyRows = Math.max(1, input.rows - input.header.length - input.footer.length - promptLines.length - below.length);
  const maxScroll = Math.max(0, body.length - bodyRows);
  const scroll = Math.max(0, Math.min(input.scroll, maxScroll));
  const start = Math.max(0, body.length - bodyRows - scroll);
  // The tail stays full-length so the primary-screen painter can commit only
  // new history. A scrolled view is a temporary viewport, never new history.
  const visibleBody = scroll > 0 ? body.slice(start, start + bodyRows) : body;
  const lines = [...input.header, ...visibleBody, ...input.footer, ...promptLines, ...below];
  return { lines, body, promptRow: lines.length - below.length - promptLines.length + 1, scroll, maxScroll,
    logWindow: { start, rows: Math.min(bodyRows, body.length), columns: input.columns,
      bodyTop: input.header.length + 1, leadingBlankRows: 0, foldTargets: prepared.foldTargets } };
}

/** Only rows newly pushed out of the viewport enter terminal scrollback. */
type CompactViewportDecoration = (visible: readonly string[]) => readonly string[];

export function createNextTuiCompactPainter(write: (text: string) => void): {
  paint(lines: readonly string[], cursorCol: number, rows: number, columns: number, stableCount?: number, cursorRow?: number, stableStart?: number, decorate?: CompactViewportDecoration,
    boundary?: { kind: 'layout' | 'resize'; chatColumns: number; retainedStableCount: number }, retainedStableCount?: number): void;
  paintViewport(lines: readonly string[], cursorCol: number, rows: number, columns: number, cursorRow?: number, decorate?: CompactViewportDecoration): void;
  beforeExternalPaint(rows: number): void;
  invalidateViewport(resizeSegment?: boolean): void;
} {
  let committed = 0;
  let previousStable: readonly string[] = [];
  let previousRows: number | null = null;
  let previousColumns: number | null = null;
  let resizeSegmentPending = false;
  let initialViewportPreserved = false;
  const preserveInitialViewport = (rows: number) => {
    if (initialViewportPreserved) return;
    initialViewportPreserved = true;
    // The shell's last output can still be in the physical viewport. Move it
    // into terminal scrollback before any clear-screen paint replaces it.
    write(`\x1b[?25l\x1b[${rows};1H${'\r\n'.repeat(rows)}`);
  };
  return {
    beforeExternalPaint(rows) {
      // The sidebar and too-small-terminal views paint through the entry
      // screen cache. They share this primary-screen boundary with chat.
      preserveInitialViewport(rows);
      previousRows = null;
    },
    paintViewport(lines, cursorCol, rows, columns, cursorRow = lines.length, decorate) {
      preserveInitialViewport(rows);
      const visible = lines.slice(-rows);
      const visibleCursorRow = Math.max(1, Math.min(rows, cursorRow - Math.max(0, lines.length - rows)));
      write(`\x1b[?25l\x1b[H\x1b[2J${(decorate?.(visible) ?? visible).join('\r\n')}\x1b[${visibleCursorRow};${Math.max(1, cursorCol)}H\x1b[?25h`);
    },
    invalidateViewport(resizeSegment = false) {
      // Another view can replace the physical chat rows. Keep only history that
      // was already written to scrollback; the next paint must restore the rest.
      if (resizeSegment && previousColumns !== null) resizeSegmentPending = true;
      previousRows = null;
    },
    paint(lines, cursorCol, rows, columns, stableCount = Math.max(0, lines.length - 1), cursorRow = lines.length, stableStart = 0, decorate, boundary, retainedStableCount) {
      preserveInitialViewport(rows);
      // Chrome before stableStart can change on every paint. Only committed
      // chat history participates in the append-only scrollback ledger.
      const historyStart = Math.max(0, Math.min(lines.length, stableStart));
      const stable = lines.slice(historyStart, Math.max(historyStart, Math.min(lines.length, stableCount)));
      const changedCommitted = previousStable.slice(0, committed).some((line, index) => stable[index] !== line);
      const reservedRows = Math.min(rows, lines.length - stable.length);
      const resized = previousColumns !== null && (resizeSegmentPending || columns !== previousColumns || previousRows !== null && rows !== previousRows);
      const segment = previousColumns !== null ? boundary?.kind ?? (resized ? 'resize' : null) : null;
      if (segment) {
        // Primary-screen scrollback is append-only. A resize may reflow old
        // rows, so begin a new transcript segment rather than guessing which
        // old rows to replay. The terminal's shell and older TUI segments stay.
        const marker = (segment === 'layout'
          ? `── layout chat ${boundary!.chatColumns}x${rows} ──`
          : `── resize ${columns}x${rows} ──`).slice(0, Math.max(1, columns));
        // Repaint only the uncommitted stable tail before moving it into
        // scrollback. The physical viewport can contain streaming previews,
        // unsent input and sidetab chrome that must remain temporary.
        if (boundary) {
          const stableTail = previousStable.slice(committed);
          write(`\x1b[?25l\x1b[H\x1b[2J${stableTail.join('\r\n')}\x1b[${rows};1H${'\r\n'.repeat(rows)}${marker}${'\r\n'.repeat(rows)}`);
        } else {
          // Direct painter callers have no source cursor from the entry. Keep
          // their existing terminal-resize behavior until ownership is known.
          write(`\x1b[?25l\x1b[${rows};1H${'\r\n'.repeat(rows)}${marker}${'\r\n'.repeat(rows)}`);
        }
        // A pure append can be identified even when the terminal has wrapped
        // each old line at a new width. Keep rows appended in this same paint
        // in the new segment. An edited history becomes the boundary snapshot.
        if (boundary) committed = Math.min(stable.length, boundary.retainedStableCount);
        else {
          const oldText = previousStable.join('');
          const newText = stable.join('');
          let firstNew = 0;
          let matchedChars = 0;
          if (newText.startsWith(oldText)) {
            while (firstNew < stable.length && matchedChars < oldText.length) matchedChars += stable[firstNew++]!.length;
          }
          committed = newText.startsWith(oldText) && matchedChars === oldText.length ? firstNew : stable.length;
        }
      } else if (changedCommitted || stable.length < committed) {
        // Fold state changes rewrap already committed source units. The entry
        // supplies their source-position prefix; only a replacement session
        // with no common source starts at zero.
        committed = retainedStableCount === undefined ? 0 : Math.min(stable.length, retainedStableCount);
      }
      const newStable = stable.slice(Math.min(committed, stable.length));
      // Only persisted history may be pushed into terminal scrollback. Streaming
      // previews and menus are repainted in the viewport until they become stable.
      if (newStable.length + reservedRows > rows) {
        const padding = Array.from({ length: reservedRows }, () => '');
        write(`\x1b[?25l\x1b[H\x1b[2J${[...newStable, ...padding].join('\r\n')}`);
        committed = Math.min(stable.length, stable.length + reservedRows - rows);
      }
      const committedEnd = committed > 0 ? historyStart + committed : 0;
      // The window is the pinned header (up to `rows - 1` rows) plus the newest rows that fit under it, never
      // reaching back into rows already committed to scrollback, and never taller than the screen: a taller
      // paint scrolls its own top (the header) into scrollback on every repaint.
      // A fold can shrink the entire transcript back into the viewport; then everything is painted again,
      // or PageUp at the now-zero scroll range leaves only the footer visible.
      const chrome = Math.min(historyStart, Math.max(0, rows - 1));
      const fitsWhole = historyStart > 0 && lines.length <= rows;
      const bodyStart = fitsWhole ? 0
        : Math.max(chrome, Math.min(committedEnd, lines.length), lines.length - (rows - chrome));
      const visible = fitsWhole ? [...lines] : [...lines.slice(0, chrome), ...lines.slice(bodyStart)];
      const topChrome = fitsWhole ? Math.min(visible.length, historyStart) : chrome;
      const padding = Array.from({ length: historyStart > 0 ? Math.max(0, rows - visible.length) : 0 }, () => '');
      const pinned = [...visible.slice(0, topChrome), ...padding, ...visible.slice(topChrome)];
      // `cursorRow` is a 1-based row of `lines`; find it in the painted window (header rows keep their place).
      const cursorInWindow = fitsWhole ? cursorRow
        : cursorRow <= chrome ? cursorRow : chrome + Math.max(0, cursorRow - bodyStart);
      const visibleCursorRow = Math.max(1, Math.min(rows, cursorInWindow + padding.length));
      write(`\x1b[?25l\x1b[H\x1b[2J${(decorate?.(pinned) ?? pinned).join('\r\n')}\x1b[${visibleCursorRow};${Math.max(1, cursorCol)}H\x1b[?25h`);
      previousRows = rows;
      previousColumns = columns;
      previousStable = [...stable];
      resizeSegmentPending = false;
    },
  };
}

/** Enter advances the nearest visible MessageBlock by one detail tier. */
export function visibleMessageBlockDetailTarget(
  levels: ReadonlyMap<string, TuiDetailLevel>,
  blocks: readonly { readonly block: MessageBlock; readonly afterMessageIndex?: number }[],
  columns: number,
  window: { start: number; rows: number; rawTexts?: ReadonlyMap<string, string> },
  messages: readonly SerializedMessage[],
  expandedToolIndexes: ReadonlySet<number>,
): { readonly block: MessageBlock; readonly end: number } | undefined {
  if (window.rows <= 0) return undefined;
  const ranges: Array<{ block: MessageBlock; start: number; end: number }> = [];
  let insertedLines = 0;
  for (const { block, afterMessageIndex } of blocks) {
    if (block.body.kind === 'assistant' || block.body.kind === 'user') continue;
    const level = levels.get(block.id) ?? 0;
    const rendered = messageBlockDetailLines(block, level, columns, window.rawTexts?.get(block.id));
    if (rendered.length === 0 || messages.length === 0) continue;
    const anchor = Math.min(messages.length - 1, Math.max(0, afterMessageIndex ?? messages.length - 1));
    const baseLines = logViewLines(messages.slice(0, anchor + 1), columns, expandedToolIndexes).length;
    const start = baseLines + insertedLines;
    ranges.push({ block, start, end: start + rendered.length - 1 });
    insertedLines += rendered.length;
  }
  const visible = ranges.filter((range) => range.end >= window.start && range.start < window.start + window.rows);
  const target = visible.at(-1);
  return target && { block: target.block, end: target.end };
}

export function toggleVisibleMessageBlockDetail(
  levels: Map<string, TuiDetailLevel>,
  blocks: readonly { readonly block: MessageBlock; readonly afterMessageIndex?: number }[],
  columns: number,
  window: { start: number; rows: number; rawTexts?: ReadonlyMap<string, string> },
  messages: readonly SerializedMessage[],
  expandedToolIndexes: ReadonlySet<number>,
): boolean {
  const target = visibleMessageBlockDetailTarget(levels, blocks, columns, window, messages, expandedToolIndexes);
  if (!target) return false;
  levels.set(target.block.id, nextMessageBlockDetailLevel(target.block, levels.get(target.block.id) ?? 0));
  return true;
}
