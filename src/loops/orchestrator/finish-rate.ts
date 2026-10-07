import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { debug } from '../../debug/log.js';
import { loadRunLedger, resolveFederatedRunLedgerTargets } from '../../self-implement/run-ledger.js';
import { withFileLockSync } from '../../storage/file-lock.js';
import type { LogTarget } from '../../cli/logs-cli.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
/** Host-side records a Pod-dispatched launch leaves when its run starts inside the Pod. */
const LAUNCH_ONLY_EVENTS = new Set(['launch-quota-policy', 'author-on-pod-receipt']);
const GH_LIMIT = 1000;

export type FinishMetric = 'launched' | 'landed' | 'landingRate' | 'staleDrafts' | 'conflictRatio' | 'unknownMergeable';
export type FinishMetrics = {
  launched: number | null;
  launchedUnreadable?: number;
  landed: number | null;
  landingRate: number | null;
  staleDrafts: number | null;
  conflictRatio: number | null;
  unknownMergeable: number | null;
  reasons: Partial<Record<FinishMetric, string>>;
};
export type FinishAdvice = { finishSlots: number; launchSlots: number; state: 'healthy' | 'backlogged' | 'unknown'; reasons: string[] };
export type FinishThresholds = { landingRate?: number; staleDrafts?: number; conflictRatio?: number };

export type FinishTrend = 'worsening' | 'improving' | 'flat' | 'unknown';
export type FinishTrendInput = Pick<FinishMetrics, 'landingRate' | 'staleDrafts' | 'conflictRatio'>;
export type FinishHistoryRow = {
  hour: string; at: string; launched: number | null; landed: number | null;
  landingRate: number | null; staleDrafts: number | null; conflictRatio: number | null; trend: FinishTrend;
};

/** FINISH-RATE 추세 — landingRate 는 내려가면 나쁨 · staleDrafts·conflictRatio 는 올라가면 나쁨.
 *  양쪽 다 유한한 숫자인 지표만 비교한다(못 잰 값은 좋음도 나쁨도 아니다) · 임의 임계 없음.
 *  나쁨 수 > 좋음 수 = worsening · 작으면 improving · 같으면 flat · 비교한 지표가 0 이면 unknown. */
export function finishTrend(previous: FinishTrendInput | null, current: FinishTrendInput): FinishTrend {
  if (!previous) return 'unknown';
  let compared = 0, worse = 0, better = 0;
  for (const key of ['landingRate', 'staleDrafts', 'conflictRatio'] as const) {
    const before = previous[key], after = current[key];
    if (typeof before !== 'number' || !Number.isFinite(before) || typeof after !== 'number' || !Number.isFinite(after)) continue;
    compared++;
    const delta = key === 'landingRate' ? before - after : after - before;
    if (delta > 0) worse++;
    else if (delta < 0) better++;
  }
  if (compared === 0) return 'unknown';
  return worse > better ? 'worsening' : worse < better ? 'improving' : 'flat';
}

export function finishHistoryPath(root: string): string {
  return join(root, 'harness', 'finish-history.jsonl');
}

/** «한 시간 한 줄» 이력 — 같은 UTC 시간 줄이 이미 있으면 안 쓴다(null) · trend 는 지금보다 이른 가장 최근 시간 줄 대비.
 *  읽을 수 없는 줄은 건너뛴다(이력 한 줄이 깨졌다고 측정을 멈추지 않는다). 쓰기 실패는 호출자에게 던진다. */
