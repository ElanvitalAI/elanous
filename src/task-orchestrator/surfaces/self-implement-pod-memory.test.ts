import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore, logsDbPath } from '../../mss/logging/log-store.js';
import { getUserConfig, resetUserConfig } from '../../user-config.js';
import { goalTouchesPwa, podMemoryLimitFor, podMemoryRequestFor, podJobManifest, podSelfImplementSpawn } from './self-implement-pod.js';
import { advisePodMemory, readPodMemoryAdvice } from '../../cli/pod-memory-advice.js';
import { measurePodMemoryByGoal } from '../../../scripts/measure-pod-memory-by-goal.js';
import { debug } from '../../debug/log.js';
import { dispatchHarnessOnPod } from '../../harness/harness-pod-dispatch.js';

describe('Pod 메모리 등급 — standard | high', () => {
  const pwaGoal = '대상 경로: apps/pwa/app/approvals/page.tsx · src/nexus/api/approvals.ts\n\n# 승인 탭';
  const plainGoal = '대상 경로: src/roles/role-watch.ts\n\n# 자리';

  test('대상에 apps/pwa/ 가 있으면 PWA 골', () => {
    expect(goalTouchesPwa(pwaGoal)).toBe(true);
    expect(goalTouchesPwa('`apps/pwa/lib/x.ts` 를 고친다')).toBe(true);
    expect(goalTouchesPwa(plainGoal)).toBe(false);
    expect(goalTouchesPwa('myapps/pwa/x')).toBe(false);
  });

  test('자동: PWA 골은 high 32Gi · 그 밖 standard 16Gi', () => {
    expect(podMemoryLimitFor(pwaGoal, {})).toEqual({ limit: '32Gi', tier: 'high', source: 'pwa-auto' });
    expect(podMemoryLimitFor(plainGoal, {})).toEqual({ limit: '16Gi', tier: 'standard', source: 'default' });
  });

  test('골 문면 한 줄 `Pod 메모리: high` 가 자동보다 앞선다', () => {
    expect(podMemoryLimitFor(`${plainGoal}\nPod 메모리: high\n`, {})).toEqual({ limit: '32Gi', tier: 'high', source: 'goal-line' });
    expect(podMemoryLimitFor(`${pwaGoal}\npod-memory: standard\n`, {})).toEqual({ limit: '16Gi', tier: 'standard', source: 'goal-line' });
  });

  test('발사 옵션(ELANOUS_POD_MEMORY_TIER)이 골 문면보다 앞선다 · 잘못된 값은 무시', () => {
    expect(podMemoryLimitFor(`${plainGoal}\nPod 메모리: standard\n`, { ELANOUS_POD_MEMORY_TIER: 'high' })).toEqual({ limit: '32Gi', tier: 'high', source: 'option' });
    expect(podMemoryLimitFor(pwaGoal, { ELANOUS_POD_MEMORY_TIER: 'huge' }).source).toBe('pwa-auto');
  });

  test('값은 환경변수로 덮고, high 는 standard 보다 작아지지 않는다', () => {
    expect(podMemoryLimitFor(pwaGoal, { ELANOUS_POD_MEMORY_HIGH: '48Gi' }).limit).toBe('48Gi');
    expect(podMemoryLimitFor(plainGoal, { ELANOUS_POD_MEMORY: '20Gi' }).limit).toBe('20Gi');
    expect(podMemoryLimitFor(pwaGoal, { ELANOUS_POD_MEMORY: '40Gi' }).limit).toBe('40Gi');
  });

  test('매니페스트 한도에 실린다', () => {
    const job = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60, memoryLimit: podMemoryLimitFor(pwaGoal, {}).limit }) as any;
    const c = job.spec.template.spec.containers.find((x: any) => x.name === 'child');
    expect(c.resources.limits.memory).toBe('32Gi');
  });

  test('harness 디스패치가 --pod-memory 를 오케스트레이터 환경으로 넘긴다', () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const status = dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'short goal', podMemory: 'high' }, { run: (_c, _a, env) => { seen = env; return 0; } });
    expect(status).toBe(0);
    expect(seen?.ELANOUS_POD_MEMORY_TIER).toBe('high');
  });
});

