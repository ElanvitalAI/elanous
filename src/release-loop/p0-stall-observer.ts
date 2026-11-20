// OP-STALL-P0-HOURLY wiring: observe each open P0 cell's PR head/branch on the periodic landing-heal tick and feed
// postP0StallAlerts. «Unchanged since» is measured across ticks in p0-stall-heads.json next to p0-stall-alerts.json.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checklistEvidencePrRefs } from '../cli/release-checklist-read-cli.js';
import { debug } from '../debug/log.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { assertNotTestWritingOps } from '../instance/test-write-guard.js';
import { listChecklist, postP0StallAlerts, type ChecklistItem, type P0HeadObservation, type P0StallTick } from './checklist.js';
import { readSchedules, releasedVersion } from './feature-store.js';

/** `gh <args>` → stdout; throws on failure (landing-heal's GitHub App seam in production). */
export type GhRun = (args: string[]) => string;
interface HeadMark { pr: string; head: string; branch: string | null; lastChangedAt: string }
type HeadState = Record<string, HeadMark>;

export function p0StallHeadsPath(version: string, root = releaseLedgerRoot()): string {
  return join(root, 'release', version, 'p0-stall-heads.json');
}

function readHeadState(path: string): HeadState {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const state: HeadState = {};
    for (const [id, value] of Object.entries(raw as Record<string, Partial<HeadMark> | null>))
      if (value && typeof value.pr === 'string' && typeof value.head === 'string' && typeof value.lastChangedAt === 'string'
        && (value.branch === null || typeof value.branch === 'string'))
        state[id] = { pr: value.pr, head: value.head, branch: value.branch, lastChangedAt: value.lastChangedAt };
    return state;
  } catch (error) {
    // A lost history restarts the 60-minute clock from this tick: late, never a false alert.
    debug.log('release-loop.p0-stall', 'heads-read-failed', { path, error: String(error).slice(0, 300) }, { level: 'warn' });
    return {};
  }
}

function writeHeadState(path: string, state: HeadState): void {
  assertNotTestWritingOps(path, 'write the P0 stall head state');
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Read the PR head/branch of every open P0 cell whose evidence names exactly one PR (E1's parser).
 *  A gh failure skips that cell this tick — no observation, so no alert and no recovery. */
export function observeP0Heads(input: { items: readonly ChecklistItem[]; gh: GhRun; now: Date }, deps: { headsPath: string }): Record<string, P0HeadObservation> {
  const previous = readHeadState(deps.headsPath);
  const next: HeadState = {};
  const heads: Record<string, P0HeadObservation> = {};
  for (const item of input.items) {
    if (item.priority !== 'P0' || item.status === 'green' || item.status === 'done') continue;
    const { prRefs } = checklistEvidencePrRefs(item.evidence ?? '');
    if (prRefs.length !== 1) continue;
    const pr = prRefs[0]!;
    let head: string; let branch: string | null;
    try {
      const view = JSON.parse(input.gh(['pr', 'view', pr, '--json', 'headRefOid,headRefName'])) as { headRefOid?: unknown; headRefName?: unknown };
      if (typeof view.headRefOid !== 'string' || !/^[0-9a-f]{40}$/i.test(view.headRefOid)) throw new Error('no headRefOid');
      head = view.headRefOid; branch = typeof view.headRefName === 'string' && view.headRefName ? view.headRefName : null;
    } catch (error) {
      debug.log('release-loop.p0-stall', 'head-read-failed', { cell: item.id, pr, error: String(error).slice(0, 300) }, { level: 'warn' });
      if (previous[item.id]) next[item.id] = previous[item.id]!;
      continue;
    }
    const old = previous[item.id];
    const mark = old && old.pr === pr && old.head === head && old.branch === branch ? old : { pr, head, branch, lastChangedAt: input.now.toISOString() };
    next[item.id] = mark;
    heads[item.id] = { head, ...(branch ? { branch } : {}), lastChangedAt: mark.lastChangedAt };
  }
  if (JSON.stringify(next) !== JSON.stringify(previous)) writeHeadState(deps.headsPath, next);
  return heads;
}

function versionOrder(a: string, b: string): number {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export interface P0StallTickDeps {
  root?: string;
  schedules?: () => Array<{ version: string; cutAt: string }>;
  shipped?: () => string;
  items?: (version: string) => readonly ChecklistItem[];
  post?: typeof postP0StallAlerts;
  store?: NonNullable<Parameters<typeof postP0StallAlerts>[1]>['store'];
}

/** One periodic tick: every unshipped release whose cut is still ahead (the org.stall escalation's window). */
export function tickP0Stall(input: { gh: GhRun; now: Date }, deps: P0StallTickDeps = {}): Array<{ version: string } & P0StallTick> {
  const root = deps.root ?? releaseLedgerRoot();
  const shipped = (deps.shipped ?? (() => releasedVersion(root)))();
  const versions = (deps.schedules ?? (() => readSchedules(root)))()
    .filter((schedule) => /^\d+\.\d+\.\d+$/.test(schedule.version) && Date.parse(schedule.cutAt) > input.now.getTime()
      && (!shipped || versionOrder(schedule.version, shipped) > 0))
    .map((schedule) => schedule.version);
  const post = deps.post ?? postP0StallAlerts;
  return versions.map((version) => {
    const items = (deps.items ?? ((v: string) => listChecklist(v, root).items))(version);
    const heads = observeP0Heads({ items, gh: input.gh, now: input.now }, { headsPath: p0StallHeadsPath(version, root) });
    const statePath = join(root, 'release', version, 'p0-stall-alerts.json');
    return { version, ...post({ version, items, heads, now: input.now }, { statePath, ...(deps.store ? { store: deps.store } : {}) }) };
  });
}
