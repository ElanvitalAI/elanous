// Ctrl+P finder modal — T4-F2/T5-H1.
//
// Sibling of session/window/ssh pickers. Wraps createSearchModal
// with the finder-scan output. Shows relative paths; match is
// substring case-insensitive with basename matches ranked first.
//
// Scope rule: when workingDir.remote is set, the caller passes a
// `remoteScan` fn that shells to ssh-fs. Otherwise a local
// scanFinder result is consumed. This module is UI glue — scan
// choice stays with the caller.

import type { SearchItem, SearchModalHandle } from '../chat/search/modal.js';
import type { ThemeTokens } from '../theme/tokens.js';
import { C } from '../tui.js';
import type { ModalBounds } from '../display/modal-stack.js';
import { scanFinder, relativizeResults, type FinderScanDeps } from './finder-scan.js';
import { normalizePickerQuery } from '../ui/chrome/picker-query.js';
import { createVwSearchModal } from '../ui/vw-search-modal.js';
import {
  searchItemsToPickerSpec,
  type PickerSearchItem,
  type PickerSpec,
} from '../expression/index.js';

export interface FinderItem {
  relPath: string;
  absPath: string;
}

export interface OpenFinderModalOpts {
  items: FinderItem[];
  bounds: ModalBounds;
  width: number;
  maxVisible?: number;
  truncated?: boolean;
  title?: string;
  onAccept: (item: FinderItem) => void;
  onCancel?: () => void;
  theme?: ThemeTokens;

}

export function rankFinderItems(items: readonly FinderItem[], query: string): FinderItem[] {
  const needle = normalizePickerQuery(query);
  if (!needle) return [...items];
  const basenameMatches: FinderItem[] = [];
  const pathMatches: FinderItem[] = [];
  for (const item of items) {
    const rel = item.relPath.toLowerCase();
    const basename = rel.slice(rel.lastIndexOf('/') + 1);
    if (basename.includes(needle)) basenameMatches.push(item);
    else if (rel.includes(needle)) pathMatches.push(item);
  }
  return [...basenameMatches, ...pathMatches];
}

export function createFinderModal(opts: OpenFinderModalOpts): SearchModalHandle {
  const items = (src: readonly FinderItem[] = opts.items): SearchItem[] => {
    return src.map((it): SearchItem => ({
      label: formatFinderLabel(it),
      payload: it.absPath,
    }));
  };
  const truncatedHint = opts.truncated ? ' (50k cap — narrow by typing)' : '';
  return createVwSearchModal({
    id: `finder:${Date.now().toString(36)}`,
    bounds: opts.bounds,
    title: (opts.title ?? 'Find file') + truncatedHint,
    width: opts.width,
    maxVisible: opts.maxVisible ?? 12,
    primaryActionLabel: 'open',
    cancelActionLabel: 'cancel',
    actionButtons: true,
    onQuery: (q) => {
      return items(rankFinderItems(opts.items, q)).slice(0, 500);
    },
    onAccept: (item) => {
      const target = opts.items.find(i => i.absPath === String(item.payload));
      if (target) opts.onAccept(target);
    },
    onCancel: opts.onCancel,
    theme: opts.theme,
    browseMode: true,
    footerHint: '',
  });
}

function formatFinderLabel(it: FinderItem): string {
  const parts = it.relPath.split('/');
  if (parts.length <= 1) return C.text(it.relPath);
  const basename = parts[parts.length - 1]!;
  const dir = parts.slice(0, -1).join('/');
  return `${C.subtext(dir + '/')}${C.text(basename)}`;
}

/** Build an expression `PickerSpec` describing finder scan results.
 *  Pure helper.
 *
 *  Each item's `description` carries the absolute path (the visual
 *  label only shows relPath with dir muted). Adapter strips the ANSI
 *  styling. Capped to 500 items to mirror the modal's onQuery slice
 *  cap; pass `maxItems` to override.
 *
 *  2026-04-28 (Pick A PR-S2) — picker family a11y integration. */
