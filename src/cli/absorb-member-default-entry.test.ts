import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChildPluginRuntimeContract } from './child-plugin-runtime.js';
import { dispatchGraphContract } from '../graph-runner/capabilities.js';
import { createAbsorbIngestMemberRegistry } from '../graph-runner/capability-providers/absorb-member-registry.js';

test('default manifest route persists a real scrap without injected providers and isolates the next reader', async () => {
  const root = mkdtempSync(join(tmpdir(), 'absorb-default-member-'));
  const prior = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'member-a' }, graphDeps: { root } });
    expect(await bridge.dispatchPluginTool('scrap_add', { kind: 'text', text: 'actual default member route' }))
      .toMatchObject({ ok: true, result: { graphId: 'absorb-ingest', status: 'done' } });
    const read = (owner: string) => dispatchGraphContract('store.read@1', {
      graphId: 'absorb-brief', runId: 'read-persisted', nodeId: 'collect', verifiedOwnerId: owner,
      input: { context: { memberId: owner } }, nodeInput: { op: 'list', collection: 'scraps', ownerScoped: true }, outputs: {},
    }, createAbsorbIngestMemberRegistry());
    expect(await read('member-a')).toMatchObject({ ok: true, result: { items: [{ text: 'actual default member route' }] } });
    expect(await read('member-b')).toMatchObject({ ok: true, result: { items: [] } });
    expect(await bridge.dispatchPluginTool('suggest_list', {}))
      .toMatchObject({ ok: true, result: { graphId: 'absorb-suggest-list', status: 'done' } });
    const unauthenticated = createChildPluginRuntimeContract({ graphDeps: { root } });
    expect(await unauthenticated.dispatchPluginTool('scrap_add', { kind: 'text', text: 'denied' }))
      .toMatchObject({ ok: false });
  } finally {
    if (prior === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
