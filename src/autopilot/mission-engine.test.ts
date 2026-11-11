import { test, expect, describe } from 'bun:test';
import { inferCronSchedule, materializeSchedulerMission, materializeMission, resolveDecomposeEffort } from './mission-engine.js';
import { openAutopilotMissionsDb, createMission } from './mission-registry.js';
import { dispatchAutopilotMissions } from './mission-tool.js';

describe('resolveDecomposeEffort — tier 분기(병목 힘빼기 2026-07-21·#4846)', () => {
  const orig = process.env.ELANOUS_DECOMPOSE_EFFORT;
  const origHeavy = process.env.ELANOUS_DECOMPOSE_HEAVY_EFFORT;
  const restore = () => {
    if (orig === undefined) delete process.env.ELANOUS_DECOMPOSE_EFFORT; else process.env.ELANOUS_DECOMPOSE_EFFORT = orig;
    if (origHeavy === undefined) delete process.env.ELANOUS_DECOMPOSE_HEAVY_EFFORT; else process.env.ELANOUS_DECOMPOSE_HEAVY_EFFORT = origHeavy;
  };
  test('heavy → medium(병목 힘빼기·종전 high)·light/미상 → medium', () => {
    delete process.env.ELANOUS_DECOMPOSE_EFFORT;
    delete process.env.ELANOUS_DECOMPOSE_HEAVY_EFFORT;
    try {
      expect(resolveDecomposeEffort('heavy')).toBe('medium');
      expect(resolveDecomposeEffort('light')).toBe('medium');
      expect(resolveDecomposeEffort(null)).toBe('medium');
      expect(resolveDecomposeEffort(undefined)).toBe('medium');
    } finally { restore(); }
  });
  test('ELANOUS_DECOMPOSE_HEAVY_EFFORT seam 이 heavy 만 되돌린다(라이브 A/B·롤백)', () => {
    delete process.env.ELANOUS_DECOMPOSE_EFFORT;
    process.env.ELANOUS_DECOMPOSE_HEAVY_EFFORT = 'high';
    try {
      expect(resolveDecomposeEffort('heavy')).toBe('high'); // seam 이 종전 동작 재현
      expect(resolveDecomposeEffort('light')).toBe('medium'); // light 는 seam 무관
    } finally { restore(); }
  });
  test('env(ELANOUS_DECOMPOSE_EFFORT) override 가 tier·seam 을 이긴다', () => {
    process.env.ELANOUS_DECOMPOSE_EFFORT = 'low';
    try { expect(resolveDecomposeEffort('heavy')).toBe('low'); } finally { restore(); }
  });
});

describe('inferCronSchedule — NL→cron 휴리스틱', () => {
  test('매일 아침 → 0 8 * * *', () => {
    expect(inferCronSchedule('매일 아침 반도체 리포트 보내줘')?.cron).toBe('0 8 * * *');
  });
  test('일요일 새벽 → 0 5 * * 0 (새벽 미인식 시 9시 오fallback 방지·2026-07-12)', () => {
    expect(inferCronSchedule('memory-lifecycle 유지보수 일요일 새벽')?.cron).toBe('0 5 * * 0');
  });
  test('매일 새벽 → 0 5 * * *', () => {
    expect(inferCronSchedule('매일 새벽 정리 루프')?.cron).toBe('0 5 * * *');
  });
  test('매일 저녁 → 0 20 * * *', () => {
    expect(inferCronSchedule('매일 저녁 시장 요약')?.cron).toBe('0 20 * * *');
  });
  test('시각 지정 "7시" → 0 7 * * *', () => {
    expect(inferCronSchedule('매일 7시에 알려줘')?.cron).toBe('0 7 * * *');
  });
  test('오후 3시 → 0 15 * * *', () => {
    expect(inferCronSchedule('매일 오후 3시 브리핑')?.cron).toBe('0 15 * * *');
  });
  test('매주 월요일 → 0 9 * * 1', () => {
    expect(inferCronSchedule('매주 월요일 회고')?.cron).toBe('0 9 * * 1');
  });
  test('평일 아침 → 0 8 * * 1-5', () => {
    expect(inferCronSchedule('평일 아침마다 수급 체크')?.cron).toBe('0 8 * * 1-5');
  });
  test('매시간 → 0 * * * *', () => {
    expect(inferCronSchedule('매시간 뉴스 체크')?.cron).toBe('0 * * * *');
  });
  test('매분 → * * * * *', () => {
    expect(inferCronSchedule('매분 감시')?.cron).toBe('* * * * *');
  });
  test('스케줄 단서 없으면 null', () => {
    expect(inferCronSchedule('반도체 종목 분석해줘')).toBeNull();
  });
});

