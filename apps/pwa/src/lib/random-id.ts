// 출처: #39459 WEBCHAT-REJECTED-TOKEN-NO-CRASH — `crypto.randomUUID` 는 secure
// context(https·localhost) 전용이라 http://<LAN-IP>:<port> 원점(테스트 우주 ·
// 랜 배포)에서는 함수 자체가 없다. 챗 런타임이 렌더 중 이 함수를 만나면
// TypeError → React #520/#321 캐스케이드 → 잡히지 않은 throw 로 Next 전역
// «Application error» 가 났다(2026-11-21 g8 실화면 · evidence/20261121/
// testverse-g8-live/RESULT-r3.md — `Uncaught TypeError: crypto.randomUUID
// is not a function`). 이 헬퍼는 그 지점의 근본 수리: 챗 전면의 직접
// randomUUID 호출을 기존 대체 id 경로로 위임한다(OP #122939 결정) —
// daemon-session.ts generateSessionId 가 randomUUID 를 갖춘 원점에서는
// 그대로 쓰고, 없는(insecure) 원점에서는 `s-<ts36>-<hex64>`(crypto.getRandomValues
// 64bit — HOLD #123572 · OP #123699) 폴백을 낸다.

import { generateSessionId } from './daemon-session';

/** 기존 대체 id 경로 위임(OP #122939) — randomUUID 있으면 그대로, 없으면 s-<ts36>-<rand36>. */
export function randomId(): string {
  return generateSessionId();
}