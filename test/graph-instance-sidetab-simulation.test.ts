import { expect, test } from 'bun:test';
import type { GraphRunState } from '../src/graph-runner/runner.js';
import { graphInstanceViewIssues } from '../scripts/validate-graph-instance-view.js';
import { readLiveGraphInstance, type ViewLedgers } from '../plugins/graph-instance-view/handlers/project-ledgers.js';
import { renderGraphInstanceTerminal } from '../plugins/graph-instance-view/handlers/render-terminal.js';

const at = '2026-11-12T03:00:00.000Z';
function world() {
  const run: GraphRunState = {
    graphId: 'sidetab-sim', runId: 'sidetab-sim-1', startedAt: at,
    status: 'running', path: ['plan', 'build'],
    nodes: [{ nodeId: 'plan', ok: true, exit: 0, executed: true }],
    currentNode: { nodeId: 'build', startedAt: at },
    executed: 1, dryRun: false, statePath: '/fake/sidetab-sim-1.json',
  };
  const unexpected = (): never => { throw new Error('Unrelated ledger read'); };
  const ledgers: ViewLedgers = {
    graphRuns: () => [run], harness: () => null, now: () => at,
    resources: unexpected, hosts: unexpected, cloudStates: unexpected,
  };
  return { run, ledgers };
}

test('side-tab reader projects a fake graph ledger through JSON into a bounded terminal panel', () => {
  const { ledgers } = world();
  const view = readLiveGraphInstance('sidetab-sim-1', ledgers)!;
  expect(graphInstanceViewIssues(view)).toEqual([]);
  expect(view.instance).toMatchObject({ source: 'graph', runId: 'sidetab-sim-1', state: 'running', observedAt: at });
  expect(view.progress).toEqual({ completed: 1, total: 2, activeNodeIds: ['build'] });
  expect(view.edges).toEqual([{ id: 'path-0', from: 'plan', to: 'build', kind: 'flow', state: 'taken' }]);
  const wire = JSON.parse(JSON.stringify(view));
  const panel = { width: 40, height: 20 };
  const lines = renderGraphInstanceTerminal(wire, panel.width, panel.height);
  const screen = lines.join('\n');
  for (const text of ['┌', '✓ plan', '● build', '┄┄> build', '로그 │ plan 완료', '1/2', '상태 │', 'running']) {
    expect(screen).toContain(text);
  }
  expect(lines.length).toBeLessThanOrEqual(panel.height);
  expect(lines.every(line => Bun.stringWidth(line) === panel.width)).toBe(true);
});

test('side-tab polling observes completion without mutating the supplied ledger', () => {
  const { run, ledgers } = world();
  expect(readLiveGraphInstance(run.runId, ledgers)!.instance.state).toBe('running');
  run.status = 'done';
  run.currentNode = undefined;
  run.nodes.push({ nodeId: 'build', ok: true, exit: 0, executed: true });
  const before = JSON.stringify(run);
  const view = readLiveGraphInstance(run.runId, ledgers)!;
  expect(view.instance.state).toBe('done');
  expect(view.progress).toEqual({ completed: 2, total: 2, activeNodeIds: [] });
  expect(renderGraphInstanceTerminal(view, 28, 5).at(-1)).toContain('done');
  expect(JSON.stringify(run)).toBe(before);
});

test('release and harness side tabs use the same injected read-only boundary', () => {
  const { run, ledgers } = world();
  run.graphId = 'release-loop';
  run.status = 'failed';
  run.currentNode = undefined;
  run.nodes.push({ nodeId: 'build', ok: false, exit: 1, executed: true });
  const release = readLiveGraphInstance(run.runId, ledgers)!;
  expect(release.instance).toMatchObject({ source: 'release', state: 'failed' });
  expect(release.nodes.find(node => node.id === 'build')!.state).toBe('failed');
  const harness = readLiveGraphInstance('harness-sim', {
    ...ledgers,
    harness: id => id === 'harness-sim' ? [
      { runId: id, timestamp: at, event: 'node-enter', data: { nodeId: 'review' } },
    ] : null,
  })!;
  expect(harness.instance).toMatchObject({ source: 'harness', runId: 'harness-sim' });
  expect(harness.nodes).toEqual([{ id: 'review', label: 'review', state: 'running' }]);
  expect(readLiveGraphInstance('missing', ledgers)).toBeNull();
});
