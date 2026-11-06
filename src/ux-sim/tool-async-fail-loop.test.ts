import { expect, test } from 'bun:test';
import { runToolAsyncFailLoopSimulation } from './tool-async-fail-loop.js';

test('SelfImplement async failures are surfaced and same-reason retries stop before a third launch', async () => {
  const evidence = await runToolAsyncFailLoopSimulation();
  expect(evidence.recordedToolCallCount).toBe(25);
  expect(evidence.incidentEmittedToolCallCount).toBe(25);
  expect(evidence.incidentEmittedToolCallCount).toBe(evidence.recordedToolCallCount);
  expect(evidence.incidentDispatchedToolCallCount).toBe(3);
  expect(evidence.blockedIncidentToolCallCount).toBe(22);
  expect(evidence.incidentEmittedToolCallCount).toBe(evidence.incidentDispatchedToolCallCount + evidence.blockedIncidentToolCallCount);
  expect(evidence.emittedToolCallCount).toBe(30);
  expect(evidence.dispatchedToolCallCount).toBe(5);
  expect(evidence.blockedToolCallCount).toBe(25);
  expect(evidence.emittedToolCallCount).toBe(evidence.dispatchedToolCallCount + evidence.blockedToolCallCount);
  expect(evidence.finalOldGoalDispatched).toBe(true);
  expect(evidence.invalidDispatches).toBe(2);
  expect(evidence.managedAdmissions).toBe(1);
  expect(evidence.repeatBlockedEvents).toBe(2);
  expect(evidence.doomLoopDetected).toBe(true);
  expect(evidence.lateFailureVisible).toBe(true);
  expect(evidence.lateFailureRepeatDispatches).toBe(2);
  expect(evidence.reusedGoalTitle).toBe('Old browser selection handoff');
});
