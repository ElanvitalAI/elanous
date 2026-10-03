import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import * as realNavigation from 'next/navigation';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { DaemonClient } from '@/lib/daemon-client';
import { PWA_ROLE_KEY, PWA_ROLE_EVENT } from '@/lib/pwa-role';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigation = { ...realNavigation };
const pushes: string[] = [];
mock.module('next/navigation', () => ({ ...originalNavigation, useRouter: () => ({ push: (href: string) => pushes.push(href) }) }));
const { TodayView } = await import('./TodayView');
afterAll(() => { mock.module('next/navigation', () => originalNavigation); });
let tree: ReactTestRenderer | undefined;
let role: 'owner' | 'contributor' | 'general' = 'owner';
let sessionId = '';
const listeners = new Set<() => void>();
afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
  pushes.length = 0;
  listeners.clear();
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function setupRole(value: typeof role) {
  role = value;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: { getItem: (key: string) => key === PWA_ROLE_KEY ? role : null },
    addEventListener: (name: string, callback: () => void) => { if (name === PWA_ROLE_EVENT) listeners.add(callback); },
    removeEventListener: (_name: string, callback: () => void) => { listeners.delete(callback); },
  } });
}
async function mount() {
  const config = { baseUrl: 'https://nexus.example', token: 'token', provider: '' };
  const client = new DaemonClient(config);
  await act(async () => { tree = create(<DaemonContext.Provider value={{ client, config, sessionId: '', setConfig: () => {}, setSessionId: id => { sessionId = id; } }}><TodayView /></DaemonContext.Provider>); });
  return tree!.root;
}
function section(root: ReactTestRenderer['root'], name: string) { return root.findByProps({ 'aria-label': name }); }
const conversations = Array.from({ length: 7 }, (_, i) => ({ id: `session-${i}`, title: `대화 ${i}`, updatedAt: `2026-10-0${i + 1}T12:00:00Z`, preview: '', source: 'pwa', createdAt: '', messageCount: 1, active: false }));
const requests = Array.from({ length: 7 }, (_, i) => ({ id: `request-${i}`, text: `맡긴 일 ${i}\n상세`, createdAt: `2026-10-0${i + 1}T12:00:00Z`, status: 'done', seats: [], resultCount: 0 }));

test('three independently fetched sections show decisions, newest five requests and conversations, all links and conversation switch; no writes', async () => {
  setupRole('owner');
  const calls: Array<{ path: string; method?: string }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ path: url, method: init?.method });
    if (url.endsWith('/v1/graph-approvals')) return json({ items: [{ graphId: 'graph', runId: 'run', message: '발행 결정 대기' }] });
    if (url.includes('/approvals/merges')) return json({ items: [{ number: 42, title: '병합 결정 대기' }] });
    if (url.endsWith('/v1/exec-requests')) return json({ items: requests });
    if (url.endsWith('/v1/sessions/store')) return json({ sessions: conversations, total: 7 });
    throw new Error(url);
  }) as typeof fetch;
  const root = await mount();
  const approval = section(root, '승인 대기');
  const work = section(root, '최근 맡긴 일');
  const chat = section(root, '최근 대화');
  expect(approval.findByType('a').props.href).toBe('/approvals');
  expect(work.findAllByType('a')[0]!.props.href).toBe('/exec');
  expect(chat.findByType('a').props.href).toBe('/chat');
  expect(approval.findAllByType('li').map(item => item.children.join(''))).toEqual(['발행 결정 대기', '병합 결정 대기']);
  expect(work.findAllByType('li')).toHaveLength(5);
  expect(work.findAllByType('li')[0]!.findByType('a').props.href).toBe('/exec?request=request-6');
  expect(work.findAllByType('li')[4]!.findByType('a').props.href).toBe('/exec?request=request-2');
  expect(chat.findAllByType('li')).toHaveLength(5);
  await act(async () => { chat.findAllByType('button')[0]!.props.onClick(); });
  expect(sessionId).toBe('session-6');
  expect(pushes).toEqual(['/chat']);
  expect(calls).toHaveLength(4);
  expect(calls.every(call => !call.method || call.method === 'GET')).toBe(true);
});

