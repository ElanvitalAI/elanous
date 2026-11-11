import { describe, expect, test } from 'bun:test';
import {
  createAppLifecycleEvent,
  projectAppLifecycleSnapshot,
  type AppLifecycleAction,
  type AppLifecycleEvent,
  type AppLifecycleEventInput,
} from './app-lifecycle-ledger.js';

const at = '2026-11-05T12:00:00.000Z';
let nextId = 0;

function event(
  appId: string,
  action: AppLifecycleAction,
  extra: Partial<Omit<AppLifecycleEvent, 'id' | 'appId' | 'action' | 'occurredAt'>> = {},
): AppLifecycleEvent {
  return createAppLifecycleEvent({
    appId,
    action,
    environment: action === 'promoted' || action === 'upgrade' || action === 'paused' || action === 'rolled-back' ? 'live' : 'simulation',
    actor: 'user',
    ...extra,
  }, { id: () => `event-${String(++nextId).padStart(4, '0')}`, now: () => new Date(at) });
}

describe('app lifecycle projection core', () => {
  test('a failed initial creation remains observable as an event but does not create a tile snapshot', () => {
    const failedCreate = event('notes', 'created', { outcome: 'failed', reasonCode: 'operation-failed' });
    expect(failedCreate.outcome).toBe('failed');
    expect(projectAppLifecycleSnapshot('notes', [failedCreate])).toBeNull();
  });

  test('events before the first successful creation cannot seed the new app projection', () => {
    const events = [
      event('catalog', 'created', { outcome: 'failed', reasonCode: 'operation-failed' }),
      event('catalog', 'receipt-issued', { receiptId: 'receipt-before-create' }),
      event('catalog', 'purged', { environment: 'live' }),
      event('catalog', 'created', { appVersion: 'v1' }),
    ];
    expect(projectAppLifecycleSnapshot('catalog', events)).toMatchObject({
      status: 'draft', currentVersion: 'v1', previousVersion: null,
      latestReceiptId: null, eventCount: events.length,
      latestEvent: { action: 'created', outcome: 'succeeded' },
    });
  });

  test('defaults only omitted outcome and timestamp and rejects explicit null values', () => {
    const defaults = createAppLifecycleEvent({
      appId: 'safe-app', action: 'created', environment: 'simulation', actor: 'user',
    }, { id: () => 'event-defaults', now: () => new Date(at) });
    expect(defaults).toMatchObject({ outcome: 'succeeded', occurredAt: at });

    const nullOutcome = {
      appId: 'safe-app', action: 'created', environment: 'simulation', actor: 'user', outcome: null,
    } as unknown as AppLifecycleEventInput;
    const nullOccurredAt = {
      appId: 'safe-app', action: 'created', environment: 'simulation', actor: 'user', occurredAt: null,
    } as unknown as AppLifecycleEventInput;
    expect(() => createAppLifecycleEvent(nullOutcome)).toThrow('invalid app lifecycle outcome');
    expect(() => createAppLifecycleEvent(nullOccurredAt)).toThrow('invalid app lifecycle timestamp');
  });

  test('projects successful lifecycle actions and rolls back to the prior version when no version is repeated', () => {
    const events = [
      event('voice-notes', 'created', { appVersion: 'v1' }),
      event('voice-notes', 'simulated', { runId: 'run-1', appFingerprint: 'a'.repeat(64), deviceCatalogVersion: 3 }),
      event('voice-notes', 'receipt-issued', { receiptId: 'receipt-1', appFingerprint: 'a'.repeat(64), deviceCatalogVersion: 3 }),
      event('voice-notes', 'promoted', { appVersion: 'v2', receiptId: 'receipt-1', appFingerprint: 'a'.repeat(64) }),
      event('voice-notes', 'promoted'),
      event('voice-notes', 'paused'),
      event('voice-notes', 'rolled-back'),
      event('voice-notes', 'trashed', { environment: 'live' }),
      event('voice-notes', 'restored', { environment: 'live' }),
    ];

    expect(projectAppLifecycleSnapshot('voice-notes', events)).toMatchObject({
      appId: 'voice-notes', status: 'live', currentVersion: 'v1', previousVersion: 'v2',
      latestReceiptId: 'receipt-1', eventCount: 9,
      latestEvent: { action: 'restored', outcome: 'succeeded' },
    });
  });

  test('records an app feature upgrade as a new live version with the prior version retained', () => {
    const events = [
      event('lecture-scrap', 'created', { environment: 'live', appVersion: 'v1' }),
      event('lecture-scrap', 'upgrade', { environment: 'live', appVersion: 'v2', receiptId: 'upgrade-receipt' }),
    ];
    expect(projectAppLifecycleSnapshot('lecture-scrap', events)).toMatchObject({
      status: 'live', currentVersion: 'v2', previousVersion: 'v1', latestReceiptId: null,
      latestEvent: { action: 'upgrade', appVersion: 'v2' },
    });
  });

  test('drops fields outside the metadata event allowlist before exposing the latest event', () => {
    const created = event('safe-app', 'created', { appVersion: 'v1' });
    const promoted = {
      ...event('safe-app', 'promoted', { environment: 'live', appVersion: 'v2' }),
      payload: 'PRIVATE-APP-DATA',
      error: 'PRIVATE-ERROR-TEXT',
    } as AppLifecycleEvent;
    const snapshot = projectAppLifecycleSnapshot('safe-app', [created, promoted]);

    expect(snapshot?.latestEvent).not.toHaveProperty('payload');
    expect(snapshot?.latestEvent).not.toHaveProperty('error');
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE-APP-DATA');
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE-ERROR-TEXT');
  });

  test('rejects non-string values at the untrusted event boundary', () => {
    const valid = event('safe-app', 'created', { appVersion: 'v1' });
    const invalidId = { ...valid, id: null } as unknown as AppLifecycleEvent;
    const invalidVersion = { ...valid, appVersion: ['v2'] } as unknown as AppLifecycleEvent;
    const invalidTimestamp = { ...valid, occurredAt: [] } as unknown as AppLifecycleEvent;

    expect(() => projectAppLifecycleSnapshot('safe-app', [invalidId])).toThrow('invalid app lifecycle event id');
    expect(() => projectAppLifecycleSnapshot('safe-app', [invalidVersion])).toThrow('invalid app lifecycle app version');
    expect(() => projectAppLifecycleSnapshot('safe-app', [invalidTimestamp])).toThrow('invalid app lifecycle timestamp');
  });

  test('failed and blocked actions remain in history but do not advance state, version, or receipt projections', () => {
    const events = [
      event('notes', 'created', { appVersion: 'v1' }),
      event('notes', 'receipt-issued', { receiptId: 'receipt-ok' }),
      event('notes', 'promoted', { appVersion: 'v2' }),
      event('notes', 'promoted', { outcome: 'failed', appVersion: 'v3', reasonCode: 'operation-failed' }),
      event('notes', 'receipt-issued', { outcome: 'failed', reasonCode: 'operation-failed' }),
      event('notes', 'receipt-issued', { outcome: 'blocked', receiptId: 'receipt-blocked', reasonCode: 'receipt-stale' }),
      event('notes', 'trashed', { outcome: 'failed', environment: 'live', reasonCode: 'operation-failed' }),
      event('notes', 'purged', { outcome: 'blocked', environment: 'live', reasonCode: 'permission-denied' }),
      event('notes', 'rolled-back', { outcome: 'failed', environment: 'live', appVersion: 'v1', reasonCode: 'operation-failed' }),
    ];

    expect(projectAppLifecycleSnapshot('notes', events)).toMatchObject({
      status: 'live', currentVersion: 'v2', previousVersion: 'v1',
      latestReceiptId: 'receipt-ok', eventCount: events.length,
      latestEvent: { action: 'rolled-back', outcome: 'failed' },
    });
  });

  test('uses an explicit rollback version and preserves the version being left', () => {
    const events = [
      event('catalog', 'created', { appVersion: 'v1' }),
      event('catalog', 'promoted', { appVersion: 'v2' }),
      event('catalog', 'rolled-back', { environment: 'live', appVersion: 'v0' }),
    ];
    expect(projectAppLifecycleSnapshot('catalog', events)).toMatchObject({
      status: 'live', currentVersion: 'v0', previousVersion: 'v2',
    });
  });

  test('a no-op explicit rollback does not overwrite the previous rollback target', () => {
    const events = [
      event('catalog', 'created', { appVersion: 'v1' }),
      event('catalog', 'promoted', { appVersion: 'v2' }),
      event('catalog', 'rolled-back', { environment: 'live', appVersion: 'v2' }),
      event('catalog', 'rolled-back', { environment: 'live' }),
    ];
    expect(projectAppLifecycleSnapshot('catalog', events)).toMatchObject({
      status: 'live', currentVersion: 'v1', previousVersion: 'v2',
    });
  });

  test('duplicate successful creation remains in history without resetting lifecycle state', () => {
    const events = [
      event('catalog', 'created', { appVersion: 'v1' }),
      event('catalog', 'promoted', { appVersion: 'v2' }),
      event('catalog', 'created', { appVersion: 'v3' }),
    ];
    expect(projectAppLifecycleSnapshot('catalog', events)).toMatchObject({
      status: 'live', currentVersion: 'v2', previousVersion: 'v1',
      eventCount: events.length, latestEvent: { action: 'created', appVersion: 'v3' },
    });
  });

  test('projects trash and permanent removal without deleting the event history', () => {
    const events = [
      event('catalog', 'created', { appVersion: 'v1' }),
      event('catalog', 'trashed'),
    ];
    expect(projectAppLifecycleSnapshot('catalog', events)?.status).toBe('trashed');
    events.push(event('catalog', 'purged', { environment: 'live' }));
    expect(projectAppLifecycleSnapshot('catalog', events)).toMatchObject({ status: 'purged', eventCount: 3 });
  });

  test('successful events after permanent removal cannot restore the purged app', () => {
    const events = [
      event('catalog', 'created', { appVersion: 'v1' }),
      event('catalog', 'trashed'),
      event('catalog', 'purged', { environment: 'live' }),
      event('catalog', 'restored', { environment: 'live' }),
      event('catalog', 'trashed', { environment: 'live' }),
    ];
    expect(projectAppLifecycleSnapshot('catalog', events)).toMatchObject({
      status: 'purged', eventCount: events.length,
      latestEvent: { action: 'trashed', outcome: 'succeeded' },
    });
  });

  test('projects events in supplied append order even when timestamps go backwards', () => {
    const created = { ...event('catalog', 'created', { appVersion: 'v1' }), occurredAt: '2026-11-06T12:00:00.000Z' };
    const promoted = { ...event('catalog', 'promoted', { environment: 'live', appVersion: 'v2' }), occurredAt: '2026-11-04T12:00:00.000Z' };
    expect(projectAppLifecycleSnapshot('catalog', [created, promoted])).toMatchObject({
      status: 'live', currentVersion: 'v2', latestEvent: { action: 'promoted' },
    });
  });

  test('returns null for an empty timeline and rejects events belonging to another app', () => {
    expect(projectAppLifecycleSnapshot('missing', [])).toBeNull();
    expect(() => projectAppLifecycleSnapshot('one', [event('two', 'created')])).toThrow('another app');
  });

  test('rejects unsafe ids, unregistered reason codes, and secret-like reason text', () => {
    expect(() => event('../outside', 'created')).toThrow('invalid app lifecycle app id');
    expect(() => event('safe-app', 'simulated', { runId: 'sk-secret' })).toThrow('invalid app lifecycle run id');
    expect(() => event('safe-app', 'paused', { reasonCode: 'user-entered-password' as never })).toThrow('invalid app lifecycle reason code');
    expect(() => event('safe-app', 'paused', { reasonCode: 'api-secret-leaked' as never })).toThrow('invalid app lifecycle reason code');
    expect(() => event('safe-app', 'simulated', { appFingerprint: 'not-a-sha256' })).toThrow('invalid app lifecycle app fingerprint');
  });

  test('requires an id for a successfully issued receipt', () => {
    expect(() => event('catalog', 'receipt-issued')).toThrow('requires a receipt id');
  });
});
