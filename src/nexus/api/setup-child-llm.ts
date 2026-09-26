// NEXUS · /v1/setup/child-llm (PWA 설정 카드 — 자식 LLM 선호 · 예산 부족 행동)
//
// 해석은 resolveChildLlmPreference 한 함수만 부른다. 키를 직접 읽어 판정하지 않는다.
// 검증은 parseChildLlmPreference · parseHarnessBudgetGate. 그 파서는 잘못된 칸을
// 경고만 찍고 기본으로 진행하므로, 여기서는 파싱 전후를 비교해 버려진 칸이 있으면
// 400 과 이유를 돌려주고 설정은 그대로 둔다.
// 쓰기는 tools.selfImplement.childLlm ⊕ harness.budgetGate 두 칸만.

import { readFileSync, writeFileSync } from 'node:fs';
import { debug } from '../../debug/log.js';
import { DASHBOARD_PROVIDER_SETUP_OPTIONS } from '../../dashboard/setup-inline.js';
import { resolveChildLlmPreference, type ResolvedChildLlmPreference } from '../../self-implement/child-llm-preference.js';
import {
  getUserConfig,
  parseChildLlmPreference,
  parseHarnessBudgetGate,
  reloadUserConfig,
  userConfigPath,
  type ChildLlmPreferenceConfig,
  type HarnessBudgetGateConfig,
} from '../../user-config.js';

export interface ChildLlmSetupGetResponse {
  resolved: ResolvedChildLlmPreference;
  /** 고를 수 있는 프로바이더 이름. `/v1/setup/llm-providers` 와 같은 원천. */
  providers: string[];
}

export interface ChildLlmSetupPostBody {
  mode?: unknown;
  chain?: unknown;
  budgetGate?: unknown;
}

const CHILD_LLM_KEYS = ['mode', 'chain', 'provider', 'model'] as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}

/** 이미 있는 `/v1/setup/llm-providers` 카탈로그의 provider 이름만. 목록을 복제하지 않는다. */
export function childLlmProviderNames(): string[] {
  return DASHBOARD_PROVIDER_SETUP_OPTIONS.map((option) => option.provider);
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

/** 파서가 경고만 찍고 버린 칸을 이유로 모은다. 없으면 null. */
function childLlmDropReason(raw: unknown, parsed: ChildLlmPreferenceConfig | undefined): string | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return `tools.selfImplement.childLlm 가 객체가 아니다(${stable(raw)})`;
  }
  const v = raw as Record<string, unknown>;
  const reasons: string[] = [];
  if (v.mode !== undefined && parsed?.mode === undefined) {
    reasons.push(`mode 는 pinned|auto 여야 한다(${stable(v.mode)})`);
  }
  if (v.provider !== undefined && (typeof v.provider !== 'string' || parsed?.provider === undefined)) {
    reasons.push(`provider 는 문자열이어야 한다(${stable(v.provider)})`);
  }
  if (v.model !== undefined && (typeof v.model !== 'string' || parsed?.model === undefined)) {
    reasons.push(`model 은 문자열이어야 한다(${stable(v.model)})`);
  }
  if (v.chain !== undefined) {
    if (!Array.isArray(v.chain)) {
      reasons.push(`chain 은 {provider, model?} 배열이어야 한다(${stable(v.chain)})`);
    } else if (parsed?.chain === undefined || parsed.chain.length !== v.chain.length) {
      reasons.push(`chain 칸이 빠졌다 — 각 원소는 비어 있지 않은 provider 문자열과 선택적 model 문자열이어야 한다(${stable(v.chain)})`);
    }
  }
  return reasons.length > 0 ? reasons.join('; ') : null;
}

function budgetGateDropReason(raw: unknown, parsed: HarnessBudgetGateConfig): string | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return `harness.budgetGate 가 객체가 아니다(${stable(raw)})`;
  }
  const v = raw as Record<string, unknown>;
  const reasons: string[] = [];
  if (v.minHeadroomPercent !== undefined && parsed.minHeadroomPercent !== v.minHeadroomPercent) {
    reasons.push(`minHeadroomPercent 는 0~100 이어야 한다(${stable(v.minHeadroomPercent)})`);
  }
  if (v.onShortfall !== undefined && parsed.onShortfall !== v.onShortfall) {
    reasons.push(`onShortfall 은 decompose|wait-reset|next-provider|proceed 여야 한다(${stable(v.onShortfall)})`);
  }
  if (v.maxUsedPercent !== undefined) {
    if (!v.maxUsedPercent || typeof v.maxUsedPercent !== 'object' || Array.isArray(v.maxUsedPercent)) {
      reasons.push(`maxUsedPercent 는 프로바이더별 0~100 객체여야 한다(${stable(v.maxUsedPercent)})`);
    } else {
      const dropped = Object.entries(v.maxUsedPercent as Record<string, unknown>)
        .filter(([provider, value]) => provider.trim() && parsed.maxUsedPercent?.[provider] !== value);
      if (dropped.length > 0) {
        reasons.push(`maxUsedPercent 칸이 0~100 이 아니다(${stable(Object.fromEntries(dropped))})`);
      }
    }
  }
  return reasons.length > 0 ? reasons.join('; ') : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/** 디스크의 tools.selfImplement.childLlm 와 harness.budgetGate 만 바꾼다. */
