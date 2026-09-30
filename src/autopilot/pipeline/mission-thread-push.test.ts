// 미션 thread 저지연 push 레이어(UR4d) — logs.db tail edge-trigger 검증 (2026-07-19)
import { test, expect, describe, afterEach } from 'bun:test';
import { LogStore } from '../../mss/logging/log-store.js';
import { watchMissionActivity, isSelfEmitCategory } from './mission-thread-push.js';

/** in-memory LogStore 에 한 행 append(테스트용 — insertBatch 경로 재사용). */
function append(store: LogStore, category: string): void {
  store.insertBatch([{ rec: { ts: new Date().toISOString(), category, event: 'x', level: 'info' }, surface: 'nexus' }]);
}

describe('mission-thread-push — 재귀가드(self-emit 제외)', () => {
  test('조율자 자기 방출 카테고리는 self-emit 으로 분류', () => {
    expect(isSelfEmitCategory('mission.registry')).toBe(true);
    expect(isSelfEmitCategory('mission.registry.sweep')).toBe(true);
    expect(isSelfEmitCategory('mission.coordinator.govern-resume')).toBe(true);
  });
  test('worker 활동 카테고리는 self-emit 아님(wake 신호)', () => {
    expect(isSelfEmitCategory('mission.walker.budget')).toBe(false);
    expect(isSelfEmitCategory('mission.build.phase')).toBe(false);
    expect(isSelfEmitCategory('mission.exec.step')).toBe(false);
    // prefix 오탐 가드 — coordinatorX 는 coordinator 자기방출 아님.
    expect(isSelfEmitCategory('mission.coordinatorx')).toBe(false);
  });
});

describe('mission-thread-push — edge-trigger tail', () => {
  const watchers: Array<{ stop(): void }> = [];
  afterEach(() => { for (const w of watchers) w.stop(); watchers.length = 0; });

  function start(store: LogStore, deps: Partial<Parameters<typeof watchMissionActivity>[0]> = {}, now?: () => number): void {
    const w = watchMissionActivity({ onWake: () => {}, store, pollMs: 5, debounceMs: 10, minWakeGapMs: 0, ...(now ? { now } : {}), ...deps });
    watchers.push(w);
  }

  test('store 가 null 이면 no-op watcher(관측만·throw 없음)', () => {
    const w = watchMissionActivity({ onWake: () => { throw new Error('should not fire'); }, store: null });
    expect(() => w.stop()).not.toThrow();
  });

  test('worker 활동이 onWake 를 edge-trigger 한다', async () => {
    const store = new LogStore(':memory:');
    let woke = 0;
    start(store, { onWake: () => { woke++; } });
    append(store, 'mission.walker.budget');   // worker 활동
    await Bun.sleep(60);
    expect(woke).toBeGreaterThanOrEqual(1);
  });

  test('조율자 자기 방출만 있으면 wake 안 함(재귀가드)', async () => {
    const store = new LogStore(':memory:');
    let woke = 0;
    start(store, { onWake: () => { woke++; } });
    append(store, 'mission.registry.sweep');           // 자기 방출
    append(store, 'mission.coordinator.govern-resume'); // 자기 방출
    await Bun.sleep(60);
    expect(woke).toBe(0);
  });

  test('버스트는 wake 1회로 coalesce(디바운스)', async () => {
    const store = new LogStore(':memory:');
    let woke = 0;
    start(store, { onWake: () => { woke++; }, pollMs: 5, debounceMs: 30, minWakeGapMs: 0 });
    for (let i = 0; i < 5; i++) append(store, 'mission.walker.step');
    await Bun.sleep(80);
    expect(woke).toBe(1);
  });

  test('접속 이전 과거 활동은 무시(maxId 커서 — 부팅 sweep 소관)', async () => {
    const store = new LogStore(':memory:');
    append(store, 'mission.walker.old');  // watcher 접속 전
    let woke = 0;
    start(store, { onWake: () => { woke++; } });
    await Bun.sleep(40);
    expect(woke).toBe(0);                 // 과거 행은 커서 밖
    append(store, 'mission.walker.new');  // 접속 후
    await Bun.sleep(40);
    expect(woke).toBe(1);
  });

  test('minWakeGap 미달 연속 활동은 thrash 가드로 wake 지연', async () => {
    const store = new LogStore(':memory:');
    let clock = 1000;
    let woke = 0;
    start(store, { onWake: () => { woke++; }, pollMs: 5, debounceMs: 10, minWakeGapMs: 100_000 }, () => clock);
    append(store, 'mission.walker.a');
    await Bun.sleep(40);
    expect(woke).toBe(1);                 // 첫 wake(lastWakeAt=0 → gap 큼)
    append(store, 'mission.walker.b');
    await Bun.sleep(40);
    expect(woke).toBe(1);                 // gap<minWakeGap → 재스케줄(아직 미발화)
  });
});
