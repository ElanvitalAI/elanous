// Independent socket regression probe: production client, production socket door and server-minted
// fixture registry; Unix peer credentials are real. No product server or live credentials involved.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { requestEls } from './client.js';
import { serveConnection } from './server.js';
import { PaneRegistry, authorizeRequest, isServerOwnerRole } from './server-auth.js';

test('server-minted OP pane may attempt only runtime-backed OP registration', () => {
  const registry = new PaneRegistry();
  const op = registry.registerSpawn({ ELANOUS_ELS_PANE: 'op', ELANOUS_ELS_WS: 'w' }, '/tmp', { kind: 'op' });
  const hand = registry.registerSpawn({ ELANOUS_ELS_PANE: 'hand', ELANOUS_ELS_WS: 'w' }, '/tmp', { kind: 'hand', seat: 'HAND-X', workspaces: ['w'] });
  const runtime = { pid: 123, start: '123:1' };
  expect(authorizeRequest(registry.classify({ token: op.ELANOUS_ELS_PANE_TOKEN }), { op: 'seat-set', seat: 'OP', runtime }, undefined, undefined).allow).toBe(true);
  expect(authorizeRequest(registry.classify({ token: op.ELANOUS_ELS_PANE_TOKEN }), { op: 'seat-set', seat: 'OP' }, undefined, undefined).allow).toBe(false);
  expect(authorizeRequest(registry.classify({ token: hand.ELANOUS_ELS_PANE_TOKEN }), { op: 'seat-set', seat: 'OP', runtime }, undefined, undefined).allow).toBe(false);
});

test('pane credential wins over owner; owner-only seat registration stays fail-closed', async () => {
  const root = mkdtempSync('/tmp/seat-probe-');
  const socket = join(root, 's');
  const registry = new PaneRegistry();
  const owner = registry.registerOwner();
  const op = registry.registerSpawn({ ELANOUS_ELS_PANE: 'op-fixture', ELANOUS_ELS_WS: 'w' }, root, { kind: 'op' });
  const hand = registry.registerSpawn({ ELANOUS_ELS_PANE: 'server-owner', ELANOUS_ELS_WS: 'w' }, root, { kind: 'hand', seat: 'HAND-X', workspaces: ['w'] });
  expect(isServerOwnerRole(registry.classify({ token: owner.token }))).toBe(true);
  expect(isServerOwnerRole(registry.classify({ token: hand.ELANOUS_ELS_PANE_TOKEN }))).toBe(false);
  let mutations = 0;
  const guard = {
    classify: (claim: { token?: unknown }) => registry.classify(claim),
    authorize: (role: any, request: any) => authorizeRequest(role, request, undefined, undefined),
    audit: () => {},
    seatSet: (request: { seat: string }) => { mutations++; return registry.registerSeat(request.seat) ? { exitCode: 0 as const, message: 'registered' } : { exitCode: 1 as const, message: 'unsupported' }; },
  };
  const server = createServer(peer => serveConnection(Promise.resolve({ shellPids: () => [] } as never), peer, root, () => undefined, { current: guard } as never, root));
  const keys = ['ELANOUS_ELS_PANE_TOKEN', 'ELANOUS_ELS_OWNER_TOKEN', 'ELANOUS_ELS_RUNTIME_TOKEN_FILE', 'ELN_SEAT_RUNTIME'] as const;
  const saved = keys.map(k => process.env[k]);
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    for (const k of keys) delete process.env[k];
    process.env.ELANOUS_ELS_OWNER_TOKEN = owner.token;
    expect((await requestEls(socket, { op: 'seat-set', seat: 'OP' })).exitCode).toBe(0);
    expect(mutations).toBe(1);
    process.env.ELANOUS_ELS_PANE_TOKEN = op.ELANOUS_ELS_PANE_TOKEN;
    const denied = await requestEls(socket, { op: 'seat-set', seat: 'OP', runtime: { pid: 123, start: '123:1' } });
    expect(denied.exitCode).toBe(1);
    // Passing the pane door is not registration: without a runtime registry it must fail closed.
    expect(mutations).toBe(1);
    process.env.ELANOUS_ELS_PANE_TOKEN = hand.ELANOUS_ELS_PANE_TOKEN;
    expect((await requestEls(socket, { op: 'seat-set', seat: 'OP' })).exitCode).toBe(1);
    delete process.env.ELANOUS_ELS_OWNER_TOKEN;
    delete process.env.ELANOUS_ELS_PANE_TOKEN;
    expect((await requestEls(socket, { op: 'seat-set', seat: 'OP' })).exitCode).toBe(1);
    expect(mutations).toBe(1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000); // Socket test timeout; no performance assertion.
