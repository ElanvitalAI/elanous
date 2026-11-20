// D17 case table: layer × operation × condition, one test per cell. Expectations are literals (rule 11), never derived
// from the store's own constants or helpers.
import { expect, test } from 'bun:test';
import { createLogicalClock, MemoryStoreError, SimMemoryStore } from './store.js';

const DAY = 86_400_000;
const w = (over: Partial<{ tenant: string; graphId: string; runId: string; key: string; text: string; ttlMs: number }> = {}) =>
  ({ tenant: 't-x', graphId: 'g-a', runId: 'r-1', nodeId: 'n-1', key: 'k', text: 'line', ...over });
const all = ['instance', 'template', 'global'] as const;
const code = async (work: Promise<unknown>) => work.then(() => 'ok', (error: unknown) =>
  error instanceof MemoryStoreError ? `${error.code} | ${error.message}` : `other | ${String(error)}`);

function world() {
  const clock = createLogicalClock('2026-11-19T00:00:00.000Z');
  return { clock, store: new SimMemoryStore(clock) };
}
async function promoted(store: SimMemoryStore, to: 'template' | 'global', over: Parameters<typeof w>[0] = {}) {
  const source = await store.write(w(over));
  return store.promote({ tenant: source.tenant, graphId: source.graphId, runId: source.runId, nodeId: 'n-p', sourceId: source.id,
    to, approval: { by: 'sim-approver' } });
}

