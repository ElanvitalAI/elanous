import { describe, expect, test } from 'bun:test';
import { dispatchOrchestrateParent, orchestrateParentInputsShareable } from './orchestrate-parent-dispatch.js';

describe('self orchestrate parent dispatch', () => {
  test('selected parent runs remotely and returns the remote exit status', async () => {
    const calls: string[][] = [];
    const fallbacks: string[] = [];
    const result = await dispatchOrchestrateParent({ requested: true, worker: false, shareableInputs: true, args: ['self', 'orchestrate', 'goal'] }, {
      runRemote: async (args) => { calls.push(args); return { dispatched: true, host: 'node-b', exitCode: 7 }; },
      logLocalFallback: (reason) => fallbacks.push(reason),
    });
    expect(result).toEqual({ mode: 'remote', host: 'node-b', exitCode: 7 });
    expect(calls).toEqual([['self', 'orchestrate', 'goal']]);
    expect(fallbacks).toEqual([]);
  });

  test('local fallback is explicit when no parent host can be selected', async () => {
    const fallbacks: string[] = [];
    const result = await dispatchOrchestrateParent({ requested: true, worker: false, shareableInputs: true, args: ['self', 'orchestrate', 'goal'] }, {
      runRemote: async () => ({ dispatched: false }),
      logLocalFallback: (reason) => fallbacks.push(reason),
    });
    expect(result).toEqual({ mode: 'local', reason: 'no-eligible-remote-parent' });
    expect(fallbacks).toEqual(['no-eligible-remote-parent']);
  });

  test('gate exclusivity blocks instead of falling back to the gate host locally', async () => {
    const fallbacks: string[] = [];
    const blocked: string[] = [];
    const result = await dispatchOrchestrateParent({ requested: true, worker: false, shareableInputs: true, args: ['self', 'orchestrate', 'goal'] }, {
      runRemote: async () => ({ dispatched: false, blocked: true, reason: 'no-parent-host-outside-release-gate-pool' }),
      logLocalFallback: (reason) => fallbacks.push(reason),
      logBlocked: (reason) => blocked.push(reason),
    });
    expect(result).toEqual({ mode: 'blocked', reason: 'no-parent-host-outside-release-gate-pool' });
    expect(fallbacks).toEqual([]);
    expect(blocked).toEqual(['no-parent-host-outside-release-gate-pool']);
  });

  test('remote worker marker prevents recursive dispatch', async () => {
    let calls = 0;
    const result = await dispatchOrchestrateParent({ requested: true, worker: true, shareableInputs: true, args: ['self', 'orchestrate'] }, {
      runRemote: async () => { calls++; return { dispatched: true, host: 'node-b', exitCode: 0 }; },
      logLocalFallback: () => {},
    });
    expect(result.mode).toBe('local');
    expect(calls).toBe(0);
  });

  test('goal-file inputs stay local even when their contents would fit the remote inline limit', async () => {
    expect(orchestrateParentInputsShareable({ goalFileCount: 1, hasResume: false, hasIsolatedInstance: false })).toBe(false);
    const fallbacks: string[] = [];
    let remoteCalls = 0;
    const result = await dispatchOrchestrateParent({ requested: true, worker: false,
      shareableInputs: orchestrateParentInputsShareable({ goalFileCount: 1, hasResume: false, hasIsolatedInstance: false }),
      args: ['self', 'orchestrate', '--goal-file', '# small goal'] }, {
      runRemote: async () => { remoteCalls++; return { dispatched: true, host: 'gcp1', exitCode: 0 }; },
      logLocalFallback: (reason) => fallbacks.push(reason),
    });
    expect(result).toEqual({ mode: 'local', reason: 'goal-input-is-local-only' });
    expect(remoteCalls).toBe(0);
    expect(fallbacks).toEqual(['goal-input-is-local-only']);
  });
});
