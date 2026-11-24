// ELN-COMPACT-EVERY-TURN ② — deterministic old-tool-result pruning inside one tool loop (no LLM call).
//
// Design: ~/elanous-hq/seat-state/OP/research/TOOL-CONTEXT-PRUNING-5CLI-1124.md items 2–5 (grok-build 50% prune +
// recent-turn protection · hermes-agent informative one-line placeholders + hysteresis · openclaw frozen projection).
// A long OP turn carries dozens of tool rounds; the old results dominate the request (up to 340K of the 400K-char
// cap) and were only shed by the request-size guard or a mid-loop compaction that rewrites the prefix. Here, once
// the request reaches half the context window, tool results older than the last few rounds become a one-line
// placeholder «[tool Name] args → ok|error, N lines». A placeholder is a pure function of the call and its
// result and is never rewritten, so every later request replays the same bytes (cache-stable prefix). A prune is
// committed only when it reclaims enough, and does not run again until the request has regrown by that much.

import type { ContentBlock, LLMMessage } from '../llm.js';
import { estimateMessagesTokens } from '../tokens.js';

/** Placeholder head — a result that already starts with it is frozen and never pruned again. */
export const PRUNED_TOOL_RESULT_HEAD = '[tool ';

export interface ToolResultPruneOptions {
  /** Context window of the active model, in tokens. */
  readonly contextTokens: number;
  /** Prune once the request reaches this share of the window (default 0.5 — grok-build PruningConfig). */
  readonly triggerRatio?: number;
  /** The most recent tool rounds kept verbatim (default 3). */
  readonly protectRounds?: number;
  /** Commit only when at least this many tokens come back (default 4000). */
  readonly minReclaimTokens?: number;
}

/** Per-loop memory for hysteresis: the request size a committed prune left. */
export interface ToolResultPruneState { committedAtTokens?: number }

export interface ToolResultPruneOutcome {
  readonly fired: boolean;
  readonly reason: 'under-trigger' | 'regrow-hold' | 'nothing-old' | 'below-min-reclaim' | 'pruned';
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly prunedResults: number;
}

const DEFAULT_TRIGGER_RATIO = 0.5; // 출처: TOOL-CONTEXT-PRUNING-5CLI-1124 §eln 2 (grok-build 50%)
const DEFAULT_PROTECT_ROUNDS = 3; // 출처: TOOL-CONTEXT-PRUNING-5CLI-1124 §eln 2 (최근 3턴 보호)
const DEFAULT_MIN_RECLAIM_TOKENS = 4_000; // 출처: TOOL-CONTEXT-PRUNING-5CLI-1124 §eln 4 (최소 회수량 — hermes 히스테리시스)
const ARGS_PREVIEW_CHARS = 80; // 출처: hermes-agent 한 줄 자리표시 길이 수준

function resultText(content: string | readonly unknown[]): string {
  if (typeof content === 'string') return content;
  return content.map((item) => (item && typeof item === 'object' && (item as { type?: unknown }).type === 'text'
    ? String((item as { text?: unknown }).text ?? '') : '')).join('\n');
}

function argsPreview(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const command = input.command;
  const head = Array.isArray(command) ? command.join(' ')
    : typeof command === 'string' ? command
      : typeof input.file_path === 'string' ? input.file_path
        : JSON.stringify(input);
  const flat = head.replace(/\s+/gu, ' ').trim();
  return flat.length > ARGS_PREVIEW_CHARS ? `${flat.slice(0, ARGS_PREVIEW_CHARS - 1)}…` : flat;
}

/** The one-line stand-in for an old result (pure: same call and result → same bytes). */
export function toolResultPlaceholder(name: string, input: Record<string, unknown> | undefined, content: string | readonly unknown[], isError: boolean): string {
  const text = resultText(content);
  const lines = text === '' ? 0 : text.split('\n').length;
  const args = argsPreview(input);
  return `${PRUNED_TOOL_RESULT_HEAD}${name}]${args ? ` ${args}` : ''} → ${isError ? 'error' : 'ok'}, ${lines} lines`;
}

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;

/** Prune old tool results in place when the request is large enough and the reclaim is worth it. */
export function pruneOldToolResults(history: LLMMessage[], options: ToolResultPruneOptions, state: ToolResultPruneState): ToolResultPruneOutcome {
  const beforeTokens = estimateMessagesTokens(history);
  const none = (reason: ToolResultPruneOutcome['reason']): ToolResultPruneOutcome => ({ fired: false, reason, beforeTokens, afterTokens: beforeTokens, prunedResults: 0 });
  if (beforeTokens < options.contextTokens * (options.triggerRatio ?? DEFAULT_TRIGGER_RATIO)) return none('under-trigger');
  const minReclaim = options.minReclaimTokens ?? DEFAULT_MIN_RECLAIM_TOKENS;
  if (state.committedAtTokens !== undefined && beforeTokens < state.committedAtTokens + minReclaim) return none('regrow-hold');

  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const roundAt: number[] = [];
  history.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content as ContentBlock[]) {
      if (block.type === 'tool_use') calls.set(block.id, { name: block.name, input: block.input });
    }
    if ((message.content as ContentBlock[]).some((block) => block.type === 'tool_result')) roundAt.push(index);
  });
  const protectFrom = roundAt.length > (options.protectRounds ?? DEFAULT_PROTECT_ROUNDS)
    ? roundAt[roundAt.length - (options.protectRounds ?? DEFAULT_PROTECT_ROUNDS)]!
    : -1;
  if (protectFrom < 0) return none('nothing-old');

  const edits: Array<{ message: number; block: number; placeholder: string }> = [];
  for (const index of roundAt) {
    if (index >= protectFrom) break;
    (history[index]!.content as ContentBlock[]).forEach((block, blockIndex) => {
      if (block.type !== 'tool_result') return;
      const text = resultText((block as ToolResultBlock).content);
      if (text.startsWith(PRUNED_TOOL_RESULT_HEAD)) return; // frozen
      const call = calls.get((block as ToolResultBlock).tool_use_id);
      const placeholder = toolResultPlaceholder(call?.name ?? 'tool', call?.input, (block as ToolResultBlock).content, (block as ToolResultBlock).isError === true);
      if (placeholder.length < text.length) edits.push({ message: index, block: blockIndex, placeholder });
    });
  }
  if (edits.length === 0) return none('nothing-old');

  const projected = history.map((message, index) => {
    const own = edits.filter((edit) => edit.message === index);
    if (own.length === 0) return message;
    const content = (message.content as ContentBlock[]).map((block, blockIndex) => {
      const edit = own.find((candidate) => candidate.block === blockIndex);
      return edit ? { ...(block as ToolResultBlock), content: edit.placeholder } : block;
    });
    return { ...message, content };
  });
  const afterTokens = estimateMessagesTokens(projected);
  if (beforeTokens - afterTokens < minReclaim) return none('below-min-reclaim');
  history.splice(0, history.length, ...projected);
  state.committedAtTokens = afterTokens;
  return { fired: true, reason: 'pruned', beforeTokens, afterTokens, prunedResults: edits.length };
}
