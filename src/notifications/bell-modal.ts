// ── NotificationBellModal (NT4) ──
//
// Modal widget showing every session's recent notifications in a
// single audit list. Invoked via Ctrl+B b (NT5).
//
// Layout:
//   ┌─ Notifications ([u] Unread  [e] Errors  [a] All) ─────┐
//   │  term:1 · 12:34:56 · status · working · message_start │
//   │  term:2 · 12:34:58 · block  · blk:3    · "Hello user" │
//   │  term:1 · 12:35:01 · error  · err      · parse-error  │
//   │  ...                                                  │
//   └─ j/k nav · Enter focus+markRead · u/e/a filter · Esc ┘
//
// The widget is pure — state.events is mutated by the dashboard on
// each open/filter change via `rebuildEvents(store, filter)`.

import type { WidgetDef } from '../widgets/types.js';
import type { NotificationEvent, NotificationKind, NotificationStore } from './store.js';
import { C, truncate, visibleWidth } from '../tui.js';
import { paneTitle } from '../panes/pane-title.js';
import { icon } from '../theme/icons.js';
import {
  describeNotificationEvent,
  renderStatusModule,
  type DescribeNotificationOpts,
} from '../expression/index.js';

export type NotificationFilter = 'u' | 'e' | 'a';

export interface BellModalState {
  events: NotificationEvent[];
  cursor: number;
  offset: number;
  filter: NotificationFilter;
}

export interface BellModalConfig {
  events?: NotificationEvent[];
  filter?: NotificationFilter;
}

const KIND_COLOR: Record<NotificationKind, (s: string) => string> = {
  status:       (s) => C.info(s),
  osc:          (s) => C.muted(s),
  exit:         (s) => C.subtext(s),
  block:        (s) => C.accent(s),
  error:        (s) => C.error(s),
  hitl:         (s) => C.warning(s),
  'agent-done': (s) => C.info(s),
  escalation:   (s) => C.error(s),
  briefing:     (s) => C.accent(s),
};

