// ── PX-3 P2: HookDispatcher ──
//
// Holds per-event handler lists, invokes them in priority order
// (ascending), enforces per-handler timeouts, isolates errors (one
// bad hook never breaks the chain), and merges outputs according to
// an event-specific reducer. Every invocation writes one NDJSON line
// to ~/.elanous/hooks-log/YYYY-MM-DD.ndjson for postmortem auditing.
//
// Abort semantics (DD-PX3-4): when a hook returns `{abort:...}`, the
// chain stops immediately and the ChainOutcome carries the abort
// reason. Dispatcher callers check `outcome.abort` before consuming
// `outcome.output` so the caller (chat loop, tool runtime,
// dispatchAgent) can short-circuit the turn / tool / spawn.
//
// Output merge (DD-PX3-3): each event has its own reducer. ToolCall
// cascades `modifyInput` — the NEXT hook's input carries the PREVIOUS
// hook's modifyInput — so stacked rewriters compose. Other events
// keep the original input across the chain; only OUTPUT accumulates.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { join } from 'node:path';
import {
  ALL_HOOK_EVENTS,
  type HookEvent,
  type HookEventMap,
  type TurnHookOutput,
  type MessageHookOutput,
  type ToolCallHookOutput,
  type SubagentSpawnHookOutput,
} from './events.js';
import {
  DEFAULT_PRIORITY,
  DEFAULT_TIMEOUT_MS,
  RESERVED_PRIORITY_MAX,
  type HookHandler,
  type HookCtx,
  type ChainOutcome,
  type ChainStep,
} from './types.js';

// ── Audit log ───────────────────────────────────────────────────────

function defaultAuditRoot(): string {
  return join(elanousStateRoot(), 'hooks-log');
}

function todayStamp(now: number): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ── Dispatcher ──────────────────────────────────────────────────────

export interface HookDispatcherOpts {
  /** Override the audit-log directory. null disables auditing. */
  auditRoot?: string | null;
  /** Clock injection for deterministic tests. */
  now?: () => number;
  /** Logger for register-time warnings (reserved priority conflicts). */
  warn?: (msg: string) => void;
}

export interface DispatchOpts<E extends HookEvent> {
  /** For events with a matcher-sensitive subject (e.g. ToolCall's
   *  toolName), pass the subject string so only handlers with a
   *  matching `matcher` fire. When omitted, all handlers of the
   *  event fire regardless of matcher. */
  subject?: string;
  /** Plugin-scoped state + logger. Dispatcher fills pluginId +
   *  abortSignal internally; caller provides state / logger when
   *  available. */
  ctx?: Partial<HookCtx>;
}

export class HookDispatcher {
  private handlers = new Map<HookEvent, HookHandler<any>[]>();
  private auditRoot: string | null;
  private now: () => number;
  private warn: (msg: string) => void;
  /** Lazy — only mkdir when the first audit write happens (so tests
   *  with auditRoot: null skip I/O entirely). */
  private auditRootEnsured = false;

  constructor(opts: HookDispatcherOpts = {}) {
    this.auditRoot = opts.auditRoot === null ? null : (opts.auditRoot ?? defaultAuditRoot());
    this.now = opts.now ?? (() => Date.now());
    this.warn = opts.warn ?? ((m) => console.warn(m));
  }

  // ── Registration ────────────────────────────────────────────────

  register(handler: HookHandler): () => void {
    const list = this.handlers.get(handler.event) ?? [];
    // Reject duplicate id for the same event — caller should
    // unregister first (ids uniquely identify a plugin's handler).
    if (list.some(h => h.id === handler.id)) {
      throw new Error(`hook '${handler.id}' already registered for event '${handler.event}'`);
    }
    if (handler.priority < 0 || !Number.isFinite(handler.priority)) {
      throw new Error(`hook '${handler.id}' has invalid priority ${handler.priority}`);
    }
    if (handler.priority <= RESERVED_PRIORITY_MAX) {
      // Advisory only — built-in Andon/Budget/Termination own this
      // range. User plugins must stay ≥10.
      const message = `hook '${handler.id}' registered with reserved priority ${handler.priority} ` +
        `(range 0-${RESERVED_PRIORITY_MAX} is reserved for built-ins)`;
      // 내장 훅(`core:*`)은 이 구간의 «주인»이다 — 경고 대상이 아니다. 종전엔 `core:andon` 만 뺐고
      // `core:route-banner`·`core:missions` 경고가 TUI 입력줄 위로 새어 화면을 깼다(🅢 2026-09-27 실측 · /research status).
      if (handler.id.startsWith('core:')) {
        debug.log('plugin-hooks', 'reserved-priority', { message });
      } else {
        this.warn(message);
      }
    }
    list.push(handler);
    this.handlers.set(handler.event, list);
    return () => { this.unregister(handler.id); };
  }

