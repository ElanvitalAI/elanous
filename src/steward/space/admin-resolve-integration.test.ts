// Isolated integration: real tick ledger + file-backed fake checklist, no live sources/effects.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFederationLadder } from '../../msg/hand-raise-ladder.js';
import { ledgerPath, runStewardSpaceNode, STEWARD_SPACE_NODES, type TickDeps, type StewardMail } from './tick.js';

const now = Date.parse('2026-11-27T07:43:00Z');
test('real tick ledger assigns once and wakes holder without giving it another WIP', () => {
  const root = mkdtempSync(join(tmpdir(), 'admin-resolve-integration-'));
  const board = join(root, 'fake-checklist.json');
  const initial = [
    { id: 'OWN-1', title: 'existing', status: 'yellow', owner: 'TC-H1', priority: 'P1', updatedAt: new Date(now-30*60000).toISOString() },
    { id: 'READY-1', title: 'ready', status: 'yellow', owner: 'TC', priority: 'P1', updatedAt: new Date(now-40*60000).toISOString() },
    { id: 'READY-2', title: 'ready 2', status: 'yellow', owner: 'TC', priority: 'P1', updatedAt: new Date(now-40*60000).toISOString() },
  ];
  writeFileSync(board, JSON.stringify(initial));
  const read = (): typeof initial => JSON.parse(readFileSync(board, 'utf8'));
  const calls: string[] = []; const mails: StewardMail[] = [];
  const deps: TickDeps = {
    root, now: () => new Date(now), config: { scopes: { TC: { mode: 'live', caps: { assign: 20 } } } },
    sources: () => ({
      panes: () => ({ panes: [
        { seat: 'TC', activityState: 'working', lastEventAtMs: now },
        { seat: 'TC-H1', activityState: 'idle', lastEventAtMs: now-20*60000 },
        { seat: 'TC-H2', activityState: 'idle', lastEventAtMs: now-20*60000 },
      ] }),
      checklist: () => ({ version: '0.3.38', items: read() }),
      ladder: () => buildFederationLadder({ hq: 'OP', spaces: [{ coordinator: 'TC', seats: ['TC-H1', 'TC-H2'] }] }),
      prs: () => [], merged: () => [], receipts: () => [], verdicts: () => [],
      util: () => ({ hosts: [], ageMs: 0 }), openHands: () => [],
    }),
    effects: {
      mail: (m) => { mails.push(m); },
      assignCell: (a) => {
        const cells = read(); const cell = cells.find((c) => c.id === a.cellId);
        if (!cell) return { ok: false, error: 'unknown-cell' };
        calls.push(`${a.cellId}:${a.seat}`); cell.owner = a.seat;
        writeFileSync(board, JSON.stringify(cells)); return { ok: true, via: 'fake-file' };
      },
      releaseCell: () => ({ ok: false, error: 'not expected' }),
      dispatchPregate: () => ({ ok: false, error: 'not expected' }),
    },
  };
  for (const runId of ['first', 'second']) for (const node of STEWARD_SPACE_NODES) {
    expect(runStewardSpaceNode(node, { runId, scope: 'TC' }, deps).outcome).toBe('ok');
  }
  const cells = read();
  expect(cells.filter((c) => c.owner === 'TC-H1').map((c) => c.id)).toEqual(['OWN-1']);
  expect(cells.filter((c) => c.owner === 'TC-H2')).toHaveLength(1);
  expect(calls.filter((c) => c.endsWith(':TC-H2'))).toHaveLength(1);
  expect(calls).toContain('OWN-1:TC-H1');
  const rows = readFileSync(ledgerPath(root, 'TC'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(rows.filter((r) => r.action === 'assign' && r.done)).toHaveLength(1);
  expect(mails.filter((m) => m.kind === 'steward-exception')).toHaveLength(0);

  // A writer conflict cannot be assigned: it must be handed to a named owner with a deadline and next step.
  writeFileSync(board, JSON.stringify(initial));
  deps.effects.assignCell = (a) => a.cellId === 'OWN-1'
    ? { ok: true, via: 'fake-file' }
    : { ok: false, error: 'live-writer:#301 writes src/a.ts' };
  const conflictDeps: TickDeps = { ...deps, root: mkdtempSync(join(tmpdir(), 'admin-resolve-conflict-')) };
  for (const node of STEWARD_SPACE_NODES) expect(runStewardSpaceNode(node, { runId: 'conflict', scope: 'TC' }, conflictDeps).outcome).toBe('ok');
  const card = mails.find((m) => m.kind === 'steward-exception');
  expect(card?.to).toBe('TC');
  expect(card?.body).toContain('live-writer');
  expect(card?.body).toContain('담당: TC');
  expect(card?.body).toContain('기한: 2026-11-27T08:13:00.000Z');
  expect(card?.body).toContain('다음 행동:');
  expect(read().find((c) => c.id === 'READY-1')?.owner).toBe('TC');
});
