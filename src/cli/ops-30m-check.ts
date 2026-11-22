import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { readOpChecklistGreen } from '../release-loop/checklist-readonly.js';
export { readOpChecklistGreen } from '../release-loop/checklist-readonly.js';

export interface OpThirtyMinuteSources {
  lastFetchAt?: string | null;
  mainLog: string;
  mainPackage: string;
  checklist: string;
  trainLog: string;
  reviewQueue: string;
  landingSubLog: string;
}

function observation(text: string, pattern: RegExp, now: number) {
  let latest: number | null = null;
  for (const line of text.split(/\r?\n/u)) {
    if (line.length > 256 || !pattern.test(line)) continue;
    const iso = line.match(/(?:^|\s)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?=\s|$)/u);
    const local = line.match(/^(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?(?=\s|$)/u);
    let time = iso ? Date.parse(iso[1]) : NaN;
    if (!iso && local) {
      const [, month, day, hour, minute, second = '0'] = local;
      // Yearless operational logs use host local time; resolve the nearest year,
      // then reject future timestamps rather than treating them as fresh.
      const parts = [Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)];
      const year = new Date(now).getFullYear();
      const candidates = [year - 1, year, year + 1].map((y) => new Date(y, parts[0], parts[1], parts[2], parts[3], parts[4]));
      const valid = candidates.filter((d) => d.getMonth() === parts[0] && d.getDate() === parts[1] && d.getHours() === parts[2] && d.getMinutes() === parts[3] && d.getSeconds() === parts[4]);
      valid.sort((a, b) => Math.abs(a.getTime() - now) - Math.abs(b.getTime() - now));
      time = valid[0]?.getTime() ?? NaN;
    }
    if (Number.isFinite(time) && time <= now && (latest === null || time > latest)) latest = time;
  }
  const ageSec = latest === null ? null : (now - latest) / 1000;
  const observed = ageSec !== null && ageSec <= 1800;
  return { observed, lastSeenAt: latest === null ? null : new Date(latest).toISOString(), ageSec,
    ...(!observed ? { reason: latest === null ? 'no-timestamped-observation' : 'stale' } : {}) };
}

