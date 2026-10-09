// Unit tests for Ops P3 셀프교정 — ambient 자각(opsHealthContext) + disarmed 기본 안전.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { openOpsEventsDb, recordOpsEvent } from '../src/domains/ops-log.js';
import { opsHealthContext } from '../src/domains/ops-status.js';
import { TaskStore } from '../src/task-orchestrator/store.js';
import { getUserConfig } from '../src/user-config.js';

function tmpDb(tag: string): string {
  return join(tmpdir(), `ops-p3-${process.pid}-${tag}.db`);
}

describe('ops P3 — opsHealthContext 자각', () => {
  test('이상 없으면 빈 문자열(노이즈 없음)', () => {
    const store = new TaskStore({ path: ':memory:', noWal: true });
    const ctx = opsHealthContext({ opsDbPath: tmpDb('healthy'), missionStore: store, schedulesDbPath: tmpDb('sched1'), mandate: null, graphLoopRuns: () => [] });
    expect(ctx).toBe('');
    store.close();
    rmSync(tmpDb('healthy'), { force: true }); rmSync(tmpDb('sched1'), { force: true });
  });

  test('errored 루프 있으면 경보 요약(개입=대표 결정 명시)', () => {
    const opsDbPath = tmpDb('errored');
    const db = openOpsEventsDb(opsDbPath);
    recordOpsEvent(db, { entityType: 'loop', entityId: 'rule:capstone', event: 'cycle_end', toState: 'failed', refs: { error: 'x' } });
    db.close();
    const store = new TaskStore({ path: ':memory:', noWal: true });
    const ctx = opsHealthContext({ opsDbPath, missionStore: store, schedulesDbPath: tmpDb('sched2'), mandate: null, graphLoopRuns: () => [] });
    expect(ctx).toContain('운영 상태 경보');
    expect(ctx).toContain('rule:capstone');
    expect(ctx).toContain('대표 결정');
    store.close();
    rmSync(opsDbPath, { force: true }); rmSync(tmpDb('sched2'), { force: true });
  });
});

describe('ops P3 — 셀프교정 안전 기본값', () => {
  test('ops.selfHeal.armed 는 기본 disarmed(undefined/false) — 자동 개입 안 함', () => {
    const cfg = getUserConfig();
    // 대표가 명시하지 않는 한 셀프교정 개입은 꺼져 있어야 한다(관측+알림만·HITL).
    expect(cfg.ops?.selfHeal?.armed === true).toBe(false);
  });
});
