/**
 * ⛔⭐ OpenAI Chat Completions 의 «출력 상한» 칸 이름은 모델 세대로 갈린다.
 *
 * `gpt-5` 이후 계열은 `max_tokens` 를 ***거부한다*** — 400 `unsupported_parameter` 를 내고
 * *"Use 'max_completion_tokens' instead"* 라고 말한다. `gpt-4o` 계열은 반대로 옛 이름만 받는다.
 *
 * 📏 2026-08-22 실측: `provider auto` 의 티어 사다리가 `gpt-5.6-*` 로 바뀐 뒤(`#11161`)
 * 3시간 만에 이 400 이 **93건** 났고 «가속»했다(20h:2 → 21h:16 → 22h:30 → 23h:45).
 * 7일 창에서 그 이전 발생은 ***0***이다. ⇒ 칸 이름을 모델로 갈라야 한다.
 *
 * ⚠️ 값을 «안 보내는» 선택은 하지 않는다 — 상한이 사라지면 비용이 조용히 는다.
 */
/**
 * ⛔⭐⭐ **브랜드마다 «칸 이름」이 다르다**(2026-09-12). `makeOpenAICompatProvider` 는 `grok` 과
 * `openai` 를 «한 경로»로 태우는데, 종전엔 둘 다 옛 칸(`max_tokens`·`temperature`)을 «생으로» 박았다.
 * ⇒ `openai` 브랜드의 새 세대(`gpt-5`+)는 그 둘을 «거부»한다 — 400 `unsupported_parameter`.
 *
 * 📏 실측 2026-09-12: `gpt-6-astra · maxTokens=2048 · api.openai.com/v1/chat/completions` 가 400 을 받았고,
 *   그 400 이 `review.done` 미실행 57건 중 ***30건***의 사유였다(무인 리뷰가 그만큼 «안 돌았다»).
 *
 * ⭐ 자는 «이미» 있었다 — `openAiOutputTokenField`·`openAiTemperatureField`. ***이 호출부가 안 물었을 뿐이다.***
 * 🪞 같은 파일의 `stripLocalLlmSpec` 이 「두 builder 중 하나만 정규화했다」로 난 사고의 처방이었다.
 *   ***같은 모양이 다시 났다*** — 그래서 이번에도 «순수 함수로 뽑아» 양쪽이 같은 자를 쓰게 한다.
 *
 * ⛔ grok 은 옛 칸을 그대로 받는다 — 바꾸지 않는다.
 */
export function openAiCompatSamplingFields(
  brand: string,
  model: string,
  temperature: number,
  maxTokens: number,
): Record<string, number> {
  return brand === 'openai'
    ? { ...openAiTemperatureField(model, temperature), ...openAiOutputTokenField(model, maxTokens) }
    : { temperature, max_tokens: maxTokens };
}

export function openAiOutputTokenField(model: string, maxTokens: number): Record<string, number> {
  return isNewGenerationOpenAiModel(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

/** `gpt-5` 이후 계열 판정 — 옛 Chat Completions 파라미터를 거부하는 세대.
 *
 *  🩸⭐⭐ **2026-09-12 — 이 자가 «늙어서» 400 이 돌아왔다.** 종전 문면은 `/^(?:gpt-5|o[1-9])/` 라
 *  ***`gpt-6` 계열을 «못 봤다»***. 그래서 `gpt-6-astra` 가 `max_tokens` 로 나갔고 400 을 받았다:
 *    `Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens'`
 *  📏 실측(2026-09-12 · 12시간 창): `review.done` 200행 중 `reviewed=false` 57, 그중 ***30***이 이 400 이다.
 *    ⊕ 요청 로그가 그것을 한 줄로 말한다 — `gpt-6-astra · maxTokens=2048 · api.openai.com/v1/chat/completions`.
 *
 *  ⇒ ⭐ **세대를 「이름 목록」으로 세지 않는다.** 번호를 «범위»로 읽어 다음 세대가 와도 안 늙게 한다.
 *    `gpt-5` 이상(두 자리 포함) ⊕ `o1`~`o9`. ⛔ `gpt-4` 이하와 로컬 모델은 종전대로 옛 칸을 쓴다.
 *
 *  🌐 **외부 그라운딩**(2026-09-12 · omni-crawl `fc-dev`) — 같은 사고가 «업스트림에도» 있었다:
 *    · `quantumnous/new-api#7211` — *"GPT-6 Astra 未命中原来的 GPT-5 前缀判断"* (똑같은 접두 판정 누락)
 *    · `genkit-ai/genkit#6320`   — *"max_tokens is sent verbatim and rejected by reasoning models"*
 *    · Azure AI docs            — `gpt-6-astra`(2026-09-03) Chat Completions ⊕ Reasoning
 *    · overchat.ai              — *"Astra does not support `temperature`, `top_p`, `top_logprobs`"*
 *      ⇒ ✅ 우리가 `temperature` 를 «생략»하는 것이 외부 사실과 «맞는다».
 *      ⚠️ `top_p`·`logprobs` 는 이 경로가 «안 보낸다»(local 프리셋 경로만 보낸다) — 그래서 조치 없음.
 *
 *  ⚖️ ⛔ **알려진 트레이드오프 — new-api 는 «반대» 결론을 냈다.** 그들은
 *    *"모든 미래 GPT 메이저를 GPT-5 로 묶으면 서로 다른 모델의 파라미터 규칙이 엮인다"* 며
 *    ***미지의 미래 메이저는 추론하지 않는다***로 갔다(명시 목록 + 날짜 스냅샷).
 *    ⇒ 우리는 «반대»를 택했다. 이유: ***목록이 늙어서 이 사고가 났기 때문***이다
 *      (이 저장소에서 실제로 리뷰 미실행 30건을 냈다). 새 규칙은 «새 관례 쪽으로» 실패한다.
 *    📌 그러므로 ***`gpt-N` 중 옛 칸을 «되찾는» 모델이 나오면 이 자가 틀린다.*** 그때는
 *      여기서 갈지 말고 «모델별 능력 선언»으로 옮긴다(new-api 가 간 길). 지금은 그 표본이 0이다. */
export function isNewGenerationOpenAiModel(model: string): boolean {
  const match = /^gpt-(\d+)/i.exec(model);
  if (match) return Number.parseInt(match[1]!, 10) >= 5;
  return /^o[1-9]/i.test(model);
}

/**
 * ⛔⭐ 같은 세대가 `temperature` 도 거부한다 — 400 `unsupported_value`,
 * *"Only the default (1) value is supported"*.
 *
 * 📏 2026-08-22 실측: `max_tokens` 를 고친 «2분 뒤»(00:13:03Z)부터 이 400 이 났고
 * 90분에 **41건**이었다. ⇒ ***한 파라미터만 고치면 다음 파라미터에서 막힌다.***
 * ⚠️ 그때 나는 「수리 뒤 400 이 0건」이라 보고했는데, 그 자가 `grep max_completion_tokens`
 * 라서 «새 400»을 못 봤다 — ***좁은 자로 「나았다」를 읽었다.***
 *
 * ⇒ 값을 «1로 보내지» 않고 ***칸을 생략***한다. 서버 기본이 1이고, 보내면 또 다른 거부를 부른다.
 */
export function openAiTemperatureField(model: string, temperature: number): Record<string, number> {
  return isNewGenerationOpenAiModel(model) ? {} : { temperature };
}
