// src/autopilot/agent-loop.ts
//
// ROADMAP-ipad-companion-autopilot-priority §P1 spike — AutopilotLoopDriver
// feasibility proof.
//
// Goals (spike scope only — production wire = D1):
//   - mission 1줄 받음 → ACP prompt 호출 → textDelta accumulate
//   - termination criteria skeleton (success · stuck · budget · cancelled · error)
//   - per-iteration follow-up hook — caller 가 다음 turn 의 text 결정
//   - feasibility verify only — D1 진입 전 가설 검증
//
// Not in spike:
//   - safety / sandbox / risky pattern detect (D1.1)
//   - mission envelope · ACP feedback stream wire (D1.2)
//   - CLI entry `elanous autopilot run` (D1.3)
//   - iOS client wire (D2)

import type { LlmTurnRunner } from './runner.js';
import type {
  SessionId,
  SessionUpdate,
  StopReason,
  ContentBlock,
} from '@agentclientprotocol/sdk';
// PLAN-autopilot-terminal-driving-2026-05-20 v2 Phase B (2026-05-20) — user
// mid-mission instruction injection. Caller (handleAutopilotRun) supplies
// a per-run queue ref · driver drains at iter-start and prepends to the
// next prompt as `[user injected: "…"]` markers. Empty drains short-circuit.
export interface AutopilotInjectionQueue {
  /** Drain + return pending instructions (FIFO · idempotent — queue empty
   *  after the call). Empty array when nothing pending. */
  drain(): string[];
}
import { scanRiskyToolCall, type RiskyPattern } from './risky-pattern.js';
import { forwardToUserTerminal } from './terminal-forwarder.js';
import {
  createSeqTracker,
  makeEnvelope,
  type FeedbackEnvelope,
  type SeqTracker,
} from '../feedback/envelope.js';

/**
 * Termination outcome for an autopilot loop. Caller can branch on the
 * `kind` tag for UI surfacing or follow-up decisions.
 */
export type AutopilotTermination =
  | { kind: 'success'; reason: string }
  | { kind: 'stuck'; iteration: number; reason: string }
  | { kind: 'budget'; budget: 'iterations' | 'wallClock' | 'outputChars'; observed: number; limit: number }
  | { kind: 'cancelled' }
  | { kind: 'risky'; pattern: RiskyPattern; iteration: number }
  | { kind: 'error'; message: string; code?: string };

/** Decision returned by the optional risky-tool-call policy hook. */
export type RiskyPolicyDecision = 'allow' | 'deny';

export interface RiskyPolicyInfo {
  pattern: RiskyPattern;
  /** The raw SessionUpdate that matched (tool_call or tool_call_update). */
  update: SessionUpdate;
  iteration: number;
}

/**
 * Default risky-tool-call policy — deny `high` severity, allow `medium`.
 * Callers wanting HITL on medium should override via
 * `AutopilotConfig.onRiskyToolCall`.
 */
export function defaultRiskyPolicy(info: RiskyPolicyInfo): RiskyPolicyDecision {
  return info.pattern.severity === 'high' ? 'deny' : 'allow';
}

/**
 * Per-iteration context handed to the `onIterationEnd` hook. The hook
 * returns the next prompt text — or `null` / empty string to terminate
 * with `kind: 'success'` (mission considered complete by caller).
 */
export interface AutopilotIterationInfo {
  iteration: number;
  /** Text delta accumulated during this turn only (not cumulative). */
  iterationText: string;
  /** Total accumulated text from all prior iterations. */
  totalText: string;
  stopReason: StopReason;
}

