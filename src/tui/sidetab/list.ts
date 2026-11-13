/** Compatibility entry point for existing Next TUI callers. Shared behavior lives in sidetab-core. */
export * from '../../sidetab-core/model.js';
import {
  formatSidetabLines as formatCoreSidetabLines,
  loadSidetabRows as loadCoreSidetabRows,
  type SidetabRow,
  type SidetabScope,
} from '../../sidetab-core/model.js';
import { listPtyManifestRows } from '../../pty-shell/pty-manifest.js';
import { formatSidetabPeekLines } from './peek.js';

type PreviewSidetabRow = SidetabRow & { readonly previewSource?: string };

/** Attach the latest manifest snapshot without changing the shared row contract. */
export function loadSidetabRows(all = false, currentSessionId?: string, scopeOverrides?: Partial<SidetabScope>): SidetabRow[] {
  const snapshots = new Map<string, string>(listPtyManifestRows().map((row) => [row.id, row.snapshot || row.frame] as const));
  const rows = loadCoreSidetabRows(all, currentSessionId, scopeOverrides);
  return rows.map((row) => ({
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
  // Agent PTYs are conversations. Give their selected row a longer live tail
  // while keeping the parent chat on screen and one selectable row visible.
  const agentSidechat = selectedRow !== undefined
    && ['agent', 'coding-agent', 'codex', 'claude', 'claude-code', 'grok', 'hermes'].includes(selectedRow.kind);
  const previewLimit = agentSidechat
    ? Number.isFinite(height) ? Math.min(6, Math.max(0, Math.floor(height) - 6)) : 6
    : 3;
  const peekLines = mode === 'list' && selectedRow
    ? formatSidetabPeekLines(selectedRow.previewSource ?? '', width, previewLimit)
    : [];
  if (peekLines.length === 0) return formatCoreSidetabLines(rows, selected, width, height, mode);

  const sidechatHeading = agentSidechat ? [' agent chat · Enter attach'.slice(0, Math.max(0, width)).padEnd(width)] : [];
  const reservedRows = peekLines.length + sidechatHeading.length + 1;
  const coreLines = formatCoreSidetabLines(rows, selected, width, Math.max(0, height - reservedRows), mode);
  // The core formatter reserves the leading ` › ` token for selection; a
  // session label may itself contain `›`, so searching anywhere in the line
  // can place the preview under the wrong row.
  const selectedLine = coreLines.findIndex((line) => line.startsWith(' › '));
  if (selectedLine < 0) return coreLines;

  const lines = [...coreLines];
  lines.splice(selectedLine + 1, 0, ' '.repeat(width), ...peekLines, ...sidechatHeading);
  return Number.isFinite(height) ? lines.slice(0, Math.max(0, Math.floor(height))) : lines;
}
