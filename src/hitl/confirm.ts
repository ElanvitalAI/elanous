// Unified Y/N confirmation — BI-P3.
//
// requestConfirmation(opts) races the user's wired HITL channels
// (Telegram, Discord, Pushcut, terminal) and resolves to the first
// answer. Each channel is expressed as a ConfirmChannel strategy
// with request() + cancel() — tests inject fakes, dashboard wires
// the real ones at startup.
//
// Design:
//   • Channels run concurrently; Promise.race picks the winner.
//   • After the race, remaining channels are cancel()'d so the user
//     doesn't get stale "confirm?" prompts on other devices.
//   • Default timeout 120s. On timeout, the fallback answer is
//     supplied by opts.onTimeout (default 'false' i.e. reject).
//   • Channels that throw are treated as "did not respond" and drop
//     from the race quietly.

export type HitlAnswer = boolean;
export type HitlChannelName = 'telegram' | 'discord' | 'pushcut' | 'terminal' | string;

export interface ConfirmRequest {
  prompt: string;
  header?: string;
  detail?: string;
  yesLabel?: string;     // default 'Yes'
  noLabel?: string;      // default 'No'
  /** Optional correlation id the channel can include in callbacks. */
  requestId?: string;
}

/** Resolution context passed to losing channels' `cancel()` after the
 *  race settles. Lets channel implementations surface the actual
 *  outcome (answer + winning channel) to the user — useful when the
 *  channel has no way to retract its original prompt (e.g. Pushcut
 *  has no notification retract API; the follow-up notification can
 *  show "✅ Approved via PWA" instead of a generic "cancelled"). */
export interface CancelResolution {
  /** Name of the channel that won the race. */
  winnerChannel: string;
  /** The answer that resolved the race. */
  answer: HitlAnswer;
}

export interface ConfirmChannel {
  readonly name: HitlChannelName;
  /** Ask the user. Throws / returns null when the channel can't
   *  deliver (unconfigured). */
  request(req: ConfirmRequest): Promise<HitlAnswer | null>;
  /** Cancel the pending prompt on this channel (racing winner
   *  already answered). No-op when nothing was pending.
   *
   *  When the race resolved through one of the channels (not timeout
   *  / all-failed), `resolution` carries the winner + answer so the
   *  channel can render a status-aware follow-up. The winning channel
   *  itself is NOT called — it already resolved its own request. */
  cancel(resolution?: CancelResolution): Promise<void> | void;
}

export interface ConfirmOpts {
  prompt: string;
  header?: string;
  detail?: string;
  yesLabel?: string;
  noLabel?: string;
  channels?: ConfirmChannel[];     // defaults to getDefaultChannels()
  timeoutMs?: number;              // default 120_000
  /** Fallback when every channel times out / fails. Default false. */
  onTimeout?: () => HitlAnswer;
  /** L1 self-dev 루프 — fail-OPEN policy (opt-in · default OFF).
   *
   *  When a HITL prompt fires in a headless / autonomous coding context
   *  (no interactive human at the terminal), a required approval that no
   *  one answers currently stalls the full `timeoutMs` and then fails
   *  CLOSED (reject) — breaking the self-dev loop. `failOpen:true` flips
   *  the fallback answer to `true` (PROCEED) and shortens the default
   *  timeout to `FAIL_OPEN_TIMEOUT_MS`, so an unattended coding-tool
   *  approval proceeds fast instead of hanging.
   *
   *  Scope is coding-tools-only by construction: ONLY coding-tool
   *  approvers (PtyShell) pass this flag; the trade / financial HITL
   *  path never sets it, so money approvals stay fail-CLOSED. An
   *  explicit `onTimeout` / `timeoutMs` still wins over the failOpen
   *  defaults. The fail-open resolution is audited + observed
   *  (`debug.log('hitl.fail-open', …)`) per §제1원칙. */
  failOpen?: boolean;
  requestId?: string;
  /** AXON P4 — scope filter. When set, only channels whose name
   *  matches the delivery target join the race. Missing ⇒ all
   *  configured channels race as before (backward-compatible). The
   *  mapping (`'modal'` / `'terminal'` → `terminal` channel, the
   *  rest → same-name channel) lives in `./types.ts`. Unknown
   *  delivery values fall through to "all" so callers can forward
   *  user-supplied strings without a pre-validation step. */
  delivery?: import('./types.js').HitlDelivery;
  /** β-4 audit hint — agent kind that triggered the prompt
   *  (e.g. `'agent-cli'`, `'workflow'`). Persisted to hitl-log.jsonl
   *  for later cohorting. Optional. */
  agentKind?: string;
  /** β-4 audit hint — workflow run id when the prompt came from a
   *  workflow approval node. Lets readers join audit entries against
   *  workflow run records. Optional. */
  runId?: string;
}

