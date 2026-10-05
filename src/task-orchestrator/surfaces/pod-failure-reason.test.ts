import { describe, expect, test } from 'bun:test';
import { extractPodFailureReason } from './pod-failure-reason.js';

describe('extractPodFailureReason', () => {
  test('takes the last error line, not the last bookkeeping line or a preceding error', () => {
    const logs = [
      'starting',
      'Error: stale failure',
      'Error: dependency unavailable',
      'at worker.ts:42',
      'ELANOUS_MEM 42 100 1:bun',
      'ELANOUS_RUN_LEDGER run-1 1/1 encoded',
      'ELANOUS_POD_SALVAGE_NONE clean',
      '{"event":"unrelated"}',
    ].join('\n');
    expect(extractPodFailureReason({ logs })).toBe('Error: dependency unavailable');
  });

  test('reads the last line of the latest failed terminal JSON error, not its first line or transfer markers', () => {
    const logs = [
      JSON.stringify({ stage: 'earlier', ok: false, error: 'old error' }),
      JSON.stringify({ stage: 'error', ok: false, error: 'first error\r\nGraphQL: API rate limit already exceeded' }),
      'ELANOUS_USAGE_ROLLUP {"measured":false}',
    ].join('\n');
    expect(extractPodFailureReason({ logs })).toBe('GraphQL: API rate limit already exceeded');
  });

  test('does not mistake an ordinary cleanup line for a failure reason', () => {
    expect(extractPodFailureReason({ logs: 'starting\ncleanup complete' })).toBe('사유 못 읽음: 로그에 읽을 수 있는 오류 줄 없음');
  });

  test('uses the error message rather than a trailing JSON error stack frame', () => {
    const logs = JSON.stringify({ stage: 'error', ok: false, error: 'Error: dependency unavailable\nat worker.ts:42' });
    expect(extractPodFailureReason({ logs })).toBe('Error: dependency unavailable');
    const annotated = JSON.stringify({ stage: 'error', ok: false, error: 'Error: dependency unavailable\ncleanup complete\nat worker.ts:42' });
    expect(extractPodFailureReason({ logs: annotated })).toBe('Error: dependency unavailable');
    const trailing = JSON.stringify({ stage: 'error', ok: false, error: 'Error: dependency unavailable\ncleanup finished\nat worker.ts:42' });
    expect(extractPodFailureReason({ logs: trailing })).toBe('Error: dependency unavailable');
  });

  test('a later successful child result prevents attributing an earlier error to the failed Job', () => {
    const logs = `${JSON.stringify({ stage: 'error', ok: false, error: 'earlier error' })}\n${JSON.stringify({ stage: 'merged', ok: true })}\n`;
    expect(extractPodFailureReason({ logs })).toBe('사유 못 읽음: 로그에 읽을 수 있는 오류 줄 없음');
  });

  test('OOMKilled and deadline status take precedence over a stale log error', () => {
    const logs = 'Error: old failure\n';
    expect(extractPodFailureReason({ logs, containerReason: 'OOMKilled' })).toBe('OOMKilled: 컨테이너 메모리 한도 초과');
    expect(extractPodFailureReason({ logs, containerReason: 'OOMKilled', jobReason: 'DeadlineExceeded', deadlineSeconds: 90 })).toBe('DeadlineExceeded: Job 수명 상한 90초 초과');
  });

  test('names why it could not read the reason when log retrieval fails, is empty or contains only markers', () => {
    expect(extractPodFailureReason({ logs: '', logTailReason: 'kubectl logs exited 1' })).toBe('사유 못 읽음: kubectl logs exited 1');
    expect(extractPodFailureReason({ logs: '  \n' })).toBe('사유 못 읽음: 자식 로그 비어 있음');
    expect(extractPodFailureReason({ logs: 'ELANOUS_MEM 42 100 1:bun\nELANOUS_POD_SALVAGE_NONE clean' })).toBe('사유 못 읽음: 로그에 읽을 수 있는 오류 줄 없음');
    expect(extractPodFailureReason({ logs: '', logTailReason: '   ' })).not.toBe('');
  });

  test('prefers the error line inside a terminal JSON error over a trailing non-error line', () => {
    const logs = `${JSON.stringify({ stage: 'error', ok: false, error: 'Error: dependency unavailable\ncleanup completed successfully\nat worker.ts:42' })}\n`;
    expect(extractPodFailureReason({ logs })).toBe('Error: dependency unavailable');
  });

  test('bounds and redacts a long filesystem-path error before it enters the outer result', () => {
    const logs = `Error: /home/ubuntu/private/file: ${'x'.repeat(400)}\n`;
    const reason = extractPodFailureReason({ logs });
    expect(reason).toStartWith('Error: ~/private/file: ');
    expect(reason).not.toContain('/home/ubuntu/');
    expect(reason.length).toBeLessThanOrEqual(240);
  });
});
