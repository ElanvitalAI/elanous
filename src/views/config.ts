// ── Dashboard view configuration ──
// Yazi-style ratio configuration for working-dir dashboard views.
// Native views and custom views use the same data model: ordered rows,
// each row contains pane ids with ratio weights.

import type { PaneFocus, WorkingDirView } from '../workspace-types.js';
import type { Layout, LayoutCell, LayoutRow } from '../layout/types.js';
import { createLayout } from '../layout/host.js';

export type DashboardViewId = string;

export interface ViewPaneSpec {
  pane: PaneFocus;
  ratio?: number;
}

/** Fixed-position left column (session M · ST1). When a row declares a
 *  leadColumn, it is rendered as the first cell of that row with a
 *  fractional width carved out of the row total. The remaining cells
 *  share the rest in their original ratios. Fractional (0 < width < 1)
 *  keeps sizing responsive across terminal widths — narrow terminals
 *  shrink the sidebar proportionally instead of starving the main
 *  content. Default 0.2 (≈24 cols on a 120-col terminal). */
export interface ViewLeadColumnSpec {
  pane: PaneFocus;
  /** Fraction of row width (0 < width < 1). Defaults to 0.2. */
  width?: number;
}

export interface ViewRowSpec {
  ratio?: number;
  panes: ViewPaneSpec[];
  leadColumn?: ViewLeadColumnSpec;
}

export const DEFAULT_LEAD_COLUMN_WIDTH = 0.2;

export interface DashboardViewDef {
  id: DashboardViewId;
  label: string;
  enabled: boolean;
  order: number;
  shortcut?: string;
  baseView: WorkingDirView;
  primary: PaneFocus;
  /** 2nd-priority pane — kept alongside `primary` on tabletTwo-
   *  class viewports; the rest fall back to modal access via
   *  Ctrl+M <pane>. When absent, tabletTwo behaves like tabletMini. */
  secondary?: PaneFocus;
  omitOrder: PaneFocus[];
  rows: ViewRowSpec[];
}

export interface DashboardViewRegistry {
  views: DashboardViewDef[];
  allViews: DashboardViewDef[];
  activeId: DashboardViewId;
}

export interface RawDashboardViewsConfig {
  order?: unknown;
  views?: unknown;
}

export interface DashboardViewRegistryOptions {
  extraPanes?: readonly PaneFocus[];
  contributedViews?: readonly unknown[];
}

// Surface-unification v2.2 V2.2-5 Part 2 (2026-05-11) — scheduler-*
// pane focus entries retired.
export const VALID_VIEW_PANES = new Set<PaneFocus>([
  'browser', 'obsidian', 'preview', 'scratch', 'log',
  'skill-browser', 'skill-file',
  'agent-roster', 'agent-detail', 'agent-log',
  'debug-events', 'debug-detail', 'debug-stack', 'debug-prompts',
  'sessions-sidebar',
]);

