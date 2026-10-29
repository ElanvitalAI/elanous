import { describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTaskLauncher, type DetachedSpawn } from '../cli/tasks-cli.js';
import { debug } from '../debug/log.js';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';
import { hostCredentials } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { _resetGrokRefreshCooldownForTesting, resolveGrokCredential } from '../grok/credential.js';
import {
  judgeParentHostCredentials, PARENT_CHILD_CREDENTIAL_MIN_REMAINING_MS, judgeParentHostFacts, releaseCore, launchRemoteParent, mirrorRemoteRunLedgers, RemoteParentNotLaunchedError, parseEtime, parseHarnessParents, preflightParentHost, preflightScript, remoteLaunchScript, shouldInstallRemoteCodexAccess,
  installRemoteCodexAccess, installRemoteCodexAccessBatch, installRemoteGrokAccess, resolveOwnerGrokAccessMirror, remoteLedgerMirrorDir, remoteLedgerMirrorDirs, remoteParentArgs, resolveParentHost, resolveParentHosts, rankParentHosts, readParentHostCapacity, readParentHostPodFit, staleHarnessParents, PARENT_HOST_ACTIVE_FILTER, PARENT_HOST_PROC_COUNT_SCRIPT, type ParentHostConfig, type SshRunner,
} from './parent-host.js';
import { handTask, shellQuote } from './task-hand.js';

const TARGET: ParentHostConfig = { host: 'node-b', cwd: '/Users/me/source/elanous' };
const GOOD_FACTS = 'version=0.2.20-dev.0\nconfig=1\npodPool=1\nrepo=1\nkubectl=1\ngrokCli=1\ncodexCli=1\n';
const ACCESS_TOKEN = `header.${Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString('base64url')}.signature`;
const TEST_CODEX_MIRROR = {
  elanousAuth: JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { accessToken: ACCESS_TOKEN, refreshToken: '', refresh_token: '' } } } }),
  codexAuth: JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: ACCESS_TOKEN, id_token: ACCESS_TOKEN, refresh_token: '', refreshToken: '' } }),
};
const capacitySample = (active = 0, waiting = 0, cpu = 0, cores = 4): string =>
  `__ELANOUS_PARENT_CAPACITY__${active}\n${waiting ? JSON.stringify({ category: 'pod-lease', event: 'admit-by-usage', data: { runId: 'run-waiting', recommended: 0 } }) + '\n' : ''}__ELANOUS_PARENT_APPROVALS__\n__ELANOUS_PARENT_LOAD__${cpu.toFixed(3)}\n__ELANOUS_PARENT_LOAD__cores=${cores}\n`;

function stubSsh(responses: Array<{ match: RegExp; stdout?: string; status?: number; stderr?: string }>): SshRunner & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((host: string, script: string) => {
    calls.push(`${host}:${script}`);
    const hit = responses.find((row) => row.match.test(script));
    return { status: hit?.status ?? 0, stdout: hit?.stdout ?? '', stderr: hit?.stderr ?? '' };
  }) as unknown as SshRunner & { calls: string[] };
  fn.calls = calls;
  return fn;
}

async function launchWithTestMirror(args: string[], cwd: string | undefined, context: Parameters<typeof defaultTaskLauncher>[2],
  deps: Parameters<typeof defaultTaskLauncher>[3] = {}): ReturnType<typeof defaultTaskLauncher> {
  return defaultTaskLauncher(args, cwd, context, { codexAccessMirror: async () => TEST_CODEX_MIRROR, ownerCodexLeaseHolder: () => true, ...deps });
}
const orderParentHosts = (targets: readonly ParentHostConfig[], runId: string, capacities: Parameters<typeof rankParentHosts>[2]): ParentHostConfig[] =>
  rankParentHosts(targets, runId, capacities).map(({ target }) => target);

describe('resolveParentHost — 기본 OFF', () => {
  test('설정·env 가 없으면 끔', () => {
    expect(resolveParentHost(undefined, {})).toBeNull();
  });
  test('cwd 없이는 켜지지 않는다', () => {
    expect(resolveParentHost({ host: 'node-b' }, {})).toBeNull();
  });
  test('env off 가 설정을 이긴다 · env 호스트는 설정 cwd 와 함께', () => {
    expect(resolveParentHost(TARGET, { ELANOUS_TA_PARENT_HOST: 'off' })).toBeNull();
    expect(resolveParentHost({ cwd: TARGET.cwd }, { ELANOUS_TA_PARENT_HOST: 'node-b' })?.host).toBe('node-b');
    expect(resolveParentHost({ host: 'bad host; rm', cwd: '/x' }, {})).toBeNull();
  });
});

