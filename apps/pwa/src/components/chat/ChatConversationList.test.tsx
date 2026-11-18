import { afterEach, expect, test } from 'bun:test';
import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { _resetSessionsServiceSingletonForTest, getSessionsService } from '@/lib/sessions-service';
import { ChatConversationList, conversationTime, conversationTitle } from './ChatConversationList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  _resetSessionsServiceSingletonForTest();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

const now = Date.now();
const cards = [
  { id: 'old', title: '프로젝트 이야기', preview: '다른 미리보기', updatedAt: new Date(now - 180_000).toISOString(), messageCount: 2, source: 'cli', active: false, createdAt: '' },
  { id: 'current', title: '', preview: '첫 줄\n둘째 줄', updatedAt: new Date(now - 60_000).toISOString(), messageCount: 3, source: 'cli', active: true, createdAt: '' },
];

async function mount(list: typeof cards = cards, titleRequestFails = false) {
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    setItem: (key: string, value: string) => saved.set(key, value),
    getItem: (key: string) => saved.get(key) ?? null,
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { localStorage, location: { search: '' } }) });
  let requests = 0;
  const client = { fetchJson: async () => {
    if (titleRequestFails && ++requests > 1) throw Error('title unavailable');
    return { sessions: list };
  }, sessionStoreEventsUrl: () => '' };
  const selected: string[] = [];
  const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' }, sessionId: 'current', setSessionId: (id: string) => selected.push(id), setConfig: () => {} };
  await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatConversationList /></DaemonContext.Provider>); });
  await act(async () => { await getSessionsService(client as never).forceRefresh(); });
  const buttons = () => tree!.root.findAllByType('button');
  return { buttons, selected, saved, requests: () => requests };
}

test('recent conversations use title, preview fallback, relative time and current highlight', async () => {
  const { buttons } = await mount();
  const items = buttons().filter((b) => b.props['aria-current'] !== undefined || b.findAllByType('span').length > 0);
  expect(items.map((b) => b.findAllByType('span')[0]?.children.join(''))).toEqual(['첫 줄', '프로젝트 이야기']);
  expect(items[0]!.props['aria-current']).toBe('page');
  expect(items[1]!.props['aria-current']).toBeUndefined();
  expect(items[0]!.findAllByType('span')[1]!.children.join('')).toContain('분 전');
  expect(conversationTime(new Date(now - 180_000).toISOString(), now)).toBe('3분 전');
  expect(conversationTitle({ id: 'x', msgCount: 0, lastTurnAt: '' })).toBe('대화');
  expect(JSON.stringify(tree!.toJSON())).not.toContain('세션');
});

test('unknown title remains neutral when the title request fails and no preview exists', async () => {
  const untitled = [{ ...cards[0]!, title: '저장된 제목', preview: '' }];
  const { buttons, requests } = await mount(untitled, true);
  expect(requests()).toBeGreaterThan(1);
  const item = buttons().find((b) => b.findAllByType('span').length > 0)!;
  expect(item.findAllByType('span')[0]!.children.join('')).toBe('대화');
  expect(JSON.stringify(tree!.toJSON())).not.toContain('제목 없는 대화');
});

test('search filters both title and preview; choosing an item switches to its id', async () => {
  const { buttons, selected } = await mount();
  const input = tree!.root.findByType('input');
  await act(async () => input.props.onChange({ target: { value: '프로젝트' } }));
  expect(tree!.root.findAllByProps({ 'aria-current': 'page' })).toHaveLength(0);
  await act(async () => buttons().find((b) => b.findAllByType('span')[0]?.children.join('') === '프로젝트 이야기')!.props.onClick());
  expect(selected).toEqual(['old']);
  await act(async () => input.props.onChange({ target: { value: '둘째 줄' } }));
  expect(JSON.stringify(tree!.toJSON())).toContain('첫 줄');
  expect(JSON.stringify(tree!.toJSON())).not.toContain('프로젝트 이야기');
});

test('one «새 대화» (no duplicate in the empty list) switches to a fresh id; no project controls', async () => {
  const { buttons, selected, saved } = await mount([]);
  expect(JSON.stringify(tree!.toJSON())).toContain('아직 대화가 없습니다');
  expect(buttons()).toHaveLength(1);
  expect(JSON.stringify(tree!.toJSON())).not.toContain('프로젝트');
  await act(async () => buttons()[0]!.props.onClick());
  expect(selected).toHaveLength(1);
  expect(selected[0]).not.toBe('current');
  expect(saved.get('elanous.daemon.sessionId')).toBe(selected[0]);
});

