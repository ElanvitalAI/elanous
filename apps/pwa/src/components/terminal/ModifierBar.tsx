'use client';

// WT-X-1 — mobile modifier bar.
//
// 8 sticky software keys for iPad-first PWA terminal users: the
// physical keyboard handles letters/numbers, this bar fills in the
// keys most virtual keyboards omit (Esc, Tab, Ctrl, Alt, arrows).
//
// Display: only when `@media (pointer: coarse)` matches — desktop
// users with a mouse never see it. Hybrid devices (Surface Pro,
// ChromeOS tablet mode) auto-toggle as the user docks/undocks.
//
// Modifier UX (Ctrl / Alt):
//   - Click toggles state ON (amber visual indicator).
//   - Click again → toggle OFF.
//   - 5-second auto-release so the user isn't permanently stuck in a
//     modifier mode after switching apps and forgetting.
//   - Pressing a non-modifier button (Esc / Tab / arrow) sends the
//     prefixed sequence then auto-releases the modifier(s) — this
//     mirrors iOS native software keyboard behaviour where Shift
//     auto-deactivates after one letter.
//
// Wire path: each press builds a byte sequence via key-sequences.ts
// and routes it through the terminal's registered input sender.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { debugLog } from '@/lib/debug';
import { sendToTerminal } from './terminal-input-registry';
import {
  buildKeySequence,
  type ModifierKey,
  type ModifierState,
} from '@/lib/key-sequences';

interface Props {
  terminalId: string;
}

interface ButtonSpec {
  key: ModifierKey;
  label: string;
  /** Larger tap target hint — arrows fit narrower than wider Esc/Tab. */
  width: 'narrow' | 'wide';
  title: string;
}

const NAV_BUTTONS: ButtonSpec[] = [
  { key: 'esc', label: 'Esc', width: 'wide', title: 'Escape (vim normal mode)' },
  { key: 'tab', label: 'Tab', width: 'wide', title: 'Tab (autocomplete)' },
  { key: 'left', label: '←', width: 'narrow', title: 'Left arrow' },
  { key: 'down', label: '↓', width: 'narrow', title: 'Down arrow' },
  { key: 'up', label: '↑', width: 'narrow', title: 'Up arrow' },
  { key: 'right', label: '→', width: 'narrow', title: 'Right arrow' },
];

const MODIFIER_AUTO_RELEASE_MS = 5000;

export function ModifierBar({ terminalId }: Props) {
  const { sessionId } = useDaemon();
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  // Refs let callbacks stay stable while reading current modifier state.
  const ctrlRef = useRef(false);
  const altRef = useRef(false);
  ctrlRef.current = ctrl;
  altRef.current = alt;

  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset auto-release timer whenever a modifier is freshly engaged.
  // Toggling off mid-flight clears the timer outright.
  const armAutoRelease = useCallback((nextCtrl: boolean, nextAlt: boolean): void => {
    if (releaseTimerRef.current !== null) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
    if (!nextCtrl && !nextAlt) return;
    releaseTimerRef.current = setTimeout(() => {
      setCtrl(false);
      setAlt(false);
      releaseTimerRef.current = null;
      debugLog('webterm.modbar.auto-release', {});
    }, MODIFIER_AUTO_RELEASE_MS);
  }, []);

  useEffect(() => () => {
    if (releaseTimerRef.current !== null) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
  }, []);

  const sendKey = useCallback((key: ModifierKey): void => {
    if (!sessionId) {
      debugLog('webterm.modbar.no-session', { key });
      return;
    }
    const mods: ModifierState = { ctrl: ctrlRef.current, alt: altRef.current };
    const data = buildKeySequence(key, mods);
    debugLog('webterm.modbar.send', { key, ctrl: mods.ctrl, alt: mods.alt, bytes: data.length });
    try {
      sendToTerminal(terminalId, data);
    } catch (e) {
      debugLog('webterm.modbar.send-error', { reason: String(e) });
    }
    // Auto-release modifiers after a non-modifier key — mirrors iOS
    // Shift behaviour. The user can still click Ctrl again immediately
    // for a chain.
    if (mods.ctrl || mods.alt) {
      setCtrl(false);
      setAlt(false);
      armAutoRelease(false, false);
    }
  }, [sessionId, terminalId, armAutoRelease]);

  const toggleCtrl = useCallback((): void => {
    const next = !ctrlRef.current;
    setCtrl(next);
    armAutoRelease(next, altRef.current);
  }, [armAutoRelease]);

  const toggleAlt = useCallback((): void => {
    const next = !altRef.current;
    setAlt(next);
    armAutoRelease(ctrlRef.current, next);
  }, [armAutoRelease]);

  const navButtonClass = (width: 'narrow' | 'wide'): string =>
    [
      'flex h-7 items-center justify-center rounded border border-border',
      'bg-card font-mono text-[11px] text-muted-foreground',
      'hover:bg-muted hover:border-primary hover:text-foreground',
      'active:translate-y-px disabled:opacity-50',
      width === 'wide' ? 'px-2 min-w-[36px]' : 'w-8',
    ].join(' ');

  const modifierButtonClass = (active: boolean): string =>
    [
      'flex h-7 items-center justify-center rounded border font-mono text-[11px]',
      'px-2 min-w-[36px]',
      'active:translate-y-px disabled:opacity-50 transition-colors',
      active
        ? 'border-amber-400 bg-amber-100 text-amber-900 dark:border-amber-500 dark:bg-amber-900 dark:text-amber-100'
        : 'border-border bg-card text-muted-foreground hover:bg-muted hover:border-primary hover:text-foreground',
    ].join(' ');

  return (
    <div
      className="flex flex-wrap items-center gap-1 border-b border-border bg-background/60 px-2 py-1"
      data-testid="modifier-bar"
      role="toolbar"
      aria-label="Mobile keyboard modifiers"
    >
      {NAV_BUTTONS.map((btn) => (
        <button
          key={btn.key}
          type="button"
          className={navButtonClass(btn.width)}
          onClick={() => { sendKey(btn.key); }}
          disabled={!sessionId}
          aria-label={btn.title}
          title={btn.title}
          data-testid={`modbar-${btn.key}`}
        >
          {btn.label}
        </button>
      ))}
      <span className="mx-1 text-[10px] text-muted-foreground/60" aria-hidden>·</span>
      <button
        type="button"
        className={modifierButtonClass(ctrl)}
        onClick={toggleCtrl}
        disabled={!sessionId}
        aria-label={`Ctrl modifier ${ctrl ? 'active' : 'idle'}`}
        aria-pressed={ctrl}
        title="Ctrl modifier — toggles. Combines with arrow keys (e.g. Ctrl+→ = next word). Auto-releases after 5s or one keystroke."
        data-testid="modbar-ctrl"
      >
        Ctrl
      </button>
      <button
        type="button"
        className={modifierButtonClass(alt)}
        onClick={toggleAlt}
        disabled={!sessionId}
        aria-label={`Alt modifier ${alt ? 'active' : 'idle'}`}
        aria-pressed={alt}
        title="Alt modifier — toggles. Combines with Esc/Tab/arrows. Auto-releases after 5s or one keystroke."
        data-testid="modbar-alt"
      >
        Alt
      </button>
    </div>
  );
}
