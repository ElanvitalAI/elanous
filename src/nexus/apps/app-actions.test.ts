import { expect, test } from 'bun:test';
import { createAppActions, AppActionError, handleAppActionRequest } from './app-actions.js';
import { createFakeStt } from '../../ux-sim/fake-stt.js';
import { handleAudioStt } from '../api/audio-stt.js';
import { fakeElevenLabsAudioBytes, startFakeElevenLabs } from '../../ux-sim/fake-elevenlabs.js';

const sttDeclaration = { builtin: 'stt' as const, uses: ['cred:openai.api_key'] };
const summaryDeclaration = { builtin: 'summarize' as const, uses: ['cred:openai.api_key'] };
const ttsDeclaration = { builtin: 'tts' as const, uses: ['cred:elevenlabs.api_key'] };

test('app TTS resolves only the app-attachable ElevenLabs credential and returns fake audio bytes', async () => {
  const fake = await startFakeElevenLabs({ apiKey: 'sim-elevenlabs-key' });
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    const requested = new URL(capturedUrl);
    return originalFetch(`${fake.baseUrl}${requested.pathname}${requested.search}`, init);
  }) as typeof fetch;
  try {
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
  } finally { globalThis.fetch = originalFetch; await fake.close(); }
});

test('TTS rejects provider redirects, oversized audio, and invalid voice or model before synthesis', async () => {
  const originalFetch = globalThis.fetch;
  let redirectOption: RequestRedirect | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    redirectOption = init?.redirect;
    return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/collect' } });
  }) as typeof fetch;
  try {
    const actions = createAppActions({ secrets: { async resolve() { return 'sim-key'; } } });
    await expect(actions.run({ appSlug: 'voice-note', declaration: ttsDeclaration, payload: { text: 'hello', voiceId: 'voice' } }))
      .rejects.toMatchObject({ code: 'provider-failed' });
    expect(redirectOption).toBe('error');
    await expect(actions.run({ appSlug: 'voice-note', declaration: ttsDeclaration, payload: { text: 'hello', voiceId: '../voice' } }))
      .rejects.toMatchObject({ code: 'invalid-input' });
    await expect(actions.run({ appSlug: 'voice-note', declaration: ttsDeclaration, payload: { text: 'hello', voiceId: 'voice', modelId: '../model' } }))
      .rejects.toMatchObject({ code: 'invalid-input' });
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1)); controller.close(); },
    }), { status: 200, headers: { 'content-type': 'audio/mpeg' } })) as unknown as typeof fetch;
    await expect(actions.run({ appSlug: 'voice-note', declaration: ttsDeclaration, payload: { text: 'hello', voiceId: 'voice' } }))
      .rejects.toMatchObject({ code: 'provider-failed' });
  } finally { globalThis.fetch = originalFetch; }
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
  const originalFetch = globalThis.fetch;
  let capturedFile: File | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const form = init?.body;
    if (form instanceof FormData) capturedFile = form.get('file') as File;
    return new Response(JSON.stringify({ text: 'transcribed', language: 'en', duration: 1 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const actions = createAppActions({ secrets: { async resolve() { return 'sim-key'; } } });
    await expect(actions.run({
      appSlug: 'voice-note', declaration: sttDeclaration,
      payload: { audio: Buffer.from('fake recording'), mimeType: 'audio/webm', filename: 'sample.webm' },
    })).resolves.toMatchObject({ text: 'transcribed', language: 'en' });
    expect(capturedFile?.name).toBe('sample.webm');
    expect(capturedFile?.type).toBe('audio/webm');
  } finally {
    globalThis.fetch = originalFetch;
  }
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
