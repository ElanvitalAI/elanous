import type { ApprovalOutcome } from '../graph-runner/approval-outcome.js';
import type { MessageSource } from '../session/index.js';
import { safeAgentSummary, safeToolActivityTarget } from '../tui/chat/tool-activity.js';
import { parsePlanWire, type PlanWire } from '../code-edit/plan-wire.js';
import { isGraphProgressObservation, type GraphProgressObservation } from '../graph-runner/graph-progress-observation.js';
/** Keep one REPL child per session so background tasks and their completion queue survive turns. */
import type { NextTuiCompactDeps, NextTuiCompactOutcome } from '../tui/slash/compact.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { sessionFile, sessionRoot } from '../session/index.js';
import { NEXT_TUI_WAKEUP_IPC_ENV, answerWakeupCall, isWakeupCallMessage, nextTuiWakeupTool } from './next-wakeup.js';
import { isNextTuiSelfHealthSnapshot, type NextTuiSelfHealthSnapshot } from '../tui/chat/self-health-status.js';
import { answerNextSidetabCall, gateNextSidetabHandler, isNextSidetabCall, type NextSidetabHandler } from '../tui/sidetab/nl-tool.js';
import type { AgentDisplayEvent } from '../tui/core/agents.js';
import type { MessageBlock } from '../conv-substrate/message-block.js';
import type { MeasuredTurnUsage } from '../session/turn-usage.js';
import {
  answerShellApprovalCall,
  isShellApprovalCallMessage,
  isShellApprovalCancelMessage,
  NEXT_TUI_SHELL_APPROVAL_IPC_ENV,
  publishApprovalOf,
  type PublishApprovalCall,
  SHELL_APPROVAL_CANCEL_TYPE,
} from './next-shell-approval.js';
import { answerHarnessAskUserCall, HARNESS_ASK_USER_IPC_ENV, isHarnessAskUserCall,
  isHarnessAskUserCancel, type HarnessAskUserCall } from './next-harness-ask-user.js';
import { getSessionTierOverride } from '../model-tier/session-override.js';
import { configForSessionProviderTurn, getSessionProvider, sessionProviderChildEnv } from './session-provider.js';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnElanousBun } from '../instance/spawn-elanous.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { debug } from '../debug/log.js';
import { SHELL_KILL_GRACE_MS, SHELL_SNAPSHOT_REPLY_TIMEOUT_MS } from '../tool-runtime/shell-watchdog.js';
import { answerMemberBoardSessionCall, isMemberBoardSessionCall, type MemberBoardSessionSource } from './next-member-board-session.js';

const STATUS_PREFIX = 'ELANOUS_TUI_BG_STATUS\t';
let nextSidetabHandler: NextSidetabHandler | null = null;
let nextSidetabIpcEnabled = false;
let nextTuiShellApprovalHandler: ((command: string, callId: string, kind: 'bash' | 'graph', windowMs?: number) => Promise<boolean | ApprovalOutcome>) | null = null;
let nextTuiShellApprovalCancelHandler: ((callId: string, reason: 'timeout' | 'turn-cancelled' | 'host-cancelled') => void) | null = null;
let nextTuiHarnessAskUserHandler: ((call: HarnessAskUserCall) => Promise<string | null>) | null = null;
let nextTuiHarnessAskUserCancelHandler: ((callId: string) => void) | null = null;
let nextMemberBoardSessionSource: MemberBoardSessionSource | null = null;

/** The Next host supplies only its existing authenticated member session. */
export function setNextMemberBoardSessionSource(source: MemberBoardSessionSource | null): void {
  nextMemberBoardSessionSource = source;
}

export function setNextSidetabHandler(handler: NextSidetabHandler | null): void {
  nextSidetabHandler = handler;
}

/** The Next TUI host enables this before any sticky REPL child is created. */
export function setNextSidetabIpcEnabled(enabled: boolean): void {
  nextSidetabIpcEnabled = enabled;
}

/** Installs the human-facing approval prompt before a sticky REPL child is created. */
let nextTuiPublishApprovalHandler: ((call: PublishApprovalCall, callId: string) => Promise<boolean>) | null = null;
/** The host's owner publish-approval screen; without one the same request falls back to the plain text confirmation. */
export function setNextTuiPublishApprovalHandler(handler: ((call: PublishApprovalCall, callId: string) => Promise<boolean>) | null): void {
  nextTuiPublishApprovalHandler = handler;
}

export function setNextTuiShellApprovalHandler(handler: ((command: string, callId: string, kind: 'bash' | 'graph', windowMs?: number) => Promise<boolean | ApprovalOutcome>) | null): void {
  nextTuiShellApprovalHandler = handler;
}

/** Closes the matching host prompt when the child times out or its turn is cancelled. */
export function setNextTuiShellApprovalCancelHandler(
  handler: ((callId: string, reason: 'timeout' | 'turn-cancelled' | 'host-cancelled') => void) | null,
): void {
  nextTuiShellApprovalCancelHandler = handler;
}

export function setNextTuiHarnessAskUserHandler(handler: ((call: HarnessAskUserCall) => Promise<string | null>) | null,
  cancel: ((callId: string) => void) | null): void {
  nextTuiHarnessAskUserHandler = handler;
  nextTuiHarnessAskUserCancelHandler = cancel;
}

