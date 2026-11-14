import { expect, test } from 'bun:test';
import { createUpstageSolarAnswerCompose } from './upstage-solar-answer-compose.js';

const input = { question: 'What changed?', sources: [
  { id: 's1', title: 'Notice', url: 'https://example.org/notice', snippet: 'Revision A applies.' },
] };
const draft = { answer: 'Revision A applies [1].', citations: [{ sourceId: 's1', url: 'https://example.org/notice' }] };
const response = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft) } }] }), { status: 200 });
// 출처: fake transport fixture sizes and timer bounds in this file; no production SLA.
const TEST_TIMEOUT_MS = 500;
const STALLED_TIMEOUT_MS = 20;
const TEST_RESPONSE_BYTES = 4096;
const TOO_SMALL_RESPONSE_BYTES = 100;

test('Solar adapter uses the existing Upstage slot wire after consent and verifies citations', async () => {
  let calls = 0;
  const provider = createUpstageSolarAnswerCompose({ consentToSend: true, timeoutMs: TEST_TIMEOUT_MS, maxResponseBytes: TEST_RESPONSE_BYTES,
    resolveApiKey: async () => 'synthetic-key',
    fetchImpl: async (url, init) => {
      calls++;
      expect(url).toBe('https://api.upstage.ai/v1/chat/completions');
      expect(init?.redirect).toBe('error');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-key');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('solar-pro4');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.messages[0].content).toContain('Use [1], [2], ... markers');
      expect(body.messages[0].content).toContain('Put no URLs in answer text');
      return response();
    },
  });
  expect((await provider(input)).status).toBe('ok');
  expect(calls).toBe(1);
});

test('no consent or bad input never reads a key or sends source text', async () => {
  let keys = 0; let calls = 0;
  const options = { timeoutMs: TEST_TIMEOUT_MS, maxResponseBytes: TEST_RESPONSE_BYTES,
    resolveApiKey: async () => { keys++; return 'synthetic-key'; },
    fetchImpl: async () => { calls++; return response(); },
  };
  expect(await createUpstageSolarAnswerCompose({ ...options, consentToSend: false })(input))
    .toEqual({ status: 'consent-required' });
  expect(await createUpstageSolarAnswerCompose({ ...options, consentToSend: true })({ ...input, sources: [] }))
    .toEqual({ status: 'invalid-input' });
  expect(keys).toBe(0); expect(calls).toBe(0);
});

test('Solar request and result use the source snapshot taken before key lookup awaits', async () => {
  const mutable = { question: input.question, sources: [{ ...input.sources[0]! }] };
  let release!: (key: string) => void;
  const keyReady = new Promise<string>(resolve => { release = resolve; });
  let promptUrl = '';
  const provider = createUpstageSolarAnswerCompose({
    consentToSend: true, timeoutMs: TEST_TIMEOUT_MS, maxResponseBytes: TEST_RESPONSE_BYTES,
    resolveApiKey: () => keyReady,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      promptUrl = JSON.parse(body.messages[1].content).sources[0].url;
      return response();
    },
  });
  const result = provider(mutable);
  mutable.sources[0]!.url = 'https://evil.example/changed';
  release('synthetic-key');
  expect(await result).toEqual({ status: 'ok', answer: draft.answer, citations: draft.citations, sourceIds: ['s1'] });
  expect(promptUrl).toBe('https://example.org/notice');
});

test('whole deadline bounds stalled key lookup and stalled body read', async () => {
  let requests = 0;
  const stalledKey = createUpstageSolarAnswerCompose({ consentToSend: true, timeoutMs: STALLED_TIMEOUT_MS, maxResponseBytes: TEST_RESPONSE_BYTES,
    resolveApiKey: async () => new Promise<string>(() => {}),
    fetchImpl: async () => { requests++; return response(); },
  });
  expect(await stalledKey(input)).toEqual({ status: 'model-unavailable' });
  expect(requests).toBe(0);

  const stalledBody = createUpstageSolarAnswerCompose({ consentToSend: true, timeoutMs: STALLED_TIMEOUT_MS, maxResponseBytes: TEST_RESPONSE_BYTES,
    resolveApiKey: async () => 'synthetic-key',
    fetchImpl: async () => new Response(new ReadableStream({ pull: async () => new Promise<void>(() => {}) }), { status: 200 }),
  });
  expect(await stalledBody(input)).toEqual({ status: 'model-unavailable' });
});

test('oversized or forged model replies fail closed without leaking response text', async () => {
  const provider = createUpstageSolarAnswerCompose({ consentToSend: true, timeoutMs: TEST_TIMEOUT_MS, maxResponseBytes: TOO_SMALL_RESPONSE_BYTES,
    resolveApiKey: async () => 'synthetic-key', fetchImpl: async () => response(),
  });
  expect(await provider(input)).toEqual({ status: 'model-unavailable' });
  const forged = createUpstageSolarAnswerCompose({ consentToSend: true, timeoutMs: TEST_TIMEOUT_MS, maxResponseBytes: TEST_RESPONSE_BYTES,
    resolveApiKey: async () => 'synthetic-key', fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ answer: 'Fake [1]', citations: [{ sourceId: 's1', url: 'https://evil.example/' }] }) } }],
    }), { status: 200 }),
  });
  expect(await forged(input)).toEqual({ status: 'invalid-citations' });
});

test('valid JSON that echoes the fake host credential never returns it', async () => {
  for (const fakeKey of ['SYNTHETIC-KEY-ECHO-1114', String.raw`SYNTHETIC-"KEY\\ECHO`]) {
    for (const echoed of [
      { answer: `Revision A ${fakeKey} [1].`, citations: draft.citations },
      { answer: 'Revision A [1].', citations: [{ sourceId: 's1', url: `https://example.org/notice?key=${fakeKey}` }] },
    ]) {
    const provider = createUpstageSolarAnswerCompose({
      consentToSend: true, timeoutMs: TEST_TIMEOUT_MS, maxResponseBytes: TEST_RESPONSE_BYTES,
      resolveApiKey: async () => fakeKey,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(echoed) } }] }), { status: 200 }),
    });
    const result = await provider(input);
    expect(result).toEqual({ status: 'model-unavailable' });
    expect(JSON.stringify(result)).not.toContain(fakeKey);
    }
  }
});
