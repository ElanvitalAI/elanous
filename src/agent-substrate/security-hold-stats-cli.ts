// Read-only: bun security-hold-stats-cli.ts <review-results-directory|events.jsonl> [UTC-Monday]
// Directory input reads saved JSON reviews; missing reviewedAt uses file mtime, NOT review time.
// Exact duplicate payloads are counted once (canonical pr-* file first). Modified copies remain distinct.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SECURITY_CLASSES, isSecurityClass, isUncategorizedSecurityHold, mergeReviewFollowUps } from './security-hold-policy.js';

type Row = Record<string, unknown>;
function object(value: unknown): value is Row { return !!value && typeof value === 'object' && !Array.isArray(value); }
function timestamp(value: unknown): number {
  return typeof value === 'number' ? value : typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? Date.parse(value) : NaN;
}

export function securityHoldStats(text: string, weekStart: string) {
  let invalidLines = 0;
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const value: unknown = JSON.parse(line); if (!object(value)) throw new Error(); rows.push(value); }
    catch { invalidLines++; }
  }
  return aggregate(rows, weekStart, invalidLines);
}

function aggregate(rows: Row[], weekStart: string, invalidLines = 0) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw new Error('week start must be a UTC Monday YYYY-MM-DD');
  const start = Date.parse(`${weekStart}T00:00:00.000Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== weekStart || new Date(start).getUTCDay() !== 1) throw new Error('week start must be a UTC Monday YYYY-MM-DD');
  const end = start + 7 * 86400000;
  const reviewers = new Map<string, { reviewer: string; verdictCount: number; holdCount: number; byClass: Record<string, number>; unclassified: number; unclassifiedRatio: number | null; holdRatio: number; retrospective: boolean; fuCount: number; otherFailures: number }>();
  for (const row of rows) {
    // Explicit unsuccessful or invalid reviews are not decisions.
    if (row.reviewed === false || row.invalid === true) { invalidLines++; continue; }
    const t = timestamp(row.reviewedAt);
    const identity = [row.judge, row.reviewer, row.model].find(v => typeof v === 'string' && v.trim());
    const verdict = typeof row.verdict === 'string' ? row.verdict.toLowerCase() : '';
    if (!Number.isFinite(t) || typeof identity !== 'string' || !['hold', 'fail', 'warn', 'pass'].includes(verdict)) { invalidLines++; continue; }
    if (t < start || t >= end) continue;
    const reviewer = identity.trim();
    let stat = reviewers.get(reviewer);
    if (!stat) {
      stat = { reviewer, verdictCount: 0, holdCount: 0, byClass: Object.fromEntries(SECURITY_CLASSES.map(c => [c, 0])), unclassified: 0, unclassifiedRatio: null, holdRatio: 0, retrospective: false, fuCount: 0, otherFailures: 0 };
      reviewers.set(reviewer, stat);
    }
    stat.verdictCount++;
    stat.fuCount += mergeReviewFollowUps(row).length;
    if (verdict === 'hold' || verdict === 'fail') {
      const classes = new Set<string>();
      if (isSecurityClass(row.securityClass)) classes.add(row.securityClass);
      // Findings must refer to an actual blocker; a class on an unrelated item is not a security hold.
      if (Array.isArray(row.mustFix) && Array.isArray(row.securityFindings)) for (const item of row.securityFindings) {
        if (object(item) && item.kind === 'security-only' && typeof item.text === 'string' && row.mustFix.includes(item.text) && isSecurityClass(item.securityClass)) classes.add(item.securityClass);
      }
      const unclassified = isUncategorizedSecurityHold(row);
      if (classes.size || unclassified) {
        stat.holdCount++;
        if (unclassified) stat.unclassified++;
        for (const c of classes) stat.byClass[c]!++;
        stat.unclassifiedRatio = stat.unclassified / stat.holdCount;
      } else stat.otherFailures++;
    }
    stat.holdRatio = stat.holdCount / stat.verdictCount;
    stat.retrospective = stat.unclassified * 10 > stat.holdCount * 3 || stat.holdCount * 10 > stat.verdictCount * 4;
  }
  return { weekStart, weekEndExclusive: new Date(end).toISOString(), invalidLines, reviewers: [...reviewers.values()].sort((a, b) => a.reviewer.localeCompare(b.reviewer)) };
}

export function savedReviewStats(dir: string, weekStart: string) {
  const names = readdirSync(dir).filter(name => name.toLowerCase().endsWith('.json'))
    .sort((a, b) => Number(!/^pr-\d+-/i.test(a)) - Number(!/^pr-\d+-/i.test(b)) || a.localeCompare(b));
  const rows: Row[] = [];
  const seen = new Set<string>();
  let invalidFiles = 0, duplicateFiles = 0, mtimeFallbackFiles = 0, ignoredFiles = 0;
  for (const name of names) {
    try {
      const path = join(dir, name);
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!object(value)) { invalidFiles++; continue; }
      // review-results also contains waiver, lock and error artifacts, not review decisions.
      if (value.reviewed !== true || value.invalid === true) { ignoredFiles++; continue; }
      const key = JSON.stringify(value);
      if (seen.has(key)) { duplicateFiles++; continue; }
      seen.add(key);
      if (value.reviewedAt === undefined) { rows.push({ ...value, reviewedAt: statSync(path).mtimeMs }); mtimeFallbackFiles++; }
      else rows.push(value);
    } catch { invalidFiles++; }
  }
  return { ...aggregate(rows, weekStart), input: { directory: dir, invalidFiles, ignoredFiles, duplicateFiles, mtimeFallbackFiles, mtimeMeaning: 'file modification time, not verified review time' } };
}

export function runSecurityHoldStatsCli(args: string[]): number {
  try {
    if (args.length < 1 || args.length > 2) throw new Error('usage: security-hold-stats-cli <review-results-directory|events.jsonl> [week-start-UTC]');
    const now = new Date();
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (now.getUTCDay() + 6) % 7)).toISOString().slice(0, 10);
    const path = args[0]!;
    const report = statSync(path).isDirectory() ? savedReviewStats(path, args[1] ?? monday) : securityHoldStats(readFileSync(path, 'utf8'), args[1] ?? monday);
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runSecurityHoldStatsCli(process.argv.slice(2));
