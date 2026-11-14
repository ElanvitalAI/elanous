import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchGraphContract } from '../capabilities.js';
import { createMemberStoreRegistry } from './member-store.js';
import { registerMemberStoreProviders } from './member-store.js';
import { createDocumentParseRegistry } from './document-parse.js';
import { createChildPluginRuntimeContract } from '../../cli/child-plugin-runtime.js';

test('actual child graph stores a member scrap and the next run reads only that member', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'member-graph-route-'));
  try {
    const registry = registerMemberStoreProviders(createDocumentParseRegistry({ apiKey: '' }),
      { root: join(directory, 'store') });
    const bridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'member-a' },
      graphDeps: { root: directory, capabilityProviders: registry } });
    const saved = await bridge.dispatchPluginTool('scrap_add', { kind: 'text', text: 'KCB actual graph' });
    expect(saved).toMatchObject({ ok: true, result: { graphId: 'absorb-ingest', status: 'done' } });
    const own = await bridge.dispatchPluginTool('suggest_list', {});
    expect(own).toMatchObject({ ok: true, result: { graphId: 'absorb-suggest-list', status: 'done' } });
    const otherBridge = createChildPluginRuntimeContract({ verifiedOwner: { id: 'member-b' },
      graphDeps: { root: directory, capabilityProviders: registry } });
    const other = await otherBridge.dispatchPluginTool('suggest_list', {});
    expect(other).toMatchObject({ ok: true, result: { graphId: 'absorb-suggest-list', status: 'done' } });
    const read = await dispatchGraphContract('store.read@1', {
      graphId: 'absorb-brief', runId: 'read-after-graph', nodeId: 'collect', verifiedOwnerId: 'member-a',
      input: { context: { memberId: 'member-a' } }, nodeInput: { op: 'list', collection: 'scraps', ownerScoped: true }, outputs: {},
    }, registry);
    expect(read).toMatchObject({ ok: true, result: { items: [{ text: 'KCB actual graph', owner: 'member-a' }] } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('member graph store persists the actual contract payload while isolating verified owners', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'member-graph-store-'));
  const root = join(directory, 'store');
  try {
    const registry = createMemberStoreRegistry({ root });
    const invoke = (contract: 'store.read@1' | 'store.write@1', owner: string, payload: Record<string, unknown>) =>
      dispatchGraphContract(contract, {
        graphId: 'absorb-ingest', runId: 'run-test', nodeId: 'store', verifiedOwnerId: owner,
        input: { context: { memberId: owner } }, nodeInput: payload, outputs: {},
      }, registry);
    const write = { op: 'create', collection: 'scraps', owner: 'member-a', ownerScoped: true,
      value: { kind: 'text', text: 'KCB member A' }, status: 'new' };
    const created = await invoke('store.write@1', 'member-a', { ...write, __validatedWrite: structuredClone(write) });
    expect(created).toMatchObject({ ok: true, result: { owner: 'member-a', status: 'new', text: 'KCB member A' } });
    const own = await invoke('store.read@1', 'member-a', { op: 'list', collection: 'scraps', ownerScoped: true,
      owner: 'member-a', where: 'status == new' });
    expect(own).toMatchObject({ ok: true, result: { items: [{ text: 'KCB member A' }] }, evidence: { owner: 'member-a', count: 1 } });
    const other = await invoke('store.read@1', 'member-b', { op: 'list', collection: 'scraps', ownerScoped: true, owner: 'member-b' });
    expect(other).toMatchObject({ ok: true, result: { items: [] } });
    expect(await invoke('store.read@1', 'member-b', { op: 'list', collection: 'scraps', ownerScoped: true, owner: 'member-a' }))
      .toMatchObject({ ok: false, evidence: { attempts: [{ reason: 'verified member owner required' }] } });
    const restarted = createMemberStoreRegistry({ root });
    const persisted = await dispatchGraphContract('store.read@1', {
      graphId: 'absorb-brief', runId: 'run-after-restart', nodeId: 'collect', verifiedOwnerId: 'member-a',
      input: { context: { memberId: 'member-a' } }, nodeInput: { op: 'list', collection: 'scraps', ownerScoped: true }, outputs: {},
    }, restarted);
    expect(persisted).toMatchObject({ ok: true, result: { items: [{ text: 'KCB member A' }] } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('member graph store serializes create collisions and rejects unsupported or forged operations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'member-graph-race-'));
  try {
    const registry = createMemberStoreRegistry({ root: join(directory, 'store') });
    const invoke = (contract: 'store.read@1' | 'store.write@1', payload: Record<string, unknown>, owner = 'member-a') =>
      dispatchGraphContract(contract, { graphId: 'absorb-build', runId: 'race', nodeId: 'store', verifiedOwnerId: owner,
        input: { context: { memberId: owner } }, nodeInput: payload, outputs: {} }, registry);
    const write = { op: 'create', collection: 'suggestions', owner: 'member-a', ownerScoped: true, key: 'suggestion-1',
      value: { id: 'suggestion-1', owner: 'member-a', briefingId: 'brief-1', appId: 'app-1',
        ask: 'ticket queue', evidenceScrapIds: ['scrap-1'] } };
    expect(await invoke('store.read@1', write)).toMatchObject({ ok: false,
      evidence: { attempts: [{ reason: 'store contract operation mismatch' }] } });
    expect(await invoke('store.read@1', { op: 'list', collection: 'suggestions', ownerScoped: true }))
      .toMatchObject({ ok: true, result: { items: [] } });
    const [first, second] = await Promise.all([
      invoke('store.write@1', { ...write, __validatedWrite: structuredClone(write) }),
      invoke('store.write@1', { ...write, __validatedWrite: structuredClone(write) }),
    ]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect(await invoke('store.read@1', { op: 'get', collection: 'suggestions', id: 'suggestion-1', ownerScoped: true }))
      .toMatchObject({ ok: true, result: { ask: 'ticket queue' }, evidence: { suggestion: { id: 'suggestion-1' } } });
    expect(await invoke('store.read@1', { op: 'get', collection: 'suggestions', id: 'suggestion-1', ownerScoped: true }, 'member-b'))
      .toMatchObject({ ok: false, evidence: { attempts: [{ reason: 'owner-scoped store item unavailable' }] } });
    expect(await invoke('store.read@1', { op: 'list', collection: '../secrets', ownerScoped: true }))
      .toMatchObject({ ok: false, evidence: { attempts: [{ reason: 'unsupported store collection' }] } });
    expect(await invoke('store.read@1', { op: 'list', collection: 'suggestions', where: 'owner != member-a', ownerScoped: true }))
      .toMatchObject({ ok: false, evidence: { attempts: [{ reason: 'unsupported store filter' }] } });
    const invalid = { ...write, key: 'suggestion-2', value: { ...write.value, id: 'suggestion-1' } };
    expect(await invoke('store.write@1', { ...invalid, __validatedWrite: structuredClone(invalid) }))
      .toMatchObject({ ok: false, evidence: { attempts: [{ reason: 'store key/value mismatch' }] } });
    expect(await invoke('store.write@1', { ...write, __validatedWrite: { ...write, owner: 'member-b' } }))
      .toMatchObject({ ok: false, error: 'store write input differs from its validated payload' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('member journal repairs only a crash-truncated final append and accepts the next write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'member-graph-tail-'));
  const root = join(directory, 'store');
  try {
    const registry = createMemberStoreRegistry({ root });
    const invoke = (contract: 'store.read@1' | 'store.write@1', payload: Record<string, unknown>) =>
      dispatchGraphContract(contract, { graphId: 'absorb-ingest', runId: 'tail-run', nodeId: 'save',
        verifiedOwnerId: 'member-a', input: { context: { memberId: 'member-a' } }, nodeInput: payload, outputs: {} }, registry);
    const first = { op: 'create', collection: 'scraps', owner: 'member-a', ownerScoped: true,
      value: { id: 'scrap-1', kind: 'text', text: 'first' } };
    expect(await invoke('store.write@1', { ...first, __validatedWrite: structuredClone(first) })).toMatchObject({ ok: true });
    const path = join(root, `member-${createHash('sha256').update('member-a').digest('hex')}.jsonl`);
    appendFileSync(path, '{"collection":"scraps","key":"unfinished"');
    expect(await invoke('store.read@1', { op: 'list', collection: 'scraps', ownerScoped: true }))
      .toMatchObject({ ok: true, result: { items: [{ text: 'first' }] } });
    expect(readFileSync(path, 'utf8')).not.toContain('unfinished');
    const second = { ...first, value: { id: 'scrap-2', kind: 'text', text: 'second' } };
    expect(await invoke('store.write@1', { ...second, __validatedWrite: structuredClone(second) })).toMatchObject({ ok: true });
    expect(await invoke('store.read@1', { op: 'list', collection: 'scraps', ownerScoped: true }))
      .toMatchObject({ ok: true, result: { items: [{ text: 'first' }, { text: 'second' }] } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('parent sync failure rolls back; a restarted provider syncs the existing journal on retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'member-graph-fsync-'));
  const root = join(directory, 'store');
  try {
    let syncCalls = 0;
    const registry = createMemberStoreRegistry({ root, syncParent: () => { syncCalls++; throw new Error('fsync fault'); } });
    const write = { op: 'create', collection: 'scraps', owner: 'member-a', ownerScoped: true,
      value: { id: 'scrap-1', kind: 'text', text: 'must not commit' } };
    const context = (nodeInput: Record<string, unknown>) => ({ graphId: 'absorb-ingest', runId: 'sync-run', nodeId: 'save',
      verifiedOwnerId: 'member-a', input: { context: { memberId: 'member-a' } }, nodeInput, outputs: {} });
    expect(await dispatchGraphContract('store.write@1', context({ ...write, __validatedWrite: structuredClone(write) }), registry))
      .toMatchObject({ ok: false, evidence: { attempts: [{ reason: 'member store unavailable' }] } });
    expect(syncCalls).toBe(1);
    expect(await dispatchGraphContract('store.read@1', context({ op: 'list', collection: 'scraps', ownerScoped: true }), registry))
      .toMatchObject({ ok: true, result: { items: [] } });
    let retrySyncs = 0;
    const restarted = createMemberStoreRegistry({ root, syncParent: () => { retrySyncs++; } });
    expect(await dispatchGraphContract('store.write@1', context({ ...write, __validatedWrite: structuredClone(write) }), restarted))
      .toMatchObject({ ok: true, result: { text: 'must not commit' } });
    const next = { ...write, value: { id: 'scrap-2', kind: 'text', text: 'next' } };
    expect(await dispatchGraphContract('store.write@1', context({ ...next, __validatedWrite: structuredClone(next) }), restarted))
      .toMatchObject({ ok: true, result: { text: 'next' } });
    expect(retrySyncs).toBe(2);
    expect(await dispatchGraphContract('store.read@1', context({ op: 'list', collection: 'scraps', ownerScoped: true }), restarted))
      .toMatchObject({ ok: true, result: { items: [{ text: 'must not commit' }, { text: 'next' }] } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('member graph store refuses a symlinked storage directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'member-graph-link-'));
  try {
    const external = join(directory, 'external');
    const root = join(directory, 'store');
    symlinkSync(external, root);
    const result = await dispatchGraphContract('store.read@1', {
      graphId: 'absorb-brief', runId: 'run-link', nodeId: 'collect', verifiedOwnerId: 'member-a',
      input: { context: { memberId: 'member-a' } }, nodeInput: { op: 'list', collection: 'scraps', ownerScoped: true }, outputs: {},
    }, createMemberStoreRegistry({ root }));
    expect(result).toMatchObject({ ok: false, evidence: { attempts: [{ reason: 'member store unavailable' }] } });
    expect(existsSync(external)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('member graph store refuses a dangling journal symlink instead of treating it as empty', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'member-graph-journal-link-'));
  try {
    const root = join(directory, 'store');
    mkdirSync(root, { mode: 0o700 });
    const digest = createHash('sha256').update('member-a').digest('hex');
    symlinkSync(join(directory, 'missing'), join(root, `member-${digest}.jsonl`));
    const result = await dispatchGraphContract('store.read@1', {
      graphId: 'absorb-brief', runId: 'run-link', nodeId: 'collect', verifiedOwnerId: 'member-a',
      input: { context: { memberId: 'member-a' } }, nodeInput: { op: 'list', collection: 'scraps', ownerScoped: true }, outputs: {},
    }, createMemberStoreRegistry({ root }));
    expect(result).toMatchObject({ ok: false, evidence: { attempts: [{ reason: 'member store unavailable' }] } });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
