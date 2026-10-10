import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph, type GraphRunState } from '../../src/graph-runner/runner.js';
import { Command } from 'commander';
import { registerReleaseCommands } from '../../src/cli/release-cli.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../../src/elanous-config-dir.js';
import { resumeReleaseRun } from './resume-release.js';
import { releaseResumeWaiver } from './resume.js';

const SHA = 'a'.repeat(40);
const VERSION = '0.2.19';

test('waive the failed tui node on the saved release path; record the original failure and pass accepted regressions to known-issues', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-waiver-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const seen: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
  const bin = join(root, 'bin');
  const calls = join(root, 'ask-calls');
  const docsTree = join(root, 'docs-tree');
  const notes = join(docsTree, 'release/public/docs/releases', `${VERSION}.md`);
  const runBash = async (body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    const ctx = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { nodeId: string; input: Record<string, unknown> };
    seen.push(ctx);
    if (ctx.nodeId === 'version-release') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', version: VERSION, commit: SHA, branch: `release/${VERSION}` }) + '\n', stderr: '' };
    if (ctx.nodeId === 'tui') return { exitCode: 1, stdout: '{"outcome":"fail","summary":"help-closes"}\n', stderr: '' };
    if (ctx.nodeId === 'docs') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', branch: `release-docs/${VERSION}`, worktree: docsTree }) + '\n', stderr: '' };
    if (ctx.nodeId === 'known-issues') {
      expect(body).toContain('bun scripts/release-loop/known-issues-node.ts');
      const child = spawnSync('bash', ['-c', body], {
        cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...opts.env, PATH: `${bin}:${process.env.PATH}`,
          KNOWN_ASK_CALLS: calls },
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
    expect(first.path.slice(-2)).toEqual(['tui', 'failed']);
    const stateFile = join(root, 'graph-runs', 'release-loop', `${first.runId}.json`);
    const before = readFileSync(stateFile, 'utf8');
    const deps = { root, graphPath, git, runBash };
    await expect(resumeReleaseRun({ runId: first.runId, from: 'docs' }, deps)).rejects.toThrow('not a node on the saved path');
    await expect(resumeReleaseRun({ runId: first.runId, from: 'tui', waive: 'tui' }, deps)).rejects.toThrow('supplied together');
    await expect(resumeReleaseRun({ runId: first.runId, from: 'tui', waive: 'gate', reason: 'Help does not close' }, deps)).rejects.toThrow('--from must name');
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
  const bin = join(root, 'bin');
  const docsTree = join(root, 'docs-tree');
  const notes = join(docsTree, 'release/public/docs/releases', `${VERSION}.md`);
  const runBash = async (body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    const ctx = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { nodeId: string };
    if (ctx.nodeId === 'version-release') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', version: VERSION, commit: SHA, branch: `release/${VERSION}` }) + '\n', stderr: '' };
    if (ctx.nodeId === 'tui') return { exitCode: 1, stdout: '{"outcome":"fail","summary":"help-closes"}\n', stderr: '' };
    if (ctx.nodeId === 'docs') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', branch: `release-docs/${VERSION}`, worktree: docsTree }) + '\n', stderr: '' };
    if (ctx.nodeId === 'known-issues') {
      const child = spawnSync('bash', ['-c', body], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...opts.env, PATH: `${bin}:${process.env.PATH}` } });
      return { exitCode: child.status ?? 2, stdout: child.stdout, stderr: child.stderr };
    }
    return { exitCode: 0, stdout: '{"outcome":"ok","verdict":"pass"}\n', stderr: '' };
  };
  const git = (args: string[]) => args[0] === 'ls-remote' ? `${SHA}\trefs/heads/release/${VERSION}` : args[0] === 'rev-parse' ? SHA : '';
  try {
    mkdirSync(join(docsTree, 'release/public/docs/releases'), { recursive: true });
    mkdirSync(bin);
    // The model is unavailable: every ask exits non-zero.
    writeFileSync(join(bin, 'elanous'), '#!/usr/bin/env node\nprocess.exit(3);\n');
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
if (process.argv[2] === 'rev-list') console.log('0');
`);
    chmodSync(join(bin, 'elanous'), 0o755);
    chmodSync(join(bin, 'git'), 0o755);
    writeFileSync(notes, '# Release\n');
    const first = await runGraph(graphPath, { input: { version: VERSION, branchCut: true, previousVersion: '0.2.18' }, deps: { root, runBash } });
    expect(first.status).toBe('failed');
    expect(first.path.slice(-2)).toEqual(['tui', 'failed']);
    // A killed or timed-out node is recorded with exit null; rewrite the saved ledger to that shape.
    const stateFile = join(root, 'graph-runs', 'release-loop', `${first.runId}.json`);
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as GraphRunState;
    const failedTui = saved.nodes.find((node) => node.nodeId === 'tui')!;
    expect(failedTui).toMatchObject({ ok: false, executed: true });
    failedTui.exit = null;
    writeFileSync(stateFile, `${JSON.stringify(saved, null, 2)}\n`);
    const resumed = await resumeReleaseRun({ runId: first.runId, from: 'tui', waive: 'tui', reason: 'Help does not close when requested' }, { root, graphPath, git, runBash });
    expect(resumed.state.status).toBe('done');
    expect(resumed.state.nodes.find((node) => node.nodeId === 'tui')).toMatchObject({ ok: true, executed: false, waiver: { original: { exit: null } } });
    expect(readFileSync(notes, 'utf8')).toContain('- Help does not close when requested.');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('accepted regressions without a waiver are persisted and delivered to the graph and known-issues node', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-accepted-resume-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const seen: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
  let tuiVisits = 0;
  const runBash = async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    const ctx = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { nodeId: string; input: Record<string, unknown> };
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

test('rerunning a waived tui without waiver retires only its recorded issue before known-issues', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-retire-waiver-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const docsTree = join(root, 'docs-tree');
  const notes = join(docsTree, 'release/public/docs/releases', `${VERSION}.md`);
  let tuiVisits = 0;
  let docsVisits = 0;
  const seen: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
  const runBash = async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    const ctx = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { nodeId: string; input: Record<string, unknown> };
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
    expect(first.path.slice(-2)).toEqual(['tui', 'failed']);
    const waived = await resumeReleaseRun({ runId: first.runId, from: 'tui', waive: 'tui', reason: 'Help does not close when requested' }, deps);
    expect(waived.state.status).toBe('failed');
    expect(waived.state.path).toContain('known-issues');
    expect((waived.state.input as { acceptedRegressions: unknown[] }).acceptedRegressions).toHaveLength(2);
    const resumed = await resumeReleaseRun({ runId: first.runId, from: 'tui' }, deps);
    expect(resumed.state.status).toBe('done');
    expect(tuiVisits).toBe(2);
    expect(seen.filter((ctx) => ctx.nodeId === 'known-issues').at(-1)?.input.acceptedRegressions).toEqual([
      { id: 'R2', note: 'Settings do not persist' },
    ]);
    expect((resumed.state.input as { acceptedRegressions: unknown[] }).acceptedRegressions).toEqual([{ id: 'R2', note: 'Settings do not persist' }]);
    expect(resumed.state.nodes.find((node) => node.nodeId === 'tui')?.waiver).toBeUndefined();
    const saved = JSON.parse(readFileSync(join(root, 'graph-runs/release-loop', `${first.runId}.json`), 'utf8')) as GraphRunState;
    expect(saved.input).toEqual(resumed.state.input);
    expect(readFileSync(notes, 'utf8')).not.toContain('Help does not close when requested');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restarting before a waived tui (from mac-smoke) drops the waiver record and its accepted issue together', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-retire-waiver-earlier-'));
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const docsTree = join(root, 'docs-tree');
  const notes = join(docsTree, 'release/public/docs/releases', `${VERSION}.md`);
  let tuiVisits = 0;
  let docsVisits = 0;
  const seen: Array<{ nodeId: string; input: Record<string, unknown> }> = [];
  const runBash = async (_body: string, opts: { env?: NodeJS.ProcessEnv }) => {
    const ctx = JSON.parse(readFileSync(opts.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { nodeId: string; input: Record<string, unknown> };
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
    expect(first.path.slice(-2)).toEqual(['tui', 'failed']);
    const waived = await resumeReleaseRun({ runId: first.runId, from: 'tui', waive: 'tui', reason: 'Help does not close when requested' }, deps);
    expect(waived.state.status).toBe('failed');
    expect(waived.state.path).toContain('known-issues');
    expect((waived.state.input as { acceptedRegressions: unknown[] }).acceptedRegressions).toHaveLength(2);
    expect(waived.state.path.indexOf('mac-smoke')).toBeGreaterThanOrEqual(0);
    expect(waived.state.path.indexOf('mac-smoke')).toBeLessThan(waived.state.path.indexOf('tui'));
    const resumed = await resumeReleaseRun({ runId: first.runId, from: 'mac-smoke' }, deps);
    expect(resumed.state.status).toBe('done');
    expect(tuiVisits).toBe(2);
    expect(seen.filter((ctx) => ctx.nodeId === 'known-issues').at(-1)?.input.acceptedRegressions).toEqual([
      { id: 'R2', note: 'Settings do not persist' },
    ]);
    expect((resumed.state.input as { acceptedRegressions: unknown[] }).acceptedRegressions).toEqual([{ id: 'R2', note: 'Settings do not persist' }]);
    expect(resumed.state.nodes.find((node) => node.nodeId === 'tui')?.waiver).toBeUndefined();
    const saved = JSON.parse(readFileSync(join(root, 'graph-runs/release-loop', `${first.runId}.json`), 'utf8')) as GraphRunState;
    expect(saved.input).toEqual(resumed.state.input);
    expect(readFileSync(notes, 'utf8')).not.toContain('Help does not close when requested');
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    expect((await invoke('--accepted-regressions', '[]')).error).toContain('release run has no input');
    expect((await invoke()).error).toContain('run identity mismatch');
  } finally {
    process.stdout.write = write;
    process.exitCode = previousExit ?? 0;
    resetElanousConfigDir();
    rmSync(root, { recursive: true, force: true });
  }
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
  expect(() => releaseResumeWaiver(state, { from: 'gate', waive: 'gate', reason: 'issue' })).toThrow('cannot waive a safety');
  state.path[1] = 'tui'; state.nodes[1]!.nodeId = 'tui';
  state.nodes[1]!.executed = false;
  expect(() => releaseResumeWaiver(state, { from: 'tui', waive: 'tui', reason: 'issue' })).toThrow('requires the failed executable node');
});
