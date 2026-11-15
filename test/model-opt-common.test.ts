import { afterEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../src/debug/log.js';
import { streamLLM, streamLLMWithTools, type LLMProvider, type LLMStreamEvent } from '../src/llm.js';
import { ApiHttpError, fetchApiWithRetry } from '../src/session-runtime/retry-api.js';

const originalFetch = globalThis.fetch;
// Source: .rules/30-harness/testing-gates.md · fake retry budget boundary cases.
const RETRY_BUDGET = { one: 1, two: 2, three: 3 } as const;
// Source: .rules/30-harness/testing-gates.md · first tool-loop turn is the bounded fixture.
const SINGLE_TOOL_TURN = 1;
afterEach(() => { globalThis.fetch = originalFetch; });

test('header deadline aborts a provider that never returns headers', async () => {
  let aborted = false;
  globalThis.fetch = ((_url, init) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; });
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  const started = Date.now();
  await expect(fetchApiWithRetry('https://provider.invalid', { method: 'POST' }, {
    // 출처: .rules/30-harness/testing-gates.md · 헤더 무응답 회수 계약의 가짜 시계와 단일 시도 상한.
    provider: 'fake', errorPrefix: 'Fake API', headerTimeoutMs: 15, maxAttempts: 1,
  })).rejects.toMatchObject({ name: 'ProviderHeaderTimeoutError', code: 'ETIMEDOUT' });
  expect(aborted).toBe(true);
  // 출처: .rules/30-harness/testing-gates.md · 가짜 헤더 마감이 시험 여유 안에 관측되는지 확인.
  expect(Date.now() - started).toBeLessThan(500);
});

test('provider error body read has its own deadline', async () => {
  let cancelled = false;
  globalThis.fetch = (() => Promise.resolve(new Response(new ReadableStream({
    pull() { return new Promise<void>(() => {}); },
    cancel() { cancelled = true; },
  }), { status: 503 }))) as unknown as typeof fetch;
  await expect(fetchApiWithRetry('https://provider.invalid', { method: 'POST' }, {
    // 출처: .rules/30-harness/testing-gates.md · 오류 본문 마감과 상태 보존을 한 시도에서 확인.
    provider: 'fake', errorPrefix: 'Fake API', headerTimeoutMs: 15, maxAttempts: 1,
  })).rejects.toMatchObject({ name: 'ApiHttpError', status: 503, bodyTimedOut: true });
  expect(cancelled).toBe(true);
});

test('abort still reaches the fetch after response headers and stops after the body closes', async () => {
  let fetchSignal: AbortSignal | undefined;
  let bodySink: ReadableStreamDefaultController<Uint8Array> | undefined;
  const external = new AbortController();
  globalThis.fetch = ((_url, init) => {
    fetchSignal = init?.signal ?? undefined;
    fetchSignal?.addEventListener('abort', () => bodySink?.error(new DOMException('aborted', 'AbortError')));
    return Promise.resolve(new Response(new ReadableStream({
      start(sink) { bodySink = sink; },
      pull() { return new Promise<void>(() => {}); },
    }), { status: 200 }));
  }) as typeof fetch;
  const response = await fetchApiWithRetry('https://provider.invalid', { signal: external.signal }, {
    // 출처: .rules/30-harness/testing-gates.md · 헤더 뒤 취소 전달을 단일 fetch 응답에서 확인.
    provider: 'fake', errorPrefix: 'Fake API', maxAttempts: 1,
  });
  expect(response.status).toBe(200);
  expect(fetchSignal?.aborted).toBe(false);
  const pendingBody = response.body!.getReader().read();
  external.abort();
  expect(fetchSignal?.aborted).toBe(true);
  await expect(pendingBody).rejects.toMatchObject({ name: 'AbortError' });
});

