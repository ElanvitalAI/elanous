// RESOURCE-OPT-HOURLY (L1) — the runtime reads behind the matching table. Every source is fail-soft: a source that
// cannot be read is named in `unmeasured` (shown in the prompt), never an empty list that looks like «no work».
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildMatchingTable, type CellIn, type JudgeIn, type MatchingTable, type PaneIn, type PrIn } from './matching-table.js';
import { resourceOptDir } from './assignment-gate.js';

function run(command: string, args: readonly string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, ...(env ? { env } : {}) }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

const short = (error: unknown): string => String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 60);

/** Read every source and build the table. Returns null when the listing names another HQ coordinator than `seat`. */
export async function gatherMatchingTable(opts: { seat: string; hqRoot?: string; now?: () => number; refused?: ReadonlyArray<{ cell: string; seat?: string }> }): Promise<MatchingTable | null> {
  const hqRoot = opts.hqRoot ?? join(homedir(), 'elanous-hq');
  const now = (opts.now ?? Date.now)();
  const unmeasured: string[] = [];
  const { resolveCurrentVersion } = await import('../ops-dashboard/current-version.js');
  const version = resolveCurrentVersion({ hqRoot }).version;

  let panes: PaneIn[] = [];
  let hqSeat = opts.seat;
  try {
    const { elanousInvocation } = await import('../instance/spawn-elanous.js');
    const inv = elanousInvocation(['side', 'ls', '--json']);
    const listed = JSON.parse(await run(inv.command, inv.args, 30_000, inv.env)) as { hqCoordinatorSeat?: unknown; panes?: Array<{ seat?: unknown; status?: unknown }> };
    if (typeof listed.hqCoordinatorSeat === 'string' && listed.hqCoordinatorSeat.trim()) hqSeat = listed.hqCoordinatorSeat.trim().toUpperCase();
    panes = (listed.panes ?? []).flatMap((pane) => {
      const status = pane.status && typeof pane.status === 'object' ? pane.status as { state?: unknown; since?: unknown } : null;
      if (!status || typeof status.state !== 'string') return [];
      return [{ ...(typeof pane.seat === 'string' ? { seat: pane.seat } : {}), state: status.state, ...(typeof status.since === 'number' ? { since: status.since } : {}) }];
    });
  } catch (error) { unmeasured.push(`seats(${short(error)})`); }
  if (hqSeat !== opts.seat.toUpperCase()) return null;

  let cells: CellIn[] = [];
  let items: import('../release-loop/checklist.js').ChecklistItem[] = [];
  try {
    const { listChecklist } = await import('../release-loop/checklist.js');
    const { releaseLedgerRoot } = await import('../instance/resolve.js');
    items = listChecklist(version, releaseLedgerRoot()).items;
    cells = items.map((item) => ({ id: item.id, title: item.title, status: item.status, updatedAt: item.updatedAt,
      ...(item.owner ? { owner: item.owner } : {}), ...(item.priority ? { priority: item.priority } : {}) }));
  } catch (error) { unmeasured.push(`checklist(${short(error)})`); }

  let prs: PrIn[] = [];
  try {
    const raw = JSON.parse(await run('gh', ['pr', 'list', '--state', 'open', '--limit', '300', '--json', 'number,headRefName,headRefOid,isDraft,title'], 30_000)) as
      Array<{ number: number; headRefName: string; headRefOid: string; isDraft: boolean; title: string }>;
    prs = raw.map((pr) => ({ number: pr.number, branch: pr.headRefName, headSha: pr.headRefOid, isDraft: pr.isDraft, title: pr.title }));
  } catch (error) { unmeasured.push(`prs(${short(error)})`); }

  let greenLanes: string[] = [];
  let judgeQueue: JudgeIn[] = [];
  try {
    const { PREGATE_GREEN_DIR, readGreenTriageSources, triageGreen } = await import('../release-loop/green-triage.js');
    greenLanes = existsSync(PREGATE_GREEN_DIR) ? readdirSync(PREGATE_GREEN_DIR) : [];
    const triage = triageGreen(version, items, readGreenTriageSources({ greenLanes: () => greenLanes }));
    const updated = new Map(items.map((item) => [item.id, Date.parse(item.updatedAt)] as const));
    judgeQueue = triage.rows.judge.map((row) => ({ id: row.id, owner: row.owner, sinceMs: updated.get(row.id) ?? now, ...(row.mergedPrs[0] ? { pr: row.mergedPrs[0] } : {}) }));
  } catch (error) { unmeasured.push(`judge-queue(${short(error)})`); }

  return buildMatchingTable({ now, version, hqSeat, panes, cells, prs, greenLanes, judgeQueue, unmeasured, ...(opts.refused?.length ? { refused: opts.refused } : {}) });
}

export const RESOURCE_OPT_TRIGGER = 'trigger';

export const RESOURCE_OPT_PENDING = 'pending.json';

/**
 * On demand: the CLI writes the trigger; a running OP TUI picks it up and opens the assignment turn. With `table`
 * (LOOP-TRAFFIC R1's exception rows) that table is the turn's input instead of a fresh full gather.
 */
export function writeResourceOptTrigger(dir: string = resourceOptDir(), by = 'cli', table?: MatchingTable): string {
  mkdirSync(dir, { recursive: true });
  if (table) {
    const tmp = join(dir, `${RESOURCE_OPT_PENDING}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(table)}\n`);
    renameSync(tmp, join(dir, RESOURCE_OPT_PENDING));
  }
  const path = join(dir, RESOURCE_OPT_TRIGGER);
  writeFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), by })}\n`);
  return path;
}

/** Watch the trigger file (fs events, no polling). Returns a stop function; a directory that cannot be watched → no-op. */
export function watchResourceOptTrigger(onTrigger: () => void, dir: string = resourceOptDir()): () => void {
  try {
    mkdirSync(dir, { recursive: true });
    const watcher = watch(dir, (_event, name) => { if (String(name ?? '') === RESOURCE_OPT_TRIGGER) onTrigger(); });
    (watcher as { unref?: () => void }).unref?.();
    return () => { try { watcher.close(); } catch { /* already closed */ } };
  } catch { return () => {}; }
}

/** A pending exception table handed over by the traffic graph (consumed once), or null. */
export function takePendingTable(dir: string = resourceOptDir()): MatchingTable | null {
  const path = join(dir, RESOURCE_OPT_PENDING);
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  try { unlinkSync(path); } catch { /* another reader took it */ }
  try {
    const table = JSON.parse(text) as MatchingTable;
    return table && Array.isArray(table.rows) && typeof table.version === 'string' && table.summary ? table : null;
  } catch { return null; }
}
