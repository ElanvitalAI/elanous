import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { authorizeRequest, coordinatorTabScope, isMutating, type ServerRole } from './server-auth.js';
import { elsSocketPath, elsToolSocketPath, startElsServer } from './server.js';
import { processIdentity } from './peer-seat.js';

const op: ServerRole = { kind: 'op', pane: 'op-pane' };
const peer: ServerRole = { kind: 'peer', pid: 1, uid: 1, pane: 'p', seat: 'OP' };
const hand: ServerRole = { kind: 'hand', pane: 'p', seat: 'HAND', workspaces: ['w'] };

test('coordinator mutations require OP, regardless of workspace or allow-list', () => {
  for (const request of [{ op: 'coordinator', ws: 'w' }, { op: 'coordinator', ws: 'w', seat: 'LEAD' }, { op: 'hq-coordinator', seat: 'LEAD' }]) {
    expect(isMutating(request)).toBe(true);
    expect(authorizeRequest(op, request, 'w', []).allow).toBe(true);
    expect(authorizeRequest(peer, request, 'w', []).allow).toBe(true);
    for (const role of [hand, { ...peer, seat: 'RES-INFRA' } as ServerRole,
      { kind: 'owner', note: 'not registered' } as ServerRole,
      { kind: 'outsider', note: 'no credential' } as ServerRole]) {
      expect(authorizeRequest(role, request, 'w', []).allow).toBe(false);
    }
  }
});

test('verified coordinator tab authority is bounded by the server assignment', () => {
  const journal = { workspaces: [{ id: 'w1', name: 'alpha', coordinatorSeat: 'HAND' }, { id: 'w2', name: 'beta', coordinatorSeat: 'OTHER' }],
    tabs: [{ id: 'a', workspaceId: 'w1' }, { id: 'a2', workspaceId: 'w1' }, { id: 'b', workspaceId: 'w2' }] };
  for (const ws of ['w1', 'alpha']) expect(coordinatorTabScope(hand, { op: 'new', ws }, journal)?.allow).toBe(true);
  for (const ws of ['w2', 'beta', 'missing']) expect(coordinatorTabScope(hand, { op: 'new', ws }, journal)?.allow).toBe(false);
  // Core resolves the first name-or-id match, not the coordinator's preferred match.
  const collision = { ...journal, workspaces: [{ id: 'other', name: 'w1', coordinatorSeat: 'OTHER' }, ...journal.workspaces] };
  expect(coordinatorTabScope(hand, { op: 'new', ws: 'w1' }, collision)?.allow).toBe(false);
  expect(coordinatorTabScope(hand, { op: 'new', ws: 'alpha' }, collision)?.allow).toBe(true);
  expect(coordinatorTabScope(hand, { op: 'reorder', kind: 'tab', id: 'a', before: 'a2' }, journal)?.allow).toBe(true);
  for (const [id, before] of [['a', 'b'], ['b', 'a'], ['missing', 'a'], ['a', 'missing']])
    expect(coordinatorTabScope(hand, { op: 'reorder', kind: 'tab', id, before }, journal)?.allow).toBe(false);
  expect(coordinatorTabScope({ kind: 'outsider', note: 'claimed HAND' }, { op: 'new', ws: 'alpha' }, journal)).toBeUndefined();
  expect(coordinatorTabScope({ ...hand, seat: 'OTHER-SEAT' }, { op: 'new', ws: 'alpha' }, journal)).toBeUndefined();
  expect(coordinatorTabScope(hand, { op: 'new', ws: 'alpha' }, { ...journal, workspaces: [...journal.workspaces, { id: 'w3', name: 'gamma', coordinatorSeat: 'HAND' }] })?.allow).toBe(false);
});

async function request(path: string, body: object, token?: string): Promise<{ exitCode: number; message: string }> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path); let data = '';
    socket.on('connect', () => {
      if (token) socket.write(JSON.stringify({ op: 'auth', token }) + '\n');
      socket.write(JSON.stringify(body) + '\n');
    });
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.on('end', () => { try { resolve(JSON.parse(data.trim().split('\n').at(-1)!)); } catch (error) { reject(error); } });
    socket.on('error', reject);
  });
}

