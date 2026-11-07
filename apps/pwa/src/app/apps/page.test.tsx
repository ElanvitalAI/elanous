import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { parseHTML } from 'linkedom';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import type { DaemonClient } from '@/lib/daemon-client';
import AppsPage from './page';

const apps = [{
  slug: 'voice-notes', name: '음성 메모', description: '회의를 기록합니다.',
  simulation: { status: 'passed' as const, receipt: 'receipt-1', href: '/apps/voice-notes/sim' },
  production: { status: 'not-created' as const },
}];

const originals = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, Node: globalThis.Node, Event: globalThis.Event, actEnvironment: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
let root: import('react-dom/client').Root;
let host: HTMLElement;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, Event: window.Event });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.getElementById('root')!;
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  Object.assign(globalThis, originals);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originals.actEnvironment;
});

async function renderClient(fetchJson: (path: string, init?: RequestInit) => Promise<unknown>) {
  const client = { fetchJson } as unknown as DaemonClient;
  const context = { client, config: { baseUrl: '', token: '', provider: '' }, setConfig: () => {}, sessionId: '', setSessionId: () => {} };
  await act(async () => { root.render(createElement(DaemonContext.Provider, { value: context }, createElement(AppsPage))); });
}

async function mount(fetchJson: (path: string, init?: RequestInit) => Promise<unknown>) {
  await renderClient(fetchJson);
}

async function submitCreateForm() {
  await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === '새 앱')!.dispatchEvent(new window.Event('click', { bubbles: true })); });
  const form = host.querySelector('form')!;
  const [name, slug, description] = [...form.querySelectorAll('input, textarea')];
  for (const [field, value] of [[name, '음성 메모'], [slug, 'voice-notes'], [description, '회의 기록']] as const) {
    const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
    nativeSetter?.call(field, value);
    await act(async () => { field.dispatchEvent(new window.Event('input', { bubbles: true })); });
  }
  await act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
}

test('loads one app tile with separate simulation and production environments', async () => {
  const paths: string[] = [];
  await mount(async (path) => { paths.push(path); return { apps }; });
  expect(paths).toEqual(['/v1/apps']);
  expect(host.textContent).toContain('음성 메모');
  expect(host.textContent).toContain('시뮬레이션');
  expect(host.textContent).toContain('통과');
  expect(host.textContent).toContain('receipt-1');
  expect(host.textContent).toContain('정식');
  expect(host.textContent).toContain('영수증 뒤 올리기');
});

test('moving an app to trash calls the lifecycle endpoint and removes its tile', async () => {
  const calls: Array<{ path: string; method?: string }> = [];
  await mount(async (path, init) => {
    calls.push({ path, method: init?.method });
    return path === '/v1/apps' ? { apps } : {};
  });
  const trash = [...host.querySelectorAll('button')].find((button) => button.textContent === '휴지통')!;
  await act(async () => { trash.dispatchEvent(new window.Event('click', { bubbles: true })); });
  expect(calls).toEqual([{ path: '/v1/apps', method: undefined }, { path: '/v1/apps/voice-notes', method: 'DELETE' }]);
  expect(host.textContent).not.toContain('음성 메모');
  expect(host.textContent).toContain('아직 앱이 없습니다');
});

test('shows a recoverable message when the app ledger cannot be read', async () => {
  await mount(async () => { throw new Error('offline'); });
  expect(host.textContent).toContain('앱 목록을 불러오지 못했습니다');
  expect(host.textContent).not.toContain('아직 앱이 없습니다');
  expect([...host.querySelectorAll('button')].find((button) => button.textContent === '새 앱')?.disabled).toBe(true);
});

test('does not offer creation until the in-flight list request has completed', async () => {
  let resolveList!: (value: { apps: typeof apps }) => void;
  await mount(() => new Promise((resolve) => { resolveList = resolve; }));
  expect([...host.querySelectorAll('button')].find((button) => button.textContent === '새 앱')?.disabled).toBe(true);
  await act(async () => { resolveList({ apps }); });
  expect([...host.querySelectorAll('button')].find((button) => button.textContent === '새 앱')?.disabled).toBe(false);
  expect(host.textContent).toContain('음성 메모');
});

