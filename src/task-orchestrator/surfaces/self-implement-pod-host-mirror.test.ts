import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { getUserConfig, saveUserConfig } from '../../user-config.js';
import { podJobManifest, podJobName, podSelfImplementSpawn, type Kubectl, type PodSpawnOptions } from './self-implement-pod.js';
import type { PodSource } from './pod-source-receive.js';
import { podSourceScript } from './pod-source-receive.js';

const base = { name: 'si-test', namespace: 'test', image: 'image', repoUrl: 'https://example.invalid/r', args: [], passEnv: [], deadlineSeconds: 60 };
const creds = () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'test' });
const bundle: PodSource = { kind: 'bundle', bundlePath: '/tmp/source.bundle', sha256: 'a'.repeat(64), sizeBytes: 10, headCommit: 'b'.repeat(40) };

function fakeLaunch(logs: string) {
  const applied: Array<Record<string, any>> = [];
  const calls: string[] = [];
  const kubectl: Kubectl = (args, input) => {
    const command = args.join(' ');
    calls.push(command);
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
    if (command.includes('jsonpath={.metadata.uid} ')) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (command.endsWith('apply -f -') && input) applied.push(JSON.parse(input));
    if (args.includes('pods')) return { status: 0, stdout: 'si-test-pod Running\n', stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: logs, stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const launch = async (options: Partial<PodSpawnOptions> = {}, spaceId = 'mirror-source') => {
    const result = await podSelfImplementSpawn({ kubectl, credentials: creds, env: {}, sleep: async () => {}, ...options })({ feature: 'x', spaceId }).done;
    expect(result.exitCode).toBe(0);
    return applied.filter((entry) => entry.kind === 'Job').at(-1)!;
  };
  return { applied, calls, launch };
}

describe('Pod host mirror Job wiring', () => {
  test('without a mirror, the complete Job spec is identical to an explicitly disabled mirror', () => {
    const original = podJobManifest(base);
    expect(podJobManifest({ ...base, hostMirror: undefined })).toEqual(original);
    const pod = (original as any).spec.template.spec;
    expect(pod.volumes).toEqual([{ name: 'creds', secret: { secretName: 'si-test-creds', defaultMode: 0o400 } }]);
    expect(pod.containers[0].volumeMounts).toEqual([{ name: 'creds', mountPath: '/creds', readOnly: true }]);
    expect(pod.volumes.some((volume: { name: string }) => volume.name === 'host-mirror')).toBe(false);
  });

  test('enabled mirror mounts a Directory hostPath read-only and leaves other Job spec fields intact', () => {
    const original = podJobManifest(base) as any;
    const enabled = podJobManifest({ ...base, hostMirror: '/srv/git/mirror.git' }) as any;
    const spec = enabled.spec.template.spec;
    expect(spec.volumes).toEqual([
      original.spec.template.spec.volumes[0],
      { name: 'host-mirror', hostPath: { path: '/srv/git/mirror.git', type: 'Directory' } },
    ]);
    expect(spec.containers[0].volumeMounts).toEqual([
      original.spec.template.spec.containers[0].volumeMounts[0],
      { name: 'host-mirror', mountPath: '/host-mirror', readOnly: true },
    ]);
    spec.volumes.pop();
    spec.containers[0].volumeMounts.pop();
    expect(enabled).toEqual(original);
  });

  test('pod.hostMirror config survives parse and save, and the existing spawn reads it with env/option precedence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-host-mirror-config-'));
    try {
      const file = join(dir, 'config.json');
      writeFileSync(file, JSON.stringify({ pod: { hostMirror: ' /srv/config-mirror ' } }));
      const config = getUserConfig(file);
      expect(config.pod?.hostMirror).toBe('/srv/config-mirror');
      saveUserConfig(config, file);
      expect(JSON.parse(readFileSync(file, 'utf8')).pod.hostMirror).toBe('/srv/config-mirror');
      const run = fakeLaunch('ELANOUS_POD_SOURCE_VIA mirror\n{"stage":"merged","ok":true}\n');
      const configHostMirror = () => getUserConfig(file).pod?.hostMirror;
      const configured = await run.launch({ configHostMirror }, 'configured');
      expect(configured.spec.template.spec.volumes[1].hostPath.path).toBe('/srv/config-mirror');
      const env = await run.launch({ configHostMirror, env: { ELANOUS_POD_HOST_MIRROR: '/srv/env-mirror' } }, 'env-mirror');
      expect(env.spec.template.spec.volumes[1].hostPath.path).toBe('/srv/env-mirror');
      const explicit = await run.launch({ configHostMirror, env: { ELANOUS_POD_HOST_MIRROR: '/srv/env-mirror' }, hostMirror: '/srv/option-mirror' }, 'option-mirror');
      expect(explicit.spec.template.spec.volumes[1].hostPath.path).toBe('/srv/option-mirror');
      const disabled = await run.launch({ configHostMirror: () => undefined, env: {} }, 'disabled-mirror');
      expect(disabled.spec.template.spec.volumes).toHaveLength(1);
      expect(disabled.spec.template.spec.containers[0].volumeMounts).toHaveLength(1);
      const off = await run.launch({ configHostMirror, hostMirror: '  ', env: { ELANOUS_POD_HOST_MIRROR: '/srv/env-mirror' } }, 'explicit-off');
      expect(off.spec.template.spec.volumes).toHaveLength(1);
      expect(() => podSelfImplementSpawn({ hostMirror: 'relative/path', kubectl: () => ({ status: 0, stdout: '', stderr: '' }), env: {} })).toThrow('absolute directory path');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('bundle delivery keeps cp/ready after Job creation and full child logs report source-via image or clone', async () => {
    const events: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-host-mirror-source-via-test', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'source-via') events.push(record.data as Record<string, unknown>);
    } });
    try {
      const bundled = fakeLaunch('{"stage":"merged","ok":true}\n');
      const job = await bundled.launch({ source: bundle, hostMirror: '/srv/mirror.git' }, 'bundle-mirror');
      const script: string = job.spec.template.spec.containers[0].args[0];
      expect(script).toContain("git clone -q --shared -- '/host-mirror' repo");
      const jobAt = bundled.calls.map((call, index) => call.endsWith('apply -f -') ? index : -1).filter((index) => index >= 0).at(1)!;
      const cpAt = bundled.calls.findIndex((call) => call.includes(' cp ') && call.includes('/tmp/source.bundle'));
      expect(cpAt).toBeGreaterThan(jobAt);
      expect(bundled.calls.some((call) => call.includes('exec') && call.includes('touch /tmp/source.ready'))).toBe(true);
      const mirrored = fakeLaunch('ELANOUS_POD_SOURCE_VIA mirror\n{"stage":"merged","ok":true}\n');
      await mirrored.launch({ hostMirror: '/srv/mirror.git' }, 'mirror-source');
      const image = fakeLaunch('ELANOUS_POD_SOURCE_VIA image\nELANOUS_POD_SOURCE_DELTA mirror\n{"stage":"merged","ok":true}\n');
      await image.launch({ hostMirror: '/srv/mirror.git' }, 'image-source');
      const imageSkip = fakeLaunch('ELANOUS_POD_SOURCE_IMAGE_SKIP pin-objects-mismatch\nELANOUS_POD_SOURCE_VIA mirror\n{"stage":"merged","ok":true}\n');
      await imageSkip.launch({ hostMirror: '/srv/mirror.git' }, 'image-skip-source');
      const fallback = fakeLaunch('ELANOUS_POD_SOURCE_VIA github\n{"stage":"merged","ok":true}\n');
      await fallback.launch({}, 'github-source');
      const skipped = fakeLaunch('ELANOUS_POD_SOURCE_MIRROR_SKIP no-mount\nELANOUS_POD_SOURCE_VIA github\n{"stage":"merged","ok":true}\n');
      await skipped.launch({}, 'skip-source');
      const bogus = fakeLaunch('ELANOUS_POD_SOURCE_MIRROR_SKIP made-up\nELANOUS_POD_SOURCE_VIA github\n{"stage":"merged","ok":true}\n');
      await bogus.launch({}, 'bogus-skip-source');
      const jobs = new Set(['mirror-source', 'image-source', 'image-skip-source', 'github-source', 'skip-source', 'bogus-skip-source'].map(podJobName));
      const ownEvents = events.filter((event) => jobs.has(event.job as string));
      expect(ownEvents).toEqual([
        expect.objectContaining({ job: podJobName('mirror-source'), via: 'mirror' }),
        expect.objectContaining({ job: podJobName('image-source'), via: 'image', delta: 'mirror' }),
        expect.objectContaining({ job: podJobName('image-skip-source'), via: 'mirror', imageSkip: 'pin-objects-mismatch' }),
        expect.objectContaining({ job: podJobName('github-source'), via: 'github' }),
        expect.objectContaining({ job: podJobName('skip-source'), via: 'github', mirrorSkip: 'no-mount' }),
        expect.objectContaining({ job: podJobName('bogus-skip-source'), via: 'github' }),
      ]);
      // No SKIP line (mirror, plain github, unknown reason) → no mirrorSkip key at all.
      expect(Object.keys(ownEvents[0]!)).not.toContain('mirrorSkip');
      expect(Object.keys(ownEvents[3]!)).not.toContain('mirrorSkip');
      expect(Object.keys(ownEvents[5]!)).not.toContain('mirrorSkip');
    } finally { off(); }
  });
});

