// AUTOPILOT-GOAL-CONTINUE-CAP — literal expectations: under autopilot AUTO the stop is «3 continuations in a row without
// progress» (one retro line, no «a person is needed»); progress = a state-changing tool call whose dispatch result succeeded.
// Every case drives session tool rows (real success / failure results) through noteTurnEnded — `progressed` is never injected.
import { describe, expect, test } from 'bun:test';
import { createGoalContinue, rowsOfThisTurn, toolResultSucceeded, turnMadeProgress, type ProgressRow } from './goal-continue.js';

const EDIT_OK: ProgressRow = { role: 'tool', toolName: 'Edit', toolArgs: '{"file_path":"a.ts"}', toolResult: '{"ok":true,"path":"a.ts"}' };
const EDIT_FAILED: ProgressRow = { role: 'tool', toolName: 'Edit', toolArgs: '{"file_path":"a.ts"}', toolResult: '{"error":"old_string not found"}' };
const MAIL_OK: ProgressRow = { role: 'tool', toolName: 'Bash', toolArgs: '{"command":"eln msg post --from OP --to TC --body hi"}', toolResult: '{"output":"posted #1","exitCode":0}' };
const MAIL_FAILED: ProgressRow = { role: 'tool', toolName: 'Bash', toolArgs: '{"command":"eln msg post --from OP --to TC --body hi"}', toolResult: '{"output":"refused","exitCode":1}' };
const READ_OK: ProgressRow = { role: 'tool', toolName: 'Read', toolArgs: '{"file_path":"a.ts"}', toolResult: '{"output":"x"}' };
const UNRELATED_OK: ProgressRow = { role: 'tool', toolName: 'BrowserRead', toolArgs: '{}', toolResult: '{"output":"page"}' };
const LIST_OK: ProgressRow = { role: 'tool', toolName: 'Bash', toolArgs: '{"command":"eln msg list --to OP"}', toolResult: '{"output":"0 unread","exitCode":0}' };

