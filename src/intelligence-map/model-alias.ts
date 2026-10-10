// Wave 8 (2026-05-04) — model alias resolver.
//
// Pattern source — ref/opencode `provider/transform.ts` lazy alias
// matching (e.g. "claude-haiku" → "claude-haiku-4-5") + ref/gemini-cli
// `defaultModelConfigs.ts` modelConfig alias hierarchy.
//
// elanous's model id matching is prefix-based throughout the codebase
// (`m.startsWith('claude-')`, `m.startsWith('gpt-')`, etc.). When a
// user types a short alias (`haiku`, `opus`, `flash`) the prefix
// lookup misses and the request falls back to provider default. This
// helper canonicalizes the short form into the full id BEFORE the
// model-id flows through `getProvider` / `getModelFamily` / catalog
// lookup, so the rest of the pipeline doesn't need alias awareness.
//
// Conservative scope — only short aliases that map unambiguously to
// a single shipping model in BUILTIN_CATALOG. Ambiguous shorts
// (`gpt`, `claude`, `gemini` with no version) are NOT aliased — let
// the user's incomplete input surface as an error rather than guess.

/** Short alias → canonical model id. Intentionally small — only
 *  unambiguous mappings. Add new entries when a new shipping model
 *  has a clear short name. */
const MODEL_ALIASES: Readonly<Record<string, string>> = {
  // Anthropic Claude family
  'haiku':           'claude-haiku-4-5',
  'haiku-3-5':       'claude-haiku-4-5',
  // sonnet 최신 = Sonnet 5 (2026-06-30·omni-crawl 검증 2026-07-17: 실제 API
  // id 는 `claude-sonnet-5`, 뒤에 -0 없음). 구버전 alias 하위호환 유지.
  'sonnet':          'claude-sonnet-5',
  'sonnet-5':        'claude-sonnet-5',
  'sonnet-4-6':      'claude-sonnet-4-6',
  // ⭐ 2026-09-25 (대표 「모델별 최신으로」): opus 최신 = 5.5(`/v1/models` 실측 ⊕ 실호출). 판을 붙인 별칭은 하위호환.
  'opus':            'claude-opus-5-5',
  'opus-5-5':        'claude-opus-5-5',
  'opus-5':          'claude-opus-5',
  'opus-4-8':        'claude-opus-4-8',
  'opus-4-7':        'claude-opus-4-7',    // 하위호환
  // ⭐ 2026-10-10 (MK) — 5.5 세대는 판을 붙여서만 부른다(맨몸 `sonnet`·`haiku` 는 옮기지 않았다 — 별개 결정).
  //   공식 API id 는 하이픈(`claude-sonnet-5-5`)인데 OpenRouter·사람은 점(`claude-sonnet-5.5`)으로 쓴다 — 둘 다 받는다.
  'sonnet-5-5':        'claude-sonnet-5-5',
  'haiku-5-5':         'claude-haiku-5-5',
  'claude-sonnet-5.5': 'claude-sonnet-5-5',
  'claude-haiku-5.5':  'claude-haiku-5-5',
  // Google Gemini family
  'flash':           'gemini-3.8-flash',   // ⭐ 2026-09-25 최신 flash(models.list 실측)
  'flash-3-7':       'gemini-3.7-flash',
  'flash-lite':      'gemini-3.5-flash-lite',
  'flash-2-5':       'gemini-2.5-flash',
  'pro':             'gemini-3.1-pro-preview',
  'gemini-pro':      'gemini-3.1-pro-preview',
  // OpenAI / Codex
  'codex':           'gpt-6-sol',   // ⭐ 2026-09-25: 운영 codex 기본(gpt-6-sol)과 맞춘다 — gpt-5.5 는 두 세대 낡았다
  'gpt-5':           'gpt-5.5',
  'mini':            'gpt-5-mini',
  'nano':            'gpt-5-nano',
  // ⭐⭐ 2026-09-23 (대표) — ***맨몸 별칭은 «GPT-6» 을 가리킨다.*** 5.6 은 판을 붙여 부른다.
  //   🔑 왜 — `sol`·`luna` 라는 «같은 이름»이 두 세대에 걸쳐 있다. 세대를 안 쓰면
  //     «어느 세대인지 말하지 않은 것»이고, 그때 골라야 할 것은 ***최신***이다.
  //     (실제로 이 겹침 때문에 커뮤니티 조사기가 5.6 과 6 을 섞어 답한 일이 있었다.)
  //   ⛔ `terra` 는 GPT-6 에 «없다» — 중간 등급이 접혔고 GPT-6 Sol 이 그 가격대를 흡수했다.
  //     그래서 `terra` 는 5.6 을 계속 가리킨다(은퇴가 아니라 «후속이 없는» 것이다).
  //   📏 세대 확인 = `curl /v1/models` ⊕ `codex debug models` (2026-09-23 둘 다 실측).
  'astra':           'gpt-6-astra',
  'sol':             'gpt-6-sol',
  'luna':            'gpt-6-luna',
  'terra':           'gpt-5.6-terra',   // ⛔ GPT-6 에 후속 없음
  // 세대를 «명시»해 부르는 길 — 겹치는 이름을 또렷하게 가리킬 때.
  '6-sol':           'gpt-6-sol',
  '6-luna':          'gpt-6-luna',
  '5.6-sol':         'gpt-5.6-sol',
  '5.6-terra':       'gpt-5.6-terra',
  '5.6-luna':        'gpt-5.6-luna',
  // xAI Grok (2026-07-15 · Grok 4.5 정비)
  'grok':            'grok-4.7',                     // 최강 flagship (2026-08-12 GA · docs.x.ai 1차 · 500k ctx · $2/$6)
  // ⛔ 2026-08-18: 'grok-4-1-fast*' 는 xAI 에서 «grok-4.3 으로 조용히 리다이렉트»되는
  //    레거시 별칭이었다(실호출 대조). 실물 최저가 계열로 고친다.
  'grok-fast':       'grok-4.20-non-reasoning',      // $1.25/$2.50 · 2M context · non-reasoning
};

/** Resolve a possibly-aliased model id to its canonical form.
 *  Returns the input unchanged when no alias matches (so existing
 *  full ids like `claude-opus-4-7` pass through). Case-insensitive
 *  on the alias key — input case is preserved otherwise. */
export function resolveModelAlias(input: string | undefined): string | undefined {
  if (!input) return input;
  const lowered = input.toLowerCase().trim();
  const aliased = MODEL_ALIASES[lowered];
  return aliased ?? input;
}

/** Snapshot of the alias map — useful for `/models` slash output and
 *  test assertions. Returns a frozen copy so callers can't mutate the
 *  shared dictionary. */
export function listModelAliases(): Readonly<Record<string, string>> {
  return MODEL_ALIASES;
}
