// `eln llm policy` — LLM 지출 정책 한 장 조회(적용 값 전부 · 출처 default/stored · 주입된 상태만) (ONE-SHOT)
//
// 대표 07:3x: 같은 결정 함수·같은 조회를 API 로 — CLI 와 화면 값이 같다(정본 하나). 이 명령은
//   넥서스 데이터 영역의 «한 벌» 정책을 «읽기만» 한다:
//   · 적용된 정책 전부 = 코드 기본 + 저장 덮어씀(없는 키 = 코드 기본값).
//   · 각 값 출처 표기: [default] / [stored] — 판정자가 어느 잎이 저장 덮어씀인지 바로 본다.
//   · 공급자 상태는 «주입된 것만» — 이 PR 에는 아무것도 주입하지 않는다(CC-1 읽기·쿼터 신호 칸이
//     나중에 readAppliedSpendPolicy({states}) 로 넣는다). 없으면 unmeasured 로 표기.
//   · 비밀 값 0 — 정책 문서에는 애초에 금고 «이름» 만 있다(vault 칼럼).
//   ⛔ 편집 노출 0: 쓰기는 «패널» 칸(넥서스 편집 API · owner 인증 · POST+Origin)만 — CLI 는 조회 전용.

import type { LlmSpendRowState } from '../nexus/llm-spend-policy/types.js';
import { LLM_SPEND_POLICY_ROLES } from '../nexus/llm-spend-policy/types.js';
import { readAppliedSpendPolicy, type AppliedSpendPolicyView } from '../nexus/llm-spend-policy/store.js';
import { resolveSpendRolePolicy } from '../nexus/llm-spend-policy/schema.js';
import { mergeRowStates, readCreditRowStates, type CreditAdapterDeps } from '../nexus/llm-spend-policy/credit-adapter.js';
import { readStoredSpendPolicy } from '../nexus/llm-spend-policy/store.js';
import { appendSpendTransition } from '../nexus/llm-spend-policy/ledger.js';
import {
  appendSpendObservation, observationsToRowStates, readSpendObservations, withoutSyntheticObservations, type SpendObservation,
} from '../nexus/llm-spend-policy/observations.js';
import { getTestStateRoot } from '../nexus/paths.js';
import { decideLlmSpend, projectBurn, rolesShiftedOffRow } from '../oauth/llm-spend-decision.js';
import { isLlmSpendPolicyRole, type LlmSpendDifficulty, type LlmSpendPolicyRole } from '../nexus/llm-spend-policy/types.js';

export interface LlmPolicyViewDeps {
  /** 저장소 디렉터리(시험 주입) — 없으면 넥서스 데이터 영역 기본. */
  readonly dir?: string;
  /** 주입된 공급자 상태(시험·후속 칸) — 없으면 전부 unmeasured 표기. */
  readonly states?: readonly LlmSpendRowState[];
  readonly out?: (line: string) => void;
  /** CC-1 잔액 어댑터 입력(임대·fetch 시험 주입). 임대 없으면 openrouter 는 missing-management-lease 로 unmeasured(네트워크 0). */
  readonly credit?: CreditAdapterDeps;
  /** false 면 공급자 잔액 어댑터를 부르지 않는다(시험·오프라인). */
  readonly readCredit?: boolean;
  /** 주입 시계(시험) — 역할 × 현재 모델 드라이런의 «지금». */
  readonly now?: Date;
}

/** 역할 × 현재 모델 — decideLlmSpend 드라이런 한 건(실호출 0 · 모델을 지어내지 않는다: stop 이면 사유 코드만). */
export interface RoleCurrentEntry {
  readonly role: LlmSpendPolicyRole;
  readonly outcome: 'choice' | 'stop';
  readonly row?: string;
  readonly model?: string;
  readonly reason: string;
  readonly skipped: readonly { readonly row: string; readonly why: string }[];
}

