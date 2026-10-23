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

test('a batch of eighteen decision cards stays readable while a seat reply travels through the notice tab', async () => {
  const cards = Array.from({ length: 18 }, (_, index) => item(`batch-${index}`));
  const requests: Array<{ path: string; body?: unknown }> = [];
  const root = await mount(async (path, init) => {
    requests.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === '/v1/ops-board/notices') return init?.method === 'POST'
      ? json({ reply: { id: 20, from: 'CEO', to: 'MK', body: '의견', createdAt: '2026-10-07T00:00:00Z' } }, 201)
      : json({ notices: [{ id: 19, from: 'MK', to: 'CEO', body: '공지', createdAt: '2026-10-07T00:00:00Z' }] });
    if (init?.method === 'POST') return json({ decidedAt: '2026-10-07T00:00:00Z' });
    return json({ decisions: cards });
  });
  expect(root.findAllByType('article')).toHaveLength(18);
  for (let index = 0; index < 18; index++) {
    await act(async () => { root.findAllByType('article')[0]!.findAllByType('button')[0]!.props.onClick(); });
  }
  expect(requests.filter(request => request.path.endsWith('/decide'))).toHaveLength(18);
  expect(root.findAllByType('article')).toHaveLength(0);
  await act(async () => { button(root, '공지 · 의견').props.onClick(); });
  await act(async () => { root.findByType('textarea').props.onChange({ target: { value: '의견' } }); });
  await act(async () => { button(root, '답글 보내기').props.onClick(); });
  expect(requests).toContainEqual({ path: '/v1/ops-board/notices', body: { noticeId: 19, body: '의견' } });
});

test('rapid repeated reply click writes only once while the first request is in flight', async () => {
  let finish!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const writes: unknown[] = [];
  const notice = { id: 13, from: 'TC', to: 'CEO', body: '공지', createdAt: '2026-10-07T00:00:00Z' };
  const root = await mount(async (path, init) => {
    if (path !== '/v1/ops-board/notices') return json({ decisions: [] });
    if (!init?.method) return json({ notices: [notice] });
    writes.push(init.body);
    return pending;
  });
  await act(async () => { button(root, '공지 · 의견').props.onClick(); });
  await act(async () => { root.findByType('textarea').props.onChange({ target: { value: '답' } }); });
  await act(async () => {
    button(root, '답글 보내기').props.onClick();
    button(root, '답글 보내기').props.onClick();
  });
  expect(writes).toHaveLength(1);
  await act(async () => { finish(json({ reply: { ...notice, from: 'CEO', to: 'TC' } }, 201)); });
});

test('notice tab reads owner inbox and sends a reply to the originating seat', async () => {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const notice = { id: 3, from: 'UX', to: 'CEO', body: '조율 채널 요약', kind: 'notice', createdAt: '2026-10-07T00:00:00Z' };
  const root = await mount(async (path, init) => {
    calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path === '/v1/ops-board/notices') return init?.method === 'POST' ? json({ reply: { ...notice, from: 'CEO', to: 'UX' } }, 201) : json({ notices: [notice] });
    return json({ decisions: [] });
  });
  await act(async () => { button(root, '공지 · 의견').props.onClick(); });
  expect(text(root)).toContain('조율 채널 요약');
  expect(root.findByType('textarea').props.value).toBe('');
  await act(async () => { root.findByType('textarea').props.onChange({ target: { value: '확인했습니다' } }); });
  await act(async () => { button(root, '답글 보내기').props.onClick(); });
  expect(calls).toContainEqual({ path: '/v1/ops-board/notices', body: { noticeId: 3, body: '확인했습니다' } });
  expect(text(root)).toContain('UX 수신함으로 보냄');
  await act(async () => { button(root, '공지 새로고침').props.onClick(); });
  expect(calls.filter(call => call.path === '/v1/ops-board/notices' && !call.body)).toHaveLength(2);
});

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

test('OP filter keeps only decisions raised by OP and toggling off restores the full list', async () => {
  const cards = [item('op-1'), item('op-2'), { ...item('tc-1'), raisedBy: { agent: 'TC', track: 'TOX' } }];
  const root = await mount(async (_path, init) => init?.method === 'POST' ? json({ decidedAt: '2026-10-07T00:00:00Z' }) : json({ decisions: cards }));
  expect(root.findAllByType('article')).toHaveLength(3);
  await act(async () => { button(root, 'OP 거르기').props.onClick(); });
  expect(root.findAllByType('article').map(node => node.props['aria-label'])).toEqual(['결정 op-1', '결정 op-2']);
  expect(button(root, 'OP 거르기').props['aria-pressed']).toBe(true);
  await act(async () => { button(root, 'OP 거르기').props.onClick(); });
  expect(root.findAllByType('article')).toHaveLength(3);
  expect(button(root, 'OP 거르기').props['aria-pressed']).toBe(false);
});

