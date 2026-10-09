import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { _resetSessionsServiceSingletonForTest, getSessionsService } from '@/lib/sessions-service';
import { ChatCurrentProject } from './ChatCurrentProject';
import { PROJECTS_CHANGED, readPendingProjects, writePendingProjects } from './ChatProjectSwitcher';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let tree: ReactTestRenderer | undefined;

afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  _resetSessionsServiceSingletonForTest();
  if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
  else delete (globalThis as { window?: Window }).window;
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

async function mount(initial: string | null, exists = true, compact = false, metadataFails = false, deferMetadata = false, deferAssign = false) {
  const saved = new Map<string, string>();
  let storageBlocked = false;
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => {
    if (storageBlocked) throw Error('storage unavailable');
    saved.set(key, value);
  } };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { localStorage: storage }) });
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  let projectId = initial;
  let onDisk = exists;
  let failAssign = false;
  let failMeta = metadataFails;
  let failProjects = false;
  let resolveMetadata: (() => void) | undefined;
  let resolveAssign: (() => void) | undefined;
  let projects = [{ id: 'p', name: '일', createdAt: '' }, { id: 'q', name: '개인', createdAt: '' }];
  const client = { fetchJson: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path === '/v1/projects/folders') return { path: '/srv/work', parent: '/srv', folders: [] };
    if (path === '/v1/projects') {
      if (init?.method === 'POST') return { project: { id: 'new', name: '새 프로젝트', createdAt: '' } };
      if (failProjects) throw Error('projects unavailable');
      return { projects };
    }
    if (init?.method === 'PATCH') {
      if (deferAssign) await new Promise<void>((resolve) => { resolveAssign = resolve; });
      if (failAssign) throw Error('unavailable');
      projectId = (JSON.parse(init.body as string) as { projectId: string | null }).projectId;
      return { ok: true };
    }
    if (path.endsWith('?ifExists=1')) {
      if (deferMetadata) await new Promise<void>((resolve) => { resolveMetadata = resolve; });
      if (failMeta) throw Error('metadata unavailable');
      return onDisk ? { meta: { projectId } } : { exists: false };
    }
    return { sessions: onDisk ? [{ id: 'current', title: '', preview: '', updatedAt: '', messageCount: 1, source: 'pwa', active: true, createdAt: '' }] : [] };
  }, sessionStoreEventsUrl: () => '' };
  const daemon = { client: client as never, sessionId: 'current', setSessionId: () => {}, setConfig: () => {}, config: { baseUrl: '', token: '', provider: '' } };
  await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatCurrentProject compact={compact} /></DaemonContext.Provider>); });
  const select = () => tree!.root.findByProps({ 'aria-label': '현재 대화 프로젝트' });
  return { calls, select, saved, fail: () => { failAssign = true; },
    finishMetadata: async () => { await act(async () => { resolveMetadata?.(); }); },
    finishAssign: async () => { await act(async () => { resolveAssign?.(); }); },
    failProjectList: () => { failProjects = true; }, recoverProjectList: () => { failProjects = false; },
    recoverMetadata: () => { failMeta = false; },
    addProject: (project: { id: string; name: string; createdAt: string }) => { projects = [...projects, project]; },
    save: () => { onDisk = true; }, blockStorage: () => { storageBlocked = true; }, getProject: () => projectId, client };
}

test('header does not call an unresolved project “none” while loading, then shows the saved project', async () => {
  const { select, finishMetadata } = await mount('p', true, false, false, true);
  expect(select().props.value).toBe('loading');
  expect(select().props.title).toBe('프로젝트 확인 중…');
  expect(select().props.disabled).toBe(true);
  expect(select().findAllByType('option').find((option) => option.props.value === 'loading')?.props.children).toBe('프로젝트 확인 중…');
  await finishMetadata();
  expect(select().props.value).toBe('p');
  expect(select().props.disabled).toBe(false);
});