export interface AutopilotConfig {
  /**
   * Session-scoped LLM turn substrate. The driver invokes `runner.prompt`
   * per iteration and `runner.cancel` for risky / forwarded / aborted
   * paths. Construct an {@link AcpTurnRunner} (today) or
   * `ElanousBuiltinTurnRunner` (MB-3) — both implement {@link LlmTurnRunner}.
   * The driver does not own the runner's lifecycle.
   */
  runner: LlmTurnRunner;
  /**
   * ACP session id — owned by the runner, mirrored here so the driver
   * can mint envelope block ids (`autopilot:<sid>:status` etc.) and
   * forward to helpers that still take a SessionId. Must match the
   * session the runner is bound to.
   */
  sessionId: SessionId;
  /** Mission as the first prompt's single text block. */
  mission: string;
  /**
   * Max iterations (turns). On exceed: termination = `{ kind: 'budget',
   * budget: 'iterations' }`. Default 8 — D1 value, fine-tuned by caller.
   */
  maxIterations?: number;
  /**
   * Wall-clock budget in ms (D1.1b). Driver checks before each iteration
   * + immediately after each turn resolves. On exceed: termination =
   * `{ kind: 'budget', budget: 'wallClock' }`. Default = `Number.POSITIVE_INFINITY`.
   */
  maxWallClockMs?: number;
  /**
   * Cumulative output character budget (D1.1b — token proxy). Sums the
   * `iterationText` of every iteration. On exceed: termination =
   * `{ kind: 'budget', budget: 'outputChars' }`. Default = `Number.POSITIVE_INFINITY`.
   *
   * Token-precise budget will replace this when ACP exposes usage on
   * `session/update` (currently nullable across backends).
   */
  maxOutputChars?: number;
  /**
   * Success predicate — invoked after each iteration with the cumulative
   * text. Returning `true` terminates with `{ kind: 'success' }`. Optional
   * — if absent, success is signaled by the `onIterationEnd` hook
   * returning `null` / empty.
   */
  successPredicate?: (totalText: string) => boolean;
  /**
   * Stuck predicate — invoked after each iteration with the iteration
   * text. Returning `true` terminates with `{ kind: 'stuck' }`. Default
   * heuristic: 3 consecutive iterations with empty / whitespace-only
   * agent output (caller can override via this hook).
   */
  stuckPredicate?: (iterationText: string, iteration: number) => boolean;
  /** Per-update streaming callback — UI can render textDelta / tool. */
  onUpdate?: (update: SessionUpdate) => void;
  /**
   * Per-iteration end hook — caller decides the next prompt's text.
   * Return `null` / empty string to terminate the loop with
   * `{ kind: 'success', reason: 'no follow-up' }`.
   *
   * If absent, the loop terminates after the first iteration as
   * `{ kind: 'success', reason: 'no follow-up hook' }` — useful for
   * single-shot mission verification.
   */
  onIterationEnd?: (info: AutopilotIterationInfo) => string | null | undefined;
  /**
   * AbortSignal — caller can cancel mid-loop. When fired the driver
   * calls `agent.cancel(sessionId)` and resolves with
   * `{ kind: 'cancelled' }`.
   */
  signal?: AbortSignal;
  /**
   * D1.1c — Risky tool-call policy. When a tool_call (or tool_call_update)
   * arrives, the driver scans its JSON form with `scanRiskyToolCall` and
   * — if a pattern matches — calls this hook. Returning `'deny'` triggers
   * `agent.cancel(sessionId)` and resolves the run with
   * `{ kind: 'risky', pattern, iteration }`. Returning `'allow'` lets
   * the turn continue.
   *
   * Default = {@link defaultRiskyPolicy} (deny `high`, allow `medium`).
   * Pass `() => 'allow'` to bypass entirely (e.g. for replay harnesses).
   */
  onRiskyToolCall?: (info: RiskyPolicyInfo) => RiskyPolicyDecision;
  /**
   * D1.2 — Mission envelope sink. Driver emits `agent.status` envelopes
   * at start (phase=start · status=running), per-iteration boundary
   * (phase=update · status=running · lastEvent=`iter ${n}`), and on
   * termination (phase=end · status mapped from termination kind:
   * `success`→done · `stuck`→error · `budget`→done · `cancelled`→done ·
   * `risky`→error · `error`→error). Callers can forward to PWA / iOS
   * surfaces, persist to log, or feed downstream renderers.
   *
   * Plan envelopes (`agent.plan` with steps) are out of scope for the
   * D1.2 first cut — mission-specific step decomposition requires
   * planner integration (D1.4+).
   */
  onEnvelope?: (env: FeedbackEnvelope) => void;
  /**
   * Agent identifier for `AgentStatusPayload.agentId`. Default
   * `"autopilot"`. Override when multiple drivers share a sink.
   */
  envelopeAgentId?: string;
  /**
   * Override the auto-created SeqTracker. Useful when the caller is
   * already aggregating envelopes from other emitters and wants a
   * shared sequence space.
   */
  seqTracker?: SeqTracker;
  /**
   * D1.4a — Optional pre-computed plan. When provided, each iteration's
   * prompt is taken from `plan.steps[iteration-1].text` instead of
   * relying on the `onIterationEnd` hook (mission is still used for the
   * very first turn unless step 0 overrides it — see below). The driver
   * also emits `agent.plan` envelopes alongside the existing
   * `agent.status` stream so renderers can show step progress.
   *
   * Behavior matrix:
   *   - `plan` absent       → existing flow (mission + onIterationEnd)
   *   - `plan` present      → mission = first prompt; subsequent prompts
   *                           pull from `plan.steps[iter-1].text`. When
   *                           the plan exhausts (iter > steps.length),
   *                           terminate with `{ kind: 'success', reason:
   *                           'plan complete' }`. `onIterationEnd` is
   *                           still invoked (for telemetry) but its
   *                           return value is ignored.
   *
   * LLM-based plan synthesis (auto-decomposition from mission) lives in
   * D1.4b — caller wires a planner before invoking the driver.
   */
  plan?: AutopilotPlan;
  /**
   * G2 — Terminal Agency. When set, the driver intercepts each
   * `tool_call`/`tool_call_update` SessionUpdate, attempts to extract
   * a shell command from the ACP backend's tool args, and forwards the
   * command bytes to the user's SwiftTerm/PreviewTerminal pty via
   * `forwardToUserTerminal`. The current turn is cancelled so the ACP
   * backend's own subshell does NOT execute the command — the user
   * environment is the single source of truth.
   *
   * Next iteration's prompt is automatically prefixed with a synthetic
   * note "[forwarded \"<cmd>\" to user terminal in iter N]" so the LLM
   * can reason about prior actions even before the G3 screenshot loop
   * is wired in. The forwarded marker is per-iteration — each new
   * tool_call gets its own forward + cancel.
   *
   * Risky-policy gate runs FIRST: if a high-severity pattern matches
   * the driver aborts with `kind: 'risky'` before any forward happens.
   *
   * Caller responsibility: keep (sessionId, terminalId) pointing at
   * a live PreviewTerminal. The driver itself does not own the pty
   * lifecycle.
   */
  terminalAgency?: TerminalAgencyConfig;
  /**
   * PLAN-autopilot-terminal-driving-2026-05-20 v2 Phase B (2026-05-20) —
   * user mid-mission instruction injection queue. When set, the driver
   * drains pending instructions at each iter-start (BEFORE building the
   * next prompt). Each drained instruction is prepended as a synthetic
   * `[user injected mid-mission: "<text>"]` marker so the LLM treats it
   * as additional context for the upcoming turn.
   *
   * Caller (handleAutopilotRun) owns the queue and pushes via the
   * `POST /v1/autopilot/<runId>/inject` REST endpoint. The driver only
   * drains — it never mutates the queue's external state otherwise.
   *
   * Empty drain (no pending instructions) short-circuits — no marker
   * added, prompt builder behaves as if Phase B were not wired.
   */
  injectionQueue?: AutopilotInjectionQueue;
}

