// ELS-START-PERF — the login-shell capture runs once per els server run, not once per pane holder; the els credentials never ride along.
// Real path: real startElsServer → real detached holders → real panes dumping `env`. SHELL is a counting wrapper named `sh`
// (a POSIX shell name the capture accepts) that appends a line to a file whenever it is asked to capture (`-c printenv`).

import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCapturedEnv } from '../shell-env-bootstrap.js';
import { requestEls } from './client.js';
import { loginEnvForSpawn, loginEnvKey, packLoginEnv, resetLoginEnvHandoffForTesting, unpackLoginEnv, warmLoginEnv } from './login-env-handoff.js';
import { elsSocketPath, startElsServer } from './server.js';

const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
const TOUCHED_ENV = ['ELANOUS_SKIP_LOGIN_ENV', 'SHELL', 'TERM_PROGRAM', 'ELANOUS_ELS_OWNER_TOKEN', 'ELANOUS_ELS_PANE_TOKEN', 'HOME'] as const;
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
  resetLoginEnvHandoffForTesting();
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

test('login env key: user, shell, HOME and rc mtimes decide whether a capture still applies', () => {
  const home = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-lek-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const env = { SHELL: '/bin/zsh', HOME: home };
  const before = loginEnvKey(env, 501);
  expect(loginEnvKey(env, 501)).toBe(before);
  expect(loginEnvKey(env, 502)).not.toBe(before);                              // another user
  expect(loginEnvKey({ ...env, SHELL: '/bin/bash' }, 501)).not.toBe(before);   // another shell
  writeFileSync(join(home, '.zshrc'), 'export A=1\n');
  expect(loginEnvKey(env, 501)).not.toBe(before);                              // an rc file appeared/changed
});

test('handoff payload never carries the els credentials and only fits its own key', () => {
  const captured = { PATH: '/bin', ELANOUS_ELS_OWNER_TOKEN: 'owner-secret', ELANOUS_ELS_PANE_TOKEN: 'pane-secret', KEEP: 'yes' };
  const packed = packLoginEnv(captured, 'k1');
  expect(packed).not.toContain('owner-secret');
  expect(packed).not.toContain('pane-secret');
  expect(unpackLoginEnv(packed, 'k1')).toEqual({ PATH: '/bin', KEEP: 'yes' });
  expect(unpackLoginEnv(packed, 'k2')).toBeUndefined();                        // another user/shell/rc state: capture it yourself
  expect(unpackLoginEnv('not json', 'k1')).toBeUndefined();
  expect(unpackLoginEnv(JSON.stringify({ key: 'k1', env: { PATH: 1 } }), 'k1')).toBeUndefined();
});

test('three new panes cost one login-shell capture, and the owner token still reaches none of them', async () => {
  const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-leh-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const counter = join(root, 'captures');
  writeFileSync(join(bin, 'sh'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = printenv ] && echo capture >> '${counter}'; done\nexec /bin/sh "$@"\n`);
  chmodSync(join(bin, 'sh'), 0o755);
  setEnv('ELANOUS_SKIP_LOGIN_ENV', undefined);
  setEnv('TERM_PROGRAM', undefined);
  setEnv('SHELL', join(bin, 'sh'));
  resetLoginEnvHandoffForTesting();
  const server = await startElsServer({ stateRoot: root });
  if ('exitCode' in server) throw new Error(server.message);
  cleanups.push(() => server.close());
  const socket = elsSocketPath(root);
  const ownerToken = process.env.ELANOUS_ELS_OWNER_TOKEN as string;
  expect(ownerToken).not.toBe('');
  const dumps: string[] = [];
  for (const n of [1, 2, 3]) {
    const out = join(root, `pane-env-${n}.out`);
    const created = await requestEls(socket, { op: 'new', ws: 'OP', cwd: root, command: ['/bin/sh', '-c', 'env > "$1.tmp" && mv "$1.tmp" "$1"; exec cat', 'sh', out] });
    expect(created.exitCode).toBe(0);
    const { pane } = JSON.parse(created.message) as { pane: string };
    cleanups.push(async () => { await requestEls(socket, { op: 'close', pane }); });
    await until(() => existsSync(out));
    dumps.push(readFileSync(out, 'utf8'));
  }
  expect(readFileSync(counter, 'utf8').trim().split('\n')).toEqual(['capture']);   // one capture for the server run, none per holder
  for (const dump of dumps) {
    expect(dump).toContain('PATH=');
    expect(dump).not.toContain(ownerToken);
    expect(dump).not.toContain('ELANOUS_ELS_OWNER_TOKEN');
  }
}, LIT_TEST_MS);

test('the ELANOUS_SKIP_LOGIN_ENV opt-out beats a capture made earlier in the same server run', async () => {
  setEnv('ELANOUS_SKIP_LOGIN_ENV', undefined);
  setEnv('TERM_PROGRAM', undefined);
  setEnv('SHELL', '/bin/sh');
  resetLoginEnvHandoffForTesting();
  expect(await loginEnvForSpawn()).toContain('PATH');   // captured and handed over
  setEnv('ELANOUS_SKIP_LOGIN_ENV', '1');
  expect(await loginEnvForSpawn()).toBeUndefined();     // opted out: the holder falls back to process.env as before
}, LIT_TEST_MS);

test('the server-side capture cache holds no els credential after warmLoginEnv, and still holds the login env', async () => {
  setEnv('ELANOUS_SKIP_LOGIN_ENV', undefined);
  setEnv('TERM_PROGRAM', undefined);
  setEnv('SHELL', '/bin/sh');
  const home = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-lec-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  // the capture runs with a stripped env, so the tokens get in the way the #39230 leak did: a rc file exports them
  writeFileSync(join(home, '.profile'), 'export ELANOUS_ELS_OWNER_TOKEN=owner-cache-secret ELANOUS_ELS_PANE_TOKEN=pane-cache-secret\n');
  setEnv('HOME', home);
  resetLoginEnvHandoffForTesting();
  await warmLoginEnv();
  const cached = getCapturedEnv();
  expect(cached.PATH).toBeTruthy();                       // a real capture, not the process.env fallback
  expect(JSON.stringify(cached)).not.toContain('cache-secret');
  expect(cached.ELANOUS_ELS_OWNER_TOKEN).toBeUndefined();
  expect(cached.ELANOUS_ELS_PANE_TOKEN).toBeUndefined();
  expect(await loginEnvForSpawn()).not.toContain('cache-secret');
}, LIT_TEST_MS);
