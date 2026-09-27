import { describe, expect, it } from 'bun:test';
import {
  apmSnapshotToMissionInit,
  apmStatusToMissionStatus,
  isAutopilotMission,
  type ApmMissionSnapshot,
} from './mission-autopilot.js';
import { createMission } from './mission.js';
import { TaskStore, TOX_SCHEMA_VERSION } from './store.js';

describe('apmStatusToMissionStatus', () => {
  it('실행/종료 상태를 TOX 5-state 로 매핑', () => {
    expect(apmStatusToMissionStatus('running')).toBe('active');
    expect(apmStatusToMissionStatus('done')).toBe('completed');
    expect(apmStatusToMissionStatus('failed')).toBe('cancelled');
  });

  it('arming/mandate 축(proposed·armed·disarmed)은 planning 에 머문다', () => {
    expect(apmStatusToMissionStatus('proposed')).toBe('planning');
    expect(apmStatusToMissionStatus('armed')).toBe('planning');
    expect(apmStatusToMissionStatus('disarmed')).toBe('planning');
  });

  it('알 수 없는/빈 상태는 planning fallback', () => {
    expect(apmStatusToMissionStatus(undefined)).toBe('planning');
    expect(apmStatusToMissionStatus(null)).toBe('planning');
    expect(apmStatusToMissionStatus('weird')).toBe('planning');
  });
});

describe('apmSnapshotToMissionInit', () => {
  const snap: ApmMissionSnapshot = {
    id: 'apm_202607090858_부활-conatus_0129b7',
    goal: 'Conatus 플랫폼 부활 — 수집 파이프라인 재가동',
    source: 'discovery',
    executionModel: 'task',
    tier: 'light',
    engine: 'tox',
    rationale: 'roadmap 미구현 1순위',
    confidence: 'medium',
    status: 'proposed',
    runIds: ['run_a', 'run_b'],
    materializeSpec: { command: 'scripts/foo.ts' },
  };

  it('goal→title/intent, apmId→goalSlug(계보 키 보존)', () => {
    const init = apmSnapshotToMissionInit(snap);
    expect(init.title).toBe('Conatus 플랫폼 부활 — 수집 파이프라인 재가동');
    expect(init.intent).toBe(snap.goal);
    expect(init.goalSlug).toBe(snap.id);
    expect(init.source).toEqual({ kind: 'manual', raw: snap.goal });
    expect(init.status).toBe('planning');
  });

  it('autopilot 메타 전부 흡수', () => {
    const { autopilot } = apmSnapshotToMissionInit(snap);
    expect(autopilot).toEqual({
      apmId: snap.id,
      origin: 'discovery',
      executionModel: 'task',
      tier: 'light',
      engine: 'tox',
      rationale: 'roadmap 미구현 1순위',
      confidence: 'medium',
      apmStatus: 'proposed',
      materializeSpec: { command: 'scripts/foo.ts' },
      runIds: ['run_a', 'run_b'],
    });
  });

  it('title 은 80자 상한, 빈 goal 은 id fallback', () => {
    const long = apmSnapshotToMissionInit({ ...snap, goal: 'x'.repeat(200) });
    expect(long.title.length).toBe(80);
    const empty = apmSnapshotToMissionInit({ ...snap, goal: '   ' });
    expect(empty.title).toBe(snap.id.slice(0, 80));
  });

  it('runIds 빈 배열은 undefined 로 정규화', () => {
    const { autopilot } = apmSnapshotToMissionInit({ ...snap, runIds: [] });
    expect(autopilot?.runIds).toBeUndefined();
  });
});

describe('isAutopilotMission', () => {
  it('autopilot 메타 유무로 자율/일반 구분', () => {
    expect(isAutopilotMission({ autopilot: { origin: 'discovery' } })).toBe(true);
    expect(isAutopilotMission({})).toBe(false);
  });
});

describe('store round-trip — autopilot_json 영속화 (U1)', () => {
  it('autopilot 메타가 save→reload 를 통과해 보존된다', () => {
    const store = new TaskStore({ path: ':memory:', noWal: true });
    try {
      const init = apmSnapshotToMissionInit({
        id: 'apm_test_slug_abc123',
        goal: '테스트 미션',
        source: 'discovery',
        executionModel: 'scheduler',
        status: 'armed',
        materializeSpec: { cron: '5 9 * * *' },
      });
      const m = createMission(init, { now: 1000 });
      store.saveMission(m);

      const loaded = store.getMission(m.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.autopilot?.apmId).toBe('apm_test_slug_abc123');
      expect(loaded?.autopilot?.origin).toBe('discovery');
      expect(loaded?.autopilot?.executionModel).toBe('scheduler');
      expect(loaded?.autopilot?.apmStatus).toBe('armed');
      expect(loaded?.autopilot?.materializeSpec).toEqual({ cron: '5 9 * * *' });
      expect(loaded?.goalSlug).toBe('apm_test_slug_abc123');
    } finally {
      store.close();
    }
  });

  it('일반 Mission(autopilot 없음)은 autopilot=undefined 로 로드', () => {
    const store = new TaskStore({ path: ':memory:', noWal: true });
    try {
      const m = createMission(
        { title: '사람이 만든 미션', source: { kind: 'manual' } },
        { now: 1000 },
      );
      store.saveMission(m);
      const loaded = store.getMission(m.id);
      expect(loaded?.autopilot).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('schema version 이 현재판이고 v3(autopilot_json 흡수) 이상 — v4 = 외부 태스크 신원·승인', () => {
    const store = new TaskStore({ path: ':memory:', noWal: true });
    try {
      expect(store.schemaVersion()).toBe(TOX_SCHEMA_VERSION);
      expect(store.schemaVersion()).toBeGreaterThanOrEqual(3);
    } finally {
      store.close();
    }
  });
});