  unregister(id: string): boolean {
    for (const [event, list] of this.handlers) {
      const idx = list.findIndex(h => h.id === id);
      if (idx >= 0) {
        list.splice(idx, 1);
        if (list.length === 0) this.handlers.delete(event);
        return true;
      }
    }
    return false;
  }

  list(event?: HookEvent): HookHandler<any>[] {
    if (event) return [...(this.handlers.get(event) ?? [])];
    const out: HookHandler<any>[] = [];
    for (const list of this.handlers.values()) out.push(...list);
    return out;
  }

  clear(): void {
    this.handlers.clear();
  }

  // ── Dispatch ────────────────────────────────────────────────────

  async dispatch<E extends HookEvent>(
    event: E,
    input: HookEventMap[E]['input'],
    opts: DispatchOpts<E> = {},
  ): Promise<ChainOutcome<HookEventMap[E]['output']>> {
    const all = this.handlers.get(event) ?? [];
    const matched = all.filter(h => this.matchSubject(h, opts.subject));
    // Priority ascending; stable within equal priorities (Array.sort
    // in V8 is stable). Caller ordering is preserved for same priority.
    matched.sort((a, b) => a.priority - b.priority);

    const steps: ChainStep[] = [];
    let accumulated: any = emptyOutputFor(event);
    let currentInput: any = input;
    let abort: { reason: string; from: string } | undefined;

    for (const h of matched) {
      const step = await this.invokeOne(h, currentInput, opts.ctx ?? {}, event);
      steps.push(step);

      if (step.status === 'abort' && step.message) {
        abort = { reason: step.message, from: h.id };
        break;
      }

      if (step.status !== 'ok') continue;  // error/timeout contributes nothing

      const out = (step as any).output as HookEventMap[E]['output'];
      accumulated = mergeOutput(event, accumulated, out);
      currentInput = applyInputCascade(event, currentInput, out);

      // Also detect abort fields on the output (some hooks return
      // `{abort:...}` alongside other fields; we honour the abort).
      if ((out as any)?.abort?.reason) {
        abort = { reason: (out as any).abort.reason, from: h.id };
        break;
      }
    }

    return {
      output: accumulated as HookEventMap[E]['output'],
      ...(abort ? { abort } : {}),
      steps,
    };
  }

  private matchSubject(handler: HookHandler, subject?: string): boolean {
    if (!handler.matcher) return true;
    if (subject === undefined) {
      // Matcher is set but caller didn't supply subject — err on the
      // side of skipping so a ToolCall-scoped hook doesn't fire on
      // unrelated subjects.
      return false;
    }
    const m = handler.matcher;
    if (typeof m === 'string') return m === subject;
    return m.includes(subject);
  }

  private async invokeOne<E extends HookEvent>(
    handler: HookHandler<E>,
    input: HookEventMap[E]['input'],
    partialCtx: Partial<HookCtx>,
    event: E,
  ): Promise<ChainStep & { output?: HookEventMap[E]['output'] }> {
    const started = this.now();
    const timeoutMs = handler.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const ac = new AbortController();
    const ctx: HookCtx = {
      pluginId: partialCtx.pluginId ?? handler.id.split(':')[0] ?? 'unknown',
      logger: partialCtx.logger ?? silentLogger,
      state: partialCtx.state,
      abortSignal: ac.signal,
    };

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);

    try {
      const out = await Promise.race([
        Promise.resolve().then(() => handler.invoke(input, ctx)),
        new Promise<never>((_resolve, reject) => {
          ac.signal.addEventListener('abort', () => {
            reject(new Error(timedOut ? `timeout after ${timeoutMs}ms` : 'aborted'));
          }, { once: true });
        }),
      ]);
      clearTimeout(timer);
      const durationMs = this.now() - started;
      // Inspect output for abort directive — bubble up without
      // failing the handler (abort != error).
      if ((out as any)?.abort?.reason) {
        const step: ChainStep = {
          handlerId: handler.id,
          priority: handler.priority,
          status: 'abort',
          durationMs,
          message: (out as any).abort.reason,
          outputKeys: outputKeysOf(out),
        };
        this.audit(event, handler, step);
        return step;
      }
      const step: ChainStep & { output: HookEventMap[E]['output'] } = {
        handlerId: handler.id,
        priority: handler.priority,
        status: 'ok',
        durationMs,
        outputKeys: outputKeysOf(out),
        output: out,
      };
      this.audit(event, handler, step);
      return step;
    } catch (err: any) {
      clearTimeout(timer);
      const durationMs = this.now() - started;
      const message = err?.message ?? String(err);
      const status: ChainStep['status'] = timedOut || /timeout/i.test(message) ? 'timeout' : 'error';
      const step: ChainStep = {
        handlerId: handler.id,
        priority: handler.priority,
        status,
        durationMs,
        message,
      };
      this.audit(event, handler, step);
      return step;
    }
  }

  private audit(event: HookEvent, handler: HookHandler, step: ChainStep): void {
    if (!this.auditRoot) return;
    try {
      if (!this.auditRootEnsured) {
        mkdirSync(this.auditRoot, { recursive: true });
        this.auditRootEnsured = true;
      }
      const ts = this.now();
      const line = JSON.stringify({
        ts,
        event,
        handlerId: handler.id,
        priority: handler.priority,
        durationMs: step.durationMs,
        status: step.status,
        ...(step.message ? { message: step.message } : {}),
        ...(step.outputKeys?.length ? { outputKeys: step.outputKeys } : {}),
      });
      const path = join(this.auditRoot, `${todayStamp(ts)}.ndjson`);
      appendFileSync(path, line + '\n', 'utf-8');
    } catch (err: any) {
      // Audit I/O failure is non-fatal — log once and move on.
      this.warn(`plugin-hooks: audit write failed: ${err?.message ?? err}`);
    }
  }
}