export const DEFAULT_DASHBOARD_VIEWS: DashboardViewDef[] = [
  {
    id: '1',
    label: 'Normal',
    enabled: true,
    order: 10,
    shortcut: '1',
    baseView: 1,
    primary: 'browser',
    secondary: 'preview',
    omitOrder: ['sessions-sidebar', 'preview', 'log', 'browser'],
    rows: [
      // First-entry scene: browser | preview | sessions, with log
      // given more vertical weight than before.
      { ratio: 2, panes: [{ pane: 'browser', ratio: 1 }, { pane: 'preview', ratio: 3 }, { pane: 'sessions-sidebar', ratio: 1 }] },
      { ratio: 3, panes: [{ pane: 'log', ratio: 1 }] },
    ],
  },
  {
    id: '2',
    label: 'Obsidian',
    enabled: true,
    order: 20,
    shortcut: '2',
    baseView: 2,
    primary: 'browser',
    secondary: 'preview',
    omitOrder: ['scratch', 'obsidian', 'preview', 'log', 'browser'],
    rows: [
      // 1:3:1 — browser left, preview center, obsidian right.
      { ratio: 3, panes: [{ pane: 'browser', ratio: 1 }, { pane: 'preview', ratio: 3 }, { pane: 'obsidian', ratio: 1 }] },
      { ratio: 2, panes: [{ pane: 'log', ratio: 3 }, { pane: 'scratch', ratio: 2 }] },
    ],
  },
  {
    id: '3',
    label: 'Skill',
    enabled: true,
    order: 30,
    shortcut: '3',
    baseView: 3,
    primary: 'skill-browser',
    secondary: 'preview',
    omitOrder: ['scratch', 'browser', 'skill-file', 'preview', 'log', 'skill-browser'],
    rows: [
      // 1:3:1 — skill-browser left, preview center, skill-file right.
      { ratio: 3, panes: [{ pane: 'skill-browser', ratio: 1 }, { pane: 'preview', ratio: 3 }, { pane: 'skill-file', ratio: 1 }] },
      { ratio: 2, panes: [{ pane: 'log', ratio: 4 }, { pane: 'scratch', ratio: 2 }, { pane: 'browser', ratio: 2 }] },
    ],
  },
  // Surface-unification v2.2 V2.2-5 Part 2 (2026-05-11) — Scheduler
  // view (id: '4', baseView: 4) entry retired (scheduler view 폐기).
  // Workflows surface absorbs recurring jobs.
  {
    id: 'agents',
    label: 'Agents',
    enabled: true,
    order: 40,
    shortcut: '4',
    baseView: 1,
    primary: 'agent-roster',
    omitOrder: ['agent-log', 'scratch', 'preview', 'agent-detail', 'log', 'agent-roster'],
    rows: [
      { ratio: 3, panes: [{ pane: 'agent-roster', ratio: 2 }, { pane: 'agent-detail', ratio: 3 }, { pane: 'preview', ratio: 3 }] },
      { ratio: 2, panes: [{ pane: 'agent-log', ratio: 3 }, { pane: 'log', ratio: 2 }] },
    ],
  },
  {
    id: 'debug',
    label: 'Debug',
    enabled: true,
    order: 50,
    shortcut: '5',
    baseView: 1,
    primary: 'debug-events',
    omitOrder: ['scratch', 'preview', 'log', 'debug-stack', 'debug-prompts', 'debug-detail', 'debug-events'],
    rows: [
      { ratio: 3, panes: [{ pane: 'debug-events', ratio: 2 }, { pane: 'debug-detail', ratio: 3 }, { pane: 'preview', ratio: 2 }] },
      { ratio: 2, panes: [{ pane: 'debug-stack', ratio: 2 }, { pane: 'debug-prompts', ratio: 2 }, { pane: 'log', ratio: 2 }] },
    ],
  },
];

function cloneView(def: DashboardViewDef): DashboardViewDef {
  return {
    ...def,
    omitOrder: [...def.omitOrder],
    rows: def.rows.map(row => ({
      ratio: row.ratio,
      panes: row.panes.map(p => ({ ...p })),
      ...(row.leadColumn ? { leadColumn: { ...row.leadColumn } } : {}),
    })),
  };
}

function leadColumnFraction(spec: ViewLeadColumnSpec | undefined): number {
  if (!spec) return 0;
  const w = typeof spec.width === 'number' && spec.width > 0 && spec.width < 1 ? spec.width : DEFAULT_LEAD_COLUMN_WIDTH;
  return w;
}

function positiveNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function validPanesFor(extraPanes?: readonly PaneFocus[]): ReadonlySet<PaneFocus> {
  if (!extraPanes || extraPanes.length === 0) return VALID_VIEW_PANES;
  return new Set<PaneFocus>([...VALID_VIEW_PANES, ...extraPanes]);
}

function parsePane(v: unknown, validPanes: ReadonlySet<PaneFocus>): PaneFocus | null {
  return typeof v === 'string' && validPanes.has(v as PaneFocus) ? v as PaneFocus : null;
}

function normalizeBaseView(v: unknown, fallback: WorkingDirView): WorkingDirView {
  return v === 1 || v === 2 || v === 3 || v === 4 ? v : fallback;
}

function cloneRowSpec(row: ViewRowSpec): ViewRowSpec {
  return {
    ratio: row.ratio,
    panes: row.panes.map(p => ({ ...p })),
    ...(row.leadColumn ? { leadColumn: { ...row.leadColumn } } : {}),
  };
}

function parseLeadColumn(raw: unknown, validPanes: ReadonlySet<PaneFocus>): ViewLeadColumnSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const pane = parsePane(obj.pane, validPanes);
  if (!pane) return undefined;
  const rawWidth = obj.width;
  const width = typeof rawWidth === 'number' && rawWidth > 0 && rawWidth < 1
    ? rawWidth
    : undefined;
  return width === undefined ? { pane } : { pane, width };
}

