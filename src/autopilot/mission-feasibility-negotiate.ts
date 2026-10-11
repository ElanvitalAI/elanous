// ── 실현가능성 협상 (스코프컷 1급화) — RFC-decomposition-critique §3b·D3 ─────────
//
// 대표 통찰: "너무 어려운 미션은 달성 힘들다는 피드백과 다르게 조정하는 방법이 왔다갔다 했어야 한다."
// 실행 중 페이즈가 교착(구현자-검증자·no-op·grounded 미충족)하면, 그냥 멈추거나 전체 재분해(파괴적)
// 하지 말고: ①근본원인 규명(Magentic-One 패턴: 먼저 왜 실패했나) → ②replan(스텝) OR ★스코프컷 제안
// (페이즈 acceptance 를 achievable 하게 축소·나머지 defer) → ③HITL 승인 게이트로 협상.
//
// ★ fidelity guard 와 공존(RFC §5): 게으른 자동 축소가 아니라 **문서화된 교착 後·근본원인 규명 +
//   사람 승인**된 스코프 조정. 자율경계(§8-4): 스코프컷은 항상 HITL(자동 축소 금지).
//
// 2 예산(§8-5·config-first): maxStalls(언제 협상) · maxReplans(언제 partial 포기). a6230f 실측 튜닝.
// 제1원칙: 협상 제안을 debug.log('mission.negotiate')로 관측.

import { getUserConfig, resolveRoleLlm } from '../user-config.js';
import { debug } from '../debug/log.js';

export interface FeasibilityBudget {
  /** 교착 몇 회에 협상 트리거(기본 2). */
  maxStalls: number;
  /** 협상(replan/scopecut) 몇 회 후 partial 포기(기본 2). */
  maxReplans: number;
}

/** config-first 예산 — autopilot.decompose.{maxStalls,maxReplans} → 기본 2/2. fail-soft. */
export function feasibilityBudget(): FeasibilityBudget {
  try {
    const cfg = getUserConfig() as { autopilot?: { decompose?: { maxStalls?: unknown; maxReplans?: unknown } } };
    const d = cfg.autopilot?.decompose ?? {};
    const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : def);
    return { maxStalls: num(d.maxStalls, 2), maxReplans: num(d.maxReplans, 2) };
  } catch { return { maxStalls: 2, maxReplans: 2 }; }
}

export type NegotiationKind = 'replan' | 'scope_cut' | 'proceed';

export interface ScopeNegotiation {
  /** 왜 교착했나(근본원인·먼저 규명). */
  rootCause: string;
  kind: NegotiationKind;
  /** scope_cut 일 때 — achievable 하게 축소한 acceptance. */
  narrowedAcceptance?: string[];
  /** scope_cut 일 때 — 무엇을 defer(후속 페이즈/미션)하나. */
  deferred?: string;
  /** replan 일 때 — 근본원인 회피하는 새 스텝 요지. */
  replanHint?: string;
  rationale: string;
  /** 항상 true(자율경계·§8-4) — 집행 前 HITL 승인. */
  needsHitl: boolean;
}

export interface NegotiateInput {
  phaseTitle: string;
  phasePrompt: string;
  acceptance: string[];
  /** 실패 진단(근본원인 추정·재사용 실존 맵 등). */
  diagnosis: string;
  /** 지금까지 협상(replan/scopecut) 횟수 — maxReplans 초과 시 partial 신호. */
  replanCount?: number;
}

export interface NegotiateDeps {
  judge?: (prompt: string) => Promise<string>;
}

/** LLM 출력 → 협상(순수·파싱 실패는 replan·보수적). */
export function parseScopeNegotiation(raw: string): ScopeNegotiation {
  const fallback: ScopeNegotiation = { rootCause: '', kind: 'replan', rationale: '파싱 실패(보수적 replan)', needsHitl: true };
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return fallback;
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const kind: NegotiationKind = o.kind === 'scope_cut' || o.kind === 'proceed' ? o.kind : 'replan';
    const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 200)).slice(0, 8) : undefined);
    return {
      rootCause: typeof o.rootCause === 'string' ? o.rootCause.slice(0, 400) : '',
      kind,
      ...(kind === 'scope_cut' ? { narrowedAcceptance: arr(o.narrowedAcceptance), deferred: typeof o.deferred === 'string' ? o.deferred.slice(0, 300) : '' } : {}),
      ...(kind === 'replan' && typeof o.replanHint === 'string' ? { replanHint: o.replanHint.slice(0, 300) } : {}),
      rationale: typeof o.rationale === 'string' ? o.rationale.slice(0, 300) : '',
      needsHitl: true,
    };
  } catch { return fallback; }
}

