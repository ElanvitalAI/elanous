import { describe, expect, test } from 'bun:test';
import { graphFromSteps, liveRunPicks, mergeWalked, runStatusLabel } from './live-run-view';

describe('live-run view helpers', () => {
  test('graphFromSteps draws only the walked path, keeping back edges', () => {
    const graph = graphFromSteps('g', [
      { node: 'implement', outcome: 'pass' }, { node: 'gate', outcome: 'fail' },
      { node: 'implement', outcome: 'pass' }, { node: 'gate', outcome: null },
    ]);
    expect(graph.nodes.map((node) => node.node_id)).toEqual(['implement', 'gate']);
    expect(graph.entry_node).toBe('implement');
    expect(graph.edges).toEqual([
      { from: 'implement', on: 'outcome', map: { pass: 'gate' } },
      { from: 'gate', on: 'outcome', map: { fail: 'implement' } },
    ]);
  });

  test('picker lists running runs first, then finished runs, first goal line only', () => {
    const picks = liveRunPicks(
      [{ runId: 'run-a', status: 'running', lastActivityTimestamp: '2026-10-08T00:00:00Z', objective: '대상 경로: src/x/a.ts · ~/.elanous/b.json\n본문은 숨긴다' }],
      [{ runId: 'run-b', status: 'completed', endedAt: '2026-10-07T23:00:00Z', objective: '골 B' }, { runId: 'run-a', status: 'completed', endedAt: 'x' }],
    );
    expect(picks).toEqual([
      { runId: 'run-a', label: '대상 경로: a.ts · b.json', live: true, at: '2026-10-08T00:00:00Z' },
      { runId: 'run-b', label: '골 B', live: false, at: '2026-10-07T23:00:00Z' },
    ]);
  });

  test('status labels are Korean', () => {
    expect(runStatusLabel('running')).toBe('● 도는 중');
    expect(runStatusLabel('completed')).toBe('완료');
    expect(runStatusLabel('weird')).toBe('weird');
  });

  test('mergeWalked keeps every declared node and adds what the run walked outside the declaration', () => {
    const declared = graphFromSteps('g', [{ node: 'a', outcome: 'pass' }, { node: 'b', outcome: null }]);
    const withUnvisited = { ...declared, nodes: [...declared.nodes, { node_id: 'never', kind: 'git', recipe: 'r', max_visits: 1 }] };
    const merged = mergeWalked(withUnvisited, [{ node: 'a', outcome: 'pass' }, { node: 'b', outcome: 'pass' }, { node: 'heal', outcome: null }]);
    expect(merged.nodes.map((node) => node.node_id)).toEqual(['a', 'b', 'never', 'heal']);
    expect(merged.edges.at(-1)).toEqual({ from: 'b', to: 'heal' });
    expect(mergeWalked(withUnvisited, [{ node: 'a', outcome: 'pass' }, { node: 'b', outcome: null }])).toBe(withUnvisited);
  });
});
