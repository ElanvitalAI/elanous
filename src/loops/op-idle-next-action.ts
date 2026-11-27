// OP-NEXT-BEST-ACTION — the «whenever OP goes idle» half (the pulse half is in op-pulse-run.ts).
//
// S: between pulses OP's autopilot opens a drive turn when it goes idle, and that turn asked «what is next?» without the
//    state — on 11-26 such turns mailed the steward and «scheduled a check».
// C: the planner (op-next-action.ts) and its live snapshot (op-next-action-live.ts) already exist; the drive turn opens in
//    the OP TUI process, where a minutes-long land tick or release run must not block the event loop.
// A: idleNextActionPrefix() plans from live state and runs only the fast planner actuators in-process (assign · goals · split request).
//    The land tick and release run stay in the block as the OP turn's commands (still through the land/release graph).
//    The block is put in front of the drive prompt. Bounded by a timeout; any failure → no prefix (the drive opens as
//    before). Only the OP seat.
//
// 세 얼굴: 관측 = {stateRoot}/loops/op-next-action.jsonl line with window `idle:<iso>` · 판단 근거 = the block's evidence
// lines · 수복과 인계 = a timeout/failure opens the plain drive and logs the reason in the ledger.
import { join } from 'node:path';
import { appendPulseLedger } from './op-pulse.js';
import { executeNextActions, planNextActions, renderNextActionBlock } from './op-next-action.js';
import { liveNextActionState, liveNextActuators, type LiveRoots } from './op-next-action-live.js';

/** The snapshot reads several stores; past this the drive opens without the block (never a stalled idle turn). */
export const IDLE_PLAN_TIMEOUT_MS = 8_000; // Source: a live snapshot took ~2–4 s on mshq in the 11-26 test-universe run.

export interface IdleDeps {
  readonly roots?: LiveRoots;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  /** Test seam: the snapshot (default: live). */
  readonly state?: typeof liveNextActionState;
  /** Test seam: the fast actuators (default: live assign + goals). */
  readonly actuators?: ReturnType<typeof liveNextActuators>;
}

function defaultRoots(): LiveRoots {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { effectiveInstanceRoot } = require('../instance/resolve.js') as typeof import('../instance/resolve.js');
  return { stateRoot: effectiveInstanceRoot(), seatState: process.env.ELANOUS_SEAT_STATE ?? join(process.env.HOME ?? '', 'elanous-hq', 'seat-state') };
}

/** The «NEXT ACTION» block for OP's idle drive turn, or null (not OP · nothing to do · timeout · failure). */
export async function idleNextActionPrefix(seat: string | null | undefined, deps: IdleDeps = {}): Promise<string | null> {
  if ((seat ?? '').trim().toUpperCase() !== 'OP') return null;
  const now = (deps.now ?? (() => new Date()))();
  const roots = deps.roots ?? defaultRoots();
  const ledger = join(roots.stateRoot, 'loops', 'op-next-action.jsonl');
  const window = `idle:${now.toISOString()}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      const plan = planNextActions(await (deps.state ?? liveNextActionState)(roots, now));
      if (!plan.actions.length) return null;
      const live = deps.actuators ?? liveNextActuators(roots);
      // Fast actuators only: a land tick / release run would block the TUI for minutes — they stay the turn's commands.
      const results = await executeNextActions(plan, { ...(live.hint ? { hint: live.hint } : {}), ...(live.wake ? { wake: live.wake } : {}), ...(live.handMailBudget ? { handMailBudget: live.handMailBudget } : {}), ...(live.writeGoals ? { writeGoals: live.writeGoals } : {}), ...(live.requestSplit ? { requestSplit: live.requestSplit } : {}) }, 'live');
      appendPulseLedger(ledger, { window, at: now.toISOString(), stage: 'idle', unmeasured: plan.unmeasured,
        actions: results.map(r => ({ rule: r.action.rule, actor: r.action.actor, key: r.action.key, status: r.status, what: r.action.what, evidence: r.evidence })) });
      return renderNextActionBlock(results, plan.goals, plan.mail);
    })();
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deps.timeoutMs ?? IDLE_PLAN_TIMEOUT_MS); (timer as { unref?: () => void }).unref?.(); });
    const block = await Promise.race([work, timeout]);
    if (block === null) return null;
    return `[OP idle · next-action planner]\n${block}`;
  } catch (error) {
    try { appendPulseLedger(ledger, { window, at: now.toISOString(), stage: 'idle', error: (error instanceof Error ? error.message : String(error)).slice(0, 200) }); } catch { /* fail-open */ }
    return null;
  } finally { if (timer) clearTimeout(timer); }
}
