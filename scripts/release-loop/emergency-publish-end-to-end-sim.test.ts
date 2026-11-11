import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph, type GraphRunOptions } from '../../src/graph-runner/runner.js';
import { resetEffectiveInstanceRoot } from '../../src/instance/resolve.js';
import { parseAlwaysIncludeList, LIGHT_RC_ALWAYS_FILE, runLightRc } from '../../src/release-loop/light-rc.js';
import { runAutoApprove } from './auto-approve-node.js';
import { runEmergencyPublishGateNode } from './emergency-publish-gate-node.js';
import { runEmergencyPublishSwitchSimulation } from './emergency-publish-switch-sim.js';
import { runPublish } from './publish-node.js';
import type { GraphContext } from './node-verdict.js';

const GRAPH = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
const REPO = join(import.meta.dir, '../..');
const hotfixCommit = 'b'.repeat(40);
const releaseCommit = 'c'.repeat(40);
const previousTagCommit = 'a'.repeat(40);

test('release graph uses the same-run emergency gate to publish after normal gate regression', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-emergency-e2e-sim-'));
  const out = join(root, 'release', '0.3.8', 'prepared');
  mkdirSync(join(out, 'dist'), { recursive: true });
  for (let i = 0; i < 5; i++) writeFileSync(join(out, 'dist', `artifact-${i}`), 'simulated artifact');
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  const previousGraphContext = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_STATE_DIR = root;
  resetEffectiveInstanceRoot();
  let normalGateRuns = 0;
  let emergencyGateRuns = 0;
  let fullReceiptAudits = 0;
  let publishRuns = 0;

  const runBash: NonNullable<NonNullable<GraphRunOptions['deps']>['runBash']> = async (_command, options) => {
    const env = options.env ?? {};
    const location = env.ELANOUS_GRAPH_CONTEXT!;
    const text = location.trimStart().startsWith('{') ? location : readFileSync(location, 'utf8');
    const context = JSON.parse(text) as GraphContext;
    const result = (value: Record<string, unknown>, exitCode = 0) => ({ exitCode, stdout: `${JSON.stringify(value)}\n`, stderr: '' });

    if (context.nodeId === 'version-release') return result({ outcome: 'ok', commit: releaseCommit });
    if (context.nodeId === 'gate') {
      normalGateRuns++;
      return result({ outcome: 'regression', verdict: 'fail', commit: releaseCommit,
        introduced: ['src/security/hotfix.test.ts > simulated injected failure'], preexisting: 0, unclassified: 0 }, 1);
    }
    if (context.nodeId === 'receipt-audit') fullReceiptAudits++;
    if (context.nodeId === 'emergency-switch') {
      // The world's fake clock advances the recorded gate start; caller-supplied blockedSince is intentionally ignored.
      const latest = [...(context.nodeHistory ?? [])].reverse().find((row) => row.nodeId === 'gate' || row.nodeId === 'residual-run');
      expect(latest).toBeDefined();
      latest!.endedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      const lines: string[] = [];
      const oldLog = console.log;
      console.log = (line?: unknown) => lines.push(String(line ?? ''));
      try {
        const exitCode = runEmergencyPublishSwitchSimulation({ ...env, ELANOUS_GRAPH_CONTEXT: JSON.stringify(context) });
        return { exitCode, stdout: `${lines.at(-1)}\n`, stderr: '' };
      } finally { console.log = oldLog; }
    }
    if (context.nodeId === 'emergency-gate') {
      emergencyGateRuns++;
      const mandatoryTests = parseAlwaysIncludeList(readFileSync(join(process.cwd(), LIGHT_RC_ALWAYS_FILE), 'utf8'));
      const measuredFiles = ['src/security/hotfix.ts', 'src/security/hotfix.test.ts'];
      const gateResult = { version: '0.3.8', base: previousTagCommit, measuredCommit: releaseCommit,
        worktreeHead: releaseCommit, changedFiles: measuredFiles, testFiles: [...mandatoryTests, 'src/security/hotfix.test.ts'],
        importerTests: 1, introduced: 0, preexisting: 0, unclassified: 0, alwaysInclude: mandatoryTests.length,
        alwaysIncludeMissing: [], shards: 4, remote: 'aws2', host: 'aws2', gateExitCode: 0, ok: true, unmeasured: null };
      const lines: string[] = [];
      const oldLog = console.log;
      console.log = (line?: unknown) => lines.push(String(line ?? ''));
      try {
        const exitCode = await runEmergencyPublishGateNode({ ...env, ELANOUS_GRAPH_CONTEXT: JSON.stringify(context) },
          (version, options) => runLightRc(version, { ...options, legacySelfGate: true, log: () => {} }, {
            cwd: REPO,
            git: (args) => {
              const ref = args.at(-1) ?? '';
              if (ref === `${releaseCommit}^{commit}` || ref === 'HEAD') return { rc: 0, stdout: `${releaseCommit}\n` };
              if (ref === `${previousTagCommit}^{commit}`) return { rc: 0, stdout: `${previousTagCommit}\n` };
              return { rc: 1, stdout: '' };
            },
            dispatch: async (_dispatchOptions, dispatchDeps) => {
              dispatchDeps?.write.out(Buffer.from(`${JSON.stringify(gateResult)}\n`));
              return 0;
            },
          }),
          { resolveCommit: () => previousTagCommit, isAncestor: () => true,
            pathsChangedByCommit: (commit) => {
              if (commit !== hotfixCommit) throw new Error('hotfix path evidence must inspect the hotfix commit itself');
              return ['src/security/hotfix.ts'];
            },
            treeEntryAt: () => ({ mode: '100644', type: 'blob', object: 'blob-hotfix' }) });
        return { exitCode, stdout: `${lines.at(-1)}\n`, stderr: '' };
      } finally { console.log = oldLog; }
    }
    if (context.nodeId === 'auto-approve') {
      const approval = runAutoApprove(context, { instanceRoot: root, repo: REPO, checklistRoot: root });
      return result(approval, approval.outcome === 'ok' ? 0 : 1);
    }
    if (context.nodeId === 'prepare') return result({ outcome: 'ok', out, commit: releaseCommit });
    if (context.nodeId === 'docs') return result({ outcome: 'ok', branch: 'release-docs/0.3.8', notes: 'simulated notes' });
    if (context.nodeId === 'tui') return result({ outcome: 'ok', regress: { pass: 7, fail: 0,
      results: Array.from({ length: 7 }, (_, i) => ({ id: `R${i + 1}`, title: `check ${i + 1}`, ok: true, reason: 'pass' })) } });
    if (context.nodeId === 'publish') {
      publishRuns++;
      const oldContext = process.env.ELANOUS_GRAPH_CONTEXT;
      process.env.ELANOUS_GRAPH_CONTEXT = location;
      try {
        const published = runPublish((command, args) => {
          if (command === 'git' && args[0] === 'show') return { status: 0,
            stdout: args[1]?.endsWith('website/pages.json') ? JSON.stringify({ pages: [] }) : '# 0.3.8\n\nSimulated emergency release.\n', stderr: '' };
          if (command === 'bun' && args[0] === 'bin/elanous.mjs' && args[1] === 'release' && args[2] === 'publish')
            return { status: 0, stdout: JSON.stringify({ ok: true, published: true, tag: 'v0.3.8', publicRepo: 'elanous/elanous', assets: [] }), stderr: '' };
          throw new Error(`unexpected simulated publish boundary: ${command} ${args.join(' ')}`);
        }, root, undefined, root);
        return result(published, published.outcome === 'ok' ? 0 : 1);
      } finally { if (oldContext === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = oldContext; }
    }
    return result({ outcome: 'ok', verdict: 'pass' });
  };

  try {
    const run = await runGraph(GRAPH, { runId: 'emergency-publish-e2e-sim', input: {
      version: '0.3.8', previousVersion: '0.3.7', emergencyPublish: { securityFix: true,
        hotfixCommits: [hotfixCommit], blockedSince: '1900-01-01T00:00:00.000Z', remote: 'aws2' },
    }, deps: { root, runBash } });
    expect(run.path).toContain('emergency-switch');
    expect(run.path).toContain('emergency-gate');
    expect(run.path).toContain('traffic-gate-passed');
    expect(run.path).toContain('auto-approve');
    expect(run.path).toContain('publish');
    expect(run.path).not.toContain('approve-publish');
    expect(normalGateRuns).toBe(1);
    expect(emergencyGateRuns).toBe(1);
    expect(fullReceiptAudits).toBe(0);
    expect(publishRuns).toBe(1);
    expect(run.status).toBe('done');
  } finally {
    resetEffectiveInstanceRoot();
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previousStateDir;
    if (previousGraphContext === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT; else process.env.ELANOUS_GRAPH_CONTEXT = previousGraphContext;
    rmSync(root, { recursive: true, force: true });
  }
});
