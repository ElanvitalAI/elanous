// SEAT-STATE-ENUM — one pane's seat status as codes ({state, reason?, since}) and the `els ls --state/--ws` filter.
// The status comes from what the pane's eln reported (a code on the event wire) or from the server's own facts (pane exited,
// output clock, stall window). Nothing here reads a screen: a changed sentence on screen never changes a state.
// 출처: seat-state/OP/orders/SEAT-STATE-ENUM-1123.md (SeatState · BlockReason 표 · pull 절).
import { isSeatState, isBlockReason, seatStateNeedsReason, SEAT_STATES, type BlockReason, type SeatState } from '../agent-events/protocol.js';

/** What an eln pane reported last (the code event), kept per pane by the server. */
export interface ReportedSeat { readonly state: SeatState; readonly reason?: BlockReason; readonly detail?: string; readonly at: number }

export interface PaneSeatStatus {
  readonly state: SeatState;
  /** Present exactly when `state` needs one (BLOCKED, WAITING_APPROVAL, WAITING_REPLY). */
  readonly reason?: BlockReason;
  readonly detail?: string;
  /** Epoch ms the pane entered this state (with this reason). */
  readonly since: number;
  /** `reported` = the pane's eln said so; `derived` = the server's own facts (exit, output clock, stall window). */
  readonly source: 'reported' | 'derived';
}

export interface SeatStatusInput {
  readonly exited: boolean;
  /** The listing's activity state (working · idle · blocked · exited · done · unknown). */
  readonly activityState: string;
  /** The server's stall verdict for a working pane (ELS-TAB-STATE-BADGE). */
  readonly stalled: boolean;
  /** The pane's own code report, when its eln sent one for the current turn state. */
  readonly reported?: ReportedSeat;
  /** The pane's eln reported the v1 word `waiting-input` without a code. */
  readonly legacyWaitingInput?: boolean;
  /** Folder of the pane not reachable (the server marks it blocked). */
  readonly unavailable?: boolean;
}

/** The state (and reason) without `since` — the caller keeps the clock per pane. */
export function seatStatusOf(input: SeatStatusInput): Omit<PaneSeatStatus, 'since'> & { readonly at?: number } {
  if (input.exited) return { state: 'EXITED', source: 'derived' };
  const r = input.reported;
  if (r) {
    // The server judges a stall: a pane that says WORKING but went quiet past the window is STALLED.
    if (r.state === 'WORKING' && input.stalled) return { state: 'STALLED', source: 'derived' };
    return { state: r.state, ...(r.reason ? { reason: r.reason } : {}), ...(r.detail ? { detail: r.detail } : {}), source: 'reported', at: r.at };
  }
  if (input.legacyWaitingInput) return { state: 'WAITING_APPROVAL', reason: 'APPROVAL_PENDING', source: 'derived' };
  if (input.unavailable) return { state: 'BLOCKED', reason: 'DEPENDENCY_WAIT', detail: 'cwd-unavailable', source: 'derived' };
  if (input.activityState === 'working') return { state: input.stalled ? 'STALLED' : 'WORKING', source: 'derived' };
  if (input.activityState === 'exited') return { state: 'EXITED', source: 'derived' };
  // A v1 `blocked` with no code names no reason; the person-needed reading is the honest one.
  if (input.activityState === 'blocked') return { state: 'BLOCKED', reason: 'HUMAN_DECISION', source: 'derived' };
  return { state: 'IDLE', source: 'derived' };
}

/** Keeps `since` per pane: the clock restarts only when the state or the reason changes. */
export function createSeatStatusClock(now: () => number) {
  const seen = new Map<string, { key: string; since: number }>();
  return {
    stamp(pane: string, status: Omit<PaneSeatStatus, 'since'> & { readonly at?: number }): PaneSeatStatus {
      const key = `${status.state}/${status.reason ?? ''}`;
      const prior = seen.get(pane);
      const since = prior && prior.key === key ? prior.since : status.at ?? now();
      if (!prior || prior.key !== key) seen.set(pane, { key, since });
      return { state: status.state, ...(status.reason ? { reason: status.reason } : {}), ...(status.detail ? { detail: status.detail } : {}), since, source: status.source };
    },
    forget(pane: string): void { seen.delete(pane); },
  };
}

