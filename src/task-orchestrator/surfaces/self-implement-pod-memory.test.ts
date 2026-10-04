import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogStore, logsDbPath } from '../../mss/logging/log-store.js';
import { getUserConfig, resetUserConfig } from '../../user-config.js';
import { goalTouchesPwa, podMemoryLimitFor, podJobManifest, podSelfImplementSpawn } from './self-implement-pod.js';
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
        store.insertBatch(rows.map((row) => ({ rec: { ts: new Date(row.ts_ms).toISOString(), category: row.category, event: row.event, data: JSON.parse(row.data) }, surface: 'nexus' })));
      } finally { store.close(); }
      expect(readPodMemoryAdvice().byGoalType.find((entry) => entry.goalType === 'test')).toMatchObject({ recommended: 'high', evidence: { runs: 1, oomKilled: 1 } });
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
      expect(jobs.map((job) => job.spec.template.spec.containers[0].resources.limits.memory)).toEqual(['16Gi', '32Gi', '16Gi', '2Gi']);
      expect(events.map(({ memoryLimit, source, tier }) => ({ memoryLimit, source, tier }))).toEqual([
        { memoryLimit: '16Gi', source: 'default', tier: 'standard' },
        { memoryLimit: '32Gi', source: 'advise', tier: 'high' },
        { memoryLimit: '16Gi', source: 'option', tier: 'standard' },
        { memoryLimit: '2Gi', source: 'goal-line', tier: 'lite' },
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
