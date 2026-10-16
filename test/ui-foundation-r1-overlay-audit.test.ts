import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tuiSourceText } from './helpers/dashboard-source.js';

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('R1 overlay audit', () => {
  test('dashboard flushes non-modal transient overlays via the shared host', () => {
    const dashboard = tuiSourceText();
    expect(dashboard).toContain("const overlay = transientOverlayHost.paint();");
    expect(dashboard).not.toContain('renderLlmContextDropBanner(');
  });

  test('legacy banner renderer stays a reference helper, not a production import', () => {
    const dragWire = read('src/drag-session-dashboard-wire.ts');
    expect(dragWire).not.toContain("import {\n  renderLlmContextDropBanner");
    expect(dragWire).not.toContain('renderLlmContextDropBanner(');

    const banner = read('src/llm-context-drop-banner.ts');
    expect(banner).toContain('NO LONGER the rendering');
    expect(banner).toContain('Retained for test coverage + backwards compatibility');
  });

  test('overlay family source comments point at the shared policy file', () => {
    const hoverPresenter = read('src/ui/hover-presenter.ts');
    const menuHost = read('src/ui/context-menu-host.ts');
    // 2026-07-07 · dashboard decomposition: src/status-bar-popups.ts
    // moved to src/status/popups.ts (same content, new home).
    const statusPopups = read('src/status/popups.ts');
    const dragWire = read('src/drag-session-dashboard-wire.ts');

    for (const text of [hoverPresenter, menuHost, statusPopups, dragWire]) {
      expect(text).toContain('transient-overlay-policy.ts');
    }
  });
});
