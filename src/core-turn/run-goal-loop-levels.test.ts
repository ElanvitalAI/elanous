/**
 * OH10 PR-a — goal.loop 판정 이벤트의 명시 severity level 배선 확인 (source-grep).
 *
 * runGoalLoop 는 runTurn/LLM 등 무거운 의존을 실행해 단위 호출이 비싸므로,
 * 소스에서 각 판정 event 가 기대 level 로 명시 방출되는지 정적으로 검증한다.
 * (feedback_source_level_grep_test_value — 배선이 조용히 풀리는 것을 막는다.)
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dir, 'run-goal-loop.ts'), 'utf8');

// PLAN §4.3 하단 매핑표 — event → 명시 level.
const EXPECTED: Record<string, string> = {
  start: 'info',
  iteration: 'debug',
  complete: 'info',
  'complete-rejected-no-evidence': 'warn',
  'complete-rejected-evidence-mismatch': 'warn',
  'complete-evidence-mismatch-failopen': 'warn',
  'complete-rejected-tool-call': 'warn',
  'complete-rejected-tool-call-failopen': 'warn',
  'blocked-signal': 'debug',
  'blocked-accepted': 'warn',
  'marker-readback': 'debug',
  'marker-readback-exhausted': 'warn',
  'intent-stall-reprompt': 'info',
  'intent-stall-exhausted': 'warn',
  'intent-stall-provider-unresolved': 'warn',
  'text-only-accept': 'info',
  'context-pressure-bail': 'warn',
  'no-progress-tick': 'debug',
  'no-progress-stop': 'warn',
  'max-iterations': 'warn',
};

describe('goal.loop — 판정 이벤트 명시 level (OH10 PR-a)', () => {
  for (const [event, level] of Object.entries(EXPECTED)) {
    it(`'${event}' 는 { level: '${level}' } 로 명시 방출된다`, () => {
      // debug.log('goal.loop', '<event>', {…}, { level: '<level>' }) 의 tail 부.
      const idx = SRC.indexOf(`'${event}'`);
      expect(idx).toBeGreaterThan(-1);
      // 해당 호출 이후 첫 `{ level: '...' }` 가 기대 level 인지.
      const after = SRC.slice(idx);
      const m = after.match(/\{ level: '([a-z]+)' \}/);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(level);
    });
  }

  it('abort/error 종료 계측 공백이 error 로 신설됐다', () => {
    // stopReason 을 event 명으로 재사용 + { level: 'error' }.
    expect(SRC).toContain("debug.log('goal.loop', lastResult.stopReason,");
    const idx = SRC.indexOf("debug.log('goal.loop', lastResult.stopReason,");
    expect(SRC.slice(idx, idx + 400)).toContain("{ level: 'error' }");
  });
});
