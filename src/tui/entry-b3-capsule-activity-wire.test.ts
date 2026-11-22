import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CapsuleActivity } from './chat/capsule-activity.js';

/** [턴 근본 배선 #5] B3 (CX-1 #89710/#90532): folded capsule progress in the footer, stage B3 only. */
describe('entry wires the B3 folded capsule activity', () => {
  const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');

  test('one subscription per observed session (always on), beside the B1 doorbell, and every stop path stops it', () => {
    const observe = entry.slice(entry.indexOf('const observeSession = ('), entry.indexOf('observedSessionId = sessionId;'));
    // main guard system: the async wiring bails out early when the session moved on
    // or a doorbell subscription is already wired (entry.ts L1037 — no wrapper block).
    expect(observe.includes('if (observedSessionId !== sessionId || capsuleSubscription.stop) return;')).toBe(true);
    expect(observe.includes('capsuleStageOn')).toBe(false);
    expect(observe.includes('capsuleActivity.setSessionId(sessionId);')).toBe(true);
    // the B1 doorbell keeps its own subscriptions in the same .then block, now 3 stops
    // (done-knock / shell-watch / migration-wait — entry.ts L1049/L1055).
    expect(observe.includes('knock.wireCapsuleDoneKnock({')).toBe(true);
    expect(observe.includes('watch.wireShellWatchKnock({')).toBe(true);
    expect(observe.includes('const stopMigrationWait = chat.onLocalChatCapsuleEvent(sessionId, (event) => {')).toBe(true);
    expect(observe.includes('capsuleSubscription.stop = () => { stopDone(); stopWatch(); stopMigrationWait(); };')).toBe(true);
    // B3 wiring: assigned directly after the B1 subscriptions (cleanup order untouched),
    // with the promoted per-event guard (entry.ts L1060/L1061).
    expect(observe.includes('capsuleActivitySubscription.stop = chat.onLocalChatCapsuleEvent(sessionId, (event) => {')).toBe(true);
    expect(observe.includes('if (tuiClosed || observedSessionId !== sessionId || id !== sessionId) return;')).toBe(true);
    expect(observe.indexOf('capsuleSubscription.stop = () => {')).toBeLessThan(observe.indexOf('capsuleActivitySubscription.stop = chat.onLocalChatCapsuleEvent'));
    expect(entry.includes("import { CapsuleActivity } from './chat/capsule-activity.js';")).toBe(true);
    // observeSession · two session switches · TUI close. 출처: #89710 (CX-1 handoff: unsubscribe on switch and close)
    expect(entry.split('capsuleActivitySubscription.stop?.();').length - 1).toBe(4);
  });

  test('the folded rows are counted in the footer and drawn above the background line', () => {
    expect(entry.includes('const statusRowCount = 1 + capsuleLines.length + (backgroundLine ? 1 : 0) + (staleInstallLine ? 1 : 0);')).toBe(true);
    const drawAt = entry.indexOf('...capsuleLines.map((line) => fitLogLine(line, chatColumns)),');
    expect(drawAt).not.toBe(-1);
    expect(entry.indexOf('...(backgroundLine ? [fitLogLine(backgroundLine, chatColumns)] : []),')).toBeGreaterThan(drawAt);
  });

  test('a session switch clears the other session’s rows (the projection entry relies on)', () => {
    const activity = new CapsuleActivity('s1');
    activity.accept({ type: 'capsule-progress', capsuleId: 'c1', kind: 'agent', sessionId: 's1', at: 1, line: 'review · started' });
    expect(activity.lines()).toEqual(['🤖 review · started']);
    activity.setSessionId('s2');
    expect(activity.lines()).toEqual([]);
  });
});
