// WT-N-5 P1 — useLiveCamera hook tests.
//
// The full React lifecycle (start → 1 Hz interval → canvas.toBlob →
// fetch → setState round-trip) needs a DOM-aware renderer that the
// bun-only PWA test setup doesn't carry. We pin the load-bearing
// pieces directly:
//   - module export shape (cheap regression guard)
//   - upload helper used internally (auth header, multipart, error)
//
// The end-to-end browser flow is verified by the manual dogfood
// captured in the PR description. Browser-side regressions surface
// as "frame counter doesn't tick" — fast to spot during dogfood,
// not worth a renderer dep just for this one hook.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { uploadAttachment } from './upload-attachment';
import { useLiveCamera } from './use-live-camera';
import { createFakeFetchDevice, type FakeFetchDevice } from '../test-devices/fake-fetch';

let fakeFetch: FakeFetchDevice | undefined;

describe('useLiveCamera module surface', () => {
  test('export is callable', () => {
    expect(typeof useLiveCamera).toBe('function');
  });
});

describe('frame upload helper — used by useLiveCamera capture loop', () => {
  let capturedAuth: string | undefined;

  beforeEach(() => {
    fakeFetch?.restore();
    capturedAuth = undefined;
    fakeFetch = createFakeFetchDevice([{
      url: '/v1/attachments',
      method: 'POST',
      response: (request) => {
        capturedAuth = request.headers.authorization;
        return Response.json({
          id: 'att-frame-1',
          filename: 'live-frame.jpg',
          mediaType: 'image/jpeg',
          size: 100,
          downloadUrl: '/v1/attachments/att-frame-1',
        }, { status: 201 });
      },
    }]);
  });

  afterEach(() => { fakeFetch?.restore(); fakeFetch = undefined; });

  test('ships JPEG blob under "file" form field with filename', async () => {
    const blob = new Blob([new Uint8Array(100)], { type: 'image/jpeg' });
    const r = await uploadAttachment({
      baseUrl: 'http://localhost:31415',
      file: blob,
      filename: 'live-frame-12345.jpg',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.meta.id).toBe('att-frame-1');
    const body = fakeFetch?.calls()[0]?.body;
    expect(body).not.toBeNull();
    const fields = JSON.parse(body!.slice('form-data:'.length)) as Array<[string, unknown]>;
    expect(fields).toContainEqual(['filename', 'live-frame-12345.jpg']);
    expect(fields).toContainEqual(['file', expect.objectContaining({ name: 'live-frame-12345.jpg' })]);
  });

  test('attaches Bearer auth header when token is set', async () => {
    await uploadAttachment({
      baseUrl: 'http://localhost:31415',
      token: 'tok-abc',
      file: new Blob(['x']),
      filename: 'x.jpg',
    });
    expect(capturedAuth).toBe('Bearer tok-abc');
  });

  test('omits auth header when no token', async () => {
    await uploadAttachment({
      baseUrl: 'http://localhost:31415',
      file: new Blob(['x']),
      filename: 'x.jpg',
    });
    expect(capturedAuth).toBeUndefined();
  });

  test('returns ok=false on non-OK response', async () => {
    fakeFetch?.restore();
    fakeFetch = createFakeFetchDevice([{ url: '/v1/attachments', method: 'POST', response: () => Response.json({ error: 'server error' }, { status: 500 }) }]);
    const r = await uploadAttachment({
      baseUrl: 'http://localhost:31415',
      file: new Blob(['x']),
      filename: 'x.jpg',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.status).toBe(500);
  });

  test('returns ok=false when baseUrl is empty', async () => {
    const r = await uploadAttachment({
      baseUrl: '',
      file: new Blob(['x']),
      filename: 'x.jpg',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toContain('baseUrl');
  });
});
