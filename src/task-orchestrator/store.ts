/**
 * Task Orchestrator SQLite persistence.
 *
 * Origin: `내부 문서 `PLAN-session-task-orchestrator-coevolution`` §3 +
 * Phase TOX-1d (feat/tox-foundation-store).
 *
 * Responsibilities:
 *   - Persist `Task` / `TaskExecution` / `TaskEvent` rows
 *   - Hydrate an in-memory `TaskGraph` from DB at session start
 *   - Subscribe to `TaskEventBus` and write `events` rows
 *
 * **Not** responsible for:
 *   - Graph logic — that's `graph.ts` (pure in-memory)
 *   - Event fan-out — that's `events.ts` bus
 *   - Dispatcher / Generator — downstream phases
 *
 * Schema versioning: `PRAGMA user_version` + `migrate()`. Schema v1 is
 * committed in this phase; future additive columns use
 * `addColumnIfMissing()` (same pattern as `src/scheduler/store.ts`).
 */
import { Database } from 'bun:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';

import { debug } from '../debug/log.js';
import { resolveHostId } from '../platform/host-id.js';

import type {
  Task,
  TaskExecution,
  TaskStatus,
  TaskSurface,
  TaskPriority,
  TaskIsolation,
  TaskAcceptance,
  TaskExecutionStatus,
  TaskGeneratedBy,
  ReviewVerdict,
} from './types.js';
import { serializeTask } from './types.js';
import type { TaskEvent, TaskEventBus } from './events.js';
import { TaskGraph } from './graph.js';
import { tasksDbPath, ensureDir } from './paths.js';
import type {
  Mission,
  MissionPriority,
  MissionSource,
  MissionStatus,
} from './mission.js';

// ─────────────────────── Schema version ─────────────────────────────

// v1 (TOX foundation) — tox_tasks / tox_executions / tox_events
// v2 (Phase 1 I6 · 2026-05-12) — tox_missions table + tox_tasks.mission_id column
// v3 (Mission Fabric 통합 U1 · 2026-07-09) — tox_missions.autopilot_json
//    (PFC Layer2 자율 메타 흡수 · apm Mission 병렬 table 제거 준비)
// v4 — external task identity and approval
export const TOX_SCHEMA_VERSION = 4;

// ─────────────────────── Row shapes ────────────────────────────────

interface TaskRow {
  id: string;
  created_at: number;
  updated_at: number;
  version: number;
  title: string;
  description: string;
  surface_json: string;
  parent_id: string | null;
  goal_slug: string | null;
  mission_id: string | null;
  depends_on_json: string; // JSON array
  triggers_json: string | null;
  priority: TaskPriority;
  estimate_ms: number | null;
  estimate_tokens: number | null;
  estimate_usd: number | null;
  feature_name: string | null;
  isolation: TaskIsolation;
  max_retries: number;
  attempt: number;
  timeout_ms: number | null;
  status: TaskStatus;
  schedule_text: string | null;
  scheduler_job_id: string | null;
  last_execution_id: string | null;
  acceptance_json: string | null;
  review_verdicts_json: string | null;
  notes_json: string; // JSON array
  generated_by_json: string | null;
  approval_json: string | null;
  external_provider: string | null;
  external_ref: string | null;
  trigger_chain_json: string;
}

interface ExecutionRow {
  id: string;
  task_id: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  status: TaskExecutionStatus;
  surface_json: string;
  surface_address: string | null;
  output: string | null;
  output_path: string | null;
  error_json: string | null;
  token_input: number | null;
  token_output: number | null;
  cost_usd: number | null;
  model_id: string | null;
  host_id: string | null;
  hostname: string | null;
}

interface EventRow {
  id: number;
  kind: string;
  timestamp: number;
  task_id: string | null;
  goal_slug: string | null;
  payload_json: string;
}

interface MissionRow {
  id: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  title: string;
  description: string | null;
  intent: string | null;
  source_json: string;
  status: MissionStatus;
  priority: MissionPriority | null;
  task_ids_json: string;   // JSON array of taskId
  goal_slug: string | null;
  notes_json: string;      // JSON array of string
  autopilot_json: string | null;  // JSON MissionAutopilot | null (U1)
}

// ─────────────────────── Store class ───────────────────────────────

export interface TaskStoreOptions {
  /** Absolute path to SQLite file. Defaults to `tasksDbPath()`. */
  path?: string;
  /** When true, skip WAL mode (useful for :memory: or CI). */
  noWal?: boolean;
}