export interface ConfirmResult {
  answer: HitlAnswer;
  channel: HitlChannelName | 'timeout' | 'all-failed';
  elapsedMs: number;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
/** Shorter timeout used when `failOpen` is set and no explicit
 *  `timeoutMs` is given — an unattended coding-tool approval should
 *  proceed quickly rather than stall the full 2 minutes. */
export const FAIL_OPEN_TIMEOUT_MS = 8_000;

/** The fallback answer when every channel times out / fails. Honors an
 *  explicit `onTimeout`; otherwise `failOpen` → proceed (true), default
 *  → reject (false). Kept in one place so the zero-channel, timeout, and
 *  all-failed paths stay in lock-step. */
function fallbackAnswer(opts: ConfirmOpts): HitlAnswer {
  if (opts.onTimeout) return opts.onTimeout();
  return opts.failOpen === true;
}

/** Local copy of the mapping in `./types.ts` — kept here to dodge a
 *  circular dep (types.ts re-exports from this file). The behaviour
 *  must stay in lock-step: 'modal'/'terminal' → terminal channel,
 *  everything else → same-name channel, 'all'/unknown → true. */
function matchesDelivery(channelName: string, delivery: string): boolean {
  if (delivery === 'all') return true;
  if (delivery === 'modal' || delivery === 'terminal') return channelName === 'terminal';
  return channelName === delivery;
}

let defaultChannels: ConfirmChannel[] = [];

/** Host (dashboard) wires up wired channels once at startup. */
export function registerDefaultConfirmChannels(channels: ConfirmChannel[]): void {
  defaultChannels = channels.slice();
}

export function getDefaultConfirmChannels(): ConfirmChannel[] {
  return defaultChannels.slice();
}

/** Ask the user; resolve to whatever channel answered first. */
export async function requestConfirmation(opts: ConfirmOpts): Promise<ConfirmResult> {
  const allChannels = opts.channels ?? defaultChannels;
  // AXON P4 — optional delivery filter. `channelMatchesDelivery`
  // maps 'modal'/'terminal' to the terminal channel and otherwise
  // compares channel names exactly; `'all'` (or missing) keeps the
  // legacy behaviour. When the filter leaves zero channels the
  // call falls through to the "all-failed" path below, which
  // returns the onTimeout fallback.
  const channels = opts.delivery && opts.delivery !== 'all'
    ? allChannels.filter(c => matchesDelivery(c.name, opts.delivery!))
    : allChannels;
  const req: ConfirmRequest = {
    prompt: opts.prompt,
    header: opts.header,
    detail: opts.detail,
    yesLabel: opts.yesLabel ?? 'Yes',
    noLabel: opts.noLabel ?? 'No',
    requestId: opts.requestId,
  };

  const timeoutMs = opts.timeoutMs
    ?? (opts.failOpen ? FAIL_OPEN_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();

  if (channels.length === 0) {
    const answer = fallbackAnswer(opts);
    observeFailOpen(opts, 'all-failed', answer, req.requestId ?? `hitl-${startedAt}`);
    const result: ConfirmResult = {
      answer,
      channel: 'all-failed',
      elapsedMs: 0,
    };
    emitAudit({
      ts: Date.now(),
      requestId: req.requestId ?? `hitl-${startedAt}`,
      prompt: req.prompt,
      detail: req.detail,
      channel: result.channel,
      answer: result.answer,
      elapsedMs: result.elapsedMs,
      agentKind: opts.agentKind,
      runId: opts.runId,
    });
    return result;
  }

  // Wrap each channel's request so we can associate the winning
  // name and ignore channels that return null / throw.
  const tasks = channels.map((ch) =>
    (async () => {
      try {
        const got = await ch.request(req);
        if (got === null) return null;                  // channel opted out
        return { channel: ch.name as HitlChannelName, answer: got };
      } catch {
        return null;
      }
    })(),
  );

  // ★ 타이머 핸들을 잡아 race 종결 후 clearTimeout — 답 도착 후에도 이 setTimeout 이 살아 one-shot
  //   프로세스(self implement CLI·TUI SelfImplement)의 이벤트루프를 최대 timeoutMs 붙잡는 leak 봉합
  //   (P1 종료지연 ROOT 2·재현 ~105s 와 일치). ⚠️ unref 안 함 — 타이머가 유일 활성 핸들일 때 unref 하면
  //   답 대기 중(데몬·인터랙티브)에 fallback timeout 전 프로세스가 조기 종료될 수 있다(PR#5439 리뷰 must-fix).
  //   ref 유지 + race 종결 후 clearTimeout 만으로 leak 봉합(종료 강제는 호출측 force-exit 이 담당).
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutTask = new Promise<{ channel: 'timeout'; answer: HitlAnswer }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({
      channel: 'timeout',
      answer: fallbackAnswer(opts),
    }), timeoutMs);
  });

  // Promise.race ignores null returns — so we hand-roll "first
  // non-null wins, else all-failed, else timeout".
  let firstAnswer: { channel: HitlChannelName | 'timeout'; answer: HitlAnswer } | null;
  try {
    firstAnswer = await new Promise<{ channel: HitlChannelName | 'timeout'; answer: HitlAnswer } | null>((resolve) => {
      let remaining = tasks.length;
      let settled = false;
      for (const t of tasks) {
        t.then((r) => {
          if (settled) return;
          if (r) { settled = true; resolve(r); return; }
          if (--remaining <= 0) {
            // All channels opted out / threw — let the timeout race win
            // (or the 'all-failed' fallback when timeout is also long).
            settled = true;
            resolve(null);
          }
        });
      }
      timeoutTask.then((r) => {
        if (settled) return;
        settled = true;
        resolve(r);
      });
    });
  } finally {
    // ★ race 종결(정상 resolve / 예외 reject 무관)에 timeout 타이머 clear 를 finally 로 보장(P1 MF1).
    //   leak 봉합: 답 도착 후 setTimeout(ref)이 이벤트루프를 붙잡지 않게 반드시 clear. reject 경로에서도
    //   도달하도록 finally(종료 강제 자체는 호출측 force-exit 담당·이건 타이머 정리만).
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  // Cancel remaining channels so stale prompts don't linger.
  //
  // The winning channel is SKIPPED — it already resolved its own
  // request internally, and calling cancel() on it would surface a
  // confusing "cancelled by other device" follow-up on the very
  // device where the user just answered (Pushcut has no retract
  // API; the cancel notification was originally meant for sibling
  // devices). Losers receive an optional `resolution` so they can
  // render a status-aware follow-up (e.g. "✅ Approved via PWA")
  // instead of a generic cancel marker.
  const winnerName: string | null =
    firstAnswer && firstAnswer.channel !== 'timeout' && firstAnswer.channel !== 'all-failed'
      ? firstAnswer.channel
      : null;
  const resolution: CancelResolution | undefined =
    firstAnswer && winnerName
      ? { winnerChannel: winnerName, answer: firstAnswer.answer }
      : undefined;
  for (const ch of channels) {
    if (resolution && ch.name === resolution.winnerChannel) continue;
    try { await ch.cancel(resolution); } catch { /* ignore */ }
  }

  if (!firstAnswer || firstAnswer.channel === 'timeout') {
    observeFailOpen(
      opts,
      firstAnswer ? 'timeout' : 'all-failed',
      firstAnswer ? firstAnswer.answer : fallbackAnswer(opts),
      req.requestId ?? `hitl-${startedAt}`,
    );
  }
  const result: ConfirmResult = !firstAnswer
    ? {
        answer: fallbackAnswer(opts),
        channel: 'all-failed',
        elapsedMs: Date.now() - startedAt,
      }
    : { ...firstAnswer, elapsedMs: Date.now() - startedAt };

  // cv-3 β-4 audit log emission (Round 2 · 2026-05-08). Fire-and-forget
  // so a slow / broken writer cannot stall the race winner. The hook
  // is registered lazily — production wires `installFileAuditHook` at
  // nexus boot; tests inject their own.
  emitAudit({
    ts: Date.now(),
    requestId: req.requestId ?? `hitl-${startedAt}`,
    prompt: req.prompt,
    detail: req.detail,
    channel: result.channel,
    answer: result.answer,
    elapsedMs: result.elapsedMs,
    agentKind: opts.agentKind,
    runId: opts.runId,
  });

  return result;
}

