// ELN-SEAT-TURN-CAP-CONTINUE(OP P0 · 11-18 13:0x) — 자리 이름의 레지스트리 v2 runtime 을 실제로 읽는 리더.
//
// seat-turn-cap.ts 는 import 0(user-config 파서가 그 모듈을 가져다 쓴다 — 순환 없음)이라
// 리더를 파라미터(seatRegistryRuntime(seat, read))로 받는다. 실제 파일 읽기는 이 파일이 담당한다:
// <seat-state>/seat-registry.json(v1·v2 모두 v2 로 정규화해 읽음)에서 자리의 runtime 을 꺼낸다.
// 파일 없음·자리 없음·해석 실패 = undefined(= 운영 상한 그대로 — 상한이 자리 턴을 막아선 안 된다).
//
// 두 호출부: src/session/chat.ts(TUI goal loop) · src/acp/core-turn-bridge.ts(harness seat route).

import { readSeatRegistryV2, seatRegistryPath, seatRegistryV2Entry } from '../loops/seat-registry.js';
import { resolveSeatStateRoot } from '../loops/msg-wake.js';

export interface ReadSeatRuntimeDeps {
  /** 레지스트리 파일 경로 재정의(시험). 기본 = <seat-state>/seat-registry.json. */
  registryPath?: string;
}

/** 자리 이름의 레지스트리 runtime('eln' | 'external-cli' | 'human'). 읽기가 안 되면 undefined. */
export function readSeatRuntime(seat: string, deps: ReadSeatRuntimeDeps = {}): string | undefined {
  const path = deps.registryPath ?? seatRegistryPath(resolveSeatStateRoot());
  const read = readSeatRegistryV2(path);
  if (read.status !== 'ready') return undefined;
  return seatRegistryV2Entry(read.registry, seat)?.runtime;
}
