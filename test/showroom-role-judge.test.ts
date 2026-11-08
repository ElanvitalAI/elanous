// R6 Task 5 · §6.1 LLM-judge — daemon-side coverage (2026-05-09).
//
// Network-bounded path is exercised via a stub fetch on globalThis;
// the parser / hybrid composer / endpoint dispatch all run in-process.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildJudgePromptMessages,
  parseJudgeReply,
} from '../src/showroom/role-judge/prompt-template.js';
import { hybridClassify } from '../src/showroom/role-judge/index.js';
import { classifyWithLocalLlm } from '../src/showroom/role-judge/local-judge.js';
import {
  handleRoleJudge,
  resolveRoleJudgeBackend,
  resolveRoleJudgeModel,
} from '../src/nexus/api/role-judge.js';
import { createFakeFetchDevice, type FakeFetchDevice } from '../src/ux-sim/fake-fetch.js';

type FetchFn = typeof globalThis.fetch;

let fakeFetch: FakeFetchDevice | undefined;
let expectedFetchCalls: string[] | undefined;

function installFetch(stub: FetchFn, expectedCallCount = 1): void {
  fakeFetch?.restore();
  const url = 'http://localhost:1234/v1/chat/completions';
  expectedFetchCalls = Array.from({ length: expectedCallCount }, () => `POST ${url}`);
  fakeFetch = createFakeFetchDevice([{
    url,
    method: 'POST',
    response: (request) => stub(request.url, {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body !== null ? { body: request.body } : {}),
      signal: request.signal,
    }),
  }]);
}

afterEach(() => {
  try {
    if (fakeFetch && expectedFetchCalls) {
      expect(fakeFetch.calls().map(({ method, url }) => `${method} ${url}`).sort()).toEqual([...expectedFetchCalls].sort());
    }
  } finally {
    fakeFetch?.restore();
    fakeFetch = undefined;
    expectedFetchCalls = undefined;
    delete process.env.ELANOUS_SHOWROOM_ROLE_JUDGE_BACKEND;
    delete process.env.ELANOUS_SHOWROOM_ROLE_JUDGE_MODEL;
    delete process.env.ELANOUS_SHOWROOM_ROLE_JUDGE_MODEL_FALLBACK;
  }
});

describe('prompt-template · buildJudgePromptMessages', () => {
  test('messages start with system prompt + 6 few-shot exchanges', () => {
    const m = buildJudgePromptMessages({ userPrompt: 'hello' });
    expect(m[0]?.role).toBe('system');
    // 1 system + 6 (user/assistant pairs) + 1 final user = 14
    expect(m.length).toBe(14);
    expect(m[m.length - 1]?.role).toBe('user');
    expect(m[m.length - 1]?.content).toBe('hello');
  });

  test('availableRoles annotation appended to user prompt', () => {
    const m = buildJudgePromptMessages({
      userPrompt: 'foo',
      availableRoles: ['plan', 'review'],
    });
    expect(m[m.length - 1]?.content).toContain('foo');
    expect(m[m.length - 1]?.content).toContain('plan, review');
  });
});

describe('prompt-template · parseJudgeReply', () => {
  test('clean JSON object → role label', () => {
    expect(parseJudgeReply('{"role":"plan"}')).toBe('plan');
    expect(parseJudgeReply('{"role":"exec"}')).toBe('exec');
    expect(parseJudgeReply('{"role":"review"}')).toBe('review');
    expect(parseJudgeReply('{"role":"reflect"}')).toBe('reflect');
  });

  test('strips markdown code fence', () => {
    expect(parseJudgeReply('```json\n{"role":"plan"}\n```')).toBe('plan');
    expect(parseJudgeReply('```\n{"role":"review"}\n```')).toBe('review');
  });

  test('tolerates surrounding whitespace + leading punctuation', () => {
    expect(parseJudgeReply('   {"role":"plan"}   ')).toBe('plan');
    expect(parseJudgeReply('. {"role":"plan"} .')).toBe('plan');
  });

  test('unknown role → null', () => {
    expect(parseJudgeReply('{"role":"discuss"}')).toBeNull();
  });

  test('non-JSON / empty / no object → null', () => {
    expect(parseJudgeReply('')).toBeNull();
    expect(parseJudgeReply('the role is plan')).toBeNull();
    expect(parseJudgeReply('not json at all')).toBeNull();
  });
});

