import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { planEdgeRail, type EdgeRailInput } from './self-update-canary.js';
import { canaryRunSucceededInLedger, missingFixCommitTitles, runUpdateForInstallation, type SelfUpdateDeps } from './self-update.js';

const old = 'aaaaaaaaaaaa';
const next = 'bbbbbbbbbbbb';
const now = new Date('2026-10-06T04:00:00Z');
const base: EdgeRailInput = { now, mainCommit: next, installed: old, seat: 'OP', canary: null, failureRate: null, quietWindow: true };
const canary = { seat: 'OP', okRuns: 3, startedAt: now.toISOString() };

test('OP installs first, others hold; three OK runs promote; quiet window gates cutover', () => {
  expect(planEdgeRail(base).decision).toBe('canary-install');
  expect(planEdgeRail({ ...base, seat: 'TC' }).decision).toBe('hold');
  expect(planEdgeRail({ ...base, seat: 'TC', canary: { ...canary, okRuns: 2 } }).decision).toBe('hold');
  expect(planEdgeRail({ ...base, seat: 'TC', canary }).decision).toBe('promote-all');
  expect(planEdgeRail({ ...base, seat: 'TC', canary, promoted: true }).decision).toBe('hold');
  expect(planEdgeRail({ ...base, seat: 'TC', canary, canaryOkRuns: 4 }).decision).toBe('hold');
  expect(planEdgeRail({ ...base, quietWindow: false }).decision).toBe('wait-quiet');
  expect(planEdgeRail({ ...base, installed: next }).decision).toBe('hold');
  for (const input of [base, { ...base, seat: 'TC' }, { ...base, seat: 'TC', canary }, { ...base, quietWindow: false }]) expect(planEdgeRail(input).reason.length).toBeGreaterThan(0);
});