export function buildRoleCurrent(view: AppliedSpendPolicyView, now: Date): readonly RoleCurrentEntry[] {
  return LLM_SPEND_POLICY_ROLES.map((role): RoleCurrentEntry => {
    const d = decideLlmSpend(view.policy, view.states, { role, execLocation: 'host', now, actor: 'policy-view' });
    const skipped = d.skipped.map((s) => ({ row: s.row, why: s.why }));
    return d.outcome === 'choice'
      ? { role, outcome: 'choice', row: d.row, model: d.model, reason: d.reason, skipped }
      : { role, outcome: 'stop', reason: d.reason, skipped };
  });
}

function renderRoleCurrent(entries: readonly RoleCurrentEntry[]): string[] {
  const lines = ['역할 × 현재 모델(드라이런 · 실호출 0 · 주입·실측 상태 기준)'];
  for (const e of entries) {
    lines.push(e.outcome === 'choice'
      ? `  ${e.role}: ${e.row} · ${e.model || '(모델 미지정)'} — ${e.reason}`
      : `  ${e.role}: 멈춤 — ${e.reason}`);
  }
  return lines;
}

function fmtState(view: AppliedSpendPolicyView, row: string): string {
  const state = view.states.find((s) => s.row === row);
  const parts: string[] = [];
  const policyRow = view.policy.providers[row];
  if (policyRow && policyRow.kind !== 'credit') {
    const window = state?.window;
    parts.push(window === undefined
      ? '창 unmeasured(주입 없음)'
      : window.status === 'measured'
        ? `창 실측 ${window.usedPct}%(${window.observedAt})${window.slopePctPerHour !== undefined ? ` · 기울기 ${window.slopePctPerHour}%/h` : ''}`
        : `창 unmeasured(${window.reason})`);
  }
  if (policyRow && policyRow.kind === 'credit') {
    const balance = state?.balance;
    parts.push(balance === undefined
      ? '잔액 unmeasured(주입 없음)'
      : balance.status === 'measured'
        ? `잔액 ${balance.usd}USD(${balance.source} · ${balance.observedAt})`
        : `잔액 unmeasured(${balance.reason})`);
    const spend = state?.spend;
    parts.push(spend === undefined
      ? '지출 unmeasured(주입 없음)'
      : `지출 일 ${spend.todayUsd ?? '?'}USD · 월 ${spend.monthUsd ?? '?'}USD(${spend.observedAt})`);
    const autoTopUp = state?.autoTopUp;
    parts.push(autoTopUp === undefined
      ? '자동충전 unmeasured(주입 없음)'
      : autoTopUp.status === 'measured'
        ? `자동충전 ${autoTopUp.enabled ? '켜짐' : '꺼짐'}${autoTopUp.amountUsd !== undefined ? ` · ${autoTopUp.amountUsd}USD` : ''}(${autoTopUp.observedAt})`
        : `자동충전 unmeasured(${autoTopUp.reason})`);
  }
  if (policyRow && policyRow.kind === 'acp-device') {
    const device = state?.device;
    parts.push(device === undefined
      ? '장치 헬스 unmeasured(주입 없음)'
      : device.status === 'measured'
        ? `장치 ${device.alive ? '살아 있음' : '헬스 실패'} · 세션 ${device.sessions}${policyRow.maxSessions !== undefined ? `/${policyRow.maxSessions}` : ''}(${device.observedAt})`
        : `장치 헬스 unmeasured(${device.reason})`);
  }
  if (policyRow && policyRow.kind !== 'credit') {
    const burn = projectBurn(policyRow, state, new Date());
    if (burn) {
      const shifted = rolesShiftedOffRow(view.policy, policyRow, state, new Date());
      parts.push(`capPct 도달 예상 ${burn.projectedCapAt}(리셋까지 ${burn.hoursToReset.toFixed(1)}h)${shifted.length > 0 ? ` · 이동 역할: ${shifted.join(', ')}` : ' · 이동 없음'}`);
    }
  }
  const lease = state?.lease;
  // 임대 상태가 «주입되지 않은» 모름 상황은 미측정 — «임대 없음» 은 임대 유무를 아는 경우(leaseId null)에만.
  parts.push(lease === undefined
    ? '임대 unmeasured(주입 없음)'
    : lease.leaseId === null
      ? `임대 없음(${lease.reason})`
      : `임대 ${lease.leaseId} · 만료 ${lease.expiresAt}`);
  return parts.join(' · ');
}