test('the external abort listener is released when the streamed response completes', async () => {
  let fetchSignal: AbortSignal | undefined;
  const external = new AbortController();
  globalThis.fetch = ((_url, init) => {
    fetchSignal = init?.signal ?? undefined;
    return Promise.resolve(new Response('done', { status: 200 }));
  }) as typeof fetch;
  const response = await fetchApiWithRetry('https://provider.invalid', { signal: external.signal }, {
    // 출처: .rules/30-harness/testing-gates.md · 성공 본문 소비 뒤 단일 요청 리스너 정리 계약.
    provider: 'fake', errorPrefix: 'Fake API', maxAttempts: 1,
  });
  expect(await response.text()).toBe('done');
  external.abort();
  expect(fetchSignal?.aborted).toBe(false);
});

test('partial error body and HTTP 429 survive a body-read timeout', async () => {
  let calls = 0;
  const logs: Array<Record<string, unknown>> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, _event, data) => {
    if (category === 'llm.provider-error') logs.push((data ?? {}) as Record<string, unknown>);
  });
  try {
    globalThis.fetch = (() => {
      calls++;
      if (calls > 1) return Promise.resolve(new Response('ok', { status: 200 }));
      return Promise.resolve(new Response(new ReadableStream({
        start(sink) { sink.enqueue(new TextEncoder().encode('rate limit partial')); },
        pull() { return new Promise<void>(() => {}); },
      }), { status: 429, headers: { 'retry-after': '0' } }));
    }) as unknown as typeof fetch;
    const response = await fetchApiWithRetry('https://provider.invalid', {}, {
      // 출처: .rules/30-harness/testing-gates.md · 429 본문 마감 뒤 retry-after에 따른 한 번 재시도.
      provider: 'fake', errorPrefix: 'Fake API', headerTimeoutMs: 15, maxAttempts: 2,
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(logs[0]).toMatchObject({ status: 429, body: 'rate limit partial', reason: 'error-body-timeout' });
  } finally {
    log.mockRestore();
  }
});

test('400 reasoning field rejection removes only the rejected field and retries once', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = ((_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Promise.resolve(bodies.length === 1
      ? new Response('{"error":{"message":"reasoning disable unsupported"}}', { status: 400 })
      : new Response('ok', { status: 200 }));
  }) as typeof fetch;
  const response = await fetchApiWithRetry('https://provider.invalid', {
    method: 'POST', body: JSON.stringify({ model: 'glm-test', reasoning: { enabled: false }, messages: [{ role: 'user', content: 'x' }] }),
  // 출처: .rules/30-harness/testing-gates.md · reasoning 필드 거부의 최초·복구 요청만 허용.
  }, { provider: 'fake', errorPrefix: 'Fake API', maxAttempts: 2 });
  expect(response.status).toBe(200);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual({ model: 'glm-test', messages: [{ role: 'user', content: 'x' }] });
});

test('unrelated 400 remains terminal and logs bounded provider body', async () => {
  let calls = 0;
  const logs: Array<{ category: string; data: Record<string, unknown> }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, _event, data) => {
    logs.push({ category, data: (data ?? {}) as Record<string, unknown> });
  });
  try {
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(new Response('bad format '.repeat(1000), { status: 400 }));
    }) as unknown as typeof fetch;
    await expect(fetchApiWithRetry('https://provider.invalid', {
      method: 'POST', body: JSON.stringify({ reasoning: { enabled: false } }),
    }, { provider: 'fake', errorPrefix: 'Fake API' })).rejects.toBeInstanceOf(ApiHttpError);
    expect(calls).toBe(1);
    const errorLog = logs.find((row) => row.category === 'llm.provider-error');
    expect(errorLog?.data.status).toBe(400);
    expect(String(errorLog?.data.body).length).toBe(500);
  } finally {
    log.mockRestore();
  }
});

test('reasoning format recovery has one retry even if the second response is 400', async () => {
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response('reasoning disable unsupported', { status: 400 }));
  }) as unknown as typeof fetch;
  await expect(fetchApiWithRetry('https://provider.invalid', {
    method: 'POST', body: JSON.stringify({ reasoning: { enabled: false } }),
  // 출처: .rules/30-harness/testing-gates.md · 일반 재시도 상한과 별개로 reasoning 복구는 한 번.
  }, { provider: 'fake', errorPrefix: 'Fake API', maxAttempts: 4 })).rejects.toBeInstanceOf(ApiHttpError);
  expect(calls).toBe(2);
});

