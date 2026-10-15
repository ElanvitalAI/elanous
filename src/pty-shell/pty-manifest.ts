// ── 크로스-프로세스 PTY 매니페스트 (실행 substrate 통합·2026-07-23) ──
//
// registry(`registry.ts`)는 프로세스-로컬 싱글톤이라 별도 프로세스 PTY를 데몬 PWA에서 관측할 수 없다.
// 이 매니페스트는 공유 SQLite로 프로세스 경계를 넘겨 모든 PTY의 상태와 출력 스냅샷을 노출한다.

import { Database } from 'bun:sqlite';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { resolveInstanceName } from '../instance-identity.js';
import { getHarnessRunId, getHarnessRunIdSource, normalizeRunIdSource, type RunIdSource } from '../harness/harness-space.js';
import { getParentPtyId, getPtyChainOrigin } from '../agent/pty-identity.js';
import { getNestDepth } from '../agent/nest-depth.js';
import { originObservationFields } from '../agent/origin-observation.js';
import { runGitCommand } from '../git-fs/runner.js';
import { debug } from '../debug/log.js';
import { appendPtyEvent } from './pty-event-log.js';

export function ptyManifestDbPath(): string {
  return _dbPathForTesting ?? join(elanousStateRoot(), 'pty', 'manifest.db');
}

export type TerminalOriginCategory = 'direct-human' | 'elanous' | 'external-tool' | 'unknown';

export interface TerminalOriginDecision {
  readonly category: TerminalOriginCategory;
  readonly reason: string;
  readonly externalToolName?: string;
}

export function classifyTerminalOrigin(observation: {
  originRoot?: string;
  originAgent?: string;
  originSession?: string;
  controller?: string;
}): TerminalOriginDecision {
  const root = observation.originRoot?.trim();
  const agent = observation.originAgent?.trim();
  const session = observation.originSession?.trim();
  const hasAgentEvidence = Boolean(agent || session);
  const validToolName = agent && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(agent) ? agent : undefined;
  if (!root) return { category: 'unknown', reason: hasAgentEvidence ? 'incomplete-origin-marker' : 'origin-marker-absent' };
  if (root === 'external-agent') {
    return validToolName && !observation.controller?.trim().includes('human-cli')
      ? { category: 'external-tool', reason: 'inherited-external-agent-marker', externalToolName: validToolName }
      : { category: 'unknown', reason: validToolName ? 'conflicting-origin-marker' : 'invalid-external-tool-marker' };
  }
  if (root === 'human-cli') {
    return hasAgentEvidence
      ? { category: 'unknown', reason: 'conflicting-human-agent-marker' }
      : { category: 'direct-human', reason: 'inherited-human-cli-marker' };
  }
  if (root === 'elanous-internal' || root === 'scheduler') {
    return hasAgentEvidence
      ? { category: 'unknown', reason: 'conflicting-monad-agent-marker' }
      : { category: 'elanous', reason: root === 'scheduler' ? 'inherited-scheduler-marker' : 'inherited-elanous-marker' };
  }
  return { category: 'unknown', reason: 'unrecognized-origin-marker' };
}

export interface PtyManifestRow {
  id: string;
  kind: string;
  nickname?: string;
  cmd: string;
  workdir?: string;
  purpose?: string;
  seat?: string;
  ownerPid: number;
  ptyPid: number;
  livenessSource?: 'pty-pid' | 'owner-pid';
  instance: string;
  startedAt: number;
  alive: boolean;
  exitCode: number | null;
  snapshot: string;
  snapshotAt: number;
  outputBytesTotal: number;
  lastControlAt?: number;
  updatedAt: number;
  frame: string;
  frameAt: number;
  runId: string;
  runIdSource: RunIdSource | '';
  spaceId: string;
  sessionId: string;
  parentPtyId: string;
  parentPid: number;
  parentKind: string;
  chainOrigin?: string;
  nestDepth?: number;
  originRoot?: string;
  originAgent?: string;
  originSession?: string;
  controller?: string;
  terminalOriginCategory?: TerminalOriginCategory;
  terminalOriginReason?: string;
  externalToolName?: string;
  closedAt: number;
  codeSha: string;
  /** TUI 턴 상태 — TUI 가 턴 시작·끝에 스스로 적는다(화면 글자 추정 아님). 없으면 기록 안 하는 행/옛 판. */
  turnState?: PtyTurnState;
  turnAt?: number;
  /** 행 소유 프로세스가 «기동 때» 실은 코드 판 — 트리 HEAD(`codeSha`)와 다른 축이다. */
  build?: PtyBuildIdentity;
}

export type PtyTurnState = 'busy' | 'idle';
export type PtyBuildSource = 'installed' | 'checkout' | 'unknown';
export interface PtyBuildIdentity {
  readonly version: string;
  /** 40자 커밋 — 모르면 ''. */
  readonly sha: string;
  readonly source: PtyBuildSource;
  /** 기동한 코드의 뿌리 — checkout 이면 지금 HEAD 와 비교하는 자리. */
  readonly codeRoot?: string;
}