describe('POD7 goal-type automatic selection', () => {
  const document = '# Write a guide\n- GoalType: document\n\n## PROBLEM\nWrite a guide';
  const research = '# Investigate\n- GoalType: research\n\n## PROBLEM\nInvestigate';
  const implement = '# Implement\n- GoalType: implement\n\n## PROBLEM\nImplement';

  test('declared research/document and CLI goal type select lite; explicit tiers and implement keep precedence', () => {
    expect(podMemoryLimitFor(document, {})).toEqual({ limit: '2Gi', tier: 'lite', source: 'goal-type-auto' });
    expect(podMemoryLimitFor(research, {})).toEqual({ limit: '2Gi', tier: 'lite', source: 'goal-type-auto' });
    expect(podMemoryLimitFor('write guide', { ELANOUS_POD_GOAL_TYPE: 'document' })).toEqual({ limit: '2Gi', tier: 'lite', source: 'goal-type-auto' });
    expect(podMemoryLimitFor('shard', {}, document)).toEqual({ limit: '2Gi', tier: 'lite', source: 'goal-type-auto' });
    expect(podMemoryLimitFor(document, { ELANOUS_POD_MEMORY_TIER: 'standard' })).toEqual({ limit: '16Gi', tier: 'standard', source: 'option' });
    expect(podMemoryLimitFor(`${document}\nPod 메모리: high`, {})).toEqual({ limit: '32Gi', tier: 'high', source: 'goal-line' });
    expect(podMemoryLimitFor('apps/pwa/page.tsx', {}, document).tier).toBe('high');
    expect(podMemoryLimitFor(implement, {})).toEqual({ limit: '16Gi', tier: 'standard', source: 'default' });
    expect(podMemoryLimitFor('write guide', { ELANOUS_POD_GOAL_TYPE: 'implement' })).toEqual({ limit: '16Gi', tier: 'standard', source: 'default' });
  });

  test('measured high advice for a document wins over automatic lite, while a document without matching advice stays lite', () => {
    const now = Date.now();
    const rows = [
      { ts_ms: now - 2000, category: 'self-implement.pod', event: 'memory-limit', data: JSON.stringify({ spaceId: 'docs-1', goalType: 'docs', memoryLimit: '16Gi' }) },
      { ts_ms: now - 1000, category: 'self-implement.pod', event: 'job-applied', data: JSON.stringify({ spaceId: 'docs-1', job: 'docs-job' }) },
      { ts_ms: now, category: 'self-implement.pod', event: 'oom-evidence', data: JSON.stringify({ job: 'docs-job', samples: [{ cgroupBytes: 16 * 1024 ** 3 }] }) },
    ];
    const advice = advisePodMemory(measurePodMemoryByGoal(rows, now, 'fixture.db'));
    expect(podMemoryLimitFor(document, {}, undefined, advice)).toEqual({ limit: '32Gi', tier: 'high', source: 'advise' });
    expect(podMemoryLimitFor(document, {})).toEqual({ limit: '2Gi', tier: 'lite', source: 'goal-type-auto' });
    expect(podMemoryLimitFor(research, {}, undefined, advice)).toEqual({ limit: '2Gi', tier: 'lite', source: 'goal-type-auto' });
    expect(podMemoryLimitFor(document, { ELANOUS_POD_MEMORY_TIER: 'lite' }, undefined, advice)).toEqual({ limit: '2Gi', tier: 'lite', source: 'option' });
  });

  test('dispatch carries the declared document type and selected lite tier', () => {
    let seen: NodeJS.ProcessEnv | undefined;
    expect(dispatchHarnessOnPod({ entrance: 'cli-harness-say', input: 'write guide', goalType: 'document' }, { run: (_c, _a, env) => { seen = env; return 0; } })).toBe(0);
    expect(seen?.ELANOUS_POD_GOAL_TYPE).toBe('document');
    expect(seen?.ELANOUS_POD_MEMORY_TIER).toBe('lite');
    expect(seen?.ELANOUS_POD_MEMORY_REASON).toBe('goal-type-default');
  });

  test('document Pod launches at 2Gi, completes and records the tier and reason; implement remains 16Gi', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-goal-type-'));
    const jobs: any[] = [];
    const events: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-goal-type-memory-test', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'memory-limit') events.push(record.data as Record<string, unknown>);
    } });
    const kubectl = (args: readonly string[], input?: string) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.includes('apply') && input) { const manifest = JSON.parse(input); if (manifest.kind === 'Job') jobs.push(manifest); }
      if (args.includes('get') && args.includes('job') && args.join(' ').includes('status.conditions[*].type')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: '{"stage":"pr-opened","ok":true}\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const spawn = podSelfImplementSpawn({ kubectl, env: { ELANOUS_STATE_DIR: root }, memoryAdvice: () => { throw new Error('no advice'); }, credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }) });
      expect((await spawn({ spaceId: 'doc-lite', feature: document }).done).exitCode).toBe(0);
      expect((await spawn({ spaceId: 'impl-default', feature: implement }).done).exitCode).toBe(0);
      expect(jobs.map((job) => job.spec.template.spec.containers[0].resources.limits.memory)).toEqual(['2Gi', '16Gi']);
      expect(jobs[0].spec.template.spec.containers[0].resources.requests.memory).toBe('2Gi');
      expect(events.map(({ tier, source, reason }) => ({ tier, source, reason }))).toEqual([
        { tier: 'lite', source: 'goal-type-auto', reason: 'declared goal type document' },
        { tier: 'standard', source: 'default', reason: 'default' },
      ]);
      const { readdirSync, readFileSync } = await import('node:fs');
      const ledgers = readdirSync(join(root, 'run-ledger')).map((file) => readFileSync(join(root, 'run-ledger', file), 'utf8')).join('\n');
      expect(ledgers).toContain('"event":"pod-memory-selected"');
      expect(ledgers).toContain('"reason":"declared goal type document"');
      expect(ledgers).toContain('"tier":"standard"');
    } finally { off(); rmSync(root, { recursive: true, force: true }); }
  });
});

