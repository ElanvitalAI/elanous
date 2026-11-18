// M6 PR 1 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) — debug
// bridge unit tests.
//
// Invariants under test:
//  1. Gate OFF (default after construction) emits 0 envelopes even
//     when matching debug.log calls fire.
//  2. activate() opens the gate; subsequent matching events emit
//     `debug.line` envelopes with a stable blockId + monotonic seq.
//  3. Category filter is applied before the gate — non-matching
//     entries never reach the ring or the wire.
//  4. deactivate() closes the gate while the bridge sink stays
//     registered; the ring still accumulates so a re-activate keeps
//     the same monotonic seq.
//  5. Ring buffer caps at `ringBufferCap` (default 200) — overflow
//     drops oldest.
//  6. asciiFallback is populated on every emit (dumb-renderer
//     contract — empty array would force the drawer to synthesize).
//  7. emit throw inside the wire writer is swallowed — debug.log
//     stream stays alive.
//  8. dispose() unregisters the sink — subsequent debug.log emits 0
//     envelopes from the disposed bridge.
//  9. parentToolCallId is never set on debug.line envelopes (the
//     session-level block has no tool parent).
// 10. Two concurrent bridges (different sessionIds) accumulate
//     independently — sink isolation.

import { describe, expect, test } from 'bun:test';

import { debug, withAmbientSessionScope } from '../src/debug/log.js';
import {
  createDebugBridge,
  DEFAULT_DEBUG_CATEGORY_FILTER,
  makeDebugSessionBlockId,
  type DebugBridge,
  type DebugBridgeOpts,
} from '../src/feedback/debug-bridge.js';
import type { FeedbackEnvelope } from '../src/feedback/envelope.js';

/** H-1: the bridge keeps only lines produced inside its own session scope, so these
 *  legacy cases log from inside the rig's default session 's-1'. */
function slog(category: string, event: string, data?: unknown, sessionId = 's-1'): void {
  withAmbientSessionScope(sessionId, () => debug.log(category, event, data));
}

interface TestRig {
  emitted: FeedbackEnvelope[];
  bridge: DebugBridge;
  blockId: string;
  emitThrows: { value: boolean };
}

function rig(overrides?: Partial<DebugBridgeOpts>): TestRig {
  const emitted: FeedbackEnvelope[] = [];
  const emitThrows = { value: false };
  let t = 1_700_000_000_000;
  const sessionId = overrides?.sessionId ?? 's-1';
  const baseOpts: DebugBridgeOpts = {
    emit: (env) => {
      if (emitThrows.value) throw new Error('wire down');
      emitted.push(env);
    },
    sessionId,
    now: () => (t += 1),
  };
  const bridge = createDebugBridge({ ...baseOpts, ...overrides });
  return {
    emitted,
    bridge,
    blockId: makeDebugSessionBlockId(sessionId),
    emitThrows,
  };
}

