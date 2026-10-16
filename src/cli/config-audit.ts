// ── CFG-STORE2 · config 감사 이력 첫 칸 (0.2.29 · 2026-10-14) ──
//
// RFC-universe-by-house-not-tree-and-config-store-2026-10-06 §2 — 겹 저장소의 첫 칸은 «감사 이력».
// CFG-STORE1(config-drift.ts · 읽기 전용 드리프트) 위에 «쓰기» 축 하나를 더한다:
// `config set` · `config unset` 이 저장에 성공하면 바꾼 키·이전 값·다음 값·by·why 를 한 행으로 남긴다.
//
// ⛔ 불변식
//   • 비밀은 «저장 전에» 가린다 — config-drift.ts 의 가림 원형(isSecretPath·isSecretValue·MASK·maskDeep)을
//     그대로 재사용한다: 비밀 경로(마디 하나라도 token/secret/key/…) ⊕ 비밀 모양 값(웹훅·토큰 접두·URL userinfo)
//     ⊕ 객체 속 비밀 키(botToken 같은 자리) → '<masked>'. config-drift.ts 는 손대지 않는다(읽기 전용 그대로).
//   • 감사 기록은 명령의 부속이다 — 호출부(src/index.ts config set/unset)가 fail-open 으로 감싼다(실패해도 경고만).
//   • by 는 자리(ELANOUS_TRACK) ⊕ 런 id 환경 변수에서 푼다 — 명시 by > ELANOUS_TRACK > 런 id > 'cli'.
//   • 읽기(readConfigHistory)는 없는 db 파일을 만들지 않는다.

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { isSecretPath, isSecretValue, maskDeep, MASK } from './config-drift.js';

// CFG-STORE1 가림 자(MASK) — 테스트 계약(config-audit.test.ts)이 이 경로로 소비한다.
export { MASK };

/** 한 번의 config 변경 — prev/next 는 저장 «전» 값과 저장 «후» 값(undefined = 그 자리에 키가 없다). */
export interface ConfigChange {
  key: string;
  prev?: unknown;
  next?: unknown;
  by?: string;
  why?: string;
}

/** config_changes 표의 한 행 — prev/next 는 가려 직렬화한 값(null = 그 자리에 값이 없었다). */
export interface ConfigChangeRow {
  at: string;
  key: string;
  prev: string | null;
  next: string | null;
  by: string;
  why: string | null;
}

/** 감사 db 기본 자리 — 활성 config 뿌리(~/.elanous · --config-dir 격리 존중) 바로 옆 config-changes.db. */
function configAuditDbPath(dbPath?: string): string {
  return dbPath ?? join(getElanousConfigDir(), 'config-changes.db');
}

/** by 해석 — 명시 by > 자리(ELANOUS_TRACK) > 런 id 환경 변수 > 'cli'. */
function resolveConfigChangeBy(by?: string): string {
  const explicit = by?.trim();
  if (explicit) return explicit;
  const track = process.env.ELANOUS_TRACK?.trim();
  if (track) return track;
  for (const name of ['ELANOUS_RUN_ID', 'HARNESS_RUN_ID', 'RUN_ID']) {
    const runId = process.env[name]?.trim();
    if (runId) return runId;
  }
  return 'cli';
}

/** 저장용 값 — undefined → SQL NULL · 비밀(경로 마디 ⊕ 값 모양) → MASK · 나머지는 maskDeep 후 JSON 직렬화. */
function serializeConfigValue(key: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (isSecretPath(key) || isSecretValue(value)) return MASK;
  return JSON.stringify(maskDeep(value)) ?? 'null';
}

// Anonymous SQLite memory databases are private to each connection. Keep one
// connection for this process so record/read share the same audit history.
// File-backed stores keep their existing open/close-per-call lifetime.
let memoryDb: Database | undefined;

function openConfigChangesDb(dbPath: string): Database {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = dbPath === ':memory:'
    ? (memoryDb ??= new Database(':memory:'))
    : new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS config_changes (
    at  TEXT NOT NULL,
    key TEXT NOT NULL,
    prev TEXT,
    next TEXT,
    by  TEXT NOT NULL,
    why TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS config_changes_key_at ON config_changes(key, at)');
  return db;
}

/** 한 번의 config 변경을 감사 이력에 «한 행»으로 남긴다. 비밀 값은 가려 쓴다. */
export function recordConfigChange(change: ConfigChange, dbPath?: string): ConfigChangeRow {
  const path = configAuditDbPath(dbPath);
  const db = openConfigChangesDb(path);
  try {
    const row: ConfigChangeRow = {
      at: new Date().toISOString(),
      key: change.key,
      prev: serializeConfigValue(change.key, change.prev),
      next: serializeConfigValue(change.key, change.next),
      by: resolveConfigChangeBy(change.by),
      why: change.why?.trim() ? change.why.trim() : null,
    };
    db.run(
      'INSERT INTO config_changes (at, key, prev, next, by, why) VALUES (?, ?, ?, ?, ?, ?)',
      [row.at, row.key, row.prev, row.next, row.by, row.why],
    );
    return row;
  } finally {
    if (path !== ':memory:') db.close();
  }
}

/** 한 키의 감사 이력 — 시간 오름차순. db 파일이 없으면 빈 배열(읽기가 파일을 만들지 않는다). */
export function readConfigHistory(key: string, dbPath?: string): ConfigChangeRow[] {
  const path = configAuditDbPath(dbPath);
  if (path !== ':memory:' && !existsSync(path)) return [];
  const db = path === ':memory:' ? openConfigChangesDb(path) : new Database(path, { readonly: true });
  try {
    return db.query('SELECT at, key, prev, next, by, why FROM config_changes WHERE key = ? ORDER BY at ASC, rowid ASC').all(key) as ConfigChangeRow[];
  } finally {
    if (path !== ':memory:') db.close();
  }
}