function sourceTag(view: AppliedSpendPolicyView, leaf: string): string {
  // 잎 자체 또는 그 아래 잎(배열·매핑 통째 값)이 하나라도 저장 덮어씀이면 [yaml].
  const stored = Object.entries(view.sources).some(([key, source]) => source === 'stored' && (key === leaf || key.startsWith(`${leaf}.`)));
  return stored ? '[yaml]' : '[default]';
}

function renderPolicyText(view: AppliedSpendPolicyView, roleCurrent: readonly RoleCurrentEntry[]): string[] {
  const lines: string[] = [];
  const stored = view.stored;
  lines.push('LLM 지출 정책 한 장 — 적용 값(코드 기본 + 저장 덮어씀)');
  const storedState = !stored.present
    ? '저장 정책 없음(코드 기본만 적용)'
    : stored.valid
      ? `저장 정책 유효 · v${stored.meta?.version ?? '?'} · ${stored.meta?.updatedAt ?? '시각 미상'}${stored.fromLastGood ? ' · ⚠️ 정본 무효 — 마지막 정상 사본으로 읽음' : ''}`
      : `저장 정책 무효(코드 기본만 적용) — 사유: ${stored.errors.join(' · ') || '(검증 실패)'}`;
  lines.push(`정본: ${view.dir}/policy.yaml · ${storedState}`);
  for (const warning of stored.warnings) lines.push(`경고: ${warning}`);
  for (const error of view.overlayErrors) lines.push(`병합 오류(기본값으로 적용): ${error}`);

  lines.push(`fallbackOrder: ${view.policy.fallbackOrder.join(' → ')} ${sourceTag(view, 'fallbackOrder')}`);
  lines.push(`shiftOrder(소진 속도 이동 순서): ${view.policy.shiftOrder.join(' → ')} ${sourceTag(view, 'shiftOrder')}`);
  lines.push(`returnOnReset: ${view.policy.returnOnReset ? 'true' : 'false'} ${sourceTag(view, 'returnOnReset')}`);

  const orderedRows = [
    ...view.policy.fallbackOrder,
    ...Object.keys(view.policy.providers).filter((key) => !view.policy.fallbackOrder.includes(key)).sort(),
  ];
  for (const row of orderedRows) {
    const policyRow = view.policy.providers[row]!;
    const vaultText = policyRow.vault !== undefined ? ` · 금고: ${policyRow.vault}` : ' · 금고: (미지정)';
    lines.push(`─ 행 ${row} — ${policyRow.kind} ${sourceTag(view, `providers.${row}.kind`)} · ${policyRow.provider} ${sourceTag(view, `providers.${row}.provider`)}${vaultText} ${sourceTag(view, `providers.${row}.vault`)}`);
    if (policyRow.kind === 'credit') {
      lines.push(`    models: ${policyRow.models.join(', ') || '(없음 — 사용 불가)'} ${sourceTag(view, `providers.${row}.models`)}`);
      const capParts: string[] = [];
      if (policyRow.spendCap.dailyUsd !== undefined) capParts.push(`일 ${policyRow.spendCap.dailyUsd}USD ${sourceTag(view, `providers.${row}.spendCap.dailyUsd`)}`);
      if (policyRow.spendCap.monthlyUsd !== undefined) capParts.push(`월 ${policyRow.spendCap.monthlyUsd}USD ${sourceTag(view, `providers.${row}.spendCap.monthlyUsd`)}`);
      lines.push(`    spendCap: ${capParts.join(' · ') || '없음(= 크레딧 0 · fail-closed)'}`);
    } else {
      const windowParts: string[] = [];
      if (policyRow.window?.hours !== undefined) windowParts.push(`${policyRow.window.hours}h 창 ${sourceTag(view, `providers.${row}.window.hours`)}`);
      if (policyRow.window?.resetAt !== undefined) windowParts.push(`리셋 ${policyRow.window.resetAt} ${sourceTag(view, `providers.${row}.window.resetAt`)}`);
      lines.push(`    창: ${windowParts.join(' · ') || '(실측 없음)'}`);
      lines.push(`    capPct: ${policyRow.capPct}% ${sourceTag(view, `providers.${row}.capPct`)}`);
      if (policyRow.kind === 'acp-device') lines.push(`    hostOnly: ${policyRow.hostOnly ? 'true(Pod 제외)' : 'false'} ${sourceTag(view, `providers.${row}.hostOnly`)} · 동시 세션 상한: ${policyRow.maxSessions ?? '(없음)'} ${sourceTag(view, `providers.${row}.maxSessions`)}`);
      lines.push(`    소진 순서: ${policyRow.onExhausted.map((entry) => entry === 'stop' ? '멈춤' : entry).join(' → ') || '(fallbackOrder 나머지)'} ${sourceTag(view, `providers.${row}.onExhausted`)}`);
    }
    lines.push(`    상태(주입된 실측만): ${fmtState(view, row)}`);
  }

  for (const role of LLM_SPEND_POLICY_ROLES) {
    if (!view.policy.roles[role]) continue;
    const rolePolicy = resolveSpendRolePolicy(view.policy, role); // 부분 역할(잎 생략)도 기본으로 완성해 찍는다.
    const tiers = Object.entries(rolePolicy.difficulty ?? {}).map(([level, list]) => `${level}=[${(list ?? []).join(', ')}]`).join(' ');
    const roleCap = rolePolicy.creditSpendCap;
    const capText = roleCap
      ? ` · creditSpendCap: ${roleCap.dailyUsd !== undefined ? `일 ${roleCap.dailyUsd}USD ` : ''}${roleCap.monthlyUsd !== undefined ? `월 ${roleCap.monthlyUsd}USD ` : ''}${sourceTag(view, `roles.${role}.creditSpendCap`)}`
      : '';
    lines.push(`─ 역할 ${role} — creditOk: ${rolePolicy.creditOk ? 'true' : 'false'} ${sourceTag(view, `roles.${role}.creditOk`)} · prefer: ${rolePolicy.prefer.join(', ') || '(없음)'} ${sourceTag(view, `roles.${role}.prefer`)} · deny: ${rolePolicy.deny.join(', ') || '(없음)'} ${sourceTag(view, `roles.${role}.deny`)}${tiers ? ` · difficulty: ${tiers} ${sourceTag(view, `roles.${role}.difficulty`)}` : ''}${capText}`);
  }
  const absentRoles = LLM_SPEND_POLICY_ROLES.filter((role) => !view.policy.roles[role]).join(', ') || '(없음)';
  lines.push(`역할 절에 없는 역할(${absentRoles})은 creditOk=false · prefer/deny 빈 목록으로 적용된다.`);
  lines.push(...renderRoleCurrent(roleCurrent));
  return lines;
}