describe('createDebugBridge · gate semantics', () => {
  test('gate OFF default — matching debug.log emits 0 envelopes', () => {
    const { emitted, bridge } = rig();
    try {
      slog('chat.test', 'no-gate', { sample: 1 });
      expect(emitted).toHaveLength(0);
    } finally {
      bridge.dispose();
    }
  });

  test('activate then matching debug.log emits one debug.line envelope', () => {
    const { emitted, bridge, blockId } = rig();
    try {
      bridge.activate();
      slog('chat.test', 'first-event', { x: 1 });
      expect(emitted).toHaveLength(1);
      const env = emitted[0]!;
      expect(env.kind).toBe('debug.line');
      expect(env.blockId).toBe(blockId);
      expect(env.phase).toBe('delta');
      expect(env.seq).toBe(1);
      expect(env.parentToolCallId).toBeUndefined();
      expect(env.asciiFallback.length).toBeGreaterThan(0);
      // Payload narrowing — TS discriminated union.
      if (env.kind === 'debug.line') {
        expect(env.payload.category).toBe('chat.test');
        expect(env.payload.event).toBe('first-event');
        expect(env.payload.data).toEqual({ x: 1 });
      }
    } finally {
      bridge.dispose();
    }
  });

  test('category filter drops non-matching entries', () => {
    const { emitted, bridge } = rig();
    try {
      bridge.activate();
      // Default filter is /^(chat|tool|agent|acp)\./ — `input.*` is
      // outside the whitelist so the sink rejects it before the ring.
      slog('input.key', 'press', { keysym: 'Enter' });
      slog('window.layout', 'resize', { w: 80 });
      expect(emitted).toHaveLength(0);
      // Ring also stays empty for non-matching categories.
      expect(bridge.getRing()).toHaveLength(0);
    } finally {
      bridge.dispose();
    }
  });

  test('deactivate stops emit but ring keeps accumulating', () => {
    const { emitted, bridge } = rig();
    try {
      bridge.activate();
      slog('tool.spawn', 'first', { id: 'a' });
      bridge.deactivate();
      slog('tool.spawn', 'second', { id: 'b' });
      slog('tool.spawn', 'third', { id: 'c' });
      expect(emitted).toHaveLength(1);
      expect(bridge.getRing()).toHaveLength(3);
    } finally {
      bridge.dispose();
    }
  });

  test('blockId stable + seq monotonic across multiple emits', () => {
    const { emitted, bridge, blockId } = rig();
    try {
      bridge.activate();
      for (let i = 0; i < 5; i++) {
        slog('agent.status', `e-${i}`, { i });
      }
      expect(emitted).toHaveLength(5);
      expect(emitted.every((e) => e.blockId === blockId)).toBe(true);
      expect(emitted.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    } finally {
      bridge.dispose();
    }
  });
});

describe('createDebugBridge · ring buffer', () => {
  test('cap defaults to 200 and overflows by dropping oldest', () => {
    const { bridge } = rig({ ringBufferCap: 3 });
    try {
      // Gate OFF — ring grows even without emit.
      slog('chat.test', '1', undefined);
      slog('chat.test', '2', undefined);
      slog('chat.test', '3', undefined);
      slog('chat.test', '4', undefined);
      const ring = bridge.getRing();
      expect(ring).toHaveLength(3);
      expect(ring.map((e) => e.event)).toEqual(['2', '3', '4']);
    } finally {
      bridge.dispose();
    }
  });

  test('asciiFallback is always populated when activated', () => {
    const { emitted, bridge } = rig();
    try {
      bridge.activate();
      // Switched from `acp.handshake` to `chat.handshake` —
      // `acp.*` was removed from DEFAULT_DEBUG_CATEGORY_FILTER on
      // 2026-05-14 to break the bridge's own re-entrant feedback
      // loop (`acp.broadcast.fanout` → envelope → broadcast →
      // another `acp.broadcast.fanout` → ...).
      slog('chat.handshake', 'hello', { v: 1 });
      const env = emitted[0]!;
      expect(Array.isArray(env.asciiFallback)).toBe(true);
      expect(env.asciiFallback.length).toBe(1);
      expect(env.asciiFallback[0]).toMatch(/\[chat\.handshake\] hello/);
    } finally {
      bridge.dispose();
    }
  });
});

describe('createDebugBridge · resilience', () => {
  test('emit throw is swallowed — debug.log stream still flows', () => {
    const { emitted, bridge, emitThrows } = rig();
    try {
      bridge.activate();
      emitThrows.value = true;
      // Should not throw despite the wire writer rejecting.
      expect(() => slog('chat.test', 'broken', { ok: 0 })).not.toThrow();
      emitThrows.value = false;
      slog('chat.test', 'healthy', { ok: 1 });
      // First emit was discarded by the wire (and we never push when
      // the throw fires); second emit succeeded.
      expect(emitted).toHaveLength(1);
      expect((emitted[0]! as Extract<FeedbackEnvelope, { kind: 'debug.line' }>).payload.event).toBe('healthy');
    } finally {
      bridge.dispose();
    }
  });

  test('dispose unregisters sink — subsequent debug.log emits 0', () => {
    const { emitted, bridge } = rig();
    bridge.activate();
    slog('chat.test', 'before-dispose', undefined);
    expect(emitted).toHaveLength(1);
    bridge.dispose();
    slog('chat.test', 'after-dispose', undefined);
    expect(emitted).toHaveLength(1);
    // getRing on a disposed bridge returns an empty snapshot.
    expect(bridge.getRing()).toHaveLength(0);
    // isActive reports false once disposed even if activate was
    // previously called.
    expect(bridge.isActive()).toBe(false);
  });

  test('concurrent bridges with different sessionIds stay isolated', () => {
    const a = rig({ sessionId: 's-A' });
    const b = rig({ sessionId: 's-B' });
    try {
      a.bridge.activate();
      b.bridge.activate();
      // H-1 (2026-11-18): one line, produced in s-A's scope, reaches only s-A.
      slog('chat.turn', 'one', { who: 'a-only-line' }, 's-A');
      expect(a.emitted).toHaveLength(1);
      expect(b.emitted).toHaveLength(0);
      expect(a.emitted[0]!.sessionId).toBe('s-A');
      expect(a.emitted[0]!.blockId).toBe(makeDebugSessionBlockId('s-A'));
      expect(JSON.stringify(b.bridge.getRing())).not.toContain('a-only-line');
    } finally {
      a.bridge.dispose();
      b.bridge.dispose();
    }
  });
});

describe('createDebugBridge · default filter', () => {
  test('DEFAULT_DEBUG_CATEGORY_FILTER matches chat/tool/agent (acp excluded · 2026-05-14)', () => {
    expect(DEFAULT_DEBUG_CATEGORY_FILTER.test('chat.picker')).toBe(true);
    expect(DEFAULT_DEBUG_CATEGORY_FILTER.test('tool.spawn')).toBe(true);
    expect(DEFAULT_DEBUG_CATEGORY_FILTER.test('agent.status')).toBe(true);
    // acp.* is INTENTIONALLY rejected — including it creates an
    // infinite feedback loop because the bridge's own envelope emit
    // triggers `acp.broadcast.fanout` debug.log events. Observed at
    // ~46k fanouts/sec on iOS dogfood (saturated WS, aborted LLM
    // turn at 30s). See bridge header comment for the rationale.
    expect(DEFAULT_DEBUG_CATEGORY_FILTER.test('acp.handshake')).toBe(false);
    expect(DEFAULT_DEBUG_CATEGORY_FILTER.test('acp.broadcast.fanout')).toBe(false);
    expect(DEFAULT_DEBUG_CATEGORY_FILTER.test('input.key')).toBe(false);
    expect(DEFAULT_DEBUG_CATEGORY_FILTER.test('window.resize')).toBe(false);
    expect(DEFAULT_DEBUG_CATEGORY_FILTER.test('key.trace.route')).toBe(false);
  });
});
