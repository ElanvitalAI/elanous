import { beforeEach, expect, test } from 'bun:test';
import { _resetPlanStateForTesting, dispatchUpdatePlan, getPlanState } from './plan-tool.js';
import { planTurnOutcome } from './plan-outcome.js';

beforeEach(() => { _resetPlanStateForTesting(); });

async function update(plan: Array<Record<string, unknown>>): Promise<string> {
  return (await dispatchUpdatePlan({ plan })).output;
}
function outcome(versionAtTurnStart: number) { return planTurnOutcome({ state: getPlanState(), versionAtTurnStart }); }

// The same four scenes in Korean and English: the verdict must not depend on the language of the step text.
const WORDINGS = {
  ko: { read: '40개 파일 따라가기', write: 'RESULT.md 작성', wait: 'PR #38070 게이트 통과 대기', blocked: '운영 키 승인 필요' },
  en: { read: 'Follow the 40-file chain', write: 'Write RESULT.md', wait: 'Wait for the PR #38070 gate', blocked: 'Production key approval needed' },
} as const;

for (const [lang, w] of Object.entries(WORDINGS)) {
  test(`more work → continue (${lang})`, async () => {
    await update([{ step: w.read, status: 'in_progress' }, { step: w.write, status: 'pending' }]);
    expect(outcome(0)).toEqual({ kind: 'continue', step: w.read });
  });
  test(`pending only → continue (${lang})`, async () => {
    await update([{ step: w.read, status: 'completed' }, { step: w.write, status: 'pending' }]);
    expect(outcome(0)).toEqual({ kind: 'continue', step: w.write });
  });
  test(`waiting with a wake → waiting (${lang})`, async () => {
    await update([{ step: w.read, status: 'completed' }, { step: w.wait, status: 'waiting', wake: { kind: 'pr', target: '38070' } }]);
    expect(outcome(0)).toEqual({ kind: 'waiting', step: w.wait, wake: { kind: 'pr', target: '38070' } });
  });
  test(`blocked with a reason → blocked, ahead of open work (${lang})`, async () => {
    await update([{ step: w.read, status: 'in_progress' }, { step: w.blocked, status: 'blocked', reason: `${w.blocked}: ask the operator` }]);
    expect(outcome(0)).toEqual({ kind: 'blocked', step: w.blocked, reason: `${w.blocked}: ask the operator` });
  });
  test(`everything completed → done (${lang})`, async () => {
    await update([{ step: w.read, status: 'completed' }, { step: w.write, status: 'completed' }]);
    expect(outcome(0)).toEqual({ kind: 'done' });
  });
}

test('open work beats a wait: pending + waiting continues, waiting alone waits (ko/en)', async () => {
  for (const w of Object.values(WORDINGS)) {
    _resetPlanStateForTesting();
    await update([{ step: w.wait, status: 'waiting', wake: { kind: 'pr', target: 'x' } }, { step: w.write, status: 'pending' }]);
    expect(outcome(0)).toEqual({ kind: 'continue', step: w.write });
    _resetPlanStateForTesting();
    await update([{ step: w.read, status: 'completed' }, { step: w.wait, status: 'waiting', wake: { kind: 'pr', target: 'x' } }]);
    expect(outcome(0).kind).toBe('waiting');
  }
});

test('no plan at all, or a plan the turn never touched → gap', async () => {
  expect(outcome(0)).toEqual({ kind: 'gap', why: 'no-plan' });
  await update([{ step: 'a', status: 'in_progress' }]);
  const version = getPlanState().version;
  expect(outcome(version)).toEqual({ kind: 'gap', why: 'plan-not-updated' });
});

test('blocked without a reason and waiting without a wake are rejected at the tool, so the gate never sees them', async () => {
  expect(await update([{ step: 'a', status: 'blocked' }])).toContain('needs a "reason"');
  expect(await update([{ step: 'a', status: 'waiting' }])).toContain('needs wake');
  expect(await update([{ step: 'a', status: 'waiting', wake: { kind: 'pr' } }])).toContain('needs wake');
  expect(getPlanState().steps).toEqual([]);
});

test('old three-status plans still parse; two in_progress is still an error', async () => {
  expect(await update([{ step: 'a', status: 'completed' }, { step: 'b', status: 'in_progress' }, { step: 'c', status: 'pending' }])).toContain('1/3 complete');
  expect(await update([{ step: 'a', status: 'in_progress' }, { step: 'b', status: 'in_progress' }])).toContain('only one step');
});
