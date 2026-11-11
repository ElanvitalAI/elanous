import { test, expect, describe } from 'bun:test';
import { missionKind, cancelMission, sweepFiniteMissions, isReviewDue, workflowNameOf, FINITE_MODELS, CONTINUOUS_MODELS, buildMissionExecutionContext, pauseMission, resumeMission, isMissionPaused, mergeMissionPhases } from './mission-lifecycle.js';
import { openAutopilotMissionsDb, createMission, getMission } from './mission-registry.js';
import { dispatchAutopilotMissions } from './mission-tool.js';

describe('buildMissionExecutionContext — 골 정정 시 "왜 축소하는지" 실행 컨텍스트(대표 2026-07-12)', () => {
  test('실패 페이즈+비평 사유 → 컨텍스트 / 실패 없으면 빈 문자열', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { createTask } = await import('../task-orchestrator/types.js');
    const store = new TaskStore({ path: ':memory:' });
    const m = createMission(store, { goal: 'g', source: 'human-intent', triage: { executionModel: 'task', tier: 'heavy', engine: 'tox' } });
    try {
      expect(buildMissionExecutionContext(m.id, { store })).toBe(''); // 실패 없음
      const t = createTask({
        title: 'KGS 스키마 마이그레이션', description: 'd',
        surface: { kind: 'subagent', definitionName: 'general-purpose', prompt: 'p' },
        goalSlug: m.id, dependsOn: [], status: 'failed', generatedBy: { kind: 'user', actorId: 't' },
      }, { allowUncheckedUrgent: true });
      t.notes = ['[CRITIQUE:FAIL] 독자 migration 신설·correctness 오류'];
      store.saveTask(t);
      const ctx = buildMissionExecutionContext(m.id, { store });
      expect(ctx).toContain('KGS 스키마 마이그레이션');
      expect(ctx).toContain('독자 migration');
      expect(ctx).toContain('제외하거나 크게 단순화');
    } finally { store.close(); }
  });
});

describe('mergeMissionPhases — R3 자동머지: clean 만·escalated/critique 제외(머지 안전)', () => {
  test('clean PR 만 머지·[CRITIQUE:*]/[REVIEW:ESCALATED] 페이즈는 제외', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { createTask } = await import('../task-orchestrator/types.js');
    const store = new TaskStore({ path: ':memory:' });
    const m = createMission(store, { goal: 'merge 안전', source: 'manual', triage: { executionModel: 'task', tier: 'heavy', engine: 'tox' } });
    try {
      const mk = (title: string, notes: string[]) => {
        const t = createTask({ title, description: 'd', surface: { kind: 'subagent', definitionName: 'general-purpose', prompt: 'p' }, goalSlug: m.id, dependsOn: [], status: 'done', generatedBy: { kind: 'user', actorId: 't' } }, { allowUncheckedUrgent: true });
        t.notes = notes; store.saveTask(t);
      };
      mk('clean 페이즈(리뷰 PASS)', ['[SE-PR] https://github.com/o/r/pull/101', '[REVIEW:PASS]']);           // 머지 대상
      mk('비평 FAIL 페이즈', ['[SE-PR] https://github.com/o/r/pull/102', '[CRITIQUE:FAIL] 미배선']);          // 제외(재반영)
      mk('리뷰 미수렴 페이즈', ['[SE-PR] https://github.com/o/r/pull/103', '[REVIEW:ESCALATED] 정체 반복']);   // 제외(HITL)
      mk('미검토 clean 페이즈', ['[SE-PR] https://github.com/o/r/pull/104']);                                // HITL=머지·자동=제외
      const merged: string[] = [];
      const r = mergeMissionPhases(m.id, { store, mergePr: (url) => { merged.push(url); return true; } });
      expect(r.ok).toBe(true);
      expect(r.merged).toBe(2); // HITL 머지: clean(리뷰 PASS + 미검토 둘 다·critique/escalated 제외)
      expect(merged.sort()).toEqual(['https://github.com/o/r/pull/101', 'https://github.com/o/r/pull/104']);
    } finally { store.close(); }
  });

  test('requireReviewPass(자동머지) — [REVIEW:PASS] 페이즈만·미검토 clean 은 제외(verdict-gated)', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { createTask } = await import('../task-orchestrator/types.js');
    const store = new TaskStore({ path: ':memory:' });
    const m = createMission(store, { goal: '자동머지 verdict-gate', source: 'manual', triage: { executionModel: 'task', tier: 'heavy', engine: 'tox' } });
    try {
      const mk = (title: string, notes: string[]) => {
        const t = createTask({ title, description: 'd', surface: { kind: 'subagent', definitionName: 'general-purpose', prompt: 'p' }, goalSlug: m.id, dependsOn: [], status: 'done', generatedBy: { kind: 'user', actorId: 't' } }, { allowUncheckedUrgent: true });
        t.notes = notes; store.saveTask(t);
      };
      mk('리뷰 PASS 페이즈', ['[SE-PR] https://github.com/o/r/pull/201', '[REVIEW:PASS]']);  // 자동머지 대상
      mk('미검토 clean 페이즈', ['[SE-PR] https://github.com/o/r/pull/202']);                 // 자동머지 제외(fail-soft pass)
      const merged: string[] = [];
      const r = mergeMissionPhases(m.id, { store, requireReviewPass: true, mergePr: (url) => { merged.push(url); return true; } });
      expect(r.merged).toBe(1);
      expect(merged).toEqual(['https://github.com/o/r/pull/201']); // 실제 리뷰 PASS 만·미검토는 자동머지 안 함
    } finally { store.close(); }
  });
});

