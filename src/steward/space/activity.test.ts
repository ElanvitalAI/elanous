// Seat activity clock — the session's last model row, not els `status.since`. Expected values are literals.
import { describe, expect, test } from 'bun:test';
import { activityFromClock, lastModelActivityMs, sessionIdOfCommand } from './activity.js';
import { parsePanes } from './sources.js';

const NOW = Date.parse('2026-11-25T07:40:00.000Z');
const SESSION = [
  { role: 'user', ts: '2026-11-25T06:55:00.000Z', content: 'task' },
  { role: 'tool', ts: '2026-11-25T06:58:00.000Z', content: 'Bash' },
  { role: 'assistant', ts: '2026-11-25T07:00:00.000Z', content: 'done' },
  // Mail landing in the session: a notice row, no model row after it.
  { role: 'user', ts: '2026-11-25T07:39:40.000Z', content: '[notice · seat-mail · 1 msg]' },
].map((r) => JSON.stringify(r)).join('\n');

describe('activity clock', () => {
  test('session id from the pane foreground command', () => {
    expect(sessionIdOfCommand(['/bin/bun', 'elanous.mjs', '--resume', '1da3542d-60f5-4f01-b25b-dfe0280cd2de'])).toBe('1da3542d-60f5-4f01-b25b-dfe0280cd2de');
    expect(sessionIdOfCommand(['eln', '--resume=abcdef12-3456'])).toBe('abcdef12-3456');
    expect(sessionIdOfCommand(['codex', '-p', 'seat'])).toBeNull();
    expect(sessionIdOfCommand('eln --resume x')).toBeNull();
  });

  test('last model row = assistant or tool; a mail notice row is not activity; as-of cut', () => {
    expect(lastModelActivityMs(SESSION)).toBe(Date.parse('2026-11-25T07:00:00.000Z'));
    expect(lastModelActivityMs(SESSION, Date.parse('2026-11-25T06:59:00.000Z'))).toBe(Date.parse('2026-11-25T06:58:00.000Z'));
    expect(lastModelActivityMs('{"role":"user","ts":"2026-11-25T07:00:00.000Z"}\nnot json')).toBeNull();
  });

  test('pane flips working↔idle on mail arrival without a turn → still idle (since the last model row)', () => {
    // els: WORKING for 20 s (the notice redrew the screen) — the model wrote nothing for 40 min.
    const flip = activityFromClock({ els: 'working', elsWorkingSinceMs: NOW - 20_000, modelAtMs: NOW - 40 * 60_000 }, NOW);
    expect(flip).toEqual({ activity: 'idle', idleForMs: 2_400_000, lastActiveMs: NOW - 2_400_000 });
    // els: IDLE for 30 s right after the flip — still 40 min by the model clock (els `since` would say 30 s).
    expect(activityFromClock({ els: 'idle', elsWorkingSinceMs: null, modelAtMs: NOW - 40 * 60_000 }, NOW)?.idleForMs).toBe(2_400_000);
    // A long tool call: els WORKING without a break for 5 min, no row yet → working.
    expect(activityFromClock({ els: 'working', elsWorkingSinceMs: NOW - 5 * 60_000, modelAtMs: NOW - 12 * 60_000 }, NOW)?.activity).toBe('working');
    // A model row 20 s ago → working. No session clock → null (els decides as before).
    expect(activityFromClock({ els: 'idle', elsWorkingSinceMs: null, modelAtMs: NOW - 20_000 }, NOW)?.activity).toBe('working');
    expect(activityFromClock({ els: 'idle', elsWorkingSinceMs: null, modelAtMs: undefined }, NOW)).toBeNull();
  });

  test('parsePanes: the session clock wins over els status.since; a pane without a session keeps the els clock', () => {
    const body = { panes: [
      { seat: 'TC-H-CX-6', activityState: 'working', status: { state: 'WORKING', since: NOW - 15_000 }, fgCommand: ['eln', '--resume', 'sess-cx6-0001'] },
      { seat: 'TC-H-CX-3', activityState: 'idle', status: { state: 'IDLE', since: NOW - 9_000 }, fgCommand: ['eln', '--resume', 'sess-cx3-0001'] },
      { seat: 'TC-H-CC-1', activityState: 'idle', status: { state: 'IDLE', since: NOW - 11 * 60_000 }, fgCommand: ['claude'] },
    ] };
    const model: Record<string, number> = { 'sess-cx6-0001': NOW - 52 * 60_000, 'sess-cx3-0001': NOW - 30_000 };
    expect(parsePanes(body, NOW, (id) => model[id] ?? null)).toEqual([
      { seat: 'TC-H-CX-6', activity: 'idle', idleForMs: 3_120_000, lastActiveMs: NOW - 3_120_000 },
      { seat: 'TC-H-CX-3', activity: 'working', idleForMs: null, lastActiveMs: NOW - 30_000 },
      { seat: 'TC-H-CC-1', activity: 'idle', idleForMs: 660_000 },
    ]);
  });
});
