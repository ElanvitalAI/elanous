// One test per M19–M24 expectation row. Expected verdicts are literals (rule 11), never derived from the table itself.
import { expect, test } from 'bun:test';
import { reduceSignals, seatKey, SignalGenerator } from './signals.js';
import { createLogicalClock } from './store.js';
import { runSignalScenario, SIGNAL_SCENARIOS, type SignalVerdictKind } from './signal-scenarios.js';

const VERDICTS: Readonly<Record<string, SignalVerdictKind>> = { M19: 'pass', M20: 'pass', M21: 'pass', M22: 'pass', M23: 'pass', M24: 'xfail' };

for (const scenario of SIGNAL_SCENARIOS) test(`${scenario.id} ${scenario.title} → ${VERDICTS[scenario.id]}`, async () => {
  const verdict = await runSignalScenario(scenario);
  expect(verdict.verdict).toBe(VERDICTS[scenario.id]!);
}, 30_000);

test('the six rows are exactly M19..M24 in order', () => {
  expect(SIGNAL_SCENARIOS.map(s => s.id)).toEqual(['M19', 'M20', 'M21', 'M22', 'M23', 'M24']);
});
test('a red row with the wrong reason is wrong-reason-red, never xfail', async () => {
  const base = SIGNAL_SCENARIOS.find(s => s.id === 'M24')!;
  expect((await runSignalScenario({ ...base, reason: 'something else' })).verdict).toBe('wrong-reason-red');
});
test('a red row that already matches asks for promote', async () => {
  const base = SIGNAL_SCENARIOS.find(s => s.id === 'M19')!;
  expect((await runSignalScenario({ ...base, expected: 'red', reason: 'x' })).verdict).toBe('promote-required');
});
test('collector: contradiction halves confidence; seatKey keeps one identity', () => {
  const gen = new SignalGenerator(createLogicalClock('2026-11-20T00:00:00.000Z'));
  const rows = [...gen.repeat({ signature: 'a:b', count: 3, origins: 3 }), gen.once('a:b', { outcome: 'ok', origin: 'run-1' })];
  expect(reduceSignals(rows)[0]!.confidence).toBe(0.39);
  expect(seatKey('RES-INFRA')).toEqual({ namespace: 'seat', id: 'RES-INFRA' });
});
