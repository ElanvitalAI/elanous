import { describe, expect, test } from 'bun:test';

import { buildDashboardControlManual } from '../src/chat/mode/manual.js';
import type { NativeToolCatalogEntry } from '../src/native-tool-catalog.js';
import type { SlashCommand } from '../src/chat/index.js';

const FAKE_CATALOG: NativeToolCatalogEntry[] = [
  {
    id: 'fake-one',
    kind: 'other',
    aliases: ['FakeOne'],
    displayName: 'FakeOne',
    description: 'Fake tool one',
    promptSummary: 'FakeOne (args, args) — fake tool one summary',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: true,
  },
  {
    id: 'fake-two',
    kind: 'other',
    aliases: ['FakeTwo'],
    displayName: 'FakeTwo',
    description: 'Fake tool two',
    promptSummary: 'FakeTwo — something else',
    host: ['all'],
    safety: ['network'],
    supportsParallel: false,
    defaultEnabled: true,
  },
  {
    id: 'hidden-tool',
    kind: 'other',
    aliases: [],
    displayName: 'Hidden',
    description: 'Hidden disabled tool',
    promptSummary: 'Hidden — disabled tool',
    host: ['skill'],
    safety: ['read-only'],
    supportsParallel: true,
    defaultEnabled: false,
  },
];

const FAKE_SLASHES: SlashCommand[] = [
  { name: 'foo', aliases: ['f'], description: 'First slash' },
  { name: 'bar', aliases: [], description: 'Second slash', subcommands: ['one', 'two'] },
];

describe('buildDashboardControlManual', () => {
  test('includes header + role framing', () => {
    const m = buildDashboardControlManual({ catalog: FAKE_CATALOG, slashes: FAKE_SLASHES });
    expect(m).toContain('# Dashboard Control Manual');
    expect(m).toContain('dashboard operator');
  });

  test('lists enabled native tools only', () => {
    const m = buildDashboardControlManual({ catalog: FAKE_CATALOG, slashes: FAKE_SLASHES });
    expect(m).toContain('FakeOne');
    expect(m).toContain('FakeTwo');
    expect(m).not.toContain('Hidden');
  });

  test('groups tools by surface (skill before all)', () => {
    const m = buildDashboardControlManual({ catalog: FAKE_CATALOG, slashes: FAKE_SLASHES });
    const skillIdx = m.indexOf('### skill');
    const allIdx = m.indexOf('### all');
    expect(skillIdx).toBeGreaterThan(0);
    expect(allIdx).toBeGreaterThan(skillIdx);
  });

  test('lists every slash with alias + subcommand hints', () => {
    const m = buildDashboardControlManual({ catalog: FAKE_CATALOG, slashes: FAKE_SLASHES });
    expect(m).toContain('`/foo` (aliases: /f)');
    expect(m).toContain('`/bar [one|two]`');
  });

  test('environment section reflects args', () => {
    const m = buildDashboardControlManual({
      catalog: FAKE_CATALOG,
      slashes: FAKE_SLASHES,
      widgetIds: ['wd-log', 'wd-preview'],
      view: { id: 2, plugin: 'sync' },
      cwdLabel: '/home/alice',
    });
    expect(m).toContain('cwd: `/home/alice`');
    expect(m).toContain('view: `2`');
    expect(m).toContain('sync');
    expect(m).toContain('wd-log');
    expect(m).toContain('wd-preview');
  });

  test('intent rendered when present', () => {
    const m = buildDashboardControlManual({
      catalog: FAKE_CATALOG, slashes: FAKE_SLASHES,
      intent: 'fix the build',
    });
    expect(m).toContain('## Active intent');
    expect(m).toContain('> fix the build');
  });

  test('intent section absent when null', () => {
    const m = buildDashboardControlManual({
      catalog: FAKE_CATALOG, slashes: FAKE_SLASHES,
      intent: null,
    });
    expect(m).not.toContain('## Active intent');
  });

  test('conventions + response shape sections omit virtual-window advice', () => {
    const m = buildDashboardControlManual({ catalog: FAKE_CATALOG, slashes: FAKE_SLASHES });
    expect(m).toContain('## Conventions');
    expect(m).toContain('Approval');
    expect(m).toContain('## Your response shape');
    expect(m).not.toContain('WindowCreate');
    expect(m).not.toContain('PaneSplit');
    expect(m).not.toContain('SpawnCodingAgentInVW');
    expect(m).not.toContain('@win:');
    expect(m).toContain('@term:<id>');
  });

  test('exit-mode guidance is present', () => {
    const m = buildDashboardControlManual({ catalog: FAKE_CATALOG, slashes: FAKE_SLASHES });
    expect(m).toContain('/control off');
  });

  test('tool count in section header matches input', () => {
    const m = buildDashboardControlManual({ catalog: FAKE_CATALOG, slashes: FAKE_SLASHES });
    expect(m).toContain('## Native tools (3)');
  });
});
