import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetEffectiveInstanceRoot } from '../instance/resolve.js';
import { runPrLand as realRunPrLand, type PrLandDeps, type PrLandOpts } from './pr-cli.js';

// LAND-BASE-MAIN-GUARD: 10-11 #26022 was squash-merged into bench/base-night-* because the base was read only AFTER the merge.
let freezeRoot = '';
let stateDir = '';
let savedStateDir: string | undefined;
beforeEach(() => {
  freezeRoot = mkdtempSync(join(tmpdir(), 'pr-base-guard-freeze-'));
  stateDir = mkdtempSync(join(tmpdir(), 'pr-base-guard-state-'));
  savedStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = stateDir;
  resetEffectiveInstanceRoot();
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = savedStateDir;
  resetEffectiveInstanceRoot();
  rmSync(freezeRoot, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

const PR_URL = 'https://github.com/example/repo/pull/26022';

function land(prBase: string, opts: PrLandOpts = {}) {
  const lines: string[] = [];
  let merges = 0;
  const deps: PrLandDeps = {
    prodFreezeRoot: freezeRoot,
    currentBranch: () => 'feat/guard',
    resolveBase: (_run, _cwd, explicit) => explicit ?? 'origin/main',
    run: (command, args) => {
      if (command === 'git' && args[0] === 'remote') return { ok: true, out: args[1] === 'get-url' ? 'https://github.com/example/repo.git' : 'origin' };
      if (command === 'git' && args[0] === 'rev-parse') return { ok: true, out: args[1] === 'HEAD' ? 'a'.repeat(40) : '/tmp/guard-test' };
      if (command === 'git' && args[0] === 'diff' && args[1] === '--name-only') return { ok: true, out: 'src/cli/x.ts\n' };
      if (command === 'gh' && args.includes('baseRefName')) return { ok: true, out: `${prBase}\n` };
      return { ok: true, out: '' };
    },
    listUnfinishedRuns: () => [],
    queryRunningRuns: () => { throw new Error('observation unavailable'); },
    runTypecheckGate: () => true,
    runIsolationGate: () => true,
    runMockModuleRestoreGate: () => true,
    runModelHardcodeGate: () => true,
    runDaemonPortGate: () => true,
    runPublicLeakGate: () => 0,
    runExportLeakCheck: () => ({ measured: true, hits: [] }),
    runTestInterferenceGate: async () => 0,
    runLandGlobalChecks: () => true,
    runAndroidGate: () => true,
    runPwaGate: () => true,
    runIosGate: () => true,
    listOpenPrs: () => [],
    out: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    manager: {
      findPrForBranchOutcome: () => ({ status: 'NOT_FOUND' }),
      upsertPr: () => ({ ok: true, url: PR_URL, reused: true }),
      mergePrOutcome: () => { merges++; return { ok: true, kind: 'merged' }; },
    } as unknown as PrLandDeps['manager'],
  };
  return realRunPrLand({ body: 'Human-requested atomic PR landing.', ...opts }, deps).then((code) => ({ code, lines, merges: () => merges }));
}

test('a reused PR whose base is not main is refused before any merge call (exit 1)', async () => {
  const result = await land('bench/x');
  expect(result.code).toBe(1);
  expect(result.merges()).toBe(0);
  expect(result.lines).toContain('✗ base-guard: base=bench/x ≠ main · gh pr edit 26022 --base main 뒤 다시');
  expect(result.lines.some((line) => line.startsWith('✓ merge:'))).toBe(false);
});

test('a reused PR whose base is main lands normally', async () => {
  const result = await land('main');
  expect(result.code).toBe(0);
  expect(result.merges()).toBe(1);
  expect(result.lines).toContain(`✓ merge: squash ${PR_URL} → main`);
});

test('an explicit --base passes through the guard', async () => {
  const result = await land('bench/x', { base: 'bench/x' });
  expect(result.code).toBe(0);
  expect(result.merges()).toBe(1);
});

// BENCH-ISOLATED-ARMS: a bench arm PR carries `elanous:bench` and never lands, even with an explicit --base.
function landWithLabels(labels: string, prBase = 'main', opts: PrLandOpts = {}, found = false) {
  const lines: string[] = [];
  let merges = 0;
  const upserts: Array<{ base?: string }> = [];
  const deps: PrLandDeps = {
    prodFreezeRoot: freezeRoot,
    currentBranch: () => 'feat/guard',
    resolveBase: (_run, _cwd, explicit) => explicit ?? 'origin/main',
    run: (command, args) => {
      if (command === 'git' && args[0] === 'remote') return { ok: true, out: args[1] === 'get-url' ? 'https://github.com/example/repo.git' : 'origin' };
      if (command === 'git' && args[0] === 'rev-parse') return { ok: true, out: args[1] === 'HEAD' ? 'a'.repeat(40) : '/tmp/guard-test' };
      if (command === 'git' && args[0] === 'diff' && args[1] === '--name-only') return { ok: true, out: 'src/cli/x.ts\n' };
      if (command === 'gh' && args.includes('baseRefName')) return { ok: true, out: `${prBase}\n` };
      if (command === 'gh' && args.includes('labels')) return { ok: true, out: labels };
      return { ok: true, out: '' };
    },
    listUnfinishedRuns: () => [],
    queryRunningRuns: () => { throw new Error('observation unavailable'); },
    runTypecheckGate: () => true,
    runIsolationGate: () => true,
    runMockModuleRestoreGate: () => true,
    runModelHardcodeGate: () => true,
    runDaemonPortGate: () => true,
    runPublicLeakGate: () => 0,
    runExportLeakCheck: () => ({ measured: true, hits: [] }),
    runTestInterferenceGate: async () => 0,
    runLandGlobalChecks: () => true,
    runAndroidGate: () => true,
    runPwaGate: () => true,
    runIosGate: () => true,
    listOpenPrs: () => [],
    out: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    manager: {
      findPrForBranchOutcome: () => (found ? { status: 'ok OUTPUT', url: PR_URL } : { status: 'NOT_FOUND' }),
      upsertPr: (input: { base?: string }) => { upserts.push(input); return { ok: true, url: PR_URL, reused: true }; },
      mergePrOutcome: () => { merges++; return { ok: true, kind: 'merged' }; },
    } as unknown as PrLandDeps['manager'],
  };
  return realRunPrLand({ body: 'Human-requested atomic PR landing.', ...opts }, deps).then((code) => ({ code, lines, merges: () => merges, upserts }));
}

test('a reused PR labelled elanous:bench is refused before any merge call, even on base main', async () => {
  const result = await landWithLabels('elanous:superseded\nelanous:bench\n');
  expect(result.code).toBe(1);
  expect(result.merges()).toBe(0);
  expect(result.lines.some((line) => line.startsWith('✗ bench-guard: #26022'))).toBe(true);
});

test('an explicit --base does not pass a bench-labelled PR', async () => {
  const result = await landWithLabels('elanous:bench\n', 'bench/x', { base: 'bench/x' });
  expect(result.code).toBe(1);
  expect(result.merges()).toBe(0);
});

test('other labels land normally', async () => {
  const result = await landWithLabels('elanous:harvestable\n');
  expect(result.code).toBe(0);
  expect(result.merges()).toBe(1);
});

// LAND-BASE-GUARD-ORDER: 10-11 #26150 — upsert retargeted the bench PR to main BEFORE the base was read, so the guard never
//   fired and a refused land still left the PR changed. The guards now run on the found PR before upsert touches it.
test('an existing PR on a bench base is refused before upsert touches it', async () => {
  const result = await landWithLabels('', 'bench/base-night-x', {}, true);
  expect(result.code).toBe(1);
  expect(result.upserts).toHaveLength(0);
  expect(result.merges()).toBe(0);
  expect(result.lines).toContain('✗ base-guard: base=bench/base-night-x ≠ main · gh pr edit 26022 --base main 뒤 다시');
});

test('an existing bench-labelled PR is refused before upsert touches it', async () => {
  const result = await landWithLabels('elanous:bench\n', 'main', {}, true);
  expect(result.code).toBe(1);
  expect(result.upserts).toHaveLength(0);
  expect(result.lines.some((line) => line.startsWith('✗ bench-guard: #26022'))).toBe(true);
});

test('reusing an existing PR without --base does not pass an inferred base to upsert', async () => {
  const result = await landWithLabels('', 'main', {}, true);
  expect(result.code).toBe(0);
  expect(result.upserts).toHaveLength(1);
  expect(result.upserts[0]!.base).toBeUndefined();
});

test('reusing an existing PR with an explicit --base passes it to upsert', async () => {
  const result = await landWithLabels('', 'release/x', { base: 'origin/release/x' }, true);
  expect(result.upserts[0]!.base).toBe('origin/release/x');
});