interface TurnResult {
  event?: string | null;
  graphProgress?: unknown;
  turnId?: string | null;
  id?: string;
  phase?: string;
  description?: string;
  status?: string;
  sessionId?: string;
  text?: string;
  /** Origin is a display classification, not a final-answer or authentication claim. */
  source?: unknown;
  error?: string;
  provider?: string;
  model?: string | null;
  goalComplete?: boolean;
  goalStopReason?: string;
  /** The turn's plan state as the REPL child sees it (untrusted until parsePlanWire). */
  planOutcome?: unknown;
  name?: string;
  target?: string;
  startedAtMonotonicMs?: number;
  calls?: unknown;
  requestId?: string;
  outcome?: string;
  activeTools?: unknown;
  steerIds?: unknown;
  selfHealth?: NextTuiSelfHealthSnapshot | null;
  usage?: MeasuredTurnUsage;
  block?: MessageBlock;
}

/** Accept only provider-measured fields from the matching child frame. */
export function isMeasuredTurnUsage(value: unknown): value is MeasuredTurnUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  if (!Object.keys(usage).every((key) => key === 'inputTokens' || key === 'outputTokens')) return false;
  return ['inputTokens', 'outputTokens'].some((key) => usage[key] !== undefined)
    && ['inputTokens', 'outputTokens'].every((key) => {
      const count = usage[key];
      return count === undefined || (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0);
    });
}
export type LocalChatToolActivity =
  | { phase: 'start' | 'finish'; id: string; name: string; target?: string; summary?: string }
  | { phase: 'snapshot'; calls: Array<{ id: string; name: string; target?: string }> };
export type LocalChatPushNowResult = { requestId: string; outcome: 'ready' | 'interrupted' | 'deferred'; activeTools: string[] };
interface WaitingTurn {
  turnId: string;
  /** The user's text for this turn; side-tab calls are honoured only when it asks for one. */
  userText?: string;
  onGraphProgress?: (event: GraphProgressObservation) => void;
  onDelta?: (text: string, replace?: boolean, source?: 'assistant-text') => void;
  onStatus?: (text: string) => void;
  onAgent?: (event: AgentDisplayEvent) => void;
  onMessageBlock?: (block: MessageBlock) => void;
  onShellActivity?: (event:
    | { phase: 'start'; id: string; name: 'Bash' | 'RunShell'; startedAtMonotonicMs: number }
    | { phase: 'finish'; id: string; name: 'Bash' | 'RunShell' }
    | { phase: 'snapshot'; calls: Array<{ id: string; name: 'Bash' | 'RunShell'; startedAtMonotonicMs: number }> }
  ) => void;
  onToolActivity?: (event: LocalChatToolActivity) => void;
  onPushNowResult?: (event: LocalChatPushNowResult) => void;
  onMeasuredUsage?: (usage: MeasuredTurnUsage) => void;
  usageSeen?: boolean;
  /** A201 — Esc snapshot request still waiting for the child's reply. */
  snapshotDeadline?: ReturnType<typeof setTimeout>;
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
}

class LocalChatSession {
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly exited: Promise<number>;
  readonly instanceRoot: string;
  /** Session provider choice baked into the child env (HARNESS-CHILD-PROVIDER-PASSTHROUGH). */
  readonly providerKey: string;
  private readonly writeInput: (payload: string) => Promise<void>;
  private waiting: WaitingTurn | null = null;
  private stderrTail = '';
  private closed = false;
  private closing: Promise<void> | null = null;
  private invalidated = false;
  private turnCount = 0;
  private readonly pendingShellApprovalIds = new Set<string>();
  private readonly pendingHarnessAskUserIds = new Set<string>();

