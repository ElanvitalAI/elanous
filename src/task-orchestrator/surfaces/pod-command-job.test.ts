import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  commandJobSecret,
  podCommandJobManifest,
  podCommandImageFor,
  podCommandScript,
  podCommandSecretKeys,
  podCommandTargetCommit,
  podCpuMillis,
  resolvePodCpu,
  runPodCommand,
  tailBytes,
} from './pod-command-job.js';
import type { Kubectl } from './self-implement-pod.js';
import { PodPoolScheduler, syncPoolImages, type PodPoolMember, type RemoteRun } from './pod-pool.js';
import { podSourceScript } from './pod-source-receive.js';
import { LogStore } from '../../mss/logging/log-store.js';

const base = {
  name: 'cmd-1',
  namespace: 'elanous-test',
  image: 'elanous-harness:local',
  repoUrl: 'https://github.com/example/repo.git',
  deadlineSeconds: 60,
  command: ['echo', 'hi'],
};

function manifest(over: Partial<Parameters<typeof podCommandJobManifest>[0]> = {}) {
  return podCommandJobManifest({ ...base, skills: [], ...over });
}

describe('pod command job manifest', () => {
  test('a limit below the default request (lite 2Gi) lowers the memory request to the limit so the Job is valid', () => {
    const lite = manifest({ clone: false, memoryLimit: '2Gi' });
    const raised = manifest({ clone: true, memoryLimit: '32Gi' });
    const res = (m: ReturnType<typeof manifest>) => (m.spec as { template: { spec: { containers: Array<{ resources: { requests: Record<string, string>; limits: Record<string, string> } }> } } }).template.spec.containers[0]!.resources;
    expect(res(lite).limits.memory).toBe('2Gi');
    expect(res(lite).requests.memory).toBe('2Gi');
    expect(res(raised).requests.memory).toBe('6Gi');
    expect(res(manifest({ clone: true })).requests.memory).toBe('6Gi');
  });

  test('memoryLimit raises only the container memory limit; omitted keeps 16Gi and the pre-change bytes', () => {
    const original = manifest({ clone: true });
    const raised = manifest({ clone: true, memoryLimit: '32Gi' });
    const limits = (m: ReturnType<typeof manifest>) => (m.spec as { template: { spec: { containers: Array<{ resources: { limits: { memory: string } } }> } } }).template.spec.containers[0]!.resources.limits;
    expect(limits(original).memory).toBe('16Gi');
    expect(limits(raised).memory).toBe('32Gi');
    expect(JSON.stringify(manifest({ clone: true, memoryLimit: undefined }))).toBe(JSON.stringify(original));
  });

  test('hostMirror mounts a read-only Directory; omitted mirror preserves the pre-change manifest bytes', () => {
    const original = manifest({ clone: true });
    const withMirror = manifest({ clone: true, hostMirror: '/mirror-host/elanous-agent.git' });
    const spec = (withMirror.spec as { template: { spec: { volumes: unknown[]; containers: Array<{ volumeMounts: unknown[] }> } } }).template.spec;
    expect(spec.volumes).toContainEqual({ name: 'host-mirror', hostPath: { path: '/mirror-host/elanous-agent.git', type: 'Directory' } });
    expect(spec.containers[0]!.volumeMounts).toContainEqual({ name: 'host-mirror', mountPath: '/host-mirror', readOnly: true });
    expect(createHash('sha256').update(JSON.stringify(original)).digest('hex')).toBe('05e44a726eb53c32273cd436662dc0fdf6dbf49f12441afafa7e49464c9b7a46');
    expect(JSON.stringify(manifest({ clone: true, hostMirror: undefined }))).toBe(JSON.stringify(original));
  });

  test('opt-in Bun cache mounts writable DirectoryOrCreate without changing the omitted manifest or host mirror', () => {
    const original = manifest({ clone: true });
    const cached = manifest({ clone: true, hostMirror: '/srv/mirror', bunCache: '/srv/bun-cache' });
    const spec = (cached.spec as { template: { spec: { volumes: unknown[]; containers: Array<{ volumeMounts: unknown[] }>; initContainers: Array<{ volumeMounts?: unknown[] }> } } }).template.spec;
    expect(spec.volumes).toEqual([
      { name: 'creds', secret: { secretName: 'cmd-1-creds', defaultMode: 0o400 } },
      { name: 'host-mirror', hostPath: { path: '/srv/mirror', type: 'Directory' } },
      { name: 'bun-cache', hostPath: { path: '/srv/bun-cache', type: 'DirectoryOrCreate' } },
    ]);
    expect(spec.containers[0]!.volumeMounts).toEqual([
      { name: 'creds', mountPath: '/creds', readOnly: true },
      { name: 'host-mirror', mountPath: '/host-mirror', readOnly: true },
      { name: 'bun-cache', mountPath: '/bun-cache', readOnly: false },
    ]);
    expect(spec.initContainers[0]!.volumeMounts).toBeUndefined();
    expect(podCommandScript(cached)).toContain('if [ -d /bun-cache ] && [ -w /bun-cache ]; then export BUN_INSTALL_CACHE_DIR=/bun-cache; fi;');
    expect(createHash('sha256').update(JSON.stringify(original)).digest('hex')).toBe('05e44a726eb53c32273cd436662dc0fdf6dbf49f12441afafa7e49464c9b7a46');
    expect(JSON.stringify(manifest({ clone: true, bunCache: undefined }))).toBe(JSON.stringify(original));
    expect(podCommandScript(original)).not.toContain('BUN_INSTALL_CACHE_DIR');
  });

  test('GATE-INSTALL-CACHE: install slots mount a hostPath and a root init container hands the host dirs to uid 1000', () => {
    const original = manifest({ clone: true });
    const slotted = manifest({ clone: true, bunCache: '/srv/bun-cache', installSlots: '/var/lib/elanous/gate-install-slots' });
    const spec = (slotted.spec as { template: { spec: { volumes: unknown[]; containers: Array<{ volumeMounts: unknown[] }>; initContainers: Array<Record<string, unknown>> } } }).template.spec;
    expect(spec.volumes).toContainEqual({ name: 'install-slots', hostPath: { path: '/var/lib/elanous/gate-install-slots', type: 'DirectoryOrCreate' } });
    expect(spec.containers[0]!.volumeMounts).toContainEqual({ name: 'install-slots', mountPath: '/gate-install-slots', readOnly: false });
    expect(spec.initContainers[0]!.name).toBe('isolation-gate');
    const init = spec.initContainers[1]!;
    expect(init).toMatchObject({ name: 'host-dirs', securityContext: { runAsUser: 0 } });
    expect(init.volumeMounts).toEqual([
      { name: 'bun-cache', mountPath: '/bun-cache', readOnly: false },
      { name: 'install-slots', mountPath: '/gate-install-slots', readOnly: false },
    ]);
    expect(String((init.args as string[])[0])).toContain('chown 1000:1000');
    expect(String((init.args as string[])[0])).toContain('exit 0');
    expect(JSON.stringify(manifest({ clone: true, installSlots: undefined }))).toBe(JSON.stringify(original));
  });

  test('GATE-SPEED A3①: cpu omitted keeps request 1 / limit 4 and the pre-change bytes; cpu override reaches the Job spec', () => {
    const res = (m: ReturnType<typeof manifest>) => (m.spec as { template: { spec: { containers: Array<{ resources: { requests: Record<string, string>; limits: Record<string, string> } }> } } }).template.spec.containers[0]!.resources;
    const original = manifest({ clone: true });
    expect(res(original)).toEqual({ requests: { cpu: '1', memory: '6Gi' }, limits: { memory: '16Gi', cpu: '4' } });
    expect(createHash('sha256').update(JSON.stringify(original)).digest('hex')).toBe('05e44a726eb53c32273cd436662dc0fdf6dbf49f12441afafa7e49464c9b7a46');
    expect(JSON.stringify(manifest({ clone: true, cpu: undefined }))).toBe(JSON.stringify(original));
    expect(JSON.stringify(manifest({ clone: true, cpu: {} }))).toBe(JSON.stringify(original));
    expect(res(manifest({ clone: true, cpu: { request: '1', limit: '1' } }))).toEqual({ requests: { cpu: '1', memory: '6Gi' }, limits: { memory: '16Gi', cpu: '1' } });
    expect(res(manifest({ clone: true, cpu: { request: '500m' } })).requests.cpu).toBe('500m');
    expect(res(manifest({ clone: true, cpu: { request: '500m' } })).limits.cpu).toBe('4');
    expect(() => manifest({ cpu: { request: '2', limit: '1' } })).toThrow('exceeds limit');
    expect(() => manifest({ cpu: { request: 'two' } })).toThrow('not a positive CPU quantity');
    expect(() => manifest({ cpu: { limit: '0' } })).toThrow('not a positive CPU quantity');
  });

  test('podCpuMillis / resolvePodCpu read Kubernetes CPU quantities', () => {
    expect([podCpuMillis('1'), podCpuMillis('0.5'), podCpuMillis('1500m'), podCpuMillis(' 2 ')]).toEqual([1000, 500, 1500, 2000]);
    expect([podCpuMillis('0'), podCpuMillis('-1'), podCpuMillis('1Gi'), podCpuMillis('0.0001'), podCpuMillis('')]).toEqual([null, null, null, null, null]);
    expect(resolvePodCpu(undefined)).toEqual({ request: '1', limit: '4' });
    expect(resolvePodCpu({ limit: '2' })).toEqual({ request: '1', limit: '2' });
  });

  test('log export uses isolated elanous CLI JSONL with structured data and a readable outbox chunk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-cmd-real-export-'));
    const script = podCommandScript(manifest({ command: ['true'], returnLogs: true }));
    try {
      const store = new LogStore(join(dir, '.elanous', 'logs', 'logs.db'));
      const runEvent = `pod-real-export-${Date.now()}`;
      store.insertBatch([{ rec: { ts: new Date().toISOString(), category: 'pod.command', event: runEvent, data: { payload: 'structured' } }, surface: 'pod' }]);
      store.close();
      const bin = join(dir, 'elanous');
      writeFileSync(bin, `#!/bin/bash\nexec bun ${JSON.stringify(resolve('bin/elanous.mjs'))} "$@"\n`);
      chmodSync(bin, 0o755);
      const start = script.indexOf('set -- ');
      const ran = spawnSync('bash', ['-c', script.slice(start)], {
        encoding: 'utf8', cwd: dir,
        env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ''}` },
      });
      expect(ran.status).toBe(0);
      expect(ran.stdout).not.toContain('ELANOUS_POD_LOGS_UNAVAILABLE');
      const jsonl = readFileSync(join(dir, 'outbox/pod-logs/logs.jsonl'), 'utf8');
      const lines = jsonl.split('\n').filter(Boolean);
      const record = lines.map((line) => JSON.parse(line) as { event?: string; data?: unknown }).find((row) => row.event === runEvent);
      expect(record?.data).toEqual({ payload: 'structured' });
      const chunks = ran.stdout.split('\n').filter((line) => line.startsWith('ELANOUS_POD_ARTIFACT '));
      expect(chunks.length).toBeGreaterThan(0);
      expect(Buffer.from(chunks[0]!.split(' ')[1]!, 'base64url').toString()).toBe('pod-logs/logs.jsonl');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);

  test('log export emits the real outbox chunk after a failed command without replacing its exit code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-cmd-export-'));
    const bin = join(dir, 'elanous');
    writeFileSync(bin, '#!/bin/bash\n[[ "$*" == "--test=$HOME/.elanous-test logs --instance prod --since 12h --limit 20000 --json --json-data" ]] || exit 19\nprintf "{\\\"ts\\\":\\\"2026-10-08T00:00:00Z\\\",\\\"category\\\":\\\"pod.command\\\",\\\"event\\\":\\\"child\\\"}\\n"\n');
    chmodSync(bin, 0o755);
    try {
      const script = podCommandScript(manifest({ command: ['false'], returnLogs: true }));
      const start = script.indexOf('set -- ');
      const executed = script.slice(start);
      const ran = spawnSync('bash', ['-c', executed], { encoding: 'utf8', env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ''}` } });
      expect(ran.status).toBe(1);
      expect(readFileSync(join(dir, 'outbox/pod-logs/logs.jsonl'), 'utf8')).toContain('"event":"child"');
      const chunks = ran.stdout.split('\n').filter((line) => line.startsWith('ELANOUS_POD_ARTIFACT '));
      expect(chunks).toHaveLength(1);
      expect(Buffer.from(chunks[0]!.split(' ')[1]!, 'base64url').toString()).toBe('pod-logs/logs.jsonl');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('skills·llm 이 없으면 Secret 자격 키가 0개다', () => {
    const job = manifest();
    const script = podCommandScript(job);
    const secret = commandJobSecret({ name: base.name, namespace: base.namespace, skills: [], skillEnvText: {} });
    expect(podCommandSecretKeys(secret)).toEqual([]);
    expect(script).not.toContain('elanous-auth.json');
    expect(script).not.toContain('codex-auth.json');
    expect(script).not.toContain('grok-auth.json');
    expect(script).not.toContain('skillenv-');
    expect(script).not.toContain('/creds/');
    const spec = job.spec as { template: { spec: { volumes?: unknown; containers: Array<{ volumeMounts?: unknown }> } } };
    expect(spec.template.spec.volumes).toBeUndefined();
    expect(spec.template.spec.containers[0]!.volumeMounts).toBeUndefined();
    expect(script).toContain('host.orb.internal:31415');
    expect(script).toContain('ISOLATION FAIL');
    expect(script).toContain('ELANOUS_POD_ARTIFACT');
    expect(script).toContain('exit $rc');
  });

  // 🐞 2026-09-27(🅞 첫 실물): 비공개 저장소를 자격 없이 clone 하다 죽었다 — 기본은 clone 없이 ~/work(이미지의 elanous) ·
  //   clone 은 명시 opt-in 이고 그때만 GitHub 토큰이 Secret 으로 간다.
  test('기본은 clone 하지 않는다(~/work) · --clone 일 때만 gh-token 이 Secret 으로 간다', () => {
    const plain = podCommandScript(manifest());
    expect(plain).not.toContain('git clone');
    expect(plain).not.toContain('gh-token');
    expect(plain).toContain('cd ~/work');
    const cloned = manifest({ clone: true });
    const script = podCommandScript(cloned);
    expect(script).toContain('/creds/gh-token');
    expect(script).toContain('git clone');
    const spec = cloned.spec as { template: { spec: { volumes?: unknown } } };
    expect(spec.template.spec.volumes).toBeDefined();
    const secret = commandJobSecret({ name: base.name, namespace: base.namespace, skills: [], skillEnvText: {}, ghToken: 'tok' });
    expect(podCommandSecretKeys(secret)).toEqual(['gh-token']);
  });

  // SHA-256 of the default JSON manifest (base + clone: true) — re-pinned 10-06 for POD-DIET (request 6Gi); a change here means the default manifest moved.
  test('commit source checks out the requested SHA; omitted source retains the default manifest bytes', () => {
    const source = { kind: 'commit' as const, sha: 'a'.repeat(40) };
    const original = '05e44a726eb53c32273cd436662dc0fdf6dbf49f12441afafa7e49464c9b7a46';
    const script = podCommandScript(manifest({ clone: true, source }));
    expect(script).toContain(podSourceScript(source, base.repoUrl));
    expect(script).toContain(`git checkout --detach ${source.sha}`);
    expect(createHash('sha256').update(JSON.stringify(manifest({ clone: true, source: { kind: 'default' } }))).digest('hex')).toBe(original);
    expect(createHash('sha256').update(JSON.stringify(manifest({ clone: true }))).digest('hex')).toBe(original);
    expect(JSON.stringify(manifest({ source }))).toBe(JSON.stringify(manifest()));
  });

  test("skills: ['yt-vault'] 는 skillenv-yt-vault 하나뿐이다", () => {
    const job = manifest({ skills: ['yt-vault'], command: ['zsh', 'scripts/absorb-one.sh'] });
    const secret = commandJobSecret({
      name: base.name, namespace: base.namespace, skills: ['yt-vault'],
      skillEnvText: { 'yt-vault': 'TOKEN=secret\n' },
    });
    expect(podCommandSecretKeys(secret)).toEqual(['skillenv-yt-vault']);
    const script = podCommandScript(job);
    expect(script).toContain('install -m 600 /creds/skillenv-$n ~/.claude/skills/$n/.env');
    expect(script).toContain('for n in yt-vault;');
    expect(script).not.toContain('elanous-auth.json');
    expect(script).not.toContain('codex-auth.json');
    expect(script).not.toContain('grok-auth.json');
    expect(JSON.stringify(secret)).not.toContain('refresh');
  });

  test("llm: 'grok' 만 grok 사본이 있고 refresh 문자열이 없다", () => {
    const grokAuth = JSON.stringify({ 'grok-cli': { key: 'access-only', expires_at: '2099-01-01T00:00:00Z' } });
    const job = manifest({ llm: 'grok' });
    const secret = commandJobSecret({
      name: base.name, namespace: base.namespace, skills: [], skillEnvText: {}, grokAuth,
    });
    expect(podCommandSecretKeys(secret)).toEqual(['grok-auth.json']);
    expect(JSON.stringify(secret)).not.toMatch(/refresh/i);
    const script = podCommandScript(job);
    expect(script).toContain('install -m 600 /creds/grok-auth.json ~/.grok/auth.json');
    expect(script).not.toContain('elanous-auth.json');
    expect(script).not.toContain('codex-auth.json');
    expect(script).not.toContain('skillenv-');
  });

  test('공백·따옴표·세미콜론 인자는 bash "$@" 로 원형 그대로이고 세미콜론 뒤는 실행되지 않는다', () => {
    const args = ['say', 'a b', `quote'"x`, 'keep; rm -rf /'];
    const job = manifest({ command: ['/tmp/print-args.sh', ...args.slice(1)] });
    const script = podCommandScript(job);
    expect(script).not.toMatch(/\$\{[^}]*command/);
    expect(script).toContain('set -- ');
    expect(script).toContain('"$@"');
    const dir = mkdtempSync(join(tmpdir(), 'pod-cmd-'));
    const printer = join(dir, 'print-args.sh');
    writeFileSync(printer, '#!/bin/bash\nprintf "%s\\n" "$@"\n');
    chmodSync(printer, 0o755);
    const wrapped = podCommandScript(manifest({ command: [printer, ...args.slice(1)] }))
      .split('\n')
      .filter((line) => line.startsWith('set -- ') || line === '"$@"')
      .join('\n');
    const ran = spawnSync('bash', ['-c', wrapped], { encoding: 'utf8' });
    expect(ran.status).toBe(0);
    expect(ran.stdout.split('\n').filter((l) => l.length > 0)).toEqual(args.slice(1));
    expect(ran.stderr).not.toContain('rm');
  });
});

