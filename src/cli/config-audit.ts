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

/** 화면 표시용 값 — 원장과 «같은 가림 자»(비밀 경로 ⊕ 비밀 모양 값 → MASK). set/unset 되읽기 줄이 쓴다. */
export function maskConfigDisplayValue(key: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (isSecretPath(key) || isSecretValue(value)) return MASK;
  return maskDeep(value);
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

// ── CFG-STORE2-HISTORY-REVERT · 조회·되돌림 (0.2.36 · 2026-10-22) ──
//
// CFG-STORE2 가 남긴 원장(위)을 «읽어서» 되돌린다. 원장은 append 전용이다 — 되돌림도 UPDATE/DELETE 없이
// 새 행 하나(prev=지금 값 · next=복원 값 · why='config revert')로만 남는다. 그래서 이력은 «왜 그 값인가» 의
// 사슬로 남고, 되돌린 되돌림도 다시 한 행이다.
//
// ⛔ 불변식
//   • 되돌릴 «이전 값» 이 MASK 면 복원하지 않는다(원문을 원장에 남기지 않았으므로 복원할 원문이 없다) —
//     가린 값을 값으로 되쓰는 조용한 오염 대신 «거부» 한다. 그 키는 사람이 다시 set 한다.
//   • 출력은 언제나 가림을 거친다(maskDeep 재적용) — 화면·JSON 어디에도 비밀 원문이 없다.
//   • 도메인 합성(아래 configDomainOf)은 «같은 원장 경로» 만 쓴다 — 특수 도메인용 별도 저장소를 만들지 않는다.

/** config 도메인 — 한 키가 어느 특수 도메인의 합성 경계에 속하는가. */
export type ConfigDomain =
  | 'llm-policy'
  | 'account-limits'
  | 'fallback-chain'
  | 'pod-pool'
  | 'author-on-pod'
  | 'config';

/** 도메인 경계 — 구체 접두가 먼저다(넓은 'llm.' 이 좁은 'llm.limits' 를 삼키지 않게). */
const CONFIG_DOMAIN_PREFIXES: readonly (readonly [ConfigDomain, readonly string[]])[] = [
  ['pod-pool', ['podPool', 'harness.podPool']],
  ['author-on-pod', ['authorOnPod', 'harness.authorOnPod']],
  ['fallback-chain', ['llm.fallback', 'llm.fallbackChain', 'llm.rotation.fallback', 'llm.providerFallback']],
  ['account-limits', ['llm.limits', 'llm.accountLimits', 'llm.accountLimit', 'account.']],
  ['llm-policy', ['llm.']],
];

/** 한 키의 도메인 — 어느 특수 도메인 접두에도 안 맞으면 'config'(일반 키). */
export function configDomainOf(key: string): ConfigDomain {
  const normalized = key.trim();
  for (const [domain, prefixes] of CONFIG_DOMAIN_PREFIXES) {
    for (const prefix of prefixes) {
      if (normalized === prefix) return domain;
      if (prefix.endsWith('.')) {
        if (normalized.startsWith(prefix)) return domain;
      } else if (normalized.startsWith(`${prefix}.`)) {
        return domain;
      }
    }
  }
  return 'config';
}

/** 원장 값 → 실제 값. null = 그 자리에 값이 없었다(undefined) · MASK = 가려서 모른다. */
export function decodeConfigChangeValue(raw: string | null): unknown {
  if (raw === null) return undefined;
  if (raw === MASK) return MASK;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** 되돌림 계획 — 원장만 보고 정한다(값을 쓰지는 않는다). */
export type ConfigRevertPlan =
  | { status: 'no-history' }
  | { status: 'masked'; last: ConfigChangeRow }
  | { status: 'already'; last: ConfigChangeRow }
  | { status: 'restore'; last: ConfigChangeRow; value: unknown };

/**
 * 값 «전체» 에 가림 자(MASK)가 있는가 — 원시·배열·객체를 깊이 순회한다.
 * 최상위 문자열 비교만 하면 `["***MASK***"]` 처럼 배열·객체 «속» 에 남은 가림 자를 놓친다.
 */
export function containsMaskValue(value: unknown): boolean {
  if (value === MASK) return true;
  if (Array.isArray(value)) return value.some((item) => containsMaskValue(item));
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => containsMaskValue(item));
  }
  return false;
}

/** 그 키의 «마지막 변경» 을 되돌릴 계획. value===undefined 면 그 자리를 지우는 복원이다. */
export function planConfigRevert(key: string, dbPath?: string): ConfigRevertPlan {
  const last = readConfigHistory(key, dbPath).at(-1);
  if (!last) return { status: 'no-history' };
  // 이전 값이 «어디든» 가려져 있으면 원문 복원 불가 — 가린 값을 값으로 되쓰지 않는다.
  // 깊이 탐색인 이유: llm.fallbackChain 같은 배열·객체 값은 원장에 ["***MASK***"] 로 남아
  // 최상위 비교(prev === MASK)로는 안 걸리고, 그대로 되쓰면 MASK 리터럴이 실제 config 값이 된다.
  if (containsMaskValue(decodeConfigChangeValue(last.prev))) return { status: 'masked', last };
  if (last.prev === last.next) return { status: 'already', last };
  return { status: 'restore', last, value: decodeConfigChangeValue(last.prev) };
}

/** 화면용 값 — 가림을 «한 번 더» 거친다(원장이 이미 가렸어도 표시 자에서 재적용). */
function renderConfigChangeValue(raw: string | null): string {
  if (raw === null) return '∅';
  const decoded = decodeConfigChangeValue(raw);
  if (decoded === MASK) return MASK;
  return JSON.stringify(maskDeep(decoded)) ?? 'null';
}

/** `config history <key>` 출력 — 도메인 ⊕ 행 수 ⊕ (시각 · prev → next · by · why). */
export function formatConfigHistory(key: string, rows: readonly ConfigChangeRow[]): string {
  const header = `config history ${key} [${configDomainOf(key)}] — ${rows.length}행`;
  const lines = rows.map((row) => {
    const why = row.why ? ` why=${row.why}` : '';
    return `${row.at}  ${renderConfigChangeValue(row.prev)} → ${renderConfigChangeValue(row.next)}  by=${row.by}${why}`;
  });
  return [header, ...lines].join('\n');
}

/** 되돌림 감사 행 — 같은 원장에 append 만 한다(why 기본값 'config revert'). */
export function recordConfigRevert(change: ConfigChange, dbPath?: string): ConfigChangeRow {
  return recordConfigChange({ ...change, why: change.why?.trim() ? change.why.trim() : 'config revert' }, dbPath);
}