test('a conversation menu shows its full id with a copy button (정보)', async () => {
  await mount();
  const menus = tree!.root.findAllByProps({ 'aria-label': '대화 관리' });
  await act(async () => menus[0]!.props.onClick());
  const menu = tree!.root.findByProps({ role: 'menu' });
  expect(JSON.stringify(menu.findAllByType('span').map((span) => span.children.join('')))).toContain('current');
  expect(menu.findAllByProps({ 'aria-label': '대화 ID 복사' })).toHaveLength(1);
});

test('삭제 asks first, deletes through the session store, and an open conversation continues in a new one', async () => {
  const calls: Array<{ path: string; method?: string }> = [];
  let fail = true;
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    setItem: (key: string, value: string) => saved.set(key, value), getItem: (key: string) => saved.get(key) ?? null,
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { localStorage, location: { search: '' } }) });
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() });
  try {
    const client = { fetchJson: async (path: string, init?: RequestInit) => {
      calls.push({ path, method: init?.method });
      if (init?.method === 'DELETE') { if (fail) throw Error('locked'); return { ok: true, deleted: true }; }
      return { sessions: cards };
    }, sessionStoreEventsUrl: () => '' };
    const selected: string[] = [];
    const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' }, sessionId: 'current', setSessionId: (id: string) => selected.push(id), setConfig: () => {} };
    await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatConversationList /></DaemonContext.Provider>); });
    await act(async () => { await getSessionsService(client as never).forceRefresh(); });
    await act(async () => tree!.root.findAllByProps({ 'aria-label': '대화 관리' })[0]!.props.onClick());
    await act(async () => tree!.root.findByProps({ role: 'menu' }).findAllByType('button').find((b) => b.children.some((child) => typeof child === 'string' && child.includes('삭제')))!.props.onClick());
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    const confirm = () => tree!.root.findByProps({ role: 'alertdialog' }).findAllByType('button').at(-1)!;
    // A failed delete keeps the dialog and says why; nothing switches.
    await act(async () => confirm().props.onClick());
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual(['/v1/sessions/store/current']);
    // The reason is inside the dialog (a line under the list would sit behind it).
    const reason = tree!.root.findByProps({ role: 'alertdialog' }).findByProps({ 'data-elanous-delete-error': true });
    expect(reason.children.join('')).toBe('지우지 못했습니다: locked');
    expect(selected).toEqual([]);
    fail = false;
    await act(async () => confirm().props.onClick());
    expect(tree!.root.findAllByProps({ role: 'alertdialog' })).toHaveLength(0);
    expect(selected).toHaveLength(1);
    expect(selected[0]).not.toBe('current');
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete (globalThis as { document?: unknown }).document;
  }
});

test('a delete that answers after the user switched conversations keeps the switch (checked at answer time)', async () => {
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    setItem: (key: string, value: string) => saved.set(key, value), getItem: (key: string) => saved.get(key) ?? null,
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { localStorage, location: { search: '' } }) });
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() });
  try {
    let answer: (() => void) | undefined;
    const client = { fetchJson: async (_path: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return await new Promise((resolve) => { answer = () => resolve({ ok: true, deleted: true }); });
      return { sessions: cards };
    }, sessionStoreEventsUrl: () => '' };
    const switched: string[] = [];
    let setActive: ((id: string) => void) | undefined;
    function Host() {
      const [sessionId, setSessionId] = useState('current');
      setActive = setSessionId;
      const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' }, sessionId,
        setSessionId: (id: string) => { switched.push(id); setSessionId(id); }, setConfig: () => {} };
      return <DaemonContext.Provider value={daemon}><ChatConversationList /></DaemonContext.Provider>;
    }
    await act(async () => { tree = create(<Host />); });
    await act(async () => { await getSessionsService(client as never).forceRefresh(); });
    // Delete the open conversation «current» …
    await act(async () => tree!.root.findAllByProps({ 'aria-label': '대화 관리' })[0]!.props.onClick());
    await act(async () => tree!.root.findByProps({ role: 'menu' }).findAllByType('button').find((b) => b.children.some((child) => typeof child === 'string' && child.includes('삭제')))!.props.onClick());
    await act(async () => tree!.root.findByProps({ role: 'alertdialog' }).findAllByType('button').at(-1)!.props.onClick());
    // … switch to «old» while the delete is in flight, then the answer arrives.
    await act(async () => { setActive!('old'); });
    await act(async () => { answer!(); });
    expect(switched).toEqual([]);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete (globalThis as { document?: unknown }).document;
  }
});