describe('materializeSchedulerMission — 안전 경계', () => {
  test('command 없으면 거부(자동생성 안 함·HITL)', async () => {
    const r = await materializeSchedulerMission({ missionId: 'apm_x', command: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('command');
  });
  test('없는 미션 → 에러', async () => {
    const r = await materializeSchedulerMission({ missionId: 'apm_nonexistent_zzz', command: 'scripts/x.ts' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('미션 없음');
  });
});

describe('materializeMission dispatcher — 모델별 라우팅', () => {
  test('task 미션 → TOX 태스크 생성(goal_slug=apm_id 계보)', async () => {
    const db = openAutopilotMissionsDb(':memory:'); // 미션은 실 db 사용해야 dispatcher가 찾음 → 실제로는 아래처럼
    db.close();
    const real = openAutopilotMissionsDb();
    const m = createMission(real, { goal: '오토파일럿 task 엔진 테스트', source: 'human-intent', triage: { executionModel: 'task', engine: 'tox' } });
    real.close();
    const r = await dispatchAutopilotMissions({ action: 'materialize', id: m.id }) as { ok?: boolean; engine?: string; taskId?: string; missionId?: string };
    expect(r.ok).toBe(true);
    expect(r.engine).toBe('tox');
    expect(r.missionId).toBe(m.id);
    expect(r.taskId).toBeTruthy();
    // cleanup — 미션 + 태스크
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const store = new TaskStore(); try { if (r.taskId) store.deleteTask(r.taskId); } finally { store.close(); }
    const c = openAutopilotMissionsDb(); c.deleteMission(m.id); c.close();
  });

  test('monitor-trigger/goal-loop → 정직한 defer(전용 seam 필요)', async () => {
    const real = openAutopilotMissionsDb();
    const m = createMission(real, { goal: '뉴스 감시', source: 'human-intent', triage: { executionModel: 'monitor-trigger', engine: 'monitor' } });
    real.close();
    const r = await materializeMission({ missionId: m.id });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('seam');
    const c = openAutopilotMissionsDb(); c.deleteMission(m.id); c.close();
  });
});

describe('배선 가드 — mission-tool materialize', () => {
  test('autopilot_missions materialize delegates a missing mission to the dispatcher', async () => {
    const result = await dispatchAutopilotMissions({ action: 'materialize', id: 'apm_c8_missing' }) as { error?: string };
    expect(result.error).toContain('미션 없음');
  });
});

// ★ 크기적응 멀티페이즈 분해(대표 지시 2026-07-11) — heavy 미션을 N 페이즈(backlog·dependsOn)로.
describe('decomposeMissionToPhases — 멀티페이즈 분해(HITL backlog)', () => {
  const MOCK_PROPOSAL = JSON.stringify({
    rationale: '스키마 → 마이그레이션 → 테스트 순으로 격리 분해.',
    tasks: [
      { index: 0, title: '스키마 버전 추가', description: 'schema version', surface: { kind: 'subagent', definitionName: 'general-purpose', prompt: 'p0' }, dependsOn: [], priority: 'high', estimateMs: 1000, estimateTokens: 100, estimateUsd: 0.1, acceptance: { criteria: ['버전 존재'] } },
      { index: 1, title: '마이그레이션 구현', description: 'migration', surface: { kind: 'subagent', definitionName: 'general-purpose', prompt: 'p1' }, dependsOn: [0], priority: 'high', estimateMs: 1000, estimateTokens: 100, estimateUsd: 0.1, acceptance: { criteria: ['구버전 변환'] } },
      { index: 2, title: '회귀 테스트', description: 'test', surface: { kind: 'subagent', definitionName: 'general-purpose', prompt: 'p2' }, dependsOn: [1], priority: 'high', estimateMs: 1000, estimateTokens: 100, estimateUsd: 0.1, acceptance: { criteria: ['테스트 통과'] } },
    ],
  });

  test('heavy 미션 → N 페이즈 backlog 태스크(dependsOn 매핑)', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { decomposeMissionToPhases } = await import('./mission-engine.js');
    const store = new TaskStore({ path: ':memory:' });
    try {
      const m = createMission(store, { goal: 'persistence 마이그레이션 리팩토링', source: 'human-intent', triage: { executionModel: 'task', tier: 'heavy', engine: 'tox' } });
      const r = await decomposeMissionToPhases(m.id, { store, callable: async () => ({ text: MOCK_PROPOSAL, modelId: 'mock' }) });
      expect(r.ok).toBe(true);
      expect(r.phaseCount).toBe(3);
      const tasks = store.listTasks({ goalSlug: m.id }).sort((a, b) => a.createdAt - b.createdAt);
      expect(tasks.length).toBe(3);
      // 전부 backlog(HITL·실행 0).
      expect(tasks.every((t) => t.status === 'backlog')).toBe(true);
      // dependsOn 이 indices → 실 task id 로 매핑됨(phase1 은 phase0 의존).
      expect(tasks[0]!.dependsOn.length).toBe(0);
      expect(tasks[1]!.dependsOn).toContain(tasks[0]!.id);
      expect(tasks[2]!.dependsOn).toContain(tasks[1]!.id);
    } finally { store.close(); }
  });

  test('★ 부분 수술 재분해(대표 2026-07-22) — done 보존·미완만 재분해·새 페이즈는 done tail 뒤 체인', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { decomposeMissionToPhases } = await import('./mission-engine.js');
    const store = new TaskStore({ path: ':memory:' });
    try {
      const m = createMission(store, { goal: 'g', source: 'human-intent', triage: { executionModel: 'task', tier: 'heavy', engine: 'tox' } });
      await decomposeMissionToPhases(m.id, { store, callable: async () => ({ text: MOCK_PROPOSAL, modelId: 'mock' }) });
      const old = store.listTasks({ goalSlug: m.id }).filter((t) => t.surface.kind === 'subagent').sort((a, b) => a.createdAt - b.createdAt);
      // 옛 페이즈: [0]=done(완료·보존 대상) · [1]=running(미완·폐기) · [2]=backlog(미완·폐기).
      store.saveTask({ ...old[0]!, status: 'done' });
      store.saveTask({ ...old[1]!, status: 'running' });
      const doneId = old[0]!.id, runningId = old[1]!.id;
      // 부분 수술 재분해 — done 은 보존, 미완만 폐기 후 재분해, 새 루트는 done tail 뒤로 체인.
      await decomposeMissionToPhases(m.id, { store, callable: async () => ({ text: MOCK_PROPOSAL, modelId: 'mock' }), reviseContext: '범위축소' });
      const after = store.listTasks({ goalSlug: m.id }).filter((t) => t.surface.kind === 'subagent');
      expect(after.some((t) => t.id === doneId && t.status === 'done')).toBe(true);  // ★ done 보존(재실행 방지)
      expect(after.some((t) => t.id === runningId)).toBe(false);                     // running(미완)은 폐기
      const news = after.filter((t) => t.id !== doneId);
      expect(news.length).toBe(3);                                                    // 새 3개(미완 재분해)
      // 새 페이즈 중 루트(다른 새 페이즈에 선행 안 걸린 것)는 done tail 뒤로 체인.
      const roots = news.filter((t) => !t.dependsOn.some((d) => news.some((n) => n.id === d)));
      expect(roots.length).toBeGreaterThan(0);
      expect(roots.every((t) => t.dependsOn.includes(doneId))).toBe(true);            // ★ done 이후부터 이어감
    } finally { store.close(); }
  });

  test('★ 근본(2026-07-22 dogfood) — 긴 골(>80자)이 autoDecomposeMission title 로 들어가도 throw 없이 80 클램프', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { autoDecomposeMission } = await import('./mission-engine.js');
    const store = new TaskStore({ path: ':memory:' });
    try {
      const longGoal = '가'.repeat(150); // >80 — 종전 slice(0,120)면 Task.title>80 throw(크래시)
      const m = createMission(store, { goal: longGoal, source: 'human-intent', triage: { executionModel: 'task', engine: 'tox' } });
      const r = autoDecomposeMission(m.id, { store });
      expect(r.ok).toBe(true); // throw 없이 성공
      const tasks = store.listTasks({ goalSlug: m.id });
      expect(tasks.length).toBe(1);
      expect(tasks[0]!.title.length).toBeLessThanOrEqual(80); // SSOT 한도 클램프
    } finally { store.close(); }
  });

  test('★ 근본(2026-07-22 dogfood) — presetTasks 1개(단일페이즈 RFC)는 autoDecompose 우회 안 하고 preset 그대로 생성', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { decomposeMissionToPhases } = await import('./mission-engine.js');
    const store = new TaskStore({ path: ':memory:' });
    try {
      const m = createMission(store, { goal: '가'.repeat(150), source: 'human-intent', triage: { executionModel: 'task', tier: 'heavy', engine: 'tox' } });
      const preset = [{ index: 0, title: '짧은 단일 페이즈 제목', description: 'desc', surface: { kind: 'subagent' as const, definitionName: 'general-purpose', prompt: 'p0' }, acceptance: { criteria: ['c'] } }];
      const r = await decomposeMissionToPhases(m.id, { store, presetTasks: preset, callable: async () => ({ text: '{}', modelId: 'mock' }) });
      expect(r.ok).toBe(true);
      expect(r.phaseCount).toBe(1);
      const tasks = store.listTasks({ goalSlug: m.id }).filter((t) => t.surface.kind === 'subagent');
      expect(tasks.length).toBe(1);
      // ★ preset title 사용 — 종전엔 tasks.length<=1 이라 골-as-title autoDecompose 로 우회했다.
      expect(tasks[0]!.title).toBe('짧은 단일 페이즈 제목');
    } finally { store.close(); }
  });

  test('★ 근본(2026-07-22) — preset title >80 도 createTask 서 80 클램프(throw 근절)', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { decomposeMissionToPhases } = await import('./mission-engine.js');
    const store = new TaskStore({ path: ':memory:' });
    try {
      const m = createMission(store, { goal: 'g', source: 'human-intent', triage: { executionModel: 'task', tier: 'heavy', engine: 'tox' } });
      const preset = [
        { index: 0, title: '나'.repeat(150), description: 'd0', surface: { kind: 'subagent' as const, definitionName: 'general-purpose', prompt: 'p0' }, acceptance: { criteria: ['c'] } },
        { index: 1, title: '짧은 둘째', description: 'd1', surface: { kind: 'subagent' as const, definitionName: 'general-purpose', prompt: 'p1' }, dependsOn: [0], acceptance: { criteria: ['c'] } },
      ];
      const r = await decomposeMissionToPhases(m.id, { store, presetTasks: preset, callable: async () => ({ text: '{}', modelId: 'mock' }) });
      expect(r.ok).toBe(true);
      const tasks = store.listTasks({ goalSlug: m.id }).filter((t) => t.surface.kind === 'subagent');
      expect(tasks.every((t) => t.title.length <= 80)).toBe(true); // 클램프로 throw 없음
    } finally { store.close(); }
  });

  test('★ 트랜잭셔널(#6) — 정정 재분해 크래시/≤1 시 옛 페이즈 보존(미션 empty 방지·대표 2026-07-12)', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { decomposeMissionToPhases } = await import('./mission-engine.js');
    const store = new TaskStore({ path: ':memory:' });
    try {
      const m = createMission(store, { goal: 'g', source: 'human-intent', triage: { executionModel: 'task', tier: 'heavy', engine: 'tox' } });
      await decomposeMissionToPhases(m.id, { store, callable: async () => ({ text: MOCK_PROPOSAL, modelId: 'mock' }) });
      const oldIds = store.listTasks({ goalSlug: m.id }).filter((t) => t.surface.kind === 'subagent').map((t) => t.id);
      expect(oldIds.length).toBe(3);
      // 크래시 — 옛 페이즈 보존(삭제 안 됨·미션 무손상)
      const crash = await decomposeMissionToPhases(m.id, { store, callable: async () => { throw new Error('LLM 크래시'); }, reviseContext: '범위축소' });
      expect(crash.ok).toBe(false);
      expect(store.listTasks({ goalSlug: m.id }).filter((t) => t.surface.kind === 'subagent').length).toBe(3); // 보존
      // ≤1 태스크 — 정정이면 폴백 대신 보존
      const oneTask = { index: 0, title: '단일', description: 'd', surface: { kind: 'subagent', definitionName: 'general-purpose', prompt: 'p' }, dependsOn: [], priority: 'high', estimateMs: 1, estimateTokens: 1, estimateUsd: 0.1, acceptance: { criteria: ['c'] } };
      const one = await decomposeMissionToPhases(m.id, { store, callable: async () => ({ text: JSON.stringify({ rationale: 'r', tasks: [oneTask] }), modelId: 'mock' }), reviseContext: '범위축소' });
      expect(one.ok).toBe(false);
      expect(store.listTasks({ goalSlug: m.id }).filter((t) => t.surface.kind === 'subagent').length).toBe(3); // 여전히 보존
    } finally { store.close(); }
  });

  test('★ 신규 미션 + reviseContext(--comment) + ≤1 → 단일 폴백(0 페이즈 침묵종료 방지·2026-07-19 dogfood)', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { decomposeMissionToPhases } = await import('./mission-engine.js');
    const store = new TaskStore({ path: ':memory:' });
    try {
      // 신규 미션 — 옛 subagent 페이즈 0. --comment(reviseContext)로 분해 시 ≤1 로 붕괴.
      const m = createMission(store, { goal: 'g', source: 'human-intent', triage: { executionModel: 'task', tier: 'heavy', engine: 'tox' } });
      const oneTask = { index: 0, title: '단일', description: 'd', surface: { kind: 'subagent', definitionName: 'general-purpose', prompt: 'p' }, dependsOn: [], priority: 'high', estimateMs: 1, estimateTokens: 1, estimateUsd: 0.1, acceptance: { criteria: ['c'] } };
      const r = await decomposeMissionToPhases(m.id, { store, callable: async () => ({ text: JSON.stringify({ rationale: 'r', tasks: [oneTask] }), modelId: 'mock' }), reviseContext: '2개 페이즈로' });
      // 보존할 옛 페이즈가 없으므로(신규) 단일 폴백 → 최소 1 페이즈(실행 가능·0 침묵종료 아님).
      expect(r.phaseCount).toBeGreaterThanOrEqual(1);
      expect(store.listTasks({ goalSlug: m.id }).filter((t) => t.surface.kind === 'subagent').length).toBeGreaterThanOrEqual(1);
    } finally { store.close(); }
  });

  test('회귀0 — coding 도메인 objective 는 기존 "구현한다" 프리앰블(도메인팩 이관·D2)', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { decomposeMissionToPhases } = await import('./mission-engine.js');
    const store = new TaskStore({ path: ':memory:' });
    try {
      const m = createMission(store, { goal: 'persistence 마이그레이션 리팩토링', source: 'human-intent', triage: { executionModel: 'task', tier: 'heavy', engine: 'tox', domain: 'coding' } });
      let captured = '';
      await decomposeMissionToPhases(m.id, { store, callable: async ({ prompt }: { prompt: string }) => { captured = prompt; return { text: MOCK_PROPOSAL, modelId: 'mock' }; } });
      // 도메인팩 이관 후에도 objective 프리앰블·골이 그대로(회귀0).
      expect(captured).toContain('elanous 에 다음 미션을 구현한다');
      expect(captured).toContain('persistence 마이그레이션 리팩토링');
    } finally { store.close(); }
  });

  test('D3 — investment 도메인은 관측→집행 투자 페이즈 가이드(구현한다 아님)', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { decomposeMissionToPhases } = await import('./mission-engine.js');
    const store = new TaskStore({ path: ':memory:' });
    try {
      const m = createMission(store, { goal: '삼성전자 비중 리밸런싱', source: 'human-intent', triage: { executionModel: 'task', tier: 'heavy', engine: 'tox', domain: 'investment' } });
      let captured = '';
      await decomposeMissionToPhases(m.id, { store, callable: async ({ prompt }: { prompt: string }) => { captured = prompt; return { text: MOCK_PROPOSAL, modelId: 'mock' }; } });
      expect(captured).toContain('투자 목표');
      expect(captured).toContain('관측');
      expect(captured).toContain('mandate');
      expect(captured).not.toContain('구현한다');
    } finally { store.close(); }
  });

  test('도메인 분기 — general 도메인은 중립 프리앰블(구현한다 아님)', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { decomposeMissionToPhases } = await import('./mission-engine.js');
    const store = new TaskStore({ path: ':memory:' });
    try {
      const m = createMission(store, { goal: '일반 지식 작업', source: 'human-intent', triage: { executionModel: 'task', tier: 'heavy', engine: 'tox', domain: 'general' } });
      let captured = '';
      await decomposeMissionToPhases(m.id, { store, callable: async ({ prompt }: { prompt: string }) => { captured = prompt; return { text: MOCK_PROPOSAL, modelId: 'mock' }; } });
      expect(captured).toContain('다음 목표를 달성한다');
      expect(captured).not.toContain('구현한다');
    } finally { store.close(); }
  });

  test('1태스크 proposal → small 폴백(단일)', async () => {
    const { TaskStore } = await import('../task-orchestrator/store.js');
    const { decomposeMissionToPhases } = await import('./mission-engine.js');
    const store = new TaskStore({ path: ':memory:' });
    try {
      const m = createMission(store, { goal: '작은 수정', source: 'human-intent', triage: { executionModel: 'task', tier: 'light', engine: 'tox' } });
      const oneTask = JSON.stringify({ rationale: 'single', tasks: [{ index: 0, title: '한 파일 수정', description: 'd', surface: { kind: 'subagent', definitionName: 'general-purpose', prompt: 'p' }, dependsOn: [], priority: 'medium', estimateMs: 1000, estimateTokens: 100, estimateUsd: 0.1, acceptance: { criteria: ['수정됨'] } }] });
      const r = await decomposeMissionToPhases(m.id, { store, callable: async () => ({ text: oneTask, modelId: 'mock' }) });
      expect(r.note).toContain('small');
      expect(r.phaseCount).toBe(1);
    } finally { store.close(); }
  });
});
