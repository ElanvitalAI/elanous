import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UserConfig } from '../../user-config.js';
import type { PoolDnsProbe } from './pod-lease.js';
import { podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';
import { decideMinihDrain, minihLocationFrom, minihStandardCapacity, parsePodPool, PodPoolScheduler, type PoolKubectl } from './pod-pool.js';

const NODE = {
  metadata: { name: 'node-c-node' },
  spec: {},
  status: { allocatable: { memory: '64Gi', cpu: '16' }, conditions: [{ type: 'Ready', status: 'True' }] },
};

interface StagedPod { readonly name: string; readonly phase: 'Running' | 'Pending' }

/**
 * 가짜 kubectl 점유 무대 — 답하는 것은 «이 클러스터에 지금 있는 하니스 Pod 목록» 뿐이고, 진짜 측정
 * (tryAcquire → measureMemberOccupancy → measurePoolLease)이 이 답을 읽는다. 드레인은 이 목록을 줄여 시뮬레이션한다.
 */
function fakeKubectlStage() {
  let pods: StagedPod[] = [];
  const calls: string[] = [];
  const kubectl: PoolKubectl = (args) => {
    const line = args.join(' ');
    calls.push(line);
    if (line.includes('get nodes')) return { status: 0, stdout: JSON.stringify({ items: [NODE] }), stderr: '' };
    if (line.includes('get jobs')) {
      const items = pods.map((p) => ({ metadata: { name: p.name, namespace: 'elanous-test', labels: { 'elanous.substrate': 'pod' } } }));
      return { status: 0, stdout: JSON.stringify({ items }), stderr: '' };
    }
    if (line.includes('get pods')) {
      const items = pods.map((p) => ({
        metadata: { name: p.name, namespace: 'elanous-test', labels: { 'elanous.substrate': 'pod', 'elanous.job': p.name } },
        spec: {
          ...(p.phase === 'Running' ? { nodeName: 'node-c-node' } : {}),
          containers: [{ resources: { limits: { memory: '16Gi', cpu: '4' }, requests: { memory: '8Gi', cpu: '1' } } }],
        },
        status: { phase: p.phase },
      }));
      return { status: 0, stdout: JSON.stringify({ items }), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `무대가 모르는 명령: ${line}` };
  };
  return {
    kubectl,
    calls,
    /** 무대의 클러스터 상태를 바꾼다 — Pod 가 끝나(드레인) 점유가 빠지는 것을 이렇게 시뮬레이션한다. */
    set(next: StagedPod[]): void { pods = next; },
    get pods(): StagedPod[] { return pods; },
    get deletes(): string[] { return calls.filter((c) => c.includes('delete') || c.includes('evict') || c.includes('drain')); },
  };
}

/** 클러스터 DNS 탐침은 범위 밖 — 측정이 그 자리에서 멈추지 않게 «준비됨»을 준다. */
const readyDns = (): PoolDnsProbe => 'ready';

function minihPool(stage: ReturnType<typeof fakeKubectlStage>, spec = 'pool-node-c@node-c:6'): PodPoolScheduler {
  return new PodPoolScheduler(parsePodPool(spec), { kubectl: stage.kubectl, dns: readyDns });
}

describe('node-c capacity and drain decision', () => {
  test('a mixed pool counts only node-c occupancy and can overflow to another member', async () => {
    const members = parsePodPool('pool-node-b@node-b:2,pool-node-c@node-c:6');
    let msb1Occupied = 2;
    let minihOccupied = 0;
    const scheduler = new PodPoolScheduler(members, {
      occupancy: () => ({
        'pool-node-b': { occupied: msb1Occupied },
        'pool-node-c': { occupied: minihOccupied },
      }),
    });
    const home = { kind: 'standard' as const, minihLocation: 'home' as const };
    expect((await scheduler.tryAcquire(undefined, undefined, home))?.context).toBe('pool-node-c');
    scheduler.release(members[1]!);
    msb1Occupied = 0;
    minihOccupied = 1;
    expect((await scheduler.tryAcquire(undefined, undefined, home))?.context).toBe('pool-node-b');
  });

  test('home has one standard slot; external has two', () => {
    expect(minihStandardCapacity('home')).toBe(1);
    expect(minihStandardCapacity('external')).toBe(2);
    expect(decideMinihDrain('home', 0)).toEqual({ capacity: 1, runningPods: 0, drainNewAdmissions: false, availableSlots: 1 });
    expect(decideMinihDrain('external', 0)).toEqual({ capacity: 2, runningPods: 0, drainNewAdmissions: false, availableSlots: 2 });
  });

  test('returning home drains excess new admissions without evicting running Pods', () => {
    expect(decideMinihDrain('home', 2)).toEqual({ capacity: 1, runningPods: 2, drainNewAdmissions: true, availableSlots: 0 });
    expect(decideMinihDrain('home', 1)).toEqual({ capacity: 1, runningPods: 1, drainNewAdmissions: false, availableSlots: 0 });
    expect(decideMinihDrain('external', 2)).toEqual({ capacity: 2, runningPods: 2, drainNewAdmissions: false, availableSlots: 0 });
    expect(decideMinihDrain('home', 0, 2)).toEqual({ capacity: 1, runningPods: 0, drainNewAdmissions: true, availableSlots: 0 });
    expect(() => decideMinihDrain('home', -1)).toThrow(RangeError);
  });

  test('without an explicit location the configured capacity is unchanged (no drain policy applied)', async () => {
    let occupied = 1;
    const pool = new PodPoolScheduler(parsePodPool('pool-node-c@node-c:2'), {
      occupancy: () => ({ 'pool-node-c': { occupied } }),
    });
    expect(decideMinihDrain('home', occupied).availableSlots).toBe(0);
    const acquired = await pool.tryAcquire();
    expect(acquired?.context).toBe('pool-node-c');
    expect(pool.snapshot()).toEqual({ 'pool-node-c': 1 });
    occupied = 2;
    expect(decideMinihDrain('home', occupied).drainNewAdmissions).toBe(true);
    expect(pool.snapshot()).toEqual({ 'pool-node-c': 1 });
    pool.release(acquired!);
    expect(pool.snapshot()).toEqual({ 'pool-node-c': 0 });
  });
});

describe('MINIH-MODE — an explicit minihLocation gates new standard-Job admission on the real tryAcquire path', () => {
  const home = { kind: 'standard', minihLocation: 'home' } as const;
  const external = { kind: 'standard', minihLocation: 'external' } as const;

  test('home: one standard slot — the second new Job is held and claims no slot', async () => {
    const stage = fakeKubectlStage();
    const scheduler = minihPool(stage);
    expect((await scheduler.tryAcquire(undefined, undefined, home))?.context).toBe('pool-node-c');
    const reasons: string[] = [];
    expect(await scheduler.tryAcquire(undefined, (reason) => reasons.push(reason), home)).toBeNull();
    // 점유는 가짜 kubectl 의 Pod 목록을 지나는 실제 측정이다(소스 문자열 대조가 아니다).
    expect(stage.calls.some((line) => line.includes('get pods'))).toBe(true);
    expect(reasons.at(-1)).toContain('home 표준 상한 1');
    expect(reasons.at(-1)).toContain('점유 1');
    expect(scheduler.snapshot()).toEqual({ 'pool-node-c': 1 });   // 보류된 입장은 슬롯을 잡지 않는다
  });

  test('home: measured excess (Running ⊕ Pending) holds new admission until it drains — existing Pods are untouched', async () => {
    const stage = fakeKubectlStage();
    stage.set([{ name: 'goal-a', phase: 'Running' }, { name: 'goal-b', phase: 'Pending' }]);
    const scheduler = minihPool(stage);
    const reasons: string[] = [];
    expect(await scheduler.tryAcquire(undefined, (reason) => reasons.push(reason), home)).toBeNull();
    expect(reasons.at(-1)).toContain('초과분이 빠질 때까지');
    // 기존 Pod 보존 — 지우기·축출 없음, 무대의 클러스터 상태 그대로, 슬롯도 잡지 않는다.
    expect(stage.deletes).toEqual([]);
    expect(stage.pods).toEqual([{ name: 'goal-a', phase: 'Running' }, { name: 'goal-b', phase: 'Pending' }]);
    expect(scheduler.snapshot()).toEqual({ 'pool-node-c': 0 });
    // 하나가 끝나 점유 1 이 되어도 상한(1)은 찬 상태 — 새 입장 없음.
    stage.set([{ name: 'goal-a', phase: 'Running' }]);
    expect(await scheduler.tryAcquire(undefined, (reason) => reasons.push(reason), home)).toBeNull();
    expect(reasons.at(-1)).toContain('상한이 찼다');
    // 초과분이 다 빠지면 새 입장이 열린다.
    stage.set([]);
    expect((await scheduler.tryAcquire(undefined, undefined, home))?.context).toBe('pool-node-c');
  });

  test('external: two standard slots — three measured Pods hold admission, one free slot reopens it', async () => {
    const stage = fakeKubectlStage();
    stage.set([{ name: 'goal-a', phase: 'Running' }, { name: 'goal-b', phase: 'Running' }, { name: 'goal-c', phase: 'Pending' }]);
    const scheduler = minihPool(stage);
    const reasons: string[] = [];
    expect(await scheduler.tryAcquire(undefined, (reason) => reasons.push(reason), external)).toBeNull();
    expect(reasons.at(-1)).toContain('external 표준 상한 2');
    expect(reasons.at(-1)).toContain('점유 3');
    stage.set([{ name: 'goal-a', phase: 'Running' }, { name: 'goal-b', phase: 'Running' }]);
    expect(await scheduler.tryAcquire(undefined, (reason) => reasons.push(reason), external)).toBeNull();
    expect(reasons.at(-1)).toContain('상한이 찼다');
    stage.set([{ name: 'goal-a', phase: 'Running' }]);
    expect((await scheduler.tryAcquire(undefined, undefined, external))?.context).toBe('pool-node-c');
    expect(scheduler.snapshot()).toEqual({ 'pool-node-c': 1 });
  });

  test('a lite Job is not the standard admission this policy gates', async () => {
    const stage = fakeKubectlStage();
    stage.set([{ name: 'goal-a', phase: 'Running' }, { name: 'goal-b', phase: 'Running' }]);
    const scheduler = minihPool(stage);
    expect((await scheduler.tryAcquire(undefined, undefined, { kind: 'lite', minihLocation: 'home' }))?.context).toBe('pool-node-c');
  });

  test('no explicit location keeps the configured capacity — 2 measured ⊕ node-c cap 1 would hold, the configured 6 does not', async () => {
    const stage = fakeKubectlStage();
    stage.set([{ name: 'goal-a', phase: 'Running' }, { name: 'goal-b', phase: 'Running' }]);
    expect(decideMinihDrain('home', 2).drainNewAdmissions).toBe(true);
    const scheduler = minihPool(stage);
    const got: Array<string | null> = [];
    for (let i = 0; i < 5; i++) got.push((await scheduler.tryAcquire())?.context ?? null);
    expect(got).toEqual(['pool-node-c', 'pool-node-c', 'pool-node-c', 'pool-node-c', null]);   // 6 상한 − 점유 2
  });
});

describe('MINIH-MODE declaration', () => {
  test('home / external declare the location; absent, blank or unknown keeps the configured capacity', () => {
    expect(minihLocationFrom('home')).toBe('home');
    expect(minihLocationFrom(' external ')).toBe('external');
    expect(minihLocationFrom('HOME')).toBe('home');
    expect(minihLocationFrom(undefined)).toBeNull();
    expect(minihLocationFrom(null)).toBeNull();
    expect(minihLocationFrom('')).toBeNull();
    expect(minihLocationFrom('orbstack')).toBeNull();
  });
});

describe('MINIH-MODE on the production launch path (podSelfImplementSpawn → acquireSlot → tryAcquire)', () => {
  let launchSeq = 0;

  /**
   * 무대: 한 가짜 kubectl 이 «점유 측정»(tryAcquire 의 measureMemberOccupancy, `--request-timeout=10s` 로 식별)과
   * «Job 발사»(current-context · job conditions · logs) 둘 다에 답한다. 측정은 처음 한 번만 초과 상태(2 Running)를
   * 답하고 그 뒤 드레인된 상태(0)로 바뀐다 — Pod 가 끝나 초과분이 빠지는 것을 이렇게 시뮬레이션한다.
   */
  function launchStage() {
    const stage = fakeKubectlStage();
    stage.set([{ name: 'goal-a', phase: 'Running' }, { name: 'goal-b', phase: 'Running' }]);
    const calls: string[] = [];
    let podReads = 0;
    const kubectl: Kubectl = (args, input) => {
      const line = args.join(' ');
      calls.push(line);
      if (line.includes('--request-timeout=10s')) {
        const answer = stage.kubectl(args, input);
        if (line.includes('--all-namespaces') && podReads++ > 0) stage.set([]);   // 답한 «뒤» 드레인
        return answer;
      }
      if (line.includes('current-context')) return { status: 0, stdout: 'pool-node-c\n', stderr: '' };
      if (line.includes('get') && line.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (line.includes('logs')) return { status: 0, stdout: '{"ok":true,"stage":"complete"}\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    return {
      kubectl,
      scheduler: new PodPoolScheduler(parsePodPool('pool-node-c@node-c:6'), { kubectl: kubectl as PoolKubectl, dns: readyDns }),
      podReads: () => podReads,
      /** Pod 를 지우거나 축출한 명령 — 발사 자신의 Secret 정리는 여기 들어오지 않는다. */
      deletes: () => calls.filter((line) => /delete\s+pods?\b/u.test(line) || line.includes('evict')),
    };
  }

  async function launch(minihLocation: string | undefined) {
    const root = mkdtempSync(join(tmpdir(), 'node-c-mode-launch-'));
    const stage = launchStage();
    // 발사 함수의 풀 사용면(구조적 계약) — tryAcquire 는 진짜 PodPoolScheduler 로 넘어간다.
    const pool = {
      tryAcquire: (skip?: ReadonlySet<string>, onEmpty?: (reason: string) => void, mode?: unknown) =>
        stage.scheduler.tryAcquire(skip, onEmpty, mode as never),
      release: (member: never) => stage.scheduler.release(member),
      snapshot: () => stage.scheduler.snapshot(),
    };
    const run = podSelfImplementSpawn({
      kubectl: stage.kubectl,
      pool: pool as never,
      sleep: async () => {},
      credentials: () => ({ elanousAuth: '{"m":1}', codexAuth: '{"c":1}', ghToken: 'gho_x' }),
      image: 'elanous-harness:local',
      imageCommit: null,
      budgetSnapshot: () => undefined,
      fallbackConfig: () => ({ llm: {} }) as UserConfig,
      openGatewayConfig: () => ({ llm: {} }) as UserConfig,
      lookupOpenPrByBranch: () => ({ status: 'not-found', reason: 'test-fixture' }),
      env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: 'node-c-mode-' + launchSeq++, ...(minihLocation ? { ELANOUS_MINIH_LOCATION: minihLocation } : {}) },
    });
    try {
      const done = await run({ feature: 'node-c-mode', spaceId: 'node-c-mode-launch-fixture' }).done;
      return { done, stage };
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  test('a declared home location holds the launch while node-c runs two standard Jobs, then admits it after the drain', async () => {
    const { done, stage } = await launch('home');
    expect(done.exitCode).toBe(0);
    // 보류가 실제로 일어났다: 초과 점유를 답한 첫 측정 뒤 다른 측정(드레인)이 있어야 입장했다.
    expect(stage.podReads()).toBeGreaterThanOrEqual(2);
    // 기존 Pod 는 건드리지 않는다 — 지우기·축출·드레인 명령 0건.
    expect(stage.deletes()).toEqual([]);
  });

  test('without the declaration the same launch admits on the first measurement (configured capacity preserved)', async () => {
    const { done, stage } = await launch(undefined);
    expect(done.exitCode).toBe(0);
    expect(stage.podReads()).toBe(1);
  });
});
