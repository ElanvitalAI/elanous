import { afterEach, expect, test } from 'bun:test';
import { firecrawlPluginSpec, runFirecrawl } from './firecrawl-plugin.js';

const KEY = 'synthetic-firecrawl-private-key';
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
function world(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  servers.push(server);
  return { apiBase: `${server.url}v2/`, readKey: async () => KEY, pollMs: 0 };
}
const page = (markdown: string) => ({ markdown, metadata: { sourceURL: 'https://example.com/page' } });

test('bundled spec exposes URL crawl with setup guidance', () => {
  const spec = firecrawlPluginSpec();
  expect(spec.name).toBe('firecrawl');
  expect(spec.pluginId).toBe('firecrawl');
  expect(spec.description).toContain('elanous setup firecrawl');
});

test('one scrape uses real HTTP transport and redacts provider credential echoes', async () => {
  let called = false;
  const deps = world(async req => {
    expect(new URL(req.url).pathname).toBe('/v2/scrape');
    expect(req.method).toBe('POST');
    expect(req.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(await req.json()).toEqual({ url: 'https://example.com/', formats: ['markdown'], onlyMainContent: true });
    called = true;
    return Response.json({ success: true, data: page(`content ${KEY}`) });
  });
  const result = await runFirecrawl({ url: 'https://example.com', mode: 'scrape' }, undefined, deps);
  expect(called).toBe(true);
  expect(result.status).toBe('completed');
  expect(JSON.stringify(result)).not.toContain(KEY);
  expect(result.pages).toEqual([{ url: 'https://example.com/page', markdown: 'content [redacted]' }]);
});

test('one crawl starts once, polls and collects same-job pagination', async () => {
  let starts = 0;
  let polls = 0;
  let apiBase = '';
  const deps = world(async req => {
    const url = new URL(req.url);
    if (req.method === 'POST') {
      starts++;
      // 출처: 내부 문서 `FIRECRAWL-DEFAULT-ONESHOT` — explicit limit within the API budget; two-page fixture.
      expect(await req.json()).toEqual({ url: 'https://example.com/', limit: 2, scrapeOptions: { formats: ['markdown'], onlyMainContent: true } });
      return Response.json({ success: true, id: 'job-one' });
    }
    expect(url.pathname).toBe('/v2/crawl/job-one');
    polls++;
    if (polls === 1) return Response.json({ status: 'scraping', data: [] });
    return Response.json(url.search ? { status: 'completed', data: [page('second')] }
      : { status: 'completed', data: [page('first')], next: `${apiBase}crawl/job-one?skip=1` });
  });
  apiBase = deps.apiBase;
  // 출처: 내부 문서 `FIRECRAWL-DEFAULT-ONESHOT` — explicit limit within the API budget; two-page fixture.
  const result = await runFirecrawl({ url: 'https://example.com', limit: 2 }, undefined, deps);
  expect(result.status).toBe('completed');
  expect(starts).toBe(1);
  expect(polls).toBe(3);
  expect(result.pages).toEqual([{ url: 'https://example.com/page', markdown: 'first' }, { url: 'https://example.com/page', markdown: 'second' }]);
});

test('missing key and failed secret backend never issue HTTP requests', async () => {
  let requests = 0;
  const deps = world(() => { requests++; return Response.json({}); });
  expect(await runFirecrawl({ url: 'https://example.com' }, undefined, { ...deps, readKey: async () => undefined }))
    .toMatchObject({ status: 'key-needed', setupCommand: 'elanous setup firecrawl' });
  const result = await runFirecrawl({ url: 'https://example.com' }, undefined, { ...deps, readKey: async () => { throw new Error(KEY); } });
  expect(result.status).toBe('failed');
  expect(JSON.stringify(result)).not.toContain(KEY);
  expect(requests).toBe(0);
});

for (const url of ['http://127.0.0.1', 'http://localhost', 'https://user:password@example.com', 'file:///etc/passwd', 'https://example.com/?api_key=synthetic']) {
  test(`rejects unsafe target ${new URL(url).protocol}`, async () => {
    let accessed = false;
    const result = await runFirecrawl({ url }, undefined, { readKey: async () => { accessed = true; return KEY; } });
    expect(result.status).toBe('failed');
    expect(accessed).toBe(false);
  });
}

test('foreign pagination never receives the credential', async () => {
  let leaked = false;
  let providerRequests = 0;
  const evil = world(() => { leaked = true; return Response.json({}); });
  const deps = world(req => {
    providerRequests++;
    return Response.json(req.method === 'POST' ? { id: 'job' }
      : { status: 'completed', data: [], next: `${evil.apiBase}crawl/job` });
  });
  const result = await runFirecrawl({ url: 'https://example.com' }, undefined, deps);
  expect(result.status).toBe('failed');
  expect(leaked).toBe(false);
  expect(providerRequests).toBe(2);
});

test('redirects and provider errors return no raw body or key', async () => {
  let leaked = false;
  const evil = world(() => { leaked = true; return Response.json({}); });
  const redirect = world(() => Response.redirect(evil.apiBase));
  expect((await runFirecrawl({ url: 'https://example.com' }, undefined, redirect)).status).toBe('failed');
  expect(leaked).toBe(false);
  const failure = world(() => new Response(KEY, { status: 401 }));
  const result = await runFirecrawl({ url: 'https://example.com' }, undefined, failure);
  expect(result.status).toBe('failed');
  expect(JSON.stringify(result)).not.toContain(KEY);
});

test('abort is not completion and retains the remote job receipt', async () => {
  const controller = new AbortController();
  const deps = world(req => {
    if (req.method === 'POST') return Response.json({ id: 'job' });
    controller.abort();
    return Response.json({ status: 'scraping', data: [] });
  });
  const result = await runFirecrawl({ url: 'https://example.com' }, { signal: controller.signal }, deps);
  expect(result).toMatchObject({ status: 'cancelled', jobId: 'job' });
});

test('invalid provider job cannot echo credential', async () => {
  const deps = world(() => Response.json({ id: KEY }));
  const result = await runFirecrawl({ url: 'https://example.com' }, undefined, deps);
  expect(result.status).toBe('failed');
  expect(JSON.stringify(result)).not.toContain(KEY);
});

test('unfinished crawl at deadline is pending, never completed or restarted', async () => {
  const deadline = new AbortController();
  let starts = 0;
  const deps = world(req => {
    if (req.method === 'POST') { starts++; return Response.json({ id: 'job' }); }
    deadline.abort();
    return Response.json({ status: 'scraping', data: [] });
  });
  expect(await runFirecrawl({ url: 'https://example.com' }, undefined, { ...deps, deadlineSignal: deadline.signal }))
    .toMatchObject({ status: 'pending', jobId: 'job' });
  expect(starts).toBe(1);
});

test('deadline covers a stuck secret lookup and late resolution cannot dispatch', async () => {
  const deadline = new AbortController();
  let resolveKey!: (key: string) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let requests = 0;
  const deps = world(() => { requests++; return Response.json({}); });
  const pending = runFirecrawl({ url: 'https://example.com' }, undefined, {
    ...deps, deadlineSignal: deadline.signal,
    readKey: () => { started(); return new Promise(resolve => { resolveKey = resolve; }); },
  });
  await entered;
  deadline.abort();
  expect(await pending).toMatchObject({ status: 'failed', error: 'Firecrawl timed out during secret lookup; no provider request sent.' });
  resolveKey(KEY);
  await Promise.resolve();
  await Promise.resolve();
  expect(requests).toBe(0);
});

test('user cancellation covers a stuck secret backend, before any provider request', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let requests = 0;
  const deps = world(() => { requests++; return Response.json({}); });
  const pending = runFirecrawl({ url: 'https://example.com' }, { signal: controller.signal }, {
    ...deps, readKey: () => { started(); return new Promise(() => {}); },
  });
  await entered;
  controller.abort();
  expect(await pending).toMatchObject({ status: 'cancelled' });
  expect(requests).toBe(0);
});