// #38183 REVIEW-1 (JUD 23:12 HOLD): the two follow-up rules, asserted.
async function mountWithDocument(deleteAnswer: () => Promise<unknown>) {
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    setItem: (key: string, value: string) => saved.set(key, value), getItem: (key: string) => saved.get(key) ?? null,
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { localStorage, location: { search: '' } }) });
  const client = { fetchJson: async (_path: string, init?: RequestInit) => (init?.method === 'DELETE' ? deleteAnswer() : { sessions: cards }),
    sessionStoreEventsUrl: () => '' };
  const selected: string[] = [];
  const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' }, sessionId: 'current', setSessionId: (id: string) => selected.push(id), setConfig: () => {} };
  await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatConversationList /></DaemonContext.Provider>); });
  await act(async () => { await getSessionsService(client as never).forceRefresh(); });
  return { selected };
}

function withDocument<T>(run: (doc: EventTarget) => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const doc = new EventTarget();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  return run(doc).finally(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete (globalThis as { document?: unknown }).document;
  });
}

const openMenu = () => act(async () => tree!.root.findAllByProps({ 'aria-label': '대화 관리' })[0]!.props.onClick());
const menuCount = () => tree!.root.findAllByProps({ role: 'menu' }).length;
const keydown = (key: string) => Object.assign(new Event('keydown'), { key });

test('a delete that finds the conversation already gone says so (not an error, not silent) and closes the dialog', () => withDocument(async () => {
  const { selected } = await mountWithDocument(async () => ({ ok: true, id: 'current', deleted: false }));
  await openMenu();
  await act(async () => tree!.root.findByProps({ role: 'menu' }).findAllByType('button').find((b) => b.children.some((child) => typeof child === 'string' && child.includes('삭제')))!.props.onClick());
  await act(async () => tree!.root.findByProps({ role: 'alertdialog' }).findAllByType('button').at(-1)!.props.onClick());
  expect(tree!.root.findAllByProps({ role: 'alertdialog' })).toHaveLength(0);
  expect(tree!.root.findAllByProps({ 'data-elanous-delete-error': true })).toHaveLength(0);
  expect(tree!.root.findByProps({ 'data-elanous-delete-notice': true }).children.join('')).toBe('이미 지워진 대화예요 · 목록을 새로 고쳤어요');
  // It was the open conversation: it is gone either way, so a new one takes its place.
  expect(selected).toHaveLength(1);
}));

test('a delete that removed the conversation shows no «already gone» notice', () => withDocument(async () => {
  await mountWithDocument(async () => ({ ok: true, id: 'current', deleted: true }));
  await openMenu();
  await act(async () => tree!.root.findByProps({ role: 'menu' }).findAllByType('button').find((b) => b.children.some((child) => typeof child === 'string' && child.includes('삭제')))!.props.onClick());
  await act(async () => tree!.root.findByProps({ role: 'alertdialog' }).findAllByType('button').at(-1)!.props.onClick());
  expect(tree!.root.findAllByProps({ 'data-elanous-delete-notice': true })).toHaveLength(0);
}));

test('the conversation menu closes on Esc and on a press outside it; a press on the menu keeps it', () => withDocument(async (doc) => {
  await mountWithDocument(async () => ({ ok: true, deleted: true }));
  await openMenu();
  expect(menuCount()).toBe(1);
  await act(async () => { doc.dispatchEvent(keydown('Enter')); });
  expect(menuCount()).toBe(1);
  await act(async () => { doc.dispatchEvent(keydown('Escape')); });
  expect(menuCount()).toBe(0);
  await openMenu();
  // A press whose target is inside the menu (or its toggle) does not close it.
  const inside = Object.assign(new Event('pointerdown'), {});
  Object.defineProperty(inside, 'target', { value: { closest: (selector: string) => (selector.includes('data-elanous-conversation-menu') ? {} : null) } });
  await act(async () => { doc.dispatchEvent(inside); });
  expect(menuCount()).toBe(1);
  await act(async () => { doc.dispatchEvent(new Event('pointerdown')); });
  expect(menuCount()).toBe(0);
}));

