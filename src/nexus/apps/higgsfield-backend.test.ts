import { expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { createAppActions } from './app-actions.js';
import { createAppJobsGenerateAction, type AppGenerationBackend } from './app-jobs.js';
import { createHiggsfieldAppBackend, downloadHiggsfieldResult, higgsfieldCliSessionCredentialForApp,
  resolveHiggsfieldAppCredentialForApp } from './higgsfield-backend.js';
import { createHiggsfieldCliSessionBackend } from './higgsfield-cli-session.js';

test('SIM-FAKE-HIGGSFIELD: app backend uploads with a signed URL and submits/polls with only that app key', async () => {
  const requests: Array<{ url: string; method: string; headers: Headers; body?: BodyInit | null }> = [];
  const fakeFetch = async (url: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const requestUrl = String(url);
    const headers = new Headers(init.headers);
    requests.push({ url: requestUrl, method: init.method ?? 'GET', headers, body: init.body });
    if (requestUrl.endsWith('/files/generate-upload-url')) {
      return Response.json({ upload_url: 'https://storage.fake.invalid/upload/1', upload_headers: { 'x-sim-token': 'signed-only' }, public_url: 'https://storage.fake.invalid/media/1.png' });
    }
    if (requestUrl === 'https://storage.fake.invalid/upload/1') return new Response(null, { status: 200 });
    if (requestUrl.endsWith('/bytedance/seedance-2.0/image-to-video')) return Response.json({ request_id: 'fake-request-1' }, { status: 202 });
    if (requestUrl.endsWith('/requests/fake-request-1/status')) return Response.json({ status: 'completed', video: { url: 'https://storage.fake.invalid/result.mp4' } });
    throw new Error(`unexpected external URL: ${requestUrl}`);
  };
  const backend = createHiggsfieldAppBackend({ keyId: 'sim-key-id', secret: 'sim-key-secret' }, { fetch: fakeFetch });

  const requestId = await backend.submit({ prompt: 'make a product video', image: new Uint8Array([1, 2, 3]), mimeType: 'image/png' });
  expect(requestId).toBe('fake-request-1');
  await expect(backend.poll(requestId)).resolves.toEqual({ status: 'completed', resultUrl: 'https://storage.fake.invalid/result.mp4' });
  expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
    ['POST', '/files/generate-upload-url'], ['PUT', '/upload/1'],
    ['POST', '/bytedance/seedance-2.0/image-to-video'], ['GET', '/requests/fake-request-1/status'],
  ]);
  expect(requests[0]!.headers.get('authorization')).toBe('Key sim-key-id:sim-key-secret');
  expect(requests[1]!.headers.get('authorization')).toBeNull();
  expect(requests[1]!.headers.get('x-sim-token')).toBe('signed-only');
  expect(requests.filter(request => new URL(request.url).origin === 'https://api.higgsfield.ai')
    .every(request => request.headers.get('authorization') === 'Key sim-key-id:sim-key-secret')).toBe(true);
  expect(JSON.parse(String(requests[2]!.body))).toEqual({
    prompt: 'make a product video', image_url: 'https://storage.fake.invalid/media/1.png',
  });
});

test('SIM-FAKE-HIGGSFIELD: app backend rejects an unsafe signed upload URL before uploading image bytes', async () => {
  const urls: string[] = [];
  const backend = createHiggsfieldAppBackend({ keyId: 'sim-id', secret: 'sim-secret' }, {
    fetch: async url => {
      urls.push(String(url));
      return Response.json({ upload_url: 'http://127.0.0.1/admin', upload_headers: {}, public_url: 'https://cdn.fake.invalid/image.png' });
    },
  });
  await expect(backend.submit({ prompt: 'test', image: new Uint8Array([7]), mimeType: 'image/png' })).rejects.toThrow('upload URL is unsafe');
  expect(urls).toHaveLength(1);
});

