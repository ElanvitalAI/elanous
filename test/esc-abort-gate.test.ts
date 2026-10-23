import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createEscAbortGate, routeStreamingEscapeKey } from '../src/esc-abort-gate.js';
import type { ModalSurface } from '../src/display/modal-stack.js';
import { DEFAULT_THEME_TOKENS } from '../src/theme/tokens.js';
import { debug } from '../src/debug/log.js';
import { KeyStreamParser } from '../src/tui.js';

const originalElanousRunId = process.env.ELANOUS_RUN_ID;

beforeAll(() => {
  delete process.env.ELANOUS_RUN_ID;
});

afterAll(() => {
  if (originalElanousRunId === undefined) delete process.env.ELANOUS_RUN_ID;
  else process.env.ELANOUS_RUN_ID = originalElanousRunId;
});

function mk(running: number, targetNames: readonly string[] = []) {
  let currentRunning = running;
  const abortCtrl = new AbortController();
  const pushedSurfaces: ModalSurface[] = [];
  const disposeCalls: number[] = [];
  const redraws: number[] = [];
  const pendingEvents: Array<{ running: number; repeat: number; targets: readonly string[] }> = [];
  const repeatEvents: Array<{ running: number; repeat: number; targets: readonly string[]; phase: 'confirming' | 'pending' }> = [];
  const gate = createEscAbortGate({
    abortCtrl,
    getRunningCount: () => currentRunning,
    mountModal: (s) => {
      pushedSurfaces.push(s);
      const idx = pushedSurfaces.length - 1;
      return () => { disposeCalls.push(idx); };
    },
    getViewport: () => ({ cols: 80, rows: 24 }),
    requestRedraw: () => { redraws.push(Date.now()); },
    getTheme: () => DEFAULT_THEME_TOKENS,
    getWaitingTargetNames: () => targetNames,
    onAbortPending: (event) => { pendingEvents.push(event); },
    onAbortRepeat: (event) => { repeatEvents.push(event); },
  });
  return {
    gate, abortCtrl, pushedSurfaces, disposeCalls, redraws, pendingEvents, repeatEvents,
    setRunning(n: number) { currentRunning = n; },
  };
}