function buildNegotiatePrompt(input: NegotiateInput, overBudget: boolean): string {
  return [
    '역할: 자율 미션의 페이즈가 반복 실패(구현자-검증자 교착·no-op)했다. 먼저 **근본원인**을 규명하고,',
    '그 다음 조정 방법을 제안하라. 두 갈림길:',
    '  - replan — 근본원인이 접근법 실수라면, 그걸 회피하는 새 스텝 요지(스코프 유지).',
    '  - scope_cut — 근본원인이 **본질적 난이도·요구 과다**라면(예: 완벽한 품질검증이 한 페이즈엔 과함),',
    '    acceptance 를 achievable 하게 **축소**하고 나머지를 후속으로 defer. 게으른 회피가 아니라',
    '    "지금 현실적으로 닫을 수 있는 계약"으로 재협상. narrowedAcceptance + deferred 를 채워라.',
    overBudget ? '  ※ 이미 여러 번 재시도했다 — scope_cut 을 우선 고려(무한 재시도 금지).' : '',
    '주의: 스코프컷은 사람 승인을 받는다. 정직하게 — 진짜 achievable 한 축소만 제안(거짓 완료 금지).',
    '',
    `## 페이즈\n제목: ${input.phaseTitle}\n지시: ${input.phasePrompt.slice(0, 900)}`,
    `현재 acceptance: ${input.acceptance.length ? input.acceptance.join(' / ') : '(없음)'}`,
    '',
    `## 실패 진단(근본원인 추정)\n${input.diagnosis.slice(0, 1200)}`,
    '',
    'JSON 한 줄만: {"rootCause":"왜 교착했나","kind":"replan|scope_cut|proceed",',
    '  "narrowedAcceptance":["축소된 acceptance"],"deferred":"후속으로 미룰 것","replanHint":"새 스텝 요지",',
    '  "rationale":"이 조정이 정당한 이유"}',
  ].filter(Boolean).join('\n');
}

export async function defaultJudge(prompt: string): Promise<string> {
  const { streamLLM, getProvider, PROVIDERS } = await import('../llm.js');
  const override = process.env.ELANOUS_NEGOTIATE_MODEL || process.env.ELANOUS_DECOMPOSE_MODEL;
  const resolved = override ? undefined : resolveRoleLlm('planning');
  const model = override || resolved!.model;
  const provider = override ? getProvider(model) : PROVIDERS[resolved!.provider];
  const providerName = override ? provider.name : resolved!.provider;
  if (!provider) throw new Error(`Unknown planning provider: ${providerName}`);
  debug.log('llm.role-pin', 'resolved', { site: 'feasibility-negotiate', role: 'planning', model, provider: providerName, source: override ? 'env' : resolved!.source });
  return streamLLM([{ role: 'user', content: prompt }], () => {}, {
    model, provider, usageRole: 'planning', reasoningEffort: 'medium',
  });
}

/** 교착 페이즈 → 실현가능성 협상 제안. replanCount ≥ maxReplans 면 scope_cut 우선 유도. fail-soft. */
export async function proposeScopeNegotiation(input: NegotiateInput, deps: NegotiateDeps = {}): Promise<ScopeNegotiation> {
  const budget = feasibilityBudget();
  const overBudget = (input.replanCount ?? 0) >= budget.maxReplans;
  try {
    const judge = deps.judge ?? (process.env.NODE_ENV === 'test' ? undefined : defaultJudge);
    if (!judge) return { rootCause: '', kind: 'replan', rationale: 'judge 미주입(test)', needsHitl: true };
    const raw = await judge(buildNegotiatePrompt(input, overBudget));
    const neg = parseScopeNegotiation(raw);
    debug.log('mission.negotiate', neg.kind, {
      phase: input.phaseTitle.slice(0, 40), rootCause: neg.rootCause.slice(0, 100),
      replanCount: input.replanCount ?? 0, overBudget,
    });
    return neg;
  } catch (e) {
    debug.log('mission.negotiate', 'error', { error: e instanceof Error ? e.message.slice(0, 120) : '' }, { level: 'error' });
    return { rootCause: '', kind: 'replan', rationale: '협상 오류(fail-soft·replan)', needsHitl: true };
  }
}

/** HITL 카드 텍스트(순수) — 스코프컷/replan 협상 제안. */
export function formatNegotiationCard(neg: ScopeNegotiation, phaseTitle: string): string {
  const head = neg.kind === 'scope_cut'
    ? `✂️ 실현가능성 협상 — 스코프컷 제안 (교착·본질적 난이도)`
    : neg.kind === 'proceed'
      ? `▶️ 실현가능성 — 진행가능 판단`
      : `🔁 실현가능성 협상 — 재계획 제안 (접근법 교정)`;
  const lines = [head, `  페이즈: ${phaseTitle}`];
  if (neg.rootCause) lines.push(`  근본원인: ${neg.rootCause.slice(0, 160)}`);
  if (neg.kind === 'scope_cut') {
    if (neg.narrowedAcceptance?.length) { lines.push('  축소 acceptance(지금 닫을 수 있는 계약):'); for (const a of neg.narrowedAcceptance) lines.push(`    - ${a}`); }
    if (neg.deferred) lines.push(`  후속으로 defer: ${neg.deferred.slice(0, 160)}`);
  } else if (neg.replanHint) lines.push(`  재계획: ${neg.replanHint.slice(0, 160)}`);
  if (neg.rationale) lines.push(`  근거: ${neg.rationale.slice(0, 160)}`);
  lines.push('  → 승인 시 이 조정으로 재구현(자율경계: 스코프컷은 항상 사람 승인·게으른 축소 아님)');
  return lines.join('\n');
}
