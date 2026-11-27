// ELS-SIDECHAT (대표 11-26 17:5x) — the server side of the sidechat popup: ONE short-lived Q&A session that exists only
// while the popup lives. The element (elements/sidechat.ts) owns the input line and an ask counter; this hub owns the
// turns and the streamed answer, so a client's stale copy can never overwrite text the server already streamed (the
// element's hydrate re-fills turns from here on every open/update). Streaming pushes are throttled through one timer
// (never a poll); closing the popup aborts the request and drops the session, and a late chunk of an aborted request is
// ignored by its generation number (no orphan output). The model call is injected: production = the product LLM client
// (getProviderForConfig → streamChatLedgered → textOnly) on the budget tier — no provider code and no keys here.

import { redactSecretText } from '../debug/secret-redaction.js';
import type { OverlayRegistry } from './overlay-registry.js';

export interface SidechatTurn { readonly q: string; readonly a: string; readonly error?: string }
export type SidechatStatus = 'idle' | 'waiting' | 'streaming';
/** ELS-SIDECHAT-EDGE A5: the last question's timing (ms from send) — first token and, once done, the whole answer. */
export interface SidechatTiming { readonly firstMs?: number; readonly totalMs?: number }
/** ELS-SIDECHAT-EDGE A1: «include context» is on — `label` is the focused pane's title, absent = the pane is unavailable. */
export interface SidechatContext { readonly label?: string }
export interface SidechatSnapshot {
  readonly turns: readonly SidechatTurn[]; readonly status: SidechatStatus; readonly input: string;
  /** A5: the typing indicator's frame while waiting for the first token (advances on the throttled push timer). */
  readonly typing?: number;
  readonly timing?: SidechatTiming;
  readonly context?: SidechatContext;
}
/** One edit of the input line. The server applies edits in arrival order to ITS input (the client's copy is only a guess:
 *  a push of an older state can land between two keys, so a client never sends its whole input — live 11-26 18:0x, a fast
 *  paste + Enter sent only the first syllable). */
export type SidechatEdit = { readonly kind: 'type'; readonly text: string } | { readonly kind: 'back' } | { readonly kind: 'clear' } | { readonly kind: 'send' }
  /** A1: `context` toggles «include context»; `pane` names the pane the popup was opened over (open props only). */
  | { readonly kind: 'context' } | { readonly kind: 'pane'; readonly pane: string };
export interface SidechatMessage { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }
/** One model call: yields answer text deltas; must stop when `signal` aborts. */
export type SidechatStream = (messages: readonly SidechatMessage[], signal: AbortSignal) => AsyncIterable<string>;

export interface SidechatHub {
  /** Apply one input edit; `send` asks the current input (ignored while an answer is in flight or the input is empty). */
  readonly edit: (edit: SidechatEdit) => void;
  readonly snapshot: () => SidechatSnapshot;
  /** The popup closed: abort the request in flight and forget the session. */
  readonly reset: () => void;
  readonly active: () => boolean;
}

export interface SidechatHubOptions {
  readonly stream: SidechatStream;
  /** Tell the overlay registry the session changed (it re-hydrates the sidechat layer and pushes the stack). */
  readonly push: () => void;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** A5: the clock for the typing frame and the first-token / total timing (sims and tests inject a fake one). */
  readonly now?: () => number;
  /** A1: the pane reader (server side, auth-checked): the pane's title and its last screen, undefined = unavailable. */
  readonly panes?: SidechatPanes;
}

/** A1: how the hub reaches a pane. `title` is sync (the header), `screen` reads the screen at send time. Both answer
 *  undefined for a missing/closed pane or one the popup's workspace may not read. */
export interface SidechatPanes {
  readonly title: (pane: string) => string | undefined;
  readonly screen: (pane: string) => Promise<{ readonly title: string; readonly screen: string } | undefined>;
}

// 출처: ELS-SIDECHAT-EDGE A1 (대표 11-26) — «the focused pane's last ~60 visible lines».
export const SIDECHAT_CONTEXT_LINES = 60;

/** The context text for the model: the screen's last visible lines (trailing blank rows dropped), redacted with the shared
 *  redactSecretText — the raw screen never leaves the server and never reaches a prop. */
