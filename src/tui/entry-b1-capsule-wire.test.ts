import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createIdleWakeDoor } from './idle-wake-door.js';

/** [턴 근본 배선 #4a] B1 (CC-1 #89704): capsule-done → one queued notice → the idle door (stage B1 only). */
describe('entry wires the B1 capsule-done doorbell', () => {
  const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');

  test('the door refuses an unregistered source, so entry registers capsule-done', () => {
    const logs: string[] = [];
    const door = createIdleWakeDoor({ busy: () => false, injectKey: () => true, queueWake: {}, log: (event) => { logs.push(event); } });
    expect(door.knock('capsule-done')).toBe(false);
    expect(logs).toEqual(['wake-knock-unregistered']);
    expect(entry.includes("idleWakeDoor.register({ id: 'capsule-done' });")).toBe(true);
  });

  test('observeSession subscribes per session (always on) and every session change stops the old subscription', () => {
    const observe = entry.slice(entry.indexOf('const observeSession = ('), entry.indexOf('observedSessionId = sessionId;'));
    expect(observe.includes('capsuleSubscription.stop?.();')).toBe(true);
    expect(observe.includes('sessionId, subscribe: chat.onLocalChatCapsuleEvent,')).toBe(true);
    expect(observe.includes('stageOn')).toBe(false);
    expect(observe.includes("knock: () => { idleWakeDoor.knock('capsule-done'); }")).toBe(true);
    // observeSession · session switch ×2 · the TUI close — four stops. 출처: #38649 (CC-1 02fd5459 hunk)
    expect(entry.split('capsuleSubscription.stop?.();').length - 1).toBe(4);
  });
});
