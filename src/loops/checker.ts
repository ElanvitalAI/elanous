import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import * as registry from './registry.js';
import { cronMatches } from '../domains/cron-match.js';
import { resolveTimeZone } from '../time/format.js';
import type { ScheduleRow } from '../domains/schedule-registry.js';
import type { LoopEntry, LoopRun } from './registry.js';

type LoopState = 'off' | 'unregistered' | 'failing' | 'late' | 'unknown' | 'alive';
export type LoopScope = 'graph-only' | 'registry';
export interface CheckEntry {
  id: string;
  owner?: string;
  ownerSource?: 'header' | 'config' | 'seat' | 'seat-arg' | 'default';
  evidence?: 'log-mtime' | 'registry';
  mode?: string;
  expectEveryMinutes?: number;
  /** The scheduled fire before the latest one (cron loops). A run older than this missed two scheduled fires. */
  dueAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  recentStatuses?: string[];
  /** Inventory sighting of the scheduled registration (schedule-registry `last_seen`, refreshed on each inventory — not the first sighting); never represented as an execution. */
  observedSince?: string;
  /** Optional launcher evidence; absent values are not inferred from a missing heartbeat. */
  health?: 'healthy' | 'degraded';
  endsAt?: string;
  installedVersion?: string;
  expectedVersion?: string;
  /** Registry graph path, supplied only by graph inventory. */
  file?: string;
  /** LOOP-PRUNE-1021-FU 판정 재료 — cron-shell·미등록 행이 실은 crontab 명세(그래프 루프에는 없다). */
  cron?: string;
  command?: string;
  enabled: boolean;
  registered: boolean;
}
export interface CheckResult extends CheckEntry {
  state: LoopState;
  reason: string;
}
export const LOOP_STATES = ['alive', 'late', 'failing', 'off', 'unregistered', 'unknown'] as const;
export type LoopCounts = Record<LoopState, number>;

export function checkLoops(entries: CheckEntry[], now: Date, opts: { failureStatuses?: readonly string[] } = {}): CheckResult[] {
  const failures = opts.failureStatuses ?? ['failed'];
  return entries.map(entry => {
    let state: LoopState;
    let reason: string;
    const age = entry.lastRunAt ? now.getTime() - Date.parse(entry.lastRunAt) : NaN;
    if (!entry.enabled) { state = 'off'; reason = 'disabled'; }
    else if (!entry.registered) { state = 'unregistered'; reason = 'not registered'; }
    else if (entry.recentStatuses?.length && entry.recentStatuses.length >= 3
      && entry.recentStatuses.slice(0, 3).every(status => failures.includes(status))) {
      state = 'failing'; reason = 'last 3 runs failed';
    } else if (Number.isFinite(age) && entry.dueAt && Number.isFinite(Date.parse(entry.dueAt))) {
      // Judge against the real schedule, not a fixed interval: overnight or weekend gaps are not lateness.
      if (Date.parse(entry.lastRunAt!) < Date.parse(entry.dueAt)) { state = 'late'; reason = `missed the scheduled runs since ${entry.dueAt}`; }
      else { state = 'alive'; reason = 'ran at or after the previous scheduled fire'; }
    } else if (Number.isFinite(age) && entry.expectEveryMinutes !== undefined
      && entry.expectEveryMinutes > 0 && age > entry.expectEveryMinutes * 2 * 60_000) {
      state = 'late'; reason = `last run exceeds twice the expected ${entry.expectEveryMinutes}m interval`;
    } else if (!entry.lastRunAt || !Number.isFinite(age)) { state = 'unknown'; reason = 'no valid run recorded'; }
    else if (entry.expectEveryMinutes === undefined || !Number.isFinite(entry.expectEveryMinutes) || entry.expectEveryMinutes <= 0) {
      state = 'unknown'; reason = 'expected interval unknown';
    } else { state = 'alive'; reason = 'within expected interval'; }
    return { ...entry, state, reason };
  });
}

