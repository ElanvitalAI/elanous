import { CLAIM_IDLE_HOURS, PR_LABELS, STALLED_DRAFT_HOURS } from '../github/pr-labels.js';
import { debug } from '../debug/log.js';
import { decideDraft, laterMergedTwins, sameGoalPr, type DraftTriagePr } from './draft-triage-rules.js';
import { branchLineageSlug } from '../cli/pr-lineage.js';

export interface SweepDraft extends DraftTriagePr {
  readonly title: string;
  readonly labels: readonly string[];
  readonly createdAt: string;
  /** Last PR update (push, label, comment). Missing ⇒ no idle-based close; merged twins can still close. */
  readonly updatedAt?: string;
  readonly runId?: string | null;
}

export interface SweepMergedPr extends DraftTriagePr {
  readonly title: string;
  readonly createdAt?: string;
  readonly mergedAt?: string;
  readonly labels?: readonly string[];
}

export interface DraftSweepAdapters {
  /** Each call returns one complete page; a rejection must not be mistaken for an empty page. */
  listDrafts(page: number, perPage: number, repository: string): Promise<readonly SweepDraft[]>;
  listMerged(page: number, perPage: number, repository: string): Promise<readonly SweepMergedPr[]>;
  /** Complete closed PR inventory for the creation cohort (including closed without merge). */
  listRecentClosed?(repository: string, createdSince: Date): Promise<readonly SweepMergedPr[]>;
  /** Undefined means no run assessment; a merged twin or 24h idle draft can still authorize a close. */
  getRunStatus(draft: SweepDraft, repository: string): Promise<string | undefined>;
  /** Undefined means liveness could not be established. */
  listLiveBranches(repository: string): Promise<ReadonlySet<string> | undefined>;
  setLabels(repository: string, number: number, change: { add: string; remove: readonly string[] }): Promise<void>;
  closeDraft(repository: string, number: number, comment: string): Promise<void>;
  /** Resolve the latest claim comment owner; a failed lookup must not authorize a close. */
  getClaimOwner?(repository: string, number: number): Promise<string | undefined>;
  /** Current owner, accounting for a later claim release; only draft metrics need this distinction. */
  getActiveClaimOwner?(repository: string, number: number): Promise<string | undefined>;
  /** Whether the current owned run has a self-implement.result final observation, even if its worktree remains. */
  hasFinalRunResult?(draft: SweepDraft, repository: string): Promise<boolean | undefined>;
  /** Per-file last change on the draft branch; undefined means file coverage is unverified. */
  getLatestFileChanges?(draft: SweepDraft, repository: string): Promise<Readonly<Record<string, string>> | undefined>;
  /** Optional merge-time file inventory for the existing all-files-landed decision. */
  getPrFiles?(repository: string, number: number): Promise<readonly string[] | undefined>;
  /**
   * Review and gate posture for the daily count. Omitted means unknown — not harvestable and not blocked.
   * `review: 'pass'` is a review PASS; `mustFix` means must-fix remains; `gate: 'pass'` is a green gate.
   */
  getReviewGate?(draft: SweepDraft, repository: string): Promise<SweepReviewGate | undefined>;
  /** One PR by number (any state); undefined means it could not be read. Only overlap metrics need it. */
  getPr?(repository: string, number: number): Promise<SweepMergedPr | undefined>;
}

/** Review PASS and gate posture used only by the daily old-draft count. */
export interface SweepReviewGate {
  readonly review?: 'pass' | 'fail';
  readonly mustFix?: boolean;
  readonly gate?: 'pass' | 'fail';
}

export interface DraftSweepOptions {
  repository: string;
  adapters: DraftSweepAdapters;
  apply?: boolean;
  now?: Date;
  /** Per-tick close cap; resolve it with resolveDraftSweepCloseCap. Absent or invalid ⇒ DRAFT_SWEEP_CLOSE_CAP. */
  closeCap?: number;
  closeCapSource?: DraftSweepCloseCapSource;
}

export interface DraftSweepEntry {
  number: number;
  action: 'keep' | 'close' | 'report';
  reason: string;
  statusLabel?: string;
  applied: boolean;
  /** Labels changed successfully, but the requested close failed. */
  partialApplied?: boolean;
  error?: string;
}

export interface DraftSweepResult {
  repository: string;
  apply: boolean;
  complete: boolean;
  entries: DraftSweepEntry[];
  counts: Record<string, number>;
  /** Drafts whose run could not be observed from here (kept, or closed by the idle rule). */
  unobserved?: number;
  /** Closes decided this tick (at most `closeCap`). */
  closed?: number;
  /** The per-tick close cap this sweep used, and where it came from. */
  closeCap?: number;
  closeCapSource?: DraftSweepCloseCapSource;
  /** Fresh running claims protected this tick. */
  claimed?: number;
  /** Running claims older than the idle window, including those kept by liveness. */
  claimExpired?: number;
  /**
   * One line per sweep: harness drafts older than 24h, split into closable (a same-goal landing exists),
   * harvestable (review PASS and gate pass), and blocked (must-fix remains).
   */
  daily?: DraftSweepDaily;
  error?: string;
}

/** Daily old-draft census. `date` is the sweep clock's UTC calendar day. */
export interface DraftSweepDaily {
  readonly date: string;
  readonly over24h: number;
  readonly closable: number;
  readonly harvestable: number;
  readonly blocked: number;
}

/** Open harness drafts now; conversion is the 48h creation cohort, not the daily over-24h census. */
export interface DraftMetrics {
  readonly inventory: number;
  readonly oldestAgeHours: number | null;
  readonly needsOwner: number;
  readonly converted48h: number;
  readonly cohort48h: number;
  readonly conversion48h: number | null;
}