describe('POD7 measured per-kind requests', () => {
  const now = Date.now();
  const rows = ([['code', 5], ['test', 2], ['docs', 0.5], ['pwa-build', 10]] as const).flatMap(([kind, gib]) => [1, 2, 3].flatMap((n) => [
    { ts_ms: now - n * 1000, category: 'self-implement.pod', event: 'memory-limit', data: JSON.stringify({ spaceId: `${kind}-${n}`, goalType: kind, memoryLimit: '16Gi' }) },
    { ts_ms: now - n * 1000 + 1, category: 'self-implement.pod', event: 'job-applied', data: JSON.stringify({ spaceId: `${kind}-${n}`, job: `job-${kind}-${n}` }) },
    { ts_ms: now - n * 1000 + 2, category: 'self-implement.pod', event: 'memory-last', data: JSON.stringify({ job: `job-${kind}-${n}`, sample: { cgroupBytes: Math.round((gib + n - 1) * 1024 ** 3) } }) },
  ]));
  const advice = advisePodMemory(measurePodMemoryByGoal(rows, now, 'fixture.db'));

  test('measured p95 reserves per kind; absent, sparse, or unknown kinds retain the 6Gi default and report the fallback', () => {
    const defaults: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-request-default-test', emit: (record) => {
      if (record.category === 'pod.memory' && record.event === 'request-default') {
        const { kind, reason } = record.data as Record<string, unknown>;
        defaults.push({ kind, reason });
      }
    } });
    try {
      expect(podMemoryRequestFor('code', advice)).toBe('9Gi');
      expect(podMemoryRequestFor('test', advice)).toBe('5Gi');
      expect(podMemoryRequestFor('docs', advice)).toBe('3Gi');
      expect(podMemoryRequestFor('pwa-build', advice)).toBe('15Gi');
      expect(podMemoryRequestFor('code')).toBe('6Gi');
      const sparse = advisePodMemory(measurePodMemoryByGoal(rows.slice(0, 3), now, 'fixture.db'));
      expect(podMemoryRequestFor('code', sparse)).toBe('6Gi');
      const lowCoverage = advisePodMemory(measurePodMemoryByGoal([
        ...rows,
        ...[4, 5, 6, 7].map((n) => ({ ts_ms: now - n * 1000, category: 'self-implement.pod', event: 'memory-limit', data: JSON.stringify({ spaceId: `code-${n}`, goalType: 'code', memoryLimit: '16Gi' }) })),
      ], now, 'fixture.db'));
      expect(podMemoryRequestFor('code', lowCoverage)).toBe('6Gi');
      const noPeak = { ...advice, byGoalType: advice.byGoalType.map((entry) => entry.goalType === 'code'
        ? { ...entry, evidence: { ...entry.evidence, peakMiB: { ...entry.evidence.peakMiB, p95: null } } } : entry) };
      expect(podMemoryRequestFor('code', noPeak)).toBe('6Gi');
      expect(podMemoryRequestFor(null, advice)).toBe('6Gi');
      expect(defaults).toEqual([
        { kind: 'code', reason: 'no-advice' },
        { kind: 'code', reason: 'insufficient-sample' },
        { kind: 'code', reason: 'insufficient-sample' },
        { kind: 'code', reason: 'no-peak' },
        { kind: null, reason: 'unknown-kind' },
      ]);
    } finally { off(); }
  });

  test('unavailable advice logs the reason and retains the 6Gi default request and 16Gi limit in the Job', async () => {
    const jobs: any[] = [];
    const defaults: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-request-unavailable-test', emit: (record) => {
      if (record.category === 'pod.memory' && record.event === 'request-default') {
        const { kind, reason } = record.data as Record<string, unknown>;
        defaults.push({ kind, reason });
      }
    } });
    const kubectl = (args: readonly string[], input?: string) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.includes('apply') && input) { const manifest = JSON.parse(input); if (manifest.kind === 'Job') jobs.push(manifest); }
      if (args.includes('get') && args.includes('job') && args.join(' ').includes('status.conditions[*].type')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: '{"stage":"pr-opened","ok":true}\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const spawn = podSelfImplementSpawn({ kubectl, memoryAdvice: () => { throw new Error('unavailable'); }, credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }) });
      expect((await spawn({ spaceId: 'request-no-advice', feature: '코드 구현' }).done).exitCode).toBe(0);
      expect(jobs[0].spec.template.spec.containers[0].resources).toEqual({
        requests: { cpu: '1', memory: '6Gi' }, limits: { cpu: '4', memory: '16Gi' },
      });
      expect(defaults).toEqual([{ kind: 'code', reason: 'no-advice' }]);
    } finally { off(); }
  });

  test('non-document lite retains a measured request below 2Gi, and explicit lite remains distinct from the document default', async () => {
    const jobs: any[] = [];
    const smallAdvice = { ...advice, byGoalType: advice.byGoalType.map((entry) => entry.goalType === 'code' || entry.goalType === 'docs'
      ? { ...entry, evidence: { ...entry.evidence, peakMiB: { ...entry.evidence.peakMiB, p95: 512 } } } : entry) };
    const kubectl = (args: readonly string[], input?: string) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.includes('apply') && input) { const manifest = JSON.parse(input); if (manifest.kind === 'Job') jobs.push(manifest); }
      if (args.includes('get') && args.includes('job') && args.join(' ').includes('status.conditions[*].type')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: '{"stage":"pr-opened","ok":true}\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const spawn = podSelfImplementSpawn({ kubectl, env: {}, memoryAdvice: () => smallAdvice,
      credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }) });
    expect(podMemoryRequestFor('docs', smallAdvice)).toBe('1Gi');
    expect((await spawn({ spaceId: 'explicit-code-lite', feature: '코드 구현\nPod 메모리: lite' }).done).exitCode).toBe(0);
    expect((await spawn({ spaceId: 'auto-document-lite', feature: '# Guide\n- GoalType: document' }).done).exitCode).toBe(0);
    expect((await spawn({ spaceId: 'explicit-document-lite', feature: '# Guide\n- GoalType: document\nPod 메모리: lite' }).done).exitCode).toBe(0);
    expect(jobs.map((job) => job.spec.template.spec.containers[0].resources)).toEqual([
      { requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '4', memory: '2Gi' } },
      { requests: { cpu: '1', memory: '2Gi' }, limits: { cpu: '4', memory: '2Gi' } },
      { requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '4', memory: '2Gi' } },
    ]);
  });

  test('spawn writes only the Job request; standard limit stays 16Gi and PWA shard limit stays high 32Gi', async () => {
    const jobs: any[] = [];
    const kinds: unknown[] = [];
    const off = debug.registerSink({ name: 'pod-request-kind-test', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'memory-limit') kinds.push((record.data as Record<string, unknown>).goalType);
    } });
    const kubectl = (args: readonly string[], input?: string) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.includes('apply') && input) { const manifest = JSON.parse(input); if (manifest.kind === 'Job') jobs.push(manifest); }
      if (args.includes('get') && args.includes('job') && args.join(' ').includes('status.conditions[*].type')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: '{"stage":"pr-opened","ok":true}\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const spawn = podSelfImplementSpawn({ kubectl, memoryAdvice: () => advice, credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }) });
    try {
      expect((await spawn({ spaceId: 'request-code', feature: '코드 구현' }).done).exitCode).toBe(0);
      expect((await spawn({ spaceId: 'request-pwa', feature: '대상 경로: apps/pwa/app/page.tsx · 코드 구현' }).done).exitCode).toBe(0);
      expect((await spawn({ spaceId: 'request-pwa-build', feature: 'apps/pwa/ PWA build' }).done).exitCode).toBe(0);
      expect((await spawn({ spaceId: 'request-test', feature: '전체 시험을 돌린다' }).done).exitCode).toBe(0);
      expect((await spawn({ spaceId: 'request-unknown', feature: '작업 진행' }).done).exitCode).toBe(0);
      expect((await spawn({ spaceId: 'request-lite', feature: '코드 구현\nPod 메모리: lite' }).done).exitCode).toBe(0);
      expect(jobs.map((job) => { const { requests, limits } = job.spec.template.spec.containers[0].resources; return { requests, limits }; })).toEqual([
        { requests: { cpu: '1', memory: '9Gi' }, limits: { cpu: '4', memory: '16Gi' } },
        { requests: { cpu: '1', memory: '9Gi' }, limits: { cpu: '4', memory: '32Gi' } },
        { requests: { cpu: '1', memory: '15Gi' }, limits: { cpu: '4', memory: '32Gi' } },
        { requests: { cpu: '1', memory: '5Gi' }, limits: { cpu: '4', memory: '16Gi' } },
        { requests: { cpu: '1', memory: '6Gi' }, limits: { cpu: '4', memory: '16Gi' } },
        { requests: { cpu: '1', memory: '2Gi' }, limits: { cpu: '4', memory: '2Gi' } },
      ]);
      expect(kinds).toEqual(['code', 'code', 'pwa-build', 'test', null, 'code']);
    } finally { off(); }
  });
});

