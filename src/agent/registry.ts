// ── Agent task registry ──
//
// Phase B2 — in-process ledger of live agent tasks. The plugin host
// owns one AgentRegistry; it's the authoritative source of task state
// and the single point that wires AbortControllers. Tasks survive past
// their run so callers can inspect .result / .error / .messages after
// the fact — a periodic prune sweep keeps the table from growing
// unbounded over a long session.
//
// Spawning an agent returns BOTH the AgentTask (for state inspection)
// AND an AsyncGenerator<AgentEvent> (for streaming the run). Callers
// that only want the final text can `await collectText(events)` —
// the event stream always ends with `done` | `error` | `status:aborted`.

import { randomUUID } from 'node:crypto';
import { runAgent } from './runner.js';
import { mintAgentUri } from '../mss/uri/builder.js';
import type {
  AgentDefinition, AgentEvent, AgentSpawnOpts, AgentTask, AgentState,
} from './types.js';

/** Result of a spawn call: task for state queries, events for streaming. */
export interface SpawnHandle {
  task: AgentTask;
  events: AsyncGenerator<AgentEvent, void, unknown>;
}

/** ROADMAP-agent-surface-deferred-tools-2026-05-13 Wave 5 E3 — HOP_CAP.
 *  Maximum spawn-tree depth before `registry.spawn` rejects. A
 *  pathological recursive agent spawning itself can't drain budget /
 *  context past this cap. Default 5 — chosen to allow realistic
 *  team-of-agents layouts (parent → coordinator → 3 expert workers →
 *  optional verifier = depth 3) while still bounding the cone. */
export const DEFAULT_AGENT_HOP_CAP = 5;

let currentHopCap = DEFAULT_AGENT_HOP_CAP;

/** Override the HOP_CAP (used by user-config wire + tests). */
export function setAgentHopCap(cap: number): void {
  currentHopCap = Math.max(0, Math.floor(cap));
}

export function getAgentHopCap(): number {
  return currentHopCap;
}

/** Error thrown by `registry.spawn` / `registry.register` when the
 *  derived depth would exceed the cap. Carries the would-be depth +
 *  the cap so the dispatcher can surface a structured tool_result
 *  rather than crashing the turn. */
export class AgentHopCapExceededError extends Error {
  constructor(public readonly depth: number, public readonly cap: number, public readonly parentTaskId?: string) {
    super(
      `agent spawn rejected: hop depth ${depth} exceeds HOP_CAP ${cap}` +
      (parentTaskId ? ` (parent=${parentTaskId})` : ''),
    );
    this.name = 'AgentHopCapExceededError';
  }
}

/** P5.2: detailed tool-call event emitted per sub-agent tool
 *  invocation. Only fires when debug.isDetailEnabled() — zero
 *  overhead in the steady state. Carries enough context for a
 *  timeline renderer to show what each agent actually did. */
export interface AgentToolCallEvent {
  /** AgentTask.id of the agent that issued the tool call. */
  agentId: string;
  /** Optional correlation ID — same value used in debug.log
   *  payloads so panes can cross-reference both feeds. */
  correlationId?: string;
  /** 1-indexed position in the agent's tool-call sequence. */
  callIdx: number;
  /** Tool name (Bash / Read / Edit / Grep / WebFetch / Agent). */
  tool: string;
  /** Raw arguments the sub-agent passed. Already redacted of
   *  secrets by the caller (redactSecrets helper). */
  args: Record<string, unknown>;
  /** Call phase — 'start' fires on tool_call, 'result' on
   *  tool_result. Both carry the same callIdx so listeners can
   *  pair them. */
  phase: 'start' | 'result';
  /** result carried ONLY on phase==='result'. String or
   *  JSON-serialized shape. Caller truncates if huge. */
  result?: string;
  /** Wall-clock ms from tool_call to tool_result. Only on
   *  phase==='result'. */
  durationMs?: number;
  /** Unix ms timestamp of this event — lets the timeline pane
   *  render absolute times + ordering without a separate clock. */
  ts: number;
}

/** In-process task registry. Safe to share across plugins; id collisions
 *  are avoided by UUID. Not persistent — teammate / cross-session
 *  storage is Phase G. */
