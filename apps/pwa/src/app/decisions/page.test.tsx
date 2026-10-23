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

test('/decisions route reaches the seven judgement cells and their fold control', async () => {
  const card = {
    id: 'route-cells', title: 'Route cells', situation: '운영 판단',
    scqa: { s: '상황', c: '문제', q: '질문' },
    options: [{ id: 'a', label: '진행', consequence: '진행' }, { id: 'b', label: '대기', consequence: '대기' }],
    recommendation: { option: 'a', why: '권고 근거' }, category: 'ops',
    raisedBy: { agent: 'OP', track: 'OP' }, irreversible: false,
    history: [
      { type: 'raised', at: '2026-10-05T01:00:00Z', by: 'OP' },
      { type: 'options-added', at: '2026-10-06T02:00:00Z', by: 'MK', choice: '대기' },
    ],
    precedent: { id: 'prev-9', title: '결정 prev-9', choice: '진행', decidedAt: '2026-10-04T00:00:00Z', decidedBy: 'auto' },
  };
  const client = { fetchResponse: async () => new Response(JSON.stringify({ decisions: [card] }), { status: 200 }) } as unknown as DaemonClient;
  await act(async () => {
    tree = create(<DaemonContext.Provider value={{ client, config: { baseUrl: '', token: '', provider: '' }, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}>
      <DecisionsPage />
    </DaemonContext.Provider>);
  });
  const root = tree!.root;
  const text = (node: typeof root): string => node.children.map(child => (typeof child === 'string' ? child : text(child as typeof root))).join('');
  const board = () => text(root.findAllByType('article')[0]!);
  for (const label of ['무엇', '지금까지', '이전 같은 갈래 결정', '지금 상태 재측', '선택지별 결과', '권고와 근거', '그냥 두면']) expect(board()).toContain(label);
  expect(board()).toContain('2026. 10. 6. 11:00 KST MK 선택지 추가 → 대기');
  expect(board()).toContain('결정 prev-9 → 진행 · 2026. 10. 4. 09:00 KST · 자율 결정');
  expect(board()).toContain('교차 확인 없음 · 사유 미기재');
  expect(board()).toContain('진행 — 권고 근거');
  expect(board()).toContain('기한 없음 — 그대로 두면 계속 열린 채로 남습니다');
  const fold = () => root.findAllByType('button').find(node => ['판단 칸 접기', '판단 칸 펼치기'].includes(node.children.join('')));
  expect(fold()!.children.join('')).toBe('판단 칸 접기');
  await act(async () => { fold()!.props.onClick(); });
  expect(fold()!.children.join('')).toBe('판단 칸 펼치기');
  expect(board()).not.toContain('2026. 10. 6. 11:00 KST MK 선택지 추가 → 대기');
  await act(async () => { fold()!.props.onClick(); });
  expect(root.findAllByType('button').map(node => node.children.join(''))).toContain('무엇 접기');
  const cellFold = () => root.findAllByType('button').find(node => node.children.join('') === '무엇 접기');
  await act(async () => { cellFold()!.props.onClick(); });
  const cellLabels = root.findAllByType('button').map(node => node.children.join(''));
  expect(cellLabels).toContain('무엇 펼치기');
  expect(cellLabels).not.toContain('무엇 접기');
});
