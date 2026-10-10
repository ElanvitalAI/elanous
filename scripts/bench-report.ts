#!/usr/bin/env bun
// 벤치 한 판(runId) → 팔 × 지표 표. RFC-fleet-supervisor-substrates-benchmark-and-token-accounting §F5 · 2026-09-25.
//   bun scripts/bench-report.ts --run <runId> [--since 24h] [--json] [--bn1 <관측.json>]
// 기본 입력은 호스트 로그 셋뿐이다(새 저장소 0). BN1은 선택적 별도 관측 파일이다.
// 기본 로그 입력:
//   ① `self-dev.orchestrate substrate`   — 팔 선언(benchArms: id·provider·model)
//   ② `self-implement.pod job-applied`   — spaceId ↔ armId
//   ③ `self-dev.orchestrate job.done`    — taskId·stage·prUrl·durationMs ⊕ (E4) gatePassed·reviewVerdict·reviewMustFixCount
//   ④ `llm-usage` site=`pod-rollup:*`    — Pod 가 잰 사용량(armId 별)
// ⛔ runId 로만 거른다 — `--all --include-test` 의 «모든 우주»가 섞여도 runId 는 한 판이다.
// ⛔ 이음이 끊긴 칸은 0 으로 채우지 않고 `null`(못 이음)로 둔다.
// ⛔ 기본 표로 팔을 «비교»하지 않는다 — 팔 밖 모델 행(leak)이 0이고 팔마다 표본이 쌓인 뒤에만(A/B 매뉴얼 · 결론 금지). BN1도 네 팔 동일 골 측정 전 결론 금지.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LogRow { category?: string; event?: string; data?: Record<string, unknown> | null }
export interface ArmDecl { id: string; provider: string; model: string | null }
export interface ArmReport {
  armId: string;
  declared: ArmDecl | null;
  stage: string | null;
  prUrl: string | null;
  durationMs: number | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  usdKnown: number;
  unknownCostCalls: number;
  /** 구독·local 호출(청구 0 · BACKLOG C6) ⊕ 그 API 환산가. */
  includedCalls: number;
  apiEquivalentUsd: number;
  models: string[];
  /** 선언 모델이 아닌 모델로 간 호출 수 — 팔이 «한 모델»이 아니었다. 선언 모델을 모르면 null. */
  leakCalls: number | null;
  /** E4 — 게이트 통과 여부 · 마지막 리뷰 판정 · must-fix 수. 못 이었거나 그 판이 안 실었으면 null. */
  gatePassed: boolean | null;
  reviewVerdict: string | null;
  reviewMustFixCount: number | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const armKey = (id: string): string => (id.startsWith('pod/') ? id : `pod/${id}`);

export function buildBenchReport(rows: readonly LogRow[], runId: string): { runId: string; arms: ArmReport[]; unjoinedJobs: number; image?: { commit: string | null; fresh: boolean | null } } {
  const mine = rows.filter((r) => r.data && r.data.runId === runId);
  const arms = new Map<string, ArmReport>();
  let image: { commit: string | null; fresh: boolean | null } | undefined;
  const arm = (armId: string): ArmReport => {
    let a = arms.get(armId);
    if (!a) {
      a = { armId, declared: null, stage: null, prUrl: null, durationMs: null, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, usdKnown: 0, unknownCostCalls: 0, includedCalls: 0, apiEquivalentUsd: 0, models: [], leakCalls: null, gatePassed: null, reviewVerdict: null, reviewMustFixCount: null };
      arms.set(armId, a);
    }
    return a;
  };
  for (const r of mine) {
    if (r.category === 'self-dev.orchestrate' && r.event === 'substrate' && 'imageCommit' in r.data!) {
      image = { commit: str(r.data!.imageCommit), fresh: typeof r.data!.imageFresh === 'boolean' ? r.data!.imageFresh : null };
    }
    if (r.category === 'self-dev.orchestrate' && r.event === 'substrate' && Array.isArray(r.data!.benchArms)) {
      for (const d of r.data!.benchArms as Array<Record<string, unknown>>) {
        const id = str(d.id);
        if (id) arm(armKey(id)).declared = { id, provider: str(d.provider) ?? '?', model: str(d.model) };
      }
    }
  }
  // spaceId → armId. 1차 = job-applied 의 armId. 2차 = 롤업 행의 `job` 이름 ↔ job-applied 의 job→spaceId
  //   (armId 를 싣기 전 판도 잇는다 · 단 호출 0인 팔은 롤업 행이 없어 2차로도 못 잇는다).
  const armBySpace = new Map<string, string>();
  const spaceByJob = new Map<string, string>();
  for (const r of mine) {
    if (r.category === 'self-implement.pod' && r.event === 'job-applied') {
      const space = str(r.data!.spaceId); const id = str(r.data!.armId); const job = str(r.data!.job);
      if (space && id) armBySpace.set(space, id);
      if (space && job) spaceByJob.set(job, space);
    }
  }
  for (const r of mine) {
    if (r.event !== 'llm-usage') continue;
    const job = str(r.data!.job); const id = str(r.data!.armId);
    const space = job ? spaceByJob.get(job) : undefined;
    if (space && id && !armBySpace.has(space)) armBySpace.set(space, id);
  }
  let unjoinedJobs = 0;
  for (const r of mine) {
    if (r.category !== 'self-dev.orchestrate' || r.event !== 'job.done') continue;
    const taskId = str(r.data!.taskId);
    const id = taskId ? armBySpace.get(taskId.replace(':', '-')) : undefined;
    if (!id) { unjoinedJobs++; continue; }
    const a = arm(id);
    a.stage = str(r.data!.stage);
    a.prUrl = str(r.data!.prUrl);
    a.durationMs = typeof r.data!.durationMs === 'number' ? r.data!.durationMs : null;
    a.gatePassed = typeof r.data!.gatePassed === 'boolean' ? r.data!.gatePassed : null;
    a.reviewVerdict = str(r.data!.reviewVerdict);
    a.reviewMustFixCount = typeof r.data!.reviewMustFixCount === 'number' ? r.data!.reviewMustFixCount : null;
  }
  const leak = new Map<string, number>();
  for (const r of mine) {
    if (r.event !== 'llm-usage') continue;
    const site = str(r.data!.site);
    const id = str(r.data!.armId);
    if (!site?.startsWith('pod-rollup:') || !id) continue;
    const a = arm(id);
    const calls = num(r.data!.calls) || 1;
    a.calls += calls;
    a.inputTokens += num(r.data!.inputTokens);
    a.outputTokens += num(r.data!.outputTokens);
    a.cacheReadInputTokens += num(r.data!.cacheReadInputTokens);
    const cost = (r.data!.cost ?? {}) as Record<string, unknown>;
    a.usdKnown += num(cost.usd);
    a.unknownCostCalls += num(cost.unknownCostCalls);
    if (cost.kind === 'included') { a.includedCalls += num(cost.includedCalls) || calls; a.apiEquivalentUsd += num(cost.apiEquivalentUsd); }
    const model = str(r.data!.model) ?? '?';
    if (!a.models.includes(model)) a.models.push(model);
    if (a.declared?.model && model !== a.declared.model) leak.set(id, (leak.get(id) ?? 0) + calls);
  }
  for (const a of arms.values()) a.leakCalls = a.declared?.model ? (leak.get(a.armId) ?? 0) : null;
  return { runId, arms: [...arms.values()].sort((x, y) => (x.armId < y.armId ? -1 : 1)), unjoinedJobs, ...(image ? { image } : {}) };
}

export const BN1_ARMS = ['Codex', 'OpenClaw', 'Hermes', '엘라누스'] as const;
export type Bn1Arm = typeof BN1_ARMS[number];
export interface Bn1Input {
  runId: string;
  goals: Array<{ id: string; text: string }>;
  observations: Array<{
    goalId: string;
    arm: Bn1Arm;
    completed: boolean | null;
    humanInterventions: number | null;
    durationMs: number | null;
    costUsd: number | null;
    evidence: string;
  }>;
}

/** BN1 is a separate, opt-in experiment: no inference from pod stage, calls or known-cost subtotal. */
export function buildBn1Comparison(input: Bn1Input, runId: string) {
  if (!input || typeof input.runId !== 'string' || !input.runId.trim() || input.runId !== runId || !Array.isArray(input.goals) || !input.goals.length || !Array.isArray(input.observations)) throw new Error('BN1: runId 또는 골 셋이 유효하지 않음');
  const goals = new Set<string>();
  for (const goal of input.goals) {
    if (typeof goal?.id !== 'string' || !goal.id.trim() || typeof goal.text !== 'string' || !goal.text.trim() || goals.has(goal.id)) throw new Error('BN1: 빈 골 또는 중복 골');
    goals.add(goal.id);
  }
  const observed = new Map<string, Bn1Input['observations'][number]>();
  for (const row of input.observations) {
    if (!row || typeof row.goalId !== 'string' || typeof row.arm !== 'string') throw new Error('BN1: 알 수 없거나 중복된 골/팔');
    const key = `${row.goalId}\u0000${row.arm}`;
    if (!goals.has(row.goalId) || !BN1_ARMS.includes(row.arm) || observed.has(key)) throw new Error('BN1: 알 수 없거나 중복된 골/팔');
    if (typeof row.evidence !== 'string' || !row.evidence.trim()) throw new Error('BN1: 관측 근거가 없음');
    if (row.completed !== null && typeof row.completed !== 'boolean') throw new Error('BN1: 완주 값은 boolean 또는 null');
    for (const value of [row.humanInterventions, row.durationMs, row.costUsd]) {
      if (value === undefined || (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))) throw new Error('BN1: 수치는 0 이상 또는 null');
    }
    if (row.humanInterventions !== null && !Number.isInteger(row.humanInterventions)) throw new Error('BN1: 사람 개입 수는 정수');
    observed.set(key, row);
  }
  const comparedGoals = input.goals.map((goal) => {
    const arms = BN1_ARMS.map((arm) => {
      const row = observed.get(`${goal.id}\u0000${arm}`);
      return { arm, completed: row?.completed ?? null, humanInterventions: row?.humanInterventions ?? null,
        durationMs: row?.durationMs ?? null, costUsd: row?.costUsd ?? null, evidence: row?.evidence ?? null };
    });
    return { id: goal.id, text: goal.text, arms };
  });
  const fieldsComplete = comparedGoals.every((goal) => goal.arms.every((arm) =>
    arm.completed !== null && arm.humanInterventions !== null && arm.durationMs !== null && arm.costUsd !== null && arm.evidence !== null));
  return { runId, fieldsComplete, goals: comparedGoals };
}

