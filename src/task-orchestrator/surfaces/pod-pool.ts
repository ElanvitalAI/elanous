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
 *   POOL-LITE(10-07): 골 종류를 주면 lite·문서·측정 골은 상한이 가장 작은 노드(node-c), 구현 골은 가장 큰 노드(node-b)를 먼저 쓰고,
 *   그 노드가 차면 빈 자리 비율로 넘친다. 상한 0 노드는 «꺼짐» — 해석에서 빠지고 절대 고르지 않는다.
 * 노드 선택의 진행 중 수는 로컬 프로세스 기준이다. 발사 허가는 별도의 lease 측정으로
 * 다른 호스트의 Running/Pending 및 메모리 예약까지 고려한다.
 * 풀을 안 주면 종전처럼 «현재 컨텍스트» 하나다(동작 불변).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { debug } from '../../debug/log.js';
import { PodLeaseAdmission, type PodLeasePredecessor, type PodLeaseRelease } from '../../pod-lease/admission.js';
import { predecessorState, type PredecessorState } from '../../pod-lease/dependency-state.js';
import { HostPoolLease, hostLeaseBaseDir, leaseHasPendingPod } from '../../pod-lease/host-lease.js';
import { acquireLockAsync, acquireLockSync } from '../../storage/file-lock.js';
import { harnessCpuSlotsBesideGate, measurePoolLease, recommendConcurrency, type PodLeaseMember, type PoolDnsProbe, type PoolLeaseRecommendation } from './pod-lease.js';

export interface PodPoolMember {
  readonly context: string;
  /** 원격 클러스터가 도는 기계(ssh 호스트). 없으면 이 기계의 docker 에 있다. */
  readonly sshHost?: string;
  readonly capacity: number;
  /**
   * POD-POOL-UNCAPPED-SPEC — 스펙에 `:N` 이 없어서 `capacity` 가 운영자 숫자가 아니라 `POD_POOL_DEFAULT_CAPACITY` 다.
   * 발사 허가는 이 표시로 «풀 기본 상한이 막았다»(`limitedBy=pool-cap`)를 일반 `capacity` 와 갈라 말한다.
   */
  readonly capacityDefaulted?: boolean;
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

/** 레지스트리 안 이미지 이름 — `docker/harness/build.sh` 의 full/lite 규칙 그대로. */
function podRegistryImageName(image: string): string {
  return image === 'elanous-harness-lite:local' ? 'elanous-harness-lite' : 'elanous-harness';
}

/** 레지스트리 태그 = 커밋 앞 12자리 (build.sh:295 와 같은 규칙). */
function podRegistryTag(commit: string): string {
  return commit.slice(0, 12);
}

/** 노드 로컬 레지스트리의 HTTP 포트 — 호스트에서는 같은 포트의 localhost 로 조회한다. */
function memberRegistryPort(member: PodPoolMember): string {
  const registry = memberRegistry(member);
  return registry.slice(registry.lastIndexOf(':') + 1);
}

/** 이 커밋의 이미지가 노드 레지스트리에 있나 — 있으면 클러스터 안 이미지 주소. */
export function registryImageRef(member: PodPoolMember, commit: string | null, run: RemoteRun = defaultRemoteRun, image = 'elanous-harness:local'): string | null {
  if (!member.sshHost || !commit) return null;
  const imageName = podRegistryImageName(image);
  const tag = podRegistryTag(commit);
  const registry = memberRegistry(member);
  const r = run(member.sshHost, `curl -fsS --max-time 5 http://localhost:${memberRegistryPort(member)}/v2/${imageName}/tags/list 2>/dev/null`);
  if (r.status !== 0) return null;
  try {
    const tags = (JSON.parse(r.stdout) as { tags?: string[] }).tags ?? [];
    return tags.includes(tag) ? `${registry}/${imageName}:${tag}` : null;
  } catch { return null; }
}

/** 레지스트리 HTTP 한 번 — 노드에서 `curl -fsS --max-time 5`(registryImageRef 와 같은 규칙). 실패면 null. */
function registryHttpGet(member: PodPoolMember, path: string, run: RemoteRun, accept?: string): string | null {
  if (!member.sshHost) return null;
  const header = accept ? `-H 'Accept: ${accept}' ` : '';
  const r = run(member.sshHost, `curl -fsS --max-time 5 ${header}http://localhost:${memberRegistryPort(member)}/v2/${path} 2>/dev/null`);
  return r.status === 0 && r.stdout.trim() ? r.stdout : null;
}

function registryLabelValue(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() && raw !== '<no value>' ? raw.trim() : null;
}

/**
 * GATE-REGISTRY-IMAGE-FASTPATH (0.2.36): 레지스트리 HTTP 만으로 이 커밋 태그 이미지의 config label 을 읽는다 —
 * 노드 Docker 데몬(`docker image inspect`)을 부르지 않는다. 태그 결손 · HTTP 오류 · manifest list(단일 config 없음) ·
 * 비JSON 은 null 이다(판정하지 않고 종전 경로로 떨어진다).
 *   GET /v2/<이미지>/manifests/<커밋12> → config.digest → GET /v2/<이미지>/blobs/<digest> → config.Labels
 */
export function registryImageLabels(member: PodPoolMember, image: string, commit: string | null, run: RemoteRun = defaultRemoteRun): { commit: string | null; skills: string | null } | null {
  if (!member.sshHost || !commit) return null;
  const imageName = podRegistryImageName(image);
  const manifest = registryHttpGet(member, `${imageName}/manifests/${podRegistryTag(commit)}`, run, 'application/vnd.docker.distribution.manifest.v2+json');
  if (!manifest) return null;
  let digest: string | undefined;
  try { digest = (JSON.parse(manifest) as { config?: { digest?: string } }).config?.digest; } catch { return null; }
  if (!digest) return null;
  // config digest 는 `sha256:<64 hex>` — 이 형태가 아니면 경로에 넣지 않는다.
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) return null;
  const blob = registryHttpGet(member, `${imageName}/blobs/${digest}`, run);
  if (!blob) return null;
  let labels: Record<string, unknown> | undefined;
  try { labels = (JSON.parse(blob) as { config?: { Labels?: Record<string, unknown> } }).config?.Labels; } catch { return null; }
  if (!labels || typeof labels !== 'object') return null;
  return { commit: registryLabelValue(labels['elanous.commit']), skills: registryLabelValue(labels['elanous.pod-skills']) };
}

/**
 * 이 커밋 태그의 이미지 label 이 이번 발사 값과 모두 맞나 — 맞으면 Docker 조회 없이 그 판을 쓸 수 있다.
 * 커밋 label 은 발사 커밋과 «정확히» 같아야 한다(태그가 다른 판을 가리키는 경우를 거른다).
 * `localSkillsDigest` 가 없으면(모르는 값) 커밋 label 만 본다 — syncPoolImages 의 종전 skillsSame 과 같은 뜻.
 */
export function registryImageLabelsMatch(member: PodPoolMember, image: string, commit: string | null, opts: { localSkillsDigest?: string | null; run?: RemoteRun } = {}): boolean {
  if (!commit) return false;
  const labels = registryImageLabels(member, image, commit, opts.run ?? defaultRemoteRun);
  if (!labels || labels.commit !== commit) return false;
  return opts.localSkillsDigest == null || labels.skills === opts.localSkillsDigest;
}

/** IMAGE-ONE-SOURCE: 이 멤버의 노드에 레지스트리 컨테이너가 있나(syncPoolImages 의 판정과 같은 명령). 로컬 멤버는 false. */
export function memberHasRegistry(member: PodPoolMember, run: RemoteRun = defaultRemoteRun): boolean {
  if (!member.sshHost) return false;
  return run(member.sshHost, `docker inspect ${memberRegistry(member).split(':')[0]} >/dev/null 2>&1`).status === 0;
}

