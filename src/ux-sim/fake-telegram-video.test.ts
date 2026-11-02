import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTelegramVideoDelivery, createTelegramVideoSender } from '../video-pipeline/telegram-video-sender.js';
import { createFakeTelegramVideoReceipt } from './fake-telegram-video.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function videoFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'fake-telegram-video-'));
  roots.push(root);
  const file = join(root, 'rendered.mp4');
  writeFileSync(file, Buffer.from([0, 1, 2, 3, 255]));
  return file;
}

describe('fake-telegram-video', () => {
  it('runs the production sendVideo callback and returns an observable Telegram delivery receipt', async () => {
    const device = createFakeTelegramVideoReceipt({ token: 'isolated-token', messageId: 8123 });
    const state: Record<string, unknown> = { telegram_chat_id: -10042 };
    expect(configureTelegramVideoDelivery(state, 'explainer-line', {
      TELEGRAM_API_BASE: 'https://api.telegram.org/', TELEGRAM_BOT_TOKEN: 'isolated-token',
    }, device.fetch)).toBe(true);
    const send = state.sendTelegramVideo as (file: string, briefing: unknown) => Promise<string>;
    const bytes = Buffer.from([0, 1, 2, 3, 255]);
    await expect(send(videoFile(), { title: '수신 확인' })).resolves.toBe('8123');
    expect(device.receipts()).toEqual([{
      endpoint: 'https://api.telegram.org/botisolated-token/sendVideo', chatId: '-10042',
      fileName: 'briefing.mp4', contentType: 'video/mp4', byteLength: 5,
      contentSha256: createHash('sha256').update(bytes).digest('hex'), caption: '수신 확인', messageId: 8123,
    }]);
  });

  it('does not wire the production sender without the intended graph, recipient, and token', () => {
    const state: Record<string, unknown> = { telegram_chat_id: 42 };
    expect(configureTelegramVideoDelivery(state, 'other-graph', { TELEGRAM_BOT_TOKEN: 'token' })).toBe(false);
    expect(configureTelegramVideoDelivery(state, 'explainer-line', {})).toBe(false);
    expect(state.sendTelegramVideo).toBeUndefined();
  });

  it('preserves Telegram rejection details and does not manufacture a delivery receipt', async () => {
    const device = createFakeTelegramVideoReceipt({ ok: false, httpStatus: 400, description: 'chat not found' });
    const send = createTelegramVideoSender({ apiBase: 'https://api.telegram.org', token: 'test-token', chatId: 1, fetchImpl: device.fetch });
    await expect(send(videoFile(), {})).rejects.toThrow('Telegram sendVideo failed: chat not found');
    expect(device.calls()).toBe(1);
    expect(device.receipts()).toHaveLength(0);
  });

  it('fails closed on an unrelated endpoint and malformed multipart body', async () => {
    const device = createFakeTelegramVideoReceipt();
    await expect(device.fetch('https://example.test/sendVideo', { method: 'POST', body: new FormData() })).rejects.toThrow('unexpected endpoint');
    await expect(device.fetch('https://api.telegram.org/bottest-token/sendVideo', { method: 'POST', body: 'video' })).rejects.toThrow('multipart FormData');
    expect(device.calls()).toBe(0);
    expect(device.receipts()).toHaveLength(0);
  });
});
