import { describe, expect, test } from 'bun:test';
import { checkPodPool, parsePodPool, PodPoolScheduler, resolvePodPoolSpec, syncPoolImage, syncPoolImages, type RemoteRun } from './pod-pool.js';
import { podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';

describe('pod pool — priority ⊕ per-node capacity', () => {
  test('parses context[@ssh][:capacity] in priority order', () => {
    expect(parsePodPool('pool-node-b@node-b:12, k3d-elanous-h1, pool-node-c@node-c:3')).toEqual([
      { context: 'pool-node-b', sshHost: 'node-b', capacity: 12, k3dCluster: 'elanous-pool' },
      { context: 'k3d-elanous-h1', capacity: 2, k3dCluster: 'elanous-h1' },
      { context: 'pool-node-c', sshHost: 'node-c', capacity: 3, k3dCluster: 'elanous-pool' },
    ]);
    expect(() => parsePodPool('a:0')).toThrow('상한은 1 이상');
    expect(() => parsePodPool('a,a')).toThrow('겹친다');
    expect(() => parsePodPool('bad node')).toThrow('못 읽는 노드');
  });

  test('explicit spec wins over env; neither → null (single current context)', () => {
    expect(resolvePodPoolSpec('a:1', { ELANOUS_POD_POOL: 'b:1' }, () => 'c:1')).toBe('a:1');
    expect(resolvePodPoolSpec(undefined, { ELANOUS_POD_POOL: 'b:1' }, () => undefined)).toBe('b:1');
    expect(resolvePodPoolSpec(undefined, {}, () => undefined)).toBeNull();
    expect(resolvePodPoolSpec(undefined, {}, () => 'pool-node-b@node-b:4')).toBe('pool-node-b@node-b:4');   // 설정 pod.pool — «--substrate pod 만» 으로 분배
    expect(resolvePodPoolSpec(undefined, { ELANOUS_POD_POOL: 'b:1' }, () => 'c:1')).toBe('b:1');
  });

  test('fills the first node to capacity before spilling to the next; release reopens a slot', () => {
    const pool = new PodPoolScheduler(parsePodPool('first:2,second:1'));
    const got = [pool.tryAcquire(), pool.tryAcquire(), pool.tryAcquire(), pool.tryAcquire()].map((m) => m?.context ?? null);
    expect(got).toEqual(['first', 'first', 'second', null]);
    pool.release(pool.members[0]!);
    expect(pool.tryAcquire()?.context).toBe('first');
    expect(pool.snapshot()).toEqual({ first: 2, second: 1 });
  });

  test('check drops unreachable nodes with the reason, never silently', () => {
    const kubectl = (args: readonly string[]) => args[1] === 'bad'
      ? { status: 1, stdout: '', stderr: 'Unable to connect to the server: dial tcp: i/o timeout' }
      : { status: 0, stdout: 'elanous-test', stderr: '' };
    const r = checkPodPool(parsePodPool('good:1,bad:1'), kubectl);
    expect(r.ok).toBe(true);
    expect(r.ready.map((m) => m.context)).toEqual(['good']);
    expect(r.dropped).toEqual([{ context: 'bad', reason: 'Unable to connect to the server: dial tcp: i/o timeout' }]);
    expect(checkPodPool(parsePodPool('bad:1'), kubectl).ok).toBe(false);
  });

  test('image sync is a no-op for a local node and for a remote node already on the same commit', () => {
    const run: RemoteRun = () => ({ status: 0, stdout: 'abc123\n', stderr: '' });
    const [local, remote] = parsePodPool('k3d-elanous-h1:1,pool-node-b@node-b:1');
    expect(syncPoolImage(local!, 'img', 'abc123', run)).toMatchObject({ ok: true, action: 'local' });
    expect(syncPoolImage(remote!, 'img', 'abc123', run)).toMatchObject({ ok: true, action: 'fresh' });
  });

  test('every kubectl call of a pooled job carries that node\'s --context, and the slot is released', async () => {
    const calls: string[][] = [];
    const kubectl: Kubectl = (args) => {
      calls.push([...args]);
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const pool = new PodPoolScheduler(parsePodPool('pool-node-b@node-b:1'));
    const spawn = podSelfImplementSpawn({
      kubectl, pool, pollMs: 1, imageCommit: null, sleep: async () => {},
      credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }),
    });
    const done = await spawn({ spaceId: 's1', feature: 'f' } as Parameters<typeof spawn>[0]).done;
    expect(done.exitCode).toBe(0);
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.every((c) => c[0] === '--context' && c[1] === 'pool-node-b')).toBe(true);
    expect(pool.snapshot()).toEqual({ 'pool-node-b': 0 });
  });

  test('remote nodes sync in parallel via node-side build; a failed build falls back to shipping', async () => {
    const labels = new Map<string, string>([['node-b', 'old'], ['node-c', 'old']]);
    const run: RemoteRun = (host, cmd) => (cmd.includes('k3d-elanous-registry') ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: `${labels.get(host)}\n`, stderr: '' });   // 레지스트리 없는 옛 노드
    const started: string[] = [];
    let inFlight = 0, maxInFlight = 0;
    const remoteBuild = async (host: string) => {
      started.push(host); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      if (host === 'node-c') return { ok: false, detail: 'keychain locked' };
      labels.set(host, 'new');
      return { ok: true, detail: 'built' };
    };
    const ship = (m: { sshHost?: string }) => { labels.set(m.sshHost!, 'new'); return { ok: true, action: 'shipped' as const, detail: 'old → new' }; };
    const r = await syncPoolImages(parsePodPool('k3d-elanous-h1:1,pool-node-b@node-b:2,pool-node-c@node-c:1'), 'img', 'new', { run, remoteBuild, ship, waitMaxMs: 0 });
    expect(maxInFlight).toBe(2);                       // 동시에
    expect(r.get('k3d-elanous-h1')?.action).toBe('local');
    expect(r.get('pool-node-b')).toMatchObject({ ok: true, action: 'built' });
    expect(r.get('pool-node-c')).toMatchObject({ ok: true, action: 'shipped' });
    expect(r.get('pool-node-c')!.detail).toContain('keychain locked');
    const again = await syncPoolImages(parsePodPool('pool-node-b@node-b:2'), 'img', 'new', { run, remoteBuild, ship });
    expect(again.get('pool-node-b')?.action).toBe('fresh');   // 같은 판이면 아무것도 안 한다
  });

  // 델타(대표 2026-09-26): 레지스트리 노드는 «커밋 ⊕ 스킬 해시 ⊕ 레지스트리 태그»가 다 맞아야 fresh — 셋 중 하나라도 어긋나면 다시 굽는다.
  test('registry node: fresh only when commit, skills digest and registry tag all match; Pod gets the registry ref', async () => {
    const state = { commit: 'new', skills: 'sk1', tags: [] as string[] };
    const run: RemoteRun = (_host, cmd) => {
      if (cmd.includes('docker inspect k3d-elanous-registry')) return { status: 0, stdout: '', stderr: '' };
      if (cmd.includes('/tags/list')) return { status: 0, stdout: JSON.stringify({ tags: state.tags }), stderr: '' };
      if (cmd.includes('elanous.pod-skills')) return { status: 0, stdout: `${state.skills}\n`, stderr: '' };
      return { status: 0, stdout: `${state.commit}\n`, stderr: '' };
    };
    let builds = 0;
    const remoteBuild = async () => { builds++; state.tags = ['new']; state.skills = 'sk2'; return { ok: true, detail: 'built' }; };
    const members = parsePodPool('pool-node-b@node-b:2');
    const r1 = await syncPoolImages(members, 'img', 'new', { run, remoteBuild, localSkillsDigest: 'sk2' });
    expect(r1.get('pool-node-b')).toMatchObject({ action: 'built', imageRef: 'k3d-elanous-registry:5050/elanous-harness:new' });
    const r2 = await syncPoolImages(members, 'img', 'new', { run, remoteBuild, localSkillsDigest: 'sk2' });
    expect(r2.get('pool-node-b')).toMatchObject({ action: 'fresh', imageRef: 'k3d-elanous-registry:5050/elanous-harness:new' });
    const r3 = await syncPoolImages(members, 'img', 'new', { run, remoteBuild, localSkillsDigest: 'sk3' });   // 스킬만 바뀌었다
    expect(r3.get('pool-node-b')?.action).toBe('built');
    expect(builds).toBe(2);
  });
  // 🩸 2026-09-26(🅣): 동시 발사가 가변 태그 `:local` 을 남의 판으로 덮어도, 레지스트리에 «이 판 커밋 태그»가 있으면 노드를 빼지 않는다.
  test('concurrent launches overwrite :local — a registry commit tag still counts as synced', async () => {
    const state = { local: 'old', tags: [] as string[] };
    const run: RemoteRun = (_host, cmd) => {
      if (cmd.includes('docker inspect k3d-elanous-registry')) return { status: 0, stdout: '', stderr: '' };
      if (cmd.includes('/tags/list')) return { status: 0, stdout: JSON.stringify({ tags: state.tags }), stderr: '' };
      if (cmd.includes('elanous.pod-skills')) return { status: 0, stdout: 'sk\n', stderr: '' };
      return { status: 0, stdout: `${state.local}\n`, stderr: '' };
    };
    let shipped = 0;
    const ship = () => { shipped++; return { ok: false, action: 'failed' as const, detail: 'shipped' }; };
    // 내 빌드는 레지스트리에 `mine` 태그를 올렸지만, 그사이 남의 빌드가 `:local` 을 `other` 로 덮었다
    const remoteBuild = async () => { state.tags = ['mine', 'other']; state.local = 'other'; return { ok: true, detail: 'built' }; };
    const r = await syncPoolImages(parsePodPool('pool-node-b@node-b:2'), 'img', 'mine', { run, remoteBuild, ship, localSkillsDigest: 'sk' });
    expect(r.get('pool-node-b')).toMatchObject({ ok: true, action: 'built', imageRef: 'k3d-elanous-registry:5050/elanous-harness:mine' });
    expect(shipped).toBe(0);
    // 대조군: 레지스트리에 내 태그가 없으면(빌드가 안 올렸다) 종전대로 통째 전송으로 떨어진다
    const state2Build = async () => { state.tags = ['other']; state.local = 'other'; return { ok: true, detail: 'built' }; };
    const r2 = await syncPoolImages(parsePodPool('pool-node-b@node-b:2'), 'img', 'mine', { run, remoteBuild: state2Build, ship, localSkillsDigest: 'sk' });
    expect(r2.get('pool-node-b')?.ok).toBe(false);
    expect(shipped).toBe(1);
  });

  // 동시 발사: 노드 쪽 빌드가 부딪혀 실패해도, 같은 판을 굽는 첫째가 레지스트리에 태그를 올리면 그 판을 쓴다.
  test('failed node build waits for the concurrent registry tag and does not ship', async () => {
    const target = 'b95a3c071f5c';
    let lookups = 0;
    const run: RemoteRun = (_host, cmd) => {
      if (cmd.includes('docker inspect k3d-elanous-registry')) return { status: 0, stdout: '', stderr: '' };
      if (cmd.includes('/tags/list')) { lookups++; return { status: 0, stdout: JSON.stringify({ tags: lookups >= 2 ? [target.slice(0, 12)] : [] }), stderr: '' }; }
      if (cmd.includes('elanous.pod-skills')) return { status: 0, stdout: 'sk\\n', stderr: '' };
      return { status: 0, stdout: 'old\\n', stderr: '' };
    };
    let shipped = 0;
    const ship = () => { shipped++; return { ok: true, action: 'shipped' as const, detail: 'should not ship' }; };
    const remoteBuild = async () => ({ ok: false, detail: '⛔ pack' });
    const r = await syncPoolImages(parsePodPool('pool-node-b@node-b:2'), 'img', target, { run, remoteBuild, ship, localSkillsDigest: 'sk', waitIntervalMs: 1, waitMaxMs: 5_000 });
    expect(r.get('pool-node-b')).toMatchObject({ ok: true, action: 'built', imageRef: `k3d-elanous-registry:5050/elanous-harness:${target.slice(0, 12)}`, detail: '동시 빌드 결과 사용' });
    expect(shipped).toBe(0);
    expect(lookups).toBeGreaterThanOrEqual(2);
  });

  // 빌드가 성공하면 레지스트리 태그를 기다리지 않고 즉시 끝난다.
  test('a successful node build returns immediately without waiting', async () => {
    let lookups = 0;
    const run: RemoteRun = (_host, cmd) => {
      if (cmd.includes('docker inspect k3d-elanous-registry')) return { status: 0, stdout: '', stderr: '' };
      if (cmd.includes('/tags/list')) { lookups++; return { status: 0, stdout: JSON.stringify({ tags: ['new'] }), stderr: '' }; }
      if (cmd.includes('elanous.pod-skills')) return { status: 0, stdout: 'sk\\n', stderr: '' };
      return { status: 0, stdout: 'new\\n', stderr: '' };
    };
    let waited = false;
    const sleep = async () => { waited = true; };
    const remoteBuild = async () => ({ ok: true, detail: 'built' });
    const r = await syncPoolImages(parsePodPool('pool-node-b@node-b:2'), 'img', 'new', { run, remoteBuild, localSkillsDigest: 'sk', sleep, waitIntervalMs: 1, waitMaxMs: 5_000 });
    expect(r.get('pool-node-b')).toMatchObject({ ok: true, action: 'built' });
    expect(waited).toBe(false);
    expect(lookups).toBe(2);   // 발사 전 1번 ⊕ 빌드 직후 1번. 대기 폴링은 없다.
  });

  test('whole-image ship only when this machine label matches the target commit', () => {
    const member = parsePodPool('pool-node-b@node-b:1')[0]!;
    const run: RemoteRun = (_host, cmd) => {
      if (cmd.includes('k3d image import')) return { status: 0, stdout: '', stderr: '' };
      if (cmd.includes('elanous.commit')) return { status: 0, stdout: remoteLabel, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    let remoteLabel = 'old';
    let saves = 0;
    const transfer = () => { saves++; remoteLabel = 'targetcommit'; return { status: 0, stderr: '' }; };
    const mismatched = syncPoolImage(member, 'elanous-harness:local', 'targetcommit', { run, inspect: () => ({ status: 0, stdout: 'othercommit' }), transfer });
    expect(mismatched).toMatchObject({ ok: false, action: 'failed', detail: '로컬 이미지 판이 다르다 · 보내지 않음' });
    expect(saves).toBe(0);

    // 대조군: 이 기계 라벨이 목표와 같으면 통째 전송을 한 번 한다.
    const matched = syncPoolImage(member, 'elanous-harness:local', 'targetcommit', { run, inspect: () => ({ status: 0, stdout: 'targetcommit' }), transfer });
    expect(matched.action).toBe('shipped');
    expect(saves).toBe(1);
  });

  test('build failure with no registry tag and a mismatched local commit ships nothing; a match ships once', async () => {
    const target = 'b95a3c071f5c';
    const run: RemoteRun = (_host, cmd) => {
      if (cmd.includes('docker inspect k3d-elanous-registry')) return { status: 0, stdout: '', stderr: '' };
      if (cmd.includes('/tags/list')) return { status: 0, stdout: JSON.stringify({ tags: [] }), stderr: '' };
      if (cmd.includes('elanous.pod-skills')) return { status: 0, stdout: 'sk', stderr: '' };
      if (cmd.includes('k3d image import')) return { status: 0, stdout: '', stderr: '' };
      if (cmd.includes('elanous.commit')) return { status: 0, stdout: remoteLabel, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const remoteBuild = async () => ({ ok: false, detail: 'pack-fail' });
    let remoteLabel = 'old';
    let saves = 0;
    const transfer = () => { saves++; remoteLabel = target; return { status: 0, stderr: '' }; };
    const mismatched = await syncPoolImages(parsePodPool('pool-node-b@node-b:2'), 'elanous-harness:local', target, {
      run, remoteBuild, localSkillsDigest: 'sk', waitIntervalMs: 1, waitMaxMs: 0, transfer,
      inspect: () => ({ status: 0, stdout: '30f95cf1aaaa' }),
    });
    expect(mismatched.get('pool-node-b')).toMatchObject({ ok: false, action: 'failed' });
    expect(mismatched.get('pool-node-b')!.detail).toContain('로컬 이미지 판이 다르다 · 보내지 않음');
    expect(saves).toBe(0);

    const matched = await syncPoolImages(parsePodPool('pool-node-b@node-b:2'), 'elanous-harness:local', target, {
      run, remoteBuild, localSkillsDigest: 'sk', waitIntervalMs: 1, waitMaxMs: 0, transfer,
      inspect: () => ({ status: 0, stdout: target }),
    });
    expect(matched.get('pool-node-b')?.action).toBe('shipped');
    expect(saves).toBe(1);
  });
});
