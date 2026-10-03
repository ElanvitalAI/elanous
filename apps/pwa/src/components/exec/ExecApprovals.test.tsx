import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonClient } from '@/lib/daemon-client';
import { ExecApprovals } from './ExecApprovals';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.fetch = originalFetch;
});

const client = new DaemonClient({ baseUrl: 'https://nexus.example', token: 'owner-token', provider: '' });
const approvals = [
  { graphId: 'graph/one', runId: 'run 1', message: '첫 승인' },
  { graphId: 'other', runId: 'run 2', message: '일치하지 않음' },
];
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
async function mount(onDecided = () => {}, onPendingChange = (_n: number) => {}) {
  await act(async () => { tree = create(<ExecApprovals client={client} approvals={approvals} onDecided={onDecided} onPendingChange={onPendingChange} />); });
  return tree!.root;
}

test('only a matching pending graph/run has actions; both decisions post the exact ids and reload the pending list', async () => {
  for (const [buttonLabel, decision, state] of [['승인', 'approved', '승인됨'], ['보류', 'rejected', '보류됨']] as const) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let reloads = 0;
    let refreshes = 0;
    const counts: number[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === 'POST') return json({ graphId: 'graph/one', runId: 'run 1', decision });
      reloads += 1;
      return json({ items: reloads === 1 ? [{ graphId: 'graph/one', runId: 'run 1', nodeId: 'publish', message: '승인', since: '', path: [], recent: [] },
        { graphId: 'unrelated', runId: 'run 1', nodeId: 'publish', message: '다른 승인', since: '', path: [], recent: [] }] : [] });
    }) as typeof fetch;
    const root = await mount(() => { refreshes += 1; }, n => { counts.push(n); });
    expect(counts).toEqual([1]);
    expect(root.findAllByType('button').map(button => button.children.join(''))).toEqual(['승인', '보류']);
    expect(root.findAllByType('li').find(li => li.findAllByType('p').some(p => p.children.join('') === '일치하지 않음'))!.findAllByType('button')).toHaveLength(0);
    await act(async () => { root.findAllByType('button').find(button => button.children.join('') === buttonLabel)!.props.onClick(); });
    expect(calls.filter(call => call.init?.method === 'POST')).toEqual([{
      url: 'https://nexus.example/v1/graph-approvals/graph%2Fone/run%201',
      init: expect.objectContaining({ method: 'POST', body: JSON.stringify({ decision }), headers: expect.objectContaining({ authorization: 'Bearer owner-token' }) }),
    }]);
    expect(reloads).toBe(2);
    expect(counts).toEqual([1, 0, 0]);
    expect(refreshes).toBe(1);
    expect(root.findAllByType('button')).toHaveLength(0);
    expect(root.findAllByType('p').some(p => p.children.join('') === state)).toBe(true);
    await act(async () => { tree!.unmount(); });
    tree = undefined;
  }
});

test('approval list and decision failures use the existing graph approval error text', async () => {
  let listFails = true;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return json({ error: 'conflict' }, 409);
    if (listFails) return json({ error: 'unauthorized' }, 401);
    return json({ items: [{ graphId: 'graph/one', runId: 'run 1' }] });
  }) as typeof fetch;
  const root = await mount();
  expect(root.findAllByType('button')).toHaveLength(0);
  expect(root.findByProps({ role: 'alert' }).children.join('')).toContain('목록을 보려면 이 기기를 데몬에 연결해야 합니다');
  listFails = false;
  await act(async () => { tree!.update(<ExecApprovals client={client} approvals={[...approvals, { graphId: 'new', runId: 'new', message: '새 승인' }]} onDecided={() => {}} onPendingChange={() => {}} />); });
  await act(async () => { root.findAllByType('button')[0]!.props.onClick(); });
  expect(root.findByProps({ role: 'alert' }).children.join('')).toBe('이미 결정된 실행입니다. 목록을 다시 확인해 주세요.');
  expect(root.findAllByType('button')).toHaveLength(2);
});
