// DS-3a-follow (Finding A · 2026-04-21) · regression guard.
//
// PR #334 Session A + Session B post-merge reviews identified
// a blocker: `dragWire.onMouse(m)` was wired to ONLY the
// streaming viewMode route · idle + input routes bypassed the
// source-side drag evaluation. The fix adds the same hook to
// both missing sites so browser → chat drag works uniformly
// across all 3 dispatch modes.
//
// This test locks the invariant structurally: the dashboard source
// must contain `dragWire.onMouse(m)` exactly 3 times (one per
// routeMouseWiring block). If a future refactor drops the hook
// from any site again, this test fails loudly per site.

import { describe, expect, test } from 'bun:test';
import { tuiSourceText } from './helpers/dashboard-source.js';


describe('DS-3a-follow · dashboard route parity', () => {
  test('dragWire.onMouse(displayMouse) is called in all 3 routeMouseWiring sites (+3 modal-guard sites)', () => {
    // 2026-07-07 · dashboard decomposition follow-up: the dispatch
    // routes now shallow-copy the event (`const displayMouse = { ...m }`)
    // so the hook argument renamed m → displayMouse. Count grew 3 → 6:
    // the original 3 routeMouseWiring blocks (streaming / idle / input)
    // plus 3 modal-path sites added since (mx-mouse modal-consumed,
    // mx-mouse modal-fellthrough, textInput foreground-modal guard) —
    // drag evaluation must run on modal-routed mouse too. Exact count
    // kept so a dropped hook at any site still fails loudly.
    const src = tuiSourceText();
    const hookPattern = /dragWire\.onMouse\(displayMouse\);/g;
    const matches = src.match(hookPattern) ?? [];
    expect(matches.length).toBe(6);
  });

  test('each routeMouseWiring block that contains handleMouse(displayMouse) also contains dragWire.onMouse(displayMouse)', () => {
    // Find every `routeMouseWiring: ... {` block and check it
    // includes the hook. Block scan is char-based to avoid TS AST
    // import cost.
    const src = tuiSourceText();
    const blocks = extractRouteMouseWiringBlocks(src);
    expect(blocks.length).toBe(3);
    for (const block of blocks) {
      expect(block).toContain('mouseWiring.handleMouse(displayMouse)');
      expect(block).toContain('dragWire.onMouse(displayMouse);');
    }
  });
});

function extractRouteMouseWiringBlocks(src: string): readonly string[] {
  const out: string[] = [];
  const needle = 'routeMouseWiring:';
  let idx = 0;
  while (true) {
    const start = src.indexOf(needle, idx);
    if (start === -1) break;
    // Scan forward — take the next ~400 chars as the block body.
    // routeMouseWiring arrow / fn body fits well within 400 chars in
    // the current layout; if it grows past that, we include some of
    // the next property but both assertions remain meaningful (we
    // want the hook to appear near this route, not elsewhere).
    const end = Math.min(src.length, start + 400);
    out.push(src.slice(start, end));
    idx = end;
  }
  return out;
}
