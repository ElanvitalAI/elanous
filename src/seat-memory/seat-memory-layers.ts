// 🧠 OP-MEMORY-PARITY (O6) — 자리 세션 턴 앞 두 층: ① 세션 시작 색인(대화마다 한 번 · 바이트 고정)
// ② 턴 회상(사람·우편 글에 맞는 기억 본문 · 매 턴 · 같은 대화에서 이미 꺼낸 것은 다시 안 꺼냄).
// 대시보드(turn-preamble)와 새 TUI REPL 이 같이 쓴다. 실패는 층만 빠지고 턴은 간다(fail-soft).

import type { LLMMessage } from '../llm.js';
import { debug } from '../debug/log.js';
import { buildSeatMemoryIndexSystemMessages, resolveSeatMemoryContext, type SeatBootDeps } from '../seat/seat-boot-preamble.js';
import { recallSeatMemoriesForTurn } from './seat-memory.js';

export interface SeatMemoryLayers { index: LLMMessage[]; recall: LLMMessage[] }

/** 턴 회상 블록 문면(없으면 null) — REPL 은 이것을 사용자 역할 텍스트 블록으로 싣는다. */
export function seatMemoryRecallText(ctx: { cwd: string; userText: string; sessionId?: string }, deps: SeatBootDeps = {}): string | null {
  try {
    const target = resolveSeatMemoryContext(ctx.cwd, deps);
    if (!target) return null;
    return recallSeatMemoriesForTurn({
      seat: target.seat, dir: target.dir, text: ctx.userText,
      ...(ctx.sessionId !== undefined ? { sessionKey: `${target.seat}:${ctx.sessionId}` } : {}),
    })?.block ?? null;
  } catch (error) {
    debug.log('memory', 'recall-failed', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export function buildSeatMemoryLayers(ctx: { cwd: string; userText: string; sessionId?: string }, deps: SeatBootDeps = {}): SeatMemoryLayers {
  let index: LLMMessage[] = [];
  try {
    index = buildSeatMemoryIndexSystemMessages({ cwd: ctx.cwd, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) }, deps);
  } catch { /* 색인 층만 빠진다 */ }
  const text = seatMemoryRecallText(ctx, deps);
  return { index, recall: text ? [{ role: 'system', content: text }] : [] };
}
