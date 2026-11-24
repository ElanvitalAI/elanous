// ── SEAT-WORK-PULL 노크 배선 (OP #139787 · 0.3.35 P0) ──
// idle 주기 폴이 배선층(createSeatWorkPull — enqueueNotice+knock 원자 claim 결과 태움)을 부른다.
// 선례: wireCapsuleDoneKnock/wireShellWatchKnock — «노티스 enqueue → idleWakeDoor.knock(source)» 통일 패턴.
// 이 모듈은 폴 스케줄과 게이트만 책임진다:
//   ① SEAT-NOTICE-BOOT-RACE — 자리 사람의 첫 턴 전엔 pull 조차 부르지 않는다(boot-wake 가 그들의
//      첫 마디를 가로채는 사고 방지 — entry.ts queueIdleWatchdog 과 같은 규칙).
//   ② busy/claimed/no-work 해석은 배선층·유닛층이 이미 판정했다 — 여기서는 관측(로그)만.
import { emitTurnLife } from '../debug/turn-life.js';

export interface WorkPullKnockDeps {
  /** 배선층 pull — createSeatWorkPull()의 반환(busy→null · claimed→{claimed} · no-work→{noWork}). */
  readonly pull: () => { claimed: string } | { noWork: string } | null;
  /** SEAT-NOTICE-BOOT-RACE — 자리 사람의 첫 턴이 시작됐는지. false 면 부르지 않는다. */
  readonly personTurnStarted?: () => boolean;
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
    if (deps.personTurnStarted !== undefined && !deps.personTurnStarted()) {
      log('turn-life:work-pull-knock', { skipped: 'person-turn-not-started' });
      return;
    }
    const out = deps.pull();
    if (out === null) { log('turn-life:work-pull-knock', { skipped: 'busy' }); return; }
    if ('claimed' in out) log('turn-life:work-pull-knock', { claimed: out.claimed });
    else log('turn-life:work-pull-knock', { noWork: out.noWork });
  };
  const intervalMs = deps.intervalMs ?? 60_000;
  const stop = (deps.schedule ?? defaultSchedule)(fire, intervalMs);
  return () => { stop(); };
}