describe('POD7 measured advice launch opt-in', () => {
  const now = Date.now();
  const rows = [
    { ts_ms: now - 2000, category: 'self-implement.pod', event: 'memory-limit', data: JSON.stringify({ spaceId: 'test-1', goalType: 'test', memoryLimit: '16Gi' }) },
    { ts_ms: now - 1000, category: 'self-implement.pod', event: 'job-applied', data: JSON.stringify({ spaceId: 'test-1', job: 'test-job' }) },
    { ts_ms: now, category: 'self-implement.pod', event: 'oom-evidence', data: JSON.stringify({ job: 'test-job', samples: [{ cgroupBytes: 15 * 1024 ** 3 }] }) },
  ];
  const advice = advisePodMemory(measurePodMemoryByGoal(rows, now, 'fixture.db'));
  const goal = '전체 시험을 돌린다';

  test('off preserves 16Gi; on selects the measured test high with source=advise', () => {
    expect(podMemoryLimitFor(goal, {})).toEqual({ limit: '16Gi', tier: 'standard', source: 'default' });
    expect(podMemoryLimitFor(goal, {}, undefined, advice)).toEqual({ limit: '32Gi', tier: 'high', source: 'advise' });
  });

  test('broad-test wording wins over incidental code words when advice is enabled', () => {
    expect(podMemoryLimitFor('코드를 수정한 뒤 전체 시험을 돌린다', {}, undefined, advice)).toEqual({ limit: '32Gi', tier: 'high', source: 'advise' });
  });

  test('missing measurement and unrelated goal kinds preserve legacy defaults', () => {
    expect(podMemoryLimitFor('문서를 쓴다', {}, undefined, advice)).toEqual({ limit: '16Gi', tier: 'standard', source: 'default' });
    expect(podMemoryLimitFor('apps/pwa/ 화면을 고친다', {}, undefined, advice)).toEqual({ limit: '32Gi', tier: 'high', source: 'pwa-auto' });
  });

  test('explicit launch option and standalone goal line beat advice, including lite and parent line', () => {
    expect(podMemoryLimitFor(`${goal}\nPod 메모리: high`, { ELANOUS_POD_MEMORY_TIER: 'standard' }, undefined, advice)).toEqual({ limit: '16Gi', tier: 'standard', source: 'option' });
    expect(podMemoryLimitFor(`${goal}\nPod 메모리: lite`, {}, undefined, advice)).toEqual({ limit: '2Gi', tier: 'lite', source: 'goal-line' });
    expect(podMemoryLimitFor(goal, {}, 'Pod 메모리: standard', advice)).toEqual({ limit: '16Gi', tier: 'standard', source: 'parent-goal-line' });
    // 조각 «자신»의 PWA 경로는 부모에서 물려받은 줄보다 먼저다(self-implement-pod.test «shard-high» 와 같은 규칙) — 조각 자신의 줄만 그것을 이긴다.
    expect(podMemoryLimitFor('apps/pwa/ 화면을 고친다', {}, 'Pod 메모리: standard', advice)).toEqual({ limit: '32Gi', tier: 'high', source: 'pwa-auto' });
    expect(podMemoryLimitFor('apps/pwa/ 화면을 고친다', {}, 'Pod 메모리: standard')).toEqual({ limit: '32Gi', tier: 'high', source: 'pwa-auto' });
    expect(podMemoryLimitFor('apps/pwa/ 화면을 고친다\nPod 메모리: standard', {}, undefined, advice)).toEqual({ limit: '16Gi', tier: 'standard', source: 'goal-line' });
  });

  test('actual spawn reads configuration and measured logs with injected kubectl, then honors explicit choices', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-memory-launch-'));
    const previous = { config: process.env.XDG_CONFIG_HOME, state: process.env.ELANOUS_STATE_DIR };
    const events: Record<string, unknown>[] = [];
    const jobs: Array<Record<string, any>> = [];
    process.env.XDG_CONFIG_HOME = root;
    process.env.ELANOUS_STATE_DIR = join(root, 'state');
    const off = debug.registerSink({ name: 'pod-advice-launch-test', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'memory-limit') events.push(record.data as Record<string, unknown>);
    } });
    const kubectl = (args: readonly string[], input?: string) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.includes('get') && args.includes('job') && args.join(' ').includes('jsonpath={.metadata.uid} ')) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.includes('apply') && input) {
        const manifest = JSON.parse(input);
        if (manifest.kind === 'Job') jobs.push(manifest);
      }
      if (args.includes('get') && args.includes('job') && args.join(' ').includes('status.conditions[*].type')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: '{"stage":"pr-opened","ok":true}\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      mkdirSync(join(root, 'elanous'));
      const store = new LogStore(logsDbPath());
      try {
        store.insertBatch([...rows, ...[1, 2, 3].flatMap((n) => [
          { ts_ms: now - n * 1000, category: 'self-implement.pod', event: 'memory-limit', data: JSON.stringify({ spaceId: `code-db-${n}`, goalType: 'code', memoryLimit: '16Gi' }) },
          { ts_ms: now - n * 1000 + 1, category: 'self-implement.pod', event: 'job-applied', data: JSON.stringify({ spaceId: `code-db-${n}`, job: `code-db-job-${n}` }) },
          { ts_ms: now - n * 1000 + 2, category: 'self-implement.pod', event: 'memory-last', data: JSON.stringify({ job: `code-db-job-${n}`, sample: { cgroupBytes: (4 + n) * 1024 ** 3 } }) },
        ])].map((row) => ({ rec: { ts: new Date(row.ts_ms).toISOString(), category: row.category, event: row.event, data: JSON.parse(row.data) }, surface: 'nexus' })));
      } finally { store.close(); }
      expect(readPodMemoryAdvice().byGoalType.find((entry) => entry.goalType === 'test')).toMatchObject({ recommended: 'high', evidence: { runs: 1, oomKilled: 1 } });
      expect(podMemoryRequestFor('code', readPodMemoryAdvice())).toBe('9Gi');
      const config = join(root, 'elanous', 'config.json');
      const launch = async (spaceId: string, feature: string, env: NodeJS.ProcessEnv = {}) => {
        const spawn = podSelfImplementSpawn({ kubectl, env, credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }) });
        expect((await spawn({ spaceId, feature }).done).exitCode).toBe(0);
      };
      writeFileSync(config, JSON.stringify({ pod: { memory: { adviseDefaults: false } } }));
      resetUserConfig();
      expect(getUserConfig().pod?.memory?.adviseDefaults).toBe(false);
      await launch('launch-off', goal);
      writeFileSync(config, JSON.stringify({ pod: { memory: { adviseDefaults: true } } }));
      resetUserConfig();
      expect(getUserConfig().pod?.memory?.adviseDefaults).toBe(true);
      await launch('launch-on', goal);
      await launch('launch-option', goal, { ELANOUS_POD_MEMORY_TIER: 'standard' });
      await launch('launch-line', `${goal}\nPod 메모리: lite`);
      await launch('launch-code', '코드 구현');
      expect(jobs.map((job) => job.spec.template.spec.containers[0].resources.limits.memory)).toEqual(['16Gi', '32Gi', '16Gi', '2Gi', '16Gi']);
      expect(jobs.map((job) => job.spec.template.spec.containers[0].resources.requests.memory)).toEqual(['6Gi', '6Gi', '6Gi', '2Gi', '9Gi']);
      expect(events.map(({ memoryLimit, source, tier }) => ({ memoryLimit, source, tier }))).toEqual([
        { memoryLimit: '16Gi', source: 'default', tier: 'standard' },
        { memoryLimit: '32Gi', source: 'advise', tier: 'high' },
        { memoryLimit: '16Gi', source: 'option', tier: 'standard' },
        { memoryLimit: '2Gi', source: 'goal-line', tier: 'lite' },
        { memoryLimit: '16Gi', source: 'advise', tier: 'standard' },
      ]);
    } finally {
      off();
      if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous.config;
      if (previous.state === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous.state;
      resetUserConfig();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('POD7 lite tier — explicit only', () => {
  const plain = '대상 경로: docs/x.md\n조사 결과를 문서로 쓴다';
  test('lite only by option or a standalone goal line; a skill mention alone never picks lite', () => {
    expect(podMemoryLimitFor(`${plain}\nPod 메모리: lite\n`, {})).toEqual({ limit: '2Gi', tier: 'lite', source: 'goal-line' });
    expect(podMemoryLimitFor(plain, { ELANOUS_POD_MEMORY_TIER: 'lite' })).toEqual({ limit: '2Gi', tier: 'lite', source: 'option' });
    expect(podMemoryLimitFor(`${plain}\n/omni-crawl 로 조사한다`, {})).toEqual({ limit: '16Gi', tier: 'standard', source: 'default' });
    expect(podMemoryLimitFor(`${plain}\nPod 메모리: lite\n`, { ELANOUS_POD_MEMORY_LITE: '1Gi' }).limit).toBe('1Gi');
  });
  test('an OOM retry target (high) is larger than lite, so POD9 retries a lite OOM', () => {
    const lite = podMemoryLimitFor(`${plain}\nPod 메모리: lite\n`, {}).limit;
    const high = podMemoryLimitFor(plain, { ELANOUS_POD_MEMORY_TIER: 'high' }).limit;
    expect(parseFloat(lite)).toBeLessThan(parseFloat(high));
  });
});
