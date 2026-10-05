// 흡수 갈래(⑤) — 흡수가 끝난 항목의 대조 결과를 산출 큐(outbox)로 나눈다. RFC-regular-external-intake §4 (P4).
// 결정론만: 판정 모델·LLM 을 부르지 않는다. 받는 쪽(🅢 입구 · 문서 소유 · 🅣 P10)이 큐를 읽는다.
// ⛔ 원장의 `text`(개인 메모일 수 있다)는 큐에 싣지 않는다 — 대조가 낸 사실·근거와 노트 경로만.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { getToxRuntimeDeps } from '../task-orchestrator/runtime-deps.js';
import type { TaskStore } from '../task-orchestrator/store.js';
import type { TaskStatus } from '../task-orchestrator/types.js';
import { canonicalUrl, ingestIntakeItems, intakeItemId, intakeLedgerDir, loadIntakeLedger, markIntakeItem, type IntakeItem } from './items.js';

/** `elanous intake check --json` 산출 중 갈래가 읽는 칸. */
export interface IntakeCheckJson {
  commit?: string;
  tree?: string;
  items: { fact: string; current: string; verdict: string; evidence?: { axis?: string; summary?: string; path?: string; line?: number; repoKind?: string }[]; patterns?: string[] }[];
  goalDraftPaths?: string[];
}

type RouteMeasurement = { unmeasured: number; measured: number };
export interface RouteResult extends RouteMeasurement { id: string; goals: number; manual: number; review: number; grounding: number; release: number; dryRun: boolean; skipped?: string }

/** 큐 파일의 날짜 — KST. 다이제스트가 KST 하루로 읽는다(07:00 KST 크론은 UTC 로 «전날»이다). */
export const kstDay = (iso: string): string => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);

/** 근거 파일의 마지막 착지 커밋 — 🅣 릴리스 루프 컷오프가 «커밋 C 이전인가»를 가른다. 못 구하면 undefined. */
export type LastCommitOf = (tree: string, path: string) => string | undefined;
export const gitLastCommitOf: LastCommitOf = (tree, path) => {
  try { return execFileSync('git', ['-C', tree, 'log', '-1', '--format=%H', '--', path], { encoding: 'utf8', timeout: 10_000 }).trim() || undefined; } catch { return undefined; }
};

export function intakeOutboxDir(root: string): string { return join(intakeLedgerDir(root), 'outbox'); }

export const INTAKE_EVENT_DEFERRED_REPLY = '일일 즉시 흡수 상한을 넘어 다음 일일 판으로 미뤘습니다.';
export type IntakeEventResult = { status: 'scheduled' | 'deferred' | 'duplicate'; reason: string; url: string; reply?: string };

// A lost claim must become eligible at the next daily pass; live tasks remain excluded.
const INTAKE_EVENT_LEASE_MS = 23 * 3600_000;

// A non-terminal task that has not been touched for this long is treated as a dead worker.
const INTAKE_EVENT_TASK_STALE_MS = 2 * 3600_000;

/** A probe may return the bare status, or the status with the task's last update (epoch ms). */
export type IntakeEventTaskProbe = (id: string) => TaskStatus | { status: TaskStatus; updatedAt?: number } | undefined;

function eventTaskStatus(taskId: string): { status: TaskStatus; updatedAt?: number } | undefined {
  const deps = getToxRuntimeDeps();
  const graphTask = deps.getGraph()?.getTask(taskId) ?? (deps.getStore?.() as TaskStore | null | undefined)?.getTask(taskId);
  return graphTask ? { status: graphTask.status, updatedAt: graphTask.updatedAt } : undefined;
}

function probeStatus(probe: IntakeEventTaskProbe, id: string): { status?: TaskStatus; updatedAt?: number } {
  const value = probe(id);
  return typeof value === 'string' ? { status: value } : value ?? {};
}

type EventClaim = { status: string; task_id: string | null; claimed_at: string | null; day: string };