export async function runLlmPolicyView(opts: { json?: boolean } & LlmPolicyViewDeps = {}): Promise<void> {
  const base = await readAppliedSpendPolicy({ dir: opts.dir, states: opts.states });
  // 읽기 전용 어댑터(CC-1) → 조회 현황(잔액·자동 충전). 직접 주입된 상태가 어댑터 값을 덮는다.
  const adapted = opts.readCredit === false ? [] : await readCreditRowStates(base.policy, opts.credit);
  // 실 관측(real · 합성 제외) 자동 충전은 «observed» 로 선언(declared)보다 우선한다. 잔액·창·지출은 여기서 섞지 않는다(어댑터·주입 몫).
  const observedTopUp: LlmSpendRowState[] = observationsToRowStates(
    withoutSyntheticObservations(await readSpendObservations(opts.dir)).filter((r) => r.kind === 'autoTopUp'),
  ).flatMap((s) => (s.autoTopUp?.status === 'measured' ? [{ row: s.row, provider: s.provider, autoTopUp: { ...s.autoTopUp, source: 'observed' } }] : []));
  const view: AppliedSpendPolicyView = { ...base, states: mergeRowStates(mergeRowStates(adapted, observedTopUp), opts.states ?? []) };
  const out = opts.out ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const roleCurrent = buildRoleCurrent(view, opts.now ?? new Date());
  if (opts.json) {
    out(JSON.stringify({
      policy: view.policy,
      sources: view.sources,
      stored: {
        present: view.stored.present,
        valid: view.stored.valid,
        fromLastGood: view.stored.fromLastGood,
        version: view.stored.meta?.version ?? null,
        updatedAt: view.stored.meta?.updatedAt ?? null,
        errors: view.stored.errors,
        warnings: view.stored.warnings,
      },
      overlayErrors: view.overlayErrors,
      states: view.states,
      roleCurrent,
      dir: view.dir,
    }, null, 2));
    return;
  }
  for (const line of renderPolicyText(view, roleCurrent)) out(line);
}

