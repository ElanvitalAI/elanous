import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listGraphRuns, runGraph } from '../graph-runner/runner.js';
import { registerGraphTriggerDispatchBinding } from './graph-trigger-dispatch-lease.js';
import { listFires, openTriggerRegistry, registerTrigger, tickTriggers, type TriggerDecl, type TriggerTickDeps } from './trigger-registry.js';

// Synthetic legacy retro and pulse declarations: both fire simultaneously, against a scratch registry only.
test('pulse and legacy retro survive concurrent ticks and restart with occupied run bindings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'op-runid-'));
  const stateRoot = join(dir, 'state'); const seatState = join(dir, 'seat');
  mkdirSync(seatState, { recursive: true });
  let db = openTriggerRegistry(stateRoot);
  try {
    const ids = ['op-pulse', 'op-retro'];
    writeFileSync(join(dir, 'recipes.yaml'), '{}\n');
    for (const graphId of ids) {
      const file = join(dir, `${graphId}.yaml`);
      // 출처: #40492 — this fixture has one terminal node and no edges, so one visit suffices.
      writeFileSync(file, `graph_id: ${graphId}\nversion: 1\nentry_node: done\nterminal_nodes: [done]\nnodes:\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges: []\n`);
      const decl: TriggerDecl = { graphId, file, owner: 'OP', cron: '0 * * * *', timeZone: 'UTC',
        goal: { kind: 'file-mtime', path: `{stateRoot}/${graphId}.done` }, goalDeadlineMin: 20,
        maxAttempts: 2, backoffSec: [60], cutoverAfter: 1, staleAfterMin: 30 };
      registerTrigger(db, decl);
      // Simulate a previous process having consumed the original binding and its first fallback.
      for (const suffix of ['', '~2']) registerGraphTriggerDispatchBinding({ triggerId: `cron:${graphId}`,
        dedupeKey: `2026-11-27T10:00:00.000Z#1${suffix}`, graphId }, { registryRoot: stateRoot, stateRoot });
    }
    let now = new Date('2026-11-27T10:00:10Z');
    const runs: Array<{ graphId: string; runId: string }> = [];
    const deps: TriggerTickDeps = { now: () => now, vars: { stateRoot, seatState },
      runGraph: async (decl, _input, runId) => {
        runs.push({ graphId: decl.graphId, runId });
        const result = await runGraph(decl.file, { runId, deps: { root: stateRoot } });
        const goal = join(stateRoot, `${decl.graphId}.done`);
        writeFileSync(goal, 'done');
        utimesSync(goal, now, now);
        return { status: result.status, runId };
      }, postCard: async () => 'synthetic', scheduleAction: async () => {} };
    const secondDb = openTriggerRegistry(stateRoot);
    try { await Promise.all([tickTriggers(db, deps), tickTriggers(secondDb, deps)]); }
    finally { secondDb.close(); }
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map(r => r.runId)).size).toBe(2);
    for (const id of ids) {
      const bindings = ['', '~2'].map(suffix => registerGraphTriggerDispatchBinding({ triggerId: `cron:${id}`,
        dedupeKey: `2026-11-27T10:00:00.000Z#1${suffix}`, graphId: id }, { registryRoot: stateRoot, stateRoot }).runId);
      expect(bindings).not.toContain(runs.find(r => r.graphId === id)!.runId);
      expect(['dispatched', 'done']).toContain(listFires(db, id)[0]!.status);
    }
    db.close();
    db = openTriggerRegistry(stateRoot);
    now = new Date('2026-11-27T11:00:10Z');
    await tickTriggers(db, deps);
    expect(runs).toHaveLength(4);
    expect(new Set(runs.map(r => r.runId)).size).toBe(4);
    expect(listGraphRuns(stateRoot).runs.filter(r => ids.includes(r.graphId)).map(r => r.status)).toEqual(['done', 'done', 'done', 'done']);
    now = new Date('2026-11-27T11:01:00Z');
    await tickTriggers(db, deps);
    for (const id of ids) {
      const fires = listFires(db, id);
      expect(fires.some(f => f.window === '2026-11-27T10:00:00.000Z' && f.status === 'done')).toBe(true);
      expect(fires.some(f => f.window === '2026-11-27T11:00:00.000Z' && f.status === 'done')).toBe(true);
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
