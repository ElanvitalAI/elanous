// R6 FU.2 · §6.3 audio bridge — daemon endpoint coverage (2026-05-09).
//
// Validation + provider routing + CORS preflight all run in-process.
// The actual provider call is exercised via fetch stub on globalThis;
// the live OpenAI Whisper round-trip is observational (manual smoke).

import { afterEach, describe, expect, test } from 'bun:test';
import {
  handleAudioStt,
  resolveAudioSttProviderId,
} from '../src/nexus/api/audio-stt.js';
import { createFakeFetchDevice, type FakeFetchDevice } from '../src/ux-sim/fake-fetch.js';

let fetchDevice: FakeFetchDevice | undefined;
afterEach(() => {
  fetchDevice?.restore();
  fetchDevice = undefined;
  delete process.env.ELANOUS_AUDIO_STT_PROVIDER;
});

function multipartBody(parts: Array<{
  name: string;
  value: string | { bytes: Uint8Array; filename: string; type: string };
}>): { body: Buffer; contentType: string } {
  const boundary = '----testboundary' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (typeof p.value === 'string') {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`,
      ));
    } else {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${p.name}"; filename="${p.value.filename}"\r\n` +
        `Content-Type: ${p.value.type}\r\n\r\n`,
      ));
      chunks.push(Buffer.from(p.value.bytes));
      chunks.push(Buffer.from(`\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('resolveAudioSttProviderId', () => {
  test('default = openai-whisper', () => {
    expect(resolveAudioSttProviderId({})).toBe('openai-whisper');
  });
  test('opts override > default', () => {
    expect(resolveAudioSttProviderId({ providerId: 'whisper-cpp' })).toBe('whisper-cpp');
  });
  test('env override > opts', () => {
    process.env.ELANOUS_AUDIO_STT_PROVIDER = 'elevenlabs-scribe';
    expect(resolveAudioSttProviderId({ providerId: 'whisper-cpp' })).toBe('elevenlabs-scribe');
  });
  test('invalid env → fallback to opts/default', () => {
    process.env.ELANOUS_AUDIO_STT_PROVIDER = 'made-up';
    expect(resolveAudioSttProviderId({})).toBe('openai-whisper');
  });
});

describe('handleAudioStt · auth + method', () => {
  test('OPTIONS → 204 + CORS preflight headers', async () => {
    const res = await handleAudioStt(new Request('http://x/v1/audio/stt', { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });
  test('GET → 405', async () => {
    const res = await handleAudioStt(new Request('http://x/v1/audio/stt'));
    expect(res.status).toBe(405);
  });
  test('checkAuth=false → 401 (auth runs after OPTIONS but before POST)', async () => {
    const res = await handleAudioStt(
      new Request('http://x/v1/audio/stt', { method: 'POST' }),
      { checkAuth: () => false },
    );
    expect(res.status).toBe(401);
  });
});

describe('handleAudioStt · multipart validation', () => {
  test('non-multipart body → 400', async () => {
    const res = await handleAudioStt(new Request('http://x/v1/audio/stt', {
      method: 'POST',
      body: 'not multipart',
      headers: { 'content-type': 'application/json' },
    }));
    expect(res.status).toBe(400);
  });
  test('missing file part → 400 file-required', async () => {
    const { body, contentType } = multipartBody([{ name: 'language', value: 'ko' }]);
    const res = await handleAudioStt(new Request('http://x/v1/audio/stt', {
      method: 'POST',
      body: new Uint8Array(body),
      headers: { 'content-type': contentType },
    }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('file-required');
  });
  test('empty file → 400 file-empty', async () => {
    const { body, contentType } = multipartBody([{
      name: 'file',
      value: { bytes: new Uint8Array(0), filename: 'empty.m4a', type: 'audio/m4a' },
    }]);
    const res = await handleAudioStt(new Request('http://x/v1/audio/stt', {
      method: 'POST',
      body: new Uint8Array(body),
      headers: { 'content-type': contentType },
    }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('file-empty');
  });
  test('unsupported provider → 501 not-implemented', async () => {
    process.env.ELANOUS_AUDIO_STT_PROVIDER = 'whisper-cpp';
    const { body, contentType } = multipartBody([{
      name: 'file',
      value: { bytes: new Uint8Array([1,2,3]), filename: 'x.m4a', type: 'audio/m4a' },
    }]);
    const res = await handleAudioStt(new Request('http://x/v1/audio/stt', {
      method: 'POST',
      body: new Uint8Array(body),
      headers: { 'content-type': contentType },
    }));
    expect(res.status).toBe(501);
    const json = (await res.json()) as { error: string; providerId: string };
    expect(json.error).toBe('provider-not-implemented');
    expect(json.providerId).toBe('whisper-cpp');
  });
});

describe('handleAudioStt · provider call (mocked fetch)', () => {
  test('happy path → 200 with text + language + duration', async () => {
    fetchDevice = createFakeFetchDevice([{ url: '/v1/audio/transcriptions', method: 'POST', response: () =>
      new Response(
        JSON.stringify({ text: '안녕하세요', language: 'ko', duration: 1.5 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) }]);
    const { body, contentType } = multipartBody([{
      name: 'file',
      value: { bytes: new Uint8Array([1,2,3,4]), filename: 'sample.m4a', type: 'audio/m4a' },
    }, { name: 'language', value: 'ko' }]);
    const res = await handleAudioStt(
      new Request('http://x/v1/audio/stt', {
        method: 'POST',
        body: new Uint8Array(body),
        headers: { 'content-type': contentType },
      }),
      { apiKey: 'sk-test-fake' },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean; text: string; language?: string; durationMs?: number; providerId: string;
    };
    expect(json.ok).toBe(true);
    expect(json.text).toBe('안녕하세요');
    expect(json.language).toBe('ko');
    expect(json.durationMs).toBe(1500);
    expect(json.providerId).toBe('openai-whisper');
    expect(fetchDevice.calls()).toMatchObject([{ method: 'POST', status: 200, body: expect.stringContaining('form-data:') }]);
  });

  test('provider failure → 502 stt-failed', async () => {
    fetchDevice = createFakeFetchDevice([{ url: '/v1/audio/transcriptions', method: 'POST', response: () => new Response('rate limited', { status: 429 }) }]);
    const { body, contentType } = multipartBody([{
      name: 'file',
      value: { bytes: new Uint8Array([1,2,3,4]), filename: 'x.m4a', type: 'audio/m4a' },
    }]);
    const res = await handleAudioStt(
      new Request('http://x/v1/audio/stt', {
        method: 'POST',
        body: new Uint8Array(body),
        headers: { 'content-type': contentType },
      }),
      { apiKey: 'sk-test' },
    );
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string; detail: string };
    expect(json.error).toBe('stt-failed');
    expect(json.detail).toContain('429');
  });

  test('CORS allow-origin set on success response', async () => {
    fetchDevice = createFakeFetchDevice([{ url: '/v1/audio/transcriptions', method: 'POST', response: () => new Response(JSON.stringify({ text: 'hi', duration: 0.5 }), { status: 200 }) }]);
    const { body, contentType } = multipartBody([{
      name: 'file',
      value: { bytes: new Uint8Array([1,2,3,4]), filename: 'x.wav', type: 'audio/wav' },
    }]);
    const res = await handleAudioStt(
      new Request('http://x/v1/audio/stt', {
        method: 'POST',
        body: new Uint8Array(body),
        headers: { 'content-type': contentType },
      }),
      { apiKey: 'sk' },
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
