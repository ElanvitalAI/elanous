import { describe, expect, test } from 'bun:test';
import { goalTouchesPwa, podMemoryLimitFor, podJobManifest } from './self-implement-pod.js';
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
