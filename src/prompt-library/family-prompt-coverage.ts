// ── 계열별 프롬프트 커버리지 «자» (2026-08-18) ──────────────────────────────
//
// ⛔ 무엇을 푸는가 — 「어느 모델 계열이 «전용» 프롬프트를 받나」를 손으로 세면 매번 틀린다.
//   2026-08-18 실측에서 그 수를 두 번 다르게 읽었다(한 번은 파일 목록으로, 한 번은 switch 로).
//   ⇒ 두 층(채팅 variant · family addendum)을 «한 자»로 재서 값으로 답한다.
//
// ⭐⭐⭐ 이 자는 «관측»이지 «복제»가 아니다 (리뷰 must-fix 2026-08-18):
//   초판은 addendum 을 갖는 계열을 «손으로 적은 집합»으로 뒀다. 그러면 원본 분기가 바뀌어도
//   이 자의 값이 안 변해서, 재는 대상이 아니라 «내가 적어 둔 기억»을 재게 된다.
//   ⇒ 지금은 `buildUniversalPreamble` 을 «실제로 돌려» 계열 없는 기준선과 대조한다.
//      원본 분기를 고치면 이 자의 값이 «따라 변한다».
//
// ⭐ 이 자는 «판정»하지 않는다 — 커버리지를 그대로 돌려줄 뿐이다.
//   무엇이 결손인지는 호출자(테스트·조사)가 정한다. 자가 임계를 갖는 순간 그 임계가 늙는다.
//
// 📏 이 자가 처음 답한 값(2026-08-18): grok 만 «두 층 다» 비어 있다.
//   같은 날 뒤: grok addendum 착지 → 한 층(chat)만 빔. 이어서 grok 전용 chat variant
//   착지 → grok.chat 는 채워짐. gemini 채팅 층은 이 자가 여전히 빈 것으로 잰다.

import { getModelFamily, type ModelFamily } from '../models/prompts.js';
import { resolveBuiltinChatVariant } from './registry.js';
import { GPT_CHAT_VARIANT } from './providers/gpt.js';
import { buildUniversalPreamble } from './universal-preamble.js';

/** 커버리지를 재는 계열과, 그 계열로 판정되는 대표 모델 id.
 *  ⛔ id 는 `getModelFamily` 의 «판정 규칙»에 맞춘 것이고 실제 카탈로그 모델일 필요는 없다. */
export const FAMILY_PROBE_MODEL_IDS: Readonly<Record<Exclude<ModelFamily, 'other'>, string>> = {
  claude: 'claude-opus-4',
  codex: 'gpt-5-codex',
  gpt: 'gpt-4o',
  grok: 'grok-4.7',
  gemini: 'gemini-3-pro',
  local: 'local:qwen',
  'open-weight': 'openrouter/z-ai/glm-5.3',
};

export interface FamilyPromptCoverage {
  family: ModelFamily;
  probeModelId: string;
  /** 채팅 시스템 프롬프트가 «그 계열 전용»인가. false = default(GPT) 로 떨어진다. */
  hasDedicatedChatVariant: boolean;
  /** ⭐ 실제 preamble 산출이 «계열 없는 기준선»과 다른가 = family addendum 이 붙는가.
   *  ⛔ 손으로 적은 목록이 아니라 «돌려서» 얻은 값이다. */
  hasFamilyAddendum: boolean;
}

/** preamble 을 재는 조건. ⛔ 계열만 바꾸고 나머지는 «고정»해야 차이가 계열 탓이 된다.
 *  cwd 는 앵커 파일(AGENTS.md/CLAUDE.md)을 읽으므로 호출자가 준 값을 그대로 쓴다. */
export interface CoverageProbeOptions {
  cwd?: string;
  enabledTools?: readonly string[];
}

function preambleText(modelFamily: ModelFamily | undefined, opts: CoverageProbeOptions): string {
  const messages = buildUniversalPreamble({
    cwd: opts.cwd ?? process.cwd(),
    ...(modelFamily !== undefined ? { modelFamily } : {}),
    ...(opts.enabledTools !== undefined ? { enabledTools: [...opts.enabledTools] } : {}),
  });
  return messages.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
}

/** 한 계열의 커버리지. */
export function familyPromptCoverage(
  family: Exclude<ModelFamily, 'other'>,
  opts: CoverageProbeOptions = {},
): FamilyPromptCoverage {
  const probeModelId = FAMILY_PROBE_MODEL_IDS[family];
  // 프로브 id 가 실제로 그 계열로 판정되는지부터 확인한다 — 아니면 이 자가 «다른 계열»을 잰다.
  const resolvedFamily = getModelFamily(probeModelId);
  const variant = resolveBuiltinChatVariant(probeModelId);
  // ⭐ 기준선 = 계열을 «주지 않은» preamble. 계열 addendum 은 그 위에 얹히는 것이므로,
  //   산출이 기준선과 다르면 그 계열에 addendum 이 붙은 것이다.
  const baseline = preambleText(undefined, opts);
  const withFamily = preambleText(resolvedFamily, opts);
  return {
    family: resolvedFamily,
    probeModelId,
    // gpt 계열 자신은 GPT variant 가 «전용»이다 — default 와 같은 값이어도 결손이 아니다.
    hasDedicatedChatVariant: family === 'gpt' ? true : variant !== GPT_CHAT_VARIANT,
    hasFamilyAddendum: withFamily !== baseline,
  };
}

/** 전 계열 커버리지. 선언 순서는 `FAMILY_PROBE_MODEL_IDS` 를 따른다. */
export function allFamilyPromptCoverage(opts: CoverageProbeOptions = {}): FamilyPromptCoverage[] {
  return (Object.keys(FAMILY_PROBE_MODEL_IDS) as Array<Exclude<ModelFamily, 'other'>>)
    .map(family => familyPromptCoverage(family, opts));
}

/** 두 층이 «모두» 비어 있는 계열. ⛔ 「결손」이라는 낱말을 쓰지 않는다 —
 *  한 층만 비는 것이 의도인 계열이 있다(예: gpt 는 addendum 이 없어도 전용 variant 를 갖는다). */
export function familiesWithNeitherLayer(opts: CoverageProbeOptions = {}): ModelFamily[] {
  return allFamilyPromptCoverage(opts)
    .filter(c => !c.hasDedicatedChatVariant && !c.hasFamilyAddendum)
    .map(c => c.family);
}