test('a 400 for another field never removes reasoning', async () => {
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response('{"error":{"param":"temperature","message":"Invalid temperature; reasoning is present"}}', { status: 400 }));
  }) as unknown as typeof fetch;
  await expect(fetchApiWithRetry('https://provider.invalid', {
    method: 'POST', body: JSON.stringify({ reasoning: { enabled: false }, temperature: 0.3 }),
  }, { provider: 'fake', errorPrefix: 'Fake API' })).rejects.toMatchObject({ status: 400 });
  expect(calls).toBe(1);
});

test('reasoning field repair has one extra request even with one transport attempt', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = ((_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Promise.resolve(new Response(bodies.length === 1 ? 'reasoning disable unsupported' : 'ok',
      { status: bodies.length === 1 ? 400 : 200 }));
  }) as typeof fetch;
  const response = await fetchApiWithRetry('https://provider.invalid', {
    method: 'POST', body: JSON.stringify({ reasoning: { enabled: false }, model: 'glm-test' }),
  }, { provider: 'fake', errorPrefix: 'Fake API', maxAttempts: RETRY_BUDGET.one });
  expect(response.status).toBe(200);
  expect(bodies).toEqual([{ reasoning: { enabled: false }, model: 'glm-test' }, { model: 'glm-test' }]);
});

test('reasoning repair remains available after the last ordinary retry', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = ((_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (bodies.length === 1) return Promise.resolve(new Response('busy', { status: 429, headers: { 'retry-after': '0' } }));
    if (bodies.length === 2) return Promise.resolve(new Response('reasoning disable unsupported', { status: 400 }));
    return Promise.resolve(new Response('ok', { status: 200 }));
  }) as typeof fetch;
  expect((await fetchApiWithRetry('https://provider.invalid', {
    method: 'POST', body: JSON.stringify({ reasoning: { enabled: false }, model: 'glm-test' }),
  }, { provider: 'fake', errorPrefix: 'Fake API', maxAttempts: RETRY_BUDGET.two })).status).toBe(200);
  expect(bodies).toHaveLength(3);
  expect(bodies[2]).toEqual({ model: 'glm-test' });
});

test('a non-timeout error body failure retains HTTP status, partial body, and terminal 400', async () => {
  let calls = 0;
  const logs: Array<Record<string, unknown>> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, _event, data) => {
    if (category === 'llm.provider-error') logs.push((data ?? {}) as Record<string, unknown>);
  });
  try {
    globalThis.fetch = (() => {
      calls++;
      let emitted = false;
      return Promise.resolve(new Response(new ReadableStream({
        pull(sink) {
          if (!emitted) { emitted = true; sink.enqueue(new TextEncoder().encode('partial invalid format')); }
          else sink.error(new Error('socket read failed'));
        },
      }), { status: 400 }));
    }) as unknown as typeof fetch;
    await expect(fetchApiWithRetry('https://provider.invalid', {}, {
      provider: 'fake', errorPrefix: 'Fake API', maxAttempts: RETRY_BUDGET.three,
    })).rejects.toMatchObject({ status: 400, bodyText: 'partial invalid format', bodyReadFailed: true });
    expect(calls).toBe(1);
    expect(logs[0]).toMatchObject({ status: 400, body: 'partial invalid format', reason: 'error-body-read-failed' });
  } finally { log.mockRestore(); }
});

