// ── BEDROCK-RUNTIME-PATH — AWS eventstream(`application/vnd.amazon.eventstream`) 디코더 (2026-10-11) ──
//
// `InvokeModelWithResponseStream` 의 응답은 SSE 가 아니라 AWS eventstream «이진 프레임»이다.
// 📏 레포에 `@smithy/eventstream-codec` 이 없다(rg · node_modules/@smithy 전수) ⇒ 의존성을 늘리지 않고 작은 디코더를 둔다.
//
// 프레임 꼴(빅엔디언):
//   [total length u32][headers length u32][prelude CRC32 u32][headers …][payload …][message CRC32 u32]
//   prelude CRC = 앞 8바이트의 CRC32 · message CRC = 마지막 4바이트를 뺀 전부의 CRC32.
// 헤더: [name len u8][name utf8][type u8][value …] — type 7(string)·6(bytes)은 u16 길이 접두.
//
// ⛔ CRC 가 안 맞거나 길이가 말이 안 되면 «조용히 건너뛰지 않고» 고정 이름의 에러로 멈춘다 —
//    깨진 프레임을 JSON 으로 읽어 반쪽 답을 내는 것보다 실패가 낫다.

/** 디코더 에러 — 고정 이름(`BedrockEventStreamError`). 메시지에 페이로드 원문을 싣지 않는다. */
export class BedrockEventStreamError extends Error {
  constructor(reason: string) {
    super(`Bedrock eventstream: ${reason}`);
    this.name = 'BedrockEventStreamError';
  }
}

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC32(IEEE 802.3 · zlib 과 같은 다항식). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type EventStreamHeaderValue = string | number | boolean | bigint | Uint8Array;

export interface EventStreamMessage {
  headers: Record<string, EventStreamHeaderValue>;
  payload: Uint8Array;
}

const PRELUDE = 12;
const MIN_FRAME = PRELUDE + 4;
/** 한 프레임 상한 — AWS 문서의 메시지 최대(16 MiB)와 같다. 넘으면 길이 칸이 깨진 것으로 본다. */
const MAX_FRAME = 16 * 1024 * 1024;

function decodeHeaders(bytes: Uint8Array): Record<string, EventStreamHeaderValue> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();
  const out: Record<string, EventStreamHeaderValue> = {};
  let i = 0;
  const need = (n: number) => { if (i + n > bytes.length) throw new BedrockEventStreamError('헤더가 잘렸다'); };
  while (i < bytes.length) {
    need(1);
    const nameLen = bytes[i]!; i += 1;
    need(nameLen);
    const name = text.decode(bytes.subarray(i, i + nameLen)); i += nameLen;
    need(1);
    const type = bytes[i]!; i += 1;
    switch (type) {
      case 0: out[name] = true; break;
      case 1: out[name] = false; break;
      case 2: need(1); out[name] = view.getInt8(i); i += 1; break;
      case 3: need(2); out[name] = view.getInt16(i); i += 2; break;
      case 4: need(4); out[name] = view.getInt32(i); i += 4; break;
      case 5: need(8); out[name] = view.getBigInt64(i); i += 8; break;
      case 6:
      case 7: {
        need(2);
        const len = view.getUint16(i); i += 2;
        need(len);
        const v = bytes.subarray(i, i + len); i += len;
        out[name] = type === 7 ? text.decode(v) : v.slice();
        break;
      }
      case 8: need(8); out[name] = view.getBigInt64(i); i += 8; break;
      case 9: need(16); out[name] = bytes.slice(i, i + 16); i += 16; break;
      default: throw new BedrockEventStreamError(`모르는 헤더 형식 ${type}`);
    }
  }
  return out;
}

/** 프레임 «하나»를 푼다(정확히 한 프레임 길이의 바이트). CRC 둘 다 검사한다. */
export function decodeEventStreamFrame(frame: Uint8Array): EventStreamMessage {
  if (frame.length < MIN_FRAME) throw new BedrockEventStreamError('프레임이 잘렸다');
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const total = view.getUint32(0);
  const headersLen = view.getUint32(4);
  if (total !== frame.length) throw new BedrockEventStreamError('프레임 길이가 맞지 않는다');
  if (view.getUint32(8) !== crc32(frame.subarray(0, 8))) throw new BedrockEventStreamError('prelude CRC 불일치');
  if (view.getUint32(total - 4) !== crc32(frame.subarray(0, total - 4))) throw new BedrockEventStreamError('message CRC 불일치');
  if (PRELUDE + headersLen > total - 4) throw new BedrockEventStreamError('헤더 길이가 프레임을 넘는다');
  const headers = decodeHeaders(frame.subarray(PRELUDE, PRELUDE + headersLen));
  const payload = frame.slice(PRELUDE + headersLen, total - 4);
  return { headers, payload };
}

/** 바이트 청크 스트림 → 프레임 스트림. 청크 경계가 프레임 경계와 무관해도 된다.
 *  스트림이 프레임 «중간»에서 끝나면 `프레임이 잘렸다` 로 멈춘다. */
