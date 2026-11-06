import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { loadMockScenarioCatalog } from './mock-scenario-catalog.js';
import { ElevenLabsTTSProvider } from '../voice/tts/tts-providers/elevenlabs-tts.js';
import {
  ELEVENLABS_TTS_CONTRACT_CASES,
  fakeElevenLabsAudioBytes,
  runElevenLabsTTSContractMatrix,
  startFakeElevenLabs,
  type ElevenLabsTtsInput,
} from './fake-elevenlabs.js';
import {
  FAKE_STT_CONTRACT_CASES,
  createFakeStt,
  runFakeSttContractMatrix,
} from './fake-stt.js';

const openedServers: Array<{ close(): Promise<void> }> = [];
let originalFetch: typeof fetch;
const outboundUrls: string[] = [];
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== '127.0.0.1') throw new Error(`fake provider test blocked non-loopback request: ${url.origin}`);
    outboundUrls.push(url.href);
    return originalFetch(input, init);
  }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const url of outboundUrls.splice(0)) expect(new URL(url).hostname).toBe('127.0.0.1');
  for (const server of openedServers.splice(0)) await server.close();
});

test('SIM-FAKE-PROVIDERS-AV: network guard rejects every non-loopback destination before fetch', async () => {
  await expect(fetch('https://example.invalid/')).rejects.toThrow('fake provider test blocked non-loopback request');
});

test('SIM-FAKE-PROVIDERS-AV: ElevenLabs loopback authenticates and returns deterministic audio', async () => {
  const fake = await startFakeElevenLabs({ apiKey: 'sim-key' });
  openedServers.push(fake);
  expect(new URL(fake.baseUrl).hostname).toBe('127.0.0.1');
  const previousBaseUrl = process.env.ELEVENLABS_BASE_URL;
  process.env.ELEVENLABS_BASE_URL = fake.baseUrl;
  try {
    const provider = new ElevenLabsTTSProvider({ id: 'elevenlabs-tts', apiKey: 'sim-key' });
    const first = await provider.synthesizeBatch('같은 텍스트');
    const second = await provider.synthesizeBatch('같은 텍스트');
    expect(first.pcm).toEqual(second.pcm);
    expect(first.pcm.byteLength).toBeGreaterThan(0);
    expect(fake.requests()).toHaveLength(2);
    expect(fake.requests()[0]).toMatchObject({ text: '같은 텍스트', status: 200 });
    expect(JSON.stringify(fake.requests())).not.toContain('sim-key');
  } finally {
    if (previousBaseUrl === undefined) delete process.env.ELEVENLABS_BASE_URL;
    else process.env.ELEVENLABS_BASE_URL = previousBaseUrl;
  }
});

