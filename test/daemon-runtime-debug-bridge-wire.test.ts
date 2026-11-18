// ── Source-grep guards for the ACP-path debug-bridge wire ──
//
// PLAN-ios-rich-dev-feedback-hydrate M5 (ACP-path portion · 2026-05-14).
// Mirrors the PWA-path guard pattern: meta-api.ts:836 instantiates a
// `createDebugBridge` per turn and disposes it in `finally`. Without
// this assertion, the ACP-side wrap (`createDaemonRunTurn`) could be
// silently removed in a future refactor and iOS would stop receiving
// `debug.line` envelopes — the kind of regression unit + integration
// tests miss because dispatchTool still works and PWA still gets its
// own bridge.
//
// Per memory `feedback_source_level_grep_test_value` (PR #2084) and
// `feedback_post_acp_emit_wire_needed` (codify candidate · this PR
// origin) — the seam between two surfaces' emit policy is the exact
// kind of dead-wire bug source-grep catches.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');

function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8');
}

describe('daemon-runtime ACP-path debug-bridge wire (M5 · 2026-05-14)', () => {
  const src = readSource('src/boot/daemon-runtime.ts');

  test('createDaemonRunTurn wraps bridgeCoreTurnToAcp return with per-turn wrapper', () => {
    // The wrapper assigns the inner to a local, then returns an async
    // (turnCtx) closure that owns the debug-bridge lifecycle. Without
    // this assignment the wrap is collapsed back to `return
    // bridgeCoreTurnToAcp(deps)` and the bridge dies.
    expect(src).toMatch(/const\s+inner\s*=\s*bridgeCoreTurnToAcp\s*\(\s*deps\s*\)\s*;/);
    expect(src).toMatch(/return\s+async\s*\(\s*turnCtx[^)]*\)\s*:\s*Promise<void>/);
  });

  test('instantiates createDebugBridge inside the wrapper', () => {
    expect(src).toMatch(/createDebugBridge\s*\(/);
    // Bridge construction reads the ACP broadcaster — same require'd
    // module the M1-S tool ctx wire uses (line 516 family).
    expect(src).toMatch(/getActiveAcpFeedbackBroadcaster\s*\(/);
  });

  test('activates only for an explicit request from an operator (H-1 · 2026-11-18)', () => {
    // Was always-on: every ACP response carried every daemon conversation's chat.* lines.
    expect(src).toMatch(/readDebugTapRequest\s*\(\s*turnCtx\.promptMeta\s*\)/);
    expect(src).toMatch(/debugEnvelopeAllowed\s*\(\s*turnCtx\.audience\s*,/);
    expect(src).toMatch(/if\s*\(\s*broadcast\s*&&\s*debugAllowed\s*\)\s*{/);
    expect(src).toMatch(/debugBridge\??\.activate\s*\(\s*\)/);
  });

  test('dispose runs in finally so the sink unregisters under abort/throw', () => {
    // Without dispose the per-session LogSink leaks into the debug
    // singleton — every subsequent turn adds another sink and old
    // sessions still receive envelopes that nobody is listening to.
    expect(src).toMatch(/}\s*finally\s*{[^}]*debugBridge\??\.dispose\s*\(\s*\)/s);
  });

  test('bridge is null-skipped when the ACP broadcaster is absent', () => {
    // Mirrors the M1-S guard at line 519 (`if (broadcast)`). Without
    // this guard, headless tests that construct a runtime without
    // booting `runAcpServer` would throw on every turn.
    expect(src).toMatch(/if\s*\(\s*broadcast\s*&&\s*debugAllowed\s*\)\s*{/);
  });
});

describe('debug-bridge substrate stability (M6 PR 1 · 2026-05-13)', () => {
  const src = readSource('src/feedback/debug-bridge.ts');

  test('exports createDebugBridge + DebugBridge type', () => {
    expect(src).toMatch(/export\s+function\s+createDebugBridge/);
    expect(src).toMatch(/export\s+interface\s+DebugBridge/);
  });

  test('DEFAULT_DEBUG_CATEGORY_FILTER limits to chat|tool|agent (no acp)', () => {
    // The M5 ACP wrap relies on this default to bound bandwidth — the
    // bridge is always-on for ACP, so the filter is the only thing
    // preventing input.*/window.*/key.trace.* spam from saturating
    // peers. Loosening it (or dropping the regex entirely) should
    // force the M5 wrap to revisit gating.
    //
    // **acp is deliberately omitted** (2026-05-14 dogfood fix) — see
    // header comment in `src/feedback/debug-bridge.ts`. The bridge's
    // own envelope emit triggers `acp.broadcast.fanout` debug.log
    // events; including `acp` here creates an infinite feedback loop
    // (~46k fanouts/sec observed, saturated iOS WS, aborted LLM turn
    // at 30s mark).
    expect(src).toMatch(/DEFAULT_DEBUG_CATEGORY_FILTER\s*=\s*\/\^\(chat\|tool\|agent\)/);
    // Hard-block the regression — adding `acp` back creates a
    // dogfood-killing feedback loop.
    expect(src).not.toMatch(/DEFAULT_DEBUG_CATEGORY_FILTER\s*=\s*\/\^\(chat\|tool\|agent\|acp\)/);
  });
});
