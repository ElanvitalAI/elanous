/** 원장 조회 경로(`/v1/loops/edges?ref=`)를 만드는 `loop-activity-map.ts` 의 ID 판정을 그대로 쓴다 — 화면과 원장의 검증 규칙을 하나로 묶는다. */
import { isValidRef } from '@/components/inside/loop-activity-map';

/** `/inside` 화면과 원장이 같은 루프 ID 를 보게 하는 진입 계약 — page.tsx 가 children(InsidePage) 호출부에 싣는다. */
export type LoopInteraction = {
  /** 고른 루프를 담는 주소 파라미터 이름. */
  refParam: string;
};

export const INSIDE_LOOP_INTERACTION: LoopInteraction = { refParam: 'ref' };

/** 화면이 읽을 수 있는 최소 표면 — URLSearchParams 와 같은 모양이면 무엇이든 받는다. */
export type LoopFocusSearch = { get(name: string): string | null };

/** 장면 헤더가 고정 루프를 표시할 때 쓰는 문구 — 화면 표시와 원장 기록이 같은 루프 ID 를 쓰는지 함께 잰다. */
export function loopFocusLabel(ref: string): string {
  return `루프 ${ref}`;
}

/**
 * `/inside?ref=<loop id>` — 루프 에이전트 장면에서 조율 루프 하나를 고정해 여는 조작.
 * 화면 상태(고정 루프 표시)와 원장 조회(`/v1/loops/edges?ref=<루프 id>&mode=live`)가 같은 루프 ID 를 쓴다.
 * 모양이 루프 ID 가 아니면 `null`(선택 없음) 로 떨어뜨려 기본 화면을 그대로 둔다.
 */
export function loopFocusRef(search: LoopFocusSearch | null | undefined, refParam: string = INSIDE_LOOP_INTERACTION.refParam): string | null {
  if (refParam.length === 0) return null;
  const value = search?.get(refParam) ?? null;
  if (value === null) return null;
  const trimmed = value.trim();
  return isValidRef(trimmed) ? trimmed : null;
}
