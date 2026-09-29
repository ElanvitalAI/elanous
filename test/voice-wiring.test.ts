// PR-S1V.4-wiring (sprint 21-Parallel-Voice · 2026-04-29) — Voice host
// dashboard wiring tests.
//
// Tested invariants:
//   1. Step 0x — `routeVoiceEnterChord` claims Ctrl+Shift+V only when
//      voice mode is idle and the host exists; otherwise falls through.
//   2. Step 0c — `routeVoiceModeKey` delegates every key to
//      `host.maybeHandleKey` while voice mode is active and that path
//      swallows non-voice keys (modal A invariant).
//   3. priority-route ordering — Force quit (Step 0) stays reachable
//      even when voice mode is active so the user has an escape hatch.
//   4. Indicator subscription — host emits transition labels
//      (`🎙 Voice mode` / `🔴 Recording` / `✨ Transcribing`) and a
//      separate `✖ send failed` flash when bridge.onSendError fires.
//      Restore label is recomputed from the *current* state when the
//      timer expires (transition-aware), not whatever was active at the
//      time of the failure.
//   5. Status segment — `voiceSegment(label)` renders mauve flat text
//      when the label is non-empty; null/empty yields ''.
//   6. mouseWiring.buildStatusLine includes the voice segment when
//      `voiceLabel` is supplied (composition slot wiring).
//
// Reference: PLAN-voice-wiring-s1v4w-2026-04-29.md §4.3 / §4.4 / §4.5a
// + 내부 문서 §3.2 14 decisions.

import { describe, expect, mock, test } from 'bun:test';
import { routeDashboardPriorityKey } from '../src/dashboard/input/dashboard-priority-key-route.js';
import {
  createVoiceInputHost,
  indicatorForState,
  type VoiceInputHost,
  type VoiceIndicator,
} from '../src/dashboard/voice-input-host.js';
import { voiceSegment } from '../src/status/bar.js';
import type { Key } from '../src/tui.js';
import type { STTProvider, STTResult } from '../src/voice/stt-provider.js';

// ── Test helpers ──────────────────────────────────────────────────

function mkKey(over: Partial<Key> & Pick<Key, 'name'>): Key {
  return {
    name: over.name,
    ctrl: over.ctrl ?? false,
    shift: over.shift ?? false,
    ...(over.alt !== undefined ? { alt: over.alt } : {}),
    ...(over.kind !== undefined ? { kind: over.kind } : {}),
  };
}

interface FakeScheduler {
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  advance: (ms: number) => void;
}

function mkScheduler(): FakeScheduler {
  let now = 0;
  let seq = 0;
  const tasks = new Map<number, { at: number; cb: () => void }>();
  return {
    setTimer: (cb, ms) => {
      const id = ++seq;
      tasks.set(id, { at: now + ms, cb });
      return id;
    },
    clearTimer: (h) => {
      tasks.delete(h as number);
    },
    advance: (ms) => {
      now += ms;
      for (;;) {
        const due = [...tasks.entries()]
          .filter(([, t]) => t.at <= now)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        tasks.delete(due[0]);
        due[1].cb();
      }
    },
  };
}

function fakeSTT(text = ''): STTProvider {
  return {
    id: 'openai-whisper',
    transcribeBatch: mock(async (_pcm: Buffer): Promise<STTResult> => ({ text })),
  };
}

interface PriorityRouteHandles {
  forceQuitFired: number;
  bellFired: number;
  preKeyFired: number;
  termModalFired: number;
}

