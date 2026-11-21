import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCeoIngress, type CeoClock } from '../agent-events/ceo-ingress.js';
import { createCeoSideAlertWriter, readCeoSideAlert } from './ceo-side-alert.js';

test('synthetic 30-second no-eyes receipt becomes a red side alert, then actual intake clears it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ceo-side-sla-'));
  let now = 0;
  const timers: Array<{ at: number; fire: () => void; cancelled: boolean }> = [];
  const clock: CeoClock = {
    now: () => now,
    after: (ms, fire) => { const timer = { at: now + ms, fire, cancelled: false }; timers.push(timer); return timer; },
    cancel: (handle) => { (handle as typeof timers[number]).cancelled = true; },
  };
  const advance = (ms: number) => { now += ms; for (const timer of timers) if (!timer.cancelled && timer.at <= now) { timer.cancelled = true; timer.fire(); } };
  try {
    const side = createCeoSideAlertWriter(dir);
    const ingress = createCeoIngress({ ws: 'HQ', allowedSenders: ['ceo-1'], clock,
      sessions: () => undefined,
      onStatus: (source, threadId, messageId, receipt) => side.update(source, threadId, messageId, receipt),
    });
    expect(ingress.submit({ source: 'telegram', sender: 'ceo-1', threadId: 'chat-9', messageId: 'm1', text: '대표 글' }).ok).toBe(true);
    expect(readCeoSideAlert(dir)).toEqual({ kind: 'ok', pendingRed: 0 });
    advance(29_999);
    expect(readCeoSideAlert(dir)).toEqual({ kind: 'ok', pendingRed: 0 });
    advance(1);
    expect(readCeoSideAlert(dir)).toEqual({ kind: 'ok', pendingRed: 1 });
    expect(ingress.ackSeen('telegram', 'chat-9', 'm1')).toBe(true);
    expect(readCeoSideAlert(dir)).toEqual({ kind: 'ok', pendingRed: 0 });
    ingress.dispose();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('side alert preserves absence and rejects damaged or linked state instead of treating it as zero', () => {
  const root = mkdtempSync(join(tmpdir(), 'ceo-side-boundary-'));
  const outside = mkdtempSync(join(tmpdir(), 'ceo-side-outside-'));
  try {
    expect(readCeoSideAlert(root)).toEqual({ kind: 'absent' });
    mkdirSync(join(root, 'els'));
    writeFileSync(join(root, 'els', 'ceo-side-alert.json'), '{broken');
    expect(readCeoSideAlert(root)).toEqual({ kind: 'error' });
    writeFileSync(join(root, 'els', 'ceo-side-alert.json'), 'x'.repeat(1025));
    expect(readCeoSideAlert(root)).toEqual({ kind: 'error' });
    rmSync(join(root, 'els', 'ceo-side-alert.json'));
    symlinkSync(join(outside, 'alert.json'), join(root, 'els', 'ceo-side-alert.json'));
    expect(readCeoSideAlert(root)).toEqual({ kind: 'error' });
    rmSync(join(root, 'els'), { recursive: true });
    symlinkSync(outside, join(root, 'els'));
    expect(createCeoSideAlertWriter(root).update('telegram', 'chat', 'm1', 'pending-red')).toBe(false);
    expect(readCeoSideAlert(root)).toEqual({ kind: 'error' });
    expect(readCeoSideAlert(outside)).toEqual({ kind: 'absent' });
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
