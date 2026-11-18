/** Text-only content for the fixed area immediately above a TUI composer. */
export interface InlinePanelRow {
  readonly label: string;
  readonly description?: string;
}

export interface InlinePanelSpec {
  readonly title: string;
  readonly rows: readonly InlinePanelRow[];
  readonly selected?: number;
  readonly hint: string;
  /** What Enter does in this panel, as the header says it («select» unless the panel's Enter does something else, e.g.
   *  the queue panel's «edit») — the header and the hint line must not disagree. */
  readonly enterAction?: string;
}

/**
 * Keep picker chrome plain and bounded; terminal clipping belongs to the host renderer.
 * `maxRows` is the room the caller really has. Title and hint are decoration: with fewer than three rows they are omitted
 * and only candidate rows are shown, windowed so the selected one is always visible (first selection → first row).
 */
export function formatInlinePanel(spec: InlinePanelSpec, maxRows = 6): string[] {
  if (!Number.isInteger(maxRows) || maxRows < 1) return [];
  const selected = spec.rows.length === 0
    ? -1
    : Math.max(0, Math.min(spec.selected ?? 0, spec.rows.length - 1));
  const mark = (row: InlinePanelRow, index: number): string => `${index === selected ? '▸' : ' '} ${row.label}${row.description ? ` — ${row.description}` : ''}`;
  const crowded = maxRows < 3;
  const count = Math.min(spec.rows.length, crowded ? maxRows : maxRows - 2);
  const start = Math.max(0, Math.min(selected - count + 1, spec.rows.length - count));
  const rows = spec.rows.slice(start, start + count);
  const items = rows.length ? rows.map((row, offset) => mark(row, start + offset)) : ['  No candidates'];
  if (crowded) return items.slice(0, maxRows);
  return [`${spec.title} · ↑↓ select · Enter ${spec.enterAction ?? 'select'} · Esc close`, ...items, spec.hint];
}
