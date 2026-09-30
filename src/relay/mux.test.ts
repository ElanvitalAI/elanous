import { describe, expect, test } from 'bun:test';
import { MAX_FRAME_BYTES } from './channel.js';
import { MAX_MUX_FRAME_BYTES, MuxDecoder, MuxEncoder, MuxStreamState, type MuxFrame } from './mux.js';

function encoded(encoder: MuxEncoder, frame: MuxFrame): Uint8Array {
  const result = encoder.encode(frame);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe('relay plaintext multiplexing', () => {
  test('interleaves HTTP and WS streams, with binary data and close/reopen on the same ID', () => {
    const encoder = new MuxEncoder();
    const decoder = new MuxDecoder();
    const frames: MuxFrame[] = [
      { streamId: 0, kind: 'open', protocol: 'http', method: 'POST', path: '/v1/질문', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' } },
      { streamId: 0xffffffff, kind: 'open', protocol: 'ws', path: '/v1/acp', headers: { upgrade: 'websocket' } },
      { streamId: 0, kind: 'data', data: new Uint8Array([0, 255, 1, 0]) },
      { streamId: 0xffffffff, kind: 'data', data: new Uint8Array() },
      { streamId: 0, kind: 'close', reason: '완료' },
      { streamId: 0, kind: 'open', protocol: 'ws', path: '/v1/acp', headers: {} },
      { streamId: 0xffffffff, kind: 'close', reason: '' },
    ];
    for (const frame of frames) expect(decoder.decode(encoded(encoder, frame))).toEqual({ ok: true, value: frame });
  });

  test('rejects duplicate opens and unopened data/close until close, independently on each side', () => {
    const encoder = new MuxEncoder();
    const decoder = new MuxDecoder();
    const open: MuxFrame = { streamId: 4, kind: 'open', protocol: 'http', method: 'GET', path: '/v1/health', headers: {} };
    const close: MuxFrame = { streamId: 4, kind: 'close', reason: 'done' };
    const data: MuxFrame = { streamId: 4, kind: 'data', data: new Uint8Array([9]) };
    expect(encoder.encode(data)).toEqual({ ok: false, reason: 'stream not open' });
    expect(encoder.encode(close)).toEqual({ ok: false, reason: 'stream not open' });
    const first = encoded(encoder, open);
    expect(decoder.decode(first)).toEqual({ ok: true, value: open });
    expect(encoder.encode(open)).toEqual({ ok: false, reason: 'stream already open' });
    expect(decoder.decode(first)).toEqual({ ok: false, reason: 'stream already open' });
    expect(decoder.decode(encoded(encoder, data))).toEqual({ ok: true, value: data });
    expect(decoder.decode(encoded(encoder, close))).toEqual({ ok: true, value: close });
    expect(decoder.decode(first)).toEqual({ ok: true, value: open });
    expect(encoder.encode(open).ok).toBe(true);
  });

  test('tracks both directions per endpoint and reuses an ID only after close', () => {
    const phoneState = new MuxStreamState();
    const daemonState = new MuxStreamState();
    const phoneEncoder = new MuxEncoder(phoneState);
    const phoneDecoder = new MuxDecoder(phoneState);
    const daemonEncoder = new MuxEncoder(daemonState);
    const daemonDecoder = new MuxDecoder(daemonState);
    const open: MuxFrame = { streamId: 3, kind: 'open', protocol: 'http', method: 'GET', path: '/', headers: {} };
    const data: MuxFrame = { streamId: 3, kind: 'data', data: new Uint8Array([1, 2]) };
    const close: MuxFrame = { streamId: 3, kind: 'close', reason: 'done' };
    expect(daemonEncoder.encode(data)).toEqual({ ok: false, reason: 'stream not open' });
    expect(daemonDecoder.decode(encoded(phoneEncoder, open))).toEqual({ ok: true, value: open });
    expect(daemonEncoder.encode(open)).toEqual({ ok: false, reason: 'stream already open' });
    expect(phoneDecoder.decode(encoded(daemonEncoder, data))).toEqual({ ok: true, value: data });
    expect(phoneEncoder.encode(open)).toEqual({ ok: false, reason: 'stream already open' });
    expect(phoneDecoder.decode(encoded(daemonEncoder, close))).toEqual({ ok: true, value: close });
    expect(phoneEncoder.encode(data)).toEqual({ ok: false, reason: 'stream not open' });
    expect(daemonDecoder.decode(encoded(phoneEncoder, open))).toEqual({ ok: true, value: open });
  });

  test('rejects unknown kinds/protocols, truncation, trailing bytes, invalid UTF-8 and invalid input without throwing or consuming an ID', () => {
    const encoder = new MuxEncoder();
    const decoder = new MuxDecoder();
    const open: MuxFrame = { streamId: 12, kind: 'open', protocol: 'ws', path: '/v1/acp', headers: {} };
    const frame = encoded(encoder, open);
    for (let length = 0; length < frame.length; length++) {
      const result = decoder.decode(frame.subarray(0, length));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('truncated frame');
    }
    const unknown = frame.slice(); unknown[8] = 99;
    expect(decoder.decode(unknown)).toEqual({ ok: false, reason: 'unknown frame kind' });
    const protocol = frame.slice(); protocol[9] = 99;
    expect(decoder.decode(protocol)).toEqual({ ok: false, reason: 'unknown protocol' });
    const utf8 = frame.slice(); utf8[14] = 0xff;
    expect(decoder.decode(utf8)).toEqual({ ok: false, reason: 'invalid UTF-8 frame' });
    const trailing = new Uint8Array(frame.length + 1); trailing.set(frame);
    new DataView(trailing.buffer).setUint32(0, trailing.length - 4);
    expect(decoder.decode(trailing)).toEqual({ ok: false, reason: 'trailing frame bytes' });
    expect(decoder.decode(frame)).toEqual({ ok: true, value: open });
    expect(encoder.encode({ ...open, kind: 'unknown' } as unknown as MuxFrame)).toEqual({ ok: false, reason: 'unknown frame kind' });
    expect(new MuxEncoder().encode({ ...open, streamId: 0x1_0000_0000 })).toEqual({ ok: false, reason: 'invalid stream ID' });
  });

  test('enforces the encrypted-channel 1MB limit on encoding and decoding, without consuming state on failure', () => {
    const encoder = new MuxEncoder();
    const decoder = new MuxDecoder();
    const open: MuxFrame = { streamId: 7, kind: 'open', protocol: 'ws', path: '/', headers: {} };
    expect(MAX_MUX_FRAME_BYTES).toBe(MAX_FRAME_BYTES - 24);
    expect(decoder.decode(new Uint8Array(MAX_MUX_FRAME_BYTES + 1))).toEqual({ ok: false, reason: 'frame exceeds 1MB' });
    const hugeOpen: MuxFrame = { ...open, path: 'x'.repeat(MAX_MUX_FRAME_BYTES) };
    expect(encoder.encode(hugeOpen)).toEqual({ ok: false, reason: 'frame exceeds 1MB' });
    expect(decoder.decode(encoded(encoder, open))).toEqual({ ok: true, value: open });
    const maximum = encoded(encoder, { streamId: 7, kind: 'data', data: new Uint8Array(MAX_MUX_FRAME_BYTES - 9) });
    expect(maximum.length).toBe(MAX_MUX_FRAME_BYTES);
    expect(decoder.decode(maximum).ok).toBe(true);
    expect(encoder.encode({ streamId: 7, kind: 'data', data: new Uint8Array(MAX_MUX_FRAME_BYTES - 8) }))
      .toEqual({ ok: false, reason: 'frame exceeds 1MB' });
  });
});
