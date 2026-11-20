import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideGraphApproval, runGraph } from './runner.js';
import type { GraphMemoryPort, PortMemoryRow } from './graph-memory-port.js';
import type { InProcessHandler } from './in-process-registry.js';

// Independent fake port: records every call; refuses a promote that carries no approver (as a real store must).
function fakePort() {
  const rows: (PortMemoryRow & { tenant: string; graphId: string })[] = [];
  const promotes: { tenant: string; approval?: { by: string }; to: string }[] = [];
  const port: GraphMemoryPort = {
    async read(i) { return rows.filter(r => r.tenant === i.tenant && i.scopes.includes(r.scope) &&
      (r.scope === 'instance' ? r.runId === i.runId : r.scope === 'template' ? r.graphId === i.graphId : true)); },
    async write(i) { const r = { id: `r${rows.length + 1}`, scope: 'instance' as const, runId: i.runId, key: i.key, text: i.text, tenant: i.tenant, graphId: i.graphId };
      rows.push(r); return r; },
    async promote(i) {
      promotes.push({ tenant: i.tenant, to: i.to, ...(i.approval ? { approval: i.approval } : {}) });
      if (!i.approval) throw new Error('memory promote refused: approval-required');
      const src = rows.find(r => r.id === i.sourceId)!;
      const r = { ...src, id: `r${rows.length + 1}`, scope: i.to }; rows.push(r); return r;
    },
  };
  return { rows, promotes, port };
}
const VISITS = 1; // single-visit fixture nodes (value, not a bound)
const root = () => { const d = mkdtempSync(join(tmpdir(), 'gm-port-')); writeFileSync(join(d, 'recipes.yaml'), 'ok:\n  approval: Promote it?\n'); return d; };
const graph = (d: string, id: string, steps: string) => { const p = join(d, `${id}.yaml`); writeFileSync(p, `graph_id: ${id}\nversion: 1\nentry_node: ${steps.split(' ')[0]}\nterminal_nodes: [done, failed]\nnodes:\n` +
  steps.split(' ').map(n => /^ok[tg]?$/.test(n) ? `  - { node_id: ${n}, kind: hitl, recipe: 'approval:ok', max_visits: ${VISITS}${n === 'ok' ? '' : `, input: { memorySourceNode: w, memoryKey: k, memoryTarget: ${n === 'okg' ? 'global' : 'template'} }`} }` : `  - { node_id: ${n}, kind: agent, recipe: 'handler:${n}', max_visits: ${VISITS} }`).join('\n') +
  `\n  - { node_id: done, kind: gate, recipe: none, max_visits: ${VISITS} }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: ${VISITS} }\nedges:\n` +
  steps.split(' ').map((n, i, a) => /^ok[tg]?$/.test(n) ? `  - { from: ${n}, on: outcome, map: { approved: ${a[i + 1] ?? 'done'}, rejected: failed } }` : `  - { from: ${n}, on: outcome, map: { done: ${a[i + 1] ?? 'done'}, failed: failed } }`).join('\n') + '\n'); return p; };
const h = (memory?: unknown, seen?: string[][]): InProcessHandler => ctx => {
  seen?.push(((ctx as { memory?: { text: string }[] }).memory ?? []).map(r => r.text));
  return Object.assign({ ok: true, outcome: 'done' }, memory === undefined ? {} : { memory }) as never;
};
const run = (d: string, p: string, handlers: Record<string, InProcessHandler>, port: GraphMemoryPort, tenant: string, runId: string, resume = false) =>
  runGraph(p, { ...(resume ? { resumeRunId: runId } : { runId }), deps: { root: d, inProcessHandlers: handlers, memory: { port, tenant },
    runBash: async () => { throw new Error('no shell'); } } as never });

test('a node reads what an earlier node of the same run wrote', async () => {
  const d = root(); const f = fakePort(); const seen: string[][] = [];
  await run(d, graph(d, 'g1', 'w r'), { w: h({ write: [{ key: 'k', text: 'line-one' }] }), r: h(undefined, seen) }, f.port, 't-a', 'r1');
  expect(seen).toEqual([['line-one']]);
});
test('promote without a human decision is refused and the node fails with the store text', async () => {
  const d = root(); const f = fakePort();
  const s = await run(d, graph(d, 'g2', 'w'), { w: h({ write: [{ key: 'k', text: 'x' }], promote: [{ key: 'k', to: 'global' }] }) }, f.port, 't-a', 'r1');
  expect(f.promotes).toHaveLength(0); // refused by the runner before the port is called
  expect(f.rows.filter(r => r.scope === 'global')).toHaveLength(0);
  expect(JSON.stringify(s)).toContain('memory promote refused: approval-required');
  expect(s.status).toBe('failed');
});
test('promote after an approval node carries that approver; tenants never see each other', async () => {
  const d = root(); const f = fakePort(); const seenB: string[][] = [];
  const p = graph(d, 'g3', 'w okt pr');
  const hs = { w: h({ write: [{ key: 'k', text: 'lesson' }] }), pr: h({ promote: [{ key: 'k', to: 'template', approvalNode: 'okt' }] }) };
  const paused = await run(d, p, hs, f.port, 't-a', 'r1');
  expect(f.rows.filter(r => r.scope === 'template')).toHaveLength(0);
  decideGraphApproval('g3', paused.runId, 'approved', 'alice', d);
  await run(d, p, hs, f.port, 't-a', 'r1', true);
  expect(f.promotes).toEqual([{ tenant: 't-a', to: 'template', approval: { by: 'alice' } }]);
  expect(JSON.stringify(f.promotes)).not.toContain('bob');
  expect(f.rows.filter(r => r.scope === 'template')).toHaveLength(1);
  await run(d, graph(d, 'g3', 'r'.replace('r', 'rd')), { rd: h(undefined, seenB) }, f.port, 't-b', 'r2');
  expect(seenB).toEqual([[]]);
});