export class AgentRegistry {
  private tasks = new Map<string, AgentTask>();
  /** P5.2: listeners for detailed tool-call events. Populated by
   *  the dashboard when the debug level is 'detail' — skill-tool-
   *  agent.ts calls emitToolCall() which fans out here. Set is
   *  used so add/remove is O(1) and listener identity is stable. */
  private toolCallListeners = new Set<(ev: AgentToolCallEvent) => void>();
  /** PFC-S1 P2: listeners for task state transitions to a terminal
   *  state (done / error / aborted). The runner invokes
   *  `registry.notifyTaskDone(task)` after stamping finishedAt. The
   *  task-notification queue subscribes here for background tasks;
   *  future roster panes will too. */
  private taskDoneListeners = new Set<(task: AgentTask) => void>();

  /** Create a task, start its run, and return handle. The generator is
   *  lazy — the run doesn't progress until the caller starts iterating
   *  (standard async-generator semantics).
   *
   *  Wave 5 E3 — derives `task.depth` from `opts.parentTaskId` and
   *  rejects via `AgentHopCapExceededError` when the resulting depth
   *  would exceed `getAgentHopCap()`. */
  spawn(opts: AgentSpawnOpts): SpawnHandle {
    const depth = this.deriveDepth(opts.parentTaskId);
    if (depth > currentHopCap) {
      throw new AgentHopCapExceededError(depth, currentHopCap, opts.parentTaskId);
    }
    const task: AgentTask = {
      id: randomUUID(),
      definition: opts.definition,
      prompt: opts.prompt,
      depth,
      ...(opts.label ? { label: opts.label } : {}),
      ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
      ...(opts.parentCorrelationId ? { parentCorrelationId: opts.parentCorrelationId } : {}),
      // Wave 3 W3.4: stamp the parent task id so abortCascade can walk
      // the descendant tree at cancel time.
      ...(opts.parentTaskId ? { parentTaskId: opts.parentTaskId } : {}),
      // PFC-S1 P1: team / cwd / background carry onto the task so
      // roster, task-notification (P2), and SendMessage (P4) can
      // read them without re-threading through AgentSpawnOpts.
      ...(opts.teamName ? { teamName: opts.teamName } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.background ? { background: true } : {}),
      // MSS M1.2: brand the spawn with an AgentUri (caller may pre-mint
      // for cross-task tracing; default = fresh mint). The legacy UUID
      // `id` stays the registry key — agentUri rides alongside.
      agentUri: opts.agentUri ?? mintAgentUri(),
      state: 'pending',
      messages: [],
      controller: new AbortController(),
    };
    this.tasks.set(task.id, task);
    // PFC-S1 P2: hand the runner a terminal-state callback so the
    // task-notification queue (and future roster panes) observe
    // completion without runner importing this file (would cycle).
    const events = runAgent(task, {
      ...opts,
      onTerminal: (t) => this.notifyTaskDone(t),
    });
    return { task, events };
  }

  /** Manually create a task without starting it. Useful when a caller
   *  wants to register the task with the registry before deciding
   *  whether to run it (e.g., confirmation gate). Always depth=0 —
   *  manual register has no parent context. */
  register(definition: AgentDefinition, prompt: string, opts: { id?: string } = {}): AgentTask {
    const task: AgentTask = {
      id: opts.id ?? randomUUID(),
      definition,
      prompt,
      depth: 0,
      // MSS M1.2: same agentUri convention as spawn() — fresh mint per
      // registration so downstream MSS bridges always have a typed id.
      agentUri: mintAgentUri(),
      state: 'pending',
      messages: [],
      controller: new AbortController(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  /** Run a registered non-LLM job under the same observable/cancellable task lifecycle. */
  async runManaged<T>(id: string, runner: (signal: AbortSignal) => Promise<T>, renderResult: (value: T) => string = String): Promise<T> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`agent task not found: ${id}`);
    if (task.state !== 'pending') throw new Error(`agent task is not pending: ${id} (${task.state})`);
    task.state = 'running';
    task.startedAt = Date.now();
    try {
      const value = await runner(task.controller.signal);
      task.state = task.controller.signal.aborted ? 'aborted' : 'done';
      task.result = renderResult(value);
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (task.controller.signal.aborted) task.state = 'aborted';
      else { task.state = 'error'; task.error = message; }
      task.result = message;
      throw error;
    } finally {
      task.finishedAt = Date.now();
      this.notifyTaskDone(task);
    }
  }

  get(id: string): AgentTask | undefined {
    return this.tasks.get(id);
  }

  /** Snapshot of all tasks. Returned as a fresh array; mutation by the
   *  caller does not affect registry state. */
  list(state?: AgentState): AgentTask[] {
    const all = [...this.tasks.values()];
    return state ? all.filter(t => t.state === state) : all;
  }

  /** Signal cancellation to one task. Idempotent — calling on a
   *  finished task is a no-op. The runner's catch handler flips state
   *  to 'aborted' once the in-flight provider fetch unwinds.
   *
   *  When `opts.cascade === true`, every descendant task (children whose
   *  `parentTaskId` chains back to `id`) is also signalled. Cycles are
   *  guarded against — each task aborts at most once per call. Use
   *  `abortCascade(id)` for the version that returns a structured count
   *  the caller can echo to the LLM (ROADMAP-agent-surface-deferred-tools
   *  Wave 3 W3.4). */
  abort(id: string, opts?: { cascade?: boolean }): boolean {
    if (opts?.cascade) {
      return this.abortCascade(id).self;
    }
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.state === 'done' || task.state === 'error' || task.state === 'aborted') return false;
    task.controller.abort();
    return true;
  }