// ─── Leak detector (2026-07-20 dogfood 버그 C) ───────────────────────
// TaskStore 에 공유 커넥션 인프라(싱글턴/풀)가 없다 — 매 인스턴스가 raw
// `new Database` + full `migrate()` DDL 을 돈다(호출부 73곳·각자 close 책임).
// 어떤 라이브 루프가 `.close()` 없이 반복 생성하면 fd 누수 + 매 틱 DDL 재실행
// = 메인스레드 CPU 스핀(Bun 단일스레드 → 이벤트루프 굶김 → 전 서피스 무응답).
// 경계(생성자)에서 순-핸들 수(open−close)를 세고 임계 하이워터 초과 시 호출
// 스택을 관측 — 계측 없던 그 루프 지점이 `elanous logs --category task-store`
// 조회로 특정된다(제1원칙: 조회에 안 뜨면 debug.log 를 심어라).
let __tsFileOpenCount = 0;
let __tsFileCloseCount = 0;
let __tsNextLeakAlertAt = 40;

export class TaskStore {
  private readonly db: Database;
  private readonly fileBacked: boolean;

  constructor(opts: TaskStoreOptions = {}) {
    const path = opts.path ?? tasksDbPath();
    this.fileBacked = path !== ':memory:';
    if (this.fileBacked) {
      ensureDir(dirname(path));
    }
    this.db = new Database(path);
    if (!opts.noWal && this.fileBacked) this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.migrate();

    if (this.fileBacked) {
      __tsFileOpenCount++;
      const live = __tsFileOpenCount - __tsFileCloseCount;
      if (live >= __tsNextLeakAlertAt) {
        __tsNextLeakAlertAt = live + 40;
        debug.log('task-store', 'live-handle-highwater', {
          live,
          opened: __tsFileOpenCount,
          closed: __tsFileCloseCount,
          path,
          // 누수 루프의 실제 호출부 — slice(2) 로 Error/생성자 프레임 제거
          openedBy: new Error('TaskStore open').stack?.split('\n').slice(2, 14).join('\n'),
        });
      }
    }
  }

  close(): void {
    this.db.close();
    if (this.fileBacked) __tsFileCloseCount++;
  }

