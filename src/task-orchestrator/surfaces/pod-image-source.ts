/**
 * IMAGE-ONE-SOURCE (대표 2026-10-09 «이미지도 공통 사용·기준값 관리 — 멀티 서버가 같은 곳을 보게»).
 *
 * `--substrate pod` 발사는 지금 «이 트리 HEAD ≠ 노드 이미지»면 그 자리에서 굽는다 — 부모 여럿이 같은 커밋을 동시에 굽고,
 * 노드마다 `:local` 판이 갈렸다. 운영 config `harness.imageCommit`(커밋 12자리 이상)이 있으면 발사는 굽지 않고
 * 레지스트리의 «기준 이미지»(커밋 태그)를 당긴다. 없으면 종전 경로(HEAD 비교·굽기) 그대로다.
 *
 * ⛔ 레지스트리 주소·태그 규칙은 docker/harness/build.sh 의 것이다(새 규칙을 만들지 않는다):
 *   REGISTRY="${ELANOUS_BUILD_REGISTRY:-k3d-elanous-registry:${ELANOUS_FLEET_REGISTRY_PORT:-5050}}" · TAG="${COMMIT:0:12}".
 *   풀 멤버가 `#k3d-레지스트리:포트` 를 명시했으면 그 멤버는 그 주소다(syncPoolImages 가 build.sh 에 넘기는 것과 같다).
 *   조회·Job ref·오류 문구는 전부 «멤버마다 정해진 그 한 주소»를 쓴다.
 * 레지스트리가 있는 풀 멤버는 원격이면 SSH, 로컬이면 이 기계에서 기준 태그를 찾는다.
 * 레지스트리가 없는 멤버(node-c 등)와 조회할 수 없는 로컬 레지스트리는 종전 경로로 간다 — 레지스트리 미러는 범위 밖.
 *   이미지는 표준판(elanous-harness)만 — 이 발사 경로는 lite 를 쓰지 않는다.
 */
import { spawnSync } from 'node:child_process';
import { debug } from '../../debug/log.js';
import { memberHasRegistry, registryImageRef, type RemoteRun } from './pod-pool.js';

const POD_IMAGE = 'elanous-harness';

export type PodImageSource =
  | { readonly kind: 'pinned'; readonly ref: string; readonly commit: string; readonly registry: string }
  | { readonly kind: 'head' };

export type PodImageSourceOutcome = 'pinned-ready' | 'pinned-waited' | 'pinned-missing' | 'head';

/** 기준 이미지가 레지스트리에 올라오기를 기다리는 기본 한도(초). */
export const POD_IMAGE_PIN_WAIT_SEC = 600;
const POD_IMAGE_PIN_POLL_MS = 15_000;

const COMMIT = /^[0-9a-f]{12,40}$/u;

/** `harness.imageCommit` 이 유효한 값인가(커밋 hex 12~40자리). */
export function isPodImageCommit(value: unknown): value is string {
  return typeof value === 'string' && COMMIT.test(value.trim().toLowerCase());
}

/** build.sh:274 와 같은 규칙 — `ELANOUS_BUILD_REGISTRY` 다음 `k3d-elanous-registry:${ELANOUS_FLEET_REGISTRY_PORT:-5050}`. */
export function podImageRegistry(env: NodeJS.ProcessEnv = process.env): string {
  // bash `${X:-d}` 는 빈 문자열도 «없음»으로 본다 — `||` 로 맞춘다.
  return env.ELANOUS_BUILD_REGISTRY || `k3d-elanous-registry:${env.ELANOUS_FLEET_REGISTRY_PORT || '5050'}`;
}

/** build.sh:276 — 태그 = 커밋 앞 12자리. */
export function podImageRef(registry: string, commit: string): string {
  return `${registry}/${POD_IMAGE}:${commit.slice(0, 12)}`;
}

export function resolvePodImageSource(
  cfg: { harness?: { imageCommit?: unknown } } | null | undefined,
  deps: { env?: NodeJS.ProcessEnv } = {},
): PodImageSource {
  const raw = cfg?.harness?.imageCommit;
  if (!isPodImageCommit(raw)) return { kind: 'head' };
  const commit = raw.trim().toLowerCase();
  const registry = podImageRegistry(deps.env ?? process.env);
  return { kind: 'pinned', ref: podImageRef(registry, commit), commit, registry };
}

