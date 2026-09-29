// SSH host picker modal — T4-E4.
//
// Sibling of session-picker-modal. Wraps
// createSearchModal with the registered SSH hosts so Ctrl+K pops
// a fuzz-matchable list; Enter switches the browser pane into
// remote mode against the selected host, Esc cancels.
//
// Label format:
//
//   ● mba     MacBook Air            2m ago
//   ○ node-b    Mac Studio B1          never
//
// Foreground marker (●) flags the host we're currently connected
// to (matches workingDir.remote.host.name). Relative timestamp
// comes from touchSshHost's in-memory last-used map.

import type { SearchItem, SearchModalHandle } from '../chat/search/modal.js';
import type { ThemeTokens } from '../theme/tokens.js';
import { C } from '../tui.js';
import type { ModalBounds } from '../display/modal-stack.js';
import {
  listSshHostsByRecency,
  touchSshHost,
  type SshHost,
  type SshHostWithRuntime,
} from './ssh-hosts.js';
import { filterPickerItemsByLabel } from '../ui/chrome/picker-query.js';
import { createVwFilterPickerModal } from '../ui/vw-filter-picker-modal.js';
import {
  searchItemsToPickerSpec,
  type PickerSearchItem,
  type PickerSpec,
} from '../expression/index.js';

export interface OpenSshPickerOpts {
  bounds: ModalBounds;
  width: number;
  maxVisible?: number;
  /** Name of the currently-connected host. Used to draw the fg
   *  marker; pass null/undefined to show all as background. */
  activeHostName?: string | null;
  /** Called with the selected host. Caller bumps touchSshHost
   *  via this callback (or via the helper). */
  onAccept: (host: SshHost) => void;
  onCancel?: () => void;
  now?: () => number;
  theme?: ThemeTokens;
}

export function createSshPickerModal(opts: OpenSshPickerOpts): SearchModalHandle {
  const nowFn = opts.now ?? (() => Date.now());
  const items = (): SearchItem[] => {
    const all = listSshHostsByRecency(nowFn());
    return all.map((h): SearchItem => ({
      label: formatHostLabel(h, opts.activeHostName ?? null, nowFn()),
      payload: h.name,
    }));
  };
  return createVwFilterPickerModal({
    id: `ssh-picker:${nowFn().toString(36)}`,
    bounds: opts.bounds,
    title: 'SSH hosts',
    width: opts.width,
    maxVisible: opts.maxVisible ?? 8,
    primaryActionLabel: 'connect',
    cancelActionLabel: 'cancel',
    onQuery: (q) => {
      const all = items();
      return filterPickerItemsByLabel(all, q, (it) => String(it.label ?? ''));
    },
    onAccept: (item) => {
      const all = listSshHostsByRecency(nowFn());
      const host = all.find(h => h.name === item.payload);
      if (!host) return;
      touchSshHost(host.name, nowFn());
      opts.onAccept(host);
    },
    onCancel: opts.onCancel,
    theme: opts.theme,
  });
}

function formatHostLabel(h: SshHostWithRuntime, active: string | null, now: number): string {
  const stateGlyph = h.name === active ? C.success('●') : C.muted('○');
  const name = h.name.padEnd(8);
  const desc = (h.description ?? h.host).padEnd(28).slice(0, 28);
  const rel = h.lastUsedAt === 0 ? C.muted('never') : C.muted(`${relativeAge(now - h.lastUsedAt)} ago`);
  const user = h.user ? C.subtext(` ${h.user}@${h.host}`) : '';
  return `${stateGlyph} ${C.info(name)} ${desc}${user} ${rel}`;
}

function relativeAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Build an expression `PickerSpec` describing the registered SSH
 *  hosts (sorted by last-used recency). Pure helper.
 *
 *  Each item's `description` carries the user@host string + last-used
 *  hint so SR users hear the connection target. Adapter strips ANSI
 *  from `formatHostLabel`. Active host is annotated as "active" in
 *  the description (matches the visual ●).
 *
 *  2026-04-28 (Pick A PR-S2) — picker family a11y integration. */
export function buildSshPickerSpec(
  activeHostName: string | null = null,
  now: number = Date.now(),
): PickerSpec {
  const all = listSshHostsByRecency(now);
  const items: PickerSearchItem[] = all.map((h) => {
    const userHost = h.user ? `${h.user}@${h.host}` : h.host;
    const status = h.name === activeHostName ? 'active' : 'idle';
    const lastUsed = h.lastUsedAt === 0
      ? 'never used'
      : `last used ${relativeAge(now - h.lastUsedAt)} ago`;
    return {
      label: formatHostLabel(h, activeHostName, now),
      payload: h.name,
      description: `${status} · ${userHost} · ${lastUsed}`,
    };
  });
  return searchItemsToPickerSpec(items, {
    id: 'ssh-picker',
    title: 'SSH hosts',
  });
}
