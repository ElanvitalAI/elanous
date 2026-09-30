import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { acceptDaemonChannel, createPhoneChannel, generateDaemonKeyPair, serverIdFromPublicKey } from './channel.js';
import { MuxDecoder, MuxEncoder, MuxStreamState, type MuxFrame } from './mux.js';
import vectors from './test-vectors.json';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fromHex = (value: string) => new Uint8Array(Buffer.from(value, 'hex'));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function value<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

test('fixed relay handshake, deterministic nonce, encrypted frames and mux wire vectors regenerate byte-for-byte', async () => {
  await sodium.ready;
  const daemonSeed = fromHex(vectors.daemonSeedHex);
  const phoneSeed = fromHex(vectors.phoneSeedHex);
  const daemon = await generateDaemonKeyPair(daemonSeed);
  const phone = value(await createPhoneChannel(daemon.publicKey, daemon.publicKey, phoneSeed));
  const server = value(await acceptDaemonChannel(daemon, phone.phonePublicKey));
  const phonePair = sodium.crypto_kx_seed_keypair(phoneSeed);
  const keys = sodium.crypto_kx_client_session_keys(phonePair.publicKey, phonePair.privateKey, daemon.publicKey);
  const serverKeys = sodium.crypto_kx_server_session_keys(daemon.publicKey, daemon.secretKey, phone.phonePublicKey);
  expect(keys.sharedTx).toEqual(serverKeys.sharedRx);
  expect(keys.sharedRx).toEqual(serverKeys.sharedTx);
  expect(hex(daemon.publicKey)).toBe(vectors.daemonPublicKeyHex);
  expect(hex(phone.phonePublicKey)).toBe(vectors.phonePublicKeyHex);
  expect(serverIdFromPublicKey(daemon.publicKey)).toBe(vectors.serverId);
  expect(sha256(keys.sharedTx)).toBe(vectors.phoneToDaemonKeySha256);
  expect(sha256(keys.sharedRx)).toBe(vectors.daemonToPhoneKeySha256);
  expect(vectors.nonceHex).toBe('00'.repeat(24));

  const phoneStreams = new MuxStreamState();
  const daemonStreams = new MuxStreamState();
  const phoneEncoder = new MuxEncoder(phoneStreams);
  const phoneDecoder = new MuxDecoder(phoneStreams);
  const daemonEncoder = new MuxEncoder(daemonStreams);
  const daemonDecoder = new MuxDecoder(daemonStreams);
  const request = vectors.request as MuxFrame;
  const requestMux = value(phoneEncoder.encode(request));
  expect(hex(requestMux)).toBe(vectors.requestMuxHex);
  const requestEncrypted = value(phone.channel.seal(requestMux));
  expect(hex(requestEncrypted)).toBe(vectors.requestEncryptedHex);
  const requestNonce = new Uint8Array(24);
  requestNonce.set(requestEncrypted.subarray(0, 8), 16);
  expect(hex(requestNonce)).toBe(vectors.nonceHex);
  const receivedRequest = value(server.open(fromHex(vectors.requestEncryptedHex)));
  expect(receivedRequest).toEqual(requestMux);
  expect(daemonDecoder.decode(receivedRequest)).toEqual({ ok: true, value: request });

  const response: MuxFrame = { streamId: vectors.response.streamId, kind: 'data', data: fromHex(vectors.response.dataHex) };
  const responseMux = value(daemonEncoder.encode(response));
  expect(hex(responseMux)).toBe(vectors.responseMuxHex);
  const responseEncrypted = value(server.seal(responseMux));
  expect(hex(responseEncrypted)).toBe(vectors.responseEncryptedHex);
  const receivedResponse = value(phone.channel.open(fromHex(vectors.responseEncryptedHex)));
  expect(receivedResponse).toEqual(responseMux);
  expect(phoneDecoder.decode(receivedResponse)).toEqual({ ok: true, value: response });
});