export interface TerminalAgencyConfig {
  /** PreviewTerminal session id — usually the same as the ACP session
   *  in single-session iOS chats, but kept distinct so PWA / multi-tab
   *  callers can target a specific pty. */
  sessionId: string;
  terminalId: string;
  /**
   * G4 — Guidance prompt injection. When truthy, a standard text block
   * is prepended to the **first** iteration's prompt that teaches the
   * LLM the raw-byte conventions for the user pty:
   *
   *   - control codes via `printf '\\eX'`, `printf '\\x03'` etc.
   *   - SGR mouse encoding (`\\e[<button;col;row;M`/`m`)
   *   - vim-style motions (`:%s/foo/bar/g`)
   *   - tmux prefix sequences (`\\x01` for default Ctrl-B etc.)
   *
   * Pass `true` for the default guidance, a string for a custom one,
   * or `false` to skip (rely on the backend's built-in knowledge).
   * Default `true` when terminalAgency is set.
   */
  injectGuidance?: boolean | string;
  /**
   * G3 — Screenshot-in-loop reflection. When true (default), after the
   * driver forwards a command to the user pty it waits `captureDelayMs`
   * (default 500) then calls `dispatchWebTerminalScreenshot` and stages
   * the resulting PNG as an inline image block in the next iteration's
   * prompt. Lets vision-capable LLMs (Claude / GPT-4V / Gemini) reason
   * about the terminal state — works whether the user is in a plain
   * shell, nvim, tmux, vim, less, git rebase -i, etc.
   *
   * Set to `false` when the backend is text-only or when bandwidth is
   * constrained — text marker still mentions the forwarded command.
   */
  captureScreenshots?: boolean;
  /** ms to wait after forward before capturing. Default 500. */
  captureDelayMs?: number;
  /** Screenshot SVG → PNG scale factor. Default 2 (matches PWA `:capture`). */
  captureScale?: number;
  /**
   * I1 — Dry-run mode. When true, the driver records the byte sequence
   * it WOULD have forwarded (via the same audit log path) but does not
   * write to the user pty. Useful for testing the LLM's intent without
   * affecting the user's environment. Loop still advances + emits the
   * forwarded marker so subsequent iterations reason about prior intent.
   */
  dryRun?: boolean;
  /**
   * I1 — Strict risky-pattern policy under terminal agency. When true,
   * every `medium` severity pattern (git reset --hard · --no-verify ·
   * chmod 777 / · eval $()) is denied in addition to the `high` ones.
   * Default false — caller opts in for unattended runs. Has no effect
   * if `onRiskyToolCall` is provided (caller's hook is authoritative).
   */
  strictRiskyPolicy?: boolean;
}

/**
 * D1.4a — Plan step shape. Mirrors `AgentPlanPayload.steps` from the
 * feedback envelope schema so consumers can render directly.
 */
export interface AutopilotPlanStep {
  /** Stable id — used as the `agent.plan` envelope blockId suffix. */
  id: string;
  /** Plain-text instruction sent as the iteration's prompt. */
  text: string;
}

export interface AutopilotPlan {
  /** Plan reference id (logged into the `agent.plan` envelope). */
  ref: string;
  /** Ordered list of steps. Empty list = no plan-driven iteration. */
  steps: AutopilotPlanStep[];
}

export interface AutopilotResult {
  termination: AutopilotTermination;
  iterations: number;
  totalText: string;
}

/**
 * Default stuck heuristic — 3 consecutive empty / whitespace-only
 * iteration outputs. Kept module-level for testability.
 */
function makeDefaultStuckPredicate(): (text: string, iter: number) => boolean {
  let emptyStreak = 0;
  return (text: string, _iter: number) => {
    if (text.trim().length === 0) {
      emptyStreak += 1;
      return emptyStreak >= 3;
    }
    emptyStreak = 0;
    return false;
  };
}

/**
 * Spike-grade autopilot loop driver. Wires the mission text into an
 * ACP session, accumulates agent text deltas across iterations, and
 * terminates based on caller-configurable predicates.
 *
 * Production hardening (D1):
 *   - safety / risky pattern detection on tool calls
 *   - sandbox cwd enforcement
 *   - elanous/ask/request fall-through for decision points
 *   - mission envelope emission (agent.plan / agent.tool / agent.status)
 *   - per-step token & wall-clock budget enforcement
 */
export class AutopilotLoopDriver {
  constructor(private readonly cfg: AutopilotConfig) {}

