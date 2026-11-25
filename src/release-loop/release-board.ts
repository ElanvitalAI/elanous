/**
 * Release Board collection — reads ONLY the release graph state/ledger (the `release graph status --json` source) and the
 * release-traffic state, and turns them into the pure scene's snapshot. Missing / partial / corrupt state → `{ ok:false }`
 * (the board shows «no data»), never a throw. Preview = the real `enterQuickSurgery` on a throw-away copy of the state.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TickerEvent } from '../tui/widgets/ticker.js';
import type { BoardStatus, BoardStep, BoardTraffic, ReleaseBoardSnapshot } from '../tui/widgets/scenes/release-board.js';
import { criticalPath, earliestStart, enterQuickSurgery, runDir, stepsFor, type LedgerRow, type Mode, type PlanOptions, type RunState, type StepDef } from './release-graph-exec.js';

export const GOLDEN_HOSTS = ['mshq', 'minim5', 'node-b', 'publish'] as const;
export const RELEASE_HOST = 'node-b';

/** Run instances of a version: the publish run and every rehearsal attempt (`<v>-rehearsal`, `<v>-rehearsal#n`, `<v>-rehearsal-n`), newest last. */
export function listInstances(stateRoot: string, version: string): string[] {
  const dir = join(stateRoot, 'release-graph');
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const esc = version.replace(/\./g, '\\.');
  const re = new RegExp(`^${esc}(-rehearsal([#-]?\\d+)?)?$`);
  const created = (n: string): number => {
    try { const s = JSON.parse(readFileSync(join(dir, n, 'state.json'), 'utf8')) as { createdAt?: string }; return Date.parse(s.createdAt ?? '') || 0; } catch { return 0; }
  };
  return names.filter(n => re.test(n) && existsSync(join(dir, n, 'state.json'))).map(n => ({ n, t: created(n) })).sort((a, b) => a.t - b.t || a.n.localeCompare(b.n)).map(x => x.n);
}

/** Newest version with a run (publish runs first, then rehearsal-only). */
export function latestVersion(stateRoot: string): string | null {
  let names: string[] = [];
  try { names = readdirSync(join(stateRoot, 'release-graph')); } catch { return null; }
  const vs = [...new Set(names.map(n => /^(\d+\.\d+\.\d+)/.exec(n)?.[1]).filter((v): v is string => !!v))];
  vs.sort((a, b) => { const pa = a.split('.').map(Number); const pb = b.split('.').map(Number); return pa[0]! - pb[0]! || pa[1]! - pb[1]! || pa[2]! - pb[2]!; });
  return vs.at(-1) ?? null;
}

export type ReadRun = { ok: true; state: RunState; ledger: LedgerRow[] } | { ok: false; reason: string };

/** Load one instance; anything unusable is a reason string, not a throw. */
export function readRun(stateRoot: string, key: string): ReadRun {
  const dir = runDir(stateRoot, key);
  const p = join(dir, 'state.json');
  if (!existsSync(p)) return { ok: false, reason: `no state for ${key} (${p})` };
  let state: RunState;
  try { state = JSON.parse(readFileSync(p, 'utf8')) as RunState; } catch (e) { return { ok: false, reason: `state for ${key} is unreadable: ${e instanceof Error ? e.message : String(e)}` }; }
  if (!state || typeof state !== 'object' || typeof state.version !== 'string' || !state.clock || typeof state.clock.publishAt !== 'string' || !state.steps || typeof state.steps !== 'object') {
    return { ok: false, reason: `state for ${key} is partial (version/clock/steps missing)` };
  }
  const ledger: LedgerRow[] = [];
  try {
    for (const line of readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n')) {
      if (!line) continue;
      try { ledger.push(JSON.parse(line) as LedgerRow); } catch { /* a torn last line is skipped */ }
    }
  } catch { /* no ledger yet */ }
  return { ok: true, state, ledger };
}

function boardStatus(state: RunState, step: StepDef): BoardStatus {
  const st = state.steps[step.id] ?? { status: 'pending' as const };
  if (state.hardStop?.step === step.id && st.status !== 'done' && st.status !== 'skipped') return 'stop';
  switch (st.status) {
    case 'running': case 'would-run': return 'running';
    case 'failed': return 'stop';
    case 'skipped': return 'skipped';
    case 'done': return st.by === 'graph(soft-fail)' ? 'soft-fail' : st.warnings?.length ? 'warn' : 'done';
    default: return 'pending';
  }
}

const EVENT_TEXT: Record<string, (r: LedgerRow) => string> = {
  marked: r => `mark ${r.step} by ${String(r.by)}`,
  skipped: r => `skip ${r.step} by ${String(r.by)}: ${String(r.reason)}`,
  resumed: r => `resume from ${String(r.target)} by ${String(r.by)}`,
  'auto-quick-surgery': () => 'auto-switch → quick-surgery (T−60m)',
  'quick-surgery': r => `quick-surgery by ${String(r.by)}`,
  'hard-stop': r => `hard stop ${r.step}: ${String(r.reason)}`,
  'stop-cleared': r => `stop cleared ${r.step}`,
  'step-warn': r => `${r.step} exit ${String(r.exit)} waived`,
  nogo: r => `NO-GO by ${String(r.by)}`,
  finished: () => 'graph finished',
  created: r => `run created (${String(r.profile ?? 'quick-surgery')})`,
};

