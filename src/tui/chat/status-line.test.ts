import { expect, test } from 'bun:test';
import { formatNextTuiStatusLine, nextTuiElapsedMs, nextTuiStatusLine } from './status-line.js';

test('shown turn duration never decreases across timer redraws and settlement', () => {
  expect(nextTuiElapsedMs(100, 460, 250)).toBe(360);
  expect(nextTuiElapsedMs(100, 420, 360)).toBe(360);
  expect(nextTuiElapsedMs(100, 80, 360)).toBe(360);
});

test('turn status shows elapsed time and provider-measured input/output tokens at normal and narrow widths', () => {
  const input = { turnState: '응답 중 · Esc 취소', model: 'provider/model-x', queued: 0, backgroundTasks: 0,
    elapsedMs: 1450, measuredUsage: { inputTokens: 14, outputTokens: 6 } };
  const wide = formatNextTuiStatusLine({ ...input, width: 100 });
  expect(wide).toContain('경과 1.4초 · 토큰 14/6');
  const narrow = formatNextTuiStatusLine({ ...input, width: 40 });
  expect(narrow).toContain('1.4초');
  expect(narrow).toContain('14/6t');
  expect(Bun.stringWidth(narrow)).toBeLessThanOrEqual(40); // Source: #37098 CORE21 row 11 narrow Next PTY uses 40 columns.
  const unavailable = formatNextTuiStatusLine({ ...input, measuredUsage: undefined, width: 100 });
  expect(unavailable).toContain('토큰 ?/?');
  const compact = nextTuiStatusLine({ state: '응답 중', queued: 0, activeChildren: 0,
    columns: 40, elapsedMs: 1450, measuredUsage: { inputTokens: 14, outputTokens: 6 } });
  expect(compact).toContain('1.4초 · 14/6t');
  expect(formatNextTuiStatusLine({ ...input, turnState: '응답 완료', width: 44 })).toContain('턴 완료');
});

test('40-column status keeps exact provider counts at the seven-digit boundary', () => {
  const line = formatNextTuiStatusLine({
    turnState: '응답 완료', model: 'provider/a-long-model-name', queued: 0, backgroundTasks: 0,
    width: 40, elapsedMs: 1450, measuredUsage: { inputTokens: 1_234_567, outputTokens: 7_654_321 },
  });
  expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40); // Source: #37098 CORE21 row 11 requires an exact measured pair at 40 columns.
  expect(line).toContain('1234567/7654321t');
  expect(line).toContain('완료');
  expect(line).toContain('Q0');
  expect(line).toContain('B0');
});

test('40-column status keeps exact max-safe provider counts before optional counters', () => {
  const line = formatNextTuiStatusLine({
    turnState: '응답 완료', model: 'provider/a-long-model-name', queued: 0, backgroundTasks: 0,
    width: 40, elapsedMs: Number.MAX_SAFE_INTEGER,
    measuredUsage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER },
  });
  expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40); // Source: #37098 B3 row 11 measured status at 40 columns.
  expect(line).toContain('9007199254740991/9007199254740991t');
  expect(line).toContain('~9e12s');
});

test('status line keeps turn, model, queue and background task counts together', () => {
  const line = formatNextTuiStatusLine({
    turnState: '응답 중 · Esc 취소', model: 'openai-codex/gpt-sim', queued: 2, backgroundTasks: 1, width: 100,
  });
  expect(line).toBe('턴 스트리밍 · 모델 openai-codex/gpt-sim · 대기 2 · 배경 1');
  expect(line).not.toContain('\n');
});

test('narrow widths shorten provider, model, labels, then state while preserving both counts', () => {
  const input = { turnState: '응답 중 · Esc 취소', model: 'openai-codex/gpt-sim-model', queued: 12, backgroundTasks: 3, width: 24 };
  const line = formatNextTuiStatusLine(input);
  expect(Bun.stringWidth(line)).toBeLessThanOrEqual(input.width);
  expect(line).toContain('Q12');
  expect(line).toContain('B3');
  expect(line).not.toContain('openai-codex');
});

test('status line strips terminal controls and clamps negative counts', () => {
  const line = formatNextTuiStatusLine({
    turnState: '대기\u001b[2J\n전송', model: 'secret\u0007-model', queued: -1, backgroundTasks: -4, width: 80,
  });
  expect(line).not.toMatch(/[\u0000-\u001f\u007f]/u);
  expect(line).toContain('대기 0');
  expect(line).toContain('배경 0');
});

