import { expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideGraphApproval, runGraph, STOPPED_NODE_ERROR, type GraphRunState } from '../../src/graph-runner/runner.js';
import { Command } from 'commander';
import { registerReleaseCommands } from '../../src/cli/release-cli.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../../src/elanous-config-dir.js';
import { resumeReleaseRun as runResumeReleaseRun } from './resume-release.js';
const resumeReleaseRun: typeof runResumeReleaseRun = (opts, deps = {}) => runResumeReleaseRun(opts, {
  ...deps, macrophageInventory: deps.macrophageInventory ?? (() => []),
});
import { debug } from '../../src/debug/log.js';
import { assertReleaseResumeApprovalBoundary, releaseFanOutForkIndex, releaseResumeGatePodPool, releaseResumeWaiver } from './resume.js';
import { appendWaiverEvents, gateWaiverEvidence, issueGateWaiverEvent, readWaiverEvents } from '../../src/release-loop/waiver-events.js';
import { BLOCKING_METRIC_NAMES } from './auto-approve-node.js';
import { runPublish } from './publish-node.js';
import { runKnownIssues } from './known-issues-node.js';
import type { GraphContext } from './node-verdict.js';
import './resume-test-traffic.js';

// End-to-end release graph fixtures can exceed Bun's default under parallel gate-test load.
setDefaultTimeout(15_000);

const SHA = 'a'.repeat(40);
const VERSION = '0.2.19';

test('release resume resolves a failed branch id to its saved fork without moving successful siblings', () => {
  const state = { path: ['traffic-npm-published', 'release-post-publish-join', 'failed'], fanOuts: {
    'traffic-npm-published:ok': { from: 'traffic-npm-published', join: 'release-post-publish-join', branches: {
      'docs-land': { runId: 'docs-child', status: 'failed', startedAt: '2026-11-01T00:00:00Z' },
      'version-dev-bump': { runId: 'bump-child', status: 'done', startedAt: '2026-11-01T00:00:00Z' },
    } },
  } } as unknown as GraphRunState;
  expect(releaseFanOutForkIndex(state, 'docs-land')).toBe(0);
  expect(releaseFanOutForkIndex(state, 'version-dev-bump')).toBeUndefined();
});

