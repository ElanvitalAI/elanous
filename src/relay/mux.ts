import { MAX_FRAME_BYTES } from './channel.js';
import type { ChannelResult } from './channel.js';

export type MuxFrame =
  | { streamId: number; kind: 'open'; protocol: 'http'; method: string; path: string; headers: Record<string, string> }
  | { streamId: number; kind: 'open'; protocol: 'ws'; path: string; headers: Record<string, string> }
  | { streamId: number; kind: 'data'; data: Uint8Array }
  | { streamId: number; kind: 'close'; reason: string };

// u32 BE length (remaining bytes), u32 BE stream ID, u8 kind (1=open, 2=data, 3=close).
// Open: u8 protocol (1=http, 2=ws), [http: u16 method bytes + UTF-8 method],
// u32 path bytes + UTF-8 path, u16 header count, then u16 name bytes + UTF-8 name,
// u16 value bytes + UTF-8 value per header. Data: remaining raw bytes.
// Close: u16 reason bytes + UTF-8 reason. One frame per encrypted plaintext.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const HEADER_BYTES = 9;
// EncryptedChannel appends an 8-byte sequence and 16-byte MAC to each plaintext.
export const MAX_MUX_FRAME_BYTES = MAX_FRAME_BYTES - 24;

type Result<T> = ChannelResult<T>;
function reject<T>(reason: string): Result<T> { return { ok: false, reason }; }

class Writer {
  private parts: Uint8Array[] = [];
  length = 0;
  bytes(value: Uint8Array) { this.parts.push(value); this.length += value.length; }
  number(value: number, size: 1 | 2 | 4) {
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    if (size === 1) view.setUint8(0, value);
    else if (size === 2) view.setUint16(0, value, false);
    else view.setUint32(0, value, false);
    this.bytes(bytes);
  }
  text(value: string, size: 2 | 4): boolean {
    if (typeof value !== 'string') return false;
    const bytes = encoder.encode(value);
    if (bytes.length > (size === 2 ? 0xffff : 0xffffffff)) return false;
    this.number(bytes.length, size);
    this.bytes(bytes);
    return true;
  }
  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) { out.set(part, offset); offset += part.length; }
    return out;
  }
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  number(size: 1 | 2 | 4): number | undefined {
    if (this.offset + size > this.bytes.length) return undefined;
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, size);
    this.offset += size;
    return size === 1 ? view.getUint8(0) : size === 2 ? view.getUint16(0, false) : view.getUint32(0, false);
  }
  text(size: 2 | 4): string | undefined {
    const length = this.number(size);
    if (length === undefined || this.offset + length > this.bytes.length) return undefined;
    const bytes = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return decoder.decode(bytes);
  }
}

function validId(id: number): boolean { return Number.isInteger(id) && id >= 0 && id <= 0xffffffff; }

/** Share one instance between the encoder and decoder of a single endpoint. */
export class MuxStreamState {
  private readonly active = new Set<number>();

  isOpen(id: number): boolean { return this.active.has(id); }
  opened(id: number): void { this.active.add(id); }
  closed(id: number): void { this.active.delete(id); }
}

/** No network I/O; shares stream IDs with the receiving decoder when supplied a state. */
export class MuxEncoder {
  constructor(private readonly streams: MuxStreamState = new MuxStreamState()) {}

