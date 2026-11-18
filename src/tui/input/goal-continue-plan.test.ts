import { expect, test } from 'bun:test';
import { createGoalContinue, DEFAULT_PLAN_CONTINUE_LIMIT, PLAN_CONTINUE_PROMPT, PLAN_NUDGE_PROMPT } from './goal-continue.js';
import type { StartTurnIfIdleOptions, StartTurnIfIdleResult } from './internal-turn.js';
import type { PlanWire, PlanWireStep } from '../../code-edit/plan-wire.js';

const harness = (extra: { planNudge?: boolean; planContinueLimit?: number } = {}) => {
  const opened: { text: string; origin?: string }[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const notices: string[] = [];
  const planOutcomes: unknown[] = [];
  const planArgs: PlanWire[] = [];
  const gc = createGoalContinue({
    startTurnIfIdle: (text: string, opts: StartTurnIfIdleOptions): StartTurnIfIdleResult => {
      opened.push({ text, origin: opts.origin });
      return { opened: true, turnId: `t${opened.length}` } as StartTurnIfIdleResult;
    },
    isEnabled: () => true,
    notify: (line) => notices.push(line),
    log: (_c, event, data) => events.push({ event, data }),
    onPlanOutcome: (outcome, planWire) => { planOutcomes.push(outcome); planArgs.push(planWire); },
    seat: 'D',
    ...extra,
  });
  return { gc, opened, events, notices, planOutcomes, planArgs };
};
// A plan the turn touched: version moved past the turn start.
const plan = (steps: PlanWireStep[]): PlanWire => ({ version: 2, versionAtTurnStart: 1, steps });

// The D 09:28 screen, in Korean and English: the last turn announces steps as not executed and asks two questions the seat could answer itself.
const SCENES = {
  ko: ['  1~5단계는 아직 실행하지 않았습니다.', '  A 방식으로 갈까요, B 방식으로 갈까요? 설정 파일 위치도 정해 주실래요?'],
  en: ['  Steps 1-5 have not been run yet.', '  Should I use approach A or B? And where should the config file live?'],
} as const;

for (const [lang, lines] of Object.entries(SCENES)) {
  test(`open plan steps and no blocker continue — the questions do not stop the turn (${lang})`, () => {
    const h = harness();
    h.gc.noteTurnEnded({ lines, plan: plan([{ status: 'completed', step: 'step 0' }, { status: 'pending', step: 'steps 1-5' }]) });
    expect(h.gc.check()).toEqual({ opened: true, reason: 'plan-open' });
    expect(h.opened[0]).toEqual({ text: PLAN_CONTINUE_PROMPT, origin: 'goal-continue' });
    expect(h.events.at(-1)).toMatchObject({ event: 'turn.auto-continue', data: { opened: true, reason: 'plan-open' } });
  });

  test(`a blocked step with a reason stops and tells the person; nothing is opened (${lang})`, () => {
    const h = harness();
    h.gc.noteTurnEnded({ lines, plan: plan([{ status: 'pending', step: 'steps 1-5' }, { status: 'blocked', step: 'choose approach', reason: 'A or B needs the operator' }]) });
    expect(h.gc.check()).toEqual({ opened: false, reason: 'not-armed' });
    expect(h.opened).toEqual([]);
    expect(h.notices.at(-1)).toContain('A or B needs the operator');
    expect(h.planOutcomes.at(-1)).toMatchObject({ kind: 'blocked' });
  });
}

test('waiting keeps quiet with its wake, and a finished plan does not continue', () => {
  const waiting = harness();
  waiting.gc.noteTurnEnded({ lines: SCENES.en, plan: plan([{ status: 'completed', step: 'a' }, { status: 'waiting', step: 'gate', wake: { kind: 'pr', target: 'x' } }]) });
  expect(waiting.gc.check().opened).toBe(false);
  expect(waiting.notices.at(-1)).toContain('pr x');
  expect(waiting.planOutcomes.at(-1)).toMatchObject({ kind: 'waiting' });
  const done = harness();
  done.gc.noteTurnEnded({ lines: ['  Next step: archive the notes.'], plan: plan([{ status: 'completed', step: 'a' }, { status: 'completed', step: 'b' }]) });
  expect(done.gc.check().opened).toBe(false);
  expect(done.planOutcomes.at(-1)).toEqual({ kind: 'done' });
  // The host also gets the plan itself (its version and step count become the completion evidence).
  expect(done.planArgs.at(-1)).toMatchObject({ version: 2, steps: [{ status: 'completed' }, { status: 'completed' }] });
});

test('plan continues are bounded, a person resets them, and an untouched plan never counts as progress', () => {
  const h = harness();
  const open = plan([{ status: 'pending', step: 'a' }]);
  for (let n = 1; n <= DEFAULT_PLAN_CONTINUE_LIMIT; n++) {
    h.gc.noteTurnEnded({ lines: ['…'], plan: open });
    expect(h.gc.check().opened).toBe(true);
  }
  h.gc.noteTurnEnded({ lines: ['…'], plan: open });
  expect(h.gc.check()).toEqual({ opened: false, reason: 'plan-limit' });
  expect(h.notices.at(-1)).toContain('a person is needed');
  h.gc.noteHumanTurn();
  h.gc.noteTurnEnded({ lines: ['…'], plan: open });
  expect(h.gc.check().opened).toBe(true);
  // The plan was not updated this turn (version unchanged): a structure gap, not "still open".
  const untouched = harness();
  untouched.gc.noteTurnEnded({ lines: ['  Thanks, that is all.'], plan: { version: 5, versionAtTurnStart: 5, steps: [{ status: 'pending', step: 'a' }] } });
  expect(untouched.gc.check().opened).toBe(false);
});

test('no plan: ordinary chat is untouched; when the old rules would continue, one plan nudge comes first, then the old rules', () => {
  const plain = harness({ planNudge: true });
  plain.gc.noteTurnEnded({ lines: ['  Here is the answer.'] });
  expect(plain.gc.check()).toEqual({ opened: false, reason: 'not-armed' });
  const h = harness({ planNudge: true });
  const pledge = { lines: ['  I will run the remaining checks now.'] };
  h.gc.noteTurnEnded(pledge);
  expect(h.gc.check()).toEqual({ opened: true, reason: 'plan-nudge' });
  expect(h.opened[0]!.text).toBe(PLAN_NUDGE_PROMPT);
  // Still no plan after the nudge: back to the wording rules.
  h.gc.noteTurnEnded({ lines: ['  I will run the remaining checks now, really.'] });
  expect(h.gc.check().reason).toBe('pledge-without-result');
  // Without the switch the old behaviour is unchanged.
  const off = harness();
  off.gc.noteTurnEnded(pledge);
  expect(off.gc.check().reason).toBe('pledge-without-result');
});

test('plan versus wording is compared, never obeyed: a sentence-only pledge on a finished plan logs turn.outcome-mismatch and does not continue', () => {
  const h = harness();
  h.gc.noteTurnEnded({ lines: ['  I will run the remaining checks now.'], plan: plan([{ status: 'completed', step: 'a' }]) });
  expect(h.gc.check().opened).toBe(false);
  expect(h.events.find((e) => e.event === 'turn.outcome-mismatch')?.data).toMatchObject({ kind: 'spurious', seat: 'D' });
});

test('ELN-SEAT-TURN-PACING: a minimum-interval refusal keeps the arm and measures again once at retryAt; the run cap drops it', () => {
  const deferred: number[] = [];
  const fns: Array<() => void> = [];
  const results: StartTurnIfIdleResult[] = [
    { opened: false, reason: 'Cap', detail: 'pacing:min-interval', retryAt: 1_000_000 + 25_000 },
    { opened: true, turnId: 't2' },
  ];
  const gc = createGoalContinue({
    startTurnIfIdle: () => results.shift()!, isEnabled: () => true, now: () => 1_000_000,
    defer: (fn, ms) => { deferred.push(ms); fns.push(fn); }, log: () => {}, seat: 'D',
  });
  gc.noteTurnEnded({ lines: SCENES.en, plan: plan([{ status: 'pending', step: 'a' }]) });
  expect(gc.check()).toEqual({ opened: false, reason: 'Cap' });
  expect(deferred).toEqual([25_000]);
  fns[0]!();
  expect(results).toHaveLength(0); // the deferred check opened the turn
  const capped = createGoalContinue({
    startTurnIfIdle: () => ({ opened: false, reason: 'Cap', detail: 'pacing:run-cap 5/5' }), isEnabled: () => true,
    defer: (fn, ms) => { deferred.push(ms); fns.push(fn); }, log: () => {}, seat: 'D',
  });
  capped.noteTurnEnded({ lines: SCENES.en, plan: plan([{ status: 'pending', step: 'a' }]) });
  capped.check();
  expect(deferred).toHaveLength(1); // no retry armed — rest until an event or a person
  expect(capped.check()).toEqual({ opened: false, reason: 'not-armed' });
});
