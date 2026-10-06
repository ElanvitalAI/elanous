/**
 * ☸️ Pod 풀 — 여러 k8s 클러스터(k3d)를 «우선순위 ⊕ 노드별 상한»으로 묶는다 (대표 2026-09-25).
 *
 * 스펙: `ELANOUS_POD_POOL` 또는 `--pod-pool` = `컨텍스트[@ssh호스트][:상한][#레지스트리주소]` 을 쉼표로, «앞이 우선».
 *   예) `pool-node-b@node-b:8#k3d-elanous-registry:5051,pool-node-c@node-c:2#k3d-elanous-registry:5052`
 *   ⭐ 운영 권장(대표 2026-09-25): M3 Ultra(node-b) «전용» — Pod 한 개가 6Gi 를 넘겨(OOM) 한도를 12Gi 로 올렸고, node-c(OrbStack VM 16GB)는 그 한 개도 빠듯해 기본 풀에서 뺀다(필요할 때만 명시) ·
 *      이 맥(mbp)은 브라우저·편집 프로그램으로 메모리가 모자라기 쉬워 «기본 풀에서 뺀다»(필요할 때만 `k3d-elanous-h1:1` 을 명시).
 *   - 컨텍스트  kubectl 컨텍스트 이름(이 맥의 kubeconfig)
 *   - @ssh호스트 원격 클러스터면 그 기계 — 이미지 판 대조·반입(`docker load` ⊕ `k3d image import`)에 쓴다
 *   - 상한      이 노드에 동시에 둘 Job 수(기본 2)
 * Job 마다 «빈 자리 비율»이 가장 큰 노드를 고른다(동률은 앞 순위 · 측정 실패 노드는 측정된 노드가 다 찼을 때만). 다 차면 자리가 날 때까지 기다린다.
 * 노드 선택의 진행 중 수는 로컬 프로세스 기준이다. 발사 허가는 별도의 lease 측정으로
 * 다른 호스트의 Running/Pending 및 메모리 예약까지 고려한다.
 * 풀을 안 주면 종전처럼 «현재 컨텍스트» 하나다(동작 불변).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { debug } from '../../debug/log.js';
import { PodLeaseAdmission, type PodLeasePredecessor, type PodLeaseRelease } from '../../pod-lease/admission.js';
import { predecessorState, type PredecessorState } from '../../pod-lease/dependency-state.js';
import { HostPoolLease, leaseHasPendingPod } from '../../pod-lease/host-lease.js';
import { measurePoolLease, recommendConcurrency, type PodLeaseMember, type PoolDnsProbe, type PoolLeaseRecommendation } from './pod-lease.js';

export interface PodPoolMember {
  readonly context: string;
  /** 원격 클러스터가 도는 기계(ssh 호스트). 없으면 이 기계의 docker 에 있다. */
  readonly sshHost?: string;
  readonly capacity: number;
  /** k3d 클러스터 이름(이미지 반입용). 기본: 컨텍스트가 `k3d-<이름>` 이면 그 이름, 원격이면 `elanous-pool`. */
  readonly k3dCluster: string;
  /** 노드 로컬 레지스트리의 이미지(커밋 태그) — 있으면 Pod 가 이것을 pull 한다(델타 · 대표 2026-09-26). 없으면 반입된 로컬 이미지. */
  readonly imageRef?: string;
  /** 클러스터 안 레지스트리 주소(host:port). 호스트 push/조회는 같은 포트의 localhost. */
  readonly registry?: string;
}

/** 노드 로컬 레지스트리(`scripts/fleet/node-setup.sh` 5b) — 클러스터 안에서 부르는 이름. */
export const NODE_REGISTRY = `k3d-elanous-registry:${process.env.ELANOUS_FLEET_REGISTRY_PORT ?? '5050'}`;

function memberRegistry(member: PodPoolMember): string {
  return member.registry ?? NODE_REGISTRY;
}

