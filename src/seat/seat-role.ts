// SEAT-COORDINATOR-PROMPT-PROFILE (대표 11-22 «eln OP 믿고 맡길 조율자») — 자리의 «성격»을 구조화 값으로 정한다.
//
// 정본 = 자리 원장 `scripts/coord-tracks.json` 의 `role` 칸(`"coordinator"` = 조율 자리 · 없으면 손 자리).
// 자리 이름은 호출부가 이미 푼 자리 신원(detectSeat · seatTurnCap.seat)을 받는다 — 여기서 디렉터리 이름을 다시 읽지 않는다.
// 맞춤은 id 정확 일치만(옛 한 글자 alias·직함은 자리 신원이 아니다).
// 소비자: 시스템 프롬프트 조립(universal-preamble · repl) · 목표 루프 최종 보고 문면 · TUI 턴 라우팅(알림 턴).
import { registeredSeats, type SeatEntry } from '../seat-address/seat-address.js';

export type SeatRole = 'coordinator' | 'hand';

/** 원장에 있는 자리면 그 성격(`coordinator`|`hand`), 원장에 없는 자리·빈 값이면 null. */
export function seatRole(seat: string | null | undefined, seats: readonly SeatEntry[] = registeredSeats()): SeatRole | null {
  const id = seat?.trim().toUpperCase();
  if (!id) return null;
  const entry = seats.find((candidate) => candidate.id.toUpperCase() === id);
  if (!entry) return null;
  return entry.role === 'coordinator' ? 'coordinator' : 'hand';
}

/** 조율 자리(OP)인가. */
export function isCoordinatorSeat(seat: string | null | undefined, seats?: readonly SeatEntry[]): boolean {
  return seatRole(seat, seats) === 'coordinator';
}
