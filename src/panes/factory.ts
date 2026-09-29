// ── VW-term-infra W1 — PaneFactory ──
//
// Single entry point for substrate consumers that need a Pane instance
// for a given PaneRef. Maintains a cache keyed by (windowId, paneId)
// so repeated describe/snapshot/addTap calls don't churn wrappers.
//
// The factory wraps terminals, shell handles and widgets, or supplies placeholders.
//
// Dashboard integration (per LESSONS L5 risk discipline): this module
// only provides the resolve API. VW composer / capture engine call
// into the factory as consumers; existing VW rendering paths are NOT
// rewritten in this commit. Real dashboard-boot wiring lands in a
// follow-up.
//
// See: 내부 문서 `PLAN-session-vw-term-infra-wiring` §6 (W1 · C7)

import type { ShellHandle } from '../shell-runner/types.js';
import type { TerminalInstance } from '../terminal-matrix/types.js';
import type { Widget, WidgetInstance } from '../widgets/types.js';
import { ExternalTerminalPane } from './external-terminal-pane.js';
import { PlaceholderPane, type PlaceholderReason } from './placeholder-pane.js';
import { TerminalPane } from './terminal-pane.js';
import { WebTerminalPane, type WebTerminalPaneOpts } from './web-terminal-pane.js';
import { WidgetPane } from './widget-pane.js';
import type { Pane, PaneRef } from './types.js';

/** A resolver factory. Usually a singleton per dashboard session. */
export class PaneFactory {
  private readonly cache = new Map<string, Pane>();

  /** Wrap a TerminalMatrix TerminalInstance as a Pane. */
  resolveFromTerminal(ref: PaneRef, term: TerminalInstance): Pane {
    const key = cacheKey(ref);
    const cached = this.cache.get(key);
    if (cached && cached.kind.kind === 'terminal') {
      const tkind = cached.kind;
      if (tkind.kind === 'terminal' && tkind.terminalId === term.id) return cached;
    }
    const pane = new TerminalPane(ref, term);
    this.cache.set(key, pane);
    return pane;
  }

  /** WT-S-3 — wrap a PWA web-terminal PreviewTerminal as a Pane.
   *  Caller (preview-tap-registry) supplies the PreviewTerminal +
   *  identifier pair; the factory caches by `ref` so subsequent
   *  `peek()` returns the same instance for the lifetime of the
   *  underlying PTY. The convention `webTerminalPaneRef(terminalId)`
   *  in `web-terminal-pane.ts` builds the canonical ref. */
  resolveFromWebTerminal(ref: PaneRef, opts: WebTerminalPaneOpts): Pane {
    const key = cacheKey(ref);
    const cached = this.cache.get(key);
    if (cached && cached.kind.kind === 'web-terminal') {
      const wk = cached.kind;
      if (wk.kind === 'web-terminal' && wk.terminalId === opts.terminalId) return cached;
    }
    const pane = new WebTerminalPane(ref, opts);
    this.cache.set(key, pane);
    return pane;
  }

  /** Wrap a Shell Runner ShellHandle as a Pane. */
  resolveFromHandle(ref: PaneRef, handle: ShellHandle): Pane {
    const key = cacheKey(ref);
    const cached = this.cache.get(key);
    if (cached && cached.kind.kind === 'external-terminal') {
      const ek = cached.kind;
      if (ek.kind === 'external-terminal' && ek.shellHandleId === handle.id) return cached;
    }
    const pane = new ExternalTerminalPane(ref, handle);
    this.cache.set(key, pane);
    return pane;
  }

  /** Wrap a WidgetInstance + Widget definition as a Pane. */
  resolveFromWidget(ref: PaneRef, instance: WidgetInstance, def: Widget): Pane {
    const key = cacheKey(ref);
    const cached = this.cache.get(key);
    if (cached && cached.kind.kind === 'widget') {
      const wk = cached.kind;
      if (wk.kind === 'widget' && wk.widgetId === instance.id) return cached;
    }
    const pane = new WidgetPane(ref, instance, def);
    this.cache.set(key, pane);
    return pane;
  }

  /** Produce a placeholder pane for empty / error / loading slots. */
  resolvePlaceholder(ref: PaneRef, reason: PlaceholderReason, detail?: string): Pane {
    const key = cacheKey(ref);
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.kind.kind === 'placeholder' &&
      cached.kind.reason === reason
    ) return cached;
    const pane = new PlaceholderPane(ref, reason, detail);
    this.cache.set(key, pane);
    return pane;
  }

  /** Look up any pane previously resolved for this ref, without
   *  creating one. Returns undefined if nothing is cached. */
  peek(ref: PaneRef): Pane | undefined {
    return this.cache.get(cacheKey(ref));
  }

  /** Drop the cached pane for `ref`. Called on placement moves,
   *  pane close, or visibility transitions that should void the
   *  prior wrapper. */
  invalidate(ref: PaneRef): void {
    const key = cacheKey(ref);
    const cached = this.cache.get(key);
    if (cached) {
      try { cached.unmount(); } catch { /* isolate unmount errors */ }
      this.cache.delete(key);
    }
  }

  /** Clear the whole cache (dashboard shutdown). */
  reset(): void {
    for (const pane of this.cache.values()) {
      try { pane.unmount(); } catch { /* isolate */ }
    }
    this.cache.clear();
  }

  /** Number of cached panes — useful for tests + diagnostics. */
  get cacheSize(): number { return this.cache.size; }
}

function cacheKey(ref: PaneRef): string {
  return `${ref.windowId}::${ref.paneId}::${ref.runnerLabel ?? ''}`;
}

// ── Default singleton (opt-in) ─────────────────────────────────

let defaultFactory: PaneFactory | null = null;

/** Access the process-wide default factory. Dashboard boot calls
 *  this during substrate init; tests can construct their own
 *  instance to avoid cross-test cache pollution. */
export function getDefaultPaneFactory(): PaneFactory {
  if (!defaultFactory) defaultFactory = new PaneFactory();
  return defaultFactory;
}

/** Test-only: replace the default factory. Useful to inject a fresh
 *  PaneFactory per `describe` block without a full module reset. */
export function __setDefaultPaneFactory(factory: PaneFactory | null): void {
  defaultFactory = factory;
}
