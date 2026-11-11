import { describe, expect, test } from 'bun:test';
import { runAbsorbGraphSimulation, runAbsorbPublishReceiptGraphSimulation, runAbsorbStoreRouteSimulation } from './absorb-v2-runGraph-sim.js';

describe('absorb graph simulation confirmation boundary', () => {
  test('default N leaves the graph, LLM, and app host unopened', async () => {
    const receipt = await runAbsorbGraphSimulation();

    expect(receipt).toMatchObject({
      ok: true,
      started: false,
      reason: 'confirmation-default-n',
      route: 'suggest_accept',
      dispatch: 'confirmation-required',
      handlerCalls: 0,
      appHostCalls: 0,
      llmCalls: 0,
    });
  });

  // Source: AWS1 full run took 65.1s after #36615 main merge; this test runs several actual graphs.
  test('the y path stores every suggestion by its own id and the build reads that stored id', async () => {
    const receipt = await runAbsorbGraphSimulation({ confirmation: 'y' });

    expect(receipt).toMatchObject({ ok: true, started: true, dispatch: 'dispatched',
      builds: { accepted: { status: 'awaiting-approval' } } });
    expect(receipt.suggestionStoreWrites).toContain('suggestions:member-demo:suggestion-2026-11-09-1');
    expect(receipt.suggestionStoreWrites).toContain('suggestions:member-demo:suggestion-2026-11-09-2');
    expect(receipt.suggestionLookups).toContain('member-demo:suggestion-2026-11-09-1');
    expect(receipt.suggestionLookups).toContain('member-demo:suggestion-2026-11-09-2');
  }, 120_000);
});

describe('absorb simulated publish receipt boundary', () => {
  test('the actual runGraph capability path publishes only for its own passing simulation receipt', async () => {
    const receipt = await runAbsorbPublishReceiptGraphSimulation();
    expect(receipt.ok).toBe(true);
    expect(receipt.graph).toBe('plugins/absorb/graph/absorb-build.yaml');
    expect(receipt.storedSuggestionId).toBe('suggestion-2026-11-09-1');
    expect(receipt.scenarios).toMatchObject({
      passed: { graphId: 'absorb-build', status: 'done', suggestionWasSavedByBrief: true, suggestionLookupObserved: true,
        simulateReached: true, simulateSuggestionId: 'suggestion-2026-11-09-1', publishNodeReached: true,
        requirePassingReceipt: true, receiptMapped: true, appHostCalls: ['lecture-scrap-demo@artifact-suggestion-2026-11-09-1'] },
      failed: { graphId: 'absorb-build', status: 'failed', suggestionId: 'suggestion-2026-11-09-1', suggestionWasSavedByBrief: true,
        suggestionLookupObserved: true, simulateReached: true, simulateSuggestionId: 'suggestion-2026-11-09-1',
        publishNodeReached: false, appHostCalls: [], currentBody: '<main>v1</main>' },
      missing: { graphId: 'absorb-build', status: 'failed', suggestionId: 'suggestion-2026-11-09-1', suggestionWasSavedByBrief: true,
        suggestionLookupObserved: true, simulateReached: true, simulateSuggestionId: 'suggestion-2026-11-09-1',
        publishNodeReached: true, requirePassingReceipt: true, receiptMapped: true, appHostCalls: [], currentBody: '<main>v1</main>' },
      mismatched: { graphId: 'absorb-build', status: 'failed', suggestionId: 'suggestion-2026-11-09-1', suggestionWasSavedByBrief: true,
        suggestionLookupObserved: true, simulateReached: true, simulateSuggestionId: 'suggestion-2026-11-09-1',
        publishNodeReached: true, requirePassingReceipt: true, receiptMapped: true, appHostCalls: [], currentBody: '<main>v1</main>' },
      'foreign-owner': { graphId: 'absorb-build', status: 'failed', suggestionWasSavedByBrief: false,
        suggestionStoredForOtherOwner: true, suggestionLookupObserved: true, suggestionLookupFound: false,
        suggestionLookupReason: 'owner-mismatch', simulateReached: false, appHostCalls: [] },
    });
  // Source: AWS1 run took 32.9s after #36615 main merge; this test runs multiple actual graphs.
  }, 120_000);
});

describe('absorb owner-scoped store route', () => {
  // Source: AWS1 run took 16.0s after #36615 main merge.
  test('scrap_add stores status new and the brief/list graphs only expose the verified owner records', async () => {
    const receipt = await runAbsorbStoreRouteSimulation();
    expect(receipt.ok).toBe(true);
    expect(receipt).toMatchObject({
      route: 'scrap_add',
      handler: './graph:absorb-ingest',
      ingestStatus: 'done',
      addedScrap: { id: 'scrap-added-by-route', owner: 'member-demo', status: 'new' },
      readOnlySuggestionList: [{ id: 'suggestion-owned', owner: 'member-demo' }],
    });
    expect(receipt.collectedOwnerItems).toContainEqual(expect.objectContaining({ id: 'scrap-added-by-route', status: 'new' }));
    expect(receipt.collectedOwnerItems).not.toContainEqual(expect.objectContaining({ id: 'private-other-member' }));
  }, 30_000);
});
