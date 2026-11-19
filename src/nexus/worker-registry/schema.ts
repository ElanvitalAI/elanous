// NEXUS · worker registry sqlite schema — DRAFT, 정식 구현 아님 (OP #95243)
//
// nexus 원장 패턴: bun:sqlite Database + WAL. 마이그레이션은 user_version
// 증가 방식(스키마 버전 상수 하나씩). 인가·감사·비밀 가림은 저장소 뒤
// api.ts 한곳에서 담당(OP 10:1x — 비밀은 원장에 평문으로 넣지 않는다).

import { Database } from 'bun:sqlite';

export const WORKER_REGISTRY_SCHEMA_VERSION = 3;

export function workerRegistryDbPath(stateRoot: string): string {
  return `${stateRoot}/nexus/worker-registry.db`;
}

export interface WorkerRegistrySchemaDeps {
  dbPath: string;
  now?: () => Date;
}

/** 표:
 *  - workers        : 작업자 원장(desired/actual 상태, kind, 능력 선언, 호스트, 부모/무리, 소유권, 정체성 사슬,
 *                     TC #95745 위계 role·siblings/children + traits cost_ms·latency_ms·risk)
 *  - worker_hosts   : 호스트(machine) 행 계약 — elsEndpoint(tailnet/loopback) · elsVersionSha(자기보고·보존 —
 *                     artifact 증명 아님, TC-H-CC-4 판정 준용) · heartbeat TTL ·
 *                     r2: 인증 host principal + generation 결속 · 폐기(revokedAt)
 *  - worker_watch   : watch 사건 원장(SSE/WS 이중화 — 재접속 시 seq로 replay)
 * 마이그레이션: PRAGMA user_version (v1 → v2: workers 위계·특성 열 추가,
 *               v2 → v3: worker_hosts principal/generation/revoked_at 결속 열 추가). */
export function migrateWorkerRegistry(db: Database): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`PRAGMA user_version = ${WORKER_REGISTRY_SCHEMA_VERSION};`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      id               TEXT PRIMARY KEY,
      kind             TEXT NOT NULL CHECK (kind IN ('shell','inline-agent','pane-agent','cli')),
      goal             TEXT,
      command          TEXT,
      host             TEXT,
      parent           TEXT,
      fanout           TEXT,
      owner            TEXT,
      budget           TEXT,
      isolation        TEXT,
      generation       INTEGER NOT NULL DEFAULT 1,
      role             TEXT CHECK (role IS NULL OR role IN ('king','op','coord','peer','child')),
      siblings_json    TEXT,
      children_json    TEXT,
      cost_ms          INTEGER,
      latency_ms      INTEGER,
      risk             TEXT,
      capabilities_json TEXT,
      desired_state     TEXT CHECK (desired_state IS NULL OR desired_state IN ('working','idle','needs-approval','done','failed','stalled')),
      actual_state      TEXT NOT NULL DEFAULT 'working' CHECK (actual_state IN ('working','idle','needs-approval','done','failed','stalled')),
      pane_id           TEXT,
      event_id          TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workers_host_idx ON workers(host);
    CREATE INDEX IF NOT EXISTS workers_parent_idx ON workers(parent);
    CREATE INDEX IF NOT EXISTS workers_fanout_idx ON workers(fanout);
    CREATE INDEX IF NOT EXISTS workers_actual_state_idx ON workers(actual_state);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_hosts (
      name             TEXT PRIMARY KEY,
      els_endpoint     TEXT,
      els_version_sha  TEXT,
      alive_at         TEXT,
      heartbeat_ttl_ms INTEGER,
      principal         TEXT,
      generation       INTEGER NOT NULL DEFAULT 1,
      revoked_at       TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_watch (
      seq       INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      type      TEXT NOT NULL,
      from_state TEXT,
      to_state  TEXT,
      pane_id   TEXT,
      event_id  TEXT,
      at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS worker_watch_worker_idx ON worker_watch(worker_id);
  `);
  // v1 → v2: 이미 만들어진 workers 표에 위계·특성 열을 보충(새 표는 위 CREATE 에 포함).
  // v2 → v3: worker_hosts 표에 r2 결속 열(principal/generation/revoked_at)을 보충.
  const addMissing = (table: string, additions: Array<[string, string]>): void => {
    const existing = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    if (existing.size === 0) return; // 표 없음 — 위 CREATE 가 최신 열로 만든다
    for (const [name, decl] of additions) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl};`);
    }
  };
  addMissing('workers', [
    ['generation', 'INTEGER NOT NULL DEFAULT 1'],
    ['role', "TEXT CHECK (role IS NULL OR role IN ('king','op','coord','peer','child'))"],
    ['siblings_json', 'TEXT'],
    ['children_json', 'TEXT'],
    ['cost_ms', 'INTEGER'],
    ['latency_ms', 'INTEGER'],
    ['risk', 'TEXT'],
  ]);
  addMissing('worker_hosts', [
    ['principal', 'TEXT'],
    ['generation', 'INTEGER NOT NULL DEFAULT 1'],
    ['revoked_at', 'TEXT'],
  ]);
  db.exec(`PRAGMA user_version = ${WORKER_REGISTRY_SCHEMA_VERSION};`);
}
