import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { elsToolSocketPath, startElsServer } from './server.js';

// The real Unix tool door is the boundary under test; seatLookup substitutes only
// OS ancestry, which cannot be arranged deterministically by a unit test.
async function fixture(run: (f: { ask: (r: object) => Promise<{exitCode: number; message: string}>; own: string; foreign: string; ownTab: string; foreignTab: string; setTabLabel: (id: string, name: string) => void; root: string; writes: string[] }) => Promise<void>, seat = 'OP') {
  const root = mkdtempSync(join(tmpdir(), 'eo-'));
  const previous = process.env.ELANOUS_ELS_OWNER_TOKEN;
  const writes: string[] = [];
  const started = await startElsServer({ stateRoot: root, stall: false, seatLookup: () => ({ pane: 'caller', seat }), spawn: () => ({ id: `pty_${Math.random()}`, isAlive: () => true, write: (v: string) => { writes.push(v); }, renderScreen: async () => 'private-screen', onExit: () => {}, kill: () => {} }) });
  if ('exitCode' in started) throw new Error(started.message);
  try {
    const make = async (seat: string, title: string) => {
      const r = await started.core.newPane({ ws: 'shared', cwd: '/tmp', command: ['sh'], title, ownerSeat: seat });
      if (r.exitCode !== 0) throw new Error(r.message);
      return JSON.parse(r.message) as { pane: string };
    };
    const own = (await make(seat, 'own')).pane;
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
    await run({ ask, own, foreign, ownTab, foreignTab, setTabLabel: (id, name) => { if (started.core.rename({ kind: 'tab', id, name }).exitCode !== 0) throw new Error('fixture rename failed'); }, root, writes });
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

test('a hand seat tool read must not expose another seat in the same workspace', () => fixture(async ({ ask, own, foreign }) => {
  expect((await ask({ op: 'read', pane: own })).exitCode).toBe(0);
  const answer = await ask({ op: 'read', pane: foreign });
  expect(answer.exitCode).toBe(1);
  expect(answer.message).not.toContain('private-screen');
  expect((await ask({ op: 'status', pane: foreign })).exitCode).toBe(1);
}, 'HAND-A'));

// CEO 11-23 (ELS-ELN-SECURITY-RELAX): the OP seat observes every pane — read and status of another seat's pane succeed.
test('OP seat tool read and status reach another seat pane', () => fixture(async ({ ask, foreign }) => {
  const answer = await ask({ op: 'read', pane: foreign });
  expect(answer.exitCode).toBe(0);
  expect(answer.message).toContain('private-screen');
  expect((await ask({ op: 'status', pane: foreign })).exitCode).toBe(0);
}));

test('OP seat read relaxation: snapshot is observe (COORD-RIGHTS 11-27); close and interrupt on a non-federation pane stay refused', () => fixture(async ({ ask, foreign, writes }) => {
  expect((await ask({ op: 'snapshot', pane: foreign })).exitCode).toBe(0);
  expect((await ask({ op: 'close', pane: foreign, confirmed: true })).exitCode).toBe(1);
  expect((await ask({ op: 'interrupt', pane: foreign })).exitCode).not.toBe(0);
  expect(writes).toEqual([]);
}));

// ELS-OP-CROSS-SPACE-SEND (CEO 11-23): the OP coordinator types a line into another seat's pane; the door audits it.
const allowToolDo = (root: string) => writeFileSync(join(root, 'els', 'control-allow.json'), JSON.stringify({ rules: [{ principal: 'eln:tool', workspace: '*', pane: '*', actions: ['do'] }] }));
const auditRows = (root: string) => readFileSync(join(root, 'els', 'control-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { pane?: string; result?: string; seat?: string });

test('OP seat tool sends a line into another seat pane and the door audits it', () => fixture(async ({ ask, foreign, root, writes }) => {
  allowToolDo(root);
  const sent = await ask({ op: 'input-line', pane: foreign, text: 'pwd', from: 'test' });
  expect(sent.exitCode).toBe(0);
  expect(writes).toEqual(['pwd\r']);
  const rows = auditRows(root).filter(row => row.pane === foreign && row.seat === 'OP');
  expect(rows.map(row => row.result)).toContain('executing');
  // `do` passes the same door (accepted, exit 0); its write goes through the pane queue, not synchronously.
  expect((await ask({ op: 'do', pane: foreign, text: 'ls', from: 'test' })).exitCode).toBe(0);
}));

test('a hand seat tool still cannot send a line into another seat pane', () => fixture(async ({ ask, foreign, root, writes }) => {
  allowToolDo(root);
  expect((await ask({ op: 'input-line', pane: foreign, text: 'pwd', from: 'test' })).exitCode).toBe(1);
  expect((await ask({ op: 'do', pane: foreign, text: 'pwd', from: 'test' })).exitCode).toBe(1);
  expect(writes).toEqual([]);
}, 'HAND-A'));

test('COORD-RIGHTS: a hand tool still cannot snapshot another seat in the same workspace', () => fixture(async ({ ask, foreign }) => {
  expect((await ask({ op: 'snapshot', pane: foreign })).exitCode).not.toBe(0);
}, 'HAND-A'));

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
