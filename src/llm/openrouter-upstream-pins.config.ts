// OR-DEEPSEEK-TUNE — OpenRouter 상류 고정 «설정 기본값»(데이터만 · 로직 없음).
//
// 키 = OpenRouter wire 모델 id(`openrouter/` 를 뗀 것) · 값 = 본문 `provider.order` 로 실을 상류 slug(⊕ allow_fallbacks:false).
// ⛔ 이 표는 코드가 아니라 «설정 기본값»이다 — 사용자 설정 `llm.openrouter.upstreamPins` 가 모델별로 덮는다
//    (빈 배열 `[]` = 그 모델은 고정하지 않음 · OpenRouter 기본 라우팅). `llm.openrouter.providerPreferences` 에
//    `order`·`only`·`allow_fallbacks` 중 하나라도 있으면 그것이 이기고 이 표는 쓰이지 않는다.
// ⛔ 표에 없는 모델은 고정하지 않는다.
//
// 📏 선정(2026-10-11 · OP 결정 ⓑ) — 공개 `GET /api/v1/models/deepseek/<slug>/endpoints`(인증 없음) 실측:
//   기준 = 데이터 학습 안 함 ⊕ max_completion_tokens ≥ 131072 ⊕ uptime_last_1d ≥ 99.
//   ⚠️ 공개 endpoint 데이터엔 학습 정책 칸이 «없다» → 학습 여부는 우리 계정 Guardrails(학습 금지) 실측으로 갈랐다:
//      라우팅 퍼널에서 «Paid model training violation» 으로 걸러진 것은 `deepseek`(공식) 하나뿐이었고, 아래 고른 상류는
//      실호출 200 으로 통과를 확인했다.
//   동률(uptime 100 다수) → fp4 제외 · tool_choice=required 지원 · 입출력 단가 합이 가장 낮은 곳.
//   ⊕ 4번째 기준(OP 2026-10-11) «2턴째 캐시 적중 > 0.5»(2턴 도구 교환 실호출) · 판촉 할인가 엔드포인트(baidu)는 제외.
//   - deepseek-v4-pro-0813 → streamlake · out 384000 · uptime 1d 99.86 · $0.66 / $1.98 per MTok (cache read $0.022)
//       실측 2턴째 캐시: baidu/fp8 0(제외) → streamlake 0.94(선정) · alibaba 0.94(통과 · 차순위)
//   - deepseek-v4.1-flash  → deepinfra/fp8 · out 131072 · uptime 1d 100 · $0.14 / $0.42 per MTok (cache read $0.0042)
//       실측 2턴째 캐시 0.98
//   ⚠️ endpoint 의 `supports_implicit_caching` 은 위 상류 모두 false 였다 — 캐시는 이 칸이 아니라 실호출로 가른다.
//   값이 늙는다 — 다시 재려면 위 endpoint 를 같은 기준으로 다시 정렬한다.
export const DEFAULT_OPENROUTER_UPSTREAM_PINS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'deepseek/deepseek-v4-pro-0813': Object.freeze(['streamlake']),
  'deepseek/deepseek-v4.1-flash': Object.freeze(['deepinfra/fp8']),
});
