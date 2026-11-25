// The plan as it crosses the REPL-child → TUI boundary (DECISION-GATE v2 step 2). `update_plan` state lives in the child process
// (a singleton); the TUI host reads the turn's outcome from this snapshot, never from reply text.
import { planTurnOutcome, type PlanTurnOutcome } from './plan-outcome.js';
import type { PlanState, PlanStep, PlanStepStatus, PlanWake } from './plan-tool.js';
import { isBlockReason, isHandCause, type BlockReason, type HandCause } from '../agent-events/protocol.js';

const STEP_MAX = 120;
const REASON_MAX = 200;
const STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed', 'blocked', 'waiting']);

export interface PlanWireStep { status: PlanStepStatus; step: string; reason?: string; code?: BlockReason; cause?: HandCause; wake?: PlanWake }
export interface PlanWire { version: number; versionAtTurnStart: number; steps: PlanWireStep[] }

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** Child side: the plan as it stands at turn end. No plan → nothing to send. */
export function planWireFromState(state: PlanState, versionAtTurnStart: number): PlanWire | undefined {
  if (state.steps.length === 0) return undefined;
  return {
    version: state.version,
    versionAtTurnStart,
    steps: state.steps.map((step: PlanStep): PlanWireStep => ({
      status: step.status, step: clip(step.step, STEP_MAX),
      ...(step.reason ? { reason: clip(step.reason, REASON_MAX) } : {}),
      ...(step.code ? { code: step.code } : {}),
      ...(step.cause ? { cause: step.cause } : {}),
      ...(step.wake ? { wake: { kind: clip(step.wake.kind, 40), target: clip(step.wake.target, 120), ...(step.wake.until ? { until: clip(step.wake.until, 40) } : {}) } } : {}),
    })),
  };
}

/** Host side: whatever came over the pipe is untrusted until it parses. */
export function parsePlanWire(value: unknown): PlanWire | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.version !== 'number' || typeof raw.versionAtTurnStart !== 'number' || !Array.isArray(raw.steps) || raw.steps.length === 0) return undefined;
  const steps: PlanWireStep[] = [];
  for (const item of raw.steps) {
    if (item === null || typeof item !== 'object') return undefined;
    const step = item as Record<string, unknown>;
    if (typeof step.step !== 'string' || typeof step.status !== 'string' || !STATUSES.has(step.status)) return undefined;
    const wake = step.wake !== null && typeof step.wake === 'object' ? step.wake as Record<string, unknown> : undefined;
    steps.push({
      status: step.status as PlanStepStatus, step: clip(step.step, STEP_MAX),
      ...(typeof step.reason === 'string' && step.reason ? { reason: clip(step.reason, REASON_MAX) } : {}),
      ...(step.status === 'blocked' && isBlockReason(step.code) ? { code: step.code } : {}),
      ...(step.status === 'blocked' && isHandCause(step.cause) ? { cause: step.cause } : {}),
      ...(typeof wake?.kind === 'string' && typeof wake.target === 'string'
        ? { wake: { kind: clip(wake.kind, 40), target: clip(wake.target, 120), ...(typeof wake.until === 'string' ? { until: clip(wake.until, 40) } : {}) } } : {}),
    });
  }
  return { version: raw.version, versionAtTurnStart: raw.versionAtTurnStart, steps };
}

/** The verdict for a snapshot (a missing snapshot is a structure gap). */
export function outcomeOfPlanWire(wire: PlanWire | undefined): PlanTurnOutcome {
  if (!wire) return { kind: 'gap', why: 'no-plan' };
  return planTurnOutcome({ state: { steps: wire.steps, updatedAt: 0, version: wire.version }, versionAtTurnStart: wire.versionAtTurnStart });
}
