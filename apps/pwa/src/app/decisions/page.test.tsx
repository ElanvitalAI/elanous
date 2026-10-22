import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DecisionBoard } from '@/components/decisions/DecisionBoard';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import type { DaemonClient } from '@/lib/daemon-client';
import DecisionsPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(async () => { if (tree) await act(async () => { tree!.unmount(); }); tree = undefined; });

test('/decisions renders the decision board without a dynamic route or server fetch', () => {
  const element = DecisionsPage();
  expect(element.type).toBe(DecisionBoard);
});

test('/decisions route reaches the board read and eighteen decision POSTs', async () => {
  const cards = Array.from({ length: 18 }, (_, index) => ({
    id: `route-${index + 1}`, title: `Route decision ${index + 1}`, situation: '운영 판단',
    scqa: { s: '상황', c: '문제', q: '질문' },
    options: [{ id: 'a', label: '진행', consequence: '진행' }, { id: 'b', label: '대기', consequence: '대기' }],
    recommendation: { option: 'a', why: '권고 근거' }, category: 'ops',
    raisedBy: { agent: 'OP', track: 'OP' }, irreversible: false,
  }));
  const requests: Array<{ path: string; method: string }> = [];
  const client = { fetchResponse: async (path: string, init?: RequestInit) => {
    requests.push({ path, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify(init?.method === 'POST'
      ? { decidedAt: '2026-10-21T00:00:00Z' }
      : { decisions: cards }), { status: 200 });
  } } as DaemonClient;
  await act(async () => {
    tree = create(<DaemonContext.Provider value={{ client, config: { baseUrl: '', token: '', provider: '' }, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}>
      <DecisionsPage />
    </DaemonContext.Provider>);
  });
  expect(requests).toContainEqual({ path: '/v1/decisions?status=open', method: 'GET' });
  const root = tree!.root;
  const bulk = root.findAllByType('button').find(node => node.children.join('') === '권고대로 일괄 결정');
  expect(bulk).toBeDefined();
  await act(async () => { bulk!.props.onClick(); });
  const decisions = requests.filter(request => request.method === 'POST' && request.path.endsWith('/decide'));
  expect(decisions).toHaveLength(18);
  expect(new Set(decisions.map(request => request.path)).size).toBe(18);
});