test('rising measured failure rate rolls back; insufficient samples and non-quiet restart hold', () => {
  const failed: EdgeRailInput = { ...base, installed: next, canary, failureRate: { before: 0.1, after: 0.2, samples: 30 } };
  expect(planEdgeRail(failed).decision).toBe('rollback');
  expect(planEdgeRail({ ...failed, failureRate: { before: 0, after: 0.1, samples: 30 } }).decision).toBe('rollback');
  expect(planEdgeRail({ ...failed, canary: null }).decision).toBe('hold');
  expect(planEdgeRail({ ...failed, failureRate: { before: 0.1, after: 0.19, samples: 30 } }).decision).toBe('hold');
  expect(planEdgeRail({ ...failed, failureRate: { before: 0.1, after: 0.2, samples: 29 } }).decision).toBe('hold');
  expect(planEdgeRail({ ...failed, quietWindow: false }).decision).toBe('wait-quiet');
  expect(planEdgeRail({ ...base, failureRate: { before: 0.1, after: 0.2, samples: 29 } }).decision).toBe('hold');
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'edge-rail-'));
  const stateDir = join(root, 'state');
  const checkout = resolve(import.meta.dir, '../..');
  const previous = '0.2.16-aaaaaaaaaaaa';
  const oldEntry = join(root, 'versions', previous, 'node_modules', 'elanous', 'bin');
  mkdirSync(oldEntry, { recursive: true });
  writeFileSync(join(oldEntry, 'elanous.mjs'), 'entry');
  symlinkSync(`versions/${previous}`, join(root, 'current'));
  writeFileSync(join(root, 'install.json'), JSON.stringify({ version: '0.2.16', versionDir: `versions/${previous}`, commit: old, source: checkout }));
  const calls: string[] = [];
  const lines: string[] = [];
  let fail = false;
  // 실제 런 원장 형식(start ⊕ run-status) — 캐너리 시작(now) 뒤 completed 만 성공 런이다.
  const ledgerDir = join(root, 'run-ledger');
  mkdirSync(ledgerDir, { recursive: true });
  const ledger = (runId: string, startedAt: Date, runStatus: string) => writeFileSync(join(ledgerDir, `${runId}.jsonl`),
    `${JSON.stringify({ runId, event: 'start', timestamp: startedAt.toISOString(), data: {} })}\n${JSON.stringify({ runId, event: 'run-status', timestamp: startedAt.toISOString(), data: { runStatus } })}\n`);
  const after = new Date(now.getTime() + 1_000);
  for (const id of ['run-1', 'run-2', 'run-3', 'run-a', 'run-b', 'failed-run']) ledger(id, after, 'completed');
  ledger('old-run', new Date(now.getTime() - 60_000), 'completed');
  ledger('bad-run', after, 'failed');
  const deps: SelfUpdateDeps = {
    cliRoot: checkout, installRoot: root, stateDir, now: () => now, edgeRailConfig: () => ({}),
    out: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    git: (_cwd, args) => {
      calls.push(`git ${args.join(' ')}`);
      if (args[0] === 'rev-parse' && args.includes('main')) return { status: 0, stdout: next, stderr: '' };
      if (args.includes('--show-toplevel')) return { status: 0, stdout: `${checkout}\n`, stderr: '' };
      if (args.includes('HEAD')) return { status: 0, stdout: next, stderr: '' };
      if (args[0] === 'log') return { status: 0, stdout: 'fix: first repair\nfeat: unrelated\nfix(cli): second repair\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    run: (cmd, args) => {
      calls.push(cmd);
      if (cmd !== 'bash') throw new Error(`unexpected command ${cmd}`);
      expect(args).toContain('--prefix');
      expect(args).toContain(root);
      const name = `0.2.17-dev.${next}`;
      const entry = join(root, 'versions', name, 'node_modules', 'elanous', 'bin');
      mkdirSync(entry, { recursive: true });
      if (!fail) writeFileSync(join(entry, 'elanous.mjs'), 'entry');
      rmSync(join(root, 'current'));
      symlinkSync(`versions/${name}`, join(root, 'current'));
      if (fail) return { status: 1, stderr: 'injected after current moved' };
      writeFileSync(join(root, 'install.json'), JSON.stringify({ version: '0.2.17', versionDir: `versions/${name}`, commit: next, source: checkout }));
      return { status: 0, stderr: '' };
    },
    packageVersion: () => '0.2.17', allowLiveRestart: false, restartEdgeRail: async () => { calls.push('restart'); return true; },
    verifyRestart: async (commit) => ({ ok: true, daemonSha: commit }),
    canaryRunSucceeded: (runId, since) => canaryRunSucceededInLedger(runId, since, ledgerDir),
    notice: () => { throw new Error('no notices'); },
  };
  return { root, stateDir, deps, calls, lines, setFail: () => { fail = true; }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('--from --auto --dry-run only plans; live OP installs through checked installer and persists state', async () => {
  const f = setup();
  try {
    const opts = { auto: true, seat: 'OP', quietWindow: true };
    const dry = await runUpdateForInstallation({ ...opts, dryRun: true }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(dry.edgeRail?.decision).toBe('canary-install');
    expect(f.calls.every((c) => c.startsWith('git '))).toBe(true);
    expect(existsSync(f.stateDir)).toBe(false);
    expect(readlinkSync(join(f.root, 'current'))).toBe('versions/0.2.16-aaaaaaaaaaaa');
    expect(f.lines).toHaveLength(1);
    const live = await runUpdateForInstallation(opts, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(live).toMatchObject({ exitCode: 0, edgeRail: { decision: 'canary-install' }, current: `versions/0.2.17-dev.${next}` });
    expect(f.calls.filter((c) => c === 'bash')).toHaveLength(1);
    expect(f.calls).toContain('restart');
    expect(f.calls.some((c) => c === 'systemctl' || c === 'launchctl')).toBe(false);
    expect(readlinkSync(join(f.root, 'current'))).toBe(`versions/0.2.17-dev.${next}`);
    expect(existsSync(join(f.root, 'current', 'node_modules', 'elanous', 'bin', 'elanous.mjs'))).toBe(true);
    expect(JSON.parse(readFileSync(join(f.stateDir, 'self-update-edge-rail.json'), 'utf8')).canary).toEqual({ seat: 'OP', okRuns: 0, startedAt: now.toISOString() });
    expect(f.lines.at(-1)).toContain('main 엔 있고 운영엔 없는 수리: fix: first repair · fix(cli): second repair');
  } finally { f.cleanup(); }
});

test('reported successful install without a verified entry is refused and restored', async () => {
  const f = setup();
  try {
    f.deps.installEdgeRail = async () => ({ exitCode: 0, installedVersion: 'missing', decision: null, restarted: false, reason: 'fake success' });
    const result = await runUpdateForInstallation({ auto: true, seat: 'OP', quietWindow: true }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain('installed entry/commit not confirmed');
    expect(readlinkSync(join(f.root, 'current'))).toBe('versions/0.2.16-aaaaaaaaaaaa');
    expect(f.calls).not.toContain('restart');
  } finally { f.cleanup(); }
});

test('failed restart restores previous build through rollbackDevInstall, without claiming canary success', async () => {
  const f = setup();
  try {
    f.deps.restartEdgeRail = async () => false;
    const result = await runUpdateForInstallation({ auto: true, from: f.deps.cliRoot, seat: 'OP', quietWindow: true }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain('previous build restored');
    expect(readlinkSync(join(f.root, 'current'))).toBe('versions/0.2.16-aaaaaaaaaaaa');
    const state = JSON.parse(readFileSync(join(f.stateDir, 'self-update-edge-rail.json'), 'utf8'));
    expect(state).toMatchObject({ rolledBack: true, canary: { okRuns: 0 } });
    f.deps.restartEdgeRail = async () => true;
    const again = await runUpdateForInstallation({ auto: true, from: f.deps.cliRoot, seat: 'OP', quietWindow: true }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(again.edgeRail?.decision).toBe('hold');
    expect(f.calls.filter((call) => call === 'bash')).toHaveLength(1);
  } finally { f.cleanup(); }
});

test('installer failure after moving current restores entry and install metadata; no canary state', async () => {
  const f = setup();
  f.setFail();
  try {
    const result = await runUpdateForInstallation({ auto: true, from: f.deps.cliRoot, seat: 'OP', quietWindow: true }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(result.exitCode).toBe(1);
    expect(readlinkSync(join(f.root, 'current'))).toBe('versions/0.2.16-aaaaaaaaaaaa');
    expect(JSON.parse(readFileSync(join(f.root, 'install.json'), 'utf8')).commit).toBe(old);
    expect(existsSync(f.stateDir)).toBe(false);
  } finally { f.cleanup(); }
});

test('measured rise invokes rollbackDevInstall and never the installer; insufficient samples hold', async () => {
  const f = setup();
  try {
    const newName = `0.2.17-dev.${next}`;
    const entry = join(f.root, 'versions', newName, 'node_modules', 'elanous', 'bin');
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'elanous.mjs'), 'entry');
    rmSync(join(f.root, 'current'));
    symlinkSync(`versions/${newName}`, join(f.root, 'current'));
    writeFileSync(join(f.root, 'install.json'), JSON.stringify({ version: '0.2.17', versionDir: `versions/${newName}`, commit: next, previous: 'versions/0.2.16-aaaaaaaaaaaa', channel: 'dev' }));
    mkdirSync(f.stateDir, { recursive: true });
    writeFileSync(join(f.stateDir, 'self-update-edge-rail.json'), JSON.stringify({ mainCommit: next, canary: { seat: 'OP', okRuns: 1, startedAt: now.toISOString() } }));
    const opts = { auto: true, from: f.deps.cliRoot, seat: 'OP', quietWindow: true, failureRate: { before: 0.1, after: 0.2, samples: 30 } };
    const hold = await runUpdateForInstallation({ ...opts, failureRate: { ...opts.failureRate, samples: 29 } }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(hold.edgeRail?.decision).toBe('hold');
    expect(readlinkSync(join(f.root, 'current'))).toBe(`versions/${newName}`);
    const result = await runUpdateForInstallation(opts, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(result.edgeRail?.decision).toBe('rollback');
    expect(result.exitCode).toBe(0);
    expect(result.autoRollback).toBe('active');
    expect(f.calls).toContain('restart');
    expect(readlinkSync(join(f.root, 'current'))).toBe('versions/0.2.16-aaaaaaaaaaaa');
    expect(f.calls.includes('bash')).toBe(false);
  } finally { f.cleanup(); }
});

test('stray edgeRail config keys cannot override the decision inputs', async () => {
  const f = setup();
  try {
    f.deps.edgeRailConfig = () => ({ seat: 'TC', quietWindow: true, canary: { seat: 'OP', okRuns: 99, startedAt: now.toISOString() } } as never);
    const result = await runUpdateForInstallation({ auto: true, from: f.deps.cliRoot, seat: 'OP', dryRun: true }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(result.edgeRail?.decision).toBe('wait-quiet');
  } finally { f.cleanup(); }
});

test('a rolled-back main stays held even with OK canary runs; no reinstall or promotion', async () => {
  const f = setup();
  try {
    const newName = `0.2.17-dev.${next}`;
    const entry = join(f.root, 'versions', newName, 'node_modules', 'elanous', 'bin');
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'elanous.mjs'), 'entry');
    rmSync(join(f.root, 'current'));
    symlinkSync(`versions/${newName}`, join(f.root, 'current'));
    writeFileSync(join(f.root, 'install.json'), JSON.stringify({ version: '0.2.17', versionDir: `versions/${newName}`, commit: next, previous: 'versions/0.2.16-aaaaaaaaaaaa', channel: 'dev', source: f.deps.cliRoot }));
    const state = join(f.stateDir, 'self-update-edge-rail.json');
    mkdirSync(f.stateDir, { recursive: true });
    writeFileSync(state, JSON.stringify({ mainCommit: next, canary: { seat: 'OP', okRuns: 3, startedAt: now.toISOString() } }));
    const opts = { auto: true, from: f.deps.cliRoot, seat: 'OP', quietWindow: true };
    const rolled = await runUpdateForInstallation({ ...opts, failureRate: { before: 0.1, after: 0.2, samples: 30 } }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(rolled.edgeRail?.decision).toBe('rollback');
    expect(JSON.parse(readFileSync(state, 'utf8'))).toMatchObject({ rolledBack: true, promoted: false });
    for (const seat of ['OP', 'TC']) {
      const after = await runUpdateForInstallation({ ...opts, seat }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
      expect(after.edgeRail?.decision).toBe('hold');
      expect(after.edgeRail?.reason).toContain('rolled back');
    }
    expect(f.calls.includes('bash')).toBe(false);
    expect(readlinkSync(join(f.root, 'current'))).toBe('versions/0.2.16-aaaaaaaaaaaa');
  } finally { f.cleanup(); }
});

test('canary counts only runs that started after the canary and completed in the ledger, each id once', async () => {
  const f = setup();
  let tick = 0;
  try {
    const state = join(f.stateDir, 'self-update-edge-rail.json');
    mkdirSync(f.stateDir, { recursive: true });
    writeFileSync(state, JSON.stringify({ mainCommit: next, canary: { seat: 'OP', okRuns: 0, startedAt: now.toISOString() } }));
    const installed = JSON.parse(readFileSync(join(f.root, 'install.json'), 'utf8'));
    writeFileSync(join(f.root, 'install.json'), JSON.stringify({ ...installed, commit: next }));
    f.deps.now = () => new Date(now.getTime() + ++tick * 60_000);
    const opts = { from: f.deps.cliRoot, auto: true, seat: 'OP', quietWindow: true };
    for (const id of ['ghost-1', 'run-a', 'old-run', 'run-b', 'run-a', 'bad-run', 'ghost-2', 'run-b']) await runUpdateForInstallation({ ...opts, canaryRunId: id }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(JSON.parse(readFileSync(state, 'utf8')).canary.okRuns).toBe(2);
    expect(JSON.parse(readFileSync(state, 'utf8')).countedRunIds).toEqual(['run-a', 'run-b']);
  } finally { f.cleanup(); }
});

test('missing or dirty main and a missing installed identity refuse execution before installer', async () => {
  const f = setup();
  try {
    const opts = { from: f.deps.cliRoot, auto: true, seat: 'OP', quietWindow: true };
    const git = f.deps.git!;
    f.deps.git = (cwd, args) => args[0] === 'diff' ? { status: 1, stdout: '', stderr: '' } : git(cwd, args);
    const dirty = await runUpdateForInstallation(opts, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(dirty).toMatchObject({ exitCode: 2, restarted: false });
    expect(f.calls).not.toContain('bash');
    f.deps.git = git;
    writeFileSync(join(f.root, 'install.json'), JSON.stringify({ version: '0.2.16' }));
    const unknown = await runUpdateForInstallation(opts, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(unknown.exitCode).toBe(2);
    expect(f.calls).not.toContain('bash');
  } finally { f.cleanup(); }
});

test('OP health-confirmed runs persist once per observation; three runs unlock fleet promotion', async () => {
  const f = setup();
  let tick = 0;
  try {
    const state = join(f.stateDir, 'self-update-edge-rail.json');
    mkdirSync(f.stateDir, { recursive: true });
    writeFileSync(state, JSON.stringify({ mainCommit: next, canary: { seat: 'OP', okRuns: 0, startedAt: now.toISOString() } }));
    const installed = JSON.parse(readFileSync(join(f.root, 'install.json'), 'utf8'));
    writeFileSync(join(f.root, 'install.json'), JSON.stringify({ ...installed, commit: next }));
    f.deps.now = () => new Date(now.getTime() + ++tick * 60_000);
    const opts = { from: f.deps.cliRoot, auto: true, seat: 'OP', quietWindow: true };
    const unproven = await runUpdateForInstallation(opts, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(unproven.edgeRail?.decision).toBe('hold');
    expect(unproven.autoRollback).toBe('inactive-no-failure-rate');
    expect(f.lines.at(-1)).toContain('자동 되돌림 비활성');
    expect(JSON.parse(readFileSync(state, 'utf8')).canary.okRuns).toBe(0);
    for (let i = 1; i <= 3; i++) {
      const result = await runUpdateForInstallation({ ...opts, canaryRunId: `run-${i}` }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
      expect(result.edgeRail?.decision).toBe('hold');
      expect(JSON.parse(readFileSync(state, 'utf8')).canary.okRuns).toBe(i);
    }
    await runUpdateForInstallation({ ...opts, canaryRunId: 'run-3' }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(JSON.parse(readFileSync(state, 'utf8')).canary.okRuns).toBe(3);
    writeFileSync(join(f.root, 'install.json'), JSON.stringify(installed));
    const promoted = await runUpdateForInstallation({ ...opts, seat: 'TC' }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(promoted.edgeRail?.decision).toBe('promote-all');
    expect(f.calls.filter((call) => call === 'bash')).toHaveLength(1);
    expect(JSON.parse(readFileSync(state, 'utf8')).canary.okRuns).toBe(3);
    expect(JSON.parse(readFileSync(state, 'utf8')).promoted).toBe(true);
    const again = await runUpdateForInstallation({ ...opts, seat: 'TC' }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(again.edgeRail?.decision).toBe('hold');
    expect(f.calls.filter((call) => call === 'bash')).toHaveLength(1);
  } finally { f.cleanup(); }
});

test('rollback dry-run leaves the installed version and state untouched', async () => {
  const f = setup();
  try {
    mkdirSync(f.stateDir, { recursive: true });
    const state = join(f.stateDir, 'self-update-edge-rail.json');
    writeFileSync(state, JSON.stringify({ mainCommit: next, canary: { seat: 'OP', okRuns: 1, startedAt: now.toISOString() } }));
    const name = `0.2.17-dev.${next}`;
    mkdirSync(join(f.root, 'versions', name, 'node_modules', 'elanous', 'bin'), { recursive: true });
    writeFileSync(join(f.root, 'versions', name, 'node_modules', 'elanous', 'bin', 'elanous.mjs'), 'entry');
    rmSync(join(f.root, 'current'));
    symlinkSync(`versions/${name}`, join(f.root, 'current'));
    writeFileSync(join(f.root, 'install.json'), JSON.stringify({ version: '0.2.17', versionDir: `versions/${name}`, commit: next, previous: 'versions/0.2.16-aaaaaaaaaaaa' }));
    const before = readFileSync(state, 'utf8');
    const result = await runUpdateForInstallation({ auto: true, dryRun: true, from: f.deps.cliRoot, seat: 'OP', quietWindow: true, failureRate: { before: 0.1, after: 0.2, samples: 30 } }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(result.edgeRail?.decision).toBe('rollback');
    expect(readlinkSync(join(f.root, 'current'))).toBe(`versions/${name}`);
    expect(readFileSync(state, 'utf8')).toBe(before);
    expect(f.calls).not.toContain('bash');
    expect(f.calls).not.toContain('restart');
  } finally { f.cleanup(); }
});

test('no observed healthy daemon does not increment canary, and dry-run never probes health', async () => {
  const f = setup();
  try {
    mkdirSync(f.stateDir, { recursive: true });
    const path = join(f.stateDir, 'self-update-edge-rail.json');
    writeFileSync(path, JSON.stringify({ mainCommit: next, canary: { seat: 'OP', okRuns: 0, startedAt: now.toISOString() } }));
    const installed = JSON.parse(readFileSync(join(f.root, 'install.json'), 'utf8'));
    writeFileSync(join(f.root, 'install.json'), JSON.stringify({ ...installed, commit: next }));
    f.deps.verifyRestart = async () => ({ ok: false, unmeasured: true });
    const opts = { from: f.deps.cliRoot, auto: true, seat: 'OP', quietWindow: true };
    const before = readFileSync(path, 'utf8');
    await runUpdateForInstallation({ ...opts, canaryRunId: 'failed-run' }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(readFileSync(path, 'utf8')).toBe(before);
    f.deps.verifyRestart = async () => { throw new Error('dry-run must not probe health'); };
    await runUpdateForInstallation({ ...opts, canaryRunId: 'run-1', dryRun: true }, { cliRoot: f.deps.cliRoot, checkout: f.deps });
    expect(readFileSync(path, 'utf8')).toBe(before);
  } finally { f.cleanup(); }
});

test('fix titles are a single output-only line; git failure leaves them unknown', () => {
  const f = setup();
  try {
    expect(missingFixCommitTitles(f.deps.cliRoot!, old, next, f.deps.git!)).toBe('main 엔 있고 운영엔 없는 수리: fix: first repair · fix(cli): second repair');
    expect(missingFixCommitTitles(f.deps.cliRoot!, old, next, () => ({ status: 1, stdout: '', stderr: 'bad' }))).toContain('판정 불가');
  } finally { f.cleanup(); }
});
