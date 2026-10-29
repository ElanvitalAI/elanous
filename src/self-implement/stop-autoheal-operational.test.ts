import { describe, expect, test } from 'bun:test';
import { operationalAutohealActions } from './stop-autoheal-operational.js';
import { autohealFromStop } from './stop-autoheal.js';
import type { AutohealContext } from './stop-autoheal.js';
import type { HostRegateInput } from './host-regate.js';

const ctx = (evidenceRef: string): AutohealContext => ({
  runId: 'run-w0', record: { class: 'env-unrelated', cause: 'host environment', evidenceRef, nextMove: 'regate' },
});
const HEAD = 'a'.repeat(40);

describe('production clean workspace autoheal', () => {
  test('gates the exact ready PR head without merging and reports the measured result', async () => {
    const calls: unknown[] = [];
    const action = operationalAutohealActions({
      repoRoot: '/repo', readPr: () => ({ headRefOid: HEAD, state: 'OPEN', isDraft: false }),
      regate: async (input) => { calls.push(input); return { passed: true, status: 'passed', failures: [], os: 'darwin' }; },
    })['clean-workspace-regate']!;
    expect(await action(ctx('https://github.com/acme/repo/pull/42'))).toMatchObject({ ok: true, detail: expect.stringContaining(`head ${HEAD} clean regate passed`) });
    expect(calls).toEqual([{ prNumber: 42, headCommit: HEAD, repoRoot: '/repo', verifyOnly: true }]);
  });

  test('does not claim healing without a PR URL or measured head', async () => {
    let ran = false;
    const action = operationalAutohealActions({
      repoRoot: '/repo', readPr: () => ({ state: 'OPEN', isDraft: true }),
      regate: async () => { ran = true; return { passed: true, failures: [], os: 'darwin' }; },
    })['clean-workspace-regate']!;
    expect((await action(ctx('run-ledger:run-w0:stop'))).ok).toBe(false);
    expect((await action(ctx('https://github.com/acme/repo/pull/42'))).ok).toBe(false);
    expect(ran).toBe(false);
  });

  test('measures a preserved draft without enabling a landing', async () => {
    const calls: HostRegateInput[] = [];
    const action = operationalAutohealActions({
      repoRoot: '/repo', readPr: () => ({ headRefOid: HEAD, state: 'OPEN', isDraft: true }),
      regate: async (input) => { calls.push(input); return { passed: false, status: 'failed', failures: [{ step: 'test', detail: 'failure' }], os: 'darwin' }; },
    })['clean-workspace-regate']!;
    expect((await action(ctx('https://github.com/acme/repo/pull/42'))).ok).toBe(false);
    expect(calls).toEqual([{ prNumber: 42, headCommit: HEAD, repoRoot: '/repo', verifyOnly: true, allowDraft: true }]);
  });

  test('live dispatcher writes attempt before the measured clean regate and healed result after it', async () => {
    const phases: string[] = [];
    const actions = operationalAutohealActions({
      repoRoot: '/repo', readPr: () => ({ headRefOid: HEAD, state: 'OPEN', isDraft: false }),
      regate: async () => {
        expect(phases).toEqual(['attempt']);
        return { passed: true, status: 'passed', failures: [], os: 'darwin' };
      },
    });
    const result = await autohealFromStop(ctx('https://github.com/acme/repo/pull/42'), {
      mode: 'live', actions, loadLedger: () => [], writeLedger: (entry) => { phases.push(String(entry.data.phase)); },
      loadLadder: () => ({ template: undefined, overlays: [] }),
    });
    expect(result.outcome).toBe('healed');
    expect(phases).toEqual(['attempt', 'result']);
  });
});