function activeEventClaim(row: EventClaim, now: string, taskStatus: IntakeEventTaskProbe): boolean {
  if (row.status !== 'scheduled' && row.status !== 'pending') return false;
  const { status, updatedAt } = row.task_id ? probeStatus(taskStatus, row.task_id) : {};
  if (status === 'done') return true;
  if (status === 'failed' || status === 'cancelled' || status === 'superseded') return false;
  const claimedAt = Date.parse(row.claimed_at ?? `${row.day}T00:00:00.000+09:00`);
  const withinLease = Number.isFinite(claimedAt) && Date.parse(now) - claimedAt < INTAKE_EVENT_LEASE_MS;
  if (!status) return withinLease;
  // A status alone is not liveness: a crashed worker leaves «running» behind, so require a recent update.
  if (updatedAt !== undefined && Number.isFinite(updatedAt)) return Date.parse(now) - updatedAt < INTAKE_EVENT_TASK_STALE_MS;
  return withinLease;
}

/** Claim an event slot before posting. The unique URL and KST-day quota share one SQLite transaction. */
export async function scheduleIntakeEvent(
  root: string,
  url: string,
  opts: {
    eventMax?: number;
    now?: string;
    post: (input: { url: string }) => Promise<{ taskId: string }>;
  },
): Promise<IntakeEventResult> {
  const normalized = canonicalUrl(url);
  if (!normalized) throw new Error('intake event requires an HTTP(S) URL');
  const now = opts.now ?? new Date().toISOString();
  const day = kstDay(now);
  const id = intakeItemId('telegram-bot', { url: normalized });
  const max = opts.eventMax ?? 10;
  if (!Number.isSafeInteger(max) || max < 0) throw new RangeError('intake.eventMax must be a non-negative integer');
  const existing = loadIntakeLedger(root).items.get(id);
  if (existing && ['queued', 'absorbed', 'checked', 'routed', 'discarded'].includes(existing.status)) {
    return { status: 'duplicate', url: normalized, reason: 'already-in-ledger' };
  }
  mkdirSync(intakeLedgerDir(root), { recursive: true });
  const db = new Database(join(intakeLedgerDir(root), 'events.sqlite'), { create: true });
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS intake_events (
      url TEXT PRIMARY KEY, day TEXT NOT NULL, status TEXT NOT NULL, task_id TEXT, claimed_at TEXT
    )`);
    const columns = db.query('PRAGMA table_info(intake_events)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'claimed_at')) db.exec('ALTER TABLE intake_events ADD COLUMN claimed_at TEXT');
    // One row per claim that reached the task queue — the KST-day quota counts these, not current statuses.
    db.exec('CREATE TABLE IF NOT EXISTS intake_event_claims (url TEXT NOT NULL, day TEXT NOT NULL, claimed_at TEXT NOT NULL, PRIMARY KEY (url, claimed_at))');
    const claim = db.transaction((): 'scheduled' | 'deferred' | 'duplicate' => {
      const previous = db.query('SELECT status, task_id, claimed_at, day FROM intake_events WHERE url = ?').get(normalized) as EventClaim | null;
      if (previous && activeEventClaim(previous, now, eventTaskStatus)) {
        if (previous.task_id && eventTaskStatus(previous.task_id)?.status === 'done') {
          db.query("UPDATE intake_events SET status = 'completed' WHERE url = ?").run(normalized);
        }
        return 'duplicate';
      }
      if (previous && previous.status !== 'failed' && previous.status !== 'expired'
        && previous.status !== 'pending' && previous.status !== 'scheduled') {
        return previous.status === 'deferred' ? 'deferred' : 'duplicate';
      }
      const count = db.query('SELECT count(*) AS n FROM intake_event_claims WHERE day = ?').get(day) as { n: number };
      const status = count.n >= max ? 'deferred' : 'pending';
      db.query(`INSERT INTO intake_events (url, day, status, claimed_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET day = excluded.day, status = excluded.status, claimed_at = excluded.claimed_at, task_id = NULL`)
        .run(normalized, day, status, now);
      if (status === 'pending') db.query('INSERT OR IGNORE INTO intake_event_claims (url, day, claimed_at) VALUES (?, ?, ?)').run(normalized, day, now);
      return status === 'pending' ? 'scheduled' : 'deferred';
    })();
    if (claim === 'duplicate') return { status: 'duplicate', url: normalized, reason: 'already-claimed' };
    if (claim === 'deferred') {
      ingestIntakeItems(root, 'telegram-bot', [{ url: normalized }], now);
      debug.log('intake.event', 'deferred', { url: normalized, reason: 'event-max' });
      return { status: 'deferred', url: normalized, reason: 'event-max', reply: INTAKE_EVENT_DEFERRED_REPLY };
    }
    let posted: { taskId: string };
    try {
      ingestIntakeItems(root, 'telegram-bot', [{ url: normalized }], now);
      posted = await opts.post({ url: normalized });
      if (!posted.taskId) throw new Error('intake event post returned no taskId');
    } catch (error) {
      db.query('DELETE FROM intake_events WHERE url = ? AND status = ? AND claimed_at = ?').run(normalized, 'pending', now);
      db.query('DELETE FROM intake_event_claims WHERE url = ? AND claimed_at = ?').run(normalized, now);
      throw error;
    }
    db.query("UPDATE intake_events SET status = 'scheduled', task_id = ? WHERE url = ? AND status = 'pending' AND claimed_at = ?")
      .run(posted.taskId, normalized, now);
    debug.log('intake.event', 'scheduled', { url: normalized, reason: 'telegram-absorb' });
    return { status: 'scheduled', url: normalized, reason: 'telegram-absorb' };
  } finally {
    db.close();
  }
}

/** Only an active task or a fresh claim excludes a URL from the daily queue. */
export function wasIntakeEventScheduled(root: string, url: string, now = new Date().toISOString(), taskStatus: IntakeEventTaskProbe = eventTaskStatus): boolean {
  const file = join(intakeLedgerDir(root), 'events.sqlite');
  if (!existsSync(file)) return false;
  const normalized = canonicalUrl(url);
  if (!normalized) return false;
  const db = new Database(file);
  try {
    const row = db.query('SELECT status, task_id, claimed_at, day FROM intake_events WHERE url = ?').get(normalized) as EventClaim | null;
    if (!row || (row.status !== 'scheduled' && row.status !== 'pending')) return row?.status === 'completed';
    if (activeEventClaim(row, now, taskStatus)) {
      if (row.task_id && probeStatus(taskStatus, row.task_id).status === 'done') {
        db.query("UPDATE intake_events SET status = 'completed' WHERE url = ?").run(normalized);
      }
      return true;
    }
    const status = row.task_id ? probeStatus(taskStatus, row.task_id).status : undefined;
    db.query("UPDATE intake_events SET status = ? WHERE url = ? AND status IN ('pending', 'scheduled')")
      .run(status === 'failed' || status === 'cancelled' || status === 'superseded' ? 'failed' : 'expired', normalized);
    return false;
  } finally {
    db.close();
  }
}

function appendJsonl(file: string, rows: unknown[]): void {
  if (!rows.length) return;
  mkdirSync(join(file, '..'), { recursive: true });
  appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function groundingHas(root: string, path: string): boolean {
  const file = join(intakeOutboxDir(root), 'grounding.jsonl');
  if (!existsSync(file)) return false;
  return readFileSync(file, 'utf8').split('\n').some((l) => { try { return JSON.parse(l).path === path; } catch { return false; } });
}

/**
 * 갈래 규칙:
 *  - 「없음」 → goals (골 후보 · 저작은 받는 쪽이 `intake check --author` 로)
 *  - 「판단 필요」이면서 근거가 문서·주석뿐 → manual (문서가 늙었거나 약속만 있는 자리)
 *  - 그 밖의 「판단 필요」 → review (사람이 노트 🧭 절을 읽고 가른다 · 다이제스트에 수를 싣는다)
 *  - 흡수 노트 → grounding 후보(한 번만) · 태그 `intake:<입력원>`
 * 이미 routed 인 항목은 다시 나누지 않는다.
 */
export function routeIntakeItem(root: string, id: string, check: IntakeCheckJson, opts: { dryRun?: boolean; lastCommitOf?: LastCommitOf } = {}, now = new Date().toISOString()): RouteResult {
  const item = loadIntakeLedger(root).items.get(id);
  if (!item) return { id, goals: 0, manual: 0, review: 0, grounding: 0, release: 0, unmeasured: 0, measured: 0, dryRun: !!opts.dryRun, skipped: '원장에 없는 id' };
  if (item.status === 'routed') return { id, goals: 0, manual: 0, review: 0, grounding: 0, release: 0, unmeasured: 0, measured: 0, dryRun: !!opts.dryRun, skipped: '이미 routed' };
  const unmeasured = check.items.filter((c) => c.verdict === '못 쟀다').length;
  const measured = check.items.length - unmeasured;
  if (measured === 0 && unmeasured > 0) {
    debug.log('intake.route', 'all-unmeasured', { id, unmeasured });
    return { id, goals: 0, manual: 0, review: 0, grounding: 0, release: 0, unmeasured, measured, dryRun: !!opts.dryRun, skipped: '모든 주장을 못 쟀다 — 대조를 다시 돌려라' };
  }
  const day = kstDay(now);
  const base = { id, at: now, source: item.source, ...(item.url ? { url: item.url } : {}), ...(check.commit ? { commit: check.commit } : {}) };
  const goals = check.items.filter((c) => c.verdict === '없음').map((c) => ({
    ...base, fact: c.fact, current: c.current, patterns: c.patterns ?? [], goalDraftPaths: check.goalDraftPaths ?? [],
  }));
  const docOnly = (c: IntakeCheckJson['items'][number]) => /문서|주석|약속/.test(c.current);
  const manual = check.items.filter((c) => c.verdict === '판단 필요' && docOnly(c)).map((c) => ({
    ...base, fact: c.fact, current: c.current, evidence: (c.evidence ?? []).slice(0, 3).map((e) => e.summary ?? '').filter(Boolean),
  }));
  const note = noteOf(item);
  const review = check.items.filter((c) => c.verdict === '판단 필요' && !docOnly(c)).map((c) => ({
    ...base, fact: c.fact, current: c.current, ...(note ? { note } : {}),
  }));
  // O4 — 「있음」이면서 실행 코드 근거가 있는 것 = 바깥 지식이 «이미 착지한 기능»에 닿는다 → 릴리스 노트 바깥 맥락(🅣 T-R 합의 줄 모양).
  const lastCommitOf = opts.lastCommitOf ?? gitLastCommitOf;
  const release = check.items.flatMap((c) => {
    if (c.verdict !== '있음') return [];
    const code = (c.evidence ?? []).filter((e) => e.axis === 'repo' && e.repoKind === 'behavior' && e.path);
    if (!code.length) return [];
    const landedSha = check.tree ? lastCommitOf(check.tree, code[0].path!.replace(/:\d+$/, '')) : undefined;
    return [{
      id, at: now, kind: 'docs' as const, title: c.fact, summary: c.current, sources: item.url ? [item.url] : [],
      evidence: code.slice(0, 3).map((e) => `${e.path}${e.line ? `:${e.line}` : ''}`), suggestedSection: '바깥 맥락',
      ...(landedSha ? { landedSha } : {}),
    }];
  });
  const grounding = note && !groundingHas(root, note) ? [{ path: note, kind: 'local-docs', tag: `intake:${item.source}`, at: now, id }] : [];
  if (!opts.dryRun) {
    const out = intakeOutboxDir(root);
    appendJsonl(join(out, 'goals', `${day}.jsonl`), goals);
    appendJsonl(join(out, 'manual', `${day}.jsonl`), manual);
    appendJsonl(join(out, 'review', `${day}.jsonl`), review);
    appendJsonl(join(out, 'grounding.jsonl'), grounding);
    appendJsonl(join(out, 'release', `${day}.jsonl`), release);
    markIntakeItem(root, id, { status: 'routed' }, now);
  }
  debug.log('intake.route', 'item-routed', { id, goals: goals.length, manual: manual.length, review: review.length, grounding: grounding.length, release: release.length, unmeasured, measured, dryRun: !!opts.dryRun });
  return { id, goals: goals.length, manual: manual.length, review: review.length, grounding: grounding.length, release: release.length, unmeasured, measured, dryRun: !!opts.dryRun };
}

function noteOf(item: IntakeItem): string | undefined {
  return [...item.outputs].reverse().find((o) => o.kind === 'note')?.ref;
}
