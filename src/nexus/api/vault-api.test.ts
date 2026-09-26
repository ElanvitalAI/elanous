// Obsidian Vault REST 브릿지(OP0) 단위테스트 — parseVaultPath + info(무vault fallback).
import { describe, test, expect, afterEach, afterAll } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat, utimes, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetObsidianCacheForTests } from '../../acp/fs-roots.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../../elanous-config-dir.js';
import { resetUserConfig } from '../../user-config.js';
import { parseVaultPath, handleVaultGet, handleTemplateExpand, handleVaultFilePut, readVaultSnapshot, vaultWriteCaller } from './vault-api.js';
import { VaultWriteBlockedError } from '../../obsidian/vault-write-guard.js';
import { debug } from '../../debug/log.js';

const originalHome = process.env.HOME;
const originalVault = process.env.OBSIDIAN_VAULT;
const originalElanousVault = process.env.ELANOUS_OBSIDIAN_VAULT;
const configDir = await mkdtemp(join(tmpdir(), 'vault-api-config-'));
process.env.HOME = configDir;
delete process.env.OBSIDIAN_VAULT;
delete process.env.ELANOUS_OBSIDIAN_VAULT;
setElanousConfigDir(configDir);
resetUserConfig();
_resetObsidianCacheForTests();
const fixtures: string[] = [];
afterEach(async () => {
  _resetObsidianCacheForTests();
  resetUserConfig();
  process.env.HOME = configDir;
  delete process.env.OBSIDIAN_VAULT;
  delete process.env.ELANOUS_OBSIDIAN_VAULT;
  for (const dir of fixtures.splice(0)) await rm(dir, { recursive: true, force: true });
});
afterAll(async () => {
  _resetObsidianCacheForTests();
  resetElanousConfigDir();
  resetUserConfig();
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalVault === undefined) delete process.env.OBSIDIAN_VAULT; else process.env.OBSIDIAN_VAULT = originalVault;
  if (originalElanousVault === undefined) delete process.env.ELANOUS_OBSIDIAN_VAULT; else process.env.ELANOUS_OBSIDIAN_VAULT = originalElanousVault;
  await rm(configDir, { recursive: true, force: true });
});

