// Tests for the experiment/voice-chat-realtime-rebind modal-A swallow
// behavior at the dashboard priority-key route layer. Verifies that
// while the voice-chat controller is active, every key (other than
// the chord toggle / force-quit, which are handled in earlier steps)
// is consumed by routeVoiceChatActiveKey and never reaches the
// downstream dispatch chain.

import { describe, it, expect } from 'bun:test';
import {
  routeDashboardPriorityKey,
  type DashboardPriorityKeyRouteDeps,
} from '../src/dashboard/input/dashboard-priority-key-route.js';
import type { Key } from '../src/tui.js';

function makeKey(name: string, mods: Partial<Pick<Key, 'ctrl' | 'shift' | 'alt'>> = {}): Key {
  return {
    name,
    ctrl: !!mods.ctrl,
    shift: !!mods.shift,
    alt: !!mods.alt,
  } as Key;
}

interface RouteSpy {
  preKeyFired: number;
  termModalFired: number;
  bellFired: number;
}

function makeDeps(opts: {
  voiceChatActive: boolean;
  onEsc?: () => void;
  spy: RouteSpy;
  onActiveKey?: (k: Key) => void;
}): DashboardPriorityKeyRouteDeps<null> {
  const { voiceChatActive, onEsc, spy, onActiveKey } = opts;
  return {
    isForceQuitChord: () => false,
    routeVoiceEnterChord: () => false,
    routeVoiceModeKey: () => false,
    routeVoiceChatRealtimeChord: () => false,
    routeVoiceChatActiveKey: async (k: Key) => {
      if (!voiceChatActive) return false;
      onActiveKey?.(k);
      if (k.name === 'escape') {
        onEsc?.();
        return true;
      }
      return true; // swallow everything else
    },
    routeBellKey: async () => { spy.bellFired++; return false; },
    dispatchPreKey: async () => { spy.preKeyFired++; return false; },
    routeExclusiveTerminalModalKey: () => { spy.termModalFired++; return false; },
    routeArmedChordKey: async () => false,
    armPrefixChord: () => false,
    isHardQuitKey: () => false,
    matchGlobalAction: () => null,
    runGlobalAction: () => {},
    routeLayoutModalKey: async () => false,
  };
}

describe('routeDashboardPriorityKey — voice-chat modal-A swallow', () => {
  it("swallows typing keys (a, space, enter) while voice-chat is active", async () => {
    const spy: RouteSpy = { preKeyFired: 0, termModalFired: 0, bellFired: 0 };
    const seen: string[] = [];
    const deps = makeDeps({
      voiceChatActive: true,
      spy,
      onActiveKey: (k) => seen.push(k.name),
    });
    for (const k of [makeKey('a'), makeKey('space'), makeKey('return')]) {
      const result = await routeDashboardPriorityKey(k, deps);
      expect(result.type).toBe('handled');
    }
    expect(seen).toEqual(['a', 'space', 'return']);
    // Downstream handlers must never have fired.
    expect(spy.bellFired).toBe(0);
    expect(spy.preKeyFired).toBe(0);
    expect(spy.termModalFired).toBe(0);
  });

  it('forwards ESC into the controller exit hook + claims the key', async () => {
    const spy: RouteSpy = { preKeyFired: 0, termModalFired: 0, bellFired: 0 };
    let escFired = 0;
    const deps = makeDeps({
      voiceChatActive: true,
      spy,
      onEsc: () => { escFired += 1; },
    });
    const result = await routeDashboardPriorityKey(makeKey('escape'), deps);
    expect(result.type).toBe('handled');
    expect(escFired).toBe(1);
    expect(spy.preKeyFired).toBe(0);
  });

  it('passthrough when voice-chat controller is idle', async () => {
    const spy: RouteSpy = { preKeyFired: 0, termModalFired: 0, bellFired: 0 };
    const deps = makeDeps({
      voiceChatActive: false,
      spy,
    });
    const result = await routeDashboardPriorityKey(makeKey('a'), deps);
    expect(result.type).toBe('passthrough');
    // All downstream stubs were exercised (they all returned false).
    expect(spy.bellFired).toBe(1);
    expect(spy.preKeyFired).toBe(1);
    expect(spy.termModalFired).toBe(1);
  });

  it('chord (alt+r) takes precedence over modal-A — handled at step 0r', async () => {
    const spy: RouteSpy = { preKeyFired: 0, termModalFired: 0, bellFired: 0 };
    let chordFired = 0;
    let activeKeyFired = 0;
    const deps: DashboardPriorityKeyRouteDeps<null> = {
      ...makeDeps({ voiceChatActive: true, spy }),
      routeVoiceChatRealtimeChord: () => { chordFired += 1; return true; },
      routeVoiceChatActiveKey: async () => { activeKeyFired += 1; return true; },
    };
    const result = await routeDashboardPriorityKey(makeKey('r', { alt: true }), deps);
    expect(result.type).toBe('handled');
    expect(chordFired).toBe(1);
    expect(activeKeyFired).toBe(0); // didn't fall through
  });
});
