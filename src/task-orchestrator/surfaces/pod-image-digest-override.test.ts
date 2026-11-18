// TA-IMAGE-PIN-OVERRIDES-COMMIT — 명시 이미지 digest 는 config 의 전역 harness.imageCommit 을 덮어쓴다.
// 2026-11-18 파일럿 ① 재현: --image-digest(83933f91 이미지)를 줬는데도 런이 config imageCommit(2b233c5f7783) 태그를 host-b 레지스트리에서 600초 기다리다 죽었다.
// 기대값은 제품이 아니라 이 파일의 리터럴(digest·ref·커밋)이다.
import { expect, test } from 'bun:test';
import { podImageMissingMessage, preparePodImage, resolvePodImageSource, type PodImageMember } from './pod-image-source.js';

const DIGEST = `sha256:${'d'.repeat(64)}`;
const OTHER = `sha256:${'e'.repeat(64)}`;
const REGISTRY = 'k3d-elanous-registry:5050';
const CFG_COMMIT = '2b233c5f7783';
const hostB: PodImageMember = { context: 'pool-host-b', sshHost: 'host-b' };
const minim5: PodImageMember = { context: 'pool-minim5', sshHost: 'minim5' };
const noRegistry: PodImageMember = { context: 'pool-bare' };

interface Probe { tagLookups: number; digestLookups: number; headCalls: number; overrides: Array<{ digest: string; configCommit: string | null }> }
function harness(options: { cfgCommit?: string; digestHits?: Record<string, { commit: string | null }>; tagHits?: readonly string[]; hasRegistry?: (m: PodImageMember) => boolean }) {
  const probe: Probe = { tagLookups: 0, digestLookups: 0, headCalls: 0, overrides: [] };
  let clock = 0;
  const deps = {
    cfg: options.cfgCommit ? { harness: { imageCommit: options.cfgCommit } } : {},
    env: { ELANOUS_BUILD_REGISTRY: REGISTRY } as NodeJS.ProcessEnv,
    headPath: async () => { probe.headCalls += 1; return 'head' as const; },
    hasRegistry: (m: PodImageMember) => (options.hasRegistry ? options.hasRegistry(m) : m.sshHost !== undefined),
    lookupTag: (m: PodImageMember, registry: string, commit: string) => { probe.tagLookups += 1; return options.tagHits?.includes(`${m.context}:${commit}`) ? `${registry}/elanous-harness:${commit}` : null; },
    lookupDigest: (m: PodImageMember, registry: string, digest: string) => { probe.digestLookups += 1; const hit = options.digestHits?.[`${m.context}:${digest}`]; return hit ? { ref: `${registry}/elanous-harness@${digest}`, commit: hit.commit } : null; },
    onOverride: (info: { digest: string; configCommit: string | null }) => { probe.overrides.push(info); },
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
  };
  return { deps, probe };
}

test('판정표 1 — digest 만(config 없음): digest ref 로 당기고 이미지 커밋 라벨을 읽는다 · 종전 굽기 경로 0', async () => {
  const { deps, probe } = harness({ digestHits: { [`pool-host-b:${DIGEST}`]: { commit: '83933f9106b9c831ccf5500d12c9e3725d77d3a0' } } });
  const r = await preparePodImage({ ...deps, members: [hostB], explicitDigest: DIGEST });
  expect(r.outcome).toBe('pinned-ready');
  expect(r.pinned).toEqual([{ ...hostB, imageRef: `${REGISTRY}/elanous-harness@${DIGEST}` }]);
  expect(r.source).toMatchObject({ kind: 'pinned', digest: DIGEST, commit: '83933f9106b9c831ccf5500d12c9e3725d77d3a0' });
  expect(probe.headCalls).toBe(0);
});

