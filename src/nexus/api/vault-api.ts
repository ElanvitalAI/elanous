// ── Obsidian Vault REST 브릿지 (2026-07-09 · OP0) ─────────────────────────
//
// iPad Obsidian 기능을 PWA에 이식(PLAN-obsidian-pwa-port). ACP(elanous/obsidian/*)는
// WebSocket 전용이라 PWA read 작업엔 REST 가 깔끔 — 기존 obsidian 헬퍼를 얇게 노출.
// 로직 중복 0(resolveObsidianRoot + 헬퍼 재사용). dashboard.ts 패턴(CORS·jsonResponse).
//
//   GET  /v1/vault/info              vault 가용성·root·source
//   GET  /v1/vault/list?cwd=&limit=  폴더 목록(obsidian root·clamp)
//   GET  /v1/vault/read?path=        파일 읽기(text/bytes·mime)
//   GET  /v1/vault/search?q=&limit=  전문검색(ripgrep)
//   GET  /v1/vault/notes?query=      노트 목록(wikilink 자동완성)
//   GET  /v1/vault/backlinks?target= 역참조
//   GET  /v1/vault/tags              태그 집계
//   GET  /v1/vault/templates         템플릿 목록
//   GET  /v1/vault/poll-changes?sinceMs=  외부 변경 감지
//   GET  /v1/vault/orphans           고아 노트
//   GET  /v1/vault/graph?focus=&hops=&limit=  노트 그래프
//   POST /v1/vault/template-expand   {templatePath,title?} 토큰 전개
//   PUT  /v1/vault/file              {path,content,lastKnownMtime?,createOnly?} 원본 저장
//        2판(🅞 2026-09-26): 헤더 `If-None-Match: *` = createOnly · `X-Elanous-Caller` → 관측 · 격리 우주는 쓰기 가드(403)

import { open, readdir, stat, lstat, mkdir, writeFile, rename, link, unlink } from 'node:fs/promises';
import { join, dirname, isAbsolute, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { debug } from '../../debug/log.js';
import { resolveObsidianRoot, resolveFsRoot, clampToRoot, isHiddenForBrowser } from '../../acp/fs-roots.js';
import { detectMime } from '../../acp/fs-mime.js';
import { rgJsonMatchesAsync } from '../../tool-runtime/ripgrep-core.js';
import { assertVaultWriteAllowed, VaultWriteBlockedError } from '../../obsidian/vault-write-guard.js';

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, if-none-match, x-elanous-caller',
  'access-control-max-age': '600',
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });
}

const READ_SECTIONS = ['info', 'list', 'read', 'search', 'notes', 'backlinks', 'tags', 'templates', 'poll-changes', 'orphans', 'graph'];

// Serialize writes to the same vault pathname through the mtime check and rename.
const fileWrites = new Map<string, Promise<void>>();
async function serializeFileWrite<T>(abs: string, write: () => Promise<T>): Promise<T> {
  const previous = fileWrites.get(abs);
  let release!: () => void;
  const finished = new Promise<void>((resolve) => { release = resolve; });
  fileWrites.set(abs, finished);
  if (previous) await previous;
  try { return await write(); }
  finally {
    if (fileWrites.get(abs) === finished) fileWrites.delete(abs);
    release();
  }
}

/** /v1/vault/:section GET 섹션(POST=template-expand 별도). */
export function parseVaultPath(pathname: string): string | null {
  const m = /^\/v1\/vault\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  const seg = decodeURIComponent(m[1]!);
  return READ_SECTIONS.includes(seg) ? seg : null;
}

function num(v: string | null, def: number): number { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : def; }

/** Read from one descriptor, rejecting a changed or replaced file before attaching its mtime. */
export async function readVaultSnapshot(abs: string, afterRead?: () => Promise<void>): Promise<{ buf: Buffer; mtimeMs: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await open(abs, 'r');
    try {
      const before = await file.stat();
      const buf = await file.readFile();
      if (afterRead) await afterRead();
      const after = await file.stat();
      const current = await stat(abs);
      if (before.dev === after.dev && before.ino === after.ino && before.size === after.size
        && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
        && after.dev === current.dev && after.ino === current.ino && after.size === current.size
        && after.mtimeMs === current.mtimeMs && after.ctimeMs === current.ctimeMs) {
        return { buf, mtimeMs: after.mtimeMs };
      }
    } finally {
      await file.close();
    }
  }
  throw new Error('vault-file-changed-during-read');
}

/** ripgrep 전문검색 — 공유 ripgrep-core(rg --json·obsidian·acp 와 동일 프리미티브). */
async function ripgrepSearch(root: string, query: string, limit: number): Promise<{ matches: Array<{ path: string; snippet: string; lineNumber: number }>; error?: string }> {
  const res = await rgJsonMatchesAsync(query, {
    roots: [root], ignoreCase: true, lineNumber: true, perFileMaxCount: 3,
    typeAdd: ['md:*.md'], types: ['md'], relTo: root, snippetMax: 240, limit,
  });
  if (!res.ok) return { matches: [], error: `rg-exit-${res.code}: ${res.stderr.slice(0, 200)}` };
  return { matches: res.matches.map((m) => ({ path: m.path, snippet: m.text, lineNumber: m.line })) };
}