test('requires the service to return the created tile instead of inventing environment state', async () => {
  const calls: Array<{ path: string; method?: string; body?: string }> = [];
  let listReads = 0;
  await mount(async (path, init) => {
    calls.push({ path, method: init?.method, body: init?.body as string | undefined });
    if (init?.method === 'POST') return {};
    listReads += 1;
    return { apps: [] };
  });
  await submitCreateForm();
  expect(calls).toHaveLength(3);
  expect(calls[1].method).toBe('POST');
  expect(JSON.parse(calls[1].body!)).toEqual({ name: '음성 메모', slug: 'voice-notes', description: '회의 기록' });
  expect(calls[2].method).toBeUndefined();
  expect(host.textContent).toContain('앱 생성 응답을 확인하지 못했습니다');
  expect(host.textContent).not.toContain('음성 메모');
});

test('accepts a missing create tile only after the refreshed ledger confirms it', async () => {
  const created = { ...apps[0], slug: 'voice-notes', name: '음성 메모' };
  let listReads = 0;
  await mount(async (_path, init) => {
    if (init?.method === 'POST') return {};
    return { apps: ++listReads === 1 ? [] : [created] };
  });
  await submitCreateForm();
  expect(host.textContent).toContain('음성 메모');
  expect(host.textContent).not.toContain('앱 생성 응답을 확인하지 못했습니다');
});

test('makes an incomplete create response retryable when its ledger refresh fails', async () => {
  let listReads = 0;
  await mount(async (_path, init) => {
    if (init?.method === 'POST') return {};
    if (++listReads === 1) return { apps: [] };
    throw new Error('offline');
  });
  await submitCreateForm();
  expect(host.textContent).toContain('앱 생성 응답이 비어 있고 목록을 갱신하지 못했습니다');
  expect([...host.querySelectorAll('button')].find((button) => button.textContent === '다시 불러오기')).toBeTruthy();
});

test('refreshes the app ledger after creation and displays only the confirmed tile', async () => {
  const created = { ...apps[0], slug: 'new-app', name: '새 앱', description: '회의 기록' };
  let listReads = 0;
  const calls: string[] = [];
  await mount(async (path, init) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (!init?.method) return { apps: ++listReads === 1 ? [] : [created] };
    return { app: created };
  });
  await submitCreateForm();
  expect(calls).toEqual(['GET /v1/apps', 'POST /v1/apps', 'GET /v1/apps']);
  expect(host.textContent).toContain('새 앱');
  expect(host.textContent).toContain('회의 기록');
  expect(host.textContent).not.toContain('앱은 만들었지만');
});

test('reports a failed post-create refresh and recovers after retry', async () => {
  const created = { ...apps[0], slug: 'new-app', name: '새 앱', description: '회의 기록' };
  let listReads = 0;
  await mount(async (path, init) => {
    if (init?.method === 'POST') return { app: created };
    listReads += 1;
    if (listReads === 1) return { apps: [] };
    if (listReads === 2) throw new Error('offline');
    return { apps: [created] };
  });
  await submitCreateForm();
  expect(host.textContent).toContain('앱은 만들었지만 목록을 갱신하지 못했습니다');
  expect(host.textContent).not.toContain('아직 앱이 없습니다');
  await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent === '다시 불러오기')!.dispatchEvent(new window.Event('click', { bubbles: true })); });
  expect(host.textContent).toContain('새 앱');
  expect(host.textContent).not.toContain('앱은 만들었지만');
});

