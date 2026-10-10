import { describe, expect, test } from 'bun:test';
import { GATE_REMOTE_DEFAULTS, runOnRemote, type GateRemoteRunner, type SshResult } from './gate-remote.js';
import { runTrainGateOnHost, trainGateOnHost, trainGateScript, type TrainGateObservation } from './train-gate-remote.js';

// Every remote call goes through an injected fake — no test reaches a real host.
const COMMIT = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MAIN = 'd'.repeat(40);
const settings = { ...GATE_REMOTE_DEFAULTS, slotWaitSeconds: 0 };
const RAN = (rc: number): SshResult => ({ rc: 0, stdout: 'out\n', stderr: `\n__GATE_REMOTE_RC=${rc}\n` });
const BUSY: SshResult = { rc: 98, stdout: '', stderr: '__GATE_REMOTE_BUSY\n' };

function fakeRunner(opts: { dirty?: boolean; ssh?: SshResult; diff?: string } = {}): GateRemoteRunner & { calls: string[][]; scripts: string[] } {
  const calls: string[][] = [];
  const scripts: string[] = [];
  return {
    calls, scripts,
    local(cmd, args) {
      calls.push([cmd, ...args]);
      if (cmd !== 'git') return { rc: 127, stdout: '', stderr: 'not git' };
      if (args[0] === 'status') return { rc: 0, stdout: opts.dirty ? ' M src/x.ts\n' : '', stderr: '' };
      if (args[0] === 'cat-file') return { rc: 0, stdout: 'commit\n', stderr: '' };
      if (args[0] === 'diff') return { rc: 0, stdout: opts.diff ?? '', stderr: '' };
      if (args[0] === 'rev-parse') {
        const ref = args.at(-1)!.replace('^{commit}', '');
        return { rc: 0, stdout: `${ref === 'HEAD' ? 'c'.repeat(40) : ref === 'origin/main' ? MAIN : ref}\n`, stderr: '' };
      }
      return { rc: 0, stdout: '', stderr: '' };
    },
    ssh(_host, script) { scripts.push(script); return opts.ssh ?? RAN(0); },
  };
}

const HEAVY = ['tsc', 'bun test', 'test:deterministic', 'nexus', 'ci-typecheck-changed'];
const localText = (runner: { calls: string[][] }) => runner.calls.map((call) => call.join(' '));