/** 노드 쪽 빌드가 실패했을 때, 같은 판을 굽는 다른 발사의 레지스트리 태그를 기다리는 한도. */
const CONCURRENT_BUILD_WAIT_MS = 5 * 60_000;
const CONCURRENT_BUILD_POLL_MS = 15_000;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * 노드 쪽 빌드가 부딪혀 실패한 뒤, 같은 판을 굽는 다른 발사가 레지스트리에 이 커밋 태그를 올리는지 본다.
 * 생기면 그 imageRef. 한도까지 없으면 null. 간격은 시험이 짧게 주입한다.
 */
async function waitForConcurrentBuild(member: PodPoolMember, commit: string | null, opts: { intervalMs?: number; maxMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; run?: RemoteRun; image?: string } = {}): Promise<{ imageRef: string | null; waitedMs: number }> {
  const intervalMs = opts.intervalMs ?? CONCURRENT_BUILD_POLL_MS;
  const maxMs = opts.maxMs ?? CONCURRENT_BUILD_WAIT_MS;
  if (maxMs <= 0) return { imageRef: registryImageRef(member, commit, opts.run, opts.image), waitedMs: 0 };
  const now = opts.now ?? Date.now;
  const pause = opts.sleep ?? sleep;
  const started = now();
  for (;;) {
    const imageRef = registryImageRef(member, commit, opts.run, opts.image);
    const waitedMs = now() - started;
    if (imageRef || waitedMs >= maxMs) return { imageRef, waitedMs };
    const remaining = maxMs - waitedMs;
    await pause(Math.min(intervalMs, remaining));
  }
}

/** 이 기계 이미지의 커밋 라벨(`elanous.commit`). 못 읽으면 null — 목표와 같다고 여기지 않는다. */
function localImageCommit(image: string, inspect: LocalImageInspect = defaultLocalImageInspect): string | null {
  const r = inspect(image);
  const v = r.status === 0 ? r.stdout.trim() : '';
  return v && v !== '<no value>' ? v : null;
}

function defaultLocalImageInspect(image: string): { status: number | null; stdout: string } {
  const r = spawnSync('docker', ['image', 'inspect', image, '--format', '{{index .Config.Labels "elanous.commit"}}'], { encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stdout: r.stdout ?? '' };
}

/** 이 커밋의 이미지가 노드 레지스트리에 있나 — 있으면 클러스터 안 이미지 주소. */
export function registryImageRef(member: PodPoolMember, commit: string | null, run: RemoteRun = defaultRemoteRun, image = 'elanous-harness:local'): string | null {
  if (!member.sshHost || !commit) return null;
  const imageName = image === 'elanous-harness-lite:local' ? 'elanous-harness-lite' : 'elanous-harness';
  const tag = commit.slice(0, 12);
  const registry = memberRegistry(member);
  const port = registry.slice(registry.lastIndexOf(':') + 1);
  const r = run(member.sshHost, `curl -fsS --max-time 5 http://localhost:${port}/v2/${imageName}/tags/list 2>/dev/null`);
  if (r.status !== 0) return null;
  try {
    const tags = (JSON.parse(r.stdout) as { tags?: string[] }).tags ?? [];
    return tags.includes(tag) ? `${registry}/${imageName}:${tag}` : null;
  } catch { return null; }
}

/** 노드 이미지의 스킬 해시 라벨(`elanous.pod-skills`). */
export function remoteImageSkillsDigest(member: PodPoolMember, image: string, run: RemoteRun = defaultRemoteRun): string | null {
  if (!member.sshHost) return null;
  const r = run(member.sshHost, `docker image inspect ${image} --format '{{index .Config.Labels "elanous.pod-skills"}}'`);
  const v = r.status === 0 ? r.stdout.trim() : '';
  return v && v !== '<no value>' ? v : null;
}

const MEMBER = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:@([A-Za-z0-9][A-Za-z0-9._-]*))?(?::(\d+))?(?:#(k3d-[A-Za-z0-9][A-Za-z0-9._-]*):([1-9]\d{0,4}))?$/u;

export function parsePodPool(spec: string): PodPoolMember[] {
  const members = spec.split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const m = MEMBER.exec(part);
    if (!m) throw new Error(`--pod-pool: 못 읽는 노드 「${part}」 — 형식 컨텍스트[@ssh호스트][:상한][#k3d-레지스트리:포트]`);
    const capacity = m[3] === undefined ? 2 : Number(m[3]);
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`--pod-pool: 상한은 1 이상 — 「${part}」`);
    if (m[5] && Number(m[5]) > 65535) throw new Error(`--pod-pool: 레지스트리 포트는 65535 이하 — 「${part}」`);
    const context = m[1]!;
    const k3dCluster = context.startsWith('k3d-') ? context.slice(4) : 'elanous-pool';
    return { context, capacity, k3dCluster, ...(m[2] ? { sshHost: m[2] } : {}), ...(m[4] ? { registry: `${m[4]}:${m[5]}` } : {}) };
  });
  if (members.length === 0) throw new Error('--pod-pool: 노드가 없다');
  if (new Set(members.map((m) => m.context)).size !== members.length) throw new Error('--pod-pool: 컨텍스트가 겹친다');
  return members;
}

