import type { FeedbackEnvelope } from '../feedback/envelope.js';
import { isFeedbackEnvelope } from '../feedback/envelope.js';

// UI-Core arc Phase U2 — `elanous/ui/*` extension methods.
//
// ACP's wire protocol carries `sessionUpdate` notifications that wrap
// agent-emitted content chunks. The `elanous/ui/*` namespace piggybacks
// on that channel with a structured text envelope so extension-aware
// clients (TUI · future Web · future iPhone) render custom UI, while
// vanilla ACP clients see a plain-text fallback.
//
// Why a text envelope on top of `sessionUpdate` instead of custom
// JSON-RPC methods? The ACP SDK v0.14.1 doesn't expose a low-level
// escape hatch for agent→client custom methods; custom methods would
// require forking the SDK or bypassing its handler registry. A prefix
// envelope is transparent to the wire protocol, trivially parseable,
// and works on every current peer.
//
// Wire shape:
//
//     [elanous/ui/<method>] <id>
//     <json-payload>
//
// Followed by an optional closing marker on crowded streams:
//
//     <<elanous-ui-end <id>>>
//
// The `id` lets clients round-trip responses (e.g. modal action clicks
// flow back via the next user prompt in a reserved shape — see
// `parseElanousUiResponse`).

export type ElanousUiModalKind = 'info' | 'warn' | 'danger' | 'prompt';

export interface ElanousUiModalAction {
  id: string;
  label: string;
  /** Visual tone hint for the client's renderer. */
  tone?: 'primary' | 'secondary' | 'danger';
}

export interface ElanousUiShowModalPayload {
  /** Opaque id chosen by the caller · used for response round-trip. */
  id: string;
  kind: ElanousUiModalKind;
  title: string;
  body?: string;
  actions: readonly ElanousUiModalAction[];
  /** Optional timeout (ms) after which the client auto-dismisses with
   *  action id `__timeout__`. */
  timeoutMs?: number;
}

export type ElanousUiToastTone = 'info' | 'success' | 'warn' | 'error';

export interface ElanousUiShowToastPayload {
  id: string;
  tone: ElanousUiToastTone;
  text: string;
  /** Duration (ms) · default 3000. */
  durationMs?: number;
}

export interface ElanousUiUpdateStatusPillPayload {
  /** Pill slot identifier (e.g. `bco-daemon` · `kgs-sync`). */
  id: string;
  /** Display text. Empty string clears the pill. */
  text: string;
  tone?: 'neutral' | 'info' | 'success' | 'warn' | 'error';
  /** Optional short tooltip · shown on hover. */
  tooltip?: string;
}

/** Per-request LLM usage telemetry. ACP's `UsageUpdate` is session-
 *  level context-window info; this is per-request token counts plus
 *  prompt-cache totals, which the dashboard's status bar consumes via
 *  `recordUsage`. Piggybacks on the `elanous/ui/*` envelope because no
 *  native ACP variant fits the shape. */
