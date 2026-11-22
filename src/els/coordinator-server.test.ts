import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { authorizeRequest, isMutating, type ServerRole } from './server-auth.js';
import { elsSocketPath, elsToolSocketPath, startElsServer } from './server.js';

const op: ServerRole = { kind: 'op', pane: 'op-pane' };
const peer: ServerRole = { kind: 'peer', pid: 1, uid: 1, pane: 'p', seat: 'OP' };
const hand: ServerRole = { kind: 'hand', pane: 'p', seat: 'HAND', workspaces: ['w'] };

test('coordinator mutations require OP, regardless of workspace or allow-list', () => {
  for (const request of [{ op: 'coordinator', ws: 'w' }]) {
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

test('socket dispatch assigns and reassigns, audits success and denial, and refuses malformed and tool requests', async () => {
  const root = mkdtempSync('/tmp/els-coord-server-');
  const previous = process.env.ELANOUS_ELS_OWNER_TOKEN;
  const server = await startElsServer({ stateRoot: root, stall: false, seatLookup: () => undefined,
    spawn: () => ({ id: 'fake', isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} }) });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const path = elsSocketPath(root);
    const token = process.env.ELANOUS_ELS_OWNER_TOKEN!;
    const made = await server.core.newPane({ ws: 'target', cwd: root, command: ['sh'] });
    expect(made.exitCode).toBe(0);
    expect((await server.core.newPane({ ws: 'OP', cwd: root, command: ['sh'] })).exitCode).toBe(0);
    const opId = JSON.parse(server.core.list().message).workspaces.find((w: { name: string }) => w.name === 'OP').id;
    expect((await request(path, { op: 'coordinator', ws: 'target' })).exitCode).toBe(1);
    expect((await request(path, { op: 'seat-set', seat: 'OP' }, token)).exitCode).toBe(0);
    // The old separate append path is unwritable: state and audit must still commit together.
    mkdirSync(join(root, 'els', 'coordinator-audit.jsonl'));
    expect((await request(path, { op: 'coordinator', ws: 'target' }, token)).exitCode).toBe(0);
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