test('SIM-FAKE-HIGGSFIELD: result download accepts only bounded video content from Higgsfield CDN hosts', async () => {
  let calls = 0;
  const fetcher = async (): Promise<Response> => {
    calls += 1;
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4', 'content-length': '3' } });
  };
  await expect(downloadHiggsfieldResult('https://cdn.fake.invalid/result.mp4', 10, fetcher)).rejects.toThrow('result host is unsafe');
  await expect(downloadHiggsfieldResult('https://media.higgsfield.ai/result.mp4', 2, fetcher)).resolves.toBeUndefined();
  await expect(downloadHiggsfieldResult('https://media.higgsfield.ai/result.mp4', 10, fetcher)).resolves.toEqual({
    bytes: new Uint8Array([1, 2, 3]), contentType: 'video/mp4',
  });
  expect(calls).toBe(2);
});

test('SIM-FAKE-HIGGSFIELD: voice-note CLI session capability runs upload, product, video, and poll without key material', async () => {
  const calls: string[][] = [];
  let uploadedFile: string | undefined;
  const backend = createHiggsfieldAppBackend({
    appSlug: 'voice-note',
    keyId: higgsfieldCliSessionCredentialForApp('voice-note', 'cred:higgsfield.key_id')!,
    secret: higgsfieldCliSessionCredentialForApp('voice-note', 'cred:higgsfield.secret')!,
  }, { cliSession: { runner: { async run(argv) {
    calls.push([...argv]);
    if (argv[0] === 'upload') {
      uploadedFile = argv[2];
      expect(await Bun.file(uploadedFile!).exists()).toBe(true);
      expect(statSync(uploadedFile!).mode & 0o777).toBe(0o600);
      return { exitCode: 0, stdout: JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', type: 'image', url: 'https://cdn.higgsfield.ai/test.png' }) };
    }
    if (argv[0] === 'marketing-studio') {
      return { exitCode: 0, stdout: JSON.stringify({ id: '22222222-2222-4222-8222-222222222222', status: 'completed' }) };
    }
    if (argv[0] === 'generate' && argv[1] === 'create') {
      return { exitCode: 0, stdout: JSON.stringify(['33333333-3333-4333-8333-333333333333']) };
    }
    if (argv[0] === 'generate' && argv[1] === 'get') {
      return { exitCode: 0, stdout: JSON.stringify({ id: argv[2], status: 'completed', result_url: 'https://media.higgsfield.ai/result.mp4' }) };
    }
    throw new Error('unexpected command');
  } } } });

  const jobId = await backend.submit({ prompt: 'product showcase', image: new Uint8Array([1, 2, 3]), mimeType: 'image/png' });
  await expect(backend.poll(jobId)).resolves.toEqual({ status: 'completed', resultUrl: 'https://media.higgsfield.ai/result.mp4' });

  const uploadedFilePath = uploadedFile;
  if (!uploadedFilePath) throw new Error('fake upload did not capture its temporary path');
  expect(calls.map(argv => argv.slice(0, 3))).toEqual([
    ['upload', 'create', uploadedFilePath],
    ['marketing-studio', 'products', 'create'],
    ['generate', 'create', 'marketing_studio_video'],
    ['generate', 'get', '33333333-3333-4333-8333-333333333333'],
  ]);
  const createVideo = calls[2]!;
  expect(createVideo).toContain('--mode');
  expect(createVideo[createVideo.indexOf('--mode') + 1]).toBe('product_showcase');
  expect(JSON.parse(createVideo[createVideo.indexOf('--product-ids') + 1]!)).toEqual(['22222222-2222-4222-8222-222222222222']);
  expect(createVideo.join(' ')).not.toContain('internal:cli-session:voice-note');
  expect(await Bun.file(uploadedFile!).exists()).toBe(false);
});

test('SIM-FAKE-HIGGSFIELD: CLI session capability is restricted to voice-note and cannot bypass spend opt-in directly', async () => {
  const keyId = higgsfieldCliSessionCredentialForApp('voice-note', 'cred:higgsfield.key_id');
  const secret = higgsfieldCliSessionCredentialForApp('voice-note', 'cred:higgsfield.secret');
  expect(keyId).toBeDefined();
  expect(secret).toBe(keyId);
  expect(higgsfieldCliSessionCredentialForApp('another-app', 'cred:higgsfield.key_id')).toBeUndefined();
  expect(higgsfieldCliSessionCredentialForApp('voice-note', 'cred:openai.api_key')).toBeUndefined();
  expect(() => createHiggsfieldCliSessionBackend({ appSlug: 'other-app' as never })).toThrow('not enabled for this app');
  expect(() => createHiggsfieldAppBackend({ appSlug: 'another-app', keyId: 'internal:cli-session:voice-note', secret: 'internal:cli-session:voice-note' }))
    .toThrow('in-memory app capability');
  expect(() => createHiggsfieldAppBackend({ appSlug: 'another-app', keyId: keyId!, secret: secret! }))
    .toThrow('not authorized for this app');
  expect(() => createHiggsfieldAppBackend({ keyId: keyId!, secret: secret! })).toThrow('not authorized for this app');
  let calls = 0;
  const backend = createHiggsfieldCliSessionBackend({ appSlug: 'voice-note', allowSpend: false,
    runner: { async run() { calls += 1; return { stdout: '', exitCode: 0 }; } } });
  await expect(backend.submit({ prompt: 'test', image: new Uint8Array([1]), mimeType: 'image/png' }))
    .rejects.toThrow('spending is disabled');
  expect(calls).toBe(0);
});

test('SIM-FAKE-HIGGSFIELD: failed upload removes its private temporary image', async () => {
  let uploadedFile = '';
  const capability = higgsfieldCliSessionCredentialForApp('voice-note', 'cred:higgsfield.key_id')!;
  const backend = createHiggsfieldAppBackend({ appSlug: 'voice-note', keyId: capability, secret: capability }, {
    cliSession: { runner: { async run(argv) {
      uploadedFile = argv[2]!;
      expect(statSync(uploadedFile).mode & 0o777).toBe(0o600);
      throw new Error('fake provider failure');
    } } },
  });
  await expect(backend.submit({ prompt: 'test product', image: new Uint8Array([1]), mimeType: 'image/png' }))
    .rejects.toThrow('Higgsfield CLI image upload failed');
  expect(uploadedFile).not.toBe('');
  expect(await Bun.file(uploadedFile).exists()).toBe(false);
});

test('SIM-FAKE-HIGGSFIELD: secret resolver grants one opaque voice-note capability, rejects partial keys, and routes the real action path', async () => {
  const stored = new Map<string, string>();
  const storedValue = (appSlug: string, field: string) => stored.get(`${appSlug}:${field}`);
  const resolve = async (appSlug: string, reference: string) => {
    const resolution = await resolveHiggsfieldAppCredentialForApp(appSlug, reference, async field => storedValue(appSlug, field));
    if (resolution.handled) return resolution.value;
    return storedValue(appSlug, reference.endsWith('.key_id') ? 'key_id' : 'secret');
  };

  stored.set('voice-note:key_id', 'voice-note-api-id');
  const partial = await resolveHiggsfieldAppCredentialForApp('voice-note', 'cred:higgsfield.secret', async field => storedValue('voice-note', field));
  expect(partial).toEqual({ handled: true });
  stored.set('voice-note:secret', 'voice-note-api-secret');
  await expect(resolve('voice-note', 'cred:higgsfield.key_id')).resolves.toBe('voice-note-api-id');
  await expect(resolve('voice-note', 'cred:higgsfield.secret')).resolves.toBe('voice-note-api-secret');
  stored.clear();

  const calls: string[][] = [];
  const keyIdCapability = await resolve('voice-note', 'cred:higgsfield.key_id');
  const secretCapability = await resolve('voice-note', 'cred:higgsfield.secret');
  expect(typeof keyIdCapability).toBe('object');
  expect(secretCapability).toBe(keyIdCapability);
  let submitPromise: Promise<string> | undefined;
  const actions = createAppActions({
    secrets: { resolve: async ({ appSlug, reference }) => resolve(appSlug, reference) },
    readImageObject: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }),
    generate: createAppJobsGenerateAction({
      jobs: { submit(input: { appSlug: string; prompt: string; image: Uint8Array; mimeType: string; backend: AppGenerationBackend; ownerConfirmed: boolean }) {
        submitPromise = input.backend.submit({ prompt: input.prompt, image: input.image, mimeType: input.mimeType });
        return { id: 'job', appSlug: input.appSlug, status: 'queued', createdAt: '', updatedAt: '' };
      }, get() { return undefined; }, close() {} } as never,
      ledger: {} as never,
      backendForCredentials(credentials) {
        const backend = createHiggsfieldAppBackend(credentials, { cliSession: { runner: { async run(argv) {
          calls.push([...argv]);
          if (argv[0] === 'upload') return { exitCode: 0, stdout: JSON.stringify({ id: '11111111-1111-4111-8111-111111111111' }) };
          if (argv[0] === 'marketing-studio') return { exitCode: 0, stdout: JSON.stringify({ id: '22222222-2222-4222-8222-222222222222', status: 'completed' }) };
          if (argv[0] === 'generate' && argv[1] === 'create') return { exitCode: 0, stdout: JSON.stringify(['33333333-3333-4333-8333-333333333333']) };
          if (argv[0] === 'generate') return { exitCode: 0, stdout: JSON.stringify({ status: 'completed', result_url: 'https://media.higgsfield.ai/result.mp4' }) };
          throw new Error('unexpected fake CLI command');
        } } } });
        return backend;
      },
    }),
  });
  await actions.run({ appSlug: 'voice-note', declaration: {
    builtin: 'generate', async: true, spend: 'owner-confirm', uses: ['cred:higgsfield.key_id', 'cred:higgsfield.secret'],
  }, payload: { text: 'test product', image: 'input.png', confirmSpend: true } });
  await expect(submitPromise).resolves.toBe('33333333-3333-4333-8333-333333333333');
  expect(calls.map(argv => argv.slice(0, argv[0] === 'upload' ? 2 : 3).join(' '))).toEqual([
    'upload create', 'marketing-studio products create', 'generate create marketing_studio_video',
  ]);

  stored.set('another-app:key_id', 'internal:cli-session:voice-note');
  stored.set('another-app:secret', 'internal:cli-session:voice-note');
  await expect(resolve('another-app', 'cred:higgsfield.key_id')).resolves.toBe('internal:cli-session:voice-note');
  await expect(resolve('another-app', 'cred:higgsfield.secret')).resolves.toBe('internal:cli-session:voice-note');
  const otherAppActions = createAppActions({
    secrets: { resolve: async ({ appSlug, reference }) => resolve(appSlug, reference) },
    readImageObject: async () => ({ bytes: new Uint8Array([1]), mimeType: 'image/png' }),
    generate: async input => {
      const backend = createHiggsfieldAppBackend(input.credentials, {
        cliSession: { runner: { async run() { throw new Error('other app must not invoke CLI'); } } },
      });
      await backend.submit({ prompt: input.prompt, image: input.image, mimeType: input.mimeType });
      return { jobId: 'unexpected', eventsUrl: '/events' };
    },
  });
  await expect(otherAppActions.run({ appSlug: 'another-app', declaration: {
    builtin: 'generate', async: true, spend: 'owner-confirm', uses: ['cred:higgsfield.key_id', 'cred:higgsfield.secret'],
  }, payload: { text: 'test product', image: 'input.png', confirmSpend: true } })).rejects.toMatchObject({ code: 'provider-failed' });
  expect(calls).toHaveLength(3);
});
