// ELS 마이그레이션 문(OP #95740 ③) — 탭 메뉴 migrate/stop 액션을 els 컨트롤 문 경유로만 실행한다.
// #38854 계약: stop 액션은 mode(migrate|quit|force) 필수 · mode 누락은 default deny 로 거부 · 문 우회 0.

import type { TabMenuActionSpec } from './tab-badge.js';

/** 문 요청 — SeatControlInput 에서 principal(문 클라이언트가 첨부)과 text 를 뺀 순수 요청 형태. */
export interface DoorRequest {
  readonly action: string;
  readonly target: { readonly workspace: string; readonly pane: string };
  readonly mode?: string;
}

export type DoorOutcome =
  | { readonly ok: true; readonly request: DoorRequest }
  | { readonly ok: false; readonly refuse: string };

/** 탭 메뉴 액션 스펙 → 문 요청 사상. stop 계열은 mode 필수(누락 거부), local 액션은 문 요청 없음. */
export function tabMenuDoorRequest(spec: TabMenuActionSpec, workspace: string): DoorOutcome {
  if (spec.via !== 'door') return { ok: false, refuse: `tab menu ${spec.action}: local 액션 — 문 요청이 없음(우회 금지)` };
  if (spec.doorOp === 'stop') {
    if (spec.doorMode === undefined) return { ok: false, refuse: 'stop 문 요청은 mode(migrate|quit|force) 필수 — mode 누락은 문이 거부(default deny)' };
    return { ok: true, request: { action: 'stop', target: { workspace, pane: `seat:${workspace}` }, mode: spec.doorMode } };
  }
  return { ok: true, request: { action: spec.doorOp, target: { workspace, pane: `seat:${workspace}` } } };
}

export interface DoorSendDeps {
  /** 문 클라이언트의 발송 의존 — 요청을 문(procincipal 첨부·규칙·감사는 문 안에서)으로 보낸다. */
  readonly send: (request: DoorRequest) => Promise<string>;
}

/** 탭 메뉴 액션 실행 — 문 경유 스펙만 deps.send 로 발송한다. 거부 사유는 예외로, 발송은 일어나지 않는다. */
export async function runTabMenuDoorAction(spec: TabMenuActionSpec, workspace: string, deps: DoorSendDeps): Promise<string> {
  const outcome = tabMenuDoorRequest(spec, workspace);
  if (!outcome.ok) throw new Error(`els migrate-door: ${outcome.refuse}`);
  return deps.send(outcome.request);
}
