import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTaskLauncher, type DetachedSpawn } from '../cli/tasks-cli.js';
import { debug } from '../debug/log.js';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';
import {
  judgeParentHostFacts, releaseCore, launchRemoteParent, mirrorRemoteRunLedgers, RemoteParentNotLaunchedError, parseEtime, parseHarnessParents, preflightParentHost, remoteLaunchScript,
  remoteLedgerMirrorDir, remoteLedgerMirrorDirs, remoteParentArgs, resolveParentHost, resolveParentHosts, orderParentHosts, readParentHostCapacity, staleHarnessParents, type ParentHostConfig, type SshRunner,
} from './parent-host.js';
import { handTask } from './task-hand.js';

const TARGET: ParentHostConfig = { host: 'node-b', cwd: '/Users/me/source/elanous' };
const GOOD_FACTS = 'version=0.2.20-dev.0\nconfig=1\npodPool=1\nrepo=1\nkubectl=1\n';
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
  const node-c = hosts[1]!;
  test('list is validated, env off wins and host-specific capacity is measured', () => {
    expect(resolveParentHosts([{ ...TARGET, approvalCapacity: 2 }, node-c, { host: 'bad;host', cwd: '/x' }, { host: 'invalid', cwd: '/x', approvalCapacity: -1 }], {})).toEqual([{ ...TARGET, approvalCapacity: 2 }, node-c]);
    expect(resolveParentHosts([TARGET, { host: 'node-c', cwd: '/srv/elanous' }], {})).toHaveLength(2);
    expect(resolveParentHost({ ...TARGET, approvalCapacity: 0 }, {})).toMatchObject({ host: 'node-b', approvalCapacity: 0 });
    expect(resolveParentHosts(hosts, { ELANOUS_TA_PARENT_HOST: 'off' })).toEqual([]);
    expect(resolveParentHosts(hosts, { ELANOUS_TA_PARENT_HOST: 'node-c' })).toEqual([node-c]);
    expect(readParentHostCapacity(node-c, () => ({ status: 0, stdout: capacitySample(2), stderr: '' }))).toEqual({ approvalHeadroom: 6, load: 0 });
    expect(readParentHostCapacity({ ...node-c, approvalCapacity: 2 }, () => ({ status: 0, stdout: capacitySample(2), stderr: '' }))).toEqual({ approvalHeadroom: 0, load: 0 });
    expect(readParentHostCapacity(TARGET, () => ({ status: 0, stdout: capacitySample(0), stderr: '' }))).toEqual({ approvalHeadroom: 1, load: 0 });
    expect(readParentHostCapacity(TARGET, () => ({ status: 0, stdout: capacitySample(1), stderr: '' }))).toEqual({ approvalHeadroom: 0, load: 0 });
    expect(readParentHostCapacity(node-c, () => ({ status: 255, stdout: '', stderr: 'timeout' }))).toBeNull();
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
    const pair = [{ ...TARGET, approvalCapacity: 2 }, { ...node-c, approvalCapacity: 2 }];
    const sample = readParentHostCapacity(pair[0]!, read('node-b'))!;
    expect(sample).toEqual({ approvalHeadroom: 1, load: 0.75 });
    expect(readParentHostCapacity(pair[1]!, read('node-b'))).toEqual({ approvalHeadroom: 2, load: 0.05 });
    const recovered = capacitySample(0, 1, 0).replace('__ELANOUS_PARENT_CAPACITY__0\n', `__ELANOUS_PARENT_CAPACITY__0\n${JSON.stringify({ category: 'pod-lease', event: 'admit-by-usage', data: { runId: 'run-waiting', recommended: 3 } })}\n`);
    expect(readParentHostCapacity(pair[0]!, () => ({ status: 0, stdout: recovered, stderr: '' }))?.approvalHeadroom).toBe(2);
    const tally = async (congested: string) => {
      const counts = { node-b: 0, node-c: 0 };
      for (let n = 0; n < 100; n++) {
        const receipt = await defaultTaskLauncher(['harness', 'say', 'g'], undefined, context(n + 500), {
          parentHost: pair, ssh: read(congested), launchHoldActive: () => false, localVersion: '0.2.20-dev.0',
          spawn: () => { throw Error('unexpected local'); },
        });
        counts[(receipt as { parentHost: { host: keyof typeof counts } }).parentHost.host]++;
      }
      return counts;
    };
    const first = await tally('node-b');
    const second = await tally('node-c');
    expect(first.node-c).toBeGreaterThan(first.node-b);
    expect(second.node-b).toBeGreaterThan(second.node-c);
    const lowLoad = { node-b: { approvalHeadroom: 2, load: 0.05 }, node-c: { approvalHeadroom: 2, load: 0.75 } };
    const highLoad = { node-b: lowLoad.node-c, node-c: lowLoad.node-b };
    const lowSelected = Array.from({ length: 100 }, (_, n) => orderParentHosts(pair, `run-load-${n}`, lowLoad)[0]!.host);
    const highSelected = Array.from({ length: 100 }, (_, n) => orderParentHosts(pair, `run-load-${n}`, highLoad)[0]!.host);
    expect(lowSelected.filter((host) => host === 'node-b').length).toBeGreaterThan(highSelected.filter((host) => host === 'node-b').length + 10);
    expect(observedScripts[0]).toContain('logs --event admit-by-usage --since 5m --json --limit 1000');
    expect(observedScripts[0]).toContain('cpu=$(ps -Ao %cpu=)');
    const unknown = capacitySample(0).replace('__ELANOUS_PARENT_LOAD__cores=4', '__ELANOUS_PARENT_LOAD__cores=bad');
    expect(readParentHostCapacity(pair[0]!, () => ({ status: 0, stdout: unknown, stderr: '' }))).toBeNull();
    const truncated = capacitySample(0).replace('__ELANOUS_PARENT_APPROVALS__', `${JSON.stringify({ _meta: { limitReached: true } })}\n__ELANOUS_PARENT_APPROVALS__`);
    expect(readParentHostCapacity(pair[0]!, () => ({ status: 0, stdout: truncated, stderr: '' }))).toBeNull();
  });
  test('capacity-proportional selection across distinct run ids; zero-headroom is not selected', () => {
    const capacity = { node-b: { approvalHeadroom: 2, load: 1 }, node-c: { approvalHeadroom: 6, load: 1 } };
    const counts = { node-b: 0, node-c: 0 };
    for (let n = 0; n < 400; n++) counts[orderParentHosts(hosts, `run-distribution-${n}`, capacity)[0]!.host as keyof typeof counts]++;
    expect(counts.node-c).toBeGreaterThan(250);
    expect(counts.node-c).toBeLessThan(350);
    expect(orderParentHosts(hosts, 'run-1', { ...capacity, node-b: { approvalHeadroom: 0, load: 1 } })[0]!.host).toBe('node-c');
    const ratioHosts = [{ ...TARGET, approvalCapacity: 32 }, { ...node-c, approvalCapacity: 14 }];
    const ratio = { node-b: 0, node-c: 0 };
    for (let n = 0; n < 30; n++) ratio[orderParentHosts(ratioHosts, `run-parent-${n}`, {
      node-b: { approvalHeadroom: 32, load: 0 }, node-c: { approvalHeadroom: 14, load: 0 },
    })[0]!.host as keyof typeof ratio]++;
    expect(ratio.node-b).toBeGreaterThan(0);
    expect(ratio.node-c).toBeGreaterThan(0);
    expect(Math.abs(ratio.node-b / 30 - 32 / 46)).toBeLessThanOrEqual(0.2);
  });
  const context = (n: number) => ({ runId: `run-multi-${n}`, launchId: `tl-${n}`, env: { ELANOUS_RUN_ID: `run-multi-${n}` } });
  const ssh: SshRunner = (host, script) => ({ status: 0, stderr: '', stdout: script.includes('__ELANOUS_PARENT_CAPACITY__') ? capacitySample(0) : script.includes('--version') ? GOOD_FACTS : `pid=${host === 'node-b' ? 111 : 222}\n` });
  const targets = [{ ...TARGET, approvalCapacity: 2 }, node-c];
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
        const receipt = await defaultTaskLauncher(['harness', 'say', 'g'], undefined,
          { runId, launchId: `tl-${n}`, env: { ELANOUS_RUN_ID: runId } },
          { parentHost: targets, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn: () => { throw Error('unexpected local'); } });
        receipts.set(runId, (receipt as { parentHost: { host: string } }).parentHost.host);
      }
      sink.flush();
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
    const weighted = [{ ...TARGET, approvalCapacity: 32 }, { ...node-c, approvalCapacity: 14 }];
    const counts = { node-b: 0, node-c: 0 };
    for (let n = 0; n < 30; n++) {
      const receipt = await defaultTaskLauncher(['harness', 'say', 'g'], undefined, context(n + 200), {
        parentHost: weighted, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0',
        spawn: () => { throw Error('unexpected local'); },
      });
      counts[(receipt as { parentHost: { host: keyof typeof counts } }).parentHost.host]++;
    }
    expect(counts.node-b).toBeGreaterThan(0);
    expect(counts.node-c).toBeGreaterThan(0);
    expect(Math.abs(counts.node-b / 30 - 32 / 46)).toBeLessThanOrEqual(0.2);
  });
  test('a valid list without approvalCapacity launches instead of falling back locally', async () => {
    const receipt = await defaultTaskLauncher(['harness', 'say', 'g'], undefined, context(101), {
      parentHost: [TARGET, { host: 'node-c', cwd: '/srv/elanous' }], ssh,
      launchHoldActive: () => false, localVersion: '0.2.20-dev.0',
      spawn: () => { throw Error('unexpected local'); },
    });
    expect(['node-b', 'node-c']).toContain((receipt as { parentHost: { host: string } }).parentHost.host);
  });
  test('unknown or saturated capacity excludes that host, then all unavailable hosts fall back locally', async () => {
    const reached: string[] = [];
    const probe: SshRunner = (host, script) => {
      if (script.includes('__ELANOUS_PARENT_CAPACITY__')) return host === 'node-b'
        ? { status: 255, stdout: '', stderr: 'capacity timeout' }
        : { status: 0, stdout: capacitySample(0), stderr: '' };
      reached.push(host);
      return { status: 0, stdout: script.includes('--version') ? GOOD_FACTS : 'pid=222\n', stderr: '' };
    };
    const spawn: DetachedSpawn = () => ({ pid: 1, once(event: string, listener: () => void) { if (event === 'spawn') queueMicrotask(listener); return this; }, removeListener() { return this; }, unref() {} } as unknown as ReturnType<DetachedSpawn>);
    const deps = { parentHost: targets, ssh: probe, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn, earlyExitWindowMs: 0, notice: () => {} };
    expect((await defaultTaskLauncher(['harness', 'say', 'g'], undefined, context(105), deps) as { parentHost: { host: string } }).parentHost.host).toBe('node-c');
    expect(reached).toEqual(['node-c', 'node-c']);
    reached.length = 0;
    const saturated: SshRunner = (host, script) => script.includes('__ELANOUS_PARENT_CAPACITY__')
      ? { status: 0, stdout: capacitySample(8), stderr: '' }
      : (reached.push(host), { status: 0, stdout: GOOD_FACTS, stderr: '' });
    expect(await defaultTaskLauncher(['harness', 'say', 'g'], undefined, context(106), { ...deps, ssh: saturated })).toEqual({ runId: context(106).runId });
    expect(reached).toEqual([]);
  });
  test('preflight rejects the chosen host before trying the other; unavailable capacity never launches there', async () => {
    const first = orderParentHosts(targets, context(99).runId, { node-b: { approvalHeadroom: 2, load: 0 }, node-c: { approvalHeadroom: 8, load: 0 } })[0]!.host;
    const launched: string[] = [];
    const ssh: SshRunner = (host, script) => {
      if (script.includes('__ELANOUS_PARENT_CAPACITY__')) return { status: 0, stdout: capacitySample(0), stderr: '' };
      if (script.includes('--version')) return { status: 0, stdout: host === first ? 'version=0.1.0\n' : GOOD_FACTS, stderr: '' };
      launched.push(host);
      return { status: 0, stdout: 'pid=42\n', stderr: '' };
    };
    const receipt = await defaultTaskLauncher(['harness', 'say', 'g'], undefined, context(99), { parentHost: targets, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn: () => { throw Error('unexpected local'); }, notice: () => {} });
    expect(launched).toEqual([targets.find((target) => target.host !== first)!.host]);
    expect((receipt as { parentHost: { host: string } }).parentHost.host).toBe(launched[0]);
  });
  test('definite failed first host tries next; both fail falls back locally; uncertain launch never retries', async () => {
    const first = orderParentHosts(targets, context(99).runId, { node-b: { approvalHeadroom: 2, load: 0 }, node-c: { approvalHeadroom: 8, load: 0 } })[0]!.host;
    const second = targets.find((target) => target.host !== first)!.host;
    const calls: string[] = [];
    const run = (failure: 'first' | 'both' | 'uncertain'): SshRunner => (host, script) => {
      if (script.includes('__ELANOUS_PARENT_CAPACITY__')) return { status: 0, stdout: capacitySample(0), stderr: '' };
      if (script.includes('--version')) return { status: 0, stdout: GOOD_FACTS, stderr: '' };
      calls.push(host);
      return host === first ? failure === 'uncertain' ? { status: 255, stdout: '', stderr: 'connection reset' } : { status: 3, stdout: 'not-launched=cwd\n', stderr: '' }
        : failure === 'both' ? { status: 4, stdout: 'not-launched=early-exit\n', stderr: '' } : { status: 0, stdout: 'pid=42\n', stderr: '' };
    };
    const spawn: DetachedSpawn = () => ({ pid: 1, once(event: string, listener: () => void) { if (event === 'spawn') queueMicrotask(listener); return this; }, removeListener() { return this; }, unref() {} } as unknown as ReturnType<DetachedSpawn>);
    expect((await defaultTaskLauncher(['harness', 'say', 'g'], undefined, context(99), { parentHost: targets, ssh: run('first'), launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn }) as { parentHost: { host: string } }).parentHost.host).toBe(second);
    expect(calls).toEqual([first, second]);
    calls.length = 0;
    expect(await defaultTaskLauncher(['harness', 'say', 'g'], undefined, context(99), { parentHost: targets, ssh: run('both'), launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn, earlyExitWindowMs: 0 })).toEqual({ runId: context(99).runId });
    expect(calls).toEqual([first, second]);
    calls.length = 0;
    await expect(defaultTaskLauncher(['harness', 'say', 'g'], undefined, context(99), { parentHost: targets, ssh: run('uncertain'), launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn })).rejects.toThrow('불확실');
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
    expect(script).toContain("env ELANOUS_RUN_ID=run-abcd1234 nohup");
    expect(script).toContain(`"$HOME"/.local/share/elanous/bin/elanous --config-dir "$HOME"/.elanous harness say --no-auto-merge`);
    expect(script).toContain(`'it'\\''s a goal\nline2'`);
    expect(script).toContain('remote-parents/run-abcd1234.log');
    expect(script).toContain('kill -0 "$p"');
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
    const receipt = await defaultTaskLauncher(['harness', 'say', '--substrate', 'pod', '--merge-by-host', 'g'], undefined, context, { parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn: noLocal });
    expect(receipt).toMatchObject({ runId: context.runId, parentHost: { host: 'node-b', pid: 4242 } });
    expect(ssh.calls.some((call) => call.includes('--no-auto-merge') && !call.includes('--merge-by-host'))).toBe(true);
  });

  test('점검 막힘 → 로컬로 되돌아가고 알림', async () => {
    const ssh = stubSsh([{ match: /--version/, stdout: 'version=0.2.19\n' }]);
    const notices: string[] = [];
    let localSpawned = 0;
    const spawn: DetachedSpawn = () => {
      localSpawned++;
      return { pid: 1, once(event: string, listener: () => void) { if (event === 'spawn') queueMicrotask(listener); return this; }, removeListener() { return this; }, unref() {} } as unknown as ReturnType<DetachedSpawn>;
    };
    const receipt = await defaultTaskLauncher(['harness', 'say', 'g'], undefined, context, { parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn, earlyExitWindowMs: 0, notice: (line) => notices.push(line) });
    expect(localSpawned).toBe(1);
    expect(receipt).toEqual({ runId: context.runId });
    expect(notices[0]).toContain('version-mismatch');
  });

  test('handTask 가 원격 영수증을 카드에 적는다', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'parent-host-')), 'task-agent-actions.json');
    const result = await handTask({ text: 'docs 한 줄', seat: 'OP', live: true, statePath, launcher: async (_args, _cwd, ctx) => ({ runId: ctx!.runId, parentHost: { host: 'node-b', pid: 7 } }) });
    expect(result.card.parentHost).toEqual({ host: 'node-b', pid: 7 });
    expect(result.card.history[0]!.detail).toContain('[parent@node-b · PR 까지만]');
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
  return (_host, script, timeoutMs) => {
    const result = spawnSync('sh', ['-c', script], { encoding: 'utf8', timeout: timeoutMs, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home } });
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

  test('살아 있는 부모 → pid · 인자에 --no-auto-merge', () => {
    const { home, cwd } = fakeHome('echo "args: $*"; echo "run=$ELANOUS_RUN_ID"; sleep 5');
    const out = launchRemoteParent({ host: 'h', cwd }, ['harness', 'say', '--merge-by-host', "it's"], env, localShell(home));
    expect(out.pid).toBeGreaterThan(0);
    const log = readFileSync(join(home, '.elanous/remote-parents/run-shell0001.log'), 'utf8');
    expect(log).toContain('args: --config-dir');
    expect(log).toContain("harness say --no-auto-merge it's");
    expect(log).toContain('run=run-shell0001');
    try { process.kill(out.pid); } catch { /* 이미 끝남 */ }
  });

  test('조기 종료 → 확실히 안 떴다(로컬로 가도 된다)', () => {
    const { home, cwd } = fakeHome('echo boom-reason; exit 2');
    expect(() => launchRemoteParent({ host: 'h', cwd }, ['harness', 'say', 'g'], env, localShell(home))).toThrow(RemoteParentNotLaunchedError);
  });

  test('cwd 없음 → 확실히 안 떴다', () => {
    const { home } = fakeHome('sleep 5');
    expect(() => launchRemoteParent({ host: 'h', cwd: join(home, 'missing') }, ['harness', 'say', 'g'], env, localShell(home))).toThrow(RemoteParentNotLaunchedError);
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
    await expect(defaultTaskLauncher(['harness', 'say', 'g'], undefined, context, { parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn })).rejects.toThrow('불확실');
    expect(local).toBe(0);
  });
});