/** 스펙 해석 순서: 명시 인자 → `ELANOUS_POD_POOL` → 없음(null = 현재 컨텍스트 하나). */
export function resolvePodPoolSpec(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env, configPool: () => string | undefined = defaultConfigPool): string | null {
  // ⭐ «--substrate pod 만 써도 분배»(대표 2026-09-26) — 인자 → 환경 → 설정 `pod.pool` 순. 셋 다 없으면 현재 컨텍스트 하나.
  //   harness 입구는 `harness.podPool` 을 먼저 보는 자기 해석(하니스 실행 칸 기본값 해석)으로 풀을 «인자»로 넘긴다 — 범용 경로 계약은 그대로.
  const v = explicit?.trim() || env.ELANOUS_POD_POOL?.trim() || configPool()?.trim();
  return v ? v : null;
}

function defaultConfigPool(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getUserConfig } = require('../../user-config.js') as typeof import('../../user-config.js');
    return genericConfigPodPool(getUserConfig());
  } catch { return undefined; }
}

/** The generic Pod path reads only `pod.pool` (harness launches resolve `harness.podPool` themselves and pass it explicitly). */
export function genericConfigPodPool(config: { pod?: { pool?: string }; harness?: { podPool?: string } }): string | undefined {
  return config.pod?.pool;
}

/**
 * Cluster occupancy of one pool member: Running + Pending harness goal Pods.
 * `null` means the read failed — callers must not treat that as zero.
 */
export type MemberOccupancy = { occupied: number } | { occupied: null; reason: string };

