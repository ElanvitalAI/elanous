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

});
