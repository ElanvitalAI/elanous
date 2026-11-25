// ── SEAT-WORK-PULL 노크 배선 (OP #139787 · 0.3.35 P0) ──
// idle 주기 폴이 배선층(createSeatWorkPull — enqueueNotice+knock 원자 claim 결과 태움)을 부른다.
// 선례: wireCapsuleDoneKnock/wireShellWatchKnock — «노티스 enqueue → idleWakeDoor.knock(source)» 통일 패턴.
// 이 모듈은 폴 스케줄과 게이트만 책임진다:
//   ① SEAT-NOTICE-BOOT-RACE — 자리 사람의 첫 턴 전엔 pull 조차 부르지 않는다(boot-wake 가 그들의
//      첫 마디를 가로채는 사고 방지 — entry.ts queueIdleWatchdog 과 같은 규칙).
//   ② busy/claimed/no-work 해석은 배선층·유닛층이 이미 판정했다 — 여기서는 관측(로그)만.
//   ③ PULL-KNOCK-HAND-GATE (P0 11-25 «손이 일을 시작 안 함»): 손 자리는 레일·update-all 마다 재기동되고 사람이
//      치지 않으므로 ①만으로는 문이 영영 안 열린다(60분 45× skipped · 0 claim). 문은 셋 중 하나면 열린다 —
//      사람 턴 시작 · 부팅 뒤 어떤 턴(우편·노티스·내부)이든 끝남 · 손 자리이고 준비 뒤 90 s 동안 사람 키 입력 없음.
//      조율·리더·사람 주도 자리는 그대로 ①만(boot-race 보호 유지).
import { emitTurnLife } from '../debug/turn-life.js';

/** 손 자리 부팅 정착 창 — 준비(또는 마지막 사람 키) 뒤 이만큼 조용하면 사람이 없는 자리로 본다. */
export const HAND_BOOT_SETTLE_MS = 90_000;

export interface PullGateInput {
  readonly personTurnStarted: boolean;
  /** 부팅 뒤 어떤 턴이든(우편·노티스·내부) 한 번 끝났는지. */
  readonly turnCompletedSinceBoot: boolean;
  /** 손 자리(federation role hand · `<SPACE>-H-` 자리)인지 — 리더·조율·사람 주도 자리는 false. */
  readonly handSeat: boolean;
  /** TUI 준비 시각(ms epoch). */
  readonly readyAt: number;
  /** 마지막 사람 키 시각(ms epoch · 없으면 0). */
  readonly lastTypedAt: number;
  readonly now: number;
  readonly settleMs?: number;
}

export type PullGateVerdict =
  | { readonly open: true; readonly via: 'person-turn' | 'turn-completed' | 'hand-settled' }
  | { readonly open: false; readonly reason: 'person-turn-not-started' | 'hand-boot-settling' };

/** Pure: may the idle pull (and the boot-wake) open a turn on this seat now? */
export function pullGateOpen(input: PullGateInput): PullGateVerdict {
  if (input.personTurnStarted) return { open: true, via: 'person-turn' };
  if (input.turnCompletedSinceBoot) return { open: true, via: 'turn-completed' };
  if (!input.handSeat) return { open: false, reason: 'person-turn-not-started' };
  const quietSince = Math.max(input.readyAt, input.lastTypedAt);
  return input.now - quietSince >= (input.settleMs ?? HAND_BOOT_SETTLE_MS)
    ? { open: true, via: 'hand-settled' }
    : { open: false, reason: 'hand-boot-settling' };
}

/** 손 자리 판정 — `-H-` 이름 또는 federation.yaml role=hand. 선언이 리더·조율이면 false. 읽기 실패 = false(보호 쪽). */
export function isHandSeat(seat: string | null | undefined, declaredRoles: Readonly<Record<string, string>> = {}): boolean {
  const id = seat?.trim().toUpperCase();
  if (!id) return false;
  const role = declaredRoles[id]?.trim().toLowerCase();
  if (role !== undefined && role !== '') return role === 'hand';
  return id.includes('-H-');
}

export interface WorkPullKnockDeps {
  /** 배선층 pull — createSeatWorkPull()의 반환(busy→null · claimed→{claimed} · no-work→{noWork}). */
  readonly pull: () => { claimed: string; wip?: true } | { noWork: string } | null;
  /** SEAT-NOTICE-BOOT-RACE — 자리 사람의 첫 턴이 시작됐는지. false 면 부르지 않는다. */
  readonly personTurnStarted?: () => boolean;
  /** PULL-KNOCK-HAND-GATE — 있으면 personTurnStarted 대신 이 판정으로 연다(pullGateOpen). */
  readonly gate?: () => PullGateVerdict;
  /** 주기 스케줄러(주입형 — 시험 우주가 결정성을 준다). 기본 = 60 s setInterval. */
  readonly schedule?: (fire: () => void, intervalMs: number) => () => void;
  readonly intervalMs?: number;
  /** 관측 로그(주입형). 기본 = emitTurnLife(fail-open). */
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
}

function defaultSchedule(fire: () => void, intervalMs: number): () => void {
  const timer = setInterval(fire, intervalMs);
  return () => { clearInterval(timer); };
}

/** Returns the stop. */
export function wireWorkPullKnock(deps: WorkPullKnockDeps): () => void {
  const log = deps.log ?? ((event: string, data?: Record<string, unknown>) => { try { emitTurnLife(event, data ?? {}); } catch { /* observability is fail-open */ } });
  const fire = (): void => {
    if (deps.gate !== undefined) {
      const verdict = deps.gate();
      if (!verdict.open) { log('turn-life:work-pull-knock', { skipped: verdict.reason }); return; }
    } else if (deps.personTurnStarted !== undefined && !deps.personTurnStarted()) {
      log('turn-life:work-pull-knock', { skipped: 'person-turn-not-started' });
      return;
    }
    const out = deps.pull();
    if (out === null) { log('turn-life:work-pull-knock', { skipped: 'busy' }); return; }
    if ('claimed' in out) log('turn-life:work-pull-knock', out.wip ? { claimed: 'wip-continue', cell: out.claimed } : { claimed: out.claimed });
    else log('turn-life:work-pull-knock', { noWork: out.noWork });
  };
  const intervalMs = deps.intervalMs ?? 60_000;
  const stop = (deps.schedule ?? defaultSchedule)(fire, intervalMs);
  return () => { stop(); };
}