// ── 합성 사건 «결정 드라이런»(inject) ─────────────────────────────────────────
//
// 대표 합성은 실 관문이 아니라 «가상 결정기» 로만 본다: 같은 decideLlmSpend · 현재 «실제(real)» 관측 위에 이번 합성 사건을 오버레이 ·
//   실호출 0 · 실 관측 저장소에 synthetic 을 쓰지 않는다 · 예약 원장·가드 기억도 건드리지 않는다. 결과(선택 행·사유·skipped)는
//   전환 원장에 synthetic:true 줄로 남기고 출력한다. (운영에서 inject 로 실 구독을 소진 처리·복귀시키는 길 0)
// 예외 `--live-synthetic`(시험 전용): 실호출이 필요한 시험에서만 실 관문 저장소에 synthetic 관측을 «쓴다».
//   이 플래그는 기능 스위치가 아니라 «시험 우주 신원(getTestStateRoot) 검사 + 명시 의도» 다 — 운영 신원이면 거부.
//   실 관문 observer 도 같은 신원일 때만 synthetic 을 읽는다(llm-call-live.ts).

export const INJECT_EVENTS = ['usage_limit_reached', 'insufficient_credits', 'window-reset', 'spend-cap', 'auto-topup', 'window-usage'] as const;
export type InjectEvent = (typeof INJECT_EVENTS)[number];

/** 운영 신원에서 --live-synthetic 을 거부할 때의 리터럴 오류 문구(비밀 0). */
export const LIVE_SYNTHETIC_DENIED = '--live-synthetic 은 시험 우주 신원(getTestStateRoot)이 있을 때만 허용된다 — 운영 우주는 합성 관측을 실 관문 저장소에 쓰지 않는다(드라이런만)';

export interface LlmPolicyInjectOptions {
  readonly row?: string;
  readonly event?: string;
  readonly resetsAt?: string;
  readonly amountUsd?: string | number;
  /** window-usage 사건 — 창 사용률(%) · 소진 기울기(%/h). resetsAt 와 함께 burn-shift 를 드라이런으로 본다. */
  readonly usedPct?: string | number;
  readonly slopePctPerHour?: string | number;
  /** 드라이런 결정 요청 — 역할(기본 authoring) · 난이도 · 모델 · 실행 위치(기본 host). */
  readonly role?: string;
  readonly difficulty?: string;
  readonly model?: string;
  readonly location?: 'host' | 'pod';
  /** 시험 전용 — 실 관문 저장소에 synthetic 관측을 쓴다(시험 우주 신원 필요). */
  readonly liveSynthetic?: boolean;
  /** 드라이런에 겹쳐 쓸 주입 상태(임대 등 — 관측 저장소에 없는 칸). */
  readonly states?: readonly LlmSpendRowState[];
  readonly json?: boolean;
  /** 저장소(정책 폴더) 주입(시험). */
  readonly dir?: string;
  readonly now?: () => Date;
  readonly out?: (line: string) => void;
}

