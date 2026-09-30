import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commandJobSecret,
  podCommandJobManifest,
  podCommandScript,
  podCommandSecretKeys,
  podCommandTargetCommit,
  runPodCommand,
} from './pod-command-job.js';
import type { Kubectl } from './self-implement-pod.js';
import { PodPoolScheduler, type PodPoolMember } from './pod-pool.js';
import { podSourceScript } from './pod-source-receive.js';

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
    expect(createHash('sha256').update(JSON.stringify(original)).digest('hex')).toBe('a64741991413fe657333bb998fd76621272b1c15fd6422caeb4f006c84f1e4f0');
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
    expect(createHash('sha256').update(JSON.stringify(original)).digest('hex')).toBe('a64741991413fe657333bb998fd76621272b1c15fd6422caeb4f006c84f1e4f0');
    expect(JSON.stringify(manifest({ clone: true, bunCache: undefined }))).toBe(JSON.stringify(original));
    expect(podCommandScript(original)).not.toContain('BUN_INSTALL_CACHE_DIR');
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

  // SHA-256 of the JSON manifest produced by the pre-change HEAD pod-command-job.ts with base + clone: true.
  test('commit source checks out the requested SHA; omitted source retains the default manifest bytes', () => {
    const source = { kind: 'commit' as const, sha: 'a'.repeat(40) };
    const original = 'a64741991413fe657333bb998fd76621272b1c15fd6422caeb4f006c84f1e4f0';
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
    expect(inputs.some((body) => body.includes('skillenv-yt-vault') && body.includes('"kind":"Secret"'))).toBe(true);
    expect(inputs.some((body) => body.includes('"kind":"Job"') && body.includes('\\"$@\\"'))).toBe(true);
    expect(inputs.filter((body) => body.includes('"kind":"Job"')).every((body) => !body.includes('host-mirror'))).toBe(true);
  });
});

// 🐞 2026-09-27(🅞 실측): 로컬 이미지가 옛 판이면 원격 노드도 그 옛 판 태그로 돌았다 — 원격이면 발사 트리의 HEAD 를 목표로.
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
  test('cpu 1 · 메모리 4Gi 를 요청하고 상한은 그대로다', () => {
    const m = manifest() as { spec: { template: { spec: { containers: Array<{ resources: { requests?: Record<string, string>; limits: Record<string, string> } }> } } } };
    const r = m.spec.template.spec.containers[0]!.resources;
    expect(r.requests).toEqual({ cpu: '1', memory: '4Gi' });
    expect(r.limits).toEqual({ memory: '16Gi', cpu: '4' });
  });
});