test('the delete dialog cancels on Esc and on the backdrop, not on a press inside it', () => withDocument(async (doc) => {
  await mountWithDocument(async () => ({ ok: true, deleted: true }));
  const openDialog = async () => {
    await openMenu();
    await act(async () => tree!.root.findByProps({ role: 'menu' }).findAllByType('button').find((b) => b.children.some((child) => typeof child === 'string' && child.includes('삭제')))!.props.onClick());
  };
  const dialogs = () => tree!.root.findAllByProps({ role: 'alertdialog' }).length;
  await openDialog();
  expect(dialogs()).toBe(1);
  await act(async () => { doc.dispatchEvent(keydown('Escape')); });
  expect(dialogs()).toBe(0);
  await openDialog();
  const backdrop = tree!.root.findByProps({ role: 'alertdialog' });
  const panel = backdrop.findByProps({ 'data-elanous-delete-panel': true });
  let stopped = false;
  await act(async () => panel.props.onClick({ stopPropagation: () => { stopped = true; } }));
  expect(stopped).toBe(true);
  expect(dialogs()).toBe(1);
  await act(async () => backdrop.props.onClick());
  expect(dialogs()).toBe(0);
}));

// #38333 REVIEW-1 ①②: a key pressed in the page reaches document twice — capture first, then bubble — and
// stopPropagation in capture keeps it from the bubble listeners. A bare EventTarget has no such path (the key is AT the
// target, so every listener runs), which hid the regression. This document models exactly that path, nothing more.
// (jsdom would too, but loading it shifted the shared debug-log flush timer into ChatLayout's PCH-12 fetch capture.)
function pageDocument() {
  type Entry = { type: string; fn: (event: Event) => void; capture: boolean };
  const entries: Entry[] = [];
  const doc = {
    addEventListener(type: string, fn: (event: Event) => void, options?: boolean | AddEventListenerOptions) {
      entries.push({ type, fn, capture: options === true || (typeof options === 'object' && options.capture === true) });
    },
    removeEventListener(type: string, fn: (event: Event) => void, options?: boolean | EventListenerOptions) {
      const capture = options === true || (typeof options === 'object' && options.capture === true);
      const at = entries.findIndex((entry) => entry.type === type && entry.fn === fn && entry.capture === capture);
      if (at >= 0) entries.splice(at, 1);
    },
    /** A key pressed on an element inside the page: document capture listeners, then (unless stopped) bubble ones. */
    pressInPage(key: string) {
      doc.pressEvent(Object.assign(new Event('keydown'), { key }));
    },
    pressEvent(event: Event) {
      let stopped = false;
      Object.assign(event, { stopPropagation: () => { stopped = true; } });
      for (const phase of [true, false]) {
        for (const entry of entries.filter((e) => e.type === 'keydown' && e.capture === phase)) entry.fn(event);
        if (stopped) return;
      }
    },
  };
  return doc;
}

function withPageDocument<T>(run: (doc: ReturnType<typeof pageDocument>) => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const doc = pageDocument();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  return run(doc).finally(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete (globalThis as { document?: unknown }).document;
  });
}

test('menu → 삭제 → one Esc pressed in the page closes the confirm dialog, and not the drawer beneath', () => withPageDocument(async (doc) => {
  // Like ChatPanel's phone drawer: subscribed on document (bubble) before anything opens.
  let drawerClosed = 0;
  doc.addEventListener('keydown', (event) => { if ((event as KeyboardEvent).key === 'Escape') drawerClosed += 1; });
  await mountWithDocument(async () => ({ ok: true, deleted: true }));
  await openMenu();
  await act(async () => tree!.root.findByProps({ role: 'menu' }).findAllByType('button').find((b) => b.children.some((child) => typeof child === 'string' && child.includes('삭제')))!.props.onClick());
  expect(tree!.root.findAllByProps({ role: 'alertdialog' })).toHaveLength(1);
  await act(async () => { doc.pressInPage('Escape'); });
  expect(tree!.root.findAllByProps({ role: 'alertdialog' })).toHaveLength(0);
  expect(menuCount()).toBe(0);
  expect(drawerClosed).toBe(0);
  await act(async () => tree!.unmount());
  tree = undefined;
}));

