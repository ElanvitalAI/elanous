import { isAbsolute } from 'node:path';

export type OrchestratorSeat = 'OP' | 'TC' | 'MK' | 'UX';
export interface OrchestratorLoopConfig {
  /** ORCH1 graph mode — shadow writes observations only; live appends delegations (default shadow). */
  mode: 'off' | 'shadow' | 'live';
  seatTrees: Partial<Record<OrchestratorSeat, string[]>>;
  seatCaps: Record<OrchestratorSeat, number>;
  /** Max new delegations per tick; absent means no limit. */
  maxDelegatePerTick?: number;
  /** Dispatch placement preference and local concurrency lane. Defaults preserve the existing Pod preference and one local lane. */
  dispatch: { podTarget: number; localLane: number };
  /** Per-seat release gate; absent seats retain the spawn-budget default. */
  releaseGate?: Partial<Record<OrchestratorSeat, number>>;
  trafficMode: 'shadow' | 'live';
  idleRequest?: 'off' | 'shadow' | 'live';
  /** FINISH-RATE — the queue tick reads finish metrics before launching; shadow logs the hold only, on holds (default shadow). */
  finishGate?: 'off' | 'shadow' | 'on';
  /** ORCH-TA-HAND — the delegate node hands its picked cell to TASK-AGENT (`handTask`). Absent = off · shadow = card only ·
   *  live = launch (only when the tick mode is live too; a live hand skips the seat journal so the cell launches once). */
  handToTaskAgent?: 'off' | 'shadow' | 'live';
  /** Demo: hand only this cell id (others keep the seat path). Absent = every delegatable cell. */
  handToTaskAgentCell?: string;
  /** COORD-HA — the tick CLI probes LLM ⊕ task board for the degradation ladder. Absent = shadow (probe and log only) ·
   *  live = the tick acts on it (L1 rules only · L2 no new assignment) · off = no probe. */
  degradationSignal?: 'off' | 'shadow' | 'live';
}

export const ORCHESTRATOR_DEFAULTS: OrchestratorLoopConfig = {
  mode: 'shadow', seatTrees: {}, seatCaps: { TC: 8, UX: 6, MK: 6, OP: 4 }, dispatch: { podTarget: 18, localLane: 1 }, trafficMode: 'shadow', idleRequest: 'shadow', finishGate: 'shadow',
};

export function parseOrchestratorLoopConfig(raw: unknown): OrchestratorLoopConfig {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const rawTrees = value.seatTrees && typeof value.seatTrees === 'object' && !Array.isArray(value.seatTrees)
    ? value.seatTrees as Record<string, unknown> : {};
  const rawCaps = value.seatCaps && typeof value.seatCaps === 'object' && !Array.isArray(value.seatCaps)
    ? value.seatCaps as Record<string, unknown> : {};
  const rawGate = value.releaseGate && typeof value.releaseGate === 'object' && !Array.isArray(value.releaseGate)
    ? value.releaseGate as Record<string, unknown> : {};
  const seatTrees: OrchestratorLoopConfig['seatTrees'] = {};
  const seatCaps = { ...ORCHESTRATOR_DEFAULTS.seatCaps };
  const releaseGate: NonNullable<OrchestratorLoopConfig['releaseGate']> = {};
  for (const seat of ['OP', 'TC', 'MK', 'UX'] as const) {
    if (Array.isArray(rawTrees[seat])) seatTrees[seat] = rawTrees[seat].filter((path): path is string => typeof path === 'string' && isAbsolute(path));
    const cap = rawCaps[seat];
    if (typeof cap === 'number' && Number.isSafeInteger(cap) && cap >= 0) seatCaps[seat] = cap;
    const gate = rawGate[seat];
    if (typeof gate === 'number' && Number.isSafeInteger(gate) && gate >= 0) releaseGate[seat] = gate;
  }
  const mode = value.mode === 'off' || value.mode === 'live' ? value.mode : 'shadow';
  const maxDelegatePerTick = value.maxDelegatePerTick;
  const rawDispatch = value.dispatch && typeof value.dispatch === 'object' && !Array.isArray(value.dispatch)
    ? value.dispatch as Record<string, unknown> : {};
  const dispatch = { ...ORCHESTRATOR_DEFAULTS.dispatch };
  for (const field of ['podTarget', 'localLane'] as const) {
    const setting = rawDispatch[field];
    if (typeof setting === 'number' && Number.isSafeInteger(setting) && setting >= 0) dispatch[field] = setting;
  }
  return { mode, seatTrees, seatCaps, dispatch,
    ...(typeof maxDelegatePerTick === 'number' && Number.isSafeInteger(maxDelegatePerTick) && maxDelegatePerTick >= 0 ? { maxDelegatePerTick } : {}),
    ...(Object.keys(releaseGate).length ? { releaseGate } : {}),
    trafficMode: value.trafficMode === 'live' ? 'live' : 'shadow',
    idleRequest: value.idleRequest === 'off' || value.idleRequest === 'live' ? value.idleRequest : 'shadow',
    finishGate: value.finishGate === 'off' || value.finishGate === 'on' ? value.finishGate : 'shadow',
    ...(value.handToTaskAgent === 'shadow' || value.handToTaskAgent === 'live' ? { handToTaskAgent: value.handToTaskAgent } : {}),
    ...(typeof value.handToTaskAgentCell === 'string' && value.handToTaskAgentCell.trim() ? { handToTaskAgentCell: value.handToTaskAgentCell.trim() } : {}),
    ...(value.degradationSignal === 'off' || value.degradationSignal === 'shadow' || value.degradationSignal === 'live' ? { degradationSignal: value.degradationSignal } : {}) };
}

