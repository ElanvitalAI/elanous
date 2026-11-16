import { expect, test } from 'bun:test';
import { englishFooterText, formatNextTuiStatusLine, nextTuiElapsedMs, nextTuiStatusLine } from './status-line.js';

test('shown turn duration never decreases across timer redraws and settlement', () => {
  expect(nextTuiElapsedMs(100, 460, 250)).toBe(360);
  expect(nextTuiElapsedMs(100, 420, 360)).toBe(360);
  expect(nextTuiElapsedMs(100, 80, 360)).toBe(360);
});

test('turn status shows elapsed time and provider-measured input/output tokens at normal and narrow widths', () => {
  const input = { turnState: '응답 중 · Esc 취소', model: 'provider/model-x', queued: 0, backgroundTasks: 0,
    elapsedMs: 1450, measuredUsage: { inputTokens: 14, outputTokens: 6 } };
  const wide = formatNextTuiStatusLine({ ...input, width: 100 });
  expect(wide).toContain('Elapsed 1.4s · Tokens 14/6');
  const narrow = formatNextTuiStatusLine({ ...input, width: 40 });
  expect(narrow).toContain('1.4s');
  expect(narrow).toContain('14/6t');
  expect(Bun.stringWidth(narrow)).toBeLessThanOrEqual(40); // Source: #37098 CORE21 row 11 narrow Next PTY uses 40 columns.
  const unavailable = formatNextTuiStatusLine({ ...input, measuredUsage: undefined, width: 100 });
  expect(unavailable).toContain('Tokens ?/?');
  const compact = nextTuiStatusLine({ state: '응답 중', queued: 0, activeChildren: 0,
    columns: 40, elapsedMs: 1450, measuredUsage: { inputTokens: 14, outputTokens: 6 } });
  expect(compact).toContain('1.4s · 14/6t');
  expect(formatNextTuiStatusLine({ ...input, turnState: '응답 완료', width: 44 })).toContain('Turn done');
});

test('40-column status keeps exact provider counts at the seven-digit boundary', () => {
  const line = formatNextTuiStatusLine({
    turnState: '응답 완료', model: 'provider/a-long-model-name', queued: 0, backgroundTasks: 0,
    width: 40, elapsedMs: 1450, measuredUsage: { inputTokens: 1_234_567, outputTokens: 7_654_321 },
  });
  expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40); // Source: #37098 CORE21 row 11 requires an exact measured pair at 40 columns.
  expect(line).toContain('1234567/7654321t');
  expect(line).toContain('done');
  expect(line).toContain('Q0');
  expect(line).toContain('B0');
});

