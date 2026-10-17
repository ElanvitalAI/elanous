// TUI-OBS-400-SHAPE(#69) — Codex 가 요청을 4xx 로 거절하면 «모양» 만 남기고 내용은 싣지 않는다.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { streamCodexResponsesEvents } from '../src/llm';
import { debug } from '../src/debug/log';
import { isShapeRelevantRejection } from '../src/llm-request-shape';

const endpoint = 'https://chatgpt.com/backend-api/codex/responses';
const SECRET = 'SECRET-PROMPT-한글-7f3a9c';
const SECRET_ARG = 'SECRET-TOOL-ARG-b81e';
const SECRET_OUT = 'SECRET-TOOL-OUTPUT-c42d';
const SECRET_SYS = 'SECRET-INSTRUCTIONS-d913';

let priorFetch: typeof fetch;
let sentBodies: string[] = [];
let priorRunId: string | undefined;
let priorHostId: string | undefined;

function installStatus(status: number, bodyText: string): void {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sentBodies.push(String(init?.body ?? ''));
    if (status === 200) {
      const sse = 'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: [DONE]\n\n';
      return new Response(new TextEncoder().encode(sse), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(bodyText, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const input = [
  { role: 'user', content: [{ type: 'input_text', text: SECRET }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }] },
  { role: 'assistant', content: [{ type: 'output_text', text: '' }] },
  { type: 'function_call', name: 'RunShell', arguments: JSON.stringify({ command: SECRET_ARG }), call_id: 'call_paired' },
  { type: 'function_call_output', call_id: 'call_paired', output: SECRET_OUT },
  // 짝 깨짐 ①: 호출만 있고 결과 없음 (SIGTERM 으로 도구 호출 도중 끊긴 기록 꼴)
  { type: 'function_call', name: 'Read', arguments: '{}', call_id: 'call_dangling' },
  // 짝 깨짐 ②: 결과만 있고 호출 없음
  { type: 'function_call_output', call_id: 'call_orphan', output: [{ type: 'input_text', text: SECRET_OUT }] },
  { role: 'user', content: [{ type: 'input_text', text: SECRET }] },
];
const body = {
  model: 'gpt-6-sol',
  instructions: SECRET_SYS,
  input,
  tools: [{ type: 'function', name: 'RunShell', description: 'run', parameters: {} }],
  reasoning: { effort: 'high' as const, summary: 'auto' as const },
};

async function drive(): Promise<Error | undefined> {
  try {
    for await (const _e of streamCodexResponsesEvents(endpoint, 'bearer-SECRET-KEY', body, undefined, { promptCache: false })) { /* drain */ }
    return undefined;
  } catch (err) {
    return err as Error;
  }
}

function capture(): { seen: Array<{ category: string; event: string; data?: unknown }>; off: () => void } {
  const seen: Array<{ category: string; event: string; data?: unknown }> = [];
  const off = debug.registerSink({
    name: `codex-rejected-shape-${Math.random()}`,
    emit: (r) => seen.push({ category: r.category, event: r.event, data: r.data }),
  });
  return { seen, off };
}

const shapeEvents = (seen: Array<{ category: string; event: string; data?: unknown }>) =>
  seen.filter((r) => r.category === 'llm.codex' && r.event === 'request-rejected-shape');

beforeEach(() => {
  priorFetch = globalThis.fetch;
  sentBodies = [];
  priorRunId = process.env.ELANOUS_RUN_ID;
  delete process.env.ELANOUS_RUN_ID;
  priorHostId = process.env.ELANOUS_HOST_ID;
  delete process.env.ELANOUS_HOST_ID;
});

afterEach(() => {
  globalThis.fetch = priorFetch;
  if (priorRunId === undefined) delete process.env.ELANOUS_RUN_ID;
  else process.env.ELANOUS_RUN_ID = priorRunId;
  if (priorHostId === undefined) delete process.env.ELANOUS_HOST_ID;
  else process.env.ELANOUS_HOST_ID = priorHostId;
});

describe('Codex 4xx request-rejected-shape observation', () => {
  test('400 → one event with exact sizes, counts and broken-pair counts, no content', async () => {
    installStatus(400, '{"detail":"Bad Request"}');
    const { seen, off } = capture();
    let err: Error | undefined;
    try { err = await drive(); } finally { off(); }
    // 오류 계약은 그대로 — 원래 ApiHttpError 문면이 호출부까지 간다.
    expect(err?.message).toContain('Codex API 400');
    expect(sentBodies.length).toBeGreaterThanOrEqual(1);
    const events = shapeEvents(seen);
    expect(events.length).toBe(1);
    const d = events[0]!.data as Record<string, any>;
    const wire = sentBodies[sentBodies.length - 1]!;
    expect(d.status).toBe(400);
    expect(d.bytes).toBe(Buffer.byteLength(wire, 'utf8'));
    expect(d.instructionsBytes).toBe(Buffer.byteLength(SECRET_SYS, 'utf8'));
    expect(d.inputItemCount).toBe(7);
    expect(d.messageCount).toBe(3);
    expect(d.roleCounts).toEqual({ user: 2, assistant: 1 });
    expect(d.itemTypeCounts).toEqual({ message: 3, function_call: 2, function_call_output: 2 });
    expect(d.contentTypeCounts).toEqual({ input_text: 3, input_image: 1, output_text: 1, string: 1 });
    expect(d.emptyTextBlockCount).toBe(1);
    expect(d.toolCallCount).toBe(2);
    expect(d.toolResultCount).toBe(2);
    expect(d.unpairedToolCallCount).toBe(1);
    expect(d.orphanToolResultCount).toBe(1);
    expect(d.toolResultBeforeCallCount).toBe(0);
    expect(d.unpairedToolCallIdHashes).toEqual([createHash('sha256').update('call_dangling').digest('hex').slice(0, 8)]);
    expect(d.orphanToolResultIdHashes).toEqual([createHash('sha256').update('call_orphan').digest('hex').slice(0, 8)]);
    expect(d.toolDefinitionCount).toBe(1);
    expect(d.model).toBe('gpt-6-sol');
    expect(d.reasoningEffort).toBe('high');
    expect(d.store).toBe(false);
    expect(d.hasPreviousResponseId).toBe(false);
    expect(d.errorBodyBytes).toBe(Buffer.byteLength('{"detail":"Bad Request"}', 'utf8'));
    // ⛔ 내용 0 — 프롬프트·도구 인자·도구 출력·시스템 지시·키·call_id 원문이 이벤트 어디에도 없다.
    const serialized = JSON.stringify(events[0]);
    for (const needle of [SECRET, SECRET_ARG, SECRET_OUT, SECRET_SYS, 'bearer-SECRET-KEY', 'call_dangling', 'call_orphan', 'Bad Request', 'base64']) {
      expect(serialized).not.toContain(needle);
    }
  });

  test('200 → zero shape events', async () => {
    installStatus(200, '');
    const { seen, off } = capture();
    let err: Error | undefined;
    try { err = await drive(); } finally { off(); }
    expect(err).toBeUndefined();
    expect(shapeEvents(seen).length).toBe(0);
  });

  test('401 (auth) → zero shape events, error still thrown', async () => {
    installStatus(401, '{"detail":"invalidated oauth token"}');
    const { seen, off } = capture();
    let err: Error | undefined;
    try { err = await drive(); } finally { off(); }
    expect(err?.message).toContain('Codex API 401');
    expect(shapeEvents(seen).length).toBe(0);
  });

  test('tool output before its call is counted', async () => {
    installStatus(400, '{"detail":"Bad Request"}');
    const { seen, off } = capture();
    const reordered = {
      ...body,
      input: [
        { type: 'function_call_output', call_id: 'call_x', output: 'o' },
        { type: 'function_call', name: 'Read', arguments: '{}', call_id: 'call_x' },
      ],
    };
    try {
      for await (const _e of streamCodexResponsesEvents(endpoint, 'b', reordered, undefined, { promptCache: false })) { /* drain */ }
    } catch { /* expected */ } finally { off(); }
    const d = shapeEvents(seen)[0]!.data as Record<string, any>;
    expect(d.toolResultBeforeCallCount).toBe(1);
    expect(d.unpairedToolCallCount).toBe(0);
    expect(d.orphanToolResultCount).toBe(0);
    expect(d.messageCount).toBe(0);
  });

  test('unknown type/role/content strings fold into `unknown` keys — no content leaks through count keys', async () => {
    installStatus(400, '{"detail":"Bad Request"}');
    const { seen, off } = capture();
    const malformed = {
      ...body,
      tool_choice: SECRET_ARG,
      reasoning: { effort: SECRET_OUT, summary: SECRET_SYS },
      input: [
        { role: SECRET, content: [{ type: SECRET_ARG, text: 'x' }] },
        { type: SECRET_OUT, payload: 'y' },
      ],
    } as unknown as typeof body;
    try {
      for await (const _e of streamCodexResponsesEvents(endpoint, 'b', malformed, undefined, { promptCache: false })) { /* drain */ }
    } catch { /* expected */ } finally { off(); }
    const events = shapeEvents(seen);
    expect(events.length).toBe(1);
    const d = events[0]!.data as Record<string, any>;
    expect(d.roleCounts).toEqual({ unknown: 1 });
    expect(d.itemTypeCounts).toEqual({ message: 1, unknown: 1 });
    expect(d.contentTypeCounts).toEqual({ unknown: 1 });
    expect(d.reasoningEffort).toBe('unknown');
    expect(d.reasoningSummary).toBe('unknown');
    const serialized = JSON.stringify(events[0]);
    for (const needle of [SECRET, SECRET_ARG, SECRET_OUT, SECRET_SYS]) expect(serialized).not.toContain(needle);
  });

  test('broken pairs are counted per item even when call_ids repeat', async () => {
    installStatus(400, '{"detail":"Bad Request"}');
    const { seen, off } = capture();
    const dup = {
      ...body,
      input: [
        { type: 'function_call', name: 'Read', arguments: '{}', call_id: 'call_dup' },
        { type: 'function_call', name: 'Read', arguments: '{}', call_id: 'call_dup' },
        { type: 'function_call_output', call_id: 'call_lost', output: 'a' },
        { type: 'function_call_output', call_id: 'call_lost', output: 'b' },
        { type: 'function_call', name: 'Read', arguments: '{}', call_id: 'call_ok' },
        { type: 'function_call', name: 'Read', arguments: '{}', call_id: 'call_ok' },
        { type: 'function_call_output', call_id: 'call_ok', output: 'c' },
      ],
    };
    try {
      for await (const _e of streamCodexResponsesEvents(endpoint, 'b', dup, undefined, { promptCache: false })) { /* drain */ }
    } catch { /* expected */ } finally { off(); }
    const d = shapeEvents(seen)[0]!.data as Record<string, any>;
    expect(d.toolCallCount).toBe(4);
    expect(d.toolResultCount).toBe(3);
    expect(d.unpairedToolCallCount).toBe(2);
    expect(d.orphanToolResultCount).toBe(2);
    expect(d.duplicateToolCallIdCount).toBe(2);
    expect(d.toolResultBeforeCallCount).toBe(0);
    expect(d.unpairedToolCallIdHashes).toEqual([createHash('sha256').update('call_dup').digest('hex').slice(0, 8)]);
    expect(d.orphanToolResultIdHashes).toEqual([createHash('sha256').update('call_lost').digest('hex').slice(0, 8)]);
  });

  test('shape-relevant status filter', () => {
    expect([400, 404, 413, 422].every(isShapeRelevantRejection)).toBe(true);
    expect([200, 401, 403, 429, 500].some(isShapeRelevantRejection)).toBe(false);
  });
});
