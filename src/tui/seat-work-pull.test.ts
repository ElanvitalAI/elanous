import { describe, expect, test } from 'bun:test';

// ── SEAT-WORK-PULL 배선층 (OP #139787) — RED 먼저: 모듈이 없으면 이 시험은 실패한다. ──
// 계약: 자리가 IDLE(≠busy)이고 맡은 일이 없으면 pullNextCellFor 로 다음 칸을 당겨
//       칸 본문(turnOpensWith)을 큐 노티스(source 'work-pull')로 넣고 queueWake 를 inject
//       해 턴을 연다. 큐가 비었으면 노티스·inject 없이 «일감 0» 근거 줄만 돌려준다.

import { createSeatWorkPull, mountSeatWorkPull } from './seat-work-pull.js';
import type { WorkCell, WorkPullResult } from '../seat-loop/work-pull.js';

function fakeDeps(pull: WorkPullResult, opts: { busy?: boolean } = {}) {
  const calls: { notices: Array<{ text: string; source: string }>; injects: number } = { notices: [], injects: 0 };
  const deps = {
    seat: 'SEAT-A',
    busy: () => opts.busy ?? false,
    readChecklist: (): WorkCell[] => [
      { id: 'cell-1', title: '칸1', status: 'yellow', owner: null, priority: 'P0' },
    ],
    pull: (_seat: string, _cells: WorkCell[]) => pull,
    enqueueNotice: (text: string, source: string) => { calls.notices.push({ text, source }); },
    injectKey: () => { calls.injects += 1; },
    queueWake: { marker: 'queue-wake' },
  };
  return { deps, calls };
}

describe('SEAT-WORK-PULL 배선 — idle 자리가 일을 당겨 턴을 연다', () => {
  test('busy 자리는 당기지 않는다 — notice·inject 0회', () => {
    const { deps, calls } = fakeDeps(
      { kind: 'claimed', claim: { db: ':memory:', cellId: 'cell-1', seat: 'SEAT-A', token: 't' }, cell: { id: 'cell-1', title: '칸1', status: 'yellow', owner: null, priority: 'P0' }, turnOpensWith: '[work-pull] 칸1' },
      { busy: true },
    );
    const pull = createSeatWorkPull(deps as never);
    const out = pull();
    expect(calls.notices).toEqual([]);
    expect(calls.injects).toBe(0);
    expect(out).toBeNull();
  });

  test('idle + claimed → 칸 본문을 source work-pull 노티스로 넣고 queueWake 1회 inject', () => {
    const { deps, calls } = fakeDeps(
      { kind: 'claimed', claim: { db: ':memory:', cellId: 'cell-1', seat: 'SEAT-A', token: 't' }, cell: { id: 'cell-1', title: '칸1', status: 'yellow', owner: null, priority: 'P0' }, turnOpensWith: '[work-pull] 칸1 본문' },
    );
    const pull = createSeatWorkPull(deps as never);
    const out = pull();
    expect(calls.notices).toEqual([{ text: '[work-pull] 칸1 본문', source: 'work-pull' }]);
    expect(calls.injects).toBe(1);
    expect(out).toEqual({ claimed: 'cell-1' });
  });

  test('idle + no-work → notice·inject 0회, «일감 0» 근거 줄만 돌려준다', () => {
    const { deps, calls } = fakeDeps({ kind: 'no-work', evidence: '일감 0 — 큐 조회 결과: 현재 판 1칸 · 대상 1칸 중 미claim 0칸 · 완료 0 · 막힘 0 · 타 자리 소유 0' });
    const pull = createSeatWorkPull(deps as never);
    const out = pull();
    expect(calls.notices).toEqual([]);
    expect(calls.injects).toBe(0);
    expect(out).toEqual({ noWork: '일감 0 — 큐 조회 결과: 현재 판 1칸 · 대상 1칸 중 미claim 0칸 · 완료 0 · 막힘 0 · 타 자리 소유 0' });
  });
});

describe('mountSeatWorkPull — entry 탑재 조립(OP #139787 part 4)', () => {
  const SENTINEL = { sentinel: 'queueWake' };
  const harness = (over: {
    seat?: string | null;
    busy?: () => boolean;
    personTurnStarted?: () => boolean;
    pull?: () => { kind: 'claimed'; claim: { db: string; cellId: string; seat: string; token: string }; cell: { id: string; title: string; status: string; owner: string | null; priority: string }; turnOpensWith: string } | { kind: 'no-work'; evidence: string };
  }): { mount: null | (() => void); fire: () => void; notices: string[]; injects: unknown[]; scheduleCalls: number; cancelled: () => boolean; pullCalls: () => number } => {
    const notices: string[] = [];
    const injects: unknown[] = [];
    let scheduleCalls = 0;
    let stopped = false;
    let fire: () => void = () => {};
    let pullCalls = 0;
    const pull = over.pull ?? (() => { pullCalls += 1; return { kind: 'no-work', evidence: '일감 0 — 큐 조회 결과: 0칸' }; });
    const wrappedPull = () => { pullCalls += 1; return pull(); };
    const deps = over.pull ? wrappedPull : pull;
    const mount = mountSeatWorkPull({
      seat: over.seat === undefined ? 'SEAT-A' : over.seat,
      busy: over.busy ?? (() => false),
      personTurnStarted: over.personTurnStarted ?? (() => true),
      enqueueNotice: (text) => { notices.push(text); },
      injectKey: (key) => { injects.push(key); },
      queueWake: SENTINEL,
      pullDeps: { pull: deps as never },
      schedule: (fn) => { scheduleCalls += 1; fire = fn; return () => { stopped = true; }; },
      intervalMs: 60_000,
      log: () => {},
    });
    return { mount, fire, notices, injects, scheduleCalls, cancelled: () => stopped, pullCalls: () => pullCalls };
  };

  test('자리 아님(seat null) → 마운트 자체를 안 한다(스케줄 0회)', () => {
    const h = harness({ seat: null });
    expect(h.mount).toBe(null);
    expect(h.scheduleCalls).toBe(0);
  });

  test('SEAT-NOTICE-BOOT-RACE — 사람 첫 턴 전엔 pull 조차 부르지 않는다', () => {
    const h = harness({ personTurnStarted: () => false });
    expect(h.mount).not.toBe(null);
    h.fire();
    expect(h.pullCalls()).toBe(0);
    expect(h.notices).toEqual([]);
    expect(h.injects).toEqual([]);
  });

  test('idle + claimed → 칸 본문 노티스 1회 + queueWake 센티널 1회 inject(조립 전체)', () => {
    const h = harness({
      pull: () => ({ kind: 'claimed', claim: { db: ':memory:', cellId: 'cell-7', seat: 'SEAT-A', token: 't1' }, cell: { id: 'cell-7', title: '칸7', status: 'yellow', owner: null, priority: 'P0' }, turnOpensWith: '[work-pull] 칸7 본문' }),
    });
    h.fire();
    expect(h.notices).toEqual(['[work-pull] 칸7 본문']);
    expect(h.injects).toEqual([SENTINEL]);
  });

  test('busy → 조립돼도 pull 을 부르지 않는다', () => {
    const h = harness({ busy: () => true });
    h.fire();
    expect(h.pullCalls()).toBe(0);
    expect(h.notices).toEqual([]);
  });

  test('stop() → 스케줄 취소(재입 없음)', () => {
    const h = harness({});
    expect(h.mount).not.toBe(null);
    expect(typeof h.mount === 'function' && h.mount());
    expect(h.cancelled()).toBe(true);
  });
});