test('empty pending decisions and other empty sections show their own copy', async () => {
  setupRole('contributor');
  globalThis.fetch = (async (url: string) => json(url.endsWith('/v1/sessions/store') ? { sessions: [], total: 0 } : { items: [] })) as typeof fetch;
  const root = await mount();
  expect(section(root, '승인 대기').findByType('p').children).toEqual(['지금 결정 대기 중인 일이 없습니다.']);
  expect(section(root, '최근 맡긴 일').findByType('p').children).toEqual(['아직 맡긴 일이 없습니다.']);
  expect(section(root, '최근 대화').findByType('p').children).toEqual(['아직 대화가 없습니다.']);
});

test('one failed section does not block the other two successful reads', async () => {
  setupRole('owner');
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith('/v1/graph-approvals')) return json({}, 503);
    if (url.includes('/approvals/merges')) return json({ items: [] });
    if (url.endsWith('/v1/exec-requests')) return json({ items: [requests[0]] });
    if (url.endsWith('/v1/sessions/store')) return json({ sessions: [conversations[0]], total: 1 });
    throw new Error(url);
  }) as typeof fetch;
  const root = await mount();
  expect(section(root, '승인 대기').findAllByProps({ role: 'alert' })).toHaveLength(1);
  expect(section(root, '최근 맡긴 일').findByType('li').findByType('a').props.href).toBe('/exec?request=request-0');
  expect(section(root, '최근 대화').findByType('li').findByType('button').children).toContain('대화 0');
});

test('each section can retry its own failed read without refetching siblings', async () => {
  setupRole('owner');
  const counts = { graph: 0, merge: 0, requests: 0, sessions: 0 };
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith('/v1/graph-approvals')) { counts.graph++; return counts.graph === 1 ? json({}, 503) : json({ items: [] }); }
    if (url.includes('/approvals/merges')) { counts.merge++; return json({ items: [] }); }
    if (url.endsWith('/v1/exec-requests')) { counts.requests++; return counts.requests === 1 ? json({}, 503) : json({ items: [] }); }
    if (url.endsWith('/v1/sessions/store')) { counts.sessions++; return counts.sessions === 1 ? json({}, 503) : json({ sessions: [], total: 0 }); }
    throw new Error(url);
  }) as typeof fetch;
  const root = await mount();
  expect(root.findAllByProps({ role: 'alert' })).toHaveLength(3);
  for (const [name, key] of [['승인 대기', 'graph'], ['최근 맡긴 일', 'requests'], ['최근 대화', 'sessions']] as const) {
    await act(async () => { section(root, name).findByType('button').props.onClick(); });
    expect(section(root, name).findAllByProps({ role: 'alert' })).toHaveLength(0);
    expect(counts[key]).toBe(2);
  }
  expect(counts).toEqual({ graph: 2, merge: 2, requests: 2, sessions: 2 });
});

test('general role cannot see approvals link or request approval data even when role changes', async () => {
  setupRole('general');
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    if (url.endsWith('/v1/graph-approvals')) return json({ items: [{ graphId: 'private', runId: 'run', message: '비공개 결정' }] });
    return json(url.endsWith('/v1/sessions/store') ? { sessions: [] } : { items: [] });
  }) as typeof fetch;
  const root = await mount();
  expect(section(root, '승인 대기').findByType('p').children).toEqual(['지금 결정 대기 중인 일이 없습니다.']);
  expect(root.findAllByType('a').map(a => a.props.href)).not.toContain('/approvals');
  expect(calls.some(url => url.includes('approvals'))).toBe(false);
  await act(async () => { role = 'owner'; listeners.forEach(callback => callback()); });
  expect(root.findAllByType('a').map(a => a.props.href)).toContain('/approvals');
  expect(section(root, '승인 대기').findByType('li').children).toEqual(['비공개 결정']);
  await act(async () => { role = 'general'; listeners.forEach(callback => callback()); });
  expect(root.findAllByType('a').map(a => a.props.href)).not.toContain('/approvals');
  expect(section(root, '승인 대기').findAllByType('li')).toHaveLength(0);
});
