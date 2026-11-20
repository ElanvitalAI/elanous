import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import IntakeFrontDoorPage from './page';

type Wish = { text: string; ref: string };
function mount(failFirst: boolean) {
  const calls: Wish[] = [];
  const cards = new Map<string, string>(); // 서버: ref 멱등
  let failed = !failFirst;
  const client = {
    fetchJson: async (path: string, init?: RequestInit) => {
      if (path !== '/v1/task-cards/wish') return { track: 'tasks', reason: 'test', decidedBy: 'rule' };
      const body = JSON.parse(String(init?.body)) as Wish;
      calls.push({ text: body.text, ref: body.ref });
      const created = !cards.has(body.ref);
      if (created) cards.set(body.ref, body.text);
      if (!failed) { failed = true; throw new Error('network lost'); } // 서버는 저장했으나 응답 유실
      return { cardId: `card-${body.ref}`, title: body.text, created };
    },
  };
  const daemon = { client, sessionId: 's1', daemonAvailable: true, config: { baseUrl: '', token: '', provider: '' },
    setConfig: () => {}, setSessionId: () => {} } as unknown as NonNullable<import('react').ContextType<typeof DaemonContext>>;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let r!: ReturnType<typeof create>;
  const ready = act(async () => { r = create(createElement(DaemonContext.Provider, { value: daemon }, createElement(IntakeFrontDoorPage))); });
  const byId = (id: string) => r.root.findByProps({ 'data-testid': id });
  const type = async (value: string) => { await act(async () => { byId('intake-front-door-field').props.onChange({ target: { value } }); }); };
  const click = async () => { await act(async () => { byId('intake-split').props.onClick(); }); };
  return { calls, cards, ready, type, click };
}

test('lost response then same-text retry reuses the same ref (1 card, no duplicate)', async () => {
  const m = mount(true);
  await m.ready;
  await m.type('A');
  await m.click(); // 서버 저장 + 응답 유실
  await m.click(); // 같은 입력 재클릭
  expect(m.calls.length).toBe(2);
  expect(m.calls[1]!.ref).toBe(m.calls[0]!.ref);
  expect(m.cards.size).toBe(1);
});

test('A lost response -> B succeeds -> retry A reuses A ref (1 card for A, 1 for B)', async () => {
  const m = mount(true);
  await m.ready;
  await m.type('A');
  await m.click(); // A 저장 + 응답 유실
  await m.type('B');
  await m.click(); // B 성공
  await m.type('A');
  await m.click(); // A 재시도
  expect(m.calls.map((c) => c.text)).toEqual(['A', 'B', 'A']);
  expect(m.calls[2]!.ref).toBe(m.calls[0]!.ref);
  expect(m.calls[1]!.ref).not.toBe(m.calls[0]!.ref);
  expect(m.cards.size).toBe(2);
  expect([...m.cards.values()].filter((v) => v === 'A').length).toBe(1);
});

test('after a confirmed success, the same text again is a deliberate new submission (new ref)', async () => {
  const m = mount(false);
  await m.ready;
  await m.type('A');
  await m.click();
  await m.click();
  expect(m.calls[1]!.ref).not.toBe(m.calls[0]!.ref);
  expect(m.cards.size).toBe(2);
});

test('editing the text after a failure generates a new ref', async () => {
  const m = mount(true);
  await m.ready;
  await m.type('A');
  await m.click();
  await m.type('B');
  await m.click();
  expect(m.calls[1]!.text).toBe('B');
  expect(m.calls[1]!.ref).not.toBe(m.calls[0]!.ref);
});

test('two tasks-track submissions with different text use different wish refs and both create cards', async () => {
  const wishCalls: Array<{ text: string; ref: string }> = [];
  const client = {
    fetchJson: async (path: string, init?: RequestInit) => {
      if (path === '/v1/task-cards/wish') {
        const body = JSON.parse(String(init?.body)) as { text: string; ref: string };
        wishCalls.push({ text: body.text, ref: body.ref });
        return { cardId: `card-${wishCalls.length}`, title: body.text, created: true };
      }
      return { track: 'tasks', reason: 'test', decidedBy: 'rule' };
    },
  };
  const daemon = { client, sessionId: 's1', daemonAvailable: true, config: { baseUrl: '', token: '', provider: '' },
    setConfig: () => {}, setSessionId: () => {} } as unknown as NonNullable<import('react').ContextType<typeof DaemonContext>>;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(createElement(DaemonContext.Provider, { value: daemon }, createElement(IntakeFrontDoorPage))); });
  const byId = (id: string) => r.root.findByProps({ 'data-testid': id });
  const submit = async (value: string) => {
    await act(async () => { byId('intake-front-door-field').props.onChange({ target: { value } }); });
    await act(async () => { byId('intake-split').props.onClick(); });
  };

  await submit('첫 번째 과제');
  await submit('두 번째 과제');

  expect(wishCalls.map((c) => c.text)).toEqual(['첫 번째 과제', '두 번째 과제']);
  expect(wishCalls[0]!.ref).not.toBe(wishCalls[1]!.ref);
  for (const c of wishCalls) expect(c.ref).toMatch(/^intake-[\w-]+$/);
  expect(JSON.stringify(byId('intake-result').props.children)).toContain('두 번째 과제');
});


test('only one submission in flight: second submit is ignored, buttons disabled, then B works with a new ref', async () => {
  const calls: Array<{ text: string; ref: string }> = [];
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  let first = true;
  const client = {
    fetchJson: async (path: string, init?: RequestInit) => {
      if (path !== '/v1/task-cards/wish') return { track: 'tasks', reason: 'test', decidedBy: 'rule' };
      const body = JSON.parse(String(init?.body)) as { text: string; ref: string };
      calls.push({ text: body.text, ref: body.ref });
      if (first) { first = false; await gate; }
      return { cardId: `card-${body.ref}`, title: body.text, created: true };
    },
  };
  const daemon = { client, sessionId: 's1', daemonAvailable: true, config: { baseUrl: '', token: '', provider: '' },
    setConfig: () => {}, setSessionId: () => {} } as unknown as NonNullable<import('react').ContextType<typeof DaemonContext>>;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(createElement(DaemonContext.Provider, { value: daemon }, createElement(IntakeFrontDoorPage))); });
  const byId = (id: string) => r.root.findByProps({ 'data-testid': id });
  const type = async (value: string) => { await act(async () => { byId('intake-front-door-field').props.onChange({ target: { value } }); }); };

  await type('A');
  let pendingA!: Promise<void>;
  await act(async () => { pendingA = Promise.resolve(byId('intake-split').props.onClick()); });
  expect(byId('intake-split').props.disabled).toBe(true);
  expect(byId('intake-absorb').props.disabled).toBe(true);
  expect(byId('intake-graph').props.disabled).toBe(true);

  await type('B');
  await act(async () => { byId('intake-split').props.onClick(); });
  expect(calls.length).toBe(1); // B 무시 — 동시 제출 불가

  await act(async () => { release(); await pendingA; });
  expect(byId('intake-split').props.disabled).toBe(false);
  await act(async () => { byId('intake-split').props.onClick(); });
  expect(calls.map((c) => c.text)).toEqual(['A', 'B']);
  expect(calls[1]!.ref).not.toBe(calls[0]!.ref);
});
