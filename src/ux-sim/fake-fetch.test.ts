import { afterEach, describe, expect, test } from 'bun:test';
import { createFakeFetchDevice, withFakeFetchDevice } from './fake-fetch.js';
import { loadMockScenarioCatalog } from './mock-scenario-catalog.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe.serial('fake-fetch device fixtures', () => {

test('fake-fetch dispatches by exact method and URL and records request metadata', async () => {
  await withFakeFetchDevice([
    { url: 'http://daemon/v1/tasks', method: 'POST', response: (request) => Response.json({ body: request.body }, { status: 201 }) },
  ], async (device) => {
    const response = await fetch('http://daemon/v1/tasks', {
      method: 'POST', headers: { authorization: 'Bearer token' }, body: '{"title":"demo"}', redirect: 'error',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ body: '{"title":"demo"}' });
    expect(device.calls()).toEqual([{
      url: 'http://daemon/v1/tasks', method: 'POST', headers: { authorization: 'Bearer token' },
      body: '{"title":"demo"}', redirect: 'error', routeId: 'route-1', status: 201,
    }]);
  });
  expect(globalThis.fetch).toBe(originalFetch);
});

test('fake-fetch records Request redirect mode and lets explicit init override it', async () => {
  await withFakeFetchDevice([{ url: 'http://daemon/redirect', response: Response.json({ ok: true }) }], async (device) => {
    const request = new Request('http://daemon/redirect', { redirect: 'error' });
    await fetch(request);
    await fetch(request, { redirect: 'manual' });
    expect(device.calls().map((call) => call.redirect)).toEqual(['error', 'manual']);
  });
});

test('fake-fetch rejects unmatched requests, records the boundary failure, and restores after throws', async () => {
  const device = createFakeFetchDevice([{ url: '/v1/known', response: Response.json({ ok: true }) }]);
  try {
    await expect(fetch('http://daemon/v1/unknown')).rejects.toThrow('fake-fetch: no route');
    expect(device.calls()).toMatchObject([{ url: 'http://daemon/v1/unknown', routeId: null, status: null, error: 'unmatched route' }]);
  } finally {
    device.restore();
  }
  expect(globalThis.fetch).toBe(originalFetch);
  await expect(withFakeFetchDevice([{ url: '/v1/known', response: Response.json({ ok: true }) }], async () => {
    throw new Error('scenario failed');
  })).rejects.toThrow('scenario failed');
  expect(globalThis.fetch).toBe(originalFetch);
});

test('fake-fetch records and rethrows route response failures', async () => {
  await withFakeFetchDevice([{ url: '/v1/failure', response: () => { throw new Error('fixture failed'); } }], async (device) => {
    await expect(fetch('http://daemon/v1/failure')).rejects.toThrow('fixture failed');
    expect(device.calls()).toMatchObject([{ routeId: 'route-1', status: null, error: 'fixture failed' }]);
  });
  expect(globalThis.fetch).toBe(originalFetch);
});

test('fake-fetch route handlers receive AbortSignal without persisting it in call receipts', async () => {
  const controller = new AbortController();
  await withFakeFetchDevice([{
    url: '/cancel-aware',
    response: (request) => {
      expect(request.signal).toBe(controller.signal);
      return Response.json({ aborted: request.signal?.aborted ?? false });
    },
  }], async (device) => {
    const response = await fetch('http://daemon/cancel-aware', { signal: controller.signal });
    expect(await response.json()).toEqual({ aborted: false });
    expect(device.calls()).toEqual([{
      url: 'http://daemon/cancel-aware', method: 'GET', headers: {}, body: null, routeId: 'route-1', status: 200,
    }]);
  });
});

test('fake-fetch rejects overlapping devices without changing the active device', async () => {
  const active = createFakeFetchDevice([{ url: '/active', response: Response.json({ ok: true }) }]);
  try {
    await expect(withFakeFetchDevice([{ url: '/nested', response: Response.json({ ok: true }) }], async () => {
      throw new Error('callback must not start');
    })).rejects.toThrow('overlapping devices');
    expect(await (await fetch('http://daemon/active')).json()).toEqual({ ok: true });
  } finally {
    active.restore();
  }
  expect(globalThis.fetch).toBe(originalFetch);
});