export type LlmPolicyInjectResult =
  | {
    readonly ok: true;
    readonly mode: 'dry-run' | 'live-synthetic';
    readonly ids: readonly string[];
    readonly decision?: { readonly outcome: 'choice' | 'stop'; readonly row?: string; readonly model?: string; readonly reason: string; readonly skipped: readonly { readonly row: string; readonly why: string }[]; readonly lease: InjectLeaseSource };
  }
  | { readonly ok: false; readonly error: string };

/** 드라이런 결정기가 임대 없는 행에 붙이는 표식 — 출력·JSON 에 그대로 찍힌다(실 관문 경로에는 없다). */
export const VIRTUAL_LEASE_ID = 'virtual(dry-run)';

/** 선택 행의 임대 출처 이름 — 'injected'(명시 주입 · id 값은 절대 찍지 않음) · 가상 표식 · 'none'(선택 행 없음/임대 없음 명시). */
export type InjectLeaseSource = typeof VIRTUAL_LEASE_ID | 'injected' | 'none';

let injectSeq = 0;

/** 합성 사건 → 관측 한 건(검증 포함). 오류 문자열 또는 관측. */
function buildSyntheticObservation(opts: LlmPolicyInjectOptions, view: AppliedSpendPolicyView, now: Date): { error: string } | { obs: SpendObservation; amount: number | undefined; event: InjectEvent } {
  const row = opts.row;
  if (!row || !view.policy.providers[row]) return { error: `--row 는 정책 행 이름이어야 한다(알려진 행: ${Object.keys(view.policy.providers).join(', ')})` };
  const event = opts.event as InjectEvent | undefined;
  if (!event || !(INJECT_EVENTS as readonly string[]).includes(event)) return { error: `--event 는 ${INJECT_EVENTS.join('|')} 중 하나` };
  const policyRow = view.policy.providers[row]!;
  const isCredit = policyRow.kind === 'credit';
  if (isCredit !== (event === 'insufficient_credits' || event === 'spend-cap' || event === 'auto-topup')) {
    return { error: `사건 ${event} 는 ${isCredit ? '구독' : '크레딧'} 행에 맞지 않는다(행 ${row} = ${policyRow.kind})` };
  }
  let amount: number | undefined;
  if (opts.amountUsd !== undefined) {
    amount = Number(opts.amountUsd);
    if (!Number.isFinite(amount) || amount < 0) return { error: '--amount-usd 는 0 이상의 유한한 수' };
  }
  if ((event === 'spend-cap') && amount === undefined) return { error: 'spend-cap 는 --amount-usd 가 필요하다' };
  if (opts.resetsAt !== undefined && !Number.isFinite(Date.parse(opts.resetsAt))) return { error: '--resets-at 는 ISO 시각' };
  let usedPct: number | undefined;
  let slope: number | undefined;
  if (event === 'window-usage') {
    usedPct = Number(opts.usedPct);
    if (opts.usedPct === undefined || !Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100) return { error: 'window-usage 는 --used-pct(0..100)가 필요하다' };
    if (opts.slopePctPerHour !== undefined) {
      slope = Number(opts.slopePctPerHour);
      if (!Number.isFinite(slope) || slope < 0) return { error: '--slope-pct-per-hour 는 0 이상의 유한한 수' };
    }
  } else if (opts.usedPct !== undefined || opts.slopePctPerHour !== undefined) {
    return { error: '--used-pct·--slope-pct-per-hour 는 window-usage 사건 전용' };
  }
  const id = `syn-${now.getTime()}-${++injectSeq}`;
  const base = { id, row, provider: policyRow.provider, source: 'synthetic' as const, observedAt: now.toISOString(), event };
  const obs: SpendObservation = event === 'usage_limit_reached'
    ? { ...base, kind: 'window', usedPct: 100, ...(opts.resetsAt !== undefined ? { resetAt: new Date(opts.resetsAt).toISOString() } : {}) }
    : event === 'window-usage' ? { ...base, kind: 'window', usedPct: usedPct!, ...(slope !== undefined ? { slopePctPerHour: slope } : {}), ...(opts.resetsAt !== undefined ? { resetAt: new Date(opts.resetsAt).toISOString() } : {}) }
    : event === 'window-reset' ? { ...base, kind: 'window', usedPct: 0 }
      : event === 'insufficient_credits' ? { ...base, kind: 'balance', usd: 0 }
        : event === 'spend-cap' ? { ...base, kind: 'spend', todayUsd: amount!, monthUsd: amount! }
          : { ...base, kind: 'autoTopUp', enabled: true, ...(amount !== undefined ? { amountUsd: amount } : {}) };
  return { obs, amount, event };
}