export function podImageMissingMessage(ref: string): string {
  return `기준 이미지 ${ref} 가 레지스트리에 없다 — 레일이 굽기 전이다`;
}

export interface PodImageMember { readonly context: string; readonly sshHost?: string; readonly registry?: string }

/** 이 멤버가 기준 이미지를 찾을 레지스트리 — 멤버 명시값, 없으면 build.sh 규칙. */
export function memberPinRegistry(member: PodImageMember, source: Extract<PodImageSource, { kind: 'pinned' }>): string {
  return member.registry ?? source.registry;
}

/** 실제 조회 — 원격은 pod-pool 의 SSH 판정, 로컬은 이 기계의 docker/curl 로 조회한다. */
export function podPoolImageLookup(run?: RemoteRun, localRun: (cmd: string, args: readonly string[]) => { status: number | null; stdout: string } = (cmd, args) => {
  const r = spawnSync(cmd, [...args], { encoding: 'utf8', timeout: 10_000 });
  return { status: r.status, stdout: r.stdout ?? '' };
}): {
  hasRegistry: (member: PodImageMember & { context: string }, registry: string) => boolean;
  lookupTag: (member: PodImageMember & { context: string }, registry: string, commit: string) => string | null;
} {
  return {
    hasRegistry: (member, registry) => {
      if (member.sshHost) return memberHasRegistry({ capacity: 0, k3dCluster: '', ...member, registry }, run);
      try { return localRun('docker', ['inspect', registry.split(':')[0]!]).status === 0; }
      catch { return false; }
    },
    lookupTag: (member, registry, commit) => {
      if (member.sshHost) return registryImageRef({ capacity: 0, k3dCluster: '', ...member, registry }, commit, run, `${POD_IMAGE}:local`);
      const port = registry.slice(registry.lastIndexOf(':') + 1);
      const tag = commit.slice(0, 12);
      try {
        const r = localRun('curl', ['-fsS', '--max-time', '5', `http://localhost:${port}/v2/${POD_IMAGE}/tags/list`]);
        if (r.status !== 0) return null;
        const tags = (JSON.parse(r.stdout) as { tags?: string[] }).tags;
        return Array.isArray(tags) && tags.includes(tag) ? podImageRef(registry, commit) : null;
      } catch { return null; }
    },
  };
}

export interface PreparePodImageDeps<M extends PodImageMember, H> {
  readonly cfg: { harness?: { imageCommit?: unknown } } | null | undefined;
  readonly env?: NodeJS.ProcessEnv;
  /** 풀 멤버(풀이 없으면 빈 배열 — 이 기계의 컨텍스트 하나). */
  readonly members: readonly M[];
  /** 종전 경로(HEAD 비교·굽기·노드 동기화). 기준값이 없으면 전 멤버로, 있으면 «기준 이미지를 못 쓰는» 멤버로만 부른다. */
  readonly headPath: (members: readonly M[]) => Promise<H>;
  /** 이 멤버의 노드에 그 레지스트리가 있나. */
  readonly hasRegistry: (member: M, registry: string) => boolean;
  /** 이 멤버의 그 레지스트리에 그 커밋 태그가 있으면 Pod 가 당길 ref, 없으면 null. */
  readonly lookupTag: (member: M, registry: string, commit: string) => string | null;
  readonly maxWaitMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly onWait?: (pending: readonly M[], waitedMs: number) => void;
}

export interface PreparedPodImage<M extends PodImageMember, H> {
  readonly source: PodImageSource;
  readonly outcome: PodImageSourceOutcome;
  /** 기준 이미지를 당기는 멤버 — `imageRef` 가 Job 이미지다. */
  readonly pinned: ReadonlyArray<M & { imageRef: string }>;
  /** 레지스트리는 있는데 한도 안에 태그가 안 올라온 멤버와 그 멤버가 찾던 ref. */
  readonly missing: ReadonlyArray<{ member: M; ref: string }>;
  /** 종전 경로를 탄 멤버(레지스트리 없음 · 로컬 태그 조회 실패). */
  readonly unpinned: readonly M[];
  /** 종전 경로의 결과 — 부르지 않았으면 null. */
  readonly head: H | null;
  readonly waitedMs: number;
}

