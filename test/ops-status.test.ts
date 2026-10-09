// Unit tests for ops-status (Ops Observability P1) — 운영 상태 조회/집계.
// opsSnapshot(미션·태스크·루프·오케스트레이션) · opsHealth(이상 판정) · opsTimeline.

import { describe, expect, test, afterEach } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { openOpsEventsDb, recordOpsEvent } from '../src/domains/ops-log.js';
import { opsSnapshot, opsHealth, opsTimeline, opsMissionDetail } from '../src/domains/ops-status.js';
import { TaskStore } from '../src/task-orchestrator/store.js';
import { createMission } from '../src/autopilot/mission-registry.js';
import { createTask, type TaskSurface } from '../src/task-orchestrator/types.js';

const surface: TaskSurface = { kind: 'llm-direct', prompt: 'p' };
const tmpFiles: string[] = [];

function tmpOpsDb(): string {
  const p = join(tmpdir(), `ops-test-${process.pid}-${tmpFiles.length}.db`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) { try { rmSync(f, { force: true }); } catch { /* noop */ } }
});

/** mandate 스텁 — 실 mandate 파일 의존 제거. */
const stubMandate = {
  armed: true, live: false, executionMode: 'orchestrator', paperSources: ['agent:free-swing'],
} as unknown as import('../src/domains/trade-mandate.js').TradeMandate;

function seedOps(path: string): void {
  const db = openOpsEventsDb(path);
  recordOpsEvent(db, { entityType: 'loop', entityId: 'agent:free-swing', event: 'cycle_end', toState: 'submitted', refs: { conviction: 0.9, legs: 2 } });
  recordOpsEvent(db, { entityType: 'loop', entityId: 'rule:capstone', event: 'cycle_end', toState: 'failed', refs: { error: 'quote timeout' } });
  recordOpsEvent(db, { entityType: 'orchestration', entityId: 'c1', event: 'alloc', toState: null, refs: { budgetScale: 1, mergedLegs: 3 } });
  db.close();
}

describe('ops-status — opsSnapshot', () => {
  test('루프 스냅샷 — entity별 최신 + mandate arming 반영', () => {
    const opsDbPath = tmpOpsDb();
    seedOps(opsDbPath);
    const store = new TaskStore({ path: ':memory:', noWal: true });
    const snap = opsSnapshot({ opsDbPath, missionStore: store, schedulesDbPath: tmpOpsDb(), mandate: stubMandate, graphLoopRuns: () => [] });
    expect(snap.loops.armed).toBe(true);
    expect(snap.loops.executionMode).toBe('orchestrator');
    expect(snap.loops.paperSources).toContain('agent:free-swing');
    const ids = snap.loops.loops.map((l) => l.id).sort();
    expect(ids).toEqual(['agent:free-swing', 'rule:capstone']);
    expect(snap.orchestration.recent.length).toBe(1);
    store.close();
  });

  test('미션·태스크 byStatus 집계 + blocked 태스크', () => {
    const store = new TaskStore({ path: ':memory:', noWal: true });
    createMission(store, { goal: '테스트 미션', source: 'manual' });
    const blocked = { ...createTask({ title: 'blocked one', surface }, { id: 'task:b', now: 1 }), status: 'blocked' as const, notes: ['[LEARNING] dep missing'] };
    store.saveTask(blocked);
    const snap = opsSnapshot({ opsDbPath: tmpOpsDb(), missionStore: store, schedulesDbPath: tmpOpsDb(), mandate: null, graphLoopRuns: () => [] });
    expect(snap.missions.total).toBe(1);
    expect(snap.missions.byStatus['proposed']).toBe(1);
    expect(snap.tasks.byStatus['blocked']).toBe(1);
    expect(snap.tasks.blocked[0]!.title).toBe('blocked one');
    expect(snap.tasks.blocked[0]!.note).toContain('dep missing');
    // 미션 disposition — proposed=승인대기(멈춤 아님) 라벨.
    expect(snap.missions.active[0]!.disposition).toContain('승인대기');
    store.close();
  });

  test('두 플레인 구분 — scheduleBacked vs dispatchPending', () => {
    const store = new TaskStore({ path: ':memory:', noWal: true });
    // 스케줄-백드 태스크(cron generatedBy) 2개 + 순수 backlog(디스패치 대기) 1개.
    const sched1 = { ...createTask({ title: 'run-x-cycle', surface }, { id: 'task:s1', now: 1 }), generatedBy: { kind: 'cron' as const, scheduleText: '*/10 * * * *', jobRef: 'job1' } };
    const sched2 = { ...createTask({ title: 'run-y-cycle', surface }, { id: 'task:s2', now: 1 }), scheduleText: '0 8 * * *' };
    const pending = createTask({ title: '진짜 대기 태스크', surface }, { id: 'task:p1', now: 1 });
    store.saveTask(sched1); store.saveTask(sched2); store.saveTask(pending);
    const snap = opsSnapshot({ opsDbPath: tmpOpsDb(), missionStore: store, schedulesDbPath: tmpOpsDb(), mandate: null, graphLoopRuns: () => [] });
    expect(snap.tasks.scheduleBacked).toBe(2);
    expect(snap.tasks.dispatchPending).toBe(1);
    expect(snap.tasks.dispatchable[0]!.title).toBe('진짜 대기 태스크');
    store.close();
  });
});

describe('ops-status — opsHealth', () => {
  test('errored 루프 + blocked 태스크를 이상으로 판정', () => {
    const opsDbPath = tmpOpsDb();
    seedOps(opsDbPath);
    const store = new TaskStore({ path: ':memory:', noWal: true });
    const blocked = { ...createTask({ title: 'b', surface }, { id: 'task:b', now: 1 }), status: 'blocked' as const };
    store.saveTask(blocked);
    const health = opsHealth({ opsDbPath, missionStore: store, schedulesDbPath: tmpOpsDb(), mandate: stubMandate, graphLoopRuns: () => [] });
    expect(health.healthy).toBe(false);
    expect(health.anomalies.some((a) => a.kind === 'errored_loop' && a.entity === 'rule:capstone')).toBe(true);
    expect(health.anomalies.some((a) => a.kind === 'blocked_task')).toBe(true);
    store.close();
  });

  test('이상 없으면 healthy=true', () => {
    const store = new TaskStore({ path: ':memory:', noWal: true });
    const health = opsHealth({ opsDbPath: tmpOpsDb(), missionStore: store, schedulesDbPath: tmpOpsDb(), mandate: null, graphLoopRuns: () => [] });
    expect(health.healthy).toBe(true);
    expect(health.anomalies.length).toBe(0);
    store.close();
  });
});

describe('ops-status — opsTimeline', () => {
  test('최근순 통합 타임라인 + entityType 필터', () => {
    const opsDbPath = tmpOpsDb();
    seedOps(opsDbPath);
    const all = opsTimeline({ opsDbPath });
    expect(all.length).toBe(3);
    const loopsOnly = opsTimeline({ opsDbPath, entityType: 'loop' });
    expect(loopsOnly.length).toBe(2);
    expect(loopsOnly.every((e) => e.entityType === 'loop')).toBe(true);
  });
});

describe('ops-status — opsMissionDetail', () => {
  test('없는 미션 id → mission=null + 안내 note(fail-soft)', () => {
    const d = opsMissionDetail('apm_nonexistent_zzz', { opsDbPath: tmpOpsDb(), schedulesDbPath: tmpOpsDb() });
    expect(d.mission).toBeNull();
    expect(d.note).toContain('없음');
    expect(Array.isArray(d.derived)).toBe(true);
    expect(Array.isArray(d.transitions)).toBe(true);
  });
});