export async function* decodeEventStream(
  chunks: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<EventStreamMessage, void, unknown> {
  let buf = new Uint8Array(0);
  const iterable: AsyncIterable<Uint8Array> = (chunks as ReadableStream<Uint8Array>).getReader
    ? readerIterable(chunks as ReadableStream<Uint8Array>)
    : (chunks as AsyncIterable<Uint8Array>);
  for await (const chunk of iterable) {
    if (!chunk || chunk.length === 0) continue;
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf, 0);
    next.set(chunk, buf.length);
    buf = next;
    while (buf.length >= PRELUDE) {
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const total = view.getUint32(0);
      if (total < MIN_FRAME || total > MAX_FRAME) throw new BedrockEventStreamError('프레임 길이 칸이 깨졌다');
      // 길이 칸을 믿기 «전»에 prelude CRC 부터 — 깨진 길이로 끝없이 기다리지 않게.
      if (view.getUint32(8) !== crc32(buf.subarray(0, 8))) throw new BedrockEventStreamError('prelude CRC 불일치');
      if (buf.length < total) break;
      yield decodeEventStreamFrame(buf.subarray(0, total));
      buf = buf.slice(total);
    }
  }
  if (buf.length > 0) throw new BedrockEventStreamError('프레임이 잘렸다');
}

async function* readerIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array, void, unknown> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** 시험·도구용 인코더 — 디코더의 거울(문자열 헤더만). 실 송신 경로에서는 쓰지 않는다. */
export function encodeEventStreamFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = enc.encode(name);
    const v = enc.encode(value);
    parts.push(n.length, ...n, 7, (v.length >> 8) & 0xff, v.length & 0xff, ...v);
  }
  const headerBytes = Uint8Array.from(parts);
  const total = PRELUDE + headerBytes.length + payload.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, headerBytes.length);
  view.setUint32(8, crc32(out.subarray(0, 8)));
  out.set(headerBytes, PRELUDE);
  out.set(payload, PRELUDE + headerBytes.length);
  view.setUint32(total - 4, crc32(out.subarray(0, total - 4)));
  return out;
}

/** 오류 문면 가림 seam — 호출자가 `redactAwsIdentifiers ∘ redactSecrets` 를 넘긴다(이 모듈은 의존 0). */
export type BedrockTextRedactor = (text: string) => string;

/** 고정 꼴의 예외 이름만 싣는다(`throttlingException` 등). 그 밖은 `UnknownException`. */
function safeExceptionType(v: unknown): string {
  return typeof v === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(v) ? v : 'UnknownException';
}

/** 스트림 «안»의 AWS 예외 프레임(`:message-type: exception`) — 고정 이름. */
export class BedrockRuntimeStreamError extends Error {
  readonly exceptionType: string;
  constructor(exceptionType: string, detail: string) {
    super(`Bedrock runtime stream ${exceptionType}${detail ? `: ${detail}` : ''}`);
    this.name = 'BedrockRuntimeStreamError';
    this.exceptionType = exceptionType;
  }
}

/**
 * runtime 응답 몸 → Anthropic SSE 꼴의 `data: <json>` 줄.
 * ⭐ 각 `chunk` 이벤트의 `{"bytes":"<base64>"}` 를 풀면 1st-party 와 같은 Anthropic 스트림 이벤트 JSON 이다 —
 *    줄로 바꿔 `parseAnthropicSSELines` 에 그대로 넣는다(사용량·도구·추론 파싱을 한 벌로 유지).
 */
export async function* bedrockRuntimeSseLines(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  redact: BedrockTextRedactor = (t) => t,
): AsyncGenerator<string, void, unknown> {
  const text = new TextDecoder();
  for await (const msg of decodeEventStream(body)) {
    const messageType = msg.headers[':message-type'];
    if (messageType === 'exception' || messageType === 'error') {
      const kind = safeExceptionType(msg.headers[':exception-type'] ?? msg.headers[':error-code']);
      let detail = '';
      try {
        const parsed = JSON.parse(text.decode(msg.payload)) as { message?: unknown; Message?: unknown };
        const m = parsed.message ?? parsed.Message;
        if (typeof m === 'string') detail = m;
      } catch { /* 본문 없음 */ }
      if (!detail && typeof msg.headers[':error-message'] === 'string') detail = msg.headers[':error-message'] as string;
      throw new BedrockRuntimeStreamError(kind, redact(detail).slice(0, 300));
    }
    if (messageType !== 'event' || msg.headers[':event-type'] !== 'chunk') continue;
    let b64: unknown;
    try { b64 = (JSON.parse(text.decode(msg.payload)) as { bytes?: unknown }).bytes; } catch { continue; }
    if (typeof b64 !== 'string' || !b64) continue;
    const json = Buffer.from(b64, 'base64').toString('utf8').trim();
    if (json) yield `data: ${json}`;
  }
}