export function buildFinderPickerSpec(
  items: ReadonlyArray<FinderItem>,
  opts: { title?: string; truncated?: boolean; maxItems?: number } = {},
): PickerSpec {
  const cap = opts.maxItems ?? 500;
  const sliced = items.slice(0, cap);
  const pickerItems: PickerSearchItem[] = sliced.map((it) => ({
    label: formatFinderLabel(it),
    payload: it.absPath,
    description: it.absPath,
  }));
  const title = (opts.title ?? 'Find file') + (opts.truncated ? ' (truncated)' : '');
  return searchItemsToPickerSpec(pickerItems, {
    id: 'finder-picker',
    title,
  });
}

// ── Folder attach picker (Arc C · v2) ───────────────────────────────
//
// Used by two call sites that share the attachment intent:
//   1. Browser pane dblclick on a folder →
//      dashboard.dispatchSidebarSubmit('folder-attach:<path>')
//   2. `@` picker Ctrl+I on a folder → picker-state onAtFolderAttach
//
// Both open the same modal: a recursive file listing under the given
// folder, letting the user pick ONE file that then flows through the
// existing attachment pipeline (`[Kind #N]` token + registry entry).
// This is deliberately distinct from the `@` picker Enter-on-folder
// path which splices the raw `@path/` text as a reference with no
// registry.

export interface OpenFolderPickerModalOpts {
  /** Absolute path of the folder to enumerate. */
  folderPath: string;
  bounds: ModalBounds;
  width: number;
  maxVisible?: number;
  /** Title override. Default: `"Pick file from <basename>"`. */
  title?: string;
  /** File selected. Caller runs the attachment pipeline. */
  onAccept: (item: FinderItem) => void;
  /** Esc / outside-click. No file selected — caller should leave the
   *  input buffer intact (no partial splice). */
  onCancel?: () => void;
  /** Max files to enumerate before showing "(50k cap — narrow by
   *  typing)" truncation hint. Defaults to finder-scan's 50 000. */
  maxFiles?: number;
  theme?: ThemeTokens;
}

/** Build `FinderItem[]` from a raw scan result + the folder root that
 *  was scanned. Extracted as a pure helper so tests can exercise the
 *  transform without spawning a real scanner. */
export function buildFolderPickerItems(
  scannedPaths: readonly string[],
  folderPath: string,
): FinderItem[] {
  const rels = relativizeResults([...scannedPaths], folderPath);
  const out: FinderItem[] = [];
  for (let i = 0; i < scannedPaths.length; i++) {
    out.push({ relPath: rels[i] ?? scannedPaths[i]!, absPath: scannedPaths[i]! });
  }
  return out;
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** Async — scans the folder recursively (fd preferred, find fallback)
 *  and mounts a `createFinderModal` over the results. Caller awaits
 *  the promise before the modal is visible to the user; for typical
 *  project folders fd finishes well under 100ms.
 *
 *  `deps` lets tests inject a fake `spawnImpl` / `probeBackend` so
 *  the scanner doesn't shell out during unit runs. */
export async function createFolderPickerModal(
  opts: OpenFolderPickerModalOpts,
  deps: FinderScanDeps = {},
): Promise<SearchModalHandle> {
  const scan = await scanFinder(
    { root: opts.folderPath, maxFiles: opts.maxFiles },
    deps,
  );
  const items = buildFolderPickerItems(scan.paths, opts.folderPath);
  const baseTitle = opts.title ?? `Pick file from ${basenameOf(opts.folderPath)}/`;
  return createFinderModal({
    items,
    bounds: opts.bounds,
    width: opts.width,
    maxVisible: opts.maxVisible,
    truncated: scan.truncated,
    title: baseTitle,
    onAccept: opts.onAccept,
    onCancel: opts.onCancel,
    theme: opts.theme,
  });
}