describe('TA-LIVE-LAND-2 — a ta-land run needs a local parent', () => {
  const runId = 'run-aaaa2222-3333-4444-5555-666677778888';
  const localSpawn = (counter: { n: number }): DetachedSpawn => () => {
    counter.n++;
    return { pid: 1, once(event: string, listener: () => void) { if (event === 'spawn') queueMicrotask(listener); return this; }, removeListener() { return this; }, unref() {} } as unknown as ReturnType<DetachedSpawn>;
  };

  test('ELANOUS_TA_LAND=1 → no ssh at all · one local spawn · fallback gap ta-land-needs-local-parent', async () => {
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
      const receipt = await defaultTaskLauncher(['harness', 'say', '--substrate', 'pod', '--merge-by-host', 'g'], undefined, context,
        { parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn: localSpawn(counter), earlyExitWindowMs: 0, notice: (line) => notices.push(line) });
      expect(ssh.calls).toEqual([]);
      expect(counter.n).toBe(1);
      expect(receipt).toEqual({ runId });
      expect(logged).toEqual([expect.objectContaining({ host: 'node-b', runId, gaps: ['ta-land-needs-local-parent'] })]);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('ta-land-needs-local-parent');
    } finally { spy.mockRestore(); }
  });

  test('no marker → remote parent as before (ssh launch · no local spawn)', async () => {
    const ssh = stubSsh([{ match: /--version/, stdout: GOOD_FACTS }, { match: /nohup/, stdout: 'pid=4343\n' }]);
    const context = { runId, launchId: 'tl-z', env: { ELANOUS_RUN_ID: runId } };
    const receipt = await defaultTaskLauncher(['harness', 'say', '--substrate', 'pod', '--merge-by-host', 'g'], undefined, context,
      { parentHost: TARGET, ssh, launchHoldActive: () => false, localVersion: '0.2.20-dev.0', spawn: () => { throw new Error('로컬 발사가 불리면 안 된다'); } });
    expect(receipt).toMatchObject({ runId, parentHost: { host: 'node-b', pid: 4343 } });
    expect(ssh.calls.some((call) => call.includes('nohup'))).toBe(true);
  });
});
