// Isolated synthetic evidence: real v2 runtime/card/body; no live ports or federation state.
import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCard } from './card.js';
import { fileAgentMemory } from './memory.js';
import { tickAgent } from './runtime.js';
import { createBody, type HandStewardDeps, type Hint } from './bodies/hand-steward.js';

test('synthetic supervisor run detects breach, respects policy and records timed pull handoff', async () => {
  const runId = `supervisor-handoff-${process.env.SIM_RUN_ID ?? 'local'}`;
  const root = mkdtempSync(join(tmpdir(), `${runId}-`));
  const now = new Date('2026-11-27T06:00:00.000Z');
  const card = loadCard('hand-steward', process.env.SIM_CARD_ROOT);
  const memory = fileAgentMemory(root, card.id, card.supervisor);
  memory.setLevel('live', 'SIM', 'isolated simulation', now);
  const hints: Record<string, Hint> = {};
  const mail: Array<{ key: string; to: string; body: string }> = [];
  const deps: HandStewardDeps = {
    readHands: () => [{ seat: 'SIM-HAND', state: 'idle', since: now.getTime() - 60_000 }],
    readCells: () => ({ version: 'sim', cells: [{ id: 'SIM-P0', title: 'synthetic task', status: 'yellow', priority: 'P0', paths: [] }] }),
    readHints: () => hints,
    hint: (cell, seat, _by, at) => { hints[cell] = { seat, until: new Date(at.getTime() + 45 * 60_000).toISOString() }; },
    unhint: cell => delete hints[cell],
    modelFor: () => ({ line: 'synthetic model', tier: 'sim' }),
    post: (key, to, body) => { mail.push({ key, to, body }); return mail.length; },
    wake: () => 'synthetic wake',
  };
  const ports = { memory, post: () => null, beat: () => {}, speak: () => {} };
  const body = createBody({ stateRoot: root, card }, deps);
  const first = await tickAgent(card, body, ports, now);
  expect(first.kpi).toBe(1);
  expect(first.kpiOk).toBe(false);
  expect(first.breach).toBe('new');
  expect(first.acted).toEqual(['assign:SIM-P0@SIM-HAND']);
  expect(mail).toHaveLength(1);
  expect(mail[0]!.to).toBe('SIM-HAND');
  expect(mail[0]!.body).toContain('기한 2026-11-27T06:30:00.000Z');
  expect(mail[0]!.body).toContain('담당 SIM-HAND');
  const second = await tickAgent(card, body, ports, new Date(now.getTime() + 60_000));
  expect(second.kpi).toBe(0);
  expect(second.acted).toEqual([]);
  expect(mail).toHaveLength(1);
  const rows = memory.cases(100);
  expect(rows.some(row => row.kind === 'tick' && row.why.includes('idle_hands_with_ready_cells 1'))).toBe(true);
  // The same event must not assign when the configured rights deny the action.
  delete hints['SIM-P0'];
  const deniedCard = { ...card, rights: { ...card.rights, actions: [] } };
  const deniedMemory = fileAgentMemory(mkdtempSync(join(tmpdir(), `${runId}-deny-`)), card.id, card.supervisor);
  deniedMemory.setLevel('live', 'SIM', 'isolated policy test', now);
  const denied = await tickAgent(deniedCard, body, { ...ports, memory: deniedMemory }, now);
  expect(denied.kpiOk).toBe(false);
  expect(denied.acted).toEqual([]);
  expect(mail).toHaveLength(1);
  expect(deniedMemory.cases(100).some(row => row.kind === 'planned' && row.subject === 'assign:SIM-P0@SIM-HAND')).toBe(true);
  console.log(JSON.stringify({ runId, synthetic: true, events: ['idle-hand', 'ready-cell'], goal: card.goal, kpi: [first.kpi, second.kpi], action: first.acted, handoff: mail[0], policy: { maxPerTick: card.rights.maxPerTick, actions: card.rights.actions, deniedAction: denied.acted }, cases: rows }));
});
