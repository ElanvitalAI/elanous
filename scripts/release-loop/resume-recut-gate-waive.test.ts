// RECUT-GATE-WAIVE (대표 11-18): a re-cut (or appended) release run whose version was already fully swept and owner-accepted
// must not re-measure the gate. Path: the run reaches the gate, `graph runs stop` cuts it before any shard result, then
// `release resume --run <id> --waive gate --reason '<sentence>' --waive-evidence-run <earlier run>`.
// --waive-evidence-run is accepted only when the evidence run is the same version, its gate passed by a recorded waiver,
// and the current cut descends from the evidence cut; the extra commits are written into the waiver record and event.
// Expectations below are literals (OP rule 11), not product constants.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph, type GraphRunState } from '../../src/graph-runner/runner.js';
import { readWaiverEvents } from '../../src/release-loop/waiver-events.js';
import { resumeReleaseRun } from './resume-release.js';
import { releaseGateSweepCarry } from './resume.js';
import { simCli } from '../../src/ux-sim/in-process-cli.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import './resume-test-traffic.js';

setDefaultTimeout(30_000);
// The release ledger and OP seat flock follow the selected config root, never the machine-wide ~/.elanous.
afterEach(() => resetElanousConfigDir());

const SHA = 'f'.repeat(40);
const VERSION = '0.2.19';
const REASON = 'The owner accepted the full gate sweep of run 6700ee80 for this version. This re-cut adds one skills front matter fix.';

// Spawned CLI ceiling: a cold `bun bin/elanous.mjs` start plus three git reads on a loaded host.
const CLI_TIMEOUT_MS = 60 * 1000;
const PRIOR = 'e'.repeat(40);
const APPENDED = 'a'.repeat(40);
const PRIOR_REASON = 'Release gate test failures from the full sweep are accepted as known issues by owner decision. Root-cause analysis will follow.';

/** Fake node bodies shared by the first (child) run and the resume; the gate body only ever runs in the child, where it hangs. */
const nodeBody = (docsTree: string, calls: string[]) => async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
  const ctx = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { nodeId: string };
  calls.push(ctx.nodeId);
  if (ctx.nodeId === 'gate-cutover-switch') return { exitCode: 0, stdout: '{"outcome":"legacy"}\n', stderr: '' };
  if (ctx.nodeId === 'cut-branch') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', version: VERSION, commit: SHA, branch: `release/${VERSION}` }) + '\n', stderr: '' };
  if (ctx.nodeId === 'gate') return { exitCode: 1, stdout: '{"outcome":"fail","verdict":"fail","summary":"gate must not run on resume"}\n', stderr: '' };
  if (ctx.nodeId === 'docs') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', branch: `release-docs/${VERSION}`, worktree: docsTree }) + '\n', stderr: '' };
  if (ctx.nodeId === 'known-issues') return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass","summary":"fixture","count":1}\n', stderr: '' };
  return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
};

/**
 * The real path: a separate runner process runs the release graph until the gate starts (its gate body hangs, no shard
 * result), then `elanous graph runs stop <run>` (spawned CLI) stops it — the ledger is whatever that command writes.
 */
