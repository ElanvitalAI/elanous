import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  podCpuQuantity,
  podCpuRightsize,
  podLaunchPreconditions,
  podRightsizeRefusal,
  POD_RIGHTSIZE_CONDITION,
  POD_RIGHTSIZE_VOID_LAUNCHES,
  POD_RESULT_MARKER,
  POD_MARKER_LOG_RETRIES,
  runPodCommand as runPodCommandImpl,
  splitPodResultMarker,
  tailBytes,
} from './pod-command-job.js';
import type { RunPodCommandOptions } from './pod-command-job.js';
import type { Kubectl } from './self-implement-pod.js';
import { PodPoolScheduler, syncPoolImages, type PodPoolMember, type RemoteRun } from './pod-pool.js';
import { podSourceScript } from './pod-source-receive.js';
import { hostShellWithin, podHostDirsNodeIdsScript, podHostDirsNodeScript, prepareHostDirsOnce, resetHostDirsPrepMemo } from './pod-install-slots.js';
import { LogStore } from '../../mss/logging/log-store.js';

const base = {
  name: 'cmd-1',
  namespace: 'elanous-test',
  image: 'elanous-harness:local',
  repoUrl: 'https://github.com/example/repo.git',
  deadlineSeconds: 60,
  command: ['echo', 'hi'],
  provenance: { actorKind: 'seat', actor: 'OPC', kind: 'command', run: 'test-run-12345678',
    phase: 'exec', requestedAt: '2026-10-20T09:00:00Z' },
};

const testProvenance = { actorKind: 'seat', actor: 'OPC', kind: 'command', run: 'test-run-12345678',
  phase: 'exec', requestedAt: '2026-10-20T09:00:00Z' };