describe('multi-host parent routing', () => {
  const hosts: ParentHostConfig[] = [TARGET, { host: 'node-c', cwd: '/srv/elanous', approvalCapacity: 8 }];
  const minihHost = hosts[1]!;
  test('node allocatable excludes a 32Gi Job from a 31.36Gi pool without creating a Pod', () => {
    const target = { ...minihHost, podPool: 'k3d-elanous-pool:8' };
    const calls: string[] = [];
    const fit = readParentHostPodFit(target, '32Gi', (_host, script) => {
      calls.push(script);
      return { status: 0, stdout: JSON.stringify({ items: [{ status: { allocatable: { memory: '32883343Ki' } } }] }), stderr: '' };
    });
    expect(fit).toMatchObject({ state: 'never-fits', memoryLimit: '32Gi', reason: 'memory-never-fits' });
    expect(fit.allocatableBytes).toBeLessThan(fit.requiredBytes!);
    expect(calls).toEqual(['kubectl --context k3d-elanous-pool get nodes -o json']);
    expect(readParentHostPodFit(target, '32Gi', () => ({ status: 1, stdout: '', stderr: 'timeout' })).state).toBe('unmeasured');
  });
  test('all known never-fit parents fail closed before local launch', async () => {
    let localLaunches = 0;
    const targets = [{ ...TARGET, podPool: 'k3d-elanous-pool:1' }, { ...minihHost, podPool: 'k3d-elanous-pool:8' }];
    const ssh: SshRunner = () => ({ status: 0, stdout: JSON.stringify({ items: [{ status: { allocatable: { memory: '31Gi' } } }] }), stderr: '' });
    await expect(launchWithTestMirror(['harness', 'say', '--substrate=pod', 'goal', '--option-after-goal'], undefined,
      { runId: 'run-fit-closed', launchId: 'tl-fit-closed', substrate: 'pod', podGoal: 'goal', env: { ELANOUS_RUN_ID: 'run-fit-closed', ELANOUS_POD_MEMORY_TIER: 'high' } },
      { parentHost: targets, ssh, launchHoldActive: () => false, spawn: () => { localLaunches++; throw Error('local launch'); } }))
      .rejects.toThrow('parent-host memory-never-fits');
    expect(localLaunches).toBe(0);
  });
  test('live hand reads inherited high tier and rejects a 31Gi pool before SSH launch', async () => {
    const priorTier = process.env.ELANOUS_POD_MEMORY_TIER;
    const path = join(mkdtempSync(join(tmpdir(), 'parent-fit-hand-')), 'state.json');
    const goal = 'ship code\n완료 경계 코드: src/task-agent/task-hand.ts 변경\n완료 경계 실물: code-pr 카드 발사\n완료 경계 증거 명령: bun test src/task-agent/parent-host.test.ts';
    const scripts: string[] = [];
    const events: unknown[] = [];
    const off = debug.registerSink({ name: 'parent-fit-hand-test', emit: (rec) => {
      if (rec.category === 'task-agent.parent-host' && rec.event === 'pod-fit') events.push(rec.data);
    } });
    process.env.ELANOUS_POD_MEMORY_TIER = 'high';
    try {
      await expect(handTask({ text: goal, live: true, statePath: path,
        prelaunchInspector: () => ({ reason: 'not-present' }),
        launcher: (args, cwd, context) => launchWithTestMirror(args, cwd, context, {
          parentHost: { ...TARGET, podPool: 'k3d-elanous-pool:1' },
          ssh: (_host, script) => { scripts.push(script); return { status: 0, stdout: JSON.stringify({ items: [{ status: { allocatable: { memory: '31Gi' } } }] }), stderr: '' }; },
          launchHoldActive: () => false,
          spawn: () => { throw Error('local launch must not occur'); },
        }),
      })).rejects.toThrow('parent-host memory-never-fits');
      expect(events).toContainEqual(expect.objectContaining({ state: 'never-fits', memoryLimit: '32Gi' }));
      expect(scripts).toEqual(['kubectl --context k3d-elanous-pool get nodes -o json']);
    } finally {
      off();
      if (priorTier === undefined) delete process.env.ELANOUS_POD_MEMORY_TIER;
      else process.env.ELANOUS_POD_MEMORY_TIER = priorTier;
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });
  test('inherited memory tier used for fit is passed to the remote parent', async () => {
    const priorTier = process.env.ELANOUS_POD_MEMORY_TIER;
    process.env.ELANOUS_POD_MEMORY_TIER = 'high';
    const scripts: string[] = [];
    try {
      const receipt = await launchWithTestMirror(['harness', 'say', '--substrate', 'pod', 'goal'], undefined,
        { runId: 'run-fit-env', launchId: 'tl-fit-env', substrate: 'pod', podGoal: 'goal', env: { ELANOUS_RUN_ID: 'run-fit-env' } },
        { parentHost: { ...TARGET, podPool: 'k3d-elanous-pool:1' },
          ssh: (_host, script) => { scripts.push(script); return { status: 0, stdout: script.includes('kubectl --context')
            ? JSON.stringify({ items: [{ status: { allocatable: { memory: '64Gi' } } }] })
            : script.includes('__ELANOUS_PARENT_CAPACITY__') ? capacitySample(0)
              : script.includes('--version') ? GOOD_FACTS : 'pid=222\n', stderr: '' }; },
          codexAccessMirror: async () => TEST_CODEX_MIRROR, launchHoldActive: () => false,
          localVersion: '0.2.20-dev.0', spawn: () => { throw Error('unexpected local'); } });
      expect(receipt).toMatchObject({ parentHost: { host: 'node-b' } });
      expect(scripts.find((script) => script.includes('nohup'))).toContain('ELANOUS_POD_MEMORY_TIER=high');
    } finally {
      if (priorTier === undefined) delete process.env.ELANOUS_POD_MEMORY_TIER;
      else process.env.ELANOUS_POD_MEMORY_TIER = priorTier;
    }
  });
  test('a measured fit is tried before an unreadable pool', async () => {
    const targets = [{ ...TARGET, podPool: 'k3d-elanous-pool:1' }, { ...minihHost, podPool: 'k3d-elanous-pool:8' }];
    const ssh: SshRunner = (host, script) => {
      if (script.includes('kubectl --context')) return host === 'node-b'
        ? { status: 1, stdout: '', stderr: 'timeout' }
        : { status: 0, stdout: JSON.stringify({ items: [{ status: { allocatable: { memory: '64Gi' } } }] }), stderr: '' };
      return { status: 0, stdout: script.includes('__ELANOUS_PARENT_CAPACITY__') ? capacitySample(0)
        : script.includes('--version') ? GOOD_FACTS : 'pid=222\n', stderr: '' };
    };
    const receipt = await launchWithTestMirror(['harness', 'say', '--substrate', 'pod', 'goal'], undefined,
      { runId: 'run-fit-order', launchId: 'tl-fit-order', substrate: 'pod', podGoal: 'goal', env: { ELANOUS_RUN_ID: 'run-fit-order', ELANOUS_POD_MEMORY_TIER: 'high' } },
      { parentHost: targets, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn: () => { throw Error('unexpected local'); } });
    expect(receipt).toMatchObject({ parentHost: { host: 'node-c' } });
  });
  test('list is validated, env off wins and host-specific capacity is measured', () => {
    expect(resolveParentHosts([{ ...TARGET, approvalCapacity: 2 }, minihHost, { host: 'bad;host', cwd: '/x' }, { host: 'invalid', cwd: '/x', approvalCapacity: -1 }], {})).toEqual([{ ...TARGET, approvalCapacity: 2 }, minihHost]);
    expect(resolveParentHosts([TARGET, { host: 'node-c', cwd: '/srv/elanous' }], {})).toHaveLength(2);
    expect(resolveParentHost({ ...TARGET, approvalCapacity: 0 }, {})).toMatchObject({ host: 'node-b', approvalCapacity: 0 });
    expect(resolveParentHosts(hosts, { ELANOUS_TA_PARENT_HOST: 'off' })).toEqual([]);
    expect(resolveParentHosts(hosts, { ELANOUS_TA_PARENT_HOST: 'node-c' })).toEqual([minihHost]);
    expect(readParentHostCapacity(minihHost, () => ({ status: 0, stdout: capacitySample(2), stderr: '' }))).toEqual({ active: 2, waiting: 0, limit: 8, headroom: 6, approvalHeadroom: 6, load: 0 });
    expect(readParentHostCapacity({ ...minihHost, approvalCapacity: 2 }, () => ({ status: 0, stdout: capacitySample(2), stderr: '' }))).toEqual({ active: 2, waiting: 0, limit: 2, headroom: 0, approvalHeadroom: 0, load: 0 });
    expect(readParentHostCapacity(TARGET, () => ({ status: 0, stdout: capacitySample(0), stderr: '' }))).toEqual({ active: 0, waiting: 0, limit: 1, headroom: 1, approvalHeadroom: 1, load: 0 });
    expect(readParentHostCapacity(TARGET, () => ({ status: 0, stdout: capacitySample(1), stderr: '' }))).toEqual({ active: 1, waiting: 0, limit: 1, headroom: 0, approvalHeadroom: 0, load: 0 });
    const unavailableReasons: string[] = [];
    const off = debug.registerSink({ name: 'parent-host-capacity-unavailable-test', emit: (rec) => {
      if (rec.category === 'task-agent.parent-host' && rec.event === 'capacity-unavailable') {
        unavailableReasons.push((rec.data as { reason: string }).reason);
      }
    } });
    try {
      expect(readParentHostCapacity(minihHost, () => ({ status: 1, stdout: '__ELANOUS_PARENT_CAPACITY_ERROR__bash-unavailable\n', stderr: '' }))).toBeNull();
      expect(readParentHostCapacity(minihHost, () => ({ status: 1, stdout: '__ELANOUS_PARENT_CAPACITY_ERROR__cgroup-unreadable\n', stderr: '' }))).toBeNull();
      expect(readParentHostCapacity(minihHost, () => ({ status: 255, stdout: '', stderr: 'timeout' }))).toBeNull();
      const missingActive = capacitySample(0).replace('__ELANOUS_PARENT_CAPACITY__0\n', '');
      const missingBoundary = capacitySample(0).replace('__ELANOUS_PARENT_APPROVALS__\n', '');
      expect(readParentHostCapacity(minihHost, () => ({ status: 0, stdout: missingActive, stderr: '' }))).toBeNull();
      expect(readParentHostCapacity(minihHost, () => ({ status: 0, stdout: missingBoundary, stderr: '' }))).toBeNull();
    } finally { off(); }
    expect(unavailableReasons).toEqual(['bash-unavailable', 'cgroup-unreadable', 'remote-command-failed', 'active-count-marker-missing', 'approval-boundary-missing']);
  });
  test('single-host launch records unmeasured ranking fields as null', async () => {
    const events: unknown[] = [];
    const off = debug.registerSink({ name: 'parent-host-single-rank-test', emit: (rec) => {
      if (rec.category === 'task-agent.parent-host' && rec.event === 'host-ranked') events.push(rec.data);
    } });
    try {
      await launchWithTestMirror(['harness', 'say', 'g'], undefined, context(450), {
        parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0',
        spawn: () => { throw Error('unexpected local'); },
      });
      expect(events).toEqual([expect.objectContaining({
        host: 'node-b', runId: context(450).runId, active: null, waiting: null,
        headroom: null, capacityState: 'unmeasured', load: null, weight: null, score: null, selected: true,
      })]);
    } finally { off(); }
  });
  test('capacity counter uses Linux argv boundaries to exclude Pod-local work and goal text', () => {
    const root = mkdtempSync(join(tmpdir(), 'parent-host-proc-'));
    const writeArgs = (pid: number, args: string[]) => {
      const dir = join(root, String(pid)); mkdirSync(dir);
      writeFileSync(join(dir, 'cmdline'), Buffer.from([...args, ''].join('\0')));
      writeFileSync(join(dir, 'cgroup'), '0::/user.slice\n');
    };
    try {
      const parent = ['/home/agent/.bun/bin/bun', '/home/agent/.local/share/elanous/current/node_modules/elanous/bin/elanous.mjs', '--config-dir', '/home/agent/.elanous', 'harness', 'say', '--pod-pool', 'pool', '--no-auto-merge', '--substrate', 'pod', 'goal'];
      writeArgs(101, parent);
      writeArgs(102, parent);
      writeArgs(103, ['/bin/bash', '-c', 'install ELANOUS_POD_FALLBACK_CHAIN elanous.mjs harness say --substrate local']);
      writeArgs(104, ['/home/agent/.bun/bin/bun', '/home/agent/.local/share/elanous/current/node_modules/elanous/bin/elanous.mjs', 'harness', 'say', '--pod-pool', 'pool', '--substrate', 'local', '--no-auto-merge', 'goal']);
      writeArgs(105, ['/home/agent/.bun/bin/bun', '/home/agent/.local/share/elanous/current/node_modules/elanous/bin/elanous.mjs', 'dev', '--implement', 'goal mentions harness say --substrate local']);
      writeArgs(106, ['/home/agent/.local/bin/elanous', '--config-dir', '/home/agent/.elanous', 'harness', 'ask', '--pod-pool', 'pool', '--no-auto-merge']);
      writeArgs(107, ['/home/agent/.bun/bin/bun', '/home/agent/.local/share/elanous/current/node_modules/elanous/bin/elanous.mjs', 'harness', 'say', '--pod-pool', 'pool', '--no-auto-merge', 'goal mentions harness say --substrate local']);
      writeArgs(108, ['bun', '/home/agent/.local/share/elanous/current/node_modules/elanous/bin/elanous.mjs', 'harness', 'say', '--pod-pool', 'pool', '--no-auto-merge']);
      writeArgs(109, ['node', '/home/agent/.local/share/elanous/current/node_modules/elanous/bin/elanous.mjs', 'harness', 'say', '--pod-pool', 'pool', '--no-auto-merge']);
      writeArgs(110, ['bun', '--bun', '/home/agent/.local/share/elanous/current/node_modules/elanous/bin/elanous.mjs', 'harness', 'say', '--pod-pool', 'pool', '--no-auto-merge']);
      writeArgs(111, ['bun', '/repo/src/elanous.mjs', 'harness', 'say', '--pod-pool', 'pool']);
      const counted = spawnSync('bash', ['-c', PARENT_HOST_PROC_COUNT_SCRIPT, '--', root], { encoding: 'utf8' });
      expect(counted.status).toBe(0);
      expect(counted.stdout.trim()).toBe('__ELANOUS_PARENT_CAPACITY__7');
      const quotedCount = spawnSync('bash', ['-c', `bash -c ${shellQuote(PARENT_HOST_PROC_COUNT_SCRIPT)} -- ${shellQuote(root)}`], { encoding: 'utf8' });
      expect(quotedCount.status).toBe(0);
      expect(quotedCount.stdout.trim()).toBe('__ELANOUS_PARENT_CAPACITY__7');
      expect(PARENT_HOST_ACTIVE_FILTER).toContain('!/^([^ ]+\\/)?[^ ]*sh -c/');
      const commandPattern = PARENT_HOST_ACTIVE_FILTER.split(' && ')[0]!;
      const commandRegex = new RegExp(commandPattern.slice(1, commandPattern.lastIndexOf('/')));
      expect(commandRegex.test('bun /home/agent/.local/share/elanous/current/node_modules/elanous/bin/elanous.mjs harness say --pod-pool pool')).toBe(true);
      expect(commandRegex.test('dev --implement goal harness say')).toBe(false);
      expect(commandRegex.test('bun /repo/src/elanous.mjs harness say --pod-pool pool')).toBe(true);
      expect(commandRegex.test('/home/agent/.bun/bin/bun /home/agent/.local/share/elanous/current/node_modules/elanous/bin/elanous.mjs harness say --no-auto-merge --pod-pool pool')).toBe(true);
      expect(PARENT_HOST_ACTIVE_FILTER).toContain('/ --no-auto-merge( |$)/');
      expect(PARENT_HOST_ACTIVE_FILTER).toContain('!/ --substrate local( |$)/');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('host capacity excludes eleven container cgroups even when argv matches four parents', () => {
    const root = mkdtempSync(join(tmpdir(), 'parent-host-cgroup-'));
    const parent = ['bun', '/opt/elanous/bin/elanous.mjs', 'harness', 'say', '--no-auto-merge', '--substrate', 'pod'];
    try {
      for (let pid = 100; pid < 115; pid++) {
        const dir = join(root, String(pid)); mkdirSync(dir);
        writeFileSync(join(dir, 'cmdline'), Buffer.from([...parent, ''].join('\0')));
        writeFileSync(join(dir, 'cgroup'), pid < 104 ? '0::/user.slice\n' : '0::/kubepods.slice/docker-123.scope\n');
      }
      const counted = spawnSync('bash', ['-c', PARENT_HOST_PROC_COUNT_SCRIPT, '--', root], { encoding: 'utf8' });
      expect(counted.status).toBe(0);
      expect(counted.stdout.trim()).toBe('__ELANOUS_PARENT_CAPACITY__4');
      rmSync(join(root, '100', 'cgroup'));
      const unknown = spawnSync('bash', ['-c', PARENT_HOST_PROC_COUNT_SCRIPT, '--', root], { encoding: 'utf8' });
      expect(unknown.status).not.toBe(0);
      expect(unknown.stdout).toContain('__ELANOUS_PARENT_CAPACITY_ERROR__cgroup-unreadable');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('remote admission backlog and CPU load change the selected host, not just parent process counts', async () => {
    const observedScripts: string[] = [];
    const read = (congested: string): SshRunner => (host, script) => {
      if (script.includes('__ELANOUS_PARENT_CAPACITY__')) {
        observedScripts.push(script);
        return { status: 0, stdout: host === congested ? capacitySample(0, 1, 300) : capacitySample(0, 0, 20), stderr: '' };
      }
      return { status: 0, stdout: script.includes('--version') ? GOOD_FACTS : `pid=${host === 'node-b' ? 111 : 222}\n`, stderr: '' };
    };
    const pair = [{ ...TARGET, approvalCapacity: 2 }, { ...minihHost, approvalCapacity: 2 }];
    const sample = readParentHostCapacity(pair[0]!, read('node-b'))!;
    expect(sample).toEqual({ active: 0, waiting: 1, limit: 2, headroom: 1, approvalHeadroom: 1, load: 0.75 });
    expect(readParentHostCapacity(pair[1]!, read('node-b'))).toEqual({ active: 0, waiting: 0, limit: 2, headroom: 2, approvalHeadroom: 2, load: 0.05 });
    const recovered = capacitySample(0, 1, 0).replace('__ELANOUS_PARENT_CAPACITY__0\n', `__ELANOUS_PARENT_CAPACITY__0\n${JSON.stringify({ category: 'pod-lease', event: 'admit-by-usage', data: { runId: 'run-waiting', recommended: 3 } })}\n`);
    expect(readParentHostCapacity(pair[0]!, () => ({ status: 0, stdout: recovered, stderr: '' }))?.approvalHeadroom).toBe(2);
    const tally = async (congested: string) => {
      const counts = { 'node-b': 0, 'node-c': 0 };
      for (let n = 0; n < 100; n++) {
        const receipt = await launchWithTestMirror(['harness', 'say', 'g'], undefined, context(n + 500), {
          parentHost: pair, ssh: read(congested), launchHoldActive: () => false, localVersion: '0.2.20-dev.0',
          spawn: () => { throw Error('unexpected local'); },
        });
        counts[(receipt as { parentHost: { host: keyof typeof counts } }).parentHost.host]++;
      }
      return counts;
    };
    const first = await tally('node-b');
    const second = await tally('node-c');
    expect(first['node-c']).toBeGreaterThan(first['node-b']);
    expect(second['node-b']).toBeGreaterThan(second['node-c']);
    const lowLoad = { 'node-b': { approvalHeadroom: 2, load: 0.05 }, 'node-c': { approvalHeadroom: 2, load: 0.75 } };
    const highLoad = { 'node-b': lowLoad['node-c'], 'node-c': lowLoad['node-b'] };
    const lowSelected = Array.from({ length: 100 }, (_, n) => orderParentHosts(pair, `run-load-${n}`, lowLoad)[0]!.host);
    const highSelected = Array.from({ length: 100 }, (_, n) => orderParentHosts(pair, `run-load-${n}`, highLoad)[0]!.host);
    expect(lowSelected.filter((host) => host === 'node-b').length).toBeGreaterThan(highSelected.filter((host) => host === 'node-b').length + 10);
    expect(observedScripts[0]).toContain('!/^([^ ]+\\/)?[^ ]*sh -c/');
    expect(observedScripts[0]).toContain('bash -c');
    expect(observedScripts[0]).toContain('if [ -r /proc/self/cmdline ]');
    expect(observedScripts[0]).toContain(PARENT_HOST_ACTIVE_FILTER);
    expect(observedScripts[0]).toContain('logs --event admit-by-usage --since 5m --json --limit 1000');
    expect(observedScripts[0]).toContain('cpu=$(ps -Ao %cpu=)');
    const unknown = capacitySample(0).replace('__ELANOUS_PARENT_LOAD__cores=4', '__ELANOUS_PARENT_LOAD__cores=bad');
    expect(readParentHostCapacity(pair[0]!, () => ({ status: 0, stdout: unknown, stderr: '' }))).toBeNull();
    const truncated = capacitySample(0).replace('__ELANOUS_PARENT_APPROVALS__', `${JSON.stringify({ _meta: { limitReached: true } })}\n__ELANOUS_PARENT_APPROVALS__`);
    expect(readParentHostCapacity(pair[0]!, () => ({ status: 0, stdout: truncated, stderr: '' }))).toBeNull();
  });
  test('capacity-proportional selection across distinct run ids; zero-headroom is not selected', () => {
    const capacity = { 'node-b': { approvalHeadroom: 2, load: 1 }, 'node-c': { approvalHeadroom: 6, load: 1 } };
    const counts = { 'node-b': 0, 'node-c': 0 };
    for (let n = 0; n < 400; n++) counts[orderParentHosts(hosts, `run-distribution-${n}`, capacity)[0]!.host as keyof typeof counts]++;
    expect(counts['node-c']).toBeGreaterThan(250);
    expect(counts['node-c']).toBeLessThan(350);
    expect(orderParentHosts(hosts, 'run-1', { ...capacity, 'node-b': { approvalHeadroom: 0, load: 1 } })[0]!.host).toBe('node-c');
    const ratioHosts = [{ ...TARGET, approvalCapacity: 32 }, { ...minihHost, approvalCapacity: 14 }];
    const ratio = { 'node-b': 0, 'node-c': 0 };
    for (let n = 0; n < 30; n++) ratio[orderParentHosts(ratioHosts, `run-parent-${n}`, {
      'node-b': { approvalHeadroom: 32, load: 0 }, 'node-c': { approvalHeadroom: 14, load: 0 },
    })[0]!.host as keyof typeof ratio]++;
    expect(ratio['node-b']).toBeGreaterThan(0);
    expect(ratio['node-c']).toBeGreaterThan(0);
    expect(Math.abs(ratio['node-b'] / 30 - 32 / 46)).toBeLessThanOrEqual(0.2);
  });
  const context = (n: number) => ({ runId: `run-multi-${n}`, launchId: `tl-${n}`, env: { ELANOUS_RUN_ID: `run-multi-${n}` } });
  const ssh: SshRunner = (host, script) => ({ status: 0, stderr: '', stdout: script.includes('__ELANOUS_PARENT_CAPACITY__') ? capacitySample(0) : script.includes('--version') ? GOOD_FACTS : `pid=${host === 'node-b' ? 111 : 222}\n` });
  const targets = [{ ...TARGET, approvalCapacity: 2 }, minihHost];
  test('launcher distributes and persists host-specific parent-host-launched observations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parent-host-ledger-'));
    const store = new LogStore(join(dir, 'logs.db'));
    const sink = new StoreSink(store, 'task-agent', { installExitHandlers: false });
    const off = debug.registerSink(sink);
    const runPrefix = `run-multi-ledger-${process.pid}-`;
    const receipts = new Map<string, string>();
    try {
      for (let n = 0; n < 40; n++) {
        const runId = `${runPrefix}${n}`;
        const receipt = await launchWithTestMirror(['harness', 'say', 'g'], undefined,
          { runId, launchId: `tl-${n}`, env: { ELANOUS_RUN_ID: runId } },
          { parentHost: targets, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn: () => { throw Error('unexpected local'); } });
        receipts.set(runId, (receipt as { parentHost: { host: string } }).parentHost.host);
      }
      sink.flush();
      const ranked = store.query({ exactCategories: ['task-agent.parent-host'], events: ['host-ranked'], limit: 1000 })
        .map((row) => JSON.parse(row.data ?? '{}') as { host?: string; runId?: string; active?: number | null; waiting?: number | null; headroom?: number | null; capacityState?: string; load?: number | null; weight?: number; score?: number | null; selected?: boolean })
        .filter((row) => row.runId?.startsWith(runPrefix));
      expect(ranked).toHaveLength(receipts.size * targets.length);
      for (const runId of receipts.keys()) {
        const evidence = ranked.filter((row) => row.runId === runId);
        expect(evidence.filter((row) => row.selected && row.host === receipts.get(runId))).toHaveLength(1);
        expect(evidence.every((row) => row.active === 0 && row.waiting === 0 && (row.headroom === 2 || row.headroom === 8) && row.capacityState === 'available' && row.load === 0 && typeof row.weight === 'number' && (typeof row.score === 'number' || row.score === null))).toBe(true);
      }
      const recorded = store.query({ exactCategories: ['task-agent'], events: ['parent-host-launched'], limit: 100 })
        .map((row) => JSON.parse(row.data ?? '{}') as { host?: string; runId?: string })
        .filter((row) => row.runId?.startsWith(runPrefix));
      expect(recorded).toHaveLength(receipts.size);
      for (const entry of recorded) expect(entry.host).toBe(receipts.get(entry.runId!));
      const selected = [...receipts.values()];
      expect(selected.filter((host) => host === 'node-c').length).toBeGreaterThan(20);
      expect(selected).toContain('node-b');
    } finally {
      off();
      sink.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('actual launcher selects 30 parents in 32:14 capacity proportion', async () => {
    const weighted = [{ ...TARGET, approvalCapacity: 32 }, { ...minihHost, approvalCapacity: 14 }];
    const counts = { 'node-b': 0, 'node-c': 0 };
    for (let n = 0; n < 30; n++) {
      const receipt = await launchWithTestMirror(['harness', 'say', 'g'], undefined, context(n + 200), {
        parentHost: weighted, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0',
        spawn: () => { throw Error('unexpected local'); },
      });
      counts[(receipt as { parentHost: { host: keyof typeof counts } }).parentHost.host]++;
    }
    expect(counts['node-b']).toBeGreaterThan(0);
    expect(counts['node-c']).toBeGreaterThan(0);
    expect(Math.abs(counts['node-b'] / 30 - 32 / 46)).toBeLessThanOrEqual(0.2);
  });
  test('a valid list without approvalCapacity launches instead of falling back locally', async () => {
    const receipt = await launchWithTestMirror(['harness', 'say', 'g'], undefined, context(101), {
      parentHost: [TARGET, { host: 'node-c', cwd: '/srv/elanous' }], ssh,
      launchHoldActive: () => false, localVersion: '0.2.20-dev.0',
      spawn: () => { throw Error('unexpected local'); },
    });
    expect(['node-b', 'node-c']).toContain((receipt as { parentHost: { host: string } }).parentHost.host);
  });
  test('missing local Codex credentials leave the host awaiting provision without a local launch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parent-no-codex-'));
    const beforeXdg = process.env.XDG_CONFIG_HOME;
    const scripts: string[] = [];
    const fitEvents: unknown[] = [];
    const off = debug.registerSink({ name: 'parent-fit-unknown-test', emit: (rec) => {
      if (rec.category === 'task-agent.parent-host' && rec.event === 'pod-fit') fitEvents.push(rec.data);
    } });
    let localLaunches = 0;
    process.env.XDG_CONFIG_HOME = join(dir, 'xdg');
    const ssh: SshRunner = (_host, script, _timeout, stdin) => {
      scripts.push(script);
      expect(stdin).toBeUndefined();
      return { status: 0, stdout: script.includes('nohup') ? 'pid=4242\n' : GOOD_FACTS, stderr: '' };
    };
    try {
      await expect(defaultTaskLauncher(['harness', 'say', 'g'], undefined,
        { runId: 'run-no-codex-0001', launchId: 'tl-no-codex', env: { ELANOUS_RUN_ID: 'run-no-codex-0001' } },
      { parentHost: { host: 'node-c', cwd: '/srv/elanous' }, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', earlyExitWindowMs: 0,
        spawn: (() => { localLaunches++; return { pid: 4242, once(event: string, listener: () => void) { if (event === 'spawn') queueMicrotask(listener); return this; }, removeListener() { return this; }, unref() {} }; }) as unknown as DetachedSpawn })).rejects.toThrow('parent-host-provision-pending');
      expect(scripts.some((script) => script.includes('nohup'))).toBe(false);
      expect(localLaunches).toBe(0);
      expect(scripts.some((script) => script.includes('umask 077'))).toBe(false);
      expect(fitEvents).toContainEqual(expect.objectContaining({ state: 'unmeasured', reason: 'pod-context-unmeasured' }));
    } finally {
      off();
      if (beforeXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = beforeXdg;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('failed Codex mirror installation never attempts remote or local launch', async () => {
    let installs = 0;
    let remoteLaunches = 0;
    let localLaunches = 0;
    const ssh: SshRunner = (_host, script, _timeout, stdin) => {
      if (stdin !== undefined) { installs++; return { status: 255, stdout: '', stderr: 'broken pipe' }; }
      if (script.includes('nohup')) { remoteLaunches++; return { status: 0, stdout: 'pid=7777\n', stderr: '' }; }
      return { status: 0, stdout: GOOD_FACTS, stderr: '' };
    };
    await expect(defaultTaskLauncher(['harness', 'say', 'g'], undefined,
      { runId: 'run-mirror-install-failed', launchId: 'tl-mirror-install-failed', env: { ELANOUS_RUN_ID: 'run-mirror-install-failed' } },
      { parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0',
        codexAccessMirror: async () => TEST_CODEX_MIRROR, ownerCodexLeaseHolder: () => true,
        spawn: () => { localLaunches++; throw Error('should not fall back locally'); } })).rejects.toThrow('remote Codex access mirror batch failed');
    expect(installs).toBe(1);
    expect(remoteLaunches).toBe(0);
    expect(localLaunches).toBe(0);
  });
  test('unknown or saturated capacity excludes that host, then all unavailable hosts fall back locally', async () => {
    const reached: string[] = [];
    const probe: SshRunner = (host, script, _timeout, stdin) => {
      if (stdin !== undefined) return { status: 0, stdout: '', stderr: '' };
      if (script.includes('__ELANOUS_PARENT_CAPACITY__')) return host === 'node-b'
        ? { status: 255, stdout: '', stderr: 'capacity timeout' }
        : { status: 0, stdout: capacitySample(0), stderr: '' };
      reached.push(host);
      return { status: 0, stdout: script.includes('--version') ? GOOD_FACTS : 'pid=222\n', stderr: '' };
    };
    const spawn: DetachedSpawn = () => ({ pid: 1, once(event: string, listener: () => void) { if (event === 'spawn') queueMicrotask(listener); return this; }, removeListener() { return this; }, unref() {} } as unknown as ReturnType<DetachedSpawn>);
    const deps = { parentHost: targets, ssh: probe, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn, earlyExitWindowMs: 0, notice: () => {} };
    expect((await launchWithTestMirror(['harness', 'say', 'g'], undefined, context(105), deps) as { parentHost: { host: string } }).parentHost.host).toBe('node-c');
    expect(reached).toEqual(['node-c', 'node-c']);
    reached.length = 0;
    const ranked: unknown[] = [];
    const off = debug.registerSink({ name: 'parent-host-saturated-rank-test', emit: (rec) => {
      if (rec.category === 'task-agent.parent-host' && rec.event === 'host-ranked') ranked.push(rec.data);
    } });
    try {
      const saturated: SshRunner = (host, script, _timeout, stdin) => stdin !== undefined
        ? { status: 0, stdout: '', stderr: '' }
        : script.includes('__ELANOUS_PARENT_CAPACITY__')
        ? { status: 0, stdout: capacitySample(8), stderr: '' }
        : (reached.push(host), { status: 0, stdout: GOOD_FACTS, stderr: '' });
      expect(await launchWithTestMirror(['harness', 'say', 'g'], undefined, context(106), { ...deps, ssh: saturated })).toEqual({ runId: context(106).runId });
      expect(reached).toEqual([]);
    } finally { off(); }
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((row) => (row as { capacityState?: string }).capacityState === 'saturated')).toBe(true);
  });
  test('preflight rejects the chosen host before trying the other; unavailable capacity never launches there', async () => {
    const first = orderParentHosts(targets, context(99).runId, { 'node-b': { approvalHeadroom: 2, load: 0 }, 'node-c': { approvalHeadroom: 8, load: 0 } })[0]!.host;
    const launched: string[] = [];
    const ssh: SshRunner = (host, script, _timeout, stdin) => {
      if (stdin !== undefined) return { status: 0, stdout: '', stderr: '' };
      if (script.includes('__ELANOUS_PARENT_CAPACITY__')) return { status: 0, stdout: capacitySample(0), stderr: '' };
      if (script.includes('--version')) return { status: 0, stdout: host === first ? 'version=0.1.0\n' : GOOD_FACTS, stderr: '' };
      launched.push(host);
      return { status: 0, stdout: 'pid=42\n', stderr: '' };
    };
    const receipt = await launchWithTestMirror(['harness', 'say', 'g'], undefined, context(99), { parentHost: targets, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn: () => { throw Error('unexpected local'); }, notice: () => {} });
    expect(launched).toEqual([targets.find((target) => target.host !== first)!.host]);
    expect((receipt as { parentHost: { host: string } }).parentHost.host).toBe(launched[0]);
  });
  test('definite failed first host tries next; both fail falls back locally; uncertain launch never retries', async () => {
    const first = orderParentHosts(targets, context(99).runId, { 'node-b': { approvalHeadroom: 2, load: 0 }, 'node-c': { approvalHeadroom: 8, load: 0 } })[0]!.host;
    const second = targets.find((target) => target.host !== first)!.host;
    const calls: string[] = [];
    const run = (failure: 'first' | 'both' | 'uncertain'): SshRunner => (host, script, _timeout, stdin) => {
      if (stdin !== undefined) return { status: 0, stdout: '', stderr: '' };
      if (script.includes('__ELANOUS_PARENT_CAPACITY__')) return { status: 0, stdout: capacitySample(0), stderr: '' };
      if (script.includes('--version')) return { status: 0, stdout: GOOD_FACTS, stderr: '' };
      calls.push(host);
      return host === first ? failure === 'uncertain' ? { status: 255, stdout: '', stderr: 'connection reset' } : { status: 3, stdout: 'not-launched=cwd\n', stderr: '' }
        : failure === 'both' ? { status: 4, stdout: 'not-launched=early-exit\n', stderr: '' } : { status: 0, stdout: 'pid=42\n', stderr: '' };
    };
    const spawn: DetachedSpawn = () => ({ pid: 1, once(event: string, listener: () => void) { if (event === 'spawn') queueMicrotask(listener); return this; }, removeListener() { return this; }, unref() {} } as unknown as ReturnType<DetachedSpawn>);
    expect((await launchWithTestMirror(['harness', 'say', 'g'], undefined, context(99), { parentHost: targets, ssh: run('first'), launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn }) as { parentHost: { host: string } }).parentHost.host).toBe(second);
    expect(calls).toEqual([first, second]);
    calls.length = 0;
    expect(await launchWithTestMirror(['harness', 'say', 'g'], undefined, context(99), { parentHost: targets, ssh: run('both'), launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn, earlyExitWindowMs: 0 })).toEqual({ runId: context(99).runId });
    expect(calls).toEqual([first, second]);
    calls.length = 0;
    await expect(launchWithTestMirror(['harness', 'say', 'g'], undefined, context(99), { parentHost: targets, ssh: run('uncertain'), launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn })).rejects.toThrow('불확실');
    expect(calls).toEqual([first]);
  });
});

describe('원격 인자 — HQ 병합 권한을 넘기지 않는다', () => {
  test('--merge-by-host → --no-auto-merge · --pod-pool 덧붙임', () => {
    const args = remoteParentArgs(['harness', 'say', '--seat', 'OP', '--substrate', 'pod', '--merge-by-host', 'goal text'], 'k3d-elanous-pool:40');
    expect(args).not.toContain('--merge-by-host');
    expect(args).toContain('--no-auto-merge');
    expect(args.slice(2, 4)).toEqual(['--pod-pool', 'k3d-elanous-pool:40']);
    expect(args.at(-1)).toBe('goal text');
  });
  test('원격 셸 한 줄 — 런 id env · 따옴표 · 로그 · pid', () => {
    const script = remoteLaunchScript(TARGET, ['harness', 'say', '--merge-by-host', "it's a goal\nline2"], { ELANOUS_RUN_ID: 'run-abcd1234' });
    expect(script).toContain('env ELANOUS_RUN_ID=run-abcd1234 ELANOUS_STATE_DIR="$HOME"/.elanous ELANOUS_STATE_DIR_SOURCE=explicit nohup');
    expect(script).toContain(`"$HOME"/.local/share/elanous/bin/elanous --config-dir "$HOME"/.elanous harness say --no-auto-merge`);
    expect(script).toContain(`'it'\\''s a goal\nline2'`);
    expect(script).toContain('remote-parents/run-abcd1234.log');
    expect(script).toContain('kill -0 "$p"');
  });
  test('사용자 지정 절대 configDir 은 상태 env 와 --config-dir 에 그대로 쓰고 기존 자격 env 를 보존한다', () => {
    const script = remoteLaunchScript({ ...TARGET, configDir: '/srv/elanous state' }, ['harness', 'say', '--merge-by-host'], {
      ELANOUS_RUN_ID: 'run-abcd1234', ELANOUS_TASK_CARD_ID: 'ta-card-123', OPENROUTER_API_KEY: 'secret value', ELANOUS_STATE_DIR: '/old/worktree/.elanous-test',
    });
    expect(script).toContain("ELANOUS_RUN_ID=run-abcd1234 ELANOUS_TASK_CARD_ID=ta-card-123 OPENROUTER_API_KEY='secret value' ELANOUS_STATE_DIR='/srv/elanous state' ELANOUS_STATE_DIR_SOURCE=explicit nohup");
    expect(script).toContain("--config-dir '/srv/elanous state' harness say --no-auto-merge");
    expect(script).not.toContain('/old/worktree/.elanous-test');
    expect(script).toContain("'/srv/elanous state/remote-parents/run-abcd1234.log'");
  });
  test('REMOTE-PARENT-OBS: 상태 루트는 출처 태그와 한 벌 — HQ 의 derived(worktree) 태그를 넘기지 않는다', () => {
    // HQ 가 git worktree/`--test` 면 context.env 에 ELANOUS_STATE_DIR_SOURCE=derived 가 실린다.
    // 루트만 원격 값으로 바꾸고 태그를 흘리면 원격 부모는 «운영 루트 + 파생 태그»를 받아
    // 자기 우주를 test 로 오독한다(codexCredentialRoot·harnessLaunchPolicyConfig 가 그 태그를 본다).
    const hqWorktreeEnv = {
      ELANOUS_RUN_ID: 'run-abcd1234', ELANOUS_TASK_CARD_ID: 'ta-card-123', OPENROUTER_API_KEY: 'secret value',
      ELANOUS_STATE_DIR: '/old/worktree/.elanous-test', ELANOUS_STATE_DIR_SOURCE: 'derived',
    };
    const defaultScript = remoteLaunchScript(TARGET, ['harness', 'say', '--merge-by-host'], hqWorktreeEnv);
    expect(defaultScript).toContain('env ELANOUS_RUN_ID=run-abcd1234 ELANOUS_TASK_CARD_ID=ta-card-123 OPENROUTER_API_KEY=\'secret value\' ELANOUS_STATE_DIR="$HOME"/.elanous ELANOUS_STATE_DIR_SOURCE=explicit nohup');
    expect(defaultScript).not.toContain('derived');
    expect(defaultScript).not.toContain('/old/worktree/.elanous-test');
    const customScript = remoteLaunchScript({ ...TARGET, configDir: '/srv/elanous state' }, ['harness', 'say', '--merge-by-host'], hqWorktreeEnv);
    expect(customScript).toContain("ELANOUS_STATE_DIR='/srv/elanous state' ELANOUS_STATE_DIR_SOURCE=explicit nohup");
    expect(customScript).toContain("--config-dir '/srv/elanous state' harness say --no-auto-merge");
    expect(customScript).not.toContain('derived');
    expect(customScript).not.toContain('/old/worktree/.elanous-test');
  });
});

describe('발사 전 점검', () => {
  test('사실이 다 맞으면 통과', () => {
    const result = preflightParentHost({ target: TARGET, localVersion: '0.2.20-dev.0', launchHoldActive: false, ssh: stubSsh([{ match: /--version/, stdout: GOOD_FACTS }]) });
    expect(result).toMatchObject({ ok: true, gaps: [] });
  });
  test('판 차이 · config 없음 · 저장소 없음 · 발사 동결은 막는다', () => {
    const gaps = judgeParentHostFacts({ version: '0.2.19' }, { localVersion: '0.2.20-dev.0', launchHoldActive: true });
    expect(gaps).toEqual(['version-mismatch: remote 0.2.19 ≠ HQ 0.2.20-dev.0', 'remote-config-missing', 'remote-pod-pool-unset', 'remote-repo-missing', 'remote-kubectl-missing', 'hq-launch-freeze-active']);
  });

  test('같은 기준판(x.y.z)의 프리릴리스 차이는 막지 않는다 — 레일 한 주기 늦음(OP 10-09)', () => {
    const facts = { version: '0.2.23', config: '1', podPool: '1', repo: '1', kubectl: '1' };
    expect(judgeParentHostFacts(facts, { localVersion: '0.2.23-dev.0', launchHoldActive: false })).toEqual([]);
    expect(judgeParentHostFacts({ ...facts, version: '0.2.22' }, { localVersion: '0.2.23-dev.0', launchHoldActive: false })).toEqual(['version-mismatch: remote 0.2.22 ≠ HQ 0.2.23-dev.0']);
    expect(releaseCore('0.2.23-dev.0')).toBe('0.2.23');
    expect(releaseCore('weird')).toBe('weird');
  });
  test('ssh 실패 = unreachable', () => {
    const result = preflightParentHost({ target: TARGET, localVersion: 'x', launchHoldActive: false, ssh: stubSsh([{ match: /./, status: 255, stderr: 'ssh: connect timed out' }]) });
    expect(result.ok).toBe(false);
    expect(result.gaps[0]).toContain('unreachable: ssh: connect timed out');
  });
});

describe('defaultTaskLauncher — 원격 부모', () => {
  const context = { runId: 'run-11112222-3333-4444-5555-666677778888', launchId: 'tl-x', env: { ELANOUS_RUN_ID: 'run-11112222-3333-4444-5555-666677778888' } };
  const noLocal: DetachedSpawn = () => { throw new Error('로컬 발사가 불리면 안 된다'); };

  test('점검 통과 → ssh 로 띄우고 영수증에 호스트 · 로컬 spawn 0', async () => {
    const ssh = stubSsh([{ match: /--version/, stdout: GOOD_FACTS }, { match: /nohup/, stdout: 'pid=4242\n' }]);
    const receipt = await launchWithTestMirror(['harness', 'say', '--substrate', 'pod', '--merge-by-host', 'g'], undefined, context, { parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn: noLocal });
    expect(receipt).toMatchObject({ runId: context.runId, parentHost: { host: 'node-b', pid: 4242 } });
    expect(ssh.calls.some((call) => call.includes('--no-auto-merge') && !call.includes('--merge-by-host'))).toBe(true);
    expect(ssh.calls.find((call) => call.includes('nohup'))).toContain('ELANOUS_STATE_DIR="$HOME"/.elanous');
  });

  test('Grok mirror refreshes on HQ and returns only fresh access metadata', () => {
    const home = mkdtempSync(join(tmpdir(), 'parent-grok-owner-'));
    const auth = join(home, '.grok', 'auth.json');
    mkdirSync(join(home, '.grok'), { recursive: true });
    const before = '2026-10-20T00:01:00.000Z';
    const after = '2030-01-01T00:00:00.000Z';
    writeFileSync(auth, JSON.stringify({
      'https://auth.x.ai::hq-selected': { key: 'old-access-test-value', refresh_token: 'hq-refresh-test-only', expires_at: before },
      'https://auth.x.ai::other': { key: 'other-access-test-value', refresh_token: 'other-refresh-test-only', expires_at: '2026-10-20T00:00:30.000Z' },
    }));
    _resetGrokRefreshCooldownForTesting();
    try {
      const mirror = resolveOwnerGrokAccessMirror({ home, now: () => Date.parse('2026-10-20T00:00:00Z'), execImpl: (cmd, args) => {
        expect(cmd).toBe('grok');
        expect(args).toEqual(['models']);
        const scopes = JSON.parse(readFileSync(auth, 'utf8')) as Record<string, Record<string, unknown>>;
        scopes['https://auth.x.ai::hq-selected'] = { ...scopes['https://auth.x.ai::hq-selected'], key: 'fresh-selected-access', expires_at: after };
        writeFileSync(auth, JSON.stringify(scopes));
      } });
      expect(mirror).toEqual({ key: 'fresh-selected-access', expiresAt: after });
      expect(Object.keys(mirror).sort()).toEqual(['expiresAt', 'key']);
    } finally {
      _resetGrokRefreshCooldownForTesting();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('Grok child launch installs no HQ mirror — the remote host keeps its own device-auth session', () => {
    const calls: Array<{ script: string; stdin?: string }> = [];
    const ssh: SshRunner = (_host, script, _timeout, stdin) => {
      calls.push({ script, ...(stdin !== undefined ? { stdin } : {}) });
      return script.includes('nohup')
        ? { status: 0, stdout: 'pid=4242\n', stderr: '' }
        : { status: 0, stdout: '', stderr: '' };
    };
    const hostCredentialEvents: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'grok-host-credential-launch-test', emit: (rec) => {
      if (rec.category === 'task-agent.parent-host' && rec.event === 'grok-host-credential') hostCredentialEvents.push(rec.data as Record<string, unknown>);
    } });
    try {
      const receipt = launchRemoteParent(TARGET, ['harness', 'say', '--child-llm-provider', 'grok', 'goal'],
        { ELANOUS_RUN_ID: context.runId }, ssh);
      expect(receipt).toMatchObject({ pid: 4242, log: expect.any(String) });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.stdin).toBeUndefined();
      expect(calls[0]!.script).not.toContain('umask 077');
      expect(calls[0]!.script).toContain('--child-llm-provider grok');
      expect(hostCredentialEvents).toEqual([expect.objectContaining({ host: 'node-b', runId: context.runId, source: 'host-device-auth' })]);
    } finally { off(); }
  });

  test('installRemoteGrokAccess keeps its access-only mirror scope when called directly', () => {
    const home = mkdtempSync(join(tmpdir(), 'parent-grok-install-'));
    const expiry = '2030-01-01T00:00:00.000Z';
    const selected = 'selected-grok-access-test-value';
    const unselected = 'other-grok-access-test-value';
    mkdirSync(join(home, '.grok'), { recursive: true });
    writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({
      'https://auth.x.ai::hq-selected': { key: selected, expires_at: expiry },
      'https://auth.x.ai::other': { key: unselected, expires_at: '2029-01-01T00:00:00.000Z', refresh_token: 'preserved-refresh-fixture' },
    }));
    try {
      const installedMirrorToken = 'installed-hq-mirror-access-test-value';
      installRemoteGrokAccess(TARGET, { key: installedMirrorToken, expiresAt: expiry }, localShell(home));
      const installed = JSON.parse(readFileSync(join(home, '.grok', 'auth.json'), 'utf8')) as Record<string, Record<string, unknown>>;
      expect(Object.keys(installed).sort()).toEqual([
        'https://auth.x.ai::hq-mirror', 'https://auth.x.ai::hq-selected', 'https://auth.x.ai::other',
      ]);
      expect(Object.keys(installed['https://auth.x.ai::hq-mirror']!).sort()).toEqual(['expires_at', 'key']);
      expect(installed['https://auth.x.ai::hq-selected']?.key).toBe(selected);
      expect(installed['https://auth.x.ai::other']?.key).toBe(unselected);
      expect(installed['https://auth.x.ai::other']?.refresh_token).toBe('preserved-refresh-fixture');
      expect(resolveGrokCredential({ home, env: {} as NodeJS.ProcessEnv })?.token).toBe(installedMirrorToken);
      expect(statSync(join(home, '.grok', 'auth.json')).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, '.grok')).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('Grok mirror is rejected at installation when the two-minute safety margin elapsed after preflight', () => {
    const now = Date.parse('2026-10-20T00:00:00.000Z');
    let sshCalls = 0;
    const ssh: SshRunner = () => {
      sshCalls++;
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(() => installRemoteGrokAccess(TARGET, {
      key: 'selected-grok-access-test-value',
      expiresAt: new Date(now + 119_999).toISOString(),
    }, ssh, () => now)).toThrow('invalid Grok access mirror');
    expect(sshCalls).toBe(0);
    expect(() => installRemoteGrokAccess(TARGET, {
      key: 'selected-grok-access-test-value',
      expiresAt: new Date(now + 120_001).toISOString(),
    }, ssh, () => now)).not.toThrow();
    expect(sshCalls).toBe(1);
  });

  test('defaultTaskLauncher refuses the launch when the host reports its Grok credential is expiring', async () => {
    const calls: Array<{ script: string; stdin?: string }> = [];
    const { defaultTaskLauncher } = await import('../cli/tasks-cli.js');
    const ssh: SshRunner = (_host, script, _timeout, stdin) => {
      calls.push({ script, ...(stdin !== undefined ? { stdin } : {}) });
      return { status: 0, stdout: script.includes('--version') ? `${GOOD_FACTS}grok=1\ngrokHost=expiring\ncodexAccounts=3\nopenrouter=1\n` : '', stderr: '' };
    };
    await expect(defaultTaskLauncher(['harness', 'say', 'goal'], undefined, {
      runId: context.runId, launchId: 'grok-expiry-preflight', effectiveChildProvider: 'grok',
      env: { ELANOUS_RUN_ID: context.runId },
    }, {
      parentHost: TARGET, ssh, localVersion: '0.2.20-dev.0',
      launchHoldActive: () => false,
      spawn: () => { throw new Error('local launch after invalid host credential'); },
    })).rejects.toThrow('parent-host-provision-pending');
    expect(calls.every((call) => !call.script.includes('nohup'))).toBe(true);
    expect(calls.some((call) => call.stdin !== undefined)).toBe(false);
  });

  test('defaultTaskLauncher launches with the host credential and installs no mirror although HQ holds a Grok subscription', () => {
    const home = mkdtempSync(join(tmpdir(), 'parent-grok-launcher-isolated-'));
    const selected = 'isolated-grok-access-fixture';
    const expiry = '2030-01-01T00:00:00.000Z';
    mkdirSync(join(home, '.grok'), { recursive: true });
    writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({
      'https://auth.x.ai::isolated': { key: selected, expires_at: expiry },
      'https://auth.x.ai::other': { key: 'unselected-grok-access-fixture', expires_at: '2029-01-01T00:00:00.000Z' },
    }));
    const hostFacts = `${GOOD_FACTS}grok=1\ngrokHost=valid\ncodexAccounts=3\nopenrouter=1\n`;
    const child = `
      const { defaultTaskLauncher } = await import('./src/cli/tasks-cli.ts');
      const { handTask } = await import('./src/task-agent/task-hand.ts');
      const calls = [];
      const ssh = (_host, script, _timeout, stdin) => {
        calls.push({ script, stdin });
        if (script.includes('--version')) return { status: 0, stdout: ${JSON.stringify(hostFacts)}, stderr: '' };
        if (script.includes('nohup')) return { status: 0, stdout: 'pid=4242\\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      const handed = await handTask({ text: 'docs Grok owner mirror integration fixture', seat: 'UX',
        childLlm: 'grok/grok-4.7', live: true, statePath: process.env.HOME + '/task-agent-actions.json',
        prelaunchInspector: () => ({ reason: 'isolated-test-fixture' }),
        launcher: (taskArgs, cwd, context) => defaultTaskLauncher(taskArgs, cwd, context,
          { parentHost: ${JSON.stringify(TARGET)}, ssh, launchHoldActive: () => false,
            localVersion: '0.2.20-dev.0', spawn: () => { throw new Error('local launch forbidden'); } }) });
      const installs = calls.filter((call) => call.stdin !== undefined);
      const launch = calls.find((call) => call.script.includes('nohup'));
      console.log(JSON.stringify({ cardProvider: handed.card.childLlm?.provider, receipt: handed.card.parentHost,
        count: calls.length, installs: installs.length,
        mirrorWrite: calls.some((call) => call.script.includes('umask 077')),
        fixtureOnWire: calls.some((call) => call.script.includes(${JSON.stringify(selected)}) || String(call.stdin || '').includes(${JSON.stringify(selected)})),
        launchHasGrok: launch?.script.includes('--child-llm-provider grok') }));
      process.exit(0);
    `;
    try {
      const result = spawnSync(process.execPath, ['-e', child], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, HOME: home },
      });
      expect(result.status).toBe(0);
      const evidence = JSON.parse(result.stdout.trim()) as {
        cardProvider: string; receipt?: { host: string; pid: number };
        count: number; installs: number; mirrorWrite: boolean; fixtureOnWire: boolean; launchHasGrok: boolean;
      };
      expect(evidence.cardProvider).toBe('grok');
      expect(evidence.receipt).toMatchObject({ host: 'node-b', pid: 4242 });
      expect(evidence.count).toBe(2); // preflight 사실 한 번 ⊕ 부모 발사 한 번 — 미러 설치 없음
      expect(evidence.installs).toBe(0);
      expect(evidence.mirrorWrite).toBe(false);
      expect(evidence.fixtureOnWire).toBe(false);
      expect(evidence.launchHasGrok).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, { timeout: 35_000 });

  test('defaultTaskLauncher blocks the Grok child before launch when the host reports no credential, with an OP re-login request', () => {
    const home = mkdtempSync(join(tmpdir(), 'parent-grok-launcher-empty-'));
    mkdirSync(join(home, '.grok'), { recursive: true });
    writeFileSync(join(home, '.grok', 'auth.json'), '{}');
    const hostFacts = `${GOOD_FACTS}grokHost=missing\ncodexAccounts=3\nopenrouter=1\n`;
    const child = `
      const { defaultTaskLauncher } = await import('./src/cli/tasks-cli.ts');
      const calls = [];
      const notices = [];
      let error = '';
      try {
        await defaultTaskLauncher(['harness', 'say', 'goal'], undefined,
          { runId: 'run-11112222-3333-4444-5555-666677778888', launchId: 'isolated-missing',
            effectiveChildProvider: 'grok', env: { ELANOUS_RUN_ID: 'run-11112222-3333-4444-5555-666677778888' } },
          { parentHost: ${JSON.stringify(TARGET)},
            ssh: (_host, script) => { calls.push(script); return { status: 0, stdout: script.includes('--version') ? ${JSON.stringify(hostFacts)} : '', stderr: '' }; },
            launchHoldActive: () => false, localVersion: '0.2.20-dev.0',
            spawn: () => { throw new Error('local launch forbidden'); },
            notice: (line) => notices.push(line) });
      } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      console.log(JSON.stringify({ launches: calls.filter((script) => script.includes('nohup')).length,
        preflights: calls.length, notices, error }));
      process.exit(0);
    `;
    try {
      const result = spawnSync(process.execPath, ['-e', child], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, HOME: home },
      });
      expect(result.status).toBe(0);
      const evidence = JSON.parse(result.stdout.trim()) as { launches: number; preflights: number; notices: string[]; error: string };
      expect(evidence.error).toContain('parent-host-provision-pending');
      expect(evidence.error).toContain('grok-credential-missing');
      expect(evidence.launches).toBe(0);
      expect(evidence.preflights).toBe(1);
      expect(evidence.notices.filter((line) => line.includes('provision 요청')))
        .toEqual(['[parent-host] node-b provision 요청 — grok-credential-missing; 준비 완료 전 배정 대기']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, { timeout: 35_000 });

  test('an expired HQ subscription neither installs a mirror nor blocks the host-credential launch', () => {
    const home = mkdtempSync(join(tmpdir(), 'parent-grok-expired-'));
    mkdirSync(join(home, '.grok'), { recursive: true });
    writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({ 'https://auth.x.ai::hq': { key: 'expired-access-test-value', expires_at: '2020-01-01T00:00:00.000Z' } }));
    const calls: Array<{ script: string; stdin?: string }> = [];
    const ssh: SshRunner = (_host, script, _timeout, stdin) => {
      calls.push({ script, ...(stdin !== undefined ? { stdin } : {}) });
      return { status: 0, stdout: script.includes('nohup') ? 'pid=4242\n' : '', stderr: '' };
    };
    try {
      // HQ-side resolution still fails closed for its own callers.
      expect(() => resolveOwnerGrokAccessMirror({
        home, now: () => Date.parse('2026-10-20T00:00:00Z'), execImpl: () => { throw new Error('refresh unavailable'); },
      })).toThrow('expired-or-refresh-did-not-produce-fresh-access');
      // The remote launch path never consults it: the host owns its own session.
      expect(launchRemoteParent(TARGET, ['harness', 'say', '--child-llm-provider=grok', 'goal'],
        { ELANOUS_RUN_ID: context.runId }, ssh)).toMatchObject({ pid: 4242 });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.stdin).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('effective provider만 Codex 미러 적용 여부를 결정하고 미지정은 기존 Codex 기본을 쓴다', () => {
    expect(shouldInstallRemoteCodexAccess(undefined)).toBe(true);
    expect(shouldInstallRemoteCodexAccess('openai-codex')).toBe(true);
    expect(shouldInstallRemoteCodexAccess('openrouter')).toBe(false);
    expect(shouldInstallRemoteCodexAccess('glm')).toBe(false);
  });

  test('명시 non-Codex child는 미러 조회·설치·계정 표지 없이 기존 원격 경로로 실행한다', async () => {
    const calls: Array<{ script: string; stdin?: string }> = [];
    let mirrorReads = 0;
    const ssh: SshRunner = (_host, script, _timeout, stdin) => {
      calls.push({ script, ...(stdin !== undefined ? { stdin } : {}) });
      return { status: 0, stdout: script.includes('--version') ? GOOD_FACTS : script.includes('nohup') ? 'pid=6161\n' : '', stderr: '' };
    };
    const inheritedMirrorLabels = {
      ELANOUS_RUN_ID: 'run-openrouter-01',
      ELANOUS_REMOTE_CODEX_ACCOUNT: 'stale-account',
      ELANOUS_REMOTE_CODEX_USED_PERCENT: '99',
      ELANOUS_REMOTE_CODEX_THRESHOLD_PERCENT: '60',
    };
    const receipt = await defaultTaskLauncher(['harness', 'say', '--child-llm-provider', 'openrouter', '--child-llm-model', 'openrouter/deepseek/deepseek-chat'], undefined,
      { runId: 'run-openrouter-01', launchId: 'tl-openrouter', effectiveChildProvider: 'openrouter', env: inheritedMirrorLabels }, {
        parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0',
        codexAccessMirror: async () => { mirrorReads++; return TEST_CODEX_MIRROR; },
        spawn: () => { throw Error('local fallback'); },
      });
    const launch = calls.find((call) => call.script.includes('nohup'))!;
    expect(receipt).toMatchObject({ parentHost: { host: 'node-b', pid: 6161 } });
    expect(mirrorReads).toBe(0);
    expect(calls.some((call) => call.stdin !== undefined)).toBe(false);
    expect(launch.script).not.toContain('ELANOUS_REMOTE_CODEX_ACCOUNT=');
    expect(launch.script).not.toContain('ELANOUS_REMOTE_CODEX_USED_PERCENT=');
    expect(launch.script).not.toContain('ELANOUS_REMOTE_CODEX_THRESHOLD_PERCENT=');
  });

  test('점검 막힘 → 로컬로 되돌아가고 알림', async () => {
    const ssh = stubSsh([{ match: /--version/, stdout: 'version=0.2.19\n' }]);
    const notices: string[] = [];
    let localSpawned = 0;
    const spawn: DetachedSpawn = () => {
      localSpawned++;
      return { pid: 1, once(event: string, listener: () => void) { if (event === 'spawn') queueMicrotask(listener); return this; }, removeListener() { return this; }, unref() {} } as unknown as ReturnType<DetachedSpawn>;
    };
    const receipt = await launchWithTestMirror(['harness', 'say', 'g'], undefined, context, { parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn, earlyExitWindowMs: 0, notice: (line) => notices.push(line) });
    expect(localSpawned).toBe(1);
    expect(receipt).toEqual({ runId: context.runId });
    expect(notices[0]).toContain('version-mismatch');
  });

  test('handTask 가 원격 영수증을 카드에 적는다', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'parent-host-')), 'task-agent-actions.json');
    let contextProvider: string | undefined;
    const result = await handTask({ text: 'docs 한 줄', seat: 'OP', live: true, statePath, launcher: async (_args, _cwd, ctx) => {
      contextProvider = ctx!.effectiveChildProvider;
      return { runId: ctx!.runId, parentHost: { host: 'node-b', pid: 7 } };
    } });
    expect(result.card.parentHost).toEqual({ host: 'node-b', pid: 7 });
    expect(result.card.history[0]!.detail).toContain('[parent@node-b · PR 까지만]');
    expect(contextProvider).toBe('openai-codex');
  });

  test('handTask carries an explicit non-Codex provider to the launcher context', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'parent-host-provider-')), 'task-agent-actions.json');
    let contextProvider: string | undefined;
    await handTask({ text: 'docs 다른 줄', seat: 'UX', childLlm: 'openrouter/deepseek/deepseek-chat', live: true, statePath,
      launcher: async (_args, _cwd, ctx) => { contextProvider = ctx!.effectiveChildProvider; return { runId: ctx!.runId }; } });
    expect(contextProvider).toBe('openrouter');
  });
});

describe('원장 거울', () => {
  test('부모 원장 ⊕ Pod 자식 원장을 당긴다 · 없음은 건너뛴다', () => {
    const root = mkdtempSync(join(tmpdir(), 'mirror-'));
    const host = [JSON.stringify({ event: 'pod-child-run', data: { childRunId: 'run-child0001' } }), JSON.stringify({ event: 'run-status', data: { runStatus: 'completed' } })].join('\n');
    const ssh = stubSsh([{ match: /run-parent01\.jsonl/, stdout: host }, { match: /run-child0001\.jsonl/, stdout: '__ELANOUS_ABSENT__\n' }]);
    expect(mirrorRemoteRunLedgers({ host: 'node-b' }, 'run-parent01', root, ssh)).toEqual(['run-parent01']);
    const dir = remoteLedgerMirrorDir(root, 'node-b');
    expect(readFileSync(join(dir, 'run-parent01.jsonl'), 'utf8')).toBe(host);
    expect(existsSync(join(dir, 'run-child0001.jsonl'))).toBe(false);
    expect(remoteLedgerMirrorDirs(root)).toEqual([dir]);
  });
  test('원격을 못 읽으면 던진다(«없음» 아님)', () => {
    const ssh = stubSsh([{ match: /./, status: 255, stderr: 'refused' }]);
    expect(() => mirrorRemoteRunLedgers({ host: 'node-b' }, 'run-parent01', mkdtempSync(join(tmpdir(), 'mirror-')), ssh)).toThrow('원격 원장 읽기 실패');
  });
});

describe('낡은 부모 보고 — 읽기 전용', () => {
  const ps = [
    '  1040 1-19:39:05 /u/.bun/bin/bun /u/.local/share/elanous/versions/0.2.19-dev.0-4cdf/node_modules/elanous/bin/elanous.mjs --config-dir /u/.elanous harness say --seat OP --substrate pod --merge-by-host goal ELANOUS_RUN_ID=run-oldterminal HOME=/u',
    '  1896      15:37 /u/.bun/bin/bun /u/.local/share/elanous/versions/0.2.20-dev.0-6b74/node_modules/elanous/bin/elanous.mjs --config-dir /u/.elanous harness say --seat TC --substrate pod goal ELANOUS_RUN_ID=run-youngrun1',
    '  2000   10:00:00 /u/.bun/bin/bun /u/src/harness/harness-queue-child.ts /tmp/receipt ELANOUS_RUN_ID=run-podgone01',
    '  2100   09:00:00 /u/.bun/bin/bun /u/x/elanous.mjs harness say --seat UX goal-without-run',
    '  2200   09:00:00 /u/.bun/bin/bun something-else',
  ].join('\n');

  test('etime 해석', () => {
    expect(parseEtime('1-19:39:05')).toBe(86400 + 19 * 3600 + 39 * 60 + 5);
    expect(parseEtime('15:37')).toBe(937);
    expect(parseEtime('x')).toBeNull();
  });

  test('부모 파싱 — 판 · 자리 · 런 id', () => {
    const rows = parseHarnessParents(ps);
    expect(rows.map((row) => [row.pid, row.kind, row.seat, row.version, row.runId])).toEqual([
      [1040, 'say', 'OP', '0.2.19-dev.0-4cdf', 'run-oldterminal'],
      [1896, 'say', 'TC', '0.2.20-dev.0-6b74', 'run-youngrun1'],
      [2000, 'queue-child', null, null, 'run-podgone01'],
      [2100, 'say', 'UX', null, null],
    ]);
  });

  test('나이 하한 · 원장 끝 · Pod 없음 · 런 id 모름', () => {
    const ledgers: Record<string, Array<{ event: string; data?: Record<string, unknown> }>> = {
      'run-oldterminal': [{ event: 'run-status', data: { runStatus: 'failed' } }],
      'run-podgone01': [{ event: 'pod-child-run', data: { childRunId: 'run-childzz1' } }],
    };
    const report = staleHarnessParents(6, { ps: () => ps, loadLedger: (id) => ledgers[id] ?? null, podRuns: () => new Set(['run-oldterminal']) });
    expect(report.scanned).toBe(4);
    expect(report.podRunsMeasured).toBe(true);
    expect(report.rows.map((row) => [row.pid, row.reasons])).toEqual([
      [1040, ['ledger-terminal(failed)']],
      [2000, ['pod-gone']],
      [2100, ['run-id-unknown']],
    ]);
  });

  test('Pod 을 못 재면 Pod 근거 없이 원장만', () => {
    const report = staleHarnessParents(6, { ps: () => ps, loadLedger: () => null, podRuns: () => { throw new Error('kubectl down'); } });
    expect(report.podRunsMeasured).toBe(false);
    expect(report.rows.map((row) => row.pid)).toEqual([2100]);
  });
});

/** 실제 셸로 원격 스크립트를 돌린다(ssh 대신 로컬 sh · HOME = 임시 디렉터리). */
function localShell(home: string): SshRunner {
  return (_host, script, timeoutMs, stdin) => {
    const result = spawnSync('sh', ['-c', script], { encoding: 'utf8', timeout: timeoutMs, input: stdin,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home } });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

function fakeHome(body: string): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), 'parent-home-'));
  const bin = join(home, '.local/share/elanous/bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'elanous'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, 'elanous'), 0o755);
  const cwd = join(home, 'repo');
  mkdirSync(cwd);
  return { home, cwd };
}