export function renderBn1Comparison(rep: ReturnType<typeof buildBn1Comparison>): string {
  const value = (v: number | boolean | null): string => v === null ? '못 잼' : typeof v === 'boolean' ? (v ? '완주' : '미완주') : String(v);
  const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', '<br>');
  return ['## BN1 · 같은 골 대조 (X1 격리 설치와 짝)', '',
    `측정 칸 완비: ${rep.fieldsComplete ? '네 팔 관측값 기입 완료(출처와 조건 별도 검증 필요)' : '아니오 — 미관측 칸 존재'}`,
    '', '| 골 | 공유 골 입력(미확정 가능) | 팔 | 끝까지 | 사람 개입 수 | 시간(ms) | 비용(USD) | 근거 |',
    '|---|---|---|---|---|---|---|---|',
    ...rep.goals.flatMap((goal) => goal.arms.map((row) => `| ${cell(goal.id)} | ${cell(goal.text)} | ${row.arm} | ${value(row.completed)} | ${value(row.humanInterventions)} | ${value(row.durationMs)} | ${value(row.costUsd)} | ${row.evidence === null ? '못 잼' : cell(row.evidence)} |`)),
    '', 'X1 짝 실측(격리 설치·첫 실행, 개발 골 대조 아님): docs/measurements/X1-inner-pty-openclaw-hermes-install-2026-10-03.md',
    '못 잼은 0이 아니라 미관측이다. 동일 골 네 팔의 근거가 모이기 전 비교 우열은 판정하지 않는다.'].join('\n');
}

