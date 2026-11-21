/** Gracefully move ELS seat tabs on this host and explicitly pinned remote hosts. */
import { authorizeSeatControl } from '../seat/seat-control.js';
import type { SeatControlExpected } from '../cli/seat-control-cli.js';

export interface UpdatePane {
  readonly address: string;
  readonly host: string;
  readonly reach: string;
  readonly seat?: string | null;
  readonly state: string;
  readonly cwd: string;
  readonly pid?: number;
  readonly kind?: string;
}

export interface UpdateSeatRow {
  readonly id: string;
  readonly seat?: string;
  readonly ownerPid: number;
  readonly alive: boolean;
  readonly kind: string;
  readonly sessionId: string;
  readonly workdir?: string;
  readonly build?: { readonly sha: string; readonly source: string };
}

export interface UpdateResultRow {
  readonly tab: string;
  readonly seat: string;
  readonly result: 'updated' | 'waiting' | 'failed' | 'skipped';
  readonly detail: string;
}

export interface UpdateAllDeps {
  readonly sender: () => string | null;
  readonly expectedDesired?: string;
  /** The CLI's guarded installation and human approval, before any target or pane work. */
  readonly prepare?: () => Promise<void>;
  readonly target: () => { desired: string | undefined; installed: string | undefined };
  readonly list: () => Promise<{ panes: readonly UpdatePane[]; hosts: readonly { name: string; reach: string }[];
    hostsProblem?: string; rejectedHosts?: readonly string[] }>;
  readonly seats: () => readonly UpdateSeatRow[];
  /** Must call the existing seat-control migrate door, not write to a pane. */
  readonly migrate: (seat: string, expected: SeatControlExpected) => Promise<{ status: string; reason?: string }>;
  /** One pinned remote host runs its own local update path and returns rows for its exact listed panes. */
  readonly remoteUpdate?: (host: { readonly name: string; readonly reach: string }, panes: readonly UpdatePane[], desired: string) => Promise<{
    readonly result: UpdateResultRow['result']; readonly detail: string; readonly panes: readonly UpdateResultRow[];
  }>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly timeoutMs?: number;
  /** Remote child only: the SSH parent owns federation; this invocation may see this host alone. */
  readonly localOnly?: boolean;
}

