import { describe, expect, test } from 'bun:test';
import { podImageMissingMessage, podImageRegistry, podPoolImageLookup, preparePodImage, resolvePodImageSource } from './pod-image-source.js';
import type { RemoteRun } from './pod-pool.js';

type Member = { context: string; sshHost?: string; registry?: string };

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const TAG = '0123456789ab';
const node-b: Member = { context: 'pool-node-b', sshHost: 'node-b' };
const node-c: Member = { context: 'pool-node-c', sshHost: 'node-c' };

/**
 * 가짜 원격 — 실제 조회 경로(pod-pool 의 `docker inspect <레지스트리>` · `curl localhost:<port>/v2/elanous-harness/tags/list`)를 그대로 받는다.
 * registries: 호스트마다 «레지스트리 컨테이너 이름 → 포트». tags(calls): 지금 그 레지스트리에 있는 태그.
 */
function fakeRemote(registries: Record<string, Record<string, string>>, tags: (lookups: number) => string[]) {
  const scripts: string[] = [];
  let lookups = 0;
  const run: RemoteRun = (host, script) => {
    scripts.push(`${host}: ${script}`);
    const regs = registries[host] ?? {};
    const inspect = /^docker inspect (\S+) /.exec(script);
    if (inspect) return { status: inspect[1]! in regs ? 0 : 1, stdout: '', stderr: '' };
    const curl = /localhost:(\d+)\/v2\/elanous-harness\/tags\/list/.exec(script);
    if (curl) {
      if (!Object.values(regs).includes(curl[1]!)) return { status: 7, stdout: '', stderr: 'connection refused' };
      lookups += 1;
      return { status: 0, stdout: JSON.stringify({ name: 'elanous-harness', tags: tags(lookups) }), stderr: '' };
    }
    return { status: 127, stdout: '', stderr: `unexpected ${script}` };
  };
  return { run, scripts, lookups: () => lookups };
}

function rig(remote: ReturnType<typeof fakeRemote>) {
  const builds: Array<readonly Member[]> = [];
  let clock = 0;
  return {
    builds,
    deps: {
      headPath: async (members: readonly Member[]) => { builds.push(members); return { built: true }; },
      ...podPoolImageLookup(remote.run),
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
      env: {} as NodeJS.ProcessEnv,
    },
  };
}

describe('resolvePodImageSource', () => {
  test('build.sh 와 같은 레지스트리 규칙 · 태그 = 커밋 앞 12자리', () => {
    expect(resolvePodImageSource({ harness: { imageCommit: COMMIT } }, { env: {} })).toMatchObject({ kind: 'pinned', ref: `k3d-elanous-registry:5050/elanous-harness:${TAG}` });
    expect(podImageRegistry({ ELANOUS_FLEET_REGISTRY_PORT: '5051' })).toBe('k3d-elanous-registry:5051');
    expect(podImageRegistry({ ELANOUS_BUILD_REGISTRY: 'k3d-x:6000', ELANOUS_FLEET_REGISTRY_PORT: '5051' })).toBe('k3d-x:6000');
    expect(podImageRegistry({ ELANOUS_BUILD_REGISTRY: '' })).toBe('k3d-elanous-registry:5050');
  });

  test('값이 없거나 커밋 형식이 아니면 head', () => {
    expect(resolvePodImageSource({})).toEqual({ kind: 'head' });
    expect(resolvePodImageSource({ harness: { imageCommit: 'abc' } })).toEqual({ kind: 'head' });
    expect(resolvePodImageSource({ harness: { imageCommit: 'zzzzzzzzzzzzzz' } })).toEqual({ kind: 'head' });
  });
});