test.skipIf(process.platform !== 'darwin')('coordinator socket creates and arranges only within its assigned space', async () => {
  if (!process.env.ELS_COORD_SCOPE_PRIVATE_TTY) {
    const child = Bun.spawn(['/usr/bin/script', '-q', '/dev/null', process.execPath, 'test', import.meta.path, '-t', 'coordinator socket creates'],
      { env: { ...process.env, ELS_COORD_SCOPE_PRIVATE_TTY: '1', NO_COLOR: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: out + err }).toMatchObject({ code: 0, output: expect.stringContaining('1 pass') });
    return;
  }
  const root = mkdtempSync('/tmp/els-coord-scope-');
  const previous = process.env.ELANOUS_ELS_OWNER_TOKEN;
  const identity = processIdentity(process.pid);
  if (!identity) throw new Error('no process identity');
  const tokens: string[] = [];
  const server = await startElsServer({ stateRoot: root, stall: false, mailWake: false, seatLookup: () => undefined,
    spawn: (_c, _d, _t, env) => {
      tokens.push(env.ELANOUS_ELS_PANE_TOKEN!);
      return { id: `pty-${tokens.length}`, ...(tokens.length === 1 ? { pid: process.pid, processBinding: { pid: process.pid, start: identity.start, generation: 'coord-scope' } } : {}), isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} };
    } });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    server.core.newPane({ ws: 'Alpha', cwd: '/tmp/seats/LEAD', command: ['sh'], parent: { kind: 'hand', seat: 'LEAD', workspaces: ['Alpha'] } });
    server.core.newPane({ ws: 'Alpha', cwd: '/tmp/seats/OTHER', command: ['sh'] });
    server.core.newPane({ ws: 'Beta', cwd: '/tmp', command: ['sh'] });
    expect(server.core.setSpaceCoordinator('Alpha', 'LEAD').exitCode).toBe(0);
    const list = () => JSON.parse(server.core.list().message) as { workspaces: { id: string; name: string }[]; tabs: { id: string; workspaceId: string }[] };
    const initial = list();
    const alpha = initial.workspaces.find(w => w.name === 'Alpha')!.id;
    const beta = initial.workspaces.find(w => w.name === 'Beta')!.id;
    const [a, a2] = initial.tabs.filter(t => t.workspaceId === alpha);
    const b = initial.tabs.find(t => t.workspaceId === beta)!;
    const ask = (body: object) => request(elsSocketPath(root), body, tokens[0]);
    expect((await ask({ op: 'new', ws: alpha, cwd: root, command: ['sh'] })).exitCode).toBe(0);
    const before = list().tabs.length;
    expect((await ask({ op: 'new', ws: 'Beta', cwd: root, command: ['sh'], seat: 'LEAD' })).exitCode).toBe(1);
    expect((await ask({ op: 'new', ws: 'missing', cwd: root, command: ['sh'] })).exitCode).toBe(1);
    expect(list().tabs.length).toBe(before);
    expect((await ask({ op: 'reorder', kind: 'tab', id: a2!.id, before: a!.id })).exitCode).toBe(0);
    expect((await ask({ op: 'reorder', kind: 'tab', id: b.id, before: a!.id })).exitCode).toBe(1);
    expect((await ask({ op: 'reorder', kind: 'tab', id: a!.id, before: b.id })).exitCode).toBe(1);
    expect((await ask({ op: 'move-tab', tab: a!.id, ws: 'Beta' })).exitCode).toBe(1);
    expect((await request(elsToolSocketPath(root), { op: 'new', ws: 'Alpha', cwd: root, command: ['sh'] }, tokens[0])).exitCode).toBe(1);
    expect(server.core.setSpaceCoordinator('Alpha', 'OTHER').exitCode).toBe(0);
    expect((await ask({ op: 'reorder', kind: 'tab', id: a2!.id, before: a!.id })).exitCode).toBe(1);
  } finally {
    await server.close(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = previous;
  }
}, 60000);