// TA-POD-WARMBOOT-PARITY — the si-task Job carries today's Pod prescriptions: the result marker (#27815) and the mirror seed (#27805).
describe('si-task Job result marker and mirror seed', () => {
  const SHA = 'c'.repeat(40);
  const markerOf = (token: string, rc: number) => `\n__ELANOUS_POD_DONE__ ${token} rc=${rc}\n`;

  /** Fake kubectl: the Job condition appears only at poll `conditionAt` (never when null); `tail(token)` is the `--tail=2` read. */
  function markerLaunch(o: { conditionAt: number | null; tail: (token: string) => { status: number; stdout: string }; full: (token: string) => string; existing?: { runId: string; script: string } }) {
    const calls: string[] = [];
    const jobs: Array<Record<string, any>> = [];
    let token = '';
    let polls = 0;
    const kubectl: Kubectl = (args, input) => {
      const command = args.join(' ');
      calls.push(command);
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (command.includes('jsonpath={.metadata.uid} ')) {
        if (!o.existing) return { status: 1, stdout: '', stderr: 'NotFound' };
        token = o.existing.runId;
        return { status: 0, stdout: '0a1b2c3d-0000-4000-8000-000000000001 ', stderr: '' };
      }
      if (o.existing && args.includes('job') && args.includes('json') && args.includes('get')) {
        return { status: 0, stdout: JSON.stringify({ metadata: { annotations: {} }, spec: { template: { spec: { containers: [{ name: 'child', args: [o.existing.script], env: [{ name: 'ELANOUS_RUN_ID', value: o.existing.runId }], resources: { limits: { memory: '8Gi' } } }] } } } }), stderr: '' };
      }
      if (command.endsWith('apply -f -') && input) {
        const manifest = JSON.parse(input);
        if (manifest.kind === 'Job') {
          jobs.push(manifest);
          token = manifest.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
        }
      }
      if (args.includes('pods')) return { status: 0, stdout: 'si-test-pod Running\n', stderr: '' };
      if (args.includes('logs') && args.includes('--tail=2')) return { stderr: '', ...o.tail(token) };
      if (args.includes('logs')) return { status: 0, stdout: o.full(token), stderr: '' };
      if (args.includes('get') && args.includes('job') && command.includes('status.conditions[*].type')) {
        polls++;
        if (polls > 50) throw new Error('wait loop did not end');
        return { status: 0, stdout: o.conditionAt !== null && polls >= o.conditionAt ? 'Complete' : '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    return { kubectl, calls, jobs, get token() { return token; }, get polls() { return polls; } };
  }

  function events(name: string, withSkipped = false) {
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name, emit: (record) => {
      if (record.category === 'self-implement.pod' && (record.event === 'result-marker-early' || record.event === 'mirror-seed' || (withSkipped && record.event === 'mirror-seed-skipped'))) seen.push({ event: record.event, data: record.data as Record<string, unknown> });
    } });
    return { seen, off };
  }

  test('the marker line is the child script\'s last line before `exit $rc`, and every other Job byte is unchanged', () => {
    const original = podJobManifest(base) as any;
    const line = `printf '\\n%s rc=%s\\n' '__ELANOUS_POD_DONE__ run-abc' "$rc"`;
    const marked = podJobManifest({ ...base, resultMarkerLine: line }) as any;
    const lines: string[] = marked.spec.template.spec.containers[0].args[0].split('\n');
    expect(lines.slice(-2)).toEqual([line, 'exit $rc']);
    marked.spec.template.spec.containers[0].args[0] = lines.filter((entry) => entry !== line).join('\n');
    expect(marked).toEqual(original);
    expect(podJobManifest({ ...base, resultMarkerLine: undefined })).toEqual(original);
  });

  test('① the marker before the condition ends the wait early with that rc, and the marker is not child output', async () => {
    const run = markerLaunch({ conditionAt: null, tail: (t) => ({ status: 0, stdout: markerOf(t, 0).slice(1) }), full: (t) => `{"stage":"pr-opened","ok":true}\n${markerOf(t, 0)}` });
    const seen = events('si-marker-early-test');
    try {
      const result = await podSelfImplementSpawn({ kubectl: run.kubectl, credentials: creds, env: {}, sleep: async () => {}, resultMarker: true })({ feature: 'x', spaceId: 'marker-early' }).done;
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain('__ELANOUS_POD_DONE__');
      expect(run.jobs[0]!.spec.template.spec.containers[0].args[0]).toContain(`'__ELANOUS_POD_DONE__ ${run.token}' "$rc"`);
      expect(run.polls).toBe(1);
      expect(seen.seen).toEqual([{ event: 'result-marker-early', data: expect.objectContaining({ job: podJobName('marker-early'), rc: 0 }) }]);
    } finally { seen.off(); }
    const failed = markerLaunch({ conditionAt: null, tail: (t) => ({ status: 0, stdout: markerOf(t, 3).slice(1) }), full: (t) => `{"stage":"implement","ok":false,"error":"boom"}\n${markerOf(t, 3)}` });
    const result = await podSelfImplementSpawn({ kubectl: failed.kubectl, credentials: creds, env: {}, sleep: async () => {}, resultMarker: true })({ feature: 'x', spaceId: 'marker-failed' }).done;
    expect(result.exitCode).toBe(1);
    expect(failed.polls).toBe(1);
  });

  test('② without a marker the wait stays on the condition as before', async () => {
    const run = markerLaunch({ conditionAt: 3, tail: () => ({ status: 0, stdout: 'ELANOUS_RUN_LEDGER_NONE\n{"stage":"pr-opened","ok":true}\n' }), full: () => '{"stage":"pr-opened","ok":true}\n' });
    const seen = events('si-marker-none-test');
    try {
      const result = await podSelfImplementSpawn({ kubectl: run.kubectl, credentials: creds, env: {}, sleep: async () => {}, resultMarker: true })({ feature: 'x', spaceId: 'marker-none' }).done;
      expect(result.exitCode).toBe(0);
      expect(run.polls).toBe(3);
      expect(seen.seen).toEqual([]);
    } finally { seen.off(); }
    // Pending Pod (tail read fails) changes nothing either.
    const pending = markerLaunch({ conditionAt: 2, tail: () => ({ status: 1, stdout: '' }), full: () => '{"stage":"pr-opened","ok":true}\n' });
    expect((await podSelfImplementSpawn({ kubectl: pending.kubectl, credentials: creds, env: {}, sleep: async () => {}, resultMarker: true })({ feature: 'x', spaceId: 'marker-pending' }).done).exitCode).toBe(0);
    expect(pending.polls).toBe(2);
    // Default with an injected kubectl: no marker line, no tail read — the existing fake-kubectl call order is untouched.
    const off = markerLaunch({ conditionAt: 1, tail: () => { throw new Error('tail read without marker'); }, full: () => '{"stage":"pr-opened","ok":true}\n' });
    await podSelfImplementSpawn({ kubectl: off.kubectl, credentials: creds, env: {}, sleep: async () => {} })({ feature: 'x', spaceId: 'marker-off' }).done;
    expect(off.jobs[0]!.spec.template.spec.containers[0].args[0]).not.toContain('__ELANOUS_POD_DONE__');
    expect(off.calls.some((call) => call.includes('--tail=2'))).toBe(false);
  });

  test('③ another launch\'s marker and a bare marker word are ignored', async () => {
    let n = 0;
    const tails = [markerOf('run-other-launch', 0).slice(1), '__ELANOUS_POD_DONE__ rc=0\n', '__ELANOUS_POD_DONE__\n'];
    const run = markerLaunch({ conditionAt: 4, tail: () => ({ status: 0, stdout: tails[n++ % tails.length]! }), full: () => '{"stage":"pr-opened","ok":true}\n' });
    const seen = events('si-marker-other-test');
    try {
      const result = await podSelfImplementSpawn({ kubectl: run.kubectl, credentials: creds, env: {}, sleep: async () => {}, resultMarker: true })({ feature: 'x', spaceId: 'marker-other' }).done;
      expect(result.exitCode).toBe(0);
      expect(run.polls).toBe(4);
      expect(n).toBe(3);
      expect(seen.seen).toEqual([]);
    } finally { seen.off(); }
  });

  test('⑤ reattaching a Job: the tail read is armed only when that Job\'s own script carries this run\'s marker line', async () => {
    const runId = 'run-reattach-0001';
    const markerLine = `printf '\\n%s rc=%s\\n' '__ELANOUS_POD_DONE__ ${runId}' "$rc"`;
    // A Job made before the marker: no tail read at all — the wait stays on the condition.
    const old = markerLaunch({ conditionAt: 2, tail: () => { throw new Error('tail must not be read for a pre-marker Job'); }, full: () => '{"stage":"pr-opened","ok":true}\n', existing: { runId, script: 'echo child\nexit $rc' } });
    const r1 = await podSelfImplementSpawn({ kubectl: old.kubectl, credentials: creds, env: {}, sleep: async () => {}, resultMarker: true })({ feature: 'x', spaceId: 'reattach-old' }).done;
    expect(r1.exitCode).toBe(0);
    expect(old.calls.some((call) => call.includes('--tail=2'))).toBe(false);
    // A Job that prints this run's marker: the early end applies.
    const marked = markerLaunch({ conditionAt: null, tail: (t) => ({ status: 0, stdout: markerOf(t, 0).slice(1) }), full: (t) => `{"stage":"pr-opened","ok":true}\n${markerOf(t, 0)}`, existing: { runId, script: `echo child\n${markerLine}\nexit $rc` } });
    const r2 = await podSelfImplementSpawn({ kubectl: marked.kubectl, credentials: creds, env: {}, sleep: async () => {}, resultMarker: true })({ feature: 'x', spaceId: 'reattach-new' }).done;
    expect(r2.exitCode).toBe(0);
    expect(marked.polls).toBe(1);
  });

  test('⑥ a seed that throws synchronously still applies the Job', async () => {
    const pool = { tryAcquire: () => ({ context: 'test-context', sshHost: 'node-b', capacity: 2 }), release: () => {}, snapshot: () => ({}) };
    const run = fakeLaunch('{"stage":"pr-opened","ok":true}\n');
    const job = await run.launch({ pool: pool as never, source: { kind: 'commit', sha: SHA }, hostMirror: '/srv/mirror.git',
      seedMirror: (() => { throw new Error('sync boom'); }) as never }, 'mirror-seed-sync-throw');
    expect(job.kind).toBe('Job');
  });

  test('④ the mirror seed runs once before the Job for a commit-pinned source; a failed seed still applies the Job', async () => {
    const pool = { tryAcquire: () => ({ context: 'test-context', sshHost: 'node-b', capacity: 2 }), release: () => {}, snapshot: () => ({}) };
    for (const outcome of ['ok', 'failed', 'threw'] as const) {
      const run = fakeLaunch('{"stage":"pr-opened","ok":true}\n');
      const seeds: Array<{ host: string; commit: string; callsBefore: number }> = [];
      const seen = events(`si-mirror-seed-${outcome}-test`, true);
      try {
        const job = await run.launch({ pool: pool as never, source: { kind: 'commit', sha: SHA }, hostMirror: '/srv/mirror.git', mirrorSeedCwd: '/tmp/tree',
          seedMirror: async ({ host, commit, cwd }) => {
            expect(cwd).toBe('/tmp/tree');
            seeds.push({ host, commit, callsBefore: run.calls.length });
            if (outcome === 'threw') throw new Error('ssh down');
            return { host, ok: outcome === 'ok', ms: 5, ...(outcome === 'failed' ? { detail: 'push rejected' } : {}) };
          } }, `mirror-seed-${outcome}`);
        expect(job.kind).toBe('Job');
        expect(seeds).toEqual([{ host: 'node-b', commit: SHA, callsBefore: expect.any(Number) }]);
        const applies = run.calls.map((call, index) => call.endsWith('apply -f -') ? index : -1).filter((index) => index >= 0);
        expect(applies).toHaveLength(2);   // Secret, then Job
        expect(applies[0]!).toBeLessThan(seeds[0]!.callsBefore);
        expect(applies[1]!).toBeGreaterThanOrEqual(seeds[0]!.callsBefore);
        expect(seen.seen).toEqual([{ event: 'mirror-seed', data: expect.objectContaining({ host: 'node-b', commit: SHA, ok: outcome === 'ok' }) }]);
      } finally { seen.off(); }
    }
    // No mirror, a PR source, or (with an injected kubectl) no head resolver for a default source: no seed — one skipped line naming why.
    let called = 0;
    const seedMirror = async () => { called++; return undefined; };
    const skipped = events('si-mirror-seed-skipped-test', true);
    try {
      await fakeLaunch('{"stage":"pr-opened","ok":true}\n').launch({ pool: pool as never, hostMirror: '/srv/mirror.git', seedMirror }, 'mirror-seed-default-source');
      await fakeLaunch('{"stage":"pr-opened","ok":true}\n').launch({ pool: pool as never, source: { kind: 'commit', sha: SHA }, seedMirror }, 'mirror-seed-no-mirror');
      await fakeLaunch('{"stage":"pr-opened","ok":true}\n').launch({ pool: pool as never, source: { kind: 'pr', number: 7 }, hostMirror: '/srv/mirror.git', seedMirror }, 'mirror-seed-pr');
      await fakeLaunch('{"stage":"pr-opened","ok":true}\n').launch({ hostMirror: '/srv/mirror.git', seedMirror }, 'mirror-seed-no-pool');
      await fakeLaunch('{"stage":"pr-opened","ok":true}\n').launch({ pool: pool as never, hostMirror: '/srv/mirror.git' }, 'mirror-seed-no-seeder');
      expect(called).toBe(0);
      expect(skipped.seen).toEqual([
        { event: 'mirror-seed-skipped', data: expect.objectContaining({ reason: 'no-head-resolver', sourceKind: 'default', host: 'node-b' }) },
        { event: 'mirror-seed-skipped', data: expect.objectContaining({ reason: 'no-host-mirror', sourceKind: 'commit' }) },
        { event: 'mirror-seed-skipped', data: expect.objectContaining({ reason: 'source-pr', sourceKind: 'pr' }) },
        { event: 'mirror-seed-skipped', data: expect.objectContaining({ reason: 'no-ssh-host', sourceKind: 'default' }) },
        { event: 'mirror-seed-skipped', data: expect.objectContaining({ reason: 'no-seeder', sourceKind: 'default' }) },
      ]);
    } finally { skipped.off(); }
  });

  test('⑦ SI-SEED-DEFAULT: a default source resolves the branch tip once and seeds that sha before the Job; a miss skips with its reason and the Job still applies', async () => {
    const pool = { tryAcquire: () => ({ context: 'test-context', sshHost: 'node-b', capacity: 2 }), release: () => {}, snapshot: () => ({}) };
    const HEAD = 'c'.repeat(40);
    for (const outcome of ['resolved', 'unresolved', 'threw', 'not-a-sha'] as const) {
      const run = fakeLaunch('{"stage":"pr-opened","ok":true}\n');
      const resolves: Array<{ repoUrl: string; base?: string; cwd: string }> = [];
      const seeds: Array<{ host: string; commit: string; cwd: string; callsBefore: number }> = [];
      const seen = events(`si-seed-default-${outcome}-test`, true);
      try {
        const job = await run.launch({ pool: pool as never, hostMirror: '/srv/mirror.git', mirrorSeedCwd: '/tmp/tree', repoUrl: 'https://example.invalid/r',
          resolveSourceHead: async (o) => {
            resolves.push(o);
            if (outcome === 'threw') throw new Error('ls-remote hung');
            return outcome === 'resolved' ? { sha: HEAD, originCalls: 1 } : outcome === 'not-a-sha' ? { sha: 'HEAD' } : { reason: 'ls-remote-failed' };
          },
          seedMirror: async ({ host, commit, cwd }) => { seeds.push({ host, commit, cwd, callsBefore: run.calls.length }); return { host, ok: true, ms: 3 }; } }, `seed-default-${outcome}`);
        expect(job.kind).toBe('Job');
        expect(resolves).toEqual([{ repoUrl: 'https://example.invalid/r', cwd: '/tmp/tree' }]);
        if (outcome === 'resolved') {
          expect(seeds).toEqual([{ host: 'node-b', commit: HEAD, cwd: '/tmp/tree', callsBefore: expect.any(Number) }]);
          const script = job.spec.template.spec.containers[0].args[0] as string;
          expect(script).toContain(`ELANOUS_POD_SOURCE_BASE_SHA_UNAVAILABLE %s\\n' '${HEAD}`);
          expect(script).toContain(`git -C repo fetch --quiet --no-write-fetch-head '/host-mirror' '${HEAD}'`);
          expect(script).not.toContain('git ls-remote --symref origin HEAD');
          expect(script).not.toContain('git fetch --depth 50 origin HEAD');
          const applies = run.calls.map((call, index) => call.endsWith('apply -f -') ? index : -1).filter((index) => index >= 0);
          expect(applies[1]!).toBeGreaterThanOrEqual(seeds[0]!.callsBefore);   // seeded before the Job is applied
          expect(seen.seen).toEqual([{ event: 'mirror-seed', data: expect.objectContaining({ host: 'node-b', commit: HEAD, sourceKind: 'default', sourceBaseSha: HEAD, ok: true }) }]);
        } else {
          expect(seeds).toEqual([]);
          const reason = outcome === 'threw' ? 'default-head-resolve-threw' : outcome === 'not-a-sha' ? 'default-head-unresolved' : 'default-head-ls-remote-failed';
          expect(seen.seen).toEqual([{ event: 'mirror-seed-skipped', data: expect.objectContaining({ reason, sourceKind: 'default', host: 'node-b' }) }]);
        }
      } finally { seen.off(); }
    }
    // A non-main base reaches the resolver as that branch, before any Job is applied. (The Job itself then checks the base on
    // origin — `example.invalid` has none, so the launch may end there; only the resolver call is measured here.)
    const based: Array<{ base?: string; jobsBefore: number }> = [];
    const baseRun = fakeLaunch('{"stage":"pr-opened","ok":true}\n');
    await Promise.resolve(baseRun.launch({ pool: pool as never, hostMirror: '/srv/mirror.git', source: { kind: 'default', base: 'bench/x' },
      resolveSourceHead: async (o) => { based.push({ base: o.base, jobsBefore: baseRun.applied.filter((e) => e.kind === 'Job').length }); return { reason: 'x' }; },
      seedMirror: async () => undefined }, 'seed-default-base')).catch(() => undefined);
    expect(based).toEqual([{ base: 'bench/x', jobsBefore: 0 }]);
  }, 30_000);

  test('host default-source resolver origin calls are joined to the Pod source IO summary', async () => {
    const run = fakeLaunch('ELANOUS_POD_SOURCE_IO {"originCalls":0,"checkoutFiles":0,"sourceVia":"mirror","sourceSeconds":1,"sourceStatus":"complete","pushCalls":null,"installRan":null,"installSeconds":null}\n{"stage":"pr-opened","ok":true}\n');
    const pool = { tryAcquire: () => ({ context: 'test-context', sshHost: 'node-b', capacity: 2 }), release: () => {}, snapshot: () => ({}) };
    const ioRows: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'si-source-io-host-origin-count-test', emit: (record) => {
      if (record.category === 'pod.source' && record.event === 'io-summary') ioRows.push(record.data as Record<string, unknown>);
    } });
    try {
      await run.launch({ pool: pool as never, hostMirror: '/srv/mirror.git', mirrorSeedCwd: '/tmp/tree',
        resolveSourceHead: async () => ({ sha: 'c'.repeat(40), originCalls: 1 }),
        seedMirror: async ({ host }) => ({ host, ok: true, ms: 1 }) }, 'source-io-host-origin-count');
      expect(ioRows).toHaveLength(1);
      expect(ioRows[0]).toMatchObject({ hostOriginCalls: 1, originCalls: 0, sourceVia: 'mirror' });
    } finally { off(); }
  }, 15_000);
});

