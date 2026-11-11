/** Keep one REPL child per session so background tasks and their completion queue survive turns. */
import type { NextTuiCompactDeps, NextTuiCompactOutcome } from '../tui/slash/compact.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { NEXT_TUI_WAKEUP_IPC_ENV, answerWakeupCall, isWakeupCallMessage, nextTuiWakeupTool } from './next-wakeup.js';
import { isNextTuiSelfHealthSnapshot, type NextTuiSelfHealthSnapshot } from '../tui/chat/self-health-status.js';
import { answerNextSidetabCall, isNextSidetabCall, type NextSidetabHandler } from '../tui/sidetab/nl-tool.js';
import type { AgentDisplayEvent } from '../tui/core/agents.js';
import type { MessageBlock } from '../conv-substrate/message-block.js';
import {
  answerShellApprovalCall,
  isShellApprovalCallMessage,
  isShellApprovalCancelMessage,
  NEXT_TUI_SHELL_APPROVAL_IPC_ENV,
  SHELL_APPROVAL_CANCEL_TYPE,
} from './next-shell-approval.js';
import { getSessionTierOverride } from '../model-tier/session-override.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnElanousBun } from '../instance/spawn-elanous.js';
import { debug } from '../debug/log.js';

const STATUS_PREFIX = 'ELANOUS_TUI_BG_STATUS\t';
let nextSidetabHandler: NextSidetabHandler | null = null;
let nextSidetabIpcEnabled = false;
let nextTuiShellApprovalHandler: ((command: string, callId: string) => Promise<boolean>) | null = null;
let nextTuiShellApprovalCancelHandler: ((callId: string, reason: 'timeout' | 'turn-cancelled' | 'host-cancelled') => void) | null = null;

export function setNextSidetabHandler(handler: NextSidetabHandler | null): void {
  nextSidetabHandler = handler;
}

/** The Next TUI host enables this before any sticky REPL child is created. */
export function setNextSidetabIpcEnabled(enabled: boolean): void {
  nextSidetabIpcEnabled = enabled;
}

/** Installs the human-facing approval prompt before a sticky REPL child is created. */
export function setNextTuiShellApprovalHandler(handler: ((command: string, callId: string) => Promise<boolean>) | null): void {
  nextTuiShellApprovalHandler = handler;
}

/** Closes the matching host prompt when the child times out or its turn is cancelled. */
export function setNextTuiShellApprovalCancelHandler(
  handler: ((callId: string, reason: 'timeout' | 'turn-cancelled' | 'host-cancelled') => void) | null,
): void {
  nextTuiShellApprovalCancelHandler = handler;
}

interface TurnResult {
  event?: string | null;
  turnId?: string | null;
  id?: string;
  phase?: string;
  description?: string;
  status?: string;
  sessionId?: string;
  text?: string;
  error?: string;
  provider?: string;
  model?: string | null;
  goalComplete?: boolean;
  goalStopReason?: string;
  name?: string;
  startedAtMonotonicMs?: number;
  calls?: unknown;
  requestId?: string;
  outcome?: string;
  activeTools?: unknown;
  selfHealth?: NextTuiSelfHealthSnapshot | null;
  block?: MessageBlock;
}
export type LocalChatToolActivity =
  | { phase: 'start' | 'finish'; id: string; name: string }
  | { phase: 'snapshot'; calls: Array<{ id: string; name: string }> };
export type LocalChatPushNowResult = { requestId: string; outcome: 'ready' | 'interrupted' | 'deferred'; activeTools: string[] };
interface WaitingTurn {
  turnId: string;
  onDelta?: (text: string, replace?: boolean) => void;
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
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
}

class LocalChatSession {
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly exited: Promise<number>;
  private readonly writeInput: (payload: string) => Promise<void>;
  private waiting: WaitingTurn | null = null;
  private stderrTail = '';
  private closed = false;
  private closing: Promise<void> | null = null;
  private invalidated = false;
  private turnCount = 0;
  private readonly pendingShellApprovalIds = new Set<string>();

