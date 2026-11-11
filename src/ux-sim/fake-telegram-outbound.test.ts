import { describe, expect, test } from 'bun:test';
import { loadMockScenarioCatalog } from './mock-scenario-catalog.js';
import { createFakeTelegramOutbound } from './fake-telegram-outbound.js';

describe('fake-telegram-outbound', () => {
  test('is registered as a reusable simulation device', () => {
    expect(loadMockScenarioCatalog().devices.some((device) => device.id === 'fake-telegram-outbound')).toBe(true);
  });

  test('records generic text and keeps action metadata optional', async () => {
    const fake = createFakeTelegramOutbound();
    expect(await fake.send({ text: 'Graph complete', kind: 'graph' })).toEqual({ ok: true });
    expect(fake.calls()).toBe(1);
    expect(fake.receipts()).toEqual([{ text: 'Graph complete', kind: 'graph', buttons: [] }]);
  });

  test('preserves briefing action values when supplied', async () => {
    const fake = createFakeTelegramOutbound();
    expect(await fake.send({ briefingId: 'brief-1', text: '오늘의 브리핑', buttons: [{ label: '열기', value: 'brief-1' }] })).toEqual({ ok: true });
    expect(fake.receipts()[0]?.buttons[0]?.value).toBe('brief-1');
  });

  test('records the surface-neutral notify contract and legacy aliases together', async () => {
    const fake = createFakeTelegramOutbound();
    const message = {
      refId: 'suggest-1', dedupKey: 'briefing:suggest-1', text: '제안이 준비됐습니다.',
      actions: [{ id: 'suggest_accept', label: 'OK' }],
      briefingId: 'brief-1', buttons: [{ label: '열기', value: 'brief-1' }],
    };
    expect(await fake.send(message)).toEqual({ ok: true });
    expect(fake.receipts()[0]).toMatchObject(message);
  });

  test('injects a failed delivery without claiming a receipt', async () => {
    const fake = createFakeTelegramOutbound({ fail: true });
    expect(await fake.send({ text: 'Graph complete' })).toEqual({ ok: false });
    expect(fake.calls()).toBe(1);
    expect(fake.receipts()).toEqual([]);
  });
});