/** 합성 사건 드라이런(기본) · 시험 우주 전용 live 저장. ⛔ 정책 정본이 없는 우주는 거부 · 전환 원장에 synthetic:true 를 «항상» 달아 쓴다. */
export async function runLlmPolicyInject(opts: LlmPolicyInjectOptions): Promise<LlmPolicyInjectResult> {
  const out = opts.out ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const now = (opts.now ?? (() => new Date()))();
  const finish = (result: LlmPolicyInjectResult, text: string): LlmPolicyInjectResult => {
    out(opts.json ? JSON.stringify(result) : text);
    return result;
  };
  const fail = (error: string): LlmPolicyInjectResult => finish({ ok: false, error }, `거부: ${error}`);

  // 신원 검사가 먼저 — 운영 신원의 live 요청은 어떤 읽기·쓰기도 하기 전에 거부.
  if (opts.liveSynthetic && getTestStateRoot() === undefined) return fail(LIVE_SYNTHETIC_DENIED);
  const stored = await readStoredSpendPolicy(opts.dir);
  if (!stored.present) return fail('정책 정본(policy.yaml)이 없는 우주 — 주입은 정책이 있는 우주에서만 의미가 있다');
  const view = await readAppliedSpendPolicy(opts.dir !== undefined ? { dir: opts.dir } : {});
  const built = buildSyntheticObservation(opts, view, now);
  if ('error' in built) return fail(built.error);
  const { obs, amount, event } = built;
  const detail = `${event}${amount !== undefined ? ` amountUsd=${amount}` : ''}${opts.resetsAt !== undefined ? ` resetsAt=${opts.resetsAt}` : ''} id=${obs.id}`;

  if (opts.liveSynthetic) {
    // 시험 우주 전용: 원장 먼저(표시 달린 줄이 못 써지면 관측도 쓰지 않는다).
    await appendSpendTransition({ at: now.toISOString(), actor: 'inject-cli', action: 'observe', what: obs.row, from: null, to: event, reason: `synthetic-inject-live ${detail}`, synthetic: true }, opts.dir);
    await appendSpendObservation(obs, opts.dir);
    return finish({ ok: true, mode: 'live-synthetic', ids: [obs.id] }, `합성 사건 live 저장(시험 우주): 행 ${obs.row} · ${event} · id ${obs.id} (source synthetic)`);
  }

  // 드라이런 — 실 관측(real) + 이번 합성 사건 오버레이 → 같은 decideLlmSpend. 저장소·예약·가드 기억 쓰기 0.
  const real = withoutSyntheticObservations(await readSpendObservations(opts.dir));
  // 드라이런 전용 가상 임대 — 주입 임대가 없는 행만 «이 판정 시각 직후까지» 유효로 본다. 실 관문(live) 경로는 이 함수를 지나지 않는다.
  const leased = new Set((opts.states ?? []).filter((s) => s.lease !== undefined).map((s) => s.row));
  const virtualLeases: LlmSpendRowState[] = Object.entries(view.policy.providers)
    .filter(([key]) => !leased.has(key))
    .map(([key, r]) => ({ row: key, provider: r.provider, lease: { leaseId: VIRTUAL_LEASE_ID, expiresAt: new Date(now.getTime() + 1).toISOString() } }));
  const states = mergeRowStates(mergeRowStates(virtualLeases, opts.states ?? []), observationsToRowStates([...real, obs]));
  const role: LlmSpendPolicyRole = isLlmSpendPolicyRole(opts.role) ? opts.role : 'authoring';
  const difficulty = opts.difficulty === 'high' || opts.difficulty === 'mid' || opts.difficulty === 'low' ? (opts.difficulty as LlmSpendDifficulty) : undefined;
  const decision = decideLlmSpend(view.policy, states, {
    role, execLocation: opts.location ?? 'host', now, actor: 'inject-cli',
    ...(difficulty !== undefined ? { difficulty } : {}), ...(opts.model !== undefined ? { model: opts.model } : {}),
  });
  const skipped = decision.skipped.map((s) => ({ row: s.row, why: s.why }));
  // 라벨은 «선택된 행» 의 임대 출처만 말한다 — 다른 행의 명시 임대나 가상 임대는 영향 0.
  // 같은 행을 두 번 주입해도 결정 함수가 본 병합 결과(mergeRowStates)와 같은 임대를 본다(UX #115450 중복 행 반례).
  const explicitLease = decision.outcome === 'choice' ? mergeRowStates([], opts.states ?? []).find((s) => s.row === decision.row)?.lease : undefined;
  const leaseSource: InjectLeaseSource = decision.outcome !== 'choice' ? 'none'
    : explicitLease === undefined ? VIRTUAL_LEASE_ID
      : explicitLease.leaseId === null ? 'none' : 'injected';
  const summary = decision.outcome === 'choice'
    ? { outcome: 'choice' as const, row: decision.row, model: decision.model, reason: decision.reason, skipped, lease: leaseSource }
    : { outcome: 'stop' as const, reason: decision.reason, skipped, lease: leaseSource };
  const burnSkip = skipped.find((s) => s.why.startsWith('burn-shift('));
  await appendSpendTransition({
    at: now.toISOString(), actor: 'inject-cli', action: 'decision', what: obs.row, from: null, to: decision.outcome === 'choice' ? decision.row : 'stop',
    reason: `synthetic-dry-run ${detail} → ${decision.outcome === 'choice' ? `선택 ${decision.row}` : '멈춤'}: ${decision.reason}${burnSkip !== undefined && decision.outcome === 'choice' ? ` · burn-shift ${burnSkip.row}→${decision.row}` : ''}`, synthetic: true,
  }, opts.dir);
  const lines = [
    `합성 사건 드라이런(실호출 0 · 실 저장소 쓰기 0): 행 ${obs.row} · ${event} · id ${obs.id}`,
    decision.outcome === 'choice' ? `지금 이 사건이면 선택: ${decision.row} (${decision.model}) — ${decision.reason}` : `지금 이 사건이면 멈춤 — ${decision.reason}`,
    ...skipped.map((s) => `  건너뜀 ${s.row}: ${s.why}`),
    ...(burnSkip !== undefined && decision.outcome === 'choice' ? [`burn-shift 이동: 역할 ${role} ${burnSkip.row} → ${decision.row}`] : []),
    leaseSource === VIRTUAL_LEASE_ID ? `lease: ${VIRTUAL_LEASE_ID} (드라이런 전용 가상 임대 · 실 관문 영향 0)`
      : leaseSource === 'injected' ? 'lease: injected (선택 행에 명시 주입된 임대 · 가상 임대 미적용)'
        : 'lease: none (선택 행 없음 또는 임대 없음 명시)',
  ];
  return finish({ ok: true, mode: 'dry-run', ids: [obs.id], decision: summary }, lines.join('\n'));
}
