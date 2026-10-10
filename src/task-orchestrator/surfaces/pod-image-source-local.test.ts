import { describe, expect, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { logPinnedImageSource, podPoolImageLookup, preparePodImage } from './pod-image-source.js';
import { podImageFreshness } from './self-implement-pod.js';
import type { RemoteRun } from './pod-pool.js';

const commit = 'cf9d035fc48f' + 'a'.repeat(28);
const member = { context: 'k3d-elanous-pool', capacity: 40, k3dCluster: 'elanous-pool' };
const ref = 'k3d-elanous-registry:5050/elanous-harness:cf9d035fc48f';

function localRig(registry: boolean, tags: string[] | null, throws = false) {
  const calls: Array<[string, readonly string[]]> = [];
  const headCalls: Array<readonly typeof member[]> = [];
  const remote: RemoteRun = () => { throw new Error('local member must not use SSH'); };
  const localRun = (cmd: string, args: readonly string[]) => {
    calls.push([cmd, args]);
    if (throws) throw new Error('registry unreadable');
    if (cmd === 'docker') return { status: registry ? 0 : 1, stdout: '' };
    if (cmd === 'curl') return { status: tags === null ? 7 : 0, stdout: JSON.stringify({ tags }) };
    throw new Error(`unexpected ${cmd}`);
  };
  const launch = () => preparePodImage({
    cfg: { harness: { imageCommit: commit } }, env: {}, members: [member],
    headPath: async (members: readonly typeof member[]) => { headCalls.push(members); return { built: true }; },
    ...podPoolImageLookup(remote, localRun),
  });
  return { launch, calls, headCalls };
}

describe('local pool member pinned image', () => {
  test('local registry with the commit tag pulls the pinned image without the HEAD/build path', async () => {
    const rig = localRig(true, ['latest', commit.slice(0, 12)]);
    const result = await rig.launch();
    expect(result.outcome).toBe('pinned-ready');
    expect(result.pinned).toEqual([{ ...member, imageRef: ref }]);
    expect(result.head).toBeNull();
    expect(rig.headCalls).toHaveLength(0);
    expect(rig.calls).toEqual([
      ['docker', ['inspect', 'k3d-elanous-registry']],
      ['curl', ['-fsS', '--max-time', '5', 'http://localhost:5050/v2/elanous-harness/tags/list']],
    ]);
  });

  test('absent or unreadable local registry falls back once without pinned-missing', async () => {
    for (const rig of [localRig(false, []), localRig(true, null), localRig(true, []), localRig(true, [], true)]) {
      const result = await rig.launch();
      expect(result.outcome).toBe('head');
      expect(result.missing).toEqual([]);
      expect(result.unpinned).toEqual([member]);
      expect(rig.headCalls).toEqual([[member]]);
    }
  });

  test('mixed pool keeps a remote pinned member while a local registry miss takes the HEAD path', async () => {
    const localCalls: string[] = [];
    const remoteCalls: string[] = [];
    const sshMember = { context: 'remote', sshHost: 'node-b' };
    const lookup = podPoolImageLookup((_host, script) => {
      remoteCalls.push(script);
      return { status: 0, stdout: script.startsWith('curl') ? JSON.stringify({ tags: [commit.slice(0, 12)] }) : '', stderr: '' };
    }, (cmd) => { localCalls.push(cmd); return { status: 1, stdout: '' }; });
    const headCalls: unknown[] = [];
    const result = await preparePodImage({ cfg: { harness: { imageCommit: commit } }, env: {}, members: [member, sshMember],
      headPath: async (members) => { headCalls.push(members); return 'built-local'; }, ...lookup });
    expect(result.outcome).toBe('pinned-ready');
    expect(result.pinned).toEqual([{ ...sshMember, imageRef: ref }]);
    expect(result.unpinned).toEqual([member]);
    expect(headCalls).toEqual([[member]]);
    expect(localCalls).toEqual(['docker']);
    expect(remoteCalls).toHaveLength(2);
  });

  test('without a pin both local and remote members take the original HEAD path without registry queries', async () => {
    const lookup = podPoolImageLookup(() => { throw new Error('SSH must not run'); }, () => { throw new Error('local probe must not run'); });
    const remote = { context: 'remote', sshHost: 'node-b' };
    const calls: unknown[] = [];
    const result = await preparePodImage({ cfg: {}, members: [member, remote], headPath: async (members) => { calls.push(members); return 'head'; }, ...lookup });
    expect(result.outcome).toBe('head');
    expect(calls).toEqual([[member, remote]]);
  });

  test('remote registry lookup still uses SSH and waits/misses rather than building', async () => {
    const scripts: string[] = [];
    const remote: RemoteRun = (_host, script) => {
      scripts.push(script);
      return { status: 0, stdout: script.startsWith('curl') ? JSON.stringify({ tags: [] }) : '', stderr: '' };
    };
    const sshMember = { context: 'remote', sshHost: 'node-b' };
    let built = 0;
    const result = await preparePodImage({ cfg: { harness: { imageCommit: commit } }, env: {}, members: [sshMember],
      headPath: async () => { built++; return null; }, ...podPoolImageLookup(remote, () => { throw new Error('local probe on remote'); }), maxWaitMs: 0 });
    expect(result.outcome).toBe('pinned-missing');
    expect(result.missing).toEqual([{ member: sshMember, ref }]);
    expect(built).toBe(0);
    expect(scripts).toEqual([
      'docker inspect k3d-elanous-registry >/dev/null 2>&1',
      'curl -fsS --max-time 5 http://localhost:5050/v2/elanous-harness/tags/list 2>/dev/null',
    ]);
  });

  test('image-source event from a local pinned launch carries outcome pinned-ready and local: true; remote-only and head carry no local', async () => {
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'image-source-local-regression', emit: (record) => events.push({ category: record.category, event: record.event, data: record.data as Record<string, unknown> }) });
    try {
      const local = await localRig(true, [commit.slice(0, 12)]).launch();
      logPinnedImageSource(local, { ref, headCommit: commit });
      const remoteRun: RemoteRun = (_host, script) => ({ status: 0, stdout: script.startsWith('curl') ? JSON.stringify({ tags: [commit.slice(0, 12)] }) : '', stderr: '' });
      const remote = await preparePodImage({ cfg: { harness: { imageCommit: commit } }, env: {}, members: [{ context: 'remote', sshHost: 'node-b' }],
        headPath: async () => null, ...podPoolImageLookup(remoteRun, () => { throw new Error('local probe on remote'); }) });
      logPinnedImageSource(remote, { ref, headCommit: commit });
      const head = await preparePodImage({ cfg: {}, members: [member], headPath: async () => null, ...podPoolImageLookup() });
      logPinnedImageSource(head, { ref: '', headCommit: null });
    } finally { off(); }
    const seen = events.filter((e) => e.category === 'self-implement.pod' && e.event === 'image-source');
    expect(seen).toHaveLength(2);
    expect(seen[0]!.data).toMatchObject({ kind: 'pinned', outcome: 'pinned-ready', local: true, ref, pinned: [{ context: member.context, imageRef: ref }] });
    expect(seen[1]!.data).toMatchObject({ kind: 'pinned', outcome: 'pinned-ready', pinned: [{ context: 'remote', imageRef: ref }] });
    expect('local' in seen[1]!.data).toBe(false);
  });
});

