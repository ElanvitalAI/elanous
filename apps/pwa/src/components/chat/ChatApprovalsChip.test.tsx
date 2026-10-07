import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import type { DaemonClient } from '@/lib/daemon-client';
import { ChatApprovalsChip } from './ChatApprovalsChip';
import { ChatLayout } from './ChatLayout';
import { SeatsNowStrip } from './SeatsNowStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalFetch = globalThis.fetch;
let tree: ReactTestRenderer | undefined;

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  globalThis.fetch = originalFetch;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: Document }).document;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
});

const approval = (id: string) => ({ graphId: `graph/${id}`, runId: `run ${id}`, nodeId: 'publish', message: `게시 ${id}`, since: '', path: [], recent: [] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(request: (path: string, init?: RequestInit) => Promise<Response>) {
  const page = new EventTarget();
  let hidden = false;
  Object.defineProperty(page, 'hidden', { get: () => hidden });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page });
  const ticks = new Set<() => void>();
  const cancelled: unknown[] = [];
  globalThis.setInterval = ((tick: () => void, delay: number) => {
    expect(delay).toBe(30_000);
    ticks.add(tick);
    return tick as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
    cancelled.push(timer);
    ticks.delete(timer as unknown as () => void);
  }) as typeof clearInterval;
  globalThis.fetch = (async () => { throw new Error('real fetch must not be called'); }) as unknown as typeof fetch;
  const client = { fetchResponse: request } as DaemonClient;
  const daemon = { client, config: { baseUrl: '', token: '', provider: '' }, sessionId: '', setConfig: () => {}, setSessionId: () => {} };
  return {
    mount: async () => {
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatApprovalsChip /></DaemonContext.Provider>); });
      return tree!.root;
    },
    changeClient: async (requestNext: (path: string, init?: RequestInit) => Promise<Response>) => {
      daemon.client = { fetchResponse: requestNext } as DaemonClient;
      await act(async () => { tree!.update(<DaemonContext.Provider value={daemon}><ChatApprovalsChip /></DaemonContext.Provider>); });
      return tree!.root;
    },
    tick: async () => { await act(async () => { for (const callback of [...ticks]) callback(); }); },
    visibility: async (value: boolean) => { hidden = value; await act(async () => { page.dispatchEvent(new Event('visibilitychange')); }); },
    timerCount: () => ticks.size,
    cancelled,
  };
}

test('two pending approvals expand to the real ExecApprovals cards; a decision refreshes and zero removes the chip', async () => {
  const items = [approval('one'), approval('two')];
  let lists = 0;
  const decisions: Array<{ path: string; body: unknown }> = [];
  const fixture = setup(async (path, init) => {
    if (init?.method === 'POST') {
      decisions.push({ path, body: JSON.parse(String(init.body)) });
      items.shift();
      return json({});
    }
    lists++;
    return json({ items: [...items] });
  });
  const root = await fixture.mount();
  const chip = () => root.findAllByType('button').find(button => button.children.join('') === `승인 대기 ${items.length}`);
  expect(chip()?.props['aria-expanded']).toBe(false);
  expect(root.findAllByType('li')).toHaveLength(0);
  await act(async () => { chip()!.props.onClick(); });
  expect(chip()?.props['aria-expanded']).toBe(true);
  expect(root.findAllByType('li')).toHaveLength(2);
  expect(root.findAllByType('button').map(button => button.children.join(''))).toEqual(['승인 대기 2', '승인', '보류', '승인', '보류']);
  expect(lists).toBe(2);
  await act(async () => { root.findAllByType('button').find(button => button.children.join('') === '승인')!.props.onClick(); });
  expect(decisions).toEqual([{ path: '/v1/graph-approvals/graph%2Fone/run%20one', body: { decision: 'approved' } }]);
  expect(lists).toBeGreaterThan(2);
  expect(chip()?.props['aria-expanded']).toBe(true);
  expect(root.findAllByType('li')).toHaveLength(1);
  await act(async () => { root.findAllByType('button').find(button => button.children.join('') === '보류')!.props.onClick(); });
  expect(decisions[1]).toEqual({ path: '/v1/graph-approvals/graph%2Ftwo/run%20two', body: { decision: 'rejected' } });
  expect(root.findAllByType('div')).toHaveLength(0);
  expect(root.findAllByType('button')).toHaveLength(0);
});

