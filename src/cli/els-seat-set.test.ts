// `els seat set OP` — the documented form must parse (a `seat` command with a `set` subcommand) and stay owner-only.
// The els server runs in this process (readiness = startElsServer resolving, no polling and no child process), and the
// real registered command runs through simCli in-process, so the whole production path (parse → owner token → socket →
// seat-set) is exercised without a CLI spawn whose boot time depends on gate-host load (R-LIVE10).
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simCli } from '../ux-sim/in-process-cli.js';
import { startElsServer } from '../els/server.js';
import { AUTH_OWNER_TOKEN_ENV } from '../els/server-auth.js';

// 출처: the first in-process CLI turn imports the whole command tree, which takes seconds on a loaded gate host (20+ load).
const LOADED_HOST_TEST_TIMEOUT_MS = 120_000;

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
const ownerTokenBefore = process.env[AUTH_OWNER_TOKEN_ENV];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // startElsServer publishes the owner token into this process's env; put the original back.
  if (ownerTokenBefore === undefined) delete process.env[AUTH_OWNER_TOKEN_ENV];
  else process.env[AUTH_OWNER_TOKEN_ENV] = ownerTokenBefore;
});
// A Unix socket path holds at most 103 bytes (macOS): the land train's long TMPDIR (…/primary-tmp/…) puts the server's
// <state>/els/els.sock over it, so a state dir under a long TMPDIR falls back to /tmp (the temp dir is removed in afterEach).
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const tempDir = (prefix: string) => { const dir = mkdtempSync(join(SOCKET_SAFE_TMP, prefix)); dirs.push(dir); return dir; };

async function serve(state: string): Promise<void> {
  const started = await startElsServer({ stateRoot: state, seatLookup: () => undefined });
  if ('exitCode' in started) throw new Error(started.message);
  closers.push(started.close);
}
const side = (state: string, args: string[]) => simCli(['side', ...args], { allowPaths: [['side', 'seat', 'set'], ['side', 'seat']], stateRoot: state, cwd: state, env: { NODE_ENV: 'development', HERDR_ENV: '' } });

test('`els seat set OP` parses as seat → set <seat> and registers OP with the owner token', async () => {
  const state = tempDir('els-seatset-');
  await serve(state);
  const done = await side(state, ['seat', 'set', 'OP']);
  expect(done.stderr).not.toContain('only OP is supported');
  expect(done.exitCode).toBe(0);
}, LOADED_HOST_TEST_TIMEOUT_MS);

test('with no els server state the owner token is missing: `els seat set OP` fails closed', async () => {
  const noServer = await side(tempDir('els-seatset-none-'), ['seat', 'set', 'OP']);
  expect(noServer.exitCode).toBe(1);
  expect(noServer.stderr).toContain('no owner token found');
}, LOADED_HOST_TEST_TIMEOUT_MS);

test('another seat name is refused even for the owner (only OP is supported)', async () => {
  const state = tempDir('els-seatset-other-');
  await serve(state);
  const refused = await side(state, ['seat', 'set', 'HAND-X']);
  expect(refused.exitCode).toBe(1);
  expect(refused.stdout + refused.stderr).toContain('only OP is supported');
}, LOADED_HOST_TEST_TIMEOUT_MS);

test('`els seat` shows its `set` subcommand in help', async () => {
  const state = tempDir('els-seatset-help-');
  const help = await side(state, ['seat', '--help']);
  expect(help.exitCode).toBe(0);
  expect(help.stdout).toContain('set <seat>');
}, LOADED_HOST_TEST_TIMEOUT_MS);
