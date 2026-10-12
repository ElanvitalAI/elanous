/** OpenRouter(`openrouter/…`) GLM·Kimi·Qwen 전용 도구 호출 규율 — 다른 군 상수와 합성하지 않는 독립 상수.
 *
 *  2026-10-11 GLM-PROMPT-TUNE 첫 조각: `llm.ts` 동결(RFC #25983)을 위해 상수를 이 파일로 옮겼다.
 *  줄 둘을 추가했다 — 실측 약점 둘을 겨냥한다:
 *    ⑴ 그라운딩 비교 8회 중 GLM 3회 전부 «Grep 으로만 확인하고 Read 는 안 했다»고 스스로 적고
 *       그 경로를 증거로 써 grounding-evidence 기각
 *    ⑵ 상 칸에서 PR 없이 라운드만 도는 no-progress(부검반 ×26)
 *  다른 군(codex·grok·local·claude·gemini·gpt·other)의 요청 바이트는 불변 — 이 상수는
 *  open-weight 계열에만 주입된다(`TOOL_DISCIPLINE_BY_FAMILY`).
 *
 *  ⛔ `llm.ts` 의 `selectIntentClassificationMessages` 가 이 상수와 «정확 일치»로 분류기를
 *     걸러 내므로, 주입부는 상수를 그대로 싣는다(합성 금지). */
export const OPEN_WEIGHT_TOOL_DISCIPLINE = [
  '[open-weight tool-use discipline]',
  '- 도구로 할 수 있는 일은 이번 응답에서 바로 도구를 호출하라. "먼저 읽겠다" 또는 "확인하겠다" 같은 계획만 말하고 응답을 끝내지 마라.',
  '- 작업을 시작하는 첫 응답에는 도구 호출이 하나 이상 있어야 한다.',
  '- 도구 호출 인자는 해당 도구의 스키마에 맞는 JSON 으로 내라.',
  '- 충분한 근거가 모이면 도구 호출 없이 최종 답을 평문으로 써서 끝내라.',
  '- 증거·근거로 적는 파일은 이번 작업에서 Read 로 연 파일만 — Grep·Glob 결과만으로 내용을 단정하지 마라.',
  '- 구현을 끝냈다고 말하기 전에 바꾼 파일과 돌린 시험 명령·결과를 적어라.',
].join('\n');
