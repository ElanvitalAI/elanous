import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore } from '../task-cards/card-store.js';
import { createWishCard } from '../intake-plane/wish-card.js';
import { scanWishFolder } from '../intake-plane/wish-folder.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { listChecklist } from '../release-loop/checklist.js';
import { setSchedule } from '../release-loop/release-schedule.js';
import { flowCard, flowTick, type FlowDeps } from './cards.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { Command } from 'commander';
import { registerFlowCommands } from '../cli/flow-cli.js';

let root = '';
let store: CardStore;
const now = new Date();
function setup() {
  root = mkdtempSync(join(tmpdir(), 'flow-cards-'));
  setElanousConfigDir(root);
  store = new CardStore(root);
  for (let n = 1; n <= 3; n++) {
    const at = new Date(now.getTime() + n * 86_400_000).toISOString();
    setSchedule(`0.2.${30 + n}`, { cutAt: at, landBy: at }, 'OP');
  }
}
afterEach(() => { store?.close(); resetElanousConfigDir(); if (root) rmSync(root, { recursive: true, force: true }); root = ''; });
const judgeReply = (value: unknown): NonNullable<FlowDeps['judge']> => async <T = string>(opts: { schema?: (v: unknown) => T | null }) => ({ ok: true, value: opts.schema ? opts.schema(value)! : value as T, reply: { text: '' }, provider: 'fake', model: 'fake' });
const cell = (id: string, title: string, predecessors: string[] = []) => ({ id, title, owner: 'TC', falsifier: `Check ${title}`, predecessors });
const placement = { now, merged24h: 10, seatCap: { TC: 1 } };

test('one tick splits two cells, places them via placeCell at seat-cap-constrained releases and never duplicates', async () => {
  setup();
  const wish = createWishCard({ text: 'Build account panel\nAdd status panel', source: 'tui', ref: 'flow-two' }, store);
  const replies: string[] = [];
  const deps: FlowDeps = { store, placement, judge: judgeReply({ cells: [cell('a', 'Account panel'), cell('b', 'Status panel')], gated: [] }), reply: async (_id, text) => { replies.push(text); } };
  expect(store.getCard(wish.cardId)?.goalId).toBe('wish:tui:flow-two');
  const first = await flowTick(deps);
  expect(first?.placements.map(p => p.version)).toEqual(['0.2.31', '0.2.32']);
  expect(first?.text).toContain('칸 2개 · 판 0.2.31, 0.2.32');
  expect(replies).toEqual([first!.text]);
  expect(listChecklist('0.2.31').items.map(c => c.id)).toEqual([`FLOW-${wish.cardId.replaceAll('-', '')}-a`]);
  expect(await flowCard(wish.cardId, deps)).toMatchObject({ duplicate: true, text: first?.text });
  expect(await flowTick(deps)).toBeNull();
  expect(listChecklist('0.2.32').items).toHaveLength(1);
});

test('same-card predecessor is translated to the preceding cell id and a later release', async () => {
  setup();
  const card = createWishCard({ text: 'Implement backend and frontend', source: 'tui', ref: 'dependency' }, store);
  const result = await flowCard(card.cardId, { store, placement: { ...placement, seatCap: { TC: 3 } },
    judge: judgeReply({ cells: [cell('a', 'Backend'), cell('b', 'Frontend', ['a'])], gated: [] }) });
  expect(result.placements.map(p => p.version)).toEqual(['0.2.31', '0.2.32']);
  expect(listChecklist('0.2.32').items[0]?.predecessors).toEqual([result.placements[0]!.id]);
});

test('payment is a decision only; ordinary work still becomes a cell, including on fallback', async () => {
  setup();
  const wish = createWishCard({ text: 'Build checkout mock. Charge customer payment.', source: 'tui', ref: 'payment' }, store);
  const raised: string[] = [];
  const deps: FlowDeps = { store, placement, judge: judgeReply({ cells: [cell('a', 'Build checkout mock')], gated: [{ title: 'Charge customer payment', text: 'Charge customer payment', category: 'money' }] }),
    raise: (input) => { raised.push(input.category); return 'D-20261004-01'; }, reply: async () => {} };
  const result = await flowCard(wish.cardId, deps);
  expect(raised).toEqual(['money']);
  expect(result.placements).toHaveLength(1);
  expect(result.decisions).toEqual(['D-20261004-01']);
  expect(result.placements[0]?.version).toBe('0.2.31');
  expect(listChecklist('0.2.31').items.map(c => c.title)).toEqual(['Build checkout mock']);
  const second = createWishCard({ text: 'Build UI. Pay invoice.', source: 'tui', ref: 'payment-fallback' }, store);
  const fallback = await flowCard(second.cardId, { ...deps, judge: async () => ({ ok: false, reason: 'call', error: 'offline' }), raise: () => 'D-20261004-02' });
  expect(fallback.placements).toHaveLength(1);
  expect(fallback.decisions).toHaveLength(1);
  expect(listChecklist(fallback.placements[0]!.version).items.some(c => c.title === 'Build UI')).toBe(true);
});

