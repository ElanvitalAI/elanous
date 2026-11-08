import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimNexusFunnelFirstSuccess,
  createNexusFunnelRuntime,
  NEXUS_FUNNEL_CATEGORY,
  NEXUS_FUNNEL_EVENT_TYPES,
  NEXUS_FUNNEL_PAID_CONVERSION_WINDOW_DAYS,
  observeNexusFunnelEvent,
  tryCreateNexusFunnelRuntime,
  type NexusFunnelEvent,
} from './funnel-observe.js';

const ACCOUNT = 'a'.repeat(64);
const APP = 'b'.repeat(64);
const NOW = new Date('2026-11-04T12:00:00.000Z');
const LIMIT_REACHED_AT = '2026-10-05T12:00:00.000Z';

type Captured = { category: string; event: string; data: Readonly<Record<string, unknown>> };

function recorder(now = NOW) {
  const events: Captured[] = [];
  const observe = (event: NexusFunnelEvent) => observeNexusFunnelEvent(event, {
    now: () => now,
    log: (category, name, data) => events.push({ category, event: name, data }),
  });
  return { events, observe };
}

describe('Nexus funnel observation API', () => {
  test('claims first-success once per app across runtime instances and process restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-funnel-first-success-'));
    try {
      const claim = (appHash: string) => claimNexusFunnelFirstSuccess(directory, appHash);
      const firstRuntime = createNexusFunnelRuntime('installation-id', undefined, claim);
      const restartedRuntime = createNexusFunnelRuntime('installation-id', undefined, claim);
      const replacementInstallation = createNexusFunnelRuntime('replacement-installation-id', undefined, claim);

      expect(firstRuntime.recordFirstSuccess('voice-note')).toBe(true);
      expect(firstRuntime.recordFirstSuccess('voice-note')).toBe(false);
      expect(firstRuntime.recordFirstSuccess('other-app')).toBe(true);
      expect(restartedRuntime.recordFirstSuccess('voice-note')).toBe(false);
      expect(restartedRuntime.recordFirstSuccess('other-app')).toBe(false);
      expect(replacementInstallation.recordFirstSuccess('voice-note')).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('keeps first-success persistence errors fail-soft and deduplicated in memory', () => {
    const runtime = createNexusFunnelRuntime('installation-id', undefined, () => { throw new Error('disk unavailable'); });
    expect(runtime.recordFirstSuccess('voice-note')).toBe(false);
    expect(runtime.recordFirstSuccess('voice-note')).toBe(false);
  });

  test('disables funnel analytics instead of throwing when installation identity storage fails', () => {
    expect(tryCreateNexusFunnelRuntime(() => { throw new Error('identity store unavailable'); })).toBeUndefined();
  });

  test('emits each funnel signal to the queryable category with only hashed identities', () => {
    const { events, observe } = recorder();
    const input: NexusFunnelEvent[] = [
      { type: 'signup', accountHash: ACCOUNT, inviteSource: 'invite' },
      { type: 'first-success', accountHash: ACCOUNT, appHash: APP },
      { type: 'app-open', accountHash: ACCOUNT, appHash: APP },
      { type: 'limit-reached', accountHash: ACCOUNT, appHash: APP },
      { type: 'paid-convert', accountHash: ACCOUNT, limitReachedAt: LIMIT_REACHED_AT },
      { type: 'invite-sent', accountHash: ACCOUNT },
    ];

    for (const event of input) expect(observe(event)).toBe(true);

    expect(events.map(({ category, event }) => [category, event])).toEqual(
      input.map(({ type }) => [NEXUS_FUNNEL_CATEGORY, type]),
    );
    expect(events.every(({ data }) => data.accountHash === ACCOUNT && data.weekStartKst === '2026-11-02T00:00:00+09:00')).toBe(true);
    expect(events[0]?.data).toEqual({ accountHash: ACCOUNT, weekStartKst: '2026-11-02T00:00:00+09:00', inviteSource: 'invite' });
    expect(events[4]?.data.conversionWindowDays).toBe(NEXUS_FUNNEL_PAID_CONVERSION_WINDOW_DAYS);
    expect(JSON.stringify(events)).not.toMatch(/@|email|userId|inviteCode/iu);
  });

  test('uses Monday 00:00 KST as the weekly bucket across the boundary', () => {
    const beforeMonday = recorder(new Date('2026-11-01T14:59:59.999Z'));
    const atMonday = recorder(new Date('2026-11-01T15:00:00.000Z'));

    beforeMonday.observe({ type: 'app-open', accountHash: ACCOUNT, appHash: APP });
    atMonday.observe({ type: 'app-open', accountHash: ACCOUNT, appHash: APP });

    expect(beforeMonday.events[0]?.data.weekStartKst).toBe('2026-10-26T00:00:00+09:00');
    expect(atMonday.events[0]?.data.weekStartKst).toBe('2026-11-02T00:00:00+09:00');
  });

  test('counts paid conversion only through 30 days after limit reached, inclusive', () => {
    const atBoundary = recorder(new Date('2026-11-04T12:00:00.000Z'));
    const afterBoundary = recorder(new Date('2026-11-04T12:00:00.001Z'));

    expect(atBoundary.observe({ type: 'paid-convert', accountHash: ACCOUNT, limitReachedAt: LIMIT_REACHED_AT })).toBe(true);
    expect(afterBoundary.observe({ type: 'paid-convert', accountHash: ACCOUNT, limitReachedAt: LIMIT_REACHED_AT })).toBe(false);
    expect(atBoundary.events).toHaveLength(1);
    expect(afterBoundary.events).toEqual([]);
  });

  test('rejects paid conversion when limit timestamp is missing, malformed, or in the future', () => {
    const { events, observe } = recorder();
    const nearNormalizedDate = recorder(new Date('2026-03-03T00:00:00.000Z'));
    expect(observe({ type: 'paid-convert', accountHash: ACCOUNT } as NexusFunnelEvent)).toBe(false);
    expect(observe({ type: 'paid-convert', accountHash: ACCOUNT, limitReachedAt: 'not-a-date' })).toBe(false);
    expect(nearNormalizedDate.observe({ type: 'paid-convert', accountHash: ACCOUNT, limitReachedAt: '2026-02-30T00:00:00Z' })).toBe(false);
    expect(observe({ type: 'paid-convert', accountHash: ACCOUNT, limitReachedAt: '2026-11-04T12:00:00.001Z' })).toBe(false);
    expect(events).toEqual([]);
    expect(nearNormalizedDate.events).toEqual([]);
  });

  test('uses the exported production entry point with only its logger replaced', () => {
    const events: Captured[] = [];
    const limitReachedAt = new Date(Date.now() - 1_000).toISOString();

    expect(observeNexusFunnelEvent(
      { type: 'paid-convert', accountHash: ACCOUNT, limitReachedAt },
      { log: (category, event, data) => events.push({ category, event, data }) },
    )).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.category).toBe(NEXUS_FUNNEL_CATEGORY);
    expect(events[0]?.event).toBe('paid-convert');
    expect(events[0]?.data.weekStartKst).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\+09:00$/u);
  });

  test('rejects raw identifiers and unknown enum values without emitting anything', () => {
    const { events, observe } = recorder();

    expect(observe({ type: 'signup', accountHash: 'ada@example.com', inviteSource: 'organic' } as NexusFunnelEvent)).toBe(false);
    expect(observe({ type: 'signup', accountHash: ACCOUNT, inviteSource: 'email' } as unknown as NexusFunnelEvent)).toBe(false);
    expect(observe({ type: 'app-open', accountHash: ACCOUNT, appHash: 'voice-note' } as NexusFunnelEvent)).toBe(false);
    expect(events).toEqual([]);
  });

  test('allowlists payload fields so runtime extras cannot leak PII', () => {
    const { events, observe } = recorder();
    const event = {
      type: 'signup', accountHash: ACCOUNT, inviteSource: 'organic',
      email: 'ada@example.com', displayName: 'Ada', inviteCode: 'secret-code',
    } as unknown as NexusFunnelEvent;

    expect(observe(event)).toBe(true);
    expect(events[0]?.data).toEqual({ accountHash: ACCOUNT, weekStartKst: '2026-11-02T00:00:00+09:00', inviteSource: 'organic' });
    expect(JSON.stringify(events)).not.toMatch(/ada@example\.com|Ada|secret-code/u);
  });

  test('fails open when the debug sink throws', () => {
    const observe = (event: NexusFunnelEvent) => observeNexusFunnelEvent(event, {
      now: () => NOW,
      log: () => { throw new Error('sink unavailable'); },
    });

    expect(() => observe({ type: 'signup', accountHash: ACCOUNT, inviteSource: 'organic' })).not.toThrow();
    expect(observe({ type: 'signup', accountHash: ACCOUNT, inviteSource: 'organic' })).toBe(false);
  });

  test('keeps the funnel event name inventory in sync with the documented metric signals', () => {
    expect(NEXUS_FUNNEL_EVENT_TYPES).toEqual([
      'signup', 'first-success', 'app-open', 'limit-reached', 'paid-convert', 'invite-sent',
    ]);
  });
});