test('post-start provider failure preserves the remote job and warns against duplicate charges', async () => {
  const deps = world(req => req.method === 'POST' ? Response.json({ id: 'paid-job' }) : new Response(KEY, { status: 503 }));
  const result = await runFirecrawl({ url: 'https://example.com' }, undefined, deps);
  expect(result).toMatchObject({ status: 'failed', jobId: 'paid-job', remoteMayContinue: true });
  expect(result.message).toContain('duplicate charges');
  expect(JSON.stringify(result)).not.toContain(KEY);
});

test('cancellation after provider accepted a crawl but before ID response reports unknown remote work', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const deps = world(async () => { started(); await new Promise(() => {}); return Response.json({}); });
  const pending = runFirecrawl({ url: 'https://example.com' }, { signal: controller.signal }, deps);
  await entered;
  controller.abort();
  const result = await pending;
  expect(result).toMatchObject({ status: 'cancelled', remoteMayContinue: true });
  expect(result.jobId).toBeUndefined();
  expect(result.message).toContain('without a job ID');
  expect(result.message).toContain('duplicate charges');
});

test('deadline after a paid start without an ID reports uncertainty instead of safe retry', async () => {
  const deadline = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const deps = world(async () => { started(); await new Promise(() => {}); return Response.json({}); });
  const pending = runFirecrawl({ url: 'https://example.com' }, undefined, { ...deps, deadlineSignal: deadline.signal });
  await entered;
  deadline.abort();
  const result = await pending;
  expect(result).toMatchObject({ status: 'failed', remoteMayContinue: true });
  expect(result.message).toContain('duplicate charges');
});