/** Read each member's cluster occupancy (Running + Pending harness goal Pods). A failed member is `occupied: null`, never 0. */
export function measureMemberOccupancy(members: readonly PodPoolMember[], deps: { kubectl?: PoolKubectl; dns?: (context: string) => PoolDnsProbe; measure?: (members: readonly PodPoolMember[]) => { members: PodLeaseMember[] } } = {}): Record<string, MemberOccupancy> {
  let measured: { members: PodLeaseMember[] };
  try {
    measured = deps.measure
      ? deps.measure(members)
      : measurePoolLease(members, { ...(deps.kubectl ? { kubectl: deps.kubectl } : {}), ...(deps.dns ? { dns: deps.dns } : {}) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return Object.fromEntries(members.map((m) => [m.context, { occupied: null, reason }]));
  }
  const byContext = new Map(measured.members.map((m) => [m.context, m]));
  return Object.fromEntries(members.map((member) => {
    const row = byContext.get(member.context);
    if (!row || row.running === null || row.pending === null) {
      return [member.context, { occupied: null, reason: row?.reason ?? '측정 불가' }];
    }
    return [member.context, { occupied: row.running + row.pending }];
  }));
}

/** 노드 자리 배분 — 클러스터 실측 점유가 있으면 남은 칸이 가장 큰 멤버. 측정이 없으면 우선순위 순 첫 빈 자리. */
export function podPoolHostLease(members: readonly PodPoolMember[]): HostPoolLease {
  return new HostPoolLease([...members.map((m) => `${m.context}@${m.sshHost ?? ''}`)].sort().join(','));
}

export class PodPoolScheduler {
  private readonly inflight = new Map<string, number>();
  private readonly admission: PodLeaseAdmission;
  private readonly outstanding = new Set<PodLeaseRelease>();
  private lastFree = 0;
  private budget = 0;
  private initialized = false;
  private readonly measure: () => Promise<PoolLeaseRecommendation>;
  private lastRaw: PoolLeaseRecommendation | null = null;
  private readonly hostLease: HostPoolLease;
  private readonly pollMs: number;
  private readonly occupancy: () => Record<string, MemberOccupancy> | Promise<Record<string, MemberOccupancy>>;
  constructor(readonly members: readonly PodPoolMember[], options: { status?: () => PoolLeaseRecommendation | Promise<PoolLeaseRecommendation>; kubectl?: PoolKubectl; dns?: (context: string) => PoolDnsProbe; pollMs?: number; hostLease?: HostPoolLease; occupancy?: () => Record<string, MemberOccupancy> | Promise<Record<string, MemberOccupancy>>; dependencyMerged?: (after: PodLeasePredecessor, signal?: AbortSignal) => PredecessorState | boolean | Promise<PredecessorState | boolean> } = {}) {
    this.pollMs = options.pollMs ?? 15_000;
    // One lease directory per pool (contexts, not caps) — every CLI process launching into the same clusters shares it.
    this.hostLease = options.hostLease ?? podPoolHostLease(members);
    const measureStatus = options.status ?? (() => {
      const measure = measurePoolLease(members, { ...(options.kubectl ? { kubectl: options.kubectl } : {}), ...(options.dns ? { dns: options.dns } : {}) });
      return recommendConcurrency(measure, { capacity: members.reduce((n, m) => n + m.capacity, 0), accounts: 0, perAccount: 0 });
    });
    this.measure = async () => measureStatus();
    this.occupancy = options.occupancy ?? (() => measureMemberOccupancy(members, { ...(options.kubectl ? { kubectl: options.kubectl } : {}), ...(options.dns ? { dns: options.dns } : {}) }));
    this.admission = new PodLeaseAdmission({ status: async () => {
      const measured = await measureStatus();
      this.lastRaw = measured;
      const pendingJobs = measured.pendingJobs ?? [];
      const ownStart = this.hostLease.selfStart();
      const transferId = process.env.ELANOUS_POD_RESERVED_LEASE;
      const transferIsOther = !!transferId && this.hostLease.reservationIsOther(transferId);
      const others = measured.recommended === null ? 0 : this.hostLease.live().filter((r) =>
        (r.pid !== process.pid || r.startedAt !== ownStart) && !leaseHasPendingPod(r, pendingJobs)).length;
      const decision = measured.recommended === null ? measured : { ...measured, recommended: Math.max(0, measured.recommended - others + (transferIsOther ? 1 : 0)) };
      // An unknown reading cannot erase permits already granted: on recovery,
      // the first healthy recommendation must still account for their slots.
      if (decision.recommended === null) return decision;
      // A new launch consumes a measured additional slot. Compare consecutive
      // measurements so repeated stale readings cannot grant that slot again.
      this.budget = Math.max(0, this.budget + decision.recommended - (this.initialized ? this.lastFree : 0));
      this.initialized = true;
      this.lastFree = decision.recommended;
      return { ...decision, recommended: this.admission.snapshot().active + this.budget };
    }, ...(options.pollMs ? { pollMs: options.pollMs } : {}), dependencyMerged: options.dependencyMerged ?? ((after, signal) => predecessorState(after, {}, signal)) });
  }
  /** FIFO gate within this process, then a host lease so independent CLI processes cannot over-admit the same pool. */
  async acquireAdmission(signal?: AbortSignal, after?: PodLeasePredecessor): Promise<PodLeaseRelease & { applied: (job: string, context: string, namespace: string) => void; observed: () => void }> {
    const local = await this.acquireLocalAdmission(signal, after);
    try {
      for (;;) {
        if (signal?.aborted) throw new Error('pod lease admission aborted');
        const free = this.lastRaw?.recommended ?? null;
        // Same check as the local gate, but atomic across processes: other authoring and pre-Running leases hold slots.
        const reservedId = process.env.ELANOUS_POD_RESERVED_LEASE;
        const transferred = reservedId ? this.hostLease.claim(reservedId) : null;
        if (reservedId && !transferred) throw new Error('pod lease: authoring reservation could not be transferred');
        if (transferred) delete process.env.ELANOUS_POD_RESERVED_LEASE;
        const pendingJobs = this.lastRaw?.pendingJobs ?? [];
        const lease = transferred ?? (free !== null && free > 0 ? this.hostLease.tryReserve((others) =>
          others - this.hostLease.live().filter((r) => leaseHasPendingPod(r, pendingJobs) &&
            (r.pid !== process.pid || r.startedAt !== this.hostLease.selfStart())).length < free) : null);
        if (lease) {
          let hostReleased = false;
          const releaseHost = () => { if (!hostReleased) { hostReleased = true; lease(); } };
          return Object.assign(() => { releaseHost(); local(); }, {
            applied: (job: string, context: string, namespace: string) => lease.applied(job, context, namespace),
            observed: releaseHost,
          });
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, this.pollMs);
          const onAbort = () => { clearTimeout(timer); reject(new Error('pod lease admission aborted')); };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        try { this.lastRaw = await this.measure(); } catch { this.lastRaw = null; }
      }
    } catch (error) {
      local();
      throw error;
    }
  }
  private acquireLocalAdmission(signal?: AbortSignal, after?: PodLeasePredecessor): Promise<PodLeaseRelease> {
    return this.admission.acquire(signal, after).then((release) => {
      this.budget = Math.max(0, this.budget - 1);
      this.outstanding.add(release);
      return () => {
        if (!this.outstanding.delete(release)) return;
        // A release only restores a locally reserved slot while the latest
        // healthy measurement still reports free capacity. If the pool fell
        // from N=2 to N=0, a release cannot manufacture a new permit.
        if (this.lastFree > 0) this.budget = Math.min(this.lastFree, this.budget + 1);
        release();
      };
    });
  }
  admissionSnapshot(): ReturnType<PodLeaseAdmission['snapshot']> {
    return this.admission.snapshot();
  }
  /**
   * Pick the member with the largest free share: (capacity − measured cluster occupancy − this process's inflight) / capacity.
   * POOL-SPREAD (10-06): comparing absolute free slots always picked the big member (node-b 25 vs node-c 4), so the small
   * member idled until the big one was full. Comparing the free share fills members in proportion to their capacity.
   * A member whose occupancy could not be read falls back to inflight-only (never treated as zero occupied).
   * Ties keep the configured member order. Returns null when every readable member is full.
   */
  async tryAcquire(): Promise<PodPoolMember | null> {
    let reading: Record<string, MemberOccupancy>;
    try { reading = await this.occupancy(); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reading = Object.fromEntries(this.members.map((m) => [m.context, { occupied: null, reason }]));
    }
    const free: Record<string, number> = {};
    const measured: Record<string, boolean> = {};
    let best: { member: PodPoolMember; slots: number; measured: boolean } | null = null;
    // A measured member always beats an unmeasured one (its share would read 100% and draw every Job to a node
    // that did not answer); unmeasured members compete only when no measured member has a free slot.
    const better = (cand: { member: PodPoolMember; slots: number; measured: boolean }) => !best
      || (cand.measured !== best.measured ? cand.measured
        : cand.slots / cand.member.capacity > best.slots / best.member.capacity);
    for (const m of this.members) {
      const inflight = this.inflight.get(m.context) ?? 0;
      const row = reading[m.context];
      const ok = !!row && row.occupied !== null;
      measured[m.context] = ok;
      const occupied = ok ? row.occupied! : 0;
      const slots = m.capacity - occupied - inflight;
      free[m.context] = slots;
      if (slots <= 0) continue;
      const cand = { member: m, slots, measured: ok };
      if (better(cand)) best = cand;
    }
    if (!best) return null;
    this.inflight.set(best.member.context, (this.inflight.get(best.member.context) ?? 0) + 1);
    const share = Object.fromEntries(this.members.map((m) => [m.context, Math.round(Math.max(0, free[m.context] ?? 0) / m.capacity * 100) / 100]));
    debug.log('pod.pool', 'member-selected', { member: best.member.context, free, measured, share });
    return best.member;
  }
  release(member: PodPoolMember): void {
    this.inflight.set(member.context, Math.max(0, (this.inflight.get(member.context) ?? 0) - 1));
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.members.map((m) => [m.context, this.inflight.get(m.context) ?? 0]));
  }
}

export type RemoteRun = (host: string, script: string, input?: Buffer) => { status: number | null; stdout: string; stderr: string };

type LocalImageInspect = (image: string) => { status: number | null; stdout: string };

/** `docker save | ssh docker load` 한 번. 시험이 실제 전송 대신 호출 횟수만 센다. */
type ImageShip = (member: PodPoolMember, image: string) => { status: number | null; stderr: string };

function defaultImageShip(member: PodPoolMember, image: string): { status: number | null; stderr: string } {
  const ship = spawnSync('bash', ['-c', `set -o pipefail; docker save ${image} | gzip -1 | ssh -o BatchMode=yes -o ConnectTimeout=10 ${member.sshHost} 'export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$PATH; gunzip | docker load'`], { encoding: 'utf8', timeout: 1_800_000 });
  return { status: ship.status, stderr: ship.stderr ?? '' };
}

export function defaultRemoteRun(host: string, script: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, `export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$PATH; unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy; ${script}`], { encoding: 'utf8', timeout: 900_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error) : '') };
}