test('bulk decision posts the recommendation for all eighteen visible pending cards', async () => {
  const cards = Array.from({ length: 18 }, (_, index) => item(`bulk-${index + 1}`));
  const posts: Array<{ path: string; body: { choice: string } }> = [];
  const root = await mount(async (path, init) => {
    if (init?.method === 'POST') { posts.push({ path, body: JSON.parse(String(init.body)) as { choice: string } }); return json({ decidedAt: '2026-10-07T00:00:00Z' }); }
    return json({ decisions: cards });
  });
  await act(async () => { button(root, '권고대로 일괄 결정').props.onClick(); });
  expect(posts).toHaveLength(18);
  expect(new Set(posts.map(post => post.path)).size).toBe(18);
  expect(new Set(posts.map(post => post.path))).toEqual(new Set(cards.map(card => `/v1/decisions/${card.id}/decide`)));
  expect(posts.every(post => post.body.choice === 'a')).toBe(true);
  expect(root.findAllByType('article')).toHaveLength(0);
  expect(text(root)).toContain('권고대로 18건을 일괄 결정했습니다');
});

test('OP filter control stays visible for empty results and filter changes clear bulk re-confirmation', async () => {
  const cards = [{ ...item('tc-only'), raisedBy: { agent: 'TC', track: 'TOX' } },
    { ...item('irreversible', true), raisedBy: { agent: 'TC', track: 'TOX' } }];
  const posts: unknown[] = [];
  const root = await mount(async (_path, init) => {
    if (init?.method === 'POST') { posts.push(init.body); return json({ decidedAt: '2026-10-07T00:00:00Z' }); }
    return json({ decisions: cards });
  });
  await act(async () => { button(root, '권고대로 일괄 결정').props.onClick(); });
  expect(text(root.findByProps({ role: 'status' }))).toContain('되돌릴 수 없는 결정 1건 포함');
  await act(async () => { button(root, 'OP 거르기').props.onClick(); });
  expect(button(root, 'OP 거르기').props['aria-pressed']).toBe(true);
  expect(text(root)).toContain('OP가 올린 열린 결정이 없습니다.');
  expect(button(root, '권고대로 일괄 결정').props.disabled).toBe(true);
  await act(async () => { button(root, 'OP 거르기').props.onClick(); });
  await act(async () => { button(root, '권고대로 일괄 결정').props.onClick(); });
  expect(posts).toHaveLength(0);
  expect(text(root.findByProps({ role: 'status' }))).toContain('되돌릴 수 없는 결정 1건 포함');
});

test('bulk decision over irreversible cards waits for one explicit re-confirmation', async () => {
  const posts: unknown[] = [];
  const root = await mount(async (_path, init) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return json({ decidedAt: '2026-10-07T00:00:00Z' }); }
    return json({ decisions: [item('irrev', true)] });
  });
  await act(async () => { button(root, '권고대로 일괄 결정').props.onClick(); });
  expect(posts).toHaveLength(0);
  expect(text(root.findByProps({ role: 'status' }))).toContain('되돌릴 수 없는 결정 1건 포함');
  await act(async () => { button(root, '권고대로 일괄 결정').props.onClick(); });
  expect(posts).toEqual([{ choice: 'a' }]);
  expect(root.findAllByType('article')).toHaveLength(0);
});