export function sidechatContextText(screen: string, lines = SIDECHAT_CONTEXT_LINES): string {
  const rows = screen.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map((row) => row.replace(/\s+$/, ''));
  while (rows.length && !rows.at(-1)) rows.pop();
  return redactSecretText(rows.slice(-lines).join('\n'));
}

// 출처: ELS-SIDECHAT — a push re-hydrates and writes overlays.json; 150 ms keeps a fast stream readable (~7 frames/s) and
// the server light (els always lightweight). The first token must come within 30 s, the whole answer within 90 s.
export const SIDECHAT_PUSH_MS = 150;
export const SIDECHAT_FIRST_TOKEN_MS = 30_000;
export const SIDECHAT_ANSWER_MS = 90_000;
// 출처: ELS-SIDECHAT-EDGE A5 — the typing indicator steps every 300 ms while waiting (the same push timer, at half the stream
// rate: each step re-hydrates and writes overlays.json, and a dot cycle reads fine at ~3 frames/s). It stops at the first token.
export const SIDECHAT_TYPING_MS = 300;
// Bounds: a popup is a quick question, not a document.
export const SIDECHAT_MAX_TURNS = 20;
export const SIDECHAT_MAX_ANSWER = 24_000;
export const SIDECHAT_MAX_QUESTION = 2_000;

export const SIDECHAT_SYSTEM = 'You are a quick side assistant inside a terminal workspace (els). Answer briefly and directly in the user\'s language. Use Markdown (short lists, tables, fenced code) only when it helps.';

/** A clean one-line message for a failed call (never a stack, never a key). */
export function sidechatErrorMessage(error: unknown, timedOut: 'first' | 'answer' | undefined): string {
  if (timedOut === 'first') return 'No answer yet — the model did not start in 30 s. Try again.';
  if (timedOut === 'answer') return 'The answer took too long and was stopped. Try a shorter question.';
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const line = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/(sk|xai|key)[-_][A-Za-z0-9_-]{6,}/gi, '[redacted]').trim().slice(0, 120);
  return line ? `The model call failed: ${line}` : 'The model call failed. Try again.';
}

