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
}

/** Keep picker chrome plain and bounded; terminal clipping belongs to the host renderer. */
export function formatInlinePanel(spec: InlinePanelSpec, maxRows = 6): string[] {
  if (!Number.isInteger(maxRows) || maxRows < 1) return [];
  const selected = spec.rows.length === 0
    ? -1
    : Math.max(0, Math.min(spec.selected ?? 0, spec.rows.length - 1));
  const count = Math.min(spec.rows.length, Math.max(0, maxRows - 2));
  const start = Math.max(0, Math.min(selected - count + 1, spec.rows.length - count));
  const rows = spec.rows.slice(start, start + count);
  return [
    `${spec.title} · ↑↓ 선택 · Enter 선택 · Esc 닫기`,
    ...(rows.length
      ? rows.map((row, offset) => `${start + offset === selected ? '▸' : ' '} ${row.label}${row.description ? ` — ${row.description}` : ''}`)
      : ['  후보 없음']),
    spec.hint,
  ];
}
