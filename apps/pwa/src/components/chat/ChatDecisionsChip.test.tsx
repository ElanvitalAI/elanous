import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import type { DaemonClient } from '@/lib/daemon-client';
import { ChatDecisionsChip } from './ChatDecisionsChip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: Document }).document;
});

const decision = (id: string) => ({ id, title: `결정 ${id}`, situation: `상황 ${id}`, options: [{ id: 'a', label: '진행' }, { id: 'b', label: '대기' }], recommendation: { option: 'a', why: '빠름' } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function setup(request: (path: string, init?: RequestInit) => Promise<Response>) {
  const page = new EventTarget();
  let hidden = false;
  Object.defineProperty(page, 'hidden', { get: () => hidden });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page });
  const ticks = new Set<() => void>();
  globalThis.setInterval = ((tick: () => void, delay: number) => {
    expect(delay).toBe(30_000);
    ticks.add(tick);
    return tick as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => { ticks.delete(timer as unknown as () => void); }) as typeof clearInterval;
  const daemon = { client: { fetchResponse: request } as DaemonClient, config: { baseUrl: '', token: '', provider: '' }, sessionId: '', setConfig: () => {}, setSessionId: () => {} };
  return {
    mount: async () => {
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatDecisionsChip /></DaemonContext.Provider>); });
      return tree!.root;
    },
    tick: async () => { await act(async () => { for (const tick of [...ticks]) tick(); }); },
    visibility: async (value: boolean) => { hidden = value; await act(async () => { page.dispatchEvent(new Event('visibilitychange')); }); },
    changeClient: async (next: typeof request) => {
      daemon.client = { fetchResponse: next } as DaemonClient;
      await act(async () => { tree!.update(<DaemonContext.Provider value={daemon}><ChatDecisionsChip /></DaemonContext.Provider>); });
      return tree!.root;
    },
    timerCount: () => ticks.size,
  };
}

test('two open decisions show chip, expandable cards with recommended option, one POST, decided label and refresh', async () => {
  const items = [decision('first'), decision('second')];
  let lists = 0;
  const posts: Array<{ path: string; method: string; body: unknown }> = [];
  const fx = setup(async (path, init) => {
    if (init?.method === 'POST') {
      posts.push({ path, method: init.method, body: JSON.parse(String(init.body)) });
      items.shift();
      return json({ id: 'first', status: 'decided' });
    }
    expect(path).toBe('/v1/decisions?status=open');
    lists++;
    return json({ decisions: [...items] });
  });
  const root = await fx.mount();
  const chip = () => root.findAllByType('button').find(button => button.children.join('') === '대표 결정 2');
  expect(chip()?.props['aria-expanded']).toBe(false);
  expect(root.findAllByType('li')).toHaveLength(0);
  await act(async () => { chip()!.props.onClick(); });
  expect(root.findAllByType('li')).toHaveLength(2);
  expect(root.findAllByType('h3').map(node => node.children.join(''))).toEqual(['결정 first', '결정 second']);
  expect(root.findAllByType('p').map(node => node.children.join(''))).toEqual(['상황 first', '상황 second']);
  const recommended = root.findAllByType('button').find(button => button.findAllByType('span').some(node => node.children.join('') === '추천'))!;
  expect(recommended).toBeDefined();
  expect(recommended.children[0]).toBe('진행');
  await act(async () => { recommended.props.onClick(); recommended.props.onClick(); });
  expect(posts).toEqual([{ path: '/v1/decisions/first/decide', method: 'POST', body: { choice: 'a' } }]);
  expect(lists).toBe(2);
  expect(root.findAllByProps({ role: 'status' }).map(node => node.children.join(''))).toContain('결정함 — 진행');
  expect(root.findAllByType('button')[0]!.children.join('')).toBe('대표 결정 1');
});

test('the final choice stays visible as decided after the refreshed list becomes empty', async () => {
  const items = [decision('only')];
  let lists = 0;
  const fx = setup(async (_path, init) => {
    if (init?.method === 'POST') { items.pop(); return json({ status: 'decided' }); }
    lists++;
    return json({ decisions: [...items] });
  });
  const root = await fx.mount();
  await act(async () => { root.findByType('button').props.onClick(); });
  const option = root.findAllByType('button').find(button => button.findAllByType('span').some(node => node.children.join('') === '추천'))!;
  await act(async () => { option.props.onClick(); });
  expect(lists).toBe(2);
  expect(root.findAllByProps({ role: 'status' }).map(node => node.children.join(''))).toContain('결정함 — 진행');
});

test('zero/failure render null; polling pauses hidden, resumes visible; unmount clears timer', async () => {
  let calls = 0;
  let fail = false;
  let items = [] as ReturnType<typeof decision>[];
  const fx = setup(async () => { calls++; return fail ? json({ error: 'failed' }, 500) : json({ decisions: items }); });
  const root = await fx.mount();
  expect(calls).toBe(1);
  expect(root.findAllByType('div')).toHaveLength(0);
  items = [decision('one')];
  await fx.tick();
  expect(root.findByType('button').children.join('')).toBe('대표 결정 1');
  await fx.visibility(true);
  await fx.tick();
  expect(calls).toBe(2);
  fail = true;
  await fx.visibility(false);
  expect(calls).toBe(3);
  expect(root.findAllByType('div')).toHaveLength(0);
  await act(async () => { tree!.unmount(); });
  tree = undefined;
  expect(fx.timerCount()).toBe(0);
  await fx.tick();
  expect(calls).toBe(3);
});

test('client switch hides old decisions and ignores late old-client response', async () => {
  let oldCalls = 0;
  let finishOld!: (response: Response) => void;
  let finishNew!: (response: Response) => void;
  const fx = setup(async () => {
    oldCalls++;
    return oldCalls === 1 ? json({ decisions: [decision('old')] }) : new Promise<Response>(resolve => { finishOld = resolve; });
  });
  const root = await fx.mount();
  expect(root.findByType('button').children.join('')).toBe('대표 결정 1');
  await fx.tick();
  await fx.changeClient(async () => new Promise<Response>(resolve => { finishNew = resolve; }));
  expect(root.findAllByType('button')).toHaveLength(0);
  await act(async () => { finishOld(json({ decisions: [decision('stale')] })); });
  expect(root.findAllByType('button')).toHaveLength(0);
  await act(async () => { finishNew(json({ decisions: [decision('new')] })); });
  expect(root.findByType('button').children.join('')).toBe('대표 결정 1');
});

test('unmount ignores a pending list response', async () => {
  let finish!: (response: Response) => void;
  let calls = 0;
  const fx = setup(async () => { calls++; return new Promise<Response>(resolve => { finish = resolve; }); });
  await fx.mount();
  expect(calls).toBe(1);
  await act(async () => { tree!.unmount(); });
  tree = undefined;
  expect(fx.timerCount()).toBe(0);
  await act(async () => { finish(json({ decisions: [decision('late')] })); });
  await fx.tick();
  expect(calls).toBe(1);
});

test('ChatLayout places ChatDecisionsChip immediately after ChatApprovalsChip', () => {
  const source = readFileSync(new URL('./ChatLayout.tsx', import.meta.url), 'utf8');
  expect(source).toMatch(/<ChatApprovalsChip \/>\s*<ChatDecisionsChip \/>/);
});
