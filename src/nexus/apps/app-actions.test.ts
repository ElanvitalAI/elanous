import { expect, test } from 'bun:test';
import { withFakeFetchDevice } from '../../ux-sim/fake-fetch.js';
import { createAppActions, AppActionError, handleAppActionRequest } from './app-actions.js';
import { createFakeStt } from '../../ux-sim/fake-stt.js';
import { handleAudioStt } from '../api/audio-stt.js';
import { fakeElevenLabsAudioBytes, startFakeElevenLabs } from '../../ux-sim/fake-elevenlabs.js';

const sttDeclaration = { builtin: 'stt' as const, uses: ['cred:openai.api_key'] };
const summaryDeclaration = { builtin: 'summarize' as const, uses: ['cred:openai.api_key'] };
const ttsDeclaration = { builtin: 'tts' as const, uses: ['cred:elevenlabs.api_key'] };
const generateDeclaration = { builtin: 'generate' as const, async: true, spend: 'owner-confirm', uses: ['cred:higgsfield.key_id', 'cred:higgsfield.secret'] };

test('app TTS resolves only the app-attachable ElevenLabs credential and returns fake audio bytes', async () => {
  const fake = await startFakeElevenLabs({ apiKey: 'sim-elevenlabs-key' });
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  try {
    await withFakeFetchDevice([{ url: '/v1/text-to-speech/fake-voice', method: 'POST', response: async (request) => {
    capturedUrl = request.url;
    capturedInit = { method: request.method, headers: request.headers, body: request.body, redirect: request.redirect };
    const requested = new URL(capturedUrl);
    return originalFetch(`${fake.baseUrl}${requested.pathname}${requested.search}`, { ...capturedInit, body: request.body ?? undefined });
  } }], async (device) => {
    const actions = createAppActions({
      secrets: { async resolve({ appSlug, reference }) {
        expect(appSlug).toBe('voice-note');
        expect(reference).toBe('cred:elevenlabs.api_key');
        return 'sim-elevenlabs-key';
      } },
    });
    const result = await actions.run({ appSlug: 'voice-note', declaration: ttsDeclaration, payload: { text: 'hello', voiceId: 'fake-voice' } });
    expect(result).toEqual({ audioBase64: fakeElevenLabsAudioBytes('hello').toString('base64'), mimeType: 'audio/pcm' });
    expect(capturedUrl).toBe('https://api.elevenlabs.io/v1/text-to-speech/fake-voice?output_format=mp3_44100_128');
    expect(capturedInit?.redirect).toBe('error');
    expect(new Headers(capturedInit?.headers).get('xi-api-key')).toBe('sim-elevenlabs-key');
    expect(JSON.parse(String(capturedInit?.body))).toEqual({ text: 'hello', model_id: 'eleven_v3' });
    expect(fake.requests()).toEqual([{ method: 'POST', path: '/v1/text-to-speech/fake-voice?output_format=mp3_44100_128', text: 'hello', status: 200 }]);
    expect(JSON.stringify(result)).not.toContain('sim-elevenlabs-key');
    expect(device.calls()).toHaveLength(1);
    });
  } finally { await fake.close(); }
});

test('TTS rejects provider redirects, oversized audio, and invalid voice or model before synthesis', async () => {
  let redirectOption: RequestRedirect | undefined;
  let ttsCalls = 0;
  await withFakeFetchDevice([{ url: '/v1/text-to-speech/voice', method: 'POST', response: (request) => {
    redirectOption = request.redirect;
    ttsCalls++;
    return ttsCalls === 1
      ? new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/collect' } })
      : new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1)); controller.close(); } }), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  } }], async (device) => {
    const actions = createAppActions({ secrets: { async resolve() { return 'sim-key'; } } });
    await expect(actions.run({ appSlug: 'voice-note', declaration: ttsDeclaration, payload: { text: 'hello', voiceId: 'voice' } }))
      .rejects.toMatchObject({ code: 'provider-failed' });
    expect(redirectOption).toBe('error');
    await expect(actions.run({ appSlug: 'voice-note', declaration: ttsDeclaration, payload: { text: 'hello', voiceId: '../voice' } }))
      .rejects.toMatchObject({ code: 'invalid-input' });
    await expect(actions.run({ appSlug: 'voice-note', declaration: ttsDeclaration, payload: { text: 'hello', voiceId: 'voice', modelId: '../model' } }))
      .rejects.toMatchObject({ code: 'invalid-input' });
    await expect(actions.run({ appSlug: 'voice-note', declaration: ttsDeclaration, payload: { text: 'hello', voiceId: 'voice' } }))
      .rejects.toMatchObject({ code: 'provider-failed' });
    expect(device.calls()).toHaveLength(2);
  });
});