describe('createEscAbortGate', () => {
  test('running=0 aborts immediately without modal and reports a pending wait target', () => {
    const ctx = mk(0, ['Read']);
    ctx.gate.handleEscape();
    expect(ctx.abortCtrl.signal.aborted).toBe(true);
    expect(ctx.pushedSurfaces.length).toBe(0);
    expect(ctx.gate.isGateOpen()).toBe(false);
    expect(ctx.pendingEvents).toEqual([{ running: 0, repeat: 0, targets: ['Read'] }]);
  });

  test('running>0 pops a modal + does NOT abort until answered', () => {
    const ctx = mk(2);
    ctx.gate.handleEscape();
    expect(ctx.abortCtrl.signal.aborted).toBe(false);
    expect(ctx.pushedSurfaces.length).toBe(1);
    expect(ctx.gate.isGateOpen()).toBe(true);
  });

  test('answering yes aborts', async () => {
    const ctx = mk(1);
    ctx.gate.handleEscape();
    ctx.gate.handleKey({ name: 'y' } as never);
    // promise resolution is microtask — flush.
    await new Promise((r) => setImmediate(r));
    expect(ctx.abortCtrl.signal.aborted).toBe(true);
    expect(ctx.gate.isGateOpen()).toBe(false);
  });

  test('answering no keeps the stream alive', async () => {
    const ctx = mk(3);
    ctx.gate.handleEscape();
    ctx.gate.handleKey({ name: 'n' } as never);
    await new Promise((r) => setImmediate(r));
    expect(ctx.abortCtrl.signal.aborted).toBe(false);
    expect(ctx.gate.isGateOpen()).toBe(false);
  });

  // ⛔⭐⭐⭐ 계약 «전환» (2026-08-19 `A2` · 대표 지시). 종전 계약은 「두 번째 Esc = Keep」이었고,
  //   그래서 ***ESC 를 연타하면 턴이 «영원히» 안 죽었다***(라이브 5회 실측).
  //   ⇒ 두 번째 Esc 는 「철회」가 아니라 «의지의 반복»이다. 철회는 `n` 으로 «명시»한다.
  test('⭐ second Escape while gate is open ABORTS (repeat = stronger intent, not withdrawal)', async () => {
    const ctx = mk(2);
    ctx.gate.handleEscape();
    expect(ctx.gate.isGateOpen()).toBe(true);
    ctx.gate.handleEscape();   // second Esc
    await new Promise((r) => setImmediate(r));
    expect(ctx.abortCtrl.signal.aborted).toBe(true);
    expect(ctx.gate.isGateOpen()).toBe(false);
  });

  test('repeated Escape records a distinct waiting event with the target name', async () => {
    const ctx = mk(2, ['Agent', 'Read']);
    ctx.gate.handleEscape();
    ctx.gate.handleEscape();
    await new Promise((r) => setImmediate(r));
    ctx.gate.handleEscape();

    expect(ctx.pendingEvents).toEqual([{ running: 2, repeat: 1, targets: ['Agent', 'Read'] }]);
    expect(ctx.repeatEvents).toEqual([
      { running: 2, repeat: 1, phase: 'confirming', targets: ['Agent', 'Read'] },
      { running: 2, repeat: 2, phase: 'pending', targets: ['Agent', 'Read'] },
    ]);
    expect(ctx.abortCtrl.signal.aborted).toBe(true);
  });

  test('⭐ `n` still withdraws — 철회 경로는 살아 있다', async () => {
    const ctx = mk(2);
    ctx.gate.handleEscape();
    ctx.gate.handleKey({ name: 'n' } as never);
    await new Promise((r) => setImmediate(r));
    expect(ctx.abortCtrl.signal.aborted).toBe(false);
    expect(ctx.gate.isGateOpen()).toBe(false);
  });

  test('`n` withdrawal resets repeat state so the next Escape is a fresh request', async () => {
    const ctx = mk(2, ['Agent']);
    ctx.gate.handleEscape();
    ctx.gate.handleKey({ name: 'n' } as never);
    await new Promise((r) => setImmediate(r));

    ctx.gate.handleEscape();
    ctx.gate.handleEscape();
    await new Promise((r) => setImmediate(r));

    expect(ctx.pendingEvents).toEqual([{ running: 2, repeat: 1, targets: ['Agent'] }]);
    expect(ctx.repeatEvents).toEqual([{ running: 2, repeat: 1, phase: 'confirming', targets: ['Agent'] }]);
    expect(ctx.abortCtrl.signal.aborted).toBe(true);
  });

  test('resetAbortRequestState makes the next Escape a fresh abort request after completion cleanup', () => {
    const ctx = mk(0, ['Read']);
    ctx.gate.handleEscape();
    ctx.gate.handleEscape();

    ctx.gate.resetAbortRequestState();
    ctx.gate.handleEscape();

    expect(ctx.pendingEvents).toEqual([
      { running: 0, repeat: 0, targets: ['Read'] },
      { running: 0, repeat: 0, targets: ['Read'] },
    ]);
    expect(ctx.repeatEvents).toEqual([{ running: 0, repeat: 1, phase: 'pending', targets: ['Read'] }]);
  });

  test('⭐ Escape routed through handleKey also aborts (공용 모달의 escape→no 를 가로챈다)', async () => {
    const ctx = mk(2);
    ctx.gate.handleEscape();
    ctx.gate.handleKey({ name: 'escape' } as never);
    await new Promise((r) => setImmediate(r));
    expect(ctx.abortCtrl.signal.aborted).toBe(true);
  });

  test('modal is disposed exactly once on resolve', async () => {
    const ctx = mk(1);
    ctx.gate.handleEscape();
    ctx.gate.handleKey({ name: 'y' } as never);
    await new Promise((r) => setImmediate(r));
    expect(ctx.disposeCalls).toEqual([0]);
  });

  test('requestRedraw fires on open and on close', async () => {
    const ctx = mk(1);
    ctx.gate.handleEscape();
    ctx.gate.handleKey({ name: 'n' } as never);
    await new Promise((r) => setImmediate(r));
    // At least: once on open, once on close. requestRedraw may
    // fire more than twice if the impl adds extra paints — accept
    // >= 2 to stay non-brittle.
    expect(ctx.redraws.length).toBeGreaterThanOrEqual(2);
  });

  test('handleKey returns false when no gate is open', () => {
    const ctx = mk(5);
    expect(ctx.gate.handleKey({ name: 'y' } as never)).toBe(false);
  });

  test('handleKey returns true while gate is open', () => {
    const ctx = mk(5);
    ctx.gate.handleEscape();
    expect(ctx.gate.handleKey({ name: 'x' } as never)).toBe(true);
  });

  test('prompt pluralizes 1 vs many', () => {
    const ctx1 = mk(1);
    ctx1.gate.handleEscape();
    const paint1 = ctx1.pushedSurfaces[0]!.paint();
    expect(paint1).toContain('1 sub-agent');
    expect(paint1).not.toContain('1 sub-agents');

    const ctx2 = mk(4);
    ctx2.gate.handleEscape();
    const paint2 = ctx2.pushedSurfaces[0]!.paint();
    expect(paint2).toContain('4 sub-agents');
  });

  test('themed abort gate modal paints static chrome close glyph', () => {
    const ctx = mk(2);
    ctx.gate.handleEscape();
    const painted = ctx.pushedSurfaces[0]!.paint();
    expect(painted).toContain('✕');
  });

  test('dispose() closes without aborting', () => {
    const ctx = mk(2);
    ctx.gate.handleEscape();
    ctx.gate.dispose();
    expect(ctx.gate.isGateOpen()).toBe(false);
    expect(ctx.abortCtrl.signal.aborted).toBe(false);
  });

  test('routes an open modal key before drag interception or a new abort decision', async () => {
    const calls: string[] = [];
    const gate = {
      isGateOpen: () => true,
      handleKey: () => { calls.push('handleKey'); return true; },
      handleEscape: () => { calls.push('handleEscape'); },
    };
    const consumed = await routeStreamingEscapeKey(
      { name: 'escape' }, gate, { name: 'escape' } as never,
      async () => { calls.push('drag'); return false; },
    );
    expect(consumed).toBe(true);
    expect(calls).toEqual(['handleKey']);
  });

  test('ignores a released Escape while the abort gate is closed', async () => {
    const calls: string[] = [];
    const gate = {
      isGateOpen: () => false,
      handleKey: () => { calls.push('handleKey'); return true; },
      handleEscape: () => { calls.push('handleEscape'); },
    };
    const press = await routeStreamingEscapeKey(
      { name: 'escape' }, gate, { name: 'escape' } as never,
      async () => { calls.push('drag'); return false; },
    );
    const release = await routeStreamingEscapeKey(
      { name: 'escape', kind: 'release' }, gate, { name: 'escape' } as never,
      async () => { calls.push('drag'); return false; },
    );
    expect(press).toBe(true);
    expect(release).toBe(false);
    expect(calls).toEqual(['drag', 'handleEscape']);
  });

  test('ignores a released Escape while the abort gate is open', async () => {
    const calls: string[] = [];
    const gate = {
      isGateOpen: () => true,
      handleKey: () => { calls.push('handleKey'); return true; },
      handleEscape: () => { calls.push('handleEscape'); },
    };
    const press = await routeStreamingEscapeKey(
      { name: 'escape' }, gate, { name: 'escape' } as never,
      async () => { calls.push('drag'); return false; },
    );
    const release = await routeStreamingEscapeKey(
      { name: 'escape', kind: 'release' }, gate, { name: 'escape' } as never,
      async () => { calls.push('drag'); return false; },
    );
    expect(press).toBe(true);
    expect(release).toBe(false);
    expect(calls).toEqual(['handleKey']);
  });

  test('routes one abort from real kitty press-plus-release parser output', async () => {
    const calls: string[] = [];
    const gate = {
      isGateOpen: () => false,
      handleKey: () => { calls.push('handleKey'); return true; },
      handleEscape: () => { calls.push('handleEscape'); },
    };
    const escape = String.fromCharCode(27);
    for (const key of new KeyStreamParser().push(`${escape}[27;1:1u${escape}[27;1:3u`)) {
      await routeStreamingEscapeKey(key, gate, key as never, async () => false);
    }
    expect(calls).toEqual(['handleEscape']);
  });

  test('consumes drag Escape before it can reach the abort gate', async () => {
    const calls: string[] = [];
    const gate = {
      isGateOpen: () => false,
      handleKey: () => { calls.push('handleKey'); return true; },
      handleEscape: () => { calls.push('handleEscape'); },
    };
    const consumed = await routeStreamingEscapeKey(
      { name: 'escape' }, gate, { name: 'escape' } as never,
      async () => { calls.push('drag'); return true; },
    );
    expect(consumed).toBe(true);
    expect(calls).toEqual(['drag']);
  });

  test('routes a non-drag streaming Escape to the existing abort gate', async () => {
    const calls: string[] = [];
    const gate = {
      isGateOpen: () => false,
      handleKey: () => { calls.push('handleKey'); return true; },
      handleEscape: () => { calls.push('handleEscape'); },
    };
    const consumed = await routeStreamingEscapeKey(
      { name: 'escape' }, gate, { name: 'escape' } as never,
      async () => { calls.push('drag'); return false; },
    );
    expect(consumed).toBe(true);
    expect(calls).toEqual(['drag', 'handleEscape']);
  });

  test('leaves a non-Escape streaming key for the ordinary key ladder', async () => {
    const calls: string[] = [];
    const gate = {
      isGateOpen: () => false,
      handleKey: () => { calls.push('handleKey'); return true; },
      handleEscape: () => { calls.push('handleEscape'); },
    };
    const consumed = await routeStreamingEscapeKey(
      { name: 'j' }, gate, { name: 'j' } as never,
      async () => { calls.push('drag'); return false; },
    );
    expect(consumed).toBe(false);
    expect(calls).toEqual([]);
  });

  test('records a distinct esc.abort decision for every Escape branch', async () => {
    // ⛔ 전역 버퍼 길이로 자르면 버퍼 포화·병렬 기록에 취약하다(무인 리뷰 should-fix).
    //    이 카테고리만 세어 **개수 차이**로 격리한다.
    const escBefore = debug.events(10_000).filter((e) => e.category === 'esc.abort').length;
    const immediate = mk(0);
    immediate.gate.handleEscape();

    const confirmation = mk(1);
    confirmation.gate.handleEscape();
    confirmation.gate.handleEscape();
    await new Promise((resolve) => setImmediate(resolve));

    const events = debug.events(10_000)
      .filter((event) => event.category === 'esc.abort')
      .slice(escBefore);
    expect(events.map((event) => event.event)).toEqual([
      'abort-immediately',
      'abort-requested-pending',
      'open-confirmation',
      'confirm-by-repeat',
      'abort-repeat-waiting',
      'abort-requested-pending',
    ]);
    expect(new Set(events.map((event) => event.event)).size).toBe(5);
    // 관측 enrich(src/debug/log.ts — ELANOUS_SUBSTRATE/ARM_ID/HOST_ID 환경이 data에
    // substrate/armId/hostId 를 덧붙인다)는 의사결정 표면이 아니므로 비교에서 제외한다.
    // 제외 없이 toEqual 로 묶으면 pod 환경에서만 빨개지는 취약 단정이 된다.
    const decisions = events.map((event) => {
      const data: Record<string, unknown> = { ...(event.data as Record<string, unknown>) };
      delete data.substrate;
      delete data.armId;
      delete data.hostId;
      return data;
    });
    expect(decisions[0]).toEqual({ running: 0, repeat: 0 });
    expect(decisions[1]).toEqual({ running: 0, repeat: 0, targets: [] });
    expect(decisions[2]).toEqual({ running: 1 });
    expect(decisions[3]).toEqual({ decision: 'abort', repeat: 1 });
    expect(decisions[4]).toEqual({ running: 1, repeat: 1, phase: 'confirming', targets: [] });
    expect(decisions[5]).toEqual({ running: 1, repeat: 1, targets: [] });
  });
});