test('release branch resume checks approval decisions up to the fork boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-branch-approval-'));
  try {
    const statePath = join(root, 'run.json');
    writeFileSync(`${statePath}.1.decision.json`, JSON.stringify({ nodeId: 'publish', decision: 'approved', decidedAt: 't1' }));
    const state = { statePath, path: ['publish', 'traffic-npm-published', 'release-post-publish-join', 'failed'], nodes: [
      { nodeId: 'publish', ok: true, exit: 0, executed: true, decidedAt: 't1' }, { nodeId: 'traffic-npm-published', ok: true, exit: 0, executed: true },
    ], fanOuts: { 'traffic-npm-published:ok': { from: 'traffic-npm-published', join: 'release-post-publish-join', branches: {
      'docs-land': { runId: 'docs-child', status: 'failed', startedAt: 't1' },
      'version-dev-bump': { runId: 'bump-child', status: 'done', startedAt: 't1' },
    } } } } as unknown as GraphRunState;
    expect(() => assertReleaseResumeApprovalBoundary(state, 'docs-land')).not.toThrow();
    state.nodes[1] = { nodeId: 'traffic-npm-published', ok: true, exit: 0, executed: true, decidedAt: 't2' };
    expect(() => assertReleaseResumeApprovalBoundary(state, 'docs-land')).toThrow(/cannot restart across an approval decision/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('waive the failed tui node on the saved release path; record the original failure and pass accepted regressions to known-issues', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-waiver-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const seen: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
  const bin = join(root, 'bin');
  const calls = join(root, 'ask-calls');
  const docsTree = join(root, 'docs-tree');
  const notes = join(docsTree, 'release/public/docs/releases', `${VERSION}.md`);
  const runBash = async (body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    const ctx = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as {
      nodeId: string; input: Record<string, unknown>; outputs?: Record<string, { outcome?: string }>;
    };
    seen.push(ctx);
    if (ctx.nodeId === 'version-release') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', version: VERSION, commit: SHA, branch: `release/${VERSION}` }) + '\n', stderr: '' };
    if (ctx.nodeId === 'tui') return { exitCode: 1, stdout: '{"outcome":"fail","summary":"help-closes"}\n', stderr: '' };
    if (ctx.nodeId === 'docs') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', branch: `release-docs/${VERSION}`, worktree: docsTree }) + '\n', stderr: '' };
    if (ctx.nodeId === 'known-issues') {
      expect(body).toContain('bun scripts/release-loop/known-issues-node.ts');
      const child = spawnSync('bash', ['-c', body], {
        cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...opts.env, PATH: `${bin}:${process.env.PATH}`,
          ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1', KNOWN_ASK_CALLS: calls },
      });
      return { exitCode: child.status ?? 2, stdout: child.stdout, stderr: child.stderr };
    }
    return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
  };
  const git = (args: string[]) => args[0] === 'ls-remote' ? `${SHA}\trefs/heads/release/${VERSION}` : args[0] === 'rev-parse' ? SHA : '';
  try {
    mkdirSync(join(docsTree, 'release/public/docs/releases'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, 'elanous'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.KNOWN_ASK_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(JSON.stringify({ reply: JSON.stringify([{ id: 'R2', bullet: 'Settings do not persist after restarting.' }]) }));
`);
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
if (process.argv[2] === 'rev-list') console.log('0');
`);
    chmodSync(join(bin, 'elanous'), 0o755);
    chmodSync(join(bin, 'git'), 0o755);
    writeFileSync(notes, '# Release\n');
    const first = await runGraph(graphPath, { input: { version: VERSION, branchCut: true, previousVersion: '0.2.18' }, deps: { root, runBash } });
    expect(first.status).toBe('failed');
    expect(first.path.slice(-3)).toEqual(['tui', 'traffic-failed-restore', 'failed']);
    const stateFile = join(root, 'graph-runs', 'release-loop', `${first.runId}.json`);
    const before = readFileSync(stateFile, 'utf8');
    const deps = { root, graphPath, git, runBash };
    await expect(resumeReleaseRun({ runId: first.runId, from: 'docs' }, deps)).rejects.toThrow('not a node on the saved path');
    await expect(resumeReleaseRun({ runId: first.runId, from: 'tui', waive: 'tui' }, deps)).rejects.toThrow('supplied together');
    await expect(resumeReleaseRun({ runId: first.runId, from: 'tui', waive: 'gate', reason: 'Known failures remain. Users may encounter these issues.' }, deps)).rejects.toThrow('--from must name');
    await expect(resumeReleaseRun({ runId: first.runId, from: 'tui', waive: 'tui', reason: 'Help does not close',
      acceptedRegressions: [{ id: 'R2', note: '' }] }, deps)).rejects.toThrow('acceptedRegressions must be an array');
    await expect(resumeReleaseRun({ runId: first.runId, from: 'tui', waive: 'tui', reason: 'Help does not close' },
      { ...deps, git: (args) => args[0] === 'ls-remote' ? `${'b'.repeat(40)}\trefs/heads/release/${VERSION}` : git(args) })).rejects.toThrow('release branch moved');
    expect(readFileSync(stateFile, 'utf8')).toBe(before);
    let remoteReads = 0;
    await expect(resumeReleaseRun({ runId: first.runId, from: 'tui', waive: 'tui', reason: 'Help does not close' },
      { ...deps, git: (args) => args[0] === 'ls-remote'
        ? `${++remoteReads === 1 ? SHA : 'b'.repeat(40)}\trefs/heads/release/${VERSION}`
        : args[0] === 'rev-parse' ? 'b'.repeat(40) : '' })).rejects.toThrow('re-gate the new tip before waiving a node');
    expect(remoteReads).toBe(2);
    expect(readFileSync(stateFile, 'utf8')).toBe(before);
    remoteReads = 0;
    await expect(resumeReleaseRun({ runId: first.runId, from: 'tui', waive: 'tui', reason: 'Help does not close' },
      { ...deps, git: (args) => args[0] === 'ls-remote'
        ? `${++remoteReads === 1 ? SHA : 'b'.repeat(40)}\trefs/heads/release/${VERSION}`
        : args[0] === 'rev-parse' ? SHA : '' })).rejects.toThrow('re-gate the new tip before waiving a node');
    expect(remoteReads).toBe(2);
    expect(readFileSync(stateFile, 'utf8')).toBe(before);
    expect(seen.filter((ctx) => ctx.nodeId === 'tui')).toHaveLength(1);
    const resumed = await resumeReleaseRun({ runId: first.runId, from: 'tui', waive: 'tui', reason: 'Help does not close when requested',
      acceptedRegressions: [{ id: 'R2', note: 'Settings do not persist' }] }, deps);
    expect(resumed.state.status).toBe('done');
    const waived = resumed.state.nodes.find((node) => node.nodeId === 'tui')!;
    expect(waived).toMatchObject({ ok: true, executed: false, exit: 0, waiver: { reason: 'Help does not close when requested', original: { exit: 1, output: '{"outcome":"fail","summary":"help-closes"}\n' } } });
    expect(JSON.parse(String(waived.output))).toMatchObject({ outcome: 'ok', verdict: 'waived' });
    expect(seen.filter((ctx) => ctx.nodeId === 'tui')).toHaveLength(1);
    expect(seen.find((ctx) => ctx.nodeId === 'known-issues')?.input.acceptedRegressions).toEqual([
      { id: 'R2', note: 'Settings do not persist' }, { id: 'waive:tui', note: 'Help does not close when requested' },
    ]);
    expect(JSON.parse(String(resumed.state.nodes.find((node) => node.nodeId === 'known-issues')?.output))).toMatchObject({ sources: { accepted: 2 }, count: 2 });
    expect(readFileSync(notes, 'utf8')).toContain('## Known issues');
    expect(readFileSync(notes, 'utf8')).toContain('- Help does not close when requested.');
    expect(readFileSync(notes, 'utf8')).toContain('- Settings do not persist after restarting.');
    const ask = JSON.parse(readFileSync(calls, 'utf8').trim()) as string[];
    expect(ask.slice(0, 3)).toEqual(['--test', 'ask', '--json']);
    expect(ask[3]).toContain('R2');
    expect(ask[3]).not.toContain('waive:tui');
    expect(readFileSync(notes, 'utf8')).not.toContain('waive:tui');
    expect(JSON.stringify(resumed.state.input)).toContain('waive:tui');
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as GraphRunState;
    expect(saved.input).toEqual(resumed.state.input);
    expect(saved.nodes.find((node) => node.nodeId === 'tui')?.waiver).toEqual(waived.waiver);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a waived tui whose recorded failure has exit null (killed or timed out) still carries the waiver reason into public notes when the model is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-waiver-exit-null-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const docsTree = join(root, 'docs-tree');
  const notes = join(docsTree, 'release/public/docs/releases', `${VERSION}.md`);
  const waiverReason = 'The app may remain open after an interrupted launch';
  const runBash = async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    const ctx = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { nodeId: string; outputs?: { gate?: { outcome?: string } } };
    if (ctx.nodeId === 'version-release') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', version: VERSION, commit: SHA, branch: `release/${VERSION}` }) + '\n', stderr: '' };
    if (ctx.nodeId === 'tui') return { exitCode: 1, stdout: '{"outcome":"fail","summary":"help-closes"}\n', stderr: '' };
    if (ctx.nodeId === 'docs') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', branch: `release-docs/${VERSION}`, worktree: docsTree }) + '\n', stderr: '' };
    if (ctx.nodeId === 'known-issues') {
      const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as GraphContext;
      const previousStateDir = process.env.ELANOUS_STATE_DIR;
      const previousGraphContext = process.env.ELANOUS_GRAPH_CONTEXT;
      process.env.ELANOUS_STATE_DIR = opts.env!.ELANOUS_STATE_DIR;
      process.env.ELANOUS_GRAPH_CONTEXT = opts.env!.ELANOUS_GRAPH_CONTEXT;
      try {
        const result = runKnownIssues(context, (command, args) => ({
          status: command === 'elanous' ? 3 : 0, stdout: args[0] === 'rev-list' ? '0\n' : '',
          stderr: command === 'elanous' ? 'model unavailable' : '',
        }));
        return { exitCode: 0, stdout: JSON.stringify(result) + '\n', stderr: '' };
      } finally {
        if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
        else process.env.ELANOUS_STATE_DIR = previousStateDir;
        if (previousGraphContext === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
        else process.env.ELANOUS_GRAPH_CONTEXT = previousGraphContext;
      }
    }
    return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
  };
  const git = (args: string[]) => args[0] === 'ls-remote' ? `${SHA}\trefs/heads/release/${VERSION}` : args[0] === 'rev-parse' ? SHA : '';
  try {
    mkdirSync(join(docsTree, 'release/public/docs/releases'), { recursive: true });
    writeFileSync(notes, '# Release\n');
    const first = await runGraph(graphPath, { input: { version: VERSION, branchCut: true, previousVersion: '0.2.18',
      acceptedRegressions: [{ id: 'R2', note: 'Settings do not persist' }] }, deps: { root, runBash } });
    expect(first.status).toBe('failed');
    expect(first.path.slice(-3)).toEqual(['tui', 'traffic-failed-restore', 'failed']);
    // A killed or timed-out node is recorded with exit null; rewrite the saved ledger to that shape.
    const stateFile = join(root, 'graph-runs', 'release-loop', `${first.runId}.json`);
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as GraphRunState;
    const failedTui = saved.nodes.find((node) => node.nodeId === 'tui')!;
    expect(failedTui).toMatchObject({ ok: false, executed: true });
    failedTui.exit = null;
    writeFileSync(stateFile, `${JSON.stringify(saved, null, 2)}\n`);
    const resumed = await resumeReleaseRun({ runId: first.runId, from: 'tui', waive: 'tui', reason: waiverReason }, { root, graphPath, git, runBash });
    expect(resumed.state.status).toBe('done');
    expect(resumed.state.nodes.find((node) => node.nodeId === 'tui')).toMatchObject({ ok: true, executed: false, waiver: { original: { exit: null } } });
    expect(readFileSync(notes, 'utf8')).toContain(`- ${waiverReason}.`);
    expect(readFileSync(notes, 'utf8')).toContain('- Known issues have been reported for this release.');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// stopped, sweep-incomplete, and killed gate waiver graph paths run in the release simulation rig.

// Appended-tip re-gate and measured waiver now run in the release simulation rig.

// The old graph measured waiver contract runs through the release simulation rig.

test('accepted regressions without a waiver are persisted and delivered to the graph and known-issues node', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-accepted-resume-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const seen: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
  let tuiVisits = 0;
  const runBash = async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    const ctx = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as {
      nodeId: string; input: Record<string, unknown>; outputs?: Record<string, { outcome?: string }>;
    };
    seen.push(ctx);
    if (ctx.nodeId === 'version-release') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', version: VERSION, commit: SHA, branch: `release/${VERSION}` }), stderr: '' };
    if (ctx.nodeId === 'tui' && ++tuiVisits === 1) return { exitCode: 1, stdout: '{"outcome":"fail"}', stderr: '' };
    return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}', stderr: '' };
  };
  const git = (args: string[]) => args[0] === 'ls-remote' ? `${SHA}\trefs/heads/release/${VERSION}` : args[0] === 'rev-parse' ? SHA : '';
  try {
    const first = await runGraph(graphPath, { input: { version: VERSION, branchCut: true, previousVersion: '0.2.18' }, deps: { root, runBash } });
    expect(first.status).toBe('failed');
    const added = [{ id: 'R2', note: 'Settings do not persist' }];
    const resumed = await resumeReleaseRun({ runId: first.runId, from: 'tui', acceptedRegressions: added }, { root, graphPath, git, runBash });
    expect(resumed.state.status).toBe('done');
    expect(tuiVisits).toBe(2);
    expect(resumed.state.input).toMatchObject({ acceptedRegressions: added });
    expect(seen.find((ctx) => ctx.nodeId === 'known-issues')?.input.acceptedRegressions).toEqual(added);
    const saved = JSON.parse(readFileSync(join(root, 'graph-runs/release-loop', `${first.runId}.json`), 'utf8')) as GraphRunState;
    expect(saved.input).toEqual(resumed.state.input);
    expect(saved.nodes.find((node) => node.nodeId === 'tui')?.waiver).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a waived tui keeps its recorded issue while failed publish waits at approve-continue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-retire-waiver-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const docsTree = join(root, 'docs-tree');
  const notes = join(docsTree, 'release/public/docs/releases', `${VERSION}.md`);
  let tuiVisits = 0;
  let docsVisits = 0;
  const seen: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
  const runBash = async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    const ctx = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as {
      nodeId: string;
      input: Record<string, unknown>;
      outputs?: Record<string, { outcome?: string }>;
    };
    seen.push(ctx);
    if (ctx.nodeId === 'version-release') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', version: VERSION, commit: SHA, branch: `release/${VERSION}` }), stderr: '' };
    if (ctx.nodeId === 'tui') return ++tuiVisits === 1
      ? { exitCode: 1, stdout: '{"outcome":"fail","summary":"help-closes"}', stderr: '' }
      : { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}', stderr: '' };
    if (ctx.nodeId === 'docs') {
      docsVisits++;
      if (docsVisits === 2) writeFileSync(notes, '# Release\n');
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', branch: `release-docs/${VERSION}`, worktree: docsTree }), stderr: '' };
    }
    if (ctx.nodeId === 'known-issues') {
      const result = spawnSync('bash', ['-c', _body], {
        cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...opts.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
      });
      return { exitCode: result.status ?? 2, stdout: result.stdout, stderr: result.stderr };
    }
    if (ctx.nodeId === 'publish' && docsVisits === 1) return { exitCode: 1, stdout: '{"outcome":"fail"}', stderr: '' };
    return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}', stderr: '' };
  };
  const git = (args: string[]) => args[0] === 'ls-remote' ? `${SHA}\trefs/heads/release/${VERSION}` : args[0] === 'rev-parse' ? SHA : '';
  try {
    mkdirSync(join(docsTree, 'release/public/docs/releases'), { recursive: true });
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/git'), '#!/usr/bin/env node\nif (process.argv[2] === "rev-list") console.log("0");\n');
    writeFileSync(join(root, 'bin/elanous'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({reply: JSON.stringify([{ id: "R2", bullet: "Settings do not persist after restarting." }])}));\n');
    chmodSync(join(root, 'bin/git'), 0o755);
    chmodSync(join(root, 'bin/elanous'), 0o755);
    writeFileSync(notes, '# Release\n');
    const deps = { root, graphPath, git, runBash };
    const first = await runGraph(graphPath, { input: { version: VERSION, branchCut: true, previousVersion: '0.2.18',
      acceptedRegressions: [{ id: 'R2', note: 'Settings do not persist' }] }, deps: { root, runBash } });
    expect(first.path.slice(-3)).toEqual(['tui', 'traffic-failed-restore', 'failed']);
    const waived = await resumeReleaseRun({ runId: first.runId, from: 'tui', waive: 'tui', reason: 'Help does not close when requested' }, deps);
    expect(waived.state.status).toBe('awaiting-approval');
    expect(waived.state.pending?.nodeId).toBe('approve-continue');
    expect(waived.state.path).toContain('known-issues');
    expect((waived.state.input as { acceptedRegressions: unknown[] }).acceptedRegressions).toHaveLength(2);
    expect(tuiVisits).toBe(1);
    expect(seen.filter((ctx) => ctx.nodeId === 'known-issues').at(-1)?.input.acceptedRegressions).toEqual([
      { id: 'R2', note: 'Settings do not persist' },
      { id: 'waive:tui', note: 'Help does not close when requested' },
    ]);
    expect(waived.state.nodes.find((node) => node.nodeId === 'tui')?.waiver).toMatchObject({ reason: 'Help does not close when requested' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restarting before a waived tui (from mac-smoke) keeps its issue while publish awaits approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-retire-waiver-earlier-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const docsTree = join(root, 'docs-tree');
  const notes = join(docsTree, 'release/public/docs/releases', `${VERSION}.md`);
  let tuiVisits = 0;
  let docsVisits = 0;
  const seen: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
  const runBash = async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    const ctx = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { nodeId: string; input: Record<string, unknown>; outputs?: Record<string, { outcome?: string }> };
    seen.push(ctx);
    if (ctx.nodeId === 'version-release') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', version: VERSION, commit: SHA, branch: `release/${VERSION}` }), stderr: '' };
    if (ctx.nodeId === 'tui') return ++tuiVisits === 1
      ? { exitCode: 1, stdout: '{"outcome":"fail","summary":"help-closes"}', stderr: '' }
      : { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}', stderr: '' };
    if (ctx.nodeId === 'docs') {
      docsVisits++;
      if (docsVisits === 2) writeFileSync(notes, '# Release\n');
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', branch: `release-docs/${VERSION}`, worktree: docsTree }), stderr: '' };
    }
    if (ctx.nodeId === 'known-issues') return { exitCode: 0,
      stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: 'known-issues fixture', count: 1 }) + '\n', stderr: '' };
    if (ctx.nodeId === 'publish' && docsVisits === 1) return { exitCode: 1, stdout: '{"outcome":"fail"}', stderr: '' };
    return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}', stderr: '' };
  };
  const git = (args: string[]) => args[0] === 'ls-remote' ? `${SHA}\trefs/heads/release/${VERSION}` : args[0] === 'rev-parse' ? SHA : '';
  try {
    mkdirSync(join(docsTree, 'release/public/docs/releases'), { recursive: true });
    writeFileSync(notes, '# Release\n');
    const deps = { root, graphPath, git, runBash };
    const first = await runGraph(graphPath, { input: { version: VERSION, branchCut: true, previousVersion: '0.2.18',
      acceptedRegressions: [{ id: 'R2', note: 'Settings do not persist' }] }, deps: { root, runBash } });
    expect(first.path.slice(-3)).toEqual(['tui', 'traffic-failed-restore', 'failed']);
    const waived = await resumeReleaseRun({ runId: first.runId, from: 'tui', waive: 'tui', reason: 'Help does not close when requested' }, deps);
    expect(waived.state.status).toBe('awaiting-approval');
    expect(waived.state.pending?.nodeId).toBe('approve-continue');
    expect(waived.state.path).toContain('known-issues');
    expect((waived.state.input as { acceptedRegressions: unknown[] }).acceptedRegressions).toHaveLength(2);
    expect(waived.state.path.indexOf('pre-prepare-join')).toBeGreaterThanOrEqual(0);
    expect(waived.state.path.indexOf('pre-prepare-join')).toBeLessThan(waived.state.path.indexOf('tui'));
    expect(Object.values(waived.state.fanOuts ?? {}).some((fanout) => fanout.from === 'traffic-gate-passed'
      && Object.hasOwn(fanout.branches, 'mac-smoke') && Object.hasOwn(fanout.branches, 'pwa'))).toBe(true);
    expect(tuiVisits).toBe(1);
    expect(seen.filter((ctx) => ctx.nodeId === 'known-issues').at(-1)?.input.acceptedRegressions).toEqual([
      { id: 'R2', note: 'Settings do not persist' },
      { id: 'waive:tui', note: 'Help does not close when requested' },
    ]);
    expect(waived.state.nodes.find((node) => node.nodeId === 'tui')?.waiver).toMatchObject({ reason: 'Help does not close when requested' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(['partial', 'unknown'] as const)('real publish entrypoint routes %s publication to approval and resumes the same run at npm-publish', async (publication) => {
  const root = mkdtempSync(join(tmpdir(), `release-publish-${publication}-`));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const version = '0.2.19';
  const commit = SHA;
  let publishCalls = 0;
  let npmPublishCalls = 0;
  const previousGraphContext = process.env.ELANOUS_GRAPH_CONTEXT;
  const runBash = async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    const context = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as {
      nodeId: string; runId: string; input: Record<string, unknown>; outputs: Record<string, Record<string, unknown>>;
    };
    if (context.nodeId === 'version-release') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', version, commit, branch: `release/${version}` }), stderr: '' };
    if (context.nodeId === 'prepare') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', commit, out: root }), stderr: '' };
    if (context.nodeId === 'docs') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', branch: `release-docs/${version}` }), stderr: '' };
    if (context.nodeId === 'tui') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', regress: { pass: 7, fail: 0,
      results: Array.from({ length: 7 }, (_, index) => ({ id: `R${index + 1}`, title: 'check', ok: true, reason: 'measured' })) } }), stderr: '' };
    if (context.nodeId === 'auto-approve') return { exitCode: 0, stdout: JSON.stringify({
      outcome: 'ok', runId: context.runId, decidedBy: 'release-loop metrics',
      tuiSubcheck: { runId: context.runId, level: 'ok', fail: 0, failedCheckIds: [], approvalRequired: false },
      metrics: [...BLOCKING_METRIC_NAMES.map((name) => ({ name, verdict: 'pass' })),
        { name: 'tui-regress', verdict: 'pass' }, { name: 'mac-smoke', verdict: 'pass' }],
    }), stderr: '' };
    if (context.nodeId === 'publish') {
      publishCalls++;
      process.env.ELANOUS_GRAPH_CONTEXT = opts.env!.ELANOUS_GRAPH_CONTEXT;
      try {
        const result = runPublish((command, args) => {
          if (command === 'git') return { status: 0, stdout: args[1]?.endsWith('pages.json') ? '{"pages":[]}' : `# ${version}\n\nRelease notes\n`, stderr: '' };
          if (command === 'bun' && args[0] === 'bin/elanous.mjs') return { status: 0, stdout: JSON.stringify(publication === 'partial'
            ? { published: true, ok: false, tag: `v${version}`, error: 'asset inventory incomplete' }
            : { ok: false, error: 'publish response missing' }), stderr: '' };
          throw new Error(`unexpected publish boundary: ${command} ${args.join(' ')}`);
        }, root, undefined, root);
        return { exitCode: 0, stdout: JSON.stringify(result), stderr: '' };
      } finally {
        if (previousGraphContext === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
        else process.env.ELANOUS_GRAPH_CONTEXT = previousGraphContext;
      }
    }
    if (context.nodeId === 'npm-publish') {
      npmPublishCalls++;
      return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}', stderr: '' };
    }
    return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}', stderr: '' };
  };
  try {
    const deps = { root, runBash };
    const first = await runGraph(graphPath, { input: { version, previousVersion: '0.2.18', branchCut: true }, deps });
    expect(first.status).toBe('awaiting-approval');
    expect(first.pending?.nodeId).toBe('approve-continue');
    expect(first.path.at(-2)).toBe('publish');
    const publishRecord = first.nodes.find((node) => node.nodeId === 'publish');
    expect(JSON.parse(String(publishRecord?.output))).toMatchObject(publication === 'partial'
      ? { outcome: 'partial', partialPublish: { published: true } }
      : { outcome: 'unknown', partialPublish: { published: 'unknown' } });
    expect(publishCalls).toBe(1);
    expect(npmPublishCalls).toBe(0);

    decideGraphApproval(first.graphId, first.runId, 'approved', 'human', root);
    const resumed = await runGraph(graphPath, { resumeRunId: first.runId, deps });
    expect(resumed.status).toBe('done');
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.path.filter((nodeId) => nodeId === 'publish')).toHaveLength(1);
    expect(publishCalls).toBe(1);
    expect(npmPublishCalls).toBe(1);
  } finally {
    if (previousGraphContext === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = previousGraphContext;
    rmSync(root, { recursive: true, force: true });
  }
});

test('release resume CLI validates waiver JSON and pairing before opening a saved run, preserving JSON error exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-waiver-cli-'));
  const previousExit = process.exitCode;
  const lines: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((value: string | Uint8Array) => { lines.push(String(value).trim()); return true; }) as typeof process.stdout.write;
  setElanousConfigDir(root);
  mkdirSync(join(root, 'graph-runs/release-loop'), { recursive: true });
  writeFileSync(join(root, 'graph-runs/release-loop/missing.json'), '{}');
  try {
    const invoke = async (...args: string[]) => {
      process.exitCode = 0;
      const cmd = new Command();
      registerReleaseCommands(cmd);
      await cmd.parseAsync(['release', 'resume', '--run', 'missing', '--from', 'tui', '--json', ...args], { from: 'user' });
      return JSON.parse(lines.at(-1)!) as { ok: boolean; error: string };
    };
    expect(await invoke('--waive', 'tui', '--reason', 'Help does not close', '--accepted-regressions', 'bad')).toMatchObject({ ok: false, error: '--accepted-regressions must be a JSON array of {id, note}' });
    expect(process.exitCode).toBe(1);
    expect((await invoke('--waive', 'tui', '--reason', 'Help does not close', '--accepted-regressions', '{}')).error).toContain('acceptedRegressions must be an array');
    expect((await invoke('--waive', 'tui')).error).toContain('supplied together');
    expect((await invoke('--waive', '', '--reason', 'Help does not close')).error).toContain('--waive must not be empty');
    expect((await invoke('--accepted-regressions', '[]')).error).toContain('run identity mismatch');
    expect((await invoke('--gate-pod-pool', 'pool-new')).error).toContain('run identity mismatch');
    expect((await invoke()).error).toContain('run identity mismatch');
    process.exitCode = 0;
    const waiveWithoutFrom = new Command();
    registerReleaseCommands(waiveWithoutFrom);
    await waiveWithoutFrom.parseAsync(['release', 'resume', '--run', 'missing', '--waive', 'gate', '--reason',
      'Known failures remain. Users may encounter these issues.', '--accepted-regressions', '[]', '--json'], { from: 'user' });
    expect(JSON.parse(lines.at(-1)!).error).toContain('run identity mismatch');
    const ownerGateFromCli = new Command();
    registerReleaseCommands(ownerGateFromCli);
    await ownerGateFromCli.parseAsync(['release', 'resume', '--run', 'missing', '--owner-waive', 'gate', '--approved-by', 'OP', '--reason', 'Known failures remain. Users may encounter these issues.', '--json'], { from: 'user' });
    expect(JSON.parse(lines.at(-1)!).error).toContain('run identity mismatch');
    const ownerWithoutApprover = new Command();
    registerReleaseCommands(ownerWithoutApprover);
    await ownerWithoutApprover.parseAsync(['release', 'resume', '--run', 'missing', '--owner-waive', 'gate', '--reason', 'Known failures remain. Users may encounter these issues.', '--json'], { from: 'user' });
    expect(JSON.parse(lines.at(-1)!).error).toContain('--owner-waive requires --approved-by');
    const ownerWithoutReason = new Command();
    registerReleaseCommands(ownerWithoutReason);
    await ownerWithoutReason.parseAsync(['release', 'resume', '--run', 'missing', '--owner-waive', 'gate', '--approved-by', 'OP', '--json'], { from: 'user' });
    expect(JSON.parse(lines.at(-1)!).error).toContain('--owner-waive requires --reason');
    const legacyTuiWithoutFrom = new Command();
    registerReleaseCommands(legacyTuiWithoutFrom);
    await legacyTuiWithoutFrom.parseAsync(['release', 'resume', '--run', 'missing', '--waive', 'tui', '--reason',
      'Help does not close. Users may encounter this issue.', '--json'], { from: 'user' });
    expect(JSON.parse(lines.at(-1)!).error).toContain('--from is required unless --waive gate is used');
  } finally {
    process.stdout.write = write;
    process.exitCode = previousExit ?? 0;
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
});