test('fake-fetch queues concurrent leases and releases the queue after callback failures', async () => {
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const order: string[] = [];
  let firstStarted = false;
  let secondStarted = false;
  let thirdStarted = false;
  const first = withFakeFetchDevice([{ url: '/first', response: Response.json({ ok: true }) }], async (device) => {
    firstStarted = true;
    order.push('first');
    await firstMayFinish;
    await fetch('http://daemon/first');
    expect(device.calls()).toMatchObject([{ routeId: 'route-1', status: 200 }]);
  });
  await Bun.sleep(0);
  expect(firstStarted).toBe(true);
  const second = withFakeFetchDevice([{ url: '/second', response: Response.json({ ok: true }) }], async (device) => {
    secondStarted = true;
    order.push('second');
    await fetch('http://daemon/second');
    expect(device.calls()).toMatchObject([{ routeId: 'route-1', status: 200 }]);
  });
  const third = withFakeFetchDevice([{ url: '/third', response: Response.json({ ok: true }) }], async (device) => {
    thirdStarted = true;
    order.push('third');
    await fetch('http://daemon/third');
    expect(device.calls()).toMatchObject([{ routeId: 'route-1', status: 200 }]);
  });
  await Bun.sleep(0);
  expect(secondStarted).toBe(false);
  expect(thirdStarted).toBe(false);
  releaseFirst();
  await Promise.all([first, second, third]);
  expect(secondStarted).toBe(true);
  expect(thirdStarted).toBe(true);
  expect(order).toEqual(['first', 'second', 'third']);

  let releaseFailure!: () => void;
  const failureMayFinish = new Promise<void>((resolve) => { releaseFailure = resolve; });
  const failure = withFakeFetchDevice([{ url: '/throws', response: Response.json({ ok: true }) }], async () => {
    await failureMayFinish;
    throw new Error('scenario failed');
  });
  await Bun.sleep(0);
  let afterFailureStarted = false;
  const waitingAfterFailure = withFakeFetchDevice([{ url: '/after-failure', response: Response.json({ ok: true }) }], async (device) => {
    afterFailureStarted = true;
    await fetch('http://daemon/after-failure');
    expect(device.calls()).toMatchObject([{ routeId: 'route-1', status: 200 }]);
  });
  await Bun.sleep(0);
  expect(afterFailureStarted).toBe(false);
  releaseFailure();
  await expect(failure).rejects.toThrow('scenario failed');
  await waitingAfterFailure;
  expect(afterFailureStarted).toBe(true);
  expect(globalThis.fetch).toBe(originalFetch);
});

test('fake-fetch honors Request init header replacement and records binary and form bodies', async () => {
  const request = new Request('http://daemon/body', { method: 'POST', headers: { 'x-old': 'old' }, body: 'old body' });
  const form = new FormData();
  form.set('title', 'demo');
  form.set('multiline', 'first line\r\nsecond line');
  form.set('file', new File([new Uint8Array([1])], 'fixture.bin', { type: 'application/octet-stream' }));
  const binary = new Uint8Array([1, 2, 3]);
  await withFakeFetchDevice([{ url: '/body', method: 'POST', response: (call) => Response.json(call) }], async (device) => {
    await fetch(request, { headers: { 'x-new': 'new' }, body: form });
    await fetch('http://daemon/body', { method: 'POST', body: binary });
    await fetch('http://daemon/body', { method: 'POST', body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('stream')); controller.close(); } }), duplex: 'half' } as RequestInit);
    const calls = device.calls();
    expect(calls[0]?.headers).toEqual({ 'content-type': expect.stringContaining('multipart/form-data; boundary='), 'x-new': 'new' });
    expect(calls[0]?.body).toContain('form-data:');
    const formBody = JSON.parse(calls[0]!.body!.slice('form-data:'.length)) as unknown[];
    expect(formBody).toContainEqual(['multiline', 'first line\r\nsecond line']);
    expect(formBody).toContainEqual(['file', {
      name: 'fixture.bin', type: 'application/octet-stream', base64: 'AQ==',
    }]);
    expect(Buffer.from(calls[0]!.wireBodyBase64!, 'base64').toString('latin1')).toContain('Content-Type: application/octet-stream');
    expect(calls[1]?.body).toBe('base64:AQID');
    expect(calls[2]?.body).toBe('stream:base64:c3RyZWFt');
  });
});

test('fake-fetch preserves content-type-free Request bytes and text Blob callback bodies', async () => {
  const request = new Request('http://daemon/body', { method: 'POST', body: new Uint8Array([0xff, 0x00]) });
  await withFakeFetchDevice([{ url: '/body', method: 'POST', response: (call) => Response.json({ body: call.body }) }], async (device) => {
    await fetch(request);
    await fetch('http://daemon/body', { method: 'POST', body: new Blob(['plain blob']) });
    await fetch(new Request('http://daemon/body', { method: 'POST', body: new Uint8Array([0xef, 0xbb, 0xbf, 0x41]) }));
    await fetch('http://daemon/body', { method: 'POST', body: new Blob([new Uint8Array([0xff, 0x00])], { type: 'application/octet-stream' }) });
    await fetch('http://daemon/body', { method: 'POST', body: new Blob([new Uint8Array([0xff, 0x00])], { type: 'text/plain' }) });
    await fetch('http://daemon/body', { method: 'POST', body: new Blob(['{"x":"\u007f"}'], { type: 'application/json' }) });
    await fetch('http://daemon/body', { method: 'POST', body: new Blob([new Uint8Array([0xff])], { type: 'application/json' }) });
    await fetch('http://daemon/body', { method: 'POST', body: new Blob(['script\u007f'], { type: 'application/javascript' }) });
    await fetch('http://daemon/body', { method: 'POST', body: new Blob(['untyped\u007f']) });
    expect(device.calls()[0]?.body).toBe('base64:/wA=');
    expect(device.calls()[1]?.body).toBe('plain blob');
    expect(device.calls()[2]?.body).toBe('\uFEFFA');
    expect(device.calls()[3]?.body).toBe('blob:application/octet-stream:base64:/wA=');
    expect(device.calls()[4]?.body).toBe('blob:text/plain;charset=utf-8:base64:/wA=');
    expect(device.calls()[5]?.body).toBe('{"x":"\u007f"}');
    expect(device.calls()[6]?.body).toBe('blob:application/json;charset=utf-8:base64:/w==');
    expect(device.calls()[7]?.body).toBe('script\u007f');
    expect(device.calls()[8]?.body).toBe('untyped\u007f');
  });
});

