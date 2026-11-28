// ALLOCATION-BUDGET budget advisor (수호자 · LLM 0 rules; a voice may only explain) — CEO 11-27 11:2x: metering exists so we
// can decide «클라우드 VM 더 투입 / 고장 난 자원 수리 / LLM 추가 크레딧 구입 / 정책적으로 구현 대신 리뷰·정비 시간».
// From metering ⊕ capacity ⊕ queues it proposes, each with expected effect and cost:
//   vm         add a burst VM — only when every reachable local host is saturated and the queue is full
//   repair     an unhealthy host / account / route — owner ⊕ action
//   topup      buy credits — provider · amount · why · runway
//   mode       shift to 정비 모드 (LLM budget tight or landing is the bottleneck) / back to 구현 모드 (capacity free)
//   rebalance  one identity holds more than its share of a scarce account
// Routing: money / irreversible → a CEO decision card (`decisions raise`, options ⊕ recommendation); in-policy moves → the
// guardian executes and reports in the 30-min digest.
import type { AllocBudgetPolicy } from './alloc-events.js';
import { topConsumers, providerOf, since, type AllocRow, type BudgetView } from './fold.js';

export interface AdvisorHost { readonly host: string; readonly reachable: boolean; readonly load1: number | null; readonly ncpu: number | null; readonly paid?: boolean; readonly why?: string }
export interface AdvisorQueues { readonly landQueue: number; readonly readyCells: number; readonly judgeQueue: number; readonly handsIdle: number }
export interface AdvisorRoute { readonly id: string; readonly healthy: boolean; readonly owner: string; readonly why: string }
export interface AdvisorAccount { readonly provider: string; readonly account: string; readonly status: string }
export interface AdvisorInput {
  readonly budget: BudgetView; readonly rows: readonly AllocRow[]; readonly policy: AllocBudgetPolicy;
  readonly hosts: readonly AdvisorHost[]; readonly queues: AdvisorQueues | null; readonly routes?: readonly AdvisorRoute[]; readonly accounts?: readonly AdvisorAccount[];
  readonly now: Date;
}
export type ProposalKind = 'vm' | 'repair' | 'topup' | 'mode' | 'rebalance';
export interface Proposal {
  readonly id: string; readonly kind: ProposalKind; readonly route: 'ceo' | 'guardian'; readonly title: string; readonly why: string;
  readonly effect: string; readonly costUsd: number | null; readonly options: readonly { key: string; label: string; consequence: string }[]; readonly recommend: string;
}

/** Saturated = load per core at or above this (= guardian policy host_load_per_cpu_max · graphs/loop-agents/guardian/agent.yaml). */
export const SATURATED_RATIO = 1.0;
/** «Queue full» = ready cells ⊕ land queue at least this. */
export const QUEUE_FULL = 6;
export const BURST_BLOCK_H = 2;
/** Buy credits when the prepaid runway at today's burn is shorter than this. */
export const RUNWAY_MIN_H = 48;

const ratio = (h: AdvisorHost) => (h.load1 !== null && h.ncpu ? h.load1 / h.ncpu : null);
const r1 = (n: number) => Math.round(n * 10) / 10;