test('release resume --gate-pod-pool updates the saved run input before re-running gate and records both values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gate-pool-resume-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const gateContexts: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
  const runBash = async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    const ctx = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { nodeId: string; input: Record<string, unknown>; outputs?: Record<string, { outcome?: string }> };
    if (ctx.nodeId === 'gate') {
      gateContexts.push(ctx);
      return gateContexts.length === 1
        ? { exitCode: 2, stdout: '{"outcome":"error","verdict":"fail","summary":"pool unavailable"}\n', stderr: '' }
        : { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
    }
    if (ctx.nodeId === 'receipt-audit') {
      const gate = ctx.outputs?.['residual-run'] ?? ctx.outputs?.gate;
      const outcome = gate?.outcome === 'error' ? 'error' : gate?.outcome === 'ok' ? 'ok' : 'fail';
      return { exitCode: outcome === 'ok' ? 0 : outcome === 'error' ? 2 : 1,
        stdout: JSON.stringify({ outcome, verdict: outcome === 'ok' ? 'pass' : 'fail', summary: 'fixture receipt audit' }) + '\n', stderr: '' };
    }
    if (ctx.nodeId === 'version-release') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', version: VERSION, commit: SHA, branch: `release/${VERSION}` }) + '\n', stderr: '' };
    return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
  };
  const git = (args: string[]) => args[0] === 'ls-remote' ? `${SHA}\trefs/heads/release/${VERSION}` : args[0] === 'rev-parse' ? SHA : '';
  try {
    const first = await runGraph(graphPath, { input: { version: VERSION, branchCut: true, previousVersion: '0.2.18', gatePodPool: 'pool-old' }, deps: { root, runBash } });
    expect(first.status).toBe('failed');
    const stateFile = join(root, 'graph-runs', 'release-loop', `${first.runId}.json`);
    // Exercise the runner override seam without acquiring the shared OP release flock.
    const resumed = await runGraph(graphPath, { resumeRunId: first.runId, fromNodeId: 'gate', releaseGatePodPool: ' pool-new ', deps: { root, runBash } });
    expect(gateContexts.map((ctx) => ctx.input.gatePodPool)).toEqual(['pool-old', 'pool-new']);
    expect(resumed.input).toMatchObject({ gatePodPool: 'pool-new' });
    expect(resumed.inputOverrides).toMatchObject([{ kind: 'gate-pod-pool', from: 'gate', set: { gatePodPool: 'pool-new' }, previous: { gatePodPool: 'pool-old' } }]);
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as GraphRunState;
    expect(saved.inputOverrides).toEqual(resumed.inputOverrides);
    expect(saved.input).toMatchObject({ gatePodPool: 'pool-new' });
    const afterGate = { ...first, path: [...first.path.slice(0, first.path.indexOf('gate') + 1), 'mac-smoke', 'failed'] };
    expect(() => releaseResumeGatePodPool(afterGate, { from: 'mac-smoke', pool: 'pool-new' })).toThrow('re-runs gate');
    expect(() => releaseResumeGatePodPool(first, { from: 'gate', pool: '  ' })).toThrow('must not be empty');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);

test('measured gate regressions are never waivable while stopped or incomplete runs remain unmeasured', () => {
  const ids = ['src/a.test.ts > first failure', 'src/b.test.ts > second failure'];
  const reason = 'Known gate failures remain in this release. Users may encounter these issues during normal use.';
  const stateFor = (output: Record<string, unknown>, executed = true) => ({
    path: ['version-release', 'gate', 'gate-triage', 'traffic-failed-restore', 'failed'],
    nodes: [
      { nodeId: 'version-release', ok: true, executed: true, exit: 0 },
      { nodeId: 'gate', ok: false, executed, exit: 1, output: JSON.stringify(output) },
      { nodeId: 'gate-triage', ok: true, executed: true, exit: 0 },
      { nodeId: 'traffic-failed-restore', ok: true, executed: true, exit: 0 },
      { nodeId: 'failed', ok: true, executed: false, exit: null },
    ],
    input: { version: VERSION }, statePath: '/tmp/release-gate-waive-test.json',
  }) as GraphRunState;
  const verdict = { outcome: 'fail', verdict: 'fail', introduced: ids, preexisting: 2, knownEnv: 0, durationMs: 12_000,
    stalledEnv: [], stalledShards: [], unmeasuredRecheckFiles: [], unmeasuredErrors: [], rcNonzeroNoFailures: [], abortedShards: 0 };
  expect(() => releaseResumeWaiver(stateFor(verdict), { from: 'gate', waive: 'gate', reason, approvedBy: 'OP',
    acceptedRegressions: [{ id: ids[0]!, note: 'Failure remains' }] })).toThrow('measured gate regressions cannot be waived');
  expect(() => releaseResumeWaiver(stateFor(verdict), { from: 'gate', waive: 'gate', reason, approvedBy: 'OP',
    acceptedRegressions: ids.map((id) => ({ id, note: 'Failure remains' })) })).toThrow('measured gate regressions cannot be waived');
  const unmeasured = { ...verdict, outcome: 'error', introduced: [], error: 'pod sweep incomplete', stalledShards: [{ reason: 'no-output' }] };
  expect(releaseResumeWaiver(stateFor(unmeasured), { from: 'gate', waive: 'gate', reason,
    acceptedRegressions: ids.map((id) => ({ id, note: 'Failure remains' })) })?.unmeasured).toContain('sweep incomplete');
  const attributionIncomplete = { ...verdict, outcome: 'error', introduced: [], error: 'failure attribution incomplete', stalledShards: [] };
  expect(releaseResumeWaiver(stateFor(attributionIncomplete), { from: 'gate', waive: 'gate', reason,
    acceptedRegressions: ids.map((id) => ({ id, note: 'Failure remains' })) })?.unmeasured).toContain('failure attribution incomplete');
  const killed = stateFor({ executionId: 'gate-execution', error: 'process terminated by SIGTERM' });
  killed.nodes[1] = { ...killed.nodes[1]!, exit: null, error: 'bash exit null: process terminated by SIGTERM' };
  expect(releaseResumeWaiver(killed, { from: 'gate', waive: 'gate', reason,
    acceptedRegressions: ids.map((id) => ({ id, note: 'Failure remains' })) })?.unmeasured).toContain('SIGTERM');
  const killedWithExit = stateFor({ executionId: 'gate-execution', error: 'process terminated by SIGTERM' });
  expect(() => releaseResumeWaiver(killedWithExit, { from: 'gate', waive: 'gate', reason,
    acceptedRegressions: ids.map((id) => ({ id, note: 'Failure remains' })) })).toThrow('cannot waive a safety, side-effect or approval node');
  const verdictThenDiagnostic = stateFor({ executionId: 'gate-execution', error: 'process terminated by SIGTERM' });
  verdictThenDiagnostic.nodes[1] = { ...verdictThenDiagnostic.nodes[1]!, exit: null,
    output: `${JSON.stringify(verdict)}\n${JSON.stringify({ executionId: 'gate-execution', error: 'process terminated by SIGTERM' })}` };
  expect(() => releaseResumeWaiver(verdictThenDiagnostic, { from: 'gate', waive: 'gate', reason,
    acceptedRegressions: ids.map((id) => ({ id, note: 'Failure remains' })) })).toThrow('cannot waive a safety, side-effect or approval node');
  expect(() => releaseResumeWaiver(stateFor(verdict, false), { from: 'gate', waive: 'gate', reason, approvedBy: 'OP',
    acceptedRegressions: ids.map((id) => ({ id, note: 'Failure remains' })) })).toThrow(/failed executable node/);
  const missingCompleteness = { ...verdict }; delete (missingCompleteness as Record<string, unknown>).rcNonzeroNoFailures;
  expect(() => releaseResumeWaiver(stateFor(missingCompleteness), { from: 'gate', waive: 'gate', reason, approvedBy: 'OP',
    acceptedRegressions: ids.map((id) => ({ id, note: 'Failure remains' })) })).toThrow('measured gate regressions cannot be waived');
  const malformedCompleteness = { ...verdict, unmeasuredErrors: 'none' };
  expect(() => releaseResumeWaiver(stateFor(malformedCompleteness), { from: 'gate', waive: 'gate', reason, approvedBy: 'OP',
    acceptedRegressions: ids.map((id) => ({ id, note: 'Failure remains' })) })).toThrow('measured gate regressions cannot be waived');
});

test('waiver rejects unrecorded nodes, unsafe side effects, invalid input and duplicate public issue IDs', () => {
  const state = { path: ['version-release', 'tui', 'failed'], nodes: [{ nodeId: 'version-release', ok: true, executed: true },
    { nodeId: 'tui', ok: false, executed: true }, { nodeId: 'failed', ok: true, executed: false }], input: { version: VERSION } } as GraphRunState;
  expect(releaseResumeWaiver(state, { from: 'tui' })).toBeUndefined();
  expect(releaseResumeWaiver(state, { from: 'tui', acceptedRegressions: [{ id: 'R1', note: 'issue' }] })).toBeUndefined();
  expect(releaseResumeWaiver(state, { from: 'tui', acceptedRegressions: [] })).toBeUndefined();
  expect(() => releaseResumeWaiver(state, { from: 'tui', waive: '', reason: 'issue' })).toThrow('--waive must not be empty');
  expect(() => releaseResumeWaiver(state, { from: 'tui', waive: 'tui', reason: '  ' })).toThrow('must not be empty');
  for (const reason of ['Help does not close; see /Users/me/internal.test.ts', 'Help does not close (#22252)', 'Help does not close [TC]']) {
    expect(() => releaseResumeWaiver(state, { from: 'tui', waive: 'tui', reason })).toThrow('unsafe public waiver reason');
  }
  expect(() => releaseResumeWaiver(state, { from: 'tui', waive: 'tui', reason: 'issue', acceptedRegressions: [{ id: 'waive:tui', note: 'duplicate' }] })).toThrow('must be unique');
  expect(() => releaseResumeWaiver(state, { from: 'tui', waive: 'docs', reason: 'issue' })).toThrow('--from must name');
  state.nodes[1]!.ok = true;
  expect(() => releaseResumeWaiver(state, { from: 'tui', waive: 'tui', reason: 'issue' })).toThrow('requires the failed executable node');
  state.nodes[1]!.ok = false;
  state.path[1] = 'publish'; state.nodes[1]!.nodeId = 'publish';
  expect(() => releaseResumeWaiver(state, { from: 'publish', waive: 'publish', reason: 'issue' })).toThrow('cannot waive a safety, side-effect');
  state.path[1] = 'gate'; state.nodes[1]!.nodeId = 'gate';
  expect(() => releaseResumeWaiver(state, { from: 'gate', waive: 'gate', reason: 'Known failure persists. Users may encounter it.' })).toThrow('cannot waive a safety, side-effect');
  state.path[1] = 'tui'; state.nodes[1]!.nodeId = 'tui';
  state.nodes[1]!.executed = false;
  expect(() => releaseResumeWaiver(state, { from: 'tui', waive: 'tui', reason: 'issue' })).toThrow('requires the failed executable node');
});


test('release resume graph consumes the exact gate-waiver event and routes its named waived gate outcome', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-owner-waive-cli-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const trafficFile = join(root, 'traffic.json');
  const cutTip = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8' }).stdout.trim();
  const reason = 'Known gate failures remain in this release. Users may encounter these issues during normal use.';
  const lines: string[] = [];
  let mutateSavedGateBeforeGraph = false;
  let savedRunStatePath = '';
  let receiptAuditRuns = 0;
  const write = process.stdout.write;
  process.stdout.write = ((value: string | Uint8Array) => { lines.push(String(value).trim()); return true; }) as typeof process.stdout.write;
  const runBash = async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    const ctx = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { nodeId: string; outputs?: { gate?: { outcome?: string } } };
    if (ctx.nodeId === 'version-release') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', version: VERSION, commit: cutTip, branch: `release/${VERSION}` }) + '\n', stderr: '' };
    // The gate output may not carry a commit; the event remains bound to the saved release cut.
    if (ctx.nodeId === 'gate') return { exitCode: 1, stdout: JSON.stringify({ outcome: 'error', commit: cutTip, introduced: [], introducedIds: [], error: 'pod sweep incomplete: worker interrupted' }) + '\n', stderr: '' };
    // The first incomplete gate is rejected by receipt auditing; its owner-waived retry gets a complete synthetic audit.
    if (ctx.nodeId === 'receipt-audit' && receiptAuditRuns++ === 0) return { exitCode: 2, stdout: JSON.stringify({ outcome: 'error', verdict: 'fail', summary: 'gate sweep incomplete' }) + '\n', stderr: '' };
    return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
  };
  const graph = async (...args: Parameters<typeof runGraph>) => {
    const [path, options] = args;
    if (mutateSavedGateBeforeGraph && options?.releaseWaiver) {
      const diskState = JSON.parse(readFileSync(savedRunStatePath, 'utf8')) as GraphRunState;
      const gate = diskState.nodes.find((node) => node.nodeId === 'gate')!;
      gate.output = JSON.stringify({ outcome: 'error', commit: cutTip, introduced: [], introducedIds: [], error: 'pod sweep incomplete: a different worker stopped' }) + '\n';
      writeFileSync(savedRunStatePath, JSON.stringify(diskState, null, 2) + '\n');
      mutateSavedGateBeforeGraph = false;
    }
    return runGraph(path, options);
  };
  const deps = { root, repo: join(import.meta.dir, '../..'), graphPath, runBash, graph, trafficFile, ledgerRoot: root, isAncestor: () => true,
    git: (args: string[]) => args[0] === 'ls-remote' ? `${cutTip}\trefs/heads/release/${VERSION}` : args[0] === 'rev-parse' ? cutTip : '' };
  setElanousConfigDir(root);
  try {
    writeFileSync(trafficFile, '{}\n');
    const first = await runGraph(graphPath, { input: { version: VERSION, branchCut: true, previousVersion: '0.2.18' }, deps: { root, runBash } });
    savedRunStatePath = first.statePath;
    expect(first.status).toBe('failed');
    const before = readFileSync(first.statePath, 'utf8');
    const invoke = async (args: string[]) => {
      process.exitCode = 0; lines.length = 0;
      const command = new Command();
      registerReleaseCommands(command, {}, {}, {}, {}, {}, deps);
      await command.parseAsync(['release', 'resume', '--run', first.runId, '--json', ...args, '--no-partial'], { from: 'user' });
      return JSON.parse(lines.at(-1)!) as { ok?: boolean; error?: string; status?: string };
    };
    expect((await invoke(['--owner-waive', 'gate', '--reason', reason])).error).toContain('--owner-waive requires --approved-by');
    expect((await invoke(['--owner-waive', 'gate', '--approved-by', 'OP'])).error).toContain('--owner-waive requires --reason');
    expect(readFileSync(first.statePath, 'utf8')).toBe(before);
    const actor = 'OP';
    const expectedWaiverEvidence = gateWaiverEvidence({ reason, actor, unmeasured: 'sweep incomplete: pod sweep incomplete: worker interrupted' });
    const issuedAt = Date.now();
    const staleSuperset = issueGateWaiverEvent({ mode: 'operational', target: `run:${first.runId}`, head: cutTip,
      evidence: [`saved-run:${first.statePath}`, ...expectedWaiverEvidence, 'gate-waiver:unmeasured:previous failure detail'],
      actor, issuedAt, expiresAt: issuedAt + 86_400_000 });
    appendWaiverEvents(join(root, 'review-results', 'waiver-events.jsonl'), [staleSuperset]);
    mutateSavedGateBeforeGraph = true;
    const staleRequest = await invoke(['--owner-waive', 'gate', '--approved-by', 'OP', '--reason', reason]);
    expect(staleRequest.error).toContain('release waiver input changed before restart');
    const staleState = JSON.parse(readFileSync(first.statePath, 'utf8')) as GraphRunState;
    const staleEvents = readWaiverEvents(join(root, 'review-results', 'waiver-events.jsonl'));
    expect(staleEvents.every((event) => event.uses === 0)).toBe(true);
    expect(staleState.nodes.find((node) => node.nodeId === 'gate')?.output).toContain('different worker stopped');
    writeFileSync(first.statePath, before);
    const result = await invoke(['--owner-waive', 'gate', '--approved-by', 'OP', '--reason', reason]);
    expect(result).toMatchObject({ ok: true, status: 'done' });
    const saved = JSON.parse(readFileSync(first.statePath, 'utf8')) as GraphRunState;
    const waiverEvents = readWaiverEvents(join(root, 'review-results', 'waiver-events.jsonl'));
    expect(waiverEvents.find((event) => event.eventId === staleSuperset.eventId)).toMatchObject({ uses: 0 });
    expect(waiverEvents.find((event) => event.uses === 1)).toMatchObject({
      kind: 'gate', target: `run:${first.runId}`, head: cutTip, actor: 'OP', expiredBy: 'used',
      evidence: expect.arrayContaining([expect.stringContaining('Known gate failures remain')]),
    });
    expect(waiverEvents).toHaveLength(2);
    expect(saved.path).toContain('publish');
    const gate = saved.nodes.find((node) => node.nodeId === 'gate');
    expect(JSON.parse(String(gate?.output))).toMatchObject({ outcome: 'ok', verdict: 'owner-waived', approvedBy: 'OP', reason });
    expect(gate).toMatchObject({ ok: true, executed: false, waiver: { reason } });
    expect(saved.path[saved.path.indexOf('gate') + 1]).toBe('receipt-audit');
    expect(saved.nodes.find((node) => node.nodeId === 'receipt-audit')).toMatchObject({ ok: true, executed: true });
    expect(saved.fanOuts?.['traffic-gate-passed:ok']?.branches.pwa).toMatchObject({ status: 'done' });
    expect(saved.nodes.find((node) => node.nodeId === 'prepare')).toMatchObject({ ok: true, executed: true });
  } finally { process.stdout.write = write; process.exitCode = 0; resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
test('owner gate waiver rejects every nonempty or malformed measured regression signal', () => {
  const state = { path: ['version-release', 'gate', 'gate-triage', 'failed'], nodes: [
    { nodeId: 'version-release', ok: true, executed: true },
    { nodeId: 'gate', ok: false, executed: true, exit: 1, output: '{"outcome":"fail","introduced":1,"introducedIds":[]}' },
    { nodeId: 'gate-triage', ok: true, executed: true }, { nodeId: 'failed', ok: false, executed: true },
  ], input: { version: '0.3.0', acceptedRegressions: [] } } as unknown as GraphRunState;
  for (const signal of [
    { introduced: 1, introducedIds: [] },
    { introduced: ['src/a.test.ts > regression'] },
    { introduced: ['src/a.test.ts > regression', ''] },
    { introducedIds: ['src/a.test.ts > regression'] },
  ]) {
    const measured = structuredClone(state);
    measured.nodes[1]!.output = JSON.stringify({ outcome: 'fail', ...signal });
    expect(() => releaseResumeWaiver(measured, { from: 'gate', ownerWaive: 'gate', reason: 'Owner approved known gate risk.', approvedBy: 'OP' }))
      .toThrow('measured gate regressions cannot be waived');
  }
  const completeMeasuredNoRegressions = structuredClone(state);
  completeMeasuredNoRegressions.nodes[1]!.output = JSON.stringify({ outcome: 'fail', verdict: 'fail', introduced: [], introducedIds: [],
    preexisting: 0, knownEnv: 0, durationMs: 1, error: '', stalledShards: [], stalledEnv: [], unmeasuredRecheckFiles: [],
    unmeasuredErrors: [], rcNonzeroNoFailures: [], abortedShards: 0 });
  expect(() => releaseResumeWaiver(completeMeasuredNoRegressions, { from: 'gate', ownerWaive: 'gate',
    reason: 'Owner approved known gate risk.', approvedBy: 'OP' })).toThrow('owner gate waiver requires an unmeasured gate');
  const unmeasured = structuredClone(state);
  unmeasured.nodes[1]!.output = JSON.stringify({ outcome: 'error', introduced: [], introducedIds: [], error: 'pod sweep incomplete: worker interrupted' });
  expect(() => releaseResumeWaiver(state, { from: 'gate', ownerWaive: 'gate', reason: 'Owner approved known gate risk.' })).toThrow('--owner-waive requires --approved-by');
  expect(releaseResumeWaiver(unmeasured, { from: 'gate', ownerWaive: 'gate', reason: 'Owner approved known gate risk.', approvedBy: 'OP' }))
    .toMatchObject({ nodeId: 'gate', approvedBy: 'OP', ownerWaived: true, unmeasured: 'sweep incomplete: pod sweep incomplete: worker interrupted',
      acceptedRegressions: [{ id: 'waive:gate', note: 'Owner approved known gate risk.' }] });
});
