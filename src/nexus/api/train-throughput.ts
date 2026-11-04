export type TrainRejectReason = 'typecheck' | 'ratchet' | 'introduced' | 'setup-unmeasured' | 'authorization' | 'lock-owner' | 'other';
export type TrainLedgerKey = { pr: string; head: string; base: string };
export type TrainAttempt = { host: string; runId: string; stage: string; prs: number[]; assignedAt: string; finishedAt?: string; rc?: number; detail?: string; ledgerKeys?: TrainLedgerKey[] };
export type TrainSummaryEvent = { eventType?: unknown; host?: unknown; at?: unknown; pr?: unknown; key?: unknown; runId?: unknown; reason?: unknown; keys?: TrainLedgerKey[] };
export type TrainThroughputTotals = {
  assigned: number; assignedPrs: number; completed: number; succeeded: number; rejected: number; failed: number;
  rejectedByReason: Record<TrainRejectReason, number>; unmeasured: number; landed: number | null; averageWaitSeconds: number | null;
};
export type TrainThroughputSnapshot = { date: string; generatedAt: string; sourceIncomplete: boolean; hosts: Record<string, TrainThroughputTotals>; hours: Record<string, TrainThroughputTotals>; attempts: TrainAttempt[] };

const REASONS: TrainRejectReason[] = ['typecheck', 'ratchet', 'introduced', 'setup-unmeasured', 'authorization', 'lock-owner', 'other'];
const ASSIGNED = /\[(?<host>[A-Za-z0-9._-]+)\]\s+manager assigned stage=(?<stage>[A-Za-z0-9._-]+) prs=(?<prs>[0-9,]+).*?run=(?<run>[^\s]+)/;
const DONE = /\[(?<host>[A-Za-z0-9._-]+)\]\s+manager done stage=(?<stage>[A-Za-z0-9._-]+) run=(?<run>[^\s]+) rc=(?<rc>-?\d+)\s+·\s*(?<detail>.*)$/;
const PREFIX = /^(?<md>\d{2}-\d{2}) (?<time>\d{2}:\d{2}:\d{2}) /;
const landedTypes = new Set(['landed', 'pr-landed', 'train-landed', 'merge-landed']);

export function isValidTrainDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month! - 1 && parsed.getUTCDate() === day;
}

export function trainIdentityFromBatchDirectory(directoryName: string, manifest: unknown): { host: string; runId: string } | undefined {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined;
  const host = (manifest as Record<string, unknown>).host;
  if (typeof host !== 'string' || !/^[A-Za-z0-9._-]+$/.test(host)) return undefined;
  const prefix = `batch-${host}-`;
  if (!directoryName.startsWith(prefix)) return undefined;
  const runId = directoryName.slice(prefix.length);
  return /^[A-Za-z0-9._-]+$/.test(runId) ? { host, runId } : undefined;
}

export function classifyTrainRefusals(detail: string): TrainRejectReason[] {
  const reasons: TrainRejectReason[] = [];
  if (/typecheck|typescript|tsc/i.test(detail)) reasons.push('typecheck');
  if (/ratchet/i.test(detail)) reasons.push('ratchet');
  if (/introduced/i.test(detail)) reasons.push('introduced');
  if (/setup-unmeasured|setup.*unmeasured|dependency.*unmeasured/i.test(detail)) reasons.push('setup-unmeasured');
  if (/authorization|unauthori[sz]ed|permission/i.test(detail)) reasons.push('authorization');
  if (/lock owner|lock-owner|claim owner/i.test(detail)) reasons.push('lock-owner');
  if (reasons.length) return reasons;
  return /BATCH REFUSED|TRAIN REFUSED|gate verdict|land-enqueue denied/i.test(detail) ? ['other'] : [];
}

