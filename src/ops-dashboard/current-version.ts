// OP-CURRENT-VERSION-AWARE (0.3.35 P0, owner TC-H-CC-2) — the current-release resolver.
//
// S: after a publish, package.json still names the previous release (`0.3.34-dev.0` while 0.3.35 is open), so the
//    operating dashboard's `ctx.version` — and with it the roster probe and the retro's «Metrics for this period» —
//    kept measuring the published release instead of the current one.
// C: the current-release marker lives in three places that update at different times (PLAN front-matter · the
//    release schedule ledger · package.json), and the dashboard read only the last one.
// Q: which release is «current», read without an LLM and without touching the session-stable prefix?
// A: ① a `plans/PLAN-<v>.md` whose front-matter says `status: current` (the OP plan marks the open release);
//    ② else the newest `release_schedules` row newer than releasedVersion() (a cut, not yet published);
//    ③ else the stripped package version — the pre-0.3.35 behaviour, no regression. A result that is already
//    published (release.json with publishedAt) carries `published: true` so the 판 row shows «⚠ 발행 완료 판».
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checklistDevVersion, devVersion } from '../release-loop/checklist.js';
import { readSchedule, readSchedules, releasedVersion, type ScheduleRow } from '../release-loop/feature-store.js';
import { releaseLedgerRoot } from '../instance/resolve.js';

export type CurrentVersionSource = 'plan' | 'schedule' | 'package';

export interface CurrentVersion {
  version: string;
  source: CurrentVersionSource;
  /** The plan headline («# PLAN-<v> — <theme>»), when a plan named this release. */
  theme: string | null;
  /** Roster size from the plan's «## 로스터 (<n> 칸 …» heading, when a plan named this release. */
  rosterCount: number | null;
  /** The release_schedules row for this version, when one exists. */
  schedule: { cutAt: string; landBy: string | null; publishAt: string | null } | null;
  /** True when this version already has release.json with publishedAt — «⚠ 발행 완료 판». */
  published: boolean;
}

const PLAN_FILE = /^PLAN-(\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?)\.md$/;
const PARSED_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(rc|alpha|beta)\.(\d+))?$/;
const PREVIEW_RANK: Record<string, number> = { alpha: 1, beta: 2, rc: 3 };

/** Numeric compare of dotted versions; a bare release sorts above its own previews (rc < beta < alpha). */
export function compareVersions(a: string, b: string): number {
  const pa = PARSED_VERSION.exec(a);
  const pb = PARSED_VERSION.exec(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  const triple = (Number(pa[1]) - Number(pb[1])) || (Number(pa[2]) - Number(pb[2])) || (Number(pa[3]) - Number(pb[3]));
  if (triple) return triple;
  const rankA = pa[4] === undefined ? 4 : PREVIEW_RANK[pa[4]] ?? 0;
  const rankB = pb[4] === undefined ? 4 : PREVIEW_RANK[pb[4]] ?? 0;
  return (rankA - rankB) || ((Number(pa[5] ?? 0)) - (Number(pb[5] ?? 0)));
}

export function plansDirFor(hqRoot: string): string {
  return join(hqRoot, 'seat-state', 'OP', 'plans');
}

/** True when this version has release.json whose publishedAt is a real timestamp. */
export function isPublishedVersion(version: string, ledgerRoot = releaseLedgerRoot()): boolean {
  try {
    const record = JSON.parse(readFileSync(join(ledgerRoot, 'release', version, 'release.json'), 'utf8')) as { version?: string; publishedAt?: string };
    return record.version === version && typeof record.publishedAt === 'string' && Number.isFinite(Date.parse(record.publishedAt));
  } catch { return false; }
}

interface PlanMark { version: string; theme: string | null; rosterCount: number | null }

/** One plan file's marker: front-matter `status: current` plus the headline theme and roster size. */
function readPlanMark(path: string, version: string): PlanMark | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return null;
  const status = lines.slice(1, end).find((line) => /^status:\s*\S+/.test(line.trim()));
  if (!/^status:\s*current\s*$/u.test(status ?? '')) return null;
  const theme = lines.map((line) => line.trim()).find((line) => /^#\s+PLAN-\S+\s+[—-]\s+/.test(line))?.replace(/^#\s+PLAN-\S+\s+[—-]\s+/u, '').trim() || null;
  const roster = /^##\s*로스터\s*\((\d+)\s*칸/mu.exec(text);
  return { version, theme, rosterCount: roster ? Number(roster[1]) : null };
}

function scheduleOf(version: string, ledgerRoot: string): CurrentVersion['schedule'] | null {
  if (!existsSync(join(ledgerRoot, 'release', 'features.sqlite'))) return null;
  const row: ScheduleRow | null = readSchedule(version, ledgerRoot);
  return row ? { cutAt: row.cutAt, landBy: row.landBy, publishAt: row.publishAt ?? null } : null;
}

/** The newest `status: current` plan (front-matter decides; the highest version wins when several say current). */
function currentPlanMark(hqRoot: string): PlanMark | null {
  const dir = plansDirFor(hqRoot);
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  let best: PlanMark | null = null;
  for (const name of names) {
    const match = PLAN_FILE.exec(name);
    if (!match) continue;
    const mark = readPlanMark(join(dir, name), match[1]!);
    if (mark && (!best || compareVersions(mark.version, best.version) > 0)) best = mark;
  }
  return best;
}

/** The newest schedule row strictly newer than the newest published release. */
function currentScheduleRow(ledgerRoot: string): ScheduleRow | null {
  const published = releasedVersion(ledgerRoot);
  if (!existsSync(join(ledgerRoot, 'release', 'features.sqlite'))) return null;
  const newer = readSchedules(ledgerRoot)
    .filter((row) => !published || compareVersions(row.version, published) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  return newer ?? null;
}

/** Resolve the current release: plan `status: current` first, then a not-yet-published schedule, then the package. */
export function resolveCurrentVersion(input: { hqRoot: string; ledgerRoot?: string; packageVersion?: string }): CurrentVersion {
  const ledgerRoot = input.ledgerRoot ?? releaseLedgerRoot();
  const plan = currentPlanMark(input.hqRoot);
  if (plan) {
    return { version: plan.version, source: 'plan', theme: plan.theme, rosterCount: plan.rosterCount,
      schedule: scheduleOf(plan.version, ledgerRoot), published: isPublishedVersion(plan.version, ledgerRoot) };
  }
  const row = currentScheduleRow(ledgerRoot);
  if (row) {
    return { version: row.version, source: 'schedule', theme: null, rosterCount: null,
      schedule: { cutAt: row.cutAt, landBy: row.landBy, publishAt: row.publishAt ?? null },
      published: isPublishedVersion(row.version, ledgerRoot) };
  }
  const version = checklistDevVersion(input.packageVersion ?? devVersion());
  return { version, source: 'package', theme: null, rosterCount: null, schedule: null, published: isPublishedVersion(version, ledgerRoot) };
}
