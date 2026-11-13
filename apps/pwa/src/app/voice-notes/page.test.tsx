import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { parseHTML } from 'linkedom';
import { act as rendererAct, create as createRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import VoiceNotesPage from './page';

const originals = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement,
  Node: globalThis.Node, Event: globalThis.Event, fetch: globalThis.fetch,
  actEnvironment: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
let root: import('react-dom/client').Root;
let host: HTMLElement;

beforeEach(async () => {
  const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, Event: window.Event });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.getElementById('root')!;
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  Object.assign(globalThis, originals);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originals.actEnvironment;
});

async function render(sessionId: string) {
  const daemon = { config: { baseUrl: 'https://api.example.test', token: '', provider: '' }, sessionId,
    setConfig: () => {}, setSessionId: () => {} } as unknown as NonNullable<import('react').ContextType<typeof DaemonContext>>;
  await act(async () => root.render(createElement(DaemonContext.Provider, { value: daemon }, createElement(VoiceNotesPage))));
}

test('member switch, failed reload and logout never expose previous member notes or folder names', async () => {
  let rejectNext!: (reason: Error) => void;
  let failNext = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (failNext) return new Promise<Response>((_, reject) => { rejectNext = reject; });
    const path = new URL(String(input)).pathname;
    const body = path === '/v1/members' ? { member: { id: 'member-a' }, appSlot: { appSlug: 'notes-a' } }
      : path === '/v1/scrap-folders' ? { folders: [{ id: 'folder-a', name: 'A만의 폴더', parentId: null }] }
        : { scraps: [{ id: 'note-a', kind: 'voice', status: 'absorbed', createdAt: '2026-11-12T00:00:00Z',
          folderId: 'folder-a', raw: { text: 'A만의 기록', recordedDate: '2026-11-12', mediaRef: 'member-a/scraps/voice-1',
            timeline: [{ t: 1000, kind: 'marker', label: '핵심' },
              { t: 2000, kind: 'photo', mediaRef: 'member-a/scraps/photo-1', mime: 'image/jpeg' }] } }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  await render('session-a');
  expect(host.textContent).toContain('A만의 기록');
  expect(host.textContent).toContain('A만의 폴더');
  expect([...host.querySelectorAll('ol li')].map((node) => node.textContent).some((text) => text?.includes('0:00 · 음성'))).toBe(true);
  const newFolderInput = host.querySelector('input') as HTMLInputElement;
  newFolderInput.value = 'A만의 새 폴더 이름';
  expect(newFolderInput.value).toBe('A만의 새 폴더 이름');

  failNext = true;
  await render('session-b');
  expect(host.querySelector('input')).not.toBe(newFolderInput);
  expect((host.querySelector('input') as HTMLInputElement).value).toBe('');
  expect(host.textContent).not.toContain('A만의 기록');
  expect(host.textContent).not.toContain('A만의 폴더');
  await act(async () => rejectNext(new Error('offline')));
  expect(host.textContent).toContain('offline');
  expect(host.textContent).not.toContain('A만의 기록');
  await render('');
  expect(host.textContent).toContain('회원 로그인이 필요합니다.');
  expect(host.textContent).not.toContain('A만의 폴더');
  expect((host.querySelector('input') as HTMLInputElement).value).toBe('');
});

test('explicit export sends the selected voice note to the configured vault folder', async () => {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  let exported = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    if (path.endsWith('/export')) exported = true;
    const body = path === '/v1/members' ? { member: { id: 'member-a' }, appSlot: { appSlug: 'notes-a' } }
      : path === '/v1/scrap-folders' ? { folders: [] }
        : path.endsWith('/export') ? { vaultId: 'configured', path: 'Members/hashed/Voice Notes/a1b2c3d4e5f60718.md' }
          : { scraps: [{ id: 'a1b2c3d4e5f60718', kind: 'voice', status: 'absorbed', createdAt: '2026-11-12T00:00:00Z',
            raw: { text: '강의 기록', recordedDate: '2026-11-12' },
            ...(exported ? { exports: [{ vaultId: 'configured', path: 'Members/hashed/Voice Notes/a1b2c3d4e5f60718.md', savedAt: '2026-11-13T00:00:00Z' }] } : {}) }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  await render('session-a');
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent === 'Obsidian에 내보내기');
  expect(button).toBeDefined();
  await act(async () => { button!.click(); });
  const exportCall = calls.find((call) => call.path === '/v1/scraps/a1b2c3d4e5f60718/export');
  expect(exportCall?.method).toBe('POST');
  expect(JSON.parse(exportCall!.body!)).toEqual({ vaultId: 'configured', vaultRelativeFolder: 'Voice Notes' });
  expect(host.textContent).toContain('Obsidian에 내보냄 · Members/hashed/Voice Notes/a1b2c3d4e5f60718.md');
});

test('new folder onChange state clears on member switch and again on logout', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    const body = path === '/v1/members' ? { member: { id: 'member' }, appSlot: { appSlug: 'notes' } }
      : path === '/v1/scrap-folders' ? { folders: [] } : { scraps: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const page = (sessionId: string) => {
    const daemon = { config: { baseUrl: 'https://api.example.test', token: '', provider: '' }, sessionId,
      setConfig: () => {}, setSessionId: () => {} } as unknown as NonNullable<import('react').ContextType<typeof DaemonContext>>;
    return createElement(DaemonContext.Provider, { value: daemon }, createElement(VoiceNotesPage));
  };
  let tree!: import('react-test-renderer').ReactTestRenderer;
  await rendererAct(async () => { tree = createRenderer(page('session-a')); });
  const folderInput = () => tree.root.findAllByType('input').find((input) => input.props.maxLength === 80)!;
  const createButton = () => tree.root.findAllByType('button').find((button) => button.children.includes('만들기'))!;
  const beforeSwitch = folderInput();
  await rendererAct(async () => beforeSwitch.props.onChange({ target: { value: 'A만의 새 폴더' } }));
  expect(folderInput().props.value).toBe('A만의 새 폴더');
  expect(createButton().props.disabled).toBe(false);

  await rendererAct(async () => tree.update(page('session-b')));
  expect(folderInput()).not.toBe(beforeSwitch);
  expect(folderInput().props.value).toBe('');
  expect(createButton().props.disabled).toBe(true);
  await rendererAct(async () => folderInput().props.onChange({ target: { value: 'B만의 새 폴더' } }));
  expect(folderInput().props.value).toBe('B만의 새 폴더');
  expect(createButton().props.disabled).toBe(false);

  await rendererAct(async () => tree.update(page('')));
  expect(folderInput().props.value).toBe('');
  expect(createButton().props.disabled).toBe(true);
  await act(async () => tree.unmount());
});