describe('workflowNameOf — cascade 가 삭제할 workflow 정의 이름 추출', () => {
  test('internal:wf:<name>:<node> 에서 이름 추출', () => {
    expect(workflowNameOf('internal:wf:se-doc-map:weekly-seoul-tick')).toBe('se-doc-map');
    expect(workflowNameOf('internal:wf:my-flow:tick')).toBe('my-flow');
  });
  test('workflow 스케줄이 아니면 null(크론 등)', () => {
    expect(workflowNameOf('1bc64bdf72dd')).toBeNull();
    expect(workflowNameOf('30 5 * * 0')).toBeNull();
  });
});

describe('missionKind — 실행모델 → 수명 성격', () => {
  test('유한 모델', () => {
    for (const m of FINITE_MODELS) expect(missionKind(m)).toBe('finite');
  });
  test('상시 모델', () => {
    for (const m of CONTINUOUS_MODELS) expect(missionKind(m)).toBe('continuous');
  });
  test('그 외', () => {
    expect(missionKind('hybrid')).toBe('other');
    expect(missionKind(null)).toBe('other');
  });
});

describe('cancelMission — 파생 없는 미션 종료', () => {
  test('파생 잡 0 → 행 purge(released 0·유령 방지)', async () => {
    const db = openAutopilotMissionsDb();
    const m = createMission(db, { goal: 'cancel 테스트', source: 'manual', triage: { executionModel: 'scheduler' } });
    db.close();
    const r = await dispatchAutopilotMissions({ action: 'cancel', id: m.id }) as { ok?: boolean; missionId?: string; status?: string; releasedCrons?: number; releasedWorkflows?: number };
    expect(r.ok).toBe(true);
    expect(r.missionId).toBe(m.id);
    expect(r.status).toBe('done');
    expect(r.releasedCrons).toBe(0);
    expect(r.releasedWorkflows).toBe(0);
    // 취소는 done 마킹이 아니라 행 완전 제거(purge) — 유령 dedup 오탐 방지(2026-07-11).
    const c = openAutopilotMissionsDb();
    expect(getMission(c, m.id)).toBeNull();
    c.close();
  });
  test('없는 미션 → 에러', async () => {
    const r = await cancelMission('apm_nonexistent_zzz');
    expect(r.ok).toBe(false);
  });
  test('defer=true → 보류(record 유지·status=rejected·완전삭제 아님)', async () => {
    const db = openAutopilotMissionsDb();
    const m = createMission(db, { goal: '보류 테스트', source: 'manual', triage: { executionModel: 'scheduler' } });
    db.close();
    const r = await cancelMission(m.id, { defer: true });
    expect(r.ok).toBe(true);
    const c = openAutopilotMissionsDb();
    const still = getMission(c, m.id);
    expect(still).not.toBeNull();            // 행 유지(리스트 "보류됨")
    expect(still?.status).toBe('rejected');  // 보류 상태
    c.close();
    await cancelMission(m.id);               // cleanup — 완전 삭제
  });
});