test('a failed 503 error-body read still follows the HTTP retry policy', async () => {
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    if (calls > 1) return Promise.resolve(new Response('ok', { status: 200 }));
    let emitted = false;
    return Promise.resolve(new Response(new ReadableStream({
      pull(sink) {
        if (!emitted) { emitted = true; sink.enqueue(new TextEncoder().encode('unavailable')); }
        else sink.error(new Error('socket read failed'));
      },
    }), { status: 503, headers: { 'retry-after': '0' } }));
  }) as unknown as typeof fetch;
  expect((await fetchApiWithRetry('https://provider.invalid', {}, {
    provider: 'fake', errorPrefix: 'Fake API', maxAttempts: RETRY_BUDGET.two,
  })).status).toBe(200);
  expect(calls).toBe(2);
});

function stalledTextProvider(firstEvent?: LLMStreamEvent): LLMProvider {
  let nextCount = 0;
  const iterator: AsyncIterator<LLMStreamEvent> = {
    next: () => ++nextCount === 1 && firstEvent
      ? Promise.resolve({ done: false, value: firstEvent })
      : new Promise<IteratorResult<LLMStreamEvent>>(() => {}),
    return: async () => ({ done: true, value: undefined }),
  };
  return {
    name: 'fake-model-opt', defaultModel: 'gpt-4o-mini', available: () => true,
    streamChat: () => ({ [Symbol.asyncIterator]: () => iterator }) as AsyncGenerator<LLMStreamEvent, void, unknown>,
    async *chat() {},
  };
}

test('first-token deadline is independent from the idle chunk deadline', async () => {
  await expect(streamLLM([{ role: 'user', content: 'x' }], () => {}, {
    provider: stalledTextProvider(), streamFirstTokenTimeoutMs: 15, streamIdleTimeoutMs: 200,
  })).rejects.toMatchObject({ name: 'StreamIdleTimeoutError', idleMs: 15 });
});

test('metadata cannot keep resetting the first-token clock', async () => {
  const provider: LLMProvider = {
    name: 'fake-model-opt', defaultModel: 'gpt-4o-mini', available: () => true,
    async *streamChat() {
      yield { type: 'usage', usage: { inputTokens: 1 } } as LLMStreamEvent;
      await new Promise<void>((resolve) => setTimeout(resolve, 12));
      yield { type: 'usage', usage: { inputTokens: 1 } } as LLMStreamEvent;
      await new Promise<void>(() => {});
    },
    async *chat() {},
  };
  const started = Date.now();
  await expect(streamLLM([{ role: 'user', content: 'x' }], () => {}, {
    provider, streamFirstTokenTimeoutMs: 20, streamIdleTimeoutMs: 200,
  })).rejects.toMatchObject({ name: 'StreamIdleTimeoutError', idleMs: 20 });
  // 출처: .rules/30-harness/testing-gates.md · 첫 토큰 시계가 메타데이터에 의해 늘지 않는지 확인.
  expect(Date.now() - started).toBeLessThan(100);
});

test('rapid non-token events cannot bypass either product first-token deadline', async () => {
  const provider: LLMProvider = {
    name: 'fake-model-opt', defaultModel: 'gpt-4o-mini', available: () => true,
    async *streamChat() {
      const until = Date.now() + 40;
      while (Date.now() < until) yield { type: 'usage', usage: { inputTokens: 1 } } as LLMStreamEvent;
    },
    async *chat() {},
  };
  await expect(streamLLM([{ role: 'user', content: 'x' }], () => {}, {
    provider, streamFirstTokenTimeoutMs: 10, streamIdleTimeoutMs: 200, streamTotalTimeoutMs: 200,
  })).rejects.toMatchObject({ name: 'StreamIdleTimeoutError', idleMs: 10 });
  await expect(streamLLMWithTools([{ role: 'user', content: 'x' }], {
    onText: () => {}, dispatchTool: async () => ({}),
  }, {
    provider, streamFirstTokenTimeoutMs: 10, streamIdleTimeoutMs: 200, streamTotalTimeoutMs: 200,
    tools: [{ name: 'probe', description: 'fake tool', parameters: { type: 'object' } }], maxTurns: SINGLE_TOOL_TURN,
  })).rejects.toMatchObject({ name: 'StreamIdleTimeoutError', idleMs: 10 });
});