export function createSidechatHub(options: SidechatHubOptions): SidechatHub {
  const setTimer = options.setTimer ?? ((callback, ms) => { const handle = setTimeout(callback, ms); (handle as { unref?: () => void }).unref?.(); return handle; });
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let turns: SidechatTurn[] = [];
  let status: SidechatStatus = 'idle';
  let input = '';
  let generation = 0;
  let controller: AbortController | undefined;
  let pushTimer: unknown;
  const timers: unknown[] = [];
  const now = options.now ?? Date.now;
  let askedAt: number | undefined;
  let firstAt: number | undefined;
  let doneAt: number | undefined;
  let pane: string | undefined;
  let context: SidechatContext | undefined;
  const contextOf = (): SidechatContext => { const label = pane ? options.panes?.title(pane) : undefined; return label ? { label } : {}; };

  const flush = (): void => { if (pushTimer !== undefined) { clearTimer(pushTimer); pushTimer = undefined; } options.push(); };
  const schedule = (): void => { if (pushTimer === undefined) pushTimer = setTimer(() => { pushTimer = undefined; options.push(); }, SIDECHAT_PUSH_MS); };
  // A5: while waiting for the first token the push timer re-arms itself (the typing indicator's next frame); the first
  // token, the end, a close or a reset all leave 'waiting' and the chain stops — no separate loop, nothing when idle.
  const typingTick = (): void => {
    if (pushTimer === undefined && status === 'waiting') pushTimer = setTimer(() => { pushTimer = undefined; options.push(); typingTick(); }, SIDECHAT_TYPING_MS);
  };
  const clearRunTimers = (): void => { for (const handle of timers.splice(0)) clearTimer(handle); };
  const setLast = (turn: SidechatTurn): void => { turns = [...turns.slice(0, -1), turn]; };

  const run = async (gen: number, messages: SidechatMessage[], withContext: string | undefined): Promise<void> => {
    const abort = new AbortController();
    controller = abort;
    let timedOut: 'first' | 'answer' | undefined;
    let first = true;
    timers.push(setTimer(() => { if (first) { timedOut = 'first'; abort.abort(); } }, SIDECHAT_FIRST_TOKEN_MS));
    timers.push(setTimer(() => { timedOut = 'answer'; abort.abort(); }, SIDECHAT_ANSWER_MS));
    try {
      if (withContext !== undefined) {
        // A1: read the pane NOW (the screen as it stands when the question goes); a missing pane → «unavailable», asked without.
        let got: { title: string; screen: string } | undefined;
        try { got = await options.panes?.screen(withContext); } catch { got = undefined; }
        if (gen !== generation) return;
        if (context) context = got ? { label: got.title } : {};
        if (got) messages.splice(1, 0, { role: 'system', content: `Context — the last visible lines of the user's focused terminal pane «${got.title}» (secrets masked):\n\`\`\`\n${sidechatContextText(got.screen)}\n\`\`\`` });
        else { flush(); typingTick(); }                  // «unavailable» shows now; the typing indicator keeps stepping
      }
      for await (const delta of options.stream(messages, abort.signal)) {
        if (gen !== generation || abort.signal.aborted) break;
        if (!delta) continue;
        // A5: the first token ends the typing chain — its pending step is swapped for the stream's 150 ms push.
        if (first) { firstAt = now(); if (pushTimer !== undefined) { clearTimer(pushTimer); pushTimer = undefined; } }
        first = false;
        const last = turns.at(-1)!;
        const a = (last.a + delta).slice(0, SIDECHAT_MAX_ANSWER);
        setLast({ ...last, a });
        status = 'streaming';
        schedule();
      }
      if (gen !== generation) return;                     // closed while streaming: the session is gone, say nothing
      if (timedOut) throw new Error('timeout');
      const last = turns.at(-1)!;
      if (!last.a.trim()) setLast({ ...last, error: 'The model returned an empty answer. Try again.' });
    } catch (error) {
      if (gen !== generation) return;
      const last = turns.at(-1)!;
      setLast({ ...last, error: sidechatErrorMessage(error, timedOut) });
    } finally {
      if (gen === generation) { clearRunTimers(); controller = undefined; status = 'idle'; doneAt = now(); flush(); }
    }
  };

  return {
    edit(edit) {
      if (edit.kind === 'pane') { if (edit.pane !== pane) { pane = edit.pane; if (context) context = contextOf(); } return; }
      if (edit.kind === 'context') { context = context ? undefined : contextOf(); return; }
      if (edit.kind === 'type') { input = (input + edit.text.replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, SIDECHAT_MAX_QUESTION); return; }
      if (edit.kind === 'back') { input = Array.from(input).slice(0, -1).join(''); return; }
      if (edit.kind === 'clear') { input = ''; return; }
      const q = input.trim();
      if (!q || status !== 'idle') return;
      input = '';
      turns = [...turns, { q, a: '' }].slice(-SIDECHAT_MAX_TURNS);
      status = 'waiting';
      askedAt = now(); firstAt = undefined; doneAt = undefined;
      typingTick();
      const messages: SidechatMessage[] = [{ role: 'system', content: SIDECHAT_SYSTEM }];
      for (const turn of turns) {
        messages.push({ role: 'user', content: turn.q });
        if (turn !== turns.at(-1) && turn.a) messages.push({ role: 'assistant', content: turn.a });
      }
      const gen = ++generation;
      // The push (re-hydrate) happens in the registry right after this hydrate returns; the run starts on the next tick
      // so a synchronous stream cannot re-enter the registry mid-apply.
      const withContext = context && pane ? pane : undefined;
      queueMicrotask(() => { if (gen === generation) void run(gen, messages, withContext); });
    },
    snapshot: () => {
      const typing = status === 'waiting' && askedAt !== undefined ? Math.max(0, Math.floor((now() - askedAt) / SIDECHAT_TYPING_MS)) : undefined;
      const timing: SidechatTiming | undefined = askedAt === undefined ? undefined
        : { ...(firstAt !== undefined ? { firstMs: firstAt - askedAt } : {}), ...(doneAt !== undefined ? { totalMs: doneAt - askedAt } : {}) };
      return { turns, status, input, ...(typing !== undefined ? { typing } : {}), ...(timing && (timing.firstMs !== undefined || timing.totalMs !== undefined) ? { timing } : {}), ...(context ? { context } : {}) };
    },
    active: () => turns.length > 0 || status !== 'idle' || input !== '' || context !== undefined || pane !== undefined,
    reset() {
      generation++;
      controller?.abort();
      controller = undefined;
      clearRunTimers();
      if (pushTimer !== undefined) { clearTimer(pushTimer); pushTimer = undefined; }
      turns = [];
      status = 'idle';
      input = '';
      askedAt = undefined; firstAt = undefined; doneAt = undefined;
      pane = undefined;
      context = undefined;
    },
  };
}

