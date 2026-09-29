import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const removed = [
  'src/panes/content-adapter.ts',
  'src/acp/resident-shell.ts',
  'src/dashboard/sim-shell.ts',
  'src/iul/resident-vw.ts',
  'src/sim/resident-vw.ts',
];
const remaining = [
  'src/panes/factory.ts',
  'src/panes/index.ts',
  'src/browser-pane/mount.ts',
  'src/preview-pane/mount.ts',
  'src/iul/sidebar-shell.ts',
  'src/acp/channel-browser-shell.ts',
];

function source(path: string): string {
  return readFileSync(resolve(import.meta.dir, '../..', path), 'utf8');
}

describe('retired virtual-window pane factories', () => {
  test('dedicated adapters and resident window factories are absent', () => {
    for (const path of removed) {
      expect(existsSync(resolve(import.meta.dir, '../..', path))).toBe(false);
    }
  });

  test('remaining entry points do not import virtual-window pane content', () => {
    for (const path of remaining) {
      expect(source(path)).not.toMatch(/from ['"][^'"]*virtual-windows\//);
    }
    for (const dir of ['src/panes', 'src/browser-pane', 'src/preview-pane', 'src/iul', 'src/acp', 'src/sim']) {
      for (const entry of readdirSync(resolve(import.meta.dir, '../..', dir), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.ts')) {
          expect(source(`${dir}/${entry.name}`)).not.toContain('virtual-windows');
        }
      }
    }
    expect(source('src/panes/factory.ts')).not.toContain('resolveFromContent');
    expect(source('src/panes/index.ts')).not.toContain('content-adapter');
    for (const [path, factory] of [
      ['src/browser-pane/mount.ts', 'createBrowserPaneContent'],
      ['src/preview-pane/mount.ts', 'createPreviewPaneContent'],
      ['src/iul/sidebar-shell.ts', 'createIulSidebarShellPaneContent'],
      ['src/acp/channel-browser-shell.ts', 'createAcpChannelBrowserPaneContent'],
    ]) {
      expect(source(path)).not.toContain(factory);
    }
  });

  test('modal and sidebar view exports remain present', () => {
    expect(source('src/browser-pane/mount.ts')).toContain('export function openBrowserPaneModal(');
    expect(source('src/preview-pane/mount.ts')).toContain('export function openPreviewPaneModal(');
    expect(source('src/iul/sidebar-shell.ts')).toContain('export function createIulSidebarShellView(');
    expect(source('src/acp/channel-browser-shell.ts')).toContain('export function createAcpChannelBrowserView(');
  });
});