export type ScheduleFinding = { id: string; owner?: string; kind: 'late' | 'failing' | 'degraded' | 'end-expired' | 'version-mismatch'; reason: string; lastRunAt?: string };

/** Additional scheduler evidence is evaluated only when supplied; the six-state CLI contract stays intact. */
export function scheduleFindings(results: CheckResult[], now: Date): ScheduleFinding[] {
  const findings: ScheduleFinding[] = [];
  for (const row of results) {
    if (!row.enabled || !row.registered) continue;
    const common = { id: row.id, ...(row.owner ? { owner: row.owner } : {}),
      ...(row.lastRunAt ? { lastRunAt: row.lastRunAt } : {}) };
    if (row.state === 'late' || row.state === 'failing') findings.push({ ...common, kind: row.state, reason: row.reason });
    else if (row.state === 'unknown' && !row.lastRunAt && row.observedSince && row.dueAt &&
        Number.isFinite(Date.parse(row.observedSince)) && Number.isFinite(Date.parse(row.dueAt)) &&
        Date.parse(row.observedSince) < Date.parse(row.dueAt))
      findings.push({ ...common, kind: 'late', reason: `no run since observed registration ${row.observedSince}` });
    if (row.health === 'degraded') findings.push({ ...common, kind: 'degraded', reason: 'launcher degraded' });
    if (row.endsAt && Number.isFinite(Date.parse(row.endsAt)) && Date.parse(row.endsAt) <= now.getTime())
      findings.push({ ...common, kind: 'end-expired', reason: `launcher ended at ${row.endsAt}` });
    if (row.installedVersion && row.expectedVersion && row.installedVersion !== row.expectedVersion)
      findings.push({ ...common, kind: 'version-mismatch', reason: `installed ${row.installedVersion}; expected ${row.expectedVersion}` });
  }
  return findings;
}

export function daemonScheduleEntries(rows: readonly ScheduleRow[], now: Date): CheckEntry[] {
  return rows.filter(row => row.enabled && row.cron && (row.run_via === 'elanous' || row.run_via === 'trigger'))
    .map(row => ({ id: row.id, owner: 'OP', enabled: true, registered: true, dueAt: dueBefore(row.cron!, now) ?? undefined,
      ...(row.last_seen ? { observedSince: row.last_seen } : {}),
      ...(row.last_run ? { lastRunAt: row.last_run } : {}),
      ...(row.last_status ? { lastStatus: row.last_status, recentStatuses: [row.last_status] } : {}),
    }));
}

export function versionEvidence(entries: CheckEntry[], repoRoot: string, stateRoot: string): CheckEntry[] {
  return entries.map(entry => {
    if (!entry.file || !/^[\w./-]+\.ya?ml$/.test(entry.file) || entry.file.split('/').includes('..')) return entry;
    const graphPath = resolve(repoRoot, entry.file);
    if (!graphPath.startsWith(resolve(repoRoot) + '/')) return entry;
    const runsPath = join(stateRoot, 'graph-runs', entry.id);
    try {
      if (!existsSync(graphPath) || !existsSync(runsPath)) return entry;
      const latest = readdirSync(runsPath).filter(name => name.endsWith('.json') && !name.endsWith('.decision.json'))
        .sort((a, b) => statSync(join(runsPath, b)).mtimeMs - statSync(join(runsPath, a)).mtimeMs)[0];
      if (!latest) return entry;
      const run = JSON.parse(readFileSync(join(runsPath, latest), 'utf8')) as { graphId?: string; variant?: unknown; graphSnapshot?: { graphSha?: string } };
      if (run.graphId !== entry.id || run.variant || !run.graphSnapshot?.graphSha) return entry;
      const installedVersion = run.graphSnapshot.graphSha;
      const current = createHash('sha256').update(readFileSync(graphPath)).digest('hex');
      return { ...entry, installedVersion, expectedVersion: current };
    } catch (error) {
      debug.log('loop.checker', 'version-unavailable', { id: entry.id, reason: String(error) });
      return entry;
    }
  });
}

