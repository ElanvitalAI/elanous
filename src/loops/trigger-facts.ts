/**
 * Facts for compound condition triggers (Cell: SCHEDULER-TO-GRAPH-RUNNER · CEO 11-25 23:5x «time AND/OR events»).
 *
 * A fact is a named, structured value read from state the system already writes — never parsed from prose:
 *   release.*        — the active release graph run (`{stateRoot}/release-graph/<v>/state.json` + `<v>-rehearsal`)
 *   res.lease.<h>.live · res.host.<h>.ready — the RES graph state (`{seatState}/RES/graph-state`)
 * Time expressions («release.cutAt - 2h») resolve against these facts, so a trigger follows the release schedule
 * instead of a hard-coded wall clock. Pure reads; a missing source = the fact is undefined (never guessed).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Facts = Record<string, string | number | boolean | null | undefined>;

function readJson(path: string): unknown { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } }

interface RunState {
  version?: string; kind?: string; done?: boolean;
  clock?: { rehearsalAt?: string; cutAt?: string; publishAt?: string };
  hardStop?: { at?: string; reason?: string } | null;
  steps?: Record<string, { status?: string; actualAt?: string; startedAt?: string }>;
}

/** Keep a release «active» this long after publishAt (late publish + restore window). */
export const ACTIVE_TAIL_MIN = 6 * 60;

/** The release the facts describe: the earliest non-rehearsal run whose publishAt + tail is still ahead. */
export function activeRelease(stateRoot: string, now: Date, graphVersion?: string | null): { version: string; state: RunState } | null {
  const dir = join(stateRoot, 'release-graph');
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir).filter(v => /^\d+\.\d+\.\d+$/.test(v))
    .map(v => ({ version: v, state: readJson(join(dir, v, 'state.json')) as RunState | undefined }))
    .filter((r): r is { version: string; state: RunState } => !!r.state?.clock?.cutAt && !!r.state.clock.publishAt && r.state.kind !== 'rehearsal')
    .filter(r => Date.parse(r.state.clock!.publishAt!) + ACTIVE_TAIL_MIN * 60_000 > now.getTime())
    .sort((a, b) => Date.parse(a.state.clock!.cutAt!) - Date.parse(b.state.clock!.cutAt!));
  // kit/release-target (DUPLICATION-MAP §1-11 · the 0.3.37-vs-0.3.38 night): the release in play is release.graph.version
  // (ops-dashboard/current-version.ts — the canonical resolver) when that run is here and active; «earliest run» is only the
  // fallback when the graph target is unset or has no active run.
  const target = graphVersion === undefined ? readGraphTarget() : graphVersion;
  return (target ? runs.find(r => r.version === target) : undefined) ?? runs[0] ?? null;
}
const readGraphTarget = (): string | null => {
  try { return (require('../ops-dashboard/current-version.js') as typeof import('../ops-dashboard/current-version.js')).readReleaseGraphVersion() ?? null; } catch { return null; }
};

function rehearsalState(dir: string, version: string, scheduledAt?: string): string {
  const st = readJson(join(dir, `${version}-rehearsal`, 'state.json')) as RunState | undefined;
  if (!st) return scheduledAt ? 'scheduled' : 'none';
  if (st.hardStop) return 'failed';
  if (st.done) return 'passed';
  return Object.values(st.steps ?? {}).some(s => s.status && s.status !== 'pending') ? 'started' : 'scheduled';
}

export function releaseFacts(stateRoot: string, now: Date): Facts {
  const run = activeRelease(stateRoot, now);
  if (!run) return { 'release.version': null, 'release.graph.state': 'idle' };
  const { state, version } = run;
  const publish = state.steps?.publish;
  const published = publish?.status === 'done' || !!publish?.actualAt;
  const rehearsal = rehearsalState(join(stateRoot, 'release-graph'), version, state.clock?.rehearsalAt);
  const cutStarted = Object.entries(state.steps ?? {}).some(([, s]) => s.status && s.status !== 'pending');
  const graphState = published ? 'published' : state.hardStop ? 'aborted' : cutStarted ? 'cut' : `rehearsal-${rehearsal}`;
  return {
    'release.version': version,
    'release.rehearsalAt': state.clock?.rehearsalAt ?? null,
    'release.cutAt': state.clock?.cutAt ?? null,
    'release.publishAt': state.clock?.publishAt ?? null,
    'release.published': published,
    'release.publishedAt': publish?.actualAt ?? (published ? publish?.startedAt ?? null : null),
    'release.aborted': !!state.hardStop,
    'release.abortedAt': state.hardStop?.at ?? null,
    'release.rehearsal': rehearsal,
    'release.graph.state': graphState,
    'release.updateAll': state.steps?.['update-all']?.status ?? 'pending',
  };
}

export function resFacts(resRoot: string, now: Date): Facts {
  const out: Facts = {};
  const leases = (readJson(join(resRoot, 'leases.json')) as Array<{ host: string; state: string; endsAt?: string }> | undefined) ?? [];
  for (const l of leases) {
    const live = (l.state === 'active' || l.state === 'requested') && (!l.endsAt || Date.parse(l.endsAt) > now.getTime());
    if (live || out[`res.lease.${l.host}.live`] === undefined) out[`res.lease.${l.host}.live`] = live || out[`res.lease.${l.host}.live`] === true;
  }
  const ready = (readJson(join(resRoot, 'ready.json')) as Record<string, { state: string }> | undefined) ?? {};
  for (const [h, r] of Object.entries(ready)) out[`res.host.${h}.ready`] = r.state === 'ready';
  return out;
}

export function liveFacts(stateRoot: string, seatState: string, now: Date): Facts {
  return { ...releaseFacts(stateRoot, now), ...resFacts(join(seatState, 'RES', 'graph-state'), now) };
}

/**
 * «release.cutAt - 2h» · «release.publishAt + 30m» · an ISO time. Returns ms, or null when the fact is missing.
 * Throws on a malformed expression (refused at register time).
 */
export function parseTimeExpr(expr: string): { fact: string | null; iso: string | null; offsetMs: number } {
  const t = expr.trim();
  if (!Number.isNaN(Date.parse(t)) && /^\d{4}-/.test(t)) return { fact: null, iso: t, offsetMs: 0 };
  const m = /^([a-zA-Z][\w.-]*)\s*(?:([+-])\s*(\d+)\s*(m|h|min)?)?$/.exec(t);
  if (!m) throw new Error(`time expression «${expr}» must be <fact> [+|- N(m|h)] or an ISO time`);
  const n = m[3] ? Number(m[3]) * (m[4] === 'h' ? 3_600_000 : 60_000) : 0;
  return { fact: m[1]!, iso: null, offsetMs: m[2] === '-' ? -n : n };
}

export function resolveTime(expr: string, facts: Facts): number | null {
  const p = parseTimeExpr(expr);
  if (p.iso) return Date.parse(p.iso);
  const v = facts[p.fact!];
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) return null;
  return Date.parse(v) + p.offsetMs;
}