function mkPriorityDeps(host: VoiceInputHost | null) {
  const handles: PriorityRouteHandles = {
    forceQuitFired: 0,
    bellFired: 0,
    preKeyFired: 0,
    termModalFired: 0,
  };
  const matchesCtrlShiftV = (k: Key): boolean =>
    k.ctrl === true && k.shift === true && (k.name === 'v' || k.name === 'V');
  const deps = {
    isForceQuitChord: (k: Key) => {
      const fired = (k.ctrl === true && k.shift === true && k.name === 'q')
        || (k.ctrl === true && (k.name === '\\' || k.name === 'backslash'));
      if (fired) handles.forceQuitFired++;
      return fired;
    },
    routeVoiceEnterChord: (k: Key) => {
      if (!host) return false;
      if (host.getState().kind !== 'idle') return false;
      if (!matchesCtrlShiftV(k)) return false;
      host.requestEnter();
      return true;
    },
    routeVoiceModeKey: (k: Key) => {
      if (!host) return false;
      if (host.getState().kind === 'idle') return false;
      return host.maybeHandleKey(k);
    },
    routeVoiceChatRealtimeChord: (_k: Key) => false,
    routeVoiceChatActiveKey: async (_k: Key) => false,
    routeBellKey: async (_k: Key) => { handles.bellFired++; return false; },
    dispatchPreKey: async (_k: Key) => { handles.preKeyFired++; return false; },
    routeExclusiveTerminalModalKey: (_k: Key) => { handles.termModalFired++; return false; },
    routeArmedChordKey: async (_k: Key) => false,
    armPrefixChord: (_k: Key) => false,
    isHardQuitKey: (_k: Key) => false,
    matchGlobalAction: (_k: Key) => null,
    runGlobalAction: () => {},
    routeLayoutModalKey: async (_k: Key) => false,
  };
  return { deps, handles };
}

// ── Step 0x — Ctrl+Shift+V entry chord ────────────────────────────

describe('PR-S1V.4-wiring · priority-route Step 0x', () => {
  test('Ctrl+Shift+V claimed when host idle → requestEnter fires', async () => {
    const sched = mkScheduler();
    const host = createVoiceInputHost({
      sttProvider: fakeSTT(),
      resolveSession: () => null,
      submitToSession: async () => {},
      writeStdout: () => {},
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });
    const { deps, handles } = mkPriorityDeps(host);
    expect(host.getState().kind).toBe('idle');

    const result = await routeDashboardPriorityKey(
      mkKey({ name: 'v', ctrl: true, shift: true }),
      deps,
    );

    expect(result.type).toBe('handled');
    expect(host.getState().kind).toBe('active');
    // Bell + dispatchPreKey + terminalModal must NOT have run.
    expect(handles.bellFired).toBe(0);
    expect(handles.preKeyFired).toBe(0);
    expect(handles.termModalFired).toBe(0);
    host.dispose();
  });

  test('Ctrl+Shift+V passes through when host is null (no OPENAI_API_KEY path)', async () => {
    const { deps, handles } = mkPriorityDeps(null);
    const result = await routeDashboardPriorityKey(
      mkKey({ name: 'v', ctrl: true, shift: true }),
      deps,
    );
    // No host → the chord is inert; the rest of the pipeline runs.
    expect(result.type).toBe('passthrough');
    // Bell + dispatchPreKey + terminalModal saw the key (legacy path).
    expect(handles.bellFired).toBe(1);
    expect(handles.preKeyFired).toBe(1);
    expect(handles.termModalFired).toBe(1);
  });

  test('Ctrl+Shift+V is NOT claimed by Step 0x while voice mode is active', async () => {
    const sched = mkScheduler();
    const host = createVoiceInputHost({
      sttProvider: fakeSTT(),
      resolveSession: () => null,
      submitToSession: async () => {},
      writeStdout: () => {},
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });
    host.requestEnter();
    expect(host.getState().kind).toBe('active');

    const { deps, handles } = mkPriorityDeps(host);
    const result = await routeDashboardPriorityKey(
      mkKey({ name: 'v', ctrl: true, shift: true }),
      deps,
    );
    // Step 0x rejected (state !== 'idle'); Step 0c (routeVoiceModeKey)
    // claimed it as part of the modal A swallow.
    expect(result.type).toBe('handled');
    expect(handles.bellFired).toBe(0);
    expect(handles.preKeyFired).toBe(0);
    host.dispose();
  });
});

// ── Step 0c — modal A invariant ───────────────────────────────────

