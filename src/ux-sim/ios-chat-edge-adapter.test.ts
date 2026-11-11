import { expect, test } from 'bun:test';
import {
  adaptIOSChatEdgeInputs,
  IOS_CHAT_EDGE_INPUTS,
} from './ios-chat-edge-adapter.js';
import { generateEdgeCreatorPlan } from './edge-creator.js';

const makeIOSChatPlan = (changedPaths: readonly string[]) =>
  generateEdgeCreatorPlan(adaptIOSChatEdgeInputs(), { changedTouches: changedPaths });

test('iOS chat input adapter preserves each manual edge as a planner incident', () => {
  const adapted = adaptIOSChatEdgeInputs();

  expect(adapted.map(({ incidentId }) => incidentId)).toEqual(['E9', 'E10', 'E11', 'E12', 'E13', 'E14', 'E15']);
  expect(adapted.map(({ invariant }) => invariant)).toEqual(IOS_CHAT_EDGE_INPUTS.map(({ expectedInvariant }) => expectedInvariant));
  expect(adapted.every(({ summary }) => summary.startsWith('[iOS chat:')
    && summary.includes('setup:') && summary.includes('action:') && summary.includes('expected:'))).toBe(true);
  expect(adapted.every(({ touches }) => touches.includes('apps/ios/ElanousiOS/ElanousiOS/Chat'))).toBe(true);
});

test('iOS chat generator plan covers the changed chat radius and excludes unrelated paths', () => {
  const chatPath = 'apps/ios/ElanousiOS/ElanousiOS/Chat/ChatView.swift';
  const nexusPath = 'src/nexus/chat-stream.ts';
  const plan = makeIOSChatPlan([chatPath]);
  const nexusPlan = makeIOSChatPlan([nexusPath]);
  const unrelatedPlan = makeIOSChatPlan(['apps/ios/ElanousiOS/ElanousiOS/Settings']);

  expect(plan.coveredIncidentIds).toEqual(adaptIOSChatEdgeInputs().map(({ incidentId }) => incidentId).sort());
  expect(plan.requiredIncidentIds).toEqual(plan.coveredIncidentIds);
  expect(plan.scenarios.every(({ touches }) => touches.some((touch) => touch === chatPath.slice(0, chatPath.lastIndexOf('/'))))).toBe(true);
  expect(nexusPlan.coveredIncidentIds).toContain('E10');
  expect(nexusPlan.coveredIncidentIds).toContain('E15');
  expect(nexusPlan.scenarios.every(({ touches }) => touches.includes('src/nexus'))).toBe(true);
  expect(unrelatedPlan.coveredIncidentIds).toEqual([]);
  expect(unrelatedPlan.scenarios).toEqual([]);
});

test('generated chat scenario retains an independently specified setup, action, and expected result', () => {
  const plan = makeIOSChatPlan(['apps/ios/ElanousiOS/ElanousiOS/Chat/ChatView.swift']);
  const offlineSend = plan.scenarios.find(({ incidentIds }) => incidentIds.includes('E9'));

  expect(offlineSend?.incidentSummaries).toContain(
    '[iOS chat:offline-send] an offline chat send remains recoverable after reconnect; setup: disconnect the test device from the test Nexus; action: send a non-sensitive test prompt, then reconnect; expected: the pending message is retained and reaches the test Nexus after reconnect',
  );
  expect(offlineSend?.invariants).toContain('offline-message-is-retained-until-reconnect');
});

test('iOS chat adapter rejects duplicate input identities', () => {
  const input = IOS_CHAT_EDGE_INPUTS[0]!;
  expect(() => adaptIOSChatEdgeInputs([input, input])).toThrow('duplicate iOS chat edge input');
});
