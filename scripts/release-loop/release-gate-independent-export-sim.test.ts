import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph, type GraphRunOptions } from '../../src/graph-runner/runner.js';
import { resumeReleaseRun } from './resume-release.js';

test('RELEASE-GATE-INDEPENDENT-OF-EXPORT sim: export failure runs the gate, then blocks prepare and publish at the join', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const root = mkdtempSync(join(tmpdir(), 'release-gate-independent-export-'));
    const started: string[] = [];
    const commit = 'a'.repeat(40);
    let exportFailures = 1;
  try {
    const state = await runGraph(graphPath, {
      input: { version: '9.9.9', previousVersion: '0.2.3', branchCut: true },
      deps: {
        root,
        runBash: async (_body, options) => {
          const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
          if (!contextPath) throw new Error('missing graph context');
          const nodeId = JSON.parse(readFileSync(contextPath, 'utf8')).nodeId as string;
          started.push(nodeId);
          const failed = nodeId === 'export-check' && exportFailures > 0;
          if (failed) exportFailures -= 1;
          const output = nodeId === 'version-release'
            ? { outcome: 'ok', version: '9.9.9', commit, branch: 'release/9.9.9' }
            : { outcome: failed ? 'fail' : 'ok', verdict: failed ? 'fail' : 'pass', summary: 'fixture' };
          return {
            exitCode: failed ? 1 : 0,
            stdout: JSON.stringify(output) + '\n',
            stderr: '',
          };
        },
      },
    });
    expect(started).toContain('checklist-gate');
    expect(started).toContain('prefetch');
    expect(started).toContain('gate');
    expect(started.indexOf('gate')).toBeLessThan(started.indexOf('export-check'));
    expect(state.path).toContain('gate');
    expect(state.path).toContain('pre-prepare-join');
    expect(state.path).not.toContain('prepare');
    expect(state.path).not.toContain('publish');
    expect(state.status).toBe('failed');
    expect(Object.keys(state.fanOuts ?? {})).toEqual(expect.arrayContaining(['cutoff:ok', 'traffic-gate-passed:ok']));

    const resumedAt: string[] = [];
    const trafficFile = join(root, 'traffic.json');
    await Bun.write(trafficFile, '{}\n');
    const git = (args: string[]) => args[0] === 'ls-remote'
      ? `${commit}\trefs/heads/release/9.9.9`
      : args[0] === 'rev-parse' ? commit : '';
    const runBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (_body, options) => {
      const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextPath) throw new Error('missing resumed graph context');
      const nodeId = JSON.parse(readFileSync(contextPath, 'utf8')).nodeId as string;
      resumedAt.push(nodeId);
      return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', summary: 'fixture' }) + '\n', stderr: '' };
    };
    const resumeDeps = {
      root, ledgerRoot: root, repo: process.cwd(), trafficFile, git, commandRootGit: git,
      registerLogSink: async () => true, macrophageInventory: () => [],
      runBash,
    };
    // Non-failed sibling branches stay invalid resume targets; the command checkout is only read during preflight.
    await expect(resumeReleaseRun({ runId: state.runId, from: 'checklist-gate', commandRoot: process.cwd() }, resumeDeps))
      .rejects.toThrow('--from checklist-gate is not a node on the saved path');
    const resumed = await resumeReleaseRun({ runId: state.runId, from: 'export-check', commandRoot: process.cwd() }, resumeDeps);
    expect(resumedAt).toContain('export-check');
    expect(resumedAt).not.toContain('gate');
    expect(resumed.state.resume?.from).toBe('traffic-gate-passed');
    expect(resumed.state.status).toBe('done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