  constructor(private readonly sessionId: string, cli: string) {
    this.instanceRoot = effectiveInstanceRoot();
    // TUI-NEXT-QUEUE-AND-WAKE: the child's ScheduleWakeup asks this process over Bun IPC — the scheduler
    // lives here because the child dies on Esc and /new. No tool registered → no IPC, env unchanged.
    const wakeupTool = nextTuiWakeupTool();
    const fastChild = fileURLToPath(new URL('./fast-repl-child.ts', import.meta.url));
    const useFastChild = cli.endsWith('/bin/elanous.mjs') && existsSync(fastChild);
    const sessionSelection = getSessionProvider(sessionId);
    const providerPassthrough = sessionProviderChildEnv(sessionSelection);
    this.providerKey = providerPassthrough.key;
    try {
      debug.log('child.provider', 'resolve', {
        mode: 'passthrough', kind: 'repl-child', sessionId,
        parentProvider: sessionSelection?.provider ?? null, parentModel: sessionSelection?.model ?? null,
        childProvider: providerPassthrough.env.ELANOUS_LLM_PROVIDER ?? process.env.ELANOUS_LLM_PROVIDER ?? null,
        childModel: providerPassthrough.env.ELANOUS_LLM_MODEL ?? process.env.ELANOUS_LLM_MODEL ?? null,
        source: sessionSelection ? 'session' : process.env.ELANOUS_LLM_PROVIDER ? 'env' : 'config',
      });
    } catch { /* observation cannot block the child */ }
    this.child = spawnElanousBun(
      useFastChild
        ? [sessionId, getElanousConfigDir()]
        // `--next-tui`: the structured Next TUI flag (CHAT-TOOLS-ENTRY-VIA-CORE-TURN) — the plain REPL never sets it.
        : ['--config-dir', getElanousConfigDir(), 'repl', '--session', sessionId, '--json', '--stdin-jsonl', '--next-tui'],
      {
      bin: useFastChild ? fastChild : cli,
      stateDir: this.instanceRoot,
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env, ...providerPassthrough.env, ELANOUS_NEXT_TUI_BG_STATUS: '1', ELANOUS_NEXT_TUI_STREAM: '1',
        ...(process.env.NODE_ENV === 'test' ? { ELANOUS_SESSION_ROOT: sessionRoot() } : {}),
        ELANOUS_NEXT_TUI_SELF_HEALTH: '1',
        ...(wakeupTool ? { [NEXT_TUI_WAKEUP_IPC_ENV]: '1' } : {}),
        // The Next TUI explicitly enables this before child startup. The
        // callback itself stays live so a child created before handler wiring
        // can still serve the host once it is installed.
        ELANOUS_NEXT_TUI_SIDETAB_IPC: nextSidetabIpcEnabled ? '1' : '0',
        // The child may be created before the UI callback is installed. Always
        // enable the approval boundary; an absent parent handler answers deny.
        [NEXT_TUI_SHELL_APPROVAL_IPC_ENV]: '1',
        [HARNESS_ASK_USER_IPC_ENV]: '1',
      },
      ipc: (message: unknown, child: { send(message: unknown): unknown }) => {
          if (isMemberBoardSessionCall(message)) {
            try { child.send(answerMemberBoardSessionCall(nextMemberBoardSessionSource, message)); }
            catch { /* the child exited before the reply */ }
          } else if (wakeupTool && isWakeupCallMessage(message)) {
            void answerWakeupCall(wakeupTool, message).then((reply) => {
              try { child.send(reply); } catch { /* the child exited mid-call; its dispatch times out */ }
            });
          } else if (isNextSidetabCall(message)) {
            const handler = nextSidetabHandler ?? (async () => ({ error: 'Next TUI sidetab handler is not ready' }));
            // TUI-NO-UNREQUESTED-SIDETAB: the model may not open side tabs the user never asked for.
            void answerNextSidetabCall(gateNextSidetabHandler(handler, this.waiting?.userText), message).then((reply) => {
              try { child.send(reply); } catch { /* the child exited mid-call; its dispatch times out */ }
            });
          } else if (isShellApprovalCancelMessage(message)) {
            this.pendingShellApprovalIds.delete(message.callId);
            try { nextTuiShellApprovalCancelHandler?.(message.callId, message.reason); }
            catch { /* cancellation bookkeeping cannot break the child */ }
          } else if (isHarnessAskUserCancel(message) && message.sessionId === this.sessionId) {
            this.pendingHarnessAskUserIds.delete(message.callId);
            nextTuiHarnessAskUserCancelHandler?.(message.callId);
          } else if (isHarnessAskUserCall(message) && message.sessionId === this.sessionId) {
            this.pendingHarnessAskUserIds.add(message.callId);
            void answerHarnessAskUserCall(nextTuiHarnessAskUserHandler, message).then(reply => {
              this.pendingHarnessAskUserIds.delete(message.callId);
              try { child.send(reply); } catch { /* child exited during interview */ }
            });
          } else if (isShellApprovalCallMessage(message)) {
            this.pendingShellApprovalIds.add(message.callId);
            const publish = publishApprovalOf(message);
            void answerShellApprovalCall(publish && nextTuiPublishApprovalHandler
              ? (_command, callId) => nextTuiPublishApprovalHandler!(publish, callId)
              : nextTuiShellApprovalHandler
                ? (command, callId) => nextTuiShellApprovalHandler!(command, callId, message.kind === 'graph' ? 'graph' : 'bash', message.windowMs)
                : null, message).then((reply) => {
              this.pendingShellApprovalIds.delete(message.callId);
              try { child.send(reply); } catch { /* the child exited mid-approval; its request times out */ }
            });
          }
      },
    });
    const input = this.child.stdin;
    const output = this.child.stdout;
    const errors = this.child.stderr;
    if (!input || typeof input === 'number' || !output || typeof output === 'number'
      || !errors || typeof errors === 'number') throw new Error('REPL pipe unavailable');
    this.writeInput = async (payload) => { input.write(payload); await input.flush(); };
    this.exited = this.child.exited;
    let stdoutClosedWhileAlive = false;
    let stderrReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const stderrDrained = this.readLines(errors, (line) => {
      if (line.startsWith(STATUS_PREFIX)) {
        for (const listener of statusListeners.get(sessionId) ?? []) {
          try { listener(line.slice(STATUS_PREFIX.length)); } catch { /* status observers cannot break the turn */ }
        }
      } else if (line.trim()) {
        this.stderrTail = line.trim();
      }
    }, undefined, (reader) => { stderrReader = reader; });
    const drainStderrAfterExit = async (): Promise<void> => {
      // A grandchild can inherit stderr after the REPL has exited. Preserve
      // buffered guidance, but never make a turn wait for that grandchild.
      const drained = await Promise.race([
        stderrDrained.then(() => true),
        Bun.sleep(100).then(() => false), // Source: #36702 — bounded post-exit stderr drain.
      ]);
      if (!drained) void stderrReader?.cancel().catch(() => { /* inherited pipe may already be gone */ });
    };
    void this.readLines(output, (line) => {
      if (!line.trim()) return;
      let result: TurnResult;
      try { result = JSON.parse(line) as TurnResult; }
      catch { this.fail(new Error(`invalid REPL JSONL response: ${line.slice(0, 160)}`)); return; }
      if (result.event === 'self-health') {
        const waiting = this.waiting;
        if (!waiting || result.turnId !== waiting.turnId || result.sessionId !== this.sessionId
          || !isNextTuiSelfHealthSnapshot(result.selfHealth) || result.selfHealth.sessionId !== this.sessionId) return;
        const snapshot = Object.freeze(result.selfHealth);
        for (const listener of selfHealthListeners.get(this.sessionId) ?? []) {
          try { listener(snapshot); } catch { /* status observers cannot break the turn */ }
        }
        return;
      }
      const waiting = this.waiting;
      if (!waiting) return;
      if ('turnId' in result && result.turnId !== waiting.turnId) return;
      if (result.event === 'usage-complete') {
        if (waiting.usageSeen || result.turnId !== waiting.turnId || result.sessionId !== this.sessionId || !isMeasuredTurnUsage(result.usage)) return;
        waiting.usageSeen = true;
        try { waiting.onMeasuredUsage?.(result.usage); } catch { /* display cannot break the turn */ }
        return;
      }
      if (result.event === 'delta') {
        if (result.turnId !== waiting.turnId) return;
        if (typeof result.text === 'string') {
          try { waiting.onDelta?.(result.text, undefined, result.source === 'assistant-text' ? 'assistant-text' : undefined); } catch { /* renderer cannot break the turn */ }
        }
        return;
      }
      if (result.event === 'replace') {
        if (result.turnId === waiting.turnId && typeof result.text === 'string') {
          try { waiting.onDelta?.(result.text, true); } catch { /* renderer cannot break the turn */ }
        }
        return;
      }
      if (result.event === 'status') {
        if (result.turnId === waiting.turnId && typeof result.text === 'string') {
          try { waiting.onStatus?.(result.text); } catch { /* renderer cannot break the turn */ }
        }
        return;
      }
      if (result.event === 'graph-progress') {
        if (result.turnId !== waiting.turnId || !isGraphProgressObservation(result.graphProgress)) return;
        try { waiting.onGraphProgress?.(result.graphProgress); } catch { /* display cannot break the turn */ }
        return;
      }
      if (result.event === 'agent') {
        if (result.turnId !== waiting.turnId || typeof result.id !== 'string' || !result.id) return;
        const event: AgentDisplayEvent | null = result.phase === 'start'
          ? { phase: 'start', id: result.id, ...(typeof result.description === 'string' ? { description: result.description } : {}) }
          : result.phase === 'finish' && (result.status === 'done' || result.status === 'failed' || result.status === 'background')
            ? { phase: 'finish', id: result.id, status: result.status }
            : null;
        if (event) try { waiting.onAgent?.(event); } catch { /* display cannot break the turn */ }
        return;
      }
      if (result.event === 'message-block') {
        if (result.turnId !== waiting.turnId || !result.block || typeof result.block.id !== 'string') return;
        try { waiting.onMessageBlock?.(result.block); } catch { /* renderer cannot break the turn */ }
        return;
      }
      if (result.event === 'shell-activity') {
        if (result.turnId !== waiting.turnId
          || (result.phase !== 'start' && result.phase !== 'finish' && result.phase !== 'snapshot')) return;
        if (result.phase === 'snapshot') {
          if (!Array.isArray(result.calls)) return;
          if (waiting.snapshotDeadline) { clearTimeout(waiting.snapshotDeadline); waiting.snapshotDeadline = undefined; }
          const calls = result.calls.filter((call): call is { id: string; name: 'Bash' | 'RunShell'; startedAtMonotonicMs: number } =>
            call !== null && typeof call === 'object' && typeof (call as { id?: unknown }).id === 'string'
            && ((call as { name?: unknown }).name === 'Bash' || (call as { name?: unknown }).name === 'RunShell')
            && typeof (call as { startedAtMonotonicMs?: unknown }).startedAtMonotonicMs === 'number'
            && Number.isFinite((call as { startedAtMonotonicMs: number }).startedAtMonotonicMs));
          try { waiting.onShellActivity?.({ phase: 'snapshot', calls }); }
          catch { /* cancellation bookkeeping cannot break a turn */ }
          return;
        }
        if (typeof result.id !== 'string' || (result.name !== 'Bash' && result.name !== 'RunShell')) return;
        if (result.phase === 'start') {
          if (typeof result.startedAtMonotonicMs !== 'number' || !Number.isFinite(result.startedAtMonotonicMs)) return;
          try { waiting.onShellActivity?.({ phase: 'start', id: result.id, name: result.name, startedAtMonotonicMs: result.startedAtMonotonicMs }); }
          catch { /* cancellation bookkeeping cannot break a turn */ }
          return;
        }
        try { waiting.onShellActivity?.({ phase: 'finish', id: result.id, name: result.name }); }
        catch { /* cancellation bookkeeping cannot break a turn */ }
        return;
      }
      if (result.event === 'tool-activity') {
        if (result.turnId !== waiting.turnId) return;
        if (result.phase === 'snapshot') {
          if (!Array.isArray(result.calls)) return;
          const calls = result.calls.filter((call): call is { id: string; name: string } =>
            call !== null && typeof call === 'object' && typeof (call as { id?: unknown }).id === 'string'
            && typeof (call as { name?: unknown }).name === 'string');
          try { waiting.onToolActivity?.({ phase: 'snapshot', calls: calls.map(call => ({ ...call,
            target: safeToolActivityTarget(call.name, (call as { target?: unknown }).target) })) }); } catch { /* observer cannot break a turn */ }
        } else if ((result.phase === 'start' || result.phase === 'finish')
          && typeof result.id === 'string' && typeof result.name === 'string') {
          const summary = result.phase === 'finish' && result.name === 'Agent' ? safeAgentSummary((result as { summary?: unknown }).summary) : undefined;
          try { waiting.onToolActivity?.({ phase: result.phase, id: result.id, name: result.name,
            target: safeToolActivityTarget(result.name, result.target), ...(summary ? { summary } : {}) }); }
          catch { /* observer cannot break a turn */ }
        }
        return;
      }
      if (result.event === 'steer-applied') {
        if (result.turnId !== waiting.turnId || !Array.isArray(result.steerIds)
          || !result.steerIds.every((steerId) => typeof steerId === 'string')) return;
        for (const listener of steerAppliedListeners.get(this.sessionId) ?? []) {
          try { listener(result.steerIds as string[]); } catch { /* observers cannot break a turn */ }
        }
        return;
      }
      if (result.event === 'push-now-result') {
        if (result.turnId !== waiting.turnId || typeof result.requestId !== 'string'
          || (result.outcome !== 'ready' && result.outcome !== 'interrupted' && result.outcome !== 'deferred')
          || !Array.isArray(result.activeTools) || !result.activeTools.every((name) => typeof name === 'string')) return;
        try { waiting.onPushNowResult?.({ requestId: result.requestId, outcome: result.outcome, activeTools: result.activeTools as string[] }); }
        catch { /* observer cannot break a turn */ }
        return;
      }
      // Future side-channel events cannot complete a turn. Legacy final
      // frames have no event; typed final frames use event=result.
      if ('event' in result && result.event !== 'result') return;
      try { debug.log('tui.local-chat', 'result-frame-accepted', { sessionId: this.sessionId, turnId: waiting.turnId, event: result.event ?? 'legacy' }); }
      catch { /* observation cannot break an accepted turn */ }
      this.waiting = null;
      waiting.resolve(result);
    }, () => {
      // An onboarding refusal exits before the first JSONL frame. stdout can
      // close before its actionable stderr line is delivered to this reader.
      // Reap a child that closed stdout but stayed alive, then use drained stderr.
      void (async () => {
        await Promise.race([this.exited, Bun.sleep(50)]);
        if (!this.closed) {
          stdoutClosedWhileAlive = true;
          try { this.child.kill(); } catch { /* already exited */ }
        }
        await this.exited;
        await drainStderrAfterExit();
        this.fail(new Error(this.stderrTail || 'REPL stdout closed'));
        void this.close();
      })();
    });
    void this.exited.then(async (code) => {
      this.closed = true;
      this.invalidate();
      if (sessions.get(sessionId) === this) sessions.delete(sessionId);
      await drainStderrAfterExit();
      this.fail(new Error(this.stderrTail || (stdoutClosedWhileAlive ? 'REPL stdout closed' : `chat exit ${code}`)));
    });
  }

  private async readLines(
    stream: ReadableStream<Uint8Array>, receive: (line: string) => void, onEnd?: () => void,
    onReader?: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
  ): Promise<void> {
    const reader = stream.getReader();
    onReader?.(reader);
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          receive(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer) receive(buffer);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      reader.releaseLock();
      onEnd?.();
    }
  }

  private fail(error: Error): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(error);
  }

  private invalidate(): void {
    if (this.invalidated) return;
    this.invalidated = true;
    for (const listener of statusListeners.get(this.sessionId) ?? []) {
      try { listener(null); } catch { /* status observers cannot break teardown */ }
    }
    for (const listener of selfHealthListeners.get(this.sessionId) ?? []) {
      try { listener(null); } catch { /* status observers cannot break teardown */ }
    }
  }

  async turn(prompt: string, writePrompt?: (payload: string) => Promise<void>, onDelta?: (text: string, replace?: boolean, source?: 'assistant-text') => void, attachments: readonly string[] = [], onStatus?: (text: string) => void, onAgent?: (event: AgentDisplayEvent) => void, onMessageBlock?: (block: MessageBlock) => void, onShellActivity?: WaitingTurn['onShellActivity'], onToolActivity?: WaitingTurn['onToolActivity'], onPushNowResult?: WaitingTurn['onPushNowResult'], onMeasuredUsage?: WaitingTurn['onMeasuredUsage'], onGraphProgress?: WaitingTurn['onGraphProgress'], from?: MessageSource): Promise<TurnResult> {
    if (this.closed) throw new Error('REPL child exited');
    if (this.waiting) throw new Error('REPL turn already running');
    const turnId = `tui-${++this.turnCount}`;
    const modelTier = getSessionTierOverride(this.sessionId)?.llm;
    const providerSelection = getSessionProvider(this.sessionId);
    const payload = JSON.stringify({ prompt, id: turnId, ...(modelTier ? { modelTier } : {}),
      ...(providerSelection ? { sessionProvider: providerSelection } : {}),
      ...(attachments.length ? { attachments } : {}),
      // MSG-SOURCE-HIERARCHY: the child persists who sent the turn; a human turn sends nothing (human is the default).
      ...(from && from.kind !== 'human' ? { from } : {}) }) + '\n';
    const response = new Promise<TurnResult>((resolve, reject) => { this.waiting = { turnId, userText: prompt, onDelta, onStatus, onAgent, onMessageBlock, onShellActivity, onToolActivity, onPushNowResult, onMeasuredUsage, onGraphProgress, resolve, reject }; });
    try {
      if (writePrompt) await writePrompt(payload);
      else await this.writeInput(payload);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
    return response;
  }

  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = (async () => {
        if (!this.closed) {
          this.closed = true;
          this.invalidate();
          for (const callId of this.pendingShellApprovalIds) {
            try {
              this.child.send({ type: SHELL_APPROVAL_CANCEL_TYPE, callId, reason: 'turn-cancelled' });
              nextTuiShellApprovalCancelHandler?.(callId, 'turn-cancelled');
            } catch { /* the child may already be exiting */ }
          }
          this.pendingShellApprovalIds.clear();
          for (const callId of this.pendingHarnessAskUserIds) nextTuiHarnessAskUserCancelHandler?.(callId);
          this.pendingHarnessAskUserIds.clear();
          try { this.child.kill(); } catch { /* already exited */ }
          // A201 — a wedged child (blocked loop or a SIGTERM handler that never runs) must not
          // hold «응답 취소 중» forever: escalate to SIGKILL on this exact child after the grace.
          const escalate = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* already exited */ } }, SHELL_KILL_GRACE_MS);
          escalate.unref?.();
          void this.exited.finally(() => clearTimeout(escalate));
        }
        await this.exited;
      })();
    }
    await this.closing;
  }

  requestShellActivitySnapshot(): boolean {
    if (this.closed || !this.waiting) return false;
    const waiting = this.waiting;
    try { this.child.send({ type: 'elanous.next-tui.shell-snapshot', turnId: waiting.turnId }); }
    catch { return false; }
    // A201 — the 63-minute «셸 실행 상태 확인 중 · Esc» stall: the child never answered and Esc was
    // swallowed while the request stayed pending. Bound the wait; a silent child counts as stalled,
    // so hand the host an empty snapshot and its Esc path cancels the turn (and closes this child).
    if (waiting.snapshotDeadline) clearTimeout(waiting.snapshotDeadline);
    waiting.snapshotDeadline = setTimeout(() => {
      waiting.snapshotDeadline = undefined;
      if (this.waiting !== waiting) return;
      try {
        debug.log('tool.watchdog', 'snapshot-timeout', { sessionId: this.sessionId, turnId: waiting.turnId,
          limitMs: SHELL_SNAPSHOT_REPLY_TIMEOUT_MS, pid: this.child.pid ?? null });
      } catch { /* observation cannot block cancellation */ }
      try { waiting.onStatus?.(`셸 상태 응답 없음 — ${Math.round(SHELL_SNAPSHOT_REPLY_TIMEOUT_MS / 1000)}초 → 중단`); }
      catch { /* display cannot block cancellation */ }
      try { waiting.onShellActivity?.({ phase: 'snapshot', calls: [] }); }
      catch { /* cancellation bookkeeping cannot break a turn */ }
    }, SHELL_SNAPSHOT_REPLY_TIMEOUT_MS);
    waiting.snapshotDeadline.unref?.();
    return true;
  }
  requestPushNow(requestId: string): boolean {
    if (this.closed || !this.waiting) return false;
    try { this.child.send({ type: 'elanous.next-tui.push-now', turnId: this.waiting.turnId, requestId }); return true; }
    catch { return false; }
  }
  commitPushNow(requestId: string): boolean {
    if (this.closed || !this.waiting) return false;
    try { this.child.send({ type: 'elanous.next-tui.push-now-commit', turnId: this.waiting.turnId, requestId }); return true; }
    catch { return false; }
  }
  /** A200 — hand input typed during this turn to the child; it joins the next model request. */
  requestSteer(steerId: string, text: string): boolean {
    if (this.closed || !this.waiting) return false;
    try { this.child.send({ type: 'elanous.next-tui.steer', turnId: this.waiting.turnId, steerId, text }); return true; }
    catch { return false; }
  }
  retractSteer(steerIds: readonly string[]): boolean {
    if (this.closed || !this.waiting || steerIds.length === 0) return false;
    try { this.child.send({ type: 'elanous.next-tui.steer-retract', turnId: this.waiting.turnId, steerIds: [...steerIds] }); return true; }
    catch { return false; }
  }
  requestTaskStop(taskId: string): boolean {
    if (this.closed) return false;
    try { this.child.send({ type: 'elanous.next-tui.task-stop', sessionId: this.sessionId, taskId }); return true; }
    catch { return false; }
  }
}

