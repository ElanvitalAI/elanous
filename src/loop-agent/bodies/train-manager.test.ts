import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LedgerRow, PrInfo } from '../../land-graph/land-graph.js';
import { parseKnowhowItems } from '../../seat-loop/seat-knowhow.js';
import { loadCard } from '../card.js';
import { fileAgentMemory } from '../memory.js';
import { tickAgent, type AgentPorts } from '../runtime.js';
import type { LandPolicy } from '../../land-steward/policy.js';
import { createBody, type TrainManagerDeps } from './train-manager.js';

// The body delegates to the land-steward train manager (decision 11-27): lanes come from land-steward `lanes()`, the order
// from `trainOrder`, the pins from its policy pack. The card's one action proposes a pin to TC by mail — it writes nothing.
const T0 = new Date('2026-11-27T10:00:00Z');
const pr = (n: number, files: string[]): PrInfo => ({ number: n, head: `h${n}`, base: 'main', draft: false, state: 'OPEN', title: `t${n}`, author: 'x', files });
const refused = (n: number, min: number): LedgerRow => ({ at: new Date(T0.getTime() - min * 60_000).toISOString(), pr: n, head: `h${n}`, mode: 'live', event: 'refused', cls: 'merge-conflict' } as LedgerRow);

function world(opts: { ghDown?: boolean; mailDown?: boolean; pinned?: boolean } = {}) {
  const prs = [pr(40501, ['src/hot.ts']), pr(40502, ['src/hot.ts', 'src/b.ts']), pr(40503, ['src/solo.ts'])];
  const rows = [refused(40502, 10), refused(40501, 20)];
  const mails: Array<{ key: string; to: string; body: string }> = [];
  const policy: LandPolicy | null = opts.pinned ? { laneOrder: { mode: 'train', pins: [{ file: 'src/hot.ts', prs: [40501, 40502] }] } } : null;
  const deps: TrainManagerDeps = {
    readLedger: () => rows,
    listPrs: async () => (opts.ghDown ? null : prs),
    policy: () => policy,
    post: (key, to, body) => { if (opts.mailDown) return false; if (mails.some(m => m.key === key)) return null; mails.push({ key, to, body }); return 900 + mails.length; },
  };
  return { deps, mails };
}

function harness(w: ReturnType<typeof world>) {
  const root = mkdtempSync(join(tmpdir(), 'tm-'));
  const card = loadCard('train-manager');
  const memory = fileAgentMemory(root, card.id, card.supervisor);
  const ports: AgentPorts = { memory, post: () => null, beat: () => {}, speak: () => {}, llm: null };
  return { card, ports, body: createBody({ stateRoot: root, card }, w.deps) };
}

describe('train-manager → land-steward train manager (delegated body)', () => {
  test('a churning hot-file lane → one pin proposal mail to TC with the YAML line · nothing written', async () => {
    const w = world(); const h = harness(w);
    const r = await tickAgent(h.card, h.body, h.ports, T0);
    expect(r.kpi).toBe(2);
    expect(r.acted).toEqual(['propose-pin:lane:src/hot.ts']);
    expect(w.mails.map(m => m.to)).toEqual(['TC']);
    expect(w.mails[0]!.body).toContain('lane_order.pins');
    expect(w.mails[0]!.body).toContain('file: src/hot.ts');
  });
  test('a lane already pinned in the pack is left alone', async () => {
    const w = world({ pinned: true }); const h = harness(w);
    const r = await tickAgent(h.card, h.body, h.ports, T0);
    expect(r.acted).toEqual([]);
    expect(w.mails).toEqual([]);
  });
  test('gh down: the KPI still comes from the land ledger (never hidden) · no lane action', async () => {
    const w = world({ ghDown: true }); const h = harness(w);
    const r = await tickAgent(h.card, h.body, h.ports, T0);
    expect(r.kpi).toBe(2);
    expect(r.acted).toEqual([]);
  });
  test('a mail that could not be sent is a failure, not «sent»', async () => {
    const w = world({ mailDown: true }); const h = harness(w);
    const r = await tickAgent(h.card, h.body, h.ports, T0);
    expect(r.failed).toEqual(['propose-pin:lane:src/hot.ts']);
  });
});

describe('train-manager card', () => {
  test('card loads · address = id upper · knowhow parses', () => {
    const c = loadCard('train-manager');
    expect(c).toMatchObject({ id: 'train-manager', address: 'TRAIN-MANAGER', supervisor: 'TC', name: '기차 매니저', kpi: { name: 'hot_file_churn_refusals', dir: 'at_most', target: 0 } });
    expect(c.rights.actions).toEqual(['propose-pin']);
    const kh = readFileSync(resolve(import.meta.dir, '../../../graphs/loop-agents/train-manager/knowhow.md'), 'utf8');
    expect(parseKnowhowItems(kh, 'TRAIN-MANAGER').length).toBeGreaterThanOrEqual(3);
  });
});