test('project list failure disables changes but retry restores selection for the same conversation', async () => {
  const { select, calls, failProjectList, recoverProjectList } = await mount('p');
  failProjectList();
  await act(async () => { window.dispatchEvent(new Event(PROJECTS_CHANGED)); });
  expect(select().props.disabled).toBe(true);
  expect(tree!.root.findByProps({ role: 'alert' }).props.children).toBe('프로젝트 목록을 불러오지 못했습니다');
  await act(async () => select().props.onChange({ target: { value: 'q' } }));
  expect(calls.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(0);
  recoverProjectList();
  await act(async () => tree!.root.findByProps({ 'aria-label': '프로젝트 다시 확인' }).props.onClick());
  expect(select().props.disabled).toBe(false);
  expect(select().props.value).toBe('p');
  await act(async () => select().props.onChange({ target: { value: 'q' } }));
  expect(select().props.value).toBe('q');
});

test('current chat header shows actual session project, switches by PATCH, supports removal and preserves selection on failure', async () => {
  const { calls, select, getProject, fail } = await mount('p');
  expect(select().props.value).toBe('p');
  expect(select().props.title).toBe('현재 프로젝트: 일');
  expect(select().findAllByType('option').map((o) => o.props.children)).toContain('일');
  expect(calls.some(({ path }) => path === '/v1/sessions/store/current?ifExists=1')).toBe(true);
  await act(async () => select().props.onChange({ target: { value: 'q' } }));
  expect(select().props.value).toBe('q');
  expect(select().props.title).toBe('현재 프로젝트: 개인');
  expect(getProject()).toBe('q');
  expect(calls.at(-2)?.init?.body).toBe('{"projectId":"q"}');
  await act(async () => select().props.onChange({ target: { value: '' } }));
  expect(select().props.value).toBe('');
  expect(select().props.title).toBe('현재 프로젝트: 프로젝트 없음');
  expect(getProject()).toBeNull();
  expect(calls.findLast(({ init }) => init?.method === 'PATCH')?.init?.body).toBe('{"projectId":null}');
  fail();
  await act(async () => select().props.onChange({ target: { value: 'p' } }));
  expect(select().props.value).toBe('');
  expect(tree!.root.findByProps({ role: 'alert' }).props.children).toBe('프로젝트를 바꾸지 못했습니다');
});

test('a new unsaved chat keeps its pending project, and a created project is selected for it', async () => {
  const { select, calls } = await mount(null, false);
  await act(async () => select().props.onChange({ target: { value: 'p' } }));
  expect(select().props.value).toBe('p');
  expect(readPendingProjects()).toEqual({ current: 'p' });
  expect(calls.some(({ init }) => init?.method === 'PATCH')).toBe(false);
  await act(async () => tree!.root.findByProps({ 'aria-label': '프로젝트 만들기' }).props.onClick());
  await act(async () => tree!.root.findByProps({ 'aria-label': '새 프로젝트 이름' }).props.onChange({ target: { value: ' 새 프로젝트 ' } }));
  await act(async () => tree!.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(select().props.value).toBe('new');
  expect(readPendingProjects()).toEqual({ current: 'new' });
  expect(calls.find(({ path, init }) => path === '/v1/projects' && init?.method === 'POST')?.init?.body).toBe('{"name":"새 프로젝트"}');
  await act(async () => select().props.onChange({ target: { value: '' } }));
  expect(readPendingProjects()).toEqual({});
});

test('header creation browses remote folders and saves the chosen primary folder', async () => {
  const { calls } = await mount(null, false);
  await act(async () => tree!.root.findByProps({ 'aria-label': '프로젝트 만들기' }).props.onClick());
  await act(async () => tree!.root.findByProps({ 'aria-label': '새 프로젝트 이름' }).props.onChange({ target: { value: '새 일' } }));
  await act(async () => tree!.root.findByProps({ 'aria-label': '원격 폴더 고르기' }).props.onClick());
  await act(async () => tree!.root.findAllByType('button').find(button => button.children.includes('이 폴더 선택'))!.props.onClick());
  await act(async () => tree!.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(calls.some(call => call.path === '/v1/projects/folders')).toBe(true);
  expect(calls.find(call => call.init?.method === 'POST')?.init?.body).toBe('{"name":"새 일","primaryFolder":"/srv/work"}');
});

test('an unsaved chat cannot display a project when its pending assignment cannot be stored', async () => {
  const { select, calls, blockStorage, save, client, getProject } = await mount(null, false);
  blockStorage();
  await act(async () => select().props.onChange({ target: { value: 'q' } }));
  expect(select().props.value).toBe('');
  expect(tree!.root.findByProps({ role: 'alert' }).props.children).toBe('프로젝트를 바꾸지 못했습니다');
  expect(readPendingProjects()).toEqual({});
  save();
  await act(async () => { await getSessionsService(client as never).forceRefresh(); });
  expect(getProject()).toBeNull();
  expect(calls.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(0);
  expect(select().props.value).toBe('');
});

test('a saved conversation reflects its successful PATCH even when pending cleanup storage is blocked', async () => {
  const { select, blockStorage, getProject, calls } = await mount('p');
  await act(async () => { writePendingProjects({ current: 'p' }); });
  blockStorage();
  await act(async () => select().props.onChange({ target: { value: 'q' } }));
  expect(getProject()).toBe('q');
  expect(select().props.value).toBe('q');
  expect(calls.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(1);
});

test('compact header exposes selection and first-project creation in its selector', async () => {
  const { select } = await mount(null, false, true);
  expect(select().props.className).toContain('max-w-[24vw]');
  expect(select().props.title).toBe('현재 프로젝트: 프로젝트 없음');
  expect(tree!.root.findByType('label').props.className).toBe('sr-only');
  expect(select().findAllByType('option').map((o) => o.props.value)).toContain('create');
  await act(async () => select().props.onChange({ target: { value: 'create' } }));
  expect(tree!.root.findAllByType('form')).toHaveLength(1);
  expect(select().props.value).toBe('');
});

test('a pending header project is assigned exactly once when the new conversation is saved', async () => {
  const { select, calls, save, client, getProject } = await mount(null, false);
  await act(async () => select().props.onChange({ target: { value: 'q' } }));
  expect(calls.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(0);
  save();
  await act(async () => { await getSessionsService(client as never).forceRefresh(); });
  expect(calls.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(1);
  expect(getProject()).toBe('q');
  expect(readPendingProjects()).toEqual({});
  expect(select().props.value).toBe('q');
  await act(async () => { await getSessionsService(client as never).forceRefresh(); });
  expect(calls.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(1);
});

test('a failed metadata lookup prevents selection until a successful retry establishes persistence', async () => {
  const { select, calls, recoverMetadata, getProject } = await mount('p', true, false, true);
  expect(select().props.disabled).toBe(true);
  await act(async () => select().props.onChange({ target: { value: 'q' } }));
  expect(calls.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(0);
  recoverMetadata();
  await act(async () => tree!.root.findByProps({ 'aria-label': '프로젝트 다시 확인' }).props.onClick());
  expect(select().props.disabled).toBe(false);
  await act(async () => select().props.onChange({ target: { value: 'q' } }));
  expect(getProject()).toBe('q');
  expect(calls.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(1);
});

test('a sidebar project creation refreshes header options and the current project name', async () => {
  const { select, addProject } = await mount('p');
  addProject({ id: 'from-sidebar', name: '사이드바 신규', createdAt: '' });
  await act(async () => { window.dispatchEvent(new Event(PROJECTS_CHANGED)); });
  expect(select().findAllByType('option').map((option) => option.props.children)).toContain('사이드바 신규');
  await act(async () => select().props.onChange({ target: { value: 'from-sidebar' } }));
  expect(select().props.value).toBe('from-sidebar');
  expect(select().findAllByType('option').find((option) => option.props.value === 'from-sidebar')?.props.children).toBe('사이드바 신규');
});

test('failed pending assignment after saving never labels the unapplied project as current', async () => {
  const { select, save, fail, client, getProject, calls } = await mount(null, false);
  await act(async () => select().props.onChange({ target: { value: 'q' } }));
  save();
  fail();
  await act(async () => { await getSessionsService(client as never).forceRefresh(); });
  expect(calls.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(1);
  expect(getProject()).toBeNull();
  expect(select().props.value).toBe('');
  expect(tree!.root.findByProps({ role: 'alert' }).props.children).toBe('프로젝트를 바꾸지 못했습니다');
});

test('a saved conversation shows stored membership until a pending PATCH succeeds', async () => {
  const { select, calls, getProject, finishAssign } = await mount('p', true, false, false, false, true);
  await act(async () => { writePendingProjects({ current: 'q' }); });
  expect(calls.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(1);
  expect(getProject()).toBe('p');
  expect(select().props.value).toBe('p');
  expect(select().props.title).toBe('현재 프로젝트: 일');
  await finishAssign();
  expect(getProject()).toBe('q');
  expect(select().props.value).toBe('q');
  expect(select().props.title).toBe('현재 프로젝트: 개인');
});

test('a saved conversation shows stored membership until a pending PATCH fails', async () => {
  const { select, calls, getProject, finishAssign, fail } = await mount('p', true, false, false, false, true);
  await act(async () => { writePendingProjects({ current: 'q' }); });
  expect(calls.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(1);
  expect(getProject()).toBe('p');
  expect(select().props.value).toBe('p');
  expect(select().props.title).toBe('현재 프로젝트: 일');
  fail();
  await finishAssign();
  expect(getProject()).toBe('p');
  expect(select().props.value).toBe('p');
  expect(select().props.title).toBe('현재 프로젝트: 일');
  expect(tree!.root.findByProps({ role: 'alert' }).props.children).toBe('프로젝트를 바꾸지 못했습니다');
});

test('a failed pending PATCH restores the stored project rather than the pending choice', async () => {
  const { select, fail, calls, getProject } = await mount('p');
  fail();
  await act(async () => { writePendingProjects({ current: 'q' }); });
  expect(calls.filter(({ init }) => init?.method === 'PATCH')).toHaveLength(1);
  expect(getProject()).toBe('p');
  expect(select().props.value).toBe('p');
  expect(readPendingProjects()).toEqual({});
  expect(tree!.root.findByProps({ role: 'alert' }).props.children).toBe('프로젝트를 바꾸지 못했습니다');
});

test('pending sidebar project is visible on the current unsaved chat', async () => {
  const { select } = await mount(null, false);
  await act(async () => { writePendingProjects({ current: 'q' }); });
  expect(select().props.value).toBe('q');
});
