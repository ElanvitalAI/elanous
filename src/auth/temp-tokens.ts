// 단기 소유자 토큰 — `elanous token issue --ttl 15m`.
//
// 왜: 검증·시연·다른 기기 한 번 붙이기에 «영구 소유자 토큰»(~/.elanous/acp-token)을 꺼내 건네면 그 값이
// 명령줄·세션 기록·브라우저에 영구로 남는다(2026-09-28 · 운영 웹 터미널 검증을 Aside 로 하려다 막혔다 · 대표 «직접 만들라»).
// ⇒ 수명이 짧고(기본 15분 · 최대 24시간), 저장소엔 «해시만» 있고, 언제든 걷을 수 있는 토큰.
//
// 권한 = 소유자 토큰과 같다(HTTP bearer ⊕ ACP 웹소켓). 범위를 좁히지 않는 대신 «수명»으로 위험을 줄인다.
// 저장 = `<config dir>/temp-tokens.json`(0600 · 원문 없음 · sha256 만) — 관리 토큰과 같은 디렉터리라 운영 데몬과 CLI 가 같은 곳을 본다.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { debug } from '../debug/log.js';

export const TEMP_TOKEN_DEFAULT_TTL_MS = 15 * 60_000;
export const TEMP_TOKEN_MAX_TTL_MS = 24 * 60 * 60_000;
const PREFIX = 'elt_';

interface StoredTempToken {
  id: string;
  hash: string;
  label: string;
  createdAt: string;
  expiresAt: string;
}

export interface TempTokenInfo { id: string; label: string; createdAt: string; expiresAt: string; expired: boolean }
export interface IssuedTempToken { id: string; token: string; label: string; expiresAt: string }

function storePath(dir: string): string { return join(dir, 'temp-tokens.json'); }

function readStore(dir: string): StoredTempToken[] {
  const path = storePath(dir);
  let text: string;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error('temp token store must be a private regular file (0600)');
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const parsed = JSON.parse(text) as { tokens?: unknown };
  if (!parsed || !Array.isArray(parsed.tokens)) throw new Error('temp token store is malformed');
  return parsed.tokens.filter((t): t is StoredTempToken => !!t && typeof t === 'object'
    && typeof (t as StoredTempToken).id === 'string' && /^[a-f0-9]{64}$/.test(String((t as StoredTempToken).hash))
    && typeof (t as StoredTempToken).expiresAt === 'string');
}

function writeStore(dir: string, tokens: StoredTempToken[]): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${storePath(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ tokens }, null, 2), { mode: 0o600 });
  renameSync(tmp, storePath(dir));
}

/** 쓰기 잠금 — O_EXCL 잠금 파일(짧게 기다렸다 포기). 발급·회수는 드물어 이것으로 충분하다. */
function withLock<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = `${storePath(dir)}.lock`;
  const until = Date.now() + 3000;
  let fd = -1;
  while (fd < 0) {
    try { fd = openSync(lock, 'wx', 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() > until) throw new Error('temp token store is locked — try again');
      Bun.sleepSync(20);
    }
  }
  try { return fn(); } finally { closeSync(fd); try { unlinkSync(lock); } catch { /* already gone */ } }
}

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** 발급 — 원문은 이 반환값에만 있다(저장소엔 해시). 만료된 것은 이때 걷는다. */
export function issueTempToken(opts: { ttlMs?: number; label?: string; dir?: string; now?: number } = {}): IssuedTempToken {
  const ttl = opts.ttlMs ?? TEMP_TOKEN_DEFAULT_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > TEMP_TOKEN_MAX_TTL_MS) throw new Error('ttl must be > 0 and at most 24h');
  const label = (opts.label ?? 'temp').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label)) throw new Error('label must be 1–64 of [A-Za-z0-9._-]');
  const dir = opts.dir ?? getElanousConfigDir();
  const now = opts.now ?? Date.now();
  return withLock(dir, () => {
    const live = readStore(dir).filter((t) => Date.parse(t.expiresAt) > now);
    const token = `${PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = randomBytes(4).toString('hex');
    const entry: StoredTempToken = { id, hash: hashOf(token), label, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl).toISOString() };
    writeStore(dir, [...live, entry]);
    try { debug.log('auth.temp-token', 'issued', { id, label, expiresAt: entry.expiresAt }); } catch { /* 관측 실패가 발급을 막지 않는다 */ }
    return { id, token, label, expiresAt: entry.expiresAt };
  });
}

/** 지금 유효한가(해시 상수시간 대조 · 만료 제외). 저장소가 손상되면 «거부»(fail-closed). */
export function matchTempToken(token: string, opts: { dir?: string; now?: number } = {}): TempTokenInfo | null {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return null;
  let entries: StoredTempToken[];
  try { entries = readStore(opts.dir ?? getElanousConfigDir()); } catch { return null; }
  const now = opts.now ?? Date.now();
  const digest = Buffer.from(hashOf(token), 'hex');
  let hit: StoredTempToken | null = null;
  for (const e of entries) if (timingSafeEqual(digest, Buffer.from(e.hash, 'hex')) && Date.parse(e.expiresAt) > now) hit = e;
  return hit ? { id: hit.id, label: hit.label, createdAt: hit.createdAt, expiresAt: hit.expiresAt, expired: false } : null;
}

export function listTempTokens(opts: { dir?: string; now?: number } = {}): TempTokenInfo[] {
  const now = opts.now ?? Date.now();
  return readStore(opts.dir ?? getElanousConfigDir()).map((t) => ({ id: t.id, label: t.label, createdAt: t.createdAt, expiresAt: t.expiresAt, expired: Date.parse(t.expiresAt) <= now }));
}

/** 회수 — id 하나 또는 전부. 다음 요청부터 거부된다. 걷은 수를 돌려준다. */
export function revokeTempTokens(which: { id?: string; all?: boolean }, opts: { dir?: string } = {}): number {
  const dir = opts.dir ?? getElanousConfigDir();
  return withLock(dir, () => {
    const tokens = readStore(dir);
    const remaining = which.all ? [] : tokens.filter((t) => t.id !== which.id);
    const removed = tokens.length - remaining.length;
    if (removed > 0) writeStore(dir, remaining);
    try { debug.log('auth.temp-token', 'revoked', { id: which.id ?? null, all: !!which.all, removed }); } catch { /* */ }
    return removed;
  });
}

/** `15m` · `2h` · `90s` · `1d`(=24h) → ms. */
export function parseTtl(text: string): number {
  const m = /^([1-9]\d*)(s|m|h|d)$/.exec(text.trim());
  if (!m) throw new Error('ttl must look like 90s, 15m, 2h or 1d');
  const n = Number(m[1]);
  return n * ({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[m[2] as 's' | 'm' | 'h' | 'd'];
}