export async function collectDraftMetrics(repository: string, adapters: Pick<DraftSweepAdapters, 'listDrafts' | 'listRecentClosed' | 'getActiveClaimOwner'>, now: Date): Promise<DraftMetrics> {
  const clock = now.getTime();
  if (!Number.isFinite(clock)) throw new Error('Invalid draft metric clock');
  // A fixed, fully matured creation cohort: each PR has had its full 48h to land.
  const cutoff = clock - 96 * 3_600_000;
  const matured = clock - 48 * 3_600_000;
  if (!adapters.listRecentClosed) throw new Error('48h closed cohort unavailable');
  const [drafts, closed] = await Promise.all([
    collectPages((page, size) => adapters.listDrafts(page, size, repository)),
    adapters.listRecentClosed(repository, new Date(cutoff)),
  ]);
  const valid = (pr: SweepDraft | SweepMergedPr): boolean => Number.isInteger(pr.number) && pr.number > 0
    && typeof pr.branch === 'string' && pr.branch.length > 0 && typeof pr.title === 'string'
    && typeof pr.createdAt === 'string' && Number.isFinite(Date.parse(pr.createdAt));
  if (drafts.some((pr) => !valid(pr) || !Array.isArray(pr.labels) || pr.labels.some((name) => typeof name !== 'string'))
    || closed.some((pr) => !valid(pr)
      || (pr.mergedAt !== undefined && !Number.isFinite(Date.parse(pr.mergedAt)))
      || !Array.isArray(pr.labels) || pr.labels.some((name) => typeof name !== 'string')))
    throw new Error('Incomplete draft metric inventory');
  if (new Set(drafts.map((pr) => pr.number)).size !== drafts.length
    || new Set(closed.map((pr) => pr.number)).size !== closed.length) throw new Error('Duplicate draft metric PR');
  const open = drafts.filter(harnessDraft);
  const owners = await Promise.all(open.map(async (draft) => {
    if (!adapters.getActiveClaimOwner) throw new Error('Draft owner lookup unavailable');
    const owner = await adapters.getActiveClaimOwner(repository, draft.number);
    if (owner !== undefined && typeof owner !== 'string') throw new Error('Invalid draft claim owner');
    return owner;
  }));
  const cohort = [...open.filter((pr) => Date.parse(pr.createdAt) >= cutoff && Date.parse(pr.createdAt) <= matured),
    ...closed.filter((pr) => (pr.branch.startsWith('self-impl/') || pr.labels!.some((name) => name.startsWith('elanous:')))
      && pr.createdAt && Date.parse(pr.createdAt) >= cutoff && Date.parse(pr.createdAt) <= matured)];
  if (new Set(cohort.map((pr) => pr.number)).size !== cohort.length) throw new Error('Overlapping draft metric inventory');
  const converted48h = cohort.filter((pr) => 'mergedAt' in pr && typeof pr.mergedAt === 'string'
    && Date.parse(pr.mergedAt) >= Date.parse(pr.createdAt!) && Date.parse(pr.mergedAt) <= clock
    && Date.parse(pr.mergedAt) - Date.parse(pr.createdAt!) <= 48 * 3_600_000).length;
  return {
    inventory: open.length,
    oldestAgeHours: open.length ? Math.max(...open.map((pr) => Math.max(0, (clock - Date.parse(pr.createdAt)) / 3_600_000))) : null,
    needsOwner: owners.filter((owner) => !owner?.trim()).length,
    converted48h,
    cohort48h: cohort.length,
    conversion48h: cohort.length ? converted48h / cohort.length : null,
  };
}

/** One `dev-pipeline` `ask-preflight` observation (written by ask-launch-flow before each launch). */
export interface OverlapPreflightRow {
  /** ISO time as the log store returns it; anything unparseable makes the source incomplete. */
  readonly ts: unknown;
  /** Either the payload itself, or a Pod-forwarded wrapper `{ origin: 'pod', originalData: '<json>' }`. */
  readonly data: Record<string, unknown> | null;
}

/**
 * Overlap launches = ask runs launched in the last 24h (no blocker, or forced past them) whose preflight
 * names a concrete overlap: an `open-pr` / `sibling-pr` warning naming `#N`, or a `live-run` warning naming a run.
 * The second sibling is this launch's own PR (branch run suffix `-r<runId[0..6]>`), else the PR on the warned sibling's lineage,
 * else (DRAFT-NOT-ARCHIVE `needs-owner-only`) a `salvaged` salvage branch of the same run or lineage with no PR yet —
 * linked as «salvaged — not landed», never auto-landed; once that branch gets a PR, the PR's merge counts as usual.
 * ⛔ `null` is «unmeasured», never «zero»:
 * - source incomplete (rows unreadable, zero rows, or a row whose payload cannot be parsed) ⇒ every count null, `sourceIncomplete`;
 * - a launch with no proof whose scan was blind (open-PR scan capped/unknown, live-run scan unknown, no planned paths) ⇒ `unmeasured`, not «no overlap»;
 * - GitHub unreadable ⇒ landing fields null;
 * - salvage source unreadable ⇒ launches with no PR sibling count as `salvageUnmeasured`, not as «no sibling».
 */
export interface OverlapMetrics {
  /** Launched runs whose preflight proves an overlap. */
  readonly launches24h: number | null;
  /** Launched runs in the window (one per runId). */
  readonly launched: number | null;
  /** Launched runs with no proven overlap whose overlap scan was blind. */
  readonly unmeasured: number | null;
  readonly sourceIncomplete: boolean;
  /** Overlap launches whose second sibling PR was found (open draft or closed). */
  readonly linked: number | null;
  /** Linked second siblings merged with no human-hand label (approval / from-human / keep). */
  readonly autoLanded: number | null;
  readonly autoRate: number | null;
  /** Median hours from the overlap launch to the second sibling's merge, over landed second siblings. */
  readonly secondSiblingMedianHours: number | null;
  /** Linked second siblings that live only on a salvage branch (no PR): «salvaged — not landed». Included in `linked`. */
  readonly salvaged: number | null;
  /** Linkable launches with no PR sibling whose salvage source could not be read — `linked` is a lower bound. */
  readonly salvageUnmeasured: number | null;
}