// ─── Audit hook indirection (β-4) ────────────────────────────────
//
// audit-log.ts owns the writer + reader; confirm.ts just calls the
// registered hook. The two files are not circularly coupled at
// runtime — audit-log.ts only `import type`s from this file.

import type { HitlAuditEntry } from './audit-log.js';
import { getHitlAuditHook } from './audit-log.js';
import { debug } from '../debug/log.js';

/** §제1원칙 — fail-open 은 셀프힐-성 결정이므로 관측을 반드시 남긴다.
 *  timeout / all-failed 로 race 가 끝났을 때만 호출되며, `failOpen` 이
 *  실제로 답을 뒤집었는지(reject→proceed)를 logs.db 카테고리에 남긴다.
 *  failOpen 이 꺼져 있으면(=일반 fail-closed) 조용히 통과 — noise 방지. */
function observeFailOpen(
  opts: ConfirmOpts,
  channel: 'timeout' | 'all-failed',
  answer: HitlAnswer,
  requestId: string,
): void {
  if (!opts.failOpen) return;
  debug.log('hitl.fail-open', requestId, {
    channel,
    answer,
    prompt: opts.prompt,
    delivery: opts.delivery,
    agentKind: opts.agentKind,
  });
}

function emitAudit(entry: HitlAuditEntry): void {
  // Fire-and-forget so a slow/broken hook cannot stall the race
  // winner. Wrapped in try/catch so anything thrown synchronously
  // from the user's hook is swallowed too.
  try {
    const hook = getHitlAuditHook();
    if (!hook) return;
    Promise.resolve(hook(entry)).catch(() => { /* swallow */ });
  } catch { /* swallow */ }
}