test('live output estimates remain labelled at narrow widths and never replace measured usage', () => {
  const input = { turnState: '응답 중', model: 'provider/model-x', queued: 0, backgroundTasks: 0,
    elapsedMs: 1450, estimatedOutputTokens: 123 };
  expect(formatNextTuiStatusLine({ ...input, width: 100 })).toContain('Output tokens est. 123');
  const narrow = formatNextTuiStatusLine({ ...input, width: 40 });
  expect(narrow).toContain('est.123t');
  expect(narrow).toContain('1.4s');
  expect(Bun.stringWidth(narrow)).toBeLessThanOrEqual(40); // Source: #37098 CORE21 40-column narrow Next PTY contract.
  const completed = formatNextTuiStatusLine({ ...input, width: 100, turnState: '응답 완료',
    measuredUsage: { inputTokens: 77, outputTokens: 9 } });
  expect(completed).toContain('Tokens 77/9');
  expect(completed).not.toContain('est.');
  expect(formatNextTuiStatusLine({ ...input, width: 100, estimatedOutputTokens: NaN })).toContain('Tokens ?/?');
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

test('streaming partial usage preserves measured input alongside labelled output estimate', () => {
  const input = { turnState: '응답 중', model: 'provider/model-x', queued: 0, backgroundTasks: 0,
    elapsedMs: 1450, measuredUsage: { inputTokens: 77 }, estimatedOutputTokens: 123 };
  expect(formatNextTuiStatusLine({ ...input, width: 100 })).toContain('Tokens 77/est.123');
  expect(formatNextTuiStatusLine({ ...input, width: 40 })).toContain('77/est.123t');
  expect(nextTuiStatusLine({ state: '응답 중', queued: 0, activeChildren: 0, columns: 40,
    elapsedMs: input.elapsedMs, measuredUsage: input.measuredUsage, estimatedOutputTokens: 123 })).toContain('77/est.123t');
  const actualOutput = formatNextTuiStatusLine({ ...input, width: 100, measuredUsage: { inputTokens: 77, outputTokens: 0 } });
  expect(actualOutput).toContain('Tokens 77/0');
  expect(actualOutput).not.toContain('est.');
});

test('40-column long-duration partial usage keeps the estimate label and exact counts', () => {
  const line = formatNextTuiStatusLine({ turnState: '응답 중', model: 'provider/model-x',
    queued: 0, backgroundTasks: 0, width: 40, elapsedMs: Number.MAX_SAFE_INTEGER,
    measuredUsage: { inputTokens: 77 }, estimatedOutputTokens: Number.MAX_SAFE_INTEGER });
  expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40); // Source: #37098 CORE21 40-column viewport contract.
  expect(line).toContain('77/est.9007199254740991t');
  expect(line).toContain('~9e12s');
  const fullPair = formatNextTuiStatusLine({ turnState: '응답 중', model: 'provider/model-x',
    queued: 0, backgroundTasks: 0, width: 40, elapsedMs: Number.MAX_SAFE_INTEGER,
    measuredUsage: { inputTokens: Number.MAX_SAFE_INTEGER }, estimatedOutputTokens: Number.MAX_SAFE_INTEGER });
  expect(Bun.stringWidth(fullPair)).toBeLessThanOrEqual(40); // Source: #37098 CORE21 40-column viewport contract.
  expect(fullPair).toContain('9007199254740991/est.9007199254740991t');
});

test('status line keeps turn, model, queue and background task counts together', () => {
  const line = formatNextTuiStatusLine({
    turnState: '응답 중 · Esc 취소', model: 'openai-codex/gpt-sim', queued: 2, backgroundTasks: 1, width: 100,
  });
  expect(line).toBe('Turn running · Model openai-codex/gpt-sim · Queue 2 · Bg 1');
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
  expect(line).toContain('Queue 0');
  expect(line).toContain('Bg 0');
});

test('status line keeps the detail on informational states', () => {
  const line = formatNextTuiStatusLine({
    turnState: '모델: 깊음 · 다음 턴부터 적용', model: 'openai-codex/gpt-sim', queued: 0, backgroundTasks: 0, width: 100,
  });
  expect(line).toContain('Model: deep · applies next turn');
});

test('status line maps shell execution to the tool phase', () => {
  const line = formatNextTuiStatusLine({
    turnState: 'Bash 실행 중 · Esc 취소', model: 'openai-codex/gpt-sim', queued: 0, backgroundTasks: 0, width: 100,
  });
  expect(line).toContain('Turn tools');
});

test('status line retains failure and cancellation reasons', () => {
  const line = formatNextTuiStatusLine({
    turnState: '하니스 호출 취소됨', model: 'auto/미설정', queued: 0, backgroundTasks: 0, width: 80,
  });
  expect(line).toContain('Harness cancelled');
});

test('tool failures keep their failure reason instead of appearing active', () => {
  const line = formatNextTuiStatusLine({
    turnState: '도구 실행 실패 · Read: missing file', model: 'auto/미설정', queued: 0, backgroundTasks: 0, width: 80,
  });
  expect(line).toContain('Tool failed · Read: missing file');
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
  expect(line).toContain('fail');
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
  expect(line).toBe('fail·m·Q12·B345');
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
    .toBe('running · 🧠 sol(high) · Queue 2 · Children 3');
});

test('narrow screen collapses children, queue and model in that order while preserving state', () => {
  const narrowViewportColumns = 22;
  const line = nextTuiStatusLine({ state: '응답 중', model: '🧠 a-very-long-model-name', queued: 12, activeChildren: 4, columns: narrowViewportColumns });
  expect(line).toContain('running');
  expect(line).not.toContain('Children');
  expect(line).not.toContain('Queue');
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
  expect(line.startsWith('running')).toBe(true);
});

test('untrusted state text is sanitized before it reaches the terminal', () => {
  const line = nextTuiStatusLine({ state: '오류\x1b[2J\n다음', queued: 0, activeChildren: 0, columns: 40 });
  expect(line).toBe('오류 다음');
});


test('unknown status phrases containing progress or work words are preserved', () => {
  for (const state of ['고객 진행 상황', '메모: 작업 중인 고객에게 연락', '임의 응답 중 메모']) {
    const line = formatNextTuiStatusLine({ turnState: state, model: 'provider/model-x', queued: 0, backgroundTasks: 0, width: 100 });
    expect(line).toContain(state);
    expect(nextTuiStatusLine({ state, queued: 0, activeChildren: 0, columns: 100 })).toBe(state);
  }
});

test('footer translation changes known error labels without translating their opaque detail', () => {
  const detail = '이유 · 시험 · 대기 · Enter 전송';
  expect(englishFooterText('압축 실패: ' + detail)).toBe('Compaction failed: ' + detail);
  expect(englishFooterText('provider 실패: ' + detail)).toBe('Provider failed: ' + detail);
  expect(englishFooterText('Enter 전송 · provider 실패: ' + detail)).toBe('Enter send · Provider failed: ' + detail);
  expect(englishFooterText('Herdr 입력 실패 · ' + detail)).toBe('Herdr input failed · ' + detail);
  expect(englishFooterText('사용자 상태 · 시험 · 대기')).toBe('사용자 상태 · 시험 · 대기');
  expect(englishFooterText('그래프 g/run · node 시작 (1회) · 시험')).toBe('Graph g/run · node started (1 attempts) · dry run');
});

test('only the exact system missing-model sentinel is translated', () => {
  for (const model of ['provider/미설정', '미설정', '사용자/미설정']) {
    expect(formatNextTuiStatusLine({ turnState: '대기', model, queued: 0, backgroundTasks: 0, width: 100 })).toContain('Model ' + model);
  }
  expect(formatNextTuiStatusLine({ turnState: '대기', model: 'auto/미설정', queued: 0, backgroundTasks: 0, width: 100 })).toContain('Model auto/unset');
});


test('unknown narrow status is not reclassified by failure or cancellation substrings', () => {
  for (const state of ['고객 failover 진행 상황', '고객 취소 요청에 관한 메모']) {
    const line = formatNextTuiStatusLine({ turnState: state, model: 'provider/model-x', queued: 0, backgroundTasks: 0, width: 24 });
    expect(line.startsWith('고객')).toBe(true);
  }
});


test('actor launch errors preserve their entire payload after leading UI clauses', () => {
  const payload = '이유 · 시험 · 대기 · Enter 전송';
  for (const actor of ['shell', 'elanous', 'codex', 'claude', 'claude-code', 'hermes', 'grok', 'grok-build']) {
    for (const [prefix, expectedPrefix] of [
      ['', ''], ['Enter 전송 · ', 'Enter send · '],
      ['Enter 전송 · Esc 취소 · ', 'Enter send · Esc cancel · '],
      ['대화 이어 가기 · ', 'Resuming chat · '], ['Bash 실행 승인 · ', 'Bash approval · '],
    ] as const) {
      expect(englishFooterText(prefix + actor + ' 실행 실패: ' + payload)).toBe(expectedPrefix + actor + ' launch failed: ' + payload);
    }
  }
});

test('unrecognized tool and model clauses keep the remaining dynamic text opaque', () => {
  for (const payload of ['Read 실행 실패: 이유 · 대기', '모델 응답: 이유 · Enter 전송', 'tool-output · 시험']) {
    expect(englishFooterText('Enter 전송 · ' + payload)).toBe('Enter send · ' + payload);
  }
});

test('complete fixed UI templates translate without treating their ID slots as UI text', () => {
  expect(englishFooterText('대화 이어 가기 · 사용자ID · 이전 = 고객없음')).toBe('Resuming chat · 사용자ID · previous = 고객없음');
  expect(englishFooterText('대화 이어 가기 · shell 실행 실패: 이유 · 이전 = 대기')).toBe('Resuming chat · shell launch failed: 이유 · 이전 = 대기');
  expect(englishFooterText('원격 PTY 화면 · t takeover · Ctrl+\\ 후 ↑/↓ 전환')).toBe('Remote PTY screen · t takeover · Ctrl+\\ then ↑/↓ switch');
  expect(englishFooterText('Herdr pane 관측 · t takeover · Esc / Ctrl+\\ 복귀 · Ctrl+Q 전체 종료 (Ctrl+[는 Esc로 읽힐 수 있음)')).toBe('Observing Herdr pane · t takeover · Esc / Ctrl+\\ return · Ctrl+Q quit all (Ctrl+[ may be read as Esc)');
});