  async run(): Promise<AutopilotResult> {
    const {
      runner,
      sessionId,
      mission,
      maxIterations = 8,
      maxWallClockMs = Number.POSITIVE_INFINITY,
      maxOutputChars = Number.POSITIVE_INFINITY,
      successPredicate,
      onUpdate,
      onIterationEnd,
      signal,
    } = this.cfg;
    const stuckPredicate = this.cfg.stuckPredicate ?? makeDefaultStuckPredicate();
    const terminalAgency = this.cfg.terminalAgency;
    // I1 — under terminal agency + strictRiskyPolicy, medium severity
    // also denied (otherwise default `high deny, medium allow`).
    const effectivePolicy: (info: RiskyPolicyInfo) => RiskyPolicyDecision =
      this.cfg.onRiskyToolCall
        ? this.cfg.onRiskyToolCall
        : terminalAgency?.strictRiskyPolicy
          ? () => 'deny'
          : defaultRiskyPolicy;
    const riskyPolicy = effectivePolicy;
    const seqTracker = this.cfg.seqTracker ?? createSeqTracker();
    const envelopeBlockId = `autopilot:${sessionId}:status`;
    const planBlockId = `autopilot:${sessionId}:plan`;
    // PLAN-autopilot-terminal-driving-2026-05-20 v2 Phase A · 2026-05-20 —
    // per-iteration chat-stream blockId so iOS ChatView renders each iter
    // as a separate thought bubble (not a single merged buffer). Computed
    // inside the loop at iter-start time using the live iteration index.
    const chatStreamBlockId = (iter: number) =>
      `autopilot:${sessionId}:chat:${iter}`;
    const agentId = this.cfg.envelopeAgentId ?? 'autopilot';
    const onEnvelope = this.cfg.onEnvelope;
    const plan = this.cfg.plan;
    const planActive = !!plan && plan.steps.length > 0;

    const emitStatus = (
      phase: 'start' | 'update' | 'end',
      status: 'running' | 'queued' | 'error' | 'done',
      lastEvent?: string,
    ): void => {
      if (!onEnvelope) return;
      try {
        const env = makeEnvelope(
          {
            kind: 'agent.status',
            sessionId,
            blockId: envelopeBlockId,
            phase,
            payload: { agentId, status, lastEvent },
          },
          seqTracker,
        );
        onEnvelope(env);
      } catch {
        // best-effort — envelope emission must not break the loop
      }
    };

    /**
     * D1.4a — Emit an `agent.plan` envelope with the current step status
     * snapshot. Called on plan start (phase=start), each step transition
     * (phase=update), and plan exhaustion (phase=end). Skipped when plan
     * is absent.
     */
    const emitPlan = (
      phase: 'start' | 'update' | 'end',
      activeIndex: number | undefined,
    ): void => {
      if (!onEnvelope || !plan) return;
      const steps = plan.steps.map((s, idx) => ({
        text: s.text,
        status: (activeIndex == null
          ? 'pending'
          : idx < activeIndex
            ? 'done'
            : idx === activeIndex
              ? 'in-progress'
              : 'pending') as 'pending' | 'in-progress' | 'done' | 'skipped',
      }));
      try {
        const env = makeEnvelope(
          {
            kind: 'agent.plan',
            sessionId,
            blockId: planBlockId,
            phase,
            payload: { ref: plan.ref, steps, activeIndex },
          },
          seqTracker,
        );
        onEnvelope(env);
      } catch {
        // best-effort — envelope emission must not break the loop
      }
    };

    /**
     * Phase A — emit a chat-targeted thought/announce/done bubble.
     * Mirrors `emitStatus`/`emitPlan` shape so caller renderers (iOS
     * ChatView · PWA chat surface) consume the same envelope substrate.
     *
     * Use cases:
     *  - per-iteration final LLM text (role='thought' / 'announce')
     *    posted at iteration end so iOS shows the model's commentary
     *    as a chat bubble rather than only inside the HUD pulse.
     *  - termination summary (role='done') posted once via `finalize`.
     *
     * Phase semantics:
     *  - 'start'  bubble open (we don't currently use — emit-once path)
     *  - 'delta'  text appended (reserved for future per-chunk streaming)
     *  - 'update' bubble's text replaced (today's default · idempotent)
     *  - 'end'    bubble finalized (role='done' or last update)
     *
     * Best-effort — envelope emission never breaks the loop.
     */
    const emitChatStream = (
      phase: 'start' | 'delta' | 'update' | 'end',
      iter: number,
      text: string,
      role: 'thought' | 'announce' | 'done',
    ): void => {
      if (!onEnvelope) return;
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      try {
        const env = makeEnvelope(
          {
            kind: 'agent.chat-stream',
            sessionId,
            blockId: chatStreamBlockId(iter),
            phase,
            payload: { text, role, iteration: iter },
            // iOS ChatView 가 typed payload 로 hydrate — asciiFallback 은
            // dumb renderer 용 single-line summary. TUI 가 본 envelope
            // 받으면 ANSI 색깔 없는 plain 한 줄로 표시 (≈ 90 chars trim).
            asciiFallback: [trimmed.slice(0, 90)],
          },
          seqTracker,
        );
        onEnvelope(env);
      } catch {
        // best-effort — envelope emission must not break the loop
      }
    };

    /** Wrap every return path so termination envelope is always emitted. */
    const finalize = (
      termination: AutopilotTermination,
      iterations: number,
      text: string,
    ): AutopilotResult => {
      const status: 'running' | 'queued' | 'error' | 'done' =
        termination.kind === 'success' ? 'done'
          : termination.kind === 'cancelled' ? 'done'
          : termination.kind === 'budget' ? 'done'
          : 'error';
      const lastEvent =
        termination.kind === 'success' ? termination.reason
        : termination.kind === 'stuck' ? `stuck@iter${termination.iteration}`
        : termination.kind === 'budget' ? `budget:${termination.budget}(${termination.observed}/${termination.limit})`
        : termination.kind === 'cancelled' ? 'cancelled'
        : termination.kind === 'risky' ? `risky:${termination.pattern.kind}`
        : termination.message;
      emitStatus('end', status, lastEvent);
      if (planActive) {
        // Plan view at termination — mark as done if success, otherwise
        // keep activeIndex frozen (caller renderer can apply 'skipped' to
        // remaining steps).
        emitPlan('end', termination.kind === 'success' ? plan!.steps.length : undefined);
      }
      // Phase A — final done-bubble in chat. text may be empty when the
      // loop terminated before any model response landed (e.g. cancelled
      // before iter 1 emits); emitChatStream short-circuits on empty.
      // Use a tiny summary derived from the termination kind so the
      // user sees a closing bubble that explains why the loop stopped.
      const doneSummary =
        termination.kind === 'success' ? `done — ${termination.reason}`
        : termination.kind === 'cancelled' ? 'cancelled by user'
        : termination.kind === 'risky' ? `aborted — risky tool call (${termination.pattern.kind})`
        : termination.kind === 'budget' ? `done — budget(${termination.budget})`
        : termination.kind === 'stuck' ? `stopped — stuck@iter${termination.iteration}`
        : `error — ${termination.message}`;
      emitChatStream('end', iterations, doneSummary, 'done');
      return { termination, iterations, totalText: text };
    };

    let totalText = '';
    // G4 — prepend guidance to the first iteration's prompt only.
    // Plan-driven steps + onIterationEnd follow-ups inherit the same
    // backend system context so no need to re-inject every turn.
    let nextPromptText: string =
      terminalAgency && terminalAgency.injectGuidance !== false
        ? `${resolveGuidanceText(terminalAgency.injectGuidance)}\n\n${mission}`
        : mission;
    let iteration = 0;
    let totalChars = 0;
    const startedAt = performance.now();
    // Ref-object pattern — TS narrows `let` to `never` after closure
    // mutation, so wrap in a stable object so `.value` keeps its
    // union type at every read site.
    const riskyDenyRef: { value: { pattern: RiskyPattern; iteration: number } | null } = { value: null };
    // G2 — per-iter terminal forward state. Set inside the onUpdate
    // closure when a shell tool_call is detected + successfully written
    // to the user pty; read in the post-turn block to (a) suppress the
    // default 'cancelled' termination and (b) inject a forwarded-marker
    // into the next iteration's prompt.
    const forwardedRef: { value: { command: string; iteration: number } | null } = { value: null };
    // G3 — pending screenshot. Set after a forward when `captureScreenshots`
    // is enabled; consumed at the start of the next iteration to prepend
    // an image ContentBlock to the prompt blocks array. Carries a string
    // base64 payload + mime so the ACP image block construction is
    // straight-line.
    const pendingScreenshotRef: {
      value: { dataB64: string; mediaType: string; iteration: number } | null;
    } = { value: null };

    emitStatus('start', 'running', mission.slice(0, 80));
    if (planActive) {
      emitPlan('start', 0);
    }

    const abortPromise = signal
      ? new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        })
      : null;

    while (iteration < maxIterations) {
      iteration += 1;
      if (signal?.aborted) {
        await this.safelyCancel(runner);
        return finalize({ kind: 'cancelled' }, iteration - 1, totalText);
      }
      // Wall-clock check before the (potentially expensive) prompt fires.
      const elapsedBefore = performance.now() - startedAt;
      if (elapsedBefore > maxWallClockMs) {
        return finalize(
          {
            kind: 'budget',
            budget: 'wallClock',
            observed: Math.round(elapsedBefore),
            limit: maxWallClockMs,
          },
          iteration - 1,
          totalText,
        );
      }
      // Per-iteration boundary status — caller surfaces show progress.
      emitStatus('update', 'running', `iter ${iteration}/${maxIterations}`);

      // D1.4a — Plan-driven prompt override. For iteration N (1-based),
      // use plan.steps[N-1].text if present. Iteration 1 still uses the
      // mission so the first turn carries the original goal context;
      // step 1's text is sent only when the loop advances to iter 2.
      if (planActive && plan && iteration > 1) {
        const stepIdx = iteration - 1; // iter 2 → step index 1 → steps[1]
        if (stepIdx < plan.steps.length) {
          nextPromptText = plan.steps[stepIdx].text;
          emitPlan('update', stepIdx);
        } else {
          // Plan exhausted — terminate with success.
          return finalize(
            { kind: 'success', reason: 'plan complete' },
            iteration - 1,
            totalText,
          );
        }
      } else if (planActive && iteration === 1) {
        // Mark step 0 as in-progress for the mission turn.
        emitPlan('update', 0);
      }

      // PLAN-autopilot-terminal-driving-2026-05-20 v2 Phase B (2026-05-20) —
      // drain pending user mid-mission instructions and prepend each as a
      // synthetic marker BEFORE the prompt text is sent. The order is:
      //   [user injected mid-mission: "<text1>"]
      //   [user injected mid-mission: "<text2>"]
      //   ...
      //   <nextPromptText (mission / plan step / forwarded marker)>
      // Empty drain short-circuits — nextPromptText untouched.
      if (this.cfg.injectionQueue) {
        try {
          const pending = this.cfg.injectionQueue.drain();
          if (pending.length > 0) {
            const markers = pending
              .map((s) => `[user injected mid-mission: "${s.replace(/\n+/g, ' ').slice(0, 500)}"]`)
              .join('\n');
            nextPromptText = `${markers}\n\n${nextPromptText}`;
            emitStatus('update', 'running', `user injected ${pending.length} instruction(s)`);
          }
        } catch {
          // best-effort — injection drain failure must not break the loop
        }
      }

      let iterationText = '';
      // G3 — prepend pending screenshot (from previous iter's forward)
      // as an image block so the LLM sees the resulting terminal state
      // before reading the synthetic text marker. ACP backends with
      // vision (Claude / GPT-4V / Gemini) auto-render; text-only models
      // ignore the block.
      const blocks: ContentBlock[] = [];
      if (pendingScreenshotRef.value) {
        blocks.push({
          type: 'image',
          data: pendingScreenshotRef.value.dataB64,
          mimeType: pendingScreenshotRef.value.mediaType,
        });
        pendingScreenshotRef.value = null;
      }
      blocks.push({ type: 'text', text: nextPromptText });

      try {
        const promptPromise = runner.prompt(blocks, (update: SessionUpdate) => {
          onUpdate?.(update);
          if (
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content?.type === 'text' &&
            typeof update.content.text === 'string'
          ) {
            iterationText += update.content.text;
          }
          // D1.1c — risky tool-call gate. Scan tool_call / tool_call_update
          // payloads. On policy=deny, request cancel + flag for post-turn
          // termination ('risky' kind). Subsequent same-turn updates are
          // ignored to avoid double-firing on tool_call_update streams.
          if (
            !riskyDenyRef.value &&
            (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
          ) {
            const pattern = scanRiskyToolCall(update);
            if (pattern) {
              const decision = riskyPolicy({ pattern, update, iteration });
              if (decision === 'deny') {
                riskyDenyRef.value = { pattern, iteration };
                // Fire-and-forget cancel — the prompt promise resolves
                // with stopReason='cancelled', which we then convert to
                // the 'risky' termination below (precedence over plain
                // cancelled when riskyDeny is set).
                runner.cancel().catch(() => {
                  // best-effort
                });
              }
            }
          }

          // G2 — Terminal Agency intercept. After the risky gate (so
          // dangerous commands never reach the user pty), attempt to
          // extract a shell command from the tool_call payload and
          // forward it to the user's SwiftTerm. Cancel the ACP turn so
          // the backend's own subshell does NOT also run the command.
          if (
            terminalAgency &&
            !forwardedRef.value &&
            !riskyDenyRef.value &&
            (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
          ) {
            const command = extractShellCommand(update);
            if (command) {
              // I1 — Dry-run mode. Skip the actual pty write but mark
              // the iteration as "forwarded" so the loop advances and
              // the next prompt carries the synthetic marker. Caller's
              // logs (debug.log via terminal-forwarder) still note the
              // intended bytes for audit.
              if (terminalAgency.dryRun) {
                forwardedRef.value = { command: `[dry-run] ${command}`, iteration };
                runner.cancel().catch(() => {
                  // best-effort
                });
              } else {
                const r = forwardToUserTerminal({
                  sessionId: terminalAgency.sessionId,
                  terminalId: terminalAgency.terminalId,
                  data: command + (command.endsWith('\n') ? '' : '\n'),
                  source: 'autopilot',
                  origin: `iter-${iteration}`,
                });
                if (r.delivered) {
                  forwardedRef.value = { command, iteration };
                  runner.cancel().catch(() => {
                    // best-effort
                  });
                }
              }
            }
          }
        });

        // Race against caller-supplied abort.
        const raceResult: { stopReason: StopReason } | 'aborted' = abortPromise
          ? await Promise.race([
              promptPromise,
              abortPromise.then(() => 'aborted' as const),
            ])
          : await promptPromise;

        if (raceResult === 'aborted') {
          await this.safelyCancel(runner);
          return finalize({ kind: 'cancelled' }, iteration, totalText);
        }

        const stopReason = raceResult.stopReason;
        totalText += iterationText;
        totalChars += iterationText.length;

        // Phase A — emit per-iteration chat bubble. Role 'thought' for
        // intermediate iterations · 'announce' for the final iteration
        // that ends with stopReason='end_turn' (LLM signalled completion
        // at the model layer). Empty iterationText short-circuits inside
        // emitChatStream — no bubble for tool-only turns.
        const bubbleRole: 'thought' | 'announce' =
          stopReason === 'end_turn' ? 'announce' : 'thought';
        emitChatStream('update', iteration, iterationText, bubbleRole);

        if (riskyDenyRef.value) {
          return finalize(
            {
              kind: 'risky',
              pattern: riskyDenyRef.value.pattern,
              iteration: riskyDenyRef.value.iteration,
            },
            iteration,
            totalText,
          );
        }

        // G2 — forwarded path: the turn was cancelled because we routed
        // the LLM's intended shell command into the user pty. Continue
        // the loop instead of treating it as 'cancelled', and prepend a
        // synthetic marker to the next iteration's prompt so the LLM
        // can reason about the action.
        if (forwardedRef.value) {
          const fwd = forwardedRef.value;
          emitStatus('update', 'running', `forwarded: ${fwd.command.slice(0, 60)}`);
          // G3 — capture terminal state after a delay (give the pty
          // time to render the command echo + first response chunk).
          if (terminalAgency && terminalAgency.captureScreenshots !== false) {
            await this.captureScreenshotForNextTurn(
              terminalAgency,
              pendingScreenshotRef,
              fwd.iteration + 1,
            );
          }
          nextPromptText =
            `${mission}\n\n` +
            `[autopilot forwarded "${fwd.command}" to user terminal in iter ${fwd.iteration}. ` +
            (pendingScreenshotRef.value
              ? `Terminal state PNG attached as the first image block in this prompt.]`
              : `(screenshot capture skipped or failed)]`);
          forwardedRef.value = null;
          continue;
        }

        if (stopReason === 'cancelled') {
          return finalize({ kind: 'cancelled' }, iteration, totalText);
        }

        // Post-turn budget checks — covers fast-cycling cheap turns that
        // would otherwise slip past the pre-turn wallClock gate.
        const elapsedAfter = performance.now() - startedAt;
        if (elapsedAfter > maxWallClockMs) {
          return finalize(
            {
              kind: 'budget',
              budget: 'wallClock',
              observed: Math.round(elapsedAfter),
              limit: maxWallClockMs,
            },
            iteration,
            totalText,
          );
        }
        if (totalChars > maxOutputChars) {
          return finalize(
            {
              kind: 'budget',
              budget: 'outputChars',
              observed: totalChars,
              limit: maxOutputChars,
            },
            iteration,
            totalText,
          );
        }

        if (successPredicate?.(totalText)) {
          return finalize(
            { kind: 'success', reason: 'predicate matched' },
            iteration,
            totalText,
          );
        }

        if (stuckPredicate(iterationText, iteration)) {
          return finalize(
            { kind: 'stuck', iteration, reason: 'stuckPredicate matched' },
            iteration,
            totalText,
          );
        }

        // D1.4a — plan-driven path bypasses the onIterationEnd return
        // value (plan drives `nextPromptText` at iter-start above). The
        // hook still fires for telemetry / observability if provided.
        if (planActive) {
          if (onIterationEnd) {
            onIterationEnd({ iteration, iterationText, totalText, stopReason });
          }
          continue;
        }

        if (!onIterationEnd) {
          return finalize(
            { kind: 'success', reason: 'no follow-up hook' },
            iteration,
            totalText,
          );
        }

        const next = onIterationEnd({
          iteration,
          iterationText,
          totalText,
          stopReason,
        });

        if (next == null || next.trim().length === 0) {
          return finalize(
            { kind: 'success', reason: 'no follow-up' },
            iteration,
            totalText,
          );
        }

        nextPromptText = next;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return finalize({ kind: 'error', message }, iteration, totalText);
      }
    }

    return finalize(
      {
        kind: 'budget',
        budget: 'iterations',
        observed: iteration,
        limit: maxIterations,
      },
      iteration,
      totalText,
    );
  }

  private async safelyCancel(runner: LlmTurnRunner): Promise<void> {
    try {
      await runner.cancel();
    } catch {
      // best-effort — cancel is idempotent on the server side
    }
  }

  /**
   * G3 — Capture the user pty's current visual state into a base64 PNG
   * so the next iteration's prompt can carry it as an inline image
   * block. Caller-supplied delay gives the pty time to echo the
   * forwarded command + flush its first response. Best-effort — all
   * errors are swallowed (logged) and the next prompt falls back to
   * text-only.
   */
  private async captureScreenshotForNextTurn(
    agency: TerminalAgencyConfig,
    ref: { value: { dataB64: string; mediaType: string; iteration: number } | null },
    iteration: number,
  ): Promise<void> {
    const delay = agency.captureDelayMs ?? 500;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      const { dispatchWebTerminalScreenshot } = await import(
        '../tool-runtime/web-terminal-screenshot.js'
      );
      const shot = await dispatchWebTerminalScreenshot({
        sessionId: agency.sessionId,
        terminalId: agency.terminalId,
        scale: agency.captureScale ?? 2,
      });
      ref.value = {
        dataB64: shot.dataB64,
        mediaType: shot.mediaType,
        iteration,
      };
    } catch {
      // best-effort — leave ref null so the prompt falls back to text-only
      ref.value = null;
    }
  }
}

