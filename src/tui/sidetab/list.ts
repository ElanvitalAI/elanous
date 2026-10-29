/** Compatibility entry point for existing Next TUI callers. Shared behavior lives in sidetab-core. */
export * from '../../sidetab-core/model.js';
import {
  formatSidetabLines as formatCoreSidetabLines,
  loadSidetabRows as loadCoreSidetabRows,
  type SidetabRow,
} from '../../sidetab-core/model.js';
import { listPtyManifestRows } from '../../pty-shell/pty-manifest.js';
import { formatSidetabPeekLines } from './peek.js';

type PreviewSidetabRow = SidetabRow & { readonly previewSource?: string };

/** Attach the latest manifest snapshot without changing the shared row contract. */
export function loadSidetabRows(all = false, currentSessionId?: string): SidetabRow[] {
  const snapshots = new Map<string, string>(listPtyManifestRows().map((row) => [row.id, row.snapshot || row.frame] as const));
  return loadCoreSidetabRows(all, currentSessionId).map((row) => ({
    ...row,
    previewSource: snapshots.get(row.id) ?? '',
  }));
}

/** Render the core list and reserve a bounded tail preview for the selected PTY row. */
export function formatSidetabLines(
  rows: readonly SidetabRow[],
  selected: number,
  width: number,
  height = Number.POSITIVE_INFINITY,
  mode: 'list' | 'new' = 'list',
): string[] {
  const selectedRow = rows[selected] as PreviewSidetabRow | undefined;
  const peekLines = mode === 'list' && selectedRow
    ? formatSidetabPeekLines(selectedRow.previewSource ?? '', width)
    : [];
  if (peekLines.length === 0) return formatCoreSidetabLines(rows, selected, width, height, mode);

  const reservedRows = peekLines.length + 1;
  const coreLines = formatCoreSidetabLines(rows, selected, width, Math.max(0, height - reservedRows), mode);
  // The core formatter reserves the leading ` › ` token for selection; a
  // session label may itself contain `›`, so searching anywhere in the line
  // can place the preview under the wrong row.
  const selectedLine = coreLines.findIndex((line) => line.startsWith(' › '));
  if (selectedLine < 0) return coreLines;

  const lines = [...coreLines];
  lines.splice(selectedLine + 1, 0, ' '.repeat(width), ...peekLines);
  return Number.isFinite(height) ? lines.slice(0, Math.max(0, Math.floor(height))) : lines;
}