/** A `status` value from another host's listing, validated (codes only; anything else is dropped). */
export function parsePaneSeatStatus(value: unknown): PaneSeatStatus | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!isSeatState(raw.state) || typeof raw.since !== 'number' || !Number.isFinite(raw.since)) return undefined;
  const needs = seatStateNeedsReason(raw.state);
  if (needs && !isBlockReason(raw.reason)) return undefined;
  return { state: raw.state, ...(needs && isBlockReason(raw.reason) ? { reason: raw.reason } : {}),
    ...(typeof raw.detail === 'string' ? { detail: raw.detail.slice(0, 200) } : {}), since: raw.since,
    source: raw.source === 'reported' ? 'reported' : 'derived' };
}

/** `--state BLOCKED,WAITING_APPROVAL` → the codes; an unknown word is an error that names the valid codes. */
export function parseStateFilter(text: string): { ok: true; states: SeatState[] } | { ok: false; message: string } {
  const words = text.split(',').map((word) => word.trim().toUpperCase()).filter(Boolean);
  const bad = words.filter((word) => !isSeatState(word));
  if (words.length === 0 || bad.length > 0) return { ok: false, message: `els ls --state: unknown state ${bad.join(',') || '(empty)'}; one of ${SEAT_STATES.join(', ')}` };
  return { ok: true, states: words as SeatState[] };
}

interface ListedPane { readonly workspace?: unknown; readonly ws?: unknown; readonly status?: unknown }
interface ListedWorkspace { readonly id?: unknown; readonly name?: unknown; readonly coordinatorSeat?: unknown }

/**
 * Which spaces a viewer sees in a state query (#39757 coordinator hierarchy): OP, the HQ coordinator seat and a seatless
 * caller see every space; a seat that coordinates spaces sees those spaces; any other seat sees every space (reading is free).
 * Returns undefined for «all», else the space names.
 */
export function viewerSpaces(viewer: string | null | undefined, listed: { readonly hqCoordinatorSeat?: unknown; readonly workspaces?: readonly ListedWorkspace[] }): string[] | undefined {
  if (!viewer || viewer === 'unknown' || viewer === 'OP' || viewer === listed.hqCoordinatorSeat) return undefined;
  const own = (listed.workspaces ?? []).filter((ws) => ws.coordinatorSeat === viewer && typeof ws.name === 'string').map((ws) => ws.name as string);
  return own.length > 0 ? own : undefined;
}

/** Keep panes whose status is one of `states` (when given) and whose space is `ws` (when given) and inside `scope`. */
export function filterPanesBySeatState<P extends ListedPane>(panes: readonly P[], opts: { states?: readonly SeatState[]; ws?: string; scope?: readonly string[] }): P[] {
  return panes.filter((pane) => {
    const space = typeof pane.workspace === 'string' ? pane.workspace : typeof pane.ws === 'string' ? pane.ws : '';
    if (opts.ws !== undefined && space !== opts.ws) return false;
    if (opts.scope && !opts.scope.includes(space)) return false;
    if (!opts.states) return true;
    const status = parsePaneSeatStatus(pane.status);
    return status !== undefined && opts.states.includes(status.state);
  });
}

interface BoardPane extends ListedPane { readonly address?: unknown; readonly seat?: unknown; readonly title?: unknown; readonly model?: unknown }

/** `els status-board` rows: seat · state · reason · since (age) · model · address. Codes only; a pane without a status reads «?». */
export function statusBoardLines(panes: readonly BoardPane[], nowMs: number): string[] {
  const age = (since: number): string => { const s = Math.max(0, Math.floor((nowMs - since) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; };
  const rows = panes.map((pane) => {
    const status = parsePaneSeatStatus(pane.status);
    const who = typeof pane.seat === 'string' && pane.seat ? pane.seat : typeof pane.title === 'string' ? pane.title : '?';
    return [who, status?.state ?? '?', status?.reason ?? '-', status ? age(status.since) : '-', typeof pane.model === 'string' && pane.model ? pane.model : '-', typeof pane.address === 'string' ? pane.address : ''];
  });
  const head = ['SEAT', 'STATE', 'REASON', 'SINCE', 'MODEL', 'ADDRESS'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: readonly string[]): string => cells.map((c, i) => i === cells.length - 1 ? c : c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(head), ...rows.map(line)];
}
