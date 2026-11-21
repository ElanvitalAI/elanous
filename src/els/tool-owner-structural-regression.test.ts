import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { elsToolSocketPath, startElsServer } from './server.js';

// The real Unix tool door is the boundary under test; seatLookup substitutes only
// OS ancestry, which cannot be arranged deterministically by a unit test.
async function fixture(run: (f: { ask: (r: object) => Promise<{exitCode: number; message: string}>; own: string; foreign: string; ownTab: string; foreignTab: string; setTabLabel: (id: string, name: string) => void }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'eo-'));
  const previous = process.env.ELANOUS_ELS_OWNER_TOKEN;
  const started = await startElsServer({ stateRoot: root, stall: false, seatLookup: () => ({ pane: 'caller', seat: 'OP' }), spawn: () => ({ id: `pty_${Math.random()}`, isAlive: () => true, write: () => {}, renderScreen: async () => 'private-screen', onExit: () => {}, kill: () => {} }) });
  if ('exitCode' in started) throw new Error(started.message);
  try {
    const make = async (seat: string, title: string) => {
      const r = await started.core.newPane({ ws: 'shared', cwd: '/tmp', command: ['sh'], title, ownerSeat: seat });
      if (r.exitCode !== 0) throw new Error(r.message);
      return JSON.parse(r.message) as { pane: string };
    };
    const own = (await make('OP', 'own')).pane;
    const foreign = (await make('OTHER', 'foreign')).pane;
    const rows = (JSON.parse(started.core.list().message) as { panes: { pane: string; tab: string }[] }).panes;
    const ownTab = rows.find(p => p.pane === own)!.tab;
    const foreignTab = rows.find(p => p.pane === foreign)!.tab;
    const ask = (r: object) => new Promise<{exitCode: number; message: string}>((resolve, reject) => {
      const socket = createConnection(elsToolSocketPath(root)); let data = '';
      socket.on('connect', () => socket.write(JSON.stringify(r) + '\n'));
      socket.on('data', chunk => { data += chunk.toString(); });
      socket.on('end', () => { try { resolve(JSON.parse(data.trim())); } catch (e) { reject(e); } });
      socket.on('error', reject);
    });
    await run({ ask, own, foreign, ownTab, foreignTab, setTabLabel: (id, name) => { if (started.core.rename({ kind: 'tab', id, name }).exitCode !== 0) throw new Error('fixture rename failed'); } });
  } finally {
    await started.close(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = previous;
  }
}

test('tool ls remains available and own read succeeds', () => fixture(async ({ ask, own }) => {
  expect((await ask({ op: 'ls' })).exitCode).toBe(0);
  expect((await ask({ op: 'read', pane: own })).exitCode).toBe(0);
}));

test('tool own snapshot and confirmed close remain usable', () => fixture(async ({ ask, own }) => {
  expect((await ask({ op: 'snapshot', pane: own })).exitCode).toBe(0);
  expect((await ask({ op: 'close', pane: own, confirmed: true })).exitCode).toBe(0);
}));

test('tool cannot close a workspace containing another seat', () => fixture(async ({ ask }) => {
  const before = (await ask({ op: 'ls' })).message;
  const result = await ask({ op: 'close-workspace', ws: 'shared', confirmed: true });
  const after = (await ask({ op: 'ls' })).message;
  expect({ exitCode: result.exitCode, after }).toEqual({ exitCode: 1, after: before });
}));

test('tool read must not expose another seat in the same workspace', () => fixture(async ({ ask, foreign }) => {
  const answer = await ask({ op: 'read', pane: foreign });
  expect(answer.exitCode).not.toBe(0);
  expect(answer.message).not.toContain('private-screen');
}));

test('tool snapshot must not capture another seat in the same workspace', () => fixture(async ({ ask, foreign }) => {
  expect((await ask({ op: 'snapshot', pane: foreign })).exitCode).not.toBe(0);
}));

test('tool can reorder its own tab to the end using existing aliases', () => fixture(async ({ ask, ownTab }) => {
  expect((await ask({ op: 'reorder', kind: 'tab', id: ownTab, before: '' })).exitCode).toBe(0);
  expect((await ask({ op: 'reorder', kind: 'tab', id: ownTab, before: 'end' })).exitCode).toBe(0);
}));

test('a tab label matching another tab ID cannot grant authority over that ID', () => fixture(async ({ ask, ownTab, foreignTab, setTabLabel }) => {
  setTabLabel(ownTab, foreignTab);
  const before = (await ask({ op: 'ls' })).message;
  const result = await ask({ op: 'reorder', kind: 'tab', id: foreignTab, before: ownTab });
  expect(result.exitCode).not.toBe(0);
  expect((await ask({ op: 'ls' })).message).toBe(before);
}));

test('tool reorder must not change another seat tab', () => fixture(async ({ ask, ownTab, foreignTab }) => {
  const before = (await ask({ op: 'ls' })).message;
  const result = await ask({ op: 'reorder', kind: 'tab', id: foreignTab, before: ownTab });
  const after = (await ask({ op: 'ls' })).message;
  expect({ exitCode: result.exitCode, after }).toEqual({ exitCode: 1, after: before });
}));

test('tool close must not close another seat pane', () => fixture(async ({ ask, foreign }) => {
  const before = (await ask({ op: 'ls' })).message;
  const result = await ask({ op: 'close', pane: foreign, confirmed: true });
  const after = (await ask({ op: 'ls' })).message;
  expect({ exitCode: result.exitCode, after }).toEqual({ exitCode: 1, after: before });
}));

test('tool rename must not rename another seat tab', () => fixture(async ({ ask, foreignTab }) => {
  const before = (await ask({ op: 'ls' })).message;
  const result = await ask({ op: 'rename', kind: 'tab', id: foreignTab, name: 'changed' });
  const after = (await ask({ op: 'ls' })).message;
  expect({ exitCode: result.exitCode, after }).toEqual({ exitCode: 1, after: before });
}));
