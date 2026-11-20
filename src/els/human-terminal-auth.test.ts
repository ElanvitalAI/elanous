import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { humanOwnerToken } from './human-terminal-auth.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A state dir the way the server leaves it: <root>/els/els.sock beside a 0600 owner-token file. */
function stateWithOwnerFile(token: string, mode = 0o600): string {
  const root = mkdtempSync(join(tmpdir(), 'els-human-'));
  dirs.push(root);
  mkdirSync(join(root, 'els'));
  writeFileSync(join(root, 'els', 'owner-token'), `${token}\n`, { mode });
  chmodSync(join(root, 'els', 'owner-token'), mode);
  return join(root, 'els', 'els.sock');
}

test('the person\'s terminal (no els env, both ends a terminal) takes the server\'s owner token from its 0600 file', () => {
  const socketPath = stateWithOwnerFile('owner-secret-1');
  expect(humanOwnerToken({ env: {}, socketPath, isTerminal: true })).toBe('owner-secret-1');
});

test('a pane process never takes it: the pane token, an owner token already held, or any pane name in env keeps what it has', () => {
  const socketPath = stateWithOwnerFile('owner-secret-2');
  const cases: Record<string, string>[] = [
    { ELANOUS_ELS_PANE_TOKEN: 'pane-token' },
    { ELANOUS_ELS_OWNER_TOKEN: 'already-held' },
    { ELANOUS_ELS_PANE: 'p1' },
    { ELANOUS_ELS_WS: 'w1' },
    { ELANOUS_ELS_SOCKET: socketPath },   // a pane whose token was scrubbed is still a pane
  ];
  for (const env of cases) expect([env, humanOwnerToken({ env, socketPath, isTerminal: true })]).toEqual([env, undefined]);
});

test('scripts and pipes (not a terminal) never take it', () => {
  const socketPath = stateWithOwnerFile('owner-secret-3');
  expect(humanOwnerToken({ env: {}, socketPath, isTerminal: false })).toBeUndefined();
});

test('only the server\'s own file counts: group/world readable, a symlink, empty, absent or another owner are all refused', () => {
  const open = stateWithOwnerFile('owner-secret-4', 0o644);
  expect(humanOwnerToken({ env: {}, socketPath: open, isTerminal: true })).toBeUndefined();

  const real = stateWithOwnerFile('owner-secret-5');
  const linked = mkdtempSync(join(tmpdir(), 'els-human-link-'));
  dirs.push(linked);
  mkdirSync(join(linked, 'els'));
  symlinkSync(join(real, '..', 'owner-token'), join(linked, 'els', 'owner-token'));
  expect(humanOwnerToken({ env: {}, socketPath: join(linked, 'els', 'els.sock'), isTerminal: true })).toBeUndefined();

  expect(humanOwnerToken({ env: {}, socketPath: stateWithOwnerFile(''), isTerminal: true })).toBeUndefined();
  expect(humanOwnerToken({ env: {}, socketPath: join(linked, 'nothing', 'els.sock'), isTerminal: true })).toBeUndefined();
  expect(humanOwnerToken({ env: {}, socketPath: real, isTerminal: true, uid: (process.getuid?.() ?? 0) + 1 })).toBeUndefined();
});