export type OverlapMetricAdapters = Pick<DraftSweepAdapters, 'listDrafts' | 'listRecentClosed' | 'getPr'> & {
  /** Every ask-preflight row since `since`, all universes; null means the store could not be read. */
  listPreflightRows(since: Date): Promise<readonly OverlapPreflightRow[] | null>;
  /** Every `self-implement.draft-not-archive` `salvaged` row since `since`; null (or absent) means unreadable. */
  listSalvagedRows?(since: Date): Promise<readonly OverlapPreflightRow[] | null>;
};

const HUMAN_HAND_LABELS: ReadonlySet<string> = new Set(PR_LABELS
  .filter((entry) => entry.sweep.action === 'exclude' || (entry.axis === 'state' && entry.sweep.action === 'none')
    || (entry.axis === 'origin' && (entry.appliedBy as readonly string[]).includes('human')))
  .map((entry) => entry.name));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Unwraps a Pod-forwarded row (`originalData` as a JSON string or object); null when the payload is unreadable. */
export function overlapPreflightPayload(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null;
  let payload: unknown = data;
  if ('originalData' in data) {
    payload = data.originalData;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { return null; }
    }
  }
  if (!isRecord(payload) || !Array.isArray(payload.warnings) || !Array.isArray(payload.blockers)) return null;
  return payload;
}

/** Unwraps a DRAFT-NOT-ARCHIVE `salvaged` row (Pod-forwarded or local); null when it names no salvage branch. */
export function salvagedPayload(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null;
  let payload: unknown = data;
  if ('originalData' in data) {
    payload = data.originalData;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { return null; }
    }
  }
  if (!isRecord(payload) || typeof payload.salvageBranch !== 'string' || !payload.salvageBranch.startsWith('salvage/')) return null;
  return payload;
}

type SalvagedSibling = { at: number; runKey: string | null; slug: string | null; salvageBranch: string };
const runKeyOf = (runId: unknown): string | null => {
  const key = typeof runId === 'string' ? runId.replace(/^run-/i, '').replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase() : '';
  return key.length === 6 ? key : null;
};