test('reasoning progress satisfies the first-token deadline', async () => {
  const provider: LLMProvider = {
    name: 'fake-model-opt', defaultModel: 'glm-test', available: () => true,
    async *streamChat() {
      yield { type: 'reasoning', kind: 'inline_delta', delta: 'thinking' } as LLMStreamEvent;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      yield { type: 'text', delta: 'answer' } as LLMStreamEvent;
    },
    async *chat() {},
  };
  expect(await streamLLM([{ role: 'user', content: 'x' }], () => {}, {
    provider, streamFirstTokenTimeoutMs: 10, streamIdleTimeoutMs: 60,
  })).toBe('answer');
});

test('total deadline stops a stream after an emitted token', async () => {
  const chunks: string[] = [];
  await expect(streamLLM([{ role: 'user', content: 'x' }], (delta) => chunks.push(delta), {
    provider: stalledTextProvider({ type: 'text', delta: 'partial' }), streamIdleTimeoutMs: 200,
    streamTotalTimeoutMs: 20,
  })).rejects.toMatchObject({ name: 'StreamTotalTimeoutError', totalMs: 20 });
  expect(chunks).toEqual(['partial']);
});

test('a length continuation shares the original total deadline', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    name: 'fake-model-opt', defaultModel: 'gpt-4o-mini', available: () => true,
    async *streamChat() {
      calls++;
      if (calls === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 15));
        yield { type: 'text', delta: 'partial' } as LLMStreamEvent;
        yield { type: 'finish', reason: 'length' } as LLMStreamEvent;
        return;
      }
      await new Promise<void>(() => {});
    },
    async *chat() {},
  };
  await expect(streamLLM([{ role: 'user', content: 'x' }], () => {}, {
    provider, streamIdleTimeoutMs: 200, streamTotalTimeoutMs: 30,
  })).rejects.toMatchObject({ name: 'StreamTotalTimeoutError', totalMs: 30 });
  expect(calls).toBe(2);
});

test('the tool-loop product entry enforces the same total deadline', async () => {
  const chunks: string[] = [];
  await expect(streamLLMWithTools(
    [{ role: 'user', content: 'x' }],
    { onText: (delta) => chunks.push(delta), dispatchTool: async () => ({}) },
    {
      provider: stalledTextProvider({ type: 'text', delta: 'partial' }),
      streamIdleTimeoutMs: 200, streamTotalTimeoutMs: 20,
      tools: [{ name: 'probe', description: 'fake tool', parameters: { type: 'object' } }],
      // 출처: .rules/30-harness/testing-gates.md · 실제 tool-loop 첫 턴으로 전체 마감 검사를 분리.
      maxTurns: 1,
    },
  )).rejects.toMatchObject({ name: 'StreamTotalTimeoutError', totalMs: 20 });
  expect(chunks).toContain('partial');
});

test('the tool-loop screen gets a one-line HTTP summary', async () => {
  const statuses: string[] = [];
  const provider: LLMProvider = {
    name: 'fake-model-opt', defaultModel: 'glm-test', available: () => true,
    async *streamChat() {
      throw new ApiHttpError({ status: 400, bodyText: '{"error":"reasoning format unsupported"}', provider: 'fake-model-opt', errorPrefix: 'Fake API' });
    },
    async *chat() {},
  };
  await expect(streamLLMWithTools(
    [{ role: 'user', content: 'x' }],
    { onText: () => {}, onStatus: (line) => statuses.push(line), dispatchTool: async () => ({}) },
    // 출처: .rules/30-harness/testing-gates.md · 화면 상태 검사는 tool-loop 단일 첫 턴만 대상.
    { provider, tools: [{ name: 'probe', description: 'fake tool', parameters: { type: 'object' } }], maxTurns: 1 },
  )).rejects.toBeInstanceOf(ApiHttpError);
  expect(statuses).toContain('fake-model-opt HTTP 400 · 요청 형식 거부');
});
