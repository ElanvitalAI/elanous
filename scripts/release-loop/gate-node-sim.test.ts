import { expect, setDefaultTimeout, test } from 'bun:test';
import { withSimClock } from '../../src/ux-sim/fake-clock.js';
import { GATE_NODE_SIM_SCENARIOS, judgeInjectedGateEvent } from './gate-node-sim.js';

setDefaultTimeout(60_000);

test('retry-pass simulation uses the measured shard artifact and remains nonblocking', async () => {
  const scenario = GATE_NODE_SIM_SCENARIOS.find((row) => row.id === 'retry-pass')!;
  const result = await judgeInjectedGateEvent(scenario);
  expect(result).toMatchObject({ outcome: 'ok', action: 'reuse', podCommandCalls: 0 });
});

test('GATE-MOCK-EVENT-SCENARIOS: distinct injected evidence pins gate judgements and planner recovery choices', async () => {
  const rows: Array<{ scenario: string; injectedInput: string; expected: string; actual: string; outcome: string }> = [];
  await withSimClock(Date.parse('2026-10-29T00:00:00.000Z'), async (clock) => {
    for (const scenario of GATE_NODE_SIM_SCENARIOS) {
      const judged = await judgeInjectedGateEvent(scenario);
      rows.push({ scenario: scenario.id, injectedInput: scenario.injectedInput,
        expected: scenario.action, actual: judged.action, outcome: judged.outcome });
      expect(judged.outcome).toBe(scenario.expectedOutcome);
      expect(judged.action, scenario.id).toBe(scenario.action);
      expect(judged.podCommandCalls).toBe(0);
      if (scenario.expectedError) expect(judged.error).toBe(scenario.expectedError);
      if (scenario.planner === 'dispatch') {
        expect(judged.evidence.kind).toBe('dispatch');
        if (judged.evidence.kind !== 'dispatch') throw new Error(`${scenario.id} needs dispatch evidence`);
        const actions = judged.evidence.actions;
        if (scenario.expectedDispatchKinds) expect(actions.map((item) => item.kind), scenario.id).toEqual(scenario.expectedDispatchKinds);
        if (scenario.expectedDispatchSummary) expect(judged.evidence.summary, scenario.id).toEqual(scenario.expectedDispatchSummary);
        if (scenario.expectedDispatchReasons) {
          const reasons = Object.fromEntries([...new Set(actions.map((item) => item.reason))]
            .map((reason) => [reason, actions.filter((item) => item.reason === reason).length]));
          expect(reasons, scenario.id).toEqual(scenario.expectedDispatchReasons);
        }
      }
      if (scenario.planner === 'partial') {
        expect(judged.evidence.kind).toBe('partial');
        if (judged.evidence.kind !== 'partial' || !scenario.expectedPartialFiles) throw new Error(`${scenario.id} needs partial evidence`);
        expect(judged.evidence.files).toEqual(scenario.expectedPartialFiles);
      }
      expect(clock.now()).toBe(Date.parse('2026-10-29T00:00:00.000Z'));
    }
  });
  console.log(['GATE-MOCK-EVENT-SCENARIOS', 'scenario | injected input | gate | decision', ...rows.map((row) =>
    `${row.scenario} | ${row.injectedInput} | ${row.outcome} | ${row.actual}`)].join('\n'));

  expect(rows).toHaveLength(23);
});

test('GATE-MOCK-EVENT-SCENARIOS: injected HOLDs and malformed sweep summaries stay HOLD', async () => {
  const cases = GATE_NODE_SIM_SCENARIOS.filter((scenario) => scenario.gateInjection === 'hold' || scenario.gateInjection === 'malformed');
  const rows = await Promise.all(cases.map(async (scenario) => [scenario.id, await judgeInjectedGateEvent(scenario)] as const));
  expect(rows).toHaveLength(5);
  for (const [id, result] of rows) {
    expect(result).toMatchObject({ outcome: 'error', action: 'HOLD' });
    const scenario = GATE_NODE_SIM_SCENARIOS.find((candidate) => candidate.id === id)!;
    if (scenario.expectedError) expect(result.error).toBe(scenario.expectedError);
    else expect(result.error).toBeTruthy();
  }
});