function timestamp(line: string, year: number, timezoneOffsetMinutes: number): string | undefined {
  const prefix = PREFIX.exec(line);
  if (!prefix) return undefined;
  const [month, day] = prefix.groups!.md!.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month! - 1, day!));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month! - 1 || candidate.getUTCDate() !== day) return undefined;
  const localDate = candidate.toISOString().slice(0, 10);
  const offset = timezoneOffsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(timezoneOffsetMinutes);
  const zone = `${offset}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
  const value = `${localDate}T${prefix.groups!.time}${zone}`;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

export function parseTrainThroughputLogs(lines: readonly string[], options: { date: string; anchorDate: string; timezoneOffsetMinutes?: number }): TrainAttempt[] {
  const offset = options.timezoneOffsetMinutes ?? 540;
  const anchorYear = Number(options.anchorDate.slice(0, 4));
  const datedRows = lines.map((line, index) => ({ line, index, md: PREFIX.exec(line)?.groups?.md }))
    .filter((row): row is { line: string; index: number; md: string } => row.md !== undefined);
  const lastMd = datedRows.at(-1)?.md;
  const anchorMs = Date.parse(`${options.anchorDate}T00:00:00Z`);
  let year = anchorYear;
  if (lastMd) {
    const [month, day] = lastMd.split('-').map(Number);
    year = [anchorYear - 1, anchorYear, anchorYear + 1]
      .sort((a, b) => Math.abs(Date.UTC(a, month! - 1, day!) - anchorMs) - Math.abs(Date.UTC(b, month! - 1, day!) - anchorMs))[0]!;
  }
  const yearsByIndex = new Map<number, number>();
  let laterMd: string | undefined;
  for (const row of [...datedRows].reverse()) {
    if (laterMd && row.md > laterMd) year--;
    yearsByIndex.set(row.index, year);
    laterMd = row.md;
  }
  const attempts = new Map<string, TrainAttempt>();
  for (const [index, line] of lines.entries()) {
    const rowYear = yearsByIndex.get(index);
    const at = rowYear === undefined ? undefined : timestamp(line, rowYear, offset);
    if (!at) continue;
    const assigned = ASSIGNED.exec(line);
    if (assigned?.groups) {
      const { host, stage, prs, run } = assigned.groups;
      const id = `${host}:${run}`;
      attempts.set(id, { host: host!, runId: run!, stage: stage!, prs: prs!.split(',').filter(Boolean).map(Number), assignedAt: at });
      continue;
    }
    const done = DONE.exec(line);
    if (done?.groups) {
      const attempt = attempts.get(`${done.groups.host}:${done.groups.run}`);
      if (attempt) Object.assign(attempt, { finishedAt: at, rc: Number(done.groups.rc), detail: done.groups.detail ?? '' });
    }
  }
  return [...attempts.values()].filter(attempt => attempt.assignedAt.slice(0, 10) === options.date || attempt.finishedAt?.slice(0, 10) === options.date)
    .sort((a, b) => a.assignedAt.localeCompare(b.assignedAt) || a.host.localeCompare(b.host));
}

export function collectTrainSummaryEvents(value: unknown): TrainSummaryEvent[] {
  const result: TrainSummaryEvent[] = [];
  const visit = (item: unknown, depth: number): void => {
    if (depth > 12 || !item || typeof item !== 'object') return;
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    const record = item as Record<string, unknown>;
    if (typeof record.eventType === 'string') result.push(record as TrainSummaryEvent);
    for (const [key, child] of Object.entries(record)) if (key !== 'eventType') visit(child, depth + 1);
  };
  visit(value, 0);
  return result;
}

export function trainKeysFromManifest(manifest: unknown, host: string, runId: string): TrainSummaryEvent[] {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return [];
  const record = manifest as Record<string, unknown>;
  const base = typeof record.base === 'string' ? record.base : '';
  if (!base || !Array.isArray(record.members)) return [];
  const keys: TrainLedgerKey[] = record.members.flatMap(member => {
    if (!member || typeof member !== 'object') return [];
    const row = member as Record<string, unknown>;
    return typeof row.pr === 'string' && typeof row.head === 'string' ? [{ pr: row.pr, head: row.head, base }] : [];
  });
  return keys.length ? [{ eventType: 'train-key', host, runId, keys }] : [];
}

export function trainRejectionsFromSummary(value: unknown, host: string, runId: string, manifest?: unknown): TrainSummaryEvent[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const summary = value as Record<string, unknown>;
  const failed = summary.verdict === 'failed' || (typeof summary.exitCode === 'number' && summary.exitCode !== 0);
  if (!failed) return [];
  const reasons: TrainRejectReason[] = [];
  const manifestRecord = manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest as Record<string, unknown> : {};
  const base = typeof manifestRecord.base === 'string' ? manifestRecord.base : typeof summary.base40 === 'string' ? summary.base40 : '';
  const members = Array.isArray(manifestRecord.members) ? manifestRecord.members : [];
  const keys: TrainLedgerKey[] = members.flatMap(member => {
    if (!member || typeof member !== 'object') return [];
    const row = member as Record<string, unknown>;
    return typeof row.pr === 'string' && typeof row.head === 'string' && base ? [{ pr: row.pr, head: row.head, base }] : [];
  });
  const typecheck = summary.typecheck as Record<string, unknown> | undefined;
  const ratchets = summary.trainAlwaysRatchets as Record<string, unknown> | undefined;
  if (typecheck?.status === 'failed') reasons.push('typecheck');
  if (ratchets?.status === 'failed') reasons.push('ratchet');
  if (typeof summary.introduced === 'number' && summary.introduced > 0) reasons.push('introduced');
  if (typeof summary.preconditionUnmet === 'number' && summary.preconditionUnmet > 0) reasons.push('setup-unmeasured');
  return reasons.map(reason => ({ eventType: 'train-rejection', host, runId, reason, ...(keys.length ? { keys } : {}) }));
}

function emptyTotals(): TrainThroughputTotals {
  return { assigned: 0, assignedPrs: 0, completed: 0, succeeded: 0, rejected: 0, failed: 0,
    rejectedByReason: Object.fromEntries(REASONS.map(reason => [reason, 0])) as Record<TrainRejectReason, number>,
    unmeasured: 0, landed: null, averageWaitSeconds: null };
}

export function buildTrainThroughput(attempts: readonly TrainAttempt[], summaryEvents: readonly TrainSummaryEvent[] | undefined = undefined,
  date = attempts[0]?.assignedAt.slice(0, 10) ?? 'unknown'): TrainThroughputSnapshot {
  const hosts: Record<string, TrainThroughputTotals> = {};
  const hours: Record<string, TrainThroughputTotals> = {};
  const durations = new Map<TrainThroughputTotals, number[]>();
  const ledgerKeysByRun = new Map<string, TrainLedgerKey[]>();
  const targets = (attempt: TrainAttempt, at: string): TrainThroughputTotals[] => {
    const host = hosts[attempt.host] ??= emptyTotals();
    const hourKey = `${at.slice(0, 13)}:00${at.slice(19)}`;
    const hour = hours[hourKey] ??= emptyTotals();
    return [host, hour];
  };
  for (const attempt of attempts) {
    const keys = (summaryEvents ?? []).filter(event => (event.eventType === 'train-rejection' || event.eventType === 'train-key')
      && event.host === attempt.host && event.runId === attempt.runId).flatMap(event => event.keys ?? []);
    if (keys.length) ledgerKeysByRun.set(`${attempt.host}:${attempt.runId}`, [...new Map(keys.map(key => [`${key.pr}:${key.head}:${key.base}`, key])).values()]);

    const assignedToday = attempt.assignedAt.slice(0, 10) === date;
    const finishedToday = attempt.finishedAt?.slice(0, 10) === date;
    if (assignedToday) {
      for (const target of targets(attempt, attempt.assignedAt)) {
        target.assigned++;
        target.assignedPrs += attempt.prs.length;
        if (!attempt.finishedAt) target.unmeasured++;
      }
    }
    if (!finishedToday || !attempt.finishedAt) continue;
    for (const target of targets(attempt, attempt.finishedAt)) {
      if (attempt.rc === undefined) { target.unmeasured++; continue; }
      target.completed++;
      if (attempt.rc === 0) target.succeeded++;
      else {
        const summaryReasons = (summaryEvents ?? []).filter(event => event.eventType === 'train-rejection'
          && event.host === attempt.host && event.runId === attempt.runId).map(event => event.reason)
          .filter((reason): reason is TrainRejectReason => REASONS.includes(reason as TrainRejectReason));
        const logReasons = classifyTrainRefusals(attempt.detail ?? '');
        const reasons = new Set([...summaryReasons, ...(logReasons.length === 1 && logReasons[0] === 'other' && summaryReasons.length ? [] : logReasons)]);
        if (reasons.size) {
          target.rejected++;
          for (const reason of reasons) target.rejectedByReason[reason]++;
        } else target.failed++;
      }
      const duration = (Date.parse(attempt.finishedAt) - Date.parse(attempt.assignedAt)) / 1000;
      if (Number.isFinite(duration) && duration >= 0) (durations.get(target) ?? (durations.set(target, []), durations.get(target)!)).push(duration);
    }
  }
  const landedKeys = new Set<string>();
  for (const event of summaryEvents ?? []) {
    if (typeof event.eventType !== 'string' || !landedTypes.has(event.eventType)) continue;
    const at = typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)) ? event.at : undefined;
    const keyObj = event.key && typeof event.key === 'object' ? event.key as Record<string, unknown> : undefined;
    const host = typeof event.host === 'string' ? event.host : typeof keyObj?.host === 'string' ? keyObj.host : undefined;
    if (!at || !host) continue;
    const local = new Date(Date.parse(at) + 9 * 60 * 60 * 1000).toISOString();
    if (local.slice(0, 10) !== date) continue;
    const pr = event.pr ?? (event.key && typeof event.key === 'object' ? (event.key as Record<string, unknown>).pr : undefined);
    const dedupeKey = `${host}:${String(pr ?? '')}:${at}`;
    if (landedKeys.has(dedupeKey)) continue;
    landedKeys.add(dedupeKey);
    const hourKey = `${local.slice(0, 13)}:00+09:00`;
    const hostTotal = hosts[host] ??= emptyTotals();
    const hourTotal = hours[hourKey] ??= emptyTotals();
    hostTotal.landed = (hostTotal.landed ?? 0) + 1;
    hourTotal.landed = (hourTotal.landed ?? 0) + 1;
  }
  for (const [totals, values] of durations) if (values.length) totals.averageWaitSeconds = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  const publicAttempts = attempts.map(({ detail: _detail, ...attempt }) => {
    const ledgerKeys = ledgerKeysByRun.get(`${attempt.host}:${attempt.runId}`);
    return { ...attempt, ...(ledgerKeys ? { ledgerKeys } : {}) };
  });
  return { date, generatedAt: new Date().toISOString(), sourceIncomplete: false, hosts, hours, attempts: publicAttempts };
}