export interface ElanousUiUsagePayload {
  /** Opaque correlation id. Dashboard uses `turn:<epoch>` per turn. */
  id: string;
  provider?: 'anthropic' | 'openai';
  /** 그 턴이 실제로 요청한 모델(라우팅 결과 — 설정 모델과 다를 수 있다). */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export type ElanousUiMethod =
  | 'showModal'
  | 'showToast'
  | 'updateStatusPill'
  | 'usage';

export interface ElanousUiEnvelope<M extends ElanousUiMethod> {
  method: M;
  payload: M extends 'showModal'
    ? ElanousUiShowModalPayload
    : M extends 'showToast'
      ? ElanousUiShowToastPayload
      : M extends 'updateStatusPill'
        ? ElanousUiUpdateStatusPillPayload
        : ElanousUiUsagePayload;
}

/** Format a `elanous/ui/*` envelope for transport over `sessionUpdate`.
 *  The returned string is the full `text` field the server pushes into
 *  an `agent_thought_chunk`. */
export function formatElanousUiEnvelope<M extends ElanousUiMethod>(
  env: ElanousUiEnvelope<M>,
): string {
  const head = `[elanous/ui/${env.method}] ${env.payload.id}`;
  const body = JSON.stringify(env.payload);
  const end = `<<elanous-ui-end ${env.payload.id}>>`;
  return `${head}\n${body}\n${end}`;
}

/** Inverse of `formatElanousUiEnvelope`. Returns `null` when the text
 *  doesn't match the envelope shape — callers should always fall back
 *  to rendering as plain text. */
export function parseElanousUiEnvelope(
  text: string,
): { method: ElanousUiMethod; payload: Record<string, unknown> } | null {
  const lines = text.split('\n');
  const first = lines[0];
  if (!first) return null;
  const m = /^\[elanous\/ui\/([a-zA-Z]+)\] (.+)$/.exec(first);
  if (!m) return null;
  const method = m[1] as ElanousUiMethod;
  if (
    method !== 'showModal' &&
    method !== 'showToast' &&
    method !== 'updateStatusPill' &&
    method !== 'usage'
  ) {
    return null;
  }
  // Body starts on line 1 and ends before the closing marker (or EOF).
  const bodyLines: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^<<elanous-ui-end /.test(line)) break;
    bodyLines.push(line);
  }
  const body = bodyLines.join('\n');
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    return { method, payload };
  } catch {
    return null;
  }
}

/** Client → server response envelope — e.g. modal action click.
 *
 *     [elanous/ui/response] <id> <actionId>
 *
 * Clients inject this on the next prompt's user-text so the server can
 * correlate the response with the outstanding showModal id. This
 * in-band channel is cheap and requires no extra RPC surface. */
export interface ElanousUiResponse {
  id: string;
  actionId: string;
}

export function formatElanousUiResponse(resp: ElanousUiResponse): string {
  return `[elanous/ui/response] ${resp.id} ${resp.actionId}`;
}

export function parseElanousUiResponse(text: string): ElanousUiResponse | null {
  const first = text.split('\n', 1)[0] ?? '';
  const m = /^\[elanous\/ui\/response\] (\S+) (\S+)$/.exec(first);
  if (!m) return null;
  return { id: m[1]!, actionId: m[2]! };
}

/** Capability declaration — the client advertises which `elanous/ui/*`
 *  methods it can render. Callers gate their `showModal` / `showToast`
 *  / `updateStatusPill` calls on `clientCaps.showModal === true` etc.
 *  Missing field → conservative false (extension-unaware client). */
export interface ElanousUiClientCapabilities {
  showModal: boolean;
  showToast: boolean;
  updateStatusPill: boolean;
  usage: boolean;
}

export const ELANOUS_UI_DISABLED: ElanousUiClientCapabilities = {
  showModal: false,
  showToast: false,
  updateStatusPill: false,
  usage: false,
};

export const ELANOUS_UI_FULL: ElanousUiClientCapabilities = {
  showModal: true,
  showToast: true,
  updateStatusPill: true,
  usage: true,
};

/** Parse the `_meta` extension blob a capability-aware client sends in
 *  its ClientCapabilities. Unknown / missing → every flag false. */
export function parseElanousUiCapabilities(
  meta: unknown,
): ElanousUiClientCapabilities {
  if (!meta || typeof meta !== 'object') return { ...ELANOUS_UI_DISABLED };
  const m = meta as { elanous?: { ui?: Record<string, unknown> } };
  const ui = m.elanous?.ui;
  if (!ui || typeof ui !== 'object') return { ...ELANOUS_UI_DISABLED };
  return {
    showModal: ui.showModal === true,
    showToast: ui.showToast === true,
    updateStatusPill: ui.updateStatusPill === true,
    usage: ui.usage === true,
  };
}

/** Emit the ClientCapabilities extension blob. Used by an extension-
 *  aware client to declare what it can render. The resulting object
 *  goes into `ClientCapabilities._meta` (SDK allows arbitrary extra
 *  fields on the wire per JSON-RPC practice). */