describe('hybridClassify · keyword tier short-circuits', () => {
  test('keyword hit → keyword source · no LLM call', async () => {
    let calls = 0;
    const stub = (async () => {
      calls += 1;
      return new Response();
    }) as unknown as FetchFn;
    installFetch(stub, 0);
    const result = await hybridClassify({
      userPrompt: '리뷰',
      keywordClassifier: () => 'review',
      useLocalLlm: true,
      localLlm: { model: 'google/gemma-4-e4b' },
    });
    expect(result.role).toBe('review');
    expect(result.source).toBe('keyword');
    expect(calls).toBe(0);
  });

  test('keyword null + useLocalLlm=false → fallback · no LLM call', async () => {
    let calls = 0;
    const stub = (async () => {
      calls += 1;
      return new Response();
    }) as unknown as FetchFn;
    installFetch(stub, 0);
    const result = await hybridClassify({
      userPrompt: 'unknown',
      keywordClassifier: () => null,
      useLocalLlm: false,
    });
    expect(result.role).toBeNull();
    expect(result.source).toBe('fallback');
    expect(calls).toBe(0);
  });

  test('keyword null + useLocalLlm=true → calls LLM and parses reply', async () => {
    const stub = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"role":"plan"}' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as FetchFn;
    installFetch(stub);
    const result = await hybridClassify({
      userPrompt: 'ambiguous prompt',
      keywordClassifier: () => null,
      useLocalLlm: true,
      localLlm: { model: 'google/gemma-4-e4b' },
    });
    expect(result.role).toBe('plan');
    expect(result.source).toBe('local-llm');
    expect(result.llm?.ok).toBe(true);
  });

  test('keyword null + LLM unparseable → fallback · failure detail attached', async () => {
    const stub = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'hmm not json' } }] }),
        { status: 200 },
      )) as unknown as FetchFn;
    installFetch(stub);
    const result = await hybridClassify({
      userPrompt: 'ambiguous',
      keywordClassifier: () => null,
      useLocalLlm: true,
      localLlm: { model: 'google/gemma-4-e4b' },
    });
    expect(result.role).toBeNull();
    expect(result.source).toBe('fallback');
    expect(result.llm?.ok).toBe(false);
    expect(result.llm && !result.llm.ok && result.llm.reason).toBe('parse');
  });
});