export function renderBenchReport(rep: ReturnType<typeof buildBenchReport>): string {
  const k = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));
  const lines = [
    `# bench ${rep.runId}`,
    '',
    rep.image
      ? `이미지 판: ${rep.image.commit?.slice(0, 12) ?? '라벨 없음'} · ${rep.image.fresh === true ? 'HEAD 와 같다' : rep.image.fresh === false ? '⛔ HEAD 와 다르다 — 이 표는 «이미지 판»을 잰다' : '모름'}`
      : '이미지 판: 못 잼(이미지 대조 전 판)',
    '',
    '| 팔 | 선언 모델 | 결과 | 시간 | 게이트 | 리뷰(must-fix) | 호출 | 입력 | 출력 | 캐시읽기 | $(알려진) | 비용 모름 | 구독·local(API 환산 $) | 팔 밖 호출 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rep.arms.map((a) => `| ${a.armId} | ${a.declared?.model ?? '못 이음'} | ${a.stage ?? '못 이음'}${a.prUrl ? ` ${a.prUrl}` : ''} | ${a.durationMs === null ? '—' : `${Math.round(a.durationMs / 1000)}s`} | ${a.gatePassed === null ? '모름' : a.gatePassed ? '통과' : '실패'} | ${a.reviewVerdict === null ? '모름' : `${a.reviewVerdict}${a.reviewMustFixCount === null ? '' : ` (${a.reviewMustFixCount})`}`} | ${a.calls} | ${k(a.inputTokens)} | ${k(a.outputTokens)} | ${k(a.cacheReadInputTokens)} | ${a.calls > 0 && a.unknownCostCalls >= a.calls ? '—' : a.usdKnown.toFixed(2)} | ${a.unknownCostCalls} | ${a.includedCalls ? `${a.includedCalls} (${a.apiEquivalentUsd.toFixed(2)})` : '—'} | ${a.leakCalls === null ? '모름' : a.leakCalls}${a.leakCalls ? ` ⛔ ${a.models.join(', ')}` : ''} |`),
    '',
  ];
  if (rep.unjoinedJobs > 0) lines.push(`⚠️ 팔을 못 이은 job ${rep.unjoinedJobs}건 — 이 판은 armId 를 싣기 전 판일 수 있다.`);
  const leaked = rep.arms.filter((a) => (a.leakCalls ?? 0) > 0).map((a) => a.armId);
  lines.push(leaked.length
    ? `⛔ 팔 밖 모델로 간 호출이 있다(${leaked.join(', ')}) — 이 판으로 팔을 비교하지 않는다.`
    : '⛔ 한 판(팔당 N=1)이다 — 결론이 아니라 관측이다. 비교는 팔마다 표본이 쌓인 뒤에.');
  return lines.join('\n');
}

