import { expect, test } from 'bun:test';
import { consumeStreamingTopModalEscape, createEscAbortGate } from '../src/esc-abort-gate.js';

function gateForHarness(identified: boolean) {
  const abortCtrl = new AbortController();
  const pending: number[] = [];
  const mounted: string[] = [];
  const gate = createEscAbortGate({
    abortCtrl,
    getRunningCount: () => 2,
    shouldAbortImmediately: () => identified,
    mountModal: (surface) => { mounted.push(surface.id); return () => {}; },
    getViewport: () => ({ cols: 80, rows: 24 }),
    requestRedraw: () => {},
    onAbortPending: ({ running }) => { pending.push(running); },
  });
  return { gate, abortCtrl, pending, mounted };
}

test('clarification window consumes Escape first, invokes its close notification and leaves the running turn alone', () => {
  const ctx = gateForHarness(true);
  const called: string[] = [];
  const consumed = consumeStreamingTopModalEscape({
    modal: { id: 'clarification' },
    abortGateModalId: null,
    event: { name: 'escape' } as never,
    question: { id: 'clarification', dispose: () => { called.push('closed'); }, isClarification: true },
    onClarificationClosed: () => { called.push('되묻기 창을 닫았다 — 답 없이 진행한다'); },
    topModalId: () => null,
    redraw: () => { called.push('draw'); },
  });
  expect(consumed).toBe(true);
  expect(called).toEqual(['closed', '되묻기 창을 닫았다 — 답 없이 진행한다', 'draw']);
  expect(ctx.abortCtrl.signal.aborted).toBe(false);
  expect(ctx.pending).toEqual([]);
  ctx.gate.dispose();
});

test('one Escape immediately aborts the foreground turn for an identified harness run even with running agents', () => {
  const ctx = gateForHarness(true);
  ctx.gate.handleEscape();
  expect(ctx.abortCtrl.signal.aborted).toBe(true);
  expect(ctx.pending).toEqual([2]);
  expect(ctx.mounted).toEqual([]);
  expect(ctx.gate.isGateOpen()).toBe(false);
  ctx.gate.dispose();
});

test('other turns with running agents still open the existing confirmation dialog', () => {
  const ctx = gateForHarness(false);
  ctx.gate.handleEscape();
  expect(ctx.abortCtrl.signal.aborted).toBe(false);
  expect(ctx.pending).toEqual([]);
  expect(ctx.mounted).toHaveLength(1);
  expect(ctx.gate.isGateOpen()).toBe(true);
  ctx.gate.dispose();
});