  // ──────────────── Migration ───────────────────────────────────

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tox_tasks (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        surface_json TEXT NOT NULL,
        parent_id TEXT,
        goal_slug TEXT,
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        triggers_json TEXT,
        priority TEXT NOT NULL DEFAULT 'medium',
        estimate_ms INTEGER,
        estimate_tokens INTEGER,
        estimate_usd REAL,
        feature_name TEXT,
        isolation TEXT NOT NULL DEFAULT 'shared',
        max_retries INTEGER NOT NULL DEFAULT 2,
        attempt INTEGER NOT NULL DEFAULT 0,
        timeout_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'backlog',
        schedule_text TEXT,
        scheduler_job_id TEXT,
        last_execution_id TEXT,
        acceptance_json TEXT,
        review_verdicts_json TEXT,
        notes_json TEXT NOT NULL DEFAULT '[]',
        generated_by_json TEXT,
        trigger_chain_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS tox_executions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tox_tasks(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        status TEXT NOT NULL,
        surface_json TEXT NOT NULL,
        surface_address TEXT,
        output TEXT,
        output_path TEXT,
        error_json TEXT,
        token_input INTEGER,
        token_output INTEGER,
        cost_usd REAL,
        model_id TEXT
      );

      CREATE TABLE IF NOT EXISTS tox_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        task_id TEXT,
        goal_slug TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tox_tasks_goal ON tox_tasks(goal_slug);
      CREATE INDEX IF NOT EXISTS idx_tox_tasks_status ON tox_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tox_executions_task ON tox_executions(task_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_tox_events_task ON tox_events(task_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_tox_events_goal ON tox_events(goal_slug, timestamp);

      -- Phase 1 I6 (2026-05-12) — Mission entity: groups N tasks generated
      -- from a single intake decomposition. Kept additive so v1 DBs migrate
      -- cleanly via addColumnIfMissing for mission_id below.
      CREATE TABLE IF NOT EXISTS tox_missions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER,
        title TEXT NOT NULL,
        description TEXT,
        intent TEXT,
        source_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planning',
        priority TEXT,
        task_ids_json TEXT NOT NULL DEFAULT '[]',
        goal_slug TEXT,
        notes_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_tox_missions_status ON tox_missions(status);
      CREATE INDEX IF NOT EXISTS idx_tox_missions_goal ON tox_missions(goal_slug);
    `);
    this.addColumnIfMissing('tox_tasks', 'schedule_text', 'TEXT');
    this.addColumnIfMissing('tox_tasks', 'scheduler_job_id', 'TEXT');
    // Phase 1 I6 (v2) — tox_tasks.mission_id reverse pointer.
    this.addColumnIfMissing('tox_tasks', 'mission_id', 'TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tox_tasks_mission ON tox_tasks(mission_id)');
    // Mission Fabric 통합 U1 (v3) — tox_missions.autopilot_json:
    // PFC Layer2 자율 메타(apm Mission 흡수). NULL = 일반 Mission.
    this.addColumnIfMissing('tox_missions', 'autopilot_json', 'TEXT');
    this.addColumnIfMissing('tox_executions', 'host_id', 'TEXT');
    this.addColumnIfMissing('tox_executions', 'hostname', 'TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tox_executions_host ON tox_executions(host_id, started_at)');
    this.addColumnIfMissing('tox_tasks', 'approval_json', 'TEXT');
    this.addColumnIfMissing('tox_tasks', 'external_provider', 'TEXT');
    this.addColumnIfMissing('tox_tasks', 'external_ref', 'TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tox_tasks_external_ref ON tox_tasks(external_provider, external_ref) WHERE external_provider IS NOT NULL AND external_ref IS NOT NULL');
    this.db.exec(`PRAGMA user_version = ${TOX_SCHEMA_VERSION}`);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some((row) => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  /** Current schema version (per PRAGMA user_version). */
  schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row?.user_version ?? 0;
  }

  // ──────────────── Task CRUD ───────────────────────────────────

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  saveTask(task: Task): void {
    this.db
      .prepare(
        `INSERT INTO tox_tasks (
          id, created_at, updated_at, version, title, description, surface_json,
          parent_id, goal_slug, mission_id, depends_on_json, triggers_json, priority,
          estimate_ms, estimate_tokens, estimate_usd, feature_name, isolation,
          max_retries, attempt, timeout_ms, status, schedule_text, scheduler_job_id, last_execution_id,
          acceptance_json, review_verdicts_json, notes_json, generated_by_json,
          trigger_chain_json, approval_json, external_provider, external_ref
        ) VALUES (${Array(33).fill('?').join(', ')})
        ON CONFLICT(id) DO UPDATE SET
          updated_at=excluded.updated_at, version=excluded.version, title=excluded.title,
          description=excluded.description, surface_json=excluded.surface_json,
          parent_id=excluded.parent_id, goal_slug=excluded.goal_slug, mission_id=excluded.mission_id,
          depends_on_json=excluded.depends_on_json, triggers_json=excluded.triggers_json,
          priority=excluded.priority, estimate_ms=excluded.estimate_ms,
          estimate_tokens=excluded.estimate_tokens, estimate_usd=excluded.estimate_usd,
          feature_name=excluded.feature_name, isolation=excluded.isolation,
          max_retries=excluded.max_retries, attempt=excluded.attempt, timeout_ms=excluded.timeout_ms,
          status=excluded.status, schedule_text=excluded.schedule_text,
          scheduler_job_id=excluded.scheduler_job_id, last_execution_id=excluded.last_execution_id,
          acceptance_json=excluded.acceptance_json, review_verdicts_json=excluded.review_verdicts_json,
          notes_json=excluded.notes_json, generated_by_json=excluded.generated_by_json,
          trigger_chain_json=excluded.trigger_chain_json, approval_json=excluded.approval_json,
          external_provider=excluded.external_provider, external_ref=excluded.external_ref`
      )
      .run(
        task.id,
        task.createdAt,
        task.updatedAt,
        task.version,
        task.title,
        task.description,
        JSON.stringify(task.surface),
        task.parentId ?? null,
        task.goalSlug ?? null,
        task.missionId ?? null,
        JSON.stringify([...task.dependsOn]),
        task.triggers ? JSON.stringify([...task.triggers]) : null,
        task.priority,
        task.estimateMs ?? null,
        task.estimateTokens ?? null,
        task.estimateUsd ?? null,
        task.featureName ?? null,
        task.isolation,
        task.maxRetries,
        task.attempt,
        task.timeoutMs ?? null,
        task.status,
        task.scheduleText ?? null,
        task.schedulerJobId ?? null,
        task.lastExecutionId ?? null,
        task.acceptance ? JSON.stringify(task.acceptance) : null,
        task.reviewVerdicts ? JSON.stringify(task.reviewVerdicts) : null,
        JSON.stringify(task.notes),
        task.generatedBy ? JSON.stringify(task.generatedBy) : null,
        JSON.stringify([...task.triggerChain]),
        task.approval ? JSON.stringify(task.approval) : null,
        task.generatedBy?.kind === 'external' ? task.generatedBy.provider : null,
        task.generatedBy?.kind === 'external' ? task.generatedBy.ref : null,
      );
  }

  findTaskByExternalRef(provider: string, ref: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tox_tasks WHERE external_provider = ? AND external_ref = ?')
      .get(provider, ref) as TaskRow | undefined;
    return row ? this.rowToTask(row) : null;
  }

  getTask(id: string): Task | null {
    const row = this.db
      .prepare('SELECT * FROM tox_tasks WHERE id = ?')
      .get(id) as TaskRow | undefined;
    if (!row) return null;
    return this.rowToTask(row);
  }

  listTasks(opts: { goalSlug?: string; status?: TaskStatus } = {}): Task[] {
    const where: string[] = [];
    const params: Array<string | number | null> = [];
    if (opts.goalSlug !== undefined) {
      where.push('goal_slug = ?');
      params.push(opts.goalSlug);
    }
    if (opts.status !== undefined) {
      where.push('status = ?');
      params.push(opts.status);
    }
    const sql =
      'SELECT * FROM tox_tasks' +
      (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY created_at ASC';
    const rows = this.db.prepare(sql).all(...params) as TaskRow[];
    return rows.map((r) => this.rowToTask(r));
  }

  deleteTask(id: string): boolean {
    const res = this.db.prepare('DELETE FROM tox_tasks WHERE id = ?').run(id);
    return res.changes > 0;
  }

  countTasks(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM tox_tasks').get() as {
      n: number;
    };
    return row?.n ?? 0;
  }

  // ──────────────── Execution CRUD ─────────────────────────────

  saveExecution(exec: TaskExecution): void {
    let hostId = exec.hostId;
    let hostname = exec.hostname;
    if (hostId === undefined) {
      try { hostId = resolveHostId(); } catch { /* Origin resolution must not block persistence. */ }
    }
    if (hostname === undefined) {
      try { hostname = osHostname(); } catch { /* Origin resolution must not block persistence. */ }
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tox_executions (
          id, task_id, started_at, ended_at, duration_ms, status, surface_json,
          surface_address, output, output_path, error_json, token_input,
          token_output, cost_usd, model_id, host_id, hostname
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        exec.id,
        exec.taskId,
        exec.startedAt,
        exec.endedAt ?? null,
        exec.durationMs ?? null,
        exec.status,
        JSON.stringify(exec.surface),
        exec.surfaceAddress ?? null,
        exec.output ?? null,
        exec.outputPath ?? null,
        exec.error ? JSON.stringify(exec.error) : null,
        exec.tokenUsage?.input ?? null,
        exec.tokenUsage?.output ?? null,
        exec.costUsd ?? null,
        exec.modelId ?? null,
        hostId ?? null,
        hostname ?? null
      );
  }

  getExecution(id: string): TaskExecution | null {
    const row = this.db
      .prepare('SELECT * FROM tox_executions WHERE id = ?')
      .get(id) as ExecutionRow | undefined;
    if (!row) return null;
    return this.rowToExecution(row);
  }

  listExecutions(taskId: string, limit = 10): TaskExecution[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM tox_executions WHERE task_id = ? ORDER BY started_at DESC LIMIT ?'
      )
      .all(taskId, limit) as ExecutionRow[];
    return rows.map((r) => this.rowToExecution(r));
  }

  // ──────────────── Event append + query ──────────────────────

  appendEvent(event: TaskEvent): number {
    const goalSlug =
      (event as { goalSlug?: string | null }).goalSlug ?? null;
    const res = this.db
      .prepare(
        `INSERT INTO tox_events (kind, timestamp, task_id, goal_slug, payload_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        event.kind,
        event.timestamp,
        event.taskId ?? null,
        goalSlug,
        JSON.stringify(event)
      );
    return Number(res.lastInsertRowid);
  }

  listEvents(
    opts: {
      goalSlug?: string;
      taskId?: string;
      kinds?: string[];
      sinceTs?: number;
      limit?: number;
    } = {}
  ): TaskEvent[] {
    const where: string[] = [];
    const params: Array<string | number | null> = [];
    if (opts.goalSlug !== undefined) {
      where.push('goal_slug = ?');
      params.push(opts.goalSlug);
    }
    if (opts.taskId !== undefined) {
      where.push('task_id = ?');
      params.push(opts.taskId);
    }
    if (opts.kinds && opts.kinds.length > 0) {
      const placeholders = opts.kinds.map(() => '?').join(',');
      where.push(`kind IN (${placeholders})`);
      params.push(...opts.kinds);
    }
    if (opts.sinceTs !== undefined) {
      where.push('timestamp >= ?');
      params.push(opts.sinceTs);
    }
    const limit = opts.limit ?? 500;
    const sql =
      'SELECT * FROM tox_events' +
      (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY timestamp ASC, id ASC LIMIT ?';
    const rows = this.db.prepare(sql).all(...params, limit) as EventRow[];
    return rows.map((r) => JSON.parse(r.payload_json) as TaskEvent);
  }

  countEvents(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM tox_events').get() as {
      n: number;
    };
    return row?.n ?? 0;
  }

  // ──────────────── Mission CRUD (Phase 1 I6 · v2) ──────────────

  saveMission(mission: Mission): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tox_missions (
          id, created_at, updated_at, closed_at, title, description, intent,
          source_json, status, priority, task_ids_json, goal_slug, notes_json,
          autopilot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        mission.id,
        mission.createdAt,
        mission.updatedAt,
        mission.closedAt ?? null,
        mission.title,
        mission.description ?? null,
        mission.intent ?? null,
        JSON.stringify(mission.source),
        mission.status,
        mission.priority ?? null,
        JSON.stringify([...mission.taskIds]),
        mission.goalSlug ?? null,
        JSON.stringify([...mission.notes]),
        mission.autopilot ? JSON.stringify(mission.autopilot) : null,
      );
  }

  getMission(id: string): Mission | null {
    const row = this.db
      .prepare('SELECT * FROM tox_missions WHERE id = ?')
      .get(id) as MissionRow | undefined;
    if (!row) return null;
    return this.rowToMission(row);
  }

  listMissions(opts: { status?: MissionStatus; goalSlug?: string } = {}): Mission[] {
    const where: string[] = [];
    const params: Array<string | number | null> = [];
    if (opts.status !== undefined) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.goalSlug !== undefined) {
      where.push('goal_slug = ?');
      params.push(opts.goalSlug);
    }
    const sql =
      'SELECT * FROM tox_missions' +
      (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY created_at ASC';
    const rows = this.db.prepare(sql).all(...params) as MissionRow[];
    return rows.map((r) => this.rowToMission(r));
  }

  deleteMission(id: string): boolean {
    const res = this.db.prepare('DELETE FROM tox_missions WHERE id = ?').run(id);
    return res.changes > 0;
  }

  countMissions(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM tox_missions').get() as {
      n: number;
    };
    return row?.n ?? 0;
  }