  constructor(private readonly sessionId: string, cli: string) {
    // TUI-NEXT-QUEUE-AND-WAKE: the child's ScheduleWakeup asks this process over Bun IPC — the scheduler
    // lives here because the child dies on Esc and /new. No tool registered → no IPC, env unchanged.
    const wakeupTool = nextTuiWakeupTool();
    const fastChild = fileURLToPath(new URL('./fast-repl-child.ts', import.meta.url));
    const useFastChild = cli.endsWith('/bin/elanous.mjs') && existsSync(fastChild);
    this.child = spawnElanousBun(
      useFastChild
        ? [sessionId, getElanousConfigDir()]
        : ['--config-dir', getElanousConfigDir(), 'repl', '--session', sessionId, '--json', '--stdin-jsonl'],
      {
      bin: useFastChild ? fastChild : cli,
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env, ELANOUS_NEXT_TUI_BG_STATUS: '1', ELANOUS_NEXT_TUI_STREAM: '1',
        ELANOUS_NEXT_TUI_SELF_HEALTH: '1',
        ...(wakeupTool ? { [NEXT_TUI_WAKEUP_IPC_ENV]: '1' } : {}),
        // The Next TUI explicitly enables this before child startup. The
        // callback itself stays live so a child created before handler wiring
        // can still serve the host once it is installed.
        ELANOUS_NEXT_TUI_SIDETAB_IPC: nextSidetabIpcEnabled ? '1' : '0',
        // The child may be created before the UI callback is installed. Always
        // enable the approval boundary; an absent parent handler answers deny.
        [NEXT_TUI_SHELL_APPROVAL_IPC_ENV]: '1',
      },
      ipc: (message: unknown, child: { send(message: unknown): unknown }) => {
          if (wakeupTool && isWakeupCallMessage(message)) {
            void answerWakeupCall(wakeupTool, message).then((reply) => {
              try { child.send(reply); } catch { /* the child exited mid-call; its dispatch times out */ }
            });
          } else if (isNextSidetabCall(message)) {
            const handler = nextSidetabHandler ?? (async () => ({ error: 'Next TUI sidetab handler is not ready' }));
            void answerNextSidetabCall(handler, message).then((reply) => {
              try { child.send(reply); } catch { /* the child exited mid-call; its dispatch times out */ }
            });
          } else if (isShellApprovalCancelMessage(message)) {
            this.pendingShellApprovalIds.delete(message.callId);
            try { nextTuiShellApprovalCancelHandler?.(message.callId, message.reason); }
            catch { /* cancellation bookkeeping cannot break the child */ }
          } else if (isShellApprovalCallMessage(message)) {
            this.pendingShellApprovalIds.add(message.callId);
            void answerShellApprovalCall(nextTuiShellApprovalHandler, message).then((reply) => {
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
      if (result.event === 'delta') {
        if (result.turnId !== waiting.turnId) return;
        if (typeof result.text === 'string') {
          try { waiting.onDelta?.(result.text); } catch { /* renderer cannot break the turn */ }
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
          try { waiting.onToolActivity?.({ phase: 'snapshot', calls }); } catch { /* observer cannot break a turn */ }
        } else if ((result.phase === 'start' || result.phase === 'finish')
          && typeof result.id === 'string' && typeof result.name === 'string') {
          try { waiting.onToolActivity?.({ phase: result.phase, id: result.id, name: result.name }); }
          catch { /* observer cannot break a turn */ }
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

  async turn(prompt: string, writePrompt?: (payload: string) => Promise<void>, onDelta?: (text: string, replace?: boolean) => void, attachments: readonly string[] = [], onStatus?: (text: string) => void, onAgent?: (event: AgentDisplayEvent) => void, onMessageBlock?: (block: MessageBlock) => void, onShellActivity?: WaitingTurn['onShellActivity'], onToolActivity?: WaitingTurn['onToolActivity'], onPushNowResult?: WaitingTurn['onPushNowResult']): Promise<TurnResult> {
    if (this.closed) throw new Error('REPL child exited');
    if (this.waiting) throw new Error('REPL turn already running');
    const turnId = `tui-${++this.turnCount}`;
    const modelTier = getSessionTierOverride(this.sessionId)?.llm;
    const payload = JSON.stringify({ prompt, id: turnId, ...(modelTier ? { modelTier } : {}), ...(attachments.length ? { attachments } : {}) }) + '\n';
    const response = new Promise<TurnResult>((resolve, reject) => { this.waiting = { turnId, onDelta, onStatus, onAgent, onMessageBlock, onShellActivity, onToolActivity, onPushNowResult, resolve, reject }; });
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
          try { this.child.kill(); } catch { /* already exited */ }
        }
        await this.exited;
      })();
    }
    await this.closing;
  }

  requestShellActivitySnapshot(): boolean {
    if (this.closed || !this.waiting) return false;
    try { this.child.send({ type: 'elanous.next-tui.shell-snapshot', turnId: this.waiting.turnId }); return true; }
    catch { return false; }
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
}
const statusListeners = new Map<string, Set<(json: string | null) => void>>();
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

export async function closeLocalChatSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  lastModels.delete(sessionId);
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
  onDelta?: (text: string, replace?: boolean) => void,
  compact: LocalChatTurnCompact = {},
  attachments: readonly string[] = [],
  onStatus?: (line: string) => void,
  onAgent?: (event: AgentDisplayEvent) => void,
  onShellActivity?: WaitingTurn['onShellActivity'],
  onToolActivity?: WaitingTurn['onToolActivity'],
  onPushNowResult?: WaitingTurn['onPushNowResult'],
): Promise<{ goalComplete: boolean; goalStopReason?: string }> {
  if (signal.aborted) throw new Error('응답을 취소했습니다');
  if (!cli) throw new Error('elanous CLI entry is unavailable');
  // The REPL child reloads the session store each turn, so compacting the store here is what this
  // turn's model call sees. Over the shared threshold only; a failure leaves the turn uncompacted.
  // Lazy like this module itself: the compaction path pulls in the LLM router, so next TUI boot stays light.
  const { compactNextTuiSession } = await import('../tui/slash/compact.js');
  const compacted = await compactNextTuiSession(sessionId, { force: false, modelId: localChatModel(sessionId) }, compact.deps);
  if (compacted.fired) {
    try { compact.onCompact?.(compacted); } catch { /* status observers cannot break the turn */ }
  }
  if (signal.aborted) throw new Error('응답을 취소했습니다');
  const session = sessions.get(sessionId) ?? new LocalChatSession(sessionId, cli);
  sessions.set(sessionId, session);
  const abort = (): void => { void closeLocalChatSession(sessionId); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let result: TurnResult;
  try {
    result = await session.turn(text, writePrompt, (delta, replace) => {
      if (!signal.aborted) onDelta?.(delta, replace);
    }, attachments, (line) => { if (!signal.aborted) onStatus?.(line); }, (event) => { if (!signal.aborted) onAgent?.(event); },
    (block) => { if (!signal.aborted) compact.onMessageBlock?.(block); },
    (event) => { if (!signal.aborted) onShellActivity?.(event); },
    (event) => { if (!signal.aborted) onToolActivity?.(event); },
    (event) => { if (!signal.aborted) onPushNowResult?.(event); });
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
  return {
    goalComplete: result.goalComplete === true,
    ...(typeof result.goalStopReason === 'string' ? { goalStopReason: result.goalStopReason } : {}),
  };
}
