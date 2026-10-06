import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import type { DaemonClient } from '@/lib/daemon-client';
import { DecisionCard } from '@/components/missions/DecisionCard';
import { ChatPendingDecision } from './ChatPendingDecision';
import { ChatHistory } from './ChatHistory';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
});

const pending = { id: 'one', title: '결정할 일', situation: '지금 선택', options: [{ id: 'yes', label: '진행' }], recommendation: { option: 'yes', why: '우선' } };
async function mount(items: typeof pending[], history = false, empty = false) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = { fetchResponse: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (init?.method === 'POST') { items = []; return new Response('{}'); }
    return new Response(JSON.stringify({ decisions: items }));
  } } as DaemonClient;
  const daemon = { client, config: { baseUrl: '', token: '', provider: '' }, sessionId: 'chat', setSessionId: () => {}, setConfig: () => {} };
  await act(async () => {
    tree = create(<DaemonContext.Provider value={daemon}>
      {history ? <ChatHistory messages={empty ? [] : [{ id: 'm1', role: 'user', text: '안녕', timestamp: 1 }]} pending={false} /> : <ChatPendingDecision />}
    </DaemonContext.Provider>);
  });
  return { root: tree!.root, calls };
}

test('a pending decision renders one shared card in the conversation and selection calls existing decide once', async () => {
  const { root, calls } = await mount([pending], true);
  expect(root.findAllByType(DecisionCard)).toHaveLength(1);
  expect(root.findAllByProps({ 'data-decision-card': 'one' })).toHaveLength(1);
  const button = root.findAllByType('button').find(node => node.children[0] === '진행')!;
  await act(async () => { button.props.onClick(); button.props.onClick(); });
  expect(calls.filter(call => call.init?.method === 'POST').map(call => ({ path: call.path, body: JSON.parse(String(call.init?.body)) })))
    .toEqual([{ path: '/v1/decisions/one/decide', body: { choice: 'yes' } }]);
  expect(root.findAllByType(DecisionCard)).toHaveLength(0);
});

test('zero pending decisions render zero cards in the chat history', async () => {
  const { root, calls } = await mount([], true);
  expect(calls[0]?.path).toBe('/v1/decisions?status=open');
  expect(root.findAllByType(DecisionCard)).toHaveLength(0);
});

test('multiple pending decisions still yield one card in the chat flow', async () => {
  const { root } = await mount([pending, { ...pending, id: 'two' }], true);
  expect(root.findAllByType(DecisionCard)).toHaveLength(1);
  expect(root.findByType(DecisionCard).props.decision.id).toBe('one');
});

test('an empty conversation also shows one pending decision card', async () => {
  const { root, calls } = await mount([pending], true, true);
  expect(calls[0]?.path).toBe('/v1/decisions?status=open');
  expect(root.findAllByType(DecisionCard)).toHaveLength(1);
});