export function emitElanousUiCapabilitiesMeta(
  caps: ElanousUiClientCapabilities,
): { elanous: { ui: ElanousUiClientCapabilities } } {
  return { elanous: { ui: { ...caps } } };
}

// ── WT-S-1 — `elanous/term/*` extension methods ─────────────────────
//
// Sibling namespace to `elanous/ui/*`. Same envelope shape, different
// sentinel tokens so the two never collide on a stream that carries
// both. Carries PreviewTerminal raw stdout chunks + PTY exit signals
// from daemon → web/PWA peers attached on the ACP `/v1/acp` channel.
//
// Wire shape:
//
//     [elanous/term/<method>] <terminalId>
//     <json-payload>
//     <<elanous-term-end <terminalId>>>
//
// Method is `terminalOutput` or `terminalExit`. terminalId in the
// head/tail lets a single envelope-aware client filter to the right
// xterm DOM when the same session multiplexes multiple terminals.

export type ElanousTermMethod = 'terminalOutput' | 'terminalExit' | 'terminalInputActivity' | 'terminalFrame';

export interface ElanousTermOutputPayload {
  /** PreviewTerminal id — stable per-session terminal handle. */
  terminalId: string;
  /** UTF-8 raw bytes from the PTY — chunked per `fs.read` boundary
   *  (≤ 8 KB each). Subscribers may need to accumulate for line
   *  framing; see `addRawOutputTap` (T7c1). */
  data: string;
}

export interface ElanousTermExitPayload {
  terminalId: string;
  /** PTY exit code · convention -1 for signal/abort. */
  code: number;
}

/** WT-M-1 — emitted by daemon when ANY peer sends a `terminal/input`
 *  for `(sessionId, terminalId)`. Other peers attached to the same
 *  terminal use this to show a "another device typed" indicator so
 *  the user understands why the shell scrolled without their typing.
 *  The originating peer filters by its own `peerId` to avoid showing
 *  the indicator for its own keystrokes. */
export interface ElanousTermInputActivityPayload {
  terminalId: string;
  /** Short opaque tag the originating PWA generated at boot. Daemon
   *  passes it through unchanged. Receivers compare to their own tag
   *  to skip self-echo. Empty when sender didn't supply one (legacy
   *  client). */
  peerId: string;
  /** ms-precision timestamp when daemon processed the input. */
  timestamp: number;
  /** Byte count of the input chunk — coarse hint for the indicator
   *  (rapid typing vs single-key). Body itself is NOT echoed (privacy
   *  + already covered by terminalOutput PTY echo). */
  bytes: number;
}

/** ⭐P2 (capture substrate · S1+S2) — a full-screen RENDERED frame
 *  snapshot (renderScreen() grid · picker/modal 포함), NOT an incremental
 *  ANSI stream like `terminalOutput`. Emitted by the daemon's manifest→
 *  frame poller so PWA/iOS peers can LIVE-MIRROR the interactive dashboard
 *  TUI that runs in a separate process (nobody holds its PTY). Consumers
 *  render by REPLACING the screen each frame (monitoring · read-only), not
 *  by appending. cf. PLAN-self-observation-capture-substrate §2/§3. */
export interface ElanousTermFramePayload {
  /** SelfReportFrame.surfaceId — e.g. `tui:<pid>`. Doubles as the
   *  terminalId so envelope head/tail routing works unchanged. */
  terminalId: string;
  /** Rendered screen text (post-ANSI grid). Newlines separate rows. */
  frame: string;
  /** Fleet federation key (resolveInstanceName · test/prod scope). */
  instance: string;
  /** Epoch ms the frame was rendered (SelfReportFrame.at) — receivers
   *  drop out-of-order/stale frames by comparing to the last shown. */
  at: number;
}

export type ElanousTermPayload<M extends ElanousTermMethod> =
  M extends 'terminalOutput' ? ElanousTermOutputPayload :
  M extends 'terminalExit' ? ElanousTermExitPayload :
  M extends 'terminalFrame' ? ElanousTermFramePayload :
  ElanousTermInputActivityPayload;