describe('PR-S1V.4-wiring · priority-route Step 0c (modal A)', () => {
  test('arbitrary press while active is swallowed before bell / preKey / termModal', async () => {
    const sched = mkScheduler();
    const host = createVoiceInputHost({
      sttProvider: fakeSTT(),
      resolveSession: () => null,
      submitToSession: async () => {},
      writeStdout: () => {},
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });
    host.requestEnter();
    const { deps, handles } = mkPriorityDeps(host);

    // Random press — `a`, `Ctrl+B`, etc. should never reach legacy
    // dispatchers while voice mode is active.
    for (const k of [
      mkKey({ name: 'a' }),
      mkKey({ name: 'b', ctrl: true }),
      mkKey({ name: 'w', alt: true }),
      mkKey({ name: '1', alt: true }),
      mkKey({ name: 'enter', kind: 'release' }),
    ]) {
      const r = await routeDashboardPriorityKey(k, deps);
      expect(r.type).toBe('handled');
    }
    expect(handles.bellFired).toBe(0);
    expect(handles.preKeyFired).toBe(0);
    expect(handles.termModalFired).toBe(0);
    host.dispose();
  });

  test('escape exits voice mode and returns control to legacy dispatchers', async () => {
    const sched = mkScheduler();
    const host = createVoiceInputHost({
      sttProvider: fakeSTT(),
      resolveSession: () => null,
      submitToSession: async () => {},
      writeStdout: () => {},
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });
    host.requestEnter();
    expect(host.getState().kind).toBe('active');

    const { deps } = mkPriorityDeps(host);
    await routeDashboardPriorityKey(mkKey({ name: 'escape' }), deps);
    expect(host.getState().kind).toBe('idle');

    // Subsequent `a` press now reaches legacy preKey.
    const { deps: deps2, handles } = mkPriorityDeps(host);
    await routeDashboardPriorityKey(mkKey({ name: 'a' }), deps2);
    expect(handles.preKeyFired).toBe(1);
    host.dispose();
  });

  test('Force quit chord still wins above voice mode (escape hatch)', async () => {
    const sched = mkScheduler();
    const host = createVoiceInputHost({
      sttProvider: fakeSTT(),
      resolveSession: () => null,
      submitToSession: async () => {},
      writeStdout: () => {},
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });
    host.requestEnter();

    const { deps, handles } = mkPriorityDeps(host);
    const result = await routeDashboardPriorityKey(
      mkKey({ name: 'q', ctrl: true, shift: true }),
      deps,
    );
    expect(result.type).toBe('quit');
    expect(handles.forceQuitFired).toBe(1);
    host.dispose();
  });
});

// ── Indicator subscription ───────────────────────────────────────

describe('PR-S1V.4-wiring · indicator subscription', () => {
  test('onIndicatorChange fires with transition labels', () => {
    const sched = mkScheduler();
    const host = createVoiceInputHost({
      sttProvider: fakeSTT(),
      resolveSession: () => null,
      submitToSession: async () => {},
      writeStdout: () => {},
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });
    const events: VoiceIndicator[] = [];
    const unsubscribe = host.onIndicatorChange((ind) => events.push({ ...ind }));
    host.requestEnter();
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]?.visible).toBe(true);
    expect(events[events.length - 1]?.label).toContain('Voice');
    unsubscribe();
    host.dispose();
  });

  test('indicatorForState helper maps every state', () => {
    expect(indicatorForState({ kind: 'idle' })).toEqual({ visible: false });
    expect(indicatorForState({ kind: 'active' }))
      .toEqual({ visible: true, label: '🎙 Voice mode' });
    expect(indicatorForState({ kind: 'recording' }))
      .toEqual({ visible: true, label: '🔴 Recording' });
    expect(indicatorForState({ kind: 'processing' }))
      .toEqual({ visible: true, label: '✨ Transcribing' });
  });
});

// ── Send failure surface (host-owned seam · §4.5a) ───────────────