async function vaultFixture() {
  const home = await mkdtemp(join(tmpdir(), 'vault-api-test-'));
  fixtures.push(home);
  const vault = join(home, 'vault');
  await mkdir(vault);
  process.env.HOME = home;
  process.env.OBSIDIAN_VAULT = vault;
  _resetObsidianCacheForTests();
  const put = (body: unknown) => handleVaultFilePut(new Request('http://x/v1/vault/file', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { home, vault, put };
}

describe('parseVaultPath', () => {
  test('지원 read 섹션', () => {
    for (const s of ['info', 'list', 'read', 'search', 'notes', 'backlinks', 'tags', 'templates', 'poll-changes', 'orphans', 'graph']) {
      expect(parseVaultPath(`/v1/vault/${s}`)).toBe(s);
    }
  });
  test('template-expand 는 POST 전용(GET 파싱 제외)', () => {
    expect(parseVaultPath('/v1/vault/template-expand')).toBeNull();
  });
  test('미지원/무관 → null', () => {
    expect(parseVaultPath('/v1/vault/bogus')).toBeNull();
    expect(parseVaultPath('/v1/dashboard/summary')).toBeNull();
  });
});

describe('handleVaultGet — info 계약', () => {
  test('info 는 available boolean + source 반환', async () => {
    const res = await handleVaultGet(new Request('http://x/v1/vault/info'), 'info');
    expect(res.status).toBe(200);
    const j = await res.json() as any;
    expect(typeof j.available).toBe('boolean');
    expect(typeof j.source).toBe('string');
  });
  test('OPTIONS → 204 CORS', async () => {
    const res = await handleVaultGet(new Request('http://x/v1/vault/list', { method: 'OPTIONS' }), 'list');
    expect(res.status).toBe(204);
  });
});

describe('Vault file writes in an isolated vault', () => {
  test('PUT overwrites note.md byte-for-byte; GET returns its mtime', async () => {
    const { vault, put } = await vaultFixture();
    await writeFile(join(vault, 'note.md'), 'old');
    const before = await stat(join(vault, 'note.md'));
    const content = '---\ntitle: unchanged\n---\n# 한글\n';
    const res = await put({ path: 'note.md', content, lastKnownMtime: before.mtimeMs });
    expect(res.status).toBe(200);
    expect(await readFile(join(vault, 'note.md'))).toEqual(Buffer.from(content));
    const saved = await res.json() as { path: string; mtimeMs: number };
    expect(saved.path).toBe('note.md');
    const read = await handleVaultGet(new Request('http://x/v1/vault/read?path=note.md'), 'read');
    expect(await read.json()).toMatchObject({ path: 'note.md', content, mtimeMs: saved.mtimeMs });
  });

  test('new nested note creates folders and writes raw content', async () => {
    const { vault, put } = await vaultFixture();
    expect((await put({ path: 'Daily/2026-09-26.md', content: '# today\n' })).status).toBe(200);
    expect(await readFile(join(vault, 'Daily/2026-09-26.md'), 'utf8')).toBe('# today\n');
  });

  test('create-only refuses an existing note and leaves its bytes intact', async () => {
    const { vault, put } = await vaultFixture();
    const target = join(vault, 'note.md');
    await writeFile(target, 'existing bytes');
    const res = await put({ path: 'note.md', content: 'replacement', createOnly: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'file_exists', path: 'note.md' });
    expect(await readFile(target, 'utf8')).toBe('existing bytes');
    const created = await put({ path: 'Daily/fresh.md', content: '# fresh\n', createOnly: true });
    expect(created.status).toBe(200);
    expect(await readFile(join(vault, 'Daily/fresh.md'), 'utf8')).toBe('# fresh\n');
  });

  test('simultaneous create-only requests cannot overwrite each other', async () => {
    const { vault, put } = await vaultFixture();
    const responses = await Promise.all([
      put({ path: 'Daily/same.md', content: 'first', createOnly: true }),
      put({ path: 'Daily/same.md', content: 'second', createOnly: true }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const content = await readFile(join(vault, 'Daily/same.md'), 'utf8');
    expect(['first', 'second']).toContain(content);
    const rejected = responses.find((response) => response.status === 409)!;
    expect(await rejected.json()).toEqual({ error: 'file_exists', path: 'Daily/same.md' });
  });

  test('read retries when a file changes between content and mtime observations', async () => {
    const { vault } = await vaultFixture();
    const target = join(vault, 'note.md');
    await writeFile(target, 'old content');
    let calls = 0;
    const snapshot = await readVaultSnapshot(target, async () => {
      if (++calls === 1) await writeFile(target, 'new and longer content');
    });
    expect(calls).toBe(2);
    expect(snapshot.buf.toString()).toBe('new and longer content');
    expect(snapshot.mtimeMs).toBe((await stat(target)).mtimeMs);
  });

  test('read retries a replacement between descriptor read and pathname stat', async () => {
    const { vault } = await vaultFixture();
    const target = join(vault, 'note.md');
    await writeFile(target, 'old content');
    let calls = 0;
    const snapshot = await readVaultSnapshot(target, async () => {
      if (++calls === 1) {
        const replacement = join(vault, 'replacement.md');
        await writeFile(replacement, 'replacement content');
        await rename(replacement, target);
      }
    });
    expect(calls).toBe(2);
    expect(snapshot.buf.toString()).toBe('replacement content');
    expect(snapshot.mtimeMs).toBe((await stat(target)).mtimeMs);
  });

  test('.. and absolute paths are rejected without creating files outside the vault', async () => {
    const { home, vault, put } = await vaultFixture();
    expect((await put({ path: '../escaped.md', content: 'bad' })).status).toBe(400);
    expect((await put({ path: '..\\escaped.md', content: 'bad' })).status).toBe(400);
    expect((await put({ path: join(home, 'absolute.md'), content: 'bad' })).status).toBe(400);
    expect((await put({ path: 'other.txt', content: 'bad' })).status).toBe(400);
    expect(await Bun.file(join(home, 'escaped.md')).exists()).toBe(false);
    expect(await Bun.file(join(home, 'absolute.md')).exists()).toBe(false);
    expect(await Bun.file(join(vault, 'other.txt')).exists()).toBe(false);
  });

  test('linked parent cannot redirect writes outside the vault', async () => {
    const { home, vault, put } = await vaultFixture();
    await symlink(home, join(vault, 'link'));
    expect((await put({ path: 'link/escaped.md', content: 'bad' })).status).toBe(400);
    expect(await Bun.file(join(home, 'escaped.md')).exists()).toBe(false);
  });

  test('newer disk mtime returns 409 without modifying disk', async () => {
    const { vault, put } = await vaultFixture();
    const target = join(vault, 'note.md');
    await writeFile(target, 'disk version');
    const now = Date.now();
    await utimes(target, new Date(now), new Date(now));
    const res = await put({ path: 'note.md', content: 'stale', lastKnownMtime: now - 1000 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'mtime_conflict', path: 'note.md', currentMtime: (await stat(target)).mtimeMs, lastKnownMtime: now - 1000 });
    expect(await readFile(target, 'utf8')).toBe('disk version');
  });

  test('an external edit only 2ms newer conflicts and preserves external bytes', async () => {
    const { vault, put } = await vaultFixture();
    const target = join(vault, 'note.md');
    await writeFile(target, 'prior content');
    const lastKnownMtime = Date.now() - 10_000;
    await utimes(target, new Date(lastKnownMtime), new Date(lastKnownMtime));
    await writeFile(target, 'external edit');
    await utimes(target, new Date(lastKnownMtime + 2), new Date(lastKnownMtime + 2));
    expect((await stat(target)).mtimeMs - lastKnownMtime).toBeCloseTo(2, 0);
    const res = await put({ path: 'note.md', content: 'new content', lastKnownMtime });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'mtime_conflict', path: 'note.md', lastKnownMtime });
    expect(await readFile(target, 'utf8')).toBe('external edit');
  });

  test('an older disk mtime also conflicts instead of overwriting', async () => {
    const { vault, put } = await vaultFixture();
    const target = join(vault, 'note.md');
    await writeFile(target, 'external edit');
    const lastKnownMtime = Date.now() - 10_000;
    await utimes(target, new Date(lastKnownMtime - 1000), new Date(lastKnownMtime - 1000));
    const res = await put({ path: 'note.md', content: 'stale', lastKnownMtime });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'mtime_conflict', lastKnownMtime, path: 'note.md' });
    expect(await readFile(target, 'utf8')).toBe('external edit');
  });

  test('a deleted opened note cannot be recreated by a stale editor save', async () => {
    const { vault, put } = await vaultFixture();
    const target = join(vault, 'note.md');
    await writeFile(target, 'opened');
    const lastKnownMtime = (await stat(target)).mtimeMs;
    await rm(target);
    const res = await put({ path: 'note.md', content: 'stale', lastKnownMtime });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('mtime_conflict');
    expect(await Bun.file(target).exists()).toBe(false);
  });

  test('simultaneous writes with the same observed mtime cannot both replace a note', async () => {
    const { vault, put } = await vaultFixture();
    const target = join(vault, 'note.md');
    await writeFile(target, 'original');
    const old = new Date(Date.now() - 60_000);
    await utimes(target, old, old);
    const lastKnownMtime = (await stat(target)).mtimeMs;
    const responses = await Promise.all([
      put({ path: 'note.md', content: 'first', lastKnownMtime }),
      put({ path: 'note.md', content: 'second', lastKnownMtime }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(['first', 'second']).toContain(await readFile(target, 'utf8'));
    expect((await responses.find((response) => response.status === 409)!.json()).error).toBe('mtime_conflict');
  });

  test('OPTIONS returns 204 and unavailable vault returns 503', async () => {
    const { vault } = await vaultFixture();
    expect((await handleVaultFilePut(new Request('http://x/v1/vault/file', { method: 'OPTIONS' }))).status).toBe(204);
    await rm(vault, { recursive: true });
    _resetObsidianCacheForTests();
    expect((await handleVaultFilePut(new Request('http://x/v1/vault/file', { method: 'PUT', body: '{}' }))).status).toBe(503);
  });
});

describe('handleTemplateExpand — 계약', () => {
  test('templatePath 없으면 400 (vault 있을 때)', async () => {
    const res = await handleTemplateExpand(new Request('http://x/v1/vault/template-expand', {
      method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' },
    }));
    // vault 부재면 200(unavailable), 있으면 400(templatePath-required). 둘 다 유효 계약.
    expect([200, 400]).toContain(res.status);
  });
  test('잘못된 JSON → 400 또는 unavailable', async () => {
    const res = await handleTemplateExpand(new Request('http://x/v1/vault/template-expand', { method: 'POST', body: 'nope' }));
    expect([200, 400]).toContain(res.status);
  });
});

describe('쓰기 문 2판 — 가드 · If-None-Match · 호출자', () => {
  const putWith = (body: unknown, headers: Record<string, string> = {}, deps = {}) => handleVaultFilePut(new Request('http://x/v1/vault/file', {
    method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }), deps);

  test('가드가 막으면 403 이고 파일을 만들지 않는다', async () => {
    const { vault } = await vaultFixture();
    const seen: string[] = [];
    const res = await putWith({ path: 'Daily/blocked.md', content: 'x' }, {}, {
      assertWrite: (abs: string) => { seen.push(abs); throw new VaultWriteBlockedError(abs); },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'vault-write-blocked-test-universe', path: 'Daily/blocked.md' });
    expect(seen).toEqual([join(vault, 'Daily/blocked.md')]);
    await expect(stat(join(vault, 'Daily'))).rejects.toThrow();
  });

  test('If-None-Match: * 는 createOnly 와 같다 — 있으면 409 · 원본 그대로', async () => {
    const { vault } = await vaultFixture();
    await writeFile(join(vault, 'note.md'), 'keep');
    const res = await putWith({ path: 'note.md', content: 'over' }, { 'if-none-match': '*' });
    expect(res.status).toBe(409);
    expect(await readFile(join(vault, 'note.md'), 'utf8')).toBe('keep');
    expect((await putWith({ path: 'new.md', content: 'n' }, { 'if-none-match': '*' })).status).toBe(200);
  });

  test('X-Elanous-Caller 가 관측에 남는다 · 없으면 pwa · 모양 밖이면 unknown', async () => {
    const mk = (h?: string) => new Request('http://x', { headers: h === undefined ? {} : { 'x-elanous-caller': h } });
    expect(vaultWriteCaller(mk())).toBe('pwa');
    expect(vaultWriteCaller(mk('intake-absorb'))).toBe('intake-absorb');
    expect(vaultWriteCaller(mk('bad caller; rm'))).toBe('unknown');
    await vaultFixture();
    const logged: unknown[] = [];
    const orig = debug.log;
    (debug as { log: typeof debug.log }).log = ((c: string, e: string, d?: unknown) => { if (c === 'pwa.vault') logged.push({ e, d }); }) as typeof debug.log;
    try { expect((await putWith({ path: 'c.md', content: 'c' }, { 'x-elanous-caller': 'intake-absorb' })).status).toBe(200); }
    finally { (debug as { log: typeof debug.log }).log = orig; }
    expect(logged).toContainEqual({ e: 'file-write', d: expect.objectContaining({ path: 'c.md', caller: 'intake-absorb' }) });
  });
});
