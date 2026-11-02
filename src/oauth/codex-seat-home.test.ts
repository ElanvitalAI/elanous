import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveTokens } from './store.js';
import { codexSeatAccountForSeat, codexSeatHomeForSeat, codexSeatLaunchEnvironment, runCodexSeatCommand, runCodexSeatHomeRefreshLoop, syncCodexSeatHome } from './codex-seat-home.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(expAt: number, account: 'team' | 'third' = 'team') {
  const root = mkdtempSync(join(tmpdir(), 'codex-seat-home-'));
  roots.push(root);
  const storePath = join(root, 'state', 'elanous', 'auth.json');
  const sourceHome = join(root, 'source', account);
  const outputRoot = join(root, 'seat-homes');
  mkdirSync(sourceHome, { recursive: true });
  const accessToken = `head.${Buffer.from(JSON.stringify({ exp: Math.floor(expAt / 1000) })).toString('base64url')}.sig`;
  const refreshToken = 'fixture-refresh-secret';
  writeFileSync(join(sourceHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    access_token: accessToken, refresh_token: refreshToken, id_token: 'fixture-id', account_id: `acct-${account}`,
  } }), { mode: 0o600 });
  saveTokens(`openai-codex:${account}`, { accessToken, refreshToken, expiresAt: expAt }, {
    authMode: 'chatgpt', codexHome: sourceHome, mirrorCodex: false,
  }, storePath);
  return { root, storePath, sourceHome, outputRoot, refreshToken };
}

