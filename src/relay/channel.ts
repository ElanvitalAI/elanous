import { createHash, timingSafeEqual } from 'node:crypto';
import sodium from 'libsodium-wrappers';

/** Maximum size of a complete encrypted frame, including sequence and MAC. */
export const MAX_FRAME_BYTES = 1024 * 1024;
const SEQUENCE_BYTES = 8;
const MAC_BYTES = 16;
const NONCE_BYTES = 24;
const MAX_SEQUENCE = (1n << 64n) - 1n;

export type ChannelResult<T> = { ok: true; value: T } | { ok: false; reason: string };
export interface DaemonKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}
export interface SerializedDaemonKeyPair {
  publicKey: string;
  secretKey: string;
}

function rejected<T>(reason: string): ChannelResult<T> {
  return { ok: false, reason };
}

function validKey(key: Uint8Array): boolean {
  return key instanceof Uint8Array && key.length === 32;
}

function equalKeys(left: Uint8Array, right: Uint8Array): boolean {
  return validKey(left) && validKey(right) && timingSafeEqual(left, right);
}

/** The daemon persists this pair; the phone creates a fresh pair per connection. */
export async function generateDaemonKeyPair(seed?: Uint8Array): Promise<DaemonKeyPair> {
  await sodium.ready;
  if (seed !== undefined && !validKey(seed)) throw new RangeError('X25519 seed must be 32 bytes');
  const pair = seed === undefined ? sodium.crypto_kx_keypair() : sodium.crypto_kx_seed_keypair(seed);
  return { publicKey: pair.publicKey, secretKey: pair.privateKey };
}

export function serverIdFromPublicKey(publicKey: Uint8Array): string {
  if (!validKey(publicKey)) throw new RangeError('X25519 public key must be 32 bytes');
  return createHash('sha256').update(publicKey).digest('hex');
}

export function serializeDaemonKeyPair(pair: DaemonKeyPair): SerializedDaemonKeyPair {
  if (!validKey(pair.publicKey) || !validKey(pair.secretKey)) throw new RangeError('invalid X25519 key pair');
  return { publicKey: Buffer.from(pair.publicKey).toString('base64'), secretKey: Buffer.from(pair.secretKey).toString('base64') };
}

export async function deserializeDaemonKeyPair(serialized: SerializedDaemonKeyPair): Promise<ChannelResult<DaemonKeyPair>> {
  await sodium.ready;
  if (typeof serialized?.publicKey !== 'string' || typeof serialized?.secretKey !== 'string' ||
      !/^[A-Za-z0-9+/]{43}=$/.test(serialized.publicKey) || !/^[A-Za-z0-9+/]{43}=$/.test(serialized.secretKey)) {
    return rejected('invalid daemon key serialization');
  }
  const publicKey = new Uint8Array(Buffer.from(serialized.publicKey, 'base64'));
  const secretKey = new Uint8Array(Buffer.from(serialized.secretKey, 'base64'));
  try {
    if (!validKey(publicKey) || !validKey(secretKey) ||
        !equalKeys(sodium.crypto_scalarmult_base(secretKey), publicKey)) {
      return rejected('invalid daemon key pair');
    }
  } catch {
    return rejected('invalid daemon key pair');
  }
  return { ok: true, value: { publicKey, secretKey } };
}

function sequenceBytes(sequence: bigint): Uint8Array {
  const bytes = new Uint8Array(SEQUENCE_BYTES);
  new DataView(bytes.buffer).setBigUint64(0, sequence, false);
  return bytes;
}

function nonceFor(sequence: bigint): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  nonce.set(sequenceBytes(sequence), NONCE_BYTES - SEQUENCE_BYTES);
  return nonce;
}

/** Each direction uses its own crypto_kx key and monotonically increasing sequence. */
export class EncryptedChannel {
  private sendSequence = 0n;
  private receiveSequence = 0n;
  private readonly sendKey: Uint8Array;
  private readonly receiveKey: Uint8Array;

  constructor(sendKey: Uint8Array, receiveKey: Uint8Array) {
    if (!validKey(sendKey) || !validKey(receiveKey)) throw new RangeError('invalid session keys');
    this.sendKey = new Uint8Array(sendKey);
    this.receiveKey = new Uint8Array(receiveKey);
  }