function harness(auto: boolean, extra: { planContinueLimit?: number; seatCapContinueLimit?: number } = {}) {
  const calls: string[] = [];
  const notices: string[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const ctl = createGoalContinue({
    startTurnIfIdle: (input) => { calls.push(input); return { opened: true, turnId: `auto-${calls.length}` }; },
    isEnabled: () => true, autopilotActive: () => auto, notify: (line) => notices.push(line),
    defer: () => {}, log: (category, event, data) => { if (category === 'tui.goal-continue') logs.push({ event, data }); },
    ...extra,
  });
  return { ctl, calls, notices, logs };
}

describe('progress from dispatch results', () => {
  test('only a state-changing call that succeeded counts', () => {
    expect(turnMadeProgress([EDIT_OK])).toBe(true);
    expect(turnMadeProgress([MAIL_OK])).toBe(true);
    expect(turnMadeProgress([EDIT_FAILED])).toBe(false);
    expect(turnMadeProgress([MAIL_FAILED])).toBe(false);
    expect(turnMadeProgress([READ_OK, UNRELATED_OK, LIST_OK])).toBe(false);
    expect(turnMadeProgress([{ role: 'tool', toolName: 'Write', toolArgs: '{}' }])).toBe(false); // no result yet
    expect(toolResultSucceeded('{"ok":false}')).toBe(false);
    expect(toolResultSucceeded('wrote 3 lines')).toBe(true);
  });
  test('rowsOfThisTurn: from the turn start, or after the last person line', () => {
    const rows = [EDIT_OK, { role: 'user' }, READ_OK];
    expect(rowsOfThisTurn(rows, 2)).toEqual([READ_OK]);
    expect(rowsOfThisTurn(rows, 'after-last-user')).toEqual([READ_OK]);
  });
});

describe('createGoalContinue under autopilot AUTO', () => {
  test('continuations with a successful edit never stop — not even on the same closing words', () => {
    const h = harness(true);
    h.ctl.noteTurnEnded({ lines: ['  다음 일을 진행하겠습니다.'] });
    expect(h.ctl.check().opened).toBe(true);
    for (let i = 0; i < 6; i++) {
      h.ctl.noteTurnEnded({ lines: ['  다음 일을 진행하겠습니다.'], rows: [READ_OK, EDIT_OK] });
      expect(h.ctl.check()).toEqual({ opened: true, reason: 'pledge-without-result' });
    }
    expect(h.calls).toHaveLength(7);
    expect(h.notices).toEqual([]);
  });

  test('3 continuations whose writes failed → stop with one retro line, no person asked', () => {
    const h = harness(true);
    h.ctl.noteTurnEnded({ lines: ['  가 일을 진행하겠습니다.'] });
    expect(h.ctl.check().opened).toBe(true);
    h.ctl.noteTurnEnded({ lines: ['  나 일을 진행하겠습니다.'], rows: [EDIT_FAILED] });
    expect(h.ctl.check().opened).toBe(true);
    h.ctl.noteTurnEnded({ lines: ['  나 일을 진행하겠습니다.'], rows: [MAIL_FAILED, UNRELATED_OK] });
    expect(h.ctl.check().opened).toBe(true);
    h.ctl.noteTurnEnded({ lines: ['  라 일을 진행하겠습니다.'], rows: [READ_OK] });
    expect(h.ctl.check()).toEqual({ opened: false, reason: 'no-progress' });
    expect(h.calls).toHaveLength(3);
    expect(h.notices).toEqual(['🚗 회고 · 이어가기 3회 연속 진척 없음(상태 변경·우편·증거 0) — 이어가기 멈춤 · 자율주행 깨움 주기로 넘긴다 · 마지막: 라 일을 진행하겠습니다.']);
    expect(h.logs.filter((l) => l.event === 'progress').map((l) => l.data)).toEqual([
      { progressed: false, noProgress: 1, consecutive: 1 },
      { progressed: false, noProgress: 2, consecutive: 2 },
      { progressed: false, noProgress: 3, consecutive: 3 },
    ]);
  });

  test('a successful mail post resets the no-progress streak', () => {
    const h = harness(true);
    const turn = (s: string, rows: ProgressRow[]) => { h.ctl.noteTurnEnded({ lines: [`  ${s} 진행하겠습니다.`], rows }); return h.ctl.check().opened; };
    expect(turn('a', [])).toBe(true);
    expect(turn('b', [READ_OK])).toBe(true);
    expect(turn('c', [EDIT_FAILED])).toBe(true);
    expect(turn('d', [MAIL_OK])).toBe(true);
    expect(turn('e', [LIST_OK])).toBe(true);
    expect(turn('f', [])).toBe(true);
    expect(turn('g', [])).toBe(false);
    expect(h.calls).toHaveLength(6);
  });

  test('plan continuations: the plan limit does not stop a progressing seat; no progress → retro', () => {
    const h = harness(true, { planContinueLimit: 1 });
    const plan = { version: 2, versionAtTurnStart: 1, steps: [{ status: 'pending' as const, step: 'land the queue' }] };
    h.ctl.noteTurnEnded({ lines: ['  계속'], plan });
    expect(h.ctl.check()).toEqual({ opened: true, reason: 'plan-open' });
    for (let i = 0; i < 3; i++) {
      h.ctl.noteTurnEnded({ lines: ['  계속'], plan, rows: [EDIT_OK] });
      expect(h.ctl.check()).toEqual({ opened: true, reason: 'plan-open' });
    }
    for (let i = 0; i < 3; i++) {
      h.ctl.noteTurnEnded({ lines: ['  계속'], plan, rows: [EDIT_FAILED] });
      expect(h.ctl.check().opened).toBe(i < 2);
    }
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toStartWith('🚗 회고 · 이어가기 3회 연속 진척 없음');
  });

  test('seat-cap continuations: the seat-cap limit does not stop a progressing seat', () => {
    const h = harness(true, { seatCapContinueLimit: 1 });
    const capped = { lines: ['  진행: 3단계까지 끝냈습니다'], stopReason: 'max_turns' };
    h.ctl.noteTurnEnded(capped);
    expect(h.ctl.check()).toEqual({ opened: true, reason: 'seat-cap' });
    for (let i = 0; i < 3; i++) {
      h.ctl.noteTurnEnded({ ...capped, rows: [MAIL_OK] });
      expect(h.ctl.check()).toEqual({ opened: true, reason: 'seat-cap' });
    }
    expect(h.notices).toEqual([]);
  });
});

describe('createGoalContinue with autopilot off', () => {
  test('the count cap of 3 still asks a person, whatever the tool results', () => {
    const h = harness(false);
    for (const s of ['일', '이', '삼']) {
      h.ctl.noteTurnEnded({ lines: [`  ${s} 진행하겠습니다.`], rows: [EDIT_OK] });
      expect(h.ctl.check().opened).toBe(true);
    }
    h.ctl.noteTurnEnded({ lines: ['  사 진행하겠습니다.'], rows: [EDIT_OK] });
    expect(h.ctl.check()).toEqual({ opened: false, reason: 'cap' });
    expect(h.notices).toEqual(['⏸ 골 이어가기 상한(3회 연속) — 사람 확인 필요 · 키 하나면 다시 이어간다']);
  });
});
