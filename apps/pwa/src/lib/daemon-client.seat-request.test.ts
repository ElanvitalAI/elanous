import { expect, test } from 'bun:test';
import { DaemonClient, SeatRequestError } from './daemon-client';
import type { AttachmentMeta } from './upload-attachment';
import { withFakeFetchDevice } from '../test-devices/fake-fetch';

const attachment: AttachmentMeta = {
  id: 'uploaded-1', filename: 'brief.pdf', mediaType: 'application/pdf', size: 12,
  downloadUrl: '/v1/attachments/uploaded-1', path: '/private/brief.pdf', createdAt: 123,
};
const client = () => new DaemonClient({ baseUrl: 'http://daemon', token: 'secret', provider: '' });

test('seat request sends only the uploaded attachment metadata and reads receipt count/channel', async () => {
  await withFakeFetchDevice([{ url: '/v1/seat-requests', method: 'POST', response: () => new Response(JSON.stringify({ receiptId: 'R-1', seat: 'MK', queuedAt: 'now', attachments: 1, channel: 'sent' }), {
      status: 202, headers: { 'content-type': 'application/json' },
    }) }], async (device) => {
    const receipt = await client().submitSeatRequest({ seat: 'MK', text: 'draft', attachments: [attachment] }, 'key-1');
    expect(receipt).toEqual({ receiptId: 'R-1', seat: 'MK', queuedAt: 'now', attachments: 1, channel: 'sent' });
    expect(device.calls()[0]).toMatchObject({ url: 'http://daemon/v1/seat-requests', method: 'POST' });
    expect(device.calls()[0]!.headers).toMatchObject({ 'idempotency-key': 'key-1', authorization: 'Bearer secret' });
    expect(JSON.parse(device.calls()[0]!.body!)).toEqual({
      seat: 'MK', text: 'draft', attachments: [{ id: 'uploaded-1', name: 'brief.pdf', mediaType: 'application/pdf', bytes: 12 }],
    });
    await client().submitSeatRequest({ text: '@cmo draft' }, 'key-2');
    expect(JSON.parse(device.calls()[1]!.body!)).toEqual({ text: '@cmo draft' });
  });
});

for (const code of ['unknown-attachment', 'attachments-unsupported'] as const) {
  test(`400 ${code} surfaces as a SeatRequestError code`, async () => {
    const submission = withFakeFetchDevice([{ url: '/v1/seat-requests', method: 'POST', response: () => new Response(JSON.stringify({ error: code }), {
      status: 400, headers: { 'content-type': 'application/json' },
    }) }], async () => {
      await client().submitSeatRequest({ seat: 'MK', text: 'draft', attachments: [attachment] }, 'key-3');
    });
    await expect(submission).rejects.toBeInstanceOf(SeatRequestError);
    await expect(submission).rejects.toMatchObject({ status: 400, code });
  });
}
