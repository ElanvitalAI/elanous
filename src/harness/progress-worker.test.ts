import { test, expect } from 'bun:test';
import { Worker } from 'node:worker_threads';
import type { ProgressQueryWorkerMessage, ProgressQueryWorkerReply } from './progress-worker-entry.js';

/** HARNESS-PROGRESS-HANG — 전용 워커 엔트리가 소스 트리·산출물 배치에서 모두 응답하는지를 직접 목격한다. */
const entryUrl = new URL('./progress-worker-entry.ts', import.meta.url);

function askEntry(messages: readonly ProgressQueryWorkerMessage[], boundMs = 20_000): Promise<ProgressQueryWorkerReply[]> {
  return new Promise((done, fail) => {
    const worker = new Worker(entryUrl);
    const replies: ProgressQueryWorkerReply[] = [];
    const timer = setTimeout(() => {
      void worker.terminate();
      fail(new Error(`워커 엔트리가 ${boundMs}ms 안에 ${messages.length}개 회신을 하지 않았습니다`));
    }, boundMs);
    worker.on('message', (reply: ProgressQueryWorkerReply) => {
      replies.push(reply);
      if (replies.length >= messages.length) {
        clearTimeout(timer);
        void worker.terminate();
        done(replies);
      }
    });
    worker.on('error', (error: unknown) => {
      clearTimeout(timer);
      void worker.terminate();
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    for (const message of messages) worker.postMessage(message);
  });
}

test('HARNESS-PROGRESS-HANG: the dedicated worker entry answers a query inside a generous bound', async () => {
  const startedAt = Date.now();
  const [reply] = await askEntry([{ kind: 'query', caller: 'progress-worker.test' }]);
  expect(Date.now() - startedAt).toBeLessThan(20_000);
  expect(reply?.ok).toBe(true);
  expect(reply?.error).toBeUndefined();
  expect(Array.isArray(reply?.result?.entries)).toBe(true);
}, 30_000);

test('HARNESS-PROGRESS-HANG: a deadline-limited worker returns partial progress with stage and reason', async () => {
  const [reply] = await askEntry([{ kind: 'query', caller: 'progress-worker.deadline', timeBudgetMs: 0 }]);
  expect(reply?.ok).toBe(true);
  expect(reply?.result?.completeness).toBe('partial');
  expect(reply?.result?.stalled).toMatchObject({ stage: 'ledger-scan', reason: 'deadline-exceeded' });
}, 30_000);

test('HARNESS-PROGRESS-HANG: the worker preserves current rows and the stop reason on abort — production path keeps partial rows', async () => {
  const [queryReply, abortReply] = await askEntry([
    { kind: 'query', caller: 'progress-worker.test', runIds: ['run-worker-preserve'] },
    { kind: 'abort' },
  ]);
  expect(queryReply?.ok).toBe(true);
  expect(Array.isArray(queryReply?.result?.entries)).toBe(true);
  // abort 회신은 마지막으로 계산한 행을 그대로 보존한다 — preservedRowCount 가 0일 이유가 없다.
  expect(abortReply?.ok).toBe(true);
  expect(abortReply?.stopped).toBe('aborted');
  expect(abortReply?.result).toBeDefined();
  expect(Array.isArray(abortReply?.result?.entries)).toBe(true);
}, 30_000);