describe('preparePodImage — 실제 조회 경로(가짜 원격)', () => {
  test('신호 1: 기준값 ⊕ 레지스트리에 태그 있음 → 굽기 0번 · ref 가 <registry>/elanous-harness:<commit12>', async () => {
    const remote = fakeRemote({ node-b: { 'k3d-elanous-registry': '5050' } }, () => ['latest', TAG]);
    const h = rig(remote);
    const r = await preparePodImage({ cfg: { harness: { imageCommit: COMMIT } }, members: [node-b], ...h.deps });
    expect(h.builds.length).toBe(0);
    expect(r.outcome).toBe('pinned-ready');
    expect(r.source).toMatchObject({ kind: 'pinned', ref: `k3d-elanous-registry:5050/elanous-harness:${TAG}` });
    expect(r.pinned).toEqual([{ ...node-b, imageRef: `k3d-elanous-registry:5050/elanous-harness:${TAG}` }]);
    expect(r.head).toBeNull();
  });

  test('ELANOUS_BUILD_REGISTRY 가 기본과 다르면 조회·Job ref 가 그 주소를 따른다', async () => {
    const remote = fakeRemote({ node-b: { 'k3d-fleet-reg': '6000' } }, () => [TAG]);
    const h = rig(remote);
    const r = await preparePodImage({ cfg: { harness: { imageCommit: COMMIT } }, members: [node-b], ...h.deps, env: { ELANOUS_BUILD_REGISTRY: 'k3d-fleet-reg:6000' } });
    expect(r.outcome).toBe('pinned-ready');
    expect(r.pinned[0]!.imageRef).toBe(`k3d-fleet-reg:6000/elanous-harness:${TAG}`);
    expect(remote.scripts.some((s) => s.includes('localhost:6000/v2/elanous-harness/tags/list'))).toBe(true);
    expect(h.builds.length).toBe(0);
  });

  test('멤버가 레지스트리를 명시했으면 그 주소로 조회한다', async () => {
    const remote = fakeRemote({ node-b: { 'k3d-elanous-registry': '5051' } }, () => [TAG]);
    const h = rig(remote);
    const r = await preparePodImage({ cfg: { harness: { imageCommit: COMMIT } }, members: [{ ...node-b, registry: 'k3d-elanous-registry:5051' }], ...h.deps });
    expect(r.pinned[0]!.imageRef).toBe(`k3d-elanous-registry:5051/elanous-harness:${TAG}`);
  });

  test('신호 2: 기준값 ⊕ 태그 없음(대기 0초) → 굽기 0번 · outcome pinned-missing', async () => {
    const remote = fakeRemote({ node-b: { 'k3d-elanous-registry': '5050' } }, () => ['latest']);
    const h = rig(remote);
    const r = await preparePodImage({ cfg: { harness: { imageCommit: COMMIT } }, members: [node-b], maxWaitMs: 0, ...h.deps });
    expect(h.builds.length).toBe(0);
    expect(r.outcome).toBe('pinned-missing');
    expect(r.waitedMs).toBe(0);
    expect(r.missing).toEqual([{ member: node-b, ref: `k3d-elanous-registry:5050/elanous-harness:${TAG}` }]);
    expect(podImageMissingMessage(r.missing[0]!.ref)).toBe(`기준 이미지 k3d-elanous-registry:5050/elanous-harness:${TAG} 가 레지스트리에 없다 — 레일이 굽기 전이다`);
  });

  test('신호 3: 기준값이 없다 → kind head · 종전 경로를 전 멤버로 한 번 · 조회 0', async () => {
    const remote = fakeRemote({ node-b: { 'k3d-elanous-registry': '5050' } }, () => [TAG]);
    const h = rig(remote);
    const r = await preparePodImage({ cfg: {}, members: [node-b, node-c], ...h.deps });
    expect(r.source.kind).toBe('head');
    expect(r.outcome).toBe('head');
    expect(h.builds).toEqual([[node-b, node-c]]);
    expect(remote.scripts).toEqual([]);
  });

  test('태그가 기다리는 중에 올라오면 pinned-waited · 굽지 않는다', async () => {
    const remote = fakeRemote({ node-b: { 'k3d-elanous-registry': '5050' } }, (n) => (n >= 3 ? [TAG] : []));
    const h = rig(remote);
    const r = await preparePodImage({ cfg: { harness: { imageCommit: COMMIT } }, members: [node-b], pollMs: 1000, maxWaitMs: 60_000, ...h.deps });
    expect(r.outcome).toBe('pinned-waited');
    expect(r.waitedMs).toBe(2000);
    expect(h.builds.length).toBe(0);
  });

  test('레지스트리 없는 멤버(node-c)만 종전 경로 — 풀 발사를 죽이지 않는다', async () => {
    const remote = fakeRemote({ node-b: { 'k3d-elanous-registry': '5050' }, node-c: {} }, () => [TAG]);
    const h = rig(remote);
    const r = await preparePodImage({ cfg: { harness: { imageCommit: COMMIT } }, members: [node-b, node-c], ...h.deps });
    expect(r.outcome).toBe('pinned-ready');
    expect(r.pinned.map((m) => m.context)).toEqual(['pool-node-b']);
    expect(h.builds).toEqual([[node-c]]);
  });

  test('풀이 없으면(로컬) 기준값이 있어도 종전 경로', async () => {
    const remote = fakeRemote({}, () => [TAG]);
    const h = rig(remote);
    const r = await preparePodImage({ cfg: { harness: { imageCommit: COMMIT } }, members: [], ...h.deps });
    expect(r.outcome).toBe('head');
    expect(h.builds).toEqual([[]]);
  });
});
