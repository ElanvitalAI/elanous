import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { acquireOpSeatFlock, opSeatFlockPath, resyncTickWithReleaseProbe } from '../../src/steward/resync-tick.js';
import { planResumeReleaseRun, resumeReleaseRun } from './resume-release.js';
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
