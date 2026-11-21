import { afterEach, expect, test } from 'bun:test';
import { randomId } from './random-id';

// 출처: #39459 WEBCHAT-REJECTED-TOKEN-NO-CRASH — randomId 는 insecure 원점의
// 렌더 throw 를 기존 대체 id 경로(daemon-session generateSessionId)로 수리하는
// 위임 헬퍼의 계약(OP #122939). g8 실화면 근거는 lib/random-id.ts 머리 주석 참조.

// 대체 id 형식 — 레거시 지속본 `s-<ts36>-<rand ≤16자>` · 수리본 `s-<ts36>-<hex64>`
// (hex 16자 ⊆ base36 ≤16자 — 기존 정책 정규식 {1,16} 그대로 통과 · OP #123699 서버 변경 0)
const FALLBACK_ID = /^s-[0-9a-z]+-[0-9a-z]{1,16}$/;

const savedCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
// 진짜 원문 getRandomValues — crypto 를 통째로 바꾼 뒤에도 원문 계약을 잴 수 있게.
const realGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);

function withCrypto(value: unknown): void {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true });
}

// OP 결정 #123699 — 대체 경로는 Math.random 을 0번 쓴다: 스파이가 호출 수를 세고 0을 단언.
function spyMathRandom(): { restore(): void; calls(): number } {
  let calls = 0;
  const original = Math.random;
  Math.random = () => { calls += 1; return original(); };
  return { restore: () => { Math.random = original; }, calls: () => calls };
}

afterEach(() => {
  if (savedCrypto) Object.defineProperty(globalThis, 'crypto', savedCrypto);
  else delete (globalThis as { crypto?: unknown }).crypto;
});

test('randomUUID 있으면(secure context) 그대로 쓴다', () => {
  let calls = 0;
  withCrypto({
    randomUUID: () => { calls += 1; return '11111111-2222-4333-8444-555555555555'; },
  });
  expect(randomId()).toBe('11111111-2222-4333-8444-555555555555');
  expect(calls).toBe(1);
});

test('randomUUID 없으면(insecure context) 대체 id(s-<ts36>-<hex64>) 폴백', () => {
  // http://<LAN-IP>:<port> 원점 — randomUUID 는 secure context 전용이라 부재.
  // getRandomValues 는 비보안 원점에도 있다(OP #123577/#123699).
  withCrypto({ getRandomValues: realGetRandomValues });
  const spy = spyMathRandom();
  try {
    for (let i = 0; i < 100; i++) {
      expect(FALLBACK_ID.test(randomId())).toBe(true);
    }
  } finally { spy.restore(); }
  expect(spy.calls()).toBe(0); // 출처: #39459 OP #123699 — 대체 경로 Math.random 0번
});

// 출처: #39459 JUD HOLD #123572(OP #123577) · OP 결정 #123699 — 폴백 난수 원천 계약.
// Math.random 폴백은 seatAskClientId(응답 조회·ack 분리 키)·session owner 로 쓰여
// 추측 가능했다 → 대체 경로는 crypto.getRandomValues(비보안 원점에도 있음) 64bit만 쓴다.
test('폴백 난수는 crypto.getRandomValues 원문을 그대로 쓴다(64bit hex — Math.random 0)', () => {
  let calls = 0;
  withCrypto({
    getRandomValues: (buf: Uint8Array) => { calls += 1; buf.fill(0); return buf; },
  });
  const spy = spyMathRandom();
  let id = '';
  try { id = randomId(); } finally { spy.restore(); }
  expect(calls).toBe(1); // 출처: #39459 HOLD #123572/#123699 — getRandomValues 정확히 1회(8바이트=64bit)
  // 8바이트 전부 0 → hex 16자 전부 '0' — getRandomValues 원문 그대로(Math.random 로는 불가).
  expect(id).toMatch(/^s-[0-9a-z]+-0{16}$/);
  expect(spy.calls()).toBe(0); // 출처: #39459 OP #123699 — Math.random 0번
});

test('crypto 자체가 없으면(SSR 모양) throw — Math.random 탈출 없음', () => {
  // OP #123699 — crypto 부재 폴백도 Math.random 을 쓰지 않는다: throw 하고
  // 상위 렌더는 ChatErrorBoundary(#39459)가 잡는다.
  delete (globalThis as { crypto?: unknown }).crypto;
  const spy = spyMathRandom();
  try {
    expect(() => randomId()).toThrow();
  } finally { spy.restore(); }
  expect(spy.calls()).toBe(0); // 출처: #39459 OP #123699 — Math.random 0번
});

test('폴백은 연속 호출마다 다른 값을 낸다(충돌 스모크)', () => {
  withCrypto({ getRandomValues: realGetRandomValues });
  const spy = spyMathRandom();
  const seen = new Set<string>();
  try {
    for (let i = 0; i < 200; i++) seen.add(randomId());
  } finally { spy.restore(); }
  // 200 연속 호출 충돌 스모크 — 64bit crypto 난수면 전부 유일해야 계약 충분(OP #123699).
  expect(seen.size).toBe(200); // 출처: #39459 OP #123699 — 실 getRandomValues 200/200 유일
  expect(spy.calls()).toBe(0); // 출처: #39459 OP #123699 — Math.random 0번
});