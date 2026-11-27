// NO-RELEASE-GOAL (replaces AUTOPILOT-RELEASE-GOAL) + AUTOPILOT-TASK-GOAL-PIN — literal expectations (fresh temp universe per
// test · injected clock). The autopilot no longer reads the release resolver: a published release sets no goal.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutopilot, readAutopilotState } from './autopilot.js';
import { dispatchAutopilotTool } from './autopilot-tool.js';

const root = mkdtempSync(join(tmpdir(), 'rel-goal-pin-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let file = '';
let n = 0;
beforeEach(() => { const dir = join(root, `u${++n}`); mkdirSync(dir, { recursive: true }); file = join(dir, '.autopilot', 'state.json'); });

const T0 = Date.parse('2026-11-25T03:00:00.000Z');
const MIN = 60_000;

function harness(opts: { coordinator?: boolean } = {}) {
  let t = T0;
  const logs: Array<[string, Record<string, unknown>]> = [];
  const lines: string[] = [];
  const pilot = createAutopilot({ file, now: () => t, log: (e, d) => { logs.push([e, d]); }, raiseDecision: () => 'D-x', postProgress: () => {},
    notify: (line) => { lines.push(line); }, ...(opts.coordinator ? { coordinator: true } : {}) });
  return { pilot, logs, lines, advance: (ms: number) => { t += ms; },
    events: (name: string) => logs.filter(([e]) => e === name).map(([, d]) => d) };
}

test('a hand seat in AUTO gets no goal from a release (no goal-derived · no 🚗 line)', () => {
  const h = harness();
  h.pilot.set({ on: true }, 'slash');
  for (let i = 0; i < 3; i += 1) { h.advance(MIN); h.pilot.tick(); }
  expect(h.pilot.state().goal).toBeUndefined();
  expect(h.pilot.state().derived).toBeUndefined();
  expect(h.events('goal-derived')).toEqual([]);
  expect(h.pilot.statusText()).toBe('🚗 AUTO');
  expect(h.pilot.goalFeed()).toBeNull();
  expect(h.lines).toEqual([]);
});

test('a hand seat whose stored goal names a released version keeps it as typed (no release rewrite)', () => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 1, on: true, goal: '0.3.35 개발' }));
  const h = harness();
  h.pilot.refresh();
  h.pilot.tick();
  expect(h.pilot.state().goal).toBe('0.3.35 개발');
  expect(h.events('goal-derived')).toEqual([]);
  expect(h.events('release-goal-cleared')).toEqual([]);
  expect(h.lines).toEqual([]);
});

test('a task goal (model default) is a bottom pin — never the chip; goal_done kind:task unpins it', async () => {
  const h = harness({ coordinator: true });
  h.pilot.refresh();
  h.pilot.noteTurnStart('human', '0.3.36 로스터랑 택틱 한 장, 이걸 골로 잡아줘');
  const out = await dispatchAutopilotTool('autopilot_set',
    { explicit_ask: '이걸 골로 잡아줘', on: true, goal: '0.3.36 로스터 + 택틱', done_criterion: '로스터 표와 택틱 한 장 발송', deadline: '07:00', expected_turns: 4 }, { cwd: root, file, now: () => T0 });
  expect(out).toEqual({ ok: true, status: '📌 1 · 0.3.36 로스터 + 택틱' });
  h.pilot.refresh();
  expect(h.pilot.statusText()).toBe('🚗 AUTO · demo D-1');
  expect(h.pilot.state().goal).toBeUndefined();
  expect(h.pilot.pinRows()).toEqual(['📌 1/1 0.3.36 로스터 + 택틱 · done when: 로스터 표와 택틱 한 장 발송 · due 07:00']);
  expect(h.pilot.goalFeed()).toContain('\n📌 작업 골(핀 1/3) — 자율주행 골이 아니다');
  expect(h.pilot.set({ goalDone: true, kind: 'task', goal: '0.3.36 로스터 + 택틱' }, 'tool')).toEqual({ ok: true, text: '📌 핀 닫힘: 0.3.36 로스터 + 택틱' });
  expect(h.pilot.pinRows()).toEqual([]);
  expect(readAutopilotState(file)?.pins).toBeUndefined();
});