function writeChildLlmKeys(
  childLlm: ChildLlmPreferenceConfig | undefined,
  budgetGate: HarnessBudgetGateConfig | undefined,
): void {
  const path = userConfigPath();
  let parsed: unknown = {};
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { parsed = {}; }
  const disk = asRecord(parsed);
  const tools = asRecord(disk.tools);
  const selfImplement = asRecord(tools.selfImplement);
  if (childLlm) selfImplement.childLlm = childLlm;
  else delete selfImplement.childLlm;
  tools.selfImplement = selfImplement;
  disk.tools = tools;
  if (budgetGate) {
    const harness = asRecord(disk.harness);
    // 카드가 아는 두 칸만 합친다 — parseHarnessBudgetGate 가 채운 기본값(maxUsedPercent 등)으로
    // 사용자가 정해 둔 다른 칸을 덮지 않는다(🅣 P15 · 2026-09-27 합의).
    harness.budgetGate = {
      ...asRecord(harness.budgetGate),
      minHeadroomPercent: budgetGate.minHeadroomPercent,
      onShortfall: budgetGate.onShortfall,
    };
    disk.harness = harness;
  }
  writeFileSync(path, JSON.stringify(disk, null, 2) + '\n', 'utf8');
}

/** GET /v1/setup/child-llm */
export function handleChildLlmGet(): Response {
  const cfg = getUserConfig();
  const body: ChildLlmSetupGetResponse = {
    resolved: resolveChildLlmPreference(cfg),
    providers: childLlmProviderNames(),
  };
  return json(body);
}

/** POST /v1/setup/child-llm — body { mode?, chain?, budgetGate? }. */
export async function handleChildLlmSet(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid-json', reason: '본문이 JSON 객체가 아니다' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'invalid-body', reason: '본문은 { mode?, chain?, budgetGate? } 객체여야 한다' }, 400);
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== 'mode' && key !== 'chain' && key !== 'budgetGate');
  if (unknown.length > 0) {
    return json({ error: 'unknown-fields', reason: `알 수 없는 칸: ${unknown.join(', ')}`, fields: unknown }, 400);
  }
  if (!('mode' in record) && !('chain' in record) && !('budgetGate' in record)) {
    return json({ error: 'empty-body', reason: 'mode · chain · budgetGate 중 하나는 있어야 한다' }, 400);
  }

  const cfg = getUserConfig();
  const current = cfg.tools.selfImplement.childLlm;
  let nextChild = current;

  if ('mode' in record || 'chain' in record) {
    const merged: Record<string, unknown> = {};
    for (const key of CHILD_LLM_KEYS) {
      if (current && current[key] !== undefined) merged[key] = current[key];
    }
    if ('mode' in record) merged.mode = record.mode;
    if ('chain' in record) merged.chain = record.chain;
    // pinned 는 provider·model 한 칸이다. 남은 chain 을 같이 두면 해석이 auto 순서로 읽는다.
    const submitted: Record<string, unknown> = {
      ...('mode' in record ? { mode: record.mode } : {}),
      ...('chain' in record ? { chain: record.chain } : {}),
    };
    if (merged.mode === 'pinned') {
      const chain = Array.isArray(merged.chain) ? merged.chain : undefined;
      const head = chain?.[0];
      const headRecord = head && typeof head === 'object' && !Array.isArray(head)
        ? head as Record<string, unknown> : undefined;
      if (headRecord && typeof headRecord.provider === 'string') merged.provider = headRecord.provider;
      if (headRecord && typeof headRecord.model === 'string') merged.model = headRecord.model;
      else delete merged.model;
      delete merged.chain;
      delete submitted.chain;
      if (merged.provider !== undefined) submitted.provider = merged.provider;
      if (merged.model !== undefined) submitted.model = merged.model;
    }
    const parsed = parseChildLlmPreference(merged);
    const reason = childLlmDropReason(submitted, parsed);
    if (reason) return json({ error: 'invalid-child-llm', reason }, 400);
    nextChild = parsed;
  }

  let nextGate = cfg.harness?.budgetGate;
  if ('budgetGate' in record) {
    const parsedGate = parseHarnessBudgetGate(record.budgetGate);
    const reason = budgetGateDropReason(record.budgetGate, parsedGate);
    if (reason) return json({ error: 'invalid-budget-gate', reason }, 400);
    nextGate = parsedGate;
  }

  // saveUserConfig 의 직렬화 whitelist 에 tools·harness 가 없다.
  // 그 함수로 쓰면 두 칸이 디스크에서 빠지고 다른 키도 다시 써진다.
  // 그래서 디스크 JSON 의 그 두 칸만 고친다.
  writeChildLlmKeys(nextChild, 'budgetGate' in record ? nextGate : undefined);
  const saved = reloadUserConfig();
  const resolved = resolveChildLlmPreference(saved);
  debug.log('pwa.settings', 'child-llm-set', {
    mode: resolved.mode,
    chainLength: resolved.chain.length,
    onShortfall: resolved.budgetGate.onShortfall,
  });
  return json({ resolved });
}