const SNAPSHOT_TAIL_BYTES = 16 * 1024;
const FRAME_TAIL_BYTES = 64 * 1024;
const SNAPSHOT_THROTTLE_MS = 1500;

let _db: Database | null = null;
let _dbFailed = false;
let _dbPathForTesting: string | null = null;
const _lastSnapshotAt = new Map<string, number>();
const _lastFrameAt = new Map<string, number>();

export function setPtyManifestDbPathForTesting(path: string | null): void {
  _db?.close();
  _db = null;
  _dbFailed = false;
  _dbPathForTesting = path;
  _lastSnapshotAt.clear();
  _lastFrameAt.clear();
}

function db(): Database | null {
  if (_db) return _db;
  if (_dbFailed) return null;
  try {
    const path = _dbPathForTesting ?? ptyManifestDbPath();
    try { mkdirSync(dirname(path), { recursive: true }); } catch { /* noop */ }
    const d = new Database(path);
    d.run('PRAGMA journal_mode = WAL');
    d.run('PRAGMA busy_timeout = 2000');
    d.run(`CREATE TABLE IF NOT EXISTS pty_manifest (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      nickname TEXT,
      cmd TEXT NOT NULL,
      workdir TEXT,
      owner_pid INTEGER NOT NULL,
      instance TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      alive INTEGER NOT NULL DEFAULT 1,
      exit_code INTEGER,
      snapshot TEXT NOT NULL DEFAULT '',
      snapshot_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`);
    migratePtyManifestSchema(d);
    _db = d;
    return d;
  } catch {
    _dbFailed = true;
    return null;
  }
}

