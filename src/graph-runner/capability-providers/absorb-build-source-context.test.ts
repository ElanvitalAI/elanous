import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChildPluginRuntimeContract } from '../../cli/child-plugin-runtime.js';
import { setTestStateRoot } from '../../nexus/paths.js';
import { createMemberStoreProvider } from './member-store.js';

test('default accept sends the suggested app ID to source generation before materializing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'absorb-build-context-'));
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  const memberId = 'member-source-context';
  process.env.ELANOUS_STATE_DIR = root;
  setTestStateRoot(root);
  try {
    const suggestion = { id: 'suggestion-context', owner: memberId, appId: 'ticket-app',
      ask: 'Build a ticket queue', briefingId: 'brief-context', designPackId: 'design-context',
      requirementLines: ['queue'], evidenceScrapIds: ['scrap-context'] };
    const seeded = await createMemberStoreProvider({}, 'write')({ graphId: 'absorb-brief', runId: 'seed',
      nodeId: 'seed-suggestion', verifiedOwnerId: memberId,
      input: { context: { memberId } }, graphInput: { context: { memberId } },
      nodeInput: { op: 'create', collection: 'suggestions', ownerScoped: true, owner: memberId,
        key: suggestion.id, value: suggestion }, outputs: {} });
    expect(seeded.ok).toBe(true);
    let observedAppId: unknown;
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: memberId },
      graphDeps: { root }, requestConfirmation: async () => true,
      graphPrompt: async prompt => {
        const source = prompt.match(/Input:\s*(\{[\s\S]*\})\s*$/)?.[1];
        const input = source ? JSON.parse(source) as { context?: { appId?: unknown } } : {};
        observedAppId = input.context?.appId;
        return JSON.stringify({ outcome: 'done', result: { artifact: {
          manifestYaml: 'apiVersion: elanous.app/v0\nslug: ticket-app\ntitle: Ticket app\nfrontend:\n  kind: static-export\n  out: out\n',
          html: '<!doctype html><html><body>Ticket queue</body></html>',
        }, service: 'ticketing', capacityAssumption: {
          concurrentUsers: 300, rationale: 'fixture estimate', source: 'model-estimate', userSpecified: false,
        } }, evidence: {} });
      } });
    const accepted = await bridge.dispatchPluginTool('suggest_accept', { suggestionId: suggestion.id });
    expect(observedAppId).toBe('ticket-app');
    expect(accepted.ok).toBe(true);
    const state = accepted.ok ? accepted.result as { status: string;
      nodes: Array<{ nodeId: string; ok: boolean; error?: string }> } : null;
    expect(state?.status).toBe('failed');
    expect(state?.nodes.map(node => ({ id: node.nodeId, ok: node.ok, error: node.error })))
      .toEqual([
        { id: 'lookup-suggestion', ok: true, error: undefined },
        { id: 'board-building', ok: true, error: undefined },
        { id: 'source-draft', ok: true, error: undefined },
        { id: 'build', ok: true, error: undefined },
        { id: 'simulate', ok: false, error: 'contract-exhausted' },
        { id: 'failed', ok: true, error: undefined },
      ]);
  } finally {
    setTestStateRoot(null);
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateDir;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
