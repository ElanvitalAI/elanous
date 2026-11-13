import { expect, test } from 'bun:test';
import { nextScene6BoardReceipt } from './scene6-board-receipt.js';
import { buildReplTools } from './index.js';

test('Scene 6 receipt binds deployment and both attachments to the graph run', async () => {
  const sha256 = 'a'.repeat(64);
  const attachment = (kind: 'diagram' | 'pdf', run: string) => ({
    kind, title: `${run}-${kind}`, url: `https://example.test/${run}/${kind}`, sha256,
  });
  const old = { id: 'card-6', memberId: 'member-1', title: 'old', state: 'deployed',
    runId: 'run-old', updatedAt: '2026-11-12T01:00:00Z',
    attachments: [attachment('diagram', 'old'), attachment('pdf', 'old')] };
  const current = { id: 'card-6', memberId: 'member-1', title: 'current', state: 'testing',
    runId: 'run-current', updatedAt: '2026-11-12T02:00:00Z',
    attachments: [attachment('diagram', 'current')] };
  const cards = [old, current];
  const input = {
    graph: { graphId: 'scene-6', status: 'done', runId: 'run-current' },
    expectedGraphId: 'scene-6', cardId: 'card-6', memberId: 'member-1',
    nexusUrl: 'https://nexus.example.test', sessionToken: 'test-session',
    fetchImpl: async () => Response.json({ cards }),
  };
  expect(await nextScene6BoardReceipt(input)).toBeNull();
  current.state = 'deployed';
  expect(await nextScene6BoardReceipt(input)).toBeNull();
  cards.push({ ...current, state: 'deployed', updatedAt: '2026-11-12T03:00:00Z',
    attachments: [attachment('diagram', 'current'), attachment('pdf', 'current')] });
  const receipt = await nextScene6BoardReceipt(input);
  expect(receipt).toContain('current-diagram');
  expect(receipt).toContain('current-pdf');
  expect(receipt).not.toContain('old-diagram');
  expect(receipt).not.toContain('old-pdf');
});

test('Scene 6 receipt keeps run-x distinct from x and rejects superseded attachments', async () => {
  const attachment = (kind: 'diagram' | 'pdf') => ({
    kind, title: kind, url: `https://example.test/${kind}`, sha256: 'a'.repeat(64),
  });
  const cards: Record<string, unknown>[] = [{
    id: 'card-6', memberId: 'member-1', title: 'older', state: 'deployed', runId: 'run-x',
    updatedAt: '2026-11-12T01:00:00Z', attachments: [attachment('diagram'), attachment('pdf')],
  }];
  const input = {
    graph: { graphId: 'scene-6', status: 'done', runId: 'x' },
    expectedGraphId: 'scene-6', cardId: 'card-6', memberId: 'member-1',
    nexusUrl: 'https://nexus.example.test', sessionToken: 'test-session',
    fetchImpl: async () => Response.json({ cards }),
  };
  expect(await nextScene6BoardReceipt(input)).toBeNull();
  input.graph.runId = 'run-x';
  expect(await nextScene6BoardReceipt(input)).toContain('PDF pdf');
  cards.push({ ...cards[0], title: 'latest empty', updatedAt: '2026-11-12T02:00:00Z', attachments: [] });
  expect(await nextScene6BoardReceipt(input)).toBeNull();
  cards.push({ ...cards[0], title: 'latest invalid', updatedAt: '2026-11-12T03:00:00Z', attachments: 'invalid' });
  expect(await nextScene6BoardReceipt(input)).toBeNull();
});

test('successful suggest_accept survives a throwing member session lookup', async () => {
  const graph = { status: 'done', runId: 'run-current' };
  let sessionCalls = 0;
  const repl = buildReplTools({
    pluginRuntime: { hostTools: [], dispatchPluginTool: async () => ({ ok: true, result: graph }) },
    memberBoardSession: async () => {
      sessionCalls += 1;
      throw new Error('session provider unavailable');
    },
  });
  expect(await repl.dispatch('suggest_accept', { suggestionId: 'card-6' })).toEqual(graph);
  expect(sessionCalls).toBe(1);
});
