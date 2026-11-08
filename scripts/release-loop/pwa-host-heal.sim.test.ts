import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { healPwaHostFailure, pwaHostHealRecipe, selectPwaHealHost, type PwaHostProbe } from '../../src/release-loop/knowhow/pwa-host-heal.js';
import { probePwaRemoteHost, runPwaRemote, type PwaRemoteSpawn } from './pwa-remote.js';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const PASS = JSON.stringify({ verdict: 'pass', commit: SHA, cells: [{ id: 'N5a', final: 'pass' }] });

function captureProbeScript(): string {
  let script = '';
  probePwaRemoteHost({ host: 'fixture', slots: 2 }, (_cmd, args) => {
    script = args[2] ?? '';
    return { rc: 255, stdout: '', stderr: 'not executed' };
  });
  return script;
}

function executeProbeScript(script: string, fixtures: { psOutput?: string; psFails?: boolean; uname?: string; uptime?: string }): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), 'pwa-host-probe-sim-'));
  const bin = join(root, '.bun', 'bin');
  mkdirSync(bin, { recursive: true });
  const command = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    chmodSync(path, 0o755);
  };
  command('bun', 'exit 0');
  command('git', 'printf "true\\n"');
  command('uname', 'printf "%s\\n" "${PWA_TEST_UNAME:-Linux}"');
  command('uptime', 'printf "%s\\n" "${PWA_TEST_UPTIME:-10:00 up 1 day, load averages: 2.09 2.88 4.18}"');
  command('ps', '[ "${PWA_TEST_PS_FAIL:-0}" = 1 ] && exit 7\nprintf "%s\\n" "${PWA_TEST_PS_OUTPUT:-}"');
  const chrome = join(root, 'chrome');
  writeFileSync(chrome, '');
  chmodSync(chrome, 0o755);
  try {
    const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', timeout: 5_000,
      env: { HOME: root, PATH: '/usr/bin:/bin', ELANOUS_CHROME_BIN: chrome,
        PWA_TEST_PS_OUTPUT: fixtures.psOutput ?? '', PWA_TEST_PS_FAIL: fixtures.psFails ? '1' : '0',
        PWA_TEST_UNAME: fixtures.uname ?? 'Linux', PWA_TEST_UPTIME: fixtures.uptime ?? '' } });
    const line = result.stdout.split('\n').reverse().find((row) => row.trim().startsWith('{'));
    if (!line) throw new Error(`probe script emitted no JSON: ${result.stderr}`);
    return JSON.parse(line) as Record<string, unknown>;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('PWA host-heal simulation: actual PWA remote node moves from mshq no-Chrome to eligible aws2 in the same run', async () => {
  expect(pwaHostHealRecipe('Chrome CDP unavailable: no-chrome-binary')?.id).toBe('pwa-host-environment-v1');
  expect(pwaHostHealRecipe('bun install failed: EACCES permission denied')?.id).toBe('pwa-host-environment-v1');
  expect(pwaHostHealRecipe('Cannot find package: missing node_modules')?.id).toBe('pwa-host-environment-v1');

  const probes: PwaHostProbe[] = [
    { host: 'gcp2', bun: true, chrome: true, repository: false, loadAverage: 0.2, activeRuns: 0, slots: 2, detail: 'mirror missing' },
    { host: 'host-c', bun: true, chrome: true, repository: true, loadAverage: 99, activeRuns: 0, slots: 1 },
    { host: 'aws2', bun: true, chrome: true, repository: true, loadAverage: 0.5, activeRuns: 0, slots: 2 },
  ];
  expect(selectPwaHealHost(probes, 'mshq', 20)?.host).toBe('aws2');
  const sshRunCount = new Map<string, number>();
  const fakeExternalBoundary: PwaRemoteSpawn = (cmd, args) => {
    if (cmd === 'git') return { rc: 0, stdout: '', stderr: '' };
    const host = args[1]!;
    const count = (sshRunCount.get(host) ?? 0) + 1;
    sshRunCount.set(host, count);
    if (host === 'mshq') return count === 1
      ? { rc: 0, stdout: '', stderr: '' }
      : { rc: 2, stdout: '', stderr: 'Chrome CDP unavailable: no-chrome-binary' };
    return count === 1 ? { rc: 0, stdout: '', stderr: '' } : { rc: 0, stdout: `${PASS}\n`, stderr: '[pwa-node] build complete' };
  };
  const invokePwaNode = (host: string) => runPwaRemote({ host, commit: SHA, withCostly: false, reruns: 2, repo: process.cwd() }, fakeExternalBoundary);
  const initial = invokePwaNode('mshq');
  expect(initial.exitCode).toBe(2);
  expect(String(initial.output.error)).toContain('no-chrome-binary');

  const healed = await healPwaHostFailure({ runId: 'sim-pwa-host-heal-19-44', failedHost: 'mshq', initial,
    candidates: { mshq: 2, gcp2: 2, 'host-c': 1, aws2: 2 }, maxLoadAverage: 20,
    probe: async (host, slots) => ({ ...probes.find((item) => item.host === host)!, slots }),
    run: async (host) => invokePwaNode(host) });

  expect(healed.result.exitCode).toBe(0);
  expect(healed.result.output).toMatchObject({ verdict: 'pass', host: 'aws2',
    hostHeal: { schema: 'elanous.release.pwa-host-heal.v1', runId: 'sim-pwa-host-heal-19-44',
      recipe: 'pwa-host-environment-v1', failedHost: 'mshq', selectedHost: 'aws2', outcome: 'recovered' } });
  expect(sshRunCount.get('mshq')).toBe(2);
  expect(sshRunCount.get('aws2')).toBe(2);
  expect(sshRunCount.get('gcp2')).toBeUndefined();
  expect(sshRunCount.get('host-c')).toBeUndefined();
});