/** 노드 이미지의 스킬 해시 라벨(`elanous.pod-skills`). */
export function remoteImageSkillsDigest(member: PodPoolMember, image: string, run: RemoteRun = defaultRemoteRun): string | null {
  if (!member.sshHost) return null;
  const r = run(member.sshHost, `docker image inspect ${image} --format '{{index .Config.Labels "elanous.pod-skills"}}'`);
  const v = r.status === 0 ? r.stdout.trim() : '';
  return v && v !== '<no value>' ? v : null;
}

const MEMBER = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:@([A-Za-z0-9][A-Za-z0-9._-]*))?(?::(\d+))?(?:#(k3d-[A-Za-z0-9][A-Za-z0-9._-]*):([1-9]\d{0,4}))?$/u;

/** 상한 없는 풀 스펙(`:N` 없음)의 노드 상한 — 파일 머리 주석의 «기본 2» 정본(POD-POOL-UNCAPPED-SPEC). */
export const POD_POOL_DEFAULT_CAPACITY = 2;

export function parsePodPool(spec: string): PodPoolMember[] {
  const members = spec.split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const m = MEMBER.exec(part);
    if (!m) throw new Error(`--pod-pool: 못 읽는 노드 「${part}」 — 형식 컨텍스트[@ssh호스트][:상한][#k3d-레지스트리:포트]`);
    // `:N` 이 없으면 «상한 없음»이 아니라 기본 상한 2 다 — 그 사실(`capacityDefaulted`)을 멤버에 남긴다.
    const capacityDefaulted = m[3] === undefined;
    const capacity = capacityDefaulted ? POD_POOL_DEFAULT_CAPACITY : Number(m[3]);
    // POOL-LITE (10-07): `:0` means «this member is off» — a `node-c:0` entry once threw here and broke every launch.
    //   It is dropped below (never chosen); only a pool with no live member left is an error.
    if (!Number.isInteger(capacity) || capacity < 0) throw new Error(`--pod-pool: 상한은 1 이상 — 「${part}」`);
    if (m[5] && Number(m[5]) > 65535) throw new Error(`--pod-pool: 레지스트리 포트는 65535 이하 — 「${part}」`);
    const context = m[1]!;
    const k3dCluster = context.startsWith('k3d-') ? context.slice(4) : 'elanous-pool';
    return { context, capacity, ...(capacityDefaulted ? { capacityDefaulted: true } : {}), k3dCluster, ...(m[2] ? { sshHost: m[2] } : {}), ...(m[4] ? { registry: `${m[4]}:${m[5]}` } : {}) };
  });
  if (members.length === 0) throw new Error('--pod-pool: 노드가 없다');
  if (new Set(members.map((m) => m.context)).size !== members.length) throw new Error('--pod-pool: 컨텍스트가 겹친다');
  const live = members.filter((m) => m.capacity > 0);
  if (live.length === 0) throw new Error(`--pod-pool: 상한은 1 이상 — 상한 0 이 아닌 노드가 없다 「${spec}」`);
  if (live.length !== members.length) {
    debug.log('pod.pool', 'member-disabled', { members: members.filter((m) => m.capacity <= 0).map((m) => m.context), reason: 'capacity-0' });
  }
  return live;
}

/**
 * POOL-LITE (10-07) — what kind of Job is being placed. `lite` = lite memory tier or a docs/measurement goal;
 * `standard` = an implementation goal. Absent kind keeps the plain free-share placement unchanged.
 */
export type PodPlacementKind = 'lite' | 'standard';

/** Identity carried by a launched pool Job and its Pod; absent source fields stay absent. */
export interface PodWorkIdentity {
  ownerKind?: 'seat' | 'steward' | 'orchestrator' | 'external';
  ownerId?: string;
  taskCard?: string;
  slotId?: string;
  work?: 'harness' | 'authoring' | 'lite';
}

/** Kubernetes label values cannot exceed 63 characters or contain arbitrary card/owner text. */
export function podWorkLabels(identity: PodWorkIdentity): Record<string, string> {
  const value = (raw: string | undefined): string | undefined => {
    const cleaned = (raw ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 63).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    return cleaned || undefined;
  };
  const ownerId = identity.ownerId && value(identity.ownerId) === identity.ownerId ? identity.ownerId : undefined;
  const taskCard = identity.taskCard && value(identity.taskCard) === identity.taskCard ? identity.taskCard : undefined;
  const slotId = identity.slotId && value(identity.slotId) === identity.slotId ? identity.slotId : undefined;
  return {
    ...(identity.ownerKind && ownerId ? { 'elanous.owner-kind': identity.ownerKind, 'elanous.owner-id': ownerId } : {}),
    ...(taskCard ? { 'elanous.task-card': taskCard } : {}),
    ...(slotId ? { 'elanous.checklist': slotId } : {}),
    ...(identity.work ? { 'elanous.work': identity.work } : {}),
  };
}

/**
 * MINIH-MODE (0.2.37) — where this pool's standard Jobs run: `home` (1 standard Job) or `external` (2).
 * The location is declared explicitly by the launch (`minihLocationFrom` reads `ELANOUS_MINIH_LOCATION`); when it
 * is absent the configured member capacities decide, exactly as before.
 */
export type MinihLocation = 'home' | 'external';

/** The declared location for a launch: `home` / `external` only. Absent, empty or unknown → null (configured capacity). */
export function minihLocationFrom(value: string | undefined | null): MinihLocation | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'home' || normalized === 'external' ? normalized : null;
}

export function minihStandardCapacity(location: MinihLocation): number {
  return location === 'home' ? 1 : 2;
}

/**
 * A drain withholds new slots until occupancy falls to the target; it never evicts Running Pods.
 * `PodPoolScheduler.tryAcquire` applies this to new standard-Job admission when a location is declared.
 */
export function decideMinihDrain(location: MinihLocation, runningPods: number, pendingPods = 0): {
  capacity: number;
  runningPods: number;
  drainNewAdmissions: boolean;
  availableSlots: number;
} {
  if (![runningPods, pendingPods].every((count) => Number.isSafeInteger(count) && count >= 0)) {
    throw new RangeError('node-c occupancy must be non-negative whole Pods');
  }
  const capacity = minihStandardCapacity(location);
  const occupied = runningPods + pendingPods;
  return {
    capacity,
    runningPods,
    drainNewAdmissions: occupied > capacity,
    availableSlots: Math.max(0, capacity - occupied),
  };
}

export interface PodPlacement {
  readonly member: string;
  readonly kind: PodPlacementKind | null;
  /** `preferred` = landed on the kind's preferred member · `overflow` = preferred member(s) full/skipped · `share` = no preference applies. */
  readonly outcome: 'preferred' | 'overflow' | 'share';
  readonly preferred: readonly string[];
  /** One line for launch output and the run ledger. */
  readonly reason: string;
}

/**
 * Preferred members for a placement kind: lite → the smallest-capacity member(s) (node-c), standard → the largest (node-b).
 * Capacity is the operator's own statement of member size (`pool-node-b@node-b:40,pool-node-c@node-c:6`), so no new spec syntax.
 * When every member has the same capacity there is no small/big member and no preference (empty list).
 */
