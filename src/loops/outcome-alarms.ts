/**
 * OUTCOME-DONE-ALARMS (CEO 11-26 18:2x · release 0.3.38 P0) — «done» is not an outcome.
 *
 * S: the 11-26 federation review found loops that tick «done» and produce nothing: the land graph ticked fine and
 *    auto-landed 0 PRs · the release-rocket tick said done with runs:[] while nobody created the 0.3.37 run (the 16:00 cut
 *    was missed) · op-bulletin fired but BULLETIN-NOW.md was not rewritten since 07:09.
 * C: the trigger registry's goal predicate only checks that the tick wrote its own receipt (last-tick.json / mtime ≥ window)
 *    — it never measures what the loop exists for.
 * Q: how does each such loop say what it actually produced, and who hears when that is zero or stale?
 * A: an outcome probe per graph, read on every registry tick from state the loops already write (land ledger ⊕ the land
 *    tick's ready count · release schedules ⊕ release-graph run dirs · BULLETIN-NOW.md mtime). A reading is `bad` when the
 *    outcome is zero or stale; bad for `holdMin` → ONE alarm card to the graph owner and OP through the trigger card path,
 *    deduped per episode key (a new card only after the outcome recovers and goes bad again, or for a new version).
 *    The latest reading shows on the loop's row in the space's «↻ loops (N)» tab.
 *
 * 세 얼굴: 관측 = graph_trigger_outcomes row per graph (summary · bad · since) ⊕ `outcome-alarm` tick event ⊕ the loop tab line ·
 * 판단 근거 = the reading's detail (counts / versions / age) in the card · 수복과 인계 = the card names the fix command.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** One measured outcome of a loop. */
export interface OutcomeReading {
  /** Short, for the loop tab line: «landed 0/30m · ready 4». */
  readonly summary: string;
  /** Zero or stale past the threshold (the hold, if any, is applied by the evaluator). */
  readonly bad: boolean;
  /** Minutes the reading must stay bad before the alarm (0 = at once). */
  readonly holdMin: number;
  /** Dedupe key of this bad episode (absent = the episode start time). */
  readonly key?: string;
  /** One line for the card: what is zero/stale and what to do. */
  readonly detail: string;
}

export type OutcomeProbe = (now: Date) => OutcomeReading | null;

// 출처: OUTCOME-DONE-ALARMS cell (CEO 11-26 18:2x) — «≥3 ready-to-land for 30 min with 0 landed · cut-at passed by 5 min
// with no run · bulletin older than 45 min». The 24 h lookback keeps old, already-handled schedules out (one release a day).
export const LAND_READY_MIN = 3;
export const LAND_STALL_MIN = 30;
export const RELEASE_CUT_GRACE_MIN = 5;
/** A scheduled cut older than this is history, not a missing run. */
export const RELEASE_LOOKBACK_MIN = 24 * 60;
export const BULLETIN_STALE_MIN = 45;

/** land-graph: landed in the last 30 min vs PRs ready to land (every gate passes) but not landed in the last tick. */
export function landOutcome(input: { landedRecent: number; readyNotLanded: number | null; mode?: string }): OutcomeReading {
  const ready = input.readyNotLanded;
  const summary = `landed ${input.landedRecent}/${LAND_STALL_MIN}m · ready ${ready ?? '?'}${input.mode && input.mode !== 'live' ? ` · ${input.mode}` : ''}`;
  const bad = ready !== null && ready >= LAND_READY_MIN && input.landedRecent === 0;
  return { summary, bad, holdMin: LAND_STALL_MIN,
    detail: `${ready ?? '?'} PRs ready to land (every gate passes) but 0 landed in ${LAND_STALL_MIN}+ min${input.mode && input.mode !== 'live' ? ` — land.graph.mode is ${input.mode}` : ''} · check: eln loop trigger watch land-graph` };
}

