import { afterEach, expect, test } from 'bun:test';
import { DaemonClient, SeatRequestError } from './daemon-client';
import type { AttachmentMeta } from './upload-attachment';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const attachment: AttachmentMeta = {
  id: 'uploaded-1', filename: 'brief.pdf', mediaType: 'application/pdf', size: 12,
  downloadUrl: '/v1/attachments/uploaded-1', path: '/private/brief.pdf', createdAt: 123,
};
const client = () => new DaemonClient({ baseUrl: 'http://daemon', token: 'secret', provider: '' });

test('seat request sends only the uploaded attachment metadata and reads receipt count/channel', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ receiptId: 'R-1', seat: 'MK', queuedAt: 'now', attachments: 1, channel: 'sent' }), {
      status: 202, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const receipt = await client().submitSeatRequest({ seat: 'MK', text: 'draft', attachments: [attachment] }, 'key-1');
  expect(receipt).toEqual({ receiptId: 'R-1', seat: 'MK', queuedAt: 'now', attachments: 1, channel: 'sent' });
  expect(calls[0]!.url).toBe('http://daemon/v1/seat-requests');
  expect(calls[0]!.init.headers).toMatchObject({ 'Idempotency-Key': 'key-1', authorization: 'Bearer secret' });
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
    seat: 'MK', text: 'draft', attachments: [{ id: 'uploaded-1', name: 'brief.pdf', mediaType: 'application/pdf', bytes: 12 }],
  });
  await client().submitSeatRequest({ text: '@cmo draft' }, 'key-2');
  expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ text: '@cmo draft' });
});

for (const code of ['unknown-attachment', 'attachments-unsupported'] as const) {
  test(`400 ${code} surfaces as a SeatRequestError code`, async () => {
    globalThis.fetch = (async (_url: string | URL | Request, _init: RequestInit = {}) => new Response(JSON.stringify({ error: code }), {
      status: 400, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    try {
      await client().submitSeatRequest({ seat: 'MK', text: 'draft', attachments: [attachment] }, 'key-3');
      throw new Error('expected 400');
    } catch (error) {
      expect(error).toBeInstanceOf(SeatRequestError);
      expect((error as SeatRequestError).status).toBe(400);
      expect((error as SeatRequestError).code).toBe(code);
    }
  });
}
