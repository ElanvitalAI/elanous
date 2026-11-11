import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph, type GraphRunOptions } from '../../src/graph-runner/runner.js';
import { debug } from '../../src/debug/log.js';
import { runEmergencyPublishSwitchSimulation } from './emergency-publish-switch-sim.js';
import { runTrafficNode } from './traffic-node.js';

const GRAPH = join(import.meta.dir, '../../graphs/release/release-loop.yaml');

test('release graph ignores caller timestamps and stays on the normal repair path before the same-run block matures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-emergency-disabled-sim-'));
  const trafficFile = join(root, 'traffic.json');
  const seats = Object.fromEntries(['OP', 'TC', 'MK', 'UX'].map((seat) => [seat, { perCycle: 6 }]));
  writeFileSync(trafficFile, JSON.stringify({ global: 'green', seats }));
  const events = spyOn(debug, 'log');
  const realLog = console.log;
  const output: string[] = [];
  let switchOutput = '';
  let gateRuns = 0;

  const runBash: NonNullable<NonNullable<GraphRunOptions['deps']>['runBash']> = async (_command, options) => {
    const env = options.env ?? {};
    const contextPath = env.ELANOUS_GRAPH_CONTEXT!;
    const contextText = contextPath.trimStart().startsWith('{') ? contextPath : readFileSync(contextPath, 'utf8');
    const context = JSON.parse(contextText) as { nodeId: string; runId: string; input: Record<string, unknown>;
      outputs: Record<string, Record<string, unknown>> };
    if (context.nodeId === 'emergency-switch') {
      output.length = 0;
      console.log = (line?: unknown) => output.push(String(line ?? ''));
      try {
        const exitCode = runEmergencyPublishSwitchSimulation(env);
        switchOutput = output.at(-1) ?? '';
        return { exitCode, stdout: `${output.at(-1)}\n`, stderr: '' };
      } finally { console.log = realLog; }
    }
    if (context.nodeId === 'gate') {
      gateRuns++;
      return { exitCode: 1, stdout: JSON.stringify({ outcome: 'regression', verdict: 'fail', commit: 'c'.repeat(40),
        introduced: ['src/security/hotfix.test.ts > injected release block'], preexisting: 0, unclassified: 0 }), stderr: '' };
    }
    if (context.nodeId.startsWith('traffic-')) {
      output.length = 0;
      console.log = (line?: unknown) => output.push(String(line ?? ''));
      try {
        const exitCode = await runTrafficNode(context.nodeId, { ...env, ELANOUS_GRAPH_CONTEXT: JSON.stringify(context) },
          { options: { trafficFile }, report: () => {} });
        return { exitCode, stdout: `${output.at(-1)}\n`, stderr: '' };
      } finally { console.log = realLog; }
    }
    return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass' }), stderr: '' };
  };

  try {
    const input = { version: '0.3.8', previousVersion: '0.3.7', emergencyPublish: {
      securityFix: true,
      hotfixCommits: ['b'.repeat(40)],
      blockedSince: '2026-11-08T01:00:00.000Z',
      nowMs: Date.parse('2026-11-08T04:00:00.000Z'),
      shadowSamples: Array.from({ length: 3 }, (_, index) => ({ eventType: 'normal-release-blocked', policyVersion: 1,
        runId: `caller-supplied-${index}`, observedAt: `2026-11-08T0${index}:00:00.000Z`, shadowEligible: true })),
      remote: 'aws1',
    } };
    const run = await runGraph(GRAPH, { runId: 'emergency-disabled-graph-sim', input, deps: { root, runBash } });

    expect(run.status).toBe('failed');
    expect(run.path).toContain('emergency-switch');
    expect(run.path).toContain('gate-triage');
    expect(run.path).toContain('traffic-failed-restore');
    expect(run.path).not.toContain('emergency-gate');
    expect(run.path).not.toContain('approve-publish');
    expect(run.path).not.toContain('publish');
    expect(gateRuns).toBe(1);
    expect(events.mock.calls.some(([category, event]) => category === 'release-loop.emergency-publish' && event === 'switch-declined')).toBe(true);
    expect(JSON.parse(switchOutput)).toMatchObject({ action: 'stay-normal', eligible: false, promoted: false,
      reasons: ['normal-release-blocked-too-short'] });
  } finally {
    events.mockRestore();
    console.log = realLog;
    rmSync(root, { recursive: true, force: true });
  }
});
