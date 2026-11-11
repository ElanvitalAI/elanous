import { describe, expect, test } from 'bun:test';
import { extractBrowserActStep } from './browser-act-step.js';
import { browserActionRowsToTrajectory } from './browser-trajectory.js';
import { readTrajectory } from './browser-act-trajectory.js';

const row = (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  category: 'harness.browser-action', event: 'executed', ts: '2026-08-28T00:00:00.000Z',
  data: JSON.stringify(data), ...extra,
});

describe('browser act step extraction', () => {
  test('both trajectory consumers interpret one encoded action and keep their own discard policy', () => {
    // Source: browser-act-step.ts BrowserActStep.coordinates; browser-trajectory.ts discards null coordinates.
    const action = row({ runId: 'run-a', url: 'https://example.test', target: '#save', coordinates: { x: 7, y: 9 } });
    const failed = row({ runId: 'run-a', url: 'https://example.test', target: '#cancel', ok: false, coordinates: null });
    const replay = browserActionRowsToTrajectory([action, failed], 'run-a');
    const history = readTrajectory([action, failed].map((entry) => JSON.stringify(entry)).join('\n'));
    expect(replay.trajectory).toEqual([{ target: '#save', coordinates: { x: 7, y: 9 } }]);
    expect(replay.discarded.invalidRow).toBe(1); // Source: browser-trajectory.ts counts present-but-null coordinates as invalidRow.
    expect(history.steps.map((step) => ({ target: step.target, coordinates: step.coordinates, ok: step.ok })))
      .toEqual([{ target: '#save', coordinates: { x: 7, y: 9 }, ok: true }, { target: '#cancel', coordinates: null, ok: false }]);
  });

  test('parses the doubly-encoded data field — the row carries data as a string', () => {
    // ⛔ 이 저장소가 2026-08-27 에 «세 트랙»이 밟은 자리.
    const r = extractBrowserActStep(row({ target: '#a', url: 'https://x', coordinates: { x: 1, y: 2 }, personaId: 'p', runId: 'r' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toMatchObject({ target: '#a', url: 'https://x', coordinates: { x: 1, y: 2 }, personaId: 'p', runId: 'r' });
  });

  test('separates "no coordinates key" from "coordinates present but unreadable"', () => {
    // ⛔ 앞엣것은 「그 조작에 좌표가 없다」(실패했다)이고, 뒤엣것은 «자료가 깨진» 것이다.
    const absent = extractBrowserActStep(row({ target: '#a' }));
    const broken = extractBrowserActStep(row({ target: '#a', coordinates: { x: 'nope', y: 2 } }));
    expect(absent.ok && absent.step.coordinatesPresent).toBe(false);
    expect(broken.ok && broken.step.coordinatesPresent).toBe(true);
    expect(absent.ok && absent.step.coordinates).toBeNull();
    expect(broken.ok && broken.step.coordinates).toBeNull();
  });

  test('reports why it could not extract, instead of returning a hollow step', () => {
    expect(extractBrowserActStep({ category: 'other', event: 'executed', data: '{}' })).toEqual({ ok: false, reason: 'unrelated-event' });
    expect(extractBrowserActStep(row({ target: '#a' }, { event: 'started' }))).toEqual({ ok: false, reason: 'unrelated-event' });
    expect(extractBrowserActStep({ category: 'harness.browser-action', event: 'executed', data: 'not json' })).toEqual({ ok: false, reason: 'invalid-row' });
    expect(extractBrowserActStep(row({ url: 'https://x' }))).toEqual({ ok: false, reason: 'missing-target' });
  });

  test('treats a failed action as a step, not as garbage', () => {
    // ⛔ 거부도 「무엇을 하려 했나」의 기록이다 — 버리는 것은 «부르는 쪽»이 정한다.
    const r = extractBrowserActStep(row({ target: '#a', url: 'https://x', ok: false, failureReason: 'unarmed', coordinates: null }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.step).toMatchObject({ ok: false, failureReason: 'unarmed', coordinates: null });
  });

  test('a row with no ok field is a success — the field only appears on failures', () => {
    const r = extractBrowserActStep(row({ target: '#a', url: 'https://x' }));
    expect(r.ok && r.step.ok).toBe(true);
  });

  test('accepts both category spellings, because the store and the query disagree', () => {
    // 📏 관측은 'harness.browser-action' 으로 나가고 조회는 'harness.browser-act' 로 하는 판이 있다.
    for (const category of ['harness.browser-action', 'harness.browser-act']) {
      const r = extractBrowserActStep({ category, event: 'executed', data: JSON.stringify({ target: '#a' }) });
      expect(r.ok).toBe(true);
    }
  });
});