const SHA = /^[a-f0-9]{40}$/i;
const SEAT = /^[A-Z][A-Z0-9_-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function safe(value: string): string { return value.replace(/[\r\n|]/g, ' ').slice(0, 160); }

export function updateResultsTable(rows: readonly UpdateResultRow[]): string {
  return ['| 탭 | 자리 | 결과 | 상세 |', '|---|---|---|---|',
    ...rows.map(row => `| ${safe(row.tab)} | ${safe(row.seat)} | ${row.result} | ${safe(row.detail)} |`)].join('\n');
}

/** A request returning "waiting" only means the running TUI accepted the turn-boundary wait. */
export async function updateAllElsTabs(deps: UpdateAllDeps): Promise<{ ok: boolean; rows: UpdateResultRow[]; reason?: string }> {
  const sender = deps.sender();
  if (sender !== 'OP' && sender !== 'RES-INFRA') return { ok: false, rows: [], reason: 'operator-seat-required' };
  const approved = deps.expectedDesired;
  if (approved !== undefined && (!SHA.test(approved) || deps.target().desired?.toLowerCase() !== approved.toLowerCase()))
    return { ok: false, rows: [], reason: 'approved-desired-changed' };
  await deps.prepare?.();
  const { desired, installed } = deps.target();
  if (approved !== undefined && desired?.toLowerCase() !== approved.toLowerCase())
    return { ok: false, rows: [], reason: 'approved-desired-changed' };
  if (!desired || !installed || !SHA.test(desired) || !SHA.test(installed) || desired.toLowerCase() !== installed.toLowerCase())
    return { ok: false, rows: [], reason: 'desired-build-not-installed' };
  const listing = await deps.list();
  if (!Array.isArray(listing.panes) || !Array.isArray(listing.hosts)) return { ok: false, rows: [], reason: 'invalid-els-list' };
  if (!deps.localOnly && (listing.hostsProblem || listing.rejectedHosts?.length)) return { ok: false, rows: [], reason: 'els-host-registry-invalid' };
  if (!listing.hosts.some(host => host.reach === 'local')) return { ok: false, rows: [], reason: 'local-els-owner-unavailable' };
  const seats = deps.seats(); // A failed ledger read must throw; an empty result is only a confirmed empty ledger.
  const rows: UpdateResultRow[] = [];
  const pending = new Map<string, { oldPid: number; sessionId: string; cwd: string; rowIndexes: number[] }>();
  const seen = new Map<string, { expected: SeatControlExpected; request: { status: string; reason?: string } }>();
  for (const pane of listing.panes) {
    if (!pane || typeof pane.address !== 'string' || typeof pane.host !== 'string' || typeof pane.reach !== 'string' || typeof pane.state !== 'string' || typeof pane.cwd !== 'string')
      return { ok: false, rows: [], reason: 'invalid-els-pane' };
    if (!listing.hosts.some(host => host.name === pane.host)) return { ok: false, rows: [], reason: 'unregistered-els-pane-host' };
  }
  for (const host of listing.hosts) {
    if (!host || typeof host.name !== 'string' || typeof host.reach !== 'string') return { ok: false, rows: [], reason: 'invalid-els-host' };
    if (host.reach === 'local' || deps.localOnly) continue;
    const remotePanes = listing.panes.filter(pane => pane.host === host.name);
    if (host.reach !== 'up' || !deps.remoteUpdate) {
      rows.push({ tab: `${host.name}:*`, seat: '', result: 'failed', detail: host.reach !== 'up' ? 'remote host unavailable' : 'remote update not configured' });
      for (const pane of remotePanes) rows.push({ tab: pane.address, seat: pane.seat ?? '', result: 'failed', detail: 'remote result unavailable' });
      continue;
    }
    try {
      const outcome = await deps.remoteUpdate(host, remotePanes, desired);
      const expected = new Set(remotePanes.map(pane => pane.address));
      if (outcome.panes.length !== expected.size || outcome.panes.some(row => !expected.delete(row.tab)) || expected.size) throw new Error('remote result does not match listed panes');
      rows.push({ tab: `${host.name}:*`, seat: '', result: outcome.result, detail: outcome.detail }, ...outcome.panes);
    } catch (error) {
      rows.push({ tab: `${host.name}:*`, seat: '', result: 'failed', detail: `remote update failed: ${error instanceof Error ? error.message : String(error)}` });
      for (const pane of remotePanes) rows.push({ tab: pane.address, seat: pane.seat ?? '', result: 'failed', detail: 'remote result unavailable' });
    }
  }
  for (const pane of listing.panes) {
    const seat = pane.seat ?? '';
    const index = rows.length;
    if (pane.reach !== 'local') continue;
    if (pane.state === 'exited') { rows.push({ tab: pane.address, seat, result: 'skipped', detail: 'exited' }); continue; }
    if (!seat) { rows.push({ tab: pane.address, seat, result: 'skipped', detail: 'not a seat tab' }); continue; }
    if (!SEAT.test(seat)) { rows.push({ tab: pane.address, seat, result: 'failed', detail: 'invalid seat identity' }); continue; }
    if (!Number.isSafeInteger(pane.pid) || pane.pid! <= 0) { rows.push({ tab: pane.address, seat, result: 'failed', detail: 'pane process identity unavailable' }); continue; }
    if (!authorizeSeatControl({ sender, target: seat, sameHost: true })) { rows.push({ tab: pane.address, seat, result: 'failed', detail: 'seat control denied' }); continue; }
    const matches = seats.filter(row => row.kind === 'tui' && row.alive && row.seat === seat && row.workdir === pane.cwd && row.ownerPid === pane.pid);
    if (matches.length !== 1) { rows.push({ tab: pane.address, seat, result: 'failed', detail: matches.length ? 'ambiguous seat' : 'live TUI missing' }); continue; }
    const old = matches[0]!;
    if (!old.sessionId) { rows.push({ tab: pane.address, seat, result: 'failed', detail: 'session identity unavailable' }); continue; }
    const expected = { id: old.id, ownerPid: old.ownerPid, sessionId: old.sessionId, workdir: pane.cwd };
    const prior = seen.get(seat);
    if (prior && (prior.expected.id !== expected.id || prior.expected.ownerPid !== expected.ownerPid
      || prior.expected.sessionId !== expected.sessionId || prior.expected.workdir !== expected.workdir)) {
      rows.push({ tab: pane.address, seat, result: 'failed', detail: 'ambiguous seat target' }); continue;
    }
    let request = prior?.request;
    if (!request) {
      try { request = await deps.migrate(seat, expected); }
      catch (error) { request = { status: 'failed', reason: error instanceof Error ? error.message : String(error) }; }
      seen.set(seat, { expected, request });
    }
    if (request.status !== 'success' || (request.reason !== 'waiting' && request.reason !== 'accepted')) {
      rows.push({ tab: pane.address, seat, result: 'failed', detail: request.reason ?? request.status }); continue;
    }
    rows.push({ tab: pane.address, seat, result: 'waiting', detail: 'turn boundary or restart pending' });
    const item = pending.get(seat);
    if (item) item.rowIndexes.push(index);
    else pending.set(seat, { oldPid: old.ownerPid, sessionId: old.sessionId, cwd: pane.cwd, rowIndexes: [index] });
  }
  const deadline = deps.now() + (deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (pending.size && deps.now() < deadline) {
    let current: readonly UpdateSeatRow[];
    try { await deps.sleep(1_000); current = deps.seats(); }
    catch (error) {
      const detail = `verification failed: ${error instanceof Error ? error.message : String(error)}`;
      for (const wait of pending.values()) for (const index of wait.rowIndexes)
        rows[index] = { ...rows[index]!, result: 'failed', detail };
      pending.clear();
      break;
    }
    for (const [seat, wait] of pending) {
      const candidates = current.filter(row => row.kind === 'tui' && row.alive && row.seat === seat && row.workdir === wait.cwd);
      if (candidates.length !== 1) continue;
      const next = candidates[0]!;
      if (next.ownerPid === wait.oldPid || next.sessionId !== wait.sessionId || next.build?.source !== 'installed'
        || next.build.sha.toLowerCase() !== desired.toLowerCase()) continue;
      for (const index of wait.rowIndexes) rows[index] = { ...rows[index]!, result: 'updated', detail: desired.slice(0, 12) };
      pending.delete(seat);
    }
  }
  for (const wait of pending.values()) for (const index of wait.rowIndexes)
    rows[index] = { ...rows[index]!, result: 'waiting', detail: 'deadline; turn or restart unverified' };
  const finalTarget = deps.target();
  const targetChanged = finalTarget.desired?.toLowerCase() !== desired.toLowerCase() || finalTarget.installed?.toLowerCase() !== installed.toLowerCase();
  if (targetChanged) {
    for (let index = 0; index < rows.length; index++) if (rows[index]!.result === 'updated')
      rows[index] = { ...rows[index]!, result: 'failed', detail: 'desired or installed build changed during migration' };
  }
  return { ok: !targetChanged && (rows.some(row => row.result === 'updated') || (!!deps.localOnly && rows.every(row => row.result === 'skipped')))
    && rows.every(row => row.result === 'updated' || row.result === 'skipped')
    && rows.every(row => !row.tab.endsWith(':*') || row.result === 'updated'), rows,
    ...(targetChanged ? { reason: 'desired-build-changed' } : rows.length === 0 ? { reason: 'no-tabs' } : {}) };
}