const sessions = new Map<string, LocalChatSession>();
/** Model the child last answered with, per session — sizes the next pre-turn compaction check. */
const lastModels = new Map<string, string>();

export function localChatModel(sessionId: string): string | null {
  return lastModels.get(sessionId) ?? null;
}

/** TUI-NEXT-COMPACT — pre-turn auto compaction hook (deps are test seams; production passes none). */
export interface LocalChatTurnCompact {
  readonly deps?: NextTuiCompactDeps;
  readonly onCompact?: (outcome: NextTuiCompactOutcome) => void;
  readonly onMessageBlock?: (block: MessageBlock) => void;
  readonly onMeasuredUsage?: (usage: MeasuredTurnUsage) => void;
}
const statusListeners = new Map<string, Set<(json: string | null) => void>>();
const steerAppliedListeners = new Map<string, Set<(steerIds: string[]) => void>>();

/** A200 — the child drained these steer ids into a model request (one screen line «조향 반영»). */
export function onLocalChatSteerApplied(sessionId: string, listener: (steerIds: string[]) => void): () => void {
  const listeners = steerAppliedListeners.get(sessionId) ?? new Set();
  listeners.add(listener);
  steerAppliedListeners.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) steerAppliedListeners.delete(sessionId);
  };
}
const selfHealthListeners = new Map<string, Set<(snapshot: NextTuiSelfHealthSnapshot | null) => void>>();