/** Parse the actual sources; a malformed queue cannot silently become zero unclaimed reviews. */
export function opThirtyMinuteSnapshot(sources: OpThirtyMinuteSources, previousGreen?: number, now = Date.now()) {
  const packageData = JSON.parse(sources.mainPackage) as { version?: unknown };
  if (typeof packageData.version !== 'string' || !/^\d+\.\d+\.\d+(?:-dev\.\d+)?$/u.test(packageData.version))
    throw new Error('main package version is invalid');
  const version = packageData.version.replace(/-dev\.\d+$/u, '');
  const checklist = JSON.parse(sources.checklist) as { green?: unknown; evidence?: string; items?: Array<{ status?: string }> };
  const green = typeof checklist.green === 'number' && Number.isInteger(checklist.green) ? checklist.green
    : Array.isArray(checklist.items) ? checklist.items.filter((item) => item.status === 'green').length : null;
  const checklistEvidence = checklist.evidence ?? 'checklist source';

  const lines = sources.reviewQueue.split(/\r?\n/u).filter(Boolean);
  // OP queue v2 defines only the first four columns; later cells are notes.
  const header = lines.shift()?.split('\t').slice(0, 4) ?? [];
  if (header.join('\t') !== 'pr\tengine\tclaimedBy\tstatus') throw new Error('review queue columns are unavailable');
  const claimIndex = 2;
  const statusIndex = 3;
  let malformedQueueRows = 0;
  let malformedUnclaimedQueueRows = 0;
  let prQueueRows = 0;
  let legacyQueueRows = 0;
  let unclaimed = 0;
  let unknownQueueRows = 0;
  let unclaimedUnknownQueueRows = 0;
  const terminal = new Set(['pass', 'pass-with-warn', 'fail', 'warn', 'skip', 'reviewed', 'merged', 'done', 'done-merged', 'done-closed', 'closed', '사후']);
  const candidates = new Set(['queued', 'ready', 'blocked', 'pending', '-', '']);
  for (const line of lines) {
    const row = line.split('\t');
    if (row.length < 4) { malformedQueueRows++; if (!row[2]?.trim()) malformedUnclaimedQueueRows++; continue; }
    const first = row[0].trim();
    const digits = (part: string, length?: number) => part.length > 0 && (length === undefined || part.length === length)
      && [...part].every((ch) => ch >= '0' && ch <= '9');
    const firstToken = first.split(' ')[0];
    const pr = firstToken.startsWith('#') ? firstToken.slice(1) : firstToken;
    if (!digits(pr)) {
      // Legacy timestamps are dates with a time or a time of day, not arbitrary labels.
      const dateTime = first.split('T');
      const date = dateTime.length === 2 ? dateTime[0].split('-') : [];
      const time = (dateTime.length === 2 ? dateTime[1] : first).replace('Z', '').split(':');
      const validDate = date.length === 3 && digits(date[0], 4) && digits(date[1], 2) && digits(date[2], 2);
      const validTime = (time.length === 2 || time.length === 3) && time.every((part) => digits(part, 2));
      if (validTime && (dateTime.length === 1 || validDate)) legacyQueueRows++;
      else { malformedQueueRows++; if (!row[2]?.trim()) malformedUnclaimedQueueRows++; }
      continue;
    }
    prQueueRows++;
    const status = row[statusIndex].trim().toLowerCase();
    let end = 0;
    while (end < status.length && ![' ', '\t', '\n', '\r', '·', '('].includes(status[end])) end++;
    const token = status.slice(0, end);
    const claimed = Boolean(row[claimIndex].trim());
    if (candidates.has(token)) { if (!claimed) unclaimed++; }
    else if (!terminal.has(token) && !token.startsWith('claim:')) {
      unknownQueueRows++;
      if (!claimed) unclaimedUnknownQueueRows++;
    }
  }
  const trainTick = observation(sources.trainLog, /\[train-manager\] tick\b/u, now);
  const landingSub = observation(sources.landingSubLog, /\S/u, now);
  const trainTickObserved = trainTick.observed;
  const landingSubObserved = landingSub.observed;
  const greenDelta = green !== null && Number.isInteger(previousGreen) && previousGreen! >= 0 ? green - previousGreen! : null;
  const landedSubjects = sources.mainLog.split(/\r?\n/u).filter(Boolean);
  const landings30m = landedSubjects.length;
  const landingsWithoutPr30m = landedSubjects.filter((line) => {
    const firstTab = line.indexOf('\t');
    const secondTab = line.indexOf('\t', firstTab + 1);
    const parents = firstTab < 0 || secondTab < 0 ? '' : line.slice(firstTab + 1, secondTab);
    const subject = secondTab < 0 ? '' : line.slice(secondTab + 1);
    const count = parents ? parents.split(' ').length : 0;
    return count < 2 && !(count === 1 && /\(#\d+\)$/u.test(subject));
  }).length;
  const lastFetchAt = sources.lastFetchAt ?? null;
  const fetchTime = lastFetchAt ? Date.parse(lastFetchAt) : NaN;
  const fetchStale = !Number.isFinite(fetchTime) || now - fetchTime > 30 * 60_000 || fetchTime > now;
  return {
    lastFetchAt, fetchStale, version, landings30m, landingsWithoutPr30m, landingTarget: 10, green, greenDelta, greenDeltaTarget: 5, checklistEvidence,
    reviewUnclaimed: malformedUnclaimedQueueRows ? null : unclaimed, prQueueRows, malformedQueueRows, malformedUnclaimedQueueRows, legacyQueueRows, unknownQueueRows, unclaimedUnknownQueueRows, trainTickObserved, landingSubObserved,
    trainTick, landingSub,
    queueComplete: malformedUnclaimedQueueRows === 0 && unclaimedUnknownQueueRows === 0,
    complete: !fetchStale && greenDelta !== null && malformedUnclaimedQueueRows === 0 && unclaimedUnknownQueueRows === 0 && trainTickObserved && landingSubObserved,
  };
}

function command(file: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(file, args, { ...(cwd ? { cwd } : {}), ...(env ? { env } : {}), encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
}

/** The fixture replaces external sources only; the same snapshot parser runs in both paths. */
export function loadOpThirtyMinuteSources(): OpThirtyMinuteSources {
  const stateRoot = effectiveInstanceRoot();
  const fixture = isAbsolute(stateRoot) ? join(resolve(stateRoot), 'fixtures', 'op-30m-sources.json') : null;
  if (resolve(stateRoot) !== resolve(prodInstanceRoot())) {
    if (fixture && existsSync(fixture)) return JSON.parse(readFileSync(fixture, 'utf8')) as OpThirtyMinuteSources;
    throw new Error('isolated OP 30-minute check requires sources fixture inside ELANOUS_STATE_DIR');
  }
  const hq = process.env.ELANOUS_HQ_ROOT ? resolve(process.env.ELANOUS_HQ_ROOT) : join(homedir(), 'elanous-hq');
  return loadLocalOpThirtyMinuteSources(hq);
}

/** A reflog update is a conservative lower bound; an unchanged fetch may not log.
 * Never infer origin/main freshness from FETCH_HEAD: it can be appended to or
 * replaced by a fetch of a different ref. Accept only the unambiguous command
 * and the current ref's latest reflog entry, otherwise return unknown. */
export function localMainFetchAt(repo: string): string | null {
  try {
    const current = command('git', ['rev-parse', '--verify', 'refs/remotes/origin/main'], repo).trim();
    const entry = command('git', ['reflog', 'show', '-1', '--date=unix', '--format=%H%x09%gD%x09%gs', 'refs/remotes/origin/main'], repo).trim();
    const match = entry.match(/^([0-9a-f]+)\trefs\/remotes\/origin\/main@\{([0-9]+)\}\tfetch origin main: (?:fast-forward|forced-update|storing head)$/u);
    if (!match || match[1] !== current) return null;
    const millis = Number(match[2]) * 1000;
    if (!Number.isSafeInteger(millis) || millis > Date.now()) return null;
    return new Date(millis).toISOString();
  } catch {
    return null;
  }
}

/** Read only local Git metadata and local operational files. */
export function loadLocalOpThirtyMinuteSources(hq: string, ledgerRoot?: string): OpThirtyMinuteSources {
  const repo = join(hq, 'repo.git');
  const op = join(hq, 'seat-state', 'OP');
  const lastFetchAt = localMainFetchAt(repo);
  const mainPackage = command('git', ['show', 'origin/main:package.json'], repo);
  const version = (JSON.parse(mainPackage) as { version: string }).version.replace(/-dev\.\d+$/u, '');
  return {
    lastFetchAt,
    mainLog: command('git', ['log', '--first-parent', '--format=%h%x09%P%x09%s', '--since=30 minutes ago', 'origin/main'], repo),
    mainPackage,
    checklist: (() => {
      try { return readOpChecklistGreen(version, ledgerRoot); }
      catch { return JSON.stringify({ green: null, evidence: 'SQLite immutable snapshot 읽기 실패 또는 원장·스키마 불일치' }); }
    })(),
    trainLog: readFileSync(join(op, 'train-manager.log'), 'utf8'),
    reviewQueue: readFileSync(join(op, 'REVIEW-QUEUE.tsv'), 'utf8'),
    landingSubLog: readFileSync(join(op, 'tools', 'land-pulse-loop.log'), 'utf8'),
  };
}
