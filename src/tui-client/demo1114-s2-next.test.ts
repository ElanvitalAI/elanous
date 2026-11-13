import { expect, test } from 'bun:test';
import { nextScene2BriefReceipt } from '../repl/scene2-brief-receipt.js';

test('Scene 2 NEXT reports only a persisted and source-linked briefing', () => {
  const brief = { nodeId: 'brief', output: JSON.stringify({ evidence: { memberId: 'member-a', briefing: {
    id: 'brief-a', summary: '동시 접속 · 중복 예매 · 공정 대기열', scrapIds: ['scrap-a'],
  } } }) };
  const saved = { nodeId: 'save-brief', ok: true, executed: true, output: JSON.stringify({ result: { stored: true } }) };
  const graph = { graphId: 'absorb-brief', status: 'done', nodes: [brief, saved] };
  expect(nextScene2BriefReceipt(graph, graph.graphId)).toContain('출처 스크랩: scrap-a');
  expect(nextScene2BriefReceipt(graph, 'another-graph')).toBeNull();
  expect(nextScene2BriefReceipt({ ...graph, status: 'failed' }, graph.graphId)).toBeNull();
  expect(nextScene2BriefReceipt({ ...graph, nodes: [brief] }, graph.graphId)).toBeNull();
  const unrelatedSave = { ...saved, nodeId: 'save-suggestions' };
  expect(nextScene2BriefReceipt({ ...graph, nodes: [brief, unrelatedSave] }, graph.graphId)).toBeNull();
  expect(nextScene2BriefReceipt({ ...graph, nodes: [brief, { ...saved, ok: false }, unrelatedSave] }, graph.graphId)).toBeNull();
  expect(nextScene2BriefReceipt({ ...graph, nodes: [brief, { ...saved, executed: false }, unrelatedSave] }, graph.graphId)).toBeNull();
  expect(nextScene2BriefReceipt({ ...graph, nodes: [{ ...brief, output: JSON.stringify({ evidence: {
    memberId: 'member-a', briefing: { id: 'brief-a', summary: '무출처', scrapIds: [] },
  } }) }, saved] }, graph.graphId)).toBeNull();
});
