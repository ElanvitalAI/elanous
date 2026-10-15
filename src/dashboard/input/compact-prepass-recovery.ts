import type { ContentBlock, LLMMessage } from '../../llm.js';
import { isDeepStrictEqual } from 'node:util';

export function isUnknownCodex400(detail: string, error?: unknown): boolean {
  if (error && typeof error === 'object' && 'status' in error && 'provider' in error
    && error.status === 400 && error.provider === 'codex') return true;
  return /\bCodex\s+API\s+400\b/i.test(detail.replace(/\s+/g, ' '));
}

/** Restore only the repaired prefix, retaining messages appended during the retry. */
export function restoreRepairedHistory<T>(
  history: T[], originalValues: readonly T[], repaired: readonly T[], expectedRepairedValues: readonly T[],
): { restored: boolean; preservedTail: number } {
  if (history.length < repaired.length || repaired.some((message, index) => history[index] !== message)
    || !isDeepStrictEqual(history.slice(0, repaired.length), expectedRepairedValues)) {
    return { restored: false, preservedTail: Math.max(0, history.length - repaired.length) };
  }
  const preservedTail = history.length - repaired.length;
  history.splice(0, repaired.length, ...originalValues);
  return { restored: true, preservedTail };
}

/** Remove only protocol orphans; preserve every matched call/result and their order. */
export function repairCodexToolPairs(messages: readonly LLMMessage[]): {
  messages: LLMMessage[];
  removedCalls: number;
  removedResults: number;
  ambiguousIds: string[];
} {
  const seenCalls = new Set<string>();
  const seenResults = new Set<string>();
  const ambiguousIds = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id) {
        if (seenCalls.has(block.id)) ambiguousIds.add(block.id);
        seenCalls.add(block.id);
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        if (seenResults.has(block.tool_use_id)) ambiguousIds.add(block.tool_use_id);
        seenResults.add(block.tool_use_id);
      }
    }
  }
  // A repeated ID cannot be assigned to a unique call/result pair. Leave history intact.
  if (ambiguousIds.size > 0) {
    return { messages: [...messages], removedCalls: 0, removedResults: 0,
      ambiguousIds: [...ambiguousIds] };
  }
  const pending = new Map<string, string>();
  const completed = new Set<string>();
  const dropped = new Set<string>();
  let removedCalls = 0;
  let removedResults = 0;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const content = messages[messageIndex]!.content;
    if (!Array.isArray(content)) continue;
    for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
      const block = content[blockIndex]!;
      const key = `${messageIndex}:${blockIndex}`;
      if (block.type === 'tool_use') {
        if (!block.id || pending.has(block.id) || completed.has(block.id)) {
          dropped.add(key);
          removedCalls++;
        } else {
          pending.set(block.id, key);
        }
      } else if (block.type === 'tool_result') {
        if (!pending.has(block.tool_use_id)) {
          dropped.add(key);
          removedResults++;
        } else {
          pending.delete(block.tool_use_id);
          completed.add(block.tool_use_id);
        }
      }
    }
  }
  for (const key of pending.values()) {
    dropped.add(key);
    removedCalls++;
  }
  if (dropped.size === 0) return { messages: [...messages], removedCalls, removedResults, ambiguousIds: [] };
  const repaired: LLMMessage[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]!;
    if (!Array.isArray(message.content)) {
      repaired.push(message);
      continue;
    }
    const blocks = message.content.filter((_block: ContentBlock, blockIndex: number) =>
      !dropped.has(`${messageIndex}:${blockIndex}`));
    if (blocks.length > 0) repaired.push({ ...message, content: blocks });
    else if (message.content.length === 0) repaired.push(message);
  }
  return { messages: repaired, removedCalls, removedResults, ambiguousIds: [] };
}
