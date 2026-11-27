// RELEASE-GOAL-FROM-LEDGER (OP trace 11-25 lever L4) — the goal line every OP surface shows, derived from the ledgers.
//
// S: the war-room tick body carried a hardcoded «06:00 0.3.35 발행 · 07:00 착지 10» all day on 11-25 while 0.3.36 was
//    current, and the autopilot chip's numeric note was a constant.
// C: the release in play, its publish time and the hourly targets live in the current PLAN (front-matter
//    `status: current`, `release:`, optional `land_per_hour` · `green_per_hour` · `idle_max`) and the release schedule.
// Q: how do the chip and the war-room body stay equal to the current release without anyone editing a string?
// A: one resolver: version = resolveCurrentVersion (plan → schedule → package) · publish/cut = schedule row, else the
//    plan's `release:` line · targets = the plan's front-matter, else the standing OPS targets (marked «default»).
//    `eln resource goal-line` prints it for shell ticks; the autopilot standing note reads the same targets.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plansDirFor, resolveCurrentVersion, type CurrentVersion } from './current-version.js';
import { releaseGoalNote, STANDING_TARGETS } from './release-targets.js';

export { releaseGoalNote, STANDING_TARGETS } from './release-targets.js';

export interface ReleaseTargets {
  landPerHour: number;
  greenPerHour: number;
  idleMax: number;
  /** `plan` = at least one value came from the plan front-matter; `default` = the standing OPS targets. */
  source: 'plan' | 'default';
}

export interface ReleaseGoal {
  version: string;
  versionSource: CurrentVersion['source'];
  published: boolean;
  /** ISO publish time (schedule row, else the plan's `release:` line). */
  publishAt: string | null;
  cutAt: string | null;
  targets: ReleaseTargets;
}

/** Front-matter lines of a plan (between the first two `---`), as key → raw value. */
export function planFrontMatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return {};
  const out: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/u.exec(line.trim());
    if (match) out[match[1]!.toLowerCase()] = match[2]!.trim();
  }
  return out;
}

const count = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const match = /^(\d{1,4})\b/u.exec(raw);
  return match ? Number(match[1]) : null;
};

/** `land_per_hour` · `green_per_hour` · `idle_max` from the front-matter; a missing one falls back to the standing target. */
export function planTargets(front: Record<string, string>): ReleaseTargets {
  const land = count(front.land_per_hour);
  const green = count(front.green_per_hour);
  const idle = count(front.idle_max);
  return {
    landPerHour: land ?? STANDING_TARGETS.landPerHour,
    greenPerHour: green ?? STANDING_TARGETS.greenPerHour,
    idleMax: idle ?? STANDING_TARGETS.idleMax,
    source: land !== null || green !== null || idle !== null ? 'plan' : 'default',
  };
}

/** The first «YYYY-MM-DD HH:MM» of the plan's `release:` value, read as KST (the HQ clock) → ISO. */
export function planReleaseAt(front: Record<string, string>): string | null {
  const match = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/u.exec(front.release ?? '');
  if (!match) return null;
  const ms = Date.parse(`${match[1]}T${match[2]}:00+09:00`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function readPlan(hqRoot: string, version: string): Record<string, string> {
  try { return planFrontMatter(readFileSync(join(plansDirFor(hqRoot), `PLAN-${version}.md`), 'utf8')); } catch { return {}; }
}

export function deriveReleaseGoal(input: { hqRoot: string; ledgerRoot?: string; packageVersion?: string; current?: CurrentVersion }): ReleaseGoal {
  const current = input.current ?? resolveCurrentVersion({ hqRoot: input.hqRoot, ...(input.ledgerRoot ? { ledgerRoot: input.ledgerRoot } : {}),
    ...(input.packageVersion ? { packageVersion: input.packageVersion } : {}) });
  const front = current.source === 'plan' || current.source === 'graph' ? readPlan(input.hqRoot, current.version) : {};
  return {
    version: current.version, versionSource: current.source, published: current.published,
    publishAt: current.schedule?.publishAt ?? planReleaseAt(front),
    cutAt: current.schedule?.cutAt ?? null,
    targets: planTargets(front),
  };
}

const KST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
/** «MM-DD HH:MM» in KST. */
export function kstShort(iso: string): string {
  const parts = Object.fromEntries(KST.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.month}-${parts.day} ${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
}

/** «D-1 3h» · «5h» · «40m» · «past» — time left to an ISO instant. */
export function timeLeft(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return '?';
  if (ms < 0) return 'past';
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `D-${Math.floor(hours / 24)} ${hours % 24}h`;
  return hours > 0 ? `${hours}h` : `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/** One line: «0.3.36 발행 11-26 06:00 (15h) · 컷 11-26 04:00 · 착지 10/h · 초록 10/h · 유휴 ≤0 [plan · targets default]». */
export function releaseGoalLine(goal: ReleaseGoal, now: number): string {
  const parts = [`${goal.version}${goal.published ? ' (published)' : ''} 발행 ${goal.publishAt ? `${kstShort(goal.publishAt)} (${timeLeft(goal.publishAt, now)})` : 'unscheduled'}`];
  if (goal.cutAt) parts.push(`컷 ${kstShort(goal.cutAt)}`);
  parts.push(`착지 ${goal.targets.landPerHour}/h`, `초록 ${goal.targets.greenPerHour}/h`, `유휴 ≤${goal.targets.idleMax}`);
  return `${parts.join(' · ')} [${goal.versionSource} · targets ${goal.targets.source}]`;
}

/** The autopilot standing note: the plan's targets when the plan sets any, else undefined (the caller keeps its default). */
export function standingNoteFromPlan(hqRoot: string, version: string): string | undefined {
  const targets = planTargets(readPlan(hqRoot, version));
  return targets.source === 'plan' ? releaseGoalNote(targets) : undefined;
}

/**
 * OP-NEXT-BEST-ACTION 3/3 — the standing note from the version's actual top open cells («UX-12 · TC-3 · OP-NBA (+40 open)»)
 * instead of the generic «로스터 착지 · 초록». Undefined when the checklist cannot be read or has no open cell (the caller
 * keeps its default). Lazy: the checklist store loads only when called.
 */
export function standingNoteFromCells(version: string, ledgerRoot: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { listChecklist } = require('../release-loop/checklist.js') as typeof import('../release-loop/checklist.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { goalNoteFromCells } = require('../loops/op-next-action.js') as typeof import('../loops/op-next-action.js');
    return goalNoteFromCells(listChecklist(version, ledgerRoot).items) ?? undefined;
  } catch { return undefined; }
}
