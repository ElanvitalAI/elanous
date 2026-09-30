import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  MAX_FRAME_BYTES, EncryptedChannel, acceptDaemonChannel, createPhoneChannel, deserializeDaemonKeyPair,
  generateDaemonKeyPair, serializeDaemonKeyPair, serverIdFromPublicKey,
} from './channel.js';

async function connected() {
  const daemon = await generateDaemonKeyPair();
  const phone = await createPhoneChannel(daemon.publicKey, daemon.publicKey);
  expect(phone.ok).toBe(true);
  if (!phone.ok) throw new Error(phone.reason);
  const accepted = await acceptDaemonChannel(daemon, phone.value.phonePublicKey);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) throw new Error(accepted.reason);
  return { daemon, phone: phone.value, server: accepted.value };
}

function sealed(value: EncryptedChannel, payload: Uint8Array) {
  const result = value.seal(payload);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe('encrypted relay channel', () => {
  test('persists daemon key pair and identifies the server by SHA-256 of public key', async () => {
    const daemon = await generateDaemonKeyPair();
    const stored = serializeDaemonKeyPair(daemon);
    const loaded = await deserializeDaemonKeyPair(stored);
    expect(loaded).toEqual({ ok: true, value: daemon });
    expect(serverIdFromPublicKey(daemon.publicKey)).toBe(createHash('sha256').update(daemon.publicKey).digest('hex'));
    expect((await deserializeDaemonKeyPair({ ...stored, secretKey: serializeDaemonKeyPair(await generateDaemonKeyPair()).secretKey })).ok).toBe(false);
  });

  test('crypto_kx exchanges distinct directional keys and ciphertext contains neither token nor plaintext', async () => {
    const { phone, server } = await connected();
    const plain = new TextEncoder().encode('Bearer sensitive-token payload with private text');
    const request = sealed(phone.channel, plain);
    expect(request.length).toBe(plain.length + 24);
    expect(Buffer.from(request).includes(Buffer.from('sensitive-token'))).toBe(false);
    expect(Buffer.from(request).includes(Buffer.from('private text'))).toBe(false);
    expect(phone.channel.open(request)).toEqual({ ok: false, reason: 'frame authentication failed' });
    expect(server.open(request)).toEqual({ ok: true, value: plain });
    const response = new TextEncoder().encode('server reply');
    expect(phone.channel.open(sealed(server, response))).toEqual({ ok: true, value: response });
    expect(phone.channel.open(request)).toEqual({ ok: false, reason: 'replayed frame' });
  });

  test('rejects tampering without consuming sequence and rejects replay and out-of-order frames', async () => {
    const { phone, server } = await connected();
    const first = sealed(phone.channel, new TextEncoder().encode('first'));
    const second = sealed(phone.channel, new TextEncoder().encode('second'));
    expect(server.open(second)).toEqual({ ok: false, reason: 'out-of-order frame' });
    const tampered = new Uint8Array(first);
    tampered[tampered.length - 1] ^= 1;
    expect(server.open(tampered)).toEqual({ ok: false, reason: 'frame authentication failed' });
    expect(server.open(first)).toEqual({ ok: true, value: new TextEncoder().encode('first') });
    expect(server.open(first)).toEqual({ ok: false, reason: 'replayed frame' });
    expect(server.open(second)).toEqual({ ok: true, value: new TextEncoder().encode('second') });
  });

  test('rejects wrong pinned daemon public key and oversized frames in either direction', async () => {
    const daemon = await generateDaemonKeyPair();
    const wrong = await generateDaemonKeyPair();
    expect(await createPhoneChannel(daemon.publicKey, wrong.publicKey)).toEqual({ ok: false, reason: 'wrong daemon public key' });
    expect((await createPhoneChannel(new Uint8Array(32), new Uint8Array(32))).ok).toBe(false);
    expect((await acceptDaemonChannel(daemon, new Uint8Array(32))).ok).toBe(false);
    const { phone, server } = await connected();
    expect(phone.channel.seal(new Uint8Array(MAX_FRAME_BYTES - 23))).toEqual({ ok: false, reason: 'frame exceeds 1MB' });
    expect(server.open(new Uint8Array(MAX_FRAME_BYTES + 1))).toEqual({ ok: false, reason: 'frame exceeds 1MB' });
    const frame = sealed(phone.channel, new Uint8Array(MAX_FRAME_BYTES - 24));
    expect(frame.length).toBe(MAX_FRAME_BYTES);
    expect(server.open(frame).ok).toBe(true);
  });
});
