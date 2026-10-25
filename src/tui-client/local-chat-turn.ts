/** Keep one REPL child per session so background tasks and their completion queue survive turns. */
import type { NextTuiCompactDeps, NextTuiCompactOutcome } from '../tui/slash/compact.js';
import { NEXT_TUI_WAKEUP_IPC_ENV, answerWakeupCall, isWakeupCallMessage, nextTuiWakeupTool } from './next-wakeup.js';
import { isNextTuiSelfHealthSnapshot, type NextTuiSelfHealthSnapshot } from '../tui/chat/self-health-status.js';

const STATUS_PREFIX = 'ELANOUS_TUI_BG_STATUS\t';

interface TurnResult {
  event?: string | null;
  turnId?: string | null;
  sessionId?: string;
  text?: string;
  error?: string;
  provider?: string;
  model?: string | null;
  selfHealth?: NextTuiSelfHealthSnapshot | null;
}
interface WaitingTurn {
  turnId: string;
  onDelta?: (text: string) => void;
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

  constructor(private readonly sessionId: string, cli: string) {
    // TUI-NEXT-QUEUE-AND-WAKE: the child's ScheduleWakeup asks this process over Bun IPC — the scheduler
    // lives here because the child dies on Esc and /new. No tool registered → no IPC, env unchanged.
    const wakeupTool = nextTuiWakeupTool();
    this.child = Bun.spawn({
      cmd: [process.execPath, cli, 'repl', '--session', sessionId, '--json', '--stdin-jsonl'],
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env, ELANOUS_NEXT_TUI_BG_STATUS: '1', ELANOUS_NEXT_TUI_STREAM: '1',
        ELANOUS_NEXT_TUI_SELF_HEALTH: '1',
        ...(wakeupTool ? { [NEXT_TUI_WAKEUP_IPC_ENV]: '1' } : {}),
      },
      ...(wakeupTool ? {
        ipc: (message: unknown, child: { send(message: unknown): unknown }) => {
          if (!isWakeupCallMessage(message)) return;
          void answerWakeupCall(wakeupTool, message).then((reply) => {
            try { child.send(reply); } catch { /* the child exited mid-call; its dispatch times out */ }
          });
        },
      } : {}),
    });
    const input = this.child.stdin;
    const output = this.child.stdout;
    const errors = this.child.stderr;
    if (!input || typeof input === 'number' || !output || typeof output === 'number'
      || !errors || typeof errors === 'number') throw new Error('REPL pipe unavailable');
    this.writeInput = async (payload) => { input.write(payload); await input.flush(); };
    this.exited = this.child.exited;
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
      // Future side-channel events cannot complete a turn. Legacy final
      // frames have no event; typed final frames use event=result.
      if ('event' in result && result.event !== 'result') return;
      this.waiting = null;
      waiting.resolve(result);
    }, () => {
      this.invalidate();
      this.fail(new Error('REPL stdout closed'));
      void this.close();
    });
    void this.readLines(errors, (line) => {
      if (line.startsWith(STATUS_PREFIX)) {
        for (const listener of statusListeners.get(sessionId) ?? []) {
          try { listener(line.slice(STATUS_PREFIX.length)); } catch { /* status observers cannot break the turn */ }
        }
      } else if (line.trim()) {
        this.stderrTail = line.trim();
      }
    });
    void this.exited.then((code) => {
      this.closed = true;
      this.invalidate();
      if (sessions.get(sessionId) === this) sessions.delete(sessionId);
      this.fail(new Error(this.stderrTail || `chat exit ${code}`));
    });
  }

  private async readLines(stream: ReadableStream<Uint8Array>, receive: (line: string) => void, onEnd?: () => void): Promise<void> {
    const reader = stream.getReader();
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

  async turn(prompt: string, writePrompt?: (payload: string) => Promise<void>, onDelta?: (text: string) => void, attachments: readonly string[] = []): Promise<TurnResult> {
    if (this.closed) throw new Error('REPL child exited');
    if (this.waiting) throw new Error('REPL turn already running');
    const turnId = `tui-${++this.turnCount}`;
    const payload = JSON.stringify({ prompt, id: turnId, ...(attachments.length ? { attachments } : {}) }) + '\n';
    const response = new Promise<TurnResult>((resolve, reject) => { this.waiting = { turnId, onDelta, resolve, reject }; });
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
          try { this.child.kill(); } catch { /* already exited */ }
        }
        await this.exited;
      })();
    }
    await this.closing;
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

/** Run one turn while retaining the child for the next turn. */
export async function runLocalChatTurn(
  sessionId: string,
  text: string,
  signal: AbortSignal,
  cli = process.argv[1],
  writePrompt?: (payload: string) => Promise<void>,
  onDelta?: (text: string) => void,
  compact: LocalChatTurnCompact = {},
  attachments: readonly string[] = [],
): Promise<void> {
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
    result = await session.turn(text, writePrompt, (delta) => {
      if (!signal.aborted) onDelta?.(delta);
    }, attachments);
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
}
