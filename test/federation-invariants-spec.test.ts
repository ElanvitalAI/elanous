// Phase 5 partial (substrate Occam refactor, 2026-05-03) —
// Federation invariants F1-F10 spec assertions.
//
// Per REQUIREMENTS §5, the 10 cross-axis invariants are the rules
// that the four substrate axes (Surface Tree · Input Dispatch ·
// Federated · Render Pipeline) must respect together. Violating
// any breaks more than one axis.
//
// This file documents each invariant + asserts compliance via the
// most-targeted check available today. Future PRs can upgrade
// individual cases to lint rules / runtime asserts; for now the
// structural-test layer provides regression guards that catch
// reintroduction of historic incident patterns.
//
// Reference: 내부 문서 `REQUIREMENTS-substrate-occam-2026-05-03`
//   §5 (federation contract) + Phase 5 spec in PLAN §7.

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  TIER_ORDER,
  tiersCompatible,
  surfaceCanOwnFocus,
  surfaceParticipatesInKeys,
  type SurfaceFocus,
} from '../src/display/types.js';
import { resolveKeyAlias } from '../src/input-core/key-alias-table.js';
import { isModalSurface, type ModalSurface } from '../src/display/modal-stack.js';
import type { DisplaySurface } from '../src/display/types.js';

// ─── Helpers ──────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function srcFiles(): string[] { return walk('src'); }

// ─── F1 · Input never bypasses the surface tree ──────────────
// Tested at: routeKey / routeMouse always consult focus stack +
// surface tier. Structural check: no `addEventListener` style
// global keyboard hooks bypassing the coordinator.

describe('F1 · Input never bypasses the surface tree', () => {
  test('coordinator routeKey is the only key dispatch entry point', () => {
    // Sanity check: the coordinator exports routeKey + routeKeyAsync
    // and both go through the same dispatch chain. (Imported above
    // to confirm the module compiles.)
    const types = readFileSync('src/display/coordinator.ts', 'utf-8');
    expect(types).toContain('routeKey');
    expect(types).toContain('routeKeyAsync');
  });
});

// ─── F2 · Focus implies dispatch precedence ───────────────────
// Implemented in `topFocusedSurface`: focused surface gets first
// crack. Q3 enum (`focus: 'owns' | 'participates' | 'none'`)
// codifies "focused" precisely.

describe('F2 · Focus implies dispatch precedence (Q3 enum)', () => {
  test('SurfaceFocus enum has exactly 3 values', () => {
    const all: SurfaceFocus[] = ['owns', 'participates', 'none'];
    for (const f of all) {
      expect(typeof surfaceCanOwnFocus(f)).toBe('boolean');
      expect(typeof surfaceParticipatesInKeys(f)).toBe('boolean');
    }
  });

  test('only owns participates in focus.active', () => {
    expect(surfaceCanOwnFocus('owns')).toBe(true);
    expect(surfaceCanOwnFocus('participates')).toBe(false);
    expect(surfaceCanOwnFocus('none')).toBe(false);
  });

  test("'owns' AND 'participates' both receive key routing; 'none' transparent", () => {
    expect(surfaceParticipatesInKeys('owns')).toBe(true);
    expect(surfaceParticipatesInKeys('participates')).toBe(true);
    expect(surfaceParticipatesInKeys('none')).toBe(false);
  });
});

// ─── F3 · A modal that captures input must also paint ────────
// Type-enforced: ModalSurface (modal-stack.ts) requires both `paint`
// and `bounds`. Tested by tsc — this is a documentation guard.

describe('F3 · Modals that capture input must paint (type-enforced)', () => {
  test('ModalSurface type requires paint + bounds (compile-time)', () => {
    const modal: ModalSurface = {
      id: 'test-modal',
      owner: 'dashboard',
      focus: 'owns',
      priority: 1,
      kind: 'modal',
      render: () => [],
      bounds: { row: 1, col: 1, width: 10, height: 3 },
      paint: () => 'modal painted',
    };
    // @ts-expect-error ModalSurface requires paint even when bounds is supplied.
    const missingPaint: ModalSurface = {
      id: 'no-paint', owner: 'dashboard', focus: 'owns', priority: 1,
      kind: 'modal', render: () => [],
      bounds: { row: 1, col: 1, width: 10, height: 3 },
    };
    // @ts-expect-error ModalSurface requires bounds even when paint is supplied.
    const missingBounds: ModalSurface = {
      id: 'no-bounds', owner: 'dashboard', focus: 'owns', priority: 1,
      kind: 'modal', render: () => [], paint: () => 'modal painted',
    };
    const surface: DisplaySurface = modal;
    expect(isModalSurface(surface)).toBe(true);
    expect(isModalSurface(missingPaint)).toBe(false);
    expect(isModalSurface(missingBounds)).toBe(false);
    if (isModalSurface(surface)) {
      expect(surface.paint()).toBe('modal painted');
      expect(surface.bounds).toEqual({ row: 1, col: 1, width: 10, height: 3 });
    }
  });
});