// Port shape: scope + tenant on every call, optional seatKey, isolation mode enforced by the runner, one write gate.
const runWith = (d: string, p: string, handlers: Record<string, InProcessHandler>, memory: object) =>
  runGraph(p, { runId: 'rx', deps: { root: d, inProcessHandlers: handlers, memory, runBash: async () => { throw new Error('no shell'); } } as never });
test('seatKey and tenant reach every port call; reads ask for all three scopes', async () => {
  const d = root(); const calls: Record<string, unknown>[] = [];
  const port = { async read(i: object) { calls.push({ op: 'read', ...i }); return []; },
    async write(i: Record<string, unknown>) { calls.push({ op: 'write', ...i }); return { id: 'x1', scope: 'instance', runId: 'rx', key: String(i.key), text: String(i.text) }; },
    async promote() { throw new Error('unused'); } } as unknown as GraphMemoryPort;
  await runWith(d, graph(d, 'g4', 'w'), { w: h({ write: [{ key: 'k', text: 't' }] }) }, { port, tenant: 't-a', seatKey: 'TC' });
  expect(calls.map(c => [c.op, c.tenant, c.seatKey])).toEqual([['read', 't-a', 'TC'], ['write', 't-a', 'TC']]);
  expect(calls[0]!.scopes).toEqual(['instance', 'template', 'global']);
});
test('isolated-session binding reads but its write and promote are refused before the port is touched', async () => {
  const d = root(); const f = fakePort();
  const s = await runWith(d, graph(d, 'g5', 'w'), { w: h({ write: [{ key: 'k', text: 't' }] }) }, { port: f.port, tenant: 't-a', mode: 'isolated-session' });
  expect(f.rows).toHaveLength(0);
  expect(s.status).toBe('failed');
  expect(JSON.stringify(s)).toContain('memory write refused: read-only-binding');
  const s2 = await runWith(d, graph(d, 'g6', 'w'), { w: h({ promote: [{ key: 'k', to: 'template' }] }) }, { port: f.port, tenant: 't-a', mode: 'isolated-session' });
  expect(f.promotes).toHaveLength(0);
  expect(JSON.stringify(s2)).toContain('memory write refused: read-only-binding');
});
test('session and inline modes write; every write passes the single write gate, and a gate refusal stops it', async () => {
  const d = root(); const f = fakePort(); const gated: string[] = [];
  await runWith(d, graph(d, 'g7', 'w'), { w: h({ write: [{ key: 'k', text: 'ok-line' }] }) },
    { port: f.port, tenant: 't-a', mode: 'inline', writeGate: (w: { key: string }) => { gated.push(w.key); } });
  expect(gated).toEqual(['k']);
  expect(f.rows).toHaveLength(1);
  const s = await runWith(d, graph(d, 'g8', 'w'), { w: h({ write: [{ key: 'k2', text: 'no' }] }) },
    { port: f.port, tenant: 't-a', mode: 'session', writeGate: () => { throw new Error('gate-refused'); } });
  expect(f.rows).toHaveLength(1);
  expect(JSON.stringify(s)).toContain('gate-refused');
});