/** 원격 노드의 이미지 판(라벨 `elanous.commit`). 못 읽으면 null. */
export function remoteImageCommit(member: PodPoolMember, image: string, run: RemoteRun = defaultRemoteRun): string | null {
  if (!member.sshHost) return null;
  const r = run(member.sshHost, `docker image inspect ${image} --format '{{index .Config.Labels "elanous.commit"}}'`);
  const v = r.status === 0 ? r.stdout.trim() : '';
  return v && v !== '<no value>' ? v : null;
}

/**
 * 원격 노드에 이 기계의 이미지를 보낸다(판이 다를 때만) — `docker save | ssh docker load` ⊕ `k3d image import`.
 * ⛔ Pod 의 elanous 는 이미지 판이다(피드백: Pod 는 main 이 아니라 이미지를 돈다) — 노드마다 판이 다르면 같은 골이 노드마다 다른 코드로 돈다.
 */
export function syncPoolImage(member: PodPoolMember, image: string, localCommit: string | null, run: RemoteRun | { run?: RemoteRun; inspect?: LocalImageInspect; transfer?: ImageShip } = defaultRemoteRun): { ok: boolean; action: 'local' | 'fresh' | 'built' | 'shipped' | 'failed'; detail: string } {
  const opts = typeof run === 'function' ? { run } : { run: run.run ?? defaultRemoteRun, inspect: run.inspect, transfer: run.transfer };
  const remote = opts.run ?? defaultRemoteRun;
  const inspect = opts.inspect ?? defaultLocalImageInspect;
  const transfer = opts.transfer ?? defaultImageShip;
  if (!member.sshHost) return { ok: true, action: 'local', detail: 'this machine' };
  const before = remoteImageCommit(member, image, remote);
  if (localCommit && before === localCommit) return { ok: true, action: 'fresh', detail: before.slice(0, 12) };
  // 통째 전송은 이 기계 이미지의 커밋 라벨이 목표와 같을 때만. 다르면 낡은 판을 보내지 않는다.
  const here = localImageCommit(image, inspect);
  if (localCommit && here !== localCommit) return { ok: false, action: 'failed', detail: '로컬 이미지 판이 다르다 · 보내지 않음' };
  const ship = transfer(member, image);
  if (ship.status !== 0) return { ok: false, action: 'failed', detail: `docker load rc=${ship.status}: ${(ship.stderr ?? '').slice(-300)}` };
  const imp = remote(member.sshHost, `k3d image import ${image} -c ${member.k3dCluster}`);
  if (imp.status !== 0) return { ok: false, action: 'failed', detail: `k3d import rc=${imp.status}: ${imp.stderr.slice(-300)}` };
  const after = remoteImageCommit(member, image, remote);
  return after && (!localCommit || after === localCommit)
    ? { ok: true, action: 'shipped', detail: `${before?.slice(0, 12) ?? '없음'} → ${after.slice(0, 12)}` }
    : { ok: false, action: 'failed', detail: `보낸 뒤 판이 ${after ?? '없음'} — 기대 ${localCommit ?? '?'}` };
}

