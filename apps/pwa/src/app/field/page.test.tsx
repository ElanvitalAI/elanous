import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { DaemonClient } from '@/lib/daemon-client';
import FieldPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;
const originalXHR = globalThis.XMLHttpRequest;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
let tree: ReactTestRenderer | undefined;
let requests: Array<{ url: string; init?: RequestInit }> = [];
let uploads: FieldXHR[] = [];
let reelState = 'rendering';

class FieldXHR {
  upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  status = 200;
  responseText = JSON.stringify({ ok: true, event: 'festival-2026', count: 2, saved: [{}, {}] });
  url = '';
  headers: Record<string, string> = {};
  body?: FormData;
  constructor() { uploads.push(this); }
  open(method: string, url: string) { expect(method).toBe('POST'); this.url = url; }
  setRequestHeader(key: string, value: string) { this.headers[key] = value; }
  send(body: FormData) { this.body = body; }
  finish() { this.onload?.(); }
}

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXHR;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  requests = [];
  uploads = [];
  reelState = 'rendering';
});

async function mount() {
  const config = { baseUrl: 'https://nexus.example', token: 'owner-token', provider: '' };
  const client = new DaemonClient(config);
  globalThis.XMLHttpRequest = FieldXHR as unknown as typeof XMLHttpRequest;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    if (url.endsWith('/v1/field/uploads')) return Response.json({ defaultEvent: 'festival-2026' });
    if (url.includes('/v1/field/reel/file')) return new Response(new Blob(['video'], { type: 'video/mp4' }));
    if (url.includes('/v1/field/reel?')) return Response.json({ event: 'festival-2026', state: reelState, items: 2, ...(reelState === 'done' ? { url: '/v1/field/reel/file?event=festival-2026' } : {}) });
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  await act(async () => {
    tree = create(<DaemonContext.Provider value={{ client, config, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}><FieldPage /></DaemonContext.Provider>);
  });
  return tree!.root;
}

function file(name: string, type: string) { return new File(['bytes'], name, { type }); }

async function select(files: File[]) {
  await act(async () => {
    tree!.root.findByProps({ id: 'field-files' }).props.onChange({ target: { files } });
  });
}

async function submit() {
  await act(async () => {
    tree!.root.findByType('form').props.onSubmit({ preventDefault: () => {} });
  });
}

test('daemon default fills the editable event and native media picker accepts multiple images or videos', async () => {
  const root = await mount();
  expect(requests.map((request) => request.url)).toEqual(['https://nexus.example/v1/field/uploads']);
  expect(root.findByProps({ id: 'field-event' }).props.value).toBe('festival-2026');
  const picker = root.findByProps({ id: 'field-files' });
  expect(picker.props.multiple).toBe(true);
  expect(picker.props.accept).toBe('image/*,video/*');
  expect(root.findByType('h1').children.join('')).toBe('현장 올리기');
  expect(root.findByProps({ htmlFor: 'field-files' }).children.join('')).toBe('사진·영상 고르기');
  expect(root.findByType('button').children.join('')).toBe('올리기');
  expect(root.findByProps({ htmlFor: 'field-caption' }).children.join('')).toBe('한 줄 설명(첫 장 자막 · 선택)');
});

test('a delayed daemon default never overwrites an event edited before it arrives', async () => {
  let resolveDefault!: (value: Response) => void;
  const pending = new Promise<Response>((resolve) => { resolveDefault = resolve; });
  const config = { baseUrl: 'https://nexus.example', token: 'owner-token', provider: '' };
  const client = new DaemonClient(config);
  globalThis.fetch = (async (_url: string) => pending) as typeof fetch;
  await act(async () => {
    tree = create(<DaemonContext.Provider value={{ client, config, sessionId: '', setConfig: () => {}, setSessionId: () => {} }}><FieldPage /></DaemonContext.Provider>);
  });
  await act(async () => { tree!.root.findByProps({ id: 'field-event' }).props.onChange({ target: { value: 'edited-event' } }); });
  await act(async () => { resolveDefault(Response.json({ defaultEvent: 'festival-2026' })); await Promise.resolve(); });
  expect(tree!.root.findByProps({ id: 'field-event' }).props.value).toBe('edited-event');
});

test('invalid slug gives a one-line hint and never posts; a valid edited event is sent', async () => {
  const root = await mount();
  await select([file('one.jpg', 'image/jpeg')]);
  await act(async () => { root.findByProps({ id: 'field-event' }).props.onChange({ target: { value: 'Bad/Name' } }); });
  expect(root.findByProps({ id: 'field-slug-error' }).children.join('')).toContain('영문 소문자');
  expect(root.findByType('button').props.disabled).toBe(true);
  await submit();
  expect(uploads).toHaveLength(0);
  await act(async () => { root.findByProps({ id: 'field-event' }).props.onChange({ target: { value: 'event_2' } }); });
  await submit();
  expect(uploads).toHaveLength(1);
  expect(uploads[0]!.url).toBe('https://nexus.example/v1/field/uploads?event=event_2&device=pwa');
});

test('multipart sends exactly the selected files with the iOS query caption and ordered timestamps, with real upload progress', async () => {
  const root = await mount();
  const chosen = [file('one.jpg', 'image/jpeg'), file('two.mp4', 'video/mp4')];
  await select(chosen);
  await act(async () => { root.findByProps({ id: 'field-caption' }).props.onChange({ target: { value: 'First frame' } }); });
  await submit();
  const xhr = uploads[0]!;
  expect(xhr.url).toBe('https://nexus.example/v1/field/uploads?event=festival-2026&device=pwa&caption=First+frame');
  expect(xhr.headers).toEqual({ authorization: 'Bearer owner-token' });
  expect(xhr.body!.getAll('file')).toEqual(chosen);
  expect(xhr.body!.getAll('caption')).toEqual(['First frame']);
  expect(xhr.body!.getAll('capturedAt')).toEqual(['', '']);
  await act(async () => { xhr.upload.onprogress?.({ lengthComputable: true, loaded: 40, total: 100 }); });
  expect(root.findByType('progress').props.value).toBe(40);
  await act(async () => { xhr.finish(); });
  expect(root.findByProps({ 'aria-label': '올린 결과' }).findByType('p').children.join('')).toContain('폴더에 2개 · 영상 만드는 중');
  expect(requests.some((request) => request.url.endsWith('/v1/field/reel?event=festival-2026'))).toBe(true);
});

test('upload result exposes only event and count after validating daemon ok', async () => {
  globalThis.XMLHttpRequest = FieldXHR as unknown as typeof XMLHttpRequest;
  const client = new DaemonClient({ baseUrl: 'https://nexus.example', token: 'owner-token', provider: '' });
  const completed = client.uploadField('festival-2026', [file('one.jpg', 'image/jpeg')], '', () => {});
  uploads[0]!.finish();
  expect(await completed).toEqual({ event: 'festival-2026', count: 2 });

  const rejected = client.uploadField('festival-2026', [file('two.jpg', 'image/jpeg')], '', () => {});
  uploads[1]!.responseText = JSON.stringify({ ok: false, event: 'festival-2026', count: 2 });
  uploads[1]!.finish();
  await expect(rejected).rejects.toThrow('field upload 200');

  const empty = client.uploadField('festival-2026', [file('three.jpg', 'image/jpeg')], '', () => {});
  uploads[2]!.responseText = 'null';
  uploads[2]!.finish();
  await expect(empty).rejects.toThrow('field upload 200: invalid response');
});

test('reel done renders an authenticated video blob and releases the URL on unmount', async () => {
  const root = await mount();
  const revoked: string[] = [];
  URL.createObjectURL = (() => 'blob:field-reel') as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => { revoked.push(url); }) as typeof URL.revokeObjectURL;
  await select([file('clip.mp4', 'video/mp4'), file('poster.jpg', 'image/jpeg')]);
  await submit();
  await act(async () => { uploads[0]!.finish(); });
  reelState = 'done';
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5100)); });
  const videoRequest = requests.find((request) => request.url.endsWith('/v1/field/reel/file?event=festival-2026'));
  expect(videoRequest?.init?.headers).toEqual({ authorization: 'Bearer owner-token' });
  expect(root.findByType('video').props.src).toBe('blob:field-reel');
  expect(root.findByType('video').props.controls).toBe(true);
  expect(root.findByProps({ 'aria-label': '올린 결과' }).findByType('p').children.join('')).toContain('영상 완료');
  await act(async () => { tree!.unmount(); });
  tree = undefined;
  expect(revoked).toEqual(['blob:field-reel']);
}, 10000);