test('ignores a delayed create success from a replaced client', async () => {
  const created = { ...apps[0], slug: 'new-app', name: '새 앱', description: '회의 기록' };
  const post = deferred<{ app: typeof created }>();
  const replacementList = deferred<{ apps: typeof apps }>();
  let postStarted = false;
  const calls: string[] = [];
  await mount(async (_path, init) => {
    if (init?.method === 'POST') { postStarted = true; calls.push('original POST'); return post.promise; }
    return { apps: [] };
  });
  await submitCreateForm();
  expect(postStarted).toBe(true);
  await renderClient(async () => {
    calls.push('replacement GET');
    return replacementList.promise;
  });
  await act(async () => {
    post.resolve({ app: created });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(calls).toEqual(['original POST', 'replacement GET']);
  await act(async () => { replacementList.resolve({ apps: [] }); });
  expect(host.textContent).not.toContain('/new-app');
  expect(host.textContent).toContain('아직 앱이 없습니다');
  expect(host.textContent).not.toContain('앱을 만들지 못했습니다');
});

test('ignores a delayed list response from the replaced client', async () => {
  const fresh = { ...apps[0], slug: 'fresh', name: '새 서버 앱' };
  const oldList = deferred<{ apps: typeof apps }>();
  await mount(async () => oldList.promise);
  await renderClient(async () => ({ apps: [fresh] }));
  expect(host.textContent).toContain('새 서버 앱');
  await act(async () => { oldList.resolve({ apps: [] }); });
  expect(host.textContent).toContain('새 서버 앱');
  expect(host.textContent).not.toContain('아직 앱이 없습니다');
});

test('hides old tiles and blocks mutations while the replacement client loads', async () => {
  const oldApp = apps[0];
  const freshList = deferred<{ apps: typeof apps }>();
  await mount(async () => ({ apps: [oldApp] }));
  await renderClient(async () => freshList.promise);
  expect(host.textContent).not.toContain(oldApp.name);
  expect(host.textContent).toContain('앱을 불러오는 중');
  expect([...host.querySelectorAll('button')].find((button) => button.textContent === '새 앱')?.disabled).toBe(true);
  await act(async () => { freshList.resolve({ apps: [] }); });
  expect(host.textContent).toContain('아직 앱이 없습니다');
});

test('ignores a delayed create failure from a replaced client', async () => {
  const fresh = { ...apps[0], slug: 'fresh', name: '새 서버 앱' };
  const post = deferred<{ app: typeof apps[number] }>();
  await mount(async (_path, init) => init?.method === 'POST' ? post.promise : { apps: [] });
  await submitCreateForm();
  await renderClient(async () => ({ apps: [fresh] }));
  await act(async () => {
    post.reject(new Error('old server offline'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain('새 서버 앱');
  expect(host.textContent).not.toContain('앱을 만들지 못했습니다');
});

test('serializes trash actions so one completion cannot clear another action state', async () => {
  const second = { ...apps[0], slug: 'second', name: '두 번째 앱' };
  const deleteRequest = deferred<unknown>();
  const deletes: string[] = [];
  await mount(async (path, init) => {
    if (init?.method === 'DELETE') { deletes.push(path); return deleteRequest.promise; }
    return { apps: [apps[0], second] };
  });
  const firstButton = host.querySelector('button[aria-label="음성 메모 휴지통으로"]')!;
  const secondButton = host.querySelector('button[aria-label="두 번째 앱 휴지통으로"]')!;
  await act(async () => {
    firstButton.dispatchEvent(new window.Event('click', { bubbles: true }));
    secondButton.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
  expect(deletes).toEqual(['/v1/apps/voice-notes']);
  expect((host.querySelector('button[aria-label="두 번째 앱 휴지통으로"]') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { deleteRequest.resolve({}); });
  expect(host.textContent).not.toContain('음성 메모');
  expect(host.textContent).toContain('두 번째 앱');
});

test('ignores a delayed trash result from a replaced client', async () => {
  const remove = deferred<unknown>();
  await mount(async (_path, init) => init?.method === 'DELETE' ? remove.promise : { apps });
  const trash = host.querySelector('button[aria-label="음성 메모 휴지통으로"]')!;
  await act(async () => { trash.dispatchEvent(new window.Event('click', { bubbles: true })); });
  await renderClient(async () => ({ apps }));
  await act(async () => { remove.resolve({}); });
  expect(host.textContent).toContain('음성 메모');
  expect(host.textContent).not.toContain('휴지통으로 옮기지 못했습니다');
});

test('ignores a delayed trash failure from a replaced client', async () => {
  const remove = deferred<unknown>();
  const fresh = { ...apps[0], slug: 'fresh', name: '새 서버 앱' };
  await mount(async (_path, init) => init?.method === 'DELETE' ? remove.promise : { apps });
  const trash = host.querySelector('button[aria-label="음성 메모 휴지통으로"]')!;
  await act(async () => { trash.dispatchEvent(new window.Event('click', { bubbles: true })); });
  await renderClient(async () => ({ apps: [fresh] }));
  await act(async () => {
    remove.reject(new Error('old server offline'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toContain('새 서버 앱');
  expect(host.textContent).not.toContain('휴지통으로 옮기지 못했습니다');
});

test('shows an error when moving an app to trash fails on the active client', async () => {
  await mount(async (_path, init) => {
    if (init?.method === 'DELETE') throw new Error('offline');
    return { apps };
  });
  const trash = host.querySelector('button[aria-label="음성 메모 휴지통으로"]')!;
  await act(async () => { trash.dispatchEvent(new window.Event('click', { bubbles: true })); });
  expect(host.textContent).toContain('음성 메모 앱을 휴지통으로 옮기지 못했습니다');
  expect(host.textContent).toContain('음성 메모');
});