// ─── Terminal channel (always available) ─────────────────────────

export interface TerminalConfirmDeps {
  /** Render the prompt somewhere visible (HUD / chat). */
  show: (req: ConfirmRequest) => void;
  /** Clear the prompt. */
  clear: () => void;
  /** Subscribe for an answer. Resolver is called with true/false; if
   *  a second caller subscribes before the first resolves, the host
   *  is free to queue or reject — MVP rejects concurrent requests. */
  awaitAnswer: () => Promise<HitlAnswer | null>;
}

export function createTerminalConfirmChannel(deps: TerminalConfirmDeps): ConfirmChannel {
  return {
    name: 'terminal',
    async request(req) {
      deps.show(req);
      try { return await deps.awaitAnswer(); }
      finally { deps.clear(); }
    },
    cancel() { deps.clear(); },
  };
}

// ─── Pushcut channel (outbound notify — response via separate
// callback is follow-up; MVP resolves to null when Pushcut can't
// round-trip the answer, i.e. always for now) ────────────────────

import type { PushcutClient, PushcutNotification } from '../pushcut/client.js';

export interface PushcutConfirmDeps {
  client: PushcutClient;
  /** Notification name pre-registered on the iPhone side. The
   *  accompanying iOS Shortcut is responsible for receiving the
   *  user's tap and POSTing back to elanous. Until that callback
   *  receiver is wired, this channel just FIRES the notification
   *  and resolves to null (letting other channels win the race). */
  notificationName: string;
  /** Optional delegate that awaits a Pushcut callback keyed by
   *  requestId. Returning undefined → null resolution. */
  awaitCallback?: (requestId: string) => Promise<HitlAnswer | null>;
  /** β-1 dismiss polish (2026-05-08) — title text for the follow-up
   *  "cancelled" notification fired when a sibling channel won the
   *  race. The Pushcut API has no retract endpoint, so this is the
   *  closest we can get to a visual dismiss on iPad. Default
   *  `'✗ cancelled by other device'`; set to `null` to keep the
   *  legacy silent cancel (no follow-up notification). */
  cancelNotificationTitle?: string | null;
}