// IDX-6 Phase 6 migration — kinds that map to a semantic IconTokens
// slot pull through theme-icons (auto ASCII fallback + preset
// override). `status / osc / exit` have no semantic match, so their
// decorative glyphs stay inline. kindGlyph() evaluates per-call so a
// /theme switch mid-session picks up the new glyphs on next render.
function kindGlyph(kind: NotificationKind): string {
  switch (kind) {
    case 'block':       return icon('notification');
    case 'error':       return icon('error');
    case 'hitl':        return icon('warning');
    case 'agent-done':  return icon('success');
    case 'escalation':  return icon('error');   // critical — shares slot with error
    case 'briefing':    return icon('notification');
    case 'status':      return '●';
    case 'osc':         return '◌';
    case 'exit':        return '◻';
    default:            return '·';
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function fit(line: string, width: number): string {
  const shown = visibleWidth(line) > width ? truncate(line, width) : line;
  return shown + ' '.repeat(Math.max(0, width - visibleWidth(shown)));
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Pure filter — useful for both the widget's initial state and
 *  dashboard-side rebuilds. */
export function filterEvents(events: readonly NotificationEvent[], filter: NotificationFilter): NotificationEvent[] {
  if (filter === 'a') return events.slice();
  if (filter === 'u') return events.filter(e => !e.read);
  if (filter === 'e') return events.filter(e => e.kind === 'error');
  return events.slice();
}

/** Dashboard convenience — pull full store, sort, filter. */
export function rebuildBellEvents(store: NotificationStore, filter: NotificationFilter): NotificationEvent[] {
  return filterEvents(store.list(), filter);
}

/** SR-friendly utterance for the bell-modal's currently focused row.
 *  Returns `null` when the state has no events (so the host can skip
 *  the emit entirely instead of speaking an empty string).
 *
 *  Hosts call this whenever the cursor moves (or on initial open) and
 *  forward the result to whatever channel their SR integration uses
 *  (aria-live mirror file, fifo, etc.). The returned text is plain
 *  ASCII-friendly (no ANSI escapes, no decorative glyphs) per the
 *  expression a11y contract.
 *
 *  2026-04-28 (Pick A PR-S5) — adds SR coverage to bell-modal event
 *  rows; chip migration (PR #914) covered only the filter chips. */
export function describeBellModalCursor(
  state: BellModalState,
  opts: DescribeNotificationOpts = {},
): string | null {
  if (state.events.length === 0) return null;
  const idx = Math.max(0, Math.min(state.cursor, state.events.length - 1));
  const evt = state.events[idx]!;
  return describeNotificationEvent(evt, opts);
}

const bellModalWidget: WidgetDef<BellModalState, BellModalConfig> = {
  type: 'notification-bell',
  description: 'Session notification mailbox (NT4) — unified list with filter chips',
  defaultCharacter: 'Notifications',

  initialState(config) {
    return {
      events: config?.events ?? [],
      cursor: 0,
      offset: 0,
      filter: config?.filter ?? 'a',
    };
  },

  render(state, ctx, character) {
    const lines: string[] = [];
    const w = ctx.width;
    const h = ctx.height;
    if (w < 8 || h < 3) return lines;

    lines.push(paneTitle(character, ctx.focused, w));

    // Filter chip bar — paints `[u] Unread` etc. through expression
    // renderStatusModule so the active/inactive color emits as raw
    // SGR (chalk-environment-deterministic) instead of going through
    // chalk's auto-detect path. Visual identity preserved: same chip
    // text, same per-state color (mauve accent for active, muted for
    // inactive).
    const chip = (id: NotificationFilter, label: string): string => {
      const isActive = state.filter === id;
      return renderStatusModule(
        {
          kind: 'status-module',
          id: `bell-chip-${id}`,
          text: `[${id}] ${label}`,
          style: { fg: isActive ? '#cba6f7' : '#7f849c' },
        },
        'truecolor',
        { style: 'inline' },
      );
    };
    const filterLine = ` ${chip('u', 'Unread')}  ${chip('e', 'Errors')}  ${chip('a', 'All')}`;
    lines.push(fit(filterLine, w));

    const bodyH = Math.max(0, h - lines.length - 1); // -1 for footer
    if (bodyH <= 0) {
      return lines;
    }

    if (state.events.length === 0) {
      const msg = state.filter === 'u' ? 'No unread notifications.' : state.filter === 'e' ? 'No errors.' : 'No notifications.';
      lines.push(C.muted(fit(`  ${msg}`, w)));
      while (lines.length < h - 1) lines.push(' '.repeat(w));
    } else {
      state.cursor = clamp(state.cursor, 0, state.events.length - 1);
      let offset = state.offset;
      if (state.cursor < offset) offset = state.cursor;
      if (state.cursor >= offset + bodyH) offset = state.cursor - bodyH + 1;
      offset = clamp(offset, 0, Math.max(0, state.events.length - bodyH));
      state.offset = offset;

      for (let i = 0; i < bodyH; i++) {
        const idx = offset + i;
        if (idx >= state.events.length) {
          lines.push(' '.repeat(w));
          continue;
        }
        const e = state.events[idx]!;
        const unreadGlyph = e.read ? ' ' : '•';
        const kindG = kindGlyph(e.kind);
        const time = fmtTime(e.ts);
        const head = ` ${unreadGlyph} ${time} ${kindG} ${e.sessionId}`;
        const tail = e.body ? ` · ${e.title} · ${e.body}` : ` · ${e.title}`;
        const raw = fit(head + tail, w);
        const painted = KIND_COLOR[e.kind](raw);
        const isCur = idx === state.cursor;
        if (isCur && ctx.focused) lines.push(C.cursor(raw));
        else if (isCur)            lines.push(C.cursorAlt(raw));
        else                       lines.push(painted);
      }
    }

    // Footer
    const footer = ' j/k nav · Enter focus · u/e/a filter · Esc close';
    lines.push(C.muted(fit(footer, w)));
    return lines;
  },

  onKey(ev, state) {
    const max = state.events.length - 1;
    switch (ev.name) {
      case 'escape':
        return { type: 'submit', text: 'bell:close' };
      case 'u':
        state.filter = 'u';
        state.cursor = 0;
        state.offset = 0;
        return { type: 'submit', text: 'bell:filter:u' };
      case 'e':
        state.filter = 'e';
        state.cursor = 0;
        state.offset = 0;
        return { type: 'submit', text: 'bell:filter:e' };
      case 'a':
        state.filter = 'a';
        state.cursor = 0;
        state.offset = 0;
        return { type: 'submit', text: 'bell:filter:a' };
      case 'j': case 'down':
        if (max >= 0) state.cursor = Math.min(state.cursor + 1, max);
        return { type: 'refresh' };
      case 'k': case 'up':
        if (max >= 0) state.cursor = Math.max(state.cursor - 1, 0);
        return { type: 'refresh' };
      case 'g': case 'home':
        state.cursor = 0;
        state.offset = 0;
        return { type: 'refresh' };
      case 'G': case 'end':
        if (max >= 0) state.cursor = max;
        return { type: 'refresh' };
      case 'enter': {
        const evt = state.events[state.cursor];
        return evt ? { type: 'submit', text: `bell:focus:${evt.sessionId}` } : { type: 'none' };
      }
      default:
        return { type: 'none' };
    }
  },
};

export default bellModalWidget;