test('a pin needs a done criterion and a deadline', () => {
  const h = harness();
  h.pilot.noteTurnStart('human', '이거 골로 잡아'); expect(h.pilot.set({ explicitAsk: '골로 잡아', on: true, goal: '택틱 한 장', doneCriterion: '문서 링크 발송', expectedTurns: 3 }, 'tool'))
    .toEqual({ ok: false, text: '작업 골(핀)에는 완료 기준(done_criterion)과 기한(deadline «HH:MM»·ISO)이 둘 다 필요하다' });
  expect(h.pilot.pins()).toEqual([]);
});

test('the 4th pin evicts the lowest-priority pin (oldest among equals) — logged; «📌 n» shows the count', () => {
  const h = harness();
  // AUTOPILOT-GOAL-CLEARING: ≤ 3 pin changes per 30 min — pins 11 min apart stay under the rate limit.
  const pin = (goal: string, priority: string) => { h.advance(11 * MIN); h.pilot.noteTurnStart('human', `${goal} 골로 잡아`); return h.pilot.set({ explicitAsk: `${goal} 골로 잡아`, on: true, goal, doneCriterion: `${goal} 끝`, deadline: '09:00', priority, expectedTurns: 3 }, 'tool'); };
  pin('A 핀', 'P1'); pin('B 핀', 'P2'); pin('C 핀', 'P1');
  expect(pin('D 핀', 'P1')).toEqual({ ok: true, text: '📌 3 · D 핀 (밀림: B 핀)' });
  expect(h.events('pin-evicted').map((d) => [d.text, d.priority, d.by])).toEqual([['B 핀', 2, 'D 핀']]);
  expect(pin('E 핀', 'P0')).toEqual({ ok: true, text: '📌 3 · E 핀 (밀림: A 핀)' });
  expect(h.pilot.pinRows()).toEqual([
    '📌 1/3 E 핀 · done when: E 핀 끝 · due 09:00 · P0',
    '📌 2/3 C 핀 · done when: C 핀 끝 · due 09:00',
    '📌 3/3 D 핀 · done when: D 핀 끝 · due 09:00',
    '🎯 history: A 핀 (superseded) · B 핀 (superseded)',
  ]);
  // The same text again replaces its pin (no duplicate, nothing evicted).
  expect(pin('C 핀', 'P1')).toEqual({ ok: true, text: '📌 3 · C 핀' });
  expect(h.events('pin-replaced').map((d) => d.text)).toEqual(['C 핀']);
});

test('deadline + 30 min unpins and leaves one «expired» line for 30 min', () => {
  const h = harness();
  h.pilot.noteTurnStart('human', '이거 골로 잡아'); h.pilot.set({ explicitAsk: '골로 잡아', on: true, goal: '데모 리허설 노트', doneCriterion: '노트 발송', deadline: '04:00', expectedMinutes: 20 }, 'tool');
  const due = h.pilot.pins()[0]!.deadline;
  h.advance(due - T0 + 29 * MIN);
  h.pilot.tick();
  expect(h.pilot.pinRows()).toEqual(['📌 1/1 데모 리허설 노트 · done when: 노트 발송 · due 04:00']);
  h.advance(MIN);
  h.pilot.tick();
  expect(h.pilot.pins()).toEqual([]);
  expect(h.pilot.pinRows()).toEqual(['⌛ Pin expired: 데모 리허설 노트 (due 04:00)', '🎯 history: 데모 리허설 노트 (expired)']);
  expect(h.events('pin-expired').map((d) => d.text)).toEqual(['데모 리허설 노트']);
  h.advance(30 * MIN);
  expect(h.pilot.pinRows()).toEqual(['🎯 history: 데모 리허설 노트 (expired)']);
  h.advance(30 * MIN);
  expect(h.pilot.pinRows()).toEqual([]);
});