/** release: a scheduled version newer than the released one whose cut time passed by the grace with no release-graph run. */
export function releaseOutcome(input: { now: Date; released: string; schedules: readonly { version: string; cutAt: string }[]; hasRun: (version: string) => boolean }): OutcomeReading {
  const t = input.now.getTime();
  const missing = input.schedules.filter(s => {
    const cut = Date.parse(s.cutAt);
    return Number.isFinite(cut) && newer(s.version, input.released) && t - cut >= RELEASE_CUT_GRACE_MIN * 60_000 && t - cut <= RELEASE_LOOKBACK_MIN * 60_000 && !input.hasRun(s.version);
  }).sort((a, b) => Date.parse(a.cutAt) - Date.parse(b.cutAt));
  if (!missing.length) return { summary: 'runs ok', bad: false, holdMin: 0, detail: 'every passed cut has a run' };
  const first = missing[0]!;
  const late = Math.round((t - Date.parse(first.cutAt)) / 60_000);
  return { summary: `missing-run ${missing.map(m => m.version).join(',')}`, bad: true, holdMin: 0, key: `missing-run:${missing.map(m => m.version).join(',')}`,
    detail: `missing-run: ${first.version} cut-at ${first.cutAt} passed ${late} min ago and no release graph run exists${missing.length > 1 ? ` (also ${missing.slice(1).map(m => m.version).join(', ')})` : ''} · start: eln release graph run ${first.version} --cut-at <iso> --publish-at <iso>` };
}

/** op-bulletin: age of BULLETIN-NOW.md. */
export function bulletinOutcome(input: { now: Date; mtimeMs: number | null }): OutcomeReading {
  if (input.mtimeMs === null) return { summary: 'bulletin missing', bad: true, holdMin: 0, key: 'bulletin:missing', detail: 'BULLETIN-NOW.md does not exist · OP writes it (OPS-RULES §연방 공보)' };
  const age = Math.max(0, Math.round((input.now.getTime() - input.mtimeMs) / 60_000));
  const bad = age > BULLETIN_STALE_MIN;
  return { summary: `bulletin ${age}m old`, bad, holdMin: 0, key: `bulletin:${Math.round(input.mtimeMs)}`,
    detail: `BULLETIN-NOW.md last rewritten ${age} min ago (> ${BULLETIN_STALE_MIN}) although op-bulletin fires · OP rewrites it now` };
}

function newer(version: string, released: string): boolean {
  if (!released) return true;
  const a = version.split('.').map(Number); const b = released.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

function readJson(path: string): unknown { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } }

/**
 * The live probes, keyed by graph id. Every read is fail-soft: a source that cannot be read gives no reading (null) —
 * never a false alarm. `releases` is injected so the trigger CLI keeps the release ledger import lazy.
 */
export function liveOutcomeProbes(input: { stateRoot: string; seatState: string; releases?: () => { released: string; schedules: readonly { version: string; cutAt: string }[] } }): Record<string, OutcomeProbe> {
  const probes: Record<string, OutcomeProbe> = {
    'land-graph': now => {
      const home = join(input.stateRoot, 'land-graph');
      const tick = readJson(join(home, 'last-tick.json')) as { readyNotLanded?: unknown; mode?: unknown } | undefined;
      if (!tick) return null;
      const since = now.getTime() - LAND_STALL_MIN * 60_000;
      let landedRecent = 0;
      try {
        for (const line of readFileSync(join(home, 'ledger.jsonl'), 'utf8').split('\n')) {
          if (!line.includes('"landed"')) continue;
          try { const row = JSON.parse(line) as { event?: string; at?: string; synthetic?: boolean }; if (row.event === 'landed' && !row.synthetic && Date.parse(row.at ?? '') >= since) landedRecent++; } catch { /* skip */ }
        }
      } catch { /* no ledger = nothing landed */ }
      return landOutcome({ landedRecent, readyNotLanded: typeof tick.readyNotLanded === 'number' ? tick.readyNotLanded : null, ...(typeof tick.mode === 'string' ? { mode: tick.mode } : {}) });
    },
    'op-bulletin': now => {
      const path = join(input.seatState, 'OPS', 'BULLETIN-NOW.md');
      let mtimeMs: number | null = null;
      try { mtimeMs = existsSync(path) ? statSync(path).mtimeMs : null; } catch { return null; }
      return bulletinOutcome({ now, mtimeMs });
    },
  };
  if (input.releases) {
    const releases = input.releases;
    probes['release-rocket'] = now => {
      let data: ReturnType<typeof releases>;
      try { data = releases(); } catch { return null; }
      return releaseOutcome({ now, ...data, hasRun: v => existsSync(join(input.stateRoot, 'release-graph', v, 'state.json')) });
    };
  }
  return probes;
}
