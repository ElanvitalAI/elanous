import { expect, test } from 'bun:test';
import { growthDecision, proposeGrowth } from './graph-grow.js';
import type { DecisionEntry } from '../decisions/decision-ledger.js';
import type { GraphTemplateSpec } from '../self-implement/graph-yaml.js';

const graph: GraphTemplateSpec = {
  graphId: 'grow-test', version: 1, entryNode: 'judge', terminalNodes: ['done'],
  nodes: [
    { nodeId: 'judge', kind: 'judge', recipe: 'cmd:judge', maxVisits: 2 },
    { nodeId: 'done', kind: 'gate', recipe: 'none', maxVisits: 1 },
  ],
  edges: [{ from: 'judge', on: 'outcome', map: { ok: 'done' } }],
};
const node = { nodeId: 'research', kind: 'agent', recipe: 'none', maxVisits: 1, contract: { inputs: [], tools: 'read-only', outputs: [] } };
const input = { graph, nodeId: 'judge', outcome: 'needs-research', runId: 'run-1' };

test('a side-effect proposal raises one decision card with an eight-hour deadline and reuses it', async () => {
  const entries: DecisionEntry[] = [];
  const ledger = {
    raiseOnce: (value: Record<string, unknown>, ref: string) => {
      const existing = entries.find(entry => entry.refs?.includes(ref));
      if (existing) return existing;
      const entry = { ...value, id: 'D-test', status: 'open' } as DecisionEntry;
      entries.push(entry);
      return entry;
    },
  };
  const proposal = { node: { ...node, recipe: 'cmd:publish' }, returnTo: 'judge', reason: 'publish result' };
  const deps = { ledger, now: () => new Date('2026-10-01T00:00:00.000Z') };
  const first = await proposeGrowth(input, () => proposal, () => 'external-effect', deps);
  const second = await proposeGrowth(input, () => proposal, () => 'external-effect', deps);
  expect(first).toMatchObject({ ok: false, park: true, decisionId: 'D-test' });
  expect(second).toMatchObject({ ok: false, park: true, decisionId: 'D-test' });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ dueAt: '2026-10-01T08:00:00.000Z',
    scqa: { s: expect.stringContaining('grow-test'), c: expect.stringContaining('cmd:publish') },
    refs: [expect.stringContaining('graph-growth:')] });
  expect(growthDecision(input, proposal, deps).id).toBe('D-test');
});

test('a different resolved command for the same recipe raises a separate card', async () => {
  const entries: DecisionEntry[] = [];
  const ledger = { raiseOnce: (value: Record<string, unknown>, ref: string) => {
    const existing = entries.find(entry => entry.refs?.includes(ref));
    if (existing) return existing;
    const entry = { ...value, id: `D-${entries.length + 1}`, status: 'open' } as DecisionEntry;
    entries.push(entry);
    return entry;
  } };
  const proposal = { node: { ...node, recipe: 'cmd:publish' }, returnTo: 'judge', reason: 'publish result' };
  const deps = { ledger };
  const first = await proposeGrowth(input, () => proposal, () => ({ effect: 'external-effect', command: { command: 'printf original' } }), deps);
  const repeated = await proposeGrowth(input, () => proposal, () => ({ effect: 'external-effect', command: { command: 'printf original' } }), deps);
  const changed = await proposeGrowth(input, () => proposal, () => ({ effect: 'external-effect', command: { command: 'printf changed' } }), deps);
  expect(first).toMatchObject({ ok: false, decisionId: 'D-1', command: { command: 'printf original' } });
  expect(repeated).toMatchObject({ ok: false, decisionId: 'D-1' });
  expect(changed).toMatchObject({ ok: false, decisionId: 'D-2', command: { command: 'printf changed' } });
  expect(entries).toHaveLength(2);
  expect(entries[0]?.refs).not.toEqual(entries[1]?.refs);
  expect(entries[0]?.pendingQuestion).toContain('printf original');
  expect(entries[1]?.pendingQuestion).toContain('printf changed');
});

test('growth validates an invented outcome, new node and return edge without mutating the source', async () => {
  const result = await proposeGrowth(input, () => ({ node, returnTo: 'judge', reason: 'review requested research' }));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.graph.nodes.at(-1)).toEqual(node);
  expect(result.graph.edges[0]?.map?.['needs-research']).toBe('research');
  expect(result.graph.edges.at(-1)).toEqual({ from: 'research', to: 'judge' });
  expect(result.growth.reason).toBe('review requested research');
  expect(result.growth.undo).toEqual({ removeNode: 'research', removeOutcome: { from: 'judge', outcome: 'needs-research' }, removeEdge: { from: 'research', to: 'judge' } });
  expect(graph.edges[0]?.map?.['needs-research']).toBeUndefined();
});

test('invalid proposals fall back with a reason, while external effects require a human', async () => {
  const duplicate = await proposeGrowth(input, () => ({ node: { ...node, nodeId: 'done' }, returnTo: 'judge', reason: 'duplicate' }));
  expect(duplicate.ok).toBe(false);
  if (!duplicate.ok) expect(duplicate.reason).toContain('invalid-growth');
  const unknownReturn = await proposeGrowth(input, () => ({ node, returnTo: 'missing', reason: 'unknown' }));
  expect(unknownReturn.ok).toBe(false);
  const missingReturn = await proposeGrowth(input, () => ({ node, reason: 'no onward route' }));
  expect(missingReturn).toMatchObject({ ok: false, reason: expect.stringContaining('invalid-growth') });
  const fakeLedger = { raiseOnce: (value: Record<string, unknown>) => ({ ...value, id: 'D-effect' }) as DecisionEntry };
  const effect = await proposeGrowth(input, () => ({ node: { ...node, recipe: 'cmd:git push' }, returnTo: 'done', reason: 'publish' }), undefined, { ledger: fakeLedger });
  expect(effect).toMatchObject({ ok: false, park: true, reason: expect.stringContaining('사람 확인 필요') });
  const upload = await proposeGrowth(input, () => ({ node: { ...node, recipe: 'cmd:upload', contract: { ...node.contract, tools: 'read-only' } }, returnTo: 'done', reason: 'upload' }), undefined, { ledger: fakeLedger });
  expect(upload).toMatchObject({ ok: false, park: true, reason: expect.stringContaining('사람 확인 필요') });
});
