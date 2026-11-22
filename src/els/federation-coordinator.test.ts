// In-memory origin and injected transport: exercises the real HTTP router and federation, not a network/server restart.
import { expect, test } from 'bun:test';
import { parseRemoteRows } from './attach-view.js';
import { createElsCore, type ElsPty } from './core.js';
import { createFederation } from './federation.js';
import { routeElsHttp } from './http.js';
import { emptyJournal, type SpaceJournal } from './space.js';

function origin() {
  let journal: SpaceJournal = emptyJournal();
  let sequence = 0;
  const core = createElsCore({ load: () => journal, save: (next) => { journal = next; }, mailBadges: () => new Map(),
    spawn: () => ({ id: `pty_${++sequence}`, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {} } as ElsPty) });
  core.start();
  for (const ws of ['alpha', 'OP', 'beta']) expect(core.newPane({ ws, cwd: '/work', command: ['sh'] }).exitCode).toBe(0);
  return core;
}

function federation(core: ReturnType<typeof origin>, alter: (body: any) => unknown = (body) => body) {
  return createFederation({ localHost: 'local', askLocal: async () => ({ exitCode: 0, message: JSON.stringify({ workspaces: [], tabs: [], panes: [] }) }),
    registry: { hosts: [{ name: 'remote', baseUrl: 'http://127.0.0.1:8790' }], rejected: [] },
    fetchJson: async (_host, path) => { const answer = await routeElsHttp(core, 'remote', 'GET', path); return { status: answer.status, body: alter(JSON.parse(answer.body)) }; } });
}

test('origin role passes through HTTP and federation to remote attach, including default OP and reassignment', async () => {
  const core = origin();
  const fed = federation(core);
  const check = async (expected: string) => {
    const originList = JSON.parse(core.list().message);
    const id = originList.workspaces.find((ws: { name: string }) => ws.name === expected).id;
    const http = JSON.parse((await routeElsHttp(core, 'remote', 'GET', '/els/ls')).body);
    expect(http.panes.filter((p: { role?: string }) => p.role === 'coordinator').map((p: { ws: string }) => p.ws)).toEqual([id]);
    const listed = JSON.parse((await fed.list()).message);
    expect(listed.panes[0].ws).toBe(id);
    expect(listed.panes.filter((p: { role?: string }) => p.role === 'coordinator').map((p: { ws: string }) => p.ws)).toEqual([id]);
    const rows = parseRemoteRows(JSON.stringify(listed));
    expect(rows[0]!.wsId).toBe(`remote:${id}`);
    expect(rows.filter((p) => p.role === 'coordinator')).toHaveLength(1);
  };
  await check('OP');
  expect(core.setCoordinator('beta').exitCode).toBe(0);
  await check('beta');
  expect(core.setCoordinator('alpha').exitCode).toBe(0);
  await check('alpha');
});

test('legacy and unrecognized remote roles do not create coordinators or mark hosts down', async () => {
  const core = origin();
  for (const role of [undefined, 'admin', null, 42]) {
    const fed = federation(core, (body) => ({ ...body, panes: body.panes.map((p: object) => ({ ...p, role })) }));
    const listed = JSON.parse((await fed.list()).message);
    expect(listed.hosts[1].reach).toBe('up');
    expect(listed.panes).toHaveLength(3);
    expect(listed.panes.every((p: object) => !('role' in p))).toBe(true);
    expect(parseRemoteRows(JSON.stringify(listed)).every((p) => p.role === undefined)).toBe(true);
  }
});
