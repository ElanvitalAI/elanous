// ── DORMANT-ADDRESS REROUTE (SIGNAL-DIET · census SUPERVISORS-AND-MESSAGING-1127 처방 ②) ─────────────────────────────
//
// S: mail to addresses with no live tab or session sits forever — RES ≥ 100 unread · REL 19 · REVIEW-2 13 · JUD-2 2 ·
//    ORCHESTRATOR ≥ 100. Nobody reads it; the sender believes it was delivered.
// C: only the sender entrances (CLI `msg post` · MsgPost tool) — programmatic producers and release proofs (JUD/OP
//    `coord` rows to REL that the release waiver verifies) are untouched · nothing is dropped · 🚨 never waits.
// A: before the gate, a post to a dormant address is rerouted: REVIEW-2 / JUD-2 → JUD (a live judge reads it);
//    RES · RES-INFRA → GUARDIAN (대표 11-27: resource mail goes to the guardian's postoffice — its mail inbox / voice answers);
//    REL · ORCHESTRATOR → OP, folded into the 30-min machine digest's «잠든 수신처» section (🚨 → OP inbox at once). The row
//    carries `rerouted-from:<address>`; the sender gets one line «rerouted to X». Both sender entrances pass the live probe
//    ({@link liveByWake}: a pane/session/tab the wake resolver reaches) — a revived tab gets its mail directly again.
//
// 세 얼굴: 관측 = the `rerouted-from:*` ref on the row ⊕ debug.log('msg.dormant-reroute') at the caller · 판단 근거 =
// {@link dormantRoutes} (census: no tab · hand-routes.yaml) minus seats a probe reports live ⊕ `ELANOUS_DORMANT_SEATS` · 수복과 인계 =
// a revived tab is reported live by the probe and receives its mail directly again.
import { readHandRoutes } from '../kit/mail-route/hand-routes.js';
import { opDigestUrgent, REROUTED_FROM_REF } from './op-machine-digest.js';

export { REROUTED_FROM_REF, reroutedFrom } from './op-machine-digest.js';
/** Target `OP` = the OP machine digest (urgent → OP inbox). Source: census 11-27 «탭 없음» rows — now DATA in
 *  kit/mail-route/hand-routes.yaml `dormant.routes` (DORMANT-SEAT-ROUTE); read per call so an override applies at once. */
export function dormantRoutes(): Readonly<Record<string, string>> { return readHandRoutes().dormant.routes; }

/** When the first target IS the sender (live bug #191271: OP's mail to dormant RES came back to OP), the next reader in
 *  line — hand-routes.yaml `dormant.alternates`. */
export function rerouteAlternates(): Readonly<Record<string, readonly string[]>> { return readHandRoutes().dormant.alternates; }

/** Wake routes that mean «a live reader is there» (a pane/session/tab the resolver reached) — `cron`/`none` are not. */
const LIVE_WAKES: ReadonlySet<string> = new Set(['pty-inject', 'herdr', 'els', 'tmux', 'sse']);
/** The live probe both sender entrances pass: the msg wake resolver (seat registry · els/herdr panes · pty names). Fail-closed
 *  to «not live» only when the resolver cannot answer — the census table then decides, as before. */
export function liveByWake(wakeDeps?: unknown): (address: string) => boolean {
  return (address: string) => {
    try {
      const { resolveWake } = require('../loops/msg-wake.js') as typeof import('../loops/msg-wake.js');
      const r = resolveWake(address, (wakeDeps ?? {}) as Parameters<typeof resolveWake>[1]);
      return LIVE_WAKES.has(r.wake) && !String((r as { reason?: string }).reason ?? '').startsWith('dead-');
    } catch { return false; }
  };
}

export interface RerouteInput {
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly kind?: string;
  readonly intent?: string;
  readonly priority?: number;
  readonly crownDirective?: string;
  readonly goal?: string;
  readonly refs?: string[];
}

export interface Reroute { readonly to: string; readonly refs: string[]; readonly body: string; readonly note: string; readonly digest: boolean }

/** Extra dormant addresses from the environment (`ELANOUS_DORMANT_SEATS=A,B` → routed to the OP digest). */
function envDormant(): string[] {
  return (process.env.ELANOUS_DORMANT_SEATS ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

/**
 * Pure: the reroute for a post, or null when it goes to its address. `isLive(address)` — true when a live pane/session
 * reads that address (then it is never rerouted); absent = the census table decides.
 */
export function dormantReroute(m: RerouteInput, opts: { isLive?: (address: string) => boolean } = {}): Reroute | null {
  const to = m.to.trim().toUpperCase();
  const from = m.from.trim().toUpperCase();
  const first = dormantRoutes()[to] ?? (envDormant().includes(to) ? 'OP' : undefined);
  if (!first || first === to || from === to) return null;
  // never back to the sender: GUARDIAN-sent mail for RES goes to the OP digest; OP-sent mail for a box whose only other
  // reader is OP stays where it was addressed (null) instead of bouncing to OP's own inbox
  const target = [first, ...(rerouteAlternates()[first] ?? [])].find((t) => t !== from && t !== to);
  if (!target) return null;
  if (to === 'REL' && (m.kind ?? '').toLowerCase() === 'coord') return null; // release proofs (JUD attest · OP approve) live in REL's mailbox
  if (opts.isLive?.(to) === true) return null;
  const digest = target === 'OP' && !opDigestUrgent({ ...m, to: 'OP' });
  return {
    to: target,
    refs: [...(m.refs ?? []).filter((r) => !r.startsWith(REROUTED_FROM_REF)), `${REROUTED_FROM_REF}${to}`],
    body: `[rerouted from ${to} · no live tab] ${m.body}`,
    digest,
    note: digest ? `${to} has no live tab — rerouted to OP (30-min digest «잠든 수신처»)` : `${to} has no live tab — rerouted to ${target}`,
  };
}
