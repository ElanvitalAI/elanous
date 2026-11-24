import { describe, expect, test } from 'bun:test';

// ── SEAT-WORK-PULL 노크 배선 (OP #139787) — RED 먼저: wireWorkPullKnock 이 없으면 실패한다. ──
// 계약: idle 주기 폴이 createSeatWorkPull() 결과를 그대로 태운다 — 사람 첫 턴 전(SEAT-NOTICE-BOOT-RACE)
//       에는 pull 조차 부르지 않고, busy면 스킵, claimed/no-work은 로그 관측만. 스케줄러는 주입형.

import { wireWorkPullKnock } from './work-pull-knock.js';

type PullOut = { claimed: string } | { noWork: string } | null;

function fakeHarness(pull: () => PullOut, opts: { personTurnStarted?: boolean } = {}) {
  const calls = { fires: 0, pulls: 0, stopped: false };
  const schedule = (fire: () => void, _ms: number) => {
    calls.fires = 0;
    // 가짜 스케줄러: 등록 즉시 1회, 이후 수동.
    void fire;
    return () => { calls.stopped = true; };
  };
  const manualFire: { run?: () => void } = {};
  const deps = {
    pull: () => { calls.pulls += 1; return pull(); },
    personTurnStarted: () => opts.personTurnStarted ?? true,
    schedule: (fire: () => void, ms: number) => {
      manualFire.run = fire;
      return schedule(fire, ms);
    },
    log: () => {},
  };
  const stop = wireWorkPullKnock(deps as never);
  return { calls, stop, manualFire };
}

describe('wireWorkPullKnock — idle 주기 폴과 SEAT-NOTICE-BOOT-RACE 게이트', () => {
  test('사람 첫 턴 전엔 pull 조차 부르지 않는다(boot race)', () => {
    const { calls, manualFire } = fakeHarness(() => ({ claimed: 'cell-1' }), { personTurnStarted: false });
    manualFire.run?.();
    expect(calls.pulls).toBe(0);
  });

  test('사람 첫 턴 뒤 idle 폴이 pull 을 부르고 claimed 결과를 관측한다', () => {
    const { calls, manualFire } = fakeHarness(() => ({ claimed: 'cell-1' }), { personTurnStarted: true });
    manualFire.run?.();
    expect(calls.pulls).toBe(1);
  });

  test('busy(pull=null)도 정상 통과 — 원자 claim 은 배선층이 이미 판정했다', () => {
    const { calls, manualFire } = fakeHarness(() => null, { personTurnStarted: true });
    manualFire.run?.();
    expect(calls.pulls).toBe(1);
  });

  test('stop() 이면 스케줄이 정지한다', () => {
    const { calls, stop } = fakeHarness(() => ({ claimed: 'cell-1' }));
    stop();
    expect(calls.stopped).toBe(true);
  });
});