describe('Pod host mirror raw-SHA fetch (real git, production upload-pack settings)', () => {
  test('an exact-SHA fetch from a push-seeded bare host mirror checks out the parent-resolved SHA with no refs and no branch route', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-host-mirror-raw-'));
    try {
      const work = join(root, 'work');
      const mirror = join(root, 'mirror.git');
      const job = join(root, 'job');
      mkdirSync(work); mkdirSync(job);
      execFileSync('git', ['init', '-q', '-b', 'main', work]);
      execFileSync('git', ['-C', work, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', work, 'config', 'user.name', 'pod']);
      writeFileSync(join(work, 'README'), 'base\n');
      execFileSync('git', ['-C', work, 'add', 'README']);
      execFileSync('git', ['-C', work, 'commit', '-qm', 'base']);
      writeFileSync(join(work, 'NEXT'), 'next\n');
      execFileSync('git', ['-C', work, 'add', 'NEXT']);
      execFileSync('git', ['-C', work, 'commit', '-qm', 'next']);
      const baseSha = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      // 프로덕션 미러 구성: bare 저장소를 push 전송으로 심는다 — upload-pack 기본 설정, 어떤 uploadpack.* 재정의도 없다.
      // (호스트 pre-push git-guard 훅(K-TC-24)은 이 심기와 무관하게 core.hooksPath= 로 명시적으로 끈다.)
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', mirror]);
      execFileSync('git', ['-c', 'core.hooksPath=', '-C', work, 'push', '-q', '--mirror', mirror]);
      // 프로덕션 구성 증거: 미러에 upload-pack 재정이 하나도 없다(allowAnySHA1InWant·allowFilter 없이 raw-SHA fetch 가 성립해야 한다).
      const uploadPackOverrides = (() => {
        try { return execFileSync('git', ['-C', mirror, 'config', '--get-regexp', '^uploadpack\\.'], { encoding: 'utf8' }).trim(); } catch { return ''; }
      })();
      expect(uploadPackOverrides).toBe('');

      // (1) 브랜치/refs 경유 없이 raw-SHA fetch 가 기본 upload-pack 설정에서 성공한다.
      execFileSync('git', ['init', '-q', '-b', 'main', job]);
      execFileSync('git', ['-C', job, 'fetch', '--quiet', '--no-write-fetch-head', mirror, baseSha]);
      execFileSync('git', ['-C', job, 'checkout', '-q', '-B', 'main', baseSha]);
      expect(execFileSync('git', ['-C', job, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(baseSha);

      // (2) 실제 Pod source-receive 스크립트가 같은 raw-SHA fetch 로 정확한 SHA 를 checkout 한다 (GitHub 호출 0).
      // 부재 commit 파일로 image 라우트를 끈다 — 기본 /opt/elanous-* 경로가 실재하는 환경에선 그 트리를 repo 로 가로채 공용 object store 의 alternates 를 오염시킨다.
      const jobScript = join(root, 'job-script');
      mkdirSync(jobScript);
      const script = podSourceScript({ kind: 'default', baseSha }, 'https://github.com/unused/repo', mirror, { imageCommitFile: join(root, 'absent-image-commit') });
      const result = Bun.spawnSync(['bash', '-c', `set -e\n${script}`], { cwd: jobScript });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString()).toContain('ELANOUS_POD_SOURCE_VIA mirror');
      expect(result.stdout.toString()).toContain(`ELANOUS_POD_SOURCE default ${baseSha}`);
      expect(execFileSync('git', ['-C', join(jobScript, 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(baseSha);
      const io = /^ELANOUS_POD_SOURCE_IO (\{[^\r\n]+\})$/m.exec(result.stdout.toString())?.[1];
      expect(io).toBeTruthy();
      expect(JSON.parse(io!)).toMatchObject({ originCalls: 0, sourceVia: 'mirror', sourceStatus: 'complete' });
      expect(script).toContain(`git -C repo fetch --quiet --no-write-fetch-head '${mirror}' '${baseSha}'`);
      expect(script).not.toContain('git ls-remote');
      expect(script).not.toContain('git fetch --depth 50 origin');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
