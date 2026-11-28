// 🧠 OP-MEMORY-PARITY (O6) — 자리 세션 턴 앞 두 층: ① 세션 시작 색인(대화마다 한 번 · 바이트 고정)
// ② 턴 회상(사람·우편 글에 맞는 기억 본문 · 매 턴 · 같은 대화에서 이미 꺼낸 것은 다시 안 꺼냄).
// 대시보드(turn-preamble)와 새 TUI REPL 이 같이 쓴다. 실패는 층만 빠지고 턴은 간다(fail-soft).

import type { LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import { buildSeatMemoryIndexSystemMessages, resolveSessionMemoryStore, seatMemoryIndexSnapshot, seatMemoryIndexStaleness, type SeatBootDeps } from '../seat/seat-boot-preamble.js';
import { listSeatMemories, readSeatMemoryIndex, recallSeatMemoriesForTurn } from './seat-memory.js';
import { traceMemoryRecall } from './memory-trace.js';

export interface SeatMemoryLayers { index: LLMMessage[]; recall: LLMMessage[] }

const CROWN = '\u{1F451}';
export interface CrownTailCaps { readonly prefix: string; readonly turnMaxCards: number; readonly turnMaxChars: number; readonly updateMaxChars: number }
export interface CrownTail { readonly text: string; readonly cards: readonly string[]; readonly updates: number }

/**
 * ELN-OP-CROWN-MEMORY — the turn tail (user role · never the system prompt, so the cache prefix stays):
 *   S2 every live `crown-` card of the seat store, whatever the turn's words (a self-decided assign turn has no «MK» to key on) —
 *      newest expiry first, ≤ turnMaxCards · ≤ turnMaxChars · an expired one (description «만료 …» past) is skipped;
 *   S1 the seat index lines the session-start snapshot does not hold (written after it · a long-running session never re-reads
 *      its index), ≤ updateMaxChars. Pure over the store files ⊕ the snapshot text.
 */
export function crownTurnTail(opts: { seat: string; dir: string; nowMs: number; snapshot: string | null }, caps: CrownTailCaps): CrownTail | null {
  const { expiryOfDescription } = require('../kit/crown-directive/index.js') as typeof import('../kit/crown-directive/index.js');
  const live = listSeatMemories(opts.dir).filter((e) => e.name.startsWith(caps.prefix)).map((e) => ({ e, exp: expiryOfDescription(e.description) }))
    .filter((x) => x.exp === null || x.exp > opts.nowMs).sort((a, b) => (b.exp ?? 0) - (a.exp ?? 0) || a.e.name.localeCompare(b.e.name));
  const cards: string[] = []; const chunks: string[] = []; let used = 0;
  for (const { e } of live) {
    if (cards.length >= caps.turnMaxCards) break;
    const chunk = `### ${e.name}\n${e.body}`;
    if (used + chunk.length > caps.turnMaxChars) continue;
    chunks.push(chunk); cards.push(e.name); used += chunk.length;
  }
  const updates: string[] = [];
  if (opts.snapshot !== null) {
    let room = caps.updateMaxChars;
    for (const line of readSeatMemoryIndex(opts.dir).split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (opts.snapshot.includes(line) || cards.some((n) => line.startsWith(`- [${n}]`))) continue;
      if (line.length > room) break;
      updates.push(line); room -= line.length;
    }
  }
  if (!cards.length && !updates.length) return null;
  const parts = [
    ...(cards.length ? [`## ${CROWN} 지시 카드 — ${opts.seat} (만료 전까지 매 턴 · 배경이 아니라 지금 유효한 지시 · 배정/이관 직전 자동 대조)\n\n${chunks.join('\n\n')}`] : []),
    ...(updates.length ? [`## 자리 기억 갱신 — ${opts.seat} (세션 시작 색인 뒤에 새로 쓴 줄 · 본문은 memory_search)\n${updates.join('\n')}`] : []),
  ];
  return { text: parts.join('\n\n'), cards, updates: updates.length };
}

/** The live tail: caps from graphs/policies/crown-directives.yaml · S1 only when MEMORY-OBSERVABILITY says the session-start index
 *  is stale (seatMemoryIndexStaleness · #40723) — then the snapshot = this conversation's cached index text. Fail-soft (null). */
function liveCrownTail(seat: string, dir: string, cwd: string, stale: boolean): string | null {
  try {
    const kit = require('../kit/crown-directive/index.js') as typeof import('../kit/crown-directive/index.js');
    const p = kit.loadCrownDirectivePolicy();
    const tail = crownTurnTail({ seat, dir, nowMs: Date.now(), snapshot: stale ? seatMemoryIndexSnapshot(cwd) : null },
      { prefix: kit.CROWN_CARD_PREFIX, turnMaxCards: p.turnMaxCards, turnMaxChars: p.turnMaxChars, updateMaxChars: p.updateMaxChars });
    if (tail) debug.log('memory', 'crown-tail', { seat, cards: tail.cards, updates: tail.updates, chars: tail.text.length });
    return tail?.text ?? null;
  } catch (error) {
    debug.log('memory', 'crown-tail-failed', { seat, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** One turn / task of a seat session. `memory: 'off'` = «do not use memory for this task» (MEMORY-CONTRACT E-9) — a structured
 *  input from the task, never guessed from its words. It holds for this call only: the store is untouched and the next task
 *  without it recalls again. */
export interface SeatMemoryTurnCtx { cwd: string; userText: string; sessionId?: string; memory?: 'on' | 'off' }

/** 턴 회상 블록 문면(없으면 null) — REPL 은 이것을 사용자 역할 텍스트 블록으로 싣는다. ELN-OP-CROWN-MEMORY: 회상 ⊕ 지시 카드 꼬리.
 *  MEMORY-NO-USE-FLAG-PER-TASK — `memory: 'off'` = 회상 0 · 꼬리 0 · 저장소는 그대로 · memory.recall turn reason=off. */
export function seatMemoryRecallText(ctx: SeatMemoryTurnCtx, deps: SeatBootDeps = {}): string | null {
  try {
    const target = resolveSessionMemoryStore(ctx.cwd, deps); // MEMORY-STORE-SPLIT — CLI 와 같은 해석기
    if (!target) return null;
    if (ctx.memory === 'off') {
      traceMemoryRecall({ store: 'seat', via: 'turn', seat: target.seat, hit: false, reason: 'off', ...(ctx.sessionId !== undefined ? { session: ctx.sessionId } : {}) });
      return null;
    }
    // MEMORY-OBSERVABILITY — say on every turn whether the session-start index is older than the store.
    const staleness = seatMemoryIndexStaleness(ctx.cwd);
    const recall = recallSeatMemoriesForTurn({
      seat: target.seat, dir: target.dir, text: ctx.userText,
      ...(ctx.sessionId !== undefined ? { sessionKey: `${target.seat}:${ctx.sessionId}` } : {}),
      trace: { session: ctx.sessionId ?? null, ...(staleness ?? {}) },
    })?.block ?? null;
    const tail = liveCrownTail(target.seat, target.dir, ctx.cwd, staleness?.staleIndex === true);
    const parts = [recall, tail].filter((p): p is string => !!p);
    return parts.length ? parts.join('\n\n') : null;
  } catch (error) {
    debug.log('memory', 'recall-failed', { error: error instanceof Error ? error.message : String(error) });
    // MEMORY-FAILURE-TRUTH (E-11) — an unreadable store is not «nothing matched»: the turn goes on without the layer, but the
    // recall trace says error (none ≠ failure).
    let seat: string | null = null;
    try { seat = resolveSessionMemoryStore(ctx.cwd, deps)?.seat ?? null; } catch { /* the seat stays unknown */ }
    traceMemoryRecall({ store: 'seat', via: 'turn', seat, hit: false, reason: 'error', ...(ctx.sessionId !== undefined ? { session: ctx.sessionId } : {}) });
    return null;
  }
}

export function buildSeatMemoryLayers(ctx: SeatMemoryTurnCtx, deps: SeatBootDeps = {}): SeatMemoryLayers {
  let index: LLMMessage[] = [];
  try {
    index = buildSeatMemoryIndexSystemMessages({ cwd: ctx.cwd, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) }, deps);
  } catch { /* 색인 층만 빠진다 */ }
  const text = seatMemoryRecallText(ctx, deps);
  return { index, recall: text ? [{ role: 'system', content: text }] : [] };
}
