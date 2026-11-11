// Browser-pane comma-chord runtime — yazi-style `,v` / `,s`.
//
// Sits between the dashboard's pane key dispatcher and the existing
// chord-state machine (`src/input-core/chord-state.ts`). Returns
// `true` if it consumed the key — the caller should bail out of its
// own switch in that case.
//
// Why a separate module: dashboard.ts is on the "shared hot files"
// list (CLAUDE.md). Every line moved here is one less merge conflict
// for parallel branches and one more unit-testable surface.
//
// Yazi precedent: `yazi-fm/src/router.rs:35-54` (Which mode arm) +
// `yazi-core/src/which/which.rs:17-48` (state machine). Our chord
// state machine is simpler — single leader, single continuation, no
// live-filter popup — but the user-facing semantics match.

import {
  armChordLeader,
  consumeChordContinuation,
  isChordArmed,
  disarmChordLeader,
} from '../input-core/chord-state.js';
import type { Key } from '../tui.js';

const COMMA_LEADER = 'browser-comma';
const CHORD_HINT_GROUP = 'browser-comma-hint';

/** Keys that arm the comma chord. ',' on US layout, 'ㅁ' on the
 *  same physical key under the Korean 2-set IME. */
const COMMA_KEYS = new Set([',', 'ㅁ']);
/** v continuation aliases — 'v' on US, 'ㅍ' under Korean IME. */
const V_KEYS = new Set(['v', 'ㅍ']);
/** s continuation aliases — 's' on US, 'ㄴ' under Korean IME. */
const S_KEYS = new Set(['s', 'ㄴ']);

export interface BrowserChordRuntimeDeps {
  /** Show the chord-armed hint toast — replaces the prior hint toast
   *  in `CHORD_HINT_GROUP`. */
  showChordHint(): void;
  /** Dismiss the chord-armed hint toast. */
  clearChordHint(): void;
  /** Run the `,v` action — open the focused file in $EDITOR. */
  onEditFocused(): Promise<void> | void;
  /** Run the `,s` action — LLM summary popup. */
  onSummarizeFocused(): Promise<void> | void;
  /** Surface a short notice to the chat / log. */
  notice(level: 'muted' | 'warning', msg: string): void;
}

export interface BrowserChordRuntime {
  /** Returns `true` iff the key was consumed (chord arm OR
   *  continuation), `false` if it should fall through to the
   *  caller's normal handling. Async because continuation actions
   *  may shell out (`,v` → launchEditor) or call the network
   *  (`,s` → LLM). */
  tryHandleKey(key: Key): Promise<boolean>;
}

export const BROWSER_CHORD_INTERNAL = {
  COMMA_LEADER,
  CHORD_HINT_GROUP,
  COMMA_KEYS,
  V_KEYS,
  S_KEYS,
} as const;

export function createBrowserChordRuntime(
  deps: BrowserChordRuntimeDeps,
): BrowserChordRuntime {
  return {
    async tryHandleKey(key: Key): Promise<boolean> {
      // Modifier-bearing keys never participate in the chord — Ctrl+,
      // / Alt+, are reserved for higher-level bindings. shift+key is
      // OK because the IME-shifted form is what we match against
      // (key.name already reflects the post-shift letter).
      if (key.ctrl || key.alt) return false;
      const name = key.name ?? '';

      // 1. Arming: comma key seen, no chord pending.
      if (COMMA_KEYS.has(name)) {
        // Pressing comma a second time inside the window resets the
        // timer (yazi behaviour: re-pressing the prefix keeps Which
        // alive). armChordLeader handles the timer reset internally.
        armChordLeader(COMMA_LEADER, () => {
          deps.clearChordHint();
        });
        deps.showChordHint();
        return true;
      }

      // 2. Continuation: a chord IS armed and the next key arrived.
      //    consumeChordContinuation always clears the chord — even
      //    on unrecognized keys — so a stale leader can never
      //    persist past the first non-comma key.
      if (isChordArmed()) {
        const combined = consumeChordContinuation(name);
        if (!combined || !combined.startsWith(`${COMMA_LEADER} `)) {
          // Some other chord was active (different leader). Don't
          // consume — let the caller handle it.
          return false;
        }
        deps.clearChordHint();
        const tail = combined.slice(COMMA_LEADER.length + 1);
        if (V_KEYS.has(tail)) {
          await deps.onEditFocused();
          return true;
        }
        if (S_KEYS.has(tail)) {
          await deps.onSummarizeFocused();
          return true;
        }
        // Unrecognized continuation — surface a hint and swallow
        // (yazi's Which dismisses silently on unknown keys).
        deps.notice('muted', `  ,${tail}: unknown chord`);
        return true;
      }

      return false;
    },
  };
}

/** Test-only helper — clear any chord state to keep tests isolated. */
export function __resetBrowserChordRuntimeForTests(): void {
  if (isChordArmed()) disarmChordLeader();
}