  encode(frame: MuxFrame): Result<Uint8Array> {
    if (!frame || !validId(frame.streamId)) return reject('invalid stream ID');
    if (frame.kind !== 'open' && frame.kind !== 'data' && frame.kind !== 'close') return reject('unknown frame kind');
    if (frame.kind === 'open' ? this.streams.isOpen(frame.streamId) : !this.streams.isOpen(frame.streamId)) {
      return reject(frame.kind === 'open' ? 'stream already open' : 'stream not open');
    }
    const writer = new Writer();
    writer.number(0, 4);
    writer.number(frame.streamId, 4);
    if (frame.kind === 'open') {
      writer.number(1, 1);
      if (frame.protocol !== 'http' && frame.protocol !== 'ws') return reject('unknown protocol');
      writer.number(frame.protocol === 'http' ? 1 : 2, 1);
      if (frame.protocol === 'http' && (!frame.method || !writer.text(frame.method, 2))) return reject('invalid method');
      if (!frame.path || !writer.text(frame.path, 4)) return reject('invalid path');
      if (!frame.headers || typeof frame.headers !== 'object' || Array.isArray(frame.headers)) return reject('invalid headers');
      const entries = Object.entries(frame.headers);
      if (entries.length > 0xffff) return reject('invalid headers');
      writer.number(entries.length, 2);
      for (const [name, value] of entries) {
        if (!name || !writer.text(name, 2) || !writer.text(value, 2)) return reject('invalid headers');
      }
    } else if (frame.kind === 'data') {
      if (!(frame.data instanceof Uint8Array)) return reject('invalid data');
      writer.number(2, 1);
      writer.bytes(frame.data);
    } else if (frame.kind === 'close') {
      writer.number(3, 1);
      if (!writer.text(frame.reason, 2)) return reject('invalid reason');
    }
    if (writer.length > MAX_MUX_FRAME_BYTES) return reject('frame exceeds 1MB');
    const out = writer.finish();
    new DataView(out.buffer).setUint32(0, out.length - 4, false);
    if (frame.kind === 'open') this.streams.opened(frame.streamId);
    if (frame.kind === 'close') this.streams.closed(frame.streamId);
    return { ok: true, value: out };
  }
}

/** Rejected frames never change stream state. Share state with the sending encoder per endpoint. */
export class MuxDecoder {
  constructor(private readonly streams: MuxStreamState = new MuxStreamState()) {}

  decode(bytes: Uint8Array): Result<MuxFrame> {
    if (!(bytes instanceof Uint8Array)) return reject('invalid frame');
    if (bytes.length > MAX_MUX_FRAME_BYTES) return reject('frame exceeds 1MB');
    if (bytes.length < HEADER_BYTES) return reject('truncated frame');
    const reader = new Reader(bytes);
    const length = reader.number(4)!;
    if (length !== bytes.length - 4) return reject(length > bytes.length - 4 ? 'truncated frame' : 'trailing frame bytes');
    const streamId = reader.number(4)!;
    const kind = reader.number(1)!;
    if (kind !== 1 && kind !== 2 && kind !== 3) return reject('unknown frame kind');
    if (kind === 1 ? this.streams.isOpen(streamId) : !this.streams.isOpen(streamId)) {
      return reject(kind === 1 ? 'stream already open' : 'stream not open');
    }
    try {
      let frame: MuxFrame;
      if (kind === 1) {
        const protocolByte = reader.number(1);
        if (protocolByte !== 1 && protocolByte !== 2) return reject(protocolByte === undefined ? 'truncated frame' : 'unknown protocol');
        const method = protocolByte === 1 ? reader.text(2) : undefined;
        if (protocolByte === 1 && method === undefined) return reject('truncated frame');
        const path = reader.text(4);
        const count = reader.number(2);
        if (path === undefined || count === undefined) return reject('truncated frame');
        if (!path || (protocolByte === 1 && !method)) return reject('invalid open frame');
        const entries: [string, string][] = [];
        const names = new Set<string>();
        for (let i = 0; i < count; i++) {
          const name = reader.text(2);
          const value = reader.text(2);
          if (name === undefined || value === undefined) return reject('truncated frame');
          if (!name || names.has(name)) return reject('invalid headers');
          names.add(name);
          entries.push([name, value]);
        }
        const headers = Object.fromEntries(entries);
        frame = protocolByte === 1
          ? { streamId, kind: 'open', protocol: 'http', method: method!, path, headers }
          : { streamId, kind: 'open', protocol: 'ws', path, headers };
      } else if (kind === 2) {
        frame = { streamId, kind: 'data', data: bytes.slice(reader.offset) };
        reader.offset = bytes.length;
      } else {
        const reason = reader.text(2);
        if (reason === undefined) return reject('truncated frame');
        frame = { streamId, kind: 'close', reason };
      }
      if (reader.offset !== bytes.length) return reject('trailing frame bytes');
      if (kind === 1) this.streams.opened(streamId);
      if (kind === 3) this.streams.closed(streamId);
      return { ok: true, value: frame };
    } catch {
      return reject('invalid UTF-8 frame');
    }
  }
}