export type PoolKubectl = (args: readonly string[], input?: string) => { status: number | null; stdout: string; stderr: string };

/**
 * 발사 전 점검 — 노드마다 «컨텍스트가 닿나 · elanous-test 네임스페이스가 있나».
 * ⛔ 안 되는 노드는 «조용히» 빼지 않는다 — 이유를 낸다. 하나도 안 되면 ok=false.
 */
export function checkPodPool(members: readonly PodPoolMember[], kubectl: PoolKubectl): { ok: boolean; ready: PodPoolMember[]; dropped: { context: string; reason: string }[] } {
  const ready: PodPoolMember[] = [];
  const dropped: { context: string; reason: string }[] = [];
  for (const m of members) {
    const ns = kubectl(['--context', m.context, '--request-timeout=10s', 'get', 'ns', 'elanous-test']);
    if (ns.status === 0) ready.push(m);
    else dropped.push({ context: m.context, reason: (ns.stderr.trim().split('\n').pop() ?? '').slice(0, 200) || `rc=${ns.status}` });
  }
  return { ok: ready.length > 0, ready, dropped };
}

export type PoolImageSync = { ok: boolean; action: 'local' | 'fresh' | 'built' | 'shipped' | 'failed'; detail: string; ms: number; /** 노드 레지스트리의 이 판 이미지(있으면 Pod 가 pull). */ imageRef?: string };