  /** ROADMAP-agent-surface-deferred-tools-2026-05-13 Wave 3 W3.4 —
   *  abort `id` and every live descendant (any task whose `parentTaskId`
   *  chain leads back to `id`). Returns:
   *   - `self`        — true when `id` itself was a live task and got
   *                     the abort signal
   *   - `descendants` — count of additional tasks the cascade signalled
   *
   *  Descendant lookup is a BFS over the current `tasks` map keyed on
   *  `parentTaskId`. A `seen` set guards against pathological cycles
   *  (shouldn't happen — parentTaskId only stamps the spawn-time
   *  parent — but the guard costs nothing). */
  /** Wave 5 E3 — derive the depth a newly-spawned child should carry.
   *  Top-level (no parent) = 0. Nested = `parent.depth + 1`, falling
   *  back to 1 when the parent record is missing (caller passed a
   *  stale id) so the cap still gates run-away chains. */
  private deriveDepth(parentTaskId?: string): number {
    if (!parentTaskId) return 0;
    const parent = this.tasks.get(parentTaskId);
    if (!parent) return 1;
    return (parent.depth ?? 0) + 1;
  }

  abortCascade(id: string): { self: boolean; descendants: number } {
    const self = (() => {
      const task = this.tasks.get(id);
      if (!task) return false;
      if (task.state === 'done' || task.state === 'error' || task.state === 'aborted') return false;
      task.controller.abort();
      return true;
    })();
    const seen = new Set<string>([id]);
    const queue: string[] = [id];
    let descendants = 0;
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      for (const t of this.tasks.values()) {
        if (t.parentTaskId !== parentId) continue;
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        queue.push(t.id);
        if (t.state === 'pending' || t.state === 'running') {
          t.controller.abort();
          descendants += 1;
        }
      }
    }
    return { self, descendants };
  }

  /** PFC-S2 P1: flip a live task to background routing. After this,
   *  when the task reaches terminal state the task-notification queue
   *  (src/agent/task-notification.ts:135) will enqueue it — parents
   *  learn about completion via injected XML on their next turn.
   *  Caller pattern: roster pane's `d` action. Idempotent; returns
   *  true only when the state actually changed. Terminal tasks are
   *  rejected (nothing to route anymore). */
  markBackground(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.state === 'done' || task.state === 'error' || task.state === 'aborted') return false;
    if (task.background) return false;
    task.background = true;
    return true;
  }

  /**
   * ★ 살아남은 «포그라운드» 라이브 태스크를 전부 백그라운드 라우팅으로 넘긴다. 넘어간 id 를 낸다.
   *
   * 🚨 왜 필요한가 (2026-08-19 · `R1` 이 낸 구멍을 막는다)
   *   `R1`(취소 축 가르기) 이후 ESC 는 ***도는 턴만*** 멈추고 자식은 살린다(대표 지시).
   *   ⛔ 그런데 `task-notification.ts` 는 ***`if (!task.background) return;`*** 이다 —
   *     포그라운드 태스크의 완료는 「부모 툴 루프가 기다리니까」 알림으로 안 간다.
   *   ⇒ 🚨 ***턴이 죽으면 그 툴 루프가 «없다».*** 그대로 두면 살아남은 자식이
   *     결과를 아무에게도 못 주고 끝난다 — ***고아***가 된다.
   *   ⇒ 🩹 그래서 턴을 멈출 때 살아남는 것들을 «백그라운드»로 넘긴다.
   *     그러면 완료가 `task-notification` 으로 부모의 «다음 턴»에 도착한다.
   *
   * ⭐ 이것이 대표 「최소 HITL」의 형태다 — 묻지 않는다. 넘기고 «알린다».
   */
  markBackgroundAllRunning(): string[] {
    const moved: string[] = [];
    for (const task of this.tasks.values()) {
      if (this.markBackground(task.id)) moved.push(task.id);
    }
    return moved;
  }

  /** PFC-S2 P1: inverse of markBackground — promote a background task
   *  back to foreground routing so terminal-state fires do NOT enqueue
   *  a task-notification. Completion observers may opt into terminal
   *  transitions only after preserving that notification. Idempotent. */
  markForeground(id: string, opts?: { allowTerminal?: boolean }): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    const terminal = task.state === 'done' || task.state === 'error' || task.state === 'aborted';
    if (terminal && !opts?.allowTerminal) return false;
    if (!task.background) return false;
    task.background = false;
    return true;
  }

  /** Abort every live task. Returns how many were actually signalled. */
  abortAll(): number {
    let n = 0;
    for (const task of this.tasks.values()) {
      if (task.state === 'pending' || task.state === 'running') {
        task.controller.abort();
        n++;
      }
    }
    return n;
  }

  /** Drop finished tasks older than `olderThanMs`. Returns removed count.
   *  Live tasks are never pruned regardless of age. */
  prune(olderThanMs = 5 * 60 * 1000, now = Date.now()): number {
    let removed = 0;
    for (const [id, task] of this.tasks) {
      if (task.state === 'pending' || task.state === 'running') continue;
      if (!task.finishedAt) continue;
      if (now - task.finishedAt > olderThanMs) {
        this.tasks.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Forget every task unconditionally. Tests use this for isolation. */
  clear(): void {
    this.tasks.clear();
    this.toolCallListeners.clear();
    this.taskDoneListeners.clear();
  }

  get size(): number {
    return this.tasks.size;
  }

  /** P5.2: subscribe to detailed tool-call events. Returns a
   *  disposer. Dashboard wires one listener when the debug level
   *  enters 'detail' and disposes it when the level drops. */
  onToolCall(listener: (ev: AgentToolCallEvent) => void): { dispose(): void } {
    this.toolCallListeners.add(listener);
    return { dispose: () => { this.toolCallListeners.delete(listener); } };
  }

  /** Called by skill-tool-agent (gated on debug.isDetailEnabled())
   *  to fan an event out to every subscriber. Safe on zero listeners
   *  — the for-of is a no-op. Exceptions in listeners are swallowed
   *  so one buggy consumer can't break agent dispatch. */
  emitToolCall(ev: AgentToolCallEvent): void {
    if (this.toolCallListeners.size === 0) return;
    for (const listener of this.toolCallListeners) {
      try { listener(ev); } catch { /* observer isolation */ }
    }
  }

  /** PFC-S1 P2: subscribe to terminal-state task transitions. Fires
   *  exactly once per task when state flips to done / error / aborted
   *  and finishedAt is stamped. Observer isolation — listener throws
   *  are swallowed. Returns a disposer. */
  onTaskDone(listener: (task: AgentTask) => void): { dispose(): void } {
    this.taskDoneListeners.add(listener);
    return { dispose: () => { this.taskDoneListeners.delete(listener); } };
  }

  /** PFC-S1 P2: runner calls this after stamping finishedAt. Safe on
   *  zero listeners. Per-task idempotency is the caller's
   *  responsibility — the runner fires once per task, and
   *  task-notification queue de-dups via taskId so double-fires are
   *  harmless. */
  notifyTaskDone(task: AgentTask): void {
    if (this.taskDoneListeners.size === 0) return;
    for (const listener of this.taskDoneListeners) {
      try { listener(task); } catch { /* observer isolation */ }
    }
  }
}

/** Drain an event stream to the final assistant text. Throws with the
 *  captured error message on error / abort. Convenience for callers
 *  that only care about the final result — e.g., consensus runner
 *  feeding results into a table. */
export async function collectAgentText(
  events: AsyncGenerator<AgentEvent, void, unknown>,
): Promise<string> {
  let text = '';
  for await (const ev of events) {
    if (ev.type === 'text') text += ev.delta;
    else if (ev.type === 'done') return ev.text;
    else if (ev.type === 'error') throw new Error(ev.message);
    else if (ev.type === 'status' && ev.stage === 'aborted') {
      throw new Error('agent aborted');
    }
  }
  return text;
}

/** Shared process-wide registry. Plugins usually import this rather
 *  than instantiating their own — keeps the task list unified across
 *  the log pane, debug tooling, and /agent slash commands. */
export const globalAgentRegistry = new AgentRegistry();