/** Salvaged siblings in [since, clock]; null when the source is unreadable or any row cannot be parsed. */
function salvagedSiblings(rows: readonly OverlapPreflightRow[] | null | undefined, since: number, clock: number): SalvagedSibling[] | null {
  if (!Array.isArray(rows)) return null;
  const out: SalvagedSibling[] = [];
  for (const row of rows) {
    const at = Date.parse(String(row?.ts));
    const payload = salvagedPayload(row?.data);
    if (!Number.isFinite(at) || payload === null) return null;
    if (at < since || at > clock) continue;
    const salvageBranch = payload.salvageBranch as string;
    const runKey = runKeyOf(payload.runId) ?? (/^salvage\/run-([0-9a-f]{6})\//i.exec(salvageBranch)?.[1]?.toLowerCase() ?? null);
    out.push({ at, runKey, slug: typeof payload.branch === 'string' ? branchLineageSlug(payload.branch) : null, salvageBranch });
  }
  return out;
}

/**
 * «Salvage branches today N» for the hourly report: distinct salvage branches whose `salvaged` event falls in [dayStart, now].
 * ⛔ Unreadable source or an unparsable row ⇒ null, never 0.
 */
export function countSalvagedToday(rows: readonly OverlapPreflightRow[] | null | undefined, dayStart: Date, now: Date): number | null {
  const siblings = salvagedSiblings(rows, dayStart.getTime(), now.getTime());
  return siblings === null ? null : new Set(siblings.map((sibling) => sibling.salvageBranch)).size;
}

type OverlapLaunch = { at: number; runKey: string | null; prs: number[]; siblings: number[]; proven: boolean; blind: boolean };

/** Reads one launched preflight: proven overlap, blind (unmeasured), or measured clean. */
function overlapLaunch(payload: Record<string, unknown>, at: number): OverlapLaunch | null {
  const blockers = payload.blockers as unknown[];
  const forced = payload.bypassed === true;
  // Only a launch counts: a clean preflight, or one the caller forced past its blockers.
  if (blockers.length > 0 && !forced) return null;
  const entries = [...(payload.warnings as unknown[]), ...(forced ? blockers : [])]
    .filter(isRecord).map((entry) => ({ kind: entry.kind, name: typeof entry.name === 'string' ? entry.name : '' }));
  const numbers = (kind: string) => entries.filter((entry) => entry.kind === kind)
    .flatMap((entry) => [...entry.name.matchAll(/#(\d+)/g)].map((match) => Number(match[1])));
  const siblings = numbers('sibling-pr');
  const prs = [...new Set([...numbers('open-pr'), ...siblings])];
  const liveRuns = entries.filter((entry) => entry.kind === 'live-run' && entry.name.trim() !== '').length;
  const axisChecked = (axis: unknown) => isRecord(axis) && axis.state === 'checked';
  // ⛔ A capped open-PR scan («열린 PR 조회 상한 N») saw only part of the PRs — its «no hit» is not a measurement.
  const capped = entries.some((entry) => entry.kind === 'open-pr' && !/#\d+/.test(entry.name));
  const blind = capped || !axisChecked(payload.openPrs) || !axisChecked(payload.liveRuns)
    || !Array.isArray(payload.paths) || payload.paths.length === 0;
  return { at, runKey: runKeyOf(payload.runId), prs, siblings, proven: prs.length > 0 || liveRuns > 0, blind };
}

export async function collectOverlapMetrics(repository: string, adapters: OverlapMetricAdapters, now: Date): Promise<OverlapMetrics> {
  const clock = now.getTime();
  if (!Number.isFinite(clock)) throw new Error('Invalid overlap metric clock');
  const since = clock - 24 * 3_600_000;
  const landingUnmeasured = { linked: null, autoLanded: null, autoRate: null, secondSiblingMedianHours: null, salvaged: null, salvageUnmeasured: null };
  const incomplete = (reason: string, extra: Record<string, unknown> = {}): OverlapMetrics => {
    try { debug.log('drafts.metrics', 'overlap-source-incomplete', { reason, ...extra }); } catch { /* fail-soft */ }
    return { launches24h: null, launched: null, unmeasured: null, sourceIncomplete: true, ...landingUnmeasured };
  };
  const rows = await adapters.listPreflightRows(new Date(since));
  if (rows === null || !Array.isArray(rows)) return incomplete('unreadable');
  if (rows.length === 0) return incomplete('zero-events');
  // One launch per run: a run re-authored after a block logs several preflights (and one store can be reached twice).
  const runs = new Map<string, OverlapLaunch>();
  let unparsable = 0;
  for (const row of rows) {
    const at = Date.parse(String(row?.ts));
    if (!Number.isFinite(at)) { unparsable++; continue; }
    if (at < since || at > clock) continue;
    const payload = overlapPreflightPayload(row?.data);
    if (payload === null) { unparsable++; continue; }
    const launch = overlapLaunch(payload, at);
    if (!launch) continue;
    const key = launch.runKey ?? `${at}:${String(payload.goalFile ?? '')}`;
    const prior = runs.get(key);
    runs.set(key, prior ? {
      at: Math.min(prior.at, launch.at), runKey: launch.runKey,
      prs: [...new Set([...prior.prs, ...launch.prs])], siblings: [...new Set([...prior.siblings, ...launch.siblings])],
      proven: prior.proven || launch.proven, blind: prior.blind || launch.blind,
    } : launch);
  }
  if (unparsable > 0) return incomplete('unparsable-rows', { unparsable, rows: rows.length });
  const all = [...runs.values()];
  const launches = all.filter((launch) => launch.proven);
  const counts = { launches24h: launches.length, launched: all.length, unmeasured: all.filter((launch) => !launch.proven && launch.blind).length, sourceIncomplete: false };
  const linkable = launches.filter((launch) => launch.runKey !== null || launch.siblings.length > 0);
  // No overlap launch is a measured empty sample; overlaps that name neither a run nor a sibling leave landing unmeasured.
  if (launches.length === 0) return { ...counts, linked: 0, autoLanded: 0, autoRate: null, secondSiblingMedianHours: null, salvaged: 0, salvageUnmeasured: 0 };
  if (linkable.length === 0) return { ...counts, ...landingUnmeasured };
  try {
    if (!adapters.getPr || !adapters.listRecentClosed) throw new Error('Overlap PR lookup unavailable');
    const [drafts, closed] = await Promise.all([
      collectPages((page, size) => adapters.listDrafts(page, size, repository)),
      adapters.listRecentClosed(repository, new Date(since)),
    ]);
    const candidates = [...drafts, ...closed].filter((pr) => Number.isInteger(pr.number) && typeof pr.branch === 'string'
      && typeof pr.createdAt === 'string' && Number.isFinite(Date.parse(pr.createdAt)));
    const firsts = new Map<number, SweepMergedPr | undefined>();
    let linked = 0, autoLanded = 0, salvaged = 0, salvageUnmeasured = 0;
    const hours: number[] = [];
    // Read lazily: only a launch with no PR sibling needs the salvage source. ⛔ A read failure is «unmeasured», not «none».
    let salvage: SalvagedSibling[] | null | undefined;
    const salvageSource = async (): Promise<SalvagedSibling[] | null> => {
      if (salvage !== undefined) return salvage;
      let rows: readonly OverlapPreflightRow[] | null = null;
      try { rows = adapters.listSalvagedRows ? await adapters.listSalvagedRows(new Date(since)) : null; } catch { rows = null; }
      salvage = salvagedSiblings(rows, since, clock);
      if (salvage === null) try { debug.log('drafts.metrics', 'overlap-salvage-unmeasured', { reason: rows === null ? 'unreadable' : 'unparsable-rows' }); } catch { /* fail-soft */ }
      return salvage;
    };
    for (const launch of linkable) {
      const after = candidates.filter((pr) => !launch.prs.includes(pr.number) && Date.parse(pr.createdAt!) >= launch.at)
        .sort((a, b) => Date.parse(a.createdAt!) - Date.parse(b.createdAt!));
      let second = launch.runKey === null ? undefined
        : after.find((pr) => pr.branch.endsWith(`-r${launch.runKey}`) || pr.branch.endsWith(`-r${launch.runKey}-early`));
      let slug: string | null = null;
      if (!second && launch.siblings.length > 0) {
        const number = launch.siblings[0]!;
        if (!firsts.has(number)) firsts.set(number, await adapters.getPr(repository, number));
        const first = firsts.get(number);
        if (!first) throw new Error('Sibling PR unreadable');
        slug = branchLineageSlug(first.branch);
        if (slug !== null) second = after.find((pr) => branchLineageSlug(pr.branch) === slug);
      }
      if (!second) {
        const source = await salvageSource();
        if (source === null) { salvageUnmeasured++; continue; }
        const branch = source.filter((sibling) => sibling.at >= launch.at
          && ((launch.runKey !== null && sibling.runKey === launch.runKey) || (slug !== null && sibling.slug === slug)))
          .sort((a, b) => a.at - b.at)[0]?.salvageBranch;
        if (branch === undefined) continue;
        // A salvage branch later landed through its own PR counts through that PR's merge.
        second = after.find((pr) => pr.branch === branch);
        if (!second) { linked++; salvaged++; continue; }
      }
      linked++;
      const mergedAt = 'mergedAt' in second && typeof second.mergedAt === 'string' ? Date.parse(second.mergedAt) : NaN;
      if (!Number.isFinite(mergedAt) || mergedAt < launch.at || mergedAt > clock) continue;
      hours.push((mergedAt - launch.at) / 3_600_000);
      if (!(second.labels ?? []).some((name) => HUMAN_HAND_LABELS.has(name))) autoLanded++;
    }
    hours.sort((a, b) => a - b);
    const mid = Math.floor(hours.length / 2);
    return {
      ...counts,
      linked,
      autoLanded,
      autoRate: linked ? autoLanded / linked : null,
      secondSiblingMedianHours: hours.length ? (hours.length % 2 ? hours[mid]! : (hours[mid - 1]! + hours[mid]!) / 2) : null,
      // ⛔ A salvage source we could not read leaves the salvaged count unknown, not zero.
      salvaged: salvage === null ? null : salvaged,
      salvageUnmeasured,
    };
  } catch (error) {
    try { debug.log('drafts.metrics', 'overlap-landing-unmeasured', { error: error instanceof Error ? error.message : String(error) }); } catch { /* fail-soft */ }
    return { ...counts, ...landingUnmeasured };
  }
}

const stateLabels = PR_LABELS.filter((label) => label.axis === 'state');
const label = (action: 'mark-stalled' | 'close', name?: string): string => {
  const match = PR_LABELS.find((entry) => entry.axis === 'state' && entry.sweep.action === action && (name === undefined || entry.name.endsWith(name)));
  if (!match) throw new Error(`Missing registered PR state for ${action}`);
  return match.name;
};
const runningLabel = label('mark-stalled');
const stalledLabel = label('close', 'stalled');
const supersededLabel = label('close', 'superseded');
const approvalLabel = PR_LABELS.find((entry) => entry.axis === 'state' && entry.sweep.action === 'none')?.name;
const keepLabel = PR_LABELS.find((entry) => entry.sweep.action === 'exclude')?.name;
const releaseHoldLabel = PR_LABELS.find((entry) => entry.axis === 'addon' && entry.sweep.action === 'none')?.name;
const PAGE_SIZE = 100;
/** At most this many closes per tick, so a wrong rule cannot close everything at once. Default for `tools.selfImplement.draftSweepCloseCap`. */
export const DRAFT_SWEEP_CLOSE_CAP = 10;
export const DRAFT_SWEEP_CLOSE_CAP_MIN = 1;
export const DRAFT_SWEEP_CLOSE_CAP_MAX = 100;
export type DraftSweepCloseCapSource = 'flag' | 'config' | 'default';

export interface DraftSweepCloseCapResolution {
  readonly closeCap: number;
  readonly closeCapSource: DraftSweepCloseCapSource;
  /** One line per rejected input (flag or config); each rejection falls through to the next source. */
  readonly warnings: readonly string[];
}

function validCloseCap(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed)
    && parsed >= DRAFT_SWEEP_CLOSE_CAP_MIN && parsed <= DRAFT_SWEEP_CLOSE_CAP_MAX ? parsed : undefined;
}

/** Flag over config over default; a value outside 1–100 (or not an integer) is rejected with a warning. */
export function resolveDraftSweepCloseCap(input: { flag?: unknown; config?: unknown }): DraftSweepCloseCapResolution {
  const warnings: string[] = [];
  for (const [source, value, name] of [['flag', input.flag, '--close-cap'], ['config', input.config, 'tools.selfImplement.draftSweepCloseCap']] as const) {
    if (value === undefined || value === null) continue;
    const cap = validCloseCap(value);
    if (cap !== undefined) return { closeCap: cap, closeCapSource: source, warnings };
    warnings.push(`${name}=${JSON.stringify(value)} 무시 — ${DRAFT_SWEEP_CLOSE_CAP_MIN}~${DRAFT_SWEEP_CLOSE_CAP_MAX} 정수만 (기본 ${DRAFT_SWEEP_CLOSE_CAP})`);
  }
  return { closeCap: DRAFT_SWEEP_CLOSE_CAP, closeCapSource: 'default', warnings };
}

/** Post-merge shortcut: only the existing superseded-by decision can authorize a close. */
export async function supersedeDraftsOnMerge(input: {
  repository: string;
  merged: SweepMergedPr & { createdAt: string; mergedAt: string };
  adapters: Pick<DraftSweepAdapters, 'listDrafts' | 'listLiveBranches' | 'getRunStatus' | 'setLabels' | 'closeDraft'>
    & Pick<Partial<DraftSweepAdapters>, 'getLatestFileChanges' | 'getPrFiles'>;
}): Promise<{ closed: number[]; kept: number[] }> {
  const { repository, merged, adapters } = input;
  const closed: number[] = [];
  const kept: number[] = [];
  let drafts: SweepDraft[] = [];
  let error: string | undefined;
  const failed: number[] = [];
  let closeAttempts = 0;
  try {
    const [listedDrafts, liveBranches] = await Promise.all([
      collectPages((page, size) => adapters.listDrafts(page, size, repository)),
      adapters.listLiveBranches(repository),
    ]);
    drafts = listedDrafts;
    if (!liveBranches || !Number.isInteger(merged.number) || !merged.branch || !merged.title
      || !Number.isFinite(Date.parse(merged.createdAt)) || !Number.isFinite(Date.parse(merged.mergedAt))
      || drafts.some((pr) => !Number.isInteger(pr.number) || !pr.branch || !Array.isArray(pr.labels)
        || !Number.isFinite(Date.parse(pr.createdAt)))) throw new Error('Incomplete merge draft inventory');
    const statuses = new Map<number, string | undefined>();
    const latestChanges = new Map<number, Readonly<Record<string, string>> | undefined>();
    const mergedFiles = await adapters.getPrFiles?.(repository, merged.number);
    const landed = { ...merged, changedFiles: mergedFiles };
    for (const draft of drafts) {
      if (draft.number !== merged.number && draft.branch.startsWith('self-impl/') && !liveBranches.has(draft.branch)
        && Date.parse(draft.createdAt) < Date.parse(merged.mergedAt)) {
        statuses.set(draft.number, await adapters.getRunStatus(draft, repository));
        if (draft.changedFiles?.length && adapters.getLatestFileChanges) {
          latestChanges.set(draft.number, await adapters.getLatestFileChanges(draft, repository));
        }
      }
    }
    for (const listedDraft of drafts) {
      const draft = { ...listedDraft, latestFileChanges: latestChanges.get(listedDraft.number) };
      if (draft.number === merged.number || !draft.branch.startsWith('self-impl/') || liveBranches.has(draft.branch)
        || Date.parse(draft.createdAt) >= Date.parse(merged.mergedAt)) {
        kept.push(draft.number);
        continue;
      }
      const decision = decideDraft({ draft, runStatus: statuses.get(draft.number),
        mergedTwins: [landed], liveBranches, ageHours: NaN });
      if (decision.action !== 'close' || !decision.reason.startsWith(`superseded-by #${merged.number}`)
        || PR_LABELS.filter((entry) => entry.axis === 'state' && draft.labels.includes(entry.name)).length > 1
        || closeAttempts >= DRAFT_SWEEP_CLOSE_CAP) {
        kept.push(draft.number);
        continue;
      }
      closeAttempts += 1;
      const remove = stateLabels.filter((entry) => draft.labels.includes(entry.name) && entry.name !== supersededLabel).map((entry) => entry.name);
      try {
        // Label first: a failed label write must never strand a closed, unlabelled PR outside open-draft sweeps.
        if (!draft.labels.includes(supersededLabel)) await adapters.setLabels(repository, draft.number, { add: supersededLabel, remove });
        await adapters.closeDraft(repository, draft.number,
          `Draft sweep: superseded-by #${merged.number} (https://github.com/${repository}/pull/${merged.number}). Branch preserved.`);
        closed.push(draft.number);
      } catch (failure) {
        kept.push(draft.number);
        failed.push(draft.number);
        error = String(failure);
      }
    }
  } catch (failure) {
    error = String(failure);
    kept.push(...drafts.map((draft) => draft.number).filter((number) => !closed.includes(number) && !kept.includes(number)));
  }
  debug.log('drafts.cleanup', 'superseded-on-merge', { merged: merged.number, closed, kept, ...(failed.length ? { failed } : {}), ...(error ? { error } : {}) });
  return { closed, kept };
}

async function collectPages<T>(fetch: (page: number, perPage: number) => Promise<readonly T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const next = await fetch(page, PAGE_SIZE);
    if (!Array.isArray(next) || next.length > PAGE_SIZE) throw new Error('Incomplete PR page');
    rows.push(...next);
    if (next.length < PAGE_SIZE) return rows;
  }
  throw new Error('PR listing exceeded pagination limit');
}

/** First line of a failure, with no stack — the draft-cleanup loop log shows this line as-is. */
export function sweepFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0 && !/^\s*at\s/.test(part));
  return line && line.length > 0 ? line : 'sweep failed';
}

/** Harness draft created at least STALLED_DRAFT_HOURS before `now` — the daily census population. */
function dailyCensusDraft(draft: SweepDraft, now: Date): boolean {
  if (!harnessDraft(draft)) return false;
  const created = Date.parse(draft.createdAt);
  return Number.isFinite(created) && created <= now.getTime() - STALLED_DRAFT_HOURS * 3_600_000;
}

/** In-flight per-PR lookups during one sweep (GitHub calls and ledger reads). */
export const DRAFT_SWEEP_CONCURRENCY = 6;

/** Runs `work` over `items` with at most `limit` in flight; the first rejection rejects the whole map. */
export async function mapBounded<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await work(items[index]!); } catch (error) { failed = true; throw error; }
    }
  });
  await Promise.all(workers);
  return results;
}

