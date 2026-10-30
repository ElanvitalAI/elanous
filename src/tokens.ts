// ── Token estimation ──
//
// Rough heuristic — no tokenizer, no provider API call. chars / 4 is a
// well-known approximation for English + code; Korean/CJK overshoot
// (closer to chars / 2) so we upweight non-ASCII. Off by ±30% vs a
// real tokenizer, which is fine for "am I near the context window"
// decisions. Exact counts arrive from the provider's streamed usage
// field when the call completes.

export interface TokenBudget {
  /** Estimated tokens in the assembled prompt. */
  used: number;
  /** Soft cap we refuse to exceed. */
  max: number;
  /** Percent [0..1] of max used. */
  ratio: number;
}

const DEFAULT_MAX = 24_000;

/** Count approximate tokens in a single string. Non-ASCII chars are
 *  weighted 1/2 tok/char (CJK is ~1 tok per 1-2 chars in BPE); ASCII
 *  falls near 1/4 tok/char. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / 4 + wide / 2);
}

export interface MessageLike {
  role: string;
  content: string | unknown[];
  /** Opaque reasoning replayed by the Codex Responses adapter. */
  codexReasoningItems?: unknown[];
}

function estimateStructuredTokens(value: unknown, ancestors = new Set<object>()): number {
  if (typeof value === 'string') return estimateTokens(value);
  if (value === null || typeof value !== 'object') return 1;
  if (ancestors.has(value)) return 200; // malformed cyclic extension: conservative block floor
  ancestors.add(value);
  let total = 2; // JSON brackets/braces
  if (Array.isArray(value)) {
    total += Math.ceil(value.length / 4); // commas
    for (const item of value) total += estimateStructuredTokens(item, ancestors);
  } else {
    const entries = Object.entries(value);
    total += Math.ceil(entries.length / 4); // commas
    for (const [key, item] of entries) {
      total += estimateTokens(key) + 1 + estimateStructuredTokens(item, ancestors);
    }
  }
  ancestors.delete(value);
  return total;
}

export function estimateMessagesTokens(messages: MessageLike[]): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // per-message overhead heuristic
    if (typeof m.content === 'string') total += estimateTokens(m.content);
    else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || typeof block !== 'object') continue;
        const obj = block as Record<string, unknown>;
        if (obj.type === 'tool_use' || obj.type === 'tool_result') {
          // These payloads are replayed as structured JSON; fixed block cost
          // misses large args/results. Retain the old 200-token floor for
          // tiny blocks so many small calls cannot under-trigger compaction.
          total += Math.max(200, estimateStructuredTokens(obj));
        } else if (typeof obj.text === 'string') {
          total += estimateTokens(obj.text);
        } else if (typeof obj.content === 'string') {
          // Wave 2 (2026-05-04) · tool_result block content matters
          // for compact diagnostics — large outputs should count
          // toward the budget so /compact's before/after delta and
          // shouldAutoCompact's threshold both see the real load.
          total += estimateTokens(obj.content);
        } else {
          // images / tool_use blocks — rough 200 tok cost each
          total += 200;
        }
      }
    }
    if (m.role === 'assistant' && m.codexReasoningItems?.length) {
      total += estimateStructuredTokens(m.codexReasoningItems);
    }
  }
  return total;
}

export function budget(used: number, max: number = DEFAULT_MAX): TokenBudget {
  const ratio = Math.max(0, Math.min(1, used / max));
  return { used, max, ratio };
}

/** Drop messages from the oldest-end until the budget fits. The first
 *  system message (if present) is always kept. Never drops the two
 *  newest messages (user + pending assistant) — those are load-bearing. */
export function trimToBudget<T extends MessageLike>(
  messages: T[],
  max: number = DEFAULT_MAX,
): { kept: T[]; dropped: number; used: number } {
  if (messages.length === 0) return { kept: [], dropped: 0, used: 0 };
  const systemIndex = messages[0].role === 'system' ? 0 : -1;
  let kept: T[] = [...messages];
  let used = estimateMessagesTokens(kept);
  let dropped = 0;
  // Never drop the last 2 messages — those are context for the current turn.
  while (used > max && kept.length - (systemIndex >= 0 ? 1 : 0) > 2) {
    const dropAt = systemIndex + 1;
    if (dropAt >= kept.length - 2) break;
    kept.splice(dropAt, 1);
    dropped++;
    used = estimateMessagesTokens(kept);
  }
  return { kept, dropped, used };
}

export function formatBudget(b: TokenBudget): string {
  const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  return `tok ${k(b.used)}/${k(b.max)}`;
}

export const DEFAULT_TOKEN_BUDGET = DEFAULT_MAX;