describe('runPodCommand', () => {
  test('lite only when the caller says so: network-skill commands with --lite get the lite image and 2Gi; skills alone never switch', async () => {
    const variants = [
      { skills: ['omni-crawl'], lite: true, expected: 'elanous-harness-lite:local', memory: '2Gi' },
      { skills: ['omni-digest', 'omni-crawl'], lite: true, expected: 'elanous-harness-lite:local', memory: '2Gi' },
      // POD7 must-fix: a network skill named without --lite may still need ffmpeg/browser — keep full.
      { skills: ['omni-crawl'], lite: false, expected: 'elanous-harness:local', memory: '16Gi' },
      { skills: ['youtube-master'], lite: false, expected: 'elanous-harness:local', memory: '16Gi' },
      { skills: [], lite: false, expected: 'elanous-harness:local', memory: '16Gi' },
    ];
    for (const [i, variant] of variants.entries()) {
      const applied: Record<string, any>[] = [];
      const result = await runPodCommand({ command: ['true'], skills: variant.skills, ...(variant.lite ? { lite: true } : {}),
        kubectl: (args, input) => {
          if (input) applied.push(JSON.parse(input));
          if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
          return { status: 0, stdout: '0', stderr: '' };
        }, imageCommit: null, name: `network-image-${i}`, env: {}, configHostMirror: () => undefined,
        readSkillEnv: () => ({}), artifactsRoot: '/tmp/pod-command-image-test',
      });
      const job = applied.find((body) => body.kind === 'Job')!;
      expect(podCommandImageFor(variant.skills, false, variant.lite)).toBe(variant.expected);
      expect(result.image).toBe(variant.expected);
      expect(job.spec.template.spec.initContainers[0].image).toBe(variant.expected);
      expect(job.spec.template.spec.containers[0].image).toBe(variant.expected);
      expect(job.spec.template.spec.containers[0].resources.limits.memory).toBe(variant.memory);
    }
  });

  test('a --lite request that does not fit is refused with the reason, never widened silently', () => {
    expect(() => podCommandImageFor(['omni-crawl', 'youtube-master'], false, true)).toThrow('벗어난 스킬: youtube-master');
    expect(() => podCommandImageFor([], false, true)).toThrow('--skill 이 없다');
    expect(() => podCommandImageFor(['omni-crawl'], true, true)).toThrow('clone 없는 명령만');
  });

  test('a registry sync forwards the selected lite image into the Job, with registry pull policy', async () => {
    const member: PodPoolMember = { context: 'pool-node-b', sshHost: 'node-b', capacity: 1, k3dCluster: 'elanous-pool', registry: 'k3d-elanous-registry:5051' };
    let syncedImage = '';
    let applied: Record<string, any> | undefined;
    const imageRef = 'k3d-elanous-registry:5051/elanous-harness-lite:abcdef123456';
    const result = await runPodCommand({ command: ['true'], skills: ['omni-digest'], lite: true, poolScheduler: new PodPoolScheduler([member]),
      kubectl: (args, input) => {
        if (input) { const body = JSON.parse(input); if (body.kind === 'Job') applied = body; }
        if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
        return { status: 0, stdout: '0', stderr: '' };
      }, syncImages: async (_members, image) => { syncedImage = image; return new Map([[member.context, { ok: true, action: 'built', detail: 'ready', ms: 1, imageRef }]]); },
      imageCommit: 'abcdef1234567890', name: 'network-registry', env: {}, configHostMirror: () => undefined,
      readSkillEnv: () => ({}), artifactsRoot: '/tmp/pod-command-image-test',
    });
    expect(syncedImage).toBe('elanous-harness-lite:local');
    expect(result.image).toBe(imageRef);
    expect(applied!.spec.template.spec.initContainers[0]).toMatchObject({ image: imageRef, imagePullPolicy: 'IfNotPresent' });
    expect(applied!.spec.template.spec.containers[0]).toMatchObject({ image: imageRef, imagePullPolicy: 'IfNotPresent' });
  });

  test('POOLGLOBAL-REG: a caller-supplied scheduler (the gate) launches past cluster occupancy — own Jobs only', async () => {
    const member: PodPoolMember = { context: 'pool-node-b', sshHost: 'node-b', capacity: 8, k3dCluster: 'elanous-pool' };
    let occupancyReads = 0;
    // The cluster reports 17 goal Pods on an 8-slot spec: the pre-fix scheduler would wait here forever.
    const pool = new PodPoolScheduler([member], { occupancy: () => { occupancyReads++; return { 'pool-node-b': { occupied: 17 } }; } });
    let applied = false;
    const result = await runPodCommand({ command: ['true'], poolScheduler: pool, name: 'gate-self-capped',
      sleep: async () => { throw new Error('waited for a slot'); },
      kubectl: (args, input) => {
        if (input && JSON.parse(input).kind === 'Job') applied = true;
        if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
        return { status: 0, stdout: '0', stderr: '' };
      }, syncImages: async () => new Map([[member.context, { ok: true, action: 'fresh' as const, detail: 'ready', ms: 1 }]]),
      imageCommit: null, env: {}, configHostMirror: () => undefined, artifactsRoot: '/tmp/pod-command-self-capped-test',
    });
    expect(result.job).toBe('gate-self-capped');
    expect(applied).toBe(true);
    expect(occupancyReads).toBe(0);
    expect(pool.snapshot()).toEqual({ 'pool-node-b': 0 });
  });

  test('pool registry tag uses IfNotPresent for both the isolation gate and child', async () => {
    const member: PodPoolMember = { context: 'pool-node-b', sshHost: 'node-b', capacity: 1, k3dCluster: 'elanous-pool', registry: 'k3d-elanous-registry:5050' };
    const ref = 'k3d-elanous-registry:5050/elanous-harness:abcdef123456';
    const run: RemoteRun = (_host, cmd) => ({ status: 0, stdout: cmd.includes('/tags/list') ? '{"tags":["abcdef123456"]}' : 'abcdef1234567890', stderr: '' });
    let job: Record<string, any> | undefined;
    const result = await runPodCommand({ command: ['true'], imageCommit: 'abcdef1234567890',
      checkPool: (members) => { expect(members).toEqual([member]); return { ok: true, ready: [...members], dropped: [] }; },
      syncImages: (members, image, commit, deps) => syncPoolImages(members, image, commit, { ...deps, run, buildScript: null }),
      kubectl: (args, input) => {
        if (input) { const body = JSON.parse(input); if (body.kind === 'Job') job = body; }
        if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
        return { status: 0, stdout: '0', stderr: '' };
      }, env: { ELANOUS_POD_POOL: 'pool-node-b@node-b:1#k3d-elanous-registry:5050' }, configHostMirror: () => undefined, artifactsRoot: '/tmp/pod-command-registry-test',
    });
    expect(result.image).toBe(ref);
    expect(job!.spec.template.spec.initContainers[0]).toMatchObject({ image: ref, imagePullPolicy: 'IfNotPresent' });
    expect(job!.spec.template.spec.containers[0]).toMatchObject({ image: ref, imagePullPolicy: 'IfNotPresent' });
  });

  test('an unavailable registry tag falls back to the local image with one observable reason', async () => {
    let job: Record<string, any> | undefined;
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const result = await runPodCommand({ command: ['true'], pool: 'pool-node-b@node-b:1', imageCommit: 'abcdef1234567890',
      checkPool: (members) => ({ ok: true, ready: [...members], dropped: [] }),
      syncImages: async (members) => new Map([[members[0]!.context, { ok: true, action: 'shipped' as const, detail: 'local image imported', ms: 1 }]]),
      kubectl: (args, input) => {
        if (input) { const body = JSON.parse(input); if (body.kind === 'Job') job = body; }
        if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
        return { status: 0, stdout: '0', stderr: '' };
      }, log: (category, event, data) => { events.push({ category, event, data }); },
      env: {}, configHostMirror: () => undefined, artifactsRoot: '/tmp/pod-command-registry-test',
    });
    expect(result.image).toBe('elanous-harness:local');
    expect(job!.spec.template.spec.initContainers[0]).toMatchObject({ image: 'elanous-harness:local', imagePullPolicy: 'Never' });
    expect(job!.spec.template.spec.containers[0]).toMatchObject({ image: 'elanous-harness:local', imagePullPolicy: 'Never' });
    expect(events.filter(({ event }) => event === 'image-fallback-local')).toEqual([
      { category: 'pod.command-job', event: 'image-fallback-local', data: { reason: 'registry-tag-unavailable' } },
    ]);
  });

  test('clone command passes the commit source through to the Job script', async () => {
    const inputs: string[] = [];
    const source = { kind: 'commit' as const, sha: 'a'.repeat(40) };
    await runPodCommand({ command: ['true'], clone: true, source, ghToken: () => 'test-token',
      kubectl: (args, input) => {
        if (input) inputs.push(input);
        if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
        return { status: 0, stdout: '0', stderr: '' };
      }, imageCommit: null, name: 'commit-source', artifactsRoot: '/tmp/pod-command-commit-test',
    });
    const job = inputs.map((body) => JSON.parse(body) as { kind: string }).find((item) => item.kind === 'Job');
    expect(job).toBeDefined();
    expect(podCommandScript(job!)).toContain(podSourceScript(source, 'https://github.com/ElanvitalAI/elanous'));
  });

  test('runPodCommand selects hostMirror by option > env > config and permits explicit opt-out', async () => {
    const applied: Array<Record<string, unknown>> = [];
    const run = async (hostMirror: string | undefined, env: NodeJS.ProcessEnv) => {
      await runPodCommand({ command: ['true'], clone: true, ghToken: () => 'token', hostMirror, env,
        configHostMirror: () => '/config/mirror.git',
        kubectl: (args, input) => {
          if (input) {
            const body = JSON.parse(input) as Record<string, unknown>;
            if (body.kind === 'Job') applied.push(body);
          }
          if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
          return { status: 0, stdout: '0', stderr: '' };
        }, imageCommit: null, name: `mirror-${applied.length}`, artifactsRoot: '/tmp/pod-command-mirror-test',
      });
      const job = applied.at(-1)! as { spec: { template: { spec: { volumes: Array<{ hostPath?: { path: string } }> } } } };
      return job.spec.template.spec.volumes.find((volume) => volume.hostPath)?.hostPath?.path;
    };
    expect(await run(undefined, {})).toBe('/config/mirror.git');
    expect(await run(undefined, { ELANOUS_POD_HOST_MIRROR: '/env/mirror.git' })).toBe('/env/mirror.git');
    expect(await run('/option/mirror.git', { ELANOUS_POD_HOST_MIRROR: '/env/mirror.git' })).toBe('/option/mirror.git');
    expect(await run(' ', { ELANOUS_POD_HOST_MIRROR: '/env/mirror.git' })).toBeUndefined();
    await expect(run('relative/mirror', {})).rejects.toThrow('absolute directory path');
  });

  test('runPodCommand passes the optional Bun cache host path to the Job without adding a default mount', async () => {
    const applied: Array<Record<string, unknown>> = [];
    const run = async (bunCache?: string) => {
      await runPodCommand({ command: ['true'], bunCache, env: {}, configHostMirror: () => undefined,
        kubectl: (args, input) => {
          if (input) applied.push(JSON.parse(input) as Record<string, unknown>);
          if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
          return { status: 0, stdout: '0', stderr: '' };
        }, imageCommit: null, name: 'bun-cache-test', artifactsRoot: '/tmp/pod-command-bun-cache-test',
      });
      return applied.filter((body) => body.kind === 'Job').at(-1)!;
    };
    const cached = await run('/srv/bun-cache');
    const spec = (cached.spec as { template: { spec: { volumes: unknown[]; containers: Array<{ volumeMounts: unknown[] }> } } }).template.spec;
    expect(spec.volumes).toEqual([{ name: 'bun-cache', hostPath: { path: '/srv/bun-cache', type: 'DirectoryOrCreate' } }]);
    expect(spec.containers[0]!.volumeMounts).toEqual([{ name: 'bun-cache', mountPath: '/bun-cache', readOnly: false }]);
    expect(podCommandScript(cached)).toContain('BUN_INSTALL_CACHE_DIR=/bun-cache');
    const omitted = await run();
    const omittedSpec = (omitted.spec as { template: { spec: { volumes?: unknown; containers: Array<{ volumeMounts?: unknown }> } } }).template.spec;
    expect(omittedSpec.volumes).toBeUndefined();
    expect(omittedSpec.containers[0]!.volumeMounts).toBeUndefined();
    expect(podCommandScript(omitted)).not.toContain('BUN_INSTALL_CACHE_DIR');
    await expect(runPodCommand({ command: ['true'], bunCache: 'relative/cache', env: {}, kubectl: () => ({ status: 0, stdout: '', stderr: '' }) })).rejects.toThrow('absolute directory path');
  });

  test('GATE-SPEED A3①: runPodCommand passes cpu to the Job only when given; a bad quantity is refused before any apply', async () => {
    const applied: Array<Record<string, unknown>> = [];
    const run = async (cpu?: { request?: string; limit?: string }) => {
      await runPodCommand({ command: ['true'], ...(cpu ? { cpu } : {}), env: {}, configHostMirror: () => undefined,
        kubectl: (args, input) => {
          if (input) applied.push(JSON.parse(input) as Record<string, unknown>);
          if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
          return { status: 0, stdout: '0', stderr: '' };
        }, imageCommit: null, name: 'cpu-test', artifactsRoot: '/tmp/pod-command-cpu-test',
      });
      const job = applied.filter((body) => body.kind === 'Job').at(-1)!;
      return (job.spec as { template: { spec: { containers: Array<{ resources: { requests: Record<string, string>; limits: Record<string, string> } }> } } }).template.spec.containers[0]!.resources;
    };
    // Non-gate callers (agent-mission · pod command CLI) name no cpu: today's request 1 / limit 4.
    expect(await run()).toEqual({ requests: { cpu: '1', memory: '6Gi' }, limits: { memory: '16Gi', cpu: '4' } });
    expect(await run({ request: '1', limit: '1' })).toEqual({ requests: { cpu: '1', memory: '6Gi' }, limits: { memory: '16Gi', cpu: '1' } });
    const before = applied.length;
    const kubectlCalls: string[][] = [];
    await expect(runPodCommand({ command: ['true'], cpu: { request: '8', limit: '4' }, env: {}, configHostMirror: () => undefined,
      kubectl: (args) => { kubectlCalls.push([...args]); return { status: 0, stdout: '', stderr: '' }; } })).rejects.toThrow('exceeds limit');
    expect(kubectlCalls).toEqual([]);
    expect(applied.length).toBe(before);
  });

  test('clone-free Job mounts a configured host mirror when an environment mirror is set', async () => {
    const inputs: string[] = [];
    await runPodCommand({ command: ['true'], env: { ELANOUS_POD_HOST_MIRROR: '/srv/mirror' },
      kubectl: (args, input) => {
        if (input) inputs.push(input);
        if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
        return { status: 0, stdout: '0', stderr: '' };
      }, imageCommit: null, name: 'no-mirror', artifactsRoot: '/tmp/pod-command-no-mirror-test',
    });
    const job = inputs.map((body) => JSON.parse(body) as { kind: string; spec?: { template: { spec: { volumes?: unknown; containers: Array<{ volumeMounts?: unknown }> } } } }).find((item) => item.kind === 'Job');
    expect(job).toBeDefined();
    expect(job!.spec!.template.spec.volumes).toEqual([{ name: 'host-mirror', hostPath: { path: '/srv/mirror', type: 'Directory' } }]);
    expect(job!.spec!.template.spec.containers[0]!.volumeMounts).toEqual([{ name: 'host-mirror', mountPath: '/host-mirror', readOnly: true }]);
  });

  test('풀 자리를 잡고 Job 을 적용한 뒤 산출을 회수하고 Secret 을 한 번 지운다', async () => {
    const calls: string[][] = [];
    const inputs: string[] = [];
    const member: PodPoolMember = { context: 'pool-node-b', capacity: 1, k3dCluster: 'elanous-pool' };
    const pool = new PodPoolScheduler([member]);
    const kubectl: Kubectl = (args, input) => {
      calls.push([...args]);
      if (input) inputs.push(input);
      const joined = args.join(' ');
      if (joined.includes('current-context')) return { status: 0, stdout: 'pool-node-b\n', stderr: '' };
      if (joined.startsWith('apply')) return { status: 0, stdout: 'ok\n', stderr: '' };
      if (joined.includes('jsonpath={.status.conditions')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (joined.includes('containerStatuses')) return { status: 0, stdout: '3', stderr: '' };
      if (joined.includes('logs')) return { status: 0, stdout: 'ran\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const events: Array<Record<string, unknown>> = [];
    const result = await runPodCommand({
      command: ['echo', 'hello world; not-run'],
      skills: ['yt-vault'],
      llm: 'grok',
      name: 'cmdjob1',
      namespace: 'elanous-test',
      deadlineSeconds: 30,
      kubectl,
      poolScheduler: pool,
      artifactsRoot: '/tmp/pod-artifacts-test',
      readSkillEnv: () => ({ 'yt-vault': 'A=1\n' }),
      grokCredentials: () => ({ grokAuth: JSON.stringify({ s: { key: 'k' } }), ghToken: 'nope' }),
      syncImages: async () => new Map([['pool-node-b', { ok: true, action: 'fresh', detail: 'same', ms: 1 }]]),
      sleep: async () => {},
      log: (_c, event, data) => { events.push({ event, ...data }); },
    });
    expect(result.exitCode).toBe(3);
    expect(result.job).toBe('cmdjob1');
    expect(result.artifactsDir).toBe('/tmp/pod-artifacts-test/cmdjob1');
    expect(pool.snapshot()['pool-node-b']).toBe(0);
    const deletes = calls.filter((c) => c.includes('delete') && c.includes('secret'));
    expect(deletes).toHaveLength(1);
    const finished = events.find((e) => e.event === 'job-finished');
    expect(finished).toMatchObject({ job: 'cmdjob1', exitCode: 3, skills: ['yt-vault'], llm: 'grok' });
    expect(String(finished?.command).length).toBeLessThanOrEqual(80);
    expect(result.artifacts).toEqual({ files: 0, names: [], error: null });
    expect(existsSync(join(result.artifactsDir, 'child.log'))).toBe(true);
    expect(readFileSync(join(result.artifactsDir, 'child.log'), 'utf8')).toBe('ran\n');
    expect(finished).toMatchObject({ artifactsDir: result.artifactsDir, artifacts: { files: 0, names: [], error: null } });
    expect(inputs.some((body) => body.includes('skillenv-yt-vault') && body.includes('"kind":"Secret"'))).toBe(true);
    expect(inputs.some((body) => body.includes('"kind":"Job"') && body.includes('\\"$@\\"'))).toBe(true);
    expect(inputs.filter((body) => body.includes('"kind":"Job"')).every((body) => !body.includes('host-mirror'))).toBe(true);
    rmSync('/tmp/pod-artifacts-test', { recursive: true, force: true });
  });
});

// 🐞 2026-09-27(🅞 실측): 로컬 이미지가 옛 판이면 원격 노드도 그 옛 판 태그로 돌았다 — 원격이면 발사 트리의 HEAD 를 목표로.
function artifactLine(path: string, body: string): string {
  const token = Buffer.from(path).toString('base64url');
  return `ELANOUS_POD_ARTIFACT ${token} 1/1 ${gzipSync(Buffer.from(body)).toString('base64')}`;
}

describe('명령 Job 산출 회수 — 표지가 없어도 알린 경로에 child.log 가 있다', () => {
  function kubectlOf(logs: { status: number; stdout: string; stderr: string }): Kubectl {
    return (args) => {
      const joined = args.join(' ');
      if (joined.includes('jsonpath={.status.conditions')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (joined.includes('containerStatuses')) return { status: 0, stdout: '0', stderr: '' };
      if (joined.includes('logs')) return logs;
      return { status: 0, stdout: '', stderr: '' };
    };
  }

  test('a plain pod run without JSONL still imports its child output into the launching store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-cmd-plain-'));
    const store = new LogStore(join(root, 'logs.db'));
    try {
      const result = await runPodCommand({ command: ['echo', 'hi'], name: 'si-cmd-plain', imageCommit: null,
        returnLogs: true, artifactsRoot: root, logStore: store,
        kubectl: kubectlOf({ status: 0, stdout: 'plain child output\n', stderr: '' }),
      });
      expect(result.artifactsDir).toBe(join(root, 'si-cmd-plain'));
      expect(readFileSync(join(result.artifactsDir, 'child.log'), 'utf8')).toBe('plain child output\n');
      expect(store.query({ events: ['child-output'] }).map(({ data }) => JSON.parse(data ?? '{}'))).toEqual([
        { job: 'si-cmd-plain', output: 'plain child output', origin: 'pod', podJob: 'si-cmd-plain' },
      ]);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('표지 없는 로그 → 디렉터리와 child.log 하나, 회수 파일 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-cmd-nobeacon-'));
    try {
      const events: Array<Record<string, unknown>> = [];
      const result = await runPodCommand({
        command: ['echo', 'hi'], name: 'nobeacon', imageCommit: null, artifactsRoot: root,
        kubectl: kubectlOf({ status: 0, stdout: 'plain child output\n', stderr: '' }),
        log: (_c, event, data) => { events.push({ event, ...data }); },
      });
      expect(result.artifactsDir).toBe(join(root, 'nobeacon'));
      expect(existsSync(result.artifactsDir)).toBe(true);
      expect(readFileSync(join(result.artifactsDir, 'child.log'), 'utf8')).toBe('plain child output\n');
      expect(result.artifacts).toEqual({ files: 0, names: [], error: null });
      expect(events.find((e) => e.event === 'job-finished')).toMatchObject({
        artifactsDir: result.artifactsDir, artifacts: { files: 0, names: [], error: null },
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('pod run Job exports its own logs before artifact emission; collection writes child/output and imports the returned row', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-cmd-return-'));
    const store = new LogStore(join(root, 'logs.db'));
    const ts = new Date().toISOString();
    const row = JSON.stringify({ ts, level: 'info', surface: 'pod', category: 'pod.command', event: 'child-observed', data: { message: 'from child' } });
    const logs = ['ran', artifactLine('note.txt', 'saved'), artifactLine('pod-logs/logs.jsonl', `${row}\n`)].join('\n');
    try {
      const job = manifest({ returnLogs: true });
      const script = podCommandScript(job);
      expect(script.indexOf('elanous --test="$HOME/.elanous-test" logs --instance prod --since 12h --limit 20000 --json --json-data')).toBeGreaterThan(script.indexOf('rc=$?'));
      expect(script.indexOf('elanous --test="$HOME/.elanous-test" logs --instance prod --since 12h --limit 20000 --json --json-data')).toBeLessThan(script.indexOf('find "$HOME/outbox" -type f -print0'));
      expect(script).toContain('exit $rc');
      expect(podCommandScript(manifest())).not.toContain('elanous logs');
      const calls: string[][] = [];
      const result = await runPodCommand({ command: ['true'], name: 'si-cmd-return', imageCommit: null,
        returnLogs: true, artifactsRoot: root, logStore: store,
        kubectl: (args) => {
          calls.push([...args]);
          if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
          if (args.includes('logs')) return { status: 0, stdout: logs, stderr: '' };
          return { status: 0, stdout: '0', stderr: '' };
        },
      });
      expect(calls.find((args) => args.includes('logs'))).toEqual(['-n', 'elanous-test', 'logs', 'job/si-cmd-return', '-c', 'child']);
      expect(result.exitCode).toBe(0);
      expect(result.artifactsDir).toBe(join(root, 'si-cmd-return'));
      expect(readFileSync(join(result.artifactsDir, 'child.log'), 'utf8')).toBe(logs);
      expect(readFileSync(join(result.artifactsDir, 'note.txt'), 'utf8')).toBe('saved');
      expect(readFileSync(join(result.artifactsDir, 'pod-logs/logs.jsonl'), 'utf8')).toBe(`${row}\n`);
      expect(store.query({ events: ['child-observed'] }).map((entry) => JSON.parse(entry.data ?? '{}'))).toEqual([
        { message: 'from child', origin: 'pod', podJob: 'si-cmd-return' },
      ]);
      expect(store.query({ events: ['child-output'] }).map((entry) => JSON.parse(entry.data ?? '{}'))).toEqual([
        expect.objectContaining({ job: 'si-cmd-return', origin: 'pod', podJob: 'si-cmd-return', output: 'ran' }),
      ]);
      expect(result.artifacts).toEqual({ files: 2, names: ['note.txt', 'pod-logs/logs.jsonl'], error: null });
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test('표지 2 → 파일 2와 child.log, 회수 수·이름이 반환값과 job-finished 에 있다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-cmd-two-'));
    const logs = ['ran\n', artifactLine('a.txt', 'alpha'), artifactLine('nested/b.txt', 'beta')].join('\n');
    try {
      const events: Array<Record<string, unknown>> = [];
      const result = await runPodCommand({
        command: ['echo', 'hi'], name: 'twobeacon', imageCommit: null, artifactsRoot: root,
        kubectl: kubectlOf({ status: 0, stdout: logs, stderr: '' }),
        log: (_c, event, data) => { events.push({ event, ...data }); },
      });
      expect(readFileSync(join(result.artifactsDir, 'a.txt'), 'utf8')).toBe('alpha');
      expect(readFileSync(join(result.artifactsDir, 'nested', 'b.txt'), 'utf8')).toBe('beta');
      expect(readFileSync(join(result.artifactsDir, 'child.log'), 'utf8')).toBe(logs);
      expect(result.artifacts).toEqual({ files: 2, names: ['a.txt', 'nested/b.txt'], error: null });
      expect(events.find((e) => e.event === 'job-finished')).toMatchObject({
        artifactsDir: result.artifactsDir, artifacts: result.artifacts,
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('로그 조회 실패 → «산출 회수 못 함: <사유>» 를 child.log·반환값·job-finished 에 싣고 빈 경로만 알리지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-cmd-logfail-'));
    try {
      const events: Array<Record<string, unknown>> = [];
      const result = await runPodCommand({
        command: ['echo', 'hi'], name: 'logfail', imageCommit: null, artifactsRoot: root,
        kubectl: kubectlOf({ status: 1, stdout: '', stderr: 'connection refused' }),
        log: (_c, event, data) => { events.push({ event, ...data }); },
      });
      expect(existsSync(result.artifactsDir)).toBe(true);
      expect(readFileSync(join(result.artifactsDir, 'child.log'), 'utf8')).toBe('산출 회수 못 함: connection refused');
      expect(result.artifacts).toEqual({ files: null, names: [], error: 'connection refused' });
      expect(events.find((e) => e.event === 'job-finished')).toMatchObject({
        artifactsDir: result.artifactsDir, artifactError: '산출 회수 못 함: connection refused',
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('출력 경로 = 실제 쓴 경로 — artifactsRoot 를 주면 effectiveInstanceRoot 가 아니라 그 경로다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-cmd-effective-'));
    try {
      const result = await runPodCommand({
        command: ['echo', 'hi'], name: 'effective1', imageCommit: null, artifactsRoot: root,
        kubectl: kubectlOf({ status: 0, stdout: 'body\n', stderr: '' }),
      });
      expect(result.artifactsDir).toBe(join(root, 'effective1'));
      expect(result.artifactsDir.startsWith(root)).toBe(true);
      expect(existsSync(join(result.artifactsDir, 'child.log'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('자식 로그가 상한을 넘으면 끝부분을 남긴다', () => {
    expect(tailBytes('abcdef', 3)).toBe('…[앞 3바이트 생략]\ndef');
    expect(tailBytes('short', 100)).toBe('short');
  });
});

describe('podCommandTargetCommit', () => {
  test('원격 노드는 HEAD 를 목표로 삼는다(로컬 이미지 판을 따르지 않는다)', () => {
    expect(podCommandTargetCommit({ remote: true, gitHead: () => 'head123', localImageCommit: () => 'old30f' })).toBe('head123');
  });
  test('HEAD 를 못 읽으면 로컬 이미지 판으로 떨어진다', () => {
    expect(podCommandTargetCommit({ remote: true, gitHead: () => null, localImageCommit: () => 'old30f' })).toBe('old30f');
  });
  test('대조군: 이 기계(원격 아님)는 종전대로 로컬 이미지 판', () => {
    expect(podCommandTargetCommit({ remote: false, gitHead: () => 'head123', localImageCommit: () => 'old30f' })).toBe('old30f');
  });
});

describe('명령 잡 자식 요청(requests) (2026-09-27)', () => {
  test('cpu 1 · 메모리 6Gi 를 요청하고 상한은 그대로다', () => {
    const m = manifest() as { spec: { template: { spec: { containers: Array<{ resources: { requests?: Record<string, string>; limits: Record<string, string> } }> } } } };
    const r = m.spec.template.spec.containers[0]!.resources;
    expect(r.requests).toEqual({ cpu: '1', memory: '6Gi' });
    expect(r.limits).toEqual({ memory: '16Gi', cpu: '4' });
  });
});


describe('POD1 — simultaneous pod runs never touch each other', () => {
  // A tiny cluster: secrets keyed by name with their labels; `delete secret -l a=b,c=d` removes only matches.
  function cluster() {
    const secrets = new Map<string, Record<string, string>>();
    const matches = (labels: Record<string, string>, selector: string) =>
      selector.split(',').every((pair) => { const [k, v] = pair.split('='); return labels[k!] === v; });
    const make = (failJobApply: boolean) => (args: readonly string[], input?: string) => {
      if (input) {
        const body = JSON.parse(input) as { kind: string; metadata: { name: string; labels?: Record<string, string> } };
        if (body.kind === 'Secret') secrets.set(body.metadata.name, body.metadata.labels ?? {});
        if (body.kind === 'Job' && failJobApply) return { status: 1, stdout: '', stderr: 'job apply refused' };
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args.includes('delete') && args.includes('secret')) {
        const at = args.indexOf('-l');
        if (at >= 0) { for (const [n, l] of [...secrets]) if (matches(l, args[at + 1]!)) secrets.delete(n); }
        else secrets.delete(args[args.indexOf('secret') + 1]!);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '0', stderr: '' };
    };
    return { secrets, make };
  }

  test('two launches in the same millisecond get different names, and the failing one cleans up only its own secret', async () => {
    const realNow = Date.now;
    Date.now = () => 1_790_000_000_000;
    const c = cluster();
    const names: string[] = [];
    try {
      // B starts first and keeps its secret while it runs (its kubectl never finishes the job here, so read secrets before A fails).
      const bSecretNames = () => [...c.secrets.keys()];
      const a = runPodCommand({ command: ['true'], skills: [], ghToken: () => 'tok-a', clone: true, kubectl: c.make(true), imageCommit: null, artifactsRoot: '/tmp/pod1-a' })
        .catch((error: Error) => error.message);
      const b = runPodCommand({ command: ['true'], skills: [], ghToken: () => 'tok-b', clone: true, kubectl: c.make(false), imageCommit: null, artifactsRoot: '/tmp/pod1-b' })
        .then((r) => { names.push(r.job); return r; });
      const [aResult] = await Promise.all([a, b]);
      expect(String(aResult)).toContain('job apply refused');
      expect(bSecretNames).toBeDefined();
    } finally { Date.now = realNow; }
    expect(names).toHaveLength(1);
    // A's cleanup selected A's own launch label: B's secret survived until B's own cleanup removed it.
    expect([...c.secrets.keys()]).toEqual([]);
  });

  test('the name carries a random tail and the job, its pod template and its secret carry this launch label', async () => {
    const realNow = Date.now;
    Date.now = () => 1_790_000_000_000;
    const bodies: Array<{ kind: string; metadata: { name: string; labels?: Record<string, string> }; spec?: { template?: { metadata?: { labels?: Record<string, string> } } } }> = [];
    const deletes: string[][] = [];
    try {
      const run = () => runPodCommand({ command: ['true'], ghToken: () => 'tok', clone: true, imageCommit: null, artifactsRoot: '/tmp/pod1-c',
        kubectl: (args, input) => {
          if (input) bodies.push(JSON.parse(input));
          if (args.includes('delete')) deletes.push([...args]);
          if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
          return { status: 0, stdout: '0', stderr: '' };
        } });
      const first = await run();
      const second = await run();
      expect(first.job).not.toBe(second.job);
    } finally { Date.now = realNow; }
    const job = bodies.find((b) => b.kind === 'Job')!;
    const secret = bodies.find((b) => b.kind === 'Secret')!;
    const launch = job.metadata.labels?.['elanous.launch'];
    expect(launch).toMatch(/^[0-9a-f]{12}$/);
    expect(job.spec?.template?.metadata?.labels?.['elanous.launch']).toBe(launch);
    expect(secret.metadata.labels?.['elanous.launch']).toBe(launch);
    expect(deletes.every((args) => args.includes('-l') && args[args.indexOf('-l') + 1]!.includes('elanous.launch='))).toBe(true);
  });
});
