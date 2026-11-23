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
  readonly build?: { readonly sha?: string | null; readonly desired?: string | null; readonly age?: string };
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
  readonly runtime?: string;
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
  /** pid → ppid snapshot of this host's process table. After a turn-boundary migration the live TUI
   * is a descendant of the pane pid, so exact ownerPid === pane.pid misses it (OP #134152). */
  readonly processTree?: () => ReadonlyMap<number, number> | undefined;
  /** Must call the existing seat-control migrate door, not write to a pane. */
  readonly migrate: (seat: string, expected: SeatControlExpected) => Promise<{ status: string; reason?: string }>;
  /** One pinned remote host runs its own local update path and returns rows for its exact listed panes. */
  readonly remoteUpdate?: (host: { readonly name: string; readonly reach: string }, panes: readonly UpdatePane[], desired: string) => Promise<{
    readonly result: UpdateResultRow['result']; readonly detail: string; readonly panes: readonly UpdateResultRow[]; readonly requested?: number;
  }>;
  readonly progress?: (message: string) => void;
  /** Injectable interval for deterministic remote-wait simulations. */
  readonly every?: (callback: () => void, ms: number) => () => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly timeoutMs?: number;
  /** Remote child only: the SSH parent owns federation; this invocation may see this host alone. */
  readonly localOnly?: boolean;
}