async function stoppedAtGate(root: string, calls: string[]) {
  setElanousConfigDir(root);
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const docsTree = join(root, 'docs-tree');
  mkdirSync(join(docsTree, 'release/public/docs/releases'), { recursive: true });
  writeFileSync(join(docsTree, 'release/public/docs/releases', `${VERSION}.md`), '# Release\n');
  const marker = join(root, 'gate-started');
  const child = join(root, 'first-run.ts');
  writeFileSync(child, [
    `import { readFileSync, writeFileSync } from 'node:fs';`,
    `import { runGraph } from ${JSON.stringify(join(import.meta.dir, '../../src/graph-runner/runner.ts'))};`,
    `const [graphPath, root, marker, sha, version, docsTree] = process.argv.slice(2);`,
    `const runBash = async (_body, opts) => {`,
    `  const ctx = JSON.parse(readFileSync(opts.env.ELANOUS_GRAPH_CONTEXT, 'utf8'));`,
    `  if (ctx.nodeId === 'gate') { writeFileSync(marker, ctx.runId); return new Promise(() => {}); }`,
    `  if (ctx.nodeId === 'gate-cutover-switch') return { exitCode: 0, stdout: '{"outcome":"legacy"}\\n', stderr: '' };`,
    `  if (ctx.nodeId === 'cut-branch') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', version, commit: sha, branch: 'release/' + version }) + '\\n', stderr: '' };`,
    `  if (ctx.nodeId === 'docs') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', branch: 'release-docs/' + version, worktree: docsTree }) + '\\n', stderr: '' };`,
    `  return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\\n', stderr: '' };`,
    `};`,
    `await runGraph(graphPath, { input: { version, branchCut: true, previousVersion: '0.2.18' }, deps: { root, runBash } });`,
    '',
  ].join('\n'));
  const runner = Bun.spawn(['bun', child, graphPath, root, marker, SHA, VERSION, docsTree], {
    cwd: join(import.meta.dir, '../..'), env: { ...process.env, ELANOUS_STATE_DIR: root }, stdout: 'ignore', stderr: 'pipe' });
  try {
    const deadline = Date.now() + CLI_TIMEOUT_MS;
    while (!existsSync(marker)) {
      if (runner.exitCode !== null || Date.now() > deadline) throw new Error(`first run never reached the gate: ${await new Response(runner.stderr).text()}`);
      await Bun.sleep(100);
    }
    const runId = readFileSync(marker, 'utf8');
    const stopped = await simCli(['graph', 'runs', 'stop', runId], { mode: 'spawn', allowPaths: [['graph', 'runs', 'stop']], stateRoot: root,
      timeoutMs: CLI_TIMEOUT_MS });
    expect(stopped.exitCode, stopped.stdout + stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain(`release-loop ${runId}: failed`);
    await runner.exited;
    const statePath = join(root, 'graph-runs', 'release-loop', `${runId}.json`);
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as GraphRunState;
    const gateAt = saved.path.indexOf('gate');
    expect(saved.status).toBe('failed');
    expect(saved.path.at(-1)).toBe('gate');
    expect(saved.nodes.at(-1)).toMatchObject({ nodeId: 'gate', ok: false, exit: null, executed: false, error: 'stopped before node completed' });
    return { runId, statePath, gateAt, graphPath, runBash: nodeBody(docsTree, calls) };
  } finally { if (runner.exitCode === null) runner.kill('SIGKILL'); }
}

/** An earlier run (or this run before an append) whose gate passed by a recorded waiver at `cut`. */
function evidenceRun(runId: string, version: string, cut: string, gateWaived: boolean, carried = false) {
  return { graphId: 'release-loop', runId, status: 'failed', input: { version, branchCut: true },
    path: ['version-release', 'gate', 'cloud-leave-ok', 'traffic-gate-passed', 'failed'],
    nodes: [
      { nodeId: 'version-release', ok: true, executed: true, exit: 0, output: JSON.stringify({ outcome: 'ok', version, commit: cut, branch: `release/${version}` }) },
      gateWaived
        ? { nodeId: 'gate', ok: true, executed: false, exit: 0, waiver: { reason: PRIOR_REASON, at: '2026-11-17T23:25:54.703Z',
          unmeasured: 'stopped: stopped before node completed after 7418.11s', original: { exit: null },
          ...(carried ? { carriedSweep: { runId: 'older-run', version, cut: 'd'.repeat(40), tip: cut, commits: [cut], priorWaiverReason: PRIOR_REASON, source: '/ledger/older-run.json' } } : {}) } }
        : { nodeId: 'gate', ok: true, executed: true, exit: 0, output: '{"outcome":"ok","verdict":"pass"}' },
    ] };
}

const fakeGit = (args: string[]) => args[0] === 'ls-remote' ? `${SHA}\trefs/heads/release/${VERSION}`
  : args[0] === 'rev-parse' ? SHA
    : args[0] === 'rev-list' && args[2] === `${PRIOR}..${SHA}` ? `${APPENDED}\n${SHA}` : '';
const isAncestor = (ancestor: string, descendant: string) => ancestor === PRIOR && descendant === SHA;

test('a re-cut run stopped at gate start is waived without re-measuring and reaches traffic-gate-passed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-recut-gate-waive-'));
  const calls: string[] = [];
  try {
    const run = await stoppedAtGate(root, calls);
    const waived = await resumeReleaseRun({ runId: run.runId, from: 'gate', waive: 'gate', reason: REASON },
      { root, graphPath: run.graphPath, git: fakeGit, runBash: run.runBash, ledgerRoot: root, macrophageInventory: () => [] });
    expect(calls).not.toContain('gate');
    const path = waived.state.path;
    const passedAt = path.indexOf('traffic-gate-passed');
    // Between the waived gate and traffic-gate-passed only the success-side cloud release runs — no triage, no failure.
    expect(path.slice(run.gateAt, passedAt + 1)).toEqual(['gate', 'cloud-leave-ok', 'gate-cutover-switch', 'traffic-gate-passed']);
    const gate = waived.state.nodes[run.gateAt]!;
    expect(gate.ok).toBe(true);
    expect(gate.waiver).toMatchObject({ reason: REASON, original: { exit: null, error: 'stopped before node completed' } });
    expect(gate.waiver?.unmeasured).toStartWith('stopped: stopped before node completed after ');
    expect(gate.waiver?.carriedSweep).toBeUndefined();
    expect((waived.state.input as { acceptedRegressions?: unknown }).acceptedRegressions).toEqual([{ id: 'waive:gate', note: REASON }]);
    const events = readWaiverEvents(join(root, 'review-results', 'waiver-events.jsonl'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'gate', target: `run:${run.runId}`, head: SHA });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('--waive-evidence-run carries an owner-accepted sweep onto the descendant cut', () => {
  test('from an earlier run of the same version: waiver record, gate output and waiver event name the extra commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-recut-carry-'));
    const calls: string[] = [];
    try {
      const run = await stoppedAtGate(root, calls);
      const priorPath = join(root, 'graph-runs', 'release-loop', 'prior-run.json');
      writeFileSync(priorPath, JSON.stringify(evidenceRun('prior-run', VERSION, PRIOR, true)));
      const waived = await resumeReleaseRun({ runId: run.runId, from: 'gate', waive: 'gate', reason: REASON, waiveEvidenceRun: 'prior-run' },
        { root, graphPath: run.graphPath, git: fakeGit, isAncestor, runBash: run.runBash, ledgerRoot: root, macrophageInventory: () => [] });
      expect(calls).not.toContain('gate');
      expect(waived.state.path).toContain('traffic-gate-passed');
      const expected = { runId: 'prior-run', version: '0.2.19', cut: PRIOR, tip: SHA, commits: [APPENDED, SHA],
        priorWaiverReason: PRIOR_REASON, priorWaiverAt: '2026-11-17T23:25:54.703Z', source: priorPath };
      const gate = waived.state.nodes[run.gateAt]!;
      expect(gate.waiver?.carriedSweep).toEqual(expected);
      expect(JSON.parse(String(gate.output).trim().split('\n').at(-1)!).carriedSweep).toEqual(expected);
      const events = readWaiverEvents(join(root, 'review-results', 'waiver-events.jsonl'));
      expect(events).toHaveLength(1);
      expect(events[0]!.evidence).toContain(`gate-waiver:carried:run:prior-run cut:${PRIOR} tip:${SHA} commits:${APPENDED},${SHA}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('from this run before an append: the pre-append backup carries the waived sweep of the earlier tip', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-append-carry-'));
    const calls: string[] = [];
    try {
      const run = await stoppedAtGate(root, calls);
      const backup = `${run.statePath}.before-tip-2026-11-18T00-00-00-000Z-1-${SHA.slice(0, 12)}.bak`;
      writeFileSync(backup, JSON.stringify(evidenceRun(run.runId, VERSION, PRIOR, true)));
      const waived = await resumeReleaseRun({ runId: run.runId, from: 'gate', waive: 'gate', reason: REASON, waiveEvidenceRun: run.runId },
        { root, graphPath: run.graphPath, git: fakeGit, isAncestor, runBash: run.runBash, ledgerRoot: root, macrophageInventory: () => [] });
      expect(waived.state.path).toContain('traffic-gate-passed');
      expect(waived.state.nodes[run.gateAt]!.waiver?.carriedSweep).toMatchObject({ runId: run.runId, cut: PRIOR, tip: SHA,
        commits: [APPENDED, SHA], source: backup });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('an evidence run of another version is refused before any waiver event is written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'release-recut-carry-refused-'));
    const calls: string[] = [];
    try {
      const run = await stoppedAtGate(root, calls);
      writeFileSync(join(root, 'graph-runs', 'release-loop', 'prior-run.json'), JSON.stringify(evidenceRun('prior-run', '0.2.18', PRIOR, true)));
      await expect(resumeReleaseRun({ runId: run.runId, from: 'gate', waive: 'gate', reason: REASON, waiveEvidenceRun: 'prior-run' },
        { root, graphPath: run.graphPath, git: fakeGit, isAncestor, runBash: run.runBash, ledgerRoot: root, macrophageInventory: () => [] }))
        .rejects.toThrow('--waive-evidence-run prior-run: evidence run is release 0.2.18, not 0.2.19');
      expect(existsSync(join(root, 'review-results', 'waiver-events.jsonl'))).toBe(false);
      expect((JSON.parse(readFileSync(run.statePath, 'utf8')) as GraphRunState).nodes.at(-1)).toMatchObject({ nodeId: 'gate', ok: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('releaseGateSweepCarry decision table (version × prior gate waived × cut descends × prior waiver carried)', () => {
  const rows: Array<[string, boolean, boolean, boolean, string]> = [
    ['0.2.19', true, true, false, 'accepted'],
    ['0.2.19', true, false, false, 'current cut ffffffffffff does not descend from the evidence cut eeeeeeeeeeee'],
    ['0.2.19', false, true, false, 'evidence run gate was not passed by a recorded waiver'],
    ['0.2.19', false, false, false, 'evidence run gate was not passed by a recorded waiver'],
    ['0.2.18', true, true, false, 'evidence run is release 0.2.18, not 0.2.19'],
    ['0.2.18', true, false, false, 'evidence run is release 0.2.18, not 0.2.19'],
    ['0.2.18', false, true, false, 'evidence run is release 0.2.18, not 0.2.19'],
    ['0.2.18', false, false, false, 'evidence run is release 0.2.18, not 0.2.19'],
    // No chaining: the evidence gate must be the owner-accepted sweep itself, not a waiver that was already carried.
    ['0.2.19', true, true, true, 'evidence run gate waiver was itself carried from another run; a carried waiver is not carried again'],
  ];
  test.each(rows)('evidence version %s · gate waived %p · descends %p · carried %p → %s', (version, waived, descends, carried, expected) => {
    const git = { isAncestor: () => descends, commitsBetween: () => [APPENDED, SHA] };
    const decide = () => releaseGateSweepCarry(evidenceRun('prior-run', version, PRIOR, waived, carried) as unknown as GraphRunState,
      { version: '0.2.19', tip: SHA }, git, '/ledger/prior-run.json');
    if (expected === 'accepted') expect(decide()).toEqual({ runId: 'prior-run', version: '0.2.19', cut: PRIOR, tip: SHA,
      commits: [APPENDED, SHA], priorWaiverReason: PRIOR_REASON, priorWaiverAt: '2026-11-17T23:25:54.703Z', source: '/ledger/prior-run.json' });
    else expect(decide).toThrow(expected);
  });

  test('same cut carries with an empty extra diff; an unlistable diff is refused', () => {
    const same = releaseGateSweepCarry(evidenceRun('prior-run', '0.2.19', SHA, true) as unknown as GraphRunState,
      { version: '0.2.19', tip: SHA }, { isAncestor: () => true, commitsBetween: () => { throw new Error('not called'); } }, 'x');
    expect(same.commits).toEqual([]);
    expect(() => releaseGateSweepCarry(evidenceRun('prior-run', '0.2.19', PRIOR, true) as unknown as GraphRunState,
      { version: '0.2.19', tip: SHA }, { isAncestor: () => true, commitsBetween: () => [] }, 'x'))
      .toThrow('extra diff between the evidence cut and the current cut could not be listed');
  });
});

test('real process: release resume --dry-run prints the carried sweep, and refuses a non-descendant evidence cut', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-recut-carry-cli-'));
  const repo = join(root, 'repo'), remote = join(root, 'remote.git');
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', ['-c', 'user.name=cli-test', '-c', 'user.email=cli-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd, encoding: 'utf8', env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    mkdirSync(join(repo, 'apps', 'pwa', 'node_modules'), { recursive: true });
    mkdirSync(join(repo, 'graphs', 'release'), { recursive: true });
    for (const file of ['release-loop.yaml', 'recipes.yaml']) copyFileSync(join(import.meta.dir, '../../graphs/release', file), join(repo, 'graphs', 'release', file));
    const sha256 = (file: string) => createHash('sha256').update(readFileSync(join(repo, 'graphs', 'release', file))).digest('hex');
    const graphSnapshot = { graphSha: sha256('release-loop.yaml'), recipesSha: sha256('recipes.yaml') };
    git(repo, 'init', '-q', '-b', 'release/0.2.19');
    writeFileSync(join(repo, 'cut.txt'), 'cut\n');
    git(repo, 'add', 'cut.txt', 'graphs/release');
    git(repo, 'commit', '-q', '-m', 'release cut');
    const priorCut = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'skills.md'), '---\nname: fix\n---\n');
    git(repo, 'add', 'skills.md');
    git(repo, 'commit', '-q', '-m', 'skills front matter fix');
    const newCut = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'side', priorCut);
    writeFileSync(join(repo, 'side.txt'), 'side\n');
    git(repo, 'add', 'side.txt');
    git(repo, 'commit', '-q', '-m', 'side cut');
    const sideCut = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'release/0.2.19');
    git(root, 'init', '-q', '--bare', remote);
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'release/0.2.19');
    const runs = join(root, 'graph-runs', 'release-loop');
    mkdirSync(runs, { recursive: true });
    const trafficFile = join(root, 'traffic.json');
    writeFileSync(trafficFile, '{}\n');
    const statePath = join(runs, 'recut-run.json');
    writeFileSync(statePath, JSON.stringify({ graphId: 'release-loop', runId: 'recut-run', status: 'failed', input: { version: '0.2.19', branchCut: true },
      path: ['version-release', 'gate'], executed: 1, dryRun: false, statePath, graphSnapshot,
      nodes: [{ nodeId: 'version-release', ok: true, executed: true, exit: 0, output: JSON.stringify({ outcome: 'ok', version: '0.2.19', commit: newCut, branch: 'release/0.2.19' }) },
        { nodeId: 'gate', ok: false, exit: null, executed: false, error: 'stopped before node completed', seconds: 12 }] }, null, 2));
    writeFileSync(join(runs, 'prior-run.json'), JSON.stringify(evidenceRun('prior-run', '0.2.19', priorCut, true)));
    writeFileSync(join(runs, 'side-run.json'), JSON.stringify(evidenceRun('side-run', '0.2.19', sideCut, true)));
    const cli = (evidence: string) => simCli(['release', 'resume', '--run', 'recut-run', '--waive', 'gate', '--reason', REASON,
      '--waive-evidence-run', evidence, '--dry-run', '--command-root', repo, '--json'], {
      mode: 'spawn', allowPaths: [['release', 'resume']], stateRoot: root, cwd: repo, timeoutMs: CLI_TIMEOUT_MS,
      env: { ELANOUS_TRACK: 'OP', ELANOUS_RELEASE_TRAFFIC_FILE: trafficFile, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    const accepted = await cli('prior-run');
    expect(accepted.exitCode, accepted.stdout + accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout.trim().split('\n').at(-1)!)).toMatchObject({ ok: true, preflight: 'passed',
      gateSweepCarry: { runId: 'prior-run', version: '0.2.19', cut: priorCut, tip: newCut, commits: [newCut] } });
    const refused = await cli('side-run');
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout + refused.stderr).toContain(`--waive-evidence-run side-run: current cut ${newCut.slice(0, 12)} does not descend from the evidence cut ${sideCut.slice(0, 12)}`);
    expect(existsSync(join(root, 'review-results', 'waiver-events.jsonl'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 90_000);