/** 이미지 빌드 스크립트 — 발사한 트리의 것(판이 HEAD 와 같다). 없으면 null(통째 전송으로 떨어진다). */
export function podImageBuildScript(cwd: string = process.cwd()): string | null {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).stdout?.trim();
  for (const root of [top, resolve(import.meta.dir, '..', '..', '..')]) {
    if (root && existsSync(join(root, 'docker', 'harness', 'build.sh'))) return join(root, 'docker', 'harness', 'build.sh');
  }
  return null;
}

type RemoteBuild = (host: string, cluster: string, registry?: string) => Promise<{ ok: boolean; detail: string }>;

function defaultRemoteBuild(script: string, image: string): RemoteBuild {
  return (host, cluster, registry) => new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ELANOUS_BUILD_REMOTE: host, ELANOUS_L2_CLUSTER: cluster, ELANOUS_BUILD_IMAGE: image === 'elanous-harness-lite:local' ? 'lite' : 'full' };
    delete env.ELANOUS_BUILD_REGISTRY;
    if (registry) env.ELANOUS_BUILD_REGISTRY = registry;
    const child = spawn('bash', [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 1_800_000);
    child.on('close', (code) => { clearTimeout(timer); done({ ok: code === 0, detail: out.trim().split('\n').slice(-2).join(' · ').slice(0, 300) }); });
  });
}

/**
 * 풀의 원격 노드들을 «동시에» 이 트리의 판으로 맞춘다 (09-25 개선).
 *   1순위 = 노드 «쪽에서» 빌드(build.sh ELANOUS_BUILD_REMOTE) — 빌드 재료(수십 MB)만 보내고 무거운 층은 그 노드의 캐시가 재사용한다.
 *           📏 커밋이 바뀐 뒤 두 노드를 올리는 데 벽시계 55초(종전: 다시 굽기 1분 40초 ⊕ 4GB 차례 전송 5분 48초).
 *   실패하면 = 종전의 통째 전송(syncPoolImage)으로 떨어진다.
 */
