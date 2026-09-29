import { describe, expect, test } from 'bun:test';
import type { SelfDevJobResult } from '../self-dev/orchestrate.js';
import { formatRunReport } from './run-report.js';

const RUN_ID = 'run-123';
const merged: SelfDevJobResult = { taskId: 'a', feature: '병합 작업', status: 'done', merged: true, prUrl: 'https://example.com/pr/1' };
const opened: SelfDevJobResult = { taskId: 'b', feature: '열린 PR 작업', status: 'done', merged: false, prUrl: 'https://example.com/pr/2' };

describe('final run report', () => {
  test('완료: 병합과 PR 을 세고 두 URL 을 각 조각에 보인다', () => {
    expect(formatRunReport({ runId: RUN_ID, results: [merged, opened] })).toBe([
      '🏁 하니스 런 끝 — 2/2 · PR 2 · 병합 1',
      '✅ 병합 작업 → 병합 https://example.com/pr/1',
      '✅ 열린 PR 작업 → PR https://example.com/pr/2',
      'run-123 · 자세히: elanous self screen --run run-123',
    ].join('\n'));
  });

  test('중단: 사유, 단계 및 오류 코드도 남긴다', () => {
    const result: SelfDevJobResult = { taskId: 'c', feature: '빌드', status: 'failed', stage: 'gate-failed', error: { code: 'TS', message: 'type error' } };
    expect(formatRunReport({ runId: RUN_ID, results: [result], failure: '검증 중단' })).toBe([
      '⛔ 하니스 런 멈춤 — 검증 중단',
      '❌ 빌드 [gate-failed] — TS',
      'run-123 · 자세히: elanous self screen --run run-123',
    ].join('\n'));
  });

  test('9개 중 8개만 표시하고 외 1을 남긴다', () => {
    const results = Array.from({ length: 9 }, (_, i): SelfDevJobResult => ({ taskId: String(i), feature: `기능 ${i}`, status: 'done' }));
    const lines = formatRunReport({ runId: RUN_ID, results }).split('\n');
    expect(lines[0]).toBe('🏁 하니스 런 끝 — 9/9 · PR 0 · 병합 0');
    expect(lines).toHaveLength(11);
    expect(lines[8]).toBe('✅ 기능 7');
    expect(lines[9]).toBe('외 1');
    expect(lines.join('\n')).not.toContain('기능 8');
  });

  test('긴 사유는 첫 줄 200자, 기능은 56자에서 끊는다', () => {
    const lines = formatRunReport({ runId: RUN_ID, results: [{ ...opened, feature: '가'.repeat(70) }], failure: `${'x'.repeat(220)}\nstack trace` }).split('\n');
    expect(lines[0]).toBe(`⛔ 하니스 런 멈춤 — ${'x'.repeat(200)}`);
    expect(lines[1]).toBe(`✅ ${'가'.repeat(56)} → PR https://example.com/pr/2`);
    expect(lines.join('\n')).not.toContain('stack trace');
  });
});
