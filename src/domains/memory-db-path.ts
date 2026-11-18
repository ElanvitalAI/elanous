// ── Managed memory/knowledge DB paths — 정본 위치 + legacy 자가치유 (2026-07-19) ──
//
// elanous 의 "기억" DB(에피소드 surface_events · 시맨틱 knowledge)는 종전 메인 state dir
// `~/.elanous/conatus/`(시그널·미션·스케줄·로그가 다 뒤섞인 junk drawer)에 얹혀 있었다.
// 이들을 **전용 `~/.elanous/memory/` 네임스페이스**로 모아 관리 표면을 통일한다.
//
// 일반화: DB 마다 경로/마이그레이션을 하드코딩(surface-events 인라인 선례)하지 않고, 이 한
// 헬퍼로 등록만 하면 (1) 정본 경로 해석 (2) conatus→memory 자가치유 이전을 공유한다.
//
//   전부 scoped — ELANOUS_STATE_DIR 격리 인스턴스는 각자 파일(인스턴스별 self-log). knowledge 도
//   Phase E(2026-07-24)에서 global→scoped 전환(격리 test 가 prod 회상 코퍼스 오염 차단). ★global
//   opt-in 은 은퇴(Phase F) — "인스턴스 무관 공유"는 격리를 뚫는 leak 벡터라 되살리지 말 것.

import { existsSync, renameSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** managed 메모리/지식 DB 의 정본 경로. ELANOUS_STATE_DIR 격리 인스턴스는 자기 파일, 아니면
 *  `~/.elanous/memory/`. (global opt-in 은퇴 — 전부 scoped·격리 불변식.) */
export function memoryDbPath(name: string): string {
  return memoryDbPathIn(process.env.ELANOUS_STATE_DIR, name);
}

const prodRoot = () => resolve(join(homedir(), '.elanous'));
const isProdStamp = (stateDir: string) => resolve(stateDir.replace(/\/+$/, '')) === prodRoot();

/** NIGHTLY-CONDENSE-INPUT-PATH — one universe, one file. A child stamped with the prod root
 *  (`ELANOUS_STATE_DIR=~/.elanous`, e.g. a graph `pinChildUniverse` child) is the same universe as an
 *  unstamped prod process, so both resolve to `~/.elanous/memory/<name>`. Before this, the stamped
 *  writer landed in `~/.elanous/<name>` while the unstamped nightly reader read `memory/<name>`. */
export function memoryDbPathIn(stateDir: string | undefined, name: string): string {
  const root = stateDir?.trim();
  if (root && !isProdStamp(root)) return join(root, name);
  return join(prodRoot(), 'memory', name);
}

/** The pre-fix prod-stamped location (`~/.elanous/<name>`), when the given universe is prod and it differs
 *  from the canonical file. Readers union it read-only so rows written there before the fix stay visible. */
export function strayProdMemoryDbPath(stateDir: string | undefined, name: string): string | undefined {
  const root = stateDir?.trim();
  if (root && !isProdStamp(root)) return undefined;
  const stray = join(prodRoot(), name);
  return stray === memoryDbPathIn(stateDir, name) ? undefined : stray;
}

/** legacy `~/.elanous/conatus/<name>` → 정본 memory/ 자가치유 이전. 신 경로 부재 + legacy 존재
 *  일 때만 rename(같은 fs·원자적·WAL/SHM 동반). ★open 前(재시작 시점)에만 도므로 라이브 안전
 *  (POSIX rename 은 열린 fd 를 따라감). scoped 격리 인스턴스는 legacy 없음 → skip. */
export function migrateLegacyMemoryDb(name: string): void {
  const target = memoryDbPath(name);
  // scoped 격리(ELANOUS_STATE_DIR)엔 conatus legacy 가 없다 — prod(미설정 또는 prod 루트 스탬프)만 이전.
  const stamp = process.env.ELANOUS_STATE_DIR?.trim();
  if (stamp && !isProdStamp(stamp)) return;
  if (existsSync(target)) return;
  const legacy = join(homedir(), '.elanous', 'conatus', name);
  if (legacy === target || !existsSync(legacy)) return;
  try {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(legacy, target);
    for (const suf of ['-wal', '-shm']) {
      if (existsSync(legacy + suf)) { try { renameSync(legacy + suf, target + suf); } catch { /* */ } }
    }
  } catch { /* best-effort — 실패 시 정본 경로에 새로 생성(이력만 유실·기능 정상) */ }
}

export interface StrayMergeResult { stray: string; merged: Record<string, number>; skipped?: 'unchanged' }

/** NIGHTLY-CONDENSE-INPUT-PATH self-heal — copy rows the pre-fix prod-stamped writer left in the stray
 *  `~/.elanous/<name>` into the canonical file `db` is open on, so every reader (not only the nightly
 *  collect) keeps them. Rows are matched by `id` per table (idempotent, so concurrent or repeated merges
 *  never duplicate). A marker beside the canonical file stores the stray file's size+mtime; an unchanged
 *  stray is skipped with one stat. The stray stays in place (a process still on old code may keep
 *  writing to it until restart; the marker then sees the change and merges again). Undefined = nothing to do. */
export function mergeStrayMemoryDb(db: Database, name: string, tables: readonly string[],
  files: { stray?: string; canonical: string } = { stray: strayProdMemoryDbPath(process.env.ELANOUS_STATE_DIR, name),
    canonical: memoryDbPathIn(process.env.ELANOUS_STATE_DIR, name) }): StrayMergeResult | undefined {
  const { stray, canonical } = files;
  if (!stray || !existsSync(stray)) return undefined;
  const stat = statSync(stray);
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  const marker = `${canonical}.stray-merged`;
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === stamp) return { stray, merged: {}, skipped: 'unchanged' };
  const merged: Record<string, number> = {};
  db.run('ATTACH DATABASE ? AS stray', [stray]);
  try {
    db.transaction(() => {
      for (const table of tables) {
        const exists = db.prepare(`SELECT 1 FROM stray.sqlite_master WHERE name = ?`).get(table);
        if (!exists) continue;
        const columns = (table: string, schema: string) =>
          (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);
        const mainColumns = new Set(columns(table, 'main'));
        const shared = columns(table, 'stray').filter(column => mainColumns.has(column));
        if (!shared.includes('id')) continue;
        const list = shared.map(column => `"${column}"`).join(', ');
        const missing = `FROM stray."${table}" WHERE id NOT IN (SELECT id FROM main."${table}")`;
        // Count first: `changes` over an FTS5 table also counts its shadow-table writes.
        merged[table] = (db.prepare(`SELECT COUNT(*) AS n ${missing}`).get() as { n: number }).n;
        db.run(`INSERT INTO main."${table}" (${list}) SELECT ${list} ${missing}`);
      }
    }).immediate();
  } finally { db.run('DETACH DATABASE stray'); }
  writeFileSync(marker, `${stamp}\n`);
  return { stray, merged };
}

