import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchGraphContract } from './capabilities.js';
import { createMemberStoreRegistry } from './capability-providers/member-store.js';
import { runGraph } from './runner.js';

test('map child receives only the verified owner and cannot write for a forged owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'member-store-fanout-'));
  try {
    const graph = join(root, 'graph.yaml');
    writeFileSync(graph, `apiVersion: elanous.dev/graph/v2
graph: { id: member-store-fanout, version: 1.0.0, layer: flow, purpose: owner-context }
entry: read
nodes:
  - { id: read, type: store, requires: store.read@1, with: { op: list, collection: scraps, owner: "$context.memberId", ownerScoped: true } }
  - id: save
    type: store
    requires: store.write@1
    map: { over: "$read.result.items", as: scrap, max_parallel: 2 }
    with: { op: create, collection: suggestions, owner: "$scrap.targetOwner", key: "$scrap.id", ownerScoped: true, value: { id: "$scrap.id", owner: "$scrap.targetOwner", briefingId: brief-1, appId: app-1, ask: test, evidenceScrapIds: [scrap-1] } }
edges:
  - { from: read, to: save }
  - { from: save, on: outcome, map: { done: done, failed: failed } }
terminal: [done, failed]
`);
    const registry = createMemberStoreRegistry({ root: join(root, 'store') });
    const seed = async (id: string, targetOwner: string) => {
      const payload = { op: 'create', collection: 'scraps', owner: 'member-a', ownerScoped: true,
        key: id, value: { id, kind: 'text', text: id, targetOwner } };
      const result = await dispatchGraphContract('store.write@1', {
        graphId: 'seed', runId: id, nodeId: 'seed', verifiedOwnerId: 'member-a',
        input: { context: { memberId: 'member-a' } }, nodeInput: { ...payload, __validatedWrite: payload }, outputs: {},
      }, registry);
      expect(result).toMatchObject({ ok: true });
    };
    await seed('scrap-1', 'member-a');
    const deps = { root, capabilityProviders: registry };
    const good = await runGraph(graph, { runId: 'owner-good', verifiedOwnerId: 'member-a',
      input: { context: { memberId: 'member-a' } }, deps, quiet: true });
    expect(good.status).toBe('done');
    const saved = await dispatchGraphContract('store.read@1', {
      graphId: 'check', runId: 'check-good', nodeId: 'check', verifiedOwnerId: 'member-a',
      input: { context: { memberId: 'member-a' } },
      nodeInput: { op: 'get', collection: 'suggestions', owner: 'member-a', ownerScoped: true, key: 'scrap-1' }, outputs: {},
    }, registry);
    expect(saved).toMatchObject({ ok: true, result: { id: 'scrap-1', owner: 'member-a' } });

    await seed('scrap-2', 'member-b');
    const forged = await runGraph(graph, { runId: 'owner-forged', verifiedOwnerId: 'member-a',
      input: { context: { memberId: 'member-a' } }, deps, quiet: true });
    expect(forged.status).toBe('failed');
    expect(forged.fanOuts && Object.values(forged.fanOuts).some(fanout =>
      Object.values(fanout.branches).some(branch => branch.status === 'failed'))).toBe(true);
    const memberBJournal = join(root, 'store', `member-${createHash('sha256').update('member-b').digest('hex')}.jsonl`);
    expect(() => readFileSync(memberBJournal)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