export function recordFinishHistory(root: string, metrics: FinishMetrics, now: Date): FinishHistoryRow | null {
  const path = finishHistoryPath(root);
  const hour = now.toISOString().slice(0, 13);
  mkdirSync(join(root, 'harness'), { recursive: true });
  // 확인과 덧붙이기를 한 잠금 안에서 — 같은 root 를 쓰는 두 틱이 같은 시간에 둘 다 «없음»을 보고 두 줄을 쓰지 않게.
  const row = withFileLockSync(`${path}.lock`, (): FinishHistoryRow | null => {
    const rows: FinishHistoryRow[] = [];
    let text = '';
    if (existsSync(path)) {
      text = readFileSync(path, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as FinishHistoryRow;
          if (parsed && typeof parsed.hour === 'string') rows.push(parsed);
        } catch { /* a broken line is skipped */ }
      }
    }
    if (rows.some((existing) => existing.hour === hour)) return null;
    // 앞 시간 = 지금보다 이른 줄 중 «가장 최근 UTC 시간»(파일 순서가 아니다 — 늦게 덧붙은 옛 시간 줄이 있을 수 있다) · 같은 시간이면 마지막 줄.
    let previous: FinishHistoryRow | null = null;
    for (const existing of rows) if (existing.hour < hour && (!previous || existing.hour >= previous.hour)) previous = existing;
    const next: FinishHistoryRow = {
      hour, at: now.toISOString(), launched: metrics.launched, landed: metrics.landed,
      landingRate: metrics.landingRate, staleDrafts: metrics.staleDrafts, conflictRatio: metrics.conflictRatio,
      trend: finishTrend(previous, metrics),
    };
    // 부분 쓰기로 끝 개행이 없으면 먼저 보정한다 — 새 줄이 깨진 꼬리에 붙어 둘 다 못 읽게 되지 않게.
    appendFileSync(path, `${text && !text.endsWith('\n') ? '\n' : ''}${JSON.stringify(next)}\n`);
    return next;
  });
  if (!row) return null;
  try {
    debug.log('loop.orchestrator', 'finish-history', {
      hour, trend: row.trend, landingRate: row.landingRate, staleDrafts: row.staleDrafts, conflictRatio: row.conflictRatio,
    });
  } catch { /* the row is written; observation is fail-soft */ }
  return row;
}

type Start = { runId: string; startedAt: string };
type StartObservation = { starts: readonly Start[]; unreadable: readonly { runId: string; reason: string }[]; unreadableDirectories?: number };
type Pr = { number: number; headRefName: string; mergedAt?: string; createdAt?: string; mergeable?: string; labels?: { name: string }[] };
export interface MeasureFinishDeps {
  listStarts?: (cutoff: number) => StartObservation;
  ledgerTargets?: readonly LogTarget[];
  runGh?: (args: string[]) => string;
}

function defaultListStarts(cutoff: number, targets?: readonly LogTarget[]): StartObservation {
  const directories = new Set<string>();
  const starts = new Map<string, Start>();
  const unreadable = new Map<string, { runId: string; reason: string }>();
  const childLedgers = new Set<string>();
  let unreadableDirectories = 0;
  let unresolvedDirectories = 0;
  const launchOnlyIds = new Set<string>();
  for (const { ledgerDirectory } of resolveFederatedRunLedgerTargets({ includeTest: true, ...(targets ? { targets } : {}) })) {
    let dir: string;
    try {
      dir = realpathSync(ledgerDirectory);
    } catch {
      unreadableDirectories += 1;
      unresolvedDirectories += 1;
      continue;
    }
    if (directories.has(dir)) continue;
    directories.add(dir);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      unreadableDirectories += 1;
      continue;
    }
    for (const name of names) {
      if (!/^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(name)) continue;
      const path = join(dir, name);
      if (statSync(path).mtimeMs < cutoff) continue;
      const runId = name.slice(0, -'.jsonl'.length);
      const entries = loadRunLedger(runId, dir);
      if (!entries) throw new Error(`run ledger disappeared: ${runId}`);
      if (entries[0]?.event === 'pod-child-run') {
        childLedgers.add(runId);
        continue;
      }
      const start = entries.find(entry => entry.event === 'start');
      // A Pod-dispatched launch leaves only a host launch record (launch-quota-policy · author-on-pod-receipt) — the run
      // itself starts inside the Pod. That is still a launch: its time is the record's timestamp, else the ledger mtime.
      const launchRecord = !start ? entries.find(entry => LAUNCH_ONLY_EVENTS.has(entry.event)) : undefined;
      const startedAt = start?.timestamp ?? (launchRecord ? (launchRecord.timestamp ?? new Date(statSync(path).mtimeMs).toISOString()) : undefined);
      if (!startedAt) {
        if (!starts.has(runId)) unreadable.set(runId, { runId, reason: entries[0]?.event ?? 'start missing' });
        continue;
      }
      // One runId can leave a host launch record in one directory and a Pod `start` in another: a real `start`
      // always wins and is never overwritten by a launch record, whatever order the directories are read in.
      if (launchRecord && starts.has(runId)) continue;
      if (launchRecord) launchOnlyIds.add(runId); else launchOnlyIds.delete(runId);
      starts.set(runId, { runId, startedAt });
      unreadable.delete(runId);
    }
  }
  debug.log('loop.orchestrator', 'finish-launch-population', {
    directories: directories.size + unresolvedDirectories, launched: starts.size, launchOnly: launchOnlyIds.size, childLedgers: childLedgers.size, unreadable: unreadable.size,
  });
  return { starts: [...starts.values()], unreadable: [...unreadable.values()], unreadableDirectories };
}

