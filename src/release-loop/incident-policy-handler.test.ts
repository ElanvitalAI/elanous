import { expect, test } from 'bun:test';
import type { GraphEvent } from '../graph-runner/graph-events.js';
import type { GraphSubscriptionDispatch } from '../graph-runner/graph-subscriptions.js';
import { createIncidentPolicyHandler, createLLMIncidentPolicyProposer } from './incident-policy-handler.js';

function dispatchFixture() {
  const registered: string[] = [];
  const appends: unknown[] = [];
  const edges: unknown[] = [];
  const event: GraphEvent = {
    graphId: 'release-loop', runId: 'incident-policy-test', eventId: 'incident-event-1', sequence: 1,
    emittedAt: '2026-11-09T00:00:00.000Z', type: 'release.incident.host-lost',
    source: { kind: 'node', nodeId: 'gate' }, data: { description: 'The release host disappeared.' },
  };
  const value: GraphSubscriptionDispatch = {
    subscriberId: 'release-loop/incident-policy-test/gate-triage:0', nodeId: 'gate-triage', action: 'reroute', event,
    eventVocabulary: { registerType: (type) => registered.push(type), hasType: (type) => registered.includes(type) },
    appendGraph: async (proposal) => { appends.push(proposal); return { disposition: 'appended', nodeId: proposal.entryNodeId }; },
    proposeEdge: async (proposal) => { edges.push(proposal); return { disposition: 'added', reason: 'accepted' }; },
  };
  return { value, registered, appends, edges };
}

test('LLM incident proposer parses a valid agent response', async () => {
  const fixture = dispatchFixture();
  const prompts: string[] = [];
  const propose = createLLMIncidentPolicyProposer(async (prompt) => {
    prompts.push(prompt);
    return JSON.stringify({ vocabularyLine: 'release.incident.host-lost', repairSummary: 'Reassign gate host', rationale: 'The current host disappeared.' });
  });

  const proposal = await propose(fixture.value);

  expect(prompts[0]).toContain('Event type: release.incident.host-lost');
  expect(proposal).toEqual({ vocabularyLine: 'release.incident.host-lost', repairSummary: 'Reassign gate host', rationale: 'The current host disappeared.' });
  expect(fixture.registered).toHaveLength(0);
  expect(fixture.appends).toHaveLength(0);
  expect(fixture.edges).toHaveLength(0);
});

test('incident policy rejects malformed, oversized, and mismatched model proposals before graph mutation', async () => {
  const badResponses = [
    'not json',
    JSON.stringify({ vocabularyLine: 'release.incident.host-lost', repairSummary: 'x'.repeat(241), rationale: 'reason' }),
  ];
  for (const response of badResponses) {
    const proposer = createLLMIncidentPolicyProposer(async () => response);
    expect(await proposer(dispatchFixture().value)).toBeUndefined();
  }
  const fixture = dispatchFixture();
  const handler = createIncidentPolicyHandler(createLLMIncidentPolicyProposer(async () => JSON.stringify({
    vocabularyLine: 'release.incident.other', repairSummary: 'repair', rationale: 'reason',
  })));
  await expect(handler(fixture.value)).rejects.toThrow('incident policy vocabulary must match the incoming event type');
  expect(fixture.registered).toHaveLength(0);
  expect(fixture.appends).toHaveLength(0);
  expect(fixture.edges).toHaveLength(0);
});