describe('unreadable Pod skill set', () => {
  const label = '1aef3a5a79db3635';
  const run = (head: string, have = label) => (cmd: string, args: readonly string[]) => ({ status: 0,
    stdout: cmd === 'git' ? `${head}\n` : args.at(-1)?.includes('elanous.pod-skills') ? `${have}\n` : `${commit}\n` });

  test('none and empty digest are unreadable, not changed; one pod-skills-unread event records the image label', () => {
    const events: Array<{ category: string; event: string; data: unknown }> = [];
    const off = debug.registerSink({ name: 'pod-skills-unread-local-regression', emit: (record) => events.push({ category: record.category, event: record.event, data: record.data }) });
    try {
      for (const want of ['none', '']) {
        events.length = 0;
        expect(podImageFreshness({ run: run(commit), skillsDigest: () => want }).fresh).toBe(true);
        expect(events.filter((e) => e.event === 'pod-skills-unread')).toEqual([{ category: 'self-implement.pod', event: 'pod-skills-unread', data: expect.objectContaining({ have: label }) }]);
      }
    } finally { off(); }
  });

  test('a real digest mismatch remains stale, and unreadable skills do not override a stale commit', () => {
    expect(podImageFreshness({ run: run(commit), skillsDigest: () => 'another-digest' })).toMatchObject({ fresh: false, reason: expect.stringContaining('Pod 스킬 세트가 바뀌었다') });
    expect(podImageFreshness({ run: run('different-head'), skillsDigest: () => 'none' })).toMatchObject({ fresh: false, reason: expect.stringContaining('≠ HEAD') });
  });
});
