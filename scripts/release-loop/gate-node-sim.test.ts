import { expect, setDefaultTimeout, test } from 'bun:test';
import { withSimClock } from '../../src/ux-sim/fake-clock.js';
import { GATE_NODE_SIM_SCENARIOS, judgeInjectedGateEvent } from './gate-node-sim.js';

setDefaultTimeout(60_000);

test('GATE-MOCK-EVENT-SCENARIOS: distinct injected evidence pins gate judgements and planner recovery choices', async () => {
  const rows: Array<{ scenario: string; injectedInput: string; expected: string; actual: string; outcome: string }> = [];
  await withSimClock(Date.parse('2026-10-29T00:00:00.000Z'), async (clock) => {
    for (const scenario of GATE_NODE_SIM_SCENARIOS) {
      const judged = await judgeInjectedGateEvent(scenario);
      rows.push({ scenario: scenario.id, injectedInput: scenario.injectedInput,
        expected: scenario.action, actual: judged.action, outcome: judged.outcome });
      expect(judged.outcome).toBe(scenario.expectedOutcome);
      expect(judged.action).toBe(scenario.action);
      expect(judged.podCommandCalls).toBe(0);
      if (scenario.expectedError) expect(judged.error).toBe(scenario.expectedError);
      if (scenario.planner === 'dispatch') {
        expect(judged.evidence.kind).toBe('dispatch');
        if (judged.evidence.kind !== 'dispatch' || !scenario.expectedDispatchKinds) throw new Error(`${scenario.id} needs dispatch evidence`);
        expect(judged.evidence.actions.map((item) => item.kind)).toEqual(scenario.expectedDispatchKinds);
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

  expect(rows).toHaveLength(16);
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
