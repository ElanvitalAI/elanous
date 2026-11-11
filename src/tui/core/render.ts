import type { SerializedMessage } from '../../session/index.js';
import type { MessageBlock } from '../../conv-substrate/message-block.js';
import { parseToolResultEnvelope } from '../../chat/tool-render/result-text.js';
import { fitLogLine, logViewLines, logViewLinesWithInsertions, toolFoldBlockRanges } from '../chat/log-view.js';
import { messageBlockDetailLines, nextMessageBlockDetailLevel, type TuiDetailLevel } from '../chat/message-block-view.js';

const HIDDEN_INTERNAL_TOOL_NAMES = new Set(['AgentOutput', 'AgentList', 'TaskGet', 'TaskList', 'update_goal', 'UpdateGoal']);
const HIDDEN_INTERNAL_TOOL_CALLS = new Set(['Agent', 'AgentOutput', 'AgentList', 'TaskGet', 'TaskList', 'update_goal', 'UpdateGoal']);

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
  readonly messageBlocks?: readonly { readonly block: MessageBlock; readonly level?: TuiDetailLevel; readonly rawText?: string; readonly afterMessageIndex?: number }[];
  readonly columns: number;
  readonly rows: number;
  readonly header: readonly string[];
  readonly footer: readonly string[];
  readonly promptLine: string;
  readonly promptLines?: readonly string[];
  readonly notices: readonly string[];
  readonly activity: readonly string[];
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
  const historyMessages = input.messages.map((message) => {
    if (message.role !== 'tool') return message;
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
  const blockRanges: Array<{ kind: 'message'; id: string; start: number; end: number; anchor: number }> = [];
  let priorBlockLines = 0;
  for (const { block, level, rawText, afterMessageIndex } of visibleMessageBlocks) {
    if (block.body.kind === 'assistant' || block.body.kind === 'user') continue;
    const anchor = Math.min(input.messages.length - 1, Math.max(0, afterMessageIndex ?? input.messages.length - 1));
    const rows = insertions.get(anchor) ?? [];
    const rendered = messageBlockDetailLines(block, level, input.columns, rawText);
    const prefixLines = anchor >= 0 ? logViewLines(historyMessages.slice(0, anchor + 1), input.columns, input.expandedToolIndexes).length : 0;
    if (rendered.length > 0) blockRanges.push({ kind: 'message', id: block.id,
      start: prefixLines + priorBlockLines, end: prefixLines + priorBlockLines + rendered.length - 1, anchor });
    rows.push(...rendered);
    priorBlockLines += rendered.length;
    insertions.set(anchor, rows);
  }
  const foldTargets: Array<{ kind: 'message'; id: string; start: number; end: number } | { kind: 'tool'; index: number; start: number; end: number }> = [
    ...blockRanges.map(({ kind, id, start, end }) => ({ kind, id, start, end })),
    ...toolFoldBlockRanges(historyMessages, input.columns, input.expandedToolIndexes).map((range) => {
      const offset = blockRanges.filter((block) => block.anchor < range.index).reduce((sum, block) => sum + block.end - block.start + 1, 0);
      return { kind: 'tool' as const, index: range.index, start: range.start + offset, end: range.end + offset };
    }),
  ];
  foldTargets.sort((left, right) => left.end - right.end);
  const lines = logViewLinesWithInsertions(historyMessages, input.columns, input.expandedToolIndexes, insertions);
  // An empty transcript is normal on a new session; do not render the shared history placeholder in Next TUI.
  return { foldTargets, lines: lines.length === 1 && lines[0] === "대화 기록 없음" ? [] : lines };
}

/** Cache the expensive history and fold ranges while only the viewport or prompt changes. */
export function createNextTuiHistoryCache(): (input: NextTuiLogFrameInput) => PreparedHistory {
  let previous: { messages: NextTuiLogFrameInput['messages']; length: number; last: SerializedMessage | undefined;
    columns: number; expanded: string; blocks: NonNullable<NextTuiLogFrameInput['messageBlocks']>; prepared: PreparedHistory } | null = null;
  return (input) => {
    const expanded = [...input.expandedToolIndexes].sort((a, b) => a - b).join(',');
    const blocks = input.messageBlocks ?? [];
    if (previous && previous.messages === input.messages && previous.length === input.messages.length
      && previous.last === input.messages.at(-1) && previous.columns === input.columns && previous.expanded === expanded
      && previous.blocks.length === blocks.length && blocks.every((entry, index) => {
        const prior = previous!.blocks[index]!;
        return prior.block === entry.block && prior.level === entry.level && prior.rawText === entry.rawText
          && prior.afterMessageIndex === entry.afterMessageIndex;
      })) return previous.prepared;
    const prepared = prepareHistory(input);
    previous = { messages: input.messages, length: input.messages.length, last: input.messages.at(-1),
      columns: input.columns, expanded, blocks: blocks.map((entry) => ({ ...entry })), prepared };
    return prepared;
  };
}

/** Pure Next TUI log layout. The session messages and fold state are never changed. */
export function renderNextTuiLogFrame(input: NextTuiLogFrameInput, prepared = prepareHistory(input)): NextTuiLogFrame {
  const { foldTargets } = prepared;
  const promptLines = (input.promptLines?.length ? input.promptLines : [input.promptLine]).slice(-Math.max(1, input.rows));
  const history = [
    ...prepared.lines,
    ...input.notices.map((line) => fitLogLine(line, input.columns)),
    ...input.activity.map((line) => fitLogLine(line, input.columns)),
  ];
  // A picker or health line may grow the header. Keep the prompt and footer visible.
  const footer = input.footer.slice(0, Math.max(0, Math.min(input.footer.length, input.rows - promptLines.length)));
  const headerBudget = Math.max(0, input.rows - footer.length - promptLines.length);
  const header = input.header.slice(0, headerBudget);
  const bodyRows = Math.max(0, input.rows - header.length - footer.length - promptLines.length);
  const maxScroll = bodyRows > 0 ? Math.max(0, history.length - bodyRows) : 0;
  const scroll = Math.max(0, Math.min(input.scroll, maxScroll));
  const start = Math.max(0, history.length - bodyRows - scroll);
  const visibleHistory = history.slice(start, start + bodyRows);
  // Keep a short transcript just above the prompt. New turns then grow upward
  // from the input area instead of starting under the header and pushing the
  // user's point of attention down the screen.
  const leadingBlankRows = scroll === 0 ? Math.max(0, bodyRows - visibleHistory.length) : 0;
  const body = [...Array.from({ length: leadingBlankRows }, () => ''), ...visibleHistory];
  const lines = [...header, ...body, ...footer, ...promptLines];
  return { lines, body, promptRow: lines.length - promptLines.length + 1, scroll, maxScroll,
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