test('dry-run leaves all ledgers untouched even for two cells, and folder goalId stays unchanged', async () => {
  setup();
  const folder = join(root, 'wish');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(folder);
  writeFileSync(join(folder, 'one.md'), '# Folder wish\nPlease add the dashboard');
  scanWishFolder({ dir: folder, store });
  const card = store.listCards()[0]!;
  expect(card.goalId).toBe('wish:one.md');
  expect(JSON.parse(card.sections.find(s => s.key === 'intake:wish:0')!.content).text).toContain('Please add the dashboard');
  const deps: FlowDeps = { store, placement, judge: judgeReply({ cells: [cell('a', 'First'), cell('b', 'Second')], gated: [] }) };
  const preview = await flowCard(card.id, deps, true);
  expect(preview.placements.map(p => p.version)).toEqual(['0.2.31', '0.2.32']);
  expect(store.getCard(card.id)?.sections.some(s => s.key.startsWith('flow:'))).toBe(false);
  expect(listChecklist('0.2.31').items).toHaveLength(0);
  expect((await flowCard(card.id, deps)).placements).toHaveLength(2);
  expect(store.getCard(card.id)?.goalId).toBe('wish:one.md');
});

test('CLI exposes tick and read-only plan, decision ledger receives only the gated portion', async () => {
  setup();
  const cli = new Command(); registerFlowCommands(cli);
  const flow = cli.commands.find(c => c.name() === 'flow')!;
  expect(flow.commands.map(c => c.name())).toEqual(['tick', 'plan']);
  expect(flow.commands.find(c => c.name() === 'plan')?.options.some(o => o.long === '--dry-run')).toBe(true);
  const card = createWishCard({ text: 'Build preview. Charge payment.', source: 'tui', ref: 'real-ledger' }, store);
  const deps: FlowDeps = { store, placement, judge: judgeReply({ cells: [cell('a', 'Build preview')], gated: [{ title: 'Charge payment', text: 'Charge payment', category: 'money' }] }) };
  const cardLog = join(root, 'task-cards', `${card.cardId}.jsonl`);
  const before = readFileSync(cardLog, 'utf8');
  const preview = await flowCard(card.cardId, deps, true);
  expect(readFileSync(cardLog, 'utf8')).toBe(before);
  expect(preview.decisions).toEqual(['dry-run']);
  expect(new DecisionLedger({ stateDir: root }).list()).toHaveLength(0);
  const actual = await flowCard(card.cardId, deps);
  expect(new DecisionLedger({ stateDir: root }).list()).toMatchObject([{ id: actual.decisions[0], category: 'money' }]);
  expect(actual.placements).toHaveLength(1);
}, 30_000); // real DecisionLedger resolves the release version from repository history (~7s on a full clone)

test('a judge cell that contains a payment is never placed, while an unrelated cell still is', async () => {
  setup();
  const card = createWishCard({ text: 'Build UI. Charge payment.', source: 'tui', ref: 'unsafe-cell' }, store);
  const result = await flowCard(card.cardId, { store, placement,
    judge: judgeReply({ cells: [cell('a', 'Build UI'), cell('b', 'Charge payment')], gated: [{ title: 'Charge payment', text: 'Charge payment', category: 'money' }] }),
    raise: () => 'D-20261004-03' });
  expect(result.placements).toHaveLength(1);
  expect(result.decisions).toHaveLength(1);
  expect(listChecklist('0.2.31').items.map(c => c.title)).toEqual(['Build UI']);
});

test('a P1 cell without a deadline falls back to one P2 card cell', async () => {
  setup();
  const card = createWishCard({ text: 'Event launch page', source: 'tui', ref: 'p1-no-deadline' }, store);
  const result = await flowCard(card.cardId, { store, placement, judge: judgeReply({ cells: [{ ...cell('a', 'Event launch page'), priority: 'P1' }], gated: [] }) });
  expect(result.placements).toHaveLength(1);
  expect(store.getCard(card.cardId)?.sections.find(s => s.key === 'flow:split:0')?.content).toContain('"fallback":true');
  expect(listChecklist('0.2.31').items[0]?.priority).toBe('P2');
});

test('unplaced predecessor marks its dependent unplaced rather than aborting the card', async () => {
  setup();
  const card = createWishCard({ text: 'Backend then UI', source: 'tui', ref: 'unplaced-dependency' }, store);
  const result = await flowCard(card.cardId, { store, placement: { ...placement, seatCap: { TC: 0, MK: 1 } },
    judge: judgeReply({ cells: [cell('a', 'Backend'), { ...cell('b', 'UI', ['a']), owner: 'MK' }], gated: [] }) });
  expect(result.placements).toHaveLength(0);
  expect(result.unplaced).toHaveLength(2);
  expect(result.unplaced[1]?.reason).toContain('선행 칸');
});

test('one unplaceable cell records its failure without blocking other cells', async () => {
  setup();
  const card = createWishCard({ text: 'Two parts', source: 'tui', ref: 'blocked' }, store);
  const result = await flowCard(card.cardId, { store, placement: { ...placement, seatCap: { TC: 0, MK: 1 } },
    judge: judgeReply({ cells: [cell('a', 'TC blocked'), { ...cell('b', 'MK allowed'), owner: 'MK' }], gated: [] }) });
  expect(result.unplaced).toHaveLength(1);
  expect(result.placements).toHaveLength(1);
  expect(store.getCard(card.cardId)?.sections.find(s => s.key === `flow:placed:${result.unplaced[0]!.id}`)?.content).toContain('배치할 판이 없다');
});
