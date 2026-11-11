import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { collectProviderAccessMirrors } from './provider-access-mirror.js';
import { installRemoteCodexCliMirror, installRemoteProviderAccessMirrors } from '../task-agent/parent-host.js';
import { refreshGrokSubscriptionToken, resolveGrokCredential } from '../grok/credential.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('fake Grok and Claude auth files yield only fresh access and no refresh', () => {
  const home = mkdtempSync(join(tmpdir(), 'oauth-provider-mirror-')); roots.push(home);
  mkdirSync(join(home, '.grok')); mkdirSync(join(home, '.claude'));
  const now = 2_000_000_000_000;
  writeFileSync(join(home, '.grok', 'auth.json'), JSON.stringify({
    stale: { key: 'stale', expires_at: new Date(now + 60_000).toISOString(), refresh_token: 'never-copy' },
    fresh: { key: 'grok-access', expires_at: new Date(now + 3 * 60 * 60_000).toISOString(), refresh_token: 'never-copy', user_id: 'u' },
  }));
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'claude-access', refreshToken: 'never-copy', expiresAt: now + 4 * 60 * 60_000, scopes: ['user:inference'] },
  }));
  const mirrors = collectProviderAccessMirrors({ home, now });
  expect(mirrors.map((m) => m.provider)).toEqual(['grok', 'claude']);
  expect(JSON.stringify(mirrors)).not.toContain('never-copy');
  const calls: string[] = [];
  installRemoteProviderAccessMirrors({ host: 'fixture', cwd: '/tmp' }, mirrors, (_host, _script, _timeout, stdin) => {
    calls.push(stdin ?? ''); return { status: 0, stdout: '', stderr: '' };
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).not.toContain('never-copy');
  expect(collectProviderAccessMirrors({ home, now: now + 3 * 60 * 60_000 }).map((m) => m.provider)).toEqual([]);
});

test('remote installer writes only access to provider homes and mirror store', () => {
  const remoteHome = mkdtempSync(join(tmpdir(), 'oauth-provider-remote-')); roots.push(remoteHome);
  const expiresAt = Date.now() + 3 * 60 * 60_000;
  const mirrors = [
    { provider: 'grok', access: 'grok-access', expiresAt },
    { provider: 'claude', access: 'claude-access', expiresAt },
  ] as const;
  const shell = (_host: string, script: string, _timeout: number, stdin?: string) => {
    const result = spawnSync('/bin/sh', ['-c', script], { env: { ...process.env, HOME: remoteHome }, input: stdin, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  installRemoteProviderAccessMirrors({ host: 'fixture', cwd: '/tmp' }, mirrors, shell);
  const file = (parts: string[]) => readFileSync(join(remoteHome, ...parts), 'utf8');
  const grok = file(['.grok', 'auth.json']);
  const claude = file(['.claude', '.credentials.json']);
  const store = file(['.elanous', 'remote-parent-credentials', 'cli-mirror', 'auth.json']);
  for (const body of [grok, claude, store]) expect(body).not.toContain('never-copy');
  expect(JSON.parse(grok)['https://auth.x.ai::hq-mirror'].refresh_token).toBe('');
  expect(JSON.parse(claude).claudeAiOauth.refreshToken).toBe('');
  expect(JSON.parse(store).providers.anthropic.source).toBe('mirror');
  const storePath = join(remoteHome, '.elanous', 'remote-parent-credentials', 'cli-mirror', 'auth.json');
  writeFileSync(storePath, JSON.stringify({ ...JSON.parse(store), version: 7 }));
  const staleLock = join(remoteHome, '.elanous', 'remote-parent-credentials', 'cli-mirror', 'remote-codex-mirror.lock');
  writeFileSync(staleLock, 'dead'); utimesSync(staleLock, new Date(0), new Date(0));
  installRemoteProviderAccessMirrors({ host: 'fixture', cwd: '/tmp' }, mirrors, shell);
  expect(JSON.parse(readFileSync(storePath, 'utf8')).version).toBe(7);
  expect(existsSync(staleLock)).toBe(false);
  const reusedPidGuard = `${staleLock}.guard`;
  writeFileSync(reusedPidGuard, JSON.stringify({ pid: process.pid, startedAt: 1, nonce: 'old-process' }));
  utimesSync(reusedPidGuard, new Date(0), new Date(0));
  installRemoteProviderAccessMirrors({ host: 'fixture', cwd: '/tmp' }, mirrors, shell);
  expect(readFileSync(reusedPidGuard, 'utf8')).toBe('flock-v2');
  let refreshCalls = 0;
  expect(refreshGrokSubscriptionToken({ home: remoteHome, execImpl: () => { refreshCalls++; } })).toBe('no-credential');
  expect(refreshCalls).toBe(0);
  writeFileSync(join(remoteHome, '.grok', 'auth.json'), JSON.stringify({
    'https://auth.x.ai::hq-mirror': { key: 'grok-access', expires_at: new Date(Date.now() + 60_000).toISOString(), refresh_token: '' },
  }));
  expect(resolveGrokCredential({ home: remoteHome, env: {} as NodeJS.ProcessEnv })).toBeNull();
});

test('concurrent Codex and provider pushes reclaim one stale lock and preserve a coherent store', async () => {
  const remoteHome = mkdtempSync(join(tmpdir(), 'oauth-mirror-race-')); roots.push(remoteHome);
  const dir = join(remoteHome, '.elanous', 'remote-parent-credentials', 'cli-mirror');
  mkdirSync(dir, { recursive: true });
  const staleLock = join(dir, 'remote-codex-mirror.lock');
  writeFileSync(staleLock, JSON.stringify({ pid: 999999999, startedAt: 1, nonce: 'dead' }));
  utimesSync(staleLock, new Date(0), new Date(0));
  const guard = `${staleLock}.guard`;
  const holder = spawn('bun', ['-e', `const fs=require('node:fs');fs.writeFileSync(process.env.MIRROR_GUARD,JSON.stringify({pid:process.pid,startedAt:Date.now(),nonce:'old-holder'}),{flag:'wx'});process.stdout.write('held\\n');setInterval(()=>{},1000)`],
    { env: { ...process.env, MIRROR_GUARD: guard }, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve, reject) => { holder.stdout.once('data', () => resolve()); holder.once('error', reject); });
  holder.kill('SIGKILL');
  await new Promise<void>((resolve) => holder.once('close', () => resolve()));
  expect(existsSync(guard)).toBe(true);
  const jobs: Array<{ script: string; stdin: string }> = [];
  const capture = (_host: string, script: string, _timeout: number, stdin?: string) => {
    jobs.push({ script, stdin: stdin ?? '' }); return { status: 0, stdout: '', stderr: '' };
  };
  const target = { host: 'fixture', cwd: '/tmp' };
  for (const suffix of ['a', 'b']) {
    installRemoteCodexCliMirror(target, [{ account: 'team',
      elanousAuth: JSON.stringify({ version: 1, providers: { 'openai-codex': { authMode: 'chatgpt', tokens: { accessToken: `codex-${suffix}`, refreshToken: '', refresh_token: '', expiresAt: Date.now() + 4 * 60 * 60_000 } } } }),
      codexAuth: JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: `codex-${suffix}`, refresh_token: '', refreshToken: '' } }),
    }], capture);
    installRemoteProviderAccessMirrors(target, [{ provider: 'claude', access: `claude-${suffix}`, expiresAt: Date.now() + 4 * 60 * 60_000 }], capture);
  }
  const run = (job: { script: string; stdin: string }) => new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', job.script], { env: { ...process.env, HOME: remoteHome }, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`push exited ${code}: ${stderr.slice(0, 300)}`)));
    child.stdin.end(job.stdin);
  });
  await Promise.all(jobs.map(run));
  const store = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
  expect(store.providers['openai-codex:team'].source).toBe('mirror');
  expect(store.providers.anthropic.source).toBe('mirror');
  expect(store.providers['openai-codex:team'].tokens.refreshToken).toBe('');
  expect(store.providers.anthropic.tokens.refreshToken).toBe('');
  expect(readdirSync(dir).filter((name) => name === 'remote-codex-mirror.lock' || name.includes('.reap-'))).toEqual([]);
  expect(readFileSync(guard, 'utf8')).toBe('flock-v2');
});

