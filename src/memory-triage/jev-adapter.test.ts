// MEMORY-TRIAGE-NO-LLM 문 ① — Jev 어댑터. 가짜 클라이언트·가짜 fetch 만(실제 HTTP·키 파일 읽기 0).
import { describe, expect, test } from 'bun:test';
import { JEV_ENDPOINT, type JevRequest, type JevResponse } from '../decide/jev.js';
import { MEMORY_JEV_QUESTION_TEXT, isLoopbackEndpoint, judgeMemoryWriteWithJev, memoryJevEgressAllowed, type MemoryJevDeps } from './jev-adapter.js';
import type { MemoryGateRow, MemoryTriageLog } from './write-gate.js';

type Ev = { event: string; data: Record<string, unknown> };
const LOCAL = 'http://127.0.0.1:8787/v1/systemone';

function harness(answer: (req: JevRequest) => JevResponse | Promise<JevResponse>, over: Partial<MemoryJevDeps> = {}) {
  const calls: JevRequest[] = [];
  const events: Ev[] = [];
  let accessReads = 0;
  const log: MemoryTriageLog = (_c, event, data) => { events.push({ event, data }); };
  const deps: MemoryJevDeps = {
    peekEndpoint: () => JEV_ENDPOINT,
    resolveAccess: () => { accessReads += 1; return { ok: true, access: { endpoint: JEV_ENDPOINT, endpointSource: 'default', key: 'fake-not-a-key' } }; },
    callJev: async (req) => { calls.push(req); return answer(req); },
    log,
    ...over,
  };
  return { deps, calls, events, accessReads: () => accessReads };
}
const answer = (over: Partial<JevResponse['answers']> = {}): JevResponse => ({
  model: 'jev-fake',
  answers: {
    durable: { type: 'noul', noul: 0.9 },
    scope: { type: 'choice', choice: 'role' },
    kind: { type: 'choice', choice: 'verified_method' },
    ...over,
  },
});
const judge = (deps: MemoryJevDeps, candidates: MemoryGateRow[] = [], audience: 'hq-seat' | 'member' = 'hq-seat') =>
  judgeMemoryWriteWithJev({ text: '교훈 BODY-MARK-jev', sourceEventId: 'repl:s1/request-1', audience, candidates, store: 'seat', origin: 'test', seat: 'TC' }, deps);

describe('한 요청 fan-out', () => {
  test('질문 문면 고정 · state 경계 · score 없음 · 후보가 없으면 dup 질문도 없다', async () => {
    const h = harness(() => answer());
    expect(await judge(h.deps)).toEqual({ ok: true, durable: 0.9, scope: 'role', kind: '확인된 방법', dupTargetId: null, model: 'jev-fake' });
    const req = h.calls[0]!;
    expect(req.questions.durable).toMatchObject({ type: 'noul', instructions: MEMORY_JEV_QUESTION_TEXT.durable });
    expect(req.questions.scope).toMatchObject({ type: 'choice', instructions: MEMORY_JEV_QUESTION_TEXT.scope });
    expect(Object.values(req.questions).map(q => q.type)).not.toContain('score');
    expect(req.questions.dup).toBeUndefined();
    const state = JSON.stringify(req.state);
    expect(state).toContain('BEGIN UNTRUSTED MEMORY STATE');
    expect(state).toContain('END UNTRUSTED MEMORY STATE');
  });

  test('dup — 후보 key ⊕ none 를 묻고 고른 key 를 줄 id 로 돌려준다', async () => {
    const h = harness(() => answer({ dup: { type: 'choice', choice: 'cand_1' } }));
    const out = await judge(h.deps, [{ id: 'land-rule.md', text: '착지는 pr land 하나로만 한다' }]);
    expect(out).toMatchObject({ ok: true, dupTargetId: 'land-rule.md' });
    expect(Object.keys((h.calls[0]!.questions.dup as { criteria: Record<string, unknown> }).criteria)).toEqual(['cand_1', 'none']);
  });
});