const SHA = /^[a-f0-9]{40}$/i;
const SEAT = /^[A-Z][A-Z0-9_-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function safe(value: string): string { return value.replace(/[\x00-\x1f\x7f-\x9f|]/g, ' ').slice(0, 160); }

export function updateResultsTable(rows: readonly UpdateResultRow[]): string {
  return ['| Tab | Seat | Runtime | Result | Detail |', '|---|---|---|---|---|',
    ...rows.map(row => `| ${safe(row.tab)} | ${safe(row.seat)} | ${safe(row.runtime ?? 'unknown')} | ${row.result} | ${safe(row.detail)} |`)].join('\n');
}

/** Preview uses self-reported build metadata; missing information is never counted as zero. */
export function updatePreview(listing: { panes: readonly UpdatePane[]; hosts: readonly { name: string; reach: string }[] }, version: string, installed: string, desired: string): string {
  const counts = listing.hosts.map(host => {
    const panes = listing.panes.filter(p => p.host === host.name && p.state !== 'exited' && !['codex', 'claude', 'grok', 'shell'].includes(p.kind ?? ''));
    const age = (p: UpdatePane) => p.build?.desired?.toLowerCase() === desired.toLowerCase() ? p.build.age : 'unknown';
    const names = new Set(panes.filter(p => p.seat && age(p) === 'older').map(p => p.seat!));
    const unknown = host.reach === 'down' || panes.some(p => p.seat === undefined || (p.seat && age(p) !== 'older' && age(p) !== 'current'));
    return { label: host.reach === 'local' ? 'this Mac' : safe(host.name), count: names.size, unknown };
  });
  const n = counts.reduce((sum, host) => sum + host.count, 0);
  const unknown = counts.some(host => host.unknown);
  const installedText = installed.toLowerCase() === desired.toLowerCase()
    ? `This Mac already has ${safe(version)} (${safe(installed.slice(0, 8))}).`
    : `This Mac has ${safe(version)} (${safe(installed.slice(0, 8))}); it will be updated.`;
  return `${installedText} ${unknown ? 'At least ' : ''}${n} seats are still on an older build (${counts.map(host => `${host.label} ${host.count}${host.unknown ? '+' : ''}`).join(' · ')}).${unknown ? ' Some seat or build information is unavailable.' : ''} Each switches to the new build when its current turn ends. Continue? [y/N] `;
}

export function updateInstallProgress(status: string, requested: number | undefined): string {
  return `Install: ${status} · Migration requested for ${requested ?? 'an unknown number of'} seats · Progress every 30s`;
}

export function updateSummary(rows: readonly UpdateResultRow[]): string {
  const seats = new Map<string, UpdateResultRow>();
  for (const row of rows) if (row.seat && !row.tab.endsWith(':*') && !['codex', 'claude', 'grok', 'shell'].includes(row.runtime ?? '')) {
    const key = `${row.tab.split(':')[0]}:${row.seat}`;
    const prior = seats.get(key);
    const rank = { skipped: 0, updated: 1, waiting: 2, failed: 3 } as const;
    if (!prior || rank[row.result] > rank[prior.result]) seats.set(key, row);
  }
  const values = [...seats.entries()];
  const migrated = values.filter(([, row]) => row.result === 'updated').length;
  const waiting = values.filter(([, row]) => row.result === 'waiting');
  const failed = values.filter(([, row]) => row.result === 'failed');
  const failedHosts = rows.filter(row => row.tab.endsWith(':*') && row.result === 'failed').map(row => safe(row.tab));
  const others = rows.filter(row => ['codex', 'claude', 'grok', 'shell'].includes(row.runtime ?? '') && !row.tab.endsWith(':*')).length;
  const eln = rows.filter(row => !row.tab.endsWith(':*') && row.seat && !['codex', 'claude', 'grok', 'shell'].includes(row.runtime ?? ''));
  const tabCount = (result: UpdateResultRow['result']) => eln.filter(row => row.result === result).length;
  return `Done: migrated ${migrated} · waiting ${waiting.length}${waiting.length ? ` (${waiting.map(([name, row]) => `${safe(name)}: ${safe(row.detail)}`).join(', ')})` : ''} · unreachable ${failed.length}${failed.length ? ` (${failed.map(([name]) => safe(name)).join(', ')})` : ''}${failedHosts.length ? ` · unreachable hosts ${failedHosts.length} (${failedHosts.join(', ')})` : ''}\neln tabs: migrated ${tabCount('updated')} / waiting ${tabCount('waiting')} / unreachable ${tabCount('failed')} · other runtimes: ${others} (no migration needed)`;
}

/** A request returning "waiting" only means the running TUI accepted the turn-boundary wait. */
export async function updateAllElsTabs(deps: UpdateAllDeps): Promise<{ ok: boolean; rows: UpdateResultRow[]; reason?: string; requested?: number }> {
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
  const verifiedElnRows = new Set<number>();
  let requested = 0; let requestedKnown = true;
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
    const remoteDeadline = deps.now() + 31 * 60 * 1000;
    const remoteSeats = new Set(remotePanes.filter(pane => pane.seat && pane.state !== 'exited').map(pane => pane.seat));
    deps.progress?.(`Remote update requested: ${safe(host.name)} · ${remoteSeats.size} seats awaiting confirmation`);
    const stop = deps.progress ? (deps.every ?? ((callback, ms) => {
      const timer = setInterval(callback, ms); return () => clearInterval(timer);
    }))(() => deps.progress?.(`Remote ${safe(host.name)} · ${remoteSeats.size} seats awaiting confirmation · ${Math.ceil(Math.max(0, remoteDeadline - deps.now()) / 1000)}s remaining`), 30_000) : () => {};
    try {
      const outcome = await deps.remoteUpdate(host, remotePanes, desired);
      if (Number.isSafeInteger(outcome.requested) && outcome.requested! >= 0) requested += outcome.requested!;
      else requestedKnown = false;
      const expected = new Set(remotePanes.map(pane => pane.address));
      if (outcome.panes.length !== expected.size || outcome.panes.some(row => !expected.delete(row.tab)) || expected.size) throw new Error('remote result does not match listed panes');
      rows.push({ tab: `${host.name}:*`, seat: '', result: outcome.result, detail: outcome.detail }, ...outcome.panes);
    } catch (error) {
      requestedKnown = false;
      rows.push({ tab: `${host.name}:*`, seat: '', result: 'failed', detail: `remote update failed: ${error instanceof Error ? error.message : String(error)}` });
      for (const pane of remotePanes) rows.push({ tab: pane.address, seat: pane.seat ?? '', result: 'failed', detail: 'remote result unavailable' });
    } finally { stop(); }
  }
  // OP P1 #134152 (ELS-UPDATE-ALL-SECOND-RUN-OWNERPID): a second update-all run after a migration
  // finds the seat TUI relaunched as a child under the pane, so the pane covers the seat row when
  // the ownerPid is the pane pid or an ancestor-chain walk from ownerPid reaches the pane pid.
  // No process table means exact-pid matching only.
  const paneCoversOwner = (ownerPid: number, panePid: number): boolean => {
    if (ownerPid === panePid) return true;
    const tree = deps.processTree?.();
    if (!tree) return false;
    const seen = new Set<number>([ownerPid]);
    let parent = tree.get(ownerPid);
    while (parent !== undefined && parent > 1 && !seen.has(parent)) {
      if (parent === panePid) return true;
      seen.add(parent);
      parent = tree.get(parent);
    }
    return false;
  };
  for (const pane of listing.panes) {
    const seat = pane.seat ?? '';
    const index = rows.length;
    if (pane.reach !== 'local') continue;
    if (pane.state === 'exited') { rows.push({ tab: pane.address, seat, result: 'skipped', detail: 'exited' }); continue; }
    if (['codex', 'claude', 'grok', 'shell'].includes(pane.kind ?? '')) { rows.push({ tab: pane.address, seat, runtime: pane.kind, result: 'skipped', detail: `${pane.kind} tab, uses new install on next command` }); continue; }
    if (!seat) { rows.push({ tab: pane.address, seat, result: 'skipped', detail: 'not a seat tab' }); continue; }
    if (!SEAT.test(seat)) { rows.push({ tab: pane.address, seat, result: 'failed', detail: 'invalid seat identity' }); continue; }
    if (!Number.isSafeInteger(pane.pid) || pane.pid! <= 0) { rows.push({ tab: pane.address, seat, result: 'failed', detail: 'pane process identity unavailable' }); continue; }
    if (!authorizeSeatControl({ sender, target: seat, sameHost: true })) { rows.push({ tab: pane.address, seat, result: 'failed', detail: 'seat control denied' }); continue; }
    const matches = seats.filter(row => row.kind === 'tui' && row.alive && row.seat === seat && row.workdir === pane.cwd && paneCoversOwner(row.ownerPid, pane.pid!));
    if (matches.length !== 1) { rows.push({ tab: pane.address, seat, result: 'failed', detail: matches.length ? 'ambiguous seat' : 'live TUI missing' }); continue; }
    verifiedElnRows.add(index);
    const old = matches[0]!;
    if (!old.sessionId) { rows.push({ tab: pane.address, seat, result: 'failed', detail: 'session identity unavailable' }); continue; }
    const expected = { id: old.id, ownerPid: old.ownerPid, sessionId: old.sessionId, workdir: pane.cwd };
    const prior = seen.get(seat);
    if (prior && (prior.expected.id !== expected.id || prior.expected.ownerPid !== expected.ownerPid
      || prior.expected.sessionId !== expected.sessionId || prior.expected.workdir !== expected.workdir)) {
      rows.push({ tab: pane.address, seat, result: 'failed', detail: 'ambiguous seat target' }); continue;
    }
    deps.progress?.(`Migration requested: ${safe(pane.address)} · ${safe(seat)}`);
    let request = prior?.request;
    if (!request) {
      // OP P0 #133752 ② — desired 는 실행 중 고정: 새 이전 발행 시점에 desired/설치본이 바뀌어 있으면 낡은 빌드로 더 이상 이전하지 않는다.
      const current = deps.target();
      if (current.desired?.toLowerCase() !== desired.toLowerCase() || current.installed?.toLowerCase() !== installed.toLowerCase()) {
        rows.push({ tab: pane.address, seat, result: 'failed', detail: 'desired-build-changed' });
        continue;
      }
      requested++;
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
  let nextProgress = deps.now() + 30_000;
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
    const now = deps.now();
    if (pending.size && now >= nextProgress) {
      deps.progress?.(`Remaining seats: ${pending.size} · ${Math.ceil(Math.max(0, deadline - now) / 1000)}s remaining`);
      nextProgress = now + 30_000;
    }
  }
  for (const wait of pending.values()) for (const index of wait.rowIndexes)
    rows[index] = { ...rows[index]!, result: 'waiting', detail: 'deadline; turn or restart unverified' };
  for (let index = 0; index < rows.length; index++) {
    const pane = listing.panes.find(p => p.address === rows[index]!.tab);
    if (pane && !rows[index]!.runtime) rows[index] = { ...rows[index]!, runtime: verifiedElnRows.has(index) ? 'eln' : pane.kind === 'pty' ? 'unknown' : pane.kind };
  }
  const finalTarget = deps.target();
  const targetChanged = finalTarget.desired?.toLowerCase() !== desired.toLowerCase() || finalTarget.installed?.toLowerCase() !== installed.toLowerCase();
  if (targetChanged) {
    for (let index = 0; index < rows.length; index++) if (rows[index]!.result === 'updated')
      rows[index] = { ...rows[index]!, result: 'failed', detail: 'desired or installed build changed during migration' };
  }
  return { ok: !targetChanged && (rows.some(row => row.result === 'updated') || (!!deps.localOnly && rows.every(row => row.result === 'skipped')))
    && rows.every(row => row.result === 'updated' || row.result === 'skipped')
    && rows.every(row => !row.tab.endsWith(':*') || row.result === 'updated'), rows, ...(requestedKnown ? { requested } : {}),
    ...(targetChanged ? { reason: 'desired-build-changed' } : rows.length === 0 ? { reason: 'no-tabs' } : {}) };
}