describe('sweepFiniteMissions — 유한 자동종료', () => {
  test('상시 미션(running)은 sweep 대상 아님', () => {
    const db = openAutopilotMissionsDb();
    const m = createMission(db, { goal: '상시 미션', source: 'manual', status: 'running', triage: { executionModel: 'scheduler' } });
    db.close();
    const r = sweepFiniteMissions();
    // 상시라 checked 에 안 들어감(완료 대상 아님)
    expect(r.ids).not.toContain(m.id);
    const c = openAutopilotMissionsDb();
    expect(getMission(c, m.id)!.status).toBe('running'); // 여전히 running
    c.deleteMission(m.id); c.close();
  });
});

describe('배선 가드 — cancel 액션', () => {
  test('autopilot_missions cancel delegates a missing mission to the lifecycle decision', async () => {
    const result = await dispatchAutopilotMissions({ action: 'cancel', id: 'apm_c8_missing' }) as { error?: string };
    expect(result.error).toContain('미션 없음');
  });
});

describe('isReviewDue — 상시 30일+ 드리프트', () => {
  const now = new Date(2026, 6, 9, 12, 0, 0);
  test('상시 running 30일+ → true', () => {
    expect(isReviewDue('scheduler', 'running', new Date(2026, 5, 1).toISOString(), { now })).toBe(true);
  });
  test('상시 running 최근 → false', () => {
    expect(isReviewDue('scheduler', 'running', new Date(2026, 6, 5).toISOString(), { now })).toBe(false);
  });
  test('유한 모델 → false(대상 아님)', () => {
    expect(isReviewDue('task', 'running', new Date(2026, 0, 1).toISOString(), { now })).toBe(false);
  });
  test('running 아니면 → false', () => {
    expect(isReviewDue('scheduler', 'proposed', new Date(2026, 0, 1).toISOString(), { now })).toBe(false);
  });
});

describe('pause/resume — S5 실행 적응(중단·상태 보존·재개)', () => {
  test('pause → isMissionPaused=true, resume → false + respawn(missionId) 호출', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const store = new TaskStore({ path: ':memory:' });
    const m = createMission(store, { goal: 'pause 왕복 테스트', source: 'manual', triage: { executionModel: 'task', tier: 'heavy', engine: 'tox' } });
    try {
      expect(isMissionPaused(m.id, { store })).toBe(false);   // 초기 미정지
      expect(pauseMission(m.id, { store })).toBe(true);
      expect(isMissionPaused(m.id, { store })).toBe(true);     // 상태 보존(삭제 아님)
      const spawned: string[] = [];
      expect(resumeMission(m.id, { store, spawnRun: (id) => spawned.push(id) })).toBe(true);
      expect(isMissionPaused(m.id, { store })).toBe(false);    // paused 해제
      expect(spawned).toEqual([m.id]);                         // 남은 페이즈 재개 위해 재spawn
    } finally { store.close(); }
  });
  test('없는 미션 → pause/resume/isPaused 안전(false·crash 없음)', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const store = new TaskStore({ path: ':memory:' });
    try {
      expect(isMissionPaused('apm_nope_zzz', { store })).toBe(false);
      expect(pauseMission('apm_nope_zzz', { store })).toBe(false);
      let spawnedCount = 0;
      expect(resumeMission('apm_nope_zzz', { store, spawnRun: () => { spawnedCount++; } })).toBe(false);
      expect(spawnedCount).toBe(0);                            // 없는 미션은 respawn 안 함
    } finally { store.close(); }
  });
});
