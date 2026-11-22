// ELS-OWNER-TOKEN-PANE-INHERIT (OP #110979 · JUD #110978) — the els server's OWNER credential must never reach a pane.
// Real path: real startElsServer → real detached holder (holder-main) → real pane running `env`. The pane writes its whole
// environment to a file; the owner token (read from the server's 0600 owner-token file) must appear nowhere in it.
// Two startPty env paths are forced with the existing seams (no new production flags):
//   - login-shell capture success: SHELL = a POSIX shell, so `$SHELL -l -i -c printenv` is captured and the child env is rebuilt from it;
//   - fallback: ELANOUS_SKIP_LOGIN_ENV=1 (the shell-env-bootstrap opt-out), so the child env falls back to the holder's process.env.
// A sentinel var set in the server env tells which path ran: captured env drops it, the process.env fallback keeps it.

import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { requestEls } from './client.js';
import { elsSocketPath, startElsServer } from './server.js';
import { guardElsProcesses, reapElsProcesses } from './test-support/els-process-guard.js';

guardElsProcesses();

// The train TMPDIR is long and unix socket paths are limited (103 bytes): keep the state dir short.
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const TOUCHED_ENV = ['ELANOUS_ELS_OWNER_TOKEN', 'ELANOUS_SKIP_LOGIN_ENV', 'SHELL', 'LIT_OWNER_INHERIT_SENTINEL'] as const;
const saved = new Map<string, string | undefined>();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  const pending = [...cleanups];
  cleanups.length = 0;
  for (const cleanup of pending.reverse()) { try { await cleanup(); } catch { /* best effort */ } }
  for (const name of TOUCHED_ENV) {
    const before = saved.get(name);
    if (before === undefined) delete process.env[name]; else process.env[name] = before;
  }
  saved.clear();
});
const setEnv = (name: typeof TOUCHED_ENV[number], value: string | undefined): void => {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
};

const LIT_WAIT_MS = 30_000;
const LIT_POLL_MS = 50;
const LIT_TEST_MS = 120_000;
const until = async (check: () => boolean): Promise<void> => {
  const stop = Date.now() + LIT_WAIT_MS;
  while (!check()) {
    if (Date.now() > stop) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, LIT_POLL_MS));
  }
};

interface PaneRun { readonly env: string; readonly ownerToken: string }

/** Boot a real server, open a pane that dumps `env` to a file, and return what the pane saw plus the server's owner token. */
async function paneEnvDump(): Promise<PaneRun> {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-oti-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(async () => { await reapElsProcesses(); });   // runs after server.close: the holders it detached die here
  const server = await startElsServer({ stateRoot: root });
  if ('exitCode' in server) throw new Error(server.message);
  cleanups.push(() => server.close());
  const socket = elsSocketPath(root);
  const ownerToken = readFileSync(join(dirname(socket), 'owner-token'), 'utf8').trim();
  expect(ownerToken).toBe(process.env.ELANOUS_ELS_OWNER_TOKEN as string); // the same credential the server holds in its own env
  expect(ownerToken).not.toBe('');                                        // a real token, so the not-contain assertions below cannot pass on an empty needle
  const out = join(root, 'pane-env.out');
  const created = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh', '-c', 'env > "$1.tmp" && mv "$1.tmp" "$1"; exec cat', 'sh', out] });
  expect(created.exitCode).toBe(0);
  const { pane } = JSON.parse(created.message) as { pane: string };
  cleanups.push(async () => { await requestEls(socket, { op: 'close', pane }); });
  await until(() => existsSync(out));
  const env = readFileSync(out, 'utf8');
  return { env, ownerToken };
}

test('owner token never reaches the pane: login-shell capture success path', async () => {
  setEnv('ELANOUS_SKIP_LOGIN_ENV', undefined);
  setEnv('SHELL', '/bin/sh');
  setEnv('LIT_OWNER_INHERIT_SENTINEL', 'lit-sentinel-captured');
  const run = await paneEnvDump();
  expect(run.env).toContain('PATH=');                                  // a real env was dumped
  expect(run.env).not.toContain('LIT_OWNER_INHERIT_SENTINEL=');        // captured path rebuilt the env (process.env was not inherited wholesale)
  expect(run.env).not.toContain(run.ownerToken);                       // THE assertion: owner token appears nowhere in the pane output
  expect(run.env).not.toContain('ELANOUS_ELS_OWNER_TOKEN');
}, LIT_TEST_MS);

test('owner token never reaches the pane: fallback (process.env) path, and the pane keeps its own token', async () => {
  setEnv('ELANOUS_SKIP_LOGIN_ENV', '1');
  setEnv('LIT_OWNER_INHERIT_SENTINEL', 'lit-sentinel-fallback');
  const run = await paneEnvDump();
  expect(run.env).toContain('LIT_OWNER_INHERIT_SENTINEL=lit-sentinel-fallback'); // fallback path really ran: the holder's process.env reached the pane
  expect(run.env).not.toContain(run.ownerToken);                       // THE assertion
  expect(run.env).not.toContain('ELANOUS_ELS_OWNER_TOKEN');
  const paneToken = /^ELANOUS_ELS_PANE_TOKEN=(.+)$/m.exec(run.env)?.[1];
  expect(paneToken).toBeDefined();                                     // the pane keeps its own credential
  expect(paneToken).not.toBe(run.ownerToken);
}, LIT_TEST_MS);
