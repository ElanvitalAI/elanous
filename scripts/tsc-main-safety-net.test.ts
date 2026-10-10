import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSafetyNet, type SafetyNetDeps, type SafetyNetEntry } from './tsc-main-safety-net.js';
import type { RemoteRunOutcome } from '../src/self-implement/gate-remote.js';

const sha = 'a'.repeat(40);
const a = { file: 'src/a.ts', code: 'TS2322', message: 'old' };
const b = { file: 'test/b.test.ts', code: 'TS2339', message: 'new' };
const lineA = 'src/a.ts(1,3): error TS2322: old';
const lineB = 'test/b.test.ts(3,4): error TS2339: new';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(remoteResult: RemoteRunOutcome, worktreeExists = false) {
  const root = mkdtempSync(join(tmpdir(), 'tsc-safety-net-test-'));
  dirs.push(root);
  const ledger = join(root, 'ledger.jsonl');
  const gitCalls: string[] = [];
  const localTsc: string[] = [];
  const remoteCalls: unknown[] = [];
  const observations: unknown[] = [];
  const worktree = join(root, 'tsc-safety-net', 'worktree');
  const deps: SafetyNetDeps = {
    instanceRoot: () => root,
    settings: () => ({ enabled: true, host: 'configured-node-b', loadThreshold: 20, hostCap: 2, mirror: '~/mirror/elanous-agent.git', slotWaitSeconds: 0 }),
    exists: (path) => path === worktree ? worktreeExists : path === join(worktree, 'node_modules'),
    now: () => 1_700_000_000_000,
    observed: (data) => { observations.push(data); },
    local: (cmd, args, cwd, options) => {
      if (cmd !== 'git') {
        localTsc.push([cmd, ...args, cwd, options?.env?.NODE_OPTIONS ?? ''].join(' '));
        return { rc: 0, stdout: '', stderr: '' };
      }
      gitCalls.push(`${args.join(' ')} @ ${cwd}`);
      if (args[0] === 'rev-parse') return { rc: 0, stdout: `${sha}\n`, stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { rc: 0, stdout: `worktree ${worktree}\n`, stderr: '' };
      if (args[0] === 'status') return { rc: 0, stdout: worktreeExists && gitCalls.filter((call) => call.startsWith('status')).length === 1 ? ' M src/a.ts\n' : '', stderr: '' };
      return { rc: 0, stdout: '', stderr: '' };
    },
    remote: (options) => { remoteCalls.push(options); return remoteResult; },
  };
  return { root, ledger, worktree, deps, gitCalls, localTsc, remoteCalls, observations,
    rows: () => readFileSync(ledger, 'utf8').trim().split('\n').map((row) => JSON.parse(row) as SafetyNetEntry),
    seed: (diagnostics: typeof a[]) => writeFileSync(ledger, `${JSON.stringify({ outcome: 'baseline', diagnostics })}\n`),
  };
}

const ran = (lines: string, rc = 2): RemoteRunOutcome => ({ kind: 'ran', rc, stdout: Buffer.from(lines), stderr: Buffer.alloc(0), commit: sha, host: 'configured-node-b', ms: 10 });

test('first complete run records a baseline rather than declaring all inherited diagnostics new; full gate config is sent to node-b', async () => {
  const f = fixture(ran(lineA));
  const result = await runSafetyNet('/repo', ['--ledger', f.ledger, '--json'], f.deps);
  expect(result.exitCode).toBe(0);
  expect(result.entry).toMatchObject({ outcome: 'baseline', total: 1, added: [], diagnostics: [a], host: 'configured-node-b' });
  expect(f.remoteCalls).toEqual([expect.objectContaining({ repo: f.worktree, host: 'configured-node-b', argv: ['bunx', 'tsc', '--noEmit', '-p', 'tsconfig.gate.json', '--incremental', 'false'] })]);
  expect(f.gitCalls).toContain('fetch origin +refs/heads/main:refs/remotes/origin/main @ /repo');
  expect(f.gitCalls).toContain(`worktree add --detach ${f.worktree} ${sha} @ /repo`);
  expect(f.gitCalls).toContain(`checkout --detach origin/main @ ${f.worktree}`);
  expect(f.observations).toEqual([{ commit: sha, outcome: 'baseline', total: 1, added: 0, removed: 0, ms: 0, host: 'configured-node-b' }]);
  expect(f.rows()).toEqual([result.entry]);
});

test('only diagnostic B is added relative to the last measured A; A alone stays clean', async () => {
  const f = fixture(ran(`${lineA}\n${lineB}`), true);
  f.seed([a]);
  const result = await runSafetyNet('/repo', ['--ledger', f.ledger], f.deps);
  expect(result.exitCode).toBe(1);
  expect(f.rows().at(-1)).toMatchObject({ outcome: 'added', total: 2, added: [b], removed: 0, diagnostics: [a, b] });
  expect(f.gitCalls).toContain(`reset --hard @ ${f.worktree}`);
  expect(f.gitCalls).toContain(`clean -fdx -e node_modules @ ${f.worktree}`);
  expect(f.observations.at(-1)).toMatchObject({ outcome: 'added', added: 1 });
  const clean = fixture(ran(`src/a.ts(99,99): error TS2322: old`));
  clean.seed([a]);
  const cleanResult = await runSafetyNet('/repo', ['--ledger', clean.ledger], clean.deps);
  expect(cleanResult.exitCode).toBe(0);
  expect(clean.rows().at(-1)).toMatchObject({ outcome: 'clean', added: [], removed: 0 });
});

test('a reused worktree is cleaned even when porcelain status is empty (ignored stale TypeScript)', async () => {
  const f = fixture(ran(lineA), true);
  const stale = join(f.worktree, 'src', 'ignored-stale.ts');
  mkdirSync(join(f.worktree, 'src'), { recursive: true });
  writeFileSync(stale, 'invalid TypeScript left by an earlier run');
  f.deps.local = (cmd, args, cwd) => {
    if (cmd !== 'git') throw new Error(`unexpected local command: ${cmd}`);
    f.gitCalls.push(`${args.join(' ')} @ ${cwd}`);
    if (args[0] === 'rev-parse') return { rc: 0, stdout: `${sha}\n`, stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'list') return { rc: 0, stdout: `worktree ${f.worktree}\n`, stderr: '' };
    if (args[0] === 'clean') rmSync(stale);
    return { rc: 0, stdout: '', stderr: '' }; // git status --porcelain does not report ignored files
  };
  f.deps.remote = (options) => {
    expect(existsSync(stale)).toBe(false);
    f.remoteCalls.push(options);
    return ran(lineA);
  };
  const result = await runSafetyNet('/repo', ['--ledger', f.ledger], f.deps);
  expect(result.exitCode).toBe(0);
  expect(f.gitCalls).toContain(`clean -fdx -e node_modules @ ${f.worktree}`);
  expect(f.remoteCalls).toHaveLength(1);
});

test('explicit remote host overrides settings; a successful zero-diagnostic run is measured clean', async () => {
  const f = fixture(ran('', 0));
  f.seed([a]);
  const result = await runSafetyNet('/repo', ['--remote', 'msb2', '--ledger', f.ledger], f.deps);
  expect(result.exitCode).toBe(0);
  expect(f.rows().at(-1)).toMatchObject({ outcome: 'clean', total: 0, removed: 1, host: 'msb2', diagnostics: [] });
  expect(f.remoteCalls).toEqual([expect.objectContaining({ host: 'msb2' })]);
});

test('a removed diagnostic is informational, and the full latest measured snapshot is the next baseline', async () => {
  const f = fixture(ran(lineA));
  f.seed([a, b]);
  const result = await runSafetyNet('/repo', ['--ledger', f.ledger], f.deps);
  expect(result.exitCode).toBe(0);
  expect(f.rows().at(-1)).toMatchObject({ outcome: 'clean', removed: 1, diagnostics: [a] });
});

test('busy and infra never fall back to local tsc and cannot become a measured baseline', async () => {
  for (const outcome of [{ kind: 'busy' } as const, { kind: 'infra', reason: 'ssh-unavailable' } as const]) {
    const f = fixture(outcome);
    f.seed([a]);
    const result = await runSafetyNet('/repo', ['--ledger', f.ledger], f.deps);
    expect(result.exitCode).toBe(2);
    expect(f.rows().at(-1)).toMatchObject({ outcome: 'unmeasured', added: [] });
    expect(f.rows()[0]?.diagnostics).toEqual([a]);
    expect(f.localTsc).toEqual([]);
  }
});

test('TS2688/TS5083/TS6053 with rc 1 are unmeasured and do not replace the last measured diagnostics', async () => {
  for (const message of [
    "error TS2688: Cannot find type definition file for 'bun-types'",
    "error TS5083: Cannot read file 'tsconfig.gate.json'",
    "error TS6053: File 'missing.ts' not found",
  ]) {
    const f = fixture(ran(message, 1));
    f.seed([a]);
    const result = await runSafetyNet('/repo', ['--ledger', f.ledger], f.deps);
    expect(result.exitCode).toBe(2);
    expect(f.rows().at(-1)?.outcome).toBe('unmeasured');
    expect(f.rows().at(-1)?.diagnostics).toBeUndefined();
    expect(f.rows()[0]?.diagnostics).toEqual([a]);
  }
});

test('an unmeasured row never becomes the next baseline: a later A+B run still adds only B', async () => {
  const f = fixture(ran(`${lineA}\n${lineB}`));
  f.seed([a]);
  writeFileSync(f.ledger, `${readFileSync(f.ledger, 'utf8')}${JSON.stringify({ outcome: 'unmeasured', diagnostics: undefined, total: 0 })}\n`);
  const result = await runSafetyNet('/repo', ['--ledger', f.ledger], f.deps);
  expect(result.exitCode).toBe(1);
  expect(f.rows().at(-1)).toMatchObject({ outcome: 'added', added: [b] });
});

test('unavailable comparison records unmeasured without promoting the current diagnostics to the next baseline', async () => {
  const f = fixture(ran(`${lineA}\n${lineB}`));
  f.seed([a]);
  f.deps.compare = (mine, previous) => {
    expect(mine).toEqual([a, b]);
    expect(previous).toEqual([a]);
    return { kind: 'unavailable', reason: 'comparison interrupted' };
  };
  const unavailable = await runSafetyNet('/repo', ['--ledger', f.ledger], f.deps);
  expect(unavailable.exitCode).toBe(2);
  expect(f.rows().at(-1)).toMatchObject({ outcome: 'unmeasured', total: 2, added: [], removed: 0 });
  expect(f.rows().at(-1)?.diagnostics).toBeUndefined();
  expect(f.rows()[0]?.diagnostics).toEqual([a]);
  expect(f.observations.at(-1)).toMatchObject({ outcome: 'unmeasured', added: 0 });

  f.deps.compare = undefined;
  const measured = await runSafetyNet('/repo', ['--ledger', f.ledger], f.deps);
  expect(measured.exitCode).toBe(1);
  expect(f.rows().at(-1)).toMatchObject({ outcome: 'added', added: [b], diagnostics: [a, b] });
});

test('a failed git fetch records unmeasured without invoking remote or local tsc', async () => {
  const f = fixture(ran(lineA));
  f.deps.local = (cmd, args) => {
    f.gitCalls.push(`${cmd} ${args.join(' ')}`);
    return { rc: 128, stdout: '', stderr: 'fetch unavailable' };
  };
  const result = await runSafetyNet('/repo', ['--ledger', f.ledger], f.deps);
  expect(result.exitCode).toBe(2);
  expect(f.rows().at(-1)?.outcome).toBe('unmeasured');
  expect(f.remoteCalls).toEqual([]);
  expect(f.localTsc).toEqual([]);
});

test('missing rc, unparseable errors, OOM after a partial diagnostic, and nonzero rc with zero diagnostics cannot manufacture a clean run', async () => {
  for (const output of [ran('', 1), ran('error TS9999: unsupported', 2), ran(`${lineA}\nFATAL ERROR: heap out of memory`, 2), { kind: 'infra', reason: 'rc-unparsed' } as const]) {
    const f = fixture(output);
    const result = await runSafetyNet('/repo', ['--ledger', f.ledger], f.deps);
    expect(result.exitCode).toBe(2);
    expect(result.entry.outcome).toBe('unmeasured');
  }
});

test('--local reconciles retained node_modules to the checked-out lockfile before tsc', async () => {
  const f = fixture({ kind: 'busy' }, true);
  let installed = false;
  f.deps.local = (cmd, args, cwd, options) => {
    if (cmd === 'git') {
      f.gitCalls.push(`${args.join(' ')} @ ${cwd}`);
      if (args[0] === 'rev-parse') return { rc: 0, stdout: `${sha}\n`, stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { rc: 0, stdout: `worktree ${f.worktree}\n`, stderr: '' };
      return { rc: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'bun' && args.join(' ') === 'install --frozen-lockfile') {
      installed = true;
      return { rc: 0, stdout: '', stderr: '' };
    }
    expect(installed).toBe(true);
    f.localTsc.push([cmd, ...args, cwd, options?.env?.NODE_OPTIONS ?? ''].join(' '));
    return { rc: 0, stdout: '', stderr: '' };
  };
  const result = await runSafetyNet('/repo', ['--local', '--ledger', f.ledger], f.deps);
  expect(result.exitCode).toBe(0);
  expect(installed).toBe(true);
  expect(f.localTsc).toHaveLength(1);
});

test('--local failed lockfile reconciliation does not run tsc or append a ledger row', async () => {
  const f = fixture({ kind: 'busy' }, true);
  f.seed([a]);
  const before = readFileSync(f.ledger, 'utf8');
  f.deps.local = (cmd, args) => {
    if (cmd === 'git') {
      if (args[0] === 'rev-parse') return { rc: 0, stdout: `${sha}\n`, stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { rc: 0, stdout: `worktree ${f.worktree}\n`, stderr: '' };
      return { rc: 0, stdout: '', stderr: '' };
    }
    expect([cmd, ...args]).toEqual(['bun', 'install', '--frozen-lockfile']);
    return { rc: 1, stdout: '', stderr: 'lockfile mismatch' };
  };
  const result = await runSafetyNet('/repo', ['--local', '--ledger', f.ledger], f.deps);
  expect(result.exitCode).toBe(2);
  expect(result.entry.outcome).toBe('unmeasured');
  expect(readFileSync(f.ledger, 'utf8')).toBe(before);
  expect(f.remoteCalls).toEqual([]);
});

test('--local runs the same non-incremental gate with tscEnv, never invokes remote; bad flags fail closed', async () => {
  const f = fixture({ kind: 'busy' });
  const result = await runSafetyNet('/repo', ['--local', '--ledger', f.ledger], f.deps);
  expect(result.exitCode).toBe(0);
  expect(f.localTsc).toEqual([
    expect.stringContaining('bun install --frozen-lockfile'),
    expect.stringContaining('bunx tsc --noEmit -p tsconfig.gate.json --incremental false'),
  ]);
  expect(f.localTsc[1]).toContain('--max-old-space-size=20480');
  expect(f.gitCalls).toContain(`checkout --detach origin/main @ ${f.worktree}`);
  expect(f.remoteCalls).toEqual([]);
  expect(result.entry.host).toBe('local');
  await expect(runSafetyNet('/repo', ['--local', '--remote', 'node-b'], f.deps)).rejects.toThrow('cannot be combined');
  await expect(runSafetyNet('/repo', ['--remote', 'bad host'], f.deps)).rejects.toThrow('invalid --remote host');
});