export function ledgerEvents(ledger: readonly LedgerRow[], limit = 6): TickerEvent[] {
  const out: TickerEvent[] = [];
  for (let i = ledger.length - 1; i >= 0 && out.length < limit; i--) {
    const r = ledger[i]!;
    const text = EVENT_TEXT[r.kind]?.(r) ?? (r.kind === 'step-done' && r.step === 'publish' ? 'published' : null);
    if (!text) continue;
    const at = new Date(Date.parse(r.at) + 9 * 3600_000).toISOString().slice(11, 16);
    out.push({ at, text });
  }
  return out;
}

export function readTraffic(roots: readonly string[], version: string): BoardTraffic | null {
  for (const root of roots) {
    try {
      const t = JSON.parse(readFileSync(join(root, 'release-traffic', `${version}.json`), 'utf8')) as { phase?: string; applied?: Record<string, number> };
      if (typeof t.phase === 'string') return { phase: t.phase, releaseHost: RELEASE_HOST, slots: t.applied ?? {} };
    } catch { /* next root */ }
  }
  return null;
}

export interface CollectInput {
  stateRoot: string;
  run: string;
  instances: string[];
  following: boolean;
  mode: Mode;
  universe: ReleaseBoardSnapshot['universe'];
  now: Date;
  tick: number;
  trafficRoots: string[];
  planOptions?: PlanOptions;
  /** ledger length at the previous snapshot — a longer ledger with a new ticker event = fresh. */
  prevEventKey?: string;
}

export type Collected = { ok: true; snapshot: ReleaseBoardSnapshot; eventKey: string } | { ok: false; reason: string };

export function snapshotFrom(state: RunState, ledger: readonly LedgerRow[], input: Omit<CollectInput, 'stateRoot'> & { stateRoot: string }): Collected {
  let steps: StepDef[];
  let critical: { path: string[]; minutes: number };
  try { steps = stepsFor(state, input.planOptions); critical = criticalPath(steps); } catch (e) { return { ok: false, reason: `graph plan failed: ${e instanceof Error ? e.message : String(e)}` }; }
  const crit = new Set(critical.path);
  const dir = runDir(input.stateRoot, input.run);
  const board: BoardStep[] = steps.map(s => {
    const st = state.steps[s.id] ?? { status: 'pending' as const };
    const early = earliestStart(s, state.clock);
    return {
      id: s.id, phase: s.phase, label: s.label, status: boardStatus(state, s), critical: crit.has(s.id), host: s.host, hard: s.hard,
      ...(st.startedAt ?? st.wouldRunAt ? { startedAt: st.startedAt ?? st.wouldRunAt } : {}),
      ...(st.endedAt ? { endedAt: st.endedAt } : {}),
      ...(early !== null && !Number.isNaN(early) ? { earliestAt: new Date(early).toISOString() } : {}),
      cmd: s.cmd, logPath: join(dir, 'logs', `${s.id}.log`),
      ...(st.ref ? { ref: st.ref } : {}), ...(st.by ? { by: st.by } : {}), ...(st.exit !== undefined ? { exit: st.exit } : {}),
      warnings: st.warnings ?? [],
    };
  });
  const hosts = GOLDEN_HOSTS.map(h => ({ name: h, busy: board.find(b => b.host === h && b.status === 'running')?.id ?? null }));
  const events = ledgerEvents(ledger);
  const eventKey = events[0] ? `${events[0].at} ${events[0].text}` : '';
  return {
    ok: true, eventKey,
    snapshot: {
      version: state.version, profile: state.profile ?? 'quick-surgery', mode: input.mode, universe: input.universe, now: input.now.toISOString(),
      cutAt: state.clock.cutAt, publishAt: state.clock.publishAt, hardStop: state.hardStop ?? null, done: !!state.done, steps: board,
      criticalMinutes: critical.minutes, events, freshEvent: !!eventKey && eventKey !== (input.prevEventKey ?? eventKey),
      hosts, traffic: readTraffic(input.trafficRoots, state.version), tick: input.tick, run: input.run, instances: input.instances, following: input.following,
    },
  };
}

export function collectReleaseBoard(input: CollectInput): Collected {
  const r = readRun(input.stateRoot, input.run);
  if (!r.ok) return r;
  return snapshotFrom(r.state, r.ledger, input);
}

/** `p` preview: the real enterQuickSurgery on a copy of the instance in a temp root; the source is never written. */
export function previewQuickSurgery(input: CollectInput): Collected {
  const tmp = mkdtempSync(join(tmpdir(), 'release-board-preview-'));
  try {
    const src = runDir(input.stateRoot, input.run);
    if (!existsSync(join(src, 'state.json'))) return { ok: false, reason: `no state for ${input.run}` };
    cpSync(join(src, 'state.json'), join(runDir(tmp, input.run), 'state.json'), { recursive: true });
    if (existsSync(join(src, 'ledger.jsonl'))) cpSync(join(src, 'ledger.jsonl'), join(runDir(tmp, input.run), 'ledger.jsonl'));
    const r0 = readRun(tmp, input.run);
    if (!r0.ok) return r0;
    // enterQuickSurgery loads by version key; rehearsal instances are previewed under their own key.
    try { enterQuickSurgery(tmp, input.run, 'preview', input.now, input.planOptions); } catch (e) { return { ok: false, reason: `preview failed: ${e instanceof Error ? e.message : String(e)}` }; }
    const r = readRun(tmp, input.run);
    if (!r.ok) return r;
    return snapshotFrom(r.state, r.ledger, { ...input, stateRoot: input.stateRoot });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