export function migratePtyManifestSchema(d: Database): void {
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN nickname TEXT'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN purpose TEXT'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN seat TEXT'); } catch { /* already exists */ }
  try { d.run(`ALTER TABLE pty_manifest ADD COLUMN frame TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN frame_at INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
  try { d.run(`ALTER TABLE pty_manifest ADD COLUMN run_id TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
  try { d.run(`ALTER TABLE pty_manifest ADD COLUMN run_id_source TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
  try { d.run(`ALTER TABLE pty_manifest ADD COLUMN space_id TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
  try { d.run(`ALTER TABLE pty_manifest ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN closed_at INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN pty_pid INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
  try { d.run(`ALTER TABLE pty_manifest ADD COLUMN liveness_source TEXT`); } catch { /* already exists */ }
  try { d.run(`ALTER TABLE pty_manifest ADD COLUMN code_sha TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
  try { d.run(`ALTER TABLE pty_manifest ADD COLUMN parent_pty_id TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN parent_pid INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
  try { d.run(`ALTER TABLE pty_manifest ADD COLUMN parent_kind TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN chain_origin TEXT'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN nest_depth INTEGER'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN origin_root TEXT'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN origin_agent TEXT'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN origin_session TEXT'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN controller TEXT'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN terminal_origin_category TEXT'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN terminal_origin_reason TEXT'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN external_tool_name TEXT'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN output_bytes_total INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN last_control_at INTEGER'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN turn_state TEXT'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN turn_at INTEGER'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN build_version TEXT'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN build_sha TEXT'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN build_source TEXT'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest ADD COLUMN build_code_root TEXT'); } catch { /* already exists */ }
  try { d.run('ALTER TABLE pty_manifest DROP COLUMN chain_depth'); } catch { /* legacy schema has no duplicate column */ }
  try { d.run('UPDATE pty_manifest SET closed_at=updated_at WHERE alive=0 AND closed_at=0'); } catch { /* fail-soft */ }
}

function codeShaForWorkdir(workdir: string | undefined): string {
  if (!workdir) return '';
  try {
    const result = runGitCommand(workdir, ['rev-parse', 'HEAD'], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : '';
  } catch {
    return '';
  }
}

type PtyLifecycleEvent = 'spawned' | 'exited' | 'seen-stale' | 'seen-orphan' | 'seen-purge' | 'seen-remove';

function recordPtyLifecycle(event: PtyLifecycleEvent, row: PtyManifestRow, now: number): void {
  const seq = appendPtyEvent({
    instance: resolveInstanceName(),
    surfaceId: row.id,
    kind: 'lifecycle',
    now,
    payload: {
      event,
      ptyId: row.id,
      kind: row.kind,
      cmd: row.cmd,
      workdir: row.workdir,
      instance: row.instance,
      runId: row.runId,
      runIdSource: row.runIdSource,
      spaceId: row.spaceId,
      sessionId: row.sessionId,
      codeSha: row.codeSha,
      parentPtyId: row.parentPtyId,
      parentPid: row.parentPid,
      parentKind: row.parentKind,
      chainOrigin: row.chainOrigin,
      nestDepth: row.nestDepth,
      originRoot: row.originRoot,
      originAgent: row.originAgent,
      originSession: row.originSession,
      controller: row.controller,
      terminalOriginCategory: row.terminalOriginCategory,
      terminalOriginReason: row.terminalOriginReason,
      externalToolName: row.externalToolName,
      exitCode: row.exitCode,
      startedAt: row.startedAt,
      closedAt: row.closedAt,
    },
  });
  if (seq === 0) debug.log('pty.manifest', 'ledger-write-failed', { ptyId: row.id, event });
}

export function upsertPtyManifest(row: {
  id: string;
  kind: string;
  nickname?: string;
  cmd: string;
  workdir?: string;
  purpose?: string;
  seat?: string;
  startedAt: number;
  now: number;
  ptyPid?: number;
  origin?: { originRoot: string; controller?: string };
  identity?: {
    spaceId?: string;
    parentPtyId?: string;
    parentPid?: number;
    controller?: string;
    nestDepth?: number;
  };
}): void {
  try {
    const d = db(); if (!d) return;
    const runId = getHarnessRunId(process.env);
    const runIdSource = getHarnessRunIdSource();
    const defaultSpaceId = process.env.ELANOUS_HARNESS_SPACE_ID?.trim() ?? '';
    const sessionId = process.env.ELANOUS_SESSION_ID?.trim() ?? '';
    const defaultParentPtyId = getParentPtyId() ?? '';
    const defaultParentPid = process.ppid;
    const chainOrigin = getPtyChainOrigin();
    const registrarNestDepth = process.env.ELANOUS_NEST_DEPTH === undefined ? undefined : getNestDepth();
    const nestDepth = row.identity?.nestDepth ?? registrarNestDepth;
    const observedOrigin = originObservationFields();
    const { originRoot, originAgent, originSession, controller } = row.origin
      ? { originRoot: row.origin.originRoot, originAgent: undefined, originSession: undefined, controller: row.origin.controller }
      : observedOrigin;
    const terminalOrigin = classifyTerminalOrigin({ originRoot, originAgent, originSession, controller });
    const codeSha = codeShaForWorkdir(row.workdir);
    d.run('BEGIN IMMEDIATE');
    try {
      const previous = d.query('SELECT alive, space_id, parent_pty_id, parent_pid, controller FROM pty_manifest WHERE id=?').get(row.id) as {
        alive: number;
        space_id: string;
        parent_pty_id: string;
        parent_pid: number;
        controller: string | null;
      } | null;
      const spaceId = row.identity?.spaceId ?? previous?.space_id ?? defaultSpaceId;
      const parentPtyId = row.identity?.parentPtyId ?? previous?.parent_pty_id ?? defaultParentPtyId;
      const parentPid = row.identity?.parentPid ?? previous?.parent_pid ?? defaultParentPid;
      const manifestController = row.identity?.controller ?? controller ?? previous?.controller ?? undefined;
      const parentKind = parentPtyId
        ? 'pty'
        : registrarNestDepth !== undefined && registrarNestDepth >= 1
          ? 'unknown'
          : 'process';
      const shouldRecordSpawned = previous === null || previous.alive === 0;
      const values = [
        row.id, row.kind, row.nickname ?? null, row.cmd, row.workdir ?? null, row.purpose ?? null, row.seat ?? null, process.pid, row.ptyPid ?? 0, resolveInstanceName(),
        runId, runIdSource, spaceId, sessionId, codeSha, parentPtyId, parentPid, parentKind, chainOrigin ?? null, nestDepth ?? null,
        originRoot ?? null, originAgent ?? null, originSession ?? null, manifestController ?? null, terminalOrigin.category, terminalOrigin.reason,
        terminalOrigin.externalToolName ?? null, row.startedAt, 1, null, '', 0, row.now,
      ];
      d.run(
        `INSERT INTO pty_manifest (id, kind, nickname, cmd, workdir, purpose, seat, owner_pid, pty_pid, instance, run_id, run_id_source, space_id, session_id, code_sha, parent_pty_id, parent_pid, parent_kind, chain_origin, nest_depth, origin_root, origin_agent, origin_session, controller, terminal_origin_category, terminal_origin_reason, external_tool_name, started_at, alive, exit_code, snapshot, snapshot_at, updated_at)
         VALUES (${values.map(() => '?').join(', ')})
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, nickname=excluded.nickname, cmd=excluded.cmd, workdir=excluded.workdir, purpose=excluded.purpose, seat=excluded.seat,
           owner_pid=excluded.owner_pid, pty_pid=excluded.pty_pid, instance=excluded.instance,
           run_id=excluded.run_id, run_id_source=excluded.run_id_source, space_id=excluded.space_id, session_id=excluded.session_id, code_sha=excluded.code_sha,
           parent_pty_id=excluded.parent_pty_id, parent_pid=excluded.parent_pid, parent_kind=excluded.parent_kind,
           chain_origin=excluded.chain_origin, nest_depth=excluded.nest_depth, origin_root=excluded.origin_root, origin_agent=excluded.origin_agent,
           origin_session=excluded.origin_session, controller=excluded.controller, terminal_origin_category=excluded.terminal_origin_category,
           terminal_origin_reason=excluded.terminal_origin_reason, external_tool_name=excluded.external_tool_name,
           started_at=excluded.started_at, alive=1, exit_code=NULL,
           snapshot='', snapshot_at=0, frame='', frame_at=0, closed_at=0, updated_at=excluded.updated_at,
           turn_state=NULL, turn_at=NULL, build_version=NULL, build_sha=NULL, build_source=NULL, build_code_root=NULL`,
        values,
      );
      d.run('COMMIT');
      if (shouldRecordSpawned) {
        recordPtyLifecycle('spawned', {
          id: row.id, kind: row.kind, ...(row.nickname ? { nickname: row.nickname } : {}), cmd: row.cmd,
          ...(row.purpose ? { purpose: row.purpose } : {}),
          ...(row.seat ? { seat: row.seat } : {}),
          ...(row.workdir ? { workdir: row.workdir } : {}), ownerPid: process.pid, ptyPid: row.ptyPid ?? 0, instance: resolveInstanceName(),
          startedAt: row.startedAt, alive: true, exitCode: null, snapshot: '', snapshotAt: 0, outputBytesTotal: 0, updatedAt: row.now,
          frame: '', frameAt: 0, runId, runIdSource, spaceId, sessionId, parentPtyId, parentPid, parentKind,
          ...(chainOrigin === undefined ? {} : { chainOrigin }),
          ...(nestDepth === undefined ? {} : { nestDepth }),
          ...(originRoot === undefined ? {} : { originRoot }),
          ...(originAgent === undefined ? {} : { originAgent }),
          ...(originSession === undefined ? {} : { originSession }),
          ...(manifestController === undefined ? {} : { controller: manifestController }),
          terminalOriginCategory: terminalOrigin.category,
          terminalOriginReason: terminalOrigin.reason,
          ...(terminalOrigin.externalToolName === undefined ? {} : { externalToolName: terminalOrigin.externalToolName }),
          closedAt: 0, codeSha,
        }, row.now);
      }
    } catch (error) {
      try { d.run('ROLLBACK'); } catch { /* fail-soft */ }
      throw error;
    }
    debug.log('pty.manifest', 'code-generation', { id: row.id, codeSha, workdir: row.workdir });
  } catch { /* fail-soft */ }
}

export function updatePtyManifestSnapshot(id: string, snapshotFn: () => string, now: number): boolean {
  try {
    const last = _lastSnapshotAt.get(id) ?? 0;
    if (now - last < SNAPSHOT_THROTTLE_MS) return false;
    _lastSnapshotAt.set(id, now);
    const d = db(); if (!d) return false;
    const snapshot = snapshotFn();
    const tail = snapshot.length > SNAPSHOT_TAIL_BYTES ? snapshot.slice(-SNAPSHOT_TAIL_BYTES) : snapshot;
    d.run('UPDATE pty_manifest SET snapshot=?, snapshot_at=?, updated_at=? WHERE id=?', [tail, now, now, id]);
    return true;
  } catch {
    return false;
  }
}

export function addPtyManifestOutputBytes(id: string, deltaBytes: number, now: number): boolean {
  if (deltaBytes <= 0) return true;
  try {
    const d = db(); if (!d) return false;
    const result = d.run(
      'UPDATE pty_manifest SET output_bytes_total = output_bytes_total + ?, updated_at = ? WHERE id = ?',
      [deltaBytes, now, id],
    );
    return result.changes > 0;
  } catch {
    return false;
  }
}

export function updatePtyManifestFrame(id: string, frameFn: () => string, now: number): void {
  try {
    const last = _lastFrameAt.get(id) ?? 0;
    if (now - last < SNAPSHOT_THROTTLE_MS) return;
    _lastFrameAt.set(id, now);
    const d = db(); if (!d) return;
    const frame = frameFn();
    const tail = frame.length > FRAME_TAIL_BYTES ? frame.slice(-FRAME_TAIL_BYTES) : frame;
    d.run('UPDATE pty_manifest SET frame=?, frame_at=?, updated_at=? WHERE id=?', [tail, now, now, id]);
  } catch { /* fail-soft */ }
}

export function updatePtyManifestNickname(id: string, nickname: string | undefined, now: number): void {
  try {
    const d = db(); if (!d) return;
    d.run('UPDATE pty_manifest SET nickname=?, updated_at=? WHERE id=?', [nickname ?? null, now, id]);
  } catch { /* fail-soft */ }
}

/** 턴 상태 기록 — 행이 없거나 db 를 못 열면 false(호출자가 관측을 남긴다). */
export function updatePtyManifestTurn(id: string, turn: PtyTurnState, at: number): boolean {
  try {
    const d = db(); if (!d) return false;
    return d.run('UPDATE pty_manifest SET turn_state=?, turn_at=? WHERE id=?', [turn, at, id]).changes > 0;
  } catch {
    return false;
  }
}

/** 기동 판 기록 — 행 등록 직후 한 번. */
export function updatePtyManifestBuild(id: string, build: PtyBuildIdentity): boolean {
  try {
    const d = db(); if (!d) return false;
    return d.run(
      'UPDATE pty_manifest SET build_version=?, build_sha=?, build_source=?, build_code_root=? WHERE id=?',
      [build.version, build.sha, build.source, build.codeRoot ?? null, id],
    ).changes > 0;
  } catch {
    return false;
  }
}

export function markPtyControlled(id: string, at: number): void {
  try {
    const d = db(); if (!d) return;
    d.run('UPDATE pty_manifest SET last_control_at=? WHERE id=?', [at, id]);
  } catch { /* fail-soft */ }
}

export function markPtyManifestClosed(id: string, exitCode: number | null, now: number): void {
  try {
    _lastSnapshotAt.delete(id);
    _lastFrameAt.delete(id);
    const d = db(); if (!d) return;
    d.run('BEGIN IMMEDIATE');
    try {
      const before = d.query('SELECT * FROM pty_manifest WHERE id=? AND alive=1').get(id) as Record<string, unknown> | null;
      d.run(
        'UPDATE pty_manifest SET alive=0, exit_code=?, closed_at=CASE WHEN closed_at=0 THEN ? ELSE closed_at END, updated_at=? WHERE id=?',
        [exitCode, now, now, id],
      );
      if (before) {
        const row = d.query('SELECT * FROM pty_manifest WHERE id=?').get(id) as Record<string, unknown> | null;
        if (row) recordPtyLifecycle('exited', mapRow(row), now);
      }
      d.run('COMMIT');
    } catch (error) {
      try { d.run('ROLLBACK'); } catch { /* fail-soft */ }
      throw error;
    }
  } catch { /* fail-soft */ }
}

export function removePtyManifest(id: string): void {
  try {
    _lastSnapshotAt.delete(id);
    _lastFrameAt.delete(id);
    const d = db(); if (!d) return;
    d.run('BEGIN IMMEDIATE');
    try {
      const row = d.query('SELECT * FROM pty_manifest WHERE id=?').get(id) as Record<string, unknown> | null;
      if (row) recordPtyLifecycle('seen-remove', mapRow(row), Date.now());
      d.run('DELETE FROM pty_manifest WHERE id=?', [id]);
      d.run('COMMIT');
    } catch (error) {
      try { d.run('ROLLBACK'); } catch { /* fail-soft */ }
      throw error;
    }
  } catch { /* fail-soft */ }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function reapDeadPtyManifest(): number {
  try {
    const d = db(); if (!d) return 0;
    const rows = d.query('SELECT id, owner_pid, pty_pid FROM pty_manifest WHERE alive=1').all() as Array<{ id: string; owner_pid: number; pty_pid: number }>;
    const now = Date.now();
    let tombstoned = 0;
    for (const r of rows) {
      const livenessSource = r.pty_pid > 0 ? 'pty-pid' : 'owner-pid';
      const livenessPid = livenessSource === 'pty-pid' ? r.pty_pid : r.owner_pid;
      if (livenessPid === process.pid) continue;
      if (!isProcessAlive(livenessPid)) {
        const res = d.run(
          'UPDATE pty_manifest SET alive=0, liveness_source=?, closed_at=CASE WHEN closed_at=0 THEN ? ELSE closed_at END, updated_at=? WHERE id=? AND alive=1',
          [livenessSource, now, now, r.id],
        );
        tombstoned += res.changes ?? 0;
      }
    }
    return tombstoned;
  } catch {
    return 0;
  }
}

export interface PtyManifestExternalReapDecision {
  readonly id: string;
  readonly livenessPid: number;
  readonly livenessSource: 'pty-pid' | 'owner-pid';
  readonly action: 'remove' | 'preserve';
  readonly reason: 'process-dead' | 'process-alive' | 'liveness-unknown' | 'row-changed' | 'write-failed';
  readonly plannedAction?: 'remove';
}

export interface PtyManifestExternalReapResult {
  readonly dbPath: string;
  readonly status: 'ok' | 'missing' | 'unreadable' | 'schema-mismatch' | 'write-failed';
  readonly missingColumns: readonly string[];
  readonly removed: number;
  readonly preserved: number;
  readonly decisions: readonly PtyManifestExternalReapDecision[];
}

type ExternalReapRow = { id: string; owner_pid: number; pty_pid?: number };

function externalReapDecisions(rows: readonly ExternalReapRow[], checkAlive: (pid: number) => boolean): PtyManifestExternalReapDecision[] {
  return rows.map((row) => {
    const livenessSource = row.pty_pid && row.pty_pid > 0 ? 'pty-pid' : 'owner-pid';
    const livenessPid = livenessSource === 'pty-pid' ? row.pty_pid! : row.owner_pid;
    let reason: PtyManifestExternalReapDecision['reason'];
    if (livenessPid <= 0) reason = 'liveness-unknown';
    else {
      try { reason = checkAlive(livenessPid) ? 'process-alive' : 'process-dead'; }
      catch { reason = 'liveness-unknown'; }
    }
    return { id: row.id, livenessPid, livenessSource, action: reason === 'process-dead' ? 'remove' : 'preserve', reason };
  });
}

function externalReapResult(
  dbPath: string,
  status: PtyManifestExternalReapResult['status'],
  removed: number,
  preserved: number,
  decisions: readonly PtyManifestExternalReapDecision[],
  missingColumns: readonly string[] = [],
): PtyManifestExternalReapResult {
  if (removed + preserved !== decisions.length) {
    throw new Error(`external PTY manifest reap summary mismatch: removed=${removed} preserved=${preserved} decisions=${decisions.length}`);
  }
  return { dbPath, status, missingColumns, removed, preserved, decisions };
}

export function reapDeadPtyManifestAt(
  dbPath: string,
  opts: {
    readonly apply?: boolean;
    readonly isProcessAlive?: (pid: number) => boolean;
    readonly configureWriteConnection?: (database: Database) => void;
  } = {},
): PtyManifestExternalReapResult {
  if (!existsSync(dbPath)) return { dbPath, status: 'missing', missingColumns: [], removed: 0, preserved: 0, decisions: [] };
  const apply = opts.apply !== false;
  let d: Database | null = null;
  try {
    d = apply
      ? new Database(dbPath, { readwrite: true, create: false })
      : new Database(dbPath, { readonly: true });
    if (apply) (opts.configureWriteConnection ?? ((database) => database.run('PRAGMA busy_timeout = 2000')))(d);
    const columns = new Set((d.query('PRAGMA table_info(pty_manifest)').all() as Array<{ name: string }>).map((column) => column.name));
    const missingColumns = ['id', 'owner_pid', 'alive'].filter((column) => !columns.has(column));
    if (missingColumns.length > 0) {
      return { dbPath, status: 'schema-mismatch', missingColumns, removed: 0, preserved: 0, decisions: [] };
    }
    const hasPtyPid = columns.has('pty_pid');
    const checkAlive = opts.isProcessAlive ?? isProcessAlive;
    const rows = d.query(`SELECT id, owner_pid${hasPtyPid ? ', pty_pid' : ''} FROM pty_manifest WHERE alive=1`).all() as ExternalReapRow[];
    const decisions = externalReapDecisions(rows, checkAlive);
    if (!apply) {
      const removed = decisions.filter((decision) => decision.action === 'remove').length;
      const preserved = decisions.filter((decision) => decision.action === 'preserve').length;
      return externalReapResult(dbPath, 'ok', removed, preserved, decisions);
    }
    try {
      d.run('BEGIN IMMEDIATE');
      let removed = 0;
      for (const row of rows) {
        const index = decisions.findIndex((decision) => decision.id === row.id && decision.action === 'remove');
        if (index < 0) continue;
        const changes = d.run(
          `DELETE FROM pty_manifest WHERE id=? AND alive=1 AND owner_pid=?${hasPtyPid ? ' AND pty_pid=?' : ''}`,
          hasPtyPid ? [row.id, row.owner_pid, row.pty_pid ?? 0] : [row.id, row.owner_pid],
        ).changes ?? 0;
        if (changes === 1) removed += 1;
        else decisions[index] = { ...decisions[index]!, action: 'preserve', reason: 'row-changed' };
      }
      d.run('COMMIT');
      return externalReapResult(
        dbPath,
        'ok',
        removed,
        decisions.filter((decision) => decision.action === 'preserve').length,
        decisions,
      );
    } catch {
      try { d.run('ROLLBACK'); } catch { /* fail-soft */ }
      const failedDecisions = decisions.map((decision) => decision.action === 'remove'
        ? { ...decision, action: 'preserve' as const, reason: 'write-failed' as const, plannedAction: 'remove' as const }
        : decision);
      return externalReapResult(dbPath, 'write-failed', 0, failedDecisions.length, failedDecisions);
    }
  } catch {
    return { dbPath, status: existsSync(dbPath) ? 'unreadable' : 'missing', missingColumns: [], removed: 0, preserved: 0, decisions: [] };
  } finally {
    try { d?.close(); } catch { /* fail-soft */ }
  }
}

export const PTY_MANIFEST_CLOSED_TTL_MS = 5 * 60 * 1000;

export function purgeClosedPtyManifest(now: number, ttlMs: number = PTY_MANIFEST_CLOSED_TTL_MS): number {
  try {
    const d = db(); if (!d) return 0;
    const where = ttlMs <= 0 ? 'alive=0' : 'alive=0 AND updated_at < ?';
    const params = ttlMs <= 0 ? [] : [now - ttlMs];
    d.run('BEGIN IMMEDIATE');
    try {
      const rows = d.query(`SELECT * FROM pty_manifest WHERE ${where}`).all(...params) as Array<Record<string, unknown>>;
      for (const row of rows) recordPtyLifecycle('seen-purge', mapRow(row), now);
      const res = d.run(`DELETE FROM pty_manifest WHERE ${where}`, params);
      d.run('COMMIT');
      return res.changes ?? 0;
    } catch (error) {
      try { d.run('ROLLBACK'); } catch { /* fail-soft */ }
      throw error;
    }
  } catch {
    return 0;
  }
}

export function reapOrphanedOwnedPtyManifest(liveIds: Set<string>): number {
  try {
    const d = db(); if (!d) return 0;
    d.run('BEGIN IMMEDIATE');
    try {
      const rows = d.query('SELECT * FROM pty_manifest WHERE owner_pid=?').all(process.pid) as Array<Record<string, unknown>>;
      let removed = 0;
      for (const raw of rows) {
        const row = mapRow(raw);
        if (!liveIds.has(row.id)) {
          recordPtyLifecycle('seen-orphan', row, Date.now());
          const res = d.run('DELETE FROM pty_manifest WHERE id=? AND owner_pid=?', [row.id, process.pid]);
          removed += res.changes ?? 0;
        }
      }
      d.run('COMMIT');
      return removed;
    } catch (error) {
      try { d.run('ROLLBACK'); } catch { /* fail-soft */ }
      throw error;
    }
  } catch {
    return 0;
  }
}

export function touchLivePtyManifest(liveIds: Set<string>, now: number): void {
  try {
    const d = db(); if (!d || liveIds.size === 0) return;
    const ids = [...liveIds];
    const placeholders = ids.map(() => '?').join(',');
    d.run(
      `UPDATE pty_manifest SET updated_at=? WHERE owner_pid=? AND alive=1 AND id IN (${placeholders})`,
      [now, process.pid, ...ids],
    );
  } catch { /* fail-soft */ }
}

export const PTY_MANIFEST_STALE_MS = 60_000;

export function reapStalePtyManifest(now: number, staleMs: number = PTY_MANIFEST_STALE_MS): number {
  try {
    const d = db(); if (!d) return 0;
    const params = [now - staleMs];
    d.run('BEGIN IMMEDIATE');
    try {
      const rows = d.query('SELECT * FROM pty_manifest WHERE alive=1 AND updated_at < ?').all(...params) as Array<Record<string, unknown>>;
      for (const row of rows) recordPtyLifecycle('seen-stale', mapRow(row), now);
      const res = d.run('DELETE FROM pty_manifest WHERE alive=1 AND updated_at < ?', params);
      d.run('COMMIT');
      return res.changes ?? 0;
    } catch (error) {
      try { d.run('ROLLBACK'); } catch { /* fail-soft */ }
      throw error;
    }
  } catch {
    return 0;
  }
}

export function listPtyManifestRows(): PtyManifestRow[] {
  try {
    const d = db(); if (!d) return [];
    const rows = d.query('SELECT * FROM pty_manifest ORDER BY started_at ASC').all() as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

/**
 * 살아 있는 소유 + 최근 하트비트인데 시작한 지 오래된 PTY — 읽기 전용.
 *
 * `reapStalePtyManifest` 는 하트비트가 끊긴 행을 보고, `reapDeadPtyManifest` 는
 * 죽은 소유/PTY 프로세스를 본다. 사람이 띄워 놓고 잊은 TUI 는 둘 다 살아 있어
 * 그 대상이 아니다. 이 진입이 그 행을 세고 각 행의 나이(`ageMs` = now − startedAt)를
 * 돌려 사람이 「끌까」를 판단할 값을 만든다.
 *
 * 「오래」(`minAgeMs`)는 호출자가 정한다. 하트비트 신선도는 기존 stale 임계
 * (`PTY_MANIFEST_STALE_MS`)와 같다 — 그 임계를 넘긴 행은 stale reaper 의 몫이다.
 *
 * ⛔ 아무것도 지우거나 종료하지 않는다. 기존 두 걷어내기·하트비트 진입은 무접촉.
 * ⛔ 의도적 경계: 화면을 끄는 일, 띄우는 방식 변경, 이 값을 보여 주는 명령/UI 는
 *    이 골의 대상이 아니다(다음 조각). 후속 표시 계층의 런타임 호출자가 없으므로
 *    시험이 이 진입을 직접 호출한다.
 */
export type LongLivedLivePtyManifestRow = PtyManifestRow & {
  /** Wall-clock age at `now`: `now - startedAt`. */
  readonly ageMs: number;
};

export function listLongLivedLivePtyManifest(now: number, minAgeMs: number): LongLivedLivePtyManifestRow[] {
  try {
    const d = db(); if (!d) return [];
    const startedBefore = now - minAgeMs;
    const heartbeatAfter = now - PTY_MANIFEST_STALE_MS;
    const rows = d.query(
      `SELECT * FROM pty_manifest
       WHERE alive=1 AND started_at <= ? AND updated_at >= ?
       ORDER BY started_at ASC`,
    ).all(startedBefore, heartbeatAfter) as Array<Record<string, unknown>>;
    const result: LongLivedLivePtyManifestRow[] = [];
    for (const raw of rows) {
      const row = mapRow(raw);
      const livenessPid = row.ptyPid > 0 ? row.ptyPid : row.ownerPid;
      if (!isProcessAlive(livenessPid)) continue;
      result.push({ ...row, ageMs: now - row.startedAt });
    }
    debug.log('pty.manifest', 'long-lived-live', { count: result.length, minAgeMs, now });
    return result;
  } catch {
    return [];
  }
}

export function listPtyManifest(): PtyManifestRow[] {
  try { reapDeadPtyManifest(); } catch { /* fail-soft */ }
  return listPtyManifestRows();
}

export function listPtyManifestRowsAt(dbPath: string): PtyManifestRow[] {
  let d: Database | null = null;
  try {
    if (!existsSync(dbPath)) return [];
    d = new Database(dbPath, { readonly: true });
    const rows = d.query('SELECT * FROM pty_manifest ORDER BY started_at ASC').all() as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  } catch {
    return [];
  } finally {
    try { d?.close(); } catch { /* fail-soft */ }
  }
}

export function listPtyManifestAt(dbPath: string): PtyManifestRow[] {
  return listPtyManifestRowsAt(dbPath).filter((row) => row.frameAt > 0);
}

export function listPtyManifestByRun(runId: string): PtyManifestRow[] {
  try {
    if (!runId) return [];
    const d = db(); if (!d) return [];
    const rows = d.query('SELECT * FROM pty_manifest WHERE run_id=? ORDER BY started_at ASC').all(runId) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

export function getPtyManifest(id: string): PtyManifestRow | null {
  try {
    const d = db(); if (!d) return null;
    const row = d.query('SELECT * FROM pty_manifest WHERE id=?').get(id) as Record<string, unknown> | null;
    return row ? mapRow(row) : null;
  } catch {
    return null;
  }
}

export function readPtyManifestFrame(id: string): { readonly frame: string; readonly frameAt: number } | null {
  const row = getPtyManifest(id);
  return row && row.frameAt > 0 ? { frame: row.frame, frameAt: row.frameAt } : null;
}

function storedTerminalOrigin(r: Record<string, unknown>): TerminalOriginDecision {
  const category = r.terminal_origin_category;
  const reason = r.terminal_origin_reason;
  const externalToolName = r.external_tool_name;
  if (
    (category === 'direct-human' || category === 'elanous' || category === 'external-tool' || category === 'unknown')
    && typeof reason === 'string' && reason.trim() && reason !== category
  ) {
    if (category !== 'external-tool') return { category, reason };
    if (typeof externalToolName === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(externalToolName)) {
      return { category, reason, externalToolName };
    }
  }
  return { category: 'unknown', reason: 'legacy-or-malformed-origin-decision' };
}

function mapRow(r: Record<string, unknown>): PtyManifestRow {
  const terminalOrigin = storedTerminalOrigin(r);
  return {
    id: String(r.id),
    kind: String(r.kind),
    ...(r.nickname ? { nickname: String(r.nickname) } : {}),
    cmd: String(r.cmd),
    ...(r.workdir ? { workdir: String(r.workdir) } : {}),
    ...(r.purpose ? { purpose: String(r.purpose) } : {}),
    ...(r.seat ? { seat: String(r.seat) } : {}),
    ownerPid: Number(r.owner_pid),
    ptyPid: Number(r.pty_pid ?? 0),
    ...(r.liveness_source === 'pty-pid' || r.liveness_source === 'owner-pid' ? { livenessSource: r.liveness_source } : {}),
    instance: String(r.instance),
    startedAt: Number(r.started_at),
    alive: Number(r.alive) === 1,
    exitCode: r.exit_code === null || r.exit_code === undefined ? null : Number(r.exit_code),
    snapshot: String(r.snapshot ?? ''),
    snapshotAt: Number(r.snapshot_at ?? 0),
    outputBytesTotal: Number(r.output_bytes_total ?? 0),
    ...(r.last_control_at === null || r.last_control_at === undefined ? {} : { lastControlAt: Number(r.last_control_at) }),
    frame: String(r.frame ?? ''),
    frameAt: Number(r.frame_at ?? 0),
    runId: String(r.run_id ?? ''),
    runIdSource: normalizeRunIdSource(r.run_id_source),
    spaceId: String(r.space_id ?? ''),
    sessionId: String(r.session_id ?? ''),
    parentPtyId: String(r.parent_pty_id ?? ''),
    parentPid: Number(r.parent_pid ?? 0),
    parentKind: String(r.parent_kind ?? ''),
    ...(r.chain_origin === null || r.chain_origin === undefined ? {} : { chainOrigin: String(r.chain_origin) }),
    ...(r.nest_depth === null || r.nest_depth === undefined ? {} : { nestDepth: Number(r.nest_depth) }),
    ...(r.origin_root === null || r.origin_root === undefined ? {} : { originRoot: String(r.origin_root) }),
    ...(r.origin_agent === null || r.origin_agent === undefined ? {} : { originAgent: String(r.origin_agent) }),
    ...(r.origin_session === null || r.origin_session === undefined ? {} : { originSession: String(r.origin_session) }),
    ...(r.controller === null || r.controller === undefined ? {} : { controller: String(r.controller) }),
    terminalOriginCategory: terminalOrigin.category,
    terminalOriginReason: terminalOrigin.reason,
    ...(terminalOrigin.externalToolName === undefined ? {} : { externalToolName: terminalOrigin.externalToolName }),
    closedAt: Number(r.closed_at ?? 0),
    codeSha: String(r.code_sha ?? ''),
    ...(r.turn_state === 'busy' || r.turn_state === 'idle' ? { turnState: r.turn_state, turnAt: Number(r.turn_at ?? 0) } : {}),
    ...(typeof r.build_sha === 'string' ? { build: mapBuild(r) } : {}),
    updatedAt: Number(r.updated_at),
  };
}

function mapBuild(r: Record<string, unknown>): PtyBuildIdentity {
  const source = r.build_source === 'installed' || r.build_source === 'checkout' ? r.build_source : 'unknown';
  return {
    version: String(r.build_version ?? ''),
    sha: String(r.build_sha ?? ''),
    source,
    ...(typeof r.build_code_root === 'string' && r.build_code_root ? { codeRoot: r.build_code_root } : {}),
  };
}
