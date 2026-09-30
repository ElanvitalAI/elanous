import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { getUserConfig, saveUserConfig } from '../../user-config.js';
import { podJobManifest, podJobName, podSelfImplementSpawn, type Kubectl, type PodSpawnOptions } from './self-implement-pod.js';
import type { PodSource } from './pod-source-receive.js';

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

  test('bundle delivery keeps cp/ready after Job creation and full child logs report source-via mirror or github', async () => {
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
      const fallback = fakeLaunch('ELANOUS_POD_SOURCE_VIA github\n{"stage":"merged","ok":true}\n');
      await fallback.launch({}, 'github-source');
      expect(events).toEqual([
        expect.objectContaining({ job: podJobName('mirror-source'), via: 'mirror' }),
        expect.objectContaining({ job: podJobName('github-source'), via: 'github' }),
      ]);
    } finally { off(); }
  });
});
