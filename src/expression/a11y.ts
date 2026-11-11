// Screen-reader descriptors — turn a `Spec` into a single-line
// utterance that a terminal screen reader (NVDA + WSL, VoiceOver +
// macOS Terminal, Orca + Linux) can read out coherently.
//
// The output has zero ANSI escapes and no decorative glyphs; punctuation
// is shaped so SR engines pause naturally between fields. Hosts emit
// the descriptor through whatever channel their SR integration uses
// (e.g. an aria-live mirror file, a `tput cup` message line, or a
// piped status fifo). The descriptor itself is a pure transform.
//
// Localized via the i18n bundle: pass `locale` through to use Korean
// strings, or omit to inherit the env-detected locale.

import type { Spec } from './spec/types.js';
import { type Locale } from './locale.js';
import { getMessages, format, type Messages } from './i18n/index.js';

export interface DescribeOpts {
  /** Override env-detected locale. */
  locale?: Locale;
}

/** Severity buckets for `describeNotificationEvent`. Hosts pick the
 *  bucket via `notificationLevelLabel(kind, messages)`; we keep this
 *  union narrow so callers can statically reason about severity even
 *  before resolving to a localized string. */
export type NotificationLevel = 'info' | 'warning' | 'error';

/** Map a free-form notification kind (elanous's `NotificationKind`
 *  union: status / osc / exit / block / error / hitl / agent-done /
 *  escalation / briefing) to a 3-bucket severity. The mapping is intentionally
 *  conservative — `escalation` and `error` shout, `hitl` warns,
 *  everything else is muted info — and lives in expression so any
 *  surface that emits SR utterances (bell-modal, control-plane health,
 *  etc.) reads from the same table. */
export function notificationLevelOf(kind: string): NotificationLevel {
  switch (kind) {
    case 'error':
    case 'escalation':
      return 'error';
    case 'hitl':
      return 'warning';
    case 'status':
    case 'osc':
    case 'exit':
    case 'block':
    case 'agent-done':
    default:
      return 'info';
  }
}

/** Resolve a localized severity word for the SR utterance. The kind
 *  → level mapping is static (see `notificationLevelOf`); the i18n
 *  bundle supplies one of three labels: info / warning / error. */
export function notificationLevelLabel(
  kind: string,
  messages: Messages,
): string {
  const level = notificationLevelOf(kind);
  switch (level) {
    case 'error':   return messages.notificationLevelError;
    case 'warning': return messages.notificationLevelWarning;
    case 'info':
    default:        return messages.notificationLevelInfo;
  }
}

/** Notification event shape — kept structural (not coupled to
 *  elanous's `NotificationEvent` from `src/notifications/store.ts`)
 *  so the helper stays usable from any surface that holds a similar
 *  record (e.g. control-plane audit logs). */
export interface DescribableNotificationEvent {
  sessionId: string;
  ts: number;
  kind: string;
  title: string;
  body?: string;
}

export interface DescribeNotificationOpts extends DescribeOpts {
  /** Override the default `HH:MM:SS` time formatter. */
  fmtTime?: (ts: number) => string;
  /** When `true` (default) the kind word resolves through the i18n
   *  bundle (info / warning / error). When `false`, the raw kind
   *  string is emitted instead — useful for log mirrors where the
   *  exact kind is the audit signal. */
  localizeKind?: boolean;
}

const DEFAULT_FMT_TIME = (ts: number): string => {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

/** Build a screen-reader utterance for a notification event. Returns
 *  plain text (no ANSI). Format:
 *
 *      "<sessionId> · <time> · <kindLabel> · <title>"
 *      "<sessionId> · <time> · <kindLabel> · <title> · <body>"  (when body)
 *
 *  The dot separator stays consistent with the visual row in
 *  `bell-modal.ts` so SR users hear the same field order they see in
 *  the rendered list. */
export function describeNotificationEvent(
  event: DescribableNotificationEvent,
  opts: DescribeNotificationOpts = {},
): string {
  const messages = getMessages(opts.locale);
  const fmtTime = opts.fmtTime ?? DEFAULT_FMT_TIME;
  const localize = opts.localizeKind !== false;
  const kindWord = localize
    ? notificationLevelLabel(event.kind, messages)
    : event.kind;
  const head = `${event.sessionId} · ${fmtTime(event.ts)} · ${kindWord} · ${event.title}`;
  return event.body ? `${head} · ${event.body}` : head;
}

/** Build a screen-reader utterance for a Spec. Returns plain text
 *  (no ANSI, no glyphs). */
export function describeForScreenReader(spec: Spec, opts: DescribeOpts = {}): string {
  const messages = getMessages(opts.locale);
  switch (spec.kind) {
    case 'progress': {
      const value = clamp01(spec.value);
      const percent = Math.round(value * 100);
      const head = format(messages.ariaProgress, { percent });
      return spec.label ? `${head} ${spec.label}` : head;
    }
    case 'spinner':
      return format(messages.ariaSpinner, { label: spec.label ?? messages.loading });
    case 'table': {
      const head = format(messages.ariaTable, {
        cols: spec.columns.length,
        rows: spec.rows.length,
      });
      return spec.title ? `${spec.title}. ${head}` : head;
    }
    case 'markdown': {
      const headings = collectHeadings(spec.body ?? '');
      const head = messages.ariaMarkdown;
      if (spec.title && headings.length > 0) {
        return `${spec.title}. ${head} ${headings.join('. ')}.`;
      }
      if (spec.title) return `${spec.title}. ${head}`;
      if (headings.length > 0) return `${head} ${headings.join('. ')}.`;
      return head;
    }
    case 'modal':
      return `${messages.ariaModal} ${spec.title}. ${spec.body}`;
    case 'picker': {
      const head = format(messages.ariaPicker, { count: spec.items.length });
      return spec.title ? `${spec.title}. ${head}` : head;
    }
    case 'status-module':
      return spec.text;
    case 'step': {
      const head =
        spec.progress
          ? format(messages.stepLabel, {
              n: spec.progress.index,
              total: spec.progress.total,
            })
          : '';
      return head ? `${head}. ${spec.title}.` : `${spec.title}.`;
    }
    case 'interactive-modal': {
      const stepCount = format(messages.stepLabel, { n: 1, total: spec.steps.length });
      return `${messages.ariaWizard} ${spec.title}. ${stepCount}.`;
    }
  }
}

/** Surface a brief plain-text summary of any Spec — useful for log
 *  mirrors / debug snapshots. Today this aliases
 *  `describeForScreenReader`; kept as a separate API so callers can
 *  reach for the right verb without coupling to a11y semantics. */
export function describeSpec(spec: Spec, opts: DescribeOpts = {}): string {
  return describeForScreenReader(spec, opts);
}

// ── Helpers ─────────────────────────────────────────────────────────

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

const RE_HEADING_LINE = /^#{1,6}\s+(.+?)\s*$/;
const RE_INLINE_MARKER = /(\*\*|__|\*|_|`|~~|\[([^\]]+)\]\(([^)]+)\))/g;

/** Extract heading lines from a markdown body, stripping inline
 *  decorations + the URL portion of links. Used to produce a TOC-style
 *  utterance for SR users. */
function collectHeadings(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const m = RE_HEADING_LINE.exec(raw);
    if (!m) continue;
    out.push(stripInlineMarkers(m[1] ?? ''));
  }
  return out;
}

function stripInlineMarkers(text: string): string {
  // Keep link label (`$2` from the alternation), drop everything else.
  return text.replace(RE_INLINE_MARKER, (_match, _whole, linkLabel: string | undefined) =>
    linkLabel ?? '',
  );
}