export function adviseBudget(input: AdvisorInput): Proposal[] {
  const out: Proposal[] = [];
  const { budget, policy, queues } = input;
  const local = input.hosts.filter(h => !h.paid);
  const reachableLocal = local.filter(h => h.reachable && ratio(h) !== null);
  // (b) repair — unreachable hosts · errored accounts · unhealthy routes
  for (const h of local.filter(x => !x.reachable)) {
    out.push({ id: `repair:host:${h.host}`, kind: 'repair', route: 'guardian', title: `${h.host} 복구 (도달 불가)`, why: h.why ?? 'probe failed',
      effect: `${h.host} 용량 회수 — 로컬 ${reachableLocal.length}/${local.length} → ${reachableLocal.length + 1}/${local.length}`, costUsd: 0,
      options: [{ key: 'a', label: '임대관 진단·재기동', consequence: 'ssh·서비스 재기동 · 실패면 RES-INFRA 우편' }, { key: 'b', label: '보류', consequence: '용량 그대로' }], recommend: 'a' });
  }
  for (const a of (input.accounts ?? []).filter(x => x.status === 'error')) {
    out.push({ id: `repair:account:${a.provider}:${a.account}`, kind: 'repair', route: 'guardian', title: `${a.provider}:${a.account} 자격 복구`, why: '잔량 조회 오류 (토큰 만료·재로그인 필요 추정)',
      effect: `${a.provider} 계정 다시 할당 가능`, costUsd: 0,
      options: [{ key: 'a', label: '연료관 재로그인 시도', consequence: '실패면 OP 에 재로그인 요청' }, { key: 'b', label: '보류', consequence: '그 계정 할당 0' }], recommend: 'a' });
  }
  for (const r of (input.routes ?? []).filter(x => !x.healthy)) {
    out.push({ id: `repair:route:${r.id}`, kind: 'repair', route: 'guardian', title: `경로 ${r.id} 수리`, why: r.why, effect: `${r.id} 로 가는 할당 정상화 (주인 ${r.owner})`, costUsd: 0,
      options: [{ key: 'a', label: `${r.owner} 에 수리 배정`, consequence: '수리 전까지 다른 경로로 강등' }, { key: 'b', label: '보류', consequence: '강등 유지' }], recommend: 'a' });
  }
  // (a) burst VM — local saturated AND queue full; never while a local host has headroom
  if (queues) {
    const backlog = queues.readyCells + queues.landQueue;
    // Every reachable local host must be measured AND saturated — an unmeasured one may have room (no paid VM on a guess).
    const reachable = local.filter(h => h.reachable);
    const saturated = reachable.length > 0 && reachable.every(h => ratio(h) !== null && ratio(h)! >= SATURATED_RATIO);
    if (saturated && backlog >= QUEUE_FULL) {
      const paid = input.hosts.filter(h => h.paid);
      const pick = paid.find(h => !h.reachable) ?? paid[0];
      const vm = pick?.host ?? 'burst';
      const hourly = policy.vmHourlyUsd?.[vm];
      const cost = hourly !== undefined ? r1(hourly * BURST_BLOCK_H) : null;
      out.push({ id: `vm:${vm}`, kind: 'vm', route: 'ceo', title: `버스트 VM ${vm} ${BURST_BLOCK_H}h 투입`,
        why: `로컬 ${reachableLocal.map(h => `${h.host} ${r1(ratio(h)!)}`).join(' · ')} 포화 · 대기 ${backlog} (준비 ${queues.readyCells} · 착지 ${queues.landQueue})`,
        effect: `대기 ${backlog} 소화 가속 · ${BURST_BLOCK_H}h 뒤 자동 정지`, costUsd: cost,
        options: [{ key: 'a', label: `${vm} ${BURST_BLOCK_H}h 기동`, consequence: cost !== null ? `약 $${cost}` : '$ 미상 (정책 vmHourlyUsd 없음)' },
          { key: 'b', label: '로컬만으로 대기', consequence: `대기 ${backlog} 그대로` }], recommend: 'a' });
    }
  }
  // (c) top-up — prepaid runway at today's burn
  const bal = budget.openRouterBalanceUsd;
  const or = budget.rows.find(r => r.provider === 'openrouter');
  if (bal !== null && or) {
    const burn = Math.max(or.burnUsdPerHour, or.todayUsd / Math.max(1, hoursIntoKstDay(input.now)));
    const runwayH = burn > 0 ? bal / burn : Infinity;
    if (bal <= 0 || runwayH < RUNWAY_MIN_H) {
      const amount = Math.max(100, Math.ceil(((or.dailyUsd ?? policy.paidDailyCapUsd) * 7) / 50) * 50);
      out.push({ id: 'topup:openrouter', kind: 'topup', route: 'ceo', title: `OpenRouter 크레딧 $${amount} 충전`,
        why: bal <= 0 ? '잔액 0 — 바닥 사다리(glm) 사라짐' : `잔액 $${r1(bal)} · 소진 속도 $${r1(burn)}/h → 남은 ${r1(runwayH)}h < ${RUNWAY_MIN_H}h`,
        effect: `${burn > 0 ? `약 ${r1((bal + amount) / burn / 24)}일` : '여유'} 운행`, costUsd: amount,
        options: [{ key: 'a', label: `$${amount} 충전`, consequence: '자동 충전 유지' }, { key: 'b', label: '충전 안 함', consequence: '유료 단계 강등·대기 증가' }], recommend: 'a' });
    }
  }
  // (d) mode shift
  const tight = budget.rows.filter(r => r.usedPct !== null && r.capPct !== null && r.usedPct >= policy.scarceAtPct);
  const known = budget.rows.filter(r => r.usedPct !== null && r.capPct !== null);
  const llmTight = (known.length > 0 && tight.length * 2 >= known.length) || budget.paidAlert !== null;
  const landBottleneck = !!queues && queues.landQueue + queues.judgeQueue >= QUEUE_FULL && queues.landQueue + queues.judgeQueue >= 2 * Math.max(1, queues.readyCells);
  const mode = policy.mode ?? 'build';
  if (mode === 'build' && (llmTight || landBottleneck)) {
    out.push({ id: 'mode:maintenance', kind: 'mode', route: 'guardian', title: '정비 모드로 전환',
      why: [llmTight ? `LLM 빠듯 (${tight.map(r => `${r.provider} ${Math.round(r.usedPct!)}%`).join(' · ') || budget.paidAlert})` : '', landBottleneck ? `착지가 병목 (착지 ${queues!.landQueue} · 판정 ${queues!.judgeQueue} vs 준비 ${queues!.readyCells})` : ''].filter(Boolean).join(' · '),
      effect: '리뷰·판정·마무리·정비 칸 먼저 · 새 구현 멈춤 → 착지 대기 감소·토큰 절약', costUsd: 0,
      options: [{ key: 'a', label: '정비 모드', consequence: '새 구현 발사 멈춤 · 리뷰/판정 우선' }, { key: 'b', label: '구현 모드 유지', consequence: '대기·소진 계속' }], recommend: 'a' });
  } else if (mode === 'maintenance' && !llmTight && !landBottleneck && (!queues || queues.handsIdle > 0)) {
    out.push({ id: 'mode:build', kind: 'mode', route: 'guardian', title: '구현 모드로 복귀', why: `용량 여유 (LLM 희소 ${tight.length}/${known.length} · 착지 ${queues?.landQueue ?? '?'} · 쉬는 손 ${queues?.handsIdle ?? '?'})`,
      effect: '새 구현 발사 재개', costUsd: 0,
      options: [{ key: 'a', label: '구현 모드', consequence: '새 구현 재개' }, { key: 'b', label: '정비 유지', consequence: '구현 멈춤 계속' }], recommend: 'a' });
  }
  // (e) rebalance — one identity over its share of a scarce account
  const day = since(input.rows, input.now.getTime() - 24 * 3_600_000);
  for (const r of tight) {
    const top = topConsumers(day.filter(x => providerOf(x) === r.provider), policy)[0];
    if (top && top.key !== 'unattributed' && top.share * 100 > policy.seatShareMaxPct && top.grants >= 3) {
      out.push({ id: `rebalance:${r.provider}:${top.key}`, kind: 'rebalance', route: 'guardian', title: `${r.provider} 몫 재배분 — ${top.key}`,
        why: `${top.key} 가 희소 ${r.provider}(${Math.round(r.usedPct!)}%) 의 ${Math.round(top.share * 100)}% > ${policy.seatShareMaxPct}%`,
        effect: `${top.key} 새 요청은 ${policy.providers[r.provider]?.stepDownTo ?? '대기'} 로 · 다른 자리 몫 확보`, costUsd: 0,
        options: [{ key: 'a', label: '몫 상한 적용', consequence: '할당기가 이미 강등 — 보고만' }, { key: 'b', label: '예외 허용', consequence: '그 자리 계속 독점' }], recommend: 'a' });
    }
  }
  return out;
}

const hoursIntoKstDay = (now: Date) => ((now.getUTCHours() + 9) % 24) + now.getUTCMinutes() / 60;

/** A CEO decision card for a money / irreversible proposal (dedup ref = alloc-advice:<id>:<KST day>). */
export function proposalCard(p: Proposal, day: string): { title: string; category: 'money'; scqa: { s: string; c: string; q: string; a: string }; options: Proposal['options']; recommendation: { option: string; why: string }; raisedBy: { agent: string }; refs: string[] } {
  return { title: p.title, category: 'money', scqa: { s: p.why, c: `예상 효과: ${p.effect}`, q: `${p.title} — 할까요?`, a: `추천 ${p.recommend}${p.costUsd !== null ? ` · 비용 약 $${p.costUsd}` : ''}` },
    options: p.options, recommendation: { option: p.recommend, why: p.effect }, raisedBy: { agent: 'loop:guardian' }, refs: [`alloc-advice:${p.id}:${day}`] };
}
