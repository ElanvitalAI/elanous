import { describe, expect, test } from 'bun:test';

import {
  buildDashboardSurfaceCatalogTargets,
  buildDashboardViewPickerEntries,
} from '../src/dashboard/compact-surface-inventory.js';

describe('buildDashboardSurfaceCatalogTargets', () => {
  test('includes current-view reopen rows and respects compact-tight shortlist', () => {
    const targets = buildDashboardSurfaceCatalogTargets({
      closedPanes: [
        { pane: 'preview', label: 'Preview' },
      ],
      activeViewLabel: 'Normal',
      compactMode: 'compact-tight',
    });
    expect(targets.map((item) => item.id)).toEqual([
      'reopen:preview',
      'pane:browser-preview',
      'pane:browser',
      'pane:preview',
      'pane:obsidian',
      'companion:clipboard',
      'companion:memo',
      'companion:detail',
    ]);
  });
});

describe('buildDashboardViewPickerEntries', () => {
  const views = [
    { id: '1', label: 'Normal', description: 'Starter: Browser + Preview', active: false },
    { id: '2', label: 'Obsidian', description: 'Starter: Browser + Preview + Obsidian', active: false },
    { id: '3', label: 'Skill', description: 'Starter: Skill + Preview', active: false },
    { id: 'agents', label: 'Agents', description: 'Starter: Agent roster', active: true },
  ] as const;

  test('compact keeps starter subset, active view, and restore/reset actions', () => {
    expect(buildDashboardViewPickerEntries({
      views,
      includeRestoreAction: true,
      compactMode: 'compact',
    }).map((item) => item.id)).toEqual([
      'agents',
      '1',
      '2',
      '3',
      'action:view-restore',
      'action:view-reset',
    ]);
  });

  test('compact-tight keeps active view plus action rows only', () => {
    expect(buildDashboardViewPickerEntries({
      views,
      includeRestoreAction: false,
      compactMode: 'compact-tight',
    }).map((item) => item.id)).toEqual([
      'agents',
      'action:view-reset',
    ]);
  });
});