function defaultRunGh(args: string[]): string {
  return execFileSync('gh', args, { cwd: resolve(import.meta.dir, '../../..'), encoding: 'utf8', timeout: 60_000, maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function readPrs(runGh: (args: string[]) => string, args: string[]): Pr[] {
  const parsed: unknown = JSON.parse(runGh(['pr', 'list', ...args, '--limit', String(GH_LIMIT)]));
  if (!Array.isArray(parsed) || parsed.length >= GH_LIMIT || parsed.some(pr => !pr || typeof pr !== 'object'
    || typeof pr.number !== 'number' || typeof pr.headRefName !== 'string')) throw new Error('incomplete or invalid PR observation');
  return parsed as Pr[];
}

function reason(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Read each source independently; an unreadable source never becomes a measured zero. */
export function measureFinish(deps: MeasureFinishDeps = {}, now: Date = new Date()): FinishMetrics {
  const reasons: FinishMetrics['reasons'] = {};
  const cutoff = now.getTime() - DAY_MS;
  let launched: number | null = null;
  let launchedUnreadable = 0;
  let landed: number | null = null;
  let staleDrafts: number | null = null;
  let conflictRatio: number | null = null;
  let unknownMergeable: number | null = null;
  const gh = deps.runGh ?? defaultRunGh;
  try {
    const observation = deps.listStarts ? deps.listStarts(cutoff) : defaultListStarts(cutoff, deps.ledgerTargets);
    if (!observation || !Array.isArray(observation.starts) || !Array.isArray(observation.unreadable)
      || observation.starts.some(start => !start || typeof start.runId !== 'string' || !Number.isFinite(Date.parse(start.startedAt)))
      || observation.unreadable.some(entry => !entry || typeof entry.runId !== 'string' || typeof entry.reason !== 'string')) throw new Error('invalid run start observation');
    launched = new Set(observation.starts.filter(start => Date.parse(start.startedAt) >= cutoff && Date.parse(start.startedAt) <= now.getTime()).map(start => start.runId)).size;
    launchedUnreadable = observation.unreadable.length;
    if (launchedUnreadable > 0) {
      reasons.launched = `${launchedUnreadable}개 원장 시작 줄 없음(하한값)`;
      debug.log('loop.orchestrator', 'finish-ledger-unreadable', { count: launchedUnreadable, sample: observation.unreadable.slice(0, 5) });
    }
    if (observation.unreadableDirectories) {
      reasons.launched = [reasons.launched, `원장 폴더 ${observation.unreadableDirectories}개 못 읽음(하한값)`].filter(Boolean).join(' · ');
    }
  } catch (error) { reasons.launched = reason(error); }
  try {
    const prs = readPrs(gh, ['--state', 'merged', '--search', `merged:>=${new Date(cutoff).toISOString().replace(/\.\d{3}Z$/, 'Z')}`, '--json', 'number,headRefName,mergedAt']);
    if (prs.some(pr => typeof pr.mergedAt !== 'string' || !Number.isFinite(Date.parse(pr.mergedAt)))) throw new Error('invalid merged PR timestamp');
    landed = new Set(prs.filter(pr => pr.headRefName.startsWith('self-impl/') && Date.parse(pr.mergedAt!) >= cutoff
      && Date.parse(pr.mergedAt!) <= now.getTime()).map(pr => pr.number)).size;
  } catch (error) { reasons.landed = reason(error); }
  try {
    const drafts = readPrs(gh, ['--state', 'open', '--draft', '--json', 'number,headRefName,createdAt,mergeable,labels']);
    if (drafts.some(pr => typeof pr.createdAt !== 'string' || !Number.isFinite(Date.parse(pr.createdAt)) || !Array.isArray(pr.labels)
      || pr.labels.some(label => !label || typeof label.name !== 'string'))) throw new Error('invalid draft observation');
    staleDrafts = drafts.filter(pr => pr.headRefName.startsWith('self-impl/') && Date.parse(pr.createdAt!) < cutoff
      && !pr.labels!.some(label => label.name === 'elanous:superseded')).length;
  } catch (error) { reasons.staleDrafts = reason(error); }
  try {
    const prs = readPrs(gh, ['--state', 'open', '--json', 'number,headRefName,mergeable']);
    const harness = prs.filter(pr => pr.headRefName.startsWith('self-impl/'));
    if (harness.some(pr => !['CONFLICTING', 'MERGEABLE', 'UNKNOWN'].includes(pr.mergeable ?? ''))) throw new Error('invalid mergeability observation');
    unknownMergeable = harness.filter(pr => pr.mergeable === 'UNKNOWN').length;
    const known = harness.length - unknownMergeable;
    if (known === 0) reasons.conflictRatio = 'no open harness PRs with known mergeability';
    else conflictRatio = harness.filter(pr => pr.mergeable === 'CONFLICTING').length / known;
  } catch (error) { reasons.conflictRatio = reason(error); reasons.unknownMergeable = reason(error); unknownMergeable = null; }
  let landingRate: number | null = null;
  if (launched === null) reasons.landingRate = `launched unavailable: ${reasons.launched}`;
  else if (landed === null) reasons.landingRate = `landed unavailable: ${reasons.landed}`;
  else if (launched === 0) reasons.landingRate = reasons.launched
    ? `launched lower bound is zero — launch population unknown: ${reasons.launched}`
    : 'no harness runs launched in the last 24 hours';
  else if (landed > launched) reasons.landingRate = `landed exceeds launched — population mismatch (launched=${launched}, landed=${landed})`;
  else landingRate = landed / launched;
  return { launched, ...(launchedUnreadable > 0 ? { launchedUnreadable } : {}), landed, landingRate, staleDrafts, conflictRatio, unknownMergeable, reasons };
}

/** Advice only: no launch cap, PR, or config is changed. */
export function finishAdvice(metrics: FinishMetrics, totalSlots: number, thresholds: FinishThresholds = {}): FinishAdvice {
  const reasons: string[] = [];
  const missing = (['launched', 'landed', 'landingRate', 'staleDrafts', 'conflictRatio', 'unknownMergeable'] as const)
    .filter(key => metrics[key] === null).map(key => `${key}: ${metrics.reasons[key] ?? 'unavailable'}`);
  let state: FinishAdvice['state'];
  let desired: number;
  if (missing.length) { state = 'unknown'; desired = 6; reasons.push(...missing); }
  else {
    if (metrics.landingRate! < (thresholds.landingRate ?? 0.5)) reasons.push('landingRate below threshold');
    if (metrics.staleDrafts! > (thresholds.staleDrafts ?? 20)) reasons.push('staleDrafts above threshold');
    if (metrics.conflictRatio! > (thresholds.conflictRatio ?? 0.3)) reasons.push('conflictRatio above threshold');
    state = reasons.length ? 'backlogged' : 'healthy';
    desired = state === 'backlogged' ? Math.max(6, Math.ceil(totalSlots * 0.3)) : 2;
  }
  if (metrics.launched !== null && metrics.reasons.launched) reasons.push(metrics.reasons.launched);
  const finishSlots = Math.min(totalSlots, desired);
  return { finishSlots, launchSlots: totalSlots - finishSlots, state, reasons };
}