describe('runTrainGateOnHost', () => {
  test('rc 0 on the host is pass; heavy steps run only in the ssh script, never locally', async () => {
    const runner = fakeRunner();
    const observed: TrainGateObservation[] = [];
    const result = await runTrainGateOnHost({ repo: '/r', commit: COMMIT, baseSha: BASE, changedFiles: ['src/a.ts', 'src/a.test.ts'], settings }, runner, { observe: (e) => observed.push(e) });
    expect(result).toMatchObject({ outcome: 'pass', host: 'node-b', rc: 0 });
    for (const line of localText(runner)) for (const heavy of HEAVY) expect(line).not.toContain(heavy);
    expect(runner.calls.every((call) => call[0] === 'git')).toBe(true);
    expect(runner.scripts).toHaveLength(1);
    const script = runner.scripts[0]!;
    expect(script).toContain('ci-typecheck-changed');
    expect(script).toContain('test:deterministic');
    expect(script).toContain('ci-pwa-build-gate');
    expect(script).toContain(`TSC_BASE_REF=`);
    expect(script).toContain(`git checkout -q --detach ${COMMIT}`);
    expect(observed).toEqual([expect.objectContaining({ host: 'node-b', commit: COMMIT, baseSha: BASE, outcome: 'pass', rc: 0, changedFiles: 2 })]);
  });

  test('a tool rc != 0 is fail', async () => {
    const result = await runTrainGateOnHost({ repo: '/r', commit: COMMIT, baseSha: BASE, changedFiles: ['src/a.ts'], settings }, fakeRunner({ ssh: RAN(1) }), { observe: () => {} });
    expect(result).toMatchObject({ outcome: 'fail', rc: 1 });
  });

  test('a host that stays busy is unmeasured and nothing but git runs locally', async () => {
    const runner = fakeRunner({ ssh: BUSY });
    const result = await runTrainGateOnHost({ repo: '/r', commit: COMMIT, baseSha: BASE, changedFiles: ['src/a.ts'], settings }, runner, { observe: () => {}, sleep: async () => {} });
    expect(result.outcome).toBe('unmeasured');
    expect(result.reason).toContain('host-busy');
    expect(runner.calls.every((call) => call[0] === 'git')).toBe(true);
    for (const line of localText(runner)) for (const heavy of HEAVY) expect(line).not.toContain(heavy);
  });

  test('busy waits within slotWaitSeconds and retries', async () => {
    let n = 0;
    const base = fakeRunner();
    const runner: GateRemoteRunner = { ...base, ssh: (h, s, t) => (n++ === 0 ? BUSY : base.ssh(h, s, t)) };
    let clock = 0;
    const result = await runTrainGateOnHost({ repo: '/r', commit: COMMIT, baseSha: BASE, changedFiles: [], settings: { ...settings, slotWaitSeconds: 60 } }, runner,
      { observe: () => {}, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(result.outcome).toBe('pass');
    expect(n).toBe(2);
  });

  test('an infra failure is unmeasured with its reason', async () => {
    const result = await runTrainGateOnHost({ repo: '/r', commit: COMMIT, baseSha: BASE, changedFiles: [], settings },
      fakeRunner({ ssh: { rc: 97, stdout: '', stderr: '__GATE_REMOTE_INFRA=clone\n' } }), { observe: () => {} });
    expect(result).toEqual({ outcome: 'unmeasured', host: 'node-b', reason: 'remote-clone' });
  });
});

describe('trainGateScript', () => {
  test('steps chain with && and skip tests when no test file changed', () => {
    expect(trainGateScript(BASE, ['src/a.ts'])).toBe(`TSC_BASE_REF='${BASE}' bun scripts/ci-typecheck-changed.ts --local && bun scripts/ci-pwa-build-gate.ts --changed-files 'src/a.ts'`);
    expect(trainGateScript(BASE, ['x.test.ts', "q'.ts"])).toContain(`bun run test:deterministic 'x.test.ts' && bun scripts/ci-pwa-build-gate.ts --changed-files 'x.test.ts' 'q'\\''.ts'`);
  });
});

describe('runOnRemote explicit commit', () => {
  test('a dirty worktree with commit pushes that sha; without commit it stays dirty-tree', () => {
    const runner = fakeRunner({ dirty: true });
    const pinned = runOnRemote({ repo: '/r', host: 'node-b', mirror: '~/m.git', commit: COMMIT, argv: ['x'] }, runner);
    expect(pinned).not.toEqual({ kind: 'infra', reason: 'dirty-tree' });
    expect(pinned).toMatchObject({ kind: 'ran', commit: COMMIT });
    expect(runner.calls.find((call) => call[1] === 'push')!.join(' ')).toContain(COMMIT);
    expect(runOnRemote({ repo: '/r', host: 'node-b', mirror: '~/m.git', argv: ['x'] }, fakeRunner({ dirty: true }))).toEqual({ kind: 'infra', reason: 'dirty-tree' });
  });
});

describe('trainGateOnHost adapter', () => {
  test('diffs locally with git and returns the outcome', async () => {
    const runner = fakeRunner({ diff: 'M\0src/a.ts\0A\0src/a.test.ts\0' });
    const gate = trainGateOnHost({ repo: '/r', baseSha: BASE, settings }, runner, { observe: () => {} });
    expect(await gate(COMMIT, [1, 2])).toBe('pass');
    expect(runner.calls[0]).toEqual(['git', 'diff', '--name-status', '-z', BASE, COMMIT]);
    expect(runner.scripts[0]).toContain(`'src/a.test.ts'`);
  });
  test('a deleted test file reaches tsc/PWA but is never run as a test (review must-fix)', async () => {
    const runner = fakeRunner({ diff: 'D\0src/gone.test.ts\0M\0src/a.ts\0R100\0src/old.test.ts\0src/new.test.ts\0' });
    const gate = trainGateOnHost({ repo: '/r', baseSha: BASE, settings }, runner, { observe: () => {} });
    expect(await gate(COMMIT, [1])).toBe('pass');
    const script = runner.scripts[0]!;
    const testStep = script.split(' && ').find((step) => step.startsWith('bun run test:deterministic')) ?? '';
    expect(testStep).toContain(`'src/new.test.ts'`);
    expect(testStep).not.toContain('gone.test.ts');
    expect(testStep).not.toContain('old.test.ts');
    expect(script).toContain(`'src/gone.test.ts'`); // still in the PWA changed-file reach
  });
  test('a throwing local git is «unmeasured», not a rejected promise, and is observed (review must-fix)', async () => {
    const runner = fakeRunner({});
    runner.local = () => { throw new Error('spawn git ENOENT'); };
    const observed: unknown[] = [];
    const gate = trainGateOnHost({ repo: '/r', baseSha: BASE, settings }, runner, { observe: (entry) => { observed.push(entry); } });
    expect(await gate(COMMIT, [1])).toBe('unmeasured');
    expect(observed).toEqual([expect.objectContaining({ outcome: 'unmeasured', reason: expect.stringContaining('prepare-failed') })]);
  });
});

describe('gate host pin', () => {
  test('a configured host other than node-b is «unmeasured» and never runs remotely (review must-fix)', async () => {
    const runner = fakeRunner({});
    const result = await runTrainGateOnHost({ repo: '/r', commit: COMMIT, baseSha: BASE, changedFiles: ['src/a.ts'], settings: { ...settings, host: 'node-c' } }, runner, { observe: () => {} });
    expect(result.outcome).toBe('unmeasured');
    expect(result.reason).toContain('host-not-gate-host');
    expect(runner.scripts).toHaveLength(0);
  });
});