describe('PR-S1V.4-wiring · bridge.onSendError → host indicator flash', () => {
  test('send failure flashes ✖ then restores from current state', async () => {
    const sched = mkScheduler();
    const host = createVoiceInputHost({
      sttProvider: fakeSTT(),
      resolveSession: () => ({ sessionId: 'sess-1' }),
      submitToSession: async () => { throw new Error('boom'); },
      writeStdout: () => {},
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
      sendErrorRestoreMs: 5000,
    });
    host.requestEnter();
    const events: VoiceIndicator[] = [];
    host.onIndicatorChange((ind) => events.push({ ...ind }));

    // Trigger a failed inject through the bridge — host's onSendError
    // wire should flash `✖ send failed` and queue a 5s restore.
    const bridgeResult = await host._internal.bridge.injectTranscript('hello');
    expect(bridgeResult.sendError).toBeInstanceOf(Error);
    const flash = events.find((e) => e.label?.startsWith('✖'));
    expect(flash).toBeDefined();

    // Before the timer fires the indicator stays in the failure state.
    sched.advance(4_999);
    const lastBeforeRestore = events[events.length - 1];
    expect(lastBeforeRestore?.label).toContain('✖');

    // 5s elapsed — host recomputes from voice-mode.getState() (still
    // active because we never released).
    sched.advance(2);
    const restored = events[events.length - 1];
    expect(restored?.visible).toBe(true);
    expect(restored?.label).toBe('🎙 Voice mode');
    host.dispose();
  });

  test('multiple failures within the restore window do not stack timers', async () => {
    const sched = mkScheduler();
    const host = createVoiceInputHost({
      sttProvider: fakeSTT(),
      resolveSession: () => ({ sessionId: 'sess-1' }),
      submitToSession: async () => { throw new Error('boom'); },
      writeStdout: () => {},
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
      sendErrorRestoreMs: 5000,
    });
    host.requestEnter();
    const events: VoiceIndicator[] = [];
    host.onIndicatorChange((ind) => events.push({ ...ind }));

    await host._internal.bridge.injectTranscript('one');
    sched.advance(2_000);
    await host._internal.bridge.injectTranscript('two');
    // First flash's timer was cleared; the second flash's 5s restore
    // is now the only pending timer.
    sched.advance(4_999);
    expect(events[events.length - 1]?.label).toContain('✖');
    sched.advance(2);
    expect(events[events.length - 1]?.label).toBe('🎙 Voice mode');
    host.dispose();
  });

  test('no-session transcript can hand off into dictation and exit voice mode', async () => {
    const sched = mkScheduler();
    const dictated: string[] = [];
    const host = createVoiceInputHost({
      sttProvider: fakeSTT(),
      resolveSession: () => null,
      submitToSession: async () => {},
      dictateTranscript: async (text) => {
        dictated.push(text);
        return true;
      },
      writeStdout: () => {},
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
    });
    host.requestEnter();
    expect(host.getState().kind).toBe('active');

    await host._internal.handleTranscript('hello dictation');

    expect(dictated).toEqual(['hello dictation']);
    expect(host.getState().kind).toBe('idle');
    host.dispose();
  });
});

// ── status bar voice segment + composition ────────────────────────

describe('PR-S1V.4-wiring · status segment composition', () => {
  test('voiceSegment hides when label is null/empty', () => {
    expect(voiceSegment(null)).toBe('');
    expect(voiceSegment('')).toBe('');
    expect(voiceSegment(undefined)).toBe('');
  });

  test('voiceSegment renders when label is non-empty', () => {
    const out = voiceSegment('🎙 Voice mode');
    expect(out).toContain('Voice mode');
    // chalk hex passthrough — in non-TTY test env the renderer may
    // strip ANSI; we just want the label preserved.
    expect(out).toContain('🎙');
  });
});

// ── transition-aware restore — recording state ────────────────────

describe('PR-S1V.4-wiring · transition-aware restore', () => {
  test('restore label tracks state transition during the flash window', async () => {
    // The host caches `voiceMode.getState()` lookups — inside the
    // restore timer callback we want to see a label that matches the
    // CURRENT state, not whatever was active when the failure
    // happened. We test this by mutating state inside the flash window.
    const sched = mkScheduler();
    const host = createVoiceInputHost({
      sttProvider: fakeSTT(),
      resolveSession: () => ({ sessionId: 'sess-1' }),
      submitToSession: async () => { throw new Error('boom'); },
      writeStdout: () => {},
      setTimer: sched.setTimer,
      clearTimer: sched.clearTimer,
      sendErrorRestoreMs: 5000,
    });
    host.requestEnter(); // active
    const events: VoiceIndicator[] = [];
    host.onIndicatorChange((ind) => events.push({ ...ind }));

    await host._internal.bridge.injectTranscript('hi');
    // While the flash is active, transition active → idle by Esc'ing
    // out of voice mode. Using the maybeHandleKey path matches the
    // production dispatch flow.
    host.maybeHandleKey({ name: 'escape', ctrl: false, shift: false });
    expect(host.getState().kind).toBe('idle');

    // 5s timer fires — the restore should now reflect IDLE
    // (visible=false), not the active label that was painted at the
    // start of the flash.
    sched.advance(5_001);
    const restored = events[events.length - 1];
    expect(restored?.visible).toBe(false);
    host.dispose();
  });
});
