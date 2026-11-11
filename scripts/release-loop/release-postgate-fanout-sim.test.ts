import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runGraph, type GraphRunOptions } from '../../src/graph-runner/runner.js';
import { resumeReleaseRun } from './resume-release.js';

// Source: this acceptance simulation runs three real graph executions plus resume on the remote test host.
const GRAPH_SIM_TIMEOUT_MS = 20_000;

test('RELEASE-GRAPH-POSTGATE-FANOUT sim: all three checks run after the gate; export failure blocks prepare', async () => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const root = mkdtempSync(join(tmpdir(), 'release-gate-independent-export-'));
    const started: string[] = [];
    const commit = 'a'.repeat(40);
    let exportFailures = 1;
    const concurrentBranchWitnesses = ['export-check', 'pwa', 'mac-smoke'];
    const simulatedOpAlerts: string[] = [];
    const activePostGateBranches = new Set<string>();
    let observedConcurrentPostGateBranches = false;
    let releaseBranchBarrier!: () => void;
    const postGateBranchBarrier = new Promise<void>((resolve) => { releaseBranchBarrier = resolve; });
  try {
    const fixtureGraphPath = join(root, 'graphs/release/release-loop.yaml');
    const fixtureGraph = parseYaml(readFileSync(graphPath, 'utf8')) as {
      nodes: Array<Record<string, unknown> & { node_id: string }>;
      edges: Array<Record<string, unknown> & { from: string; map?: Record<string, string> }>;
    };
    expect(fixtureGraph.edges.find(({ from }) => from === 'traffic-gate-passed')).toMatchObject({
      branches: { ok: ['export-check', 'pwa', 'mac-smoke'] },
      join: 'pre-prepare-join',
      warning_branches: ['mac-smoke'],
    });
    const edges = fixtureGraph.edges;
    const parentEdge = edges.find(({ from }) => from === 'pre-gate-join');
    if (!parentEdge?.map) throw new Error('release graph fixture is missing the pre-gate-join edge');
    parentEdge.map.ok = 'gate';
    // This simulator isolates post-gate fan-out; the independent pod-reuse subgraph has its own contract test.
    const cloudJoinEdge = edges.find(({ from }) => from === 'cloud-join');
    if (!cloudJoinEdge?.map) throw new Error('release graph fixture is missing the cloud-join edge');
    cloudJoinEdge.map.ok = 'gate';
    fixtureGraph.nodes = fixtureGraph.nodes.filter(({ node_id }) => node_id !== 'pod-reuse-prep');
    fixtureGraph.edges = edges.filter(({ from }) => from !== 'pod-reuse-prep');
    mkdirSync(dirname(fixtureGraphPath), { recursive: true });
    writeFileSync(fixtureGraphPath, stringifyYaml(fixtureGraph));
    writeFileSync(join(dirname(fixtureGraphPath), 'recipes.yaml'), readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8'));

    const state = await runGraph(fixtureGraphPath, {
      input: { version: '9.9.9', previousVersion: '0.2.3', branchCut: true },
      deps: {
        root,
        postOpAlert: (body: string) => { simulatedOpAlerts.push(body); },
        runBash: async (_body, options) => {
          const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
          if (!contextPath) throw new Error('missing graph context');
          const nodeId = JSON.parse(readFileSync(contextPath, 'utf8')).nodeId as string;
          started.push(nodeId);
          if (['export-check', 'pwa', 'mac-smoke'].includes(nodeId)) {
            activePostGateBranches.add(nodeId);
            if (activePostGateBranches.size >= concurrentBranchWitnesses.length) {
              observedConcurrentPostGateBranches = true;
              releaseBranchBarrier();
            }
            await postGateBranchBarrier;
            activePostGateBranches.delete(nodeId);
          }
          const failed = nodeId === 'export-check' && exportFailures > 0;
          if (failed) exportFailures -= 1;
          const output = nodeId === 'version-release'
            ? { outcome: 'ok', version: '9.9.9', commit, branch: 'release/9.9.9' }
            : nodeId === 'gate-cutover-switch'
              ? { outcome: 'legacy', verdict: 'pass', summary: 'fixture' }
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
    expect(started).toEqual(expect.arrayContaining(['export-check', 'pwa', 'mac-smoke']));
    for (const branch of ['export-check', 'pwa', 'mac-smoke']) {
      expect(started.indexOf('gate')).toBeLessThan(started.indexOf(branch));
    }
    expect(observedConcurrentPostGateBranches).toBe(true);
    expect(state.path).toContain('gate');
    expect(state.path).toContain('pre-prepare-join');
    expect(state.path).not.toContain('prepare');
    expect(state.path).not.toContain('publish');
    expect(state.status).toBe('failed');
    expect(simulatedOpAlerts).toEqual([]);
    expect(Object.keys(state.fanOuts ?? {})).toEqual(expect.arrayContaining(['cutoff:ok', 'traffic-gate-passed:ok']));

    symlinkSync(join(import.meta.dir, '../..', 'node_modules'), join(root, 'node_modules'), 'dir');
    mkdirSync(join(root, 'apps/pwa'), { recursive: true });
    symlinkSync(join(import.meta.dir, '../..', 'apps/pwa/node_modules'), join(root, 'apps/pwa/node_modules'), 'dir');
    const trafficFile = join(root, 'traffic.json');
    writeFileSync(trafficFile, '{}\n');
    const git = (args: string[]) => args[0] === 'ls-remote'
      ? `${commit}\trefs/heads/release/9.9.9`
      : args[0] === 'rev-parse' ? commit : '';
    const resumedAt: string[] = [];
    const resumeRunBash: NonNullable<GraphRunOptions['deps']>['runBash'] = async (_body, options) => {
      const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextPath) throw new Error('missing resumed graph context');
      const nodeId = JSON.parse(readFileSync(contextPath, 'utf8')).nodeId as string;
      resumedAt.push(nodeId);
      const output = nodeId === 'version-release'
        ? { outcome: 'ok', version: '9.9.9', commit, branch: 'release/9.9.9' }
        : nodeId === 'gate-cutover-switch' ? { outcome: 'legacy' }
          : { outcome: 'ok', verdict: 'pass', summary: 'fixture' };
      return { exitCode: 0, stdout: JSON.stringify(output) + '\n', stderr: '' };
    };
    const resumeDeps = { root, ledgerRoot: root, repo: root, trafficFile, git, commandRootGit: git,
      registerLogSink: async () => true, macrophageInventory: () => [], runBash: resumeRunBash };
    await expect(resumeReleaseRun({ runId: state.runId, from: 'checklist-gate', commandRoot: root }, resumeDeps))
      .rejects.toThrow('--from checklist-gate is not a node on the saved path');
    expect(resumedAt).toEqual([]);
    const resumed = await resumeReleaseRun({ runId: state.runId, from: 'export-check', commandRoot: root }, resumeDeps);
    expect(resumedAt).toContain('export-check');
    expect(resumedAt).not.toContain('gate');
    expect(resumed.state.status).toBe('done');

    const warningRoot = mkdtempSync(join(tmpdir(), 'release-postgate-mac-warning-'));
    try {
      const warningGraphPath = join(warningRoot, 'graphs/release/release-loop.yaml');
      const warningGraph = parseYaml(readFileSync(graphPath, 'utf8')) as {
        nodes: Array<Record<string, unknown> & { node_id: string }>;
        edges: Array<Record<string, unknown> & { from: string; map?: Record<string, string> }>;
      };
      warningGraph.nodes = warningGraph.nodes.filter(({ node_id }) => node_id !== 'pod-reuse-prep');
      warningGraph.edges = warningGraph.edges.filter(({ from }) => from !== 'pod-reuse-prep');
      const warningParent = warningGraph.edges.find(({ from }) => from === 'pre-gate-join');
      if (!warningParent?.map) throw new Error('release graph fixture is missing the pre-gate-join edge');
      warningParent.map.ok = 'gate';
      const warningCloudJoin = warningGraph.edges.find(({ from }) => from === 'cloud-join');
      if (!warningCloudJoin?.map) throw new Error('release graph fixture is missing the cloud-join edge');
      warningCloudJoin.map.ok = 'gate';
      mkdirSync(dirname(warningGraphPath), { recursive: true });
      writeFileSync(warningGraphPath, stringifyYaml(warningGraph));
      writeFileSync(join(dirname(warningGraphPath), 'recipes.yaml'), readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8'));
      const warningStarted: string[] = [];
      const warningState = await runGraph(warningGraphPath, {
        input: { version: '9.9.9', previousVersion: '0.2.3', branchCut: true },
        deps: { root: warningRoot, runBash: async (_body, options) => {
          const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
          if (!contextPath) throw new Error('missing graph context');
          const nodeId = JSON.parse(readFileSync(contextPath, 'utf8')).nodeId as string;
          warningStarted.push(nodeId);
          const failed = nodeId === 'mac-smoke';
          const output = nodeId === 'version-release'
            ? { outcome: 'ok', version: '9.9.9', commit, branch: 'release/9.9.9' }
            : nodeId === 'gate-cutover-switch' ? { outcome: 'legacy' }
              : { outcome: failed ? 'fail' : 'ok', verdict: failed ? 'fail' : 'pass', summary: 'fixture' };
          return { exitCode: failed ? 1 : 0, stdout: JSON.stringify(output) + '\n', stderr: '' };
        } },
      });
      expect(warningStarted).toContain('mac-smoke');
      expect(warningState.path).toContain('pre-prepare-join');
      expect(warningStarted).toContain('prepare');
      expect(warningStarted).toContain('publish');
      expect(warningState.path).not.toContain('traffic-failed-restore');
      expect(warningState.status).toBe('done');
    } finally {
      rmSync(warningRoot, { recursive: true, force: true });
    }

    const pwaRoot = mkdtempSync(join(tmpdir(), 'release-postgate-pwa-failure-'));
    try {
      const pwaGraphPath = join(pwaRoot, 'graphs/release/release-loop.yaml');
      const pwaGraph = parseYaml(readFileSync(graphPath, 'utf8')) as {
        nodes: Array<Record<string, unknown> & { node_id: string }>;
        edges: Array<Record<string, unknown> & { from: string; map?: Record<string, string> }>;
      };
      pwaGraph.nodes = pwaGraph.nodes.filter(({ node_id }) => node_id !== 'pod-reuse-prep');
      pwaGraph.edges = pwaGraph.edges.filter(({ from }) => from !== 'pod-reuse-prep');
      const pwaParent = pwaGraph.edges.find(({ from }) => from === 'pre-gate-join');
      if (!pwaParent?.map) throw new Error('release graph fixture is missing the pre-gate-join edge');
      pwaParent.map.ok = 'gate';
      const pwaCloudJoin = pwaGraph.edges.find(({ from }) => from === 'cloud-join');
      if (!pwaCloudJoin?.map) throw new Error('release graph fixture is missing the cloud-join edge');
      pwaCloudJoin.map.ok = 'gate';
      mkdirSync(dirname(pwaGraphPath), { recursive: true });
      writeFileSync(pwaGraphPath, stringifyYaml(pwaGraph));
      writeFileSync(join(dirname(pwaGraphPath), 'recipes.yaml'), readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8'));
      const pwaStarted: string[] = [];
      const pwaState = await runGraph(pwaGraphPath, {
        input: { version: '9.9.9', previousVersion: '0.2.3', branchCut: true },
        deps: { root: pwaRoot, postOpAlert: () => {}, runBash: async (_body, options) => {
          const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
          if (!contextPath) throw new Error('missing graph context');
          const nodeId = JSON.parse(readFileSync(contextPath, 'utf8')).nodeId as string;
          pwaStarted.push(nodeId);
          const failed = nodeId === 'pwa';
          const output = nodeId === 'version-release'
            ? { outcome: 'ok', version: '9.9.9', commit, branch: 'release/9.9.9' }
            : nodeId === 'gate-cutover-switch' ? { outcome: 'legacy' }
              : { outcome: failed ? 'fail' : 'ok', verdict: failed ? 'fail' : 'pass', summary: 'fixture' };
          return { exitCode: failed ? 1 : 0, stdout: JSON.stringify(output) + '\n', stderr: '' };
        } },
      });
      expect(pwaStarted).toContain('pwa');
      expect(pwaStarted).not.toContain('prepare');
      expect(pwaState.path).toContain('pre-prepare-join');
      expect(pwaState.path).toContain('traffic-failed-restore');
      expect(pwaState.status).toBe('failed');
    } finally {
      rmSync(pwaRoot, { recursive: true, force: true });
    }

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, GRAPH_SIM_TIMEOUT_MS);