export function preferredMembers(members: readonly PodPoolMember[], kind: PodPlacementKind | null | undefined): string[] {
  const live = members.filter((m) => m.capacity > 0);
  if (!kind || live.length < 2) return [];
  const caps = live.map((m) => m.capacity);
  const min = Math.min(...caps);
  const max = Math.max(...caps);
  if (min === max) return [];
  const target = kind === 'lite' ? min : max;
  return live.filter((m) => m.capacity === target).map((m) => m.context);
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
  /**
   * GATE-ADMIT-EXEMPT — the gate's own shard Jobs (GATE-MEM-ADMIT) queue here: memory admission without the
   * GATE-RESERVE-AUTO CPU bound, which exists to protect the gate from harness Pods, not from itself.
   */
  private readonly gateAdmission: PodLeaseAdmission;
  /** A launch with an explicit memory limit must be measured with that limit, not the pool's 16Gi default. */
  private readonly memoryAdmissions = new Map<string, { admission: PodLeaseAdmission; reading: () => PoolLeaseRecommendation | null; measure: () => Promise<PoolLeaseRecommendation>; take: () => void; release: () => void }>();
  private readonly outstanding = new Set<PodLeaseRelease>();
  private lastFree = 0;
  private budget = 0;
  /** GATE-RESERVE-AUTO — local permits whose Pod was observed (Running/terminal): already inside the CPU reading. */
  private seenActive = 0;
  private initialized = false;
  private readonly measure: () => Promise<PoolLeaseRecommendation>;
  private readonly measureForMemory: (memoryLimit: string) => Promise<PoolLeaseRecommendation>;
  private readonly dependencyMerged: (after: PodLeasePredecessor, signal?: AbortSignal) => PredecessorState | boolean | Promise<PredecessorState | boolean>;
  private lastRaw: PoolLeaseRecommendation | null = null;
  /** GATE-ADMIT-EXEMPT — the same reading before the gate CPU cap (memory/limitedBy unchanged); gate callers read it. */
  private lastUncapped: PoolLeaseRecommendation | null = null;
  private readonly hostLease: HostPoolLease;
  private readonly pollMs: number;
  private readonly occupancy: () => Record<string, MemberOccupancy> | Promise<Record<string, MemberOccupancy>>;
  private readonly memberMemory: () => Array<{ context: string; allocatableMemoryBytes: number | null }> | Promise<Array<{ context: string; allocatableMemoryBytes: number | null }>>;
  constructor(readonly members: readonly PodPoolMember[], options: { status?: (memoryLimit?: string) => PoolLeaseRecommendation | Promise<PoolLeaseRecommendation>; kubectl?: PoolKubectl; dns?: (context: string) => PoolDnsProbe; pollMs?: number; hostLease?: HostPoolLease; memberMemory?: () => Array<{ context: string; allocatableMemoryBytes: number | null }> | Promise<Array<{ context: string; allocatableMemoryBytes: number | null }>>; occupancy?: () => Record<string, MemberOccupancy> | Promise<Record<string, MemberOccupancy>>; dependencyMerged?: (after: PodLeasePredecessor, signal?: AbortSignal) => PredecessorState | boolean | Promise<PredecessorState | boolean> } = {}) {
    this.pollMs = options.pollMs ?? 15_000;
    // One lease directory per pool (contexts, not caps) — every CLI process launching into the same clusters shares it.
    this.hostLease = options.hostLease ?? podPoolHostLease(members);
    // GATE-RESERVE-AUTO: the gate reservation is returned beside the recommendation, never folded into it — the
    // delta budget below must not see a gate start/end as a free-slot change (that made the result order-dependent).
    const measureStatus: (memoryLimit?: string) => Promise<{ status: PoolLeaseRecommendation; gateSlots: number | null | undefined }> = options.status
      ? async (memoryLimit) => ({ status: await options.status!(memoryLimit), gateSlots: undefined })
      : async (memoryLimit) => {
        // POD-ADMIT-BY-USAGE: admission reads observed Pod usage (`kubectl top`); tryAcquire's occupancy read does not.
        const measure = measurePoolLease(members, { ...(options.kubectl ? { kubectl: options.kubectl } : {}), ...(options.dns ? { dns: options.dns } : {}), measureUsage: true });
        return { status: recommendConcurrency(measure, { capacity: members.reduce((n, m) => n + m.capacity, 0), ...(memoryLimit ? { perGoalMemory: memoryLimit } : {}), accounts: 0, perAccount: 0 }), gateSlots: harnessCpuSlotsBesideGate(measure) };
      };
    /** Cluster-level additional slots for the cross-process host lease: the measured free slots, capped by the gate's CPU. */
    const capped = ({ status, gateSlots }: { status: PoolLeaseRecommendation; gateSlots: number | null | undefined }): PoolLeaseRecommendation =>
      gateSlots === undefined || status.recommended === null ? status
        : gateSlots === null ? { ...status, recommended: null, reason: '측정 불가: gate CPU' }
          : { ...status, recommended: Math.min(status.recommended, gateSlots) };
    this.measure = async () => { const reading = await measureStatus(); this.lastUncapped = reading.status; return capped(reading); };
    this.measureForMemory = async (memoryLimit) => capped(await measureStatus(memoryLimit));
    // An injected status (tests, callers with their own measurement) without memberMemory never shells out to kubectl here.
    this.memberMemory = options.memberMemory ?? (options.status ? (() => []) : () => measurePoolLease(members, { ...(options.kubectl ? { kubectl: options.kubectl } : {}), ...(options.dns ? { dns: options.dns } : {}) }).members
      .map((m: PodLeaseMember) => ({ context: m.context, allocatableMemoryBytes: m.allocatableMemoryBytes })));
    this.occupancy = options.occupancy ?? (() => measureMemberOccupancy(members, { ...(options.kubectl ? { kubectl: options.kubectl } : {}), ...(options.dns ? { dns: options.dns } : {}) }));
    const decide = async (gate: boolean): Promise<PoolLeaseRecommendation> => {
      const reading = await measureStatus();
      const measured = reading.status;
      this.lastRaw = capped(reading);
      this.lastUncapped = measured;
      const pendingJobs = measured.pendingJobs ?? [];
      const ownStart = this.hostLease.selfStart();
      const transferId = process.env.ELANOUS_POD_RESERVED_LEASE;
      const transferIsOther = !!transferId && this.hostLease.reservationIsOther(transferId);
      const others = measured.recommended === null ? 0 : this.hostLease.live().filter((r) =>
        (r.pid !== process.pid || r.startedAt !== ownStart) && !leaseHasPendingPod(r, pendingJobs)).length;
      const decision = measured.recommended === null ? measured : { ...measured, recommended: Math.max(0, measured.recommended - others + (transferIsOther ? 1 : 0)) };
      // An unknown reading cannot erase permits already granted: on recovery,
      // the first healthy recommendation must still account for their slots.
      // GATE-ADMIT-UNMEASURED(10-09 대표 «판 발행 문제없게»): 측정이 «?»(예: 부하 노드의 DNS 탐침)여도 게이트 조각은 하나씩 들어간다 —
      //   게이트가 측정 복구를 기다리며 조각마다 승인 시간 초과를 물지 않게. 실제로 자리가 없으면 스케줄러가 Pending 으로 둔다(잃는 것 없음).
      if (decision.recommended === null) {
        if (!gate) return decision;
        const active = this.gateAdmission.snapshot().active;
        debug.log('pod.pool', 'gate-admit-unmeasured', { active, reason: decision.reason ?? null });
        return { ...decision, recommended: active + 1 };
      }
      // A new launch consumes a measured additional slot. Compare consecutive
      // measurements so repeated stale readings cannot grant that slot again.
      this.budget = Math.max(0, this.budget + decision.recommended - (this.initialized ? this.lastFree : 0));
      this.initialized = true;
      this.lastFree = decision.recommended;
      // Each queue's limit is its own permits plus the shared remaining budget (every permit already took one from it).
      const active = (gate ? this.gateAdmission : this.admission).snapshot().active;
      const total = active + this.budget;
      if (reading.gateSlots === undefined) return { ...decision, recommended: total };
      if (gate) {
        debug.log('pod.pool', 'gate-reserve', { gateSlots: reading.gateSlots, active, budget: this.budget, recommended: total, exempt: 'gate-caller' });
        return { ...decision, recommended: total };
      }
      // GATE-RESERVE-AUTO: while a gate shard Job is active, harness admission is also bounded by the CPU left after
      // the gate. The bound is absolute (this reading ⊕ current local permits). Pods already in the reading — observed
      // ones (`seenActive`) and ones measured Pending (own leases with a pending Pod) — are not subtracted again;
      // the remaining local permits and other processes' leases without a measured Pod (`others`) are.
      const ownMeasuredPending = this.hostLease.live().filter((r) => r.pid === process.pid && r.startedAt === ownStart && leaseHasPendingPod(r, pendingJobs)).length;
      const unseen = Math.max(0, active - this.seenActive - ownMeasuredPending);
      const cpuFree = reading.gateSlots === null ? 0 : Math.max(0, reading.gateSlots - others + (transferIsOther ? 1 : 0) - unseen);
      const recommended = Math.min(total, active + cpuFree);
      if (recommended < total) debug.log('pod.pool', 'gate-reserve', { gateSlots: reading.gateSlots, active, unseen, ownMeasuredPending, others, budget: this.budget, recommended });
      return reading.gateSlots === null
        ? { ...decision, recommended, reason: '측정 불가: gate CPU' }
        : { ...decision, recommended };
    };
    this.dependencyMerged = options.dependencyMerged ?? ((after: PodLeasePredecessor, signal?: AbortSignal) => predecessorState(after, {}, signal));
    this.admission = new PodLeaseAdmission({ status: () => decide(false), ...(options.pollMs ? { pollMs: options.pollMs } : {}), dependencyMerged: this.dependencyMerged });
    this.gateAdmission = new PodLeaseAdmission({ status: () => decide(true), ...(options.pollMs ? { pollMs: options.pollMs } : {}), dependencyMerged: this.dependencyMerged });
  }
  private memoryAdmission(memoryLimit: string): { admission: PodLeaseAdmission; reading: () => PoolLeaseRecommendation | null; measure: () => Promise<PoolLeaseRecommendation>; take: () => void; release: () => void } {
    const existing = this.memoryAdmissions.get(memoryLimit);
    if (existing) return existing;
    let last: PoolLeaseRecommendation | null = null;
    let admission: PodLeaseAdmission;
    let lastFree = 0;
    let budget = 0;
    let initialized = false;
    const measure = async () => { last = await this.measureForMemory(memoryLimit); return last; };
    admission = new PodLeaseAdmission({
      status: async () => {
        const raw = await measure();
        if (raw.recommended === null) return raw;
        const ownStart = this.hostLease.selfStart();
        const pendingJobs = raw.pendingJobs ?? [];
        const transferId = process.env.ELANOUS_POD_RESERVED_LEASE;
        const transferIsOther = !!transferId && this.hostLease.reservationIsOther(transferId);
        const others = this.hostLease.live().filter((r) =>
          (r.pid !== process.pid || r.startedAt !== ownStart) && !leaseHasPendingPod(r, pendingJobs)).length;
        const available = Math.max(0, raw.recommended - others + (transferIsOther ? 1 : 0));
        // A repeated stale reading does not mint another permit before an admitted Job is observed.
        // Other tiers and processes share the host lease, which enforces the pool cap before Job apply.
        budget = Math.max(0, budget + available - (initialized ? lastFree : 0));
        initialized = true;
        lastFree = available;
        return { ...raw, recommended: admission.snapshot().active + budget };
      },
      pollMs: this.pollMs,
      dependencyMerged: this.dependencyMerged,
    });
    const entry = { admission, reading: () => last, measure,
      take: () => { budget = Math.max(0, budget - 1); },
      release: () => { if (lastFree > 0) budget = Math.min(lastFree, budget + 1); },
    };
    this.memoryAdmissions.set(memoryLimit, entry);
    return entry;
  }
  /** FIFO gate within this process, then a host lease so independent CLI processes cannot over-admit the same pool. */
  async acquireAdmission(signal?: AbortSignal, after?: PodLeasePredecessor, opts: { gate?: boolean; memoryLimit?: string } = {}): Promise<PodLeaseRelease & { applied: (job: string, context: string, namespace: string) => void; observed: () => void }> {
    const gate = opts.gate === true;
    const lane = !gate && opts.memoryLimit && opts.memoryLimit !== '16Gi' ? this.memoryAdmission(opts.memoryLimit) : null;
    const local = lane ? await lane.admission.acquire(signal, after).then((release) => {
      lane.take();
      let done = false;
      return () => { if (done) return; done = true; lane.release(); release(); };
    }) : await this.acquireLocalAdmission(signal, after, gate);
    try {
      for (;;) {
        if (signal?.aborted) throw new Error('pod lease admission aborted');
        // GATE-ADMIT-EXEMPT: a gate caller is not bounded by its own gate's CPU reservation (memory still bounds it).
        const reading = lane?.reading() ?? (gate ? this.lastUncapped : this.lastRaw);
        const free = reading?.recommended ?? null;
        // Same check as the local gate, but atomic across processes: other authoring and pre-Running leases hold slots.
        const reservedId = process.env.ELANOUS_POD_RESERVED_LEASE;
        const transferred = reservedId ? this.hostLease.claim(reservedId) : null;
        if (reservedId && !transferred) throw new Error('pod lease: authoring reservation could not be transferred');
        if (transferred) delete process.env.ELANOUS_POD_RESERVED_LEASE;
        const pendingJobs = reading?.pendingJobs ?? [];
        const lease = transferred ?? (free !== null && free > 0 ? this.hostLease.tryReserve((others) =>
          others - this.hostLease.live().filter((r) => leaseHasPendingPod(r, pendingJobs) &&
            ((lane || this.memoryAdmissions.size > 0) || r.pid !== process.pid || r.startedAt !== this.hostLease.selfStart())).length < free,
          // The legacy queue accounts for its own permits locally. Mixed memory tiers have separate queues,
          // so their host leases must count together under the same pool cap.
          !!lane || this.memoryAdmissions.size > 0) : (gate && free === null ? this.hostLease.tryReserve(() => true) : null));
        if (lease) {
          let hostReleased = false;
          const releaseHost = () => { if (!hostReleased) { hostReleased = true; lease(); } };
          // GATE-RESERVE-AUTO: an observed Pod (Running or terminal) is in the CPU reading; until then it is subtracted.
          let seen = false, done = false;
          return Object.assign(() => {
            if (done) return;
            done = true;
            if (seen) this.seenActive--;
            releaseHost(); local();
          }, {
            applied: (job: string, context: string, namespace: string) => lease.applied(job, context, namespace),
            observed: () => { if (!seen && !done) { seen = true; this.seenActive++; } releaseHost(); },
          });
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, this.pollMs);
          const onAbort = () => { clearTimeout(timer); reject(new Error('pod lease admission aborted')); };
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        try { if (lane) await lane.measure(); else this.lastRaw = await this.measure(); }
        catch { if (!lane) { this.lastRaw = null; this.lastUncapped = null; } }
      }
    } catch (error) {
      local();
      throw error;
    }
  }
  private acquireLocalAdmission(signal?: AbortSignal, after?: PodLeasePredecessor, gate = false): Promise<PodLeaseRelease> {
    return (gate ? this.gateAdmission : this.admission).acquire(signal, after).then((release) => {
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
  /**
   * LAUNCH-STALL (10-06): members whose total allocatable memory is below one Job's limit can never take it —
   * waiting for them is an endless silent stall (minio 12.5GB vs a 16Gi standard Job). A member whose memory
   * could not be read is not judged unfit (unknown ≠ too small).
   */
  async unfitMembers(limitBytes: number): Promise<Array<{ context: string; allocatableMemoryBytes: number }>> {
    let rows: Array<{ context: string; allocatableMemoryBytes: number | null }>;
    try { rows = await this.memberMemory(); } catch { return []; }
    return rows.flatMap((r) => r.allocatableMemoryBytes !== null && r.allocatableMemoryBytes < limitBytes
      ? [{ context: r.context, allocatableMemoryBytes: r.allocatableMemoryBytes }] : []);
  }
  /** Why admission is still waiting: the pool-wide lease measurement (null before any reading). Slot waits get their reason from tryAcquire's onEmpty. */
  waitReason(memoryLimit?: string): string | null {
    const r = memoryLimit && memoryLimit !== '16Gi' ? this.memoryAdmissions.get(memoryLimit)?.reading() : this.lastRaw;
    if (!r) return null;
    return `recommended=${r.recommended ?? 'unknown'} limitedBy=${r.limitedBy ?? '-'} memorySlots=${r.memorySlots ?? '?'}${r.reason ? ` reason=${r.reason}` : ''}`;
  }
  /** The harness queue by default; `{ gate: true }` reads the gate-caller queue (GATE-ADMIT-EXEMPT). */
  admissionSnapshot(opts: { gate?: boolean } = {}): ReturnType<PodLeaseAdmission['snapshot']> {
    if (opts.gate) return this.gateAdmission.snapshot();
    const snapshots = [this.admission.snapshot(), ...[...this.memoryAdmissions.values()].map((lane) => lane.admission.snapshot())];
    return { active: snapshots.reduce((n, item) => n + item.active, 0), queued: snapshots.reduce((n, item) => n + item.queued, 0),
      recommended: Math.min(this.members.reduce((n, item) => n + item.capacity, 0), snapshots.reduce((n, item) => n + item.recommended, 0)),
      waiting: snapshots.flatMap((item) => item.waiting) };
  }
  /**
   * MINIH-MODE — withhold NEW standard-Job admission while the declared location has no free standard slot.
   * Occupancy = the measured node-c Pods (Running ⊕ Pending; a Pending Pod already holds a slot) ⊕ this process's
   * node-c inflight slots. Nothing here deletes, evicts or re-schedules a Pod: an excess above the location's capacity
   * leaves only as those Pods finish, and until then new admissions wait. `lite` Jobs are not the standard
   * admission this policy gates, and no declared location keeps the configured member capacities.
   */
  private minihHold(kind: PodPlacementKind | null, location: MinihLocation | null, reading: Record<string, MemberOccupancy>): { capacity: number; occupied: number; draining: boolean } | null {
    if (!location || kind === 'lite') return null;
    // A launch pool can contain node-b and WSL beside node-c. Their Pods do not occupy node-c's physical slots.
    const minihMembers = this.members.filter((m) => m.capacity > 0 && (m.sshHost === 'node-c' || m.context === 'pool-node-c'));
    if (minihMembers.length === 0) return null;
    // Lite Jobs also hold a physical node-c slot while running, even though this policy never blocks their admission.
    const inflight = minihMembers.reduce((count, m) => count + (this.inflight.get(m.context) ?? 0), 0);
    // The measurement reports Running and Pending as one occupied count, and decideMinihDrain judges only their sum.
    const occupied = minihMembers
      .reduce((count, m) => count + (reading[m.context]?.occupied ?? 0), inflight);
    const decision = decideMinihDrain(location, occupied);
    return decision.availableSlots > 0 ? null : { capacity: decision.capacity, occupied, draining: decision.drainNewAdmissions };
  }
  /**
   * Pick the member with the largest free share: (capacity − measured cluster occupancy − this process's inflight) / capacity.
   * POOL-SPREAD (10-06): comparing absolute free slots always picked the big member (node-b 25 vs node-c 4), so the small
   * member idled until the big one was full. Comparing the free share fills members in proportion to their capacity.
   * A member whose occupancy could not be read falls back to inflight-only (never treated as zero occupied).
   * `selfCapped` (POOLGLOBAL-REG 10-07): a caller with its own concurrency cap (the release gate) counts only its own Jobs
   * — free = capacity − this scheduler's inflight, summed over members as the pool total — and reads no cluster occupancy.
   * #24253 made every acquire subtract all Running+Pending harness goal Pods, so with ~24 goal Pods on the gate's 25-slot
   * member the 0.2.15 gate launched its shards one at a time.
   * Ties keep the configured member order. Returns null when every readable member is full.
   */
  async tryAcquire(skip?: ReadonlySet<string>, onEmpty?: (reason: string) => void, mode: { selfCapped?: boolean; kind?: PodPlacementKind | null; /** MINIH-MODE: a declared location gates new standard-Job admission (home 1 · external 2). */ minihLocation?: MinihLocation | null; onPlacement?: (placement: PodPlacement) => void; signal?: AbortSignal } = {}): Promise<PodPoolMember | null> {
    const selfCapped = mode.selfCapped === true;
    const kind = mode.kind ?? null;
    const minihLocation = mode.minihLocation ?? null;
    // POOL-LITE: lite goals try the small member first, implementation goals the big one; full → overflow by free share.
    const preferred = new Set(preferredMembers(this.members, kind));
    let reading: Record<string, MemberOccupancy>;
    // A self-capped caller's own Jobs are its inflight; other workloads' Pods are not its slots (no cluster read).
    if (selfCapped) reading = Object.fromEntries(this.members.map((m) => [m.context, { occupied: 0 }]));
    else try { reading = await this.occupancy(); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reading = Object.fromEntries(this.members.map((m) => [m.context, { occupied: null, reason }]));
    }
    // A caller may abandon a slow occupancy read. Never acquire its lease after cancellation.
    if (mode.signal?.aborted) throw mode.signal.reason ?? new Error('pod pool acquisition aborted');
    // MINIH-MODE: only node-c candidates are held. Other pool members retain their own configured capacity.
    // Running/Pending Pods already in the pool stay exactly as they are.
    const minihHeld = this.minihHold(kind, minihLocation, reading);
    const free: Record<string, number> = {};
    const measured: Record<string, boolean> = {};
    let best: { member: PodPoolMember; slots: number; measured: boolean; preferred: boolean } | null = null;
    // A measured member always beats an unmeasured one (its share would read 100% and draw every Job to a node
    // that did not answer); unmeasured members compete only when no measured member has a free slot.
    // Among equally measured members a preferred one (POOL-LITE) beats the rest; then the larger free share wins.
    const better = (cand: { member: PodPoolMember; slots: number; measured: boolean; preferred: boolean }) => !best
      || (cand.measured !== best.measured ? cand.measured
        : cand.preferred !== best.preferred ? cand.preferred
          : cand.slots / cand.member.capacity > best.slots / best.member.capacity);
    for (const m of this.members) {
      // A capacity-0 member is off — never chosen (and no division by zero in the share).
      if (m.capacity <= 0) continue;
      if (minihHeld && (m.sshHost === 'node-c' || m.context === 'pool-node-c')) {
        free[m.context] = 0;
        continue;
      }
      // LAUNCH-STALL: a member this launch cannot fit is skipped for this call only (other launches may fit it).
      if (skip?.has(m.context)) continue;
      const inflight = this.inflight.get(m.context) ?? 0;
      const row = reading[m.context];
      const ok = !!row && row.occupied !== null;
      measured[m.context] = ok;
      const occupied = ok ? row.occupied! : 0;
      const slots = m.capacity - occupied - inflight;
      free[m.context] = slots;
      if (slots <= 0) continue;
      const cand = { member: m, slots, measured: ok, preferred: preferred.has(m.context) };
      if (better(cand)) best = cand;
    }
    if (!best) {
      if (minihHeld) {
        const reason = `node-c 드레인: ${minihLocation} 표준 상한 ${minihHeld.capacity} · 점유 ${minihHeld.occupied}${minihHeld.draining
          ? ' — 초과분이 빠질 때까지 새 입장 보류(기존 Pod 유지)' : ' — 상한이 찼다'}`;
        debug.log('pod.pool', 'node-c-drain-hold', { location: minihLocation, capacity: minihHeld.capacity, occupied: minihHeld.occupied, draining: minihHeld.draining, kind });
        onEmpty?.(reason);
      } else onEmpty?.(`no free slot · free=${JSON.stringify(free)} · measured=${JSON.stringify(measured)}${selfCapped ? ' · selfCapped' : ''}${skip?.size ? ` · skipped=${[...skip].join(',')}` : ''}${kind ? ` · kind=${kind}` : ''}`);
      return null;
    }
    const chosen: { member: PodPoolMember; slots: number; measured: boolean; preferred: boolean } = best;
    this.inflight.set(chosen.member.context, (this.inflight.get(chosen.member.context) ?? 0) + 1);
    const share = Object.fromEntries(this.members.map((m) => [m.context, m.capacity > 0 ? Math.round(Math.max(0, free[m.context] ?? 0) / m.capacity * 100) / 100 : 0]));
    const outcome: PodPlacement['outcome'] = preferred.size === 0 ? 'share' : chosen.preferred ? 'preferred' : 'overflow';
    const pref = [...preferred];
    const why = (c: string) => skip?.has(c) ? 'skipped' : measured[c] === false ? 'unmeasured' : 'full';
    const reason = outcome === 'share'
      ? `${chosen.member.context} · free share ${share[chosen.member.context]}${kind ? ` · ${kind} 골 · 선호 멤버 없음(${this.members.filter((m) => m.capacity > 0).length < 2 ? '단일 멤버' : '상한이 같다'})` : ''}`
      : outcome === 'preferred'
        ? `${chosen.member.context} · ${kind} 골 선호 멤버 · free share ${share[chosen.member.context]}`
        : `${chosen.member.context} · ${kind} 골 넘침 — 선호 ${pref.map((c) => `${c}(${why(c)})`).join(',')} · free share ${share[chosen.member.context]}`;
    const placement: PodPlacement = { member: chosen.member.context, kind, outcome, preferred: pref, reason };
    debug.log('pod.pool', 'member-selected', { member: chosen.member.context, free, measured, share, ...(selfCapped ? { selfCapped: true } : {}), ...(kind ? { kind, outcome, preferred: pref, reason } : {}) });
    // The callback only observes the placement — a throwing observer must not leak the slot it was told about.
    try { mode.onPlacement?.(placement); }
    catch (error) { debug.log('pod.pool', 'placement-observer-failed', { member: chosen.member.context, reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
    return chosen.member;
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

const IMAGE_SHIP_TIMEOUT_MS = 1_800_000;
const REMOTE_RUN_TIMEOUT_MS = 900_000;

/**
 * Runs a shell pipeline in its «own process group» and kills the whole group, not just bash (flood 10-08:
 * 186 orphaned `docker save | gzip | ssh` pipes after runs timed out or died).
 *   - `perl setpgrp` gives the pipeline a group of its own, so `kill 0` cannot reach the caller.
 *   - The pipeline runs in the background and bash `wait`s, because bash defers a trap until a «foreground»
 *     command finishes — a TERM from the spawnSync timeout would otherwise wait out `docker save`.
 *   - A watchdog in the group polls the parent pid: if the caller dies (kill -9 included), the group goes too.
 *   - On a normal finish the group is swept as well (watchdog and its `sleep`).
 * ⚠️ The background pipeline's stdin is /dev/null (non-interactive bash) — fine for `docker save`.
 */
export function runProcessGroupPipeline(pipeline: string, opts: { timeoutMs: number; parentPid?: number; watchIntervalSec?: number }): { status: number | null; stderr: string; timedOut: boolean } {
  const script = [
    `trap 'trap "" TERM HUP INT; kill -TERM 0 2>/dev/null; exit 143' TERM HUP INT`,
    `( while kill -0 "$ELANOUS_PIPE_PARENT" 2>/dev/null; do sleep "$ELANOUS_PIPE_WATCH"; done; kill -TERM 0 2>/dev/null ) &`,
    `( set -o pipefail; eval "$ELANOUS_PIPE_CMD" ) &`,
    'wait $!',
    'rc=$?',
    `trap "" TERM HUP INT`,
    'kill -TERM 0 2>/dev/null',
    'exit $rc',
  ].join('\n');
  const r = spawnSync('perl', ['-e', 'setpgrp(0,0) or die "setpgrp: $!"; exec @ARGV or die "exec: $!"', 'bash', '-c', script], {
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    killSignal: 'SIGTERM',
    env: { ...process.env, ELANOUS_PIPE_CMD: pipeline, ELANOUS_PIPE_PARENT: String(opts.parentPid ?? process.pid), ELANOUS_PIPE_WATCH: String(opts.watchIntervalSec ?? 2) },
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return { status: r.status, stderr: (r.stderr ?? '') + (timedOut ? ` · timed out after ${opts.timeoutMs}ms (process group killed)` : r.error ? ` · ${String(r.error)}` : ''), timedOut };
}

function defaultImageShip(member: PodPoolMember, image: string): { status: number | null; stderr: string } {
  const ship = runProcessGroupPipeline(`docker save ${image} | gzip -1 | ssh -o BatchMode=yes -o ConnectTimeout=10 ${member.sshHost} 'export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$PATH; gunzip | docker load'`, { timeoutMs: IMAGE_SHIP_TIMEOUT_MS });
  return { status: ship.status, stderr: ship.stderr };
}

/** This machine's image ID (`sha256:…` — `docker save | docker load` keeps it). Null when unreadable. */
function defaultLocalImageId(image: string): { status: number | null; stdout: string } {
  const r = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stdout: r.stdout ?? '' };
}

function imageIdFrom(r: { status: number | null; stdout: string }): string | null {
  const v = r.status === 0 ? r.stdout.trim() : '';
  return /^sha256:[0-9a-f]{64}$/.test(v) ? v : null;
}

/** The remote node's image ID. Null when unreadable — never read as «same». */
export function remoteImageId(member: PodPoolMember, image: string, run: RemoteRun = defaultRemoteRun): string | null {
  if (!member.sshHost) return null;
  return imageIdFrom(run(member.sshHost, `docker image inspect ${image} --format '{{.Id}}'`));
}

export function defaultRemoteRun(host: string, script: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, `export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.orbstack/bin:$PATH; unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy; ${script}`], { encoding: 'utf8', timeout: REMOTE_RUN_TIMEOUT_MS });
  return { status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') + (r.error ? String(r.error) : '') };
}

/** 원격 노드의 이미지 판(라벨 `elanous.commit`). 못 읽으면 null. */
export function remoteImageCommit(member: PodPoolMember, image: string, run: RemoteRun = defaultRemoteRun): string | null {
  if (!member.sshHost) return null;
  const r = run(member.sshHost, `docker image inspect ${image} --format '{{index .Config.Labels "elanous.commit"}}'`);
  const v = r.status === 0 ? r.stdout.trim() : '';
  return v && v !== '<no value>' ? v : null;
}

/** Cross-process lock options for one image ship per host (tests shrink them). */
export interface ImageShipLockOptions {
  /** Directory for the per-host lock files. Default = the machine-wide pod lease dir (shared by every universe on this machine). */
  dir?: string;
  retryMs?: number;
  /** A lock older than this is a crash leftover. Default = ship timeout ⊕ import timeout ⊕ 2 min. */
  staleMs?: number;
  maxTries?: number;
}

export function imageShipLockPath(host: string, dir: string = join(hostLeaseBaseDir(), 'image-ship')): string {
  return join(dir, `${host.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'host'}.lock`);
}

/**
 * 원격 노드에 이 기계의 이미지를 보낸다(판이 다를 때만) — `docker save | ssh docker load` ⊕ `k3d image import`.
 * ⛔ Pod 의 elanous 는 이미지 판이다(피드백: Pod 는 main 이 아니라 이미지를 돈다) — 노드마다 판이 다르면 같은 골이 노드마다 다른 코드로 돈다.
 * 🩸 10-08 flood: many runs saw the same stale label at once and all shipped together — ssh refused them
 *   (`Session open refused by peer` · `kex_exchange_identification`). Now:
 *   ① «same image» = commit label OR (label missing) the same image ID on both sides — never ship it twice.
 *   ② one ship per host, under a cross-process lock; whoever gets the lock re-checks and skips if another process shipped.
 *   ③ the ship pipeline runs in its own process group (`runProcessGroupPipeline`).
 */
export function syncPoolImage(member: PodPoolMember, image: string, localCommit: string | null, run: RemoteRun | { run?: RemoteRun; inspect?: LocalImageInspect; inspectId?: LocalImageInspect; transfer?: ImageShip; lock?: ImageShipLockOptions } = defaultRemoteRun): { ok: boolean; action: 'local' | 'fresh' | 'built' | 'shipped' | 'failed'; detail: string } {
  const opts = typeof run === 'function' ? { run } : { run: run.run ?? defaultRemoteRun, inspect: run.inspect, inspectId: run.inspectId, transfer: run.transfer, lock: run.lock };
  const remote = opts.run ?? defaultRemoteRun;
  const inspect = opts.inspect ?? defaultLocalImageInspect;
  // An injected label inspect without an ID inspect = a hermetic caller: the ID check is off (no real docker call).
  const inspectId = opts.inspectId ?? (opts.inspect ? null : defaultLocalImageId);
  const transfer = opts.transfer ?? defaultImageShip;
  if (!member.sshHost) return { ok: true, action: 'local', detail: 'this machine' };
  const host = member.sshHost;
  const before = remoteImageCommit(member, image, remote);
  if (localCommit && before === localCommit) return { ok: true, action: 'fresh', detail: before.slice(0, 12) };
  // 통째 전송은 이 기계 이미지의 커밋 라벨이 목표와 같을 때만. 다르면 낡은 판을 보내지 않는다.
  const here = localImageCommit(image, inspect);
  if (localCommit && here !== localCommit) return { ok: false, action: 'failed', detail: '로컬 이미지 판이 다르다 · 보내지 않음' };
  const localId = inspectId ? imageIdFrom(inspectId(image)) : null;
  /** Fresh = the commit label matches, or the very same image (ID) is already there. Null = not fresh. */
  const freshDetail = (label: string | null): string | null => {
    if (localCommit && label === localCommit) return label.slice(0, 12);
    if (localId && remoteImageId(member, image, remote) === localId) return `same image id ${localId.slice(7, 19)}`;
    return null;
  };
  const sameId = freshDetail(before);
  if (sameId) {
    debug.log('pod.pool', 'image-ship-skipped-same-id', { host, image, localCommit, remoteCommit: before, detail: sameId });
    return { ok: true, action: 'fresh', detail: sameId };
  }

  const lockOpts = opts.lock ?? {};
  const retryMs = lockOpts.retryMs ?? 2_000;
  const staleMs = lockOpts.staleMs ?? IMAGE_SHIP_TIMEOUT_MS + REMOTE_RUN_TIMEOUT_MS + 120_000;
  const lockDir = lockOpts.dir ?? join(hostLeaseBaseDir(), 'image-ship');
  const lockPath = imageShipLockPath(host, lockDir);
  const t0 = Date.now();
  let waited = false;
  let release: () => void;
  try {
    mkdirSync(lockDir, { recursive: true });
    release = acquireLockSync(lockPath, {
      staleMs,
      retryBusyMs: retryMs,
      maxTries: lockOpts.maxTries ?? Math.ceil(staleMs / retryMs) + 10,
      breakDeadHolder: true,
      onWait: (holder) => { waited = true; debug.log('pod.pool', 'image-ship-lock-wait', { host, image, lockPath, holder }); },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debug.log('pod.pool', 'image-ship-lock-failed', { host, image, lockPath, reason }, { level: 'warn' });
    return { ok: false, action: 'failed', detail: `image ship lock: ${reason}` };
  }
  try {
    debug.log('pod.pool', 'image-ship-lock-acquired', { host, image, lockPath, waited, waitedMs: Date.now() - t0 });
    // ⭐ Re-check after the lock: the holder we waited for may have shipped this very image.
    const labelNow = waited ? remoteImageCommit(member, image, remote) : before;
    const fresh = waited ? freshDetail(labelNow) : null;
    if (fresh) {
      debug.log('pod.pool', 'image-ship-skipped-fresh-after-wait', { host, image, localCommit, remoteCommit: labelNow, detail: fresh, waitedMs: Date.now() - t0 });
      return { ok: true, action: 'fresh', detail: `${fresh} (shipped by another process while waiting)` };
    }
    const ship = transfer(member, image);
    if (ship.status !== 0) return { ok: false, action: 'failed', detail: `docker load rc=${ship.status}: ${(ship.stderr ?? '').slice(-300)}` };
    // The import phase gets its own stale window (the lock file's age restarts here).
    try { const now = new Date(); utimesSync(lockPath, now, now); } catch { /* lock gone · finish anyway */ }
    const imp = remote(host, `k3d image import ${image} -c ${member.k3dCluster}`);
    // As in build.sh, only tools-node cleanup errors may follow a nonzero import rc.
    // Ignore informational lines, but reject any other failure line (including WARN and untagged output).
    const failures = imp.stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^(?:INFO|DEBU|DEBUG|TRAC|TRACE)(?:\[|\s|:|$)/.test(line));
    const cleanup = /^(?:(?:ERROR|ERRO|FATAL|FATA|WARNING|WARN|INFO)(?:\[[^\]]*\])?:?\s*)?(?:failed to import images: )?failed to delete tools node '[^']*': (?:Error response from daemon: )?(?:No such container: [A-Za-z0-9_.-]+|removal of container [A-Za-z0-9_.-]+ is already in progress)$/i;
    if (imp.status !== 0 && (failures.length === 0 || !failures.every((line) => cleanup.test(line)))) return { ok: false, action: 'failed', detail: `k3d import rc=${imp.status}: ${imp.stderr.slice(-300)}` };
    const after = remoteImageCommit(member, image, remote);
    return after && (!localCommit || after === localCommit)
      ? { ok: true, action: 'shipped', detail: `${labelNow?.slice(0, 12) ?? '없음'} → ${after.slice(0, 12)}` }
      : { ok: false, action: 'failed', detail: `보낸 뒤 판이 ${after ?? '없음'} — 기대 ${localCommit ?? '?'}` };
  } finally {
    release();
  }
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

/** packedTgz = 풀 동기화가 한 번 만든 패키지 묶음(있으면 build.sh 가 pack 을 다시 하지 않는다). */
type RemoteBuild = (host: string, cluster: string, registry?: string, packedTgz?: string) => Promise<{ ok: boolean; detail: string }>;

/** 같은 트리의 패키지 묶음(tgz)을 «한 번» 만든다 — 멤버들이 같이 쓴다. cleanup 은 동기화가 끝나면 부른다. */
type PoolPack = () => Promise<{ ok: boolean; tgz?: string; detail: string; cleanup?: () => void }>;

function runBuildScript(script: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; detail: string }> {
  return new Promise((done) => {
    const child = spawn('bash', [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 1_800_000);
    child.on('close', (code) => { clearTimeout(timer); done({ ok: code === 0, detail: out.trim().split('\n').slice(-2).join(' · ').slice(0, 300) }); });
  });
}

/**
 * 🩸 2026-10-06: 멤버마다 build.sh 가 같은 트리에서 `bun pm pack` 을 «동시에» 돌렸다 — prepack 이 트리에 쓰는
 * src/version/packed-revision.json 을 다른 쪽 postpack 이 지워 한쪽이 «⛔ pack» 으로 죽었다(node-c 가 매 발사 빠졌다).
 * ⇒ 원격 멤버가 둘 이상이면 pack 은 여기서 한 번만 하고 그 tgz 를 나눠 준다.
 */
function defaultPoolPack(script: string): PoolPack {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-pool-pack-'));
    const tgz = join(dir, 'elanous.tgz');
    const env: NodeJS.ProcessEnv = { ...process.env, ELANOUS_BUILD_PACK_ONLY: tgz };
    delete env.ELANOUS_BUILD_PACKED_TGZ;
    delete env.ELANOUS_BUILD_REMOTE;
    const r = await runBuildScript(script, env);
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    if (!r.ok || !existsSync(tgz)) { cleanup(); return { ok: false, detail: r.detail }; }
    return { ok: true, tgz, detail: r.detail, cleanup };
  };
}

function defaultRemoteBuild(script: string, image: string): RemoteBuild {
  return (host, cluster, registry, packedTgz) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ELANOUS_BUILD_REMOTE: host, ELANOUS_L2_CLUSTER: cluster, ELANOUS_BUILD_IMAGE: image === 'elanous-harness-lite:local' ? 'lite' : 'full' };
    delete env.ELANOUS_BUILD_REGISTRY;
    if (registry) env.ELANOUS_BUILD_REGISTRY = registry;
    delete env.ELANOUS_BUILD_PACK_ONLY;
    delete env.ELANOUS_BUILD_PACKED_TGZ;
    if (packedTgz) env.ELANOUS_BUILD_PACKED_TGZ = packedTgz;
    return runBuildScript(script, env);
  };
}
/**
 * 풀의 원격 노드들을 «동시에» 이 트리의 판으로 맞춘다 (09-25 개선).
 *   1순위 = 노드 «쪽에서» 빌드(build.sh ELANOUS_BUILD_REMOTE) — 빌드 재료(수십 MB)만 보내고 무거운 층은 그 노드의 캐시가 재사용한다.
 *           📏 커밋이 바뀐 뒤 두 노드를 올리는 데 벽시계 55초(종전: 다시 굽기 1분 40초 ⊕ 4GB 차례 전송 5분 48초).
 *   실패하면 = 종전의 통째 전송(syncPoolImage)으로 떨어진다.
 */
export async function syncPoolImages(members: readonly PodPoolMember[], image: string, localCommit: string | null, deps: { run?: RemoteRun; remoteBuild?: RemoteBuild; buildScript?: string | null; ship?: typeof syncPoolImage; localSkillsDigest?: string | null; waitIntervalMs?: number; waitMaxMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; inspect?: LocalImageInspect; transfer?: ImageShip; pack?: PoolPack | null; lock?: ImageShipLockOptions } = {}): Promise<Map<string, PoolImageSync>> {
  const run = deps.run ?? defaultRemoteRun;
  const script = deps.buildScript === undefined ? podImageBuildScript() : deps.buildScript;
  const remoteBuild = deps.remoteBuild ?? (script ? defaultRemoteBuild(script, image) : null);
  // The registry-less build fallback below calls this ship path, including its remote import result check.
  const ship = deps.ship ?? ((m: PodPoolMember, img: string, commit: string | null, remote: RemoteRun) =>
    syncPoolImage(m, img, commit, { run: remote, inspect: deps.inspect, transfer: deps.transfer }));
  const results = new Map<string, PoolImageSync>();
  // pack 한 번 ⊕ 나눠 쓰기 — 원격 멤버가 둘 이상일 때만(하나뿐이면 종전대로 build.sh 가 스스로 pack 한다).
  //   주입된 remoteBuild(시험)에는 진짜 pack 을 붙이지 않는다 — pack 도 주입해야 쓴다.
  const pack = deps.pack !== undefined ? deps.pack : (!deps.remoteBuild && script ? defaultPoolPack(script) : null);
  const sharePack = pack && members.filter((m) => m.sshHost).length >= 2 ? pack : null;
  let packed: ReturnType<PoolPack> | null = null;
  await Promise.all(members.map(async (m) => {
    const t0 = Date.now();
    if (!m.sshHost) { results.set(m.context, { ok: true, action: 'local', detail: 'this machine', ms: 0 }); return; }
    // ⭐ GATE-REGISTRY-IMAGE-FASTPATH (0.2.36 · OP): 레지스트리 커밋 태그의 config label(commit ⊕ pod-skills)이 이번 발사
    //   값과 같으면 노드 Docker 데몬을 «한 번도» 부르지 않고 그 커밋 ref 로 끝난다 — 데몬 조회가 느려도 gate 첫 Pod 이 뜬다.
    //   태그 결손 · label 불일치 · HTTP 오류면 아래 종전 경로(원격 inspect → 노드 빌드 → 통째 전송)가 그대로 판정한다.
    if (localCommit && registryImageLabelsMatch(m, image, localCommit, { ...(deps.localSkillsDigest !== undefined ? { localSkillsDigest: deps.localSkillsDigest } : {}), run })) {
      const imageRef = `${memberRegistry(m)}/${podRegistryImageName(image)}:${podRegistryTag(localCommit)}`;
      debug.log('pod.pool', 'image-fresh-registry-label', { context: m.context, host: m.sshHost, commit: localCommit, imageRef, skills: deps.localSkillsDigest ?? null, waitedMs: 0 });
      results.set(m.context, { ok: true, action: 'fresh', detail: localCommit.slice(0, 12), ms: Date.now() - t0, imageRef });
      return;
    }
    const before = remoteImageCommit(m, image, run);
    const skillsNow = deps.localSkillsDigest;
    const refBefore = registryImageRef(m, localCommit, run, image);
    const hasRegistry = run(m.sshHost, `docker inspect ${memberRegistry(m).split(':')[0]} >/dev/null 2>&1`).status === 0;
    const registrySkillsSame = (ref: string) => skillsNow == null || remoteImageSkillsDigest(m, `localhost:${memberRegistry(m).split(':')[1]}/${ref.slice(ref.indexOf('/') + 1)}`, run) === skillsNow;
    const skillsSame = hasRegistry && refBefore ? registrySkillsSame(refBefore) : skillsNow == null || remoteImageSkillsDigest(m, image, run) === skillsNow;
    if (hasRegistry && refBefore && skillsSame) {
      debug.log('pod.pool', 'image-fresh-registry-tag', { context: m.context, host: m.sshHost, commit: localCommit, localLabel: before, imageRef: refBefore, waitedMs: 0 });
      results.set(m.context, { ok: true, action: 'fresh', detail: localCommit!.slice(0, 12), ms: Date.now() - t0, imageRef: refBefore });
      return;
    }
    if (!hasRegistry && localCommit && before === localCommit && skillsSame) {
      results.set(m.context, { ok: true, action: 'fresh', detail: before.slice(0, 12), ms: Date.now() - t0 });
      return;
    }
    if (remoteBuild) {
      // Build and publish under a separate per-host lock: a failed build can then enter ship's synchronous lock.
      const lockOpts = deps.lock ?? {};
      const lockDir = lockOpts.dir ?? join(hostLeaseBaseDir(), 'image-ship');
      const lockPath = `${imageShipLockPath(m.sshHost, lockDir)}.build`;
      const retryMs = lockOpts.retryMs ?? 2_000;
      const staleMs = lockOpts.staleMs ?? IMAGE_SHIP_TIMEOUT_MS + REMOTE_RUN_TIMEOUT_MS + 120_000;
      const lockStarted = Date.now();
      let b: { ok: boolean; detail: string };
      try {
        mkdirSync(lockDir, { recursive: true });
        // Probe atomically rather than testing path existence: another process can acquire between that test and us.
        let lock;
        let waited = false;
        try { lock = await acquireLockAsync(lockPath, { staleMs, retryBusyMs: 1, maxTries: 1 }); }
        catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('acquireLockAsync: timed out')) throw error;
          waited = true;
          debug.log('pod.pool', 'image-build-lock-wait', { context: m.context, host: m.sshHost, commit: localCommit, localLabel: before, imageRef: refBefore, waitedMs: Date.now() - lockStarted });
          lock = await acquireLockAsync(lockPath, { staleMs, retryBusyMs: retryMs, maxTries: lockOpts.maxTries ?? Math.ceil(staleMs / retryMs) + 10 });
        }
        try {
          if (waited && hasRegistry) {
            const refNow = registryImageRef(m, localCommit, run, image);
            if (refNow && registrySkillsSame(refNow)) {
              debug.log('pod.pool', 'image-build-skipped-after-wait', { context: m.context, host: m.sshHost, commit: localCommit, localLabel: before, imageRef: refNow, waitedMs: Date.now() - lockStarted });
              results.set(m.context, { ok: true, action: 'fresh', imageRef: refNow, detail: `${localCommit?.slice(0, 12)} (built by another process while waiting)`, ms: Date.now() - t0 });
              return;
            }
          }
          // 같은 판이 아닌 멤버가 처음 여기 닿을 때 pack 한다(전부 fresh 면 pack 도 없다).
          const shared = sharePack ? await (packed ??= sharePack()) : null;
          if (shared && !shared.ok) debug.log('self-implement.pod', 'pool-image-pack-failed', { context: m.context, detail: shared.detail });
          b = shared && !shared.ok
            ? { ok: false, detail: shared.detail }
            : lock.stillHeld() ? await remoteBuild(m.sshHost, m.k3dCluster, m.registry, shared?.tgz) : { ok: false, detail: 'image build lock lost' };
          if (!lock.stillHeld()) b = { ok: false, detail: 'image build lock lost' };
        } finally { lock.release(); }
      } catch (error) {
        b = { ok: false, detail: `image build lock: ${error instanceof Error ? error.message : String(error)}` };
      }
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
  })).finally(async () => { if (packed) (await packed).cleanup?.(); });
  return results;
}
