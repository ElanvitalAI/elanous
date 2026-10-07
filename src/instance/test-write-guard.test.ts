// TEST-PROD-LEAK — the guard refuses a test's writes/sends into an «ops-like» root and allows an isolated one.
// The ops root is injected (setOpsRootsForTesting) so nothing here touches the real ~/.elanous.
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { deferOutbound, deliver, flushDeferred, sendOutbound, sendTelegramDirect, setInProcessOutbound } from '../domains/outbound-alert.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { setResolveDaemonEndpointForTest } from '../nexus/daemon-endpoint.js';
import { LogStore } from '../mss/logging/log-store.js';
import { refuseProductionLedgerWriteInTest } from '../harness/ledger-write-guard.js';
import { getUserConfig } from '../user-config.js';
import { effectiveInstanceRoot } from './resolve.js';
import {
  assertNotTestWritingOps, EXTRA_OPS_ROOTS_ENV, isInsideOpsRoot, opsRoots, setAccountHomeLookupForTesting, setOpsRootsForTesting, testProcessSignal,
  TestOpsWriteRefusedError,
} from './test-write-guard.js';

const ENV_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'ELANOUS_NEXUS_URL', 'SEND_VIA_ELANOUS', 'ELANOUS_TELEGRAM_BOT_TOKEN', 'ELANOUS_DISCORD_BOT_TOKEN'] as const;
let saved: Record<string, string | undefined> = {};
let root = '';
let opsLike = '';
let isolated = '';

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  root = mkdtempSync(join(tmpdir(), 'test-write-guard-'));
  opsLike = join(root, 'ops');
  isolated = join(root, 'isolated');
  mkdirSync(opsLike, { recursive: true });
  mkdirSync(isolated, { recursive: true });
  setOpsRootsForTesting([opsLike]);
});