test('an open menu takes the one Esc; the drawer beneath gets the next one', () => withPageDocument(async (doc) => {
  let drawerClosed = 0;
  doc.addEventListener('keydown', (event) => { if ((event as KeyboardEvent).key === 'Escape') drawerClosed += 1; });
  await mountWithDocument(async () => ({ ok: true, deleted: true }));
  await openMenu();
  await act(async () => { doc.pressInPage('Escape'); });
  expect(menuCount()).toBe(0);
  expect(drawerClosed).toBe(0);
  await act(async () => { doc.pressInPage('Escape'); });
  expect(drawerClosed).toBe(1);
  await act(async () => tree!.unmount());
  tree = undefined;
}));

// #38333 re-review follow-ups (0.3.29).
test('an Esc that ends an IME composition closes neither the menu nor the confirm dialog', () => withPageDocument(async (doc) => {
  await mountWithDocument(async () => ({ ok: true, deleted: true }));
  await openMenu();
  const composingEsc = () => Object.assign(new Event('keydown'), { key: 'Escape', isComposing: true });
  // The same capture → bubble path as pressInPage, with an event that is still composing.
  const send = (event: Event) => doc.pressEvent(event);
  await act(async () => { send(composingEsc()); });
  expect(menuCount()).toBe(1);
  await act(async () => tree!.root.findByProps({ role: 'menu' }).findAllByType('button').find((b) => b.children.some((child) => typeof child === 'string' && child.includes('삭제')))!.props.onClick());
  await act(async () => { send(composingEsc()); });
  expect(tree!.root.findAllByProps({ role: 'alertdialog' })).toHaveLength(1);
  await act(async () => { doc.pressInPage('Escape'); });
  expect(tree!.root.findAllByProps({ role: 'alertdialog' })).toHaveLength(0);
  await act(async () => tree!.unmount());
  tree = undefined;
}));

test('the «already gone» notice clears after 5 s, a failed next delete clears it at once, and unmount stops the timer', () => withDocument(async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => { const id = next++; timers.set(id, { fn, ms: ms ?? 0 }); return id; }) as never;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as never;
  const fire = (ms: number) => { for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); t.fn(); } };
  try {
    let answer: () => Promise<unknown> = async () => ({ ok: true, deleted: false });
    await mountWithDocument(() => answer());
    const deleteFirst = async () => {
      await openMenu();
      await act(async () => tree!.root.findByProps({ role: 'menu' }).findAllByType('button').find((b) => b.children.some((child) => typeof child === 'string' && child.includes('삭제')))!.props.onClick());
      await act(async () => tree!.root.findByProps({ role: 'alertdialog' }).findAllByType('button').at(-1)!.props.onClick());
    };
    const notices = () => tree!.root.findAllByProps({ 'data-elanous-delete-notice': true }).length;
    await deleteFirst();
    expect(notices()).toBe(1);
    // 출처: ChatConversationList notice timer (5000 ms).
    await act(async () => { fire(5000); });
    expect(notices()).toBe(0);
    // Again «already gone», then a failing delete: the notice goes as the attempt starts; only the error shows.
    await deleteFirst();
    expect(notices()).toBe(1);
    answer = async () => { throw Error('locked'); };
    await deleteFirst();
    expect(notices()).toBe(0);
    expect(tree!.root.findAllByProps({ 'data-elanous-delete-error': true })).toHaveLength(1);
    // Unmount while a notice timer is pending removes it.
    await act(async () => tree!.root.findByProps({ role: 'alertdialog' }).findAllByType('button')[0]!.props.onClick());
    answer = async () => ({ ok: true, deleted: false });
    await deleteFirst();
    expect([...timers.values()].filter((t) => t.ms === 5000)).toHaveLength(1);
    await act(async () => tree!.unmount());
    tree = undefined;
    expect([...timers.values()].filter((t) => t.ms === 5000)).toHaveLength(0);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}));
