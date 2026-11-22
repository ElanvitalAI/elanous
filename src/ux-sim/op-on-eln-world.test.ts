import { describe, expect, test } from 'bun:test';
import { createOpOnElnWorld } from './op-on-eln-world.js';

describe('createOpOnElnWorld — 정정의 기존 배정 취소 상태 명시 모델링 (#39377 shouldFix a)', () => {
  test('정정 장면은 취소된 이전 지시를 지우지 않고 canceled 표지로 남긴다', () => {
    const world = createOpOnElnWorld();
    expect(world.nextSnapshot()!.sceneId).toBe('planning-flood');
    // crown-1(export-check) 을 배정하지 않고 다음 장면으로 넘어가 정정을 유발한다.
    const corrected = world.nextSnapshot()!;
    expect(corrected.sceneId).toBe('corrected-order');
    // 취소된 crown-1 이 목록에서 사라지지 않고 canceled 로 관측된다(RED: 현재는 조용히 삭제).
    expect(corrected.orders.find(order => order.id === 'crown-1')?.canceled).toBe(true);
    const correction = corrected.orders.find(order => order.id === 'crown-9');
    expect(correction?.supersedes).toBe('crown-1');
    expect(correction?.task).toBe('export-check');
  });

  test('취소된 지시 ID 로 배정하면 거부된다', () => {
    const world = createOpOnElnWorld();
    world.nextSnapshot();
    world.nextSnapshot();
    const denied = world.applyActions([{
      type: 'assign', target: 'crown-1', reason: '취소 지시 재배정 시도', evidence: ['crown-1'], worker: 'sim-release',
    }])[0]!;
    expect(denied.status).toBe('denied');
  });
});

describe('createOpOnElnWorld — 배정된 지시의 정정 취소 보존 (terra r4 mustFix 0 · #39377)', () => {
  test('배정된 crown-1·crown-5 도 정정 장면에서 이전 지시·canceled 상태로 남는다', () => {
    const world = createOpOnElnWorld();
    const planning = world.nextSnapshot()!;
    expect(planning.sceneId).toBe('planning-flood');
    // 장면 0에서 crown-1(export-check)·crown-5(onboard-sim) 을 배정한다.
    const results = world.applyActions([
      { type: 'assign', target: 'export-check', reason: 'P0 원격 경로 검증 배정', evidence: ['crown-1'], worker: 'sim-release' },
      { type: 'assign', target: 'onboard-sim', reason: '합성 회원 복원 목록 배정', evidence: ['crown-5'], worker: 'sim-review' },
    ]);
    expect(results.map(result => result.status)).toEqual(['accepted', 'accepted']);
    const corrected = world.nextSnapshot()!;
    expect(corrected.sceneId).toBe('corrected-order');
    // RED: 배정 시 pendingOrders 삭제로 두 지시가 정정 장면 원장에서 사라진다.
    // 정정(crown-9·crown-10 의 supersedes) 은 배정 여부와 무관하게 이전 지시와 취소 상태를 보존해야 한다.
    const supersededExport = corrected.orders.find(order => order.id === 'crown-1');
    expect(supersededExport?.task).toBe('export-check');
    expect(supersededExport?.canceled).toBe(true);
    const supersededReview = corrected.orders.find(order => order.id === 'crown-5');
    expect(supersededReview?.task).toBe('onboard-sim');
    expect(supersededReview?.canceled).toBe(true);
    // 정정은 배정이었던 worker 의 배정을 비운다.
    expect(corrected.workers.find(worker => worker.id === 'sim-release')?.assignment).toBeNull();
    expect(corrected.workers.find(worker => worker.id === 'sim-review')?.assignment).toBeNull();
  });
});