test('app STT action resolves a manifest credential through the boundary and uses fake STT', async () => {
  const fake = createFakeStt();
  const resolved: Array<{ appSlug: string; reference: string }> = [];
  const actions = createAppActions({
    secrets: { async resolve(input) { resolved.push(input); return 'sim-only-secret'; } },
    transcribe: async ({ audio, language }) => fake.transcribe({ audio, ...(language ? { language: language as 'ko' | 'en' } : {}) }),
  });
  const result = await actions.run({ appSlug: 'voice-note', declaration: sttDeclaration, payload: { audio: Buffer.from('fake-stt-contract-audio'), mimeType: 'audio/webm', filename: 'sample.webm' } });
  expect(result).toMatchObject({ text: '\uC548\uB155\uD558\uC138\uC694', language: 'ko' });
  expect(resolved).toEqual([{ appSlug: 'voice-note', reference: 'cred:openai.api_key' }]);
  expect(JSON.stringify(result)).not.toContain('sim-only-secret');
});

test('summarize action uses injected provider and never returns credential material', async () => {
  const actions = createAppActions({
    secrets: { async resolve() { return 'sim-only-secret'; } },
    summarize: async ({ text, apiKey }) => {
      expect(apiKey).toBe('sim-only-secret');
      return `summary: ${text}`;
    },
  });
  await expect(actions.run({ appSlug: 'voice-note', declaration: summaryDeclaration, payload: { text: 'meeting is Friday.' } }))
    .resolves.toEqual({ text: 'summary: meeting is Friday.' });
});

test('generate prompt limit does not narrow the existing summarize input limit', async () => {
  const largeText = 'x'.repeat(9_000);
  let summarized = false;
  const actions = createAppActions({
    secrets: { async resolve() { return 'sim-only-secret'; } },
    summarize: async ({ text }) => { summarized = text.length === largeText.length; return 'ok'; },
    readImageObject: async () => ({ bytes: new Uint8Array([1]), mimeType: 'image/png' }),
    generate: async () => ({ jobId: '00000000-0000-4000-8000-000000000002', eventsUrl: '/events' }),
  });
  await expect(actions.run({ appSlug: 'voice-note', declaration: summaryDeclaration, payload: { text: largeText } })).resolves.toEqual({ text: 'ok' });
  expect(summarized).toBe(true);
  await expect(actions.run({
    appSlug: 'voice-note', declaration: generateDeclaration,
    payload: { text: largeText, image: 'products/input.png', confirmSpend: true },
  })).rejects.toMatchObject({ code: 'invalid-input' });
});

test('invalid declarations and provider failures fail closed without exposing secret or provider text', async () => {
  const actions = createAppActions({
    secrets: { async resolve() { return 'sim-only-secret'; } },
    summarize: async () => { throw new Error('Bearer sim-only-secret leaked by provider'); },
  });
  await expect(actions.run({ appSlug: 'voice-note', declaration: { builtin: 'stt', uses: ['cred:elevenlabs.api_key'] }, payload: { audio: Buffer.from('x') } }))
    .rejects.toBeInstanceOf(AppActionError);
  await expect(actions.run({ appSlug: 'voice-note', declaration: summaryDeclaration, payload: { text: 'some text' } }))
    .rejects.toMatchObject({ code: 'provider-failed' });
  await expect(actions.run({ appSlug: 'voice-note', declaration: sttDeclaration, payload: { audio: Buffer.alloc(0) } }))
    .rejects.toMatchObject({ code: 'invalid-input' });
});