test('socket dispatch assigns and reassigns, audits success and denial, and refuses malformed and tool requests', async () => {
  const root = mkdtempSync('/tmp/els-coord-server-');
  const previous = process.env.ELANOUS_ELS_OWNER_TOKEN;
  const server = await startElsServer({ stateRoot: root, stall: false, seatLookup: () => undefined,
    spawn: () => ({ id: 'fake', isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} }) });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const path = elsSocketPath(root);
    const token = process.env.ELANOUS_ELS_OWNER_TOKEN!;
    const made = await server.core.newPane({ ws: 'target', cwd: join(root, 'seats', 'LEAD'), command: ['sh'] });
    expect(made.exitCode).toBe(0);
    expect((await server.core.newPane({ ws: 'OP', cwd: root, command: ['sh'] })).exitCode).toBe(0);
    const opId = JSON.parse(server.core.list().message).workspaces.find((w: { name: string }) => w.name === 'OP').id;
    expect((await request(path, { op: 'coordinator', ws: 'target' })).exitCode).toBe(1);
    expect((await request(path, { op: 'hq-coordinator', seat: 'LEAD' })).exitCode).toBe(1);
    expect((await request(path, { op: 'seat-set', seat: 'OP' }, token)).exitCode).toBe(0);
    expect((await request(path, { op: 'hq-coordinator', seat: 42 }, token)).exitCode).toBe(2);
    expect((await request(path, { op: 'hq-coordinator', seat: 'LEAD' }, token)).exitCode).toBe(0);
    const secondHq = await request(path, { op: 'hq-coordinator', seat: 'OTHER' }, token);
    expect(secondHq.exitCode).toBe(1);
    expect(secondHq.message).toContain('already assigned');
    expect(JSON.parse(server.core.list().message).hqCoordinatorSeat).toBe('LEAD');
    // The old separate append path is unwritable: state and audit must still commit together.
    mkdirSync(join(root, 'els', 'coordinator-audit.jsonl'));
    expect((await request(path, { op: 'coordinator', ws: 'target' }, token)).exitCode).toBe(0);
    expect((await request(path, { op: 'coordinator', ws: 'target', seat: 'LEAD' }, token)).exitCode).toBe(0);
    expect(JSON.parse(server.core.list().message).workspaces.find((w: { name: string }) => w.name === 'target').coordinatorSeat).toBe('LEAD');
    expect((await request(path, { op: 'coordinator', ws: 'target', seat: 42 }, token)).exitCode).toBe(2);
    expect(JSON.parse(server.core.list().message).workspaces.find((w: { name: string }) => w.name === 'target').role).toBe('coordinator');
    expect((await request(path, { op: 'coordinator' }, token)).exitCode).toBe(2);
    expect((await request(path, { op: 'coordinator-unset' }, token)).exitCode).not.toBe(0);
    expect(JSON.parse(server.core.list().message).workspaces.find((w: { name: string }) => w.name === 'target').role).toBe('coordinator');
    expect((await request(elsToolSocketPath(root), { op: 'coordinator', ws: 'target' }, token)).exitCode).toBe(1);
    expect(JSON.parse(server.core.list().message).workspaces.find((w: { name: string }) => w.name === 'target').role).toBe('coordinator');
    expect((await request(path, { op: 'coordinator', ws: 'OP' }, token)).exitCode).toBe(0);
    expect(JSON.parse(server.core.list().message).workspaces.find((w: { name: string }) => w.name === 'OP').role).toBe('coordinator');
    const journal = JSON.parse(readFileSync(join(root, 'els', 'journal.json'), 'utf8'));
    expect(journal.coordinatorAudit.map((row: { op: string }) => row.op)).toEqual(['coordinator', 'coordinator']);
    expect(journal.coordinatorAudit[0].result).toContain(`${opId} ->`);
    const denied = readFileSync(join(root, 'els', 'control-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(denied.some(row => row.action === 'coordinator' && row.result === 'denied')).toBe(true);
  } finally {
    await server.close(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = previous;
  }
});
