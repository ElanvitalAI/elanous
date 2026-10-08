import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTaskLauncher, type DetachedSpawn } from '../cli/tasks-cli.js';
import {
  judgeParentHostFacts, launchRemoteParent, mirrorRemoteRunLedgers, RemoteParentNotLaunchedError, parseEtime, parseHarnessParents, preflightParentHost, remoteLaunchScript,
  remoteLedgerMirrorDir, remoteLedgerMirrorDirs, remoteParentArgs, resolveParentHost, staleHarnessParents, type ParentHostConfig, type SshRunner,
} from './parent-host.js';
import { handTask } from './task-hand.js';

const TARGET: ParentHostConfig = { host: 'node-b', cwd: '/Users/me/source/elanous' };
const GOOD_FACTS = 'version=0.2.20-dev.0\nconfig=1\npodPool=1\nrepo=1\nkubectl=1\n';

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
