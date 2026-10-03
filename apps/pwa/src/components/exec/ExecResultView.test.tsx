import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonClient, type ExecRequestDetail } from '@/lib/daemon-client';
import { ExecResultView } from './ExecResultView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalTimeout = globalThis.setTimeout;
let tree: ReactTestRenderer | undefined;
const client = new DaemonClient({ baseUrl: 'https://nexus.example', token: 'owner-token', provider: '' });
type Result = ExecRequestDetail['results'][number];
const result = (kind: Result['kind'], url: string, extras: Partial<Result> = {}): Result => ({ seat: 'COO', kind, title: '', url, ...extras });

async function mount(value: Result) {
  await act(async () => { tree = create(<ExecResultView client={client} id="one" result={value} />); });
  return tree!.root;
}
afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  globalThis.setTimeout = originalTimeout;
});

test('all result kinds have Korean names and only three safe external sources open in a new tab', async () => {
  for (const [kind, name] of [['report', '보고서'], ['pdf', 'PDF'], ['video', '영상'], ['image', '그림'], ['text', '글'], ['link', '링크']] as const) {
    const root = await mount(result(kind, 'https://external.example/result', { sources: [
      { title: 'A', url: 'https://example.com/a' }, { title: 'B', url: 'https://example.com/b' },
      { title: 'C', url: 'https://example.com/c' }, { title: 'D', url: 'https://example.com/d' },
    ] }));
    expect(root.findAllByType('span')[0]!.children.join('')).toContain(name);
    expect(root.findAllByType('a').map(anchor => anchor.props.href)).toEqual([
      'https://external.example/result', 'https://example.com/a', 'https://example.com/b', 'https://example.com/c',
    ]);
    expect(root.findAllByType('a').every(anchor => anchor.props.target === '_blank' && anchor.props.rel === 'noopener noreferrer')).toBe(true);
    await act(async () => { tree!.unmount(); });
    tree = undefined;
  }
  const root = await mount(result('report', 'javascript:alert(1)', { sources: [{ title: 'unsafe', url: 'javascript:alert(1)' }] }));
  expect(root.findAllByType('a')).toHaveLength(0);
});

test('authenticated daemon video and image display inline and release their blob URLs', async () => {
  const fetches: Array<{ url: string; init?: RequestInit }> = [];
  const revoked: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    fetches.push({ url, init });
    return new Response('file');
  }) as typeof fetch;
  URL.createObjectURL = () => `blob:media-${fetches.length}`;
  URL.revokeObjectURL = url => { revoked.push(url); };
  for (const [kind, tag] of [['video', 'video'], ['image', 'img']] as const) {
    const root = await mount(result(kind, `/v1/exec-requests/one/files/media.${kind}`));
    const media = root.findByType(tag);
    expect(media.props.src).toBe(`blob:media-${fetches.length}`);
    if (tag === 'video') expect(media.props.controls).toBe(true);
    else expect(media.props.alt).toBe('그림');
    expect(root.findAllByType('button')).toHaveLength(0);
    await act(async () => { tree!.unmount(); });
    tree = undefined;
  }
  expect(fetches.map(call => call.init?.headers)).toEqual([{ authorization: 'Bearer owner-token' }, { authorization: 'Bearer owner-token' }]);
  expect(revoked).toEqual(['blob:media-1', 'blob:media-2']);
});

test('PDF opens its tab during the click, then navigates to authenticated content after a delayed response', async () => {
  let resolveFetch: ((value: Response) => void) | undefined;
  const events: string[] = [];
  globalThis.fetch = ((_url: string) => new Promise<Response>(resolve => { events.push('fetch'); resolveFetch = resolve; })) as typeof fetch;
  URL.createObjectURL = () => 'blob:result';
  URL.revokeObjectURL = () => {};
  globalThis.setTimeout = (() => 1) as unknown as typeof setTimeout;
  const tab = { opener: {} as unknown, closed: false, location: { replace(url: string) { events.push(`navigate:${url}`); } }, close() { events.push('close'); } };
  globalThis.window = { open: () => { events.push('open'); return tab; } } as unknown as Window & typeof globalThis;
  const root = await mount(result('pdf', '/v1/exec-requests/one/files/file.pdf'));
  await act(async () => { root.findByType('button').props.onClick(); });
  expect(events).toEqual(['open', 'fetch']);
  expect(tab.opener).toBe(null);
  await act(async () => { resolveFetch!(new Response('file')); });
  expect(events).toEqual(['open', 'fetch', 'navigate:blob:result']);
});

test('non-PDF daemon files still download through the authenticated client', async () => {
  const clicks: Array<{ href: string; download: string }> = [];
  const fetches: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => { fetches.push({ url, init }); return new Response('file'); }) as typeof fetch;
  URL.createObjectURL = () => 'blob:result';
  URL.revokeObjectURL = () => {};
  globalThis.setTimeout = (() => 1) as unknown as typeof setTimeout;
  globalThis.document = { body: { appendChild() {} }, createElement: () => ({ href: '', download: '', click() { clicks.push({ href: this.href, download: this.download }); }, remove() {} }) } as unknown as Document;
  for (const kind of ['report', 'text'] as const) {
    const root = await mount(result(kind, '/v1/exec-requests/one/files/file.txt'));
    await act(async () => { root.findByType('button').props.onClick(); });
    expect(clicks.at(-1)).toEqual({ href: 'blob:result', download: 'file.txt' });
    await act(async () => { tree!.unmount(); });
    tree = undefined;
  }
  expect(fetches.map(call => call.init?.headers)).toEqual([{ authorization: 'Bearer owner-token' }, { authorization: 'Bearer owner-token' }]);
});