describe('classifyWithLocalLlm · transport branches', () => {
  test('non-2xx → http reason', async () => {
    const stub = (async () => new Response('rate limited', { status: 429 })) as unknown as FetchFn;
    installFetch(stub);
    const r = await classifyWithLocalLlm('foo', { model: 'gemma' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('http');
  });

  test('thrown fetch → network reason', async () => {
    const stub = (async () => { throw new Error('econnrefused'); }) as unknown as FetchFn;
    installFetch(stub);
    const r = await classifyWithLocalLlm('foo', { model: 'gemma' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('network');
      expect(r.detail).toContain('econnrefused');
    }
  });

  test('AbortError → timeout reason when the request signal aborts', async () => {
    let observedSignal: AbortSignal | null | undefined;
    const stub = (async (_url: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init?.signal;
      const abort = () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (!init?.signal) {
        reject(new Error('request signal was not provided'));
        return;
      }
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
    })) as unknown as FetchFn;
    installFetch(stub);
    const r = await classifyWithLocalLlm('foo', { model: 'gemma', timeoutMs: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timeout');
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
  });
});

describe('handleRoleJudge endpoint', () => {
  test('GET → 405', async () => {
    const res = await handleRoleJudge(new Request('http://x/v1/showroom/role-judge'));
    expect(res.status).toBe(405);
  });

  test('invalid json body → 400', async () => {
    const res = await handleRoleJudge(
      new Request('http://x/v1/showroom/role-judge', {
        method: 'POST',
        body: 'not json',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(400);
  });

  test('empty prompt → 400', async () => {
    const res = await handleRoleJudge(
      new Request('http://x/v1/showroom/role-judge', {
        method: 'POST',
        body: JSON.stringify({ prompt: '   ' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(400);
  });

  test('default backend = keyword · keyword hit returns role', async () => {
    const res = await handleRoleJudge(
      new Request('http://x/v1/showroom/role-judge', {
        method: 'POST',
        body: JSON.stringify({ prompt: '이 PR 리뷰' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string; source: string; backend: string };
    expect(body.role).toBe('review');
    expect(body.source).toBe('keyword');
    expect(body.backend).toBe('keyword');
  });

  test('checkAuth=false → 401', async () => {
    const res = await handleRoleJudge(
      new Request('http://x/v1/showroom/role-judge', { method: 'POST', body: '{}' }),
      { checkAuth: () => false },
    );
    expect(res.status).toBe(401);
  });
});

describe('resolveRoleJudgeBackend / resolveRoleJudgeModel', () => {
  test('backend default = keyword', () => {
    expect(resolveRoleJudgeBackend({})).toBe('keyword');
  });

  test('backend env override > opts > default', () => {
    expect(resolveRoleJudgeBackend({ backend: 'local-llm' })).toBe('local-llm');
    process.env.ELANOUS_SHOWROOM_ROLE_JUDGE_BACKEND = 'keyword';
    expect(resolveRoleJudgeBackend({ backend: 'local-llm' })).toBe('keyword');
  });

  test('model default = mlx-community/gemma-4-26b-a4b-it (micro.2a · non-reasoning)', () => {
    expect(resolveRoleJudgeModel({})).toBe('mlx-community/gemma-4-26b-a4b-it');
  });

  test('model env override > opts > default', () => {
    expect(resolveRoleJudgeModel({ model: 'qwen3.5-9b-mlx' })).toBe('qwen3.5-9b-mlx');
    process.env.ELANOUS_SHOWROOM_ROLE_JUDGE_MODEL = 'gemma-4-26b-a4b-it';
    expect(resolveRoleJudgeModel({ model: 'qwen3.5-9b-mlx' })).toBe('gemma-4-26b-a4b-it');
  });
});

describe('FU.5 (2026-05-09) — body backend / model override', () => {
  test('body.backend = "local-llm" overrides default keyword', async () => {
    const stub = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"role":"plan"}' } }] }),
        { status: 200 },
      )) as unknown as FetchFn;
    installFetch(stub, 0);
    const res = await handleRoleJudge(
      new Request('http://x/v1/showroom/role-judge', {
        method: 'POST',
        body: JSON.stringify({
          // ambiguous — keyword null
          prompt: '음 그거 좀 살펴봐',
          backend: 'local-llm',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backend: string; source: string };
    expect(body.backend).toBe('local-llm');
    // 이 prompt 가 keyword 매치 ("살펴" → review) 인지 확인 — body 무관 keyword hit
    expect(body.source).toBe('keyword');
  });

  test('body.model overrides resolveRoleJudgeModel default', async () => {
    let captured = '';
    const stub = (async (_url: unknown, init?: RequestInit) => {
      captured = (init?.body as string | undefined) ?? '';
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"role":"plan"}' } }] }),
        { status: 200 },
      );
    }) as unknown as FetchFn;
    installFetch(stub);
    const res = await handleRoleJudge(
      new Request('http://x/v1/showroom/role-judge', {
        method: 'POST',
        body: JSON.stringify({
          prompt: 'totally unknown content',
          backend: 'local-llm',
          model: 'qwen2.5-3b-instruct',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(200);
    const parsed = JSON.parse(captured) as { model: string };
    expect(parsed.model).toBe('qwen2.5-3b-instruct');
    const body = (await res.json()) as { model?: string };
    expect(body.model).toBe('qwen2.5-3b-instruct');
  });

  test('body.backend invalid → falls back to env/opts/default', async () => {
    const res = await handleRoleJudge(
      new Request('http://x/v1/showroom/role-judge', {
        method: 'POST',
        body: JSON.stringify({
          prompt: '이 PR 리뷰',
          backend: 'cloud-haiku' as unknown as 'keyword',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backend: string; role: string };
    expect(body.backend).toBe('keyword');
    expect(body.role).toBe('review');
  });
});

describe('FU.1 (2026-05-09) — max_tokens + timeout reasoning-safe defaults', () => {
  test('max_tokens default 1024 honoured in request body', async () => {
    let capturedBody = '';
    const stub = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = (init?.body as string | undefined) ?? '';
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"role":"plan"}' } }] }),
        { status: 200 },
      );
    }) as unknown as FetchFn;
    installFetch(stub);
    await classifyWithLocalLlm('foo', { model: 'gemma' });
    const parsed = JSON.parse(capturedBody) as { max_tokens?: number };
    expect(parsed.max_tokens).toBe(1024);
  });

  test('ELANOUS_SHOWROOM_ROLE_JUDGE_MAX_TOKENS env overrides default', async () => {
    process.env.ELANOUS_SHOWROOM_ROLE_JUDGE_MAX_TOKENS = '512';
    let capturedBody = '';
    const stub = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = (init?.body as string | undefined) ?? '';
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"role":"plan"}' } }] }),
        { status: 200 },
      );
    }) as unknown as FetchFn;
    installFetch(stub);
    await classifyWithLocalLlm('foo', { model: 'gemma' });
    const parsed = JSON.parse(capturedBody) as { max_tokens?: number };
    expect(parsed.max_tokens).toBe(512);
    delete process.env.ELANOUS_SHOWROOM_ROLE_JUDGE_MAX_TOKENS;
  });

  test('reasoning_content fallback parses when content empty', async () => {
    const stub = (async () =>
      new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: '',
              reasoning_content: 'Thinking…\n\nFinal: {"role":"reflect"}',
            },
          }],
        }),
        { status: 200 },
      )) as unknown as FetchFn;
    installFetch(stub);
    const r = await classifyWithLocalLlm('foo', { model: 'gemma' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.role).toBe('reflect');
  });
});
