import { emitTurnLife } from '../debug/turn-life.js';
import {
  CAPSULE_SYNC_CAP_MS,
  type CapsuleDecision, type CapsuleDecisionInput, type CapsuleKind, type CapsulePolicy,
} from '../turn-capsule/contract.js';

export interface CapsulePolicyOptions {
  /** The raw `turn` config section (for `syncCapMs`); read failures are undefined. */
  readonly turnConfig: () => unknown;
  /** Correlation supplied by the caller for this turn or capsule. */
  correlation?: {
    turnId?: string;
    capsuleId?: string;
    eventId?: string;
    sessionId?: string;
  };
  /** Optional observer; failures must not affect the decision. */
  log?: (event: string, data: Record<string, unknown>) => void;
  /** RUNSHELL-BG-ENDS-TURN — a tool family's own cap: `turn[capKey]` (else `defaultCapMs`) replaces `turn.syncCapMs`;
   *  `turn.syncCapMs: 0` («never detach by policy») still holds for every family. */
  readonly capKey?: string;
  readonly defaultCapMs?: number;
}

const validCap = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The capsule policy (A1) — the one switchless decision every capsule tool asks before it blocks the turn: Bash and RunShell
 * (A2) detach past `syncCapMs`. There is no on/off (CAPSULE-FLAGS-REMOVE-DEFAULT · the way back is a revert PR); `turn.syncCapMs`
 * only tunes the cap, and 0 means «never detach by policy». The caller supplies the kind from its own dispatch registry;
 * unknown tools stay synchronous.
 */
export function createCapsulePolicy(options: CapsulePolicyOptions): CapsulePolicy {
  return {
    decide(input: CapsuleDecisionInput): CapsuleDecision {
      let turn: unknown;
      try { turn = options.turnConfig(); } catch { turn = undefined; }
      const section = typeof turn === 'object' && turn !== null ? turn as Record<string, unknown> : {};
      const configured = section.syncCapMs;
      const own = options.capKey === undefined ? undefined : section[options.capKey];
      const cap = options.capKey !== undefined
        // Terra MF2: an explicit «never detach» (`turn.syncCapMs: 0`) wins over the family cap.
        ? (configured === 0 ? 0 : validCap(own) ? own : options.defaultCapMs ?? CAPSULE_SYNC_CAP_MS)
        : validCap(configured) ? configured : CAPSULE_SYNC_CAP_MS;
      let decision: CapsuleDecision;
      if (cap === 0) {
        // syncCapMs 0 = never detach by policy (an explicit background request still detaches).
        decision = input.requestedBackground === true
          ? { mode: 'detach', syncCapMs: 0, reason: 'requested-background' }
          : { mode: 'sync', syncCapMs: Number.POSITIVE_INFINITY, reason: 'sync-cap-zero' };
      } else if (input.requestedBackground === true) {
        decision = { mode: 'detach', syncCapMs: 0, reason: 'requested-background' };
      } else if (input.kind === null) {
        decision = { mode: 'sync', syncCapMs: Infinity, reason: 'not-a-capsule' };
      } else {
        decision = { mode: 'sync', syncCapMs: cap, reason: 'capsule-sync-cap' };
      }
      try {
        (options.log ?? emitTurnLife)('turn-life:capsule-policy', {
          ...options.correlation, tool: input.tool, kind: input.kind, mode: decision.mode,
          syncCapMs: Number.isFinite(decision.syncCapMs) ? decision.syncCapMs : null, reason: decision.reason,
        });
      } catch { /* Observability must not change the policy. */ }
      return decision;
    },
  };
}

/** Map a dispatched tool name to its contract CapsuleKind (CAPSULE-A1, judgment-only): the §1.5 capsule families —
 *  긴 Bash(shell) · Agent 서브에이전트(agent) · 하니스 자식(harness) · MCP(mcp) — plus graph runs (graph).
 *  A tool name outside these families is not a capsule: the junction returns null and emits no policy row. */
export function capsulePolicyKindForTool(name: string): CapsuleKind | null {
  if (name === 'Agent' || name === 'Task') return 'agent';
  if (name.startsWith('mcp__')) return 'mcp';
  if (/^(Bash|Shell|RunShell|WebTerminal|Terminal)/.test(name)) return 'shell';
  if (/^(RunDevHarness|DevHarness|Harness)/.test(name)) return 'harness';
  if (/^(GraphRun|RunGraph|Graph)/.test(name)) return 'graph';
  return null;
}

/** Strict per-kind predicate for the EXPLICIT background-request keys the tool's own family actually
 *  supports (CAPSULE-A1 judgment fidelity · JUD-B #128143 → terra r8 mustFix[1] · JUD-B #128197): the
 *  dispatch junction threads this through to decide() so the judgment row states the args actually
 *  dispatched. Interpretation is per-kind, never tool-agnostic — agent family(Agent/Task) reads
 *  `run_in_background` (W1.3 AgentSpawn · agent/types.ts · agent-cli.ts), shell family
 *  (Bash/Shell/RunShell/WebTerminal/Terminal) reads `mode: 'bg'` (skills/tools/shell.ts · shell-runner
 *  dispatch, A2 병렬 탈착 축 §3.6 C3:805; the REAL Bash schema carries only command+timeout —
 *  skills/tools/index.ts buildBashTool — so it can never produce a background key), and
 *  mcp·harness·graph families have NO official background key at this junction — fail-open false.
 *  mcp/server.ts `run_in_background ?? true` is the inbound MCP-surface Agent only and never crosses
 *  this junction, so a business `mode:'bg'`·`run_in_background` on an outbound mcp__* tool must NOT
 *  be misread as a background request. Fail-open: 인자가 없거나·읽을 수 없거나·다른 값이면 요청이
 *  아니다(문자열 'true'/'bg' 등 truthy 오판 없이 엄격 일치만). */
export function capsuleRequestedBackground(tool: string, args: unknown): boolean {
  const kind = capsulePolicyKindForTool(tool);
  if (kind === null) return false;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
  const a = args as Record<string, unknown>;
  if (kind === 'agent') return a.run_in_background === true;
  if (kind === 'shell') return a.mode === 'bg';
  return false; // mcp·harness·graph: 이 접합부에 공식 배경 키 없음 — fail-open
}
