// ── 결함 주입 심 — «풀 상한 없음» (Pod 풀 스펙에 `:N` 이 빠짐) ────────────────
//
// 🚨 왜 이것이 있나 (SIM-VERIFY-KIT 셋째 심 · 2026-10-12)
//   `--pod-pool pool-x@host` 처럼 `:N` 을 빼면 «상한 없음»이 아니라 기본 상한 2 다. 그 풀은 Pod 두 개가 돌면
//   승인 0 으로 멈추는데, 운영에선 프로브를 띄워 40분을 기다려야 보였다(10-10 · POD-POOL-UNCAPPED-SPEC).
//   이 심은 스펙 문자열과 «멤버마다 지금 도는 Pod 수»만 주고 승인 판정을 바로 낸다.
//
// ⛔ 흉내 내지 않는다: 스펙은 진짜 parsePodPool 로 읽고, 승인은 진짜 recommendConcurrency 가 정한다.
//    클러스터 측정(kubectl)만 «메모리·CPU 넉넉한 노드»로 채운다 — 메모리가 아니라 상한이 판정을 정하게 하려는 것이다.

import { recommendConcurrency, type PodLeaseMember, type PoolLeaseRecommendation } from '../task-orchestrator/surfaces/pod-lease.js';
import { parsePodPool } from '../task-orchestrator/surfaces/pod-pool.js';

const GiB = 1024 ** 3;

export interface PoolCapScenario {
  /** `--pod-pool` 값 그대로(예: `pool-node-b@node-b` · `pool-node-b@node-b:20,pool-node-c@node-c`). */
  readonly spec: string;
  /** 멤버(컨텍스트)마다 지금 Running 인 하니스 Pod 수 — 멤버마다 «반드시» 준다(빠지면 0 으로 꾸미지 않고 던진다). */
  readonly running: Readonly<Record<string, number>>;
  /** Query failures for a context stay unknown and suppress the admission recommendation. */
  readonly queryFailures?: Readonly<Record<string, string>>;
}

export interface PoolCapObservation {
  readonly scenario: PoolCapScenario;
  readonly members: ReadonlyArray<{ context: string; capacity: number; capacityDefaulted: boolean; running?: number; queryError?: string }>;
  readonly recommendation: PoolLeaseRecommendation | null;
}

/** 메모리·CPU 가 넉넉한 노드 한 대 — 승인이 상한(capacity)으로만 갈리게 한다. */
function roomyMember(context: string, capacity: number, capacityDefaulted: boolean, running: number): PodLeaseMember {
  return {
    context, capacity, ...(capacityDefaulted ? { capacityDefaulted: true } : {}),
    running, pending: 0, pendingJobs: [], unleasedRunning: 0,
    memoryLimitBytes: running * 16 * GiB, allocatableMemoryBytes: 1024 * GiB, allocatableCpuMillicores: 256_000,
    availableMemoryByNodeBytes: [1024 * GiB - running * 16 * GiB], reason: null,
  };
}

function runningOf(scenario: PoolCapScenario, context: string): number {
  const n = scenario.running[context];
  if (n === undefined || !Number.isSafeInteger(n) || n < 0) {
    throw new Error(`simPoolCap: 멤버 「${context}」 의 Running 수가 없다 — 모르는 점유를 0 으로 꾸미지 않는다`);
  }
  return n;
}

export function simPoolCap(scenario: PoolCapScenario): PoolCapObservation {
  const parsed = parsePodPool(scenario.spec);
  const members = parsed.map((m) => ({
    context: m.context, capacity: m.capacity, capacityDefaulted: (m as { capacityDefaulted?: boolean }).capacityDefaulted === true,
    ...(scenario.queryFailures?.[m.context]
      ? { queryError: scenario.queryFailures[m.context] }
      : { running: runningOf(scenario, m.context) }),
  }));
  if (members.some((member) => member.queryError)) return { scenario, members, recommendation: null };
  const recommendation = recommendConcurrency(
    { members: members.map((m) => roomyMember(m.context, m.capacity, m.capacityDefaulted, m.running!)) },
    { capacity: members.reduce((sum, m) => sum + m.capacity, 0), accounts: -1, perAccount: -1 },
  );
  return { scenario, members, recommendation };
}

/** 기본 훑기 — 상한 뺀 스펙이 Pod 둘에서 막히는 순간과, 상한을 적은 스펙의 대조. */
export function poolCapSweep(): PoolCapObservation[] {
  return [
    simPoolCap({ spec: 'pool-node-b@node-b', running: { 'pool-node-b': 0 } }),
    simPoolCap({ spec: 'pool-node-b@node-b', running: { 'pool-node-b': 1 } }),
    simPoolCap({ spec: 'pool-node-b@node-b', running: { 'pool-node-b': 2 } }),
    simPoolCap({ spec: 'pool-node-b@node-b:20', running: { 'pool-node-b': 2 } }),
    simPoolCap({ spec: 'pool-node-b@node-b:20', running: { 'pool-node-b': 20 } }),
    simPoolCap({ spec: 'pool-node-b@node-b:20,pool-node-c@node-c', running: { 'pool-node-b': 20, 'pool-node-c': 2 } }),
    simPoolCap({ spec: 'pool-node-b@node-b:20,pool-node-c@node-c', running: { 'pool-node-b': 20, 'pool-node-c': 0 } }),
  ];
}

export function renderPoolCap(rows: readonly PoolCapObservation[]): string[] {
  return [
    'pool-cap · `:N` 없는 멤버 = 기본 상한 2(capacityDefaulted)',
    ...rows.map((r) => {
      const occ = r.members.map((m) => `${m.context} ${m.running === undefined ? 'unknown' : m.running}/${m.capacity}${m.capacityDefaulted ? '(기본)' : ''}${m.queryError ? ` query-error=${m.queryError}` : ''}`).join(' · ');
      return `  ${r.scenario.spec.padEnd(36)} ${occ.padEnd(40)} → 승인 ${String(r.recommendation?.recommended ?? 'unknown')} · limitedBy=${String(r.recommendation?.limitedBy ?? 'unknown')}`;
    }),
  ];
}