test('new push waits on the previous version flock without replacing its inode', async () => {
  const remoteHome = mkdtempSync(join(tmpdir(), 'oauth-mirror-mixed-')); roots.push(remoteHome);
  const dir = join(remoteHome, '.elanous', 'remote-parent-credentials', 'cli-mirror');
  mkdirSync(dir, { recursive: true });
  const guard = join(dir, 'remote-codex-mirror.lock.guard');
  const old = spawn('bun', ['-e', `const fs=require('node:fs'),{dlopen,FFIType}=require('bun:ffi');const fd=fs.openSync(process.env.MIRROR_GUARD,'a+'),lib=dlopen(process.platform==='darwin'?'/usr/lib/libSystem.B.dylib':'libc.so.6',{flock:{args:[FFIType.i32,FFIType.i32],returns:FFIType.i32}});lib.symbols.flock(fd,2);process.stdout.write('held\\n');setTimeout(()=>{lib.symbols.flock(fd,8);fs.closeSync(fd);process.exit(0)},350)`],
    { env: { ...process.env, MIRROR_GUARD: guard }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => { old.stdout.once('data', () => resolve()); old.once('error', reject); });
  const guardInode = statSync(guard).ino;
  let script = '', stdin = '';
  installRemoteProviderAccessMirrors({ host: 'fixture', cwd: '/tmp' }, [{ provider: 'claude', access: 'fresh', expiresAt: Date.now() + 4 * 60 * 60_000 }],
    (_host, command, _timeout, input) => { script = command; stdin = input ?? ''; return { status: 0, stdout: '', stderr: '' }; });
  const newer = spawn('/bin/sh', ['-c', script], { env: { ...process.env, HOME: remoteHome }, stdio: ['pipe', 'ignore', 'pipe'] });
  newer.stdin.end(stdin);
  await Bun.sleep(120);
  expect(newer.exitCode).toBeNull();
  const [newCode, oldCode] = await Promise.all([
    new Promise<number | null>((resolve, reject) => { newer.once('close', resolve); newer.once('error', reject); }),
    new Promise<number | null>((resolve, reject) => { old.once('close', resolve); old.once('error', reject); }),
  ]);
  expect([newCode, oldCode]).toEqual([0, 0]);
  expect(readFileSync(guard, 'utf8')).toBe('flock-v2');
  expect(statSync(guard).ino).toBe(guardInode);
});