if (import.meta.main) {
  const arg = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const runId = arg('--run');
  if (!runId) { console.error('사용: bun scripts/bench-report.ts --run <runId> [--since 24h] [--json]'); process.exit(2); }
  const bn1Path = arg('--bn1');
  if (process.argv.includes('--bn1') && (!bn1Path || bn1Path.startsWith('--'))) {
    console.error('BN1 입력 실패: --bn1 <관측.json> 경로 필요');
    process.exit(2);
  }
  let bn1: ReturnType<typeof buildBn1Comparison> | undefined;
  if (bn1Path) {
    try { bn1 = buildBn1Comparison(JSON.parse(readFileSync(bn1Path, 'utf8')) as Bn1Input, runId); }
    catch (error) { console.error(`BN1 입력 실패: ${error instanceof Error ? error.message : String(error)}`); process.exit(2); }
  }
  // BN1 external arms have no self-dev pod logs. Do not require legacy bench arms for their report.
  if (bn1) {
    console.log(process.argv.includes('--json') ? JSON.stringify(bn1) : renderBn1Comparison(bn1));
    process.exit(0);
  }
  const bin = join(dirname(import.meta.dir), 'bin', 'elanous.mjs');
  const rows: LogRow[] = [];
  for (const q of [['--category', 'self-dev.orchestrate'], ['--category', 'self-implement.pod'], ['--event', 'llm-usage']]) {
    const r = spawnSync(process.execPath, [bin, 'logs', '--all', '--include-test', ...q, '--since', arg('--since') ?? '24h', '--limit', '50000', '--json', '--json-data'], { encoding: 'utf8', timeout: 180_000, maxBuffer: 512 * 1024 * 1024 });
    if (r.status !== 0) { console.error(`elanous logs ${q.join(' ')} 실패 rc=${r.status}: ${(r.stderr ?? '').slice(0, 300)}`); process.exit(1); }
    let n = 0;
    for (const line of (r.stdout ?? '').split('\n')) {
      if (!line.startsWith('{')) continue;
      try { const o = JSON.parse(line) as LogRow & { _meta?: unknown }; if (!o._meta) { rows.push(o); n++; } } catch { /* skip */ }
    }
    // ⛔ 잘린 창은 «시작을 늦게» 틀린다 — 상한에 닿았으면 이 판의 앞쪽 행이 빠졌을 수 있다.
    if (n >= 50_000) console.error(`⚠️ elanous logs ${q.join(' ')} 가 상한 50000 에 닿았다 — --since 를 좁혀라(이 표는 «하한»이다).`);
  }
  const rep = buildBenchReport(rows, runId);
  console.log(process.argv.includes('--json') ? JSON.stringify(rep) : renderBenchReport(rep));
  if (rep.arms.length === 0) process.exit(1);
}
