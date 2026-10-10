import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseVersion, isReleaseVersion, nextPrereleaseVersion, prereleaseKind } from './release-version.js';
import { cutReleaseBranchForRun, main as versionNode, nextDevVersion } from './version-node.js';
import { cutReleaseBranch } from './cut-branch.js';
import { refreshReleaseBranchTip, resumeReleaseRun } from './resume-release.js';
import { labelPrerelease } from './publish-node.js';
import { parseOptions as gateOptions } from './gate-node.js';

// RELEASE-BRANCH ⊕ RELEASE-REHEARSAL-RC (10-06): real git against a temporary bare origin; install is injected and
// nothing is published.
setDefaultTimeout(60_000);

const GIT_ENV = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
const saved: Partial<Record<(typeof GIT_ENV)[number], string | undefined>> = {};
let home = '';

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'release-branch-home-')));
  writeFileSync(join(home, 'gitconfig'), '[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
  for (const key of GIT_ENV) saved[key] = process.env[key];
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
});
afterAll(() => {
  for (const key of GIT_ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  rmSync(home, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function writeVersion(tree: string, version: string): void {
  writeFileSync(join(tree, 'package.json'), `${JSON.stringify({ name: 'fixture', version }, null, 2)}\n`);
  writeFileSync(join(tree, 'bun.lock'), JSON.stringify({ workspaces: { '': { name: 'fixture', version, dependencies: {} } } }));
}

/** A bare origin, a seat clone that lands on main, and the release checkout the node runs in. */
function fixture(mainVersion = '0.2.18-dev.3') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-branch-')));
  const origin = join(root, 'origin.git');
  git(root, 'init', '--bare', '-b', 'main', origin);
  const seat = join(root, 'seat');
  git(root, 'clone', origin, seat);
  writeVersion(seat, mainVersion);
  mkdirSync(join(seat, 'src'));
  writeFileSync(join(seat, 'src', 'a.ts'), 'export const a = 1;\n');
  git(seat, 'add', '-A');
  git(seat, 'commit', '-m', 'seed');
  git(seat, 'push', 'origin', 'HEAD:main');
  const repo = join(root, 'release');
  git(root, 'clone', origin, repo);
  const land = (file: string, body: string) => {
    git(seat, 'pull', '--ff-only', 'origin', 'main');
    writeFileSync(join(seat, 'src', file), body);
    git(seat, 'add', '-A');
    git(seat, 'commit', '-m', `land ${file}`);
    git(seat, 'push', 'origin', 'HEAD:main');
    return git(seat, 'rev-parse', 'HEAD');
  };
  const versionOn = (ref: string) => (JSON.parse(git(origin, 'show', `${ref}:package.json`)) as { version: string }).version;
  return { root, origin, seat, repo, land, versionOn, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('release versions: stable or rc/alpha/beta; the next free prerelease number comes from branches and tags', () => {
  for (const ok of ['0.2.18', '0.2.18-rc.0', '1.0.0-beta.12', '0.2.18-alpha.3']) expect(isReleaseVersion(ok)).toBe(true);
  for (const bad of ['0.2.18-dev.1', '0.2.18-rc', '0.2.18-rc.01', '00.2.18', 'v0.2.18', '0.2.18-rc.1/x']) expect(isReleaseVersion(bad)).toBe(false);
  expect(baseVersion('0.2.18-rc.4')).toBe('0.2.18');
  expect(prereleaseKind('0.2.18')).toBeNull();
  expect(prereleaseKind('0.2.18-beta.1')).toBe('beta');
  expect(nextPrereleaseVersion('0.2.18', 'rc', [])).toBe('0.2.18-rc.0');
  expect(nextPrereleaseVersion('0.2.18', 'rc', ['release/0.2.18-rc.0', 'refs/tags/v0.2.18-rc.3^{}', 'v0.2.18-beta.9', 'release/0.2.181-rc.7'])).toBe('0.2.18-rc.4');
  expect(() => nextPrereleaseVersion('0.2.18-rc.0', 'rc', [])).toThrow('x.y.z');
  expect(nextDevVersion('0.2.18-rc.2')).toBe('0.2.19-dev.0');
});

test('RELEASE-BRANCH: the bump lands only on release/<v>; main keeps -dev.N and a later main landing never moves the cut', () => {
  const f = fixture();
  try {
    const installs: string[] = [];
    const mainAtCut = git(f.origin, 'rev-parse', 'main');
    const cut = cutReleaseBranchForRun(f.repo, '0.2.18', { install: (tree) => { installs.push(tree); }, freeze: () => null });
    expect(cut).toMatchObject({ outcome: 'ok', kind: 'release', version: '0.2.18', branch: 'release/0.2.18', base: mainAtCut });
    expect(installs).toHaveLength(1);
    expect(git(f.origin, 'rev-parse', 'release/0.2.18')).toBe(cut.commit!);
    expect(f.versionOn('release/0.2.18')).toBe('0.2.18');
    expect(git(f.origin, 'rev-parse', `${cut.commit}^`)).toBe(mainAtCut);
    expect(f.versionOn('main')).toBe('0.2.18-dev.3');
    expect(git(f.origin, 'rev-parse', 'main')).toBe(mainAtCut);
    expect(git(f.origin, 'log', '-1', '--format=%s', 'release/0.2.18')).toBe('release: 0.2.18');
    // main keeps landing during the run; a re-run (resume) reuses the branch tip, not main HEAD.
    f.land('b.ts', 'export const b = 2;\n');
    const again = cutReleaseBranchForRun(f.repo, '0.2.18', { install: () => { throw new Error('must not install again'); }, freeze: () => null });
    expect(again).toMatchObject({ outcome: 'ok', commit: cut.commit, existing: true });
    expect(git(f.repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    // A same-named branch from another history (fork point not on this -dev line) is not adopted.
    const stray = join(f.root, 'stray');
    git(f.root, 'init', '-b', 'main', stray);
    writeVersion(stray, '0.2.19');
    git(stray, 'add', '-A');
    git(stray, 'commit', '-m', 'stray');
    git(stray, 'push', f.origin, 'HEAD:refs/heads/release/0.2.19');
    expect(() => cutReleaseBranchForRun(f.repo, '0.2.19', { install: () => {}, freeze: () => null })).toThrow();
  } finally { f.done(); }
});

test('RELEASE-BRANCH: a repair appended with cut-branch --append becomes the tip a resumed run reads', () => {
  const f = fixture();
  try {
    const cut = cutReleaseBranchForRun(f.repo, '0.2.18', { install: () => {}, freeze: () => null });
    const fix = f.land('fix.ts', 'export const fix = true;\n');
    cutReleaseBranch({ version: '0.2.18', base: cut.base!, pick: [fix], append: true, repoRoot: f.repo, log: () => {} });
    const tip = git(f.origin, 'rev-parse', 'release/0.2.18');
    expect(tip).not.toBe(cut.commit);
    expect(git(f.origin, 'show', `${tip}:src/fix.ts`)).toBe('export const fix = true;');
    expect(f.versionOn('main')).toBe('0.2.18-dev.3');
    expect(cutReleaseBranchForRun(f.repo, '0.2.18', { install: () => {}, freeze: () => null })).toMatchObject({ commit: tip, existing: true });

    // The failed run's saved version-release output is re-pointed (fast-forward only, backed up).
    const state = join(f.root, 'state');
    const runFile = join(state, 'graph-runs', 'release-loop', 'run-1.json');
    mkdirSync(join(state, 'graph-runs', 'release-loop'), { recursive: true });
    const recorded = { outcome: 'ok', kind: 'release', version: '0.2.18', commit: cut.commit, pr: null, branch: 'release/0.2.18' };
    writeFileSync(runFile, JSON.stringify({ graphId: 'release-loop', runId: 'run-1', status: 'failed', input: { version: '0.2.18', branchCut: true }, path: ['version-release', 'cutoff', 'gate'],
      nodes: [{ nodeId: 'version-release', ok: true, exit: 0, executed: true, output: `log line\n${JSON.stringify(recorded)}\n` },
        { nodeId: 'cutoff', ok: true, exit: 0, executed: true, output: '{"outcome":"ok"}' }, { nodeId: 'gate', ok: false, exit: 1, executed: true, output: '{"outcome":"fail"}' }],
      executed: 3, dryRun: false, statePath: runFile }));
    const refreshed = refreshReleaseBranchTip('run-1', { root: state, repo: f.repo });
    expect(refreshed).toMatchObject({ changed: true, from: cut.commit, to: tip, branch: 'release/0.2.18' });
    expect(JSON.parse(readFileSync(refreshed.backup!, 'utf8')).nodes[0].output).toContain(cut.commit!);
    const after = JSON.parse(readFileSync(runFile, 'utf8')) as { nodes: Array<{ output: string }> };
    const last = JSON.parse(after.nodes[0]!.output.trim().split('\n').at(-1)!) as { commit: string; refreshedFrom: string };
    expect([last.commit, last.refreshedFrom]).toEqual([tip, cut.commit!]);
    expect(refreshReleaseBranchTip('run-1', { root: state, repo: f.repo })).toMatchObject({ changed: false, to: tip });
  } finally { f.done(); }
});

test('RELEASE-BRANCH resume refuses a non-fast-forward tip, a run that is not failed, and a restart at version-release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resume-'));
  try {
    const runFile = join(root, 'graph-runs', 'release-loop', 'r.json');
    mkdirSync(join(root, 'graph-runs', 'release-loop'), { recursive: true });
    const write = (status: string, input: Record<string, unknown> = { version: '0.2.18-rc.0', branchCut: true }, branch: string | undefined = 'release/0.2.18-rc.0') => writeFileSync(runFile, JSON.stringify({ graphId: 'release-loop', runId: 'r', status, input, path: ['version-release', 'cutoff', 'gate', 'prepare', 'npm-publish'],
      nodes: [{ nodeId: 'version-release', ok: true, exit: 0, executed: true, output: JSON.stringify({ outcome: 'ok', version: '0.2.18-rc.0', commit: 'a'.repeat(40), ...(branch ? { branch } : {}) }) },
        ...['cutoff', 'gate', 'prepare'].map((nodeId) => ({ nodeId, ok: true, exit: 0, executed: true, output: '{"outcome":"ok"}' })),
        { nodeId: 'npm-publish', ok: false, exit: 1, executed: true, output: '{"outcome":"fail"}' }],
      executed: 1, dryRun: false, statePath: runFile }));
    const git = (args: string[]) => args[0] === 'ls-remote' ? `${'b'.repeat(40)}\trefs/heads/release/0.2.18-rc.0` : args[0] === 'rev-parse' ? 'b'.repeat(40) : '';
    // A main-cut or --cut-commit run has no branch of its own: never re-pointed at a same-named branch.
    write('failed', { version: '0.2.18-rc.0' }, undefined);
    expect(() => refreshReleaseBranchTip('r', { root, git, isAncestor: () => true })).toThrow('was not cut as release/0.2.18-rc.0');
    write('failed', { version: '0.2.18-rc.0', cutCommit: 'a'.repeat(40) }, 'release/0.2.18-rc.0');
    expect(() => refreshReleaseBranchTip('r', { root, git, isAncestor: () => true })).toThrow('was not cut as');
    write('failed');
    expect(() => refreshReleaseBranchTip('r', { root, git, isAncestor: () => false })).toThrow('does not descend');
    const original = readFileSync(runFile, 'utf8');
    let graphs = 0;
    // A moved tip invalidates nodes built from the old one (gate verdict, prepared archive): no restart after gate.
    expect(() => refreshReleaseBranchTip('r', { root, git, isAncestor: () => true }, 'npm-publish')).toThrow('resume at gate or earlier');
    await expect(resumeReleaseRun({ runId: 'r', from: 'nope' }, { root, git, isAncestor: () => true, graph: async () => { graphs++; return {} as never; } })).rejects.toThrow('not a node on the saved path');
    expect(readFileSync(runFile, 'utf8')).toBe(original);
    await expect(resumeReleaseRun({ runId: 'r', from: 'version-release' }, { root, git, isAncestor: () => true, graph: async () => { graphs++; return {} as never; } })).rejects.toThrow('would cut again');
    expect(readFileSync(runFile, 'utf8')).toBe(original);
    const resumed = await resumeReleaseRun({ runId: 'r', from: 'gate' }, { root, git, isAncestor: () => true,
      graph: async (_path, options) => { graphs++; expect(options).toMatchObject({ resumeRunId: 'r', fromNodeId: 'gate', pinChildUniverse: true }); return { status: 'done', runId: 'r' } as never; } });
    expect(resumed.tip).toMatchObject({ changed: true, to: 'b'.repeat(40) });
    expect(graphs).toBe(1);
    write('done');
    expect(() => refreshReleaseBranchTip('r', { root, git })).toThrow('only a failed run');
    expect(() => refreshReleaseBranchTip('../r', { root, git })).toThrow('invalid run id');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('RELEASE-REHEARSAL-RC: an rc branch is cut from main -dev.N and main is untouched; the dev bump is skipped', () => {
  const f = fixture();
  try {
    const mainBefore = git(f.origin, 'rev-parse', 'main');
    const rc = cutReleaseBranchForRun(f.repo, '0.2.18-rc.0', { install: () => {}, freeze: () => null });
    expect(rc).toMatchObject({ outcome: 'ok', version: '0.2.18-rc.0', branch: 'release/0.2.18-rc.0' });
    expect(f.versionOn('release/0.2.18-rc.0')).toBe('0.2.18-rc.0');
    expect(git(f.origin, 'rev-parse', 'main')).toBe(mainBefore);
    expect(() => cutReleaseBranchForRun(f.repo, '0.2.19', { install: () => {}, freeze: () => null })).toThrow('is not 0.2.19-dev.N');
    // An rc number is used once: a second run that picked the same number refuses instead of reusing another run's cut.
    expect(() => cutReleaseBranchForRun(f.repo, '0.2.18-rc.0', { install: () => {}, freeze: () => null })).toThrow('already exists');
    const previous = process.env.ELANOUS_GRAPH_CONTEXT;
    process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ input: { version: '0.2.18-rc.0', branchCut: true }, outputs: { 'version-release': { commit: rc.commit } } });
    try {
      expect(versionNode(['dev-bump', '--json'], f.repo)).toMatchObject({ outcome: 'ok', kind: 'dev-bump', skipped: 'prerelease', commit: null });
    } finally { if (previous === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previous; }
    expect(git(f.origin, 'rev-parse', 'main')).toBe(mainBefore);
  } finally { f.done(); }
});

test('RELEASE-BRANCH: a freeze that is on stops a new branch cut (the emergency stop); --force-freeze cuts anyway', () => {
  const f = fixture();
  try {
    const freeze = () => ({ reason: 'emergency', startedAt: '2026-10-06T00:00:00.000Z', until: null, by: 'OP' });
    expect(() => cutReleaseBranchForRun(f.repo, '0.2.18', { install: () => {}, freeze })).toThrow('동결 중 · emergency');
    expect(git(f.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/release/0.2.18')).toBe('');
    const forced = cutReleaseBranchForRun(f.repo, '0.2.18', { install: () => {}, freeze, forceFreeze: true });
    expect(forced).toMatchObject({ outcome: 'ok', branch: 'release/0.2.18' });
    // Reusing an existing cut passes the same emergency stop.
    expect(() => cutReleaseBranchForRun(f.repo, '0.2.18', { install: () => {}, freeze })).toThrow('동결 중 · emergency');
    expect(cutReleaseBranchForRun(f.repo, '0.2.18', { install: () => {}, freeze: () => null })).toMatchObject({ commit: forced.commit, existing: true });
  } finally { f.done(); }
});

test('RELEASE-BRANCH: a real graph run resumed after cut-branch --append runs its later node on the repaired tip', async () => {
  const f = fixture();
  try {
    const cut = cutReleaseBranchForRun(f.repo, '0.2.18', { install: () => {}, freeze: () => null });
    const probe = join(f.root, 'probe');
    const state = join(f.root, 'state');
    mkdirSync(probe);
    const fixed = join(probe, 'fixed');
    writeFileSync(join(probe, 'vr.json'), `${JSON.stringify({ outcome: 'ok', kind: 'release', version: '0.2.18', commit: cut.commit, pr: null, branch: 'release/0.2.18' })}\n`);
    writeFileSync(join(probe, 'gate.js'), [
      "const fs = require('node:fs');",
      'const loc = process.env.ELANOUS_GRAPH_CONTEXT;',
      "const ctx = JSON.parse(loc.trim().startsWith('{') ? loc : fs.readFileSync(loc, 'utf8'));",
      "const commit = ctx.outputs['version-release'].commit;",
      `if (!fs.existsSync(${JSON.stringify(fixed)})) { console.log(JSON.stringify({ outcome: 'fail', commit })); process.exit(1); }`,
      "console.log(JSON.stringify({ outcome: 'ok', commit }));",
    ].join('\n'));
    writeFileSync(join(probe, 'release-loop.yaml'), ['graph_id: release-loop', 'version: 1', 'entry_node: version-release', 'terminal_nodes: [done, failed]', 'nodes:',
      "  - { node_id: version-release, kind: git, recipe: 'cmd:vr', max_visits: 1 }", "  - { node_id: gate, kind: gate, recipe: 'cmd:gate', max_visits: 1 }",
      '  - { node_id: done, kind: gate, max_visits: 1 }', '  - { node_id: failed, kind: gate, max_visits: 1 }', 'edges:',
      '  - { from: version-release, on: outcome, map: { ok: gate, fail: failed, error: failed } }',
      '  - { from: gate, on: outcome, map: { ok: done, fail: failed, error: failed } }', ''].join('\n'));
    writeFileSync(join(probe, 'recipes.yaml'), `vr:\n  command: 'cat ${join(probe, 'vr.json')}'\n  timeout_ms: 30000\ngate:\n  command: 'bun ${join(probe, 'gate.js')}'\n  timeout_ms: 30000\n`);
    const { runGraph } = await import('../../src/graph-runner/runner.js');
    const first = await runGraph(join(probe, 'release-loop.yaml'), { input: { version: '0.2.18', previousVersion: '0.2.17', branchCut: true }, deps: { root: state } });
    expect(first.status).toBe('failed');
    expect(JSON.stringify(first.nodes.find((node) => node.nodeId === 'gate')!.output)).toContain(cut.commit!);
    // Repair: one main fix appended to release/0.2.18, then resume at the gate.
    const fix = f.land('fix.ts', 'export const fix = true;\n');
    cutReleaseBranch({ version: '0.2.18', base: cut.base!, pick: [fix], append: true, repoRoot: f.repo, log: () => {} });
    const tip = git(f.origin, 'rev-parse', 'release/0.2.18');
    writeFileSync(fixed, '');
    const resumed = await resumeReleaseRun({ runId: first.runId, from: 'gate' }, { root: state, repo: f.repo, graphPath: join(probe, 'release-loop.yaml') });
    expect(resumed.tip).toMatchObject({ changed: true, from: cut.commit, to: tip });
    expect(resumed.state.status).toBe('done');
    const gate = resumed.state.nodes.find((node) => node.nodeId === 'gate')!;
    expect(JSON.parse(String(gate.output).trim().split('\n').at(-1)!)).toEqual({ outcome: 'ok', commit: tip });
  } finally { f.done(); }
});

test('RELEASE-BRANCH: the real release graph, failed at gate and resumed after --append, hands every later node the repaired tip', async () => {
  const f = fixture();
  try {
    const state = join(f.root, 'state');
    const seen: Array<{ nodeId: string; commit: unknown; context: string }> = [];
    let gateFails = true;
    // Node commands are not executed: version-release runs the real branch cut; every other node records the context
    // the runner handed it (gate fails once). Nothing is published.
    const runBash = async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
      const contextPath = opts.env!.ELANOUS_GRAPH_CONTEXT!;
      const raw = readFileSync(contextPath, 'utf8');
      const context = JSON.parse(raw) as { nodeId: string; outputs: Record<string, { commit?: unknown } | null> };
      if (context.nodeId === 'version-release') {
        return { exitCode: 0, stderr: '', stdout: `${JSON.stringify(cutReleaseBranchForRun(f.repo, '0.2.18', { install: () => {}, freeze: () => null }))}\n` };
      }
      const copy = join(f.root, `ctx-${seen.length}.json`);
      writeFileSync(copy, raw);
      seen.push({ nodeId: context.nodeId, commit: context.outputs['version-release']?.commit, context: copy });
      if (context.nodeId === 'gate' && gateFails) return { exitCode: 1, stderr: '', stdout: '{"outcome":"fail"}\n' };
      return { exitCode: 0, stderr: '', stdout: '{"outcome":"ok","verdict":"pass"}\n' };
    };
    const { runGraph } = await import('../../src/graph-runner/runner.js');
    const first = await runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'),
      { input: { version: '0.2.18', previousVersion: '0.2.17', gatePodPool: 'pool', branchCut: true }, deps: { root: state, runBash } });
    expect(first.status).toBe('failed');
    expect(first.path.slice(0, 5)).toEqual(['version-release', 'cutoff', 'checklist-gate', 'prefetch', 'gate']);
    const cut = git(f.origin, 'rev-parse', 'release/0.2.18');
    expect(seen.map((item) => item.commit)).toEqual([cut, cut, cut, cut]);
    const fix = f.land('fix.ts', 'export const fix = true;\n');
    const base = git(f.origin, 'rev-parse', `${cut}^`);
    cutReleaseBranch({ version: '0.2.18', base, pick: [fix], append: true, repoRoot: f.repo, log: () => {} });
    const tip = git(f.origin, 'rev-parse', 'release/0.2.18');
    gateFails = false;
    seen.length = 0;
    const resumed = await resumeReleaseRun({ runId: first.runId, from: 'gate' }, { root: state, repo: f.repo, runBash });
    expect(resumed.tip).toMatchObject({ changed: true, from: cut, to: tip });
    expect(resumed.state.status).toBe('done');
    expect(seen.map((item) => item.nodeId)).toEqual(['gate', 'mac-smoke', 'export-check', 'pwa', 'prepare', 'upgrade', 'tui', 'docs', 'known-issues',
      'notes-check', 'auto-approve', 'publish', 'npm-publish', 'docs-land', 'verify', 'vault-note', 'release-story', 'ops-upgrade', 'version-dev-bump']);
    expect(new Set(seen.map((item) => item.commit))).toEqual(new Set([tip]));
    // The real gate node reads that context and measures the repaired tip.
    const gate = gateOptions(['--json'], { ELANOUS_GRAPH_CONTEXT: seen[0]!.context });
    expect(gate !== 'help' && gate.commit).toBe(tip);
    expect(git(f.origin, 'rev-parse', 'main')).toBe(fix);
    expect(f.versionOn('main')).toBe('0.2.18-dev.3');
  } finally { f.done(); }
});

test('RELEASE-REHEARSAL-RC: docs-land and ops-upgrade skip a prerelease; its public notes open with a pre-release label', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-rc-nodes-'));
  try {
    const context = join(root, 'context.json');
    writeFileSync(context, JSON.stringify({ input: { version: '0.2.18-rc.1', previousVersion: '0.2.17' }, outputs: {} }));
    for (const node of ['docs-land-node.ts', 'ops-upgrade-node.ts']) {
      const run = spawnSync('bun', [join(import.meta.dir, node)], { cwd: root, encoding: 'utf8',
        env: { ...process.env, ELANOUS_GRAPH_CONTEXT: context, ELANOUS_STATE_DIR: join(root, 'state'), ELANOUS_CONFIG_DIR: join(root, 'state') } });
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout.trim().split('\n').at(-1)!)).toMatchObject({ outcome: 'ok', skipped: 'prerelease' });
    }
    expect(labelPrerelease('0.2.18', 'body')).toBe('body');
    expect(labelPrerelease('0.2.18-rc.1', 'body')).toStartWith('> **Pre-release** — 0.2.18-rc.1');
    expect(labelPrerelease('0.2.18-rc.1', 'body')).toContain('elanous@next');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GATE-PARTIAL resume: the graph is resumed at the run’s own saved path; --partial plans test-only changes and falls back otherwise', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resume-partial-'));
  const ledger = mkdtempSync(join(tmpdir(), 'release-resume-ledger-'));
  try {
    const runFile = join(root, 'graph-runs', 'release-loop', 'r.json');
    mkdirSync(join(root, 'graph-runs', 'release-loop'), { recursive: true });
    const old = 'a'.repeat(40), tip = 'b'.repeat(40);
    const write = () => writeFileSync(runFile, JSON.stringify({ graphId: 'release-loop', runId: 'r', status: 'failed', input: { version: '0.2.18', branchCut: true },
      path: ['version-release', 'cutoff', 'gate'], graphPath: '/elsewhere/wt-release/graphs/release/release-loop.yaml',
      nodes: [{ nodeId: 'version-release', ok: true, exit: 0, executed: true, output: JSON.stringify({ outcome: 'ok', version: '0.2.18', commit: old, branch: 'release/0.2.18' }) },
        { nodeId: 'cutoff', ok: true, exit: 0, executed: true, output: '{"outcome":"ok"}' },
        { nodeId: 'gate', ok: false, exit: 1, executed: true, output: '{"outcome":"fail"}' }],
      executed: 1, dryRun: false, statePath: runFile }));
    let changed = 'scripts/audit.test.ts\n';
    const git = (args: string[]) => args[0] === 'ls-remote' ? `${tip}\trefs/heads/release/0.2.18` : args[0] === 'rev-parse' ? tip : args[0] === 'diff' ? changed : '';
    mkdirSync(join(ledger, 'release', '0.2.18'), { recursive: true });
    writeFileSync(join(ledger, 'release', '0.2.18', 'gate-failures.json'), JSON.stringify({ commit: old, failures: ['src/x.test.ts > slow'] }));
    const paths: string[] = [];
    const graph = (async (path: string) => { paths.push(path); return { status: 'done', runId: 'r' }; }) as never;
    // Each resume backs the state up under a timestamped name (exclusive) — give every call its own instant.
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 9, 7, 0, 0, tick++));
    write();
    const applied = await resumeReleaseRun({ runId: 'r', from: 'gate', partial: true }, { root, ledgerRoot: ledger, git, isAncestor: () => true, graph, now });
    expect(paths).toEqual(['/elsewhere/wt-release/graphs/release/release-loop.yaml']);
    expect(applied.partial).toEqual({ requested: true, applied: true, files: 2, priorCommit: old });
    expect(JSON.parse(readFileSync(join(root, 'release', '0.2.18', 'gate-partial.json'), 'utf8'))).toMatchObject({ forCommit: tip, files: ['scripts/audit.test.ts', 'src/x.test.ts'] });
    // A source change: fall back to a full gate — and the old plan for this version is removed, not reused.
    write();
    changed = 'scripts/audit.test.ts\nsrc/release-loop/gate.ts\n';
    const fell = await resumeReleaseRun({ runId: 'r', from: 'gate', partial: true }, { root, ledgerRoot: ledger, git, isAncestor: () => true, graph, now });
    expect(fell.partial).toMatchObject({ requested: true, applied: false, reason: expect.stringContaining('non-test change') });
    expect(() => readFileSync(join(root, 'release', '0.2.18', 'gate-partial.json'), 'utf8')).toThrow();
    // A failing diff: full gate with the reason — the already refreshed tip never strands the resume.
    write();
    const throwingGit = (args: string[]) => { if (args[0] === 'diff') throw new Error('bad object'); return git(args); };
    const noDiff = await resumeReleaseRun({ runId: 'r', from: 'gate', partial: true }, { root, ledgerRoot: ledger, git: throwingGit, isAncestor: () => true, graph, now });
    expect(noDiff.partial).toMatchObject({ requested: true, applied: false, reason: expect.stringContaining('changed files unreadable') });
    // A corrupt prior gate record: fall back to a full gate with the reason (never an exception mid-resume).
    write();
    writeFileSync(join(ledger, 'release', '0.2.18', 'gate-failures.json'), '{broken');
    const corrupt = await resumeReleaseRun({ runId: 'r', from: 'gate', partial: true }, { root, ledgerRoot: ledger, git, isAncestor: () => true, graph, now });
    expect(corrupt.partial).toMatchObject({ requested: true, applied: false, reason: expect.stringContaining('unreadable gate record') });
    writeFileSync(join(ledger, 'release', '0.2.18', 'gate-failures.json'), JSON.stringify({ commit: old, failures: ['src/x.test.ts > slow'] }));
    // Without --partial: no plan, full gate — and a plan left from before is removed even when resuming at another node.
    write();
    changed = 'scripts/audit.test.ts\n';
    await resumeReleaseRun({ runId: 'r', from: 'gate', partial: true }, { root, ledgerRoot: ledger, git, isAncestor: () => true, graph, now });
    write();
    const full = await resumeReleaseRun({ runId: 'r', from: 'cutoff' }, { root, ledgerRoot: ledger, git, isAncestor: () => true, graph, now });
    expect(full.partial).toEqual({ requested: false });
    expect(() => readFileSync(join(root, 'release', '0.2.18', 'gate-partial.json'), 'utf8')).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(ledger, { recursive: true, force: true }); }
});
