import { expect, mock, test } from 'bun:test';
import { runEmergencyPublishGateNode } from './emergency-publish-gate-node.js';

test('reduced emergency gate remains closed while its measured implementation is deferred', () => {
  const output = mock((...args: unknown[]) => { void args; });
  const previousLog = console.log;
  console.log = output;
  try {
    const exitCode = runEmergencyPublishGateNode({ ELANOUS_GRAPH_CONTEXT: JSON.stringify({
      graphId: 'release-loop', nodeId: 'emergency-gate', runId: 'normal-run-1',
      input: { version: '0.3.7', previousVersion: '0.3.6' }, outputs: { 'emergency-switch': { action: 'switch' } },
    }) });
    expect(exitCode).toBe(2);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ outcome: 'error', verdict: 'fail',
      summary: 'emergency publish is disabled by default; reduced gate implementation is deferred' });
  } finally { console.log = previousLog; }
});