export function launcherEvidence(entries: CheckEntry[], root: string): CheckEntry[] {
  const path = join(root, 'msg', 'messages.db');
  if (!existsSync(path)) return entries;
  try {
    const db = new Database(path, { readonly: true });
    try {
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='loop_signals'").get()) return entries;
      const signals = db.query('SELECT loop_id, health, ends_at FROM loop_signals').all() as Array<{
        loop_id: string; health: string; ends_at: string | null;
      }>;
      const byId = new Map(signals.map(signal => [signal.loop_id, signal]));
      return entries.map(entry => {
        const signal = byId.get(entry.id);
        return signal ? { ...entry, ...(signal.health === 'degraded' ? { health: 'degraded' as const } : {}),
          ...(signal.ends_at ? { endsAt: signal.ends_at } : {}) } : entry;
      });
    } finally { db.close(); }
  } catch (error) {
    debug.log('loop.checker', 'launcher-evidence-unavailable', { reason: String(error) });
    return entries;
  }
}

// Extend only an observed healthy launcher that is still heartbeating. The CAS prevents replacing a renewed lease.
export function extendHealthyLauncher(root: string, finding: ScheduleFinding, now: Date): boolean {
  if (finding.kind !== 'end-expired' || !Number.isFinite(now.getTime())) return false;
  const path = join(root, 'msg', 'messages.db');
  if (!existsSync(path)) return false;
  const db = new Database(path);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.query('SELECT at, health, ends_at FROM loop_signals WHERE loop_id=?')
        .get(finding.id) as { at: string; health: string; ends_at: string | null } | null;
      const age = row ? now.getTime() - Date.parse(row.at) : NaN;
      if (!row || row.health !== 'healthy' || !Number.isFinite(age) || age < 0 || age > 15 * 60_000 ||
          !row.ends_at || !Number.isFinite(Date.parse(row.ends_at)) || Date.parse(row.ends_at) > now.getTime()) {
        db.exec('COMMIT');
        return false;
      }
      const result = db.query('UPDATE loop_signals SET ends_at=? WHERE loop_id=? AND at=? AND health=? AND ends_at=?')
        .run(new Date(now.getTime() + 15 * 60_000).toISOString(), finding.id, row.at, row.health, row.ends_at);
      db.exec('COMMIT');
      return result.changes === 1;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

export function countLoopStates(results: CheckResult[]): LoopCounts {
  const counts: LoopCounts = { alive: 0, late: 0, failing: 0, off: 0, unregistered: 0, unknown: 0 };
  for (const result of results) counts[result.state]++;
  return counts;
}

/** Latest cron fire at or before `at` (minute resolution, scans back up to one year). */
export function previousLoopFire(cron: string, at: Date, timeZone: string = resolveTimeZone().timeZone): string | null {
  if (cron.trim().split(/\s+/).length !== 5) return null;
  let minute = Math.floor(at.getTime() / 60000) * 60000;
  for (let i = 0; i < 527040; i++, minute -= 60000) {
    if (cronMatches(cron, new Date(minute), { timeZone })) return new Date(minute).toISOString();
  }
  return null;
}

/** The fire before the latest scheduled fire — a run older than this has missed two scheduled fires. */
export function dueBefore(cron: string, now: Date, timeZone?: string): string | null {
  const latest = previousLoopFire(cron, now, timeZone);
  return latest ? previousLoopFire(cron, new Date(Date.parse(latest) - 60000), timeZone) : null;
}

export interface RegistryAdapterDeps {
  listLoops?: () => LoopEntry[];
  listAllLoops?: () => CheckEntry[];
  statusForLoop?: (id: string) => { recentRuns: Pick<LoopRun, 'status'>[] };
  now?: Date;
  timeZone?: string;
}

export function entriesFromRegistry(deps: RegistryAdapterDeps = {}): { entries: CheckEntry[]; scope: LoopScope } {
  // An explicitly injected graph inventory remains the checker test/adapter fallback.
  const all = deps.listAllLoops ?? (deps.listLoops ? undefined : registry.listAllLoops);
  if (typeof all === 'function') return { entries: all(), scope: 'registry' };
  const now = deps.now ?? new Date();
  return { scope: 'graph-only', entries: (deps.listLoops ?? registry.listLoops)().map(loop => {
    const first = loop.trigger.cron ? registry.nextLoopFire(loop.trigger.cron, now) : null;
    const second = first && loop.trigger.cron ? registry.nextLoopFire(loop.trigger.cron, new Date(first)) : null;
    const interval = first && second ? (Date.parse(second) - Date.parse(first)) / 60_000 : undefined;
    const statuses = loop.lastRun
      ? deps.statusForLoop ? deps.statusForLoop(loop.id).recentRuns.map(run => run.status)
        : deps.listLoops ? [loop.lastRun.status]
          : registry.loopStatus(loop.id).recentRuns.map(run => run.status)
      : [];
    const dueAt = loop.trigger.cron ? dueBefore(loop.trigger.cron, now, deps.timeZone) : null;
    return { id: loop.id, owner: loop.owner ?? undefined, ownerSource: loop.ownerSource, enabled: loop.enabled, registered: true,
      ...(interval !== undefined ? { expectEveryMinutes: interval } : {}),
      ...(dueAt ? { dueAt } : {}),
      ...(loop.lastRun ? { lastRunAt: loop.lastRun.at, lastStatus: loop.lastRun.status } : {}),
      recentStatuses: statuses };
  }) };
}

export interface CheckerDeps {
  root?: string;
  now?: Date;
}

/** Appends only new daily keys to the seat request journal; never rewrites existing lines. */
export function notifyOwners(results: CheckResult[], deps: CheckerDeps = {}, findings: ScheduleFinding[] = [], escalation = false): number {
  const eligible = [
    ...results.filter(result => result.owner && (result.state === 'late' || result.state === 'failing'))
      .map(result => ({ ...result, alertState: result.state })),
    ...findings.filter(result => result.owner && (result.kind !== 'late' && result.kind !== 'failing' ||
      !results.some(row => row.id === result.id && row.state === result.kind)))
      .map(result => ({ ...result, alertState: result.kind })),
  ].filter(result => escalation ? result.owner !== 'OP' : true);
  if (!eligible.length) return 0;
  const now = deps.now ?? new Date();
  const path = join(deps.root ?? effectiveInstanceRoot(), 'seat-requests', 'requests.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  // SQLite's OS locks are released when a process dies, including after SIGKILL.
  // The journal itself remains append-only; this database only serializes check + append.
  const lock = new Database(`${path}.loop-checker.lock.sqlite`);
  try {
    lock.exec('PRAGMA busy_timeout = 10000');
    lock.exec('BEGIN EXCLUSIVE');
    try {
      const existing = new Set<string>();
      const ownerRequests = new Map<string, { queuedAt?: string; status?: string }>();
      if (existsSync(path)) {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (line.trim()) {
            const row = JSON.parse(line) as { key?: string; queuedAt?: string; status?: string };
            if (row.key) {
              existing.add(row.key);
              ownerRequests.set(row.key, row);
            }
          }
        }
      }
      let added = 0;
      for (const result of eligible) {
        const ownerKey = `loopcheck:${result.id}:${now.toISOString().slice(0, 10)}:${result.alertState}`;
        let requestKey = ownerKey;
        if (escalation) {
          const yesterday = new Date(now.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
          const priorKey = `loopcheck:${result.id}:${yesterday}:${result.alertState}`;
          const prior = ownerRequests.get(priorKey);
          if (prior?.status === 'queued' && prior.queuedAt &&
              now.getTime() - Date.parse(prior.queuedAt) >= 30 * 60_000 && !existing.has(`${priorKey}:op`))
            requestKey = priorKey;
        }
        const key = escalation ? `${requestKey}:op` : ownerKey;
        if (existing.has(key)) continue;
        if (escalation) {
          const request = ownerRequests.get(requestKey);
          if (!request || request.status !== 'queued' || !request.queuedAt ||
              now.getTime() - Date.parse(request.queuedAt) < 30 * 60_000) continue;
        }
        const row = { key, receiptId: key, seat: escalation ? 'OP' : result.owner, text: `${result.id} ${result.alertState} — 마지막 ${result.lastRunAt ?? '없음'} · ${result.reason}`,
          status: 'queued', queuedAt: now.toISOString(), source: 'loop-checker' };
        appendFileSync(path, JSON.stringify(row) + '\n');
        existing.add(key);
        added++;
      }
      lock.exec('COMMIT');
      return added;
    } catch (error) {
      lock.exec('ROLLBACK');
      throw error;
    }
  } finally { lock.close(); }
}

/** Persist the previous comparison only for explicit all-status checks. Notification is separate. */
export function observeLoopCheck(results: CheckResult[], scope: LoopScope, deps: CheckerDeps = {}): LoopCounts {
  const path = join(deps.root ?? effectiveInstanceRoot(), 'loop', 'checker', 'last.json');
  let previous: Record<string, LoopState> = {};
  try { previous = JSON.parse(readFileSync(path, 'utf8')) as Record<string, LoopState>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const current: Record<string, LoopState> = {};
  for (const { id, state } of results) {
    current[id] = state;
    if (previous[id] && previous[id] !== state) debug.log('loop.checker', 'state-change', { id, from: previous[id], to: state });
  }
  const counts = countLoopStates(results);
  debug.log('loop.checker', 'checked', { counts, scope });
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(current)); renameSync(tmp, path); }
  catch (error) { if (existsSync(tmp)) unlinkSync(tmp); throw error; }
  return counts;
}

// ── LOOP-PRUNE-1021-FU 정리 판정 (내부 문서 `loop-lineage-1021` · 0.2.36) ─────
/** 무실행 은퇴 한계 — off 상태가 원장으로 최근 14일 실행이 증명될 때만 은퇴 후보가 된다. */
export const PRUNE_IDLE_DAYS = 14;
/** 활성 루프 상한 — alive 가 25 를 넘으면 접기·은퇴 판정을 먼저 치른다. */
export const PRUNE_ALIVE_LIMIT = 25;

export interface PruneFoldGroup { family: string; ids: string[]; }
export interface PruneUnregisteredRow { id: string; cron?: string; command?: string; }
export interface PruneJudgment {
  /** 14일 무실행이 원장으로 증명된 은퇴 후보(off). */
  idleRetire: string[];
  /** 실행 기록이 없어 무실행을 증명할 수 없는 항목 — 은퇴 후보에서 제외한다. */
  idleUnproven: string[];
  /** 등록되지 않은 elanous 크론 행 — 등록/제거 판정에 넘긴다. */
  unregistered: PruneUnregisteredRow[];
  /** 같은 일을 하는 elanous:* 형제 슬롯 가족 — 그래프 루프·원장 해시는 접지 않는다. */
  foldGroups: PruneFoldGroup[];
  /** 활성 루프 수와 25 한도 판정. */
  alive: { count: number; limit: number; within: boolean };
  /** 운영 이름이 없는 원장 해시 id — 명명 대상. */
  unnamed: string[];
}

/** elanous:* 슬롯의 가족 이름 — namedCronIds 의 -N 접미와 자리 슬롯(:SEAT)을 원래 가족으로 되돌린다. */
function pruneFoldFamily(id: string): string | undefined {
  if (!id.startsWith('elanous:')) return undefined;
  const seat = /^elanous:([^:]+):[^:]+$/.exec(id);
  if (seat) return `elanous:${seat[1]}`;
  const sibling = /^elanous:(.+)-\d+$/.exec(id);
  return `elanous:${sibling ? sibling[1] : id.slice('elanous:'.length)}`;
}

/** LOOP-PRUNE-1021-FU — CheckResult 원장 위에서 무실행 은퇴·미등록 정리·형제 접기·alive ≤ 25·이름 없는 해시를 판정한다. */
export function pruneJudgment(results: readonly CheckResult[], opts: { now?: Date } = {}): PruneJudgment {
  const now = opts.now ?? new Date();
  const idleMs = PRUNE_IDLE_DAYS * 24 * 60 * 60_000;
  const idleRetire: string[] = [];
  const idleUnproven: string[] = [];
  const unregistered: PruneUnregisteredRow[] = [];
  const unnamed: string[] = [];
  const families = new Map<string, string[]>();
  let aliveCount = 0;
  for (const result of results) {
    if (result.state === 'alive') aliveCount++;
    if (result.state === 'unregistered') {
      unregistered.push({
        id: result.id,
        ...(result.cron ? { cron: result.cron } : {}),
        ...(result.command ? { command: result.command } : {}),
      });
    }
    if (result.state === 'off') {
      const ran = result.lastRunAt && Number.isFinite(Date.parse(result.lastRunAt)) ? Date.parse(result.lastRunAt) : undefined;
      if (ran === undefined) idleUnproven.push(result.id);
      else if (now.getTime() - ran > idleMs) idleRetire.push(result.id);
    }
    if (/^[0-9a-f]{8,}$/.test(result.id)) unnamed.push(result.id);
    const family = pruneFoldFamily(result.id);
    if (family) {
      const group = families.get(family) ?? [];
      group.push(result.id);
      families.set(family, group);
    }
  }
  const foldGroups: PruneFoldGroup[] = [];
  for (const [family, ids] of families) {
    if (ids.length < 2) continue;
    foldGroups.push({ family, ids: [...ids].sort() });
  }
  const judgment: PruneJudgment = {
    idleRetire,
    idleUnproven,
    unregistered,
    foldGroups,
    alive: { count: aliveCount, limit: PRUNE_ALIVE_LIMIT, within: aliveCount <= PRUNE_ALIVE_LIMIT },
    unnamed,
  };
  debug.log('loop.checker', 'prune', {
    idleRetire: idleRetire.length, idleUnproven: idleUnproven.length, unregistered: unregistered.length,
    folds: foldGroups.length, alive: aliveCount, unnamed: unnamed.length,
  });
  return judgment;
}

/** LOOP-PRUNE-1021-FU — PruneJudgment 을 사람용 정리 판정 줄로 렌더한다(loop status --all 인간 출력 꼬리). */
export function pruneText(judgment: PruneJudgment): string {
  const lines = [
    `무실행 은퇴 ${judgment.idleRetire.length}: ${judgment.idleRetire.join(', ') || '없음'}`,
    `무실행 미증명 ${judgment.idleUnproven.length}: ${judgment.idleUnproven.join(', ') || '없음'}`,
    `미등록 ${judgment.unregistered.length}: ${judgment.unregistered.map(row => row.command ? `${row.id} (${row.command})` : row.id).join(', ') || '없음'}`,
    `형제 접기 ${judgment.foldGroups.length}: ${judgment.foldGroups.map(group => `${group.family}[${group.ids.join('+')}]`).join(', ') || '없음'}`,
    `alive ${judgment.alive.count}/${judgment.alive.limit} ${judgment.alive.within ? '한도 이내' : '한도 초과'}`,
    `이름 없는 해시 ${judgment.unnamed.length}: ${judgment.unnamed.join(', ') || '없음'}`,
  ];
  return lines.join('\n');
}