/**
 * 발사 이미지를 준비한다. 기준값이 없으면 `headPath(members)` 하나만 부른다(종전 동작 그대로).
 * 기준값이 있으면: 레지스트리가 있는 멤버는 태그를 기다려 당기고(굽지 않는다), 나머지 멤버만 종전 경로로 보낸다.
 * 원격 레지스트리 멤버 «전부» 태그가 끝내 없으면 outcome `pinned-missing` — 종전 경로도 부르지 않는다(호출부가 exit 2).
 */
export async function preparePodImage<M extends PodImageMember, H>(deps: PreparePodImageDeps<M, H>): Promise<PreparedPodImage<M, H>> {
  const source = resolvePodImageSource(deps.cfg, { env: deps.env });
  if (source.kind === 'head') {
    return { source, outcome: 'head', pinned: [], missing: [], unpinned: deps.members, head: await deps.headPath(deps.members), waitedMs: 0 };
  }
  const localRefs = new Map<string, string>();
  const registryMembers = deps.members.filter((m) => {
    const registry = memberPinRegistry(m, source);
    if (!deps.hasRegistry(m, registry)) return false;
    if (m.sshHost) return true;
    // A local registry without the requested tag (or an unreadable one) can still use the old build path.
    const ref = deps.lookupTag(m, registry, source.commit);
    if (!ref) return false;
    localRefs.set(m.context, ref);
    return true;
  });
  const unpinned = deps.members.filter((m) => !registryMembers.includes(m));
  if (registryMembers.length === 0) {
    // 기준 이미지를 당길 멤버가 없다(풀 없음 · 레지스트리 없는 멤버뿐) — 종전 경로.
    return { source, outcome: 'head', pinned: [], missing: [], unpinned, head: await deps.headPath(unpinned), waitedMs: 0 };
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const maxWaitMs = Math.max(0, deps.maxWaitMs ?? POD_IMAGE_PIN_WAIT_SEC * 1000);
  const pollMs = Math.max(1, deps.pollMs ?? POD_IMAGE_PIN_POLL_MS);
  const found = new Map<string, string>();
  const t0 = now();
  let pending = registryMembers;
  let slept = false;
  for (;;) {
    pending = pending.filter((m) => {
      const ref = localRefs.get(m.context) ?? deps.lookupTag(m, memberPinRegistry(m, source), source.commit);
      if (ref) found.set(m.context, ref);
      return !ref;
    });
    const waited = now() - t0;
    if (pending.length === 0 || waited >= maxWaitMs) break;
    deps.onWait?.(pending, waited);
    slept = true;
    await sleep(Math.min(pollMs, maxWaitMs - waited));
  }
  const waitedMs = now() - t0;
  const pinned = registryMembers.filter((m) => found.has(m.context)).map((m) => ({ ...m, imageRef: found.get(m.context)! }));
  const missing = pending.map((member) => ({ member, ref: podImageRef(memberPinRegistry(member, source), source.commit) }));
  if (pinned.length === 0) {
    return { source, outcome: 'pinned-missing', pinned, missing, unpinned, head: null, waitedMs };
  }
  return {
    source,
    outcome: slept ? 'pinned-waited' : 'pinned-ready',
    pinned,
    missing,
    unpinned,
    head: unpinned.length > 0 ? await deps.headPath(unpinned) : null,
    waitedMs,
  };
}

/**
 * 기준값 경로의 `image-source` 사건 — 발사 호출부(index.ts)가 부르는 단 하나의 기록처.
 * 이 기계의 로컬 멤버(sshHost 없음)가 기준 이미지를 당겼으면 `local: true` 를 싣는다.
 */
export function logPinnedImageSource<M extends PodImageMember, H>(
  prepared: PreparedPodImage<M, H>,
  ctx: { readonly ref: string; readonly headCommit: string | null },
): void {
  if (prepared.source.kind !== 'pinned') return;
  const local = prepared.pinned.some((m) => !m.sshHost);
  debug.log('self-implement.pod', 'image-source', {
    kind: prepared.source.kind, ref: ctx.ref, pinRef: prepared.source.ref, headCommit: ctx.headCommit, waitedMs: prepared.waitedMs, outcome: prepared.outcome,
    ...(local ? { local: true } : {}),
    pinned: prepared.pinned.map((m) => ({ context: m.context, imageRef: m.imageRef })),
    missing: prepared.missing.map((x) => ({ context: x.member.context, ref: x.ref })),
    unpinned: prepared.unpinned.map((m) => m.context),
  });
}