test('OPS-BOARD-FU: an open card renders all seven judgement cells from the served ledger and folds them away', async () => {
  const card = { ...item('cells', false, '2026-10-21T00:00:00Z'), raisedAt: '2026-10-19T00:00:00Z',
    history: [
      { type: 'raised', at: '2026-10-19T00:00:00Z', by: 'OP' },
      { type: 'options-added', at: '2026-10-20T00:00:00Z', by: 'MK', choice: '대기' },
    ],
    precedent: { id: 'prev-1', title: '결정 prev-1', choice: '진행', decidedAt: '2026-10-18T00:00:00Z', decidedBy: 'human' } };
  const root = await mount(async () => json({ decisions: [card] }));
  const first = root.findAllByType('article')[0]!;
  for (const label of ['무엇', '지금까지', '이전 같은 갈래 결정', '지금 상태 재측', '선택지별 결과', '권고와 근거', '그냥 두면']) {
    expect(text(first)).toContain(label);
  }
  expect(text(first)).toContain('2026. 10. 19. 09:00 KST OP 올림');
  expect(text(first)).toContain('2026. 10. 20. 09:00 KST MK 선택지 추가 → 대기');
  expect(text(first)).toContain('결정 prev-1 → 진행 · 2026. 10. 18. 09:00 KST · 대표 결정');
  expect(text(first)).toContain('TC 교차 확인 · 2026. 10. 4. 09:00 KST · 검토');
  expect(text(first)).toContain('A) 진행 — 진행 결과');
  expect(text(first)).toContain('B) 대기 — 대기 결과');
  expect(text(first)).toContain('진행 — 빠르다');
  expect(text(first)).not.toContain('확신');
  expect(text(first)).toContain('기한 2026. 10. 21. 09:00 KST 이 지나면 열린 채로 남습니다');
  await act(async () => { button(root, '무엇 접기').props.onClick(); });
  expect(button(root, '무엇 펼치기').props['aria-expanded']).toBe(false);
  await act(async () => { button(root, '무엇 펼치기').props.onClick(); });
  expect(button(root, '무엇 접기').props['aria-expanded']).toBe(true);
  expect(button(root, '판단 칸 접기').props['aria-expanded']).toBe(true);
  await act(async () => { button(root, '판단 칸 접기').props.onClick(); });
  expect(text(root)).not.toContain('OP 올림');
  expect(button(root, '판단 칸 펼치기').props['aria-expanded']).toBe(false);
  await act(async () => { button(root, '판단 칸 펼치기').props.onClick(); });
  expect(text(root)).toContain('OP 올림');
});

test('OPS-BOARD-FU: unrecorded judgement cells stay explicit instead of being invented', async () => {
  const bare = { ...item('bare'), title: '', recommendation: { skipped: true as const, reason: '판단 보류' },
    crossCheck: [], crossCheckSkipped: '자료 없음', history: [], precedent: null };
  const root = await mount(async () => json({ decisions: [bare] }));
  const first = root.findAllByType('article')[0]!;
  expect(first.findAllByType('dd').map(node => text(node))).toContain('미기재');
  expect(text(first)).toContain('원장 기록 없음 · 제기 시각 미상');
  expect(text(first)).toContain('이전 같은 갈래 결정 없음');
  expect(text(first)).toContain('교차 확인 없음 · 자료 없음');
  expect(text(first)).toContain('권고 없음: 판단 보류');
  expect(text(first)).toContain('기한 없음 — 그대로 두면 계속 열린 채로 남습니다');
});

test('individual decision clears bulk re-confirmation after changing its target set', async () => {
  const cards = [item('first', true), item('second', true)];
  const posts: string[] = [];
  const root = await mount(async (path, init) => {
    if (init?.method === 'POST') { posts.push(path); return json({ decidedAt: '2026-10-07T00:00:00Z' }); }
    return json({ decisions: cards });
  });
  await act(async () => { button(root, '권고대로 일괄 결정').props.onClick(); });
  expect(text(root.findByProps({ role: 'status' }))).toContain('되돌릴 수 없는 결정 2건 포함');
  await act(async () => { root.findAllByType('article')[0]!.findAllByType('button')[0]!.props.onClick(); });
  await act(async () => { button(root, '예, 결정').props.onClick(); });
  expect(posts).toEqual(['/v1/decisions/first/decide']);
  await act(async () => { button(root, '권고대로 일괄 결정').props.onClick(); });
  expect(posts).toHaveLength(1);
  expect(text(root.findByProps({ role: 'status' }))).toContain('되돌릴 수 없는 결정 1건 포함');
});

test('OPS-BOARD-FU: a precedent whose deciding actor is unrecorded shows unknown instead of an autonomous decision', async () => {
  const unrecorded = { ...item('unknown-cell'),
    precedent: { id: 'prev-u', title: '결정 prev-u', choice: '진행', decidedAt: '2026-10-18T00:00:00Z' } };
  const autonomous = { ...item('auto-cell'),
    precedent: { id: 'prev-a', title: '결정 prev-a', choice: '진행', decidedAt: '2026-10-18T00:00:00Z', decidedBy: 'auto' } };
  const root = await mount(async () => json({ decisions: [unrecorded, autonomous] }));
  const articles = root.findAllByType('article');
  const unknownCard = articles.find(node => text(node).includes('결정 unknown-cell'))!;
  const autoCard = articles.find(node => text(node).includes('결정 auto-cell'))!;
  expect(text(unknownCard)).toContain('결정 prev-u → 진행 · 2026. 10. 18. 09:00 KST · 결정 주체 미상');
  expect(text(unknownCard)).not.toContain('자율 결정');
  expect(text(autoCard)).toContain('결정 prev-a → 진행 · 2026. 10. 18. 09:00 KST · 자율 결정');
});
