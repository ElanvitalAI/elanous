import { expect, test } from 'bun:test';
import {
  evaluateEntranceShadow,
  type EntranceShadowInput,
  type EntranceShadowSnapshot,
} from './entrance-shadow.js';

const at = '2026-11-01T07:00:00.000Z';
const observed = <T>(value: T): EntranceShadowInput<T> => ({ state: 'observed', value, source: 'mock-fixture', observedAt: at });
const snapshot = (overrides: Partial<EntranceShadowSnapshot> = {}): EntranceShadowSnapshot => ({
  cycleId: 'cycle-1',
  cellId: 'ENTRANCE-DISPATCH-SHADOW',
  version: '0.2.45',
  observedAt: at,
  checklist: observed({ status: 'yellow', priority: 'P0', targetPathsGrounded: true }),
  hold: observed({ active: false }),
  openPullRequests: observed({ sameCell: 0, overlapping: false, overlapBlock: true }),
  capacity: observed({ podSlotsAvailable: 1, podSlotsRequired: 1, localSlotsAvailable: 0, localSlotsRequired: 1, seatShareAvailable: true }),
  ...overrides,
});

test('ENTRANCE-DISPATCH-SHADOW: complete eligible snapshot records would-run without launching', () => {
  const row = evaluateEntranceShadow(snapshot());
  expect(row).toMatchObject({
    schema: 'entrance-shadow/v1', cycleId: 'cycle-1', cellId: 'ENTRANCE-DISPATCH-SHADOW', version: '0.2.45',
    decision: 'would-run', reason: 'eligible', substrate: 'pod', launched: false, unknownInputs: [],
    inputs: { checklist: { state: 'observed', source: 'mock-fixture', observedAt: at,
      value: { status: 'yellow', priority: 'P0', targetPathsGrounded: true } } },
  });
});

test('ENTRANCE-DISPATCH-SHADOW: audit inputs are copied and malformed observations fail closed', () => {
  const observedHold = observed({ active: false, reason: 'clear' });
  const row = evaluateEntranceShadow(snapshot({ hold: observedHold }));
  if (observedHold.state === 'observed') {
    observedHold.value.active = true;
    observedHold.source = 'mutated-after-decision';
  }
  expect(row.inputs.hold).toMatchObject({ state: 'observed', value: { active: false }, source: 'mock-fixture' });

  const missingField = {
    state: 'observed', value: {}, source: 'mock-fixture', observedAt: at,
  } as unknown as EntranceShadowInput<{ active: boolean; reason?: string }>;
  expect(evaluateEntranceShadow(snapshot({ hold: missingField }))).toMatchObject({
    decision: 'would-skip', reason: 'input-unknown', unknownInputs: ['hold'], launched: false,
  });
  expect(evaluateEntranceShadow(snapshot({ hold: undefined as unknown as EntranceShadowInput<{ active: boolean; reason?: string }> }))).toMatchObject({
    decision: 'would-skip', reason: 'input-unknown', unknownInputs: ['hold'], launched: false,
  });
  const uncloneable = observed({ active: false, extra: () => undefined }) as unknown as EntranceShadowInput<{ active: boolean; reason?: string }>;
  expect(evaluateEntranceShadow(snapshot({ hold: uncloneable }))).toMatchObject({
    decision: 'would-skip', reason: 'input-unknown', unknownInputs: ['hold'], launched: false,
  });
  const arrayStatus = observed({ status: ['yellow'], priority: 'P0', targetPathsGrounded: true }) as unknown as EntranceShadowInput<{
    status: 'green' | 'yellow' | 'red' | 'done'; priority: 'P0' | 'P1' | 'P2'; targetPathsGrounded: boolean;
  }>;
  expect(evaluateEntranceShadow(snapshot({ checklist: arrayStatus }))).toMatchObject({
    decision: 'would-skip', reason: 'input-unknown', unknownInputs: ['checklist'], launched: false,
  });
  const badStamp = evaluateEntranceShadow(snapshot({ observedAt: 'not-a-date' }));
  expect(badStamp).toMatchObject({ decision: 'would-skip', reason: 'input-unknown', unknownInputs: ['snapshot'], launched: false });
});

test('ENTRANCE-DISPATCH-SHADOW: eligibility blockers are explicit and ordered', () => {
  expect(evaluateEntranceShadow(snapshot({ hold: observed({ active: true, reason: 'OP hold' }) }))).toMatchObject({
    decision: 'would-skip', reason: 'held', launched: false,
  });
  expect(evaluateEntranceShadow(snapshot({ openPullRequests: observed({ sameCell: 1, overlapping: false, overlapBlock: true }) }))).toMatchObject({
    decision: 'would-skip', reason: 'open-pr-conflict',
  });
  expect(evaluateEntranceShadow(snapshot({ openPullRequests: observed({ sameCell: 0, overlapping: true, overlapBlock: false }) }))).toMatchObject({
    decision: 'would-run', reason: 'eligible',
  });
  expect(evaluateEntranceShadow(snapshot({ capacity: observed({ podSlotsAvailable: 0, podSlotsRequired: 1, localSlotsAvailable: 1, localSlotsRequired: 1, seatShareAvailable: true }) }))).toMatchObject({
    decision: 'would-run', reason: 'eligible', substrate: 'local',
  });
  expect(evaluateEntranceShadow(snapshot({ capacity: observed({ podSlotsAvailable: 0, podSlotsRequired: 1, localSlotsAvailable: 0, localSlotsRequired: 1, seatShareAvailable: true }) }))).toMatchObject({
    decision: 'would-skip', reason: 'local-capacity',
  });
  expect(evaluateEntranceShadow(snapshot({ capacity: observed({ podSlotsAvailable: 1, podSlotsRequired: 1, localSlotsAvailable: 0, localSlotsRequired: 1, seatShareAvailable: false }) }))).toMatchObject({
    decision: 'would-skip', reason: 'seat-share-unavailable',
  });
  expect(evaluateEntranceShadow(snapshot({ checklist: observed({ status: 'green', priority: 'P0', targetPathsGrounded: false }) }))).toMatchObject({
    decision: 'would-skip', reason: 'checklist-not-yellow',
  });
  expect(evaluateEntranceShadow(snapshot({ checklist: observed({ status: 'yellow', priority: 'P0', targetPathsGrounded: false }) }))).toMatchObject({
    decision: 'would-skip', reason: 'target-path-not-grounded',
  });
});

test('ENTRANCE-DISPATCH-SHADOW: unknown observations fail closed', () => {
  const row = evaluateEntranceShadow(snapshot({
    hold: { state: 'unknown', reason: 'traffic unavailable', source: 'mock-hold', observedAt: at },
  }));
  expect(row).toMatchObject({ decision: 'would-skip', reason: 'input-unknown', launched: false, unknownInputs: ['hold'] });
  const unproven = evaluateEntranceShadow(snapshot({
    capacity: { state: 'observed', value: { podSlotsAvailable: 1, podSlotsRequired: 1, localSlotsAvailable: 0, localSlotsRequired: 1, seatShareAvailable: true }, source: '', observedAt: at },
  }));
  expect(unproven).toMatchObject({ decision: 'would-skip', reason: 'input-unknown', unknownInputs: ['capacity'] });
});