  seal(plaintext: Uint8Array): ChannelResult<Uint8Array> {
    if (!(plaintext instanceof Uint8Array)) return rejected('invalid plaintext');
    if (plaintext.length + SEQUENCE_BYTES + MAC_BYTES > MAX_FRAME_BYTES) return rejected('frame exceeds 1MB');
    if (this.sendSequence > MAX_SEQUENCE) return rejected('send sequence exhausted');
    const header = sequenceBytes(this.sendSequence);
    try {
      const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext, header, null, nonceFor(this.sendSequence), this.sendKey,
      );
      const frame = new Uint8Array(header.length + ciphertext.length);
      frame.set(header);
      frame.set(ciphertext, header.length);
      this.sendSequence++;
      return { ok: true, value: frame };
    } catch {
      return rejected('frame encryption failed');
    }
  }

  open(frame: Uint8Array): ChannelResult<Uint8Array> {
    if (!(frame instanceof Uint8Array) || frame.length < SEQUENCE_BYTES + MAC_BYTES) return rejected('invalid frame');
    if (frame.length > MAX_FRAME_BYTES) return rejected('frame exceeds 1MB');
    if (this.receiveSequence > MAX_SEQUENCE) return rejected('receive sequence exhausted');
    const sequence = new DataView(frame.buffer, frame.byteOffset, SEQUENCE_BYTES).getBigUint64(0, false);
    if (sequence < this.receiveSequence) return rejected('replayed frame');
    if (sequence > this.receiveSequence) return rejected('out-of-order frame');
    const header = frame.subarray(0, SEQUENCE_BYTES);
    try {
      const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, frame.subarray(SEQUENCE_BYTES), header, nonceFor(sequence), this.receiveKey,
      );
      this.receiveSequence++;
      return { ok: true, value: plaintext };
    } catch {
      return rejected('frame authentication failed');
    }
  }
}

export interface PhoneChannel {
  /** Sent to the daemon during handshake; the private key stays on the phone. */
  phonePublicKey: Uint8Array;
  serverId: string;
  channel: EncryptedChannel;
}

/** Pin the daemon's public key before deriving any traffic keys. */
export async function createPhoneChannel(
  daemonPublicKey: Uint8Array,
  expectedDaemonPublicKey: Uint8Array,
  phoneSeed?: Uint8Array,
): Promise<ChannelResult<PhoneChannel>> {
  await sodium.ready;
  if (!validKey(daemonPublicKey) || !equalKeys(daemonPublicKey, expectedDaemonPublicKey)) {
    return rejected('wrong daemon public key');
  }
  if (phoneSeed !== undefined && !validKey(phoneSeed)) return rejected('invalid phone seed');
  const phoneKeys = phoneSeed === undefined ? sodium.crypto_kx_keypair() : sodium.crypto_kx_seed_keypair(phoneSeed);
  try {
    const keys = sodium.crypto_kx_client_session_keys(phoneKeys.publicKey, phoneKeys.privateKey, daemonPublicKey);
    return { ok: true, value: {
      phonePublicKey: phoneKeys.publicKey,
      serverId: serverIdFromPublicKey(daemonPublicKey),
      channel: new EncryptedChannel(keys.sharedTx, keys.sharedRx),
    } };
  } catch {
    return rejected('invalid daemon public key');
  }
}

/** Called with the phone's ephemeral public key; crypto_kx supplies opposite Tx/Rx keys. */
export async function acceptDaemonChannel(
  daemonKeys: DaemonKeyPair,
  phonePublicKey: Uint8Array,
): Promise<ChannelResult<EncryptedChannel>> {
  await sodium.ready;
  if (!validKey(daemonKeys?.publicKey) || !validKey(daemonKeys?.secretKey)) {
    return rejected('invalid daemon key pair');
  }
  if (!validKey(phonePublicKey)) return rejected('invalid phone public key');
  try {
    if (!equalKeys(sodium.crypto_scalarmult_base(daemonKeys.secretKey), daemonKeys.publicKey)) {
      return rejected('invalid daemon key pair');
    }
    const keys = sodium.crypto_kx_server_session_keys(daemonKeys.publicKey, daemonKeys.secretKey, phonePublicKey);
    return { ok: true, value: new EncryptedChannel(keys.sharedTx, keys.sharedRx) };
  } catch {
    return rejected('invalid handshake key');
  }
}