function harnessDraft(draft: SweepDraft): boolean {
  return draft.branch.startsWith('self-impl/') || draft.labels.some((name) => name.startsWith('elanous:'));
}

/**
 * Census of harness drafts older than 24h. Same-goal landing uses `sameGoalPr` unchanged.
 * A draft counts as closable when a same-goal merged PR exists, harvestable when review PASS and the gate passed,
 * and blocked when must-fix remains. Unknown review/gate is neither harvestable nor blocked.
 */
export function draftSweepDaily(
  drafts: readonly SweepDraft[],
  merged: readonly SweepMergedPr[],
  now: Date,
  reviewGate: ReadonlyMap<number, SweepReviewGate | undefined>,
): DraftSweepDaily {
  let over24h = 0;
  let closable = 0;
  let harvestable = 0;
  let blocked = 0;
  for (const draft of drafts) {
    if (!dailyCensusDraft(draft, now)) continue;
    over24h += 1;
    if (merged.some((pr) => pr.number !== draft.number && sameGoalPr(draft, pr))) closable += 1;
    const posture = reviewGate.get(draft.number);
    if (posture?.mustFix === true) blocked += 1;
    else if (posture?.review === 'pass' && posture.gate === 'pass') harvestable += 1;
  }
  return { date: now.toISOString().slice(0, 10), over24h, closable, harvestable, blocked };
}

