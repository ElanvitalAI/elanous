// AUTOPILOT-TASK-GOAL-PIN · agents (owner 11-25 07:1x) — «서브 에이전트 활동이 안 끝난 것 같은데 «🤖 … · ok · 59s» 로 나오고
// 사라진다 — 하단에 피닝이 되어서 계속 보여줘야».
//
// S: a background agent's finish was one transcript line; the footer dropped it at once, before the seat had even read
//    the result.
// C: under each task-goal pin, its agents stay visible: running (elapsed) → done-but-not-yet-read → collapsed into the
//    pin's «🤖 k/n read» count once a turn has carried the capsule-done result. Agents without a pin sit under one
//    «🤖 background n» line. Sub-lines never count as pins; at most 3 per pin, then «+n more».
// A: this session-local projection (agent capsules only). Tie rule (structural, no text matching): an agent belongs to
//    the newest task pin set at or before the agent started; none → background. «Read» = the queue closed that
//    capsule's result (delivered into a turn — queue.capsuleConsumed).
//
// 세 얼굴:
//   관측 = the rows on screen + the capsule frames already logged (turn-life:capsule-done-knock)
//   인지 = accept() folds progress/done · consumed() asks the queue
//   수복과 인계 = a read result collapses by itself · a pin that closes hands its unread agents to the background line

import type { CapsuleEvent } from '../../turn-capsule/contract.js';
import { correctionsMarker } from './background-job-status.js';

export interface PinRef { id: string; at: number }
interface AgentRow { capsuleId: string; name: string; startedAt: number; /** undefined = not tied yet (decided at compose) */ pinId?: string | null; done?: { seconds: number; status: string } }

export const AGENT_SUBLINES_MAX = 3;
const ROWS_KEEP = 200;
const BACKGROUND = '__background__';
const INDENT = '   ';
const clean = (s: string): string => s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const elapsed = (ms: number): string => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };

export class PinnedAgents {
  private rows = new Map<string, AgentRow>();
  private sessionId: string | null;
  constructor(sessionId: string | null) { this.sessionId = sessionId; }
  setSessionId(sessionId: string): void { if (sessionId !== this.sessionId) { this.sessionId = sessionId; this.rows.clear(); } }

  /** Fold one capsule frame (agents only). Returns true when rows changed. */
  accept(event: CapsuleEvent): boolean {
    if (event.kind !== 'agent' || event.sessionId !== this.sessionId) return false;
    const prev = this.rows.get(event.capsuleId);
    if (event.type === 'capsule-progress') {
      if (prev) return false;
      const line = clean(event.line);
      this.add({ capsuleId: event.capsuleId, name: line.replace(/ · started$/u, '').split(' · ')[0] || 'agent', startedAt: event.at });
      return true;
    }
    if (prev?.done) return false;
    const summary = clean(event.summary);
    const name = prev?.name ?? (summary.replace(new RegExp(` · ${event.status}(?: · \\d+s)?$`, 'u'), '') || 'agent');
    this.add({ capsuleId: event.capsuleId, name, startedAt: prev?.startedAt ?? event.startedAt, ...(prev?.pinId !== undefined ? { pinId: prev.pinId } : {}),
      done: { seconds: Math.max(0, Math.round((event.endedAt - event.startedAt) / 1000)), status: event.status } });
    return true;
  }

  private add(row: AgentRow): void {
    this.rows.set(row.capsuleId, row);
    if (this.rows.size > ROWS_KEEP) this.rows.delete(this.rows.keys().next().value!);
  }

  /**
   * The pin block: each pin row (with «🤖 k/n read» once any of its agents was read), its visible agent sub-lines
   * (running · done-not-yet-read · at most 3 then «+n more»), then one «🤖 background n» line for unpinned agents.
   */
  compose(pins: readonly { id?: string; at?: number; row: string }[], now: number, consumed: (capsuleId: string) => boolean,
    /** AGENT-STEER — corrections sent to this agent («✉ n corrections» at the end of its line). */
    corrections: (capsuleId: string) => number | undefined = () => undefined): string[] {
    const refs: PinRef[] = pins.filter((p): p is { id: string; at: number; row: string } => !!p.id && p.at !== undefined).map((p) => ({ id: p.id, at: p.at }));
    const open = new Set(refs.map((p) => p.id));
    const groups = new Map<string, AgentRow[]>();
    for (const r of this.rows.values()) {
      // Tied once, to the newest pin set at or before the agent started (a pin set later never adopts it).
      if (r.pinId === undefined) { const t = tie(refs, r.startedAt); if (t) r.pinId = t; }
      const key = r.pinId && open.has(r.pinId) ? r.pinId : BACKGROUND;
      // A read agent whose pin closed has nothing left to show.
      if (key === BACKGROUND && r.done && consumed(r.capsuleId)) continue;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const sub = (rows: readonly AgentRow[]): string[] => {
      const visible = rows.filter((r) => !r.done || !consumed(r.capsuleId))
        .map((r) => `${INDENT}🤖 ${r.name} · ${r.done ? `${r.done.status === 'ok' ? 'done' : r.done.status} ${elapsed(r.done.seconds * 1000)} · result not read yet` : `running ${elapsed(now - r.startedAt)}`}${correctionsMarker(corrections(r.capsuleId))}`);
      return visible.length > AGENT_SUBLINES_MAX
        ? [...visible.slice(0, AGENT_SUBLINES_MAX), `${INDENT}+${visible.length - AGENT_SUBLINES_MAX} more`] : visible;
    };
    const out: string[] = [];
    for (const p of pins) {
      const rows = p.id ? groups.get(p.id) ?? [] : [];
      const read = rows.filter((r) => r.done && consumed(r.capsuleId)).length;
      out.push(read > 0 ? `${p.row} · 🤖 ${read}/${rows.length} read` : p.row, ...sub(rows));
    }
    const background = sub(groups.get(BACKGROUND) ?? []);
    const shown = (groups.get(BACKGROUND) ?? []).filter((r) => !r.done || !consumed(r.capsuleId)).length;
    if (shown > 0) out.push(`🤖 background ${shown}`, ...background);
    return out;
  }

  /** True when any agent row is visible (the footer's own «🤖 N running» row is then redundant). */
  hasVisible(consumed: (capsuleId: string) => boolean): boolean {
    for (const r of this.rows.values()) if (!r.done || !consumed(r.capsuleId)) return true;
    return false;
  }
}

/** The newest pin set at or before `at` (null = background). */
function tie(pins: readonly PinRef[], at: number): string | null {
  let best: PinRef | null = null;
  for (const p of pins) if (p.at <= at && (!best || p.at >= best.at)) best = p;
  return best?.id ?? null;
}