export async function syncPoolImages(members: readonly PodPoolMember[], image: string, localCommit: string | null, deps: { run?: RemoteRun; remoteBuild?: RemoteBuild; buildScript?: string | null; ship?: typeof syncPoolImage; localSkillsDigest?: string | null; waitIntervalMs?: number; waitMaxMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; inspect?: LocalImageInspect; transfer?: ImageShip } = {}): Promise<Map<string, PoolImageSync>> {
  const run = deps.run ?? defaultRemoteRun;
  const script = deps.buildScript === undefined ? podImageBuildScript() : deps.buildScript;
  const remoteBuild = deps.remoteBuild ?? (script ? defaultRemoteBuild(script, image) : null);
  const ship = deps.ship ?? ((m: PodPoolMember, img: string, commit: string | null, remote: RemoteRun) => syncPoolImage(m, img, commit, { run: remote, inspect: deps.inspect, transfer: deps.transfer }));
  const results = new Map<string, PoolImageSync>();
  await Promise.all(members.map(async (m) => {
    const t0 = Date.now();
    if (!m.sshHost) { results.set(m.context, { ok: true, action: 'local', detail: 'this machine', ms: 0 }); return; }
    const before = remoteImageCommit(m, image, run);
    // ⭐ «같은 판» = 커밋 ⊕ 스킬 해시 ⊕ (레지스트리 노드면) 레지스트리에 그 커밋 태그가 있다 — 스킬만 바뀌어도 다시 굽는다(대표 2026-09-26 «스킬 셋트 싱크»).
    const skillsNow = deps.localSkillsDigest;
    const skillsSame = skillsNow == null || remoteImageSkillsDigest(m, image, run) === skillsNow;
    const refBefore = registryImageRef(m, localCommit, run, image);
    const hasRegistry = run(m.sshHost, `docker inspect ${memberRegistry(m).split(':')[0]} >/dev/null 2>&1`).status === 0;
    if (localCommit && before === localCommit && skillsSame && (!hasRegistry || refBefore)) {
      results.set(m.context, { ok: true, action: 'fresh', detail: before.slice(0, 12), ms: Date.now() - t0, ...(refBefore ? { imageRef: refBefore } : {}) });
      return;
    }
    if (remoteBuild) {
      const b = await remoteBuild(m.sshHost, m.k3dCluster, m.registry);
      const after = remoteImageCommit(m, image, run);
      const refAfter = registryImageRef(m, localCommit ?? after, run, image);
      // ⭐ 레지스트리 노드면 «이 판 커밋 태그가 레지스트리에 있나»로 판정한다 — Pod 는 그 커밋 태그를 pull 한다.
      //   🩸 2026-09-26(🅣 실측): 두 발사가 같은 노드를 동시에 구우면 가변 태그 `:local` 을 서로 덮어, 빌드는 성공했는데
      //   `:local` 의 판이 남의 커밋이라 «못 맞췄다»로 노드를 뺐다(런이 시작도 못 함). 커밋 태그는 덮이지 않는다.
      if (b.ok && localCommit && refAfter) {
        results.set(m.context, { ok: true, action: 'built', imageRef: refAfter, detail: `${before?.slice(0, 12) ?? '없음'} → ${localCommit.slice(0, 12)} (노드 쪽 빌드 · 레지스트리 판 태그)`, ms: Date.now() - t0 });
        return;
      }
      if (b.ok && after && (!localCommit || after === localCommit)) { results.set(m.context, { ok: true, action: 'built', ...(refAfter ? { imageRef: refAfter } : {}), detail: `${before?.slice(0, 12) ?? '없음'} → ${after.slice(0, 12)} (노드 쪽 빌드)`, ms: Date.now() - t0 }); return; }
      // 빌드가 성공하면 위에서 즉시 끝난다. 실패했을 때만, 통째 전송 전에 같은 판을 굽는 다른 발사의 태그를 기다린다.
      if (!b.ok) {
        const waited = await waitForConcurrentBuild(m, localCommit, { intervalMs: deps.waitIntervalMs, maxMs: deps.waitMaxMs, now: deps.now, sleep: deps.sleep, run, image });
        debug.log('self-implement.pod', 'pool-image-wait-concurrent', { context: m.context, commit: localCommit, waitedMs: waited.waitedMs, outcome: waited.imageRef ? 'built' : 'timeout' });
        if (waited.imageRef) {
          results.set(m.context, { ok: true, action: 'built', imageRef: waited.imageRef, detail: '동시 빌드 결과 사용', ms: Date.now() - t0 });
          return;
        }
      }
      const fallback = ship(m, image, localCommit, run);
      results.set(m.context, { ...fallback, detail: `노드 쪽 빌드 실패(${b.detail}) → ${fallback.detail}`, ms: Date.now() - t0 });
      return;
    }
    results.set(m.context, { ...ship(m, image, localCommit, run), ms: Date.now() - t0 });
  }));
  return results;
}