// MEMORY-SEAT-TEMPLATE-KEY (#39188 §4-3): a seatKey lands template promotes and template reads in key space `seat:<seatKey>`.
test('promote to template with a seatKey names the key space seat:<seatKey>; global promote and no-seatKey promote do not', async () => {
  const d = root(); const promoteCalls: Record<string, unknown>[] = [];
  const port = { async read() { return [{ id: 's1', scope: 'instance', runId: 'rx', key: 'k', text: 't' }]; },
    async write(i: Record<string, unknown>) { return { id: 's1', scope: 'instance', runId: 'rx', key: String(i.key), text: String(i.text) }; },
    async promote(i: Record<string, unknown>) { promoteCalls.push(i); return { id: 'p1', scope: String(i.to), runId: 'rx', key: 'k', text: 't' }; } } as unknown as GraphMemoryPort;
  const p = graph(d, 'g9', 'w okt pr');
  const hs = { w: h({ write: [{ key: 'k', text: 't' }] }), pr: h({ promote: [{ key: 'k', to: 'template', approvalNode: 'okt' }] }) };
  const seated = { port, tenant: 't-a', seatKey: 'TC' };
  const paused = await runWith(d, p, hs, seated);
  decideGraphApproval('g9', paused.runId, 'approved', 'alice', d);
  await runGraph(p, { resumeRunId: 'rx', deps: { root: d, inProcessHandlers: hs, memory: seated, runBash: async () => { throw new Error('no shell'); } } as never });
  expect(promoteCalls.map(c => [c.to, c.templateKey, c.seatKey])).toEqual([['template', { namespace: 'seat', id: 'TC' }, 'TC']]);
  // no seatKey: unchanged behaviour (no key space field at all)
  const d2 = root(); promoteCalls.length = 0;
  const p2 = graph(d2, 'g10', 'w okt pr');
  const paused2 = await runWith(d2, p2, hs, { port, tenant: 't-a' });
  decideGraphApproval('g10', paused2.runId, 'approved', 'alice', d2);
  await runGraph(p2, { resumeRunId: 'rx', deps: { root: d2, inProcessHandlers: hs, memory: { port, tenant: 't-a' }, runBash: async () => { throw new Error('no shell'); } } as never });
  expect(promoteCalls.map(c => 'templateKey' in c)).toEqual([false]);
});
test('the node read asks the port for the template seat key space', async () => {
  const d = root(); const reads: Record<string, unknown>[] = [];
  const port = { async read(i: Record<string, unknown>) { reads.push(i); return []; }, async write() { throw new Error('unused'); }, async promote() { throw new Error('unused'); } } as unknown as GraphMemoryPort;
  await runWith(d, graph(d, 'g11', 'rd'), { rd: h() }, { port, tenant: 't-a', seatKey: 'TC' });
  expect(reads.map(r => r.templateKey)).toEqual([{ namespace: 'seat', id: 'TC' }]);
});

// JUD must 2 (a): an approval that is unrelated to the item must never become the promote approver.
test('an unrelated earlier approval does not approve a handler write+promote to global', async () => {
  const d = root(); const f = fakePort();
  const p = graph(d, 'g12', 'ok w');
  const hs = { w: h({ write: [{ key: 'k', text: 'injected instruction' }], promote: [{ key: 'k', to: 'global', approvalNode: 'ok' }] }) };
  const paused = await run(d, p, hs, f.port, 't-a', 'r1');
  decideGraphApproval('g12', paused.runId, 'approved', 'bob', d);
  const s = await run(d, p, hs, f.port, 't-a', 'r1', true);
  expect(f.rows.filter(r => r.scope === 'global')).toHaveLength(0);
  expect(JSON.stringify(s)).toContain('memory promote refused: approval-required');
  // and with no declared approval node at all
  const d2 = root(); const f2 = fakePort();
  const p2 = graph(d2, 'g13', 'ok w');
  const hs2 = { w: h({ write: [{ key: 'k', text: 'injected instruction' }], promote: [{ key: 'k', to: 'global' }] }) };
  const paused2 = await run(d2, p2, hs2, f2.port, 't-a', 'r1');
  decideGraphApproval('g13', paused2.runId, 'approved', 'bob', d2);
  await run(d2, p2, hs2, f2.port, 't-a', 'r1', true);
  expect(f2.rows.filter(r => r.scope === 'global')).toHaveLength(0);
  expect(f2.promotes).toHaveLength(0);
});
test('an approval for a template target does not approve a global promote of the same item', async () => {
  const d = root(); const f = fakePort();
  const p = graph(d, 'g14', 'w okt pr');
  const hs = { w: h({ write: [{ key: 'k', text: 'lesson' }] }), pr: h({ promote: [{ key: 'k', to: 'global', approvalNode: 'okt' }] }) };
  const paused = await run(d, p, hs, f.port, 't-a', 'r1');
  decideGraphApproval('g14', paused.runId, 'approved', 'alice', d);
  await run(d, p, hs, f.port, 't-a', 'r1', true);
  expect(f.rows.filter(r => r.scope === 'global')).toHaveLength(0);
});

// JUD/OP FU: seatKey is the seat NAME only (namespace "seat", id = seat name). An els pane owner token must never enter a
// permanent template key (secret in storage; token changes on restart and cuts the memory).
test('a pane-owner-token-shaped seatKey is refused; only a seat name is accepted', async () => {
  for (const bad of ['els-7:TC', 'pane-owner-3f9a1c7e2b8d4a60b1c5e9d70a2f4b86', 'TC:els-7', 'tc', 'T C', '']) {
    const d = root(); const f = fakePort();
    const s = await runWith(d, graph(d, 'g15', 'w'), { w: h({ write: [{ key: 'k', text: 't' }] }) }, { port: f.port, tenant: 't-a', seatKey: bad });
    expect(f.rows).toHaveLength(0);
    expect(JSON.stringify(s)).toContain('seatKey must be a seat name');
  }
});