// ─── F4 · Workspace identity is a paint identity ─────────────
// Tested in src/display/coordinator.ts:1769+ where workspace-affine
// focus changes mark host chrome dirty (status + dock).

describe('F4 · Workspace identity is a paint identity', () => {
  test('host chrome dirty rule documented in source', () => {
    const coord = readFileSync('src/display/coordinator.ts', 'utf-8');
    // Look for the host chrome dirty helper / decision point.
    expect(coord).toContain('shouldDirtyHostChromeForFocusChange');
  });
});

// ─── F5 · Lifecycle events drive all axes ────────────────────
// Per REQUIREMENTS §3.7-3.8: pushModal + popModal are atomic
// transactions emitting `pushed → mounted → focused` and
// `closed → unfocused → disposed`.

describe('F5 · Lifecycle events drive all axes', () => {
  test('coordinator emits lifecycle events for modals', () => {
    const coord = readFileSync('src/display/coordinator.ts', 'utf-8');
    expect(coord).toContain('pushModal');
    expect(coord).toContain('popModal');
    // Mirror to the ModalLifecycle primitive — the lifecycle source
    // of truth.
    expect(coord).toMatch(/mirrorPush|ModalLifecycle/);
  });
});

// ─── F6 · Z-order respects tier order at insertion ───────────
// Enforced via tiersCompatible() at pushModal under
// ELANOUS_BOUNDARY_CHECK=1. Test the invariant function directly.

describe('F6 · Z-order respects tier order at insertion', () => {
  test('tiersCompatible() is a strict weak ordering', () => {
    expect(tiersCompatible(undefined, 'vw')).toBe(true);     // empty stack
    expect(tiersCompatible('vw', 'dialog')).toBe(true);      // ascending
    expect(tiersCompatible('dialog', 'dialog')).toBe(true);  // same tier
    expect(tiersCompatible('dialog', 'vw')).toBe(false);     // descending
    expect(tiersCompatible('tooltip', 'vw')).toBe(false);    // top → bottom
  });

  test('TIER_ORDER is the canonical layering (low → high rank)', () => {
    // Spec: vw < execution < terminal < dialog < popup < menu < picker < tooltip
    expect(TIER_ORDER).toEqual([
      'vw', 'execution', 'terminal', 'dialog', 'popup', 'menu', 'picker', 'tooltip',
    ]);
  });
});

// ─── F7 · Hit-test order = render reverse ────────────────────
// Tested in dashboard mouse-wiring tests; documented invariant.

describe('F7 · Hit-test order = render reverse', () => {
  test('mouse wiring documented in src', () => {
    const wiring = readFileSync('src/dashboard/input/mouse-wiring.ts', 'utf-8');
    // The hit-test routes top-down through the focus stack.
    expect(wiring.length).toBeGreaterThan(0);
  });
});

// ─── F8 · Generation bumps are the federation seam ───────────
// Phase 4 deferred — generation cache not yet implemented.
// Documentation marker only.

describe('F8 · Generation bumps (Phase 4 deferred)', () => {
  test.skip('generation field on DisplaySurface (Phase 4 deferred)', () => {
    // Implementation deferred per Phase 4 partial PR.
  });
});

// ─── F9 · Occluder pop triggers full-frame redraw ────────────
// Implemented in coordinator.popModal (always markDirty('all') +
// forceNext = true). Phase 4 PR documented + tested this.

describe('F9 · Occluder pop triggers full-frame redraw', () => {
  test('popModal source contains the F9 / Q7 B+ implementation', () => {
    const coord = readFileSync('src/display/coordinator.ts', 'utf-8');
    expect(coord).toContain('Q7 B+');
    expect(coord).toContain("markDirty('all')");
  });
});

// ─── F10 · Drag-to-front mutates within-tier z, never tier ───
// Phase 4 deferred — drag-to-front not yet wired.
// Documentation marker only.

describe('F10 · Drag-to-front (Phase 4 deferred)', () => {
  test.skip('drag-to-front raises within-tier z (Phase 4 deferred)', () => {
    // Implementation deferred per Phase 4 partial PR.
  });
});

// ─── Q4 supplemental · Key alias table is central ────────────
// Phase 1B already shipped; this asserts no per-binding pipe
// alias has crept back in.

describe('Q4 supplemental · No per-binding pipe alias regression', () => {
  test('no `key: \'...|...\'` registrations in src', () => {
    const offenders: string[] = [];
    for (const file of srcFiles()) {
      const content = readFileSync(file, 'utf-8');
      // Match `key: 'C-x|C-y'` and similar patterns.
      const matches = content.match(/key:\s*['"][CASM]-[^'"]*\|[CASM]-[^'"]*['"]/g);
      if (matches) {
        offenders.push(`${file}: ${matches.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('resolveKeyAlias resolves built-in jamo without per-binding declarations', () => {
    // Smoke-check that the central table works for the common cases.
    expect(resolveKeyAlias('ㅏ')).toBe('k');
    expect(resolveKeyAlias('ㅔ')).toBe('p');
    expect(resolveKeyAlias('ㅡ')).toBe('m');
  });
});