/** GET 디스패치 — parseVaultPath 로 매칭된 섹션. */
export async function handleVaultGet(req: Request, seg: string): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const ob = resolveObsidianRoot();

  if (seg === 'info') {
    return ob.available ? json({ available: true, root: ob.root, source: ob.source }) : json({ available: false, source: ob.source });
  }
  if (!ob.available) return json({ error: 'obsidian-vault-unavailable', available: false }, 200);

  try {
    switch (seg) {
      case 'list': {
        const base = resolveFsRoot('obsidian');
        const rawCwd = url.searchParams.get('cwd') || base;
        const cwd = clampToRoot(base, rawCwd);
        if (cwd == null) return json({ cwd: base, entries: [], error: 'cwd-escapes-root' });
        const dirents = await readdir(cwd, { withFileTypes: true });
        const entries = dirents
          .filter(e => !isHiddenForBrowser(e.name))
          .map(e => ({ name: e.name, isDir: e.isDirectory(), relPath: e.name }))
          .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
          .slice(0, 500);
        return json({ cwd, root: 'obsidian', base, entries });
      }
      case 'read': {
        const rel = url.searchParams.get('path');
        if (!rel) return json({ error: 'path-required' }, 400);
        const base = resolveFsRoot('obsidian');
        const abs = clampToRoot(base, join(base, rel));
        if (abs == null) return json({ error: 'path-escapes-root' }, 400);
        const maxBytes = num(url.searchParams.get('maxBytes'), 256 * 1024);
        const mime = detectMime(abs);
        const { buf, mtimeMs } = await readVaultSnapshot(abs);
        const truncated = buf.length > maxBytes;
        const slice = truncated ? buf.subarray(0, maxBytes) : buf;
        if (mime.startsWith('text/') || mime === 'application/json' || abs.endsWith('.md')) {
          return json({ path: rel, mime, size: buf.length, truncated, mtimeMs, content: slice.toString('utf8') });
        }
        return json({ path: rel, mime, size: buf.length, truncated, mtimeMs, bytes: slice.toString('base64') });
      }
      case 'search': {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json({ matches: [], error: 'query-required' });
        return json(await ripgrepSearch(ob.root, q, num(url.searchParams.get('limit'), 50)));
      }
      case 'notes': {
        const { findNotes } = await import('../../acp/obsidian-notes.js');
        return json(await findNotes({ vaultRoot: ob.root, query: url.searchParams.get('query') || undefined, limit: num(url.searchParams.get('limit'), 500) }));
      }
      case 'backlinks': {
        const target = (url.searchParams.get('target') || '').trim();
        if (!target) return json({ matches: [], error: 'target-required' });
        const { findBacklinks } = await import('../../acp/obsidian-backlinks.js');
        return json(await findBacklinks({ vaultRoot: ob.root, target, limit: num(url.searchParams.get('limit'), 100) }));
      }
      case 'tags': {
        const { findTags } = await import('../../acp/obsidian-tags.js');
        return json(await findTags({ vaultRoot: ob.root }));
      }
      case 'templates': {
        const { findTemplates } = await import('../../acp/obsidian-templates.js');
        return json(await findTemplates({ vaultRoot: ob.root }));
      }
      case 'poll-changes': {
        const { pollVaultChanges } = await import('../../acp/obsidian-poll-changes.js');
        return json(await pollVaultChanges({ vaultRoot: ob.root, sinceMs: num(url.searchParams.get('sinceMs'), 0) }));
      }
      case 'orphans': {
        const { findOrphanNotes } = await import('../../acp/obsidian-cleanup-orphans.js');
        return json(await findOrphanNotes({ vaultRoot: ob.root }));
      }
      case 'graph': {
        const { buildVaultGraph } = await import('../../acp/obsidian-graph.js');
        const focus = url.searchParams.get('focus') || undefined;
        return json(await buildVaultGraph({ vaultRoot: ob.root, limit: num(url.searchParams.get('limit'), 500), ...(focus ? { focus, hops: num(url.searchParams.get('hops'), 1) } : {}) }));
      }
      default: return json({ error: 'unknown section' }, 404);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

/** 호출자 표시 — 누가 볼트에 썼나(PWA 편집기 · 흡수 `intake-absorb` …). 모양 밖이면 `unknown`, 없으면 `pwa`. */
export function vaultWriteCaller(req: Request): string {
  const raw = req.headers.get('x-elanous-caller')?.trim();
  if (!raw) return 'pwa';
  return /^[a-z0-9][a-z0-9._-]{0,39}$/i.test(raw) ? raw : 'unknown';
}

export interface VaultFilePutDeps { readonly assertWrite?: (abs: string) => void }

/** PUT /v1/vault/file — persist the exact editor content in the same vault used by read. */
export async function handleVaultFilePut(req: Request, deps: VaultFilePutDeps = {}): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const ob = resolveObsidianRoot();
  if (!ob.available) return json({ error: 'obsidian-vault-unavailable' }, 503);
  let body: { path?: unknown; content?: unknown; lastKnownMtime?: unknown; createOnly?: unknown };
  try { body = await req.json() as typeof body; } catch { return json({ error: 'invalid JSON' }, 400); }
  if (!body || typeof body.path !== 'string' || !body.path || typeof body.content !== 'string'
    || (body.lastKnownMtime !== undefined && (typeof body.lastKnownMtime !== 'number' || !Number.isFinite(body.lastKnownMtime)))
    || (body.createOnly !== undefined && typeof body.createOnly !== 'boolean')) {
    return json({ error: 'invalid-file-write' }, 400);
  }
  const path = body.path;
  const content = body.content;
  const caller = vaultWriteCaller(req);
  const createOnly = body.createOnly === true || req.headers.get('if-none-match')?.trim() === '*';
  if (isAbsolute(path) || path.includes('\\') || path.split('/').includes('..') || !path.endsWith('.md')) return json({ error: 'invalid-path' }, 400);
  const base = resolveFsRoot('obsidian');
  const abs = clampToRoot(base, join(base, path));
  if (!abs || abs === base) return json({ error: 'path-escapes-root' }, 400);
  // ⛔ 격리(test) 우주는 운영 볼트에 쓰지 않는다 — 시험 볼트(`obsidian.testVault`)·우주 폴더·OS tmp 만(🅢 #20720).
  try { (deps.assertWrite ?? assertVaultWriteAllowed)(abs); }
  catch (e) {
    if (!(e instanceof VaultWriteBlockedError)) throw e;
    debug.log('pwa.vault', 'file-write-blocked', { path, caller });
    return json({ error: e.code, path, message: e.message }, 403);
  }
  return serializeFileWrite(abs, async () => {
    try {
      // Do not follow a symlink in a directory or at the destination: rename would
      // otherwise write through a linked parent outside the vault.
      let dir = base;
      for (const part of relative(base, dirname(abs)).split(sep).filter(Boolean)) {
        dir = join(dir, part);
        try {
          const entry = await lstat(dir);
          if (!entry.isDirectory() || entry.isSymbolicLink()) return json({ error: 'invalid-path' }, 400);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          try { await mkdir(dir); }
          catch (mkdirError) {
            if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
            const entry = await lstat(dir);
            if (!entry.isDirectory() || entry.isSymbolicLink()) return json({ error: 'invalid-path' }, 400);
          }
        }
      }
      let previous: Awaited<ReturnType<typeof lstat>> | undefined;
      try { previous = await lstat(abs); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (previous && !previous.isFile()) return json({ error: 'invalid-path' }, 400);
      if (!previous && typeof body.lastKnownMtime === 'number') {
        return json({ error: 'mtime_conflict', lastKnownMtime: body.lastKnownMtime, path }, 409);
      }
      if (previous && createOnly) return json({ error: 'file_exists', path }, 409);
      if (previous && typeof body.lastKnownMtime === 'number' && previous.mtimeMs !== body.lastKnownMtime) {
        return json({ error: 'mtime_conflict', currentMtime: previous.mtimeMs, lastKnownMtime: body.lastKnownMtime, path }, 409);
      }
      const tmp = join(dirname(abs), `.${randomUUID()}.tmp`);
      try {
        await writeFile(tmp, content, { flag: 'wx' });
        if (createOnly) {
          try { await link(tmp, abs); }
          catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') return json({ error: 'file_exists', path }, 409);
            throw e;
          }
        } else {
          await rename(tmp, abs);
        }
      } finally {
        try { await unlink(tmp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
      const { mtimeMs } = await stat(abs);
      debug.log('pwa.vault', 'file-write', { path, caller, bytes: Buffer.byteLength(content), created: !previous });
      return json({ path, mtimeMs });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}

/** POST /v1/vault/template-expand — {templatePath, title?} 토큰 전개. */
export async function handleTemplateExpand(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const ob = resolveObsidianRoot();
  if (!ob.available) return json({ error: 'obsidian-vault-unavailable' }, 200);
  let body: { templatePath?: unknown; title?: unknown };
  try { body = (await req.json()) as typeof body; } catch { return json({ error: 'invalid JSON' }, 400); }
  const templatePath = typeof body.templatePath === 'string' ? body.templatePath : '';
  if (!templatePath) return json({ error: 'templatePath-required' }, 400);
  const { expandTemplate } = await import('../../acp/obsidian-template-expand.js');
  return json(await expandTemplate({ vaultRoot: ob.root, templatePath, ...(typeof body.title === 'string' ? { title: body.title } : {}) }));
}