describe('원격 스크립트 — 실제 셸', () => {
  const env = { ELANOUS_RUN_ID: 'run-shell0001' };

  test('HQ의 세 access 미러를 한 스냅샷으로 설치하고 원격에는 refresh 권한이 없다', () => {
    const { home } = fakeHome('true');
    const mirror = (account: string) => ({
      account,
      elanousAuth: JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { accessToken: `access-${account}`, refreshToken: '', refresh_token: '' } } } }),
      codexAuth: JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: `access-${account}`, refresh_token: '', refreshToken: '' } }),
    });
    try {
      const target = { host: 'h', cwd: '/repo' };
      const shell = localShell(home);
      installRemoteCodexAccessBatch(target, ['default', 'team', 'third'].map(mirror), shell);
      const store = JSON.parse(readFileSync(join(home, '.elanous', 'auth.json'), 'utf8'));
      expect(Object.keys(store.providers).sort()).toEqual(['openai-codex', 'openai-codex:team', 'openai-codex:third']);
      for (const account of ['default', 'team', 'third']) {
        const key = account === 'default' ? 'openai-codex' : `openai-codex:${account}`;
        const path = account === 'default' ? join(home, '.elanous', 'codex-default', 'auth.json') : join(home, '.elanous', 'codex-accounts', account, 'auth.json');
        const auth = JSON.parse(readFileSync(path, 'utf8'));
        expect(store.providers[key].tokens).toMatchObject({ accessToken: `access-${account}`, refreshToken: '', refresh_token: '' });
        expect(auth.tokens).toMatchObject({ access_token: `access-${account}`, refresh_token: '', refreshToken: '' });
      }
      expect(() => installRemoteCodexAccessBatch(target, [mirror('team'), mirror('team')], shell)).toThrow('duplicate');
      const staleLock = join(home, '.elanous', 'remote-codex-mirror.lock');
      writeFileSync(staleLock, 'dead installer');
      utimesSync(staleLock, new Date(0), new Date(0));
      installRemoteCodexAccessBatch(target, [mirror('default'), mirror('team')], shell);
      expect(existsSync(staleLock)).toBe(false);
      expect(JSON.parse(readFileSync(join(home, '.elanous', 'auth.json'), 'utf8')).providers['openai-codex:third']).toBeUndefined();
      expect(existsSync(join(home, '.elanous', 'codex-accounts', 'third'))).toBe(false);
      const firstParent = { ...target, configDir: join(home, 'parent-a', 'elanous') };
      const secondParent = { ...target, configDir: join(home, 'parent-b', 'elanous') };
      installRemoteCodexAccessBatch(firstParent, [mirror('team'), mirror('third')], shell);
      installRemoteCodexAccessBatch(secondParent, [mirror('team')], shell);
      expect(JSON.parse(readFileSync(join(firstParent.configDir, 'auth.json'), 'utf8')).providers['openai-codex:third']).toBeDefined();
      expect(existsSync(join(firstParent.configDir, 'codex-accounts', 'third', 'auth.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(secondParent.configDir, 'auth.json'), 'utf8')).providers['openai-codex:third']).toBeUndefined();
      const parentEntry = spawnSync('bun', [join(process.cwd(), 'bin', 'elanous.mjs'), '--config-dir', join(home, '.elanous'), 'provider', 'codex', 'account', 'list'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'parent-a'), CODEX_HOME: join(firstParent.configDir, 'codex-default') },
      });
      expect(parentEntry.status).toBe(0);
      expect(parentEntry.stdout).toContain('third');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('remote owner mirror installs only the selected account when account tokens differ', () => {
    const { home } = fakeHome('true');
    const sourceStore = join(home, 'source-auth.json');
    const accountToken = (exp: number) => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
    const accounts = ['team', 'third'] as const;
    const access = { team: accountToken(1_900_000_001), third: accountToken(1_900_000_002) };
    const refresh = { team: 'team-refresh-secret', third: 'third-refresh-secret' };
    const providers: Record<string, unknown> = {};
    for (const name of accounts) {
      const codexHome = join(home, `source-${name}`);
      mkdirSync(codexHome, { recursive: true });
      const idToken = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: `${name}-account` } })).toString('base64url')}.signature`;
      writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', last_refresh: '2026-10-19T00:00:00Z', tokens: {
        access_token: access[name], id_token: idToken, refresh_token: refresh[name], account_id: `${name}-account`,
      } }), { mode: 0o600 });
      providers[`openai-codex:${name}`] = { authMode: 'chatgpt', codexHome, lastRefresh: '2026-10-19T00:00:00Z', tokens: { accessToken: access[name], refreshToken: refresh[name] } };
    }
    writeFileSync(sourceStore, JSON.stringify({ version: 1, providers }), { mode: 0o600 });
    try {
      const remoteAccountDir = join(home, '.elanous', 'codex-accounts', 'stray');
      mkdirSync(remoteAccountDir, { recursive: true });
      writeFileSync(join(remoteAccountDir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'stray-token', refresh_token: '' } }), { mode: 0o600 });
      const orphanAccountDir = join(home, '.elanous', 'codex-accounts', 'orphan');
      mkdirSync(orphanAccountDir, { recursive: true });
      writeFileSync(join(orphanAccountDir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'orphan-token', refresh_token: '' } }), { mode: 0o600 });
      writeFileSync(join(home, '.elanous', 'auth.json'), JSON.stringify({ version: 1, providers: {
        'openai-codex:stray': { codexHome: remoteAccountDir, tokens: { accessToken: 'stray-token' } },
        anthropic: { tokens: { accessToken: 'keep-unrelated-provider' } },
      } }), { mode: 0o600 });
      writeFileSync(join(home, '.elanous', 'remote-codex-mirror.json'), JSON.stringify({ account: 'stray' }), { mode: 0o600 });
      const credentials = hostCredentials('third', sourceStore, () => '', { requireExplicitChatgptAuthMode: true });
      installRemoteCodexAccess({ host: 'h', cwd: '/repo' }, { ...credentials, account: 'third' }, localShell(home));
      const remoteStore = JSON.parse(readFileSync(join(home, '.elanous', 'auth.json'), 'utf8'));
      const remoteCodex = JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8'));
      expect(Object.keys(remoteStore.providers).sort()).toEqual(['anthropic', 'openai-codex', 'openai-codex:third']);
      expect(remoteStore.providers['openai-codex:third'].tokens).toMatchObject({ accessToken: access.third, refreshToken: '', refresh_token: '' });
      expect(remoteStore.providers['openai-codex:third'].codexHome).toBe(join(home, '.elanous', 'codex-accounts', 'third'));
      expect(remoteStore.providers['openai-codex'].tokens.accessToken).toBe(access.third);
      expect(remoteStore.providers.anthropic.tokens.accessToken).toBe('keep-unrelated-provider');
      expect(existsSync(remoteAccountDir)).toBe(false);
      expect(existsSync(orphanAccountDir)).toBe(false);
      expect(existsSync(join(home, '.elanous', 'remote-codex-mirror.json'))).toBe(false);
      expect(JSON.stringify({ remoteStore, remoteCodex })).not.toContain('stray-token');
      expect(remoteCodex.tokens).toMatchObject({ access_token: access.third, refresh_token: '', refreshToken: '' });
      expect(JSON.stringify({ remoteStore, remoteCodex })).not.toContain(access.team);
      expect(JSON.stringify({ remoteStore, remoteCodex })).not.toContain(refresh.team);

      const teamCredentials = hostCredentials('team', sourceStore, () => '', { requireExplicitChatgptAuthMode: true });
      installRemoteCodexAccess({ host: 'h', cwd: '/repo' }, { ...teamCredentials, account: 'team' }, localShell(home));
      const afterSwitch = JSON.parse(readFileSync(join(home, '.elanous', 'auth.json'), 'utf8'));
      const teamHome = join(home, '.elanous', 'codex-accounts', 'team');
      const teamCodex = JSON.parse(readFileSync(join(teamHome, 'auth.json'), 'utf8'));
      const defaultCodex = JSON.parse(readFileSync(join(home, '.codex', 'auth.json'), 'utf8'));
      expect(Object.keys(afterSwitch.providers).sort()).toEqual(['anthropic', 'openai-codex', 'openai-codex:team']);
      expect(afterSwitch.providers['openai-codex:team'].codexHome).toBe(teamHome);
      expect(afterSwitch.providers['openai-codex:team'].tokens.accessToken).toBe(access.team);
      expect(afterSwitch.providers['openai-codex'].tokens.accessToken).toBe(access.team);
      expect(teamCodex.tokens.access_token).toBe(access.team);
      expect(defaultCodex.tokens.access_token).toBe(access.team);
      expect(existsSync(join(home, '.elanous', 'codex-accounts', 'third'))).toBe(false);
      expect(JSON.stringify({ afterSwitch, teamCodex, defaultCodex })).not.toContain(access.third);
      expect(JSON.stringify({ afterSwitch, teamCodex, defaultCodex })).not.toContain(refresh.third);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('살아 있는 부모 → pid · 인자에 --no-auto-merge', () => {
    const { home, cwd } = fakeHome('echo "args: $*"; echo "run=$ELANOUS_RUN_ID"; echo "state=$ELANOUS_STATE_DIR"; sleep 5');
    const out = launchRemoteParent({ host: 'h', cwd }, ['harness', 'say', '--merge-by-host', "it's"],
      { ...env, ELANOUS_STATE_DIR: join(cwd, '.elanous-test') }, localShell(home));
    expect(out.pid).toBeGreaterThan(0);
    const log = readFileSync(join(home, '.elanous/remote-parents/run-shell0001.log'), 'utf8');
    expect(log).toContain('args: --config-dir');
    expect(log).toContain("harness say --no-auto-merge it's");
    expect(log).toContain('run=run-shell0001');
    expect(log).toContain(`state=${join(home, '.elanous')}`);
    expect(log).not.toContain(`state=${join(cwd, '.elanous-test')}`);
    try { process.kill(out.pid); } catch { /* 이미 끝남 */ }
  });

  test('사용자 지정 절대 configDir → 원격 셸에서 동일한 운영 상태 루트 사용', () => {
    const { home, cwd } = fakeHome('echo "state=$ELANOUS_STATE_DIR"; echo "args: $*"; sleep 5');
    const configDir = join(home, 'custom state');
    const out = launchRemoteParent({ host: 'h', cwd, configDir }, ['harness', 'say', '--merge-by-host'],
      { ...env, ELANOUS_STATE_DIR: join(cwd, '.elanous-test') }, localShell(home));
    expect(out.pid).toBeGreaterThan(0);
    const log = readFileSync(join(configDir, 'remote-parents/run-shell0001.log'), 'utf8');
    expect(log).toContain(`state=${configDir}`);
    expect(log).toContain(`args: --config-dir ${configDir} harness say --no-auto-merge`);
    expect(log).not.toContain(join(cwd, '.elanous-test'));
    try { process.kill(out.pid); } catch { /* 이미 끝남 */ }
  });

  test('REMOTE-PARENT-OBS: 원격 부모 발사 env에 원격 configDir과 같은 ELANOUS_STATE_DIR을', () => {
    const probe = 'echo "args: $*"; echo "run=$ELANOUS_RUN_ID"; echo "card=$ELANOUS_TASK_CARD_ID"; echo "key=$OPENROUTER_API_KEY"; echo "state=$ELANOUS_STATE_DIR"; sleep 3';
    const harnessArgs = ['harness', 'say', '--merge-by-host', 'goal'];
    const worktreeTestState = (cwd: string) => join(cwd, '.elanous-test');
    const { home, cwd } = fakeHome(probe);
    try {
      // 기본 configDir — 원격 셸이 $HOME 을 확장해 운영 상태 루트로 바인딩한다.
      const basic = launchRemoteParent({ host: 'h', cwd }, harnessArgs,
        { ELANOUS_RUN_ID: 'run-obs-0001', ELANOUS_TASK_CARD_ID: 'ta-obs-1', OPENROUTER_API_KEY: 'obs key', ELANOUS_STATE_DIR: worktreeTestState(cwd) },
        localShell(home));
      expect(basic.pid).toBeGreaterThan(0);
      const basicLog = readFileSync(join(home, '.elanous/remote-parents/run-obs-0001.log'), 'utf8');
      expect(basicLog).toContain('args: --config-dir');
      expect(basicLog).toContain('harness say --no-auto-merge goal');
      expect(basicLog).toContain('run=run-obs-0001');
      expect(basicLog).toContain('card=ta-obs-1');
      expect(basicLog).toContain('key=obs key');
      expect(basicLog).toContain(`state=${join(home, '.elanous')}`);
      expect(basicLog).not.toContain(`state=${worktreeTestState(cwd)}`);
      try { process.kill(basic.pid); } catch { /* 이미 끝남 */ }

      // 사용자 지정 절대 configDir — 그 경로 그대로 운영 상태 루트로 바인딩한다.
      const configDir = join(home, 'obs state');
      const custom = launchRemoteParent({ host: 'h', cwd, configDir }, harnessArgs,
        { ELANOUS_RUN_ID: 'run-obs-0001', ELANOUS_TASK_CARD_ID: 'ta-obs-1', OPENROUTER_API_KEY: 'obs key', ELANOUS_STATE_DIR: worktreeTestState(cwd) },
        localShell(home));
      expect(custom.pid).toBeGreaterThan(0);
      const customLog = readFileSync(join(configDir, 'remote-parents/run-obs-0001.log'), 'utf8');
      expect(customLog).toContain('harness say --no-auto-merge goal');
      expect(customLog).toContain('run=run-obs-0001');
      expect(customLog).toContain('card=ta-obs-1');
      expect(customLog).toContain('key=obs key');
      expect(customLog).toContain(`state=${configDir}`);
      expect(customLog).not.toContain(worktreeTestState(cwd));
      try { process.kill(custom.pid); } catch { /* 이미 끝남 */ }
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, { timeout: 20_000 });

  test('REMOTE-PARENT-OBS: HQ 의 derived(worktree) 상태 태그가 원격 부모로 흐르지 않고 explicit 로 찍힌다', () => {
    const probe = 'echo "state=$ELANOUS_STATE_DIR"; echo "source=$ELANOUS_STATE_DIR_SOURCE"; sleep 3';
    const harnessArgs = ['harness', 'say', '--merge-by-host', 'goal'];
    const worktreeTestState = (cwd: string) => join(cwd, '.elanous-test');
    const { home, cwd } = fakeHome(probe);
    try {
      // HQ 쪽 env — git worktree 파생 test 우주가 «루트 + 태그» 한 벌로 실린 상태(src/agent/identity-env.ts).
      const hqEnv = { ...env, ELANOUS_TASK_CARD_ID: 'ta-obs-2', ELANOUS_STATE_DIR: worktreeTestState(cwd), ELANOUS_STATE_DIR_SOURCE: 'derived' };
      // 기본 configDir — 원격 셸이 $HOME 을 확장한 운영 상태 루트 + explicit 태그.
      const basic = launchRemoteParent({ host: 'h', cwd }, harnessArgs, hqEnv, localShell(home));
      expect(basic.pid).toBeGreaterThan(0);
      const basicLog = readFileSync(join(home, '.elanous/remote-parents/run-shell0001.log'), 'utf8');
      expect(basicLog).toContain(`state=${join(home, '.elanous')}`);
      expect(basicLog).toContain('source=explicit');
      expect(basicLog).not.toContain('derived');
      expect(basicLog).not.toContain(worktreeTestState(cwd));
      try { process.kill(basic.pid); } catch { /* 이미 끝남 */ }

      // 사용자 지정 절대 configDir — 같은 한 벌.
      const configDir = join(home, 'obs state');
      const custom = launchRemoteParent({ host: 'h', cwd, configDir }, harnessArgs, { ...hqEnv, ELANOUS_RUN_ID: 'run-obs-0002' }, localShell(home));
      expect(custom.pid).toBeGreaterThan(0);
      const customLog = readFileSync(join(configDir, 'remote-parents/run-obs-0002.log'), 'utf8');
      expect(customLog).toContain(`state=${configDir}`);
      expect(customLog).toContain('source=explicit');
      expect(customLog).not.toContain('derived');
      expect(customLog).not.toContain(worktreeTestState(cwd));
      try { process.kill(custom.pid); } catch { /* 이미 끝남 */ }
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, { timeout: 20_000 });

  test('조기 종료 → 확실히 안 떴다(로컬로 가도 된다)', () => {
    const { home, cwd } = fakeHome('echo boom-reason; exit 2');
    expect(() => launchRemoteParent({ host: 'h', cwd }, ['harness', 'say', 'g'], env, localShell(home))).toThrow(RemoteParentNotLaunchedError);
  });

  test('cwd 없음 → 확실히 안 떴다', () => {
    const { home } = fakeHome('sleep 5');
    expect(() => launchRemoteParent({ host: 'h', cwd: join(home, 'missing') }, ['harness', 'say', 'g'], env, localShell(home))).toThrow(RemoteParentNotLaunchedError);
  });

  test('Codex access mirror is installed from stdin with no refresh authority and private files', () => {
    const { home } = fakeHome('true');
    const sourceHome = join(home, 'source-codex-home');
    mkdirSync(sourceHome);
    const sourceStore = join(home, 'source-auth.json');
    const sourceRefresh = 'hq-refresh-token-sentinel';
    const sourceIdToken = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fake-account' } })).toString('base64url')}.signature`;
    mkdirSync(join(home, '.elanous'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.elanous', 'auth.json'), JSON.stringify({ version: 9, remoteMarker: 'keep-elanous', providers: { other: { keep: true }, 'openai-codex': { providerMarker: 'keep-provider', authMode: 'remote-old', chatGPT: { accountId: 'remote-account', remoteOnly: 'keep-chatgpt-field' }, tokens: { legacy: 'keep-provider-token' } } } }));
    writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', last_refresh: 'remote-last-refresh', remoteMarker: 'keep-codex', tokens: { legacy: 'preserve-me' } }));
    writeFileSync(join(sourceHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', last_refresh: 'hq-last-refresh', sourceMarker: 'copy-source-field', tokens: {
      access_token: ACCESS_TOKEN, id_token: sourceIdToken, refresh_token: sourceRefresh, account_id: 'fake-account',
    } }), { mode: 0o600 });
    writeFileSync(sourceStore, JSON.stringify({ version: 1, providers: { 'openai-codex': {
      tokens: { accessToken: ACCESS_TOKEN, refreshToken: sourceRefresh }, lastRefresh: 'hq-last-refresh', authMode: 'chatgpt', codexHome: sourceHome,
    } } }), { mode: 0o600 });
    const credentials = hostCredentials('default', sourceStore, () => '');
    installRemoteCodexAccess({ host: 'h', cwd: '/repo' }, credentials, localShell(home));
    const elanousPath = join(home, '.elanous/auth.json');
    const codexPath = join(home, '.codex/auth.json');
    const elanous = JSON.parse(readFileSync(elanousPath, 'utf8'));
    const codex = JSON.parse(readFileSync(codexPath, 'utf8'));
    expect(elanous.providers['openai-codex'].tokens).toMatchObject({ accessToken: ACCESS_TOKEN, refreshToken: '', refresh_token: '' });
    expect(elanous.providers['openai-codex']).toMatchObject({ providerMarker: 'keep-provider' });
    expect(elanous.providers['openai-codex'].tokens.legacy).toBeUndefined();
    expect(elanous.providers['openai-codex']).toMatchObject({ authMode: 'chatgpt', lastRefresh: 'hq-last-refresh', chatGPT: { accountId: 'fake-account', remoteOnly: 'keep-chatgpt-field' } });
    expect(codex.tokens).toMatchObject({ access_token: ACCESS_TOKEN, id_token: sourceIdToken, refresh_token: '', refreshToken: '' });
    expect(codex.auth_mode).toBe('chatgpt');
    expect(codex.last_refresh).toBe('hq-last-refresh');
    expect(codex.sourceMarker).toBe('copy-source-field');
    expect(JSON.stringify(codex)).not.toContain(sourceRefresh);
    expect(elanous.version).toBe(9);
    expect(elanous.remoteMarker).toBe('keep-elanous');
    expect(elanous.providers.other).toEqual({ keep: true });
    expect(codex.remoteMarker).toBe('keep-codex');
    expect(codex.tokens.legacy).toBeUndefined();
    installRemoteCodexAccess({ host: 'h', cwd: '/repo' }, { ...credentials, account: 'third' }, localShell(home));
    const namedStore = JSON.parse(readFileSync(elanousPath, 'utf8'));
    expect(namedStore.providers['openai-codex:third'].tokens).toMatchObject({ accessToken: ACCESS_TOKEN, refreshToken: '', refresh_token: '' });
    expect(namedStore.providers['openai-codex:third'].codexHome).toBe(join(home, '.elanous', 'codex-accounts', 'third'));
    expect(namedStore.providers['openai-codex'].tokens.accessToken).toBe(ACCESS_TOKEN);
    delete namedStore.providers['openai-codex'];
    writeFileSync(elanousPath, JSON.stringify(namedStore));
    installRemoteCodexAccess({ host: 'h', cwd: '/repo' }, { ...credentials, account: 'third' }, localShell(home));
    expect(JSON.parse(readFileSync(elanousPath, 'utf8')).providers['openai-codex'].tokens.accessToken).toBe(ACCESS_TOKEN);
    expect(JSON.parse(hostCredentials('default', sourceStore, () => '', { requireExplicitChatgptAuthMode: true }).codexAuth).auth_mode).toBe('chatgpt');
    const sourceAuthPath = join(sourceHome, 'auth.json');
    const withoutLastRefresh = JSON.parse(readFileSync(sourceAuthPath, 'utf8')) as Record<string, unknown>;
    delete withoutLastRefresh.last_refresh;
    writeFileSync(sourceAuthPath, JSON.stringify(withoutLastRefresh), { mode: 0o600 });
    const noLastRefresh = hostCredentials('default', sourceStore, () => '');
    installRemoteCodexAccess({ host: 'h', cwd: '/repo' }, noLastRefresh, localShell(home));
    const codexWithoutLastRefresh = JSON.parse(readFileSync(codexPath, 'utf8')) as Record<string, unknown>;
    expect(Object.hasOwn(codexWithoutLastRefresh, 'last_refresh')).toBe(false);

    const withoutAuthMode = { ...withoutLastRefresh };
    delete withoutAuthMode.auth_mode;
    writeFileSync(sourceAuthPath, JSON.stringify(withoutAuthMode), { mode: 0o600 });
    const podCompatible = hostCredentials('default', sourceStore, () => '');
    expect(JSON.parse(podCompatible.codexAuth).auth_mode).toBeUndefined();
    expect(JSON.parse(podCompatible.elanousAuth).providers['openai-codex'].authMode).toBe('chatgpt');
    expect(() => hostCredentials('default', sourceStore, () => '', { requireExplicitChatgptAuthMode: true }))
      .toThrow('auth_mode must be explicitly chatgpt for remote parent');
    expect(statSync(elanousPath).mode & 0o777).toBe(0o600);
    expect(statSync(codexPath).mode & 0o777).toBe(0o600);
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(home, '.codex');
    try {
      const reloaded = hostCredentials('default', elanousPath, () => '');
      expect(JSON.parse(reloaded.elanousAuth).version).toBe(9);
      expect(JSON.parse(reloaded.codexAuth).auth_mode).toBe('chatgpt');
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });

  test('failed remote auth write removes the credential-bearing temporary file', () => {
    const { home } = fakeHome('true');
    mkdirSync(join(home, '.elanous', 'auth.json'), { recursive: true });
    expect(() => installRemoteCodexAccess({ host: 'h', cwd: '/repo' }, TEST_CODEX_MIRROR, localShell(home))).toThrow('ssh rc=');
    expect(readdirSync(join(home, '.elanous'))).toEqual(['auth.json']);
  });

  test('remote Codex access mirror rejects unsupported auth modes before SSH', () => {
    let sshCalls = 0;
    expect(() => installRemoteCodexAccess({ host: 'h', cwd: '/repo' }, {
      elanousAuth: JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { accessToken: 'access', refreshToken: '', refresh_token: '' } } } }),
      codexAuth: JSON.stringify({ auth_mode: 'oauth', tokens: { access_token: 'access', refresh_token: '', refreshToken: '' } }),
    }, () => { sshCalls++; return { status: 0, stdout: '', stderr: '' }; })).toThrow('versioned store, auth mode');
    expect(() => installRemoteCodexAccess({ host: 'h', cwd: '/repo' }, {
      elanousAuth: JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { accessToken: 'access', refreshToken: '', refresh_token: '' } } } }),
      codexAuth: JSON.stringify({ tokens: { access_token: 'access', refresh_token: '', refreshToken: '' } }),
    }, () => { sshCalls++; return { status: 0, stdout: '', stderr: '' }; })).toThrow('versioned store, auth mode');
    expect(sshCalls).toBe(0);
  });

  test('ssh 끊김 → 불확실(일반 Error · 로컬 재발사 금지)', () => {
    let error: unknown;
    try { launchRemoteParent(TARGET, ['harness', 'say', 'g'], env, stubSsh([{ match: /./, status: 255, stderr: 'broken pipe' }])); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RemoteParentNotLaunchedError);
    expect(String(error)).toContain('불확실');
  });

  test('원장 거울 — 실제 셸 · 사라진 원격 원장은 거울도 걷는다', () => {
    const { home } = fakeHome('true');
    const remoteDir = join(home, '.elanous/run-ledger');
    mkdirSync(remoteDir, { recursive: true });
    writeFileSync(join(remoteDir, 'run-shell0001.jsonl'), '{"event":"start"}\n');
    const root = mkdtempSync(join(tmpdir(), 'mirror-root-'));
    expect(mirrorRemoteRunLedgers({ host: 'h' }, 'run-shell0001', root, localShell(home))).toEqual(['run-shell0001']);
    const mirrored = join(remoteLedgerMirrorDir(root, 'h'), 'run-shell0001.jsonl');
    expect(readFileSync(mirrored, 'utf8')).toBe('{"event":"start"}\n');
    rmSync(join(remoteDir, 'run-shell0001.jsonl'));
    expect(mirrorRemoteRunLedgers({ host: 'h' }, 'run-shell0001', root, localShell(home))).toEqual([]);
    expect(existsSync(mirrored)).toBe(false);
  });

  test('원장 읽기 오류(권한)는 «없음»이 아니라 던진다', () => {
    if (process.getuid?.() === 0) return;
    const { home } = fakeHome('true');
    const remoteDir = join(home, '.elanous/run-ledger');
    mkdirSync(remoteDir, { recursive: true });
    writeFileSync(join(remoteDir, 'run-shell0002.jsonl'), 'x');
    chmodSync(join(remoteDir, 'run-shell0002.jsonl'), 0o000);
    expect(() => mirrorRemoteRunLedgers({ host: 'h' }, 'run-shell0002', mkdtempSync(join(tmpdir(), 'mirror-root-')), localShell(home))).toThrow('원격 원장 읽기 실패');
  });
});

