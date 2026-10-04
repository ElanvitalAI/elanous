import { execFileSync } from 'node:child_process';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { debug } from '../../debug/log.js';
import { loadRunLedger, resolveFederatedRunLedgerTargets } from '../../self-implement/run-ledger.js';
import type { LogTarget } from '../../cli/logs-cli.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
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
      if (!start?.timestamp) {
        if (!starts.has(runId)) unreadable.set(runId, { runId, reason: entries[0]?.event ?? 'start missing' });
        continue;
      }
      starts.set(runId, { runId, startedAt: start.timestamp });
      unreadable.delete(runId);
    }
  }
  debug.log('loop.orchestrator', 'finish-launch-population', {
    directories: directories.size + unresolvedDirectories, launched: starts.size, childLedgers: childLedgers.size, unreadable: unreadable.size,
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