/**
 * G4 — Default guidance text injected into the first prompt when
 * `terminalAgency.injectGuidance` is truthy. Teaches the LLM how to
 * compose raw byte sequences for the user pty — keyboard control
 * codes, vim/tmux idioms, SGR mouse encoding. Exported for test +
 * doc round-trip; callers that need a custom prompt pass a string.
 */
export const DEFAULT_TERMINAL_AGENCY_GUIDANCE = `[Terminal Agency mode]
You are typing directly into the user's interactive terminal — same
shell, same cwd, same env, same open editor/multiplexer state as the
user sees on screen. After each shell tool_call the daemon forwards
the command bytes into the user's pty and cancels your sub-shell,
then captures a PNG of the resulting terminal state which arrives as
the first image block of the *next* message. Reflect on that image
before issuing the next command.

Sending raw bytes (control codes, escape sequences, mouse signals)
via the Bash tool — wrap the bytes in printf and avoid quoting that
mangles them:

  printf '\\\\e'                       # ESC (start of any CSI seq)
  printf '\\\\e:wq\\\\n'                # vim :wq + Enter
  printf '\\\\x03'                     # Ctrl-C
  printf '\\\\x04'                     # Ctrl-D (EOF)
  printf '\\\\x0c'                     # Ctrl-L (clear / redraw)
  printf '\\\\e[A'                     # up arrow
  printf '\\\\e[1;5C'                  # Ctrl+Right (word jump)
  printf '\\\\e[5~'                    # PgUp
  printf '\\\\eOP'                     # F1

For TUI editors:
  vim/nvim   — :w :q :wq · / search · :%s/foo/bar/g · v V <C-v> visual
  tmux       — default prefix C-b (\\\\x02): "\\\\x02c" new window,
                "\\\\x02%" split-h, "\\\\x02\\"" split-v, "\\\\x02n/p" cycle
  less       — q to quit, / search, n/N next/prev, g/G top/bottom
  git rebase -i — e/s/r/d/p in pick list, then :wq

For mouse-aware apps (htop, vim with set mouse=a, less with --mouse,
tmux with mouse on) — emit SGR mouse encoding (Cap. 1006):

  printf '\\\\e[<0;%d;%dM' COL ROW    # left-button DOWN at (col,row)
  printf '\\\\e[<0;%d;%dm' COL ROW    # left-button UP at (col,row)
  printf '\\\\e[<2;%d;%dM' COL ROW    # right-button DOWN
  printf '\\\\e[<64;%d;%dM' COL ROW   # scroll-up
  printf '\\\\e[<65;%d;%dM' COL ROW   # scroll-down

Column + row are 1-based (top-left = 1,1). Estimate from the screenshot.

Safety rails (daemon-enforced — you cannot bypass):
  - rm -rf, sudo, git push --force, dd of=/dev/*, curl | bash etc. are
    blocked before reaching the pty
  - The user can take over at any time by typing or tapping the
    terminal — your loop will be cancelled

Conventions:
  - One shell tool_call per turn. The daemon forwards + screenshots.
  - You do NOT see stdout via tool_result — only the screenshot. Plan
    for that. If you need an explicit value, run a command that prints
    it (\`pwd\`, \`echo \$PATH\`) and read it from the screenshot.
  - When the task is complete say so explicitly so the loop terminates.`;

