/**
 * SIM — WAKE-PRIORITY (CEO 11-26 22:2x). Today's shape, OP TUI 22:01–22:19 KST: the autopilot's goal-continue turns opened
 * every 2–5 min (requirements open · «plan not updated» · a pledge «22:34에 확인»), each 1–4 min long; the retro wake and
 * the resource-optimize wake came due at 22:15, were refused NotIdle while a turn ran, then `Cap · pacing:min-interval`
 * right after it → «Retro missed (Cap)» · «Resource optimize missed (Cap)». Seeds 1–5 vary turn lengths and attempt
 * cadence. The producers here follow the real retry rules (retry 60 s on NotIdle/HumanTyping, give up on anything else or
 * past their window). Expect: none missed; goal-continue yields while a wake waits; goal-continue still runs afterwards.
 */
import { describe, expect, test } from 'bun:test';
import { createInternalTurnGate, DEFAULT_PACING_MAX_CONSECUTIVE, DEFAULT_PACING_MIN_INTERVAL_MS } from './internal-turn.js';
import type { InternalTurnOrigin } from '../../chat/internal-turn-origin.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const T0 = Date.parse('2026-11-26T13:01:00.000Z'); // 22:01 KST
const DUE = Date.parse('2026-11-26T13:15:00.000Z'); // 22:15 KST

interface Wake { origin: InternalTurnOrigin; name: string; nextTry: number; windowMs: number; opened: number | null; missed: string | null }

function simulate(seed: number) {
  const r = rng(seed);
  let clock = T0; let running = null as { until: number; origin: InternalTurnOrigin } | null; // cast: assigned inside closures (tsc narrows a plain null)
  const events: string[] = [];
  const gate = createInternalTurnGate({ isEnabled: () => true, isTurnRunning: () => running !== null, getBufferText: () => '', getTypeaheadCount: () => 0,
    pendingKeyCount: () => 0, lastHumanKeyAt: () => 0, now: () => clock, log: (_c, e, d) => { if (e === 'rejected' && (d as { detail?: string }).detail === 'pacing:yield-scheduled') events.push('yield'); },
    pacing: { minIntervalMs: DEFAULT_PACING_MIN_INTERVAL_MS, maxConsecutive: DEFAULT_PACING_MAX_CONSECUTIVE } });
  gate.port.attach(() => true);
  const open = (origin: InternalTurnOrigin, ms: number): boolean => {
    const res = gate.startTurnIfIdle(`${origin} turn`, { origin, ownLimit: origin === 'goal-continue' });
    if (!res.opened) return false;
    gate.takePending(); gate.noteTurnStarted();
    running = { until: clock + ms, origin }; events.push(`${new Date(clock).toISOString().slice(11, 19)} open ${origin}`);
    return true;
  };
  // retro (origin retro · 30-min window) and resource optimize (origin scheduled · 20-min window), both due 22:15.
  const wakes: Wake[] = [{ origin: 'retro', name: 'retro', nextTry: DUE, windowMs: 30 * 60_000, opened: null, missed: null },
    { origin: 'scheduled', name: 'resource', nextTry: DUE + 2_000, windowMs: 20 * 60_000, opened: null, missed: null }];
  let gcNext = T0; let gcOpened = 0; let gcAfterDue = 0;
  for (; clock < DUE + 25 * 60_000; clock += 1_000) {
    if (running && clock >= running.until) { running = null; gate.noteTurnSettled(); }
    for (const w of wakes) {
      if (w.opened !== null || w.missed !== null || clock < w.nextTry) continue;
      const res = gate.startTurnIfIdle(`${w.name}`, { origin: w.origin });
      if (res.opened) { gate.takePending(); gate.noteTurnStarted(); running = { until: clock + 60_000, origin: w.origin }; w.opened = clock; events.push(`${new Date(clock).toISOString().slice(11, 19)} open ${w.name}`); continue; }
      if ((res.reason === 'NotIdle' || res.reason === 'HumanTyping') && clock + 60_000 <= DUE + w.windowMs) { w.nextTry = clock + 60_000; continue; }
      w.missed = `${res.reason}${res.detail ? ` ${res.detail}` : ''}`;
    }
    if (clock >= gcNext && !running) {
      const len = (60 + Math.floor(r() * 180)) * 1_000; // 1–4 min turns
      if (open('goal-continue', len)) { gcOpened++; if (clock > DUE) gcAfterDue++; gcNext = clock + len + (60 + Math.floor(r() * 120)) * 1_000; }
      else gcNext = clock + 10_000;
    }
  }
  return { wakes, gcOpened, gcAfterDue, events };
}