export function onLocalChatBackgroundStatus(sessionId: string, listener: (json: string | null) => void): () => void {
  const listeners = statusListeners.get(sessionId) ?? new Set();
  listeners.add(listener);
  statusListeners.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) statusListeners.delete(sessionId);
  };
}

export function onLocalChatSelfHealthStatus(sessionId: string, listener: (snapshot: NextTuiSelfHealthSnapshot | null) => void): () => void {
  const listeners = selfHealthListeners.get(sessionId) ?? new Set();
  listeners.add(listener);
  selfHealthListeners.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) selfHealthListeners.delete(sessionId);
  };
}

/**
 * NEXT-TUI-DIFF-RENDER (2/2): start the sticky chat child right after the first paint, while the
 * person reads and types, so its bootstrap is not paid after the first Enter. runLocalChatTurn
 * reuses it, or closes and replaces it when the universe or session provider changed meanwhile.
 */
export function warmLocalChatSession(sessionId: string, cli = process.argv[1]): boolean {
  if (!sessionId || !cli || sessions.has(sessionId)) return false;
  try {
    sessions.set(sessionId, new LocalChatSession(sessionId, cli));
    debug.log('tui.next', 'child-prewarm', { sessionId });
    return true;
  } catch (error) {
    // A failed warm-up leaves the normal first-turn spawn path in place.
    debug.log('tui.next', 'child-prewarm-failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export async function closeLocalChatSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  lastModels.delete(sessionId);
  // The selection belongs to the TUI session, so a REPL child restart keeps it.
  await session?.close();
}

export function requestLocalChatShellActivitySnapshot(sessionId: string): boolean {
  return sessions.get(sessionId)?.requestShellActivitySnapshot() ?? false;
}
export function requestLocalChatPushNow(sessionId: string, requestId: string): boolean {
  return sessions.get(sessionId)?.requestPushNow(requestId) ?? false;
}
export function commitLocalChatPushNow(sessionId: string, requestId: string): boolean {
  return sessions.get(sessionId)?.commitPushNow(requestId) ?? false;
}
export function requestLocalChatSteer(sessionId: string, steerId: string, text: string): boolean {
  return sessions.get(sessionId)?.requestSteer(steerId, text) ?? false;
}
export function retractLocalChatSteer(sessionId: string, steerIds: readonly string[]): boolean {
  return sessions.get(sessionId)?.retractSteer(steerIds) ?? false;
}
export function requestLocalChatTaskStop(sessionId: string, taskId: string): boolean {
  return sessions.get(sessionId)?.requestTaskStop(taskId) ?? false;
}

/** Run one turn while retaining the child for the next turn. */
export async function runLocalChatTurn(
  sessionId: string,
  text: string,
  signal: AbortSignal,
  cli = process.argv[1],
  writePrompt?: (payload: string) => Promise<void>,
  onDelta?: (text: string, replace?: boolean, source?: 'assistant-text') => void,
  compact: LocalChatTurnCompact = {},
  attachments: readonly string[] = [],
  onStatus?: (line: string) => void,
  onAgent?: (event: AgentDisplayEvent) => void,
  onShellActivity?: WaitingTurn['onShellActivity'],
  onToolActivity?: WaitingTurn['onToolActivity'],
  onPushNowResult?: WaitingTurn['onPushNowResult'],
  onGraphProgress?: WaitingTurn['onGraphProgress'],
  from?: MessageSource,
): Promise<{ goalComplete: boolean; goalStopReason?: string; planOutcome?: PlanWire }> {
  if (signal.aborted) throw new Error('응답을 취소했습니다');
  if (!cli) throw new Error('elanous CLI entry is unavailable');
  // An auth refusal in the child can leave the Next TUI waiting indefinitely.
  // Resolve the same provider auth before starting the turn, request one bounded
  // owner mirror refresh on a missing mirror, then use the normal error card.
  const cfg = (await import('../user-config.js')).getUserConfig();
  const selection = getSessionProvider(sessionId);
  if ((selection?.provider ?? cfg.llm.provider) === 'openai-codex') {
    const effectiveCfg = await configForSessionProviderTurn(cfg, selection);
    const { preflightNextTuiAuth, requestOwnerMirrorOnce } = await import('./next-auth-preflight.js');
    const { loadFreshCodexAuthState, readCodexOwnerMirrorForRun } = await import('../oauth/codex.js');
    const { shouldUseCodexOwnerMirror } = await import('../oauth/codex-owner-mirror.js');
    const remote = shouldUseCodexOwnerMirror(effectiveCfg);
    await preflightNextTuiAuth(effectiveCfg, {
      load: async () => remote ? readCodexOwnerMirrorForRun().state : loadFreshCodexAuthState(),
      request: () => requestOwnerMirrorOnce(effectiveCfg),
      observe: (reason, requested) => {
        try { debug.log('llm.auth', 'next-tui-mirror-request', { reason, requested }); }
        catch { /* observation cannot block the turn */ }
      },
    });
  }
  // TUI-GLM-PROVIDER-USES-ZAI-CODING-PLAN — a glm turn without a Z.ai Coding Plan key shows that reason
  // on the normal error card instead of a 0s generic failure from the child.
  if ((selection?.provider ?? cfg.llm.provider) === 'glm') {
    const { zaiCodingPlanAvailable } = await import('../llm/zai-coding-plan.js');
    (await import('./next-auth-preflight.js')).preflightNextTuiGlmAuth('glm', () => zaiCodingPlanAvailable());
  }
  // A resumed session id may be selected in another test universe. Its sticky
  // child must not keep reading or writing memory in the previous universe.
  const existing = sessions.get(sessionId);
  if (existing && existing.instanceRoot !== effectiveInstanceRoot()) await closeLocalChatSession(sessionId);
  // A /provider switch after the child started must not leave the child on the old provider.
  else if (existing && existing.providerKey !== sessionProviderChildEnv(getSessionProvider(sessionId)).key) await closeLocalChatSession(sessionId);
  const started = performance.now();
  let compactImportMs: number | null = null;
  let compactMs: number | null = null;
  let compactReason = 'preparing';
  let reusedChild: boolean | null = null;
  let childCreateMs: number | null = null;
  let dispatchMs: number | null = null;
  let firstDeltaMs: number | null = null;
  let firstAssistantTextMs: number | null = null;
  let outcome: 'completed' | 'error' = 'error';
  const observeLatency = (outcome: 'completed' | 'error' | 'cancelled'): void => {
    try {
      debug.log('tui.next', 'turn-latency', {
        sessionId, scope: 'post-preflight-to-result', compactReason, compactImportMs, compactMs,
        reusedChild, childCreateMs, dispatchMs, firstDeltaMs, firstAssistantTextMs,
        totalMs: performance.now() - started, outcome,
      });
    } catch { /* observation must not change transport or renderer behavior */ }
  };
  // Once timing starts, preparation, cancellation and constructor failures also terminate here.
  try {
    // Empty sessions have nothing to compact. Avoid loading the summarizer/provider graph or
    // resolving its default model on this first-answer path; populated sessions keep the same
    // pre-turn store rewrite, threshold, failure fallback and selected model as before.
    if ((compact.deps?.config ?? cfg.chat.autoCompact).enabled) {
      let hasHistory = true;
      // Stat the canonical transcript instead of parsing a populated history twice.
      // Missing/zero-byte files are provably empty; other read failures keep the old boundary.
      try { hasHistory = statSync(sessionFile(sessionId)).size > 0; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') hasHistory = false;
      }
      if (hasHistory) {
        const importing = performance.now();
        const { compactNextTuiSession } = await import('../tui/slash/compact.js')
          .finally(() => { compactImportMs = performance.now() - importing; });
        const compacting = performance.now();
        const compacted = await compactNextTuiSession(sessionId, { force: false,
          modelId: selection?.model ?? (selection ? (await import('../user-config.js')).PROVIDER_DEFAULT_MODEL[selection.provider] : undefined)
            ?? localChatModel(sessionId) }, compact.deps)
          .finally(() => { compactMs = performance.now() - compacting; });
        compactReason = compacted.reason;
        if (compacted.fired) {
          try { compact.onCompact?.(compacted); } catch { /* status observers cannot break the turn */ }
        }
      } else {
        compactReason = 'empty-session';
        compactImportMs = compactMs = 0;
      }
    } else {
      compactReason = 'disabled';
      compactImportMs = compactMs = 0;
    }
    if (signal.aborted) throw new Error('응답을 취소했습니다');
    const creating = performance.now();
    reusedChild = sessions.has(sessionId);
    let session: LocalChatSession;
    try { session = sessions.get(sessionId) ?? new LocalChatSession(sessionId, cli); }
    finally { childCreateMs = performance.now() - creating; }
    sessions.set(sessionId, session);
    dispatchMs = performance.now() - started;
    const abort = (): void => { void closeLocalChatSession(sessionId); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let result: TurnResult;
    try {
      result = await session.turn(text, writePrompt, (delta, replace, source) => {
        if (!signal.aborted) {
          if (delta.length > 0) {
            firstDeltaMs ??= performance.now() - started;
            if (source === 'assistant-text') firstAssistantTextMs ??= performance.now() - started;
          }
          onDelta?.(delta, replace, source);
        }
      }, attachments, (line) => { if (!signal.aborted) onStatus?.(line); }, (event) => { if (!signal.aborted) onAgent?.(event); },
      (block) => { if (!signal.aborted) compact.onMessageBlock?.(block); },
      (event) => { if (!signal.aborted) onShellActivity?.(event); },
      (event) => { if (!signal.aborted) onToolActivity?.(event); },
      (event) => { if (!signal.aborted) onPushNowResult?.(event); },
      (usage) => { if (!signal.aborted) compact.onMeasuredUsage?.(usage); },
      (event) => { if (!signal.aborted) onGraphProgress?.(event); }, from);
    } catch (error) {
      if (signal.aborted) throw new Error('응답을 취소했습니다');
      await closeLocalChatSession(sessionId);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
    if (signal.aborted) throw new Error('응답을 취소했습니다');
    // A completed JSONL error frame is a turn failure, not a transport failure:
    // the child still owns live tasks and buffered notifications for retry.
    if (result.error) throw new Error(result.error);
    if (result.model) lastModels.set(sessionId, result.model);
    if (result.provider) {
      try {
        const { debug } = await import('../debug/log.js');
        debug.log('llm.route-decision', 'local-chat-executed', {
          surface: 'tui-local', sessionId, provider: result.provider, model: result.model ?? null,
        });
      } catch { /* observation must not fail a completed turn */ }
    }
    // The route observation import yields after the earlier result check.
    // Match the caller's terminal result to a cancellation received during that await.
    if (signal.aborted) throw new Error('응답을 취소했습니다');
    outcome = 'completed';
    return {
      goalComplete: result.goalComplete === true,
      ...(typeof result.goalStopReason === 'string' ? { goalStopReason: result.goalStopReason } : {}),
      ...(() => { const planOutcome = parsePlanWire(result.planOutcome); return planOutcome ? { planOutcome } : {}; })(),
    };
  } finally {
    observeLatency(signal.aborted ? 'cancelled' : outcome);
  }
}