export interface ElanousTermEnvelope<M extends ElanousTermMethod> {
  method: M;
  payload: ElanousTermPayload<M>;
}

/** Format a `elanous/term/*` envelope for transport over `sessionUpdate`. */
export function formatElanousTermEnvelope<M extends ElanousTermMethod>(
  env: ElanousTermEnvelope<M>,
): string {
  const tid = env.payload.terminalId;
  const head = `[elanous/term/${env.method}] ${tid}`;
  const body = JSON.stringify(env.payload);
  const end = `<<elanous-term-end ${tid}>>`;
  return `${head}\n${body}\n${end}`;
}

/** Inverse of `formatElanousTermEnvelope`. Returns `null` when the text
 *  doesn't match the envelope shape — callers should fall back to
 *  rendering as plain `agent_thought_chunk` text. */
export function parseElanousTermEnvelope(
  text: string,
):
  | { method: 'terminalOutput'; payload: ElanousTermOutputPayload }
  | { method: 'terminalExit'; payload: ElanousTermExitPayload }
  | { method: 'terminalInputActivity'; payload: ElanousTermInputActivityPayload }
  | { method: 'terminalFrame'; payload: ElanousTermFramePayload }
  | null {
  const lines = text.split('\n');
  const first = lines[0];
  if (!first) return null;
  const m = /^\[elanous\/term\/([a-zA-Z]+)\] (.+)$/.exec(first);
  if (!m) return null;
  const method = m[1];
  if (method !== 'terminalOutput' && method !== 'terminalExit' && method !== 'terminalInputActivity' && method !== 'terminalFrame') {
    return null;
  }
  const bodyLines: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^<<elanous-term-end /.test(line)) break;
    bodyLines.push(line);
  }
  try {
    const payload = JSON.parse(bodyLines.join('\n')) as Record<string, unknown>;
    if (typeof payload.terminalId !== 'string') return null;
    if (method === 'terminalOutput') {
      if (typeof payload.data !== 'string') return null;
      return {
        method,
        payload: { terminalId: payload.terminalId, data: payload.data },
      };
    }
    if (method === 'terminalExit') {
      if (typeof payload.code !== 'number') return null;
      return {
        method,
        payload: { terminalId: payload.terminalId, code: payload.code },
      };
    }
    if (method === 'terminalFrame') {
      if (typeof payload.frame !== 'string') return null;
      if (typeof payload.instance !== 'string') return null;
      if (typeof payload.at !== 'number' || !Number.isFinite(payload.at)) return null;
      return {
        method,
        payload: {
          terminalId: payload.terminalId,
          frame: payload.frame,
          instance: payload.instance,
          at: payload.at,
        },
      };
    }
    // terminalInputActivity
    if (typeof payload.peerId !== 'string') return null;
    if (typeof payload.timestamp !== 'number') return null;
    if (typeof payload.bytes !== 'number') return null;
    return {
      method,
      payload: {
        terminalId: payload.terminalId,
        peerId: payload.peerId,
        timestamp: payload.timestamp,
        bytes: payload.bytes,
      },
    };
  } catch {
    return null;
  }
}

/** Capability flags — sibling to ElanousUiClientCapabilities. The client
 *  declares which `elanous/term/*` methods it can render; daemon gates
 *  emission so old clients don't see the envelope text bleed through. */
export interface ElanousTermClientCapabilities {
  terminalOutput: boolean;
  terminalExit: boolean;
  /** WT-M-1 — receive `terminalInputActivity` pings from other peers
   *  attached to the same terminal. Optional so legacy PWAs that
   *  don't render the indicator still negotiate cleanly. */
  terminalInputActivity?: boolean;
  /** ⭐P2 — receive `terminalFrame` full-screen snapshots (live-mirror
   *  the interactive dashboard TUI). Optional so legacy PWAs that can't
   *  render a mirror don't get the envelope text bleed. */
  terminalFrame?: boolean;
}