function parseRows(raw: unknown, fallback: ViewRowSpec[], validPanes: ReadonlySet<PaneFocus>): ViewRowSpec[] {
  if (!Array.isArray(raw)) return fallback.map(cloneRowSpec);
  const rows: ViewRowSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const panesRaw = obj.panes;
    if (!Array.isArray(panesRaw)) continue;
    const panes: ViewPaneSpec[] = [];
    for (const p of panesRaw) {
      if (typeof p === 'string') {
        const pane = parsePane(p, validPanes);
        if (pane) panes.push({ pane, ratio: 1 });
      } else if (p && typeof p === 'object') {
        const po = p as Record<string, unknown>;
        const pane = parsePane(po.pane, validPanes);
        if (pane) panes.push({ pane, ratio: positiveNumber(po.ratio, 1) });
      }
    }
    if (panes.length > 0) {
      const leadColumn = parseLeadColumn(obj.leadColumn, validPanes);
      rows.push({
        ratio: positiveNumber(obj.ratio, 1),
        panes,
        ...(leadColumn ? { leadColumn } : {}),
      });
    }
  }
  return rows.length > 0 ? rows : fallback.map(cloneRowSpec);
}

function parseView(raw: unknown, fallback: DashboardViewDef | undefined, validPanes: ReadonlySet<PaneFocus>): DashboardViewDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = str(obj.id) ?? fallback?.id;
  if (!id) return null;
  const baseView = normalizeBaseView(obj.baseView, fallback?.baseView ?? 1);
  const rows = parseRows(obj.rows, fallback?.rows ?? DEFAULT_DASHBOARD_VIEWS[0]!.rows, validPanes);
  const panes = rows.flatMap(row => row.panes.map(p => p.pane));
  const primary = parsePane(obj.primary, validPanes) ?? fallback?.primary ?? panes[0] ?? 'browser';
  const omitRaw = Array.isArray(obj.omitOrder) ? obj.omitOrder.map(p => parsePane(p, validPanes)).filter(Boolean) as PaneFocus[] : undefined;
  return {
    id,
    label: str(obj.label) ?? fallback?.label ?? id,
    enabled: obj.enabled === undefined ? fallback?.enabled ?? true : obj.enabled !== false,
    order: positiveNumber(obj.order, fallback?.order ?? 100),
    shortcut: str(obj.shortcut) ?? fallback?.shortcut,
    baseView,
    primary: panes.includes(primary) ? primary : panes[0] ?? primary,
    omitOrder: omitRaw && omitRaw.length > 0 ? omitRaw : fallback?.omitOrder ?? panes.slice().reverse(),
    rows,
  };
}