test('default app STT forwards the declared file metadata through a mocked HTTP boundary', async () => {
  let multipartWire = '';
  let multipartBoundary = '';
  await withFakeFetchDevice([{ url: 'https://api.openai.com/v1/audio/transcriptions', method: 'POST', response: (request) => {
    multipartWire = Buffer.from(request.wireBodyBase64 ?? '', 'base64').toString('latin1');
    multipartBoundary = request.headers['content-type']?.match(/boundary=([^;]+)/)?.[1] ?? '';
    return new Response(JSON.stringify({ text: 'transcribed', language: 'en', duration: 1 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  } }], async (device) => {
    const actions = createAppActions({ secrets: { async resolve() { return 'sim-key'; } } });
    await expect(actions.run({
      appSlug: 'voice-note', declaration: sttDeclaration,
      payload: { audio: Buffer.from('fake recording'), mimeType: 'audio/webm', filename: 'sample.webm' },
    })).resolves.toMatchObject({ text: 'transcribed', language: 'en' });
    expect(multipartBoundary).not.toBe('');
    const filePart = multipartWire.split(`--${multipartBoundary}`).find((part) => part.includes('name="file"')) ?? '';
    expect(filePart).toContain('filename="sample.webm"');
    expect(filePart).toContain('Content-Type: audio/webm');
    expect(filePart).toContain('fake recording');
    expect(device.calls()).toHaveLength(1);
  });
});

test('manifest action HTTP route authorizes and dispatches through the app action executor', async () => {
  let calls = 0;
  const actions = createAppActions({
    secrets: { async resolve() { return 'sim-only-secret'; } },
    summarize: async ({ text }) => { calls++; return `summary: ${text}`; },
  });
  const response = await handleAppActionRequest(new Request('http://localhost/v1/apps/voice-note/actions/summarize', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'meeting notes' }),
  }), {
    authorize: async (_request, slug) => slug === 'voice-note',
    getDeclaration: async (_slug, name) => name === 'summarize' ? summaryDeclaration : undefined,
    run: async input => actions.run(input),
  });
  expect(response?.status).toBe(200);
  await expect(response?.json()).resolves.toEqual({ ok: true, text: 'summary: meeting notes' });
  expect(calls).toBe(1);
});

test('generate action requires per-request owner confirmation, resolves only app Higgsfield credentials, and returns a queued job', async () => {
  const resolved: string[] = [];
  const generated: unknown[] = [];
  const actions = createAppActions({
    secrets: { async resolve({ appSlug, reference }) {
      expect(appSlug).toBe('shop-studio');
      resolved.push(reference);
      return reference.endsWith('key_id') ? 'sim-key-id' : 'sim-key-secret';
    } },
    readImageObject: async ({ reference }) => reference === 'products/input.png' ? { bytes: new Uint8Array([1, 2]), mimeType: 'image/png' } : undefined,
    generate: async input => { generated.push(input); return { jobId: '00000000-0000-4000-8000-000000000001', eventsUrl: '/v1/apps/shop-studio/jobs/00000000-0000-4000-8000-000000000001/events' }; },
  });
  const input = { appSlug: 'shop-studio', declaration: generateDeclaration, payload: { text: 'Make a product clip', image: 'products/input.png' } };
  await expect(actions.run(input)).rejects.toMatchObject({ code: 'invalid-input' });
  expect(resolved).toEqual([]);
  const result = await actions.run({ ...input, payload: { ...input.payload, confirmSpend: true } });
  expect(result).toEqual({
    jobId: '00000000-0000-4000-8000-000000000001', status: 'queued',
    eventsUrl: '/v1/apps/shop-studio/jobs/00000000-0000-4000-8000-000000000001/events',
  });
  expect(resolved).toEqual(['cred:higgsfield.key_id', 'cred:higgsfield.secret']);
  expect(generated).toEqual([expect.objectContaining({ prompt: 'Make a product clip', mimeType: 'image/png', credentials: { appSlug: 'shop-studio', keyId: 'sim-key-id', secret: 'sim-key-secret' } })]);
  expect(JSON.stringify(result)).not.toContain('sim-key-secret');
});

test('generate declaration HTTP route returns 202 and does not expose credentials', async () => {
  const response = await handleAppActionRequest(new Request('http://localhost/v1/apps/shop-studio/actions/makeAd', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'clip', image: 'products/input.png', confirmSpend: true }),
  }), {
    authorize: async () => true,
    getDeclaration: async () => generateDeclaration,
    run: async input => {
      expect(input.actionName).toBe('makeAd');
      return { jobId: '00000000-0000-4000-8000-000000000001', status: 'queued', eventsUrl: '/events' };
    },
  });
  expect(response?.status).toBe(202);
  await expect(response?.json()).resolves.toEqual({ ok: true, jobId: '00000000-0000-4000-8000-000000000001', status: 'queued', eventsUrl: '/events' });
});
test('audio STT missing provider key retains provider-config 500', async () => {
  const original = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const form = new FormData();
    form.set('file', new Blob([Buffer.from('sample')], { type: 'audio/webm' }), 'sample.webm');
    const response = await handleAudioStt(new Request('http://localhost/v1/audio/stt', { method: 'POST', body: form }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: 'provider-config' });
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  }
});
