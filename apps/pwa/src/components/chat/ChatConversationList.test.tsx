import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { _resetSessionsServiceSingletonForTest, getSessionsService } from '@/lib/sessions-service';
import { ChatConversationList, conversationTime, conversationTitle } from './ChatConversationList';
import { PROJECT_SELECTION_KEY, readPendingProjects, writePendingProjects } from './ChatProjectSwitcher';
import { ChatCurrentProject } from './ChatCurrentProject';

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

test('project selection filters conversations, persists on device, and assigns a new conversation exactly once after first save', async () => {
  const saved = new Map<string, string>();
  const all = [...cards, { ...cards[0]!, id: 'inbox', title: '받은 항목', projectId: undefined }];
  const assigned = all.map((card) => card.id === 'old' ? { ...card, projectId: 'p' } : card);
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  let current: Array<(typeof cards)[number] & { projectId?: string }> = assigned;
  let projects = [{ id: 'p', name: '일', createdAt: '' }];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    setItem: (key: string, value: string) => saved.set(key, value),
    getItem: (key: string) => saved.get(key) ?? null,
  } });
  saved.set(PROJECT_SELECTION_KEY, 'p');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { localStorage, location: { search: '' } }) });
  const client = { fetchJson: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path === '/v1/projects') {
      if (init?.method === 'POST') {
        const project = { id: 'q', name: '새 일', createdAt: '' };
        projects = [...projects, project];
        return { project };
      }
      return { projects };
    }
    if (init?.method === 'PATCH') return { ok: true };
    if (path.includes('?ifExists=1')) return { meta: current.find((card) => path.includes(card.id)) };
    return { sessions: path.includes('?projectId=p') ? current.filter((c) => c.projectId === 'p') : current };
  }, sessionStoreEventsUrl: () => '' };
  const selected: string[] = [];
  const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' }, sessionId: 'current', setSessionId: (id: string) => selected.push(id), setConfig: () => {} };
  await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatConversationList /></DaemonContext.Provider>); });
  await act(async () => { await getSessionsService(client as never).forceRefresh(); });
  const text = () => JSON.stringify(tree!.toJSON());
  expect(text()).toContain('프로젝트 이야기');
  expect(text()).not.toContain('받은 항목');
  expect(calls.some((c) => c.path === '/v1/sessions/store?projectId=p')).toBe(true);
  const select = tree!.root.findByType('select');
  await act(async () => select.props.onChange({ target: { value: 'none' } }));
  expect(saved.get(PROJECT_SELECTION_KEY)).toBe('none');
  expect(text()).toContain('받은 항목');
  expect(text()).not.toContain('프로젝트 이야기');
  await act(async () => select.props.onChange({ target: { value: 'all' } }));
  expect(text()).toContain('프로젝트 이야기');
  expect(text()).toContain('받은 항목');
  await act(async () => select.props.onChange({ target: { value: 'create' } }));
  await act(async () => tree!.root.findByProps({ 'aria-label': '프로젝트 이름' }).props.onChange({ target: { value: '새 일' } }));
  await act(async () => tree!.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(saved.get(PROJECT_SELECTION_KEY)).toBe('q');
  await act(async () => tree!.root.findAllByType('button').find((button) => button.children.includes(' 새 대화'))!.props.onClick());
  expect(selected).toHaveLength(1);
  expect(readPendingProjects()[selected[0]!]).toBe('q');
  expect(calls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(0);
  current = [...current, { ...cards[0]!, id: selected[0]!, title: '새 대화' }];
  await act(async () => { await getSessionsService(client as never).forceRefresh(); });
  expect(calls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(1);
  expect(readPendingProjects()[selected[0]!]).toBeUndefined();
  expect(calls.find((c) => c.init?.method === 'PATCH')?.init?.body).toBe('{"projectId":"q"}');
  await act(async () => { await getSessionsService(client as never).forceRefresh(); });
  expect(calls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(1);
  expect(text()).toContain('새 대화');
});

test('sidebar project picker browses remote folders and passes the chosen folder to creation', async () => {
  const saved = new Map<string, string>();
  const storage = { setItem: (key: string, value: string) => saved.set(key, value), getItem: (key: string) => saved.get(key) ?? null };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { localStorage: storage, location: { search: '' } }) });
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = { fetchJson: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path.startsWith('/v1/projects/folders')) return path.includes('path=')
      ? { path: '/srv/work', parent: '/srv', folders: [] }
      : { path: '/srv', parent: '/', folders: [{ name: 'work', path: '/srv/work' }] };
    if (path === '/v1/projects') return init?.method === 'POST'
      ? { project: { id: 'p', name: '새 일', primaryFolder: '/srv/work', createdAt: '' } }
      : { projects: [] };
    return { sessions: cards };
  }, sessionStoreEventsUrl: () => '' };
  const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' }, sessionId: 'current', setSessionId: () => {}, setConfig: () => {} };
  await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatConversationList /></DaemonContext.Provider>); });
  await act(async () => tree!.root.findAllByType('button').find(button => button.children.includes('＋ 프로젝트 만들기'))!.props.onClick());
  await act(async () => tree!.root.findByProps({ 'aria-label': '프로젝트 이름' }).props.onChange({ target: { value: '새 일' } }));
  await act(async () => tree!.root.findByProps({ 'aria-label': '원격 폴더 고르기' }).props.onClick());
  expect(tree!.root.findByProps({ 'aria-label': '원격 폴더 목록' })).toBeDefined();
  expect(calls.some(call => call.path === '/v1/projects/folders')).toBe(true);
  await act(async () => tree!.root.findByProps({ 'aria-label': '원격 폴더 목록' }).findAllByType('button')[1]!.props.onClick());
  await act(async () => tree!.root.findAllByType('button').find(button => button.children.includes('이 폴더 선택'))!.props.onClick());
  await act(async () => tree!.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(calls.filter(call => call.path.startsWith('/v1/projects/folders')).map(call => call.path))
    .toEqual(['/v1/projects/folders', '/v1/projects/folders?path=%2Fsrv%2Fwork']);
  expect(calls.find(call => call.init?.method === 'POST')?.init?.body).toBe('{"name":"새 일","primaryFolder":"/srv/work"}');
  expect(saved.get(PROJECT_SELECTION_KEY)).toBe('p');
});

