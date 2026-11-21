import { expect, test } from 'bun:test';
import { createConnection, createServer } from 'node:net';
import { serveConnection } from './server.js';
import { elsJournalPath, saveJournal } from './journal.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerSeatRuntime, startElsServer, elsSocketPath } from './server.js';
import { requestEls } from './client.js';
import { SeatRuntimeRegistry, type RuntimeProcess } from './seat-runtime.js';

test('failed runtime registration cannot register OP or report success', () => {
  let seatMutated = false;
  const guard = { seatSet: () => { seatMutated = true; return { exitCode: 0 as const, message: 'registered' }; } };
  const registry = { register: () => false, registrationToken: () => undefined, clear: () => {} };
  const result = registerSeatRuntime({ op: 'seat-set', seat: 'OP', runtime: { pid: 200, start: '200:1' } }, guard, registry, undefined, undefined, undefined, () => {});
  expect(result.exitCode).not.toBe(0);
  expect(seatMutated).toBe(false);
});

test.skipIf(process.platform !== 'darwin')('owner registration is not rejected merely because its peer also resolves to OP', async () => {
  const root = mkdtempSync('/tmp/els-reg-owner-');
  const previous = process.env.ELANOUS_ELS_OWNER_TOKEN;
  const server = await startElsServer({ stateRoot: root, stall: false, seatLookup: () => ({ pane: 'op-pane', seat: 'OP' }) });
  if ('exitCode' in server) throw new Error(server.message);
  try {
    const result = await requestEls(elsSocketPath(root), { op: 'seat-set', seat: 'OP' });
    // Runtime verification may fail under a short-lived test runner, but the owner must
    // reach it rather than being rejected as a peer before registration is attempted.
    expect(result.message).not.toContain('only the server owner may register');
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.ELANOUS_ELS_OWNER_TOKEN; else process.env.ELANOUS_ELS_OWNER_TOKEN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed replacement publication preserves the previous live registration', () => {
  const runtime: RuntimeProcess = { pid: 200, ppid: 1, uid: 501, start: '200:1', name: 'codex' };
  const peer: RuntimeProcess = { pid: 400, ppid: 200, uid: 501, start: '400:1', name: 'els' };
  const registry = new SeatRuntimeRegistry(pid => pid === 200 ? runtime : pid === 400 ? peer : undefined);
  expect(registry.register(400, 501, peer, { pid: 200, start: '200:1' })).toBe(true);
  const oldToken = registry.registrationToken();
  const oldGeneration = registry.key();
  const guard = { seatSet: () => ({ exitCode: 0 as const, message: 'registered' }) };
  const result = registerSeatRuntime({ op: 'seat-set', seat: 'OP', runtime: { pid: 200, start: '200:1' } }, guard, registry, 400, 501, peer, () => { throw new Error('write failed'); });
  expect(result.exitCode).not.toBe(0);
  expect(registry.registrationToken()).toBe(oldToken);
  expect(registry.isLiveGeneration(oldGeneration)).toBe(true);
  expect(registry.matches(400, 501, peer, oldToken)).toBe(true);
});

test('credential publication failure revokes registration and never mutates the seat ledger', () => {
  let seatMutated = false; let revoked = false;
  const guard = { seatSet: () => { seatMutated = true; return { exitCode: 0 as const, message: 'registered' }; } };
  const registry = { register: () => true, registrationToken: () => 'fixture', clear: () => { revoked = true; } };
  const result = registerSeatRuntime({ op: 'seat-set', seat: 'OP', runtime: { pid: 200, start: '200:1' } }, guard, registry, 1, 501, undefined, () => { throw new Error('write failed'); });
  expect(result.exitCode).not.toBe(0);
  expect(seatMutated).toBe(false);
  expect(revoked).toBe(true);
});

// Real Unix peer credentials are needed at the serveConnection boundary; the runtime
// registry is a controlled seam so token and ancestry can be varied independently.
test.skipIf(process.platform !== 'darwin')('human socket runtime descendant needs runtime credential for OP peer authority', async () => {
  const root = mkdtempSync('/tmp/els-role-');
  const path = `${root}/s.sock`;
  const relay = createServer();
  await new Promise<void>(resolve => relay.listen(path, resolve));
  let descendant = true;
  const registry = {
    isDescendant: () => descendant,
    matches: (_pid: unknown, _uid: unknown, _baseline: unknown, token: unknown) => descendant && token === 'fixture-token',
    key: () => 'fixture-generation',
    isLiveGeneration: () => true,
  } as unknown as SeatRuntimeRegistry;
  const roles: string[] = [];
  const guard = {
    classify: () => ({ kind: 'outsider', note: 'no pane credential' }),
    authorize: (role: { kind: string }) => { roles.push(role.kind); return { allow: role.kind === 'peer', reason: 'denied' }; },
    audit: () => {}, seatSet: () => ({ exitCode: 1, message: 'unused' }),
  } as never;
  saveJournal(elsJournalPath(root), { version: 1,
    workspaces: [{ id: 'w', name: 'w', rootCwd: root, purpose: '', host: 'local' }],
    tabs: [{ id: 'x', workspaceId: 'w', label: 'x', focusPaneId: 'p' }],
    panes: [{ id: 'p', tabId: 'x', kind: 'pty', title: 'p', cwd: root, command: ['sh'], state: 'working', restore: 'cwd', ptyId: '', scrollback: '', ownerSeat: 'OP' }],
  });
  const core = { shellPids: () => [], rename: () => ({ exitCode: 0, message: 'renamed' }) } as never;
  const ask = async (token?: string) => {
    const client = createConnection(path);
    const peer = await new Promise<import('node:net').Socket>(resolve => relay.once('connection', resolve));
    serveConnection(Promise.resolve(core), peer, root, () => ({ pane: 'op-pane', seat: 'OP' }), { current: guard }, root, undefined, false, registry);
    const answer = new Promise<string>((resolve, reject) => { client.once('data', d => resolve(String(d))); client.once('error', reject); });
    client.write(`${JSON.stringify({ op: 'auth', ...(token ? { runtimeToken: token } : {}) })}\n`);
    await answer;
    const result = new Promise<string>((resolve, reject) => { client.once('data', d => resolve(String(d))); client.once('error', reject); });
    client.write(`${JSON.stringify({ op: 'rename', kind: 'tab', id: 'x', name: 'y' })}\n`);
    const response = JSON.parse(await result) as { exitCode: number };
    client.destroy(); peer.destroy();
    return response.exitCode;
  };
  try {
    expect(await ask()).toBe(1);
    expect(await ask('wrong')).toBe(1);
    expect(await ask('fixture-token')).toBe(0);
    descendant = false;
    expect(await ask()).toBe(0); // Unrelated human OP peer keeps the existing path.
    expect(roles).toEqual(['outsider', 'outsider', 'peer', 'peer']);
  } finally {
    await new Promise<void>(resolve => relay.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
