import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { handleIntakeRoutePost, INTAKE_ROUTE_MAX_TEXT_BYTES, INTAKE_ROUTE_CLASSIFY_TIMEOUT_MS } from './intake-route.js';

const logged: Array<{ category: string; event: string; data: unknown }> = [];

// R-TST23 — spyOn ⊕ restore, not mock.module (which swaps debug for the whole test process).
let logSpy: ReturnType<typeof spyOn> | undefined;
beforeEach(() => {
  logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => {
    logged.push({ category, event, data });
  }) as typeof debug.log);
});

afterEach(() => {
  logSpy?.mockRestore();
  logSpy = undefined;
  logged.length = 0;
});

function post(body: unknown): Request {
  return new Request('http://127.0.0.1/v1/intake/route', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('200 응답은 판정 결과와 dryRun true · decidedBy 를 담는다', async () => {
  const res = await handleIntakeRoutePost(
    post({ text: 'https://youtu.be/x', consent: 'route', source: 'pwa', dryRun: false }),
  );
  expect(res.status).toBe(200);
  const body = await res.json() as Record<string, unknown>;
  expect(body.track).toBe('absorb');
  expect(body.decidedBy).toBe('rule');
  expect(body.dryRun).toBe(true);
  expect(typeof body.reason).toBe('string');
  expect(typeof body.confidence).toBe('number');
});

test('빈 text 는 400', async () => {
  const res = await handleIntakeRoutePost(post({ text: '   ', consent: 'route' }));
  expect(res.status).toBe(400);
  expect(logged).toHaveLength(0);
});

test('8KB 초과 text 는 400', async () => {
  const text = 'a'.repeat(INTAKE_ROUTE_MAX_TEXT_BYTES + 1);
  const res = await handleIntakeRoutePost(post({ text, consent: 'route' }));
  expect(res.status).toBe(400);
});

test('로그 데이터에 원문 문자열이 없고 textLength 만 있다', async () => {
  const text = '이거 정리해줘 https://a.example';
  const res = await handleIntakeRoutePost(post({ text, consent: 'route' }));
  expect(res.status).toBe(200);
  expect(logged).toHaveLength(1);
  const row = logged[0]!;
  expect(row.category).toBe('intake.route');
  expect(row.event).toBe('decided');
  const data = row.data as Record<string, unknown>;
  expect(data).toEqual({
    track: 'absorb',
    decidedBy: 'rule',
    confidence: data.confidence,
    textLength: new TextEncoder().encode(text).byteLength,
    classifierCalled: false,
  });
  expect(JSON.stringify(data)).not.toContain(text);
  expect(JSON.stringify(data)).not.toContain('https://a.example');
});

test('규칙 밖 글은 요청하지 않으면 분류기를 부르지 않고 규칙 판정을 반환한다', async () => {
  const calls: string[] = [];
  const classify = async (text: string) => {
    calls.push(text);
    return { track: 'graph' as const, confidence: 0.8, reason: 'intent', decidedBy: 'classifier' as const };
  };
  for (const classifyValue of [undefined, false, 'true']) {
    const res = await handleIntakeRoutePost(post({ text: '이 글 어떻게 할까요?', consent: 'route', classify: classifyValue }), { classify });
    expect(await res.json()).toEqual({ track: 'ask-human', confidence: 0, reason: 'rule-unknown', decidedBy: 'rule', dryRun: true });
  }
  expect(calls).toHaveLength(0);
  expect(logged.map((row) => (row.data as { classifierCalled: boolean }).classifierCalled)).toEqual([false, false, false]);
});

test('규칙 밖 글에 classify true 이면 한 번만 분류하고 길이만 기록한다', async () => {
  const text = '어느 쪽으로 갈까요?';
  const calls: string[] = [];
  const decision = { track: 'tasks' as const, confidence: 0.83, reason: 'intent', decidedBy: 'classifier' as const };
  const res = await handleIntakeRoutePost(post({ text, consent: 'route', classify: true }), {
    classify: async (value) => { calls.push(value); return decision; },
  });
  expect(calls).toEqual([text]);
  expect(await res.json()).toEqual({ ...decision, dryRun: true });
  expect(logged[0]!.data).toEqual({ track: 'tasks', decidedBy: 'classifier', confidence: 0.83, textLength: new TextEncoder().encode(text).byteLength, classifierCalled: true });
  expect(JSON.stringify(logged)).not.toContain(text);
});

test('규칙 판정 · consent 누락 · 사람 hint 는 classify true 여도 분류하지 않는다', async () => {
  let calls = 0;
  const classify = async () => { calls++; return { track: 'graph' as const, confidence: 0.9, reason: 'intent', decidedBy: 'classifier' as const }; };
  for (const [body, reason, decidedBy] of [
    [{ text: 'https://youtu.be/x', consent: 'route', classify: true }, 'url-only', 'rule'],
    [{ text: '어느 쪽일까요?', classify: true }, 'consent-missing', 'rule'],
    [{ text: '어느 쪽일까요?', consent: 'route', hint: 'absorb', classify: true }, 'hint', 'human'],
  ] as const) {
    const res = await handleIntakeRoutePost(post(body), { classify });
    expect(await res.json()).toMatchObject({ reason, decidedBy, dryRun: true });
  }
  expect(calls).toBe(0);
});

test('끝나지 않는 분류기는 제한 시간을 넘으면 timeout 판정한다', async () => {
  expect(INTAKE_ROUTE_CLASSIFY_TIMEOUT_MS).toBe(20_000);
  const res = await handleIntakeRoutePost(post({ text: '어느 쪽일까요?', consent: 'route', classify: true }), {
    classify: async () => new Promise(() => {}), classifyTimeoutMs: 20,
  });
  expect(await res.json()).toEqual({ track: 'ask-human', confidence: 0, reason: 'classifier-failed:timeout', decidedBy: 'classifier', dryRun: true });
  expect(logged[0]!.data).toMatchObject({ classifierCalled: true, decidedBy: 'classifier' });
});