export function createPushcutConfirmChannel(deps: PushcutConfirmDeps): ConfirmChannel {
  let lastRequestId: string | null = null;
  return {
    name: 'pushcut',
    async request(req) {
      if (!deps.client.configured) return null;
      const requestId = req.requestId ?? `hitl-${Date.now()}`;
      lastRequestId = requestId;
      const payload: PushcutNotification = {
        title: req.prompt,
        text: req.detail,
        input: requestId,
        actions: [
          { name: req.yesLabel ?? 'Yes', shortcut: 'monad-confirm-yes', input: requestId },
          { name: req.noLabel ?? 'No',  shortcut: 'monad-confirm-no',  input: requestId },
        ],
      };
      const r = await deps.client.notify(deps.notificationName, payload);
      if (!r.ok) return null;
      if (deps.awaitCallback) return deps.awaitCallback(requestId);
      return null;
    },
    async cancel(resolution?: CancelResolution) {
      const reqId = lastRequestId;
      lastRequestId = null;
      if (!reqId || !deps.client.configured) return;

      // Resolution-aware title: when we know the race outcome,
      // surface it directly ("✅ Approved via PWA") so the iPhone
      // user sees the actual answer instead of a generic cancel
      // marker. Falls back to the legacy `cancelNotificationTitle`
      // (or its default) when no resolution is supplied — e.g. an
      // ad-hoc cancel() call outside the race wrapper.
      let title: string | null;
      if (resolution) {
        title = resolution.answer
          ? `✅ Approved via ${resolution.winnerChannel}`
          : `❌ Rejected via ${resolution.winnerChannel}`;
      } else if (deps.cancelNotificationTitle === undefined) {
        title = '✗ cancelled by other device';
      } else {
        title = deps.cancelNotificationTitle;
      }
      if (title === null) return;

      // Best-effort follow-up notify — no API to retract the
      // original; iOS shows two notifications, the second one
      // signalling the resolution. `actions: []` overrides the
      // Pushcut Notification template's default Yes/No buttons —
      // this follow-up is informational only, not a re-prompt
      // (tapping a default action would fire the iOS Shortcut
      // and POST to /v1/hitl/callback/ without a real requestId,
      // hitting a daemon 404). Failures swallow.
      try {
        await deps.client.notify(deps.notificationName, {
          title,
          text: `request ${reqId}`,
          actions: [],
        });
      } catch { /* swallow */ }
    },
  };
}

// ─── Telegram channel (uses existing TelegramBot.sendMessage +
// inline keyboard callback; the caller provides a thin bridge
// because the bot's sendMessage is instance-based) ───────────────

export interface TelegramConfirmDeps {
  /** Post the prompt; returns a handle that resolves when the user
   *  taps Yes or No (via inline keyboard callback_query). */
  post(req: ConfirmRequest): Promise<{
    answer: Promise<HitlAnswer | null>;
    cancel(): Promise<void> | void;
  }>;
}

export function createTelegramConfirmChannel(deps: TelegramConfirmDeps): ConfirmChannel {
  let handle: { answer: Promise<HitlAnswer | null>; cancel(): Promise<void> | void } | null = null;
  return {
    name: 'telegram',
    async request(req) {
      try { handle = await deps.post(req); }
      catch { return null; }
      return handle.answer;
    },
    async cancel(_resolution?: CancelResolution) { if (handle) { try { await handle.cancel(); } catch { /* */ } handle = null; } },
  };
}

// ─── Discord channel — identical pattern to Telegram, caller posts
// a message + listens for a reply ────────────────────────────────

export interface DiscordConfirmDeps {
  post(req: ConfirmRequest): Promise<{
    answer: Promise<HitlAnswer | null>;
    cancel(): Promise<void> | void;
  }>;
}

export function createDiscordConfirmChannel(deps: DiscordConfirmDeps): ConfirmChannel {
  let handle: { answer: Promise<HitlAnswer | null>; cancel(): Promise<void> | void } | null = null;
  return {
    name: 'discord',
    async request(req) {
      try { handle = await deps.post(req); }
      catch { return null; }
      return handle.answer;
    },
    async cancel(_resolution?: CancelResolution) { if (handle) { try { await handle.cancel(); } catch { /* */ } handle = null; } },
  };
}
