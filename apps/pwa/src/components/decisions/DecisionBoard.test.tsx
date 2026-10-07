import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import type { DaemonClient } from '@/lib/daemon-client';
import { DecisionBoard, sortOpenDecisions } from './DecisionBoard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(async () => { if (tree) await act(async () => { tree!.unmount(); }); tree = undefined; });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const item = (id: string, irreversible = false, dueAt?: string) => ({ id, title: `결정 ${id}`, situation: '옛 상황',
  scqa: { s: '가'.repeat(220), c: '문제', q: '질문' }, options: [{ id: 'a', label: '진행', consequence: '진행 결과' }, { id: 'b', label: '대기', consequence: '대기 결과' }],
  recommendation: { option: 'a', why: '빠르다' }, category: '운영', raisedBy: { agent: 'OP', track: 'OP' }, irreversible,
  crossCheck: [{ seat: 'TC', at: '2026-10-04T00:00:00Z', note: '검토' }], dissent: '반대', alternative: 'b',
  pendingQuestion: '전문 첫 줄\n전문 둘째 줄', dueAt });
async function mount(request: (path: string, init?: RequestInit) => Promise<Response>) {
  const client = { fetchResponse: request } as DaemonClient;
  await act(async () => { tree = create(<DaemonContext.Provider value={{ client, config: { baseUrl: '', token: '', provider: '' }, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}><DecisionBoard /></DaemonContext.Provider>); });
  return tree!.root;
}
const text = (node: ReactTestRenderer['root'] | ReturnType<ReactTestRenderer['root']['findByType']>): string =>
  node.children.map(child => typeof child === 'string' ? child : text(child)).join('');
const button = (root: ReactTestRenderer['root'], label: string) => root.findAllByType('button').find(node => text(node) === label)!;

test('deadline order places undated cards last; full SCQA, recommendation, checks and folded original question are readable', async () => {
  const root = await mount(async () => json({ decisions: [item('none'), item('late', false, '2026-10-07T00:00:00Z'), item('early', false, '2026-10-06T00:00:00Z')] }));
  expect(sortOpenDecisions([item('none'), item('late', false, '2026-10-07T00:00:00Z'), item('early', false, '2026-10-06T00:00:00Z')]).map(row => row.id)).toEqual(['early', 'late', 'none']);
  expect(root.findAllByType('article').map(node => node.props['aria-label'])).toEqual(['결정 early', '결정 late', '결정 none']);
  const first = root.findAllByType('article')[0]!;
  expect(text(first)).toContain('가'.repeat(220));
  expect(text(first)).toContain('분류: 운영');
  expect(text(first)).toContain('A:(비움)');
  expect(text(first)).toContain('권고: 진행 — 빠르다');
  expect(text(first)).toContain('진행 — 진행 결과');
  expect(text(first)).toContain('교차 확인: TC ✓ 검토 · 2026. 10. 4. 09:00 KST');
  expect(text(first)).toContain('이견: 반대');
  expect(first.findByType('time').props.dateTime).toBe('2026-10-06T00:00:00Z');
  expect(text(first)).toContain('2026. 10. 6.');
  expect(text(first)).toContain('KST');
  expect(first.findByType('details').findByType('summary').children).toEqual(['대기 질문 전문']);
  expect(text(first)).toContain('전문 첫 줄\n전문 둘째 줄');
});

test('skipped recommendation and skipped cross-check render their reasons without inventing missing SCQA fields', async () => {
  const skipped = { ...item('skipped'), recommendation: { skipped: true, reason: '판단 보류' },
    crossCheck: undefined, crossCheckSkipped: '검토 불가', scqa: { s: '상황', c: '문제' } };
  const root = await mount(async () => json({ decisions: [skipped] }));
  expect(text(root)).toContain('권고 없음: 판단 보류');
  expect(text(root)).toContain('교차 확인 없음(검토 불가)');
  expect(text(root)).toContain('Q:(비움)');
  expect(text(root)).toContain('A:(비움)');
});

test('note is capped at 300 and sent with choice; success becomes a folded decided label with ledger time', async () => {
  const posts: Array<{ path: string; body: unknown }> = [];
  const root = await mount(async (path, init) => {
    if (init?.method === 'POST') { posts.push({ path, body: JSON.parse(String(init.body)) }); return json({ decidedAt: '2026-10-06T00:00:00Z' }); }
    return json({ decisions: [item('one')] });
  });
  await act(async () => { root.findByType('input').props.onChange({ target: { value: '나'.repeat(305) } }); });
  expect(root.findByType('input').props.value).toHaveLength(300);
  await act(async () => { button(root, '진행 선택').props.onClick(); });
  expect(posts).toEqual([{ path: '/v1/decisions/one/decide', body: { choice: 'a', note: '나'.repeat(300) } }]);
  expect(root.findAllByType('article')).toHaveLength(0);
  expect(root.findByType('details').findByType('summary').children.join('')).toContain('결정됨: 진행 ·');
  expect(text(root.findByType('details'))).toContain('KST');
});

test('irreversible choice requires a second confirmation; cancellation never posts', async () => {
  const posts: unknown[] = [];
  const root = await mount(async (_path, init) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return json({ decidedAt: '2026-10-06T00:00:00Z' }); }
    return json({ decisions: [item('money', true)] });
  });
  expect(text(root)).toContain('되돌릴 수 없음');
  await act(async () => { button(root, '진행 선택').props.onClick(); });
  expect(posts).toHaveLength(0);
  expect(text(root.findByProps({ role: 'alert' }))).toContain('되돌릴 수 없습니다 — 이것으로 정할까요?');
  await act(async () => { button(root, '취소').props.onClick(); });
  expect(posts).toHaveLength(0);
  await act(async () => { button(root, '대기 선택').props.onClick(); });
  await act(async () => { button(root, '대기 선택').props.onClick(); });
  expect(posts).toHaveLength(0);
  await act(async () => { button(root, '예, 결정').props.onClick(); });
  expect(posts).toEqual([{ choice: 'b' }]);
});

test('409 and 404 stay on their respective cards while failed reads do not become zero cards', async () => {
  const root = await mount(async (path, init) => init?.method === 'POST' ? json({}, path.includes('one') ? 409 : 404)
    : json({ decisions: [item('one'), item('two')] }));
  await act(async () => { button(root, '진행 선택').props.onClick(); });
  expect(text(root.findAllByType('article')[0]!)).toContain('이미 결정됨');
  await act(async () => { root.findAllByType('article')[1]!.findAllByType('button')[0]!.props.onClick(); });
  expect(text(root.findAllByType('article')[1]!)).toContain('사라진 결정');
  await act(async () => { tree!.unmount(); }); tree = undefined;
  const failed = await mount(async () => json({ error: 'down' }, 503));
  expect(text(failed)).toContain('못 읽음 · decisions list failed: 503');
  expect(text(failed)).not.toContain('열린 결정이 없습니다');
});
