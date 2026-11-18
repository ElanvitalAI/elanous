/**
 * OBSERVE-TURN-EVENT-LIFECYCLE — 모든 `turn-life` 관측의 단일 진입점(계약은 TC §1.5 관측 지점 표).
 * 관측은 동작을 바꾸지 않는다: 이 호출이 던지면 삼키고 턴 생명주기는 그대로 간다.
 * deps/options 주입형 라이브러리 파일(queue.ts · next-wakeup.ts 등)은 이것을 직접 import 하지
 * 않고 선택 dep `turnLifeLog` 로 주입받는다(기본값 = emitTurnLife). 직접 쓰는 곳은 조립부뿐이다.
 */
import { debug } from './log.js';

/** 방출 형태: debug.log('turn-life', 'turn-life:<event>', data) — 사건 이름 리터럴이 event 인자에 통째로 들어간다. */
export function emitTurnLife(event: string, data: Record<string, unknown>): void {
  // observability is fail-open — a logging failure must never break the turn lifecycle.
  try { debug.log('turn-life', event, data); } catch { /* observability is fail-open */ }
}