/** A failed inventory or liveness lookup is never treated as proof that a draft can be closed. */
export async function runDraftSweep({ repository, adapters, apply = false, now = new Date(), closeCap: requestedCap, closeCapSource: requestedSource }: DraftSweepOptions): Promise<DraftSweepResult> {
  const validCap = validCloseCap(requestedCap);
  const closeCap = validCap ?? DRAFT_SWEEP_CLOSE_CAP;
  const closeCapSource: DraftSweepCloseCapSource = validCap === undefined ? 'default' : requestedSource ?? 'flag';
  const result: DraftSweepResult = { repository, apply, complete: false, entries: [], counts: {}, closeCap, closeCapSource };
  const record = (entry: DraftSweepEntry): void => {
    result.entries.push(entry);
    result.counts[entry.reason] = (result.counts[entry.reason] ?? 0) + 1;
    debug.log('drafts.cleanup', 'decided', { number: entry.number, action: entry.action, reason: entry.reason });
  };
  const finish = (): DraftSweepResult => {
    debug.log('drafts.cleanup', 'summary', result.counts);
    if (result.daily) debug.log('harness.drafts', 'daily', result.daily);
    if (!result.complete && result.error) debug.log('drafts.cleanup', 'failed', { reason: sweepFailureReason(result.error) });
    return result;
  };
  const started = Date.now();
  let phaseStarted = started;
  // A failed phase still reports its elapsed time (and the total) — a timeout cause must be visible either way.
  const timing = (phase: string, count: number, outcome?: 'failed'): void => {
    const at = Date.now();
    try {
      debug.log('self-dev.draft-sweep', 'timing', { phase, ms: at - phaseStarted, count, ...(outcome ? { outcome } : {}) });
      if (outcome) debug.log('self-dev.draft-sweep', 'timing', { phase: 'total', ms: at - started, count, outcome, closeCap, closeCapSource });
    } catch { /* fail-soft */ }
    phaseStarted = at;
  };
  let drafts: SweepDraft[] = [];
  let merged: SweepMergedPr[] = [];
  let liveBranches: ReadonlySet<string> | undefined;
  try {
    [drafts, merged, liveBranches] = await Promise.all([
      collectPages((page, size) => adapters.listDrafts(page, size, repository)),
      collectPages((page, size) => adapters.listMerged(page, size, repository)),
      adapters.listLiveBranches(repository),
    ]);
    if (!liveBranches) throw new Error('Branch liveness unavailable');
    if (drafts.some((pr) => !Number.isInteger(pr.number) || !pr.branch || !Array.isArray(pr.labels) || !Number.isFinite(Date.parse(pr.createdAt)))
      || merged.some((pr) => !Number.isInteger(pr.number) || !pr.branch)) throw new Error('Invalid PR inventory');
  } catch (error) {
    timing('inventory', drafts.length + merged.length, 'failed');
    result.error = sweepFailureReason(error);
    if (drafts.length > 0) result.daily = draftSweepDaily(drafts, merged, now, new Map());
    return finish();
  }
  timing('inventory', drafts.length + merged.length);
  const statuses = new Map<number, string | undefined>();
  const finality = new Map<number, boolean | undefined>();
  const latestFileChanges = new Map<number, Readonly<Record<string, string>> | undefined>();
  try {
    // Per-draft lookups are independent: bounded concurrency, results keyed by PR number (decisions stay in list order).
    await mapBounded(drafts, DRAFT_SWEEP_CONCURRENCY, async (draft) => {
      const status = await adapters.getRunStatus(draft, repository);
      // A prior final cannot terminate a new active run on the same draft.
      const active = status === 'running' || status === 'probable-running';
      const final = active ? false : await adapters.hasFinalRunResult?.(draft, repository);
      finality.set(draft.number, final);
      statuses.set(draft.number, final ? 'self-implement.result final' : status);
      // Per-file history only matters to all-files-landed, which needs a later same-lineage merge.
      if (draft.changedFiles?.length && adapters.getLatestFileChanges && laterMergedTwins(draft, merged).length > 0) {
        latestFileChanges.set(draft.number, await adapters.getLatestFileChanges(draft, repository));
      }
    });
  } catch (error) {
    timing('run-status', drafts.length, 'failed');
    result.error = sweepFailureReason(error);
    return finish();
  }
  timing('run-status', drafts.length);
  const reviewGate = new Map<number, SweepReviewGate | undefined>();
  if (adapters.getReviewGate) {
    // Review/gate posture only feeds the daily census, which only counts harness drafts older than 24h.
    const censused = drafts.filter((draft) => dailyCensusDraft(draft, now));
    try {
      await mapBounded(censused, DRAFT_SWEEP_CONCURRENCY, async (draft) => {
        reviewGate.set(draft.number, await adapters.getReviewGate!(draft, repository));
      });
    } catch (error) {
      timing('review-gate', censused.length, 'failed');
      result.error = sweepFailureReason(error);
      return finish();
    }
    timing('review-gate', censused.length);
  }
  result.daily = draftSweepDaily(drafts, merged, now, reviewGate);
  result.complete = true;
  let closes = 0;
  let unobserved = 0;
  let claimed = 0;
  let claimExpired = 0;
  for (const listedDraft of drafts) {
    const draft = { ...listedDraft, latestFileChanges: latestFileChanges.get(listedDraft.number) };
    const runStatus = statuses.get(draft.number);
    const finalRunResult = finality.get(draft.number);
    const states = stateLabels.filter((state) => draft.labels.includes(state.name));
    const contradiction = states.length > 1 || draft.labels.includes(approvalLabel ?? '');
    if (draft.labels.includes(releaseHoldLabel ?? '') || (!contradiction && draft.labels.includes(keepLabel ?? ''))) {
      const held = draft.labels.includes(keepLabel ?? '') ? keepLabel : releaseHoldLabel;
      record({ number: draft.number, action: 'keep', reason: `label:${held}`, applied: false });
      continue;
    }
    const isClaimed = !contradiction && draft.labels.includes(runningLabel);
    const ageHours = (now.getTime() - Date.parse(draft.createdAt)) / 3_600_000;
    const idleHours = typeof draft.updatedAt === 'string' && Number.isFinite(Date.parse(draft.updatedAt))
      ? (now.getTime() - Date.parse(draft.updatedAt)) / 3_600_000 : NaN;
    // An unobserved claim may still have a merged twin: liveness/holds retain their priority,
    // but a superseded draft must not be hidden by the six-hour claim window.
    const mergedDecision = isClaimed ? decideDraft({ draft, runStatus, mergedTwins: merged, openDrafts: drafts, liveBranches,
      finalRunResult, ageHours: idleHours }) : undefined;
    const supersededClaim = mergedDecision?.reason.startsWith('superseded-by #') === true
      || mergedDecision?.reason.startsWith('duplicate-of-open #') === true;
    if (!contradiction && mergedDecision?.reason === 'branch-finality-unobserved') {
      record({ number: draft.number, action: 'keep', reason: mergedDecision.reason, applied: false });
      continue;
    }
    // Without an observed update time, neither expiration nor a fallback to creation time can authorize mutation —
    // but a merged twin does not need the update time, so superseded keeps its priority over the unobserved claim.
    if (isClaimed && !supersededClaim && (typeof draft.updatedAt !== 'string' || !Number.isFinite(Date.parse(draft.updatedAt)))) {
      record({ number: draft.number, action: 'keep', reason: 'claim-update-unobserved', applied: false });
      continue;
    }
    if (isClaimed && !supersededClaim && Number.isFinite(idleHours) && idleHours < CLAIM_IDLE_HOURS) {
      claimed += 1;
      record({ number: draft.number, action: 'keep', reason: `label:running(<${CLAIM_IDLE_HOURS}h)`, applied: false });
      continue;
    }
    if (isClaimed && !supersededClaim && Number.isFinite(idleHours) && idleHours >= CLAIM_IDLE_HOURS) {
      claimExpired += 1;
      if (liveBranches.has(draft.branch) && finalRunResult === undefined
        && runStatus !== 'running' && runStatus !== 'probable-running') {
        record({ number: draft.number, action: 'keep', reason: 'branch-finality-unobserved', applied: false });
        continue;
      }
      if (runStatus === 'running' || runStatus === 'probable-running' ||
        (runStatus !== 'self-implement.result final' && liveBranches.has(draft.branch))) {
        record({ number: draft.number, action: 'keep', reason: 'claim-expired-but-live', applied: false });
        continue;
      }
      const action = closes >= closeCap ? 'keep' : 'close';
      if (action === 'close') closes += 1;
      const entry: DraftSweepEntry = { number: draft.number, action,
        reason: action === 'close' ? runStatus === 'self-implement.result final'
          ? 'claim-expired (self-implement.result final; worktree is not live)' : 'claim-expired' : 'close-cap',
        ...(action === 'close' ? { statusLabel: stalledLabel } : {}), applied: false };
      record(entry);
      if (!apply || action !== 'close') continue;
      let labelsChanged = false;
      try {
        const owner = await adapters.getClaimOwner?.(repository, draft.number) ?? '미상';
        await adapters.setLabels(repository, draft.number, { add: stalledLabel, remove: [runningLabel] });
        labelsChanged = true;
        await adapters.closeDraft(repository, draft.number,
          `Draft sweep: 처리 중 표식이 ${CLAIM_IDLE_HOURS}시간 갱신 없음 — ${runStatus === 'self-implement.result final' ? 'self-implement.result final · 남은 워크트리는 live 아님' : '런·워크트리 없음'} · 주인 ${owner}. Closed as stalled. Branch preserved; reopen to restore.`);
        entry.applied = true;
      } catch (error) {
        if (labelsChanged) entry.partialApplied = true;
        entry.error = String(error);
      }
      continue;
    }
    // Unlabelled non-harness drafts are outside the sweeper's jurisdiction.
    if (!contradiction && !states.length && !draft.branch.startsWith('self-impl/')) {
      record({ number: draft.number, action: 'keep', reason: 'outside-harness', applied: false });
      continue;
    }
    let decision = supersededClaim ? mergedDecision! : decideDraft({ draft, runStatus, mergedTwins: merged, openDrafts: drafts, liveBranches,
      finalRunResult, ageHours: runStatus ? ageHours : idleHours });
    if (!runStatus && (decision.reason === 'unobserved' || decision.reason === 'stale-unobserved')) unobserved += 1;
    if (!contradiction && decision.action === 'close') {
      if (closes >= closeCap) decision = { action: 'keep', reason: 'close-cap' };
      else closes += 1;
    }
    const action = contradiction ? 'report' : decision.action;
    const reason = contradiction
      ? (states.length > 1 ? 'conflicting-state-labels' : 'approval-label-on-draft')
      : decision.reason;
    const isLive = decision.reason === 'live';
    const target = action === 'report' ? undefined : action === 'close'
      ? decision.reason.startsWith('superseded-by #') || decision.reason.startsWith('duplicate-of-open #') ? supersededLabel : stalledLabel
      : isLive ? (states.length ? runningLabel : undefined) : runStatus && (states[0]?.name === runningLabel || states.length === 0) ? stalledLabel : undefined;
    const entry: DraftSweepEntry = { number: draft.number, action, reason, ...(target ? { statusLabel: target } : {}), applied: false };
    record(entry);
    if (!apply || action === 'report') continue;
    let labelsChanged = false;
    try {
      if (target && !draft.labels.includes(target)) {
        await adapters.setLabels(repository, draft.number, {
          add: target, remove: states.map((state) => state.name).filter((name) => name !== target),
        });
        labelsChanged = true;
      }
      if (action === 'close') {
        await adapters.closeDraft(repository, draft.number, decision.reason === 'stale-unobserved'
          ? `Draft sweep: run unobserved — no run record reachable here, no host worktree for this branch, idle ≥${STALLED_DRAFT_HOURS}h. Closed as stalled. Branch preserved; reopen to restore.`
          : `Draft sweep: ${decision.reason}${decision.reason.startsWith('superseded-by #')
            ? ` (https://github.com/${repository}/pull/${decision.reason.slice('superseded-by #'.length).match(/^\d+/)![0]})` : ''}. Branch preserved.`);
      }
      entry.applied = labelsChanged || action === 'close';
    } catch (error) {
      if (labelsChanged && action === 'close') entry.partialApplied = true;
      entry.error = String(error);
    }
  }
  timing('decide', drafts.length);
  try { debug.log('self-dev.draft-sweep', 'timing', { phase: 'total', ms: Date.now() - started, count: drafts.length, closed: closes, closeCap, closeCapSource }); } catch { /* fail-soft */ }
  result.unobserved = unobserved;
  result.closed = closes;
  result.claimed = claimed;
  result.claimExpired = claimExpired;
  return finish();
}
