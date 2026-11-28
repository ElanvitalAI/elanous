// 🔭 MEMORY-OBSERVABILITY (대표 11-28 21:1x «기록 그리고 회상 두 개 모두 확인 · 메모리 관련 내용만 볼 방법») — one door for
// memory activity in `elanous logs`.
//
// S: memory events were spread over five categories (`memory` · `memory.triage` · `chat.memory-layer` · `bus` · and the
//    12k/day `memory.signal routed` frame noise under the same `memory` prefix), CLI writes (`eln memory add|pin --seat`)
//    never reached logs.db, and nothing said that a long-running seat session was still reading an index snapshot older
//    than the store (11-28: six 대표 cards written 20:57 were absent from OP's prompt until the child restarted 21:02).
// C: «did OP write it? did OP's turn carry it?» must be answerable with one filter, without opening any store.
// Q: what is the smallest shape that answers write ⊕ recall for every store?
// A: two categories — `memory.write` (event = action) and `memory.recall` (event = via) — one bounded schema
//    (store · seat · names/ids · reason · hit · bytes/tokens · session · stale index), names and counts only, never bodies.
//    `elanous logs --category memory.write,memory.recall --grep '"seat":"OP"'` shows only memory activity.
//    The legacy events stay as they are (existing tests and dashboards read them).
// 세 얼굴: 관측 = these two categories · 판단 근거 = `hit` / `stale` / `reason` fields · 수복 = fail-soft (a trace never
//    throws into a write or a turn).

import { debug } from '../debug/log.js';

export type MemoryTraceStore = 'seat' | 'common' | 'global' | 'surface-events';
export type MemoryRecallVia = 'session-start' | 'turn' | 'tool';

const NAMES_MAX = 10; // not-policy: log payload shape (how many names one trace line lists), not a behaviour knob
const NAME_MAX_CHARS = 80; // not-policy: log payload shape (per-name length in a trace line), not a behaviour knob

function boundedNames(names: readonly string[] | undefined): string[] | undefined {
  if (!names) return undefined;
  return names.slice(0, NAMES_MAX).map(n => (n.length > NAME_MAX_CHARS ? `${n.slice(0, NAME_MAX_CHARS)}…` : n));
}

export interface MemoryWriteTrace {
  store: MemoryTraceStore;
  /** created · updated · deduped · superseded · deleted · pinned · refused · failed · recorded · duplicate · promoted */
  action: string;
  seat?: string | null;
  name?: string;
  id?: string;
  /** who wrote it (`memory-cli.add-seat` · `msg-ack-digest` · `tool.memory_save` · `bus` …). */
  origin?: string;
  /** why it was refused / skipped. */
  reason?: string;
  bytes?: number;
}

export interface MemoryRecallTrace {
  store: MemoryTraceStore;
  via: MemoryRecallVia;
  seat?: string | null;
  /** at least one memory entered the prompt / tool result. */
  hit: boolean;
  names?: readonly string[];
  ids?: readonly string[];
  candidates?: number;
  /** characters (session-start index) or tokens (turn layers) that entered the prompt. */
  bytes?: number;
  tokens?: number;
  session?: string | null;
  /** why nothing entered: `low-context` · `no-match` · `already-shown` · `budget` · `empty-or-missing` · `error` · `off` (the task said no memory). */
  reason?: string;
  /** session-start index snapshot is older than the store's MEMORY.md (a write after the snapshot is not in the prompt). */
  staleIndex?: boolean;
  indexAgeMs?: number;
  lines?: number;
  truncated?: boolean;
}

export function traceMemoryWrite(t: MemoryWriteTrace): void {
  try {
    debug.log('memory.write', t.action, { ...t, ...(t.name !== undefined ? { name: boundedNames([t.name])![0] } : {}) }, { level: 'info' });
  } catch { /* fail-soft */ }
}

export function traceMemoryRecall(t: MemoryRecallTrace): void {
  try {
    const { names, ids, ...rest } = t;
    debug.log('memory.recall', t.via, {
      ...rest,
      ...(names || ids ? { count: names?.length ?? ids?.length ?? 0 } : {}),
      ...(names ? { names: boundedNames(names) } : {}),
      ...(ids ? { ids: boundedNames(ids) } : {}),
    });
  } catch { /* fail-soft */ }
}
