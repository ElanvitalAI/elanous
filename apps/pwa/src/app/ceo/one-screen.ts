/**
 * 대표 조망판 «한 화면 답» — 이미 읽어 온 원천만으로
 * «지금 무엇이 막혔고 무엇을 결정해야 하나»를 한 줄씩 만든다.
 *
 * 새 네트워크 읽기를 만들지 않는다. 못 읽은 원천은 «못 잼»으로 남기고 0 과 섞지 않는다.
 * 판정 어휘·신선도 계약은 overview-strip.ts 가 정본이므로 여기서 다시 만들지 않는다.
 */

import type { GridData } from '../../../../../src/nexus/api/grid';

export type OneScreenFlow = { label: string; reason?: string | null };
export type OneScreenRisk = { kind: string; title: string };
/** /v1/grid 응답 그대로 — 여기서 새 형태를 만들지 않는다(원천 계약 보존). */
export type OneScreenGrid = Pick<GridData, 'hq' | 'members' | 'poolReason'>;

export type OneScreenInput = {
  flow: OneScreenFlow | null | undefined;
  release: { green: number; yellow: number } | null | undefined;
  decisions: number | null | undefined;
  merged: number | null | undefined;
  risks: OneScreenRisk[] | null | undefined;
  grid: OneScreenGrid | null | undefined;
};

export type OneScreenAnswer = {
  blocked: string;
  decide: string;
  landed: string;
  spare: string;
  heartbeat: string;
  release: string;
};

export const UNMEASURED = '못 잼';
export const LOADING = '불러오는 중…';

export function heartbeatText(ageSeconds: number | null | undefined): string {
  if (ageSeconds === null || ageSeconds === undefined || !Number.isFinite(ageSeconds) || ageSeconds < 0) return UNMEASURED;
  const seconds = Math.round(ageSeconds);
  return seconds < 60 ? `${seconds}초 전` : `${Math.floor(seconds / 60)}분 전`;
}

/** 예비 = 아직 차지 않았고 «사용 가능한» 칸. 하나라도 측정 불가면 값을 만들지 않는다. */
export function spareSlots(grid: OneScreenGrid | null | undefined): number | null {
  if (!grid || grid.poolReason || grid.members.length === 0) return null;
  if (grid.members.some((member) => member.occupied === null)) return null;
  return grid.members.reduce((sum, member) => sum + Math.max(0, member.capacity - (member.occupied as number)), 0);
}

export function oneScreenAnswer(input: OneScreenInput): OneScreenAnswer {
  const flow = input.flow === undefined ? LOADING
    : input.flow === null ? UNMEASURED
      : `${input.flow.label}${input.flow.reason ? ` · ${input.flow.reason}` : ''}`;
  const top = input.risks === undefined ? LOADING
    : input.risks === null ? UNMEASURED
      : input.risks.length === 0 ? '해당 없음'
        : `${input.risks[0]!.kind} · ${input.risks[0]!.title}`;
  const spare = input.grid === undefined ? null : spareSlots(input.grid);
  return {
    blocked: `${flow} / 톱 ${top}`,
    decide: input.decisions === undefined ? LOADING : input.decisions === null ? UNMEASURED : `결정 대기 ${input.decisions}건`,
    landed: input.merged === undefined ? LOADING : input.merged === null ? UNMEASURED : `${input.merged}건`,
    spare: input.grid === undefined ? LOADING : spare === null ? UNMEASURED : `${spare}칸`,
    heartbeat: input.grid === undefined ? LOADING : heartbeatText(input.grid?.hq.ageSeconds),
    release: input.release === undefined ? LOADING : input.release === null ? UNMEASURED
      : `green ${input.release.green} · 노랑 ${input.release.yellow}`,
  };
}
