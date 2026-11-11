import { describe, expect, test } from 'bun:test';
import {
  buildDashboardViewRegistry,
  compileDashboardViewLayout,
  describeDashboardViewsForPrompt,
  findDashboardView,
  nextDashboardView,
  panesForDashboardView,
  resolveDashboardViewAfterReload,
  validateDashboardViewsConfig,
} from '../src/views/config.js';

describe('dashboard view config', () => {
  // Scheduler was hard-retired by 94e6ac8491 on 2026-05-11; this suite's
  // Scheduler shortcut contract predates it (4e37e59043, 2026-04-17).
  test('ships native views as config-backed definitions', () => {
    const registry = buildDashboardViewRegistry();
    expect(registry.views.map(v => v.id)).toEqual(['1', '2', '3', 'agents', 'debug']);
    expect(registry.views.find(v => v.id === 'debug')?.shortcut).toBe('5');
    expect(registry.views.find(v => v.id === 'agents')?.shortcut).toBe('4');
    expect(registry.views.find(v => v.id === '4')).toBeUndefined();
    expect(registry.views[0]!.rows[0]!.panes.map(p => p.pane)).toEqual(['browser', 'preview', 'sessions-sidebar']);
    expect(registry.views.find(v => v.id === 'agents')?.rows[0]?.panes.map(p => p.pane))
      .toEqual(['agent-roster', 'agent-detail', 'preview']);
    expect(registry.views.find(v => v.id === 'debug')?.rows[0]?.panes.map(p => p.pane))
      .toEqual(['debug-events', 'debug-detail', 'preview']);
    expect(registry.views.find(v => v.id === 'debug')?.rows[1]?.panes.map(p => p.pane))
      .toEqual(['debug-stack', 'debug-prompts', 'log']);
  });

  test('resolves reordered native shortcuts for Agents and Debug', () => {
    const registry = buildDashboardViewRegistry();

    expect(findDashboardView(registry, '4')?.id).toBe('agents');
    expect(findDashboardView(registry, '5')?.id).toBe('debug');
    expect(findDashboardView(registry, '6')).toBeNull();
  });

  test('accepts order, enable/disable, and native ratio overrides', () => {
    const registry = buildDashboardViewRegistry({
      order: ['3', '1'],
      views: [
        { id: '2', enabled: false },
        { id: '1', rows: [{ ratio: 1, panes: [{ pane: 'browser', ratio: 2 }, { pane: 'preview', ratio: 1 }] }] },
      ],
    });
    // Explicitly conflicts with every default axis: order, enabled state, and ratio.
    expect(registry.views.map(v => v.id)).toEqual(['3', '1', 'agents', 'debug']);
    expect(registry.views.find(v => v.id === '2')).toBeUndefined();
    const normal = registry.allViews.find(v => v.id === '1')!;
    expect(normal.rows).toEqual([{ ratio: 1, panes: [{ pane: 'browser', ratio: 2 }, { pane: 'preview', ratio: 1 }] }]);
    expect(normal.rows[0]!.panes[0]!.ratio).toBe(2);
  });

  test('adds custom view modes with shortcuts', () => {
    const registry = buildDashboardViewRegistry({
      views: [{
        id: 'focus-preview',
        label: 'Focus Preview',
        shortcut: '8',
        baseView: 1,
        rows: [{ ratio: 1, panes: [{ pane: 'preview', ratio: 3 }, { pane: 'log', ratio: 1 }] }],
      }],
    });
    const def = findDashboardView(registry, '8')!;
    expect(def.id).toBe('focus-preview');
    expect(panesForDashboardView(def)).toEqual(['preview', 'log']);
  });

  test('accepts plugin panes only when contributed', () => {
    const missing = buildDashboardViewRegistry({
      views: [{ id: 'plugin-view', rows: [{ panes: ['plugin:demo.status', 'log'] }] }],
    });
    expect(panesForDashboardView(missing.allViews.find(v => v.id === 'plugin-view')!)).toEqual(['log']);

    const registry = buildDashboardViewRegistry({
      views: [{ id: 'plugin-view', primary: 'plugin:demo.status', rows: [{ panes: ['plugin:demo.status', 'log'] }] }],
    }, {
      extraPanes: ['plugin:demo.status'],
    });
    const def = registry.allViews.find(v => v.id === 'plugin-view')!;
    expect(def.primary).toBe('plugin:demo.status');
    expect(panesForDashboardView(def)).toEqual(['plugin:demo.status', 'log']);
  });

  test('merges contributed plugin views before user overrides', () => {
    const registry = buildDashboardViewRegistry({
      views: [{ id: 'plugin:demo.monitor', label: 'User Monitor', rows: [{ panes: ['log'] }] }],
    }, {
      extraPanes: ['plugin:demo.status'],
      contributedViews: [{
        id: 'plugin:demo.monitor',
        label: 'Plugin Monitor',
        shortcut: '8',
        rows: [{ panes: ['plugin:demo.status', 'log'] }],
      }],
    });
    const def = findDashboardView(registry, '8')!;
    expect(def.label).toBe('User Monitor');
    expect(panesForDashboardView(def)).toEqual(['log']);
  });

  test('compiles ratio rows into layout fractions', () => {
    const registry = buildDashboardViewRegistry({
      views: [{
        id: 'x',
        rows: [
          { ratio: 3, panes: [{ pane: 'browser', ratio: 2 }, { pane: 'preview', ratio: 1 }] },
          { ratio: 1, panes: [{ pane: 'log', ratio: 1 }] },
        ],
      }],
    });
    const def = registry.allViews.find(v => v.id === 'x')!;
    const layout = compileDashboardViewLayout(def, new Set(['browser', 'preview', 'log'] as const), pane => `w:${pane}`);
    expect(layout.rows[0]!.height).toBe(0.75);
    expect(layout.rows[0]!.cells.map(c => c.width)).toEqual([2 / 3, 1 / 3]);
  });

  test('cycles through enabled registry order', () => {
    const registry = buildDashboardViewRegistry({
      order: ['3', '1'],
      views: [
        { id: '2', enabled: false },
      ],
    });
    expect(registry.views.map(v => v.id)).toEqual(['3', '1', 'agents', 'debug']);
    expect(nextDashboardView(registry, '3', 1).id).toBe('1');
    expect(nextDashboardView(registry, 'debug', 1).id).toBe('3');
    expect(nextDashboardView(registry, '3', -1).id).toBe('debug');
    expect(nextDashboardView(registry, 'agents', 1).id).toBe('debug');
    expect(nextDashboardView(registry, 'debug', -1).id).toBe('agents');
  });

  test('reload resolver preserves active view by id, then by base view', () => {
    const registry = buildDashboardViewRegistry({
      order: ['debug', 'agent-alt', '4', 'agents', '1'],
      views: [
        { id: 'agent-alt', label: 'Agent Alt', baseView: 4, rows: [{ panes: ['agent-roster', 'agent-detail'] }] },
        { id: 'agents', enabled: false },
      ],
    });

    expect(resolveDashboardViewAfterReload(registry, { id: 'debug', baseView: 1 }).id).toBe('debug');
    expect(resolveDashboardViewAfterReload(registry, { id: 'agents', baseView: 4 }).id).toBe('agent-alt');
    expect(resolveDashboardViewAfterReload(registry, null).id).toBe('debug');
  });

  test('prompt summary exposes rows and shortcuts', () => {
    const summary = describeDashboardViewsForPrompt(buildDashboardViewRegistry());
    expect(summary).toContain('Dashboard View Configuration');
    expect(summary).toContain('shortcut=1');
    expect(summary).toContain('browser');
  });

  test('validation reports malformed view config with field paths', () => {
    const issues = validateDashboardViewsConfig({
      order: ['1', ''],
      views: [{
        id: 'broken',
        baseView: 9,
        primary: 'missing-pane',
        omitOrder: ['scratch', 'missing-pane'],
        rows: [{ panes: [{ pane: 'browser' }, { pane: 'missing-pane' }] }],
      }],
    });

    expect(issues).toContain('dashboard.views.order[1] must be a non-empty string');
    expect(issues).toContain('dashboard.views.views[0].baseView must be one of 1, 2, 3, or 4');
    expect(issues).toContain('dashboard.views.views[0].primary references unknown pane "missing-pane"');
    expect(issues).toContain('dashboard.views.views[0].omitOrder[1] references unknown pane "missing-pane"');
    expect(issues).toContain('dashboard.views.views[0].rows[0].panes[1] references unknown pane "missing-pane"');
  });

  test('validation accepts contributed plugin panes', () => {
    const issues = validateDashboardViewsConfig({
      views: [{
        id: 'plugin-view',
        primary: 'plugin:demo.status',
        rows: [{ panes: ['plugin:demo.status', 'log'] }],
      }],
    }, {
      extraPanes: ['plugin:demo.status'],
    });

    expect(issues).toEqual([]);
  });

  // ── ST1 — leadColumn ──────────────────────────────────────────

  test('ST1 — leadColumn compiles into first cell with scaled remainder', () => {
    const registry = buildDashboardViewRegistry({
      views: [{
        id: 'x',
        rows: [
          {
            ratio: 1,
            panes: [{ pane: 'browser', ratio: 1 }, { pane: 'preview', ratio: 3 }, { pane: 'scratch', ratio: 1 }],
            leadColumn: { pane: 'sessions-sidebar', width: 0.2 },
          },
        ],
      }],
    });
    const def = registry.allViews.find(v => v.id === 'x')!;
    const visible = new Set(['sessions-sidebar', 'browser', 'preview', 'scratch'] as const);
    const layout = compileDashboardViewLayout(def, visible, pane => `w:${pane}`);
    const widths = layout.rows[0]!.cells.map(c => c.width);
    expect(widths[0]).toBeCloseTo(0.2, 6);
    expect(widths[1]).toBeCloseTo(0.8 * 1 / 5, 6);
    expect(widths[2]).toBeCloseTo(0.8 * 3 / 5, 6);
    expect(widths[3]).toBeCloseTo(0.8 * 1 / 5, 6);
    const sum = widths.reduce((acc, w) => acc + (typeof w === 'number' ? w : 0), 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  test('ST1 — leadColumn defaults to 0.2 when width is omitted and is skipped when pane is hidden', () => {
    const registry = buildDashboardViewRegistry({
      views: [{
        id: 'x',
        rows: [{
          panes: [{ pane: 'browser', ratio: 1 }],
          leadColumn: { pane: 'sessions-sidebar' },
        }],
      }],
    });
    const def = registry.allViews.find(v => v.id === 'x')!;

    const withSidebar = compileDashboardViewLayout(def, new Set(['sessions-sidebar', 'browser']), p => `w:${p}`);
    expect(withSidebar.rows[0]!.cells[0]!.width).toBeCloseTo(0.2, 6);
    expect(withSidebar.rows[0]!.cells[1]!.width).toBeCloseTo(0.8, 6);

    // Hidden leadColumn: the row falls back to the non-lead cells at full width.
    const withoutSidebar = compileDashboardViewLayout(def, new Set(['browser']), p => `w:${p}`);
    expect(withoutSidebar.rows[0]!.cells).toHaveLength(1);
    expect(withoutSidebar.rows[0]!.cells[0]!.width).toBeCloseTo(1, 6);
  });

  test('ST1 — panesForDashboardView includes leadColumn pane first', () => {
    const registry = buildDashboardViewRegistry({
      views: [{
        id: 'x',
        primary: 'browser',
        rows: [{
          panes: [{ pane: 'browser' }, { pane: 'preview' }],
          leadColumn: { pane: 'sessions-sidebar' },
        }],
      }],
    });
    const def = registry.allViews.find(v => v.id === 'x')!;
    expect(panesForDashboardView(def)).toEqual(['sessions-sidebar', 'browser', 'preview']);
  });

  test('ST1 — validation rejects bad leadColumn pane and width', () => {
    const issues = validateDashboardViewsConfig({
      views: [{
        id: 'bad-lead',
        rows: [
          { panes: [{ pane: 'browser' }], leadColumn: { pane: 'missing', width: 0.2 } },
          { panes: [{ pane: 'browser' }], leadColumn: { pane: 'sessions-sidebar', width: 5 } },
          { panes: [{ pane: 'browser' }], leadColumn: 'not-an-object' },
        ],
      }],
    });
    expect(issues).toContain('dashboard.views.views[0].rows[0].leadColumn.pane references unknown pane "missing"');
    expect(issues).toContain('dashboard.views.views[0].rows[1].leadColumn.width must be a fraction between 0 and 1 (exclusive)');
    expect(issues).toContain('dashboard.views.views[0].rows[2].leadColumn must be an object');
  });
});