test('fake-fetch Blob recording matches native Request content type and bytes across MIME edge cases', async () => {
  const cases = [
    {
      name: 'empty MIME keeps a UTF-8 BOM as text',
      type: '',
      bytes: [0xef, 0xbb, 0xbf, 0x41],
      contentType: null,
      recordedBody: '\uFEFFA',
    },
    {
      name: 'text MIME with invalid UTF-8 retains normalized type and bytes',
      type: 'text/plain',
      bytes: [0xff, 0x00],
      contentType: 'text/plain;charset=utf-8',
      recordedBody: 'blob:text/plain;charset=utf-8:base64:/wA=',
    },
    {
      name: 'JSON text preserves DEL',
      type: 'application/json',
      bytes: [0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0x7f, 0x22, 0x7d],
      contentType: 'application/json;charset=utf-8',
      recordedBody: '{"x":"\u007f"}',
    },
    {
      name: 'JavaScript MIME normalization preserves valid text with DEL',
      type: 'application/javascript',
      bytes: [0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x7f],
      contentType: 'text/javascript;charset=utf-8',
      recordedBody: 'script\u007f',
    },
    {
      name: 'octet stream records binary bytes',
      type: 'application/octet-stream',
      bytes: [0xff],
      contentType: 'application/octet-stream',
      recordedBody: 'blob:application/octet-stream:base64:/w==',
    },
    {
      name: 'empty MIME binary still records exact bytes',
      type: '',
      bytes: [0xff],
      contentType: null,
      recordedBody: 'blob::base64:/w==',
    },
  ] as const;

  await withFakeFetchDevice([{ url: '/blob-compat', method: 'POST', response: Response.json({ ok: true }) }], async (device) => {
    for (const item of cases) {
      const blob = new Blob([new Uint8Array(item.bytes)], { type: item.type });
      const nativeRequest = new Request('http://daemon/blob-compat', { method: 'POST', body: blob });
      expect(nativeRequest.headers.get('content-type'), item.name).toBe(item.contentType);
      expect([...new Uint8Array(await nativeRequest.clone().arrayBuffer())], item.name).toEqual([...item.bytes]);

      await fetch('http://daemon/blob-compat', { method: 'POST', body: blob });
      expect(device.calls().at(-1)?.headers['content-type'] ?? null, item.name).toBe(item.contentType);
      expect(device.calls().at(-1)?.body, item.name).toBe(item.recordedBody);
    }
  });
});

test('fake-fetch blocks preconnect instead of forwarding it to the real fetch', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  let calls = 0;
  const originalWithPreconnect = Object.assign(async () => new Response(), { preconnect: () => { calls++; } }) as typeof fetch;
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: originalWithPreconnect });
  const device = createFakeFetchDevice([{ url: '/ok', response: Response.json({ ok: true }) }]);
  try {
    expect(() => (globalThis.fetch as typeof fetch & { preconnect?: () => void }).preconnect?.()).toThrow('preconnect is blocked');
    expect(calls).toBe(0);
  } finally {
    device.restore();
    if (originalDescriptor) Object.defineProperty(globalThis, 'fetch', originalDescriptor);
  }
});

test('fake-fetch is registered for the shared core and PWA test adapter', () => {
  const catalog = loadMockScenarioCatalog();
  const device = catalog.devices.find((entry) => entry.id === 'fake-fetch');
  expect(device?.implementation).toEqual(['src/ux-sim/fake-fetch.ts', 'apps/pwa/src/test-devices/fake-fetch.ts']);
  expect(device?.tests).toContain('src/ux-sim/fake-fetch.test.ts');
  expect(catalog.sourceModules.find((module) => module.path === 'src/ux-sim/fake-fetch.ts')?.deviceIds).toContain('fake-fetch');
});

});