/**
 * Resolve the runtime guidance string. `true` / undefined → default,
 * string → that exact text, `false` → empty (caller short-circuits
 * before calling). Kept in sync with the
 * \`TerminalAgencyConfig.injectGuidance\` doc above.
 */
export function resolveGuidanceText(option: boolean | string | undefined): string {
  if (typeof option === 'string') return option;
  if (option === false) return '';
  return DEFAULT_TERMINAL_AGENCY_GUIDANCE;
}

/**
 * G2 — Best-effort shell-command extraction from a `tool_call` /
 * `tool_call_update` SessionUpdate. Different ACP backends advertise
 * shell tools under different names + arg shapes, so the helper probes
 * the common spots:
 *   - `update.toolName` matches `/bash|shell|exec/i` → `update.rawInput.command`
 *   - `update.toolUseBlock.input.command` (Anthropic SDK shape)
 *   - `update.toolCall.rawInput.command` (some claude-code-acp builds)
 *   - `update.input.command` (defensive)
 *
 * Returns `null` when no shell command can be extracted — caller should
 * leave the tool_call to its normal ACP path. Exported for unit tests.
 */
export function extractShellCommand(update: unknown): string | null {
  if (!update || typeof update !== 'object') return null;
  const u = update as Record<string, unknown>;
  const toolName =
    typeof u.toolName === 'string'
      ? u.toolName
      : typeof u.title === 'string'
        ? u.title
        : undefined;
  const looksShell = toolName ? /\b(bash|shell|exec|terminal)\b/i.test(toolName) : true;
  // probe common rawInput shapes
  const candidates: Array<unknown> = [
    (u as { rawInput?: { command?: unknown } }).rawInput?.command,
    (u as { toolUseBlock?: { input?: { command?: unknown } } }).toolUseBlock?.input?.command,
    (u as { toolCall?: { rawInput?: { command?: unknown } } }).toolCall?.rawInput?.command,
    (u as { input?: { command?: unknown } }).input?.command,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0 && looksShell) {
      return c;
    }
  }
  return null;
}

/**
 * Convenience factory — single-shot mission. Equivalent to
 * `new AutopilotLoopDriver({ ..., maxIterations: 1 }).run()`.
 *
 * Useful for D1 smoke tests + spike harness validation.
 */
export async function runMissionOnce(
  runner: LlmTurnRunner,
  sessionId: SessionId,
  mission: string,
  onUpdate?: (update: SessionUpdate) => void,
): Promise<AutopilotResult> {
  const driver = new AutopilotLoopDriver({
    runner,
    sessionId,
    mission,
    maxIterations: 1,
    onUpdate,
  });
  return driver.run();
}