describe('Codex seat home distribution', () => {
  test('applies the approved stable seat mapping and leaves default on the existing Codex home', () => {
    expect(codexSeatAccountForSeat(' TC ')).toBe('team');
    expect(codexSeatAccountForSeat('MK')).toBe('team');
    expect(codexSeatAccountForSeat('UX')).toBe('team');
    expect(codexSeatAccountForSeat('OPC')).toBe('third');
    expect(codexSeatAccountForSeat('OPT')).toBe('third');
    expect(codexSeatAccountForSeat('MOCKDEV')).toBe('third');
    expect(codexSeatAccountForSeat('OP')).toBe('default');
    expect(codexSeatHomeForSeat('OPC', '/tmp/codex-seat-homes')).toBe('/tmp/codex-seat-homes/third');
    expect(codexSeatHomeForSeat('OP', '/tmp/codex-seat-homes')).toBeUndefined();
    expect(codexSeatLaunchEnvironment('OP', { env: { CODEX_HOME: '/existing/default-home' } })).toEqual({
      ok: true, env: { CODEX_HOME: '/existing/default-home' },
    });
    expect(codexSeatLaunchEnvironment('OPC', { env: {}, seatHomeRoot: '/tmp/missing-seat-homes' }))
      .toMatchObject({ ok: false, kind: 'missing-mirror' });
  });

  test('installs access-only auth atomically with restrictive permissions and never refreshes default', async () => {
    const now = Date.now();
    const f = fixture(now + 60 * 60 * 1000);
    const result = await syncCodexSeatHome('team', {
      storePath: f.storePath, seatHomeRoot: f.outputRoot, now: () => now, ownerLeaseHeld: () => true,
    });
    expect(result).toMatchObject({ ok: true, account: 'team', refreshed: false });
    if (!result.ok) return;
    const auth = readFileSync(result.path, 'utf8');
    const parsed = JSON.parse(auth);
    expect(parsed.tokens.refresh_token).toBe('');
    expect(parsed.tokens.refreshToken).toBe('');
    expect(auth).not.toContain(f.refreshToken);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(statSync(f.outputRoot).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.outputRoot, 'team')).mode & 0o777).toBe(0o700);
    let refreshCalls = 0;
    const refused = await syncCodexSeatHome('default', {
      storePath: f.storePath, seatHomeRoot: f.outputRoot, ownerLeaseHeld: () => true,
      refresh: async () => { refreshCalls++; return { ok: true }; },
    });
    expect(refused).toMatchObject({ ok: false, kind: 'bad-account' });
    expect(refreshCalls).toBe(0);
  });

  test('launch rejects a mirror containing the camelCase refresh credential alias', async () => {
    const now = Date.now();
    const f = fixture(now + 60 * 60 * 1000);
    const result = await syncCodexSeatHome('team', {
      storePath: f.storePath, seatHomeRoot: f.outputRoot, now: () => now, ownerLeaseHeld: () => true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(readFileSync(result.path, 'utf8'));
    parsed.tokens.refreshToken = 'refresh-alias-secret';
    writeFileSync(result.path, JSON.stringify(parsed), { mode: 0o600 });
    expect(codexSeatLaunchEnvironment('TC', { seatHomeRoot: f.outputRoot, now }))
      .toMatchObject({ ok: false, kind: 'invalid-mirror' });
  });

  test('launch refuses a JSON null mirror as invalid instead of throwing', async () => {
    const now = Date.now();
    const f = fixture(now + 60 * 60 * 1000);
    const result = await syncCodexSeatHome('team', {
      storePath: f.storePath, seatHomeRoot: f.outputRoot, now: () => now, ownerLeaseHeld: () => true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    writeFileSync(result.path, 'null', { mode: 0o600 });
    expect(codexSeatLaunchEnvironment('TC', { seatHomeRoot: f.outputRoot, now }))
      .toMatchObject({ ok: false, kind: 'invalid-mirror' });
  });

  test('refuses to refresh or distribute when the owner lease is absent', async () => {
    const f = fixture(Date.now() + 60 * 60 * 1000);
    const result = await syncCodexSeatHome('team', {
      storePath: f.storePath, seatHomeRoot: f.outputRoot, ownerLeaseHeld: () => false,
    });
    expect(result).toMatchObject({ ok: false, kind: 'owner-lease-lost' });
    expect(() => readFileSync(join(f.outputRoot, 'team', 'auth.json'))).toThrow();
  });

  test('near-expiry refreshes the named source then updates the mirror without stopping a live session', async () => {
    let now = Date.now();
    const f = fixture(now + 2 * 60 * 1000);
    let refreshCalls = 0;
    const session = { state: 'running' as 'running' | 'stopped' };
    let sessionActiveDuringRefresh = false;
    const refresh = async () => {
      refreshCalls++;
      sessionActiveDuringRefresh = session.state === 'running';
      now += 1000;
      const accessToken = `head.${Buffer.from(JSON.stringify({ exp: Math.floor((now + 60 * 60 * 1000) / 1000) })).toString('base64url')}.sig`;
      const source = join(f.sourceHome, 'auth.json');
      const prior = JSON.parse(readFileSync(source, 'utf8'));
      writeFileSync(source, JSON.stringify({ ...prior, tokens: { ...prior.tokens, access_token: accessToken, refresh_token: 'rotated-refresh-secret' } }), { mode: 0o600 });
      saveTokens('openai-codex:team', { accessToken, refreshToken: 'rotated-refresh-secret', expiresAt: now + 60 * 60 * 1000 }, {
        authMode: 'chatgpt', codexHome: f.sourceHome, mirrorCodex: false,
      }, f.storePath);
      return { ok: true };
    };
    const result = await syncCodexSeatHome('team', {
      storePath: f.storePath, seatHomeRoot: f.outputRoot, now: () => now, ownerLeaseHeld: () => true, refresh,
    });
    expect(result).toMatchObject({ ok: true, refreshed: true });
    expect(refreshCalls).toBe(1);
    expect(sessionActiveDuringRefresh).toBe(true);
    const mirrored = JSON.parse(readFileSync(join(f.outputRoot, 'team', 'auth.json'), 'utf8'));
    expect(mirrored.tokens.refresh_token).toBe('');
    expect(readFileSync(join(f.outputRoot, 'team', 'auth.json'), 'utf8')).not.toContain('rotated-refresh-secret');
    // The updater only swaps the auth snapshot; the mock running session lifecycle has no stop/restart transition.
    expect(session.state).toBe('running');
  });

  test('launch starts a real Codex child with the mapped home and refresh leaves that process alive', async () => {
    let now = Date.now();
    const f = fixture(now + 60 * 60 * 1000);
    const firstSync = await syncCodexSeatHome('team', {
      storePath: f.storePath, seatHomeRoot: f.outputRoot, now: () => now, ownerLeaseHeld: () => true,
    });
    expect(firstSync.ok).toBe(true);
    const nearExpiryToken = `head.${Buffer.from(JSON.stringify({ exp: Math.floor((now + 2 * 60 * 1000) / 1000) })).toString('base64url')}.sig`;
    const source = join(f.sourceHome, 'auth.json');
    const sourceAuth = JSON.parse(readFileSync(source, 'utf8'));
    writeFileSync(source, JSON.stringify({ ...sourceAuth, tokens: { ...sourceAuth.tokens, access_token: nearExpiryToken } }), { mode: 0o600 });
    saveTokens('openai-codex:team', { accessToken: nearExpiryToken, refreshToken: f.refreshToken, expiresAt: now + 2 * 60 * 1000 }, {
      authMode: 'chatgpt', codexHome: f.sourceHome, mirrorCodex: false,
    }, f.storePath);
    const marker = join(f.root, 'child');
    const binDir = join(f.root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const fakeCodex = join(binDir, 'codex');
    writeFileSync(fakeCodex, `#!/bin/sh\nprintf '%s\\n' "$CODEX_HOME" "$$" "$@" > "$CODEX_SEAT_MARKER.before"\nwhile [ ! -f "$CODEX_SEAT_MARKER.continue" ]; do sleep 0.02; done\nprintf '%s\\n' "$CODEX_HOME" "$$" "$@" > "$CODEX_SEAT_MARKER.after"\n`, { mode: 0o755 });
    let child: ChildProcess | undefined;
    let processAliveDuringRefresh = false;
    const launchPromise = runCodexSeatCommand('TC', ['-p', 'seat launch argument'], {
      env: { ...process.env, CODEX_HOME: '/old/default-codex-home', PATH: `${binDir}:${process.env.PATH ?? ''}`, CODEX_SEAT_MARKER: marker }, seatHomeRoot: f.outputRoot, now,
      onSpawn: (started) => { child = started; },
    });
    for (let i = 0; i < 100 && !existsSync(`${marker}.before`); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(`${marker}.before`)).toBe(true);
    const before = readFileSync(`${marker}.before`, 'utf8').trim().split('\n');
    expect(before[0]).toBe(join(f.outputRoot, 'team'));
    expect(before[1]).toMatch(/^\d+$/);
    expect(before.slice(2)).toEqual(['-p', 'seat launch argument']);
    const refreshed = await syncCodexSeatHome('team', {
      storePath: f.storePath, seatHomeRoot: f.outputRoot, now: () => now, ownerLeaseHeld: () => true,
      refresh: async () => {
        processAliveDuringRefresh = !!child?.pid && child.exitCode === null;
        const prior = JSON.parse(readFileSync(source, 'utf8'));
        const accessToken = `head.${Buffer.from(JSON.stringify({ exp: Math.floor((now + 60 * 60 * 1000) / 1000) })).toString('base64url')}.sig`;
        writeFileSync(source, JSON.stringify({ ...prior, tokens: { ...prior.tokens, access_token: accessToken, refresh_token: 'rotated-refresh-secret' } }), { mode: 0o600 });
        saveTokens('openai-codex:team', { accessToken, refreshToken: 'rotated-refresh-secret', expiresAt: now + 60 * 60 * 1000 }, {
          authMode: 'chatgpt', codexHome: f.sourceHome, mirrorCodex: false,
        }, f.storePath);
        return { ok: true };
      },
    });
    expect(refreshed).toMatchObject({ ok: true, refreshed: true });
    expect(processAliveDuringRefresh).toBe(true);
    expect(!!child?.pid && child.exitCode === null).toBe(true);
    const mirrorAfterRefresh = JSON.parse(readFileSync(join(f.outputRoot, 'team', 'auth.json'), 'utf8'));
    expect(mirrorAfterRefresh.tokens.access_token).toContain(Buffer.from(JSON.stringify({ exp: Math.floor((now + 60 * 60 * 1000) / 1000) })).toString('base64url'));
    writeFileSync(`${marker}.continue`, 'continue');
    expect(await launchPromise).toEqual({ ok: true, exitCode: 0 });
    const after = readFileSync(`${marker}.after`, 'utf8').trim().split('\n');
    expect(after).toEqual(before);
  });

  test('periodic loop keeps scanning named accounts until asked to stop', async () => {
    let now = Date.now();
    const f = fixture(now + 60 * 60 * 1000);
    let polls = 0;
    let stopped = false;
    await runCodexSeatHomeRefreshLoop(['team'], {
      storePath: f.storePath, seatHomeRoot: f.outputRoot, now: () => now, ownerLeaseHeld: () => true,
      pollMs: 10_000,
      sleep: async () => { polls++; now += 10_000; if (polls === 2) stopped = true; },
      shouldStop: () => stopped,
    });
    expect(polls).toBe(2);
    expect(readFileSync(join(f.outputRoot, 'team', 'auth.json'), 'utf8')).toContain('fixture-id');
  });
});