test('status line keeps the detail on informational states', () => {
  const line = formatNextTuiStatusLine({
    turnState: '모델: 깊음 · 다음 턴부터 적용', model: 'openai-codex/gpt-sim', queued: 0, backgroundTasks: 0, width: 100,
  });
  expect(line).toContain('모델: 깊음 · 다음 턴부터 적용');
});

test('status line maps shell execution to the tool phase', () => {
  const line = formatNextTuiStatusLine({
    turnState: 'Bash 실행 중 · Esc 취소', model: 'openai-codex/gpt-sim', queued: 0, backgroundTasks: 0, width: 100,
  });
  expect(line).toContain('턴 도구 실행');
});

test('status line retains failure and cancellation reasons', () => {
  const line = formatNextTuiStatusLine({
    turnState: '하니스 호출 취소됨', model: 'auto/미설정', queued: 0, backgroundTasks: 0, width: 80,
  });
  expect(line).toContain('하니스 호출 취소됨');
});

test('tool failures keep their failure reason instead of appearing active', () => {
  const line = formatNextTuiStatusLine({
    turnState: '도구 실행 실패 · Read: missing file', model: 'auto/미설정', queued: 0, backgroundTasks: 0, width: 80,
  });
  expect(line).toContain('도구 실행 실패 · Read: missing file');
});

test('narrow failure status preserves failure meaning before model and queue details', () => {
  const input = {
    turnState: '도구 실행 실패 · Read: missing file',
    model: 'provider/model-x',
    queued: 12,
    backgroundTasks: 345,
    width: 24,
  };
  const line = formatNextTuiStatusLine(input);
  expect(Bun.stringWidth(line)).toBeLessThanOrEqual(input.width);
  expect(line).toContain('실패');
  expect(line).toContain('model-x');
  expect(line).toContain('Q12');
  expect(line).toContain('B345');
});

test('narrow failure status keeps the failure label before model and both counters', () => {
  const input = {
    turnState: '도구 실행 실패 · Read: missing file',
    model: 'provider/model-x',
    queued: 12,
    backgroundTasks: 345,
    width: 19,
  };
  const line = formatNextTuiStatusLine(input);
  expect(line).toBe('실패·m·Q12·B345');
  expect(Bun.stringWidth(line)).toBeLessThanOrEqual(input.width);
});

test('narrow status line shortens long information before both queue counters', () => {
  const input = {
    turnState: 'Turn cap reached — continuation paused while waiting for the next request',
    model: 'provider/model-x', queued: 12, backgroundTasks: 345, width: 24,
  };
  const line = formatNextTuiStatusLine(input);
  expect(Bun.stringWidth(line)).toBeLessThanOrEqual(input.width);
  expect(line).toContain('model-x');
  expect(line).toContain('Q12');
  expect(line).toContain('B345');
});

test('turn state shortens its detail before dropping the model initial', () => {
  const line14 = formatNextTuiStatusLine({
    turnState: 'abcd', model: 'provider/model-x', queued: 12, backgroundTasks: 345, width: 14,
  });
  expect(line14).toBe('ab…·m·Q12·B345');
  const line15 = formatNextTuiStatusLine({
    turnState: 'abcd', model: 'provider/model-x', queued: 12, backgroundTasks: 345, width: 15,
  });
  expect(line15).toBe('abcd·m·Q12·B345');
});

test('status line shows state, model, queue and active children on a wide screen', () => {
  expect(nextTuiStatusLine({ state: '응답 중', model: '🧠 sol(high)', queued: 2, activeChildren: 3, columns: 80 }))
    .toBe('응답 중 · 🧠 sol(high) · 대기 2 · 하위 3');
});

test('narrow screen collapses children, queue and model in that order while preserving state', () => {
  const narrowViewportColumns = 22;
  const line = nextTuiStatusLine({ state: '응답 중', model: '🧠 a-very-long-model-name', queued: 12, activeChildren: 4, columns: narrowViewportColumns });
  expect(line).toContain('응답 중');
  expect(line).not.toContain('하위');
  expect(line).not.toContain('대기');
  expect(Bun.stringWidth(line)).toBeLessThanOrEqual(narrowViewportColumns);
});

test('narrow screen keeps the live turn state ahead of the attachment page hint', () => {
  const line = nextTuiStatusLine({
    state: '응답 중 · 첨부 경로 2/5 · PgUp/PgDn',
    model: '🧠 long-model-name',
    queued: 0,
    activeChildren: 0,
    columns: 20,
  });
  expect(line.startsWith('응답 중')).toBe(true);
});

test('untrusted state text is sanitized before it reaches the terminal', () => {
  const line = nextTuiStatusLine({ state: '오류\x1b[2J\n다음', queued: 0, activeChildren: 0, columns: 40 });
  expect(line).toBe('오류 다음');
});