describe('defaultTaskLauncher — 불확실한 원격 발사는 로컬로 다시 띄우지 않는다', () => {
  test('ssh 끊김 → 던진다 · 로컬 spawn 0', async () => {
    const context = { runId: 'run-aaaabbbb-cccc-dddd-eeee-ffff00001111', launchId: 'tl-y', env: { ELANOUS_RUN_ID: 'run-aaaabbbb-cccc-dddd-eeee-ffff00001111' } };
    const ssh = stubSsh([{ match: /--version/, stdout: GOOD_FACTS }, { match: /nohup/, status: 255, stderr: 'connection reset' }]);
    let local = 0;
    const spawn: DetachedSpawn = () => { local++; throw new Error('no'); };
    await expect(launchWithTestMirror(['harness', 'say', 'g'], undefined, context, { parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn })).rejects.toThrow('불확실');
    expect(local).toBe(0);
  });
});

describe('LLM 자격 사실 — 막지 않고 경고', () => {
  const FULL = `${GOOD_FACTS}codexAccounts=3\ngrok=1\nopenrouter=1\n`;
  const judge = (facts: Record<string, string>) => judgeParentHostFacts(facts, { localVersion: '0.2.20-dev.0', launchHoldActive: false });

  test('host with one codex account and no grok credential yields warnings but no gaps', () => {
    const result = preflightParentHost({ target: TARGET, localVersion: '0.2.20-dev.0', launchHoldActive: false, ssh: stubSsh([{ match: /--version/, stdout: `${GOOD_FACTS}codexAccounts=1\nopenrouter=1\n` }]) });
    expect(result.gaps).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual(['codex-accounts-low', 'grok-credential-missing']);
  });

  test('fully credentialed host yields no warnings', () => {
    const result = preflightParentHost({ target: TARGET, localVersion: '0.2.20-dev.0', launchHoldActive: false, ssh: stubSsh([{ match: /--version/, stdout: FULL }]) });
    expect(result).toMatchObject({ ok: true, gaps: [], warnings: [] });
  });

  test('credential facts never turn into gaps; unreachable host has no credential warnings', () => {
    const facts = { version: '0.2.20-dev.0', config: '1', podPool: '1', repo: '1', kubectl: '1', codexAccounts: '0', grok: '', openrouter: '' };
    expect(judge(facts)).toEqual([]);
    expect(judgeParentHostCredentials(facts)).toEqual(['codex-accounts-low', 'grok-credential-missing', 'openrouter-key-missing']);
    expect(judgeParentHostCredentials({ unreachable: 'rc=255' })).toEqual([]);
  });

  test('launcher warns with the host name and still launches remotely', async () => {
    const runId = 'run-cafe0000-3333-4444-5555-666677778888';
    const ssh = stubSsh([{ match: /--version/, stdout: `${GOOD_FACTS}codexAccounts=1\n` }, { match: /nohup/, stdout: 'pid=4545\n' }]);
    const notices: string[] = [];
    const receipt = await launchWithTestMirror(['harness', 'say', '--substrate', 'pod', '--merge-by-host', 'g'], undefined, { runId, launchId: 'tl-c', env: { ELANOUS_RUN_ID: runId } },
      { parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn: () => { throw new Error('로컬 발사가 불리면 안 된다'); }, notice: (line) => notices.push(line) });
    expect(receipt).toMatchObject({ parentHost: { host: 'node-b', pid: 4545 } });
    expect(notices).toEqual(['⚠ node-b 자격: codex-accounts-low · grok-credential-missing · openrouter-key-missing']);
  });

  test('each remote parent launch redeploys the access-only mirror through stdin before starting', async () => {
    const calls: Array<{ script: string; stdin?: string }> = [];
    let mirrorReads = 0;
    const ssh: SshRunner = (_host, script, _timeout, stdin) => {
      calls.push({ script, ...(stdin !== undefined ? { stdin } : {}) });
      return { status: 0, stdout: script.includes('--version') ? GOOD_FACTS : script.includes('nohup') ? 'pid=5151\n' : '', stderr: '' };
    };
    const context = { runId: 'run-mirror0001', launchId: 'tl-mirror', env: { ELANOUS_RUN_ID: 'run-mirror0001' } };
    const deps = { parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0',
      codexAccessMirror: async () => { mirrorReads++; return { ...TEST_CODEX_MIRROR, account: 'third', usedPercent: 47, thresholdPercent: 60 }; }, ownerCodexLeaseHolder: () => true, spawn: () => { throw Error('local fallback'); } };

    const first = await launchWithTestMirror(['harness', 'say', 'g'], undefined, context, deps);
    const second = await launchWithTestMirror(['harness', 'say', 'g'], undefined, context, deps);
    const installs = calls.filter((call) => call.stdin !== undefined);
    expect(first).toMatchObject({ parentHost: { host: 'node-b', pid: 5151 } });
    expect(second).toMatchObject({ parentHost: { host: 'node-b', pid: 5151 } });
    expect(mirrorReads).toBe(2);
    expect(installs).toHaveLength(2);
    for (const call of installs) {
      expect(call.script).not.toContain(ACCESS_TOKEN);
      expect(call.script).not.toContain('refreshCodexAccountHome');
      const payload = JSON.parse(call.stdin!)[0];
      expect(payload.provider.tokens.refreshToken).toBe('');
      expect(payload.provider.tokens.refresh_token).toBe('');
      expect(payload.codexAuth.tokens.refresh_token).toBe('');
      expect(payload.codexAuth.tokens.refreshToken).toBe('');
      expect(payload.codexAuth.tokens.access_token).toBe(ACCESS_TOKEN);
      expect(payload.codexAuth.tokens.id_token).toBe(ACCESS_TOKEN);
    }
    expect(calls.findIndex((call) => call.stdin !== undefined)).toBeLessThan(calls.findIndex((call) => call.script.includes('nohup')));
    const launchScript = calls.find((call) => call.script.includes('nohup'))!.script;
    expect(launchScript).toContain('ELANOUS_REMOTE_CODEX_ACCOUNT=third');
    expect(launchScript).toContain('ELANOUS_REMOTE_CODEX_USED_PERCENT=47');
    expect(launchScript).toContain('ELANOUS_REMOTE_CODEX_THRESHOLD_PERCENT=60');
    expect(launchScript).toContain('XDG_CONFIG_HOME=');
    expect(launchScript).toContain('CODEX_HOME=');
    expect(launchScript).toContain('GH_CONFIG_DIR="$HOME"/.config/gh');
    expect(launchScript).not.toContain(ACCESS_TOKEN);
  });

  test('single-account injection gives consecutive parents separate auth stores', async () => {
    const { home } = fakeHome('true');
    const configDir = join(home, '.elanous');
    const mirror = (account: string) => ({ account,
      elanousAuth: JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { accessToken: `access-${account}`, refreshToken: '', refresh_token: '' } } } }),
      codexAuth: JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: `access-${account}`, refresh_token: '', refreshToken: '' } }),
    });
    const launches: string[] = [];
    const shell = localShell(home);
    const ssh: SshRunner = (host, script, timeoutMs, stdin) => {
      if (stdin !== undefined) return shell(host, script, timeoutMs, stdin);
      if (script.includes('--version')) return { status: 0, stdout: GOOD_FACTS, stderr: '' };
      if (script.includes('nohup')) { launches.push(script); return { status: 0, stdout: 'pid=5151\n', stderr: '' }; }
      return { status: 0, stdout: '', stderr: '' };
    };
    const credentials = join(configDir, 'remote-parent-credentials');
    try {
      for (const [account, runId] of [['team', 'run-singlea'], ['third', 'run-singleb']] as const) {
        await defaultTaskLauncher(['harness', 'say', 'g'], undefined,
          { runId, launchId: `tl-${account}`, env: { ELANOUS_RUN_ID: runId } },
          { parentHost: { ...TARGET, configDir }, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0',
            codexAccessMirror: async () => mirror(account), ownerCodexLeaseHolder: () => true, spawn: () => { throw Error('local fallback'); } });
        const dirs = readdirSync(credentials);
        expect(dirs).toHaveLength(account === 'team' ? 1 : 2);
      }
      const stores = readdirSync(credentials).map((name) => join(credentials, name, 'elanous'));
      const installed = stores.map((store) => JSON.parse(readFileSync(join(store, 'auth.json'), 'utf8')).providers['openai-codex'].tokens.accessToken).sort();
      expect(installed).toEqual(['access-team', 'access-third']);
      expect(launches).toHaveLength(2);
      for (const script of launches) {
        expect(script).toContain('XDG_CONFIG_HOME=');
        expect(script).toContain('CODEX_HOME=');
        expect(script).toContain('remote-parent-credentials/');
      }
      expect(existsSync(join(home, '.codex', 'auth.json'))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('real HQ selector mirrors every eligible account in order and refuses when all owner accounts exceed caps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owner-mirror-selector-'));
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = root;
    try {
      const storePath = join(root, 'elanous', 'auth.json');
      mkdirSync(join(root, 'elanous'), { recursive: true });
      const accounts = ['third', 'team'] as const;
      const accountToken = (exp: number) => `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
      const accessByAccount = { third: accountToken(1_900_000_001), team: accountToken(1_900_000_002) } as const;
      const providers: Record<string, unknown> = {};
      for (const name of accounts) {
        const home = join(root, `codex-${name}`);
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: accessByAccount[name], id_token: accessByAccount[name], refresh_token: `refresh-${name}` } }));
        providers[`openai-codex:${name}`] = { authMode: 'chatgpt', codexHome: home, tokens: { accessToken: accessByAccount[name], refreshToken: `refresh-${name}` } };
      }
      writeFileSync(storePath, JSON.stringify({ version: 1, providers }));
      const candidates = accounts.map((name, index) => ({ name, storeKey: `openai-codex:${name}`, home: join(root, `codex-${name}`), reached: false, usedPercent: index === 0 ? 47 : 55 }));
      const rotation = { candidates, accountThresholds: accounts.map((name) => ({ name, thresholdPercent: 91 })) };
      const calls: Array<{ script: string; stdin?: string }> = [];
      const ssh: SshRunner = (_host, script, _timeout, stdin) => {
        calls.push({ script, ...(stdin === undefined ? {} : { stdin }) });
        return { status: 0, stdout: script.includes('--version') ? GOOD_FACTS : script.includes('nohup') ? 'pid=5152\n' : '', stderr: '' };
      };
      const baseDeps = { parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn: () => { throw Error('local fallback'); },
        ownerCodexLeaseHolder: () => true,
        ownerCodexRotation: () => rotation as unknown as ReturnType<typeof import('../oauth/codex-account-store.js').inspectCodexRotation>,
        ownerCodexRotationConfig: { accountOrder: ['team', 'third'], thresholdPercentByAccount: { third: 60, team: 60 } } };
      const launched = await defaultTaskLauncher(['harness', 'say', 'g'], undefined,
        { runId: 'run-ownerselect01', launchId: 'tl-ownerselect', substrate: 'pod', podGoal: 'document this behavior',
          env: { ELANOUS_RUN_ID: 'run-ownerselect01', ELANOUS_POD_MEMORY_TIER: 'high', ELANOUS_POD_MEMORY: '16Gi' } }, baseDeps);
      expect(launched && 'parentHost' in launched ? launched.parentHost?.host : undefined).toBe('node-b');
      const install = calls.find((call) => call.stdin !== undefined)!;
      const firstInstallScript = install.script;
      const installed = JSON.parse(install.stdin!);
      expect(installed.map((entry: { account: string }) => entry.account)).toEqual(['team', 'third']);
      expect(installed.map((entry: { provider: { tokens: { accessToken: string } } }) => entry.provider.tokens.accessToken)).toEqual([accessByAccount.team, accessByAccount.third]);
      expect(install.stdin).not.toContain('refresh-team');
      expect(install.stdin).not.toContain('refresh-third');
      const launchScript = calls.find((call) => call.script.includes('nohup'))?.script ?? '';
      expect(launchScript).toContain('ELANOUS_REMOTE_CODEX_THRESHOLD_PERCENT=60');
      expect(launchScript).toContain('ELANOUS_REMOTE_CODEX_ACCOUNT=team');
      expect(launchScript).toContain('ELANOUS_REMOTE_CODEX_ACCOUNTS=');
      expect(launchScript).toContain('ELANOUS_REMOTE_CODEX_ACCESS_ONLY=1');
      expect(launchScript).toContain('XDG_CONFIG_HOME=');
      expect(launchScript).toContain('CODEX_HOME=');
      expect(launchScript).toContain('remote-parent-credentials/');
      expect(launchScript).toContain('ELANOUS_POD_MEMORY_TIER=high');
      expect(launchScript).toContain('ELANOUS_POD_MEMORY=16Gi');

      // A broken owner credential skips team; the other owner credential still reaches node-b.
      calls.length = 0;
      const teamAuthPath = join(root, 'codex-team', 'auth.json');
      const teamAuthBefore = readFileSync(teamAuthPath, 'utf8');
      writeFileSync(teamAuthPath, JSON.stringify({ auth_mode: 'apikey', tokens: { access_token: accessByAccount.team, refresh_token: 'refresh-team' } }));
      const withBrokenTeam = await defaultTaskLauncher(['harness', 'say', 'g'], undefined,
        { runId: 'run-ownerselect02', launchId: 'tl-ownerselect2', substrate: 'pod', podGoal: 'document this behavior', env: { ELANOUS_RUN_ID: 'run-ownerselect02' } },
        baseDeps);
      expect(withBrokenTeam && 'parentHost' in withBrokenTeam ? withBrokenTeam.parentHost?.host : undefined).toBe('node-b');
      expect(JSON.parse(calls.find((call) => call.stdin !== undefined)!.stdin!).map((entry: { account: string }) => entry.account)).toEqual(['third']);
      expect(calls.find((call) => call.stdin !== undefined)!.script).not.toBe(firstInstallScript);
      writeFileSync(teamAuthPath, teamAuthBefore);

      // The owner lease can transfer after candidate planning. The stale
      // account is not refreshed, and the fresh account must not be installed.
      calls.length = 0;
      const expiring = accountToken(Math.floor(Date.now() / 1000) + 3_600);
      writeFileSync(teamAuthPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: expiring, id_token: expiring, refresh_token: 'refresh-team' } }));
      const teamAuthExpiring = readFileSync(teamAuthPath, 'utf8');
      let leaseChecks = 0;
      await expect(defaultTaskLauncher(['harness', 'say', 'g'], undefined,
        { runId: 'run-ownerselect03', launchId: 'tl-ownerselect3', substrate: 'pod', podGoal: 'document this behavior', env: { ELANOUS_RUN_ID: 'run-ownerselect03' } },
        { ...baseDeps, ownerCodexLeaseHolder: () => ++leaseChecks === 1 })).rejects.toThrow('임대가 설치 직전에 사라져');
      expect(leaseChecks).toBeGreaterThan(1);
      expect(readFileSync(teamAuthPath, 'utf8')).toBe(teamAuthExpiring);
      expect(calls.some((call) => call.stdin !== undefined || call.script.includes('nohup'))).toBe(false);

      calls.length = 0;
      const exhausted = { ...rotation, candidates: candidates.map((candidate) => ({ ...candidate, usedPercent: 99 })) };
      await expect(defaultTaskLauncher(['harness', 'say', 'g'], undefined,
        { runId: 'run-ownerempty01', launchId: 'tl-ownerempty', env: { ELANOUS_RUN_ID: 'run-ownerempty01' } },
        { ...baseDeps, ownerCodexRotation: () => exhausted as unknown as ReturnType<typeof import('../oauth/codex-account-store.js').inspectCodexRotation> })).rejects.toThrow('모두 사용 임계');
      expect(calls.some((call) => call.stdin !== undefined || call.script.includes('nohup'))).toBe(false);

      calls.length = 0;
      writeFileSync(teamAuthPath, teamAuthBefore);
      const creditCandidates = candidates.map((candidate) => ({ ...candidate, reached: true, usedPercent: 100,
        hasCredits: true, creditBalance: candidate.name === 'team' ? 3_000 : 1_000 }));
      const creditLaunch = await defaultTaskLauncher(['harness', 'say', 'g'], undefined,
        { runId: 'run-ownercredit01', launchId: 'tl-ownercredit', substrate: 'pod', podGoal: 'document this behavior',
          env: { ELANOUS_RUN_ID: 'run-ownercredit01' } },
        { ...baseDeps, ownerCodexRotation: () => ({ ...rotation, candidates: creditCandidates }) as unknown as ReturnType<typeof import('../oauth/codex-account-store.js').inspectCodexRotation>,
          ownerCodexRotationConfig: { ...baseDeps.ownerCodexRotationConfig, creditsAllowed: true, creditReserve: 2_000 } });
      expect(creditLaunch && 'parentHost' in creditLaunch ? creditLaunch.parentHost?.host : undefined).toBe('node-b');
      expect(JSON.parse(calls.find((call) => call.stdin !== undefined)!.stdin!).map((entry: { account: string }) => entry.account)).toEqual(['team']);
      expect(calls.some((call) => call.script.includes('nohup'))).toBe(true);

      // The receiver rejects a marker above 16 accounts. The sender must
      // bound the installed batch and marker together before remote launch.
      calls.length = 0;
      const manyNames = Array.from({ length: 17 }, (_, index) => `acct${String(index).padStart(2, '0')}`);
      const manyCandidates = manyNames.map((name) => {
        const home = join(root, `codex-${name}`);
        mkdirSync(home, { recursive: true });
        const token = accountToken(1_900_000_003);
        writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, id_token: token, refresh_token: `refresh-${name}` } }));
        providers[`openai-codex:${name}`] = { authMode: 'chatgpt', codexHome: home, tokens: { accessToken: token, refreshToken: `refresh-${name}` } };
        return { name, storeKey: `openai-codex:${name}`, home, reached: false, usedPercent: 10 };
      });
      writeFileSync(storePath, JSON.stringify({ version: 1, providers }));
      await defaultTaskLauncher(['harness', 'say', 'g'], undefined,
        { runId: 'run-ownercap17', launchId: 'tl-ownercap17', substrate: 'pod', podGoal: 'document this behavior', env: { ELANOUS_RUN_ID: 'run-ownercap17' } },
        { ...baseDeps, ownerCodexRotation: () => ({ ...rotation, candidates: manyCandidates }) as unknown as ReturnType<typeof import('../oauth/codex-account-store.js').inspectCodexRotation>,
          ownerCodexRotationConfig: { accountOrder: manyNames } });
      expect(JSON.parse(calls.find((call) => call.stdin !== undefined)!.stdin!).map((entry: { account: string }) => entry.account)).toEqual(manyNames.slice(0, 16));
      const cappedLaunch = calls.find((call) => call.script.includes('nohup'))!.script;
      const markerAccounts = (script: string) => {
        const quoted = /ELANOUS_REMOTE_CODEX_ACCOUNTS='([^']+)'/.exec(script)?.[1];
        expect(quoted).toBeDefined();
        return JSON.parse(quoted!).map((entry: { account: string }) => entry.account);
      };
      expect(markerAccounts(cappedLaunch)).toEqual(manyNames.slice(0, 16));

      // The injected owner source must obey the same installation and marker cap.
      calls.length = 0;
      const injected = manyNames.map((account) => ({ account, expiresAt: 1_900_000_003_000, thresholdPercent: 60,
        elanousAuth: JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { accessToken: `access-${account}`, refreshToken: '', refresh_token: '' } } } }),
        codexAuth: JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: `access-${account}`, refresh_token: '', refreshToken: '' } }),
      }));
      await defaultTaskLauncher(['harness', 'say', 'g'], undefined,
        { runId: 'run-ownerinject17', launchId: 'tl-ownerinject17', substrate: 'pod', podGoal: 'document this behavior', env: { ELANOUS_RUN_ID: 'run-ownerinject17' } },
        { ...baseDeps, codexAccessMirror: async () => ({ ...injected[16]!, mirrors: injected }) });
      const injectedInstall = JSON.parse(calls.find((call) => call.stdin !== undefined)!.stdin!).map((entry: { account: string }) => entry.account);
      const injectedLaunch = calls.find((call) => call.script.includes('nohup'))!.script;
      expect(injectedInstall).toEqual(manyNames.slice(0, 16));
      expect(markerAccounts(injectedLaunch)).toEqual(injectedInstall);
      expect(injectedLaunch).toContain('ELANOUS_REMOTE_CODEX_ACCOUNT=acct00');

      await expect(defaultTaskLauncher(['harness', 'say', 'g'], undefined,
        { runId: 'run-ownernolease', launchId: 'tl-ownernolease', env: { ELANOUS_RUN_ID: 'run-ownernolease' } },
        { ...baseDeps, ownerCodexLeaseHolder: () => false })).rejects.toThrow('주인 임대');
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preflight script measures existence and counts only — real shell on a fake HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'cred-facts-'));
    const cwd = mkdtempSync(join(tmpdir(), 'cred-cwd-'));
    mkdirSync(join(home, '.elanous'), { recursive: true });
    mkdirSync(join(home, '.grok'), { recursive: true });
    mkdirSync(join(home, '.cache'), { recursive: true });
    const run = () => {
      const facts: Record<string, string> = {};
      for (const line of localShell(home)('h', preflightScript({ host: 'h', cwd }), 20_000).stdout.split('\n')) {
        const at = line.indexOf('=');
        if (at > 0) facts[line.slice(0, at)] = line.slice(at + 1);
      }
      return facts;
    };
    const before = run();
    expect(before.codexAccounts).toBe('0');
    expect(before.grok).toBeUndefined();
    expect(before.openrouter).toBeUndefined();

    const secret = 'SECRET-TOKEN-VALUE';
    writeFileSync(join(home, '.elanous/auth.json'), JSON.stringify({ version: 1, providers: { 'openai-codex': { accessToken: secret }, 'openai-codex:team': { accessToken: secret }, anthropic: { accessToken: secret } } }, null, 2));
    writeFileSync(join(home, '.grok/auth.json'), JSON.stringify({ 'https://auth.x.ai::abc': { key: secret, expires_at: '2030-01-01T00:00:00Z' } }));
    writeFileSync(join(home, '.cache/openrouter_api_key'), secret);
    const after = run();
    expect(after).toMatchObject({ codexAccounts: '2', grok: '1', openrouter: '1' });
    expect(JSON.stringify(after)).not.toContain(secret);
  });
});

describe('HOST-TOOL-SELF-PROVISION — provider-ready parent admission', () => {
  const context = { runId: 'run-provider-ready-01', launchId: 'tl-provider-ready', effectiveChildProvider: 'grok',
    env: { ELANOUS_RUN_ID: 'run-provider-ready-01' } };

  test('missing Grok CLI requests provision once and excludes host; after install the same host launches', async () => {
    let installed = false;
    const calls: string[] = [];
    const notices: string[] = [];
    const provisionEvents: Array<{ host?: string; runId?: string; provider?: string; reason?: string }> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: { host?: string; runId?: string; provider?: string; reason?: string }) => {
      if (category === 'task-agent.parent-host' && event === 'provision-requested') provisionEvents.push(data ?? {});
    }) as typeof debug.log);
    const ssh: SshRunner = (_host, script) => {
      calls.push(script);
      return { status: 0, stdout: script.includes('--version')
        ? GOOD_FACTS.replace('grokCli=1\n', installed ? 'grokCli=1\n' : '')
        : script.includes('nohup') ? 'pid=4242\n' : '', stderr: '' };
    };
    const deps = { parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0',
      spawn: () => { throw Error('local launch forbidden'); }, notice: (line: string) => notices.push(line) };
    try {
      await expect(defaultTaskLauncher(['harness', 'say', 'g'], undefined, context, deps)).rejects.toThrow('parent-host-provision-pending');
      expect(calls.filter((script) => script.includes('nohup'))).toHaveLength(0);
      expect(notices.filter((line) => line.includes('provision 요청'))).toHaveLength(1);
      expect(provisionEvents).toEqual([{ host: 'node-b', runId: context.runId, provider: 'grok', reason: 'grok-cli-missing' }]);
      installed = true;
      const launched = await defaultTaskLauncher(['harness', 'say', 'g'], undefined, context, deps);
      expect(launched).toMatchObject({ parentHost: { host: 'node-b', pid: 4242 } });
    } finally { logSpy.mockRestore(); }
  });

  test('host-reported expiring and expired Grok credentials fail before launch; valid permits selection', async () => {
    const testTarget = { ...TARGET, host: 'remote-a' };
    const hostFacts = (state: string) => `${GOOD_FACTS}grok=1\ngrokHost=${state}\ncodexAccounts=3\nopenrouter=1\n`;
    for (const state of ['expiring', 'expired']) {
      const calls: string[] = [];
      const notices: string[] = [];
      await expect(defaultTaskLauncher(['harness', 'say', 'g'], undefined, context, {
        parentHost: testTarget, ssh: (_host, script) => { calls.push(script); return { status: 0, stdout: script.includes('--version') ? hostFacts(state) : '', stderr: '' }; },
        launchHoldActive: () => false, localVersion: '0.2.20-dev.0',
        spawn: () => { throw Error('local launch forbidden'); }, notice: (line) => notices.push(line),
      })).rejects.toThrow(`parent-host-provision-pending`);
      expect(calls.filter((script) => script.includes('nohup'))).toHaveLength(0);
      expect(notices.filter((line) => line.includes('provision 요청')))
        .toEqual([`[parent-host] remote-a provision 요청 — grok-credential-${state}; 준비 완료 전 배정 대기`]);
    }
    const launched = await defaultTaskLauncher(['harness', 'say', 'g'], undefined, context, {
      parentHost: testTarget, ssh: (_host, script) => ({ status: 0, stdout: script.includes('--version') ? hostFacts('valid') : script.includes('nohup') ? 'pid=4242\n' : '', stderr: '' }),
      launchHoldActive: () => false, localVersion: '0.2.20-dev.0',
      spawn: () => { throw Error('local launch forbidden'); },
    });
    expect(launched).toMatchObject({ parentHost: { host: 'remote-a', pid: 4242 } });
  });

  test('missing Codex CLI is a gap only for Codex child selection', () => {
    const facts = { version: '0.2.20-dev.0', config: '1', podPool: '1', repo: '1', kubectl: '1', grokCli: '1' };
    expect(judgeParentHostFacts(facts, { localVersion: '0.2.20-dev.0', launchHoldActive: false, childProvider: 'openai-codex' })).toContain('codex-cli-missing');
    expect(judgeParentHostFacts(facts, { localVersion: '0.2.20-dev.0', launchHoldActive: false, childProvider: 'grok' })).toEqual([]);
  });
});

describe('TA-LAND-REMOTE-PARENT — a ta-land run may use a remote parent', () => {
  const runId = 'run-aaaa2222-3333-4444-5555-666677778888';
  const localSpawn = (counter: { n: number }): DetachedSpawn => () => {
    counter.n++;
    return { pid: 1, once(event: string, listener: () => void) { if (event === 'spawn') queueMicrotask(listener); return this; }, removeListener() { return this; }, unref() {} } as unknown as ReturnType<DetachedSpawn>;
  };

  test('ELANOUS_TA_LAND=1 → remote ssh with marker and --no-auto-merge · no local spawn', async () => {
    const { debug } = await import('../debug/log.js');
    const { spyOn } = await import('bun:test');
    const logged: Array<Record<string, unknown>> = [];
    const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'task-agent' && event === 'parent-host-fallback') logged.push(data ?? {});
    }) as typeof debug.log);
    try {
      const ssh = stubSsh([{ match: /--version/, stdout: GOOD_FACTS }, { match: /nohup/, stdout: 'pid=4242\n' }]);
      const counter = { n: 0 };
      const notices: string[] = [];
      const context = { runId, launchId: 'tl-y', env: { ELANOUS_RUN_ID: runId, ELANOUS_TA_LAND: '1' } };
      const receipt = await launchWithTestMirror(['harness', 'say', '--substrate', 'pod', '--merge-by-host', 'g'], undefined, context,
        { parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn: localSpawn(counter), earlyExitWindowMs: 0, notice: (line) => notices.push(line) });
      const launches = ssh.calls.filter((call) => call.includes('nohup'));
      expect(launches).toHaveLength(1);
      const launch = launches[0]!;
      expect(launch).toContain('ELANOUS_TA_LAND=1');
      expect(launch).toContain('--no-auto-merge');
      expect(launch).not.toContain('--merge-by-host');
      expect(counter.n).toBe(0);
      expect(receipt).toMatchObject({ runId, parentHost: { host: 'node-b', pid: 4242 } });
      expect(logged).toEqual([]);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('자격:');
    } finally { spy.mockRestore(); }
  });

  test('no marker → remote parent as before (ssh launch · no local spawn)', async () => {
    const ssh = stubSsh([{ match: /--version/, stdout: GOOD_FACTS }, { match: /nohup/, stdout: 'pid=4343\n' }]);
    const context = { runId, launchId: 'tl-z', env: { ELANOUS_RUN_ID: runId } };
    const receipt = await launchWithTestMirror(['harness', 'say', '--substrate', 'pod', '--merge-by-host', 'g'], undefined, context,
      { parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn: () => { throw new Error('로컬 발사가 불리면 안 된다'); } });
    expect(receipt).toMatchObject({ runId, parentHost: { host: 'node-b', pid: 4343 } });
    expect(ssh.calls.some((call) => call.includes('nohup'))).toBe(true);
  });
});

describe('GROK-MIRROR-REAL-SCOPE — 원격 부모는 호스트 자체 grok 자격을 쓴다', () => {
  const testTarget = { ...TARGET, host: 'remote-a' };
  const hostFacts = (state: string) => `${GOOD_FACTS}grok=1\ngrokHost=${state}\ncodexAccounts=3\nopenrouter=1\n`;

  test('preflight blocks a Grok child when the host reports no credential and asks OP to re-login', () => {
    const reloginEvents: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'grok-relogin-required-test', emit: (rec) => {
      if (rec.category === 'task-agent.parent-host' && rec.event === 'grok-relogin-required') reloginEvents.push(rec.data as Record<string, unknown>);
    } });
    try {
      const blocked = preflightParentHost({ target: testTarget, localVersion: '0.2.20-dev.0', launchHoldActive: false, childProvider: 'grok',
        ssh: stubSsh([{ match: /--version/, stdout: `${GOOD_FACTS}grokHost=missing\ncodexAccounts=3\nopenrouter=1\n` }]) });
      expect(blocked.ok).toBe(false);
      expect(blocked.gaps).toEqual(['grok-credential-missing']);
      expect(reloginEvents).toEqual([expect.objectContaining({ host: 'remote-a', state: 'missing', gaps: ['grok-credential-missing'] })]);

      const valid = preflightParentHost({ target: testTarget, localVersion: '0.2.20-dev.0', launchHoldActive: false, childProvider: 'grok',
        ssh: stubSsh([{ match: /--version/, stdout: hostFacts('valid') }]) });
      expect(valid).toMatchObject({ ok: true, gaps: [] });
      expect(reloginEvents).toHaveLength(1);
    } finally { off(); }
  });

  test('judgeParentHostGrokCredential blocks missing/expiring/expired and passes valid, unknown, or a non-Grok child', async () => {
    const { judgeParentHostGrokCredential: judgeGrok } = await import('./parent-host.js');
    expect(typeof judgeGrok).toBe('function');
    const judge = (facts: Record<string, string>, childProvider?: string) =>
      judgeGrok(facts, { ...(childProvider ? { childProvider } : {}) });
    expect(judge({ grokHost: 'missing' }, 'grok')).toEqual(['grok-credential-missing']);
    expect(judge({ grokHost: 'expiring', grok: '1' }, 'grok')).toEqual(['grok-credential-expiring']);
    expect(judge({ grokHost: 'expired', grok: '1' }, 'grok')).toEqual(['grok-credential-expired']);
    expect(judge({ grokHost: 'valid', grok: '1' }, 'grok')).toEqual([]);
    expect(judge({ grokHost: 'unknown', grok: '1' }, 'grok')).toEqual([]);
    expect(judge({ grokHost: 'missing' }, 'openai-codex')).toEqual([]);
    expect(judge({}, 'grok')).toEqual([]); // 호스트가 상태를 안 보고하면 막지 않는다(구 호스트)
    expect(judge({ unreachable: 'rc=255' }, 'grok')).toEqual([]);
  });

  test('real shell: the preflight probe measures the host credential against the 60m floor', () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-host-cred-'));
    const cwd = mkdtempSync(join(tmpdir(), 'grok-host-cwd-'));
    mkdirSync(join(home, '.grok'), { recursive: true });
    const auth = join(home, '.grok', 'auth.json');
    const facts = () => {
      const parsed: Record<string, string> = {};
      for (const line of localShell(home)('h', preflightScript({ host: 'h', cwd }), 20_000).stdout.split('\n')) {
        const at = line.indexOf('=');
        if (at > 0) parsed[line.slice(0, at)] = line.slice(at + 1);
      }
      return parsed;
    };
    const deviceAuth = (expiresAt: string, mirrorExpiresAt?: string) => JSON.stringify({
      'https://auth.x.ai::device': { key: 'host-device-auth-fixture', expires_at: expiresAt },
      ...(mirrorExpiresAt ? { 'https://auth.x.ai::hq-mirror': { key: 'stale-hq-mirror-fixture', expires_at: mirrorExpiresAt } } : {}),
    });
    try {
      expect(PARENT_CHILD_CREDENTIAL_MIN_REMAINING_MS).toBe(60 * 60_000);
      expect(facts().grokHost).toBe('missing');
      writeFileSync(auth, JSON.stringify({
        'https://auth.x.ai::hq-mirror': { key: 'mirror-only-fixture', expires_at: new Date(Date.now() + 6 * 3_600_000).toISOString() },
      }));
      expect(facts().grokHost).toBe('missing');
      writeFileSync(auth, deviceAuth(new Date(Date.now() + 30 * 60_000).toISOString(), new Date(Date.now() + 6 * 3_600_000).toISOString()));
      expect(facts().grokHost).toBe('expiring');
      writeFileSync(auth, deviceAuth(new Date(Date.now() + 30 * 60_000).toISOString()));
      expect(facts().grokHost).toBe('expiring');
      writeFileSync(auth, deviceAuth(new Date(Date.now() - 60_000).toISOString()));
      expect(facts().grokHost).toBe('expired');
      writeFileSync(auth, deviceAuth(new Date(Date.now() + 6 * 3_600_000).toISOString()));
      expect(facts()).toMatchObject({ grok: '1', grokHost: 'valid' });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