test('SIM-FAKE-PROVIDERS-AV: ElevenLabs supports auth failure, retry-after, controllable delay, and reusable matrix', async () => {
  const unauthorized = await startFakeElevenLabs({ apiKey: 'expected', mode: 'ok' });
  openedServers.push(unauthorized);
  const badKey = await fetch(`${unauthorized.baseUrl}/v1/text-to-speech/voice/stream?output_format=pcm_24000`, {
    method: 'POST', headers: { 'xi-api-key': 'wrong', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
  });
  expect(badKey.status).toBe(401);

  const limited = await startFakeElevenLabs({ apiKey: 'expected', mode: 'rate-limited', retryAfterSeconds: 7 });
  openedServers.push(limited);
  const rateLimited = await fetch(`${limited.baseUrl}/v1/text-to-speech/voice/stream`, {
    method: 'POST', headers: { 'xi-api-key': 'expected', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
  });
  expect(rateLimited.status).toBe(429);
  expect(rateLimited.headers.get('retry-after')).toBe('7');

  let releaseDelay!: () => void;
  let signalDelayStarted!: () => void;
  const delayStarted = new Promise<void>(resolve => { signalDelayStarted = resolve; });
  const delayed = await startFakeElevenLabs({ apiKey: 'expected', delayMs: 50, delay: () => {
    signalDelayStarted();
    return new Promise<void>(resolve => { releaseDelay = resolve; });
  } });
  openedServers.push(delayed);
  const delayedResponse = fetch(`${delayed.baseUrl}/v1/text-to-speech/voice/stream`, {
    method: 'POST', headers: { 'xi-api-key': 'expected', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }),
  });
  await delayStarted;
  let completed = false;
  void delayedResponse.then(() => { completed = true; });
  await Promise.resolve();
  expect(completed).toBe(false);
  releaseDelay();
  expect((await delayedResponse).status).toBe(200);
  expect(delayed.requests()).toHaveLength(1);

  let signalCancelDelayStarted!: () => void;
  const cancelDelayStarted = new Promise<void>(resolve => { signalCancelDelayStarted = resolve; });
  const cancelled = await startFakeElevenLabs({ apiKey: 'expected', delayMs: 50, delay: () => {
    signalCancelDelayStarted();
    return new Promise<void>(() => {});
  } });
  openedServers.push(cancelled);
  const controller = new AbortController();
  const cancelledResponse = fetch(`${cancelled.baseUrl}/v1/text-to-speech/voice/stream`, {
    method: 'POST', signal: controller.signal,
    headers: { 'xi-api-key': 'expected', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'cancel me' }),
  });
  await cancelDelayStarted;
  expect(cancelled.requests()).toHaveLength(1);
  controller.abort();
  await expect(cancelledResponse).rejects.toThrow();
  expect(cancelled.requests()).toMatchObject([{ text: 'cancel me', status: 200 }]);

  const failedDelay = await startFakeElevenLabs({ apiKey: 'expected', delayMs: 10, delay: () => Promise.reject(new Error('simulated delay failure')) });
  openedServers.push(failedDelay);
  const failedResponse = await fetch(`${failedDelay.baseUrl}/v1/text-to-speech/voice/stream`, {
    method: 'POST', headers: { 'xi-api-key': 'expected', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'delay failed' }),
  });
  expect(failedResponse.status).toBe(500);
  expect(failedDelay.requests()).toMatchObject([{ text: 'delay failed', status: 500 }]);

  expect(ELEVENLABS_TTS_CONTRACT_CASES.map(row => row.name)).toContain('valid-key');
  const matrixOk = await startFakeElevenLabs({ apiKey: 'sim-key' });
  const matrixLimited = await startFakeElevenLabs({ apiKey: 'sim-key', mode: 'rate-limited' });
  openedServers.push(matrixOk, matrixLimited);
  const port = {
    synthesize: async (input: ElevenLabsTtsInput) => {
      const server = input.mode === 'rate-limited' ? matrixLimited : matrixOk;
      const response = await fetch(`${server.baseUrl}/v1/text-to-speech/contract/stream`, {
        method: 'POST', headers: { 'xi-api-key': input.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ text: input.text }),
      });
      return {
        status: response.status,
        ...(response.headers.get('retry-after') ? { retryAfter: response.headers.get('retry-after')! } : {}),
        bytes: Buffer.from(await response.arrayBuffer()),
      };
    },
  };
  await expect(runElevenLabsTTSContractMatrix(port)).resolves.toBeUndefined();
  await expect(runElevenLabsTTSContractMatrix(port, { exactAudioBytes: fakeElevenLabsAudioBytes })).resolves.toBeUndefined();
  await expect(runElevenLabsTTSContractMatrix(port, { exactAudioBytes: () => Buffer.from('other') }))
    .rejects.toThrow('audio bytes do not match the expected exact bytes');
  let nondeterministicCalls = 0;
  await expect(runElevenLabsTTSContractMatrix({
    synthesize: async input => input.apiKey !== 'sim-key' ? { status: 401, bytes: Buffer.alloc(0) }
      : input.mode === 'rate-limited' ? { status: 429, retryAfter: '1', bytes: Buffer.alloc(0) }
      : { status: 200, bytes: Buffer.from(`audio-${nondeterministicCalls++}`) },
  })).rejects.toThrow('same text did not return the same audio bytes');
  const reusedBuffer = Buffer.alloc(4);
  let reusedCalls = 0;
  await expect(runElevenLabsTTSContractMatrix({
    synthesize: async input => {
      if (input.apiKey !== 'sim-key') return { status: 401, bytes: Buffer.alloc(0) };
      if (input.mode === 'rate-limited') return { status: 429, retryAfter: '1', bytes: Buffer.alloc(0) };
      reusedBuffer.writeUInt32BE(++reusedCalls);
      return { status: 200, bytes: reusedBuffer };
    },
  })).rejects.toThrow('same text did not return the same audio bytes');
  await expect(runElevenLabsTTSContractMatrix({
    synthesize: async () => ({ status: 200, bytes: Buffer.alloc(0) }),
  })).rejects.toThrow('expected non-empty audio bytes');
  expect(matrixOk.requests()).toHaveLength(7);
  expect(matrixLimited.requests()).toHaveLength(2);
});