describe('SIM wake priority — 22:01–22:19 shape, seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: retro and resource optimize both open (none missed); goal-continue yields, then resumes`, () => {
      const { wakes, gcOpened, gcAfterDue, events } = simulate(seed);
      for (const w of wakes) {
        expect({ name: w.name, missed: w.missed }).toEqual({ name: w.name, missed: null });
        expect(w.opened).not.toBe(null);
        // 출처: a goal-continue turn is ≤ 4 min here; the wake opens after at most that turn, its own 60 s retry and the other wake's 60 s turn.
        expect(w.opened! - DUE <= 7 * 60_000).toBe(true);
      }
      expect(gcOpened >= 3).toBe(true); // 출처: 22:01–22:15 had goal-continue every 2–5 min — the autopilot still drives
      expect(gcAfterDue >= 1).toBe(true); // and it resumes once the wakes ran
      expect(events.indexOf(events.find(e => e.endsWith('open retro'))!) >= 0).toBe(true);
    });
  }
  test('goal-continue yields only while a scheduled wake waits; a claim older than 30 min stops counting', () => {
    let clock = T0; let busy = true;
    const gate = createInternalTurnGate({ isEnabled: () => true, isTurnRunning: () => busy, getBufferText: () => '', getTypeaheadCount: () => 0, pendingKeyCount: () => 0,
      lastHumanKeyAt: () => 0, now: () => clock, log: () => {}, pacing: { minIntervalMs: 45_000, maxConsecutive: 5 } });
    gate.port.attach(() => true);
    expect(gate.startTurnIfIdle('retro', { origin: 'retro' })).toMatchObject({ opened: false, reason: 'NotIdle' }); // the wake waits
    busy = false;
    expect(gate.startTurnIfIdle('gc', { origin: 'goal-continue' })).toMatchObject({ opened: false, reason: 'Cap', detail: 'pacing:yield-scheduled', retryAt: T0 + 60_000 });
    clock += 31 * 60_000;
    expect(gate.startTurnIfIdle('gc', { origin: 'goal-continue' })).toMatchObject({ opened: true });
  });
  test('a scheduled wake right after an automatic turn is not paced (no min-interval) — goal-continue still is', () => {
    let clock = T0;
    const gate = createInternalTurnGate({ isEnabled: () => true, isTurnRunning: () => false, getBufferText: () => '', getTypeaheadCount: () => 0, pendingKeyCount: () => 0,
      lastHumanKeyAt: () => 0, now: () => clock, log: () => {}, pacing: { minIntervalMs: 45_000, maxConsecutive: 5 } });
    gate.port.attach(() => true);
    expect(gate.startTurnIfIdle('gc', { origin: 'goal-continue' })).toMatchObject({ opened: true });
    gate.takePending(); gate.noteTurnStarted(); clock += 5_000; gate.noteTurnSettled();
    expect(gate.startTurnIfIdle('gc', { origin: 'goal-continue' })).toMatchObject({ opened: false, reason: 'Cap', detail: 'pacing:min-interval' });
    expect(gate.startTurnIfIdle('retro', { origin: 'retro' })).toMatchObject({ opened: true });
  });
});
