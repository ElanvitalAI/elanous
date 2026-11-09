// WT-N-2 — upload helper tests. Run via `bun test` (PWA-side bun
// runner picks up *.test.ts under apps/pwa).

import { describe, expect, test } from 'bun:test';
import { uploadAttachment, uploadAttachments } from './upload-attachment';
import { withFakeFetchDevice, type FakeFetchDevice } from '../test-devices/fake-fetch';

function withMockFetch<T>(response: () => Response | Promise<Response>, run: (device: FakeFetchDevice) => Promise<T>): Promise<T> {
  return withFakeFetchDevice([{ url: '/v1/attachments', method: 'POST', response }], run);
}

describe('uploadAttachment', () => {
  test('rejects when baseUrl empty', async () => {
    const r = await uploadAttachment({
      baseUrl: '',
      file: new Blob([new Uint8Array([1, 2])]),
      filename: 'x.bin',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('baseUrl');
  });

  test('strips trailing slash from baseUrl + posts multipart', async () => {
    await withMockFetch(() => Response.json({
        id: 'att-abc-1234',
        filename: 'photo.jpg',
        mediaType: 'image/jpeg',
        size: 4,
        downloadUrl: '/v1/attachments/att-abc-1234',
      }, { status: 201 }), async (device) => {
      const r = await uploadAttachment({
        baseUrl: 'http://localhost:31415/',
        token: 'tok',
        file: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }),
        filename: 'photo.jpg',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      expect(r.meta.id).toBe('att-abc-1234');
      expect(device.calls()).toHaveLength(1);
      expect(device.calls()[0]).toMatchObject({ url: 'http://localhost:31415/v1/attachments', method: 'POST' });
      expect(device.calls()[0]!.headers.authorization).toBe('Bearer tok');
      expect(device.calls()[0]!.body).toContain('photo.jpg');
      const wireBody = Uint8Array.from(atob(device.calls()[0]!.wireBodyBase64!), (char) => char.charCodeAt(0));
      const wireText = new TextDecoder().decode(wireBody);
      expect(wireText).toContain('Content-Disposition: form-data; name="file"; filename="photo.jpg"');
      expect(wireText).toContain('Content-Disposition: form-data; name="filename"');
      expect(wireText).toContain('\r\n\r\nphoto.jpg\r\n');
    });
  });

  test('omits authorization header when no token', async () => {
    await withMockFetch(() => Response.json({}), async (device) => {
      await uploadAttachment({
        baseUrl: 'http://x',
        file: new Blob([new Uint8Array([1])]),
      });
      expect(device.calls()[0]!.headers.authorization).toBeUndefined();
    });
  });

  test('returns typed error on non-ok HTTP', async () => {
    await withMockFetch(() => new Response('{"error":"too-large"}', { status: 413 }), async () => {
      const r = await uploadAttachment({
        baseUrl: 'http://x',
        file: new Blob([new Uint8Array([1])]),
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.status).toBe(413);
      expect(r.reason).toContain('too-large');
    });
  });

  test('catches fetch exceptions as status=0', async () => {
    await withMockFetch(() => { throw new Error('network down'); }, async () => {
      const r = await uploadAttachment({
        baseUrl: 'http://x',
        file: new Blob([new Uint8Array([1])]),
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.status).toBe(0);
      expect(r.reason).toContain('network down');
    });
  });

  test('uses File.name when filename omitted', async () => {
    await withMockFetch(() => Response.json({}), async (device) => {
      const file = new File([new Uint8Array([1])], 'auto-name.png', { type: 'image/png' });
      await uploadAttachment({ baseUrl: 'http://x', file });
      const [call] = device.calls();
      expect(device.calls()).toHaveLength(1);
      expect(call!.wireBodyBase64).toBeDefined();
      const entries = JSON.parse(call!.body!.slice('form-data:'.length)) as Array<[string, string | { name: string; type: string; base64: string }]>;
      expect(entries[0]).toEqual(['file', { name: 'auto-name.png', type: 'image/png', base64: 'AQ==' }]);
      expect(entries[1]).toEqual(['filename', 'auto-name.png']);
      const wireBody = Uint8Array.from(atob(call!.wireBodyBase64!), (char) => char.charCodeAt(0));
      const wireText = new TextDecoder().decode(wireBody);
      expect(wireText).toContain('Content-Disposition: form-data; name="file"; filename="auto-name.png"');
      expect(wireText).toContain('Content-Disposition: form-data; name="filename"');
      expect(wireText).toContain('\r\n\r\nauto-name.png\r\n');
    });
  });
});

describe('uploadAttachments (batch)', () => {
  test('runs N uploads in parallel + returns per-file results', async () => {
    let count = 0;
    await withMockFetch(() => {
      count += 1;
      return Response.json({
          id: `att-${count}`,
          filename: `f${count}`,
          mediaType: 'application/octet-stream',
          size: 1,
          downloadUrl: `/v1/attachments/att-${count}`,
        }, { status: 201 });
    }, async (device) => {
      const results = await uploadAttachments([
        { file: new Blob([new Uint8Array([1])]), filename: 'a' },
        { file: new Blob([new Uint8Array([2])]), filename: 'b' },
        { file: new Blob([new Uint8Array([3])]), filename: 'c' },
      ], { baseUrl: 'http://x' });
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(device.calls()).toHaveLength(3);
    });
  });

  test('mixes successes + failures cleanly', async () => {
    let count = 0;
    const emptyReportedSize = new Uint8Array().byteLength;
    await withMockFetch(() => {
      count += 1;
      const ok = count !== 2; // 2nd call fails
      return Response.json({ id: `att-${count}`, filename: `f${count}`, mediaType: '', size: emptyReportedSize, downloadUrl: '' }, {
        status: ok ? 201 : 500,
        ...(ok ? {} : { statusText: 'server error' }),
      });
    }, async (device) => {
      const results = await uploadAttachments([
        { file: new Blob([new Uint8Array([1])]), filename: 'a' },
        { file: new Blob([new Uint8Array([2])]), filename: 'b' },
        { file: new Blob([new Uint8Array([3])]), filename: 'c' },
      ], { baseUrl: 'http://x' });
      expect(results.filter((r) => r.ok)).toHaveLength(2);
      expect(results.filter((r) => !r.ok)).toHaveLength(1);
      expect(device.calls()).toHaveLength(3);
    });
  });
});
