import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { acquireOpSeatFlock, opSeatFlockPath, resyncTickWithReleaseProbe } from '../../src/steward/resync-tick.js';
import { planResumeReleaseRun, resumeReleaseRun, type RecoverReleaseDeps } from './resume-release.js';
import { type CutBranchOptions } from './cut-branch.js';
import { Command } from 'commander';
import { registerReleaseCommands } from '../../src/cli/release-cli.js';
import { reserveReleaseResumeAttempt } from './resume-cap.js';
import { partialPlanPath } from './gate-partial.js';
import { DecisionLedger } from '../../src/decisions/decision-ledger.js';
import { runGraph, verifyReleaseCommandRoot } from '../../src/graph-runner/runner.js';

const SHA = 'a'.repeat(40);
const VERSION = '0.2.19';
const releaseGraphDir = join(import.meta.dir, '../../graphs/release');

function configureTraffic(root: string): void {
  const trafficFile = join(root, 'release-traffic.json');
  writeFileSync(trafficFile, '{}\n');
  writeFileSync(join(root, 'config.json'), JSON.stringify({ release: { loop: { trafficFile } } }));
}

function installReleaseRecipes(checkout: string): void {
  const target = join(checkout, 'graphs/release');
  mkdirSync(target, { recursive: true });
  for (const name of ['release-loop.yaml', 'recipes.yaml']) copyFileSync(join(releaseGraphDir, name), join(target, name));
}

function createPreflightCommandRoot(root: string): string {
  const checkout = join(root, 'checkout');
  mkdirSync(checkout, { recursive: true });
  mkdirSync(join(checkout, 'node_modules'));
  mkdirSync(join(checkout, 'apps', 'pwa', 'node_modules'), { recursive: true });
  installReleaseRecipes(checkout);
  return checkout;
}

function writeFailedRun(root: string, runId = 'r', gateOutput = '{"outcome":"ok"}', cutCommit = SHA): { statePath: string; original: string } {
  configureTraffic(root);
  const statePath = join(root, 'graph-runs', 'release-loop', `${runId}.json`);
  mkdirSync(join(root, 'graph-runs', 'release-loop'), { recursive: true });
  const state = {
    graphId: 'release-loop', runId, status: 'failed',
    input: { version: VERSION, branchCut: true },
    path: ['version-release', 'gate', 'tui', 'failed'],
    nodes: [
      { nodeId: 'version-release', ok: true, exit: 0, executed: true, output: JSON.stringify({ outcome: 'ok', version: VERSION, commit: cutCommit, branch: `release/${VERSION}` }) },
      { nodeId: 'gate', ok: true, exit: 0, executed: true, output: gateOutput },
      { nodeId: 'tui', ok: false, exit: 1, executed: true, output: '{"outcome":"fail"}' },
      { nodeId: 'failed', ok: true, exit: 0, executed: false },
    ],
    executed: 3, dryRun: false, statePath,
    graphSnapshot: {
      graphSha: createHash('sha256').update(readFileSync(join(releaseGraphDir, 'release-loop.yaml'))).digest('hex'),
      recipesSha: createHash('sha256').update(readFileSync(join(releaseGraphDir, 'recipes.yaml'))).digest('hex'),
    },
  };
  writeFileSync(statePath, JSON.stringify(state));
  return { statePath, original: readFileSync(statePath, 'utf8') };
}

function gitStub(args: string[]): string {
  if (args[0] === 'ls-remote') return `${SHA}\trefs/heads/release/${VERSION}`;
  if (args[0] === 'rev-parse') return SHA;
  return '';
}

test('resume dry-run checks the saved cut and checkout without running nodes or changing release state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resume-dry-run-'));
  setElanousConfigDir(root);
  const saved = writeFailedRun(root);
  const priorPlanPath = partialPlanPath(root, VERSION);
  mkdirSync(join(root, 'release', VERSION), { recursive: true });
  const priorPlan = '{"sentinel":"preserve-existing-plan"}\n';
  writeFileSync(priorPlanPath, priorPlan);
  try {
    let graphCalls = 0;
    const gitCalls: string[] = [];
    const plan = await planResumeReleaseRun({ runId: 'r', from: 'tui', partial: false }, {
      root, git: (args) => { gitCalls.push(args[0]!); return gitStub(args); }, graph: async () => { graphCalls++; return { status: 'done' } as never; },
    });
    expect(plan).toMatchObject({ runId: 'r', version: VERSION, fromNode: 'tui', nextAttempt: 1, priorCountKnown: true, preflight: 'passed', gatePlan: { mode: 'not-run' },
      tip: { changed: false, from: SHA, to: SHA } });
    expect(graphCalls).toBe(0);
    expect(gitCalls).not.toContain('fetch');
    expect(readFileSync(saved.statePath, 'utf8')).toBe(saved.original);
    expect(readFileSync(priorPlanPath, 'utf8')).toBe(priorPlan);
    expect(existsSync(join(root, 'release', VERSION, 'resume-attempts', 'r.json'))).toBe(false);
    expect(readdirSync(join(root, 'graph-runs', 'release-loop'))).toEqual(['r.json']);
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('resume preflight matches owned docs and prepared paths by realpath while rejecting another worktree', async () => {
  const run = async (wrongListedWorktree = false) => {
    const root = mkdtempSync(join(tmpdir(), 'release-resume-realpath-'));
    setElanousConfigDir(root);
    const saved = writeFailedRun(root);
    const commandRoot = createPreflightCommandRoot(root);
    const branch = `release-docs/${VERSION}`;
    const tree = join(root, 'docs-tree'); mkdirSync(tree);
    const receiptTree = join(root, 'docs-tree-alias'); symlinkSync(tree, receiptTree, 'dir');
    const listedPath = realpathSync(tree);
    const listed = wrongListedWorktree ? join(root, 'other-tree') : listedPath;
    if (wrongListedWorktree) mkdirSync(listed);
    const prepared = join(root, 'release', VERSION, 'prepared');
    mkdirSync(prepared, { recursive: true });
    writeFileSync(join(prepared, 'release.json'), JSON.stringify({ version: VERSION, sourceCommit: SHA }));
    const preparedAlias = join(root, 'prepared-alias'); symlinkSync(prepared, preparedAlias, 'dir');
    const state = JSON.parse(readFileSync(saved.statePath, 'utf8')) as { nodes: Array<Record<string, unknown>> };
    state.nodes.push(
      { nodeId: 'prepare', ok: true, output: JSON.stringify({ outcome: 'ok', out: preparedAlias, commit: SHA }) },
      { nodeId: 'docs', ok: true, output: JSON.stringify({ outcome: 'ok', branch, worktree: receiptTree, artifactOwner: { runId: 'r', attempt: 0 } }) },
    );
    writeFileSync(saved.statePath, JSON.stringify(state));
    writeFileSync(join(root, 'release', VERSION, 'docs-branch-owner.json'), JSON.stringify({
      owner: { runId: 'r', attempt: 0 }, branch, worktree: receiptTree, outcome: 'built',
    }));
    const git = (args: string[]) => {
      if (args[0] === 'show-ref' && args.at(-1) === `refs/heads/${branch}`) return SHA;
      if (args[0] === 'worktree' && args[1] === 'list') return `worktree ${listed}\nbranch refs/heads/${branch}\n`;
      if (args[0] === 'ls-remote' && args.at(-1) === `refs/heads/${branch}`) return `${SHA}\trefs/heads/${branch}`;
      return gitStub(args);
    };
    try {
      return await planResumeReleaseRun({ runId: 'r', from: 'tui', commandRoot }, { root, git });
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  };

  const plan = await run();
  expect(plan.preflight).toBe('passed');
  await expect(run(true)).rejects.toThrow('docs branch/worktree is outside');
});

test('resume preflight rejects each environment/artifact mismatch before graph or attempt/state writes', async () => {
  const cases: Array<{ name: string; expected: string; prepare: (root: string) => { commandRoot: string; git?: (args: string[]) => string; isAncestor?: () => boolean } }> = [
    { name: 'traffic file', expected: 'traffic file is missing or not writable', prepare: (root) => ({ commandRoot: createPreflightCommandRoot(root) }) },
    { name: 'prepared ownership', prepare: (root) => {
      mkdirSync(join(root, 'release', VERSION, 'prepared'), { recursive: true });
      writeFileSync(join(root, 'release', VERSION, 'prepared', 'release.json'), JSON.stringify({ version: VERSION, sourceCommit: SHA }));
      return { commandRoot: createPreflightCommandRoot(root) };
    }, expected: 'prepared artifact is outside' },
    { name: 'docs branch ownership', expected: 'docs branch/worktree is outside', prepare: (root) => ({ commandRoot: createPreflightCommandRoot(root), git: (args) => {
      if (args[0] === 'ls-remote' && args.at(-1) === `refs/heads/release-docs/${VERSION}`) return `${SHA}\trefs/heads/release-docs/${VERSION}`;
      return gitStub(args);
    } }) },
    { name: 'docs remote tip moved after pushed receipt', expected: 'docs branch tip differs', prepare: (root) => {
      const branch = `release-docs/${VERSION}`;
      const tree = join(root, 'docs-tree'); mkdirSync(tree);
      const statePath = join(root, 'graph-runs', 'release-loop', 'r.json');
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { nodes: Array<Record<string, unknown>> };
      state.nodes.push({ nodeId: 'docs', ok: true, output: JSON.stringify({ outcome: 'ok', branch, worktree: tree,
        artifactOwner: { runId: 'r', attempt: 0 } }) });
      writeFileSync(statePath, JSON.stringify(state));
      const releaseDir = join(root, 'release', VERSION);
      mkdirSync(releaseDir, { recursive: true });
      writeFileSync(join(releaseDir, 'docs-branch-owner.json'), JSON.stringify({
        owner: { runId: 'r', attempt: 0 }, branch, worktree: tree, outcome: 'pushed', head: SHA,
      }));
      return { commandRoot: createPreflightCommandRoot(root), git: (args) => {
        if (args[0] === 'show-ref' && args.at(-1) === `refs/heads/${branch}`) return SHA;
        if (args[0] === 'worktree' && args[1] === 'list') return `worktree ${tree}\nbranch refs/heads/${branch}\n`;
        if (args[0] === 'ls-remote' && args.at(-1) === `refs/heads/${branch}`) return `${'b'.repeat(40)}\trefs/heads/${branch}`;
        return gitStub(args);
      } };
    } },
    { name: 'release tip ownership', expected: 'does not descend from the recorded release commit', prepare: (root) => ({ commandRoot: createPreflightCommandRoot(root), git: (args) => args[0] === 'ls-remote'
      ? `${'b'.repeat(40)}\trefs/heads/release/${VERSION}` : gitStub(args), isAncestor: () => false }) },
    { name: 'root and PWA dependencies', expected: 'release resume dependencies missing', prepare: (root) => {
      const commandRoot = join(root, 'checkout'); mkdirSync(commandRoot);
      installReleaseRecipes(commandRoot);
      mkdirSync(join(commandRoot, 'node_modules'));
      return { commandRoot, git: (args) => args[0] === 'rev-parse' ? SHA : args[0] === 'ls-remote' ? gitStub(args) : '' };
    } },
  ];
  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), 'resume-wide-preflight-'));
    setElanousConfigDir(root);
    const saved = writeFailedRun(root);
    let graphCalls = 0;
    const extra = item.prepare(root);
    const stateAfterFixtureSetup = readFileSync(saved.statePath, 'utf8');
    const deps: NonNullable<Parameters<typeof resumeReleaseRun>[1]> = {
      root, git: gitStub, ...extra, graph: async () => { graphCalls++; return { status: 'done' } as never; },
    };
    try {
      if (item.name === 'traffic file') deps.trafficFile = join(root, 'missing-traffic.json');
      await expect(planResumeReleaseRun({ runId: 'r', from: 'tui', partial: false,
        commandRoot: extra.commandRoot }, deps)).rejects.toThrow(item.expected);
      await expect(resumeReleaseRun({ runId: 'r', from: 'tui', partial: false,
        commandRoot: extra.commandRoot }, deps).then(() => 'passed', (error) => String(error)))
        .resolves.toContain(item.expected);
      expect(graphCalls).toBe(0);
      expect(readFileSync(saved.statePath, 'utf8')).toBe(stateAfterFixtureSetup);
      expect(existsSync(join(root, 'release', VERSION, 'resume-attempts', 'r.json'))).toBe(false);
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  }
});