test('zero and failed lists render nothing; 30-second polls pause while hidden and resume immediately on visibility', async () => {
  let calls = 0;
  let fail = false;
  let items = [] as ReturnType<typeof approval>[];
  const fixture = setup(async () => { calls++; return fail ? json({ error: 'unavailable' }, 500) : json({ items }); });
  const root = await fixture.mount();
  expect(calls).toBe(1);
  expect(root.findAllByType('div')).toHaveLength(0);
  items = [approval('one')];
  await fixture.tick();
  expect(calls).toBe(2);
  expect(root.findAllByType('button')[0]!.children.join('')).toBe('승인 대기 1');
  await fixture.visibility(true);
  await fixture.tick();
  expect(calls).toBe(2);
  fail = true;
  await fixture.visibility(false);
  expect(calls).toBe(3);
  expect(root.findAllByType('div')).toHaveLength(0);
  expect(root.findAllByType('button')).toHaveLength(0);
  fail = false;
  items = [];
  await fixture.tick();
  expect(calls).toBe(4);
  expect(root.findAllByType('div')).toHaveLength(0);
});

test('unmount clears timer and listener, and ignores an in-flight response', async () => {
  let calls = 0;
  let finish!: (response: Response) => void;
  const fixture = setup(async () => { calls++; return new Promise<Response>(resolve => { finish = resolve; }); });
  await fixture.mount();
  expect(calls).toBe(1);
  await act(async () => { tree!.unmount(); });
  tree = undefined;
  expect(fixture.timerCount()).toBe(0);
  expect(fixture.cancelled).toHaveLength(1);
  await fixture.tick();
  await fixture.visibility(true);
  expect(calls).toBe(1);
  await act(async () => { finish(json({ items: [approval('late')] })); });
  expect(calls).toBe(1);
});

test('switching clients hides old cards immediately and ignores a late old-client list', async () => {
  let oldCalls = 0;
  let finishOld!: (response: Response) => void;
  let finishNew!: (response: Response) => void;
  const decisions: string[] = [];
  const fixture = setup(async (path, init) => {
    if (init?.method === 'POST') { decisions.push(`old:${path}`); return json({}); }
    oldCalls++;
    return oldCalls < 3 ? json({ items: [approval('old')] })
      : new Promise<Response>(resolve => { finishOld = resolve; });
  });
  const root = await fixture.mount();
  await act(async () => { root.findByType('button').props.onClick(); });
  expect(root.findAllByType('button').map(button => button.children.join(''))).toEqual(['승인 대기 1', '승인', '보류']);
  await fixture.tick();
  await fixture.changeClient(async (path, init) => {
    if (init?.method === 'POST') { decisions.push(`new:${path}`); return json({}); }
    return new Promise<Response>(resolve => { finishNew = resolve; });
  });
  expect(root.findAllByType('button')).toHaveLength(0);
  expect(root.findAllByType('li')).toHaveLength(0);
  await act(async () => { finishOld(json({ items: [approval('old')] })); });
  expect(root.findAllByType('button')).toHaveLength(0);
  await act(async () => { finishNew(json({ items: [approval('new')] })); });
  expect(root.findByType('button').children.join('')).toBe('승인 대기 1');
  expect(root.findByType('button').props['aria-expanded']).toBe(false);
  expect(decisions).toEqual([]);
});

test('wide ChatLayout places the approvals chip after SeatsNowStrip without an extra wrapper', async () => {
  const request = async (path: string) => json(path.includes('decisions') ? { decisions: [] } : { items: [] });
  const daemon = { client: { fetchResponse: request, fetchJson: async () => ({ messages: [] }), voiceWsUrl: () => '', connectAcp: () => { throw Error('offline'); } } as never, config: { baseUrl: '', token: '', provider: '' }, sessionId: '', setConfig: () => {}, setSessionId: () => {} };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { innerWidth: 1024, location: { search: '' }, sessionStorage: { getItem: () => null } }) });
  await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatLayout /></DaemonContext.Provider>); });
  const children = tree!.root.findByType(ChatLayout).findByType('div').children.filter((child): child is ReactTestRenderer['root'] => typeof child !== 'string');
  const strip = children.findIndex(child => child.type === SeatsNowStrip);
  expect(strip).toBeGreaterThanOrEqual(0);
  expect(children[strip + 1]!.findAllByType(ChatApprovalsChip)).toHaveLength(1);
});