/** Production stream: the product LLM client on the budget (fast) tier. Loaded lazily so the els server starts light. */
export const productSidechatStream: SidechatStream = async function* (messages, signal) {
  const [{ getProviderForConfig }, { getUserConfig }, { streamChatLedgered }, { textOnly }, { tierModel }] = await Promise.all([
    import('../llm.js'), import('../user-config.js'), import('../llm/ledgered-call.js'), import('../llm/stream-text.js'), import('../llm/model-defaults.js'),
  ]);
  const provider = getProviderForConfig(getUserConfig());
  if (!provider.streamChat) throw new Error('the configured provider cannot stream');
  let model: string | undefined;
  try { model = tierModel('budget', provider.name as Parameters<typeof tierModel>[1]); } catch { model = undefined; }
  const opts = { temperature: 0.3, maxTokens: 1200, signal, ...(model ? { model } : {}) };
  yield* textOnly(streamChatLedgered(provider, messages.map((one) => ({ role: one.role, content: one.content })) as never, opts, { site: 'els-sidechat', jobKind: 'els-sidechat' }));
};

/** A1: the server's pane reader for the hub. A pane is read only when it lives in the sidechat layer's owner workspace
 *  (a layer opened by a workspace pane carries that workspace — server-auth's own-workspace rule); a layer with no owner
 *  workspace was opened by the owner terminal or OP (a hand pane cannot open or update one), so any local pane is fine. */
export interface SidechatPaneSource {
  readonly paneExists: (ref: string) => string | undefined;
  readonly workspaceOf: (ref: string) => { readonly id: string; readonly name: string } | undefined;
  readonly read: (ref: string) => Promise<{ readonly exitCode: number; readonly message: string }>;
  readonly list: () => { readonly message: string };
}
export function sidechatPanes(core: SidechatPaneSource, ownerWorkspace: () => string | undefined): SidechatPanes {
  const allowed = (ref: string): string | undefined => {
    const id = core.paneExists(ref);
    if (!id) return undefined;
    const owner = ownerWorkspace();
    if (owner === undefined) return id;
    const ws = core.workspaceOf(id);
    return ws && (ws.id === owner || ws.name === owner) ? id : undefined;
  };
  const title = (id: string): string => {
    try {
      const rows = (JSON.parse(core.list().message) as { panes?: Array<{ pane?: string; title?: string }> }).panes ?? [];
      const found = rows.find((row) => row.pane === id)?.title;
      return (found ?? id).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 60) || id;
    } catch { return id; }
  };
  return {
    title: (ref) => { const id = allowed(ref); return id ? title(id) : undefined; },
    screen: async (ref) => {
      const id = allowed(ref);
      if (!id) return undefined;
      const read = await core.read(id);
      return read.exitCode === 0 ? { title: title(id), screen: read.message } : undefined;
    },
  };
}

/** The hub's push: re-apply the open sidechat layer's own props (the registry re-validates and re-hydrates from the hub). */
export function pushSidechat(registry: OverlayRegistry | undefined): void {
  const layer = registry?.stack().layers.filter((one) => one.kind === 'sidechat').at(-1);
  if (layer && registry) registry.apply({ action: 'update', id: layer.id, props: layer.props });
}

/** A4: at server start a sidechat layer restored from overlays.json still carries the dead session's turns (and maybe a
 *  «streaming» status). Its session died with the old process, so re-hydrate it from the fresh hub (empty) with the
 *  restart note — no stale turn, no ghost «answering…», no request in flight. Call once, right after the registry exists. */
export function clearRestoredSidechat(registry: OverlayRegistry): void {
  for (const layer of registry.stack().layers.filter((one) => one.kind === 'sidechat')) registry.apply({ action: 'update', id: layer.id, props: { input: '', restarted: true } });
}

/** Closing the popup ends the session: the request in flight is aborted and the turns are forgotten. Event-driven
 *  (the registry's change listener), never polled. */
export function watchSidechatClose(registry: OverlayRegistry, hub: SidechatHub): { readonly dispose: () => void } {
  return registry.onChange((stack) => { if (hub.active() && !stack.layers.some((one) => one.kind === 'sidechat')) hub.reset(); });
}