describe('떨어지기(jev-fallback)', () => {
  test('요청 실패', async () => {
    const h = harness(() => { throw new Error('Jev HTTP 503'); });
    expect(await judge(h.deps)).toEqual({ ok: false, reason: 'request-failed' });
    expect(h.events.map(e => [e.event, e.data.cause])).toEqual([['jev-fallback', 'request-failed']]);
  });

  test('키 없음 — 부르지 않는다', async () => {
    const h = harness(() => answer(), { resolveAccess: () => ({ ok: false }) });
    expect(await judge(h.deps)).toEqual({ ok: false, reason: 'no-key' });
    expect(h.calls).toHaveLength(0);
  });

  test('물은 답이 하나라도 없거나 기준 밖이면 판정 전체를 버린다', async () => {
    const missingKind = harness(() => ({ model: 'm', answers: { durable: { type: 'noul', noul: 0.1 }, scope: { type: 'choice', choice: 'seat' } } }));
    expect(await judge(missingKind.deps)).toEqual({ ok: false, reason: 'invalid-answer' });
    const badDup = harness(() => answer({ dup: { type: 'choice', choice: 'cand_9' } }));
    expect(await judge(badDup.deps, [{ id: 'a.md', text: 'x' }])).toEqual({ ok: false, reason: 'invalid-answer' });
    const missingDup = harness(() => answer());
    expect(await judge(missingDup.deps, [{ id: 'a.md', text: 'x' }])).toEqual({ ok: false, reason: 'invalid-answer' });
    const outOfRange = harness(() => answer({ durable: { type: 'noul', noul: 1.5 } }));
    expect(await judge(outOfRange.deps)).toEqual({ ok: false, reason: 'no-answer' });
    // 프로토타입 키는 기준이 아니다 — kind·scope·dup 모두.
    for (const bad of ['constructor', 'toString', '__proto__']) {
      expect(await judge(harness(() => answer({ kind: { type: 'choice', choice: bad } })).deps)).toEqual({ ok: false, reason: 'invalid-answer' });
      expect(await judge(harness(() => answer({ scope: { type: 'choice', choice: bad } })).deps)).toEqual({ ok: false, reason: 'invalid-answer' });
      expect(await judge(harness(() => answer({ dup: { type: 'choice', choice: bad } })).deps, [{ id: 'a.md', text: 'x' }])).toEqual({ ok: false, reason: 'invalid-answer' });
    }
  });

  test('시간 초과 — 끝나지 않는 요청을 끊고(abort) timeout 으로 떨어진다', async () => {
    const signals: AbortSignal[] = [];
    const neverFetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const h = harness(() => answer(), {
      callJev: (_req, _key, fetchImpl, endpoint) => fetchImpl(endpoint, {}).then(() => answer()),
      fetch: neverFetch,
      // 출처: R-TST40 — 벽시계로 판정하지 않는다. 1ms 는 «끝나지 않는 요청을 곧바로 끊는다»를 만드는 주입값이다
      timeoutMs: 1,
    });
    expect(await judge(h.deps)).toEqual({ ok: false, reason: 'timeout' });
    expect(h.events.map(e => [e.event, e.data.cause])).toEqual([['jev-fallback', 'timeout']]);
    expect(signals.map(sig => sig.aborted)).toEqual([true]);
  });

  test('보낼 곳을 못 정하면 endpoint-unavailable', async () => {
    const h = harness(() => answer(), { peekEndpoint: () => { throw new Error('config unreadable'); } });
    expect(await judge(h.deps)).toEqual({ ok: false, reason: 'endpoint-unavailable' });
    expect(h.calls).toHaveLength(0);
  });

  test('사건에 기억 문장이 없다', async () => {
    const h = harness(() => { throw new Error('down'); });
    await judge(h.deps);
    expect(JSON.stringify(h.events)).not.toContain('BODY-MARK');
  });
});

describe('반출', () => {
  test('회원 기억 — 원격이면 부르지 않고 키도 읽지 않는다 · loopback 이면 부른다', async () => {
    const remote = harness(() => answer());
    expect(await judge(remote.deps, [], 'member')).toEqual({ ok: false, reason: 'egress-not-allowed' });
    expect(remote.calls).toHaveLength(0);
    expect(remote.accessReads()).toBe(0);
    const local = harness(() => answer(), {
      peekEndpoint: () => LOCAL,
      resolveAccess: () => ({ ok: true, access: { endpoint: LOCAL, endpointSource: 'config' } }),
    });
    expect(await judge(local.deps, [], 'member')).toMatchObject({ ok: true });
    expect(local.calls).toHaveLength(1);
  });

  test('loopback 은 IP 리터럴로만 판정한다(localhost 이름도 아니다)', () => {
    expect(isLoopbackEndpoint('http://127.evil.com/v1/systemone')).toBe(false);
    expect(isLoopbackEndpoint('http://localhost.evil.com/v1/systemone')).toBe(false);
    expect(isLoopbackEndpoint('http://localhost:8787/v1/systemone')).toBe(false);
    expect(isLoopbackEndpoint(LOCAL)).toBe(true);
    expect(isLoopbackEndpoint('http://[::1]:8787/v1/systemone')).toBe(true);
    expect(memoryJevEgressAllowed('hq-seat', JEV_ENDPOINT)).toBe(true);
    expect(memoryJevEgressAllowed('member', JEV_ENDPOINT)).toBe(false);
  });

  test('리다이렉트를 따르지 않는다', async () => {
    const inits: RequestInit[] = [];
    const fakeFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response(JSON.stringify(answer()), { status: 200 });
    }) as typeof fetch;
    const deps: MemoryJevDeps = {
      peekEndpoint: () => JEV_ENDPOINT,
      resolveAccess: () => ({ ok: true, access: { endpoint: JEV_ENDPOINT, endpointSource: 'default', key: 'fake-not-a-key' } }),
      fetch: fakeFetch,
      log: () => {},
    };
    expect(await judge(deps)).toMatchObject({ ok: true });
    expect(inits.map(i => i.redirect)).toEqual(['error']);
  });
});