// ── Output merge / cascade reducers ─────────────────────────────────

function emptyOutputFor(event: HookEvent): unknown {
  switch (event) {
    case 'Turn':
    case 'Message':
    case 'ToolCall':
    case 'SubagentSpawn':
      return {};
    case 'StateRestore':
      return undefined;
  }
}

function mergeOutput(event: HookEvent, acc: any, delta: any): any {
  if (!delta) return acc;
  switch (event) {
    case 'Turn': {
      const a = acc as TurnHookOutput;
      const d = delta as TurnHookOutput;
      const systemPromptInject = [a.systemPromptInject, d.systemPromptInject]
        .filter(Boolean).join('\n\n') || undefined;
      const messagesPrepend = [
        ...(a.messagesPrepend ?? []),
        ...(d.messagesPrepend ?? []),
      ];
      return {
        ...(systemPromptInject ? { systemPromptInject } : {}),
        ...(messagesPrepend.length ? { messagesPrepend } : {}),
      };
    }
    case 'Message': {
      const a = acc as MessageHookOutput;
      const d = delta as MessageHookOutput;
      const followup = [
        ...(a.followupMessages ?? []),
        ...(d.followupMessages ?? []),
      ];
      const redirect = d.redirectTo ?? a.redirectTo;
      return {
        ...(followup.length ? { followupMessages: followup } : {}),
        ...(redirect ? { redirectTo: redirect } : {}),
      };
    }
    case 'ToolCall': {
      const a = acc as ToolCallHookOutput;
      const d = delta as ToolCallHookOutput;
      // deny first-wins — once set, don't overwrite.
      const deny = a.deny ?? d.deny;
      // modifyInput last-wins — accumulated result reflects the
      // final override (chain cascade pushed each step into
      // `currentInput`, so the last hook's output is authoritative).
      const modifyInput = d.modifyInput !== undefined ? d.modifyInput : a.modifyInput;
      const allow = d.allow ?? a.allow;
      return {
        ...(deny ? { deny } : {}),
        ...(modifyInput !== undefined ? { modifyInput } : {}),
        ...(allow !== undefined ? { allow } : {}),
      };
    }
    case 'SubagentSpawn': {
      const a = acc as SubagentSpawnHookOutput;
      const d = delta as SubagentSpawnHookOutput;
      const override = {
        ...(a.overrideDefinition ?? {}),
        ...(d.overrideDefinition ?? {}),
      };
      return Object.keys(override).length > 0
        ? { overrideDefinition: override }
        : {};
    }
    case 'StateRestore':
      return undefined;
  }
}

function applyInputCascade(event: HookEvent, input: any, out: any): any {
  // Only ToolCall cascades — its modifyInput is semantically "what the
  // next hook should see". For other events, subsequent hooks get the
  // original input.
  if (event === 'ToolCall' && out?.modifyInput !== undefined) {
    return { ...input, input: out.modifyInput };
  }
  return input;
}

function outputKeysOf(out: unknown): string[] | undefined {
  if (!out || typeof out !== 'object') return undefined;
  const keys = Object.keys(out as Record<string, unknown>);
  return keys.length ? keys : undefined;
}

const silentLogger: HookCtx['logger'] = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ── Global singleton ───────────────────────────────────────────────
//
// One process-wide dispatcher so plugins + the chat loop + tool
// runtime + skill-tool-agent all talk to the same chain.

export const globalHookDispatcher = new HookDispatcher();

/** Convenience: list every event that currently has at least one
 *  registered handler. Used by /plugin hooks to render a debug view. */
export function listActiveHookEvents(d: HookDispatcher = globalHookDispatcher): HookEvent[] {
  const out: HookEvent[] = [];
  for (const e of ALL_HOOK_EVENTS) {
    if (d.list(e).length > 0) out.push(e);
  }
  return out;
}