// The required launch identity changes the baseline bytes; optional Job fields must still leave this baseline untouched.
const PROVENANCE_MANIFEST_SHA256 = '885410325c0a6335a8132ed1e56052e85dabaf1b4c4ba0ae4a57bd2c880c6251';
const runPodCommand = (options: RunPodCommandOptions) => runPodCommandImpl({ provenance: testProvenance, ...options });

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

  test('memoryLimit raises only the container memory limit; omitted keeps 16Gi and the baseline bytes', () => {
    const original = manifest({ clone: true });
    const raised = manifest({ clone: true, memoryLimit: '32Gi' });
    const limits = (m: ReturnType<typeof manifest>) => (m.spec as { template: { spec: { containers: Array<{ resources: { limits: { memory: string } } }> } } }).template.spec.containers[0]!.resources.limits;
    expect(limits(original).memory).toBe('16Gi');
    expect(limits(raised).memory).toBe('32Gi');
    expect(JSON.stringify(manifest({ clone: true, memoryLimit: undefined }))).toBe(JSON.stringify(original));
  });

  test('hostMirror mounts a read-only Directory; omitted mirror preserves the baseline manifest bytes', () => {
    const original = manifest({ clone: true });
    const withMirror = manifest({ clone: true, hostMirror: '/mirror-host/elanous-agent.git' });
    const spec = (withMirror.spec as { template: { spec: { volumes: unknown[]; containers: Array<{ volumeMounts: unknown[] }> } } }).template.spec;
    expect(spec.volumes).toContainEqual({ name: 'host-mirror', hostPath: { path: '/mirror-host/elanous-agent.git', type: 'Directory' } });
    expect(spec.containers[0]!.volumeMounts).toContainEqual({ name: 'host-mirror', mountPath: '/host-mirror', readOnly: true });
    expect(createHash('sha256').update(JSON.stringify(original)).digest('hex')).toBe(PROVENANCE_MANIFEST_SHA256);
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
    // GATE-WARM-BOOT-NO-INIT: no init container; the host dir is handed over on the node (runPodCommand), the child only reports.
    expect(spec.initContainers).toBeUndefined();
    expect(podCommandScript(cached)).toContain(`[host-dirs] could not prepare $d`);
    expect(podCommandScript(cached)).toContain('if [ -d /bun-cache ] && [ -w /bun-cache ]; then export BUN_INSTALL_CACHE_DIR=/bun-cache; fi;');
    expect(createHash('sha256').update(JSON.stringify(original)).digest('hex')).toBe(PROVENANCE_MANIFEST_SHA256);
    expect(JSON.stringify(manifest({ clone: true, bunCache: undefined }))).toBe(JSON.stringify(original));
    expect(podCommandScript(original)).not.toContain('BUN_INSTALL_CACHE_DIR');
  });

  test('GATE-INSTALL-CACHE: install slots mount a hostPath; no init container and no root container hands them over', () => {
    const original = manifest({ clone: true });
    const slotted = manifest({ clone: true, bunCache: '/srv/bun-cache', installSlots: '/var/lib/elanous/gate-install-slots' });
    const spec = (slotted.spec as { template: { spec: { volumes: unknown[]; containers: Array<Record<string, unknown> & { volumeMounts: unknown[] }>; initContainers?: unknown[] } } }).template.spec;
    expect(spec.volumes).toContainEqual({ name: 'install-slots', hostPath: { path: '/var/lib/elanous/gate-install-slots', type: 'DirectoryOrCreate' } });
    expect(spec.containers[0]!.volumeMounts).toContainEqual({ name: 'install-slots', mountPath: '/gate-install-slots', readOnly: false });
    // GATE-WARM-BOOT-NO-INIT (10-15): #27805 measured init 2 → 354 s · init 1 → 41 s · none → 1 s on node-b k3d.
    expect(spec.initContainers).toBeUndefined();
    expect(spec.containers[0]!.securityContext).toBeUndefined();
    const script = podCommandScript(slotted);
    expect(script).not.toContain('chown');
    // The child only reports an unwritable dir (never fails on it), after the isolation probe passed.
    expect(script).toContain(`for d in '/bun-cache' '/gate-install-slots'; do [ -d "$d" ] && [ -w "$d" ] || echo "[host-dirs] could not prepare $d`);
    expect(script.indexOf('[host-dirs]')).toBeGreaterThan(script.indexOf('isolation enforced'));
    expect(JSON.stringify(manifest({ clone: true, installSlots: undefined }))).toBe(JSON.stringify(original));
  });

  test('GATE-WARM-BOOT-NO-INIT: every manifest has zero init containers and the isolation probe is the child shell first line', () => {
    for (const over of [{}, { clone: true }, { skills: ['omni-crawl'] }, { llm: 'grok' as const }, { clone: true, bunCache: '/srv/bun-cache', installSlots: '/var/lib/elanous/gate-install-slots' }]) {
      const m = manifest(over);
      const spec = (m.spec as { template: { spec: Record<string, unknown> } }).template.spec;
      expect(spec.initContainers).toBeUndefined();
      const script = podCommandScript(m);
      expect(script.split('\n')[0]).toBe('elanous_isolation_gate() {');
      // The probe passes before any credential line or the command runs.
      const probe = script.indexOf('elanous_isolation_gate || exit 1');
      expect(probe).toBeGreaterThan(0);
      for (const later of ['/creds/', 'set -- ', '"$@"']) if (script.includes(later)) expect(script.indexOf(later)).toBeGreaterThan(probe);
      // Same probe, same log lines and exit code as the old `isolation-gate` init container.
      expect(script).toContain('curl -s -m 1 -o /dev/null http://host.orb.internal:31415/health || curl -s -m 1 -o /dev/null http://core.elanous-prod:8080/');
      expect(script).toContain('echo "[gate] isolation enforced after ${i} probes"; return 0;');
      expect(script).toContain('echo "[gate] ISOLATION NOT ENFORCED within 30s"; exit 1');
    }
  });

  test('GATE-WARM-BOOT-NO-INIT: the probe lines run in bash — enforced continues, unreachable daemons pass, a reachable one exits 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-iso-probe-'));
    try {
      const probe = podCommandScript(manifest({})).split('\n').slice(0, 10).join('\n');
      expect(probe.split('\n').at(-1)).toBe('elanous_isolation_gate || exit 1');
      const run = (curlRc: number) => {
        writeFileSync(join(dir, 'curl'), `#!/bin/sh\nexit ${curlRc}\n`); chmodSync(join(dir, 'curl'), 0o755);
        writeFileSync(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n'); chmodSync(join(dir, 'sleep'), 0o755);
        return spawnSync('bash', ['-c', `${probe}\necho CHILD-RAN`], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}` } });
      };
      const blocked = run(7);
      expect(blocked.status).toBe(0);
      expect(blocked.stdout).toBe('[gate] isolation enforced after 3 probes\nCHILD-RAN\n');
      const open = run(0);
      expect(open.status).toBe(1);
      expect(open.stdout).toBe('[gate] ISOLATION NOT ENFORCED within 30s\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('W5: tmpfsSizeLimit mounts a memory emptyDir as TMPDIR; omitted keeps the baseline bytes', () => {
    const original = manifest({ clone: true });
    const spec = (manifest({ clone: true, tmpfsSizeLimit: '2Gi' }).spec as { template: { spec: { volumes: unknown[]; containers: Array<{ env: unknown[]; volumeMounts: unknown[] }> } } }).template.spec;
    expect(spec.volumes).toContainEqual({ name: 'tmp-mem', emptyDir: { medium: 'Memory', sizeLimit: '2Gi' } });
    expect(spec.containers[0]!.volumeMounts).toContainEqual({ name: 'tmp-mem', mountPath: '/tmp-mem' });
    expect(spec.containers[0]!.env).toContainEqual({ name: 'TMPDIR', value: '/tmp-mem' });
    expect(JSON.stringify(manifest({ clone: true, tmpfsSizeLimit: undefined }))).toBe(JSON.stringify(original));
    expect(JSON.stringify(manifest({ clone: true, tmpfsSizeLimit: ' ' }))).toBe(JSON.stringify(original));
  });

  test('GATE-SPEED A3①: cpu omitted keeps request 1 / limit 4 and the baseline bytes; cpu override reaches the Job spec', () => {
    const res = (m: ReturnType<typeof manifest>) => (m.spec as { template: { spec: { containers: Array<{ resources: { requests: Record<string, string>; limits: Record<string, string> } }> } } }).template.spec.containers[0]!.resources;
    const original = manifest({ clone: true });
    expect(res(original)).toEqual({ requests: { cpu: '1', memory: '6Gi' }, limits: { memory: '16Gi', cpu: '4' } });
    expect(createHash('sha256').update(JSON.stringify(original)).digest('hex')).toBe(PROVENANCE_MANIFEST_SHA256);
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

  test('outbox sends smaller files first, breaks size ties by name, and preserves the 20 MiB budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-cmd-artifact-order-'));
    const outbox = join(dir, 'outbox');
    mkdirSync(outbox);
    try {
      const large = Buffer.alloc(5 * 1024 * 1024, 'x');
      for (const name of ['large-4', 'large-3', 'large-2', 'large-1']) writeFileSync(join(outbox, name), large);
      writeFileSync(join(outbox, 'note-z'), 'z');
      writeFileSync(join(outbox, 'note-a'), 'a');
      const script = podCommandScript(manifest({ command: ['true'] }));
      const ran = spawnSync('bash', ['-c', script.slice(script.indexOf('set -- '))], {
        encoding: 'utf8', env: { ...process.env, HOME: dir }, maxBuffer: 2 * 1024 * 1024,
      });
      expect(ran.status).toBe(0);
      const names = ran.stdout.split('\n').filter((line) => line.startsWith('ELANOUS_POD_ARTIFACT '))
        .map((line) => Buffer.from(line.split(' ')[1]!, 'base64url').toString());
      expect(names).toEqual(['note-a', 'note-z', 'large-1', 'large-2', 'large-3']);
      expect(ran.stdout).toContain('ELANOUS_POD_ARTIFACT_SKIPPED large-4 5242880');
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

  // SHA-256 of the default JSON manifest (base + clone: true) — re-pinned 10-15 for GATE-POD-RESULT-MARKER (done-marker line) then GATE-WARM-BOOT-NO-INIT (no init container · probe in the child shell), 10-16 TA-POD-WARMBOOT-PARITY (MIRROR_SKIP reason line); a change here means the default manifest moved.
  test('commit source checks out the requested SHA; omitted source retains the default manifest bytes', () => {
    const source = { kind: 'commit' as const, sha: 'a'.repeat(40) };
    const original = PROVENANCE_MANIFEST_SHA256;
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
  test('a prepared producer Pod hands two commit-pinned files to its consumer Job', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-warm-consumer-'));
    const commit = 'a'.repeat(40);
    const image = 'registry.local/elanous-harness:aaaaaaaaaaaa';
    const producer = 'prepared-source-1';
    const files = { 'package.json': '{"name":"warm-fixture"}\n', 'src/first.ts': 'export const first = 1;\n' };
    const applied: Record<string, any>[] = [];
    const calls: string[][] = [];
    const linked: Array<Record<string, unknown>> = [];
    const staged = join(root, 'staged');
    const consumer = join(root, 'consumer');
    const producerCwd = join(root, 'producer-cwd');
    mkdirSync(staged);
    mkdirSync(consumer);
    mkdirSync(join(producerCwd, 'repo', 'src'), { recursive: true });
    for (const [path, content] of Object.entries(files)) writeFileSync(join(producerCwd, 'repo', path), content);
    const gitStub = join(root, 'git');
    writeFileSync(gitStub, `#!/bin/sh\necho ${commit}\n`);
    chmodSync(gitStub, 0o755);
    // The child image has GNU install -D; keep this shell fixture portable on macOS.
    const installStub = join(root, 'install');
    writeFileSync(installStub, '#!/bin/sh\n[ "$1" = -m ] && [ "$2" = 644 ] && [ "$3" = -D ] || exit 2\nmkdir -p "$(dirname "$5")" || exit 2\ncp "$4" "$5" || exit 2\nchmod 644 "$5"\n');
    chmodSync(installStub, 0o755);
    const copied = { status: null as number | null, output: '', error: '' };
    let consumerPods = [{ metadata: { name: 'warm-consumer-1-pod' }, spec: { containers: [{ name: 'child', image }] } }];
    try {
      const options: Parameters<typeof runPodCommand>[0] = {
        command: ['true'], name: 'warm-consumer-1', image, imageCommit: commit,
        clone: true, source: { kind: 'commit', sha: commit }, ghToken: () => 'test-token',
        warmProducer: { pod: producer, podUid: 'producer-uid', context: '', image, commit, files: ['package.json', 'src/first.ts'] },
        log: (_category, event, data) => { if (event === 'warm-source-linked') linked.push(data); },
        kubectl: (args, input) => {
          calls.push([...args]);
          if (input) {
            const body = JSON.parse(input);
            applied.push(body);
            if (body.kind === 'ConfigMap') for (const [key, encoded] of Object.entries(body.binaryData as Record<string, string>)) writeFileSync(join(staged, key), Buffer.from(encoded, 'base64'));
            if (body.kind === 'Job') {
              const copyLines = podCommandScript(body).split('\n').filter((line) => line.startsWith('if [ "$(git rev-parse HEAD)"') || line.startsWith('install -m 644 -D /warm-source/') || line.startsWith("printf 'ELANOUS_WARM_SOURCE "));
              const run = spawnSync('bash', ['-c', copyLines.join('\n').replaceAll('/warm-source/', `${staged}/`)], { cwd: consumer, encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
              copied.status = run.status;
              copied.output = run.stdout;
              copied.error = run.stderr;
            }
          }
          if (args.includes('get') && args.includes('pod') && args.includes(producer)) return { status: 0, stdout: JSON.stringify({ metadata: { name: producer, uid: 'producer-uid' }, spec: { containers: [{ name: 'child', image }] } }), stderr: '' };
          if (args.includes('exec') && args.includes(producer)) {
            const line = args.at(-1)!;
            if (line.includes('rev-parse HEAD')) {
              expect(line).toBe('git -C repo rev-parse HEAD');
              expect(existsSync(join(producerCwd, 'repo'))).toBe(true);
              return { status: 0, stdout: `${commit}\n`, stderr: '' };
            }
            const match = /^base64 -w0 'repo\/([^']+)'$/u.exec(line);
            expect(match).not.toBeNull();
            const source = join(producerCwd, 'repo', match![1]!);
            expect(existsSync(source)).toBe(true);
            return { status: 0, stdout: readFileSync(source).toString('base64'), stderr: '' };
          }
          if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
          if (args.includes('pods') && args.includes('json')) return { status: 0, stdout: JSON.stringify({ items: consumerPods }), stderr: '' };
          if (args.includes('logs')) {
            if (copied.status !== 0) throw new Error(`consumer fixture failed ${copied.status}: ${copied.output} ${copied.error}`);
            return { status: 0, stdout: copied.output + Object.keys(files).map((path) => artifactLine(path, readFileSync(join(consumer, path), 'utf8'))).join('\n'), stderr: copied.error };
          }
          return { status: 0, stdout: '0', stderr: '' };
        },
        env: {}, configHostMirror: () => undefined, artifactsRoot: root,
      };
      const result = await runPodCommand(options);
      const config = applied.find((body) => body.kind === 'ConfigMap')!;
      const job = applied.find((body) => body.kind === 'Job')!;
      expect(config.metadata.name).toBe(`warm-consumer-1-${job.metadata.labels['elanous.launch']}`);
      expect(config.binaryData).toEqual({ 'file-0': Buffer.from(files['package.json']).toString('base64'), 'file-1': Buffer.from(files['src/first.ts']).toString('base64') });
      expect(job.spec.template.spec.containers[0].image).toBe(image);
      expect(job.spec.template.spec.volumes).toContainEqual({ name: 'warm-source', configMap: { name: config.metadata.name } });
      expect(job.spec.template.spec.containers[0].volumeMounts).toContainEqual({ name: 'warm-source', mountPath: '/warm-source', readOnly: true });
      const script = podCommandScript(job);
      expect(script).toContain(`git rev-parse HEAD`);
      expect(script).toContain(commit);
      for (const [i, path] of Object.keys(files).entries()) {
        expect(script).toContain(`/warm-source/file-${i}`);
        expect(script).toContain(path);
      }
      expect(calls.filter((args) => args.includes('exec') && args.includes(producer))).toHaveLength(3);
      expect(calls.some((args) => args.includes('get') && args.includes('pod') && args.includes(producer))).toBe(true);
      expect(result.image).toBe(image);
      expect(linked).toEqual([{ producerPod: producer, consumerPod: 'warm-consumer-1-pod', image, commit, files: ['package.json', 'src/first.ts'] }]);
      expect(result.artifacts?.names).toEqual(['package.json', 'src/first.ts']);
      for (const [path, content] of Object.entries(files)) expect(readFileSync(join(result.artifactsDir, path), 'utf8')).toBe(content);
      expect(copied.status).toBe(0);
      for (const [path, content] of Object.entries(files)) expect(readFileSync(join(consumer, path), 'utf8')).toBe(content);
      consumerPods = [...consumerPods, { metadata: { name: 'warm-consumer-retry-pod' }, spec: { containers: [{ name: 'child', image }] } }];
      await expect(runPodCommand(options)).rejects.toThrow('consumer Pod identity or image mismatch');
      expect(linked).toHaveLength(1);
      consumerPods = consumerPods.slice(0, 1);
      await expect(runPodCommand({ ...options, warmProducer: { ...options.warmProducer!, podUid: 'replaced-uid' } })).rejects.toThrow('producer Pod identity or image mismatch');
      expect(linked).toHaveLength(1);
      writeFileSync(gitStub, '#!/bin/sh\necho ' + 'b'.repeat(40) + '\n');
      const handoff = script.split('\n').filter((line) => line.startsWith('if [ "$(git rev-parse HEAD)"') || line.startsWith('install -m 644 -D /warm-source/') || line.startsWith("printf 'ELANOUS_WARM_SOURCE ")).join('\n').replaceAll('/warm-source/', `${staged}/`);
      expect(spawnSync('bash', ['-c', handoff], { cwd: consumer, env: { ...process.env, PATH: `${root}:${process.env.PATH}` } }).status).toBe(5);
      expect(calls.some((args) => args.includes('delete') && args.includes('configmap') && args.includes('elanous.job=warm-consumer-1,elanous.launch=' + job.metadata.labels['elanous.launch']))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a generated-length Job uses a valid, unique ConfigMap name for its warm files', async () => {
    const name = 'si-' + 'a'.repeat(55);
    const launch = '123456789abc';
    const job = manifest({ name, launch, clone: true, source: { kind: 'commit', sha: 'a'.repeat(40) }, warmFiles: ['package.json', 'src/first.ts'] });
    const source = (job.spec as { template: { spec: { volumes: Array<{ name: string; configMap?: { name: string } }> } } }).template.spec.volumes.find((volume) => volume.name === 'warm-source')!.configMap!.name;
    expect(source.length).toBeLessThanOrEqual(63);
    expect(source).not.toBe(`${name}-source`);
    expect(source).toContain(launch);
  });

  test('a consumer with the same image and commit but altered first file is rejected before collection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-warm-corrupt-'));
    const commit = 'a'.repeat(40);
    const image = 'registry.local/elanous-harness:aaaaaaaaaaaa';
    const producer = 'prepared-source-1';
    const files = { 'package.json': '{"name":"warm-fixture"}\n', 'src/first.ts': 'export const first = 1;\n' };
    const calls: string[][] = [];
    try {
      await expect(runPodCommand({ command: ['true'], name: 'warm-corrupt', image, imageCommit: commit,
        clone: true, source: { kind: 'commit', sha: commit }, ghToken: () => 'test-token',
        warmProducer: { pod: producer, podUid: 'producer-uid', context: '', image, commit, files: ['package.json', 'src/first.ts'] },
        kubectl: (args) => {
          calls.push([...args]);
          if (args.includes('get') && args.includes('pod') && args.includes(producer)) return { status: 0, stdout: JSON.stringify({ metadata: { name: producer, uid: 'producer-uid' }, spec: { containers: [{ name: 'child', image }] } }), stderr: '' };
          if (args.includes('exec') && args.includes(producer)) {
            const line = args.at(-1)!;
            const path = /^base64 -w0 'repo\/([^']+)'$/u.exec(line)?.[1] as keyof typeof files | undefined;
            return { status: 0, stdout: path ? Buffer.from(files[path]).toString('base64') : `${commit}\n`, stderr: '' };
          }
          if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
          if (args.includes('pods') && args.includes('json')) return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'warm-corrupt-pod' }, spec: { containers: [{ name: 'child', image }] } }] }), stderr: '' };
          if (args.includes('logs')) return { status: 0, stdout: [
            `ELANOUS_WARM_SOURCE package.json ${createHash('sha256').update('altered').digest('hex')} ${commit}`,
            `ELANOUS_WARM_SOURCE src/first.ts ${createHash('sha256').update(files['src/first.ts']).digest('hex')} ${commit}`,
          ].join('\n'), stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }, env: {}, configHostMirror: () => undefined, artifactsRoot: root,
      })).rejects.toThrow('consumer file or commit mismatch: package.json');
      expect(calls.some((args) => args.includes('delete') && args.includes('configmap') && args.includes('-l'))).toBe(true);
      expect(existsSync(join(root, 'warm-corrupt', 'child.log'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a producer with a different image or commit cannot hand files to a consumer Job', async () => {
    const commit = 'a'.repeat(40);
    const image = 'registry.local/elanous-harness:aaaaaaaaaaaa';
    const applied: string[] = [];
    for (const mismatch of ['image', 'commit'] as const) {
      await expect(runPodCommand({ command: ['true'], name: 'warm-mismatch', image, imageCommit: commit,
        clone: true, source: { kind: 'commit', sha: commit }, ghToken: () => 'test-token',
        warmProducer: { pod: 'producer-1', podUid: 'producer-uid', context: '', image, commit, files: ['package.json', 'src/first.ts'] },
        kubectl: (args, input) => {
          if (input) applied.push(JSON.parse(input).kind);
          if (args.includes('get') && args.includes('pod')) return { status: 0, stdout: JSON.stringify({ metadata: { name: 'producer-1', uid: 'producer-uid' }, spec: { containers: [{ name: 'child', image: mismatch === 'image' ? 'wrong-image' : image }] } }), stderr: '' };
          if (args.includes('exec')) return { status: 0, stdout: `${mismatch === 'commit' ? 'b'.repeat(40) : commit}\n`, stderr: '' };
          return { status: 0, stdout: '', stderr: '' };
        }, env: {}, configHostMirror: () => undefined,
      })).rejects.toThrow(mismatch === 'image' ? 'identity or image mismatch' : 'commit mismatch');
    }
    expect(applied).toEqual([]);
  });

  test('shelf Job requires its commit and registry image; fails closed without the tag and keeps ordinary Job bytes', async () => {
    const commit = 'a'.repeat(40);
    const image = 'k3d-elanous-registry:5050/elanous-harness:aaaaaaaaaaaa';
    const applied: Record<string, any>[] = [];
    const member: PodPoolMember = { context: 'pool-node-b', sshHost: 'node-b', capacity: 1, k3dCluster: 'elanous-pool', registry: 'k3d-elanous-registry:5050' };
    const run = (tag: boolean) => runPodCommand({ command: ['bun', 'bin/elanous.mjs', '--test', '--version'], image, shelfImage: image,
      shelfLookup: () => tag ? image : null,
      imageCommit: commit, clone: true, source: { kind: 'commit', sha: commit }, ghToken: () => 'test-token',
      poolScheduler: new PodPoolScheduler([member]), configHostMirror: () => undefined, artifactsRoot: '/tmp/pod-shelf-job-test',
      kubectl: (args, input) => {
        if (input) applied.push(JSON.parse(input));
        if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
        if (args.includes('logs')) return { status: 0, stdout: 'version tail\n', stderr: '' };
        return { status: 0, stdout: '0', stderr: '' };
      },
      syncImages: async () => { throw new Error('shelf must not re-sync a mutable image'); },
      // Registry lookup is remote; a missing tag must fail rather than launching :local.
      env: { ELANOUS_POD_POOL: 'pool-node-b@node-b:1#k3d-elanous-registry:5050' },
    });
    await expect(run(false)).rejects.toThrow('selected image unavailable');
    expect(applied.find((entry) => entry.kind === 'Job')).toBeUndefined();
    const result = await run(true);
    expect(result).toMatchObject({ image, exitCode: 0 });
    const job = applied.find((entry) => entry.kind === 'Job')!;
    expect(job.spec.template.spec.containers[0]).toMatchObject({ image, imagePullPolicy: 'IfNotPresent' });
    expect(podCommandScript(job)).toContain(`git checkout --detach ${commit}`);
    expect(readFileSync(join(result.artifactsDir, 'child.log'), 'utf8')).toBe('version tail\n');
    expect(createHash('sha256').update(JSON.stringify(manifest({ clone: true }))).digest('hex')).toBe(PROVENANCE_MANIFEST_SHA256);
  });

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
      expect(job.spec.template.spec.initContainers).toBeUndefined();
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
    expect(applied!.spec.template.spec.initContainers).toBeUndefined();
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

  test('GATE-MULTI-HOST: a Job whose status stays unreadable (member gone mid-Job) throws after statusUnreadableMs instead of polling forever; omitted = keeps polling', async () => {
    const member: PodPoolMember = { context: 'pool-node-c', sshHost: 'node-c', capacity: 2, k3dCluster: 'elanous-pool' };
    const run = (statusUnreadableMs: number | undefined, polls: { n: number }, boundedShadow = false) => {
      const pool = new PodPoolScheduler([member]);
      const commands: string[][] = [];
      return { pool, commands, done: runPodCommand({ command: ['true'], poolScheduler: pool, name: 'gate-lost-member', ...(statusUnreadableMs !== undefined ? { statusUnreadableMs } : {}),
        ...(boundedShadow ? { signal: new AbortController().signal } : {}),
        sleep: async () => { if (++polls.n > 5) throw new Error('still polling'); },
        kubectl: (args) => { commands.push([...args]); return args.some((arg) => arg.includes('.status.conditions'))
          ? { status: 1, stdout: '', stderr: 'Unable to connect to the server: dial tcp: i/o timeout' }
          : { status: 0, stdout: '', stderr: '' }; },
        syncImages: async () => new Map([[member.context, { ok: true, action: 'fresh' as const, detail: 'ready', ms: 1 }]]),
        imageCommit: null, env: {}, configHostMirror: () => undefined, artifactsRoot: '/tmp/pod-command-lost-member-test', log: () => {},
      }) };
    };
    const bounded = { n: 0 };
    const a = run(0, bounded, true);
    await expect(a.done).rejects.toThrow(/Job 상태를 0초 동안 못 읽었다\(pool-node-c\)/);
    expect(bounded.n).toBe(0);
    expect(a.pool.snapshot()).toEqual({ 'pool-node-c': 0 });
    expect(a.commands.some((args) => args.includes('delete') && args.includes('job') && args.includes('gate-lost-member'))).toBe(true);
    const ordinary = run(0, { n: 0 });
    await expect(ordinary.done).rejects.toThrow(/Job 상태를 0초 동안 못 읽었다/);
    expect(ordinary.commands.filter((args) => args.includes('delete') && args.includes('job') && args.includes('gate-lost-member'))).toHaveLength(0); // omitted signal keeps the prior cleanup policy
    const unbounded = { n: 0 };
    await expect(run(undefined, unbounded).done).rejects.toThrow('still polling');
    expect(unbounded.n).toBe(6);
  });

  test('PRLAND-SHADOW-HOST-TIMEOUT: abort stops Pending polling and deletes only its own Job', async () => {
    const controller = new AbortController();
    const member: PodPoolMember = { context: 'pool-node-b', sshHost: 'node-b', capacity: 1, k3dCluster: 'elanous-pool' };
    const pool = new PodPoolScheduler([member]);
    const commands: string[][] = [];
    let polls = 0;
    const pending = runPodCommand({ command: ['true'], name: 'shadow-timeout-test', signal: controller.signal, poolScheduler: pool,
      kubectl: (args) => {
        commands.push([...args]);
        if (args.some((arg) => arg.includes('.status.conditions'))) polls++;
        return { status: 0, stdout: '', stderr: '' };
      },
      syncImages: async () => new Map([[member.context, { ok: true, action: 'fresh' as const, detail: 'ready', ms: 1 }]]),
      sleep: async () => { controller.abort(new Error('shadow deadline')); },
      imageCommit: null, env: {}, configHostMirror: () => undefined,
      artifactsRoot: '/tmp/pod-command-shadow-timeout-test', log: () => {},
    });
    await expect(pending).rejects.toThrow('shadow deadline');
    expect(polls).toBe(1);
    expect(commands.filter((args) => args.includes('delete') && args.includes('job') && args.includes('shadow-timeout-test'))).toHaveLength(1);
    expect(commands.some((args) => args.includes('delete') && args.includes('secret'))).toBe(true);
    expect(pool.snapshot()).toEqual({ 'pool-node-b': 0 });
  });

  test('PRLAND-SHADOW-HOST-TIMEOUT: wall clock catches a deadline crossed inside synchronous status read', async () => {
    const member: PodPoolMember = { context: 'pool-node-b', sshHost: 'node-b', capacity: 1, k3dCluster: 'elanous-pool' };
    const pool = new PodPoolScheduler([member]);
    const commands: string[][] = [];
    let clock = 0;
    const pending = runPodCommand({ command: ['true'], name: 'shadow-wall-deadline', signal: new AbortController().signal,
      hostDeadlineAtMs: 100, nowMs: () => clock, poolScheduler: pool,
      kubectl: (args) => {
        commands.push([...args]);
        if (args.some((arg) => arg.includes('.status.conditions'))) clock = 101;
        return { status: 0, stdout: '', stderr: '' };
      },
      syncImages: async () => new Map([[member.context, { ok: true, action: 'fresh' as const, detail: 'ready', ms: 1 }]]),
      sleep: async () => { throw new Error('polled after host deadline'); },
      imageCommit: null, env: {}, configHostMirror: () => undefined,
      artifactsRoot: '/tmp/pod-command-shadow-wall-test', log: () => {},
    });
    await expect(pending).rejects.toThrow('pod shadow: host timeout');
    expect(commands.filter((args) => args.includes('delete') && args.includes('job') && args.includes('shadow-wall-deadline'))).toHaveLength(1);
    expect(pool.snapshot()).toEqual({ 'pool-node-b': 0 });
  });

  test('PRLAND-SHADOW-HOST-TIMEOUT: a Pending Pod poll that crosses the host deadline ends the loop with exactly one timeout record', async () => {
    // 격리 45분 교착 재현 입력: the Job status reads fine but never finishes — without the host deadline the loop never ends.
    const member: PodPoolMember = { context: 'pool-node-b', sshHost: 'node-b', capacity: 1, k3dCluster: 'elanous-pool' };
    const pool = new PodPoolScheduler([member]);
    const commands: string[][] = [];
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    let clock = 0;
    let sleeps = 0;
    const pending = runPodCommand({ command: ['true'], name: 'shadow-host-loop-timeout', signal: new AbortController().signal,
      hostDeadlineAtMs: 2_700_000, nowMs: () => clock, poolScheduler: pool,
      kubectl: (args) => {
        commands.push([...args]);
        return { status: 0, stdout: '', stderr: '' };
      },
      syncImages: async () => new Map([[member.context, { ok: true, action: 'fresh' as const, detail: 'ready', ms: 1 }]]),
      sleep: async () => { sleeps++; clock = 3_000_000; },
      imageCommit: null, env: {}, configHostMirror: () => undefined,
      artifactsRoot: '/tmp/pod-command-shadow-loop-test',
      log: (category, event, data) => { events.push({ category, event, data: data as Record<string, unknown> }); },
    });
    await expect(pending).rejects.toThrow('pod shadow: host timeout');
    // 폴링 중단: one Pending poll, one deadline crossing — never a second status read after the deadline.
    const statusReads = commands.filter((args) => args.some((arg) => arg.includes('.status.conditions')));
    expect(statusReads).toHaveLength(1);
    expect(sleeps).toBe(1);
    // 타임아웃 상태 레코드: 정확히 한 건 — deadline 초과 시각 ⊕ 최종 상태.
    const timeouts = events.filter((e) => e.event === 'host-timeout');
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toMatchObject({
      category: 'pod.command', data: { job: 'shadow-host-loop-timeout', hostDeadlineAtMs: 2_700_000, finalState: 'timeout' },
    });
    expect((timeouts[0]!.data as { nowMs?: number }).nowMs).toBeGreaterThanOrEqual(2_700_000);
    expect(pool.snapshot()).toEqual({ 'pool-node-b': 0 });
  });

  test('PRLAND-SHADOW-HOST-TIMEOUT: abort during pre-Job image sync returns and releases lease', async () => {
    const controller = new AbortController();
    const member: PodPoolMember = { context: 'pool-node-b', sshHost: 'node-b', capacity: 1, k3dCluster: 'elanous-pool' };
    const pool = new PodPoolScheduler([member]);
    let entered!: () => void;
    const syncing = new Promise<void>((resolve) => { entered = resolve; });
    const commands: string[][] = [];
    const pending = runPodCommand({ command: ['true'], signal: controller.signal, poolScheduler: pool,
      kubectl: (args) => { commands.push([...args]); return { status: 0, stdout: '', stderr: '' }; },
      syncImages: async () => { entered(); return new Promise(() => {}); },
      imageCommit: null, env: {}, configHostMirror: () => undefined, log: () => {},
    });
    await syncing;
    controller.abort(new Error('shadow deadline during image sync'));
    await expect(pending).rejects.toThrow('shadow deadline during image sync');
    expect(pool.snapshot()).toEqual({ 'pool-node-b': 0 });
    expect(commands.some((args) => args.includes('apply'))).toBe(false);
  });

  test('PRLAND-SHADOW-HOST-TIMEOUT: late pool acquisition is released after caller abort', async () => {
    const controller = new AbortController();
    const member: PodPoolMember = { context: 'pool-node-b', sshHost: 'node-b', capacity: 1, k3dCluster: 'elanous-pool' };
    let finish!: (member: PodPoolMember) => void;
    let releases = 0;
    const pool = {
      tryAcquire: () => new Promise<PodPoolMember>((resolve) => { finish = resolve; }),
      release: () => { releases++; },
    } as unknown as PodPoolScheduler;
    const pending = runPodCommand({ command: ['true'], signal: controller.signal, poolScheduler: pool,
      kubectl: () => ({ status: 0, stdout: '', stderr: '' }), imageCommit: null, env: {}, configHostMirror: () => undefined,
    });
    controller.abort(new Error('shadow deadline during acquisition'));
    await expect(pending).rejects.toThrow('shadow deadline during acquisition');
    finish(member);
    await Promise.resolve();
    expect(releases).toBe(1);
  });

  test('pool registry tag uses IfNotPresent for the child (no init container)', async () => {
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
    expect(job!.spec.template.spec.initContainers).toBeUndefined();
    expect(job!.spec.template.spec.containers[0]).toMatchObject({ image: ref, imagePullPolicy: 'IfNotPresent' });
  });

  test('GATE-WARM-BOOT: a commit-pinned clone on a pool host seeds that commit into the host mirror before the Job', async () => {
    const member: PodPoolMember = { context: 'pool-node-b', sshHost: 'node-b', capacity: 1, k3dCluster: 'elanous-pool', registry: 'k3d-elanous-registry:5050' };
    const run: RemoteRun = (_host, cmd) => ({ status: 0, stdout: cmd.includes('/tags/list') ? '{"tags":["abcdef123456"]}' : 'abcdef1234567890', stderr: '' });
    const sha = 'e1783835d5b719e397b697452d1c2fe358b7c3f1';
    const order: string[] = [];
    const seeds: Array<{ host: string; commit: string; cwd: string }> = [];
    const events: Array<[string, Record<string, unknown> | undefined]> = [];
    const launch = (opts: { source?: { kind: 'commit'; sha: string }; mirror?: string }) => runPodCommand({ command: ['true'], imageCommit: 'abcdef1234567890', clone: true, ghToken: () => 'gh-x',
      ...(opts.source ? { source: opts.source } : {}),
      seedMirror: async (o) => { order.push('seed'); seeds.push(o); return { host: o.host, ok: true, ms: 5 }; }, mirrorSeedCwd: '/repo',
      log: (c, e, d) => { if (e === 'mirror-seed') events.push([e, d as Record<string, unknown>]); },
      checkPool: (members) => ({ ok: true, ready: [...members], dropped: [] }),
      syncImages: (members, image, commit, deps) => syncPoolImages(members, image, commit, { ...deps, run, buildScript: null }),
      kubectl: (args, input) => {
        if (input && JSON.parse(input).kind === 'Job') order.push('job');
        if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
        return { status: 0, stdout: '0', stderr: '' };
      }, env: { ELANOUS_POD_POOL: 'pool-node-b@node-b:1#k3d-elanous-registry:5050' }, configHostMirror: () => opts.mirror, artifactsRoot: '/tmp/pod-command-seed-test',
    });
    await launch({ source: { kind: 'commit', sha }, mirror: '/mirror-host/elanous-agent.git' });
    expect(seeds).toEqual([{ host: member.sshHost!, commit: sha, cwd: '/repo' }]);
    expect(order).toEqual(['seed', 'job']);
    expect(events).toEqual([['mirror-seed', { host: 'node-b', commit: sha, ok: true, ms: 5 }]]);
    // No mirror configured, or not a commit-pinned clone: nothing is pushed.
    await launch({ source: { kind: 'commit', sha } });
    await launch({ mirror: '/mirror-host/elanous-agent.git' });
    expect(seeds).toHaveLength(1);
  });

  test('GATE-WARM-BOOT-NO-INIT: host dirs are handed over on the placed member once before the Job; failure only logs', async () => {
    const member: PodPoolMember = { context: 'pool-node-b', sshHost: 'node-b', capacity: 1, k3dCluster: 'elanous-pool' };
    const order: string[] = [];
    const preps: Array<{ member: PodPoolMember; hostPaths: readonly string[] }> = [];
    const events: Array<Record<string, unknown>> = [];
    const launch = (o: { ok: boolean; installSlots?: string; pool?: boolean }) => runPodCommand({ command: ['true'], name: 'host-dirs-prep', imageCommit: null,
      ...(o.pool === false ? {} : { poolScheduler: new PodPoolScheduler([member]) }),
      ...(o.installSlots ? { installSlots: o.installSlots, bunCache: '/srv/bun-cache' } : {}),
      prepareHostDirs: async (p) => { order.push('prep'); preps.push(p); return o.ok ? { host: 'node-b', ok: true, ms: 7 } : { host: 'node-b', ok: false, ms: 3, detail: 'no k3d node' }; },
      log: (_c, e, d) => { if (e === 'host-dirs-prep') events.push(d as Record<string, unknown>); },
      syncImages: async () => new Map([[member.context, { ok: true, action: 'fresh' as const, detail: 'ready', ms: 1 }]]),
      kubectl: (args, input) => {
        if (input && JSON.parse(input).kind === 'Job') order.push('job');
        if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
        return { status: 0, stdout: '0', stderr: '' };
      }, env: {}, configHostMirror: () => undefined, artifactsRoot: '/tmp/pod-command-host-dirs-test',
    });
    await launch({ ok: true, installSlots: '/var/lib/elanous/gate-install-slots' });
    expect(order).toEqual(['prep', 'job']);
    expect(preps).toEqual([{ member, hostPaths: ['/srv/bun-cache', '/var/lib/elanous/gate-install-slots'] }]);
    expect(events).toEqual([{ host: 'node-b', ok: true, ms: 7, paths: ['/srv/bun-cache', '/var/lib/elanous/gate-install-slots'] }]);
    // A failed hand-over still launches the Job (the child falls back) and leaves the reason in the log.
    order.length = 0;
    await launch({ ok: false, installSlots: '/var/lib/elanous/gate-install-slots' });
    expect(order).toEqual(['prep', 'job']);
    expect(events.at(-1)).toMatchObject({ ok: false, detail: 'no k3d node' });
    // No host dirs: nothing to hand over. No pool member: observable skip.
    order.length = 0;
    await launch({ ok: true });
    expect(order).toEqual(['job']);
    await launch({ ok: true, installSlots: '/var/lib/elanous/gate-install-slots', pool: false });
    expect(events.at(-1)).toEqual({ ok: false, reason: 'no-pool-member', paths: ['/srv/bun-cache', '/var/lib/elanous/gate-install-slots'] });
    // An injected kubectl without a seam never reaches a host, but the skip is still observed.
    const skipped: Array<Record<string, unknown>> = [];
    await runPodCommand({ command: ['true'], name: 'host-dirs-skip', imageCommit: null, poolScheduler: new PodPoolScheduler([member]),
      installSlots: '/var/lib/elanous/gate-install-slots',
      log: (_c, e, d) => { if (e === 'host-dirs-prep') skipped.push(d as Record<string, unknown>); },
      syncImages: async () => new Map([[member.context, { ok: true, action: 'fresh' as const, detail: 'ready', ms: 1 }]]),
      kubectl: (args) => args.some((arg) => arg.includes('.status.conditions')) ? { status: 0, stdout: 'Complete', stderr: '' } : { status: 0, stdout: '0', stderr: '' },
      env: {}, configHostMirror: () => undefined, artifactsRoot: '/tmp/pod-command-host-dirs-test',
    });
    expect(skipped).toEqual([{ ok: false, reason: 'prep-disabled', paths: ['/var/lib/elanous/gate-install-slots'] }]);
  });

  test('GATE-WARM-BOOT-NO-INIT: when the node-side hand-over did not succeed the Job keeps a root host-dirs init (uid 1000 can write)', async () => {
    const member: PodPoolMember = { context: 'pool-node-b', sshHost: 'node-b', capacity: 1, k3dCluster: 'elanous-pool' };
    const initsOf = async (o: { prep?: 'ok' | 'fail'; pool?: boolean; hostDirs?: boolean }) => {
      let job: { spec: { template: { spec: { initContainers?: Array<{ name: string; securityContext?: { runAsUser: number }; args: string[]; volumeMounts: Array<{ mountPath: string }> }> } } } } | undefined;
      await runPodCommand({ command: ['true'], name: 'host-dirs-init', imageCommit: null,
        ...(o.pool === false ? {} : { poolScheduler: new PodPoolScheduler([member]) }),
        ...(o.hostDirs === false ? {} : { installSlots: '/var/lib/elanous/gate-install-slots', bunCache: '/srv/bun-cache' }),
        ...(o.prep ? { prepareHostDirs: async () => o.prep === 'ok' ? { host: 'node-b', ok: true, ms: 1 } : { host: 'node-b', ok: false, ms: 1, detail: 'no k3d node' } } : {}),
        log: () => {},
        syncImages: async () => new Map([[member.context, { ok: true, action: 'fresh' as const, detail: 'ready', ms: 1 }]]),
        kubectl: (args, input) => {
          if (input && JSON.parse(input).kind === 'Job') job = JSON.parse(input);
          if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
          return { status: 0, stdout: '0', stderr: '' };
        }, env: {}, configHostMirror: () => undefined, artifactsRoot: '/tmp/pod-command-host-dirs-init-test',
      });
      return job!.spec.template.spec.initContainers;
    };
    // Prepared on the node → no init container (the warm-boot path).
    expect(await initsOf({ prep: 'ok' })).toBeUndefined();
    // No host dirs → nothing to hand over → no init.
    expect(await initsOf({ prep: 'ok', hostDirs: false })).toBeUndefined();
    // No pool member · hand-over failed · no seam (injected kubectl): the old in-Pod root hand-over comes back.
    for (const inits of [await initsOf({ pool: false }), await initsOf({ prep: 'fail' }), await initsOf({})]) {
      expect(inits).toHaveLength(1);
      expect(inits![0]!.name).toBe('host-dirs');
      expect(inits![0]!.securityContext).toEqual({ runAsUser: 0 });
      expect(inits![0]!.args[0]).toContain('chown 1000:1000');
      expect(inits![0]!.volumeMounts.length).toBe(2);
    }
  });

  test('GATE-WARM-BOOT-NO-INIT: the node script chowns in every k3d server/agent node and the memo runs once per member', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-host-dirs-'));
    try {
      const calls = join(dir, 'calls');
      writeFileSync(join(dir, 'docker'), `#!/bin/sh
if [ "$1" = ps ]; then echo "$*" >> ${calls}; printf 'k3d-elanous-pool-server-0 server\nk3d-elanous-pool-serverlb loadbalancer\nk3d-elanous-pool-agent-0 agent\n'; exit 0; fi
echo "$2 $5" >> ${calls}
exit 0
`);
      chmodSync(join(dir, 'docker'), 0o755);
      const script = podHostDirsNodeScript({ cluster: 'elanous-pool', hostPaths: ['/var/lib/elanous/gate-install-slots'] });
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}` } });
      expect(r.status).toBe(0);
      const lines = readFileSync(calls, 'utf8').trim().split('\n');
      expect(lines[0]).toContain('label=k3d.cluster=elanous-pool');
      expect(lines.slice(1)).toEqual([
        'k3d-elanous-pool-server-0 for d in /var/lib/elanous/gate-install-slots; do mkdir -p "$d" && chown 1000:1000 "$d" && chmod 0775 "$d" || { echo "[host-dirs] could not prepare $d"; exit 1; }; done',
        'k3d-elanous-pool-agent-0 for d in /var/lib/elanous/gate-install-slots; do mkdir -p "$d" && chown 1000:1000 "$d" && chmod 0775 "$d" || { echo "[host-dirs] could not prepare $d"; exit 1; }; done',
      ]);
      expect(() => podHostDirsNodeScript({ cluster: 'elanous-pool', hostPaths: ["/x'; rm -rf /"] })).toThrow('invalid host dir');
      expect(() => podHostDirsNodeScript({ cluster: 'a b', hostPaths: ['/x'] })).toThrow('invalid k3d cluster');
    } finally { rmSync(dir, { recursive: true, force: true }); }

    resetHostDirsPrepMemo();
    // Fake host shell: the node-IDs query answers with the current node set; every other script is a hand-over run.
    let nodeIds = 'id-server id-agent0';
    let idsRc = 0;
    let rc = 1;
    const runs: Array<string | undefined> = [];
    const scripts: string[] = [];
    const shell = async (host: string | undefined, script: string) => {
      if (script.includes('{{.ID}}')) return { rc: idsRc, output: idsRc ? '' : `${nodeIds} ` };
      runs.push(host); scripts.push(script);
      return { rc, output: rc ? 'docker: not found' : '' };
    };
    const member = { sshHost: 'node-b', k3dCluster: 'elanous-pool' };
    expect(await prepareHostDirsOnce({ member, hostPaths: ['/a'], shell })).toMatchObject({ host: 'node-b', ok: false, detail: 'docker: not found' });
    rc = 0;
    const [a, b] = await Promise.all([prepareHostDirsOnce({ member, hostPaths: ['/a'], shell }), prepareHostDirsOnce({ member, hostPaths: ['/a'], shell })]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    await prepareHostDirsOnce({ member: { k3dCluster: 'elanous-h1' }, hostPaths: ['/a'], shell });
    // failure not memoized (retried) · concurrent calls share one run · a local member runs without ssh.
    expect(runs).toEqual(['node-b', 'node-b', undefined]);
    // Same node set → remembered (no new run).
    expect((await prepareHostDirsOnce({ member, hostPaths: ['/a'], shell })).ok).toBe(true);
    expect(runs).toHaveLength(3);
    // Review mf: a recreated cluster / new agent (other container IDs) is a new generation → the hand-over runs again.
    nodeIds = 'id-server id-agent0 id-agent1';
    expect((await prepareHostDirsOnce({ member, hostPaths: ['/a'], shell })).ok).toBe(true);
    expect(runs).toHaveLength(4);
    // Unreadable node IDs → no memo: every call runs and success is not remembered.
    idsRc = 1;
    await prepareHostDirsOnce({ member, hostPaths: ['/a'], shell });
    await prepareHostDirsOnce({ member, hostPaths: ['/a'], shell });
    expect(runs).toHaveLength(6);
    idsRc = 0;
    // Memo is per path: a list overlapping an already-prepared path runs only the new path.
    scripts.length = 0;
    expect((await prepareHostDirsOnce({ member, hostPaths: ['/a', '/b'], shell })).ok).toBe(true);
    expect((await prepareHostDirsOnce({ member, hostPaths: ['/a', '/c'], shell })).ok).toBe(true);
    expect(await prepareHostDirsOnce({ member, hostPaths: ['/b', '/c'], shell })).toMatchObject({ ok: true });
    expect(scripts.map((script) => /for d in ([^;]+);/.exec(script)?.[1])).toEqual(['/b', '/c']);
    // The IDs query lists only server/agent containers of that cluster, sorted.
    expect(podHostDirsNodeIdsScript('elanous-pool')).toContain('label=k3d.cluster=elanous-pool');
    expect(podHostDirsNodeIdsScript('elanous-pool')).toContain('$2=="server"||$2=="agent"');
    expect(() => podHostDirsNodeIdsScript('a b')).toThrow('invalid k3d cluster');
    resetHostDirsPrepMemo();
  });

  test('GATE-WARM-BOOT-NO-INIT: a stuck host shell returns at the limit even when a grandchild holds the pipe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pod-host-shell-'));
    try {
      const pidFile = join(dir, 'pid');
      // `docker exec` stand-in: a grandchild that inherits stdout and never exits.
      const start = Date.now();
      const r = await hostShellWithin(undefined, `sh -c 'echo $$ > ${pidFile}; exec sleep 30' | cat`, 300);
      expect(Date.now() - start).toBeLessThan(5_000);
      expect(r.rc).toBe(124);
      expect(r.output).toContain('[host-dirs] timed out after 300 ms');
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      await new Promise((done) => setTimeout(done, 100));
      expect(() => process.kill(pid, 0)).toThrow();
      // A timed-out prep is a failure (not memoized) and the Job launch behind it goes on.
      resetHostDirsPrepMemo();
      const prep = await prepareHostDirsOnce({ member: { k3dCluster: 'elanous-pool' }, hostPaths: ['/a'], limitMs: 300,
        shell: (host, _script, limitMs) => hostShellWithin(host, 'sleep 30 | cat', limitMs) });
      expect(prep).toMatchObject({ host: 'local', ok: false });
      expect(prep.detail).toContain('timed out after 300 ms');
      resetHostDirsPrepMemo();
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
    expect(job!.spec.template.spec.initContainers).toBeUndefined();
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

  test('W5: runPodCommand passes tmpfsSizeLimit into the Job — volume, mount and TMPDIR together; omitted adds none', async () => {
    const run = async (tmpfsSizeLimit?: string) => {
      const inputs: string[] = [];
      await runPodCommand({ command: ['true'], env: {}, configHostMirror: () => undefined, ...(tmpfsSizeLimit ? { tmpfsSizeLimit } : {}),
        kubectl: (args, input) => {
          if (input) inputs.push(input);
          if (args.some((arg) => arg.includes('.status.conditions'))) return { status: 0, stdout: 'Complete', stderr: '' };
          return { status: 0, stdout: '0', stderr: '' };
        }, imageCommit: null, name: 'tmpfs-test', artifactsRoot: '/tmp/pod-command-tmpfs-test',
      });
      const job = inputs.map((body) => JSON.parse(body) as { kind: string; spec?: { template: { spec: { volumes?: unknown[]; containers: Array<{ env: unknown[]; volumeMounts?: unknown[] }> } } } }).find((item) => item.kind === 'Job');
      return job!.spec!.template.spec;
    };
    const withTmpfs = await run('2Gi');
    expect(withTmpfs.volumes).toContainEqual({ name: 'tmp-mem', emptyDir: { medium: 'Memory', sizeLimit: '2Gi' } });
    expect(withTmpfs.containers[0]!.volumeMounts).toContainEqual({ name: 'tmp-mem', mountPath: '/tmp-mem' });
    expect(withTmpfs.containers[0]!.env).toContainEqual({ name: 'TMPDIR', value: '/tmp-mem' });
    const plain = await run();
    expect(JSON.stringify(plain)).not.toContain('tmp-mem');
    expect(plain.containers[0]!.env).not.toContainEqual({ name: 'TMPDIR', value: '/tmp-mem' });
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

describe('GATE-POD-RESULT-MARKER — the child prints a done marker so the host skips the Job condition lag', () => {
  test('the script prints the marker after the artifact emit, right before exit', () => {
    const script = podCommandScript(podCommandJobManifest({ ...base, command: ['true'], skills: [] }));
    const lines = script.split('\n');
    expect(lines.at(-1)).toBe('exit $rc');
    expect(lines.at(-2)).toBe(`printf '\\n${POD_RESULT_MARKER} ${base.name} rc=%s\\n' "$rc"`);
    expect(script.indexOf('ELANOUS_POD_ARTIFACT %s')).toBeLessThan(script.indexOf(POD_RESULT_MARKER));
    // Bash produces exactly the tail the host strips — the command output bytes come back unchanged.
    const ran = spawnSync('bash', ['-c', `printf 'out\\nno-lf'; rc=4; ${lines.at(-2)}`], { encoding: 'utf8' });
    expect(splitPodResultMarker(ran.stdout, base.name)).toEqual({ logs: 'out\nno-lf', rc: 4 });
    expect(splitPodResultMarker('plain\n', base.name)).toEqual({ logs: 'plain\n', rc: null });
    // Another token (or the bare word a command could print) is not this launch's marker.
    expect(splitPodResultMarker(ran.stdout, 'other').rc).toBeNull();
    const withLaunch = podCommandScript(podCommandJobManifest({ ...base, launch: 'a1b2c3d4e5f6', command: ['true'], skills: [] }));
    expect(withLaunch).toContain(`${POD_RESULT_MARKER} a1b2c3d4e5f6 rc=%s`);
  });

  // conditions: what each condition poll returns · tails: what each tail read returns (last one repeats).
  const run = async (o: { conditions: string[]; tails: Array<{ status: number; stdout: string }>; logs: string; podExit?: string; logReads?: Array<{ status: number; stdout: string }> }) => {
    const calls: string[][] = [];
    const events: Array<Record<string, unknown>> = [];
    let cond = 0, tail = 0, logRead = 0, launch = '';
    const bind = (text: string) => text.replaceAll('LAUNCH', launch);
    const dir = mkdtempSync(join(tmpdir(), 'pod-marker-'));
    try {
      const result = await runPodCommand({
        command: ['true'], name: 'si-cmd-marker', imageCommit: null, artifactsRoot: dir, env: {}, configHostMirror: () => undefined,
        sleep: async () => {},
        log: (_c, event, data) => { events.push({ event, ...data }); },
        kubectl: (args, input) => {
          if (input?.includes('"kind":"Job"')) launch = /"elanous\.launch":"([0-9a-f]+)"/.exec(input)?.[1] ?? '';
          calls.push([...args]);
          const joined = args.join(' ');
          if (joined.includes('.status.conditions')) return { status: 0, stdout: o.conditions[Math.min(cond++, o.conditions.length - 1)]!, stderr: '' };
          if (joined.includes('containerStatuses')) return { status: 0, stdout: o.podExit ?? '9', stderr: '' };
          if (args.includes('--tail=2')) { const t = o.tails[Math.min(tail++, o.tails.length - 1)]!; return { status: t.status, stdout: bind(t.stdout), stderr: '' }; }
          if (args.includes('logs')) { const r = o.logReads?.[Math.min(logRead++, o.logReads.length - 1)]; return r ? { status: r.status, stdout: bind(r.stdout), stderr: r.status ? 'logs: transient' : '' } : { status: 0, stdout: bind(o.logs), stderr: '' }; }
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      return { result, calls, events, childLog: readFileSync(join(result.artifactsDir, 'child.log'), 'utf8') };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const done = (rc: number) => `\n${POD_RESULT_MARKER} LAUNCH rc=${rc}\n`;

  test('marker seen before the condition → returns at once with the marker rc and the output minus the marker', async () => {
    const { result, calls, events, childLog } = await run({
      conditions: [''], tails: [{ status: 1, stdout: '' }, { status: 0, stdout: 'still running\n' }, { status: 0, stdout: `ran\n${done(0)}` }],
      logs: `ran\n${done(0)}`,
    });
    expect(result.exitCode).toBe(0);
    expect(childLog).toBe('ran\n');
    expect(calls.filter((c) => c.join(' ').includes('.status.conditions'))).toHaveLength(3);
    expect(calls.some((c) => c.join(' ').includes('containerStatuses'))).toBe(false);
    expect(events.find((e) => e.event === 'result-marker-early')).toMatchObject({ job: 'si-cmd-marker', rc: 0 });
    expect(events.find((e) => e.event === 'job-finished')).toMatchObject({ exitCode: 0 });
  });

  test('marker path: a transient full-log failure is re-read (≤2) before the artifacts count as lost', async () => {
    const { result, events, childLog } = await run({
      conditions: [''], tails: [{ status: 0, stdout: `ran\n${done(0)}` }], logs: '',
      logReads: [{ status: 1, stdout: '' }, { status: 0, stdout: `ran\n${done(0)}` }],
    });
    expect(result.exitCode).toBe(0);
    expect(childLog).toBe('ran\n');
    expect(events.filter((e) => e.event === 'result-marker-log-retry')).toHaveLength(1);
    expect(events.find((e) => e.event === 'job-finished')).not.toHaveProperty('artifactError');
  });

  test('marker path: full-log reads that keep failing stop after the retry cap (artifacts lost · exit code kept)', async () => {
    const { result, calls, events } = await run({
      conditions: [''], tails: [{ status: 0, stdout: `x${done(3)}` }], logs: '', logReads: [{ status: 1, stdout: '' }],
    });
    expect(result.exitCode).toBe(3);
    expect(events.filter((e) => e.event === 'result-marker-log-retry')).toHaveLength(POD_MARKER_LOG_RETRIES);
    expect(calls.filter((c) => c.includes('logs') && !c.includes('--tail=2'))).toHaveLength(POD_MARKER_LOG_RETRIES + 1);
    expect(events.find((e) => e.event === 'job-finished')).toHaveProperty('artifactError');
  });

  test('marker path: a full log that reads ok but stops before this launch\'s marker is re-read; still missing → explicit failure', async () => {
    // Cut-off read first, then the complete log: recovered on the retry.
    const healed = await run({ conditions: [''], tails: [{ status: 0, stdout: `ran\n${done(0)}` }], logs: '',
      logReads: [{ status: 0, stdout: 'ran\n' }, { status: 0, stdout: `ran\n${done(0)}` }] });
    expect(healed.result.exitCode).toBe(0);
    expect(healed.childLog).toBe('ran\n');
    expect(healed.events.filter((e) => e.event === 'result-marker-log-retry')).toEqual([expect.objectContaining({ attempt: 1, reason: 'marker-missing-in-full-log' })]);
    expect(healed.events.find((e) => e.event === 'job-finished')).not.toHaveProperty('artifactError');
    // Empty every time: retries run out and the collection is reported as failed (not taken as a complete log).
    const empty = await run({ conditions: [''], tails: [{ status: 0, stdout: `x${done(0)}` }], logs: '', logReads: [{ status: 0, stdout: '' }] });
    expect(empty.result.exitCode).toBe(0);
    expect(empty.events.filter((e) => e.event === 'result-marker-log-retry')).toHaveLength(POD_MARKER_LOG_RETRIES);
    expect(String(empty.events.find((e) => e.event === 'job-finished')?.artifactError)).toContain('result marker');
  });

  test('condition path: a full-log failure is not retried (unchanged)', async () => {
    const { events } = await run({ conditions: ['Complete'], tails: [{ status: 0, stdout: '' }], logs: '', logReads: [{ status: 1, stdout: '' }], podExit: '0' });
    expect(events.some((e) => e.event === 'result-marker-log-retry')).toBe(false);
  });

  test('marker rc≠0 → that rc is the exit code (no Pod status read)', async () => {
    const { result, calls, childLog } = await run({ conditions: [''], tails: [{ status: 0, stdout: `x${done(2)}` }], logs: `boom\nx${done(2)}` });
    expect(result.exitCode).toBe(2);
    expect(childLog).toBe('boom\nx');
    expect(calls.some((c) => c.join(' ').includes('containerStatuses'))).toBe(false);
  });

  test('no marker → waits for the condition exactly as before (Pod exit code · logs unchanged)', async () => {
    const { result, events, childLog } = await run({ conditions: ['', '', 'Complete'], tails: [{ status: 0, stdout: 'no marker\n' }], logs: 'old pod output\n', podExit: '5' });
    expect(result.exitCode).toBe(5);
    expect(childLog).toBe('old pod output\n');
    expect(events.some((e) => e.event === 'result-marker-early')).toBe(false);
  });

  test('a command printing an unbound marker (bare word · another launch) does not end the wait', async () => {
    const spoof = `\n${POD_RESULT_MARKER} rc=0\n`, other = `\n${POD_RESULT_MARKER} ffffffffffff rc=0\n`;
    const { result, events, childLog } = await run({ conditions: ['', '', 'Failed'], tails: [{ status: 0, stdout: spoof }, { status: 0, stdout: other }], logs: `x${spoof}y${done(7)}`, podExit: '7' });
    expect(events.some((e) => e.event === 'result-marker-early')).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(childLog).toBe(`x${spoof}y`);
  });

  test('condition first → unchanged path; no tail read; the marker is still stripped from the output', async () => {
    const { result, calls, events, childLog } = await run({ conditions: ['Failed'], tails: [{ status: 0, stdout: done(0) }], logs: `out${done(1)}`, podExit: '1' });
    expect(result.exitCode).toBe(1);
    expect(childLog).toBe('out');
    expect(calls.some((c) => c.includes('--tail=2'))).toBe(false);
    expect(events.some((e) => e.event === 'result-marker-early')).toBe(false);
  });
});

// POD-CPU-REQUEST-RIGHTSIZE-2-FU 무대: 가짜 kubectl(K8s API 응답 고정) ⊕ 가짜 ssh 시험 ⊕ 가짜 풀 — runPodCommand 생산
// 경로를 그대로 지나며 발사 선행 조건·no-launch 재발사 금지·측정값 기반 요청량을 본다.
describe('POD-CPU-REQUEST-RIGHTSIZE-2-FU — gate16+harness40 공존 재측정', () => {
  function rightsizeStage(o: {
    nodes?: Array<{ name: string; allocatableCpu: string }>;
    pods?: Array<{ nodeName: string; cpu?: string }>;
    canI?: string;
    podsRc?: number;
  } = {}) {
    const applied: Array<Record<string, any>> = [];
    const calls: string[][] = [];
    const events: Array<{ category: string; event: string; data: Record<string, any> }> = [];
    const kubectl: Kubectl = (args, input) => {
      calls.push([...args]);
      if (input) { applied.push(JSON.parse(input) as Record<string, any>); return { status: 0, stdout: '', stderr: '' }; }
      const joined = args.join(' ');
      if (joined.includes('auth can-i')) return { status: 0, stdout: `${o.canI ?? 'yes'}\n`, stderr: '' };
      if (args.includes('nodes')) {
        const nodes = o.nodes ?? [{ name: 'node-b-node', allocatableCpu: '8' }];
        return { status: 0, stdout: JSON.stringify({ items: nodes.map((n) => ({ metadata: { name: n.name }, status: { allocatable: { cpu: n.allocatableCpu } } })) }), stderr: '' };
      }
      if (args.includes('pods') && joined.includes('--all-namespaces')) {
        const items = (o.pods ?? []).map((p) => ({ spec: { nodeName: p.nodeName, containers: [{ resources: { requests: { cpu: p.cpu ?? '1' } } }] } }));
        return { status: o.podsRc ?? 0, stdout: JSON.stringify({ items }), stderr: '' };
      }
      if (joined.includes('.status.conditions')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '0', stderr: '' };
    };
    return { kubectl, applied, calls, events, log: (category: string, event: string, data: Record<string, unknown>) => { events.push({ category, event, data: data as Record<string, any> }); } };
  }
  const resources = (job: Record<string, any>) => job.spec.template.spec.containers[0].resources as { requests: Record<string, string>; limits: Record<string, string> };
  const jobOf = (stage: ReturnType<typeof rightsizeStage>) => stage.applied.find((body) => body.kind === 'Job');

  test('run-477b2ee2·run-7bc13989 는 CPU 측정 전에 no-launch(pod-error)로 끝나 같은 조건의 무효 재발사를 금지한다', async () => {
    const stage = rightsizeStage();
    await expect(runPodCommand({
      command: ['true'], name: 'rightsize-void', imageCommit: null, env: {}, configHostMirror: () => undefined,
      artifactsRoot: '/tmp/pod-command-rightsize-void', kubectl: stage.kubectl, log: stage.log,
      cpuRightsize: {},
    })).rejects.toThrow('same condition gate16+harness40 re-launch refused — run-477b2ee2:pod-error·run-7bc13989:pod-error ended before any CPU measurement');
    // 발사 0: Secret 도 Job 도 적용되지 않았고, local substrate 로 대체한 흔적도 없다.
    expect(stage.applied).toEqual([]);
    const refused = stage.events.filter((e) => e.event === 'rightsize-relaunch-refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      category: 'pod.command-job',
      data: { condition: POD_RIGHTSIZE_CONDITION, launched: false, fallback: 'none', hitl: true, substrate: 'pod' },
    });
    expect(refused[0]!.data.priorVoid.map((record: { run: string }) => record.run)).toEqual(['run-477b2ee2', 'run-7bc13989']);
    expect(POD_RIGHTSIZE_VOID_LAUNCHES.map((record) => record.run)).toEqual(['run-477b2ee2', 'run-7bc13989']);
    // 판정은 기억이 아니라 기록이다: 사용량을 잰 표본이 있으면 같은 조건이라도 재발사가 아니다.
    const measured = rightsizeStage();
    const { refused: stillRefused } = podRightsizeRefusal({
      condition: POD_RIGHTSIZE_CONDITION,
      samples: [{ label: 'gate16', requestMillis: 1000, usageMillis: 2200, waitMs: 1_000 }],
    });
    expect(stillRefused).toBe(false);
    await runPodCommand({
      command: ['true'], name: 'rightsize-measured', imageCommit: null, env: {}, configHostMirror: () => undefined,
      artifactsRoot: '/tmp/pod-command-rightsize-measured', kubectl: measured.kubectl, log: measured.log,
      cpuRightsize: { samples: [{ label: 'gate16', requestMillis: 1000, usageMillis: 2200, waitMs: 1_000 }] },
    });
    expect(measured.events.some((e) => e.event === 'rightsize-relaunch-refused')).toBe(false);
    expect(resources(jobOf(measured)!).requests.cpu).toBe('2800m');
  });

  test('풀 슬롯·SSH·Pod admission·allocatable/request 기준선을 기록하고 하나라도 불가하면 발사 0·사유·HITL 이며 local substrate 로 대체하지 않는다', async () => {
    const member: PodPoolMember = { context: 'pool-node-b', sshHost: 'node-b', capacity: 1, k3dCluster: 'elanous-pool' };
    const blocked = rightsizeStage({ canI: 'no', nodes: [{ name: 'node-b-node', allocatableCpu: '2' }], pods: [{ nodeName: 'node-b-node', cpu: '1500m' }] });
    const samples = [{ label: 'gate16', requestMillis: 1000, usageMillis: 2200, waitMs: 1_000 }];
    await expect(runPodCommand({
      command: ['true'], name: 'rightsize-blocked', imageCommit: null, env: {}, configHostMirror: () => undefined,
      artifactsRoot: '/tmp/pod-command-rightsize-blocked', kubectl: blocked.kubectl, log: blocked.log,
      poolScheduler: new PodPoolScheduler([member]),
      syncImages: async () => new Map([[member.context, { ok: true, action: 'fresh' as const, detail: 'ready', ms: 1 }]]),
      sshProbe: () => ({ status: 255, stdout: '', stderr: 'ssh: connect to host node-b port 22: Connection refused' }),
      cpuRightsize: { samples },
    })).rejects.toThrow('발사 선행 조건 미충족(ssh, admission, baseline) — 발사 0 · HITL');
    expect(blocked.applied).toEqual([]);
    const refused = blocked.events.find((e) => e.event === 'rightsize-launch-refused')!;
    expect(refused.data).toMatchObject({ condition: POD_RIGHTSIZE_CONDITION, host: 'node-b', blocked: ['ssh', 'admission', 'baseline'], launched: false, fallback: 'none', hitl: true, substrate: 'pod' });
    expect(refused.data.preconditions).toMatchObject({
      slots: { ok: true, ready: 1, capacity: 1 },
      ssh: { ok: false, host: 'node-b', detail: 'ssh: connect to host node-b port 22: Connection refused' },
      admission: { ok: false, detail: 'can-i no' },
      baseline: {
        ok: false, node: 'node-b-node', allocatableCpuMillis: 2000, requestedCpuMillis: 1500,
        requestCpuMillis: 1000, freeCpuMillis: 500, detail: 'free 500m < request 1000m',
      },
    });

    // 풀 슬롯 0 — 자리가 없으면 발사하지 않고 slots 를 사유로 남긴다.
    const noSlot = rightsizeStage();
    const emptyPool = { context: 'pool-node-b', capacity: 0, k3dCluster: 'elanous-pool' } as PodPoolMember;
    const stubPool = {
      members: [emptyPool],
      tryAcquire: async () => emptyPool,
      release: () => {},
    } as unknown as PodPoolScheduler;
    await expect(runPodCommand({
      command: ['true'], name: 'rightsize-no-slot', imageCommit: null, env: {}, configHostMirror: () => undefined,
      artifactsRoot: '/tmp/pod-command-rightsize-no-slot', kubectl: noSlot.kubectl, log: noSlot.log,
      poolScheduler: stubPool, cpuRightsize: { samples },
    })).rejects.toThrow('발사 선행 조건 미충족(slots) — 발사 0 · HITL');
    expect(noSlot.applied).toEqual([]);
    expect(noSlot.events.find((e) => e.event === 'rightsize-launch-refused')!.data.preconditions.slots)
      .toEqual({ ok: false, ready: 0, capacity: 0, detail: 'no ready pool member' });

    // 선행 조건이 다 충족되면 같은 기록이 ok 이고 Job 이 실제로 발사된다.
    const passing = rightsizeStage({ pods: [{ nodeName: 'node-b-node', cpu: '2000m' }] });
    const oneSlotPool = { members: [member], tryAcquire: async () => member, release: () => {} } as unknown as PodPoolScheduler;
    await runPodCommand({
      command: ['true'], name: 'rightsize-provided', imageCommit: null, env: {}, configHostMirror: () => undefined,
      artifactsRoot: '/tmp/pod-command-rightsize-provided', kubectl: passing.kubectl, log: passing.log,
      poolScheduler: oneSlotPool,
      syncImages: async () => new Map([[member.context, { ok: true, action: 'fresh' as const, detail: 'ready', ms: 1 }]]),
      sshProbe: () => ({ status: 0, stdout: '', stderr: '' }),
      cpuRightsize: { samples, host: 'node-b' },
    });
    const recorded = passing.events.find((e) => e.event === 'rightsize-preconditions')!.data.preconditions;
    expect(recorded).toMatchObject({
      slots: { ok: true, ready: 1, capacity: 1 },
      ssh: { ok: true, host: 'node-b' },
      admission: { ok: true },
      baseline: { ok: true, node: 'node-b-node', allocatableCpuMillis: 8000, requestedCpuMillis: 2000, freeCpuMillis: 6000, requestCpuMillis: 1000 },
    });
    expect(jobOf(passing)).toBeDefined();
  });

  test('공존 측정값(usage·대기 시간·eviction 원문)으로 요청량을 조정하고, 재측정 불가면 yellow 로 기본 요청량을 지킨다', async () => {
    const coResident = [
      { label: 'gate16', requestMillis: 1000, usageMillis: 2200, waitMs: 4_000 },
      { label: 'harness40', requestMillis: 1000, usageMillis: 1900, waitMs: 6_000 },
    ];
    const green = rightsizeStage({ pods: [{ nodeName: 'node-b-node', cpu: '2000m' }] });
    await runPodCommand({
      command: ['true'], name: 'rightsize-green', imageCommit: null, env: {}, configHostMirror: () => undefined,
      artifactsRoot: '/tmp/pod-command-rightsize-green', kubectl: green.kubectl, log: green.log,
      cpuRightsize: { host: 'node-b', samples: coResident },
    });
    expect(resources(jobOf(green)!)).toEqual({ requests: { cpu: '2800m', memory: '6Gi' }, limits: { memory: '16Gi', cpu: '4' } });
    // 매니페스트에 실린 값 = 측정 판정값(같은 계산이 두 곳에 있지 않다).
    expect(podCpuRightsize(coResident)).toMatchObject({ status: 'green', request: '2800m', requestMillis: 2800 });
    expect(resources(jobOf(green)!).requests.cpu).toBe(podCpuRightsize(coResident).request);
    const verdict = green.events.find((e) => e.event === 'cpu-rightsize')!.data;
    expect(verdict).toMatchObject({ condition: POD_RIGHTSIZE_CONDITION, host: 'node-b', status: 'green', request: '2800m' });
    expect(verdict.reason).toContain('peak usage 2200m over 2 samples');
    expect(verdict.samples).toEqual([
      { label: 'gate16', requestMillis: 1000, usageMillis: 2200, waitMs: 4_000, eviction: null },
      { label: 'harness40', requestMillis: 1000, usageMillis: 1900, waitMs: 6_000, eviction: null },
    ]);

    // eviction 원문이 있으면 그 원문을 사유로 남기고 기본 요청량을 지킨다(yellow).
    const evicted = rightsizeStage();
    await runPodCommand({
      command: ['true'], name: 'rightsize-evicted', imageCommit: null, env: {}, configHostMirror: () => undefined,
      artifactsRoot: '/tmp/pod-command-rightsize-evicted', kubectl: evicted.kubectl, log: evicted.log,
      cpuRightsize: { samples: [coResident[0]!, { label: 'harness40', requestMillis: 1000, usageMillis: null, waitMs: null, eviction: 'Evicted  0/1 nodes are available: 1 Insufficient cpu.' }] },
    });
    expect(resources(jobOf(evicted)!)).toEqual({ requests: { cpu: '1', memory: '6Gi' }, limits: { memory: '16Gi', cpu: '4' } });
    const evictedVerdict = evicted.events.find((e) => e.event === 'cpu-rightsize')!.data;
    expect(evictedVerdict).toMatchObject({ status: 'yellow', request: '1' });
    expect(evictedVerdict.reason).toContain('eviction on harness40: Evicted 0/1 nodes are available: 1 Insufficient cpu.');

    // 발사는 됐지만 사용량을 못 쟀으면(재측정 불가) yellow · 기본값 — 무효 재발사 금지와는 다른 축이다.
    const unmeasured = rightsizeStage();
    await runPodCommand({
      command: ['true'], name: 'rightsize-unmeasured', imageCommit: null, env: {}, configHostMirror: () => undefined,
      artifactsRoot: '/tmp/pod-command-rightsize-unmeasured', kubectl: unmeasured.kubectl, log: unmeasured.log,
      cpuRightsize: {
        priorLaunches: [{ run: 'run-4dd07a14aa', condition: POD_RIGHTSIZE_CONDITION, outcome: 'launched' }],
        samples: [{ label: 'gate16', requestMillis: 1000, usageMillis: null, waitMs: 1_000 }],
      },
    });
    expect(resources(jobOf(unmeasured)!).requests.cpu).toBe('1');
    expect(unmeasured.events.find((e) => e.event === 'cpu-rightsize')!.data)
      .toMatchObject({ status: 'yellow', request: '1', reason: 'usage unmeasured on gate16' });

    // 표본이 없으면 같은 yellow — 측정 없이 요청량을 바꾸지 않는다.
    expect(podCpuRightsize([])).toMatchObject({ status: 'yellow', request: '1', reason: 'no same-host co-residency samples' });
    expect(podCpuQuantity(1000)).toBe('1');
    expect(podCpuQuantity(2800)).toBe('2800m');
  });

  test('요청량 없이 오는 발사(다른 명령·화면)는 선행 조건도 측정도 지나지 않고 종전 Job 바이트 그대로다', async () => {
    const plain = rightsizeStage();
    await runPodCommand({
      command: ['true'], name: 'rightsize-omitted', imageCommit: null, env: {}, configHostMirror: () => undefined,
      artifactsRoot: '/tmp/pod-command-rightsize-omitted', kubectl: plain.kubectl, log: plain.log,
    });
    expect(plain.events.some((e) => e.event.startsWith('rightsize') || e.event === 'cpu-rightsize')).toBe(false);
    expect(plain.calls.some((args) => args.join(' ').includes('auth can-i'))).toBe(false);
    expect(resources(jobOf(plain)!)).toEqual({ requests: { cpu: '1', memory: '6Gi' }, limits: { memory: '16Gi', cpu: '4' } });
    expect(createHash('sha256').update(JSON.stringify(manifest({ clone: true }))).digest('hex')).toBe(PROVENANCE_MANIFEST_SHA256);
  });
});