  /** Tasks attached to a mission via the `tox_tasks.mission_id` reverse
   *  pointer. Cheap O(1) lookup via the `idx_tox_tasks_mission` index. */
  listTasksForMission(missionId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tox_tasks WHERE mission_id = ? ORDER BY created_at ASC')
      .all(missionId) as TaskRow[];
    return rows.map((r) => this.rowToTask(r));
  }

  /** Tasks linked to a mission by EITHER linkage — `mission_id` (intake
   *  decomposition) OR `goal_slug` = apm_id (mission-engine phase decompose,
   *  which stamps goal_slug not mission_id). promote/트레이스가 두 경로 모두
   *  잡아야 페이즈를 놓치지 않는다(2026-07-14 실측: heavy 분해는 goal_slug 만 심음). */
  listTasksForMissionAnyLink(missionId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tox_tasks WHERE mission_id = ? OR goal_slug = ? ORDER BY created_at ASC')
      .all(missionId, missionId) as TaskRow[];
    return rows.map((r) => this.rowToTask(r));
  }

  // ──────────────── Row ↔ domain converters ───────────────────

  private rowToTask(row: TaskRow): Task {
    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
      title: row.title,
      description: row.description,
      surface: JSON.parse(row.surface_json) as TaskSurface,
      parentId: row.parent_id ?? undefined,
      goalSlug: row.goal_slug ?? undefined,
      missionId: row.mission_id ?? undefined,
      dependsOn: Object.freeze(JSON.parse(row.depends_on_json) as string[]),
      triggers: row.triggers_json
        ? Object.freeze(JSON.parse(row.triggers_json) as string[])
        : undefined,
      priority: row.priority,
      estimateMs: row.estimate_ms ?? undefined,
      estimateTokens: row.estimate_tokens ?? undefined,
      estimateUsd: row.estimate_usd ?? undefined,
      featureName: row.feature_name ?? undefined,
      isolation: row.isolation,
      maxRetries: row.max_retries,
      attempt: row.attempt,
      timeoutMs: row.timeout_ms ?? undefined,
      status: row.status,
      scheduleText: row.schedule_text ?? undefined,
      schedulerJobId: row.scheduler_job_id ?? undefined,
      lastExecutionId: row.last_execution_id ?? undefined,
      acceptance: row.acceptance_json
        ? (JSON.parse(row.acceptance_json) as TaskAcceptance)
        : undefined,
      reviewVerdicts: row.review_verdicts_json
        ? (JSON.parse(row.review_verdicts_json) as ReviewVerdict[])
        : undefined,
      notes: JSON.parse(row.notes_json) as string[],
      generatedBy: row.generated_by_json
        ? (JSON.parse(row.generated_by_json) as TaskGeneratedBy)
        : undefined,
      approval: row.approval_json
        ? (JSON.parse(row.approval_json) as Task['approval'])
        : undefined,
      triggerChain: Object.freeze(JSON.parse(row.trigger_chain_json) as string[]),
    };
  }

  private rowToMission(row: MissionRow): Mission {
    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at ?? undefined,
      title: row.title,
      description: row.description ?? undefined,
      intent: row.intent ?? undefined,
      source: JSON.parse(row.source_json) as MissionSource,
      status: row.status,
      priority: row.priority ?? undefined,
      taskIds: Object.freeze(JSON.parse(row.task_ids_json) as string[]),
      goalSlug: row.goal_slug ?? undefined,
      notes: Object.freeze(JSON.parse(row.notes_json) as string[]),
      autopilot: row.autopilot_json
        ? (JSON.parse(row.autopilot_json) as Mission['autopilot'])
        : undefined,
    };
  }

  private rowToExecution(row: ExecutionRow): TaskExecution {
    const tokenUsage =
      row.token_input !== null && row.token_output !== null
        ? { input: row.token_input, output: row.token_output }
        : undefined;
    return {
      id: row.id,
      taskId: row.task_id,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      status: row.status,
      surface: JSON.parse(row.surface_json) as TaskSurface,
      surfaceAddress: row.surface_address ?? undefined,
      output: row.output ?? undefined,
      outputPath: row.output_path ?? undefined,
      error: row.error_json
        ? (JSON.parse(row.error_json) as TaskExecution['error'])
        : undefined,
      tokenUsage,
      costUsd: row.cost_usd ?? undefined,
      modelId: row.model_id ?? undefined,
      ...(row.host_id !== null ? { hostId: row.host_id } : {}),
      ...(row.hostname !== null ? { hostname: row.hostname } : {}),
    };
  }
}

