// 🧠 MEMORY-TRIAGE-NO-LLM 문 ③ 의 입력 — 기억 «쓰임 원장» 생산자(PR-a · #38387). 덧붙임만 한다.
//
// S: 수명 문 규칙(ASK-MEMORY-TRIAGE-NO-LLM-1117 ③)은 «14일 동안 쓰임 0 → 보관»이다.
// C: main 에는 기억 id 별로 주입·회상을 남기는 원장이 없었다(PR 본문 «생산자 표»): 전역 주입은 `chat.memory-layer injected`,
//    자리 회상은 `memory recalled` 를 debug 로그로만 남긴다(레벨·보존에 매이고 logs.db 직접 열기 금지 R-FP4).
// Q: 판정 전에 무엇부터 쌓아야 하나?
// A: 시도 한 번 = 한 줄 `{v, at, store, seat, via, injected, used}` — 기억 id 의 해시 참조(`m:<hash>`)와 자리만(본문·이름 0) · 빈 시도도 한 줄.
//
// ⛔ 무결성 보장 없음(OP 판정 · #38387 5라운드). 줄이 빠지거나 하루 파일이 사라져도 이 원장은 알아채지 않는다.
//    그러니 이 원장만으로 판정(보관·강등·승격 후보)을 하지 않는다. 무결성 설계 = `내부 문서 `MEMORY-USAGE-LEDGER-INTEGRITY``
//    · 그 설계 뒤 별 PR(앞 시도의 코드는 가지 `wip/tc-memory-ledger-integrity-0329`).
//
// 세 얼굴:
//   관측 = 덧붙이기 실패마다 `memory.lifetime usage-record-failed`(warn · 본문 0) · 자리 id 가 틀리면 `usage-record-refused`.
//   판단 근거 = 줄 하나 = 시도 하나 · injected(고정 주입, 근거 없음) ↔ used(낱말 맞음·회상·검색 적중).
//   수복과 인계 = 실패는 던지지 않는다(부르는 턴을 막지 않는다) · 이 PR 에 판정은 없다(제안·보관 0).
//
// 자리: `<기억 뿌리>/.triage-usage/<UTC 날짜>.jsonl` — 하루 상한 원장(`.triage-daily.json`)과 같은 뿌리(전역·자리 저장소 공유).
//   O_APPEND 로 한 줄씩 덧붙인다. 기억 목록(`*.md`)과 섞이지 않는다.

import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { memoryRowRef, utcDay } from './write-gate.js';

export const MEMORY_USAGE_DIR = '.triage-usage';
export const MEMORY_USAGE_VERSION = 1;
export type MemoryUsageStore = 'global' | 'seat';
/** turn = 턴마다 주입·회상 시도 · search = 도구·CLI·근거 수집의 명시적 검색. */
export type MemoryUsageVia = 'turn' | 'search';

export interface MemoryUsageLine {
  v: number;
  at: string;
  store: MemoryUsageStore;
  seat: string | null;
  via: MemoryUsageVia;
  /** 근거 없이 실린 기억(고정 pinned) 참조. */
  injected: string[];
  /** 이 시도의 글·질의에 맞아 실리거나 꺼내진 기억 참조. */
  used: string[];
}

export type MemoryUsageFs = Pick<typeof nodeFs, 'mkdirSync' | 'appendFileSync'>;
export type MemoryUsageLog = (category: string, event: string, data: Record<string, unknown>, level?: 'info' | 'warn' | 'error') => void;
const defaultLog: MemoryUsageLog = (category, event, data, level) => {
  try { debug.log(category, event, data, level ? { level } : undefined); } catch { /* 관측 실패가 턴을 막지 않는다 */ }
};

const SEAT = /^[A-Z][A-Z0-9_-]{0,63}$/;

/** 기억 참조 — 전역 id(uuid)·자리 id(파일 이름) 둘 다 같은 해시 꼴(쓰기 문 사건의 `memoryRowRef` 와 같다). */
export const memoryUsageRef = (id: string): string => memoryRowRef(id);
export const memoryUsageDir = (root: string): string => join(root, MEMORY_USAGE_DIR);

/**
 * 시도 한 번을 한 줄로 덧붙인다. ids 는 기억 id(전역 uuid · 자리 파일 이름) — 여기서 해시 참조로 바꾼다(문면은 원장에 안 남는다).
 * 실패는 던지지 않는다 — 사건만 남긴다. 반환 = 덧붙였나.
 */
export function recordMemoryUsage(
  input: { store: MemoryUsageStore; seat?: string | null; via: MemoryUsageVia; injectedIds?: readonly string[]; usedIds?: readonly string[] },
  root: string,
  deps: { now?: Date; fs?: MemoryUsageFs; log?: MemoryUsageLog } = {},
): boolean {
  const fs = deps.fs ?? nodeFs;
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? new Date();
  const seat = input.store === 'seat' ? (input.seat ?? '').trim().toUpperCase() : null;
  if (input.store === 'seat' && !SEAT.test(seat ?? '')) {
    log('memory.lifetime', 'usage-record-refused', { store: input.store, cause: 'seat-invalid' }, 'warn');
    return false;
  }
  const day = utcDay(now);
  const used = [...new Set((input.usedIds ?? []).map(memoryUsageRef))];
  const usedSet = new Set(used);
  const injected = [...new Set((input.injectedIds ?? []).map(memoryUsageRef))].filter(ref => !usedSet.has(ref));
  const line: MemoryUsageLine = { v: MEMORY_USAGE_VERSION, at: now.toISOString(), store: input.store, seat, via: input.via, injected, used };
  try {
    const dir = memoryUsageDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 });
    return true;
  } catch (error) {
    log('memory.lifetime', 'usage-record-failed', {
      store: input.store, seat, via: input.via, day, cause: (error as NodeJS.ErrnoException)?.code ?? 'write-failed',
    }, 'warn');
    return false;
  }
}