test('failed pending assignment restores the saved project membership in the sidebar', async () => {
  const saved = new Map<string, string>();
  saved.set(PROJECT_SELECTION_KEY, 'p');
  const storage = { setItem: (key: string, value: string) => saved.set(key, value), getItem: (key: string) => saved.get(key) ?? null };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { localStorage: storage }) });
  let rejectPatch: ((reason: Error) => void) | undefined;
  const calls: string[] = [];
  const old = { ...cards[0]!, projectId: 'p' };
  const client = { fetchJson: async (path: string, init?: RequestInit) => {
    if (path === '/v1/projects') return { projects: [{ id: 'p', name: '일', createdAt: '' }, { id: 'q', name: '개인', createdAt: '' }] };
    if (init?.method === 'PATCH') {
      calls.push(path);
      return await new Promise((_, reject) => { rejectPatch = reject; });
    }
    if (path.includes('?ifExists=1')) return { meta: old };
    return { sessions: [old] };
  }, sessionStoreEventsUrl: () => '' };
  const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' }, sessionId: 'current', setSessionId: () => {}, setConfig: () => {} };
  await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatConversationList /></DaemonContext.Provider>); });
  await act(async () => { await getSessionsService(client as never).forceRefresh(); });
  const text = () => JSON.stringify(tree!.toJSON());
  expect(text()).toContain('프로젝트 이야기');
  await act(async () => { writePendingProjects({ old: 'q' }); });
  expect(calls).toEqual(['/v1/sessions/store/old']);
  expect(readPendingProjects().old).toBe('q');
  await act(async () => { rejectPatch!(new Error('offline')); });
  expect(readPendingProjects().old).toBeUndefined();
  expect(text()).toContain('프로젝트 이야기');
  const select = tree!.root.findByProps({ 'aria-label': '프로젝트 바꾸기' });
  await act(async () => select.props.onChange({ target: { value: 'q' } }));
  expect(text()).not.toContain('프로젝트 이야기');
  await act(async () => select.props.onChange({ target: { value: 'p' } }));
  expect(text()).toContain('프로젝트 이야기');
  expect(calls).toHaveLength(1);
});

test('creating a project in the sidebar refreshes a mounted chat header and opening a conversation refreshes again', async () => {
  const saved = new Map<string, string>();
  const storage = { setItem: (key: string, value: string) => saved.set(key, value), getItem: (key: string) => saved.get(key) ?? null };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { localStorage: storage }) });
  let projects = [{ id: 'p', name: '일', createdAt: '' }];
  let lists = 0;
  const client = { fetchJson: async (path: string, init?: RequestInit) => {
    if (path === '/v1/projects') {
      if (init?.method === 'POST') {
        const project = { id: 'q', name: '새 일', createdAt: '' };
        projects = [...projects, project];
        return { project };
      }
      lists++;
      return { projects };
    }
    if (path.includes('?ifExists=1')) return { meta: { projectId: 'q' } };
    return { sessions: cards };
  }, sessionStoreEventsUrl: () => '' };
  const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' }, sessionId: 'current', setSessionId: () => {}, setConfig: () => {} };
  await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatConversationList /><ChatCurrentProject /></DaemonContext.Provider>); });
  const header = () => tree!.root.findByProps({ 'aria-label': '현재 대화 프로젝트' });
  expect(header().findAllByType('option').map((option) => option.props.children)).not.toContain('새 일');
  await act(async () => tree!.root.findByProps({ 'aria-label': '프로젝트 바꾸기' }).props.onChange({ target: { value: 'create' } }));
  await act(async () => tree!.root.findByProps({ 'aria-label': '프로젝트 이름' }).props.onChange({ target: { value: '새 일' } }));
  await act(async () => tree!.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(header().findAllByType('option').find((option) => option.props.value === 'q')?.props.children).toBe('새 일');
  await act(async () => tree!.root.findByProps({ 'aria-label': '프로젝트 바꾸기' }).props.onChange({ target: { value: 'all' } }));
  await act(async () => { await getSessionsService(client as never).forceRefresh(); });
  const beforeOpen = lists;
  await act(async () => tree!.root.findAllByType('button').find((button) => button.props['aria-current'] === 'page')!.props.onClick());
  expect(lists).toBeGreaterThan(beforeOpen);
  expect(header().findAllByType('option').find((option) => option.props.value === 'q')?.props.children).toBe('새 일');
});

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

test('new conversation switches to a fresh id and empty list offers the same action', async () => {
  const { buttons, selected, saved } = await mount([]);
  expect(JSON.stringify(tree!.toJSON())).toContain('아직 대화가 없습니다');
  await act(async () => buttons().find((b) => b.children.includes('＋ 새 대화'))!.props.onClick());
  expect(selected).toHaveLength(1);
  expect(selected[0]).not.toBe('current');
  expect(saved.get('elanous.daemon.sessionId')).toBe(selected[0]);
  await act(async () => buttons()[0]!.props.onClick());
  expect(selected[1]).not.toBe(selected[0]);
});