export const ELANOUS_TERM_DISABLED: ElanousTermClientCapabilities = {
  terminalOutput: false,
  terminalExit: false,
  terminalInputActivity: false,
  terminalFrame: false,
};

export const ELANOUS_TERM_FULL: ElanousTermClientCapabilities = {
  terminalOutput: true,
  terminalExit: true,
  terminalInputActivity: true,
  terminalFrame: true,
};

/** Parse the `_meta.elanous.term` extension blob from ClientCapabilities. */
export function parseElanousTermCapabilities(
  meta: unknown,
): ElanousTermClientCapabilities {
  if (!meta || typeof meta !== 'object') return { ...ELANOUS_TERM_DISABLED };
  const m = meta as { elanous?: { term?: Record<string, unknown> } };
  const term = m.elanous?.term;
  if (!term || typeof term !== 'object') return { ...ELANOUS_TERM_DISABLED };
  return {
    terminalOutput: term.terminalOutput === true,
    terminalExit: term.terminalExit === true,
    terminalInputActivity: term.terminalInputActivity === true,
    terminalFrame: term.terminalFrame === true,
  };
}

// ── PLAN-ios-rich-dev-feedback-hydrate · M1-S — `elanous/feedback/*` ──
//
// Sibling namespace to `elanous/ui/*` and `elanous/term/*`. Carries
// `FeedbackEnvelope` (src/feedback/envelope.ts) from daemon → ACP peer
// (PWA · TUI · iOS native) on top of `agent_thought_chunk` text because
// ACP SDK v0.14.1's sessionUpdate discriminant validator rejects custom
// kinds. iOS Codable mirror parses the envelope JSON inside the body.
//
// Wire shape:
//
//     [elanous/feedback/emit] <blockId>
//     <FeedbackEnvelope JSON>
//     <<elanous-feedback-end <blockId>>>
//
// blockId is the envelope's own stable merge key (makeToolCallBlockId
// etc.) so a single envelope-aware client routes the body straight into
// its accumulator without re-parsing the head.

export type ElanousFeedbackMethod = 'emit';

export interface ElanousFeedbackEnvelopeShape {
  method: ElanousFeedbackMethod;
  payload: FeedbackEnvelope;
}

export function formatElanousFeedbackEnvelope(env: ElanousFeedbackEnvelopeShape): string {
  const head = `[elanous/feedback/${env.method}] ${env.payload.blockId}`;
  const body = JSON.stringify(env.payload);
  const end = `<<elanous-feedback-end ${env.payload.blockId}>>`;
  return `${head}\n${body}\n${end}`;
}

/** Inverse of `formatElanousFeedbackEnvelope`. Returns `null` when the
 *  text doesn't match the envelope shape OR when the embedded JSON
 *  fails `isFeedbackEnvelope` validation. Callers fall back to
 *  rendering as plain `agent_thought_chunk` text. */
export function parseElanousFeedbackEnvelope(
  text: string,
): ElanousFeedbackEnvelopeShape | null {
  const lines = text.split('\n');
  const first = lines[0];
  if (!first) return null;
  const m = /^\[elanous\/feedback\/([a-zA-Z]+)\] (.+)$/.exec(first);
  if (!m) return null;
  const method = m[1];
  if (method !== 'emit') return null;
  const bodyLines: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^<<elanous-feedback-end /.test(line)) break;
    bodyLines.push(line);
  }
  try {
    const payload = JSON.parse(bodyLines.join('\n'));
    if (!isFeedbackEnvelope(payload)) return null;
    return { method, payload };
  } catch {
    return null;
  }
}

/** Emit a ClientCapabilities `_meta.elanous.term` blob. Web/PWA peers
 *  declare full caps at connect time. */
export function emitElanousTermCapabilitiesMeta(
  caps: ElanousTermClientCapabilities,
): { elanous: { term: ElanousTermClientCapabilities } } {
  return { elanous: { term: { ...caps } } };
}