test('판정표 2 — digest ∧ config imageCommit(그 태그는 이 레지스트리에 없음): digest 가 이긴다 · 태그를 기다리지 않는다 · override 사건 1(파일럿 ① 재현)', async () => {
  const { deps, probe } = harness({ cfgCommit: CFG_COMMIT, digestHits: { [`pool-host-b:${DIGEST}`]: { commit: null } } });
  const r = await preparePodImage({ ...deps, members: [hostB], explicitDigest: DIGEST });
  expect(r.outcome).toBe('pinned-ready');
  expect(r.waitedMs).toBe(0);
  expect(r.pinned[0]!.imageRef).toBe(`${REGISTRY}/elanous-harness@${DIGEST}`);
  expect(probe.tagLookups).toBe(0);
  expect(probe.overrides).toEqual([{ digest: DIGEST, configCommit: CFG_COMMIT }]);
});

test('판정표 3 — digest 가 레지스트리에 없다: 30초 안에 pinned-missing(600초 대기 아님) · 메시지에 digest 와 «config imageCommit 안 씀»', async () => {
  const { deps } = harness({ cfgCommit: CFG_COMMIT, digestHits: {} });
  const r = await preparePodImage({ ...deps, members: [hostB], explicitDigest: DIGEST });
  expect(r.outcome).toBe('pinned-missing');
  expect(r.waitedMs).toBe(30_000);
  expect(r.pinned).toEqual([]);
  expect(r.missing.map((x) => x.ref)).toEqual([`${REGISTRY}/elanous-harness@${DIGEST}`]);
  expect(podImageMissingMessage(r.missing[0]!.ref)).toContain('지정한 digest 이미지');
  expect(podImageMissingMessage(r.missing[0]!.ref)).toContain('config imageCommit 은 이 발사에서 쓰지 않는다');
});

test('판정표 4 — 멤버 둘 중 하나만 digest 보유: 보유 멤버만 pinned · 나머지는 missing 에(풀에서 빠짐)', async () => {
  const { deps } = harness({ digestHits: { [`pool-minim5:${DIGEST}`]: { commit: null } } });
  const r = await preparePodImage({ ...deps, members: [hostB, minim5], explicitDigest: DIGEST });
  expect(r.outcome).toBe('pinned-waited');
  expect(r.pinned.map((m) => m.context)).toEqual(['pool-minim5']);
  expect(r.missing.map((x) => x.member.context)).toEqual(['pool-host-b']);
});

test('판정표 5 — 레지스트리가 없는 멤버는 굽지 않는다: pin 을 지킬 수 없으니 head 경로 0 · missing 에 적힘', async () => {
  const { deps, probe } = harness({ digestHits: { [`pool-host-b:${DIGEST}`]: { commit: null } } });
  const r = await preparePodImage({ ...deps, members: [hostB, noRegistry], explicitDigest: DIGEST });
  expect(r.pinned.map((m) => m.context)).toEqual(['pool-host-b']);
  expect(r.unpinned.map((m) => m.context)).toEqual(['pool-bare']);
  expect(r.missing.map((x) => x.member.context)).toEqual(['pool-bare']);
  expect(r.head).toBeNull();
  expect(probe.headCalls).toBe(0);
});

test('판정표 6 — 형식 불량 digest 는 조용히 config 경로로 떨어지지 않고 던진다', async () => {
  const { deps } = harness({ cfgCommit: CFG_COMMIT });
  for (const bad of ['latest', 'sha256:abc', `${DIGEST}\n`, ` ${DIGEST}`, DIGEST.toUpperCase().replace('SHA256', 'sha256')]) {
    await expect(preparePodImage({ ...deps, members: [hostB], explicitDigest: bad })).rejects.toThrow(/형식 불량/);
  }
  expect(() => resolvePodImageSource({}, { explicitDigest: 'x' })).toThrow(/형식 불량/);
});

test('판정표 7 — 회귀: digest 없이 config imageCommit 만이면 종전 태그 경로(태그를 찾고 override 사건 0)', async () => {
  const { deps, probe } = harness({ cfgCommit: CFG_COMMIT, tagHits: [`pool-host-b:${CFG_COMMIT}`] });
  const r = await preparePodImage({ ...deps, members: [hostB] });
  expect(r.outcome).toBe('pinned-ready');
  expect(r.pinned[0]!.imageRef).toBe(`${REGISTRY}/elanous-harness:${CFG_COMMIT}`);
  expect(probe.digestLookups).toBe(0);
  expect(probe.overrides).toEqual([]);
});