test('PWA remote eligibility probe parses host bun, Chrome, repository, load, active runs, and configured slots', () => {
  let script = '';
  const probe = probePwaRemoteHost({ host: 'aws2', slots: 3 }, (cmd, args) => {
    expect(cmd).toBe('ssh');
    script = args[2] ?? '';
    return { rc: 0, stdout: '{"bun":true,"chrome":true,"repository":true,"loadAverage":1.25,"loadMeasured":true,"activeRuns":1,"activeRunsMeasured":true}\n', stderr: '' };
  });
  expect(probe).toEqual({ host: 'aws2', slots: 3, bun: true, chrome: true, repository: true, loadAverage: 1.25, activeRuns: 1 });
  expect(script).toContain('command -v bun');
  expect(script).toContain('chrome_ok');
  expect(script).toContain('git --git-dir=');
  expect(script).toContain('/proc/loadavg');
  expect(script).toContain("s/[ ,].*//");
  expect(script).toContain('ps -axo pid=,command=');
  expect(script).toContain('basename($2)');
  expect(script).toContain('isPwaScenario($3)');
  expect(script).not.toContain('pgrep -fc');
});

test('PWA host probe executes isolated ps and macOS uptime fixtures', () => {
  const script = captureProbeScript();
  const processRows = [
    '101 /tmp/fake/.bun/bin/notbun scripts/release-loop/pwa-scenarios-node.ts',
    '102 /tmp/fake/.bun/bin/bun scripts/other.ts scripts/release-loop/pwa-scenarios-node.ts',
    '103 /tmp/fake/.bun/bin/bun scripts/release-loop/pwa-scenarios-node.ts --json',
    '104 /tmp/fake/.bun/bin/bun /tmp/pwa-worktree/scripts/release-loop/pwa-scenarios-node.ts --json',
  ].join('\n');
  const measured = executeProbeScript(script, { psOutput: processRows, uname: 'Darwin',
    uptime: '10:00 up 1 day, 2 users, load averages: 2.09 2.88 4.18' });
  expect(measured).toMatchObject({ bun: true, chrome: true, repository: true, loadAverage: 2.09,
    loadMeasured: true, activeRuns: 2, activeRunsMeasured: true });

  const failedPs = executeProbeScript(script, { psFails: true, uname: 'Darwin',
    uptime: '10:00 up 1 day, load averages: 2.09 2.88 4.18' });
  expect(failedPs).toMatchObject({ loadAverage: 2.09, loadMeasured: true, activeRunsMeasured: false });
});

test('PWA host eligibility rejects unmeasured load and process counts', () => {
  const probe = probePwaRemoteHost({ host: 'host-c', slots: 2 }, () => ({ rc: 0,
    stdout: '{"bun":true,"chrome":true,"repository":true,"loadAverage":0,"loadMeasured":false,"activeRuns":0,"activeRunsMeasured":false}\n', stderr: '' }));
  expect(probe.loadAverage).toBe(Infinity);
  expect(probe.activeRuns).toBe(2);
  expect(selectPwaHealHost([probe], 'mshq', 20)).toBeUndefined();
});

test('PWA host-heal preserves an unrecovered receipt when no probe is eligible', async () => {
  const initial = { exitCode: 2 as const, output: { verdict: 'error', host: 'mshq', error: 'Chrome unavailable: no-chrome-binary' } };
  const healed = await healPwaHostFailure({ runId: 'sim-pwa-unrecovered', failedHost: 'mshq', initial,
    candidates: { aws2: 1 }, maxLoadAverage: 20,
    probe: async (host, slots) => ({ host, slots, bun: true, chrome: false, repository: true, loadAverage: 0.2, activeRuns: 0 }),
    run: async () => { throw new Error('ineligible host must not run'); } });
  expect(healed.result.output.hostHeal).toMatchObject({ outcome: 'unrecovered', runId: 'sim-pwa-unrecovered',
    initial: initial.output, candidates: [{ host: 'aws2', chrome: false }] });
});