test('SIM-FAKE-PROVIDERS-AV: STT maps sha256 fingerprints to language-tagged transcripts and variations', async () => {
  const audio = Buffer.from('deterministic recording');
  const fingerprint = createHash('sha256').update(audio).digest('hex');
  const fake = createFakeStt({ transcripts: { [fingerprint]: { text: '안녕하세요', language: 'ko' } } });
  await expect(fake.transcribe({ audio })).resolves.toMatchObject({ text: '안녕하세요', language: 'ko' });
  expect(fake.requests()[0]).toMatchObject({ fingerprint });
  expect(fake.requests()[0]).not.toHaveProperty('language');
  expect(FAKE_STT_CONTRACT_CASES.map(row => row.name)).toEqual(expect.arrayContaining(['matching-fingerprint', 'failure-code', 'empty-transcript', 'language-ko-en']));
  await expect(runFakeSttContractMatrix(fake)).resolves.toBeUndefined();

  const failure = createFakeStt({ failure: { code: 'FAKE_STT_UNAVAILABLE', message: 'offline simulation' } });
  await expect(failure.transcribe({ audio })).rejects.toMatchObject({ code: 'FAKE_STT_UNAVAILABLE' });
  const empty = createFakeStt({ emptyTranscript: true });
  await expect(empty.transcribe({ audio })).resolves.toMatchObject({ text: '' });
  expect((await empty.transcribe({ audio })).language).toBeUndefined();
  expect(empty.requests()[0]).not.toHaveProperty('language');

  const englishAudio = Buffer.from('fake-stt-language-audio');
  const english = createFakeStt();
  await expect(english.transcribe({ audio: englishAudio })).resolves.toMatchObject({ text: 'hello', language: 'en' });
  expect(english.requests()[0]).not.toHaveProperty('language');

  const independentPort = {
    async transcribe(input: { audio: Buffer; language?: 'ko' | 'en'; variation?: 'failure' | 'empty' }) {
      if (input.variation === 'failure') throw { code: 'FAKE_STT_UNAVAILABLE' };
      if (input.variation === 'empty') return { fingerprint: createHash('sha256').update(input.audio).digest('hex'), text: '' };
      const fingerprint = createHash('sha256').update(input.audio).digest('hex');
      return fingerprint === createHash('sha256').update('fake-stt-contract-audio').digest('hex')
        ? { fingerprint, text: '안녕하세요', language: 'ko' as const }
        : { fingerprint, text: 'hello', language: 'en' as const };
    },
  };
  await expect(runFakeSttContractMatrix(independentPort)).resolves.toBeUndefined();

  let releaseDelay!: () => void;
  let signalDelayStarted!: () => void;
  const delayStarted = new Promise<void>(resolve => { signalDelayStarted = resolve; });
  const delayed = createFakeStt({ delayMs: 40, delay: () => {
    signalDelayStarted();
    return new Promise<void>(resolve => { releaseDelay = resolve; });
  }, transcripts: { [fingerprint]: { text: 'hello', language: 'en' } } });
  const transcription = delayed.transcribe({ audio, language: 'en' });
  await delayStarted;
  let completed = false;
  void transcription.then(() => { completed = true; });
  await Promise.resolve();
  expect(completed).toBe(false);
  releaseDelay();
  await expect(transcription).resolves.toMatchObject({ text: 'hello', language: 'en' });
});

test('SIM-FAKE-PROVIDERS-AV: device registration references both modules and this contract test in id order', () => {
  const catalog = loadMockScenarioCatalog();
  const device = catalog.devices.find(row => row.id === 'SIM-FAKE-PROVIDERS-AV');
  expect(device?.implementation).toEqual(['src/ux-sim/fake-elevenlabs.ts', 'src/ux-sim/fake-stt.ts']);
  expect(device?.tests).toContain('src/ux-sim/fake-provider-av.test.ts');
  expect(catalog.sourceModules.map(module => module.path)).toEqual(expect.arrayContaining([
    'src/ux-sim/fake-elevenlabs.ts', 'src/ux-sim/fake-stt.ts',
  ]));
  const ids = catalog.devices.map(row => row.id);
  expect(ids.indexOf('SIM-FAKE-PROVIDERS-AV')).toBe(0);
  expect(ids.indexOf('SIM-FAKE-PROVIDERS-AV')).toBeLessThan(ids.indexOf('codex-wire-capture'));
});