afterEach(() => {
  setOpsRootsForTesting(null);
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

describe('test-process detection (measured under bun test)', () => {
  test('bun test marks this process; the real CLI shape does not', () => {
    expect(testProcessSignal()).not.toBeNull();
    expect(testProcessSignal({ NODE_ENV: 'test' }, '/repo/bin/elanous.mjs')).toBe('NODE_ENV=test');
    expect(testProcessSignal({ ELANOUS_TEST_HOME: '/tmp/x' }, '/repo/bin/elanous.mjs')).toBe('ELANOUS_TEST_HOME');
    // A test that overrides NODE_ENV is still a test: Bun.main is the running test file.
    expect(testProcessSignal({ NODE_ENV: 'production' }, '/repo/src/a/b.test.ts')).toBe('Bun.main=test-file');
    expect(testProcessSignal({}, '/repo/bin/elanous.mjs')).toBeNull();
    expect(testProcessSignal({ NODE_ENV: 'production' }, '/repo/scripts/release.ts')).toBeNull();
  });

  test('the real ops root is the account home, not a redirected HOME', () => {
    setOpsRootsForTesting(null);
    const [real] = opsRoots();
    expect(real!.endsWith('/.elanous')).toBe(true);
    expect(real).not.toContain(tmpdir());
  });

  test('an unreadable account database fails toward protection: conventional homes and HOME are all ops', () => {
    setOpsRootsForTesting(null);
    setAccountHomeLookupForTesting(() => null);
    try {
      const roots = opsRoots();
      expect(roots.length).toBeGreaterThanOrEqual(2);
      expect(roots.some((r) => r.endsWith(`/${userInfo().username}/.elanous`))).toBe(true);
      expect(isInsideOpsRoot(join(homedir(), '.elanous', 'logs', 'logs.db'))).toBe(true);
      // A non-standard account home under a redirected HOME is still protected: any `.elanous` tree is.
      expect(isInsideOpsRoot('/opt/accounts/nonstandard/.elanous/logs/logs.db')).toBe(true);
      expect(() => assertNotTestWritingOps('/opt/accounts/nonstandard/.elanous/conatus/outbound_deferred.jsonl', 'probe')).toThrow(TestOpsWriteRefusedError);
      // A `.elanous` that is a symlink to an oddly named directory — live or dangling — is still protected.
      const odd = join(root, 'odd-home');
      mkdirSync(join(odd, 'real-state'), { recursive: true });
      symlinkSync(join(odd, 'real-state'), join(odd, '.elanous'));
      expect(() => assertNotTestWritingOps(join(odd, '.elanous', 'logs', 'logs.db'), 'probe')).toThrow(TestOpsWriteRefusedError);
      const dangling = join(root, 'odd-home-2');
      mkdirSync(dangling, { recursive: true });
      symlinkSync(join(dangling, 'missing-state'), join(dangling, '.elanous'));
      expect(() => assertNotTestWritingOps(join(dangling, '.elanous', 'conatus', 'outbound_deferred.jsonl'), 'probe')).toThrow(TestOpsWriteRefusedError);
      // The run-ledger guard sees the same tree through the original spelling.
      const redirectedHome = join(root, 'home', '.elanous');
      expect(refuseProductionLedgerWriteInTest(join(odd, '.elanous', 'run-ledger'), 'run-ledger', { NODE_ENV: 'test' }, redirectedHome, redirectedHome)).toBe(true);
      // An isolated test root stays writable.
      expect(isInsideOpsRoot(join(isolated, 'logs', 'logs.db'))).toBe(false);
    } finally { setAccountHomeLookupForTesting(null); }
  });

  test('a real entry process (no test signal) is not refused even when its own root is ops; with NODE_ENV=test it is', () => {
    // outbound-log-probe.ts is a real entry script: it registers the logs.db store sink and sends through curl.
    // Its state root is declared ops via the widening-only env; a fake curl on PATH keeps the send local.
    const repo = join(import.meta.dir, '..', '..');
    const state = join(root, 'probe-state');
    const fakeBin = join(root, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    const curlCalls = join(root, 'curl-calls');
    writeFileSync(join(fakeBin, 'curl'), `#!/bin/sh\necho called >> '${curlCalls}'\nprintf '{"ok":true}'\n`, { mode: 0o755 });
    const env: Record<string, string | undefined> = {
      ...process.env, NODE_ENV: '', ELANOUS_TEST_HOME: '', ELANOUS_STATE_DIR: state, ELANOUS_CONFIG_DIR: state,
      ELANOUS_NEXUS_URL: '', [EXTRA_OPS_ROOTS_ENV]: state, PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    };
    const run = (overrides: Record<string, string>) => childProcess.spawnSync('bun', ['src/domains/outbound-log-probe.ts'], {
      cwd: repo, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 60_000,
    });
    const real = run({});
    expect(real.stderr).not.toContain('[test-guard]');
    expect(real.status).toBe(0);
    expect(existsSync(join(state, 'logs', 'logs.db'))).toBe(true);
    expect(readFileSync(curlCalls, 'utf8').trim().split('\n')).toEqual(['called']); // the send reached the transport
    rmSync(curlCalls, { force: true });
    const asTest = run({ NODE_ENV: 'test' });
    expect(asTest.stderr).toContain('[test-guard] refused');
    expect(asTest.status).not.toBe(0);
    expect(existsSync(curlCalls)).toBe(false);
  }, 90_000);
});

describe('ops-like root → refused · isolated root → allowed', () => {
  test('deferred-alert queue append', () => {
    const opsQueue = join(opsLike, 'conatus', 'outbound_deferred.jsonl');
    expect(() => deferOutbound('private-alert-body', 'ops-alert', null, opsQueue)).toThrow(TestOpsWriteRefusedError);
    expect(existsSync(opsQueue)).toBe(false);
    const ownQueue = join(isolated, 'conatus', 'outbound_deferred.jsonl');
    expect(deferOutbound('body', 'ops-alert', null, ownQueue)).toBe(true);
    expect(existsSync(ownQueue)).toBe(true);
  });

  test('flushDeferred on the ops queue never reaches its sender', () => {
    const opsQueue = join(opsLike, 'conatus', 'outbound_deferred.jsonl');
    mkdirSync(join(opsLike, 'conatus'), { recursive: true });
    writeFileSync(opsQueue, `${JSON.stringify({ ts: new Date().toISOString(), kind: 'ops-alert', text: 'private-alert-body' })}\n`);
    let sent = 0;
    const sendBatch = () => { sent++; return true; };
    expect(() => flushDeferred(opsQueue, { sendBatch })).toThrow(TestOpsWriteRefusedError);
    expect(sent).toBe(0);
    const ownQueue = join(isolated, 'outbound_deferred.jsonl');
    writeFileSync(ownQueue, `${JSON.stringify({ ts: new Date().toISOString(), kind: 'ops-alert', text: 'x' })}\n`);
    expect(flushDeferred(ownQueue, { sendBatch })).toBe(1);
    expect(sent).toBe(1);
  });

  test('logs.db open for write', () => {
    const opsDb = join(opsLike, 'logs', 'logs.db');
    expect(() => new LogStore(opsDb, { instance: 'test' })).toThrow(TestOpsWriteRefusedError);
    expect(existsSync(opsDb)).toBe(false);
    const own = new LogStore(join(isolated, 'logs', 'logs.db'), { instance: 'test' });
    own.close();
    expect(existsSync(join(isolated, 'logs', 'logs.db'))).toBe(true);
    expect(() => new LogStore(':memory:')).not.toThrow();
  });

  test('a send routed through the ops universe is refused, faked or not', () => {
    // Pretend this test's own universe is ops: the daemon endpoint/token would be the ops daemon's.
    setOpsRootsForTesting([effectiveInstanceRoot(), getElanousConfigDir()]);
    process.env.ELANOUS_NEXUS_URL = 'http://127.0.0.1:9';
    expect(() => deliver('private-alert-body', 'ops-alert')).toThrow(TestOpsWriteRefusedError);
    // Ops routing is refused whatever the transport is: a bare spy, a call-through wrapper and a real fake alike.
    const real = childProcess.execFileSync;
    for (const install of [
      () => spyOn(childProcess, 'execFileSync'),
      () => spyOn(childProcess, 'execFileSync').mockImplementation(((...args: unknown[]) => (real as (...a: unknown[]) => unknown)(...args)) as never),
      () => spyOn(childProcess, 'execFileSync').mockImplementation((() => '{"delivered":true}') as never),
    ]) {
      const spy = install();
      try {
        expect(() => deliver('private-alert-body', 'ops-alert')).toThrow(TestOpsWriteRefusedError);
        expect(spy).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
    }
  });

  test('the in-process daemon sender is refused in the ops universe and allowed in an isolated one', async () => {
    let called = 0;
    setInProcessOutbound(async () => { called++; return true; });
    try {
      setOpsRootsForTesting([effectiveInstanceRoot(), getElanousConfigDir()]);
      expect(() => deliver('private-alert-body', 'ops-alert')).toThrow(TestOpsWriteRefusedError);
      expect(called).toBe(0);
      setOpsRootsForTesting([opsLike]);
      expect(deliver('body', 'ops-alert')).toBe('daemon');
      await Bun.sleep(0);
      expect(called).toBe(1);
    } finally { setInProcessOutbound(null); }
  });

  test('origin sends (Telegram · Discord) are refused in the ops universe before the faked transport runs', () => {
    setSystemTime(new Date('2026-10-01T03:00:00Z')); // 12:00 KST — outside quiet hours, so the origin path runs
    process.env.ELANOUS_TELEGRAM_BOT_TOKEN = 'telegram-origin-test-token';
    process.env.ELANOUS_DISCORD_BOT_TOKEN = 'discord-origin-test-token';
    const urls: string[] = [];
    const spy = spyOn(childProcess, 'execFileSync').mockImplementation(((_cmd: string, args?: readonly string[]) => {
      const url = String(args?.at(-1) ?? '');
      urls.push(url);
      return url.includes('discord.com') ? '{"id":"posted"}' : '{"ok":true}';
    }) as never);
    try {
      setOpsRootsForTesting([effectiveInstanceRoot(), getElanousConfigDir()]);
      for (const origin of [{ channel: 'telegram', chatId: 98765 }, { channel: 'discord', channelId: '123' }] as const) {
        expect(() => sendOutbound('private-alert-body', 'alert', origin)).toThrow(TestOpsWriteRefusedError);
      }
      expect(urls.filter((u) => u.includes('api.telegram.org') || u.includes('discord.com'))).toEqual([]);
      setOpsRootsForTesting([opsLike]);
      expect(sendOutbound('body', 'alert', { channel: 'telegram', chatId: 98765 })).toBe(true);
      expect(sendOutbound('body', 'alert', { channel: 'discord', channelId: '123' })).toBe(true);
      expect(urls.some((u) => u.includes('api.telegram.org'))).toBe(true);
      expect(urls.some((u) => u.includes('discord.com'))).toBe(true);
    } finally {
      spy.mockRestore();
      setSystemTime();
      delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
      delete process.env.ELANOUS_DISCORD_BOT_TOKEN;
    }
  });

  test('isolated routing with a faked transport is allowed', () => {
    process.env.ELANOUS_NEXUS_URL = 'http://127.0.0.1:9';
    const spy = spyOn(childProcess, 'execFileSync').mockImplementation((() => '{"delivered":true}') as never);
    try {
      expect(deliver('body', 'ops-alert')).toBe('daemon');
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  test('isolated routing: a send to this universe\'s own daemon is not refused by the guard', () => {
    // The endpoint resolved from this (isolated) universe; 127.0.0.1:9 refuses locally and no bot token exists.
    setResolveDaemonEndpointForTest(() => ({ baseUrl: 'http://127.0.0.1:9', healthUrl: 'http://127.0.0.1:9/v1/health', pwaUrl: 'http://127.0.0.1:9', source: 'lifecycle' }));
    try {
      expect(isInsideOpsRoot(effectiveInstanceRoot())).toBe(false);
      expect(deliver('body', 'alert')).toBe(false);
    } finally { setResolveDaemonEndpointForTest(null); }
  });

  test('an explicit ELANOUS_NEXUS_URL (could be the ops daemon) is refused unless curl is faked', () => {
    process.env.ELANOUS_NEXUS_URL = 'http://127.0.0.1:9';
    const bare = spyOn(childProcess, 'execFileSync');
    try {
      expect(() => deliver('private-alert-body', 'ops-alert')).toThrow(TestOpsWriteRefusedError);
      expect(bare).not.toHaveBeenCalled();
    } finally { bare.mockRestore(); }
  });

  test('a real bot send is refused unless the transport is faked — env token or isolated config token alike', () => {
    process.env.TELEGRAM_BOT_TOKEN = '1:fake';
    process.env.TELEGRAM_CHAT_ID = '1';
    const base = getUserConfig();
    const envOnly = { ...base, telegram: { ...base.telegram, channels: undefined, botToken: undefined, homeChannel: undefined } } as typeof base;
    expect(() => sendTelegramDirect('private-alert-body', 'alert', { config: envOnly, legacyEnv: () => ({}) })).toThrow(TestOpsWriteRefusedError);
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    // A bot configured in this test's own isolated config is still a real bot.
    const configured = { ...base, telegram: { ...base.telegram, channels: undefined, botToken: '2:fake', homeChannel: 2 } } as typeof base;
    expect(() => sendTelegramDirect('private-alert-body', 'ops-alert', { config: configured })).toThrow(TestOpsWriteRefusedError);
    // A bare spy in an isolated universe still calls the real curl — not a fake, so the bot send is refused.
    const bare = spyOn(childProcess, 'execFileSync');
    try {
      expect(() => sendTelegramDirect('private-alert-body', 'ops-alert', { config: configured })).toThrow(TestOpsWriteRefusedError);
      expect(bare).not.toHaveBeenCalled();
    } finally { bare.mockRestore(); }
    const spy = spyOn(childProcess, 'execFileSync').mockImplementation((() => '{"ok":true}') as never);
    try {
      expect(sendTelegramDirect('body', 'ops-alert', { config: configured })).toBe(true);
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    const calls: string[] = [];
    expect(sendTelegramDirect('body', 'ops-alert', { config: configured, sendRaw: (_t, chat) => { calls.push(String(chat)); return true; } })).toBe(true);
    expect(calls).toEqual(['2']);
  });

  test('a bare spy installed before outbound-alert is imported is still not a fake', () => {
    const state = join(root, 'spy-first-state');
    const r = childProcess.spawnSync(process.execPath, [join(import.meta.dir, 'test-write-guard-spy-first.fixture.ts')], {
      env: { ...process.env, NODE_ENV: 'test', ELANOUS_STATE_DIR: state, ELANOUS_CONFIG_DIR: state }, encoding: 'utf8', timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').at(-1)!)).toEqual({ refused: 'TestOpsWriteRefusedError', curlCalls: 0 });
  }, 90_000);

  test('an injected sender is still refused when the test resolved the ops universe', () => {
    setOpsRootsForTesting([effectiveInstanceRoot(), getElanousConfigDir()]);
    const base = getUserConfig();
    const configured = { ...base, telegram: { ...base.telegram, channels: undefined, botToken: '2:fake', homeChannel: 2 } } as typeof base;
    let called = 0;
    expect(() => sendTelegramDirect('private-alert-body', 'ops-alert', { config: configured, sendRaw: () => { called++; return true; } }))
      .toThrow(TestOpsWriteRefusedError);
    expect(called).toBe(0);
  });

  test('a dangling symlink in an isolated dir that points into ops resolves to the ops side', () => {
    const link = join(isolated, 'outbound_deferred.jsonl');
    symlinkSync(join(opsLike, 'conatus', 'outbound_deferred.jsonl'), link);
    expect(() => deferOutbound('private-alert-body', 'ops-alert', null, link)).toThrow(TestOpsWriteRefusedError);
    expect(existsSync(join(opsLike, 'conatus', 'outbound_deferred.jsonl'))).toBe(false);
    const dirLink = join(isolated, 'logs-link');
    symlinkSync(join(opsLike, 'logs'), dirLink);
    expect(() => new LogStore(join(dirLink, 'logs.db'), { instance: 'test' })).toThrow(TestOpsWriteRefusedError);
  });

  test('run-ledger guard: the account ops root is production even when HOME (productionRoot) was redirected', () => {
    const redirectedHome = join(root, 'home', '.elanous');
    expect(refuseProductionLedgerWriteInTest(join(opsLike, 'run-ledger'), 'run-ledger', { NODE_ENV: 'test' }, redirectedHome, redirectedHome)).toBe(true);
    expect(refuseProductionLedgerWriteInTest(join(isolated, 'run-ledger'), 'run-ledger', { NODE_ENV: 'test' }, redirectedHome, redirectedHome)).toBe(false);
    expect(refuseProductionLedgerWriteInTest(join(opsLike, 'run-ledger'), 'run-ledger', {}, redirectedHome, redirectedHome)).toBe(false);
  });

  test('with HOME redirected, a test child still refuses the independently resolved account ~/.elanous and added roots', () => {
    // Resolve the OS account home here, independently of the guard (account database, not HOME).
    const uid = process.getuid?.();
    const accountHome = process.platform === 'darwin'
      ? childProcess.execFileSync('/usr/bin/dscl', ['.', '-read', `/Users/${userInfo().username}`, 'NFSHomeDirectory'], { encoding: 'utf8' }).trim().split(/\s+/).at(-1)
      : readFileSync('/etc/passwd', 'utf8').split('\n').map((l) => l.split(':')).find((f) => Number(f[2]) === uid)?.[5];
    expect(accountHome && accountHome.startsWith('/')).toBe(true);
    const fakeHome = join(root, 'fake-home');
    mkdirSync(fakeHome, { recursive: true });
    const guard = JSON.stringify(join(import.meta.dir, 'test-write-guard.ts'));
    const script = `import { assertNotTestWritingOps } from ${guard};
const probe = (p) => { try { assertNotTestWritingOps(p, 'probe'); return 'allowed'; } catch (e) { return e.name; } };
console.log(JSON.stringify(process.argv.slice(-4).map(probe)));`;
    const targets = [
      join(accountHome!, '.elanous', 'logs', 'logs.db'),
      join(accountHome!, '.elanous', 'conatus', 'outbound_deferred.jsonl'),
      join(opsLike, 'logs', 'logs.db'),
      join(fakeHome, '.elanous', 'logs', 'logs.db'),
    ];
    const r = childProcess.spawnSync(process.execPath, ['-e', script, ...targets], {
      env: { ...process.env, HOME: fakeHome, NODE_ENV: 'test', [EXTRA_OPS_ROOTS_ENV]: opsLike }, encoding: 'utf8', timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').at(-1)!)).toEqual([
      'TestOpsWriteRefusedError', 'TestOpsWriteRefusedError', 'TestOpsWriteRefusedError', 'allowed',
    ]);
  }, 90_000);

  test('injected ops-like roots add to the real account root — they never unprotect it', () => {
    const [real] = (() => { setOpsRootsForTesting(null); const r = opsRoots(); setOpsRootsForTesting([opsLike]); return r; })();
    expect(opsRoots()).toContain(real!);
    expect(() => assertNotTestWritingOps(join(real!, 'logs', 'logs.db'), 'probe')).toThrow(TestOpsWriteRefusedError);
    expect(() => assertNotTestWritingOps(join(real!, 'conatus', 'outbound_deferred.jsonl'), 'probe')).toThrow(TestOpsWriteRefusedError);
  });

  test('a symlink followed by .. resolves in kernel order (alias/.. lands in ops, not back in the isolated dir)', () => {
    mkdirSync(join(opsLike, 'child'), { recursive: true });
    const alias = join(isolated, 'alias');
    symlinkSync(join(opsLike, 'child'), alias);
    // Raw strings, not join(): join() would fold alias/.. away before the guard sees it.
    const queue = `${alias}/../conatus/outbound_deferred.jsonl`;
    expect(() => deferOutbound('private-alert-body', 'ops-alert', null, queue)).toThrow(TestOpsWriteRefusedError);
    expect(existsSync(join(opsLike, 'conatus', 'outbound_deferred.jsonl'))).toBe(false);
    expect(() => new LogStore(`${alias}/../logs/logs.db`, { instance: 'test' })).toThrow(TestOpsWriteRefusedError);
    expect(existsSync(join(opsLike, 'logs'))).toBe(false);
    // run-ledger: a link to a child of the (HOME-derived) production root, not registered as an ops root at all.
    setOpsRootsForTesting(null);
    const production = join(root, 'home', '.elanous');
    mkdirSync(join(production, 'child'), { recursive: true });
    const prodAlias = join(isolated, 'prod-alias');
    symlinkSync(join(production, 'child'), prodAlias);
    expect(refuseProductionLedgerWriteInTest(`${prodAlias}/../run-ledger`, 'run-ledger', { NODE_ENV: 'test' }, production, production)).toBe(true);
    expect(refuseProductionLedgerWriteInTest(`${isolated}/run-ledger`, 'run-ledger', { NODE_ENV: 'test' }, production, production)).toBe(false);
    setOpsRootsForTesting([opsLike]);
    // The isolated directory itself is still writable through a plain path.
    expect(deferOutbound('body', 'ops-alert', null, `${isolated}/./q/../outbound_deferred.jsonl`)).toBe(true);
  });

  test('assertNotTestWritingOps covers the root itself and ignores siblings with a shared prefix', () => {
    expect(() => assertNotTestWritingOps(opsLike, 'probe')).toThrow(TestOpsWriteRefusedError);
    expect(() => assertNotTestWritingOps(`${opsLike}-other/x`, 'probe')).not.toThrow();
  });
});