// ───────────────────────── Hydration + bus wire ───────────────────

/**
 * Rebuild an in-memory `TaskGraph` from store contents. Tasks are
 * loaded in `created_at` order so that `addTask` does not see a
 * dependent before its dep (though missing deps are tolerated).
 *
 * Superseded tasks are excluded by default (history noise) — pass
 * `includeSuperseded: true` to opt in.
 */
export function hydrateGraph(
  store: TaskStore,
  opts: { includeSuperseded?: boolean } = {}
): TaskGraph {
  const graph = new TaskGraph();
  const tasks = store.listTasks();
  for (const t of tasks) {
    if (!opts.includeSuperseded && t.status === 'superseded') continue;
    // addTask does cycle check — but since tasks came from a DB that
    // was already cycle-checked on save, we accept the tiny cost for
    // defense-in-depth.
    graph.addTask(t);
  }
  return graph;
}

/**
 * Wire the in-memory `TaskEventBus` to persist every emit into
 * `tox_events`. Returns a disposable that unsubscribes.
 */
export function wireEventBusPersistence(
  bus: TaskEventBus,
  store: TaskStore
): { dispose: () => void } {
  const sub = bus.subscribe((ev) => {
    try {
      store.appendEvent(ev);
    } catch {
      // persistence failure must not abort in-memory flow
    }
  });
  return sub;
}

// Avoid unused-import lint
void serializeTask;
