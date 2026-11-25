import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── PULL-KNOCK-HAND-GATE (P0 11-25 «손이 일을 시작 안 함») ──
// 손 자리는 레일·update-all 마다 재기동되고 아무도 치지 않는다 — 사람 첫 턴 게이트만으로는 60분 45× skipped · 0 claim.
// 기대값은 제품 상수를 재사용하지 않는 독립 리터럴(90 000 ms · 'hand-settled' 등).

import { isHandSeat, pullGateOpen, wireWorkPullKnock } from './work-pull-knock.js';
import { mountSeatWorkPull } from './seat-work-pull.js';

const T0 = 1_700_000_000_000;

describe('pullGateOpen — 사람 턴 ∨ 끝난 턴 ∨ 손 자리 90 s 정착', () => {
  const base = { personTurnStarted: false, turnCompletedSinceBoot: false, handSeat: true, readyAt: T0, lastTypedAt: 0 };

  test('사람 입력 없이 부팅한 손 자리 — 89 s 는 닫힘, 90 s 에 열림', () => {
    expect(pullGateOpen({ ...base, now: T0 + 89_000 })).toEqual({ open: false, reason: 'hand-boot-settling' });
    expect(pullGateOpen({ ...base, now: T0 + 90_000 })).toEqual({ open: true, via: 'hand-settled' });
  });

  test('리더·조율 자리는 몇 분이 지나도 사람 첫 턴을 기다린다', () => {
    expect(pullGateOpen({ ...base, handSeat: false, now: T0 + 600_000 })).toEqual({ open: false, reason: 'person-turn-not-started' });
  });

  test('90 s 안에 사람이 키를 치면 가로채지 않는다 — 마지막 키부터 다시 90 s', () => {
    const typedAt = T0 + 80_000;
    expect(pullGateOpen({ ...base, lastTypedAt: typedAt, now: T0 + 95_000 }).open).toBe(false);
    expect(pullGateOpen({ ...base, lastTypedAt: typedAt, now: T0 + 169_000 }).open).toBe(false);
    expect(pullGateOpen({ ...base, lastTypedAt: typedAt, now: T0 + 170_000 })).toEqual({ open: true, via: 'hand-settled' });
  });

  test('부팅 뒤 끝난 턴(우편·노티스) 하나면 어느 자리든 연다', () => {
    expect(pullGateOpen({ ...base, handSeat: false, turnCompletedSinceBoot: true, now: T0 + 1_000 })).toEqual({ open: true, via: 'turn-completed' });
  });

  test('사람 턴이 시작됐으면 바로 연다', () => {
    expect(pullGateOpen({ ...base, handSeat: false, personTurnStarted: true, now: T0 })).toEqual({ open: true, via: 'person-turn' });
  });
});

describe('isHandSeat — -H- 이름 ⊕ federation.yaml role', () => {
  test('-H- 자리는 손, 선언 없는 리더·OP 는 손이 아니다', () => {
    expect(isHandSeat('tc-h-cx-6')).toBe(true);
    expect(isHandSeat('TC')).toBe(false);
    expect(isHandSeat('OP')).toBe(false);
    expect(isHandSeat(null)).toBe(false);
  });
  test('선언 role 이 이름보다 앞선다', () => {
    expect(isHandSeat('RES', { RES: 'hand' })).toBe(true);
    expect(isHandSeat('TC-H-1', { 'TC-H-1': 'leader' })).toBe(false);
  });
});

describe('wireWorkPullKnock — gate 판정이 pull 과 로그를 가른다', () => {
  test('닫힌 gate 는 pull 0회 · 사유를 로그한다', () => {
    let pulls = 0;
    let fire: () => void = () => {};
    const logs: unknown[] = [];
    wireWorkPullKnock({
      pull: () => { pulls += 1; return { claimed: 'x' }; },
      personTurnStarted: () => true,
      gate: () => ({ open: false, reason: 'hand-boot-settling' }),
      schedule: (f) => { fire = f; return () => {}; },
      log: (_e, d) => { logs.push(d); },
    });
    fire();
    expect(pulls).toBe(0);
    expect(logs).toEqual([{ skipped: 'hand-boot-settling' }]);
  });
});

describe('시험 우주 — 재기동한 가짜 손 패널이 ~2.5 분 안에 READY 칸을 claim 한다', () => {
  test('60 s 폴 · 사람 입력 0 · 실제 workNext(eln work next 와 같은 함수) + 시험 우주 판', () => {
    const root = mkdtempSync(join(tmpdir(), 'pull-knock-hand-'));
    try {
      let now = T0; // TUI 준비 = 재기동 직후
      let fire: () => void = () => {};
      const notices: string[] = [];
      const injects: unknown[] = [];
      const logs: Array<Record<string, unknown> | undefined> = [];
      let personTurnStarted = false;
      const stop = mountSeatWorkPull({
        seat: 'TC-H-CX-9',
        busy: () => false,
        personTurnStarted: () => personTurnStarted,
        gate: () => pullGateOpen({ personTurnStarted, turnCompletedSinceBoot: false, handSeat: isHandSeat('TC-H-CX-9'), readyAt: T0, lastTypedAt: 0, now }),
        enqueueNotice: (text) => { notices.push(text); },
        injectKey: (key) => { injects.push(key); },
        queueWake: 'WAKE',
        pullDeps: { workNextDeps: () => ({
          now: () => now, version: '9.9.9', scopeOf: () => 'TC', lastActiveMs: () => now, isJudge: () => false,
          cells: () => [{ id: 'READY-CELL-1', title: 'ready cell', status: 'yellow', priority: 'P0', updatedAt: '2026-11-25T00:00:00Z' }],
          swap: () => ({ outcome: 'swapped' as const }),
        }) },
        schedule: (f) => { fire = f; return () => {}; },
        log: (_e, d) => { logs.push(d); },
      });
      expect(stop).not.toBe(null);
      // 60 s · 120 s 폴 — 재기동 뒤 두 번째 폴(2 분)에 claim
      now = T0 + 60_000; fire();
      expect(notices.length).toBe(0);
      now = T0 + 120_000; fire();
      expect(injects).toEqual(['WAKE']);
      expect(notices.length).toBe(1);
      expect(notices[0]).toContain('READY-CELL-1');
      expect(logs).toEqual([{ skipped: 'hand-boot-settling' }, { claimed: 'READY-CELL-1' }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
