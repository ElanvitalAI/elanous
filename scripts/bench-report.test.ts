import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildBenchReport, renderBenchReport, buildBn1Comparison, renderBn1Comparison, type LogRow, type Bn1Input } from './bench-report.js';

const R = 'run-1';
const rows: LogRow[] = [
  { category: 'self-dev.orchestrate', event: 'substrate', data: { runId: R, imageCommit: 'abc123', imageFresh: false, benchArms: [{ id: 'claude', provider: 'anthropic', model: 'claude-sonnet-5' }, { id: 'kimi', provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3' }, { id: 'codex', provider: 'openai-codex', model: 'gpt-6-sol' }] } },
  { category: 'self-implement.pod', event: 'job-applied', data: { runId: R, job: 'si-a', spaceId: 'task-a', armId: 'pod/claude' } },
  { category: 'self-implement.pod', event: 'job-applied', data: { runId: R, job: 'si-b', spaceId: 'task-b' } },            // armId 없는 옛 판 — 롤업 job 으로 잇는다
  { category: 'self-implement.pod', event: 'job-applied', data: { runId: R, job: 'si-c', spaceId: 'task-c' } },            // 호출 0 · armId 없음 → 못 잇는다
  { category: 'self-dev.orchestrate', event: 'job.done', data: { runId: R, taskId: 'task:a', stage: 'pr-opened', prUrl: 'u/1', durationMs: 60_000 } },
  { category: 'self-dev.orchestrate', event: 'job.done', data: { runId: R, taskId: 'task:b', stage: 'pr-opened', durationMs: 30_000 } },
  { category: 'self-dev.orchestrate', event: 'job.done', data: { runId: R, taskId: 'task:c', stage: 'aborted', durationMs: 5_000 } },
  { event: 'llm-usage', data: { runId: R, site: 'pod-rollup:agent-turn', armId: 'pod/claude', job: 'si-a', model: 'claude-sonnet-5', calls: 10, inputTokens: 100, outputTokens: 10, cost: { usd: 1.5, unknownCostCalls: 0 } } },
  { event: 'llm-usage', data: { runId: R, site: 'pod-rollup:agent-turn', armId: 'pod/claude', job: 'si-a', model: 'gpt-6-sol', calls: 4, inputTokens: 900, outputTokens: 9, cost: { usd: 0.5, unknownCostCalls: 0 } } },
  { event: 'llm-usage', data: { runId: R, site: 'pod-rollup:agent-turn', armId: 'pod/kimi', job: 'si-b', model: 'openrouter/moonshotai/kimi-k3', calls: 3, inputTokens: 30, outputTokens: 3, cost: { usd: 0, unknownCostCalls: 3 } } },
  // 다른 판 · pod-rollup 이 아닌 행 — 섞이면 안 된다
  { event: 'llm-usage', data: { runId: 'run-2', site: 'pod-rollup:agent-turn', armId: 'pod/claude', model: 'claude-sonnet-5', calls: 99, inputTokens: 1 } },
  { event: 'llm-usage', data: { runId: R, site: 'agent-turn', armId: 'pod/claude', model: 'claude-sonnet-5', inputTokens: 7 } },
];

describe('bench report (RFC F5)', () => {
  const rep = buildBenchReport(rows, R);
  const by = Object.fromEntries(rep.arms.map((a) => [a.armId, a]));
  test('joins declaration, outcome and pod usage by runId only', () => {
    expect(by['pod/claude']).toMatchObject({ stage: 'pr-opened', prUrl: 'u/1', durationMs: 60_000, calls: 14, inputTokens: 1000, usdKnown: 2 });
    expect(by['pod/kimi']).toMatchObject({ stage: 'pr-opened', calls: 3, unknownCostCalls: 3, leakCalls: 0 });
  });
  test('counts calls that left the declared model (arm = one model)', () => {
    expect(by['pod/claude']!.leakCalls).toBe(4);
    expect(renderBenchReport(rep)).toContain('이 판으로 팔을 비교하지 않는다');
  });
  test('a zero-call arm without armId stays unjoined, not zero-filled', () => {
    expect(rep.unjoinedJobs).toBe(1);
    expect(by['pod/codex']).toMatchObject({ stage: null, calls: 0 });
    expect(renderBenchReport(rep)).toContain('못 이음');
  });
  test('names the image version it measured and warns when it is not HEAD', () => {
    expect(rep.image).toEqual({ commit: 'abc123', fresh: false });
    expect(renderBenchReport(rep)).toContain('HEAD 와 다르다');
  });
});

describe('BN1 — 동일 골 네 팔의 근거 있는 비교', () => {
  const input: Bn1Input = {
    runId: R,
    goals: [{ id: 'g1', text: '같은 골 원문' }],
    observations: [
      { goalId: 'g1', arm: 'Codex', completed: false, humanInterventions: 0, durationMs: 0, costUsd: 0, evidence: 'fixture:codex' },
      { goalId: 'g1', arm: '엘라누스', completed: true, humanInterventions: 1, durationMs: 1200, costUsd: null, evidence: 'fixture:elanous' },
    ],
  };
  test('같은 골의 네 팔을 고정해 미관측은 null, 관측된 0은 0으로 유지한다', () => {
    const result = buildBn1Comparison(input, R);
    expect(result.fieldsComplete).toBe(false);
    expect(result.goals[0]!.text).toBe('같은 골 원문');
    expect(result.goals[0]!.arms.map((row) => row.arm)).toEqual(['Codex', 'OpenClaw', 'Hermes', '엘라누스']);
    expect(result.goals[0]!.arms[0]).toMatchObject({ completed: false, humanInterventions: 0, durationMs: 0, costUsd: 0 });
    expect(result.goals[0]!.arms[1]).toMatchObject({ completed: null, humanInterventions: null, durationMs: null, costUsd: null, evidence: null });
    expect(renderBn1Comparison(result)).toContain('측정 칸 완비: 아니오 — 미관측 칸 존재');
    expect(renderBn1Comparison(result)).toContain('| 골 | 공유 골 입력(미확정 가능) | 팔 | 끝까지 | 사람 개입 수 | 시간(ms) | 비용(USD) | 근거 |');
    expect(renderBn1Comparison(result)).toContain('| g1 | 같은 골 원문 | OpenClaw | 못 잼 | 못 잼 | 못 잼 | 못 잼 | 못 잼 |');
    expect(renderBn1Comparison(result)).toContain('| g1 | 같은 골 원문 | Codex | 미완주 | 0 | 0 | 0 | fixture:codex |');
    expect(renderBn1Comparison(result)).toContain('| g1 | 같은 골 원문 | 엘라누스 | 완주 | 1 | 1200 | 못 잼 | fixture:elanous |');
    expect(renderBn1Comparison(result)).toContain('X1 짝 실측(격리 설치·첫 실행, 개발 골 대조 아님)');
  });
  test('네 팔 모든 판정 칸을 관측한 경우에만 비교 입력을 채웠다고 판정한다', () => {
    const complete = {
      ...input,
      observations: [
        ...input.observations.map((row) => ({ ...row, costUsd: row.costUsd ?? 0 })),
        ...(['OpenClaw', 'Hermes'] as const).map((arm) => ({ goalId: 'g1', arm, completed: false, humanInterventions: 0, durationMs: 1, costUsd: 0, evidence: `fixture:${arm}` })),
      ],
    };
    expect(buildBn1Comparison(complete, R).fieldsComplete).toBe(true);
    expect(renderBn1Comparison(buildBn1Comparison(complete, R))).toContain('측정 칸 완비: 네 팔 관측값 기입 완료(출처와 조건 별도 검증 필요)');
    expect(buildBn1Comparison({ ...complete, observations: complete.observations.map((row) => row.arm === 'Hermes' ? { ...row, costUsd: null } : row) }, R).fieldsComplete).toBe(false);
    expect(buildBn1Comparison({ ...complete, goals: [...complete.goals, { id: 'g2', text: '두 번째 동일 골' }] }, R).fieldsComplete).toBe(false);
  });
  test('다른 런, 중복 팔, 없는 근거, 음수 개입은 비교 근거로 받지 않는다', () => {
    expect(() => buildBn1Comparison(input, 'other')).toThrow();
    expect(() => buildBn1Comparison({ ...input, observations: [...input.observations, input.observations[0]!] }, R)).toThrow();
    expect(() => buildBn1Comparison({ ...input, observations: [{ ...input.observations[0]!, evidence: '' }] }, R)).toThrow();
    expect(() => buildBn1Comparison({ ...input, observations: [{ ...input.observations[0]!, humanInterventions: -1 }] }, R)).toThrow();
    expect(() => buildBn1Comparison({ ...input, observations: [{ ...input.observations[0]!, humanInterventions: 0.5 }] }, R)).toThrow();
    expect(() => buildBn1Comparison({ ...input, observations: [{ ...input.observations[0]!, durationMs: undefined }] } as unknown as Bn1Input, R)).toThrow();
    expect(() => buildBn1Comparison({ ...input, observations: [{ ...input.observations[0]!, arm: 'unknown' }] } as unknown as Bn1Input, R)).toThrow();
    expect(() => buildBn1Comparison({ ...input, observations: [{ ...input.observations[0]!, goalId: 'other' }] }, R)).toThrow();
    expect(() => buildBn1Comparison({ ...input, goals: [{ id: 'g1', text: '같은 골 원문' }, { id: 'g1', text: '중복' }] }, R)).toThrow();
    expect(() => buildBn1Comparison({ ...input, observations: [{ ...input.observations[0]!, completed: undefined }] } as unknown as Bn1Input, R)).toThrow();
    expect(() => buildBn1Comparison({ ...input, observations: [{ ...input.observations[0]!, costUsd: -1 }] }, R)).toThrow();
    expect(() => buildBn1Comparison({ ...input, observations: [{ ...input.observations[0]!, durationMs: Number.NaN }] }, R)).toThrow();
  });
  test('실행 입구 --bn1은 외부 팔의 Pod 로그 없이 독립 대조 JSON을 출력한다', () => {
    const fixture = join(import.meta.dir, '../docs/measurements/bn1-task-agent.first-slice.json');
    const result = spawnSync(process.execPath, [join(import.meta.dir, 'bench-report.ts'), '--run', 'bn1-first-slice-unmeasured', '--bn1', fixture, '--json'], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as ReturnType<typeof buildBn1Comparison>;
    expect(report.fieldsComplete).toBe(false);
    expect(report.goals).toHaveLength(2);
    expect(report.goals.flatMap((goal) => goal.arms)).toHaveLength(8);
    expect(report.goals.every((goal) => goal.arms.every((arm) => arm.completed === null && arm.humanInterventions === null && arm.durationMs === null && arm.costUsd === null))).toBe(true);
    const mismatched = spawnSync(process.execPath, [join(import.meta.dir, 'bench-report.ts'), '--run', 'other', '--bn1', fixture, '--json'], { encoding: 'utf8', timeout: 10_000 });
    expect(mismatched.status).toBe(2);
    expect(mismatched.stderr).toContain('BN1 입력 실패: BN1: runId 또는 골 셋이 유효하지 않음');
    const missing = spawnSync(process.execPath, [join(import.meta.dir, 'bench-report.ts'), '--run', 'bn1-first-slice-unmeasured', '--bn1'], { encoding: 'utf8', timeout: 10_000 });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('BN1 입력 실패: --bn1 <관측.json> 경로 필요');
    const markdown = spawnSync(process.execPath, [join(import.meta.dir, 'bench-report.ts'), '--run', 'bn1-first-slice-unmeasured', '--bn1', fixture], { encoding: 'utf8', timeout: 10_000 });
    expect(markdown.status).toBe(0);
    expect(markdown.stdout).toContain('| BN1-G1 | 동일한 격리 저장소에서 동일한 작은 코드 결함 수정·집중 시험 통과·리뷰·병합 (실제 골 원문·커밋 미확정) | Codex | 못 잼 | 못 잼 | 못 잼 | 못 잼 | 못 잼 |');
    expect(markdown.stdout).toContain('X1 짝 실측(격리 설치·첫 실행, 개발 골 대조 아님)');
  });
  test('선택하지 않은 종전 리포트의 출력과 JSON 원장 모양은 그대로다', () => {
    const old = buildBenchReport(rows, R);
    expect(Object.keys(old)).toEqual(['runId', 'arms', 'unjoinedJobs', 'image']);
    expect(JSON.stringify(old)).not.toContain('bn1');
    expect(renderBenchReport(old)).not.toContain('BN1 · 같은 골 대조');
    const usage = spawnSync(process.execPath, [join(import.meta.dir, 'bench-report.ts')], { encoding: 'utf8', timeout: 10_000 });
    expect(usage.status).toBe(2);
    expect(usage.stderr.trim()).toBe('사용: bun scripts/bench-report.ts --run <runId> [--since 24h] [--json]');
  });
});

describe('E4 — 게이트·리뷰 칸 (2026-09-25)', () => {
  const base: LogRow[] = [
    { category: 'self-implement.pod', event: 'job-applied', data: { runId: 'run-e4', job: 'si-x', spaceId: 'task-x', armId: 'pod/x' } },
    { category: 'self-implement.pod', event: 'job-applied', data: { runId: 'run-e4', job: 'si-y', spaceId: 'task-y', armId: 'pod/y' } },
    { category: 'self-dev.orchestrate', event: 'job.done', data: { runId: 'run-e4', taskId: 'task:x', stage: 'merged', gatePassed: true, reviewVerdict: 'warn', reviewMustFixCount: 0 } },
    { category: 'self-dev.orchestrate', event: 'job.done', data: { runId: 'run-e4', taskId: 'task:y', stage: 'aborted' } },   // 칸을 안 실은 판
  ];
  test('job.done 이 실은 게이트·리뷰를 팔에 옮기고, 안 실은 판은 «모름»(null)이다 — 실패로 접지 않는다', () => {
    const r = buildBenchReport(base, 'run-e4');
    const x = r.arms.find((a) => a.armId === 'pod/x')!;
    const y = r.arms.find((a) => a.armId === 'pod/y')!;
    expect([x.gatePassed, x.reviewVerdict, x.reviewMustFixCount]).toEqual([true, 'warn', 0]);
    expect([y.gatePassed, y.reviewVerdict, y.reviewMustFixCount]).toEqual([null, null, null]);
    const text = renderBenchReport(r);
    expect(text).toContain('| 게이트 | 리뷰(must-fix) |');
    expect(text).toContain('| 통과 | warn (0) |');
    expect(text).toContain('| 모름 | 모름 |');
  });
});
