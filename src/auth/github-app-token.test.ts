import { afterEach, describe, expect, it, spyOn, test } from 'bun:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { defaultCmdRunner } from '../autopilot/pr-manager.js';
import { coalescedInstallationCredential, githubAutomationToken, githubInstallationCredential } from './github-app-token.js';

const originalGhToken = process.env.GH_TOKEN;
const originalPath = process.env.PATH;
const originalConfigDir = getElanousConfigDirOverride();
const directories: string[] = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'github-app-test-'));
  directories.push(dir);
  const configDir = join(dir, 'secrets', 'github-app');
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, 'app.json');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(configPath, JSON.stringify({
    id: 5117269, installation_id: 166020594,
    pem: '5117269.pem',
  }), { mode: 0o600 });
  writeFileSync(join(configDir, '5117269.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  setElanousConfigDir(dir);
  return { dir, configPath, publicKey };
}

afterEach(() => {
  if (originalGhToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = originalGhToken;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  resetElanousConfigDir();
  if (originalConfigDir) setElanousConfigDir(originalConfigDir);
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('githubAutomationToken + defaultCmdRunner', () => {
  it('빈 캐시에서 기본 curl 발급 경로를 거쳐 gh에 토큰을 전하고 두 번째 gh는 캐시를 쓴다', () => {
    const { dir, publicKey } = fixture();
    delete process.env.GH_TOKEN;
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const curl = join(bin, 'curl');
    const gh = join(bin, 'gh');
    const request = join(dir, 'curl-request');
    const curlArgs = join(dir, 'curl-args');
    const count = join(dir, 'curl-count');
    const captured = join(dir, 'gh-token');
    const ghArgs = join(dir, 'gh-args');
    const expiry = new Date(Date.now() + 60 * 60_000).toISOString();
    writeFileSync(curl, `#!/bin/sh\ncat > '${request}'\nprintf '%s\\n' "$*" > '${curlArgs}'\nprintf 'call\\n' >> '${count}'\nprintf '%s\\n' '${JSON.stringify({ token: 'ghs_test', expires_at: expiry })}'\n`);
    writeFileSync(gh, `#!/bin/sh\nprintf '%s' "\${GH_TOKEN-unset}" > '${captured}'\nprintf '%s' "$*" > '${ghArgs}'\nprintf 'done\\n'\n`);
    chmodSync(curl, 0o700);
    chmodSync(gh, 0o700);
    process.env.PATH = `${bin}:${originalPath ?? ''}`;

    const run = () => defaultCmdRunner('gh', ['pr', 'list'], { cwd: dir });
    expect(run()).toEqual({ ok: true, out: 'done', err: '' });
    expect(readFileSync(ghArgs, 'utf8')).toBe('pr list');
    expect(readFileSync(captured, 'utf8')).toBe('ghs_test');
    expect(readFileSync(curlArgs, 'utf8')).toContain('POST');
    expect(readFileSync(curlArgs, 'utf8')).toContain('https://api.github.com/app/installations/166020594/access_tokens');
    const input = readFileSync(request, 'utf8');
    const jwt = /^Authorization: Bearer ([^\n]+)\n$/.exec(input)?.[1];
    expect(jwt).toBeDefined();
    const [header, payload, signature] = jwt!.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString()).alg).toBe('RS256');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(claims.iss).toBe('5117269');
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    expect(run()).toEqual({ ok: true, out: 'done', err: '' });
    expect(readFileSync(captured, 'utf8')).toBe('ghs_test');
    expect(readFileSync(count, 'utf8')).toBe('call\n');
  });

  it('RS256 JWT로 설치 토큰을 한 번 받고 캐시한 값을 gh에만 전한다; 기존 GH_TOKEN 우선·설정 부재는 무변', () => {
    const { dir, configPath, publicKey } = fixture();
    delete process.env.GH_TOKEN;
    const now = Date.now();
    const expiry = new Date(now + 60 * 60_000).toISOString();
    const calls: string[] = [];
    const fetch = (url: string, jwt: string) => {
      expect(url).toBe('https://api.github.com/app/installations/166020594/access_tokens');
      calls.push(jwt);
      return { token: 'ghs_test', expires_at: expiry };
    };
    const first = githubAutomationToken({ configPath, fetch, now: () => now });
    const second = githubAutomationToken({ configPath, fetch, now: () => now + 1000 });
    expect([first, second]).toEqual(['ghs_test', 'ghs_test']);
    expect(calls).toHaveLength(1);
    const [header, payload, signature] = calls[0]!.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toMatchObject({ alg: 'RS256' });
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(claims.iss).toBe('5117269');
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);

    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const gh = join(bin, 'gh');
    const captured = join(dir, 'gh-token');
    const args = join(dir, 'gh-args');
    writeFileSync(gh, `#!/bin/sh\nprintf '%s' "\${GH_TOKEN-unset}" > '${captured}'\nprintf '%s' "$*" > '${args}'\nprintf ' done\\n'\nprintf 'warning\\n' >&2\n`);
    chmodSync(gh, 0o700);
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    const result = defaultCmdRunner('gh', ['pr', 'list'], { cwd: dir });
    expect(result).toEqual({ ok: true, out: 'done', err: 'warning' });
    expect(readFileSync(args, 'utf8')).toBe('pr list');
    expect(readFileSync(captured, 'utf8')).toBe('ghs_test');
    expect(calls).toHaveLength(1);

    process.env.GH_TOKEN = 'caller-token';
    expect(defaultCmdRunner('gh', ['pr', 'list'])).toEqual(result);
    expect(readFileSync(captured, 'utf8')).toBe('caller-token');
    delete process.env.GH_TOKEN;
    unlinkSync(configPath);
    expect(githubAutomationToken({ configPath, fetch })).toBeNull();
    expect(defaultCmdRunner('gh', ['pr', 'list'])).toEqual(result);
    expect(readFileSync(captured, 'utf8')).toBe('unset');
    expect(calls).toHaveLength(1);
    const noAppOptions = { encoding: 'utf-8', timeout: 120_000, env: process.env, cwd: dir } as const;
    const direct = spawnSync('gh', ['pr', 'list'], noAppOptions);
    expect(defaultCmdRunner('gh', ['pr', 'list'], { cwd: dir })).toEqual({
      ok: direct.status === 0, out: (direct.stdout ?? '').trim(), err: (direct.stderr ?? '').trim(),
    });
    expect(readFileSync(captured, 'utf8')).toBe('unset');
  });

  it('installation credential preserves GitHub expiry and mints fresh for each scoped request', () => {
    const { configPath } = fixture();
    const now = Date.now();
    const expires_at = new Date(now + 60 * 60_000).toISOString();
    let calls = 0;
    const deps = { configPath, now: () => now, scope: { repository: 'repo-one' }, fetch: (_url: string, _jwt: string, body?: unknown) => {
      expect(body).toEqual({ repositories: ['repo-one'], permissions: { contents: 'write', pull_requests: 'write' } });
      return { token: `new-${++calls}`, expires_at };
    } };
    expect(githubInstallationCredential(deps)).toEqual({ token: 'new-1', expires_at });
    expect(githubInstallationCredential(deps)).toEqual({ token: 'new-2', expires_at });
    expect(calls).toBe(2);
  });

  it('repository scope sends only one repository and contents/write + pull_requests/write, without reusing an unscoped token', () => {
    const { configPath } = fixture();
    const now = Date.now();
    const requests: unknown[] = [];
    const fetch = (_url: string, _jwt: string, body?: unknown) => {
      requests.push(body);
      return { token: `ghs_${requests.length}`, expires_at: new Date(now + 60 * 60_000).toISOString() };
    };
    const base = { configPath, now: () => now, fetch };
    expect(githubAutomationToken(base)).toBe('ghs_1');
    expect(githubAutomationToken({ ...base, scope: { repository: 'repo-one' } })).toBe('ghs_2');
    expect(githubAutomationToken({ ...base, scope: { repository: 'repo-two' } })).toBe('ghs_3');
    expect(githubAutomationToken({ ...base, scope: { repository: 'repo-one' } })).toBe('ghs_4');
    expect(githubAutomationToken(base)).toBe('ghs_1');
    expect(requests).toEqual([
      undefined,
      { repositories: ['repo-one'], permissions: { contents: 'write', pull_requests: 'write' } },
      { repositories: ['repo-two'], permissions: { contents: 'write', pull_requests: 'write' } },
      { repositories: ['repo-one'], permissions: { contents: 'write', pull_requests: 'write' } },
    ]);
    expect(githubAutomationToken({ ...base, scope: { repository: '../repo' } })).toBeNull();
    expect(requests).toHaveLength(4);
    expect(githubAutomationToken({ ...base, scope: { repository: 'repo-one' }, fetch: () => { throw new Error('mint-failed'); } })).toBeNull();
    expect(githubAutomationToken(base)).toBe('ghs_1');
  });

  it('default curl sends the scoped JSON request, while unscoped curl stays body-free', () => {
    const { dir, configPath } = fixture();
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const curl = join(bin, 'curl');
    const argsPath = join(dir, 'curl-args');
    const expiry = new Date(Date.now() + 60 * 60_000).toISOString();
    writeFileSync(curl, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsPath}'\ncat >/dev/null\nprintf '%s\\n' '${JSON.stringify({ token: 'ghs_scoped', expires_at: expiry })}'\n`);
    chmodSync(curl, 0o700);
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    expect(githubAutomationToken({ configPath, scope: { repository: 'repo-one' } })).toBe('ghs_scoped');
    const args = readFileSync(argsPath, 'utf8').trim().split('\n');
    expect(args[args.indexOf('--data-raw') + 1]).toBe(JSON.stringify({
      repositories: ['repo-one'], permissions: { contents: 'write', pull_requests: 'write' },
    }));
    expect(args).toContain('Content-Type: application/json');
    expect(githubAutomationToken({ configPath })).toBe('ghs_scoped');
    expect(readFileSync(argsPath, 'utf8')).not.toContain('--data-raw');
  });

  it('같은 경로에서 App ID·설치 ID·PEM이 교체되면 만료 전 캐시를 버린다', () => {
    const { configPath } = fixture();
    const pemPath = join(configPath, '..', '5117269.pem');
    const now = Date.now();
    const requests: { url: string; iss: string; jwt: string }[] = [];
    const fetch = (url: string, jwt: string) => {
      const iss = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()).iss as string;
      requests.push({ url, iss, jwt });
      return { token: `ghs_${requests.length}`, expires_at: new Date(now + 60 * 60_000).toISOString() };
    };
    const get = () => githubAutomationToken({ configPath, now: () => now, fetch });
    expect(get()).toBe('ghs_1');
    expect(get()).toBe('ghs_1');
    writeFileSync(configPath, JSON.stringify({ id: 5117270, installation_id: 166020594, pem: '5117269.pem' }));
    expect(get()).toBe('ghs_2');
    expect(requests[1]?.iss).toBe('5117270');
    writeFileSync(configPath, JSON.stringify({ id: 5117270, installation_id: 166020595, pem: '5117269.pem' }));
    expect(get()).toBe('ghs_3');
    expect(requests[2]?.url).toBe('https://api.github.com/app/installations/166020595/access_tokens');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(pemPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
    expect(get()).toBe('ghs_4');
    expect(requests[3]?.jwt).not.toBe(requests[2]?.jwt);
    expect(get()).toBe('ghs_4');
    expect(requests).toHaveLength(4);
    unlinkSync(pemPath);
    expect(get()).toBeNull();
    expect(requests).toHaveLength(4);
  });

  it('설정이 없는 기계에서 git 명령도 원래 환경과 인자·결과를 유지한다', () => {
    const { dir, configPath } = fixture();
    unlinkSync(configPath);
    delete process.env.GH_TOKEN;
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const git = join(bin, 'git');
    writeFileSync(git, '#!/bin/sh\nprintf "%s|%s\\n" "$*" "${GH_TOKEN-unset}"\n');
    chmodSync(git, 0o700);
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    const direct = spawnSync('git', ['status', '--short'], { encoding: 'utf-8', timeout: 120_000, env: process.env, cwd: dir });
    expect(defaultCmdRunner('git', ['status', '--short'], { cwd: dir })).toEqual({
      ok: direct.status === 0, out: (direct.stdout ?? '').trim(), err: (direct.stderr ?? '').trim(),
    });
    expect(direct.stdout.trim()).toBe('status --short|unset');
  });

  it('만료 10분 전 다시 발급하고 실패 시 자격값이나 예외를 로그·오류로 노출하지 않는다', () => {
    const { configPath } = fixture();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const now = Date.now();
      let count = 0;
      const fetch = () => ({ token: `secret-${++count}`, expires_at: new Date(now + (count === 1 ? 60 : 110) * 60_000).toISOString() });
      expect(githubAutomationToken({ configPath, now: () => now, fetch })).toBe('secret-1');
      expect(githubAutomationToken({ configPath, now: () => now + 49 * 60_000, fetch })).toBe('secret-1');
      expect(count).toBe(1);
      expect(githubAutomationToken({ configPath, now: () => now + 50 * 60_000, fetch })).toBe('secret-2');
      expect(githubAutomationToken({ configPath, now: () => now + 51 * 60_000, fetch })).toBe('secret-2');
      expect(count).toBe(2);
      expect(log).toHaveBeenCalledWith('auth.github-app', 'token-minted', {
        installationId: 166020594, expiresAt: new Date(now + 60 * 60_000).toISOString(),
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret-');
      expect(githubAutomationToken({ configPath, now: () => now + 101 * 60_000, fetch: () => { throw new Error('secret-throw'); } })).toBeNull();
      expect(log).toHaveBeenCalledWith('auth.github-app', 'token-failed', { reason: 'mint-failed' });
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret-throw');
      writeFileSync(configPath, '{broken', { mode: 0o600 });
      expect(githubAutomationToken({ configPath, fetch })).toBeNull();
      writeFileSync(configPath, JSON.stringify({ id: 5117269, installation_id: 166020594, pem: 'missing.pem' }));
      expect(githubAutomationToken({ configPath, fetch })).toBeNull();
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret-');
    } finally { log.mockRestore(); }
  });
});

describe('test runs never reach the machine App key', () => {
  test('the bun test preload pins the App config to a missing file, so a default call mints nothing', () => {
    const pinned = process.env.ELANOUS_GITHUB_APP_CONFIG_PATH;
    expect(pinned).toBeTruthy();
    expect(existsSync(pinned!)).toBe(false);
    let called = 0;
    expect(githubInstallationCredential({ fetch: () => { called += 1; return {}; } })).toBeNull();
    expect(called).toBe(0);
  });

  test('ELANOUS_GITHUB_APP_CONFIG_PATH is the file the default call reads', () => {
    const { configPath } = fixture();
    const before = process.env.ELANOUS_GITHUB_APP_CONFIG_PATH;
    process.env.ELANOUS_GITHUB_APP_CONFIG_PATH = configPath;
    try {
      const minted = githubInstallationCredential({ scope: { repository: 'repo-env' }, fetch: () => ({ token: 'ghs_env', expires_at: new Date(Date.now() + 3600_000).toISOString() }) });
      expect(minted?.token).toBe('ghs_env');
    } finally { process.env.ELANOUS_GITHUB_APP_CONFIG_PATH = before; }
  });
});

describe('PODCRED1 coalesced scoped issuance', () => {
  const T0 = Date.parse('2026-10-05T12:49:34Z');
  const fresh = (n: number, now = T0) => ({ token: `ghs_coalesced_${n}`, expires_at: new Date(now + 60 * 60_000).toISOString() });

  test('repeated issuers in one process within the window mint once and share the result (cross-process concurrency: next test)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-coalesce-'));
    try {
      let mints = 0;
      const results = await Promise.all(Array.from({ length: 6 }, () => Promise.resolve().then(() =>
        coalescedInstallationCredential({ repository: 'elanous-agent' }, { cacheDir: dir, now: () => T0, mint: () => fresh(++mints) }))));
      expect(mints).toBe(1);
      expect(new Set(results.map((r) => r?.token))).toEqual(new Set(['ghs_coalesced_1']));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('separate processes coalesce through the shared lock and cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-coalesce-proc-'));
    const counter = join(dir, 'mints.log');
    const script = `const { coalescedInstallationCredential } = await import(${JSON.stringify(join(import.meta.dir, 'github-app-token.ts'))});
const fs = await import('node:fs');
const r = coalescedInstallationCredential({ repository: 'elanous-agent' }, { cacheDir: ${JSON.stringify(dir)}, mint: () => {
  fs.appendFileSync(${JSON.stringify(counter)}, 'm\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  return { token: 'ghs_proc_' + process.pid, expires_at: new Date(Date.now() + 3600_000).toISOString() }; } });
process.stdout.write(r ? 'ok' : 'null');`;
    try {
      const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' }));
      const texts = await Promise.all(children.map(async (c) => { await c.exited; return new Response(c.stdout).text(); }));
      expect(texts).toEqual(['ok', 'ok', 'ok', 'ok']);
      expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('an old or short-lived cached token is not reused — a new one is minted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-coalesce-old-'));
    try {
      let mints = 0;
      let t = T0;
      const call = () => coalescedInstallationCredential({ repository: 'elanous-agent' }, { cacheDir: dir, now: () => t, mint: () => fresh(++mints, t) });
      expect(call()?.token).toBe('ghs_coalesced_1');
      t = T0 + 121_000;
      expect(call()?.token).toBe('ghs_coalesced_2');
      expect(mints).toBe(2);
      // A recent entry whose remaining life is below the floor is not reused either.
      expect(coalescedInstallationCredential({ repository: 'elanous-agent' }, { cacheDir: dir, now: () => t + 15 * 60_000, windowMs: 3600_000, mint: () => fresh(++mints, t) })?.token).toBe('ghs_coalesced_3');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a stale lock left by a dead issuer does not block issuance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-coalesce-stale-'));
    try {
      mkdirSync(dir, { recursive: true });
      const key = new Bun.CryptoHasher('sha256').update('injected\0elanous-agent').digest('hex').slice(0, 32);
      mkdirSync(join(dir, `${key}.lock`));
      let mints = 0;
      const r = coalescedInstallationCredential({ repository: 'elanous-agent' }, { cacheDir: dir, now: () => Date.now() + 60_000, sleepSync: () => {}, mint: () => fresh(++mints) });
      expect(r?.token).toBe('ghs_coalesced_1');
      expect(existsSync(join(dir, `${key}.lock`))).toBe(false);
      expect(spawnSync('ls', ['-a', dir], { encoding: 'utf8' }).stdout.split('\n').filter((name) => name.endsWith('.lock'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('the cache file is private and observations never carry the token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-coalesce-private-'));
    const logged: string[] = [];
    const off = debug.registerSink({ name: 'gh-coalesce-private', emit: (record) => { if (record.category === 'auth.github-app') logged.push(JSON.stringify(record)); } });
    try {
      coalescedInstallationCredential({ repository: 'elanous-agent' }, { cacheDir: dir, now: () => T0, mint: () => fresh(1) });
      coalescedInstallationCredential({ repository: 'elanous-agent' }, { cacheDir: dir, now: () => T0, mint: () => fresh(2) });
      const file = spawnSync('ls', ['-l', dir], { encoding: 'utf8' }).stdout.split('\n').find((l) => l.endsWith('.json'));
      expect(file?.startsWith('-rw-------')).toBe(true);
      expect(logged.some((l) => l.includes('token-coalesced'))).toBe(true);
      expect(logged.join('\n')).not.toContain('ghs_coalesced');
    } finally { off(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('a test process without an explicit cache dir never coalesces through the operational root', () => {
    expect(process.env.NODE_ENV === 'test' || Boolean(process.env.ELANOUS_TEST_HOME)).toBe(true);
    let mints = 0;
    coalescedInstallationCredential({ repository: 'elanous-agent' }, { now: () => T0, mint: () => fresh(++mints) });
    coalescedInstallationCredential({ repository: 'elanous-agent' }, { now: () => T0, mint: () => fresh(++mints) });
    expect(mints).toBe(2);
  });

  test('fresh skips reuse but publishes the new token for later issuers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-coalesce-fresh-'));
    try {
      let mints = 0;
      const call = (f?: boolean) => coalescedInstallationCredential({ repository: 'elanous-agent' }, { cacheDir: dir, fresh: f, now: () => T0, mint: () => fresh(++mints) })?.token;
      expect(call()).toBe('ghs_coalesced_1');
      expect(call(true)).toBe('ghs_coalesced_2');
      expect(call()).toBe('ghs_coalesced_2');
      expect(mints).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