test('resume refuses to cross a rejected publish approval after an appended cut, before dry-run or mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resume-rejected-approval-'));
  setElanousConfigDir(root);
  const saved = writeFailedRun(root);
  const state = JSON.parse(saved.original) as Record<string, any>;
  const decidedAt = '2026-10-26T07:00:00.000Z';
  state.path = ['version-release', 'gate', 'auto-approve', 'approve-publish', 'failed'];
  state.nodes = [
    { nodeId: 'version-release', ok: true, exit: 0, executed: true,
      output: JSON.stringify({ outcome: 'ok', version: VERSION, commit: SHA, branch: `release/${VERSION}` }) },
    { nodeId: 'gate', ok: true, exit: 0, executed: true, output: '{"outcome":"ok"}' },
    { nodeId: 'auto-approve', ok: false, exit: 1, executed: true, output: '{"outcome":"fail"}' },
    { nodeId: 'approve-publish', ok: false, exit: 1, executed: true, decidedAt },
    { nodeId: 'failed', ok: true, exit: 0, executed: false },
  ];
  state.executed = 4;
  writeFileSync(saved.statePath, JSON.stringify(state));
  writeFileSync(`${saved.statePath}.4.decision.json`, JSON.stringify({
    nodeId: 'approve-publish', decision: 'rejected', decidedAt,
  }));
  const appended = 'b'.repeat(40);
  const git = (args: string[]) => {
    if (args[0] === 'ls-remote') return `${appended}\trefs/heads/release/${VERSION}`;
    if (args[0] === 'rev-parse') return appended;
    return '';
  };
  let graphCalls = 0;
  const deps = { root, git, isAncestor: () => true, repo: process.cwd() };
  try {
    await expect(planResumeReleaseRun({ runId: 'r', from: 'gate', partial: false }, deps))
      .rejects.toThrow('cannot restart across an approval decision');
    await expect(resumeReleaseRun({ runId: 'r', from: 'gate', partial: false }, {
      ...deps, graph: async () => { graphCalls++; throw new Error('graph should not run'); },
    })).rejects.toThrow('cannot restart across an approval decision');
    expect(readFileSync(saved.statePath, 'utf8')).toBe(JSON.stringify(state));
    expect(readdirSync(join(root, 'graph-runs', 'release-loop')).some((name) => name.includes('.before-tip-'))).toBe(false);
    expect(graphCalls).toBe(0);
    expect(existsSync(join(root, 'release', VERSION, 'resume-attempts', 'r.json'))).toBe(false);
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('resume dry-run marks an explicit no-partial gate restart as a full gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resume-dry-run-full-gate-'));
  setElanousConfigDir(root);
  writeFailedRun(root);
  try {
    const plan = await planResumeReleaseRun({ runId: 'r', from: 'gate', partial: false }, { root, git: gitStub });
    expect(plan.gatePlan).toEqual({ mode: 'full', reason: 'partial recheck disabled' });
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('resume dry-run on a moved cut reports the fail-closed full-gate fallback without writing a partial plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resume-dry-run-moved-tip-'));
  setElanousConfigDir(root);
  const saved = writeFailedRun(root);
  const moved = 'b'.repeat(40), gitCalls: string[] = [];
  const git = (args: string[]) => {
    gitCalls.push(args[0]!);
    if (args[0] === 'ls-remote') return `${moved}\trefs/heads/release/${VERSION}`;
    if (args[0] === 'rev-parse') return moved;
    return '';
  };
  try {
    const plan = await planResumeReleaseRun({ runId: 'r', from: 'gate' }, { root, git, isAncestor: () => true });
    expect(plan.tip).toMatchObject({ changed: true, from: SHA, to: moved });
    expect(plan.partial).toMatchObject({ requested: true, applied: false, auto: true });
    expect(plan.gatePlan).toMatchObject({ mode: 'full', reason: expect.stringContaining('no complete gate record') });
    expect(readFileSync(saved.statePath, 'utf8')).toBe(saved.original);
    expect(readdirSync(join(root, 'graph-runs', 'release-loop'))).toEqual(['r.json']);
    expect(gitCalls).not.toContain('fetch');
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('RELEASE-GATE-RADIUS-POD-IMAGE: a Pod resume without prior shard receipts falls back to a full gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resume-pod-image-missing-'));
  setElanousConfigDir(root);
  const saved = writeFailedRun(root);
  const state = JSON.parse(saved.original) as { input: { gatePodPool?: string } };
  state.input.gatePodPool = 'pool-node-b';
  writeFileSync(saved.statePath, JSON.stringify(state));
  const moved = 'b'.repeat(40);
  const git = (args: string[]) => args[0] === 'ls-remote' ? `${moved}\trefs/heads/release/${VERSION}`
    : args[0] === 'rev-parse' ? moved : args[0] === 'diff' ? 'src/x.test.ts\n' : '';
  const releaseDir = join(root, 'release', VERSION);
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, 'gate-failures.json'), JSON.stringify({ commit: SHA, failures: [], errors: [] }));
  try {
    const commandRoot = createPreflightCommandRoot(root);
    const deps = { root, git, isAncestor: () => true,
      closureTree: () => ({ files: ['src/x.test.ts', 'src/y.test.ts'] }) as never };
    const plan = await planResumeReleaseRun({ runId: 'r', from: 'gate', commandRoot }, deps);
    expect(plan.gatePlan).toEqual({ mode: 'full', reason: 'executed-pod-image-digest-missing' });
    expect(existsSync(partialPlanPath(root, VERSION))).toBe(false);
    delete state.input.gatePodPool;
    writeFileSync(saved.statePath, JSON.stringify(state));
    const cut = join(releaseDir, 'gate-logs', 'cut');
    mkdirSync(cut, { recursive: true });
    writeFileSync(join(cut, 'pod-0.json'), JSON.stringify({ commit: SHA }));
    const hostPlan = await planResumeReleaseRun({ runId: 'r', from: 'gate', commandRoot }, deps);
    expect(hostPlan.gatePlan).toEqual({ mode: 'partial' });
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('resume dry-run rejects legacy cut-commit runs before attempting branch refresh', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resume-dry-run-legacy-'));
  setElanousConfigDir(root);
  const saved = writeFailedRun(root);
  const state = JSON.parse(saved.original) as { input: { branchCut: boolean } };
  state.input.branchCut = false;
  writeFileSync(saved.statePath, JSON.stringify(state));
  try {
    await expect(planResumeReleaseRun({ runId: 'r', from: 'tui' }, { root, git: gitStub }))
      .rejects.toThrow('was not cut as release/0.2.19');
    expect(existsSync(join(root, 'release', VERSION, 'resume-attempts', 'r.json'))).toBe(false);
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('resume dry-run surfaces checkout preflight ENOBUFS and leaves retry state untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resume-dry-run-enobufs-'));
  setElanousConfigDir(root);
  const saved = writeFailedRun(root);
  const git = (args: string[]) => {
    if (args[0] === 'ls-files') throw Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
    return gitStub(args);
  };
  try {
    await expect(planResumeReleaseRun({ runId: 'r', from: 'tui' }, { root, git })).rejects.toThrow('ENOBUFS');
    expect(readFileSync(saved.statePath, 'utf8')).toBe(saved.original);
    expect(existsSync(join(root, 'release', VERSION, 'resume-attempts', 'r.json'))).toBe(false);
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('resume dry-run previews the third attempt without creating a decision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resume-dry-run-cap-'));
  setElanousConfigDir(root);
  const saved = writeFailedRun(root);
  const run = JSON.parse(saved.original) as Parameters<typeof reserveReleaseResumeAttempt>[0];
  reserveReleaseResumeAttempt(run, root);
  reserveReleaseResumeAttempt(run, root);
  try {
    const plan = await planResumeReleaseRun({ runId: 'r', from: 'tui' }, { root, git: gitStub });
    expect(plan.nextAttempt).toBe(3);
    expect(plan).not.toHaveProperty('attemptLimit');
    expect(new DecisionLedger({ stateDir: root }).list({ status: 'open' })).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(root, 'release', VERSION, 'resume-attempts', 'r.json'), 'utf8')).attempts).toHaveLength(2);
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('third release resume reaches the graph and records attempt three without a decision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resume-third-'));
  setElanousConfigDir(root);
  const saved = writeFailedRun(root);
  const run = JSON.parse(saved.original) as Parameters<typeof reserveReleaseResumeAttempt>[0];
  reserveReleaseResumeAttempt(run, root);
  reserveReleaseResumeAttempt(run, root);
  let graphCalls = 0;
  try {
    const result = await resumeReleaseRun({ runId: 'r', from: 'tui' }, {
      root, git: gitStub, graph: async () => { graphCalls++; return { status: 'done' } as never; },
    });
    expect(result.state.status).toBe('done');
    expect(graphCalls).toBe(1);
    expect(JSON.parse(readFileSync(join(root, 'release', VERSION, 'resume-attempts', 'r.json'), 'utf8')).attempts).toHaveLength(3);
    expect(new DecisionLedger({ stateDir: root }).list({ status: 'open' })).toHaveLength(0);
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('release command root checks the real checkout HEAD and rejects a different tip', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-command-root-'));
  try {
    seatGit(root, 'init', '-q');
    writeFileSync(join(root, 'file'), 'cut\n');
    seatGit(root, 'add', 'file');
    seatGit(root, 'commit', '-q', '-m', 'cut');
    const cut = seatGit(root, 'rev-parse', 'HEAD');
    expect(verifyReleaseCommandRoot(root, cut)).toBe(realpathSync(root));
    writeFileSync(join(root, 'file'), 'later\n');
    expect(() => verifyReleaseCommandRoot(root, cut)).toThrow('--command-root');
    seatGit(root, 'add', 'file');
    seatGit(root, 'commit', '-q', '-m', 'later');
    expect(() => verifyReleaseCommandRoot(root, cut)).toThrow('--command-root');
    seatGit(root, 'reset', '--hard', cut);
    seatGit(root, 'config', 'status.showUntrackedFiles', 'no');
    writeFileSync(join(root, 'untracked.ts'), 'changed code\n');
    expect(seatGit(root, 'status', '--porcelain')).toBe('');
    expect(() => verifyReleaseCommandRoot(root, cut)).toThrow('--command-root');
    rmSync(join(root, 'untracked.ts'));
    seatGit(root, 'update-index', '--assume-unchanged', 'file');
    writeFileSync(join(root, 'file'), 'hidden change\n');
    expect(seatGit(root, 'status', '--porcelain')).toBe('');
    expect(() => verifyReleaseCommandRoot(root, cut)).toThrow('--command-root');
    seatGit(root, 'update-index', '--no-assume-unchanged', 'file');
    seatGit(root, 'reset', '--hard', cut);
    seatGit(root, 'update-index', '--skip-worktree', 'file');
    writeFileSync(join(root, 'file'), 'hidden change\n');
    expect(seatGit(root, 'status', '--porcelain')).toBe('');
    expect(() => verifyReleaseCommandRoot(root, cut)).toThrow('--command-root');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-RESUME-STALLED-ONLY: same-commit resume plans stalled files and preserves completed shard outcomes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'resume-stalled-only-'));
  setElanousConfigDir(root);
  const state = writeFailedRun(root, 'r', JSON.stringify({ outcome: 'error', commit: SHA,
    stalledShards: [{ shard: 4, files: ['src/stalled.test.ts'], reason: 'job-failed' }],
    partialSummary: { pass: 10, fail: 1, errors: 1, ran: 10, files: 10 }, preservedShardCount: 5,
    partialFailures: { failures: ['src/completed.test.ts > kept'], errors: ['src/error.test.ts > [error]'] } }));
  try {
    const resumed = await resumeReleaseRun({ runId: 'r', from: 'gate' }, { root, git: gitStub, isAncestor: () => true,
      closureTree: () => ({ files: ['src/stalled.test.ts', 'src/completed.test.ts', 'src/error.test.ts'] }) as never,
      graph: async () => ({ status: 'done', runId: 'r' }) as never });
    expect(resumed.partial).toMatchObject({ requested: true, applied: true, files: 1, priorCommit: SHA });
    expect(JSON.parse(readFileSync(join(root, 'release', VERSION, 'gate-partial.json'), 'utf8'))).toMatchObject({
      kind: 'recheck', forCommit: SHA, stalledFiles: ['src/stalled.test.ts'],
      files: ['src/stalled.test.ts'], preservedShardCount: 5,
      priorFailures: ['src/completed.test.ts > kept'], priorErrors: ['src/error.test.ts > [error]'],
    });
    expect(readFileSync(state.statePath, 'utf8')).toContain('partialFailures');
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('GATE-SHARD-HOST-REROUTE: release resume passes the exact shard override to runGraph', async () => {
  const root = mkdtempSync(join(tmpdir(), 'resume-shard-reroute-'));
  setElanousConfigDir(root);
  const saved = writeFailedRun(root);
  const state = JSON.parse(saved.original) as { input: Record<string, unknown> };
  state.input.gatePodPool = 'pool-test';
  writeFileSync(saved.statePath, JSON.stringify(state));
  const commandRoot = createPreflightCommandRoot(root);
  let graphOptions: Parameters<typeof runGraph>[1];
  try {
    await resumeReleaseRun({ runId: 'r', from: 'gate', partial: false,
      rerouteShard: 'pod-2', shardHost: 'pool-mac', shardOs: 'darwin', commandRoot }, {
      root, git: gitStub, isAncestor: () => true,
      graph: async (_path, options) => { graphOptions = options; return { status: 'done' } as never; },
    });
    expect(graphOptions).toMatchObject({ resumeRunId: 'r', fromNodeId: 'gate',
      releaseGateShardReroute: { shard: 'pod-2', host: 'pool-mac', os: 'darwin' } });
    expect(graphOptions?.releaseCommandSource?.cutTip).toBe(SHA);
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

for (const reason of ['admission-timeout', 'admission-error'] as const) {
  test(`GATE-MEM-ADMIT: same-commit resume rechecks ${reason} files without a full sweep`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'resume-admission-'));
    setElanousConfigDir(root);
    writeFailedRun(root, 'r', JSON.stringify({ outcome: 'error', commit: SHA,
      stalledShards: [{ shard: 4, files: ['src/stalled.test.ts'], reason }],
      partialSummary: { pass: 10, fail: 0, errors: 0, ran: 10, files: 10 }, preservedShardCount: 5,
      partialFailures: { failures: [], errors: [] } }));
    try {
      const resumed = await resumeReleaseRun({ runId: 'r', from: 'gate' }, { root, git: gitStub, isAncestor: () => true,
        closureTree: () => ({ files: ['src/stalled.test.ts'] }) as never,
        graph: async () => ({ status: 'done', runId: 'r' }) as never });
      expect(resumed.partial).toMatchObject({ requested: true, applied: true, files: 1, priorCommit: SHA });
      expect(JSON.parse(readFileSync(join(root, 'release', VERSION, 'gate-partial.json'), 'utf8'))).toMatchObject({
        kind: 'recheck', stalledFiles: ['src/stalled.test.ts'], files: ['src/stalled.test.ts'], preservedShardCount: 5,
      });
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  });
}

test('GATE-RESUME-STALLED-ONLY: an incomplete saved gate record falls back to a full sweep plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'resume-stalled-fallback-'));
  setElanousConfigDir(root);
  writeFailedRun(root, 'r', JSON.stringify({ outcome: 'error', stalledShards: [{ files: ['src/stalled.test.ts'], reason: 'job-failed' }] }));
  try {
    const resumed = await resumeReleaseRun({ runId: 'r', from: 'gate' }, { root, git: gitStub, isAncestor: () => true,
      graph: async () => ({ status: 'done', runId: 'r' }) as never });
    expect(resumed.partial).toMatchObject({ requested: true, applied: false, reason: expect.stringContaining('no complete stalled-shard') });
    expect(existsSync(join(root, 'release', VERSION, 'gate-partial.json'))).toBe(false);
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('GATE-RESUME-STALLED-ONLY: a saved gate result from another commit cannot authorize a partial recheck', async () => {
  const root = mkdtempSync(join(tmpdir(), 'resume-stalled-wrong-commit-'));
  setElanousConfigDir(root);
  writeFailedRun(root, 'r', JSON.stringify({ outcome: 'error', commit: 'b'.repeat(40),
    stalledShards: [{ files: ['src/stalled.test.ts'], reason: 'job-failed' }],
    partialSummary: { pass: 10, fail: 0, errors: 0, ran: 10, files: 10 },
    partialFailures: { failures: [], errors: [] } }));
  try {
    const resumed = await resumeReleaseRun({ runId: 'r', from: 'gate' }, { root, git: gitStub, isAncestor: () => true,
      closureTree: () => ({ files: ['src/stalled.test.ts'] }) as never,
      graph: async () => ({ status: 'done', runId: 'r' }) as never });
    expect(resumed.partial).toMatchObject({ requested: true, applied: false, reason: expect.stringContaining('no complete stalled-shard') });
    expect(existsSync(join(root, 'release', VERSION, 'gate-partial.json'))).toBe(false);
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('GATE-RESUME-STALLED-ONLY: missing measured failure IDs cannot authorize a partial recheck', async () => {
  const root = mkdtempSync(join(tmpdir(), 'resume-stalled-missing-failure-'));
  setElanousConfigDir(root);
  writeFailedRun(root, 'r', JSON.stringify({ outcome: 'error', stalledShards: [{ files: ['src/stalled.test.ts'], reason: 'job-failed' }],
    partialSummary: { pass: 10, fail: 1, errors: 0, ran: 11, files: 10 },
    partialFailures: { failures: [], errors: [] } }));
  try {
    const resumed = await resumeReleaseRun({ runId: 'r', from: 'gate' }, { root, git: gitStub, isAncestor: () => true,
      closureTree: () => ({ files: ['src/stalled.test.ts'] }) as never,
      graph: async () => ({ status: 'done', runId: 'r' }) as never });
    expect(resumed.partial).toMatchObject({ requested: true, applied: false, reason: expect.stringContaining('no complete stalled-shard') });
    expect(existsSync(join(root, 'release', VERSION, 'gate-partial.json'))).toBe(false);
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('an injected graph cannot skip command checkout verification at resume start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-command-graph-'));
  setElanousConfigDir(root);
  writeFailedRun(root);
  try {
    let graphCalls = 0;
    const git = (args: string[]) => args[0] === 'rev-parse' && args[1] === 'HEAD' ? 'b'.repeat(40) : gitStub(args);
    await expect(resumeReleaseRun({ runId: 'r', from: 'tui', partial: false }, { root, git,
      graph: async () => { graphCalls++; return { status: 'done' } as never; } })).rejects.toThrow('--command-root');
    expect(graphCalls).toBe(0);
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('resume announces the saved recipe source and gives the graph the verified checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-command-source-'));
  setElanousConfigDir(root);
  writeFailedRun(root);
  try {
    const lines: string[] = [];
    const result = await resumeReleaseRun({ runId: 'r', from: 'tui', partial: false }, { root, git: gitStub,
      onSource: (line) => lines.push(line), graph: async (_path, options) => {
        expect(options?.releaseCommandSource).toMatchObject({ root: realpathSync(process.cwd()), cutTip: SHA });
        return { status: 'done', runId: 'r' } as never;
      } });
    expect(result.state.status).toBe('done');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('레시피 출처:');
    expect(lines[0]).toContain(`컷 tip=${SHA.slice(0, 12)}`);
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('a moved command checkout stops a resumed Bash node before its runner is called', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-command-dispatch-'));
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  seatGit(checkout, 'init', '-q');
  writeFileSync(join(checkout, 'file'), 'cut\n');
  installReleaseRecipes(checkout);
  seatGit(checkout, 'add', '.');
  seatGit(checkout, 'commit', '-q', '-m', 'cut');
  const cut = seatGit(checkout, 'rev-parse', 'HEAD');
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  let commands = 0;
  const runBash = async (body: string) => {
    commands++;
    if (body.includes('version-node.ts release')) return { exitCode: 0, stderr: '', stdout: JSON.stringify({ outcome: 'ok', version: VERSION, branch: `release/${VERSION}`, commit: cut }) };
    return { exitCode: 1, stderr: '', stdout: '{"outcome":"fail"}' };
  };
  try {
    const first = await runGraph(graphPath, { input: { version: VERSION, branchCut: true }, deps: { root, runBash } });
    expect(first.status).toBe('failed');
    const before = commands;
    let moved = false;
    const resumed = await runGraph(graphPath, { resumeRunId: first.runId, fromNodeId: 'cutoff',
      releaseCommandSource: { root: checkout, cutTip: cut }, deps: { root, runBash, beforeNode: () => {
        if (moved) return;
        moved = true;
        writeFileSync(join(checkout, 'file'), 'later\n');
        seatGit(checkout, 'add', 'file');
        seatGit(checkout, 'commit', '-q', '-m', 'later');
      } } });
    expect(moved).toBe(true);
    expect(seatGit(checkout, 'rev-parse', 'HEAD')).not.toBe(cut);
    expect(commands).toBe(before);
    expect(resumed.status).toBe('failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a clean cut checkout with different recipes is rejected before resumed Bash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-command-recipe-drift-'));
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  seatGit(checkout, 'init', '-q');
  installReleaseRecipes(checkout);
  writeFileSync(join(checkout, 'graphs/release/recipes.yaml'), readFileSync(join(checkout, 'graphs/release/recipes.yaml'), 'utf8') + '\n# cut changed recipes\n');
  seatGit(checkout, 'add', '.');
  seatGit(checkout, 'commit', '-q', '-m', 'cut');
  const cut = seatGit(checkout, 'rev-parse', 'HEAD');
  const graphPath = join(releaseGraphDir, 'release-loop.yaml');
  let calls = 0;
  const runBash = async (body: string) => {
    calls++;
    return body.includes('version-node.ts release')
      ? { exitCode: 0, stderr: '', stdout: JSON.stringify({ outcome: 'ok', version: VERSION, branch: `release/${VERSION}`, commit: cut }) }
      : { exitCode: 1, stderr: '', stdout: '{"outcome":"fail"}' };
  };
  try {
    const first = await runGraph(graphPath, { input: { version: VERSION, branchCut: true }, deps: { root, runBash } });
    expect(first.status).toBe('failed');
    const before = calls;
    await expect(runGraph(graphPath, { resumeRunId: first.runId, fromNodeId: 'cutoff',
      releaseCommandSource: { root: checkout, cutTip: cut }, deps: { root, runBash } }))
      .rejects.toThrow('release recipe source differs');
    expect(calls).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a clean real Git cut with different recipes is rejected before an injected graph callback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-command-injected-graph-'));
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  seatGit(checkout, 'init', '-q');
  installReleaseRecipes(checkout);
  writeFileSync(join(checkout, 'graphs/release/recipes.yaml'), readFileSync(join(checkout, 'graphs/release/recipes.yaml'), 'utf8') + '\n# drift\n');
  seatGit(checkout, 'add', '.');
  seatGit(checkout, 'commit', '-q', '-m', 'cut');
  const cut = seatGit(checkout, 'rev-parse', 'HEAD');
  setElanousConfigDir(root);
  writeFailedRun(root, 'r', '{"outcome":"ok"}', cut);
  let graphCalls = 0;
  const git = (args: string[]): string => {
    if (args[0] === 'ls-remote') return `${cut}\trefs/heads/release/${VERSION}`;
    if (args[0] === 'fetch') return '';
    if (args[0] === 'rev-parse' && args[1] === '--verify') return cut;
    return seatGit(checkout, ...args);
  };
  try {
    await expect(resumeReleaseRun({ runId: 'r', from: 'tui', partial: false, commandRoot: checkout }, { root, git,
      graph: async () => { graphCalls++; return { status: 'done' } as never; } }))
      .rejects.toThrow('release recipe source differs');
    expect(graphCalls).toBe(0);
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('simulated failed gate: pin mismatch leaves state unchanged; matching pin resumes at gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resume-pin-preflight-'));
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  installReleaseRecipes(checkout);
  const graphFile = join(checkout, 'graphs/release/release-loop.yaml');
  writeFileSync(graphFile, readFileSync(graphFile, 'utf8') + '\n# different cut graph\n');
  const currentGraphSha = createHash('sha256').update(readFileSync(graphFile)).digest('hex');
  const saved = writeFailedRun(root);
  const failedGate = JSON.parse(saved.original) as { path: string[]; nodes: Array<{ nodeId: string; ok: boolean; output?: string }>; graphSnapshot: { graphSha: string } };
  failedGate.path = ['version-release', 'gate', 'failed'];
  failedGate.nodes = [failedGate.nodes[0]!,
    { nodeId: 'gate', ok: false, output: JSON.stringify({ outcome: 'fail', introduced: 1, gateVerdict: 'failed' }) },
    { nodeId: 'failed', ok: true }];
  writeFileSync(saved.statePath, JSON.stringify(failedGate));
  const original = readFileSync(saved.statePath, 'utf8');
  const savedGraphSha = failedGate.graphSnapshot.graphSha;
  const moved = 'b'.repeat(40);
  const gitCalls: string[] = [];
  const git = (args: string[]): string => {
    gitCalls.push(args[0]!);
    if (args[0] === 'ls-remote') return `${moved}\trefs/heads/release/${VERSION}`;
    if (args[0] === 'rev-parse') return moved;
    return '';
  };
  setElanousConfigDir(root);
  mkdirSync(join(checkout, 'node_modules'), { recursive: true });
  mkdirSync(join(checkout, 'apps', 'pwa', 'node_modules'), { recursive: true });
  try {
    for (const resume of [
      () => planResumeReleaseRun({ runId: 'r', from: 'gate', commandRoot: checkout }, { root, git, isAncestor: () => true }),
      () => resumeReleaseRun({ runId: 'r', from: 'gate', commandRoot: checkout }, { root, git, isAncestor: () => true }),
    ]) {
      let error = '';
      try { await resume(); } catch (caught) { error = String(caught); }
      expect(error).toContain('release-loop.yaml');
      expect(error).toContain(savedGraphSha);
      expect(error).toContain(currentGraphSha);
      expect(error).toContain(`eln release run --version ${VERSION}`);
      expect(readFileSync(saved.statePath, 'utf8')).toBe(original);
      expect(readdirSync(join(root, 'graph-runs', 'release-loop'))).toEqual(['r.json']);
      expect(existsSync(join(root, 'release', VERSION, 'resume-attempts', 'r.json'))).toBe(false);
    }
    expect(gitCalls).not.toContain('fetch');
    installReleaseRecipes(checkout);
    let resumedFrom = '';
    const resumed = await resumeReleaseRun({ runId: 'r', from: 'gate', partial: false, commandRoot: checkout }, {
      root, git, isAncestor: () => true,
      graph: async (_path, options) => { resumedFrom = options?.fromNodeId ?? ''; return { status: 'done' } as never; },
    });
    expect(resumedFrom).toBe('gate');
    expect(resumed.state.status).toBe('done');
    expect(resumed.tip).toMatchObject({ from: SHA, to: moved, changed: true });
    expect(gitCalls).toContain('fetch');
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('the resumed Bash process reads from the verified command checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-command-cwd-'));
  const checkout = join(root, 'checkout');
  mkdirSync(checkout);
  seatGit(checkout, 'init', '-q');
  writeFileSync(join(checkout, 'marker'), 'cut recipe\n');
  installReleaseRecipes(checkout);
  seatGit(checkout, 'add', '.');
  seatGit(checkout, 'commit', '-q', '-m', 'cut');
  const cut = seatGit(checkout, 'rev-parse', 'HEAD');
  const checkoutAlias = join(root, 'checkout-alias');
  symlinkSync(checkout, checkoutAlias);
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  try {
    const first = await runGraph(graphPath, { input: { version: VERSION, branchCut: true }, deps: { root,
      runBash: async (body) => body.includes('version-node.ts release')
        ? { exitCode: 0, stderr: '', stdout: JSON.stringify({ outcome: 'ok', version: VERSION, branch: `release/${VERSION}`, commit: cut }) }
        : { exitCode: 1, stderr: '', stdout: '{"outcome":"fail"}' } } });
    expect(first.status).toBe('failed');
    const fakeBin = join(root, 'bin');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'bun'), '#!/bin/sh\npwd\ncat marker\nprintf \'{"outcome":"fail"}\\n\'\n');
    chmodSync(join(fakeBin, 'bun'), 0o755);
    const oldPath = process.env.PATH;
    let resumed;
    try {
      process.env.PATH = `${fakeBin}:${oldPath ?? ''}`;
      resumed = await runGraph(graphPath, { resumeRunId: first.runId, fromNodeId: 'cutoff',
        releaseCommandSource: { root: checkoutAlias, cutTip: cut }, deps: { root } });
    } finally { process.env.PATH = oldPath; }
    const output = String(resumed.nodes.find((node) => node.nodeId === 'cutoff')?.output ?? '');
    expect(output).toContain(realpathSync(checkout));
    expect(output).toContain('cut recipe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Real git against the temporary OP seat (hermetic: no system/global config, identity passed inline). */
function seatGit(seat: string, ...args: string[]): string {
  const out = spawnSync('git', ['-c', 'user.name=seat-test', '-c', 'user.email=seat-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd: seat, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: seat, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`);
  return out.stdout.trim();
}

/** One OP-seat mutation as the real paths do it — work file, index, HEAD — recording when it entered and left. */
async function mutateSeat(seat: string, label: string, spans: Array<{ label: string; enter: number; exit: number }>, hold?: Promise<void>): Promise<string> {
  const enter = performance.now();
  writeFileSync(join(seat, 'workfile'), `work-${label}\n`);
  seatGit(seat, 'add', 'workfile');
  seatGit(seat, 'commit', '-q', '-m', label);
  if (hold) await hold;
  spans.push({ label, enter, exit: performance.now() });
  return seatGit(seat, 'rev-parse', 'HEAD');
}

test('out-of-window manual resume and resync started together serialize on one OP-seat flock over a real git seat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'resume-resync-flock-'));
  setElanousConfigDir(root);
  const seat = join(root, 'op-seat');
  mkdirSync(seat, { recursive: true });
  seatGit(seat, 'init', '-q');
  writeFileSync(join(seat, 'workfile'), 'work-v1\n');
  seatGit(seat, 'add', 'workfile');
  seatGit(seat, 'commit', '-q', '-m', 'base');
  const base = seatGit(seat, 'rev-parse', 'HEAD');
  const { statePath, original } = writeFailedRun(root);
  try {
    const spans: Array<{ label: string; enter: number; exit: number }> = [];
    let resumeHead = '';
    let resyncHead = '';
    let resumeEntered = false;
    let resyncEntered = false;
    let releaseResume!: () => void;
    const resumeHeld = new Promise<void>((resolve) => { releaseResume = resolve; });
    // No injected root on either side: both resolve the lock through the shared OP-seat root (here the --config-dir universe).
    const resume = resumeReleaseRun({ runId: 'r', from: 'tui' }, {
      git: gitStub,
      isAncestor: () => true,
      graph: async () => {
        resumeEntered = true;
        resumeHead = await mutateSeat(seat, 'resume', spans, resumeHeld);
        return { status: 'done', runId: 'r' } as never;
      },
    });
    while (!resumeEntered) await Bun.sleep(5);
    const resync = resyncTickWithReleaseProbe(async () => {
      resyncEntered = true;
      resyncHead = await mutateSeat(seat, 'resync', spans);
      return { candidates: 1, tried: 1, saved: 1, savedRatio: 1 };
    }, () => {}, join(root, 'steward', 'resync-pending.json'), () => 'idle', () => 'outside');
    await Bun.sleep(150);
    // While resume holds the lock, resync has not entered and the seat shows exactly resume's commit with a clean index.
    expect(resyncEntered).toBe(false);
    expect(seatGit(seat, 'log', '--format=%s')).toBe('resume\nbase');
    expect(seatGit(seat, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(seat, 'workfile'), 'utf8')).toBe('work-resume\n');
    releaseResume();
    const [resumed, resynced] = await Promise.all([resume, resync]);
    expect(resumed.state.status).toBe('done');
    expect(resynced.decision).toBe('ran');
    // The critical sections never overlapped: resync entered only after resume left.
    expect(spans.map((span) => span.label)).toEqual(['resume', 'resync']);
    expect(spans[1]!.enter).toBeGreaterThanOrEqual(spans[0]!.exit);
    // Final git state: linear history base → resume → resync, HEAD = resync's commit, index and work tree clean.
    expect(seatGit(seat, 'rev-parse', `${resumeHead}^`)).toBe(base);
    expect(seatGit(seat, 'rev-parse', `${resyncHead}^`)).toBe(resumeHead);
    expect(seatGit(seat, 'rev-parse', 'HEAD')).toBe(resyncHead);
    expect(seatGit(seat, 'log', '--format=%s')).toBe('resync\nresume\nbase');
    expect(seatGit(seat, 'diff', '--cached', '--name-only')).toBe('');
    expect(seatGit(seat, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(seat, 'workfile'), 'utf8')).toBe('work-resync\n');
    const after = await acquireOpSeatFlock(undefined, 1_000);
    expect(after.path).toBe(opSeatFlockPath(root));
    after.release();
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ graphId: 'release-loop', runId: 'r' });
    expect(original.length).toBeGreaterThan(0);
  } finally {
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a resume with an injected ledger root different from the OP-seat root still excludes a default-root resync', async () => {
  const seatRoot = mkdtempSync(join(tmpdir(), 'resume-seat-'));
  const ledger = mkdtempSync(join(tmpdir(), 'resume-ledger-'));
  setElanousConfigDir(seatRoot);
  configureTraffic(seatRoot);
  writeFailedRun(ledger);
  try {
    let resumeEntered = false;
    let resyncEntered = false;
    let releaseResume!: () => void;
    const resumeHeld = new Promise<void>((resolve) => { releaseResume = resolve; });
    const resume = resumeReleaseRun({ runId: 'r', from: 'tui' }, {
      root: ledger,
      git: gitStub,
      isAncestor: () => true,
      graph: async () => { resumeEntered = true; await resumeHeld; return { status: 'done', runId: 'r' } as never; },
    });
    while (!resumeEntered) await Bun.sleep(5);
    // The lock lives at the OP-seat root, not under the injected ledger root.
    await expect(acquireOpSeatFlock(undefined, 60)).rejects.toThrow('OP seat flock timed out');
    const resync = resyncTickWithReleaseProbe(async () => { resyncEntered = true; return { candidates: 0, tried: 0, saved: 0, savedRatio: null }; },
      () => {}, join(seatRoot, 'steward', 'resync-pending.json'), () => 'idle', () => 'outside');
    await Bun.sleep(100);
    expect(resyncEntered).toBe(false);
    releaseResume();
    const [resumed, resynced] = await Promise.all([resume, resync]);
    expect(resumed.state.status).toBe('done');
    expect(resynced.decision).toBe('ran');
    expect(resyncEntered).toBe(true);
    expect(existsSync(join(ledger, 'steward', 'op-seat.flock'))).toBe(false);
  } finally {
    resetElanousConfigDir();
    rmSync(seatRoot, { recursive: true, force: true });
    rmSync(ledger, { recursive: true, force: true });
  }
});

/** MS-02 stage: one release 9.9.9 run whose gate failed, saved in the isolated test universe. */
const RECOVER_VERSION = '9.9.9';

function writeRecoverRun(root: string, runId: string, cut: string): { statePath: string; original: string } {
  const statePath = join(root, 'graph-runs', 'release-loop', `${runId}.json`);
  mkdirSync(join(root, 'graph-runs', 'release-loop'), { recursive: true });
  configureTraffic(root);
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const recipesPath = join(import.meta.dir, '../../graphs/release/recipes.yaml');
  const state = {
    graphId: 'release-loop', runId, status: 'failed',
    graphSnapshot: {
      graphSha: createHash('sha256').update(readFileSync(graphPath)).digest('hex'),
      recipesSha: createHash('sha256').update(readFileSync(recipesPath)).digest('hex'),
    },
    input: { version: RECOVER_VERSION, branchCut: true },
    path: ['version-release', 'export-check', 'gate', 'failed'],
    nodes: [
      { nodeId: 'version-release', ok: true, exit: 0, executed: true, output: JSON.stringify({ outcome: 'ok', version: RECOVER_VERSION, commit: cut, branch: `release/${RECOVER_VERSION}` }) },
      { nodeId: 'export-check', ok: true, exit: 0, executed: true, output: '{"outcome":"ok"}' },
      { nodeId: 'gate', ok: false, exit: 1, executed: true, output: '{"outcome":"fail"}' },
      { nodeId: 'failed', ok: true, exit: 0, executed: false },
    ],
    executed: 3, dryRun: false, statePath,
  };
  writeFileSync(statePath, JSON.stringify(state));
  return { statePath, original: readFileSync(statePath, 'utf8') };
}

/** The repair seat: a bare origin carrying main ⊕ release/9.9.9, and one fix commit on main to pick. */
function buildRecoverSeat(root: string): { work: string; origin: string; cut: string; pick: string } {
  const origin = join(root, 'origin.git');
  mkdirSync(origin, { recursive: true });
  seatGit(origin, 'init', '--bare', '-q');
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  seatGit(work, 'init', '-q');
  seatGit(work, 'checkout', '-q', '-b', 'main');
  seatGit(work, 'remote', 'add', 'origin', origin);
  // The real `cutReleaseBranch` append cherry-picks in a temporary worktree with a plain env: the identity has
  // to live in the repo config (seatGit's inline -c never reaches it) for the real push path to commit.
  seatGit(work, 'config', 'user.name', 'release-loop test');
  seatGit(work, 'config', 'user.email', 'release-loop@test.invalid');
  seatGit(work, 'config', 'commit.gpgsign', 'false');
  // The pod's global git config points core.hooksPath at a push guard that refuses refs/heads/release/<v>,
  // and the real `cutReleaseBranch` push runs with the process env — the global config reaches it. The seat
  // pushes only to its own throwaway bare origin, so the repo config points hooks at an empty directory;
  // the guard stays in force for the real checkout, which never routes through this fixture.
  const noHooks = join(root, 'no-hooks');
  mkdirSync(noHooks, { recursive: true });
  seatGit(work, 'config', 'core.hooksPath', noHooks);
  seatGit(origin, 'config', 'core.hooksPath', noHooks);
  mkdirSync(join(work, 'graphs', 'release'), { recursive: true });
  for (const file of ['release-loop.yaml', 'recipes.yaml'])
    copyFileSync(join(import.meta.dir, '../../graphs/release', file), join(work, 'graphs', 'release', file));
  mkdirSync(join(work, 'node_modules'), { recursive: true });
  mkdirSync(join(work, 'apps', 'pwa', 'node_modules'), { recursive: true });
  writeFileSync(join(work, 'node_modules', '.fixture'), 'test fixture\n');
  writeFileSync(join(work, 'apps', 'pwa', 'node_modules', '.fixture'), 'test fixture\n');
  writeFileSync(join(work, 'package.json'), `{"version":"${RECOVER_VERSION}"}\n`);
  seatGit(work, 'add', 'package.json', 'graphs/release/release-loop.yaml', 'graphs/release/recipes.yaml');
  seatGit(work, 'add', '-f', 'node_modules/.fixture', 'apps/pwa/node_modules/.fixture');
  seatGit(work, 'commit', '-q', '-m', `cut ${RECOVER_VERSION}`);
  const cut = seatGit(work, 'rev-parse', 'HEAD');
  seatGit(work, 'push', '-q', 'origin', 'main');
  seatGit(work, 'push', '-q', 'origin', `main:refs/heads/release/${RECOVER_VERSION}`);
  writeFileSync(join(work, 'fix.txt'), 'fix\n');
  seatGit(work, 'add', 'fix.txt');
  seatGit(work, 'commit', '-q', '-m', `fix for ${RECOVER_VERSION}`);
  const pick = seatGit(work, 'rev-parse', 'HEAD');
  seatGit(work, 'push', '-q', 'origin', 'main');
  return { work, origin, cut, pick };
}

/** The production dispatch: `release recover` as registerReleaseCommands wires it, JSON read back from stdout. */
async function invokeRecover(args: string[], deps: RecoverReleaseDeps): Promise<{
  ok: boolean; error?: string;
  stages: Array<{ stage: string; outcome: string; commit?: string | null; from?: string; gatePlan?: string; reason?: string }>;
}> {
  const lines: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((value: string | Uint8Array) => { lines.push(String(value).trim()); return true; }) as typeof process.stdout.write;
  try {
    process.exitCode = 0;
    const cmd = new Command();
    registerReleaseCommands(cmd, {}, {}, {}, {}, {}, deps);
    await cmd.parseAsync(['release', 'recover', ...args, '--json'], { from: 'user' });
    return JSON.parse(lines.at(-1)!) as never;
  } finally { process.stdout.write = write; }
}

test('RELEASE-RECOVER-ONE-CMD: one recover appends the repair with the real cutReleaseBranch push and reaches the resume plan from its own tip checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-recover-one-cmd-'));
  setElanousConfigDir(root);
  const previousExit = process.exitCode;
  const seat = buildRecoverSeat(root);
  const saved = writeRecoverRun(root, 'r', seat.cut);
  const graphCalls: Array<{ fromNodeId?: string; cutTip?: string }> = [];
  try {
    // No fake cutBranch and no --command-root (GOODHART): stages 1-2 are the real `release cut-branch --append`
    // — the dry-run plans the fast-forward, the append cherry-picks in a temporary worktree and pushes the
    // bare origin for real (a local push to refs/heads/release/* works here). Stage 3 then needs a checkout
    // whose HEAD is the appended tip, and the operator checkout never moves: recover must prepare its own
    // temporary checkout, or production would stop with «differs from cut tip».
    const result = await invokeRecover(['--run', 'r', '--pick', seat.pick, '--repo-root', seat.work, '--no-partial'],
      { root, repo: seat.work, graph: async (_path, options) => {
        graphCalls.push({ ...(options?.fromNodeId === undefined ? {} : { fromNodeId: options.fromNodeId }),
          ...(options?.releaseCommandSource?.cutTip === undefined ? {} : { cutTip: options.releaseCommandSource.cutTip }) });
        return { status: 'done', runId: 'r' } as never;
      } });
    expect(result.ok).toBe(true);
    expect(process.exitCode).toBe(0);
    // The three stages ran in this order, and the first only planned the append.
    expect(result.stages.map((stage) => stage.stage)).toEqual(['append-dry-run', 'append', 'resume']);
    expect(result.stages.map((stage) => stage.outcome)).toEqual(['ok', 'ok', 'ok']);
    // The repair reached origin through the real push: release/9.9.9 moved to a tip that carries the picked fix.
    const tip = seatGit(seat.origin, 'rev-parse', `refs/heads/release/${RECOVER_VERSION}`);
    expect(tip).not.toBe(seat.cut);
    expect(seatGit(seat.origin, 'show', `${tip}:fix.txt`)).toBe('fix');
    expect((JSON.parse(seatGit(seat.origin, 'show', `${tip}:package.json`)) as { version: string }).version).toBe(RECOVER_VERSION);
    expect(result.stages[1]!.commit).toBe(tip);
    // The resume stage is ok without any fake checkout, and the graph ran from the origin tip (GOODHART evidence).
    expect(result.stages[2]).toMatchObject({ from: 'export-check', gatePlan: 'full', commit: tip });
    expect(graphCalls).toEqual([{ fromNodeId: 'export-check', cutTip: tip }]);
    // The saved run names the repaired commit and keeps the previous one as refreshedFrom.
    const run = JSON.parse(readFileSync(saved.statePath, 'utf8')) as { nodes: Array<{ nodeId: string; output: string }> };
    expect(JSON.parse(run.nodes.find((node) => node.nodeId === 'version-release')!.output.trim().split('\n').at(-1)!))
      .toMatchObject({ commit: tip, refreshedFrom: seat.cut });
    // The attempt ledger keeps its format (attempts of timestamps) and gains the per-stage results.
    const ledger = JSON.parse(readFileSync(join(root, 'release', RECOVER_VERSION, 'resume-attempts', 'r.json'), 'utf8')) as
      { version: string; runId: string; priorCountKnown: boolean; attempts: string[]; recoveries: Array<{ stage: string; outcome: string }> };
    expect(ledger).toMatchObject({ version: RECOVER_VERSION, runId: 'r', priorCountKnown: true });
    expect(ledger.attempts).toHaveLength(1);
    expect(ledger.attempts.every((at) => Number.isFinite(Date.parse(at)))).toBe(true);
    expect(ledger.recoveries.map((stage) => [stage.stage, stage.outcome]))
      .toEqual([['append-dry-run', 'ok'], ['append', 'ok'], ['resume', 'ok']]);
  } finally {
    process.exitCode = previousExit ?? 0;
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('RELEASE-RECOVER-ONE-CMD: a failing stage stops the command — the later stages never run and the ledger keeps the failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-recover-stop-'));
  setElanousConfigDir(root);
  const previousExit = process.exitCode;
  const cut = 'a'.repeat(40);
  const pick = 'b'.repeat(40);
  const saved = writeRecoverRun(root, 'r', cut);
  const cutCalls: Array<{ append?: boolean; dryRun?: boolean }> = [];
  let graphCalls = 0;
  const cutBranch = (options: CutBranchOptions) => {
    cutCalls.push({ ...(options.append === undefined ? {} : { append: options.append }), ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }) });
    if (options.dryRun !== true) throw new Error(`release/${RECOVER_VERSION} remote tip moved — fast-forward refused (no force push)`);
    return { branch: `release/${RECOVER_VERSION}`, commit: null, dryRun: true };
  };
  try {
    const result = await invokeRecover(['--run', 'r', '--pick', pick, '--repo-root', root],
      { root, cutBranch, graph: async () => { graphCalls++; return { status: 'done', runId: 'r' } as never; } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('append 단계에서 멈췄다');
    expect(result.error).toContain('resume 단계는 실행하지 않았다');
    expect(process.exitCode).toBe(1);
    // The dry-run ran, the append failed, and the resume was never reached.
    expect(cutCalls).toEqual([{ append: true, dryRun: true }, { append: true }]);
    expect(graphCalls).toBe(0);
    const ledger = JSON.parse(readFileSync(join(root, 'release', RECOVER_VERSION, 'resume-attempts', 'r.json'), 'utf8')) as
      { attempts: string[]; recoveries: Array<{ stage: string; outcome: string; reason?: string }> };
    expect(ledger.recoveries.map((stage) => [stage.stage, stage.outcome])).toEqual([['append-dry-run', 'ok'], ['append', 'failed']]);
    expect(ledger.recoveries[1]!.reason).toContain('fast-forward refused');
    // A stopped recovery consumes no resume attempt and leaves the saved run untouched.
    expect(ledger.attempts).toEqual([]);
    expect(readFileSync(saved.statePath, 'utf8')).toBe(saved.original);
  } finally {
    process.exitCode = previousExit ?? 0;
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('RELEASE-RECOVER-PREFLIGHT: a run the resume would refuse never moves release/<v> — the refusals are read-only before the append', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-recover-preflight-'));
  setElanousConfigDir(root);
  const previousExit = process.exitCode;
  const seat = buildRecoverSeat(root);
  writeRecoverRun(root, 'r', seat.cut);
  const cutCalls: Array<{ append?: boolean; dryRun?: boolean }> = [];
  const cutBranch = (options: CutBranchOptions) => {
    cutCalls.push({ ...(options.append === undefined ? {} : { append: options.append }), ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }) });
    throw new Error('append must not run for a refused run');
  };
  const refuse = async (args: string[]) => invokeRecover(args,
    { root, repo: seat.work, cutBranch, graph: async () => ({ status: 'done', runId: 'r' }) as never });
  const statePath = join(root, 'graph-runs', 'release-loop', 'r.json');
  const branchAt = (): string => seatGit(seat.origin, 'rev-parse', `refs/heads/release/${RECOVER_VERSION}`);
  try {
    // A finished run is refused before any append — the branch stays on the cut.
    writeFileSync(statePath, JSON.stringify({ ...(JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>), status: 'done' }));
    let refused = await refuse(['--run', 'r', '--pick', seat.pick, '--repo-root', seat.work, '--no-partial']);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('is done — only a failed run is recovered; release/9.9.9 was not moved');
    expect(branchAt()).toBe(seat.cut);
    // A --from later than export-check is refused the same read-only way.
    writeFileSync(statePath, JSON.stringify({ ...(JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>), status: 'failed' }));
    refused = await refuse(['--run', 'r', '--pick', seat.pick, '--from', 'gate', '--repo-root', seat.work, '--no-partial']);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('--from gate is later than export-check');
    expect(refused.error).toContain('was not moved');
    // A --from that is not on the saved path is refused too.
    refused = await refuse(['--run', 'r', '--pick', seat.pick, '--from', 'tui', '--repo-root', seat.work, '--no-partial']);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('--from tui is not a node on the saved path of r');
    // Every refusal happened before the append: no stage ran, no ledger was written, the branch never moved.
    expect(cutCalls).toEqual([]);
    expect(branchAt()).toBe(seat.cut);
    expect(existsSync(join(root, 'release', RECOVER_VERSION, 'resume-attempts', 'r.json'))).toBe(false);
  } finally {
    process.exitCode = previousExit ?? 0;
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('RELEASE-RECOVER-REENTRY: a second recover with the same --pick reads the ledger append-ok and resumes without appending again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-recover-reentry-'));
  setElanousConfigDir(root);
  const previousExit = process.exitCode;
  const seat = buildRecoverSeat(root);
  writeRecoverRun(root, 'r', seat.cut);
  const args = ['--run', 'r', '--pick', seat.pick, '--repo-root', seat.work, '--no-partial'];
  const graphCalls: Array<{ fromNodeId?: string; cutTip?: string }> = [];
  try {
    // First recover: the append lands on origin for real, then the resume stage fails (the graph explodes) and stops.
    const first = await invokeRecover(args, { root, repo: seat.work, graph: async () => { throw new Error('gate exploded'); } });
    expect(first.ok).toBe(false);
    expect(first.error).toContain('resume 단계에서 멈췄다');
    expect(first.stages.map((stage) => [stage.stage, stage.outcome]))
      .toEqual([['append-dry-run', 'ok'], ['append', 'ok'], ['resume', 'failed']]);
    const tip = seatGit(seat.origin, 'rev-parse', `refs/heads/release/${RECOVER_VERSION}`);
    expect(tip).not.toBe(seat.cut);
    // Second recover with the same --pick: the ledger already carries the append-ok at the branch tip, so
    // cut-branch's «pick … is already in release/9.9.9» refusal is never reached — only the resume runs again.
    const second = await invokeRecover(args, { root, repo: seat.work, graph: async (_path, options) => {
      graphCalls.push({ ...(options?.fromNodeId === undefined ? {} : { fromNodeId: options.fromNodeId }),
        ...(options?.releaseCommandSource?.cutTip === undefined ? {} : { cutTip: options.releaseCommandSource.cutTip }) });
      return { status: 'done', runId: 'r' } as never;
    } });
    expect(second.ok).toBe(true);
    expect(second.stages.map((stage) => stage.stage)).toEqual(['resume']);
    expect(second.stages.map((stage) => stage.outcome)).toEqual(['ok']);
    expect(second.stages[0]).toMatchObject({ from: 'export-check', commit: tip });
    // The branch was not appended twice: origin still ends at the first recover's tip, and the graph ran from it.
    expect(seatGit(seat.origin, 'rev-parse', `refs/heads/release/${RECOVER_VERSION}`)).toBe(tip);
    expect(graphCalls).toEqual([{ fromNodeId: 'export-check', cutTip: tip }]);
    // The ledger keeps the first recover's stages and gains only the second resume.
    const ledger = JSON.parse(readFileSync(join(root, 'release', RECOVER_VERSION, 'resume-attempts', 'r.json'), 'utf8')) as
      { attempts: string[]; recoveries: Array<{ stage: string; outcome: string; commit?: string }> };
    expect(ledger.recoveries.map((stage) => [stage.stage, stage.outcome]))
      .toEqual([['append-dry-run', 'ok'], ['append', 'ok'], ['resume', 'failed'], ['resume', 'ok']]);
    expect(ledger.recoveries[1]!.commit).toBe(tip);
    expect(ledger.attempts).toHaveLength(2);
  } finally {
    process.exitCode = previousExit ?? 0;
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('RELEASE-RECOVER-REENTRY: a second recover with a different --pick appends the new repair — the old append-ok never skips it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-recover-reentry-diff-pick-'));
  setElanousConfigDir(root);
  const previousExit = process.exitCode;
  const seat = buildRecoverSeat(root);
  // A second, different repair on main: the operator re-picks this one after the first resume failed.
  writeFileSync(join(seat.work, 'fix2.txt'), 'fix2\n');
  seatGit(seat.work, 'add', 'fix2.txt');
  seatGit(seat.work, 'commit', '-q', '-m', `fix2 for ${RECOVER_VERSION}`);
  const pick2 = seatGit(seat.work, 'rev-parse', 'HEAD');
  seatGit(seat.work, 'push', '-q', 'origin', 'main');
  writeRecoverRun(root, 'r', seat.cut);
  const graphCalls: Array<{ fromNodeId?: string; cutTip?: string }> = [];
  try {
    // First recover with --pick A: the append lands on origin for real, then the resume stage fails and stops.
    const first = await invokeRecover(['--run', 'r', '--pick', seat.pick, '--repo-root', seat.work, '--no-partial'],
      { root, repo: seat.work, graph: async () => { throw new Error('gate exploded'); } });
    expect(first.ok).toBe(false);
    expect(first.stages.map((stage) => [stage.stage, stage.outcome]))
      .toEqual([['append-dry-run', 'ok'], ['append', 'ok'], ['resume', 'failed']]);
    const tipA = seatGit(seat.origin, 'rev-parse', `refs/heads/release/${RECOVER_VERSION}`);
    // The ledger's append-ok names the pick list it appended.
    const ledgerAfter = JSON.parse(readFileSync(join(root, 'release', RECOVER_VERSION, 'resume-attempts', 'r.json'), 'utf8')) as
      { recoveries: Array<{ stage: string; outcome: string; pick?: string[] }> };
    expect(ledgerAfter.recoveries[1]).toMatchObject({ stage: 'append', outcome: 'ok', pick: [seat.pick] });
    // Second recover with --pick B: the ledger append-ok is for A, not B — B must be appended onto A's tip
    // and pushed, not skipped as a re-entry.
    const second = await invokeRecover(['--run', 'r', '--pick', pick2, '--repo-root', seat.work, '--no-partial'],
      { root, repo: seat.work, graph: async (_path, options) => {
        graphCalls.push({ ...(options?.fromNodeId === undefined ? {} : { fromNodeId: options.fromNodeId }),
          ...(options?.releaseCommandSource?.cutTip === undefined ? {} : { cutTip: options.releaseCommandSource.cutTip }) });
        return { status: 'done', runId: 'r' } as never;
      } });
    expect(second.ok).toBe(true);
    expect(second.stages.map((stage) => stage.stage)).toEqual(['append-dry-run', 'append', 'resume']);
    expect(second.stages.map((stage) => stage.outcome)).toEqual(['ok', 'ok', 'ok']);
    const tipB = seatGit(seat.origin, 'rev-parse', `refs/heads/release/${RECOVER_VERSION}`);
    expect(tipB).not.toBe(tipA);
    // The new repair reached origin through the real push, on top of the first one.
    expect(seatGit(seat.origin, 'show', `${tipB}:fix.txt`)).toBe('fix');
    expect(seatGit(seat.origin, 'show', `${tipB}:fix2.txt`)).toBe('fix2');
    expect(second.stages[1]!.commit).toBe(tipB);
    // The graph resumed from the new tip, and the run names it.
    expect(graphCalls).toEqual([{ fromNodeId: 'export-check', cutTip: tipB }]);
    const ledger = JSON.parse(readFileSync(join(root, 'release', RECOVER_VERSION, 'resume-attempts', 'r.json'), 'utf8')) as
      { attempts: string[]; recoveries: Array<{ stage: string; outcome: string; commit?: string; pick?: string[] }> };
    expect(ledger.recoveries.map((stage) => [stage.stage, stage.outcome]))
      .toEqual([['append-dry-run', 'ok'], ['append', 'ok'], ['resume', 'failed'], ['append-dry-run', 'ok'], ['append', 'ok'], ['resume', 'ok']]);
    expect(ledger.recoveries[4]).toMatchObject({ stage: 'append', outcome: 'ok', commit: tipB, pick: [pick2] });
    expect(ledger.attempts).toHaveLength(2);
  } finally {
    process.exitCode = previousExit ?? 0;
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('RELEASE-RECOVER-REENTRY: a repair the branch already carries stops with the direct-resume guidance in the error and the ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-recover-already-in-'));
  setElanousConfigDir(root);
  const previousExit = process.exitCode;
  const seat = buildRecoverSeat(root);
  writeRecoverRun(root, 'r', seat.cut);
  // A hand-run append already fast-forwarded release/9.9.9 to the pick — no recover ledger exists for it.
  seatGit(seat.work, 'push', '-q', 'origin', `${seat.pick}:refs/heads/release/${RECOVER_VERSION}`);
  const cutCalls: Array<{ append?: boolean; dryRun?: boolean }> = [];
  const cutBranch = (options: CutBranchOptions) => {
    cutCalls.push({ ...(options.append === undefined ? {} : { append: options.append }), ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }) });
    return { branch: `release/${RECOVER_VERSION}`, commit: null, dryRun: true };
  };
  try {
    const result = await invokeRecover(['--run', 'r', '--pick', seat.pick, '--repo-root', seat.work, '--no-partial'],
      { root, repo: seat.work, cutBranch, graph: async () => ({ status: 'done', runId: 'r' }) as never });
    expect(result.ok).toBe(false);
    // The human's next step is named in the stop error and in the ledger: resume directly, nothing was appended.
    expect(result.error).toContain('is already in release/9.9.9');
    expect(result.error).toContain('release resume --run r --from export-check');
    expect(result.error).toContain('append · resume 단계는 실행하지 않았다');
    expect(cutCalls).toEqual([]);
    expect(seatGit(seat.origin, 'rev-parse', `refs/heads/release/${RECOVER_VERSION}`)).toBe(seat.pick);
    const ledger = JSON.parse(readFileSync(join(root, 'release', RECOVER_VERSION, 'resume-attempts', 'r.json'), 'utf8')) as
      { attempts: string[]; recoveries: Array<{ stage: string; outcome: string; reason?: string }> };
    expect(ledger.recoveries.map((stage) => [stage.stage, stage.outcome])).toEqual([['append-dry-run', 'failed']]);
    expect(ledger.recoveries[0]!.reason).toContain('release resume --run r --from export-check');
    expect(ledger.attempts).toEqual([]);
  } finally {
    process.exitCode = previousExit ?? 0;
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