type Case = readonly [cell: string, run: () => Promise<unknown>, expected: unknown];
const CASES: readonly Case[] = [
  ['instance × write × ok → instance row, seq and time from the clock', async () => {
    const { store } = world();
    const record = await store.write(w());
    return [record.id, record.seq, record.scope, record.writtenAt, record.expiresAt];
  }, ['mem-1', 1, 'instance', '2026-11-19T00:00:00.000Z', '2026-11-20T00:00:00.000Z']],
  ['instance × read × same run → 1 · other run → 0', async () => {
    const { store } = world();
    await store.write(w());
    return [(await store.read({ ...w(), scopes: all })).length, (await store.read({ ...w({ runId: 'r-2' }), scopes: all })).length];
  }, [1, 0]],
  ['template × read × same graph other run → 1 · other graph → 0', async () => {
    const { store } = world();
    await promoted(store, 'template');
    const texts = async (graphId: string) => (await store.read({ tenant: 't-x', graphId, runId: 'r-9', scopes: ['template'] })).map(r => r.text);
    return [await texts('g-a'), await texts('g-b')];
  }, [['line'], []]],
  ['global × read × other graph same tenant → 1', async () => {
    const { store } = world();
    await promoted(store, 'global');
    return (await store.read({ tenant: 't-x', graphId: 'g-b', runId: 'r-9', scopes: ['global'] })).map(r => [r.scope, r.approvedBy]);
  }, [['global', 'sim-approver']]],
  ['instance/template/global × read × other tenant → 0 each', async () => {
    const { store } = world();
    await store.write(w({ key: 'i' }));
    await promoted(store, 'template', { key: 't' });
    await promoted(store, 'global', { key: 'g' });
    return (await store.read({ tenant: 't-y', graphId: 'g-a', runId: 'r-1', scopes: all })).length;
  }, 0],
  ['instance × write × same key in two tenants → both kept, no collision', async () => {
    const { store } = world();
    await store.write(w({ tenant: 't-x', text: 'x-line' }));
    await store.write(w({ tenant: 't-y', text: 'y-line' }));
    return [(await store.read({ ...w({ tenant: 't-x' }), scopes: all })).map(r => r.text),
      (await store.read({ ...w({ tenant: 't-y' }), scopes: all })).map(r => r.text), store.events().filter(e => e.type === 'memory.refused').length];
  }, [['x-line'], ['y-line'], 0]],
  ['template × promote × no approval → refused, 0 template rows, refusal event', async () => {
    const { store } = world();
    const source = await store.write(w());
    const result = await code(store.promote({ tenant: 't-x', graphId: 'g-a', runId: 'r-1', nodeId: 'n-p', sourceId: source.id, to: 'template' }));
    return [result, (await store.read({ ...w(), scopes: ['template'] })).length, store.events().at(-1)?.type, store.events().at(-1)?.data.code];
  }, ['approval-required | memory promote refused: approval-required', 0, 'memory.refused', 'approval-required']],
  ['global × promote × no approval → refused, 0 global rows', async () => {
    const { store } = world();
    const source = await store.write(w());
    const result = await code(store.promote({ tenant: 't-x', graphId: 'g-a', runId: 'r-1', nodeId: 'n-p', sourceId: source.id, to: 'global' }));
    return [result, (await store.read({ ...w(), scopes: ['global'] })).length];
  }, ['approval-required | memory promote refused: approval-required', 0]],
  ['template × promote × approval → 1 row with approver and source link', async () => {
    const { store } = world();
    const record = await promoted(store, 'template');
    return [record.id, record.scope, record.approvedBy, record.promotedFrom, record.expiresAt];
  }, ['mem-2', 'template', 'sim-approver', 'mem-1', '2026-12-19T00:00:00.000Z']],
  ['template × promote × other tenant source → tenant-mismatch', async () => {
    const { store } = world();
    const source = await store.write(w());
    return code(store.promote({ tenant: 't-y', graphId: 'g-a', runId: 'r-1', nodeId: 'n-p', sourceId: source.id, to: 'template',
      approval: { by: 'sim-approver' } }));
  }, 'tenant-mismatch | memory promote refused: tenant-mismatch'],
  ['template × promote × concurrent same key → 1 claimed, 1 key-claimed, both sources kept', async () => {
    const { store } = world();
    const a = await store.write(w({ runId: 'r-1', text: 'from-r1' }));
    const b = await store.write(w({ runId: 'r-2', text: 'from-r2' }));
    const results = await Promise.all([a, b].map(source => code(store.promote({ tenant: 't-x', graphId: 'g-a', runId: source.runId,
      nodeId: 'n-p', sourceId: source.id, to: 'template', approval: { by: 'sim-approver' } }))));
    return [results, store.all().filter(r => r.scope === 'template').map(r => r.text), store.all().filter(r => r.scope === 'instance').length];
  }, [['ok', 'key-claimed | memory promote refused: key-claimed'], ['from-r1'], 2]],
  ['instance × write × concurrent 3 → seq follows call order', async () => {
    const { store } = world();
    const records = await Promise.all(['a', 'b', 'c'].map(text => store.write(w({ text }))));
    return records.map(r => `${r.seq}:${r.text}`);
  }, ['1:a', '2:b', '3:c']],
  ['instance × write × writer dies mid-write → no record, event, next write still works', async () => {
    const { store } = world();
    store.armDeathMidWrite();
    const died = await code(store.write(w({ text: 'lost' })));
    const next = await store.write(w({ text: 'kept' }));
    return [died, store.all().map(r => r.text), next.seq, store.events().map(e => e.type)];
  }, ['writer-died | memory write lost: writer died mid-write', ['kept'], 1, ['memory.writer-died', 'memory.written']]],
  ['instance × read × +8d → instance rows (1d) expired; promoted template row (30d) kept; tombstones not deleted', async () => {
    const { store, clock } = world();
    await store.write(w({ key: 'short', text: 'short' }));
    await promoted(store, 'template', { key: 'keep', text: 'keep' });
    clock.advance(8 * DAY);
    const expired = await store.expire();
    return [expired, (await store.read({ ...w({ runId: 'r-9' }), scopes: all })).map(r => r.text), store.all().length,
      store.all().filter(r => r.expired).map(r => r.key)];
  }, [2, ['keep'], 3, ['short', 'keep']]],
  ['template × read × +31d → template row (30d) gone', async () => {
    const { store, clock } = world();
    await promoted(store, 'template');
    clock.advance(31 * DAY);
    return (await store.read({ ...w({ runId: 'r-9' }), scopes: ['template'] })).length;
  }, 0],
  ['instance × write × ttlMs longer than the 1d scope TTL → refused (a fake may not outlive the real store)', async () => {
    const { store } = world();
    return [await code(store.write(w({ ttlMs: 7 * DAY }))), store.all().length];
  }, ['invalid | memory write refused: invalid', 0]],
  ['instance × write × secret-looking text → refused with event', async () => {
    const { store } = world();
    return [await code(store.write(w({ text: 'api_key=abc123' }))), store.all().length, store.events().map(e => e.data.code)];
  }, ['sensitive | memory write refused: sensitive', 0, ['sensitive']]],
  ['instance × write × identical write twice → same row back, no duplicate', async () => {
    const { store } = world();
    const first = await store.write(w());
    const second = await store.write(w());
    return [first.id, second.id, store.all().length, store.events().map(e => e.type)];
  }, ['mem-1', 'mem-1', 1, ['memory.written', 'memory.write-deduped']]],
  ['instance × write × 1001st row in one run → capacity-exceeded', async () => {
    const { store } = world();
    for (let i = 0; i < 1000; i++) await store.write(w({ key: `k${i}` }));
    return [await code(store.write(w({ key: 'k1000' }))), store.all().length];
  }, ['capacity-exceeded | memory write refused: capacity-exceeded', 1000]],
  ['instance × read × 12 visible rows → first 10 by seq', async () => {
    const { store } = world();
    for (let i = 1; i <= 12; i++) await store.write(w({ key: `k${i}`, text: `t${i}` }));
    const rows = await store.read({ ...w(), scopes: all });
    return [rows.length, rows[0]?.text, rows.at(-1)?.text];
  }, [10, 't1', 't10']],
  ['all layers × replay × same script on the same clock → byte-identical snapshot', async () => {
    const script = async () => {
      const { store, clock } = world();
      await store.write(w({ key: 'a', text: 'one' }));
      await promoted(store, 'template', { key: 'b', text: 'two' });
      store.armDeathMidWrite();
      await code(store.write(w({ key: 'c', text: 'lost' })));
      await code(store.promote({ tenant: 't-x', graphId: 'g-a', runId: 'r-1', nodeId: 'n-p', sourceId: 'mem-1', to: 'global' }));
      clock.advance(2 * DAY);
      await store.expire();
      return store.snapshot();
    };
    const [first, second] = [await script(), await script()];
    return [first === second, first.length > 0];
  }, [true, true]],
  ['instance × read × TTL passed but not swept → already invisible', async () => {
    const { store, clock } = world();
    await store.write(w({ ttlMs: DAY }));
    clock.advance(DAY);
    return (await store.read({ ...w(), scopes: all })).length;
  }, 0],
  ['instance × write × injected store fault → store-fault error, listed in faults(), no row', async () => {
    const { store } = world();
    store.injectStoreFault();
    return [await code(store.write(w())), store.faults(), store.all().length, store.events().map(e => e.type)];
  }, ['store-fault | memory write failed (injected)', ['memory write failed (injected)'], 0, ['memory.fault']]],
  ['instance × write × invalid key → refused with event', async () => {
    const { store } = world();
    return [await code(store.write(w({ key: 'bad key' }))), store.events().map(e => e.type)];
  }, ['invalid | memory write refused: invalid', ['memory.refused']]],
  ['instance × digest × unchanged rows → same hash; new row → different hash', async () => {
    const { store } = world();
    await store.write(w());
    const first = store.instanceDigest('t-x', 'g-a', 'r-1');
    const again = store.instanceDigest('t-x', 'g-a', 'r-1');
    await store.write(w({ text: 'more' }));
    return [first === again, first === store.instanceDigest('t-x', 'g-a', 'r-1'), first.length];
  }, [true, false, 64]],
];

for (const [cell, run, expected] of CASES) test(`D17 ${cell}`, async () => { expect(await run()).toEqual(expected); });
