import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { takeSharedPayload, markSharedPayloadProgress, readSharedPayloadProgress, acknowledgeSharedPayloadFiles, withSharedPayloadLock } from './share-target-store';
import { saveSharedScraps } from './share-scraps';
import type { ShareFetch } from './share-scraps';

test('fake Web Share Target POST stores media and redirects to exported scrap receiver', async () => {
  const handlers = new Map<string, (event: any) => void>();
  const entries = new Map<string, Response>();
  let failProgressWrite = false;
  const storage = {
    keys: async () => ['elanous-pwa-share-target-v4-phase-4-offline-cache'],
    open: async () => ({
      put: async (key: string, value: Response) => {
        if (failProgressWrite && key.includes('/progress/')) throw new Error('simulated cache quota');
        entries.set(key, value);
      },
      match: async (key: string) => entries.get(key)?.clone(),
      delete: async (key: string | Request) => entries.delete(typeof key === 'string' ? key : new URL(key.url).pathname),
      keys: async () => [...entries.keys()].map((key) => new Request(new URL(key, 'https://nexus.test'))),
    }),
  };
  const prior = globalThis.caches;
  const priorLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const localEntries = new Map<string, string>();
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => localEntries.get(key) ?? null,
    setItem: (key: string, value: string) => { localEntries.set(key, value); },
    removeItem: (key: string) => { localEntries.delete(key); },
    get length() { return localEntries.size; },
    key: (index: number) => [...localEntries.keys()][index] ?? null,
  } });
  try {
    class WorkerResponse extends Response {
      static redirect(url: string, status = 302): Response {
        return new Response(null, { status, headers: { location: url } });
      }
    }
    runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), {
      self: { caches: storage, location: { origin: 'https://nexus.test' }, addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler) },
      importScripts: () => undefined,
      URL, Date, Math, String, File, Headers, Response: WorkerResponse,
    });
    const form = new FormData();
    form.set('title', '공유한 소리');
    form.set('text', 'https://example.test/a');
    form.append('files', new File(['voice'], 'voice.ogg', { type: 'audio/ogg' }));
    let handled: Promise<Response> | undefined;
    handlers.get('fetch')!({
      request: new Request('https://nexus.test/app/share/', { method: 'POST', body: form }),
      respondWith: (response: Promise<Response>) => { handled = response; },
    });
    const redirect = await handled!;
    expect(redirect.status).toBe(303);
    const location = redirect.headers.get('location')!;
    expect(location.startsWith('/app/share/received/?shared=')).toBe(true);
    const id = new URL(location, 'https://nexus.test').searchParams.get('shared')!;
    const shared = await takeSharedPayload(id, { drain: false });
    expect(shared?.text).toBe('https://example.test/a');
    expect(shared?.files[0]?.type).toBe('audio/ogg');
    expect(shared?.files[0]?.name).toBe('voice.ogg');
    await Promise.all([markSharedPayloadProgress(id, 'url'), markSharedPayloadProgress(id, 'text')]);
    expect(new Set(await readSharedPayloadProgress(id))).toEqual(new Set(['url', 'text']));
    failProgressWrite = true;
    await markSharedPayloadProgress(id, 'file:0');
    expect(new Set(await readSharedPayloadProgress(id))).toEqual(new Set(['url', 'text', 'file:0']));
    await acknowledgeSharedPayloadFiles(id, shared?.fileKeys ?? []);
    expect(new Set(await readSharedPayloadProgress(id))).toEqual(new Set(['url', 'text', 'file:0']));
    failProgressWrite = false;

    const pdf = new FormData();
    pdf.append('files', new File(['%PDF'], 'paper.pdf', { type: 'application/pdf' }));
    let pdfHandled: Promise<Response> | undefined;
    handlers.get('fetch')!({
      request: new Request('https://nexus.test/app/share/', { method: 'POST', body: pdf }),
      respondWith: (response: Promise<Response>) => { pdfHandled = response; },
    });
    expect((await pdfHandled!).headers.get('location')?.startsWith('/app/chat?shared=')).toBe(true);

    const locks = new Map<string, Promise<void>>();
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
      request: <T>(name: string, callback: () => Promise<T>): Promise<T> => {
        const next = (locks.get(name) ?? Promise.resolve()).then(callback);
        locks.set(name, next.then(() => undefined, () => undefined));
        return next;
      },
    } } });
    const concurrent = new FormData();
    concurrent.set('text', 'same shared text');
    let concurrentHandled: Promise<Response> | undefined;
    handlers.get('fetch')!({
      request: new Request('https://nexus.test/app/share/', { method: 'POST', body: concurrent }),
      respondWith: (response: Promise<Response>) => { concurrentHandled = response; },
    });
    const concurrentId = new URL((await concurrentHandled!).headers.get('location')!, 'https://nexus.test').searchParams.get('shared')!;
    let scrapPosts = 0;
    const fetcher: ShareFetch = async (input) => {
      if (new URL(String(input)).pathname === '/v1/members') return Response.json({ member: { id: 'member-a' } });
      scrapPosts++;
      return Response.json({ id: `scrap-${scrapPosts}` }, { status: 201 });
    };
    const saveFromTab = () => withSharedPayloadLock(concurrentId, async () => {
      const candidate = await takeSharedPayload(concurrentId, { drain: false });
      if (!candidate) return;
      const completed = new Set(await readSharedPayloadProgress(concurrentId));
      const result = await saveSharedScraps(candidate, {
        baseUrl: 'https://nexus.test', fetcher, completedKeys: completed,
        onSaved: (key) => markSharedPayloadProgress(concurrentId, key),
      });
      if (result.failed.length === 0) await acknowledgeSharedPayloadFiles(concurrentId, candidate.fileKeys);
    });
    await Promise.all([saveFromTab(), saveFromTab()]);
    expect(scrapPosts).toBe(1);
    expect(await readSharedPayloadProgress(concurrentId)).toEqual(['text']);
  } finally {
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: prior });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: priorLocalStorage });
    if (priorNavigator) Object.defineProperty(globalThis, 'navigator', priorNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