/** Canonical paths this process already tried to fold a stray into. Bounds the merge to once per process per
 *  db path: while a pre-fix process keeps writing the stray, its size/mtime marker never matches, and an
 *  uncapped merge would ATTACH + scan + take an IMMEDIATE write lock on every open of the write path. */
const strayMergeAttempted = new Set<string>();
const strayMergeRuns = new Map<string, number>();
let strayPathResolver: (name: string) => string | undefined =
  name => strayProdMemoryDbPath(process.env.ELANOUS_STATE_DIR, name);

/** Test seam: forget the per-process attempts (and run counts); optionally point the stray lookup at a fixture. */
export function resetStrayMergeAttempts(resolver?: (name: string) => string | undefined): void {
  strayMergeAttempted.clear();
  strayMergeRuns.clear();
  strayPathResolver = resolver ?? (name => strayProdMemoryDbPath(process.env.ELANOUS_STATE_DIR, name));
}

/** How many merge calls this process made for `canonical` (the cap keeps it at one; the marker may still skip the scan). */
export function strayMergeRunCount(canonical: string): number {
  return strayMergeRuns.get(canonical) ?? 0;
}

export type StrayMergeOnceResult = StrayMergeResult | { stray?: string; merged: Record<string, number>; skipped: 'already-attempted' | 'busy' };

/** The openers' entry: at most one merge attempt per process per canonical path. A busy database is skipped
 *  without waiting (busy_timeout 0 for the attempt) — the write that opened the db is never blocked, and the
 *  next process (or restart) makes the attempt instead. */
export function mergeStrayMemoryDbOnce(db: Database, name: string, tables: readonly string[], canonical: string): StrayMergeOnceResult | undefined {
  if (strayMergeAttempted.has(canonical)) return { merged: {}, skipped: 'already-attempted' };
  strayMergeAttempted.add(canonical);
  const stray = strayPathResolver(name);
  if (!stray || !existsSync(stray)) return undefined;
  const previous = (db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | null)?.timeout ?? 0;
  db.run('PRAGMA busy_timeout = 0');
  try {
    strayMergeRuns.set(canonical, strayMergeRunCount(canonical) + 1);
    return mergeStrayMemoryDb(db, name, tables, { stray, canonical });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? '';
    const message = error instanceof Error ? error.message : String(error);
    if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED') || /database is (locked|busy)/i.test(message)) {
      return { stray, merged: {}, skipped: 'busy' };
    }
    throw error;
  } finally { db.run(`PRAGMA busy_timeout = ${Number(previous) || 0}`); }
}
