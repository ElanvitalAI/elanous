import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { streamCodexResponsesEvents } from '../src/llm';
import { debug } from '../src/debug/log';
import { createFakeFetchDevice, type FakeFetchDevice } from '../src/ux-sim/fake-fetch.js';

const endpoint = 'https://chatgpt.com/backend-api/codex/responses';
let fetchDevice: FakeFetchDevice | undefined;
let priorRunId: string | undefined;

function installSse(sse: string): void {
  fetchDevice?.restore();
  fetchDevice = createFakeFetchDevice([{
    url: '/backend-api/codex/responses', method: 'POST', response: () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  } }]);
}

async function streamFailure(payload: object): Promise<Error> {
  installSse(`data: ${JSON.stringify(payload)}\n\n`);
  try {
    for await (const _event of streamCodexResponsesEvents(
      endpoint,
      'bearer',
      { model: 'gpt-5-codex', instructions: 'sys', input: [] },
    )) { /* failure is thrown before an event yields */ }
    throw new Error('expected Codex stream failure');
  } catch (error) {
    return error as Error;
  }
}

// ⭐ 2026-09-25: `debug.log` 는 `ELANOUS_HOST_ID` 가 있으면 `hostId` 를 자동 부착한다(RFC 런 출처 O2 · #20468) —
//   앞 시험 파일의 `ensureRunIdentity` 가 env 에 남긴 값이 이 파일의 `toEqual` 을 깨지 않게 runId 처럼 비운다.
let priorHostId: string | undefined;
beforeEach(() => {
  priorRunId = process.env.ELANOUS_RUN_ID;
  delete process.env.ELANOUS_RUN_ID;
  priorHostId = process.env.ELANOUS_HOST_ID;
  delete process.env.ELANOUS_HOST_ID;
});

afterEach(() => {
  fetchDevice?.restore();
  fetchDevice = undefined;
  if (priorRunId === undefined) delete process.env.ELANOUS_RUN_ID;
  else process.env.ELANOUS_RUN_ID = priorRunId;
  if (priorHostId === undefined) delete process.env.ELANOUS_HOST_ID;
  else process.env.ELANOUS_HOST_ID = priorHostId;
});

describe('streamCodexResponsesEvents Codex error observability', () => {
  test('records response.failed provider diagnostics while preserving its error text', async () => {
    const seen: Array<{ category: string; event: string; data?: unknown }> = [];
    const off = debug.registerSink({
      name: 'codex-error-observability-capture',
      emit: (record) => seen.push({ category: record.category, event: record.event, data: record.data }),
    });
    try {
      const error = await streamFailure({
        type: 'response.failed',
        response: { error: { type: 'invalid_request_error', code: 'context_length_exceeded', param: 'input', message: 'input exceeds context window' } },
      });
      expect(error.message).toBe('Codex API error: input exceeds context window');
      const observation = seen.find((record) => record.category === 'llm.response.status' && record.event === 'codex response.failed');
      expect(observation?.data).toEqual({
        streamEventType: 'response.failed',
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        param: 'input',
        message: 'input exceeds context window',
      });
    } finally {
      off();
    }
  });

  test('omits missing provider diagnostics for error events instead of filling sentinel values', async () => {
    const seen: Array<{ category: string; event: string; data?: unknown }> = [];
    const off = debug.registerSink({
      name: 'codex-error-observability-omission',
      emit: (record) => seen.push({ category: record.category, event: record.event, data: record.data }),
    });
    try {
      const error = await streamFailure({ type: 'error', error: { message: 'server is overloaded' } });
      expect(error.message).toBe('Codex API error: server is overloaded');
      const observation = seen.find((record) => record.category === 'llm.response.status' && record.event === 'codex error');
      expect(observation?.data).toEqual({ streamEventType: 'error', message: 'server is overloaded' });
    } finally {
      off();
    }
  });

  test('omits the observation message when the provider omitted it while retaining legacy message priority', async () => {
    const seen: Array<{ category: string; event: string; data?: unknown }> = [];
    const off = debug.registerSink({
      name: 'codex-error-observability-message-omission',
      emit: (record) => seen.push({ category: record.category, event: record.event, data: record.data }),
    });
    try {
      const error = await streamFailure({
        type: 'response.failed',
        response: { error: { type: 'invalid_request_error', code: 'context_length_exceeded' } },
        error: { message: 'top-level message remains the legacy fallback' },
      });
      expect(error.message).toBe('Codex API error: top-level message remains the legacy fallback');
      const observation = seen.find((record) => record.category === 'llm.response.status' && record.event === 'codex response.failed');
      expect(observation?.data).toEqual({
        streamEventType: 'response.failed',
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
      });
    } finally {
      off();
    }
  });

  test('uses the legacy fallback message without synthesizing an observation message', async () => {
    const seen: Array<{ category: string; event: string; data?: unknown }> = [];
    const off = debug.registerSink({
      name: 'codex-error-observability-fallback',
      emit: (record) => seen.push({ category: record.category, event: record.event, data: record.data }),
    });
    try {
      const error = await streamFailure({ type: 'error' });
      expect(error.message).toBe('Codex API error: codex stream failed');
      const observation = seen.find((record) => record.category === 'llm.response.status' && record.event === 'codex error');
      expect(observation?.data).toEqual({ streamEventType: 'error' });
    } finally {
      off();
    }
  });

  test('propagates the original Codex error when the observation call itself throws', async () => {
    const originalLog = debug.log;
    const log = spyOn(debug, 'log').mockImplementation((category, event, ...args) => {
      if (category === 'llm.response.status' && event === 'codex error') throw new Error('observation failure');
      originalLog.call(debug, category, event, ...args);
    });
    try {
      const error = await streamFailure({ type: 'error', error: { message: 'provider failed' } });
      expect(log.mock.calls.filter(([category, event]) => category === 'llm.response.status' && event === 'codex error')).toHaveLength(1);
      expect(error.message).toBe('Codex API error: provider failed');
    } finally {
      log.mockRestore();
    }
  });
});