export function validateDashboardViewsConfig(
  raw: unknown,
  options: DashboardViewRegistryOptions = {},
): string[] {
  const issues: string[] = [];
  const validPanes = validPanesFor(options.extraPanes);
  if (raw == null) return issues;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return ['dashboard.views must be an object'];
  }
  const obj = raw as Record<string, unknown>;
  if (obj.order !== undefined) {
    if (!Array.isArray(obj.order)) {
      issues.push('dashboard.views.order must be an array of view ids');
    } else {
      obj.order.forEach((item, index) => {
        if (typeof item !== 'string' || item.trim() === '') {
          issues.push(`dashboard.views.order[${index}] must be a non-empty string`);
        }
      });
    }
  }
  if (obj.views !== undefined && !Array.isArray(obj.views)) {
    issues.push('dashboard.views.views must be an array');
  }
  if (!Array.isArray(obj.views)) return issues;
  obj.views.forEach((item, viewIndex) => {
    const viewPath = `dashboard.views.views[${viewIndex}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`${viewPath} must be an object`);
      return;
    }
    const view = item as Record<string, unknown>;
    if (view.id !== undefined && (typeof view.id !== 'string' || view.id.trim() === '')) {
      issues.push(`${viewPath}.id must be a non-empty string`);
    }
    if (view.baseView !== undefined && ![1, 2, 3, 4].includes(view.baseView as number)) {
      issues.push(`${viewPath}.baseView must be one of 1, 2, 3, or 4`);
    }
    if (view.primary !== undefined && (typeof view.primary !== 'string' || !validPanes.has(view.primary as PaneFocus))) {
      issues.push(`${viewPath}.primary references unknown pane "${String(view.primary)}"`);
    }
    if (view.omitOrder !== undefined) {
      if (!Array.isArray(view.omitOrder)) {
        issues.push(`${viewPath}.omitOrder must be an array of pane ids`);
      } else {
        view.omitOrder.forEach((pane, paneIndex) => {
          if (typeof pane !== 'string' || !validPanes.has(pane as PaneFocus)) {
            issues.push(`${viewPath}.omitOrder[${paneIndex}] references unknown pane "${String(pane)}"`);
          }
        });
      }
    }
    if (view.rows !== undefined) {
      if (!Array.isArray(view.rows)) {
        issues.push(`${viewPath}.rows must be an array`);
      } else {
        view.rows.forEach((row, rowIndex) => {
          const rowPath = `${viewPath}.rows[${rowIndex}]`;
          if (!row || typeof row !== 'object' || Array.isArray(row)) {
            issues.push(`${rowPath} must be an object`);
            return;
          }
          const panes = (row as Record<string, unknown>).panes;
          if (!Array.isArray(panes)) {
            issues.push(`${rowPath}.panes must be an array`);
            return;
          }
          panes.forEach((paneSpec, paneIndex) => {
            const panePath = `${rowPath}.panes[${paneIndex}]`;
            const pane = typeof paneSpec === 'string'
              ? paneSpec
              : paneSpec && typeof paneSpec === 'object' && !Array.isArray(paneSpec)
                ? (paneSpec as Record<string, unknown>).pane
                : undefined;
            if (typeof pane !== 'string' || !validPanes.has(pane as PaneFocus)) {
              issues.push(`${panePath} references unknown pane "${String(pane)}"`);
            }
          });
          const leadColumn = (row as Record<string, unknown>).leadColumn;
          if (leadColumn !== undefined) {
            const leadPath = `${rowPath}.leadColumn`;
            if (!leadColumn || typeof leadColumn !== 'object' || Array.isArray(leadColumn)) {
              issues.push(`${leadPath} must be an object`);
            } else {
              const leadObj = leadColumn as Record<string, unknown>;
              if (typeof leadObj.pane !== 'string' || !validPanes.has(leadObj.pane as PaneFocus)) {
                issues.push(`${leadPath}.pane references unknown pane "${String(leadObj.pane)}"`);
              }
              if (leadObj.width !== undefined) {
                const w = leadObj.width;
                if (typeof w !== 'number' || !(w > 0 && w < 1)) {
                  issues.push(`${leadPath}.width must be a fraction between 0 and 1 (exclusive)`);
                }
              }
            }
          }
        });
      }
    }
  });
  return issues;
}

export function buildDashboardViewRegistry(
  raw?: RawDashboardViewsConfig | null,
  options: DashboardViewRegistryOptions = {},
): DashboardViewRegistry {
  const validPanes = validPanesFor(options.extraPanes);
  const byId = new Map<string, DashboardViewDef>();
  for (const def of DEFAULT_DASHBOARD_VIEWS) byId.set(def.id, cloneView(def));
  const contributedViews = Array.isArray(options.contributedViews) ? options.contributedViews : [];
  for (const item of contributedViews) {
    const id = item && typeof item === 'object' ? str((item as Record<string, unknown>).id) : undefined;
    const parsed = parseView(item, id ? byId.get(id) : undefined, validPanes);
    if (parsed) byId.set(parsed.id, parsed);
  }
  const rawViews = raw && typeof raw === 'object' && Array.isArray(raw.views) ? raw.views : [];
  for (const item of rawViews) {
    const id = item && typeof item === 'object' ? str((item as Record<string, unknown>).id) : undefined;
    const parsed = parseView(item, id ? byId.get(id) : undefined, validPanes);
    if (parsed) byId.set(parsed.id, parsed);
  }
  const rawOrder = raw && typeof raw === 'object' && Array.isArray(raw.order) ? raw.order.map(str).filter(Boolean) as string[] : [];
  for (let i = 0; i < rawOrder.length; i++) {
    const def = byId.get(rawOrder[i]!);
    if (def) def.order = i + 1;
  }
  const allViews = [...byId.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  let views = allViews.filter(v => v.enabled);
  if (views.length === 0) {
    const fallback = byId.get('1') ?? cloneView(DEFAULT_DASHBOARD_VIEWS[0]!);
    fallback.enabled = true;
    views = [fallback];
  }
  return { allViews, views, activeId: views[0]?.id ?? '1' };
}

export function findDashboardView(registry: DashboardViewRegistry, needle: string): DashboardViewDef | null {
  const q = needle.trim().toLowerCase();
  if (!q) return null;
  return registry.views.find(v =>
    v.id.toLowerCase() === q
    || v.label.toLowerCase() === q
    || (v.shortcut ?? '').toLowerCase() === q
  ) ?? null;
}

export function nextDashboardView(registry: DashboardViewRegistry, activeId: string, dir: 1 | -1): DashboardViewDef {
  const views = registry.views.length > 0 ? registry.views : DEFAULT_DASHBOARD_VIEWS;
  const i = views.findIndex(v => v.id === activeId);
  const n = views.length;
  return views[((i < 0 ? 0 : i) + dir + n) % n]!;
}

export function resolveDashboardViewAfterReload(
  registry: DashboardViewRegistry,
  previous: Pick<DashboardViewDef, 'id' | 'baseView'> | null | undefined,
): DashboardViewDef {
  const views = registry.views.length > 0 ? registry.views : DEFAULT_DASHBOARD_VIEWS;
  if (previous) {
    const sameId = views.find(v => v.id === previous.id);
    if (sameId) return sameId;
    const sameBaseView = views.find(v => v.baseView === previous.baseView);
    if (sameBaseView) return sameBaseView;
  }
  return views[0]!;
}

export function compileDashboardViewLayout(
  def: DashboardViewDef,
  visiblePanes: ReadonlySet<PaneFocus>,
  paneToWidgetId: (pane: PaneFocus, baseView: WorkingDirView) => string | null,
): Layout {
  const rows: LayoutRow[] = [];
  const visibleRows = def.rows
    .map(row => ({
      ratio: positiveNumber(row.ratio, 1),
      panes: row.panes.filter(p => visiblePanes.has(p.pane)),
      leadColumn: row.leadColumn && visiblePanes.has(row.leadColumn.pane) ? row.leadColumn : undefined,
    }))
    .filter(row => row.panes.length > 0 || row.leadColumn);
  const rowTotal = visibleRows.reduce((sum, row) => sum + row.ratio, 0) || 1;
  for (const row of visibleRows) {
    const total = row.panes.reduce((sum, pane) => sum + positiveNumber(pane.ratio, 1), 0) || 1;
    const leadFrac = row.leadColumn ? leadColumnFraction(row.leadColumn) : 0;
    const remainderFrac = 1 - leadFrac;
    const cells: LayoutCell[] = [];
    if (row.leadColumn) {
      const leadId = paneToWidgetId(row.leadColumn.pane, def.baseView);
      if (leadId) cells.push({ widgetInstanceId: leadId, width: leadFrac });
    }
    for (const pane of row.panes) {
      const id = paneToWidgetId(pane.pane, def.baseView);
      if (!id) continue;
      const rawFrac = positiveNumber(pane.ratio, 1) / total;
      cells.push({ widgetInstanceId: id, width: rawFrac * remainderFrac });
    }
    if (cells.length > 0) rows.push({ height: row.ratio / rowTotal, cells });
  }
  return createLayout(rows.length > 0 ? rows : [{ height: 'flex', cells: [{ widgetInstanceId: paneToWidgetId(def.primary, def.baseView), width: 'flex' }] }]);
}

export function panesForDashboardView(def: DashboardViewDef): PaneFocus[] {
  const out: PaneFocus[] = [];
  for (const row of def.rows) {
    if (row.leadColumn && !out.includes(row.leadColumn.pane)) out.push(row.leadColumn.pane);
    for (const pane of row.panes) {
      if (!out.includes(pane.pane)) out.push(pane.pane);
    }
  }
  return out;
}

export function serializeDashboardViewsConfig(registry: DashboardViewRegistry): RawDashboardViewsConfig {
  return {
    order: registry.allViews.map(v => v.id),
    views: registry.allViews.map(v => ({
      id: v.id,
      label: v.label,
      enabled: v.enabled,
      order: v.order,
      shortcut: v.shortcut,
      baseView: v.baseView,
      primary: v.primary,
      omitOrder: v.omitOrder,
      rows: v.rows,
    })),
  };
}

export function describeDashboardViewsForPrompt(registry: DashboardViewRegistry): string {
  const lines = registry.allViews.map(v => {
    const state = v.enabled ? 'enabled' : 'disabled';
    const key = v.shortcut ? ` shortcut=${v.shortcut}` : '';
    const rows = v.rows.map(row => row.panes.map(p => `${p.pane}:${p.ratio ?? 1}`).join('|')).join(' / ');
    return `- ${v.id} "${v.label}" (${state}, baseView=${v.baseView}${key}) rows: ${rows}`;
  });
  return [
    '## Dashboard View Configuration',
    '',
    'Views are configurable as ordered row/pane ratio specs. Use view_getConfig before changing views.',
    ...lines,
  ].join('\n');
}
