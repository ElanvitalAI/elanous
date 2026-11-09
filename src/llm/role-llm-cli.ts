// 역할별 LLM 선택의 «입력 파서» — CLI·슬래시·(장래) NL 이 «같은» 문법을 쓰게 하는 공용 심.
//
// ⛔ 이 모듈이 존재하는 이유(RFC-role-scoped-llm-selection-2026-08-18 §2a·§4e):
//   110차에 `elanous self review --acp-backend grok` 이 «조용히» API 로 갔다 — 플래그는 받았는데
//   그것을 「한 번 정해서 아래로 내리는」 계약이 없어 그냥 버려졌다(verdict pass · exit 0 · 경고 0).
//   그래서 여기서는 ***모르는 값을 삼키지 않는다*** — 반드시 이유를 달아 거부한다.
//
// 문법:  <role>=<provider>[/<tier>]   ·   <role>=/<tier>   (tier 만)
// 예:    implement=grok/best · review=anthropic · planning=/best
import { isModelRole, parseRoleLlmEntry, MODEL_ROLES } from '../user-config.js';
import type { ModelRole, RoleLlmConfig } from '../user-config/types.js';

export type RoleLlmFlagParse =
  | { ok: true; overrides: RoleLlmConfig }
  | { ok: false; message: string };

/** `<role>=<provider>[/<tier>]` 한 칸을 판다. ⛔ 빈 칸·모르는 역할·모르는 값은 «전부» 거부. */
function parseOne(token: string): { ok: true; role: ModelRole; raw: Record<string, unknown> } | { ok: false; message: string } {
  const eq = token.indexOf('=');
  if (eq <= 0) return { ok: false, message: `'${token}' — 형식은 <role>=<provider>[/<tier>] 이다` };
  const role = token.slice(0, eq).trim();
  const value = token.slice(eq + 1).trim();
  if (!isModelRole(role)) {
    return { ok: false, message: `'${role}' 은 알려진 역할이 아니다 (허용: ${MODEL_ROLES.join('|')})` };
  }
  if (!value) return { ok: false, message: `'${role}=' 에 값이 없다 — provider 나 /tier 중 하나는 줘야 한다` };
  const slash = value.indexOf('/');
  const provider = slash < 0 ? value : value.slice(0, slash).trim();
  const tier = slash < 0 ? '' : value.slice(slash + 1).trim();
  if (slash >= 0 && !tier) return { ok: false, message: `'${token}' — '/' 뒤에 tier 가 없다` };
  const raw: Record<string, unknown> = {};
  if (provider) raw.provider = provider;
  if (tier) raw.tier = tier;
  return { ok: true, role, raw };
}

/** ★ `--role-llm` 값 목록을 override 맵으로. ⛔ 하나라도 틀리면 «전체»를 거부한다 —
 *  일부만 먹고 일부는 조용히 버려지는 것이 이 축에서 가장 나쁜 실패다(F42). */
export function parseRoleLlmFlags(values: readonly string[]): RoleLlmFlagParse {
  const overrides: RoleLlmConfig = {};
  for (const token of values) {
    const one = parseOne(String(token));
    if (!one.ok) return { ok: false, message: one.message };
    const entry = parseRoleLlmEntry(one.raw);
    if (!entry.ok) return { ok: false, message: `'${token}' — ${entry.reason}` };
    overrides[one.role] = entry.spec;
  }
  return { ok: true, overrides };
}

/** 사람이 읽는 한 줄 — 슬래시·CLI 가 공유한다. */
export function formatRoleLlmSpec(role: ModelRole, spec: RoleLlmConfig[ModelRole]): string {
  if (!spec) return `${role}: (없음 — 전역/기본 사다리)`;
  const parts = [
    spec.provider ? `provider=${spec.provider}` : null,
    spec.tier ? `tier=${spec.tier}` : null,
    spec.model ? `model=${spec.model}` : null,
  ].filter(Boolean);
  return `${role}: ${parts.join(' · ')}`;
}
