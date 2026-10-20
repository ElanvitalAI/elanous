// GPT-6(astra) 계열 행동 규율 — ⛔ 이 문면은 «내가 쓴 것이 아니라» 공식 가이드에서 옮긴 것이다.
//
// 🩸 왜 있나 (2026-09-13 🅕 · 실측 일곱 판 뒤에야 찾았다):
//    이 저장소는 `gpt-6-astra` 를 자식으로 돌리면서 ***어떤 계열 addendum 도 «안» 줬다***.
//    `universal-preamble.ts` 의 family 사슬은 codex · gemini · claude · grok «넷»이고
//    `gpt` 칸이 «없었다». 그런데 `models/prompts.ts` 는 `startsWith('gpt-5')` 만 codex 로 보내므로
//    ***`gpt-6-astra` 는 `gpt` 계열로 떨어져 규율을 하나도 못 받았다.***
//    ⊕ 그 상태로 이 저장소의 `AGENTS.md`·`CLAUDE.md`(⛔ 금지가 수백 줄)를 앵커로 받았다.
//    ⇒ 관측된 결과: ***멈춤 · 되묻기 · 서술만 하고 파일을 안 만듦*** (인계 §10·§36·§37).
//
// 📏 그라운딩 셋 — «독립으로» 같은 진단을 낸다:
//  ① `ref/codex` 에 번들된 OpenAI 공식 문서
//     `codex-rs/skills/src/assets/samples/openai-내부 문서 `prompting-guide``
//       "GPT-6 Astra … is thus more likely to ask the user a question when additional input could
//        materially change the result. ***This can cause it to stop*** when the user may expect it to
//        make reasonable assumptions and persist."
//       "It can be ***more sensitive to instructions contained in skills and other files, such as
//        `AGENTS.md`***. We ***strongly recommend*** auditing skills and other files accessible to
//        your model for instructions that could influence its behavior."
//  ② `ref/codex` `codex-rs/models-manager/models.json` — astra 전용 `instructions_template` 이
//     실제로 존재하고, 그 ***첫 두 절***이 「# When to ask the user for permission」과
//     「# Autonomy and persistence」다(커밋 `83b62a02fa`·`c4d5848b1f`·`6ae07812e2` 가 그 축의 핫픽스).
//  ③ 커뮤니티(fc-dev): `oh-my-openagent#8168` · `codex-lb#2309` ·
//     "Leaving autonomy undefined → ***Astra defaults to asking***" / "Keeping old instructions that fixed GPT-5"
//
// ⛔⭐ 공식 가이드 자신의 지침을 지킨다 — *"`prompt migration` … make a ***surgical prompt edit tied to
//    that failure***; do not rewrite a working prompt stack wholesale."*
//    ⇒ 그래서 ***절 넷***만 가져온다.
// ⛔ ***인격·문체 절은 «일부러» 안 가져왔다*** — 공식 문면은 *"Avoid section headings"* ·
//    *"Use lists only when …"* 를 말하는데, 이 저장소의 보고 요구(구조·표·판정 줄)와 정면으로 충돌한다.
//    (claude addendum 이 conciseness 지시를 일부러 뺀 것과 «같은» 판단이다.)
// ⛔ 문면을 「내 말로」 바꾸지 않는다 — 바꾸면 ①②의 근거가 사라진다.

// ═══ 2026-09-23 갱신 (🅢 · 대표 지시로 재측) ═════════════════════════════════════
// 🔑 ***이 규율이 astra «전용»이 아니라는 것을 실측했다.*** 종전 근거는 astra 의
//    `instructions_template` 하나였고, 그 뒤 GPT-6 Sol·Luna 가 나왔다(2026-09-22).
//
// 📏 `codex debug models` 전수 (codex-cli 0.155.1 · base_instructions 를 직접 대조):
//    ```
//    gpt-6-astra              21,420자   고유
//    gpt-6-sol                18,992자   고유   ← astra 와 «다르다»
//    gpt-6-luna               18,037자   고유   ← sol 과도 «다르다»
//    gpt-5.6-sol/terra/luna   17,730자   ← 셋이 «하나를 공유»
//    ```
//    ⇒ ⭐ ***5.6 은 세 변종이 프롬프트를 공유했는데 GPT-6 은 셋 다 자기 것을 가진다.***
//
// ✅ 그런데 «절 제목»을 대조하니 sol·luna 도 `# When to ask the user for permission` ⊕
//    `# Autonomy and persistence` 를 ***둘 다 가진다***(sol·luna 는 제목 16개가 «동일»).
//    ⇒ 이 addendum 이 겨눈 두 축이 sol·luna 에도 그대로 있으므로 ***그대로 붙인다.***
//    ⛔ 5.6-terra 엔 `# When to ask…` 이 «아예 없다» — 그래서 세대가 바뀌며 축이 «생긴» 것이다.
//
// ⚠️ 다만 ***sol 의 자기 프롬프트가 「멈춤」 병을 이미 누르고 있다***:
//      *"The user gets very frustrated when you stop and ask for confirmation or permission"*
//    ⇒ astra 때만큼 이 addendum 이 «무겁게» 필요하진 않을 수 있다. ⛔ 그러나 빼지 않는다 —
//      「필요 없다」는 측정이 아직 없고, 빼는 쪽이 되돌리기 비싼 방향이다.
//
// 📌 도구 표면도 갈렸다(elanous 가 «아직 안 쓰는» 것들이지만 기록해 둔다):
//      experimental_supported_tools   GPT-6 = ["send_user_message_async","clock"] · 5.6 = []
//      include_plugin/apps_usage_instructions  GPT-6 = false · 5.6 = true
//        └ 이유: GPT-6 의 base_instructions 에 `# Apps (Connectors)`·`# Plugins` 절이 «이미» 있다.
//      node_repl_auto_review_required  astra·sol = true · luna·5.6 = false
// ═══════════════════════════════════════════════════════════════════════════════

import type { LLMMessage } from '../llm.js';

/** ⛔ 이 규율이 ***원리상 못 하는*** 것. */
export const GPT6_ADDENDUM_BLIND_SPOTS: readonly string[] = [
  'scope-not-measured-here: ***범위 규율 절의 효과를 이 저장소에서 «아직 안 쟀다»*** — 근거는 바깥 표본이다. 재는 법은 그 절의 주석에',
  'not-a-family-fix: ***계열 판정기를 안 고친다*** — `modelFamily === \'codex\'` 로 갈리는 «다른 자리들»(도구 루프 상한·inspect 예산·유휴 상한 …)은 그대로다',
  'also-hits-o-series: `gpt` 계열엔 `o1-`·`o3-`·`o4-` 도 들어올 수 있다 — 이 문면은 그들에게도 해롭지 않지만 ***그들을 겨눠 쓴 것은 아니다***',
  'not-measured: ***「그래서 잘 짓는다」를 안 잰다*** — 그건 A/B 의 몫이고, 계열 수리가 선행이다',
  'anchor-still-large: ***`AGENTS.md`·`CLAUDE.md` 의 금지 표면 자체를 줄이지 않는다*** — 공식 가이드가 「감사하라」고 한 그 일은 «별개 축»이다',
];

/**
 * ⭐ 절 ①  자율과 지속 — 공식 `## Prompting best practices` §Initiative and follow-through 의
 *    ***세 프롬프트를 그대로*** 옮긴다(bias-to-action · 「can you…」 해석 · 허락의 «시점»).
 */
const GPT6_AUTONOMY = `## Autonomy and persistence (GPT-6 guidance)

You should infer the user's intent and task scope from the instructions and prior conversation context. Your job is to bias towards action and carry the user's intended task to completion.

When the user expresses intent to perform new work or fix an existing issue, persist until the user's intended goal is complete. Progress autonomously towards the user's goal (e.g. creating isolated worktrees / checkouts if needed, resolving merge conflicts, read-only actions, creating draft PRs etc.) unless they are clearly destructive or irreversible.

When the user's prompt indicates a request for action, such as "can you...", "I want to...", "help me..." and similar expressions, treat these as instructions to do the work and take action. Do not stop at acknowledging capability (e.g. "Yes…"), proposing a plan, or offering to continue. Do not settle for a partial or "helpful enough" solution that does not fully satisfy the user's task to save time, effort or tokens. If a task requires sustained work, complete all the necessary work until the intended outcome is fulfilled.

If the user's intent or task scope is unclear, progress towards the user's goal with the information available and then ask for clarification while continuing independent work.`;

/**
 * ⭐ 절 ②  허락의 «시점» — 공식 문면 ⊕ models.json 템플릿의
 *    「You MUST complete the work that is already authorized … before asking」.
 */
const GPT6_PERMISSION_TIMING = `## When to ask for permission (GPT-6 guidance)

Before asking the user clarifying questions, you should complete the work that is already authorized from context and necessary to make the proposed action concrete and reviewable. The user should be approving a concrete, reviewable result. For example, before deploying a change, writing to an external application, merging a PR or publishing a site, do all the required work first so that user approval is the final step. You don't need user permission for reversible tasks, read-only actions, reviews or fixes, or anything for which authorization is provided earlier in the session or strongly implied from the task instruction.

User authorization and preferences persist across turns. Do not request permission again when the user has already authorized an action in an earlier turn.

Do not introduce unsolicited warnings, disclaimers, approval flows, or safety/compliance checklists due to hypothetical risk.`;

/**
 * ⭐ 절 ③  스킬·앵커 파일의 «우선순위» — ***이 저장소에서 가장 중요한 절***이다.
 *    공식 가이드가 "more sensitive to instructions contained in skills and other files, such as
 *    `AGENTS.md`" 라고 경고한 그 상황이 이 저장소의 «상수»다(금지 수백 줄).
 *    ⊕ 진단 프롬프트("name and link to the exact file … quote the relevant instruction")를 함께 준다 —
 *      그러면 멈춤이 ***관측 가능***해진다(제1원칙: 자기 관측성).
 */
const GPT6_INSTRUCTION_PRECEDENCE = `## Instruction precedence and pausing (GPT-6 guidance)

The user's instructions take precedence over guidelines provided in a skill or repository instruction file (for example \`AGENTS.md\` or \`CLAUDE.md\`). If explicit user instructions conflict with those guidelines, prioritize the user's instructions.

Do not treat exceptions to requirements in local markdown and instruction files as automatically requiring user approval. Before asking for clarification, determine whether you already have authorization in the existing session and whether the rule actually applies. Resolve routine implementation choices using session context and your judgment.

If an instruction file or skill causes you to ask for permission or confirmation, pause, leave requested work unfinished, or diverge from the user's intent: name the exact file you read, quote the relevant instruction, and briefly explain how it applies. Distinguish explicit requirements from your interpretation of guidelines. If a file does not explicitly require approval, default to proceeding within the authorized scope rather than asking based on an inferred requirement.`;

/**
 * ⭐ 절 ④  시험 보정 — 공식 §Testing and verification.
 *    ⚠️ 이 저장소의 게이트 규율과 충돌하지 않는다(게이트는 «변경 파일 범위»이고, 이 절은
 *       「작은 변경에 과도한 시험을 새로 쓰지 마라」다).
 */
// ⭐⭐ 2026-09-23 신설 — ***범위 규율.*** ⛔ 이 절만은 공식 문면이 아니라 «바깥 표본»에서 왔다.
//   🩸 계기: 운영 기본을 `gpt-5.6-terra` → `gpt-6-sol · medium` 으로 옮겼다(대표 2026-09-23).
//     그런데 sol 계열은 ***과잉설계·scope creep***이 일관된 불만이다 — 독립 조사 셋이 같은 말을 했다:
//       *"More reasoning budget often leads to larger refactors, invented architecture,
//         scope drift (small fix → half the codebase), unnecessary tests"*
//       *"Sol variants still show tendencies toward broader tests or minor scope expansion
//         [at medium], but it's usually manageable with **good prompts**"*
//     그리고 ***처방까지 같이 말한다***: *"Use explicit constraints in prompts —
//       'preserve existing workflow exactly', 'minimal diff only', 'no new architecture'"*.
//   ⇒ 그래서 이 절은 「일반 미덕」이 아니라 ***방금 바꾼 모델의 알려진 실패 양상에 붙인 것***이다
//     (이 파일의 규율: *"make a surgical prompt edit tied to that failure"*).
//   ⛔⭐ ***효과는 아직 이 저장소에서 «안 쟀다».*** 재는 법:
//     같은 골을 이 절 있음/없음으로 쏘고 `+줄수` · 손댄 파일 수 · 리뷰 라운드 수를 견준다.
//     ⚠️ 한 발로는 못 가른다 — sol 의 산포가 크다는 것이 바깥 표본의 또 다른 말이다.
const GPT6_SCOPE_DISCIPLINE = `## Scope discipline (GPT-6 guidance)

Change the smallest thing that makes the stated goal true. Prefer a minimal diff over a
broader refactor, and do not introduce new architecture, abstractions, or files that the
task did not ask for.

Preserve the existing workflow and conventions of the surrounding code exactly unless the
task says to change them. When you notice an adjacent problem, name it in your report
instead of fixing it in the same change.

Add tests for what you changed. Do not rewrite an existing test's expectations to make a
new behavior pass — if an existing expectation now conflicts, say so and explain which one
is correct rather than silently adopting the new value.`;

const GPT6_TESTING_CALIBRATION = `## Testing calibration (GPT-6 guidance)

Do not write tests for reversible, low-impact changes that mirror the implementation. If you do choose to verify your work with tests, make sure that the tests are meaningful and necessary to verify implementation.

Run tests appropriate to the change and complete required checks. Once those pass, broaden or repeat testing only when new changes, failures, or unresolved concerns justify it; otherwise, continue toward completing the task.`;

// ⭐ 2026-10-18 신설 — ***진행 설명.*** ⛔ 공식 문면이 아니다 — 이 저장소 `codex-family-addendum.ts`
//   «Narrate Before Each Tool Batch» 절을 줄여 옮겼다(gpt-5 계열만 그 절을 받았다).
//   🩸 계기(결함 #87 · 대표 10-18): OPT(`gpt-6-sol`) 30분 19라운드 전부 `llm.stream consume-end`
//     `textChars=0` — 도구만 연달아 부르고 «무엇을 하는지» 한 줄도 안 냈다. TUI 가 숨긴 것이 아니다.
//   ⛔ 효과는 `consume-end` 의 `textChars>0` 라운드 비율로 잰다(전: 0/19).
const GPT6_PROGRESS_NARRATION = `## Progress narration (elanous TUI)

Before each batch of tool calls, write one short plain-text sentence in the user's language
saying what you are about to check and why. After the batch, if the next step changes, say
so in one sentence. Do not narrate routine bookkeeping calls (mailbox checks, wake-up
scheduling) one by one.`;

/** 사람이 찾을 수 있게 «출처»를 산출에도 남긴다 — ⛔ 이 줄이 없으면 다음 사람이 창작으로 읽는다. */
export const GPT6_ADDENDUM_SOURCE =
  'Source: OpenAI GPT-6 Astra prompting guidance '
  + '(developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#prompting-best-practices) '
  + 'as bundled in ref/codex openai-docs skill, plus the astra instructions_template in '
  + 'codex-rs/models-manager/models.json. Quoted, not paraphrased.';

/**
 * GPT-6(astra) 계열 행동 규율을 시스템 메시지로 낸다(공식 넷 ⊕ 범위 ⊕ 진행 설명).
 * ⛔ 순서가 뜻을 갖는다 — ***자율 → 허락의 시점 → 우선순위 → 시험***.
 *    금지(우선순위)보다 «자율»을 먼저 둔다: 이 저장소의 앵커가 이미 금지로 가득하고,
 *    관측된 실패가 ***「멈춤」***이었기 때문이다.
 */
export function buildGpt6FamilyAddendum(): LLMMessage[] {
  return [
    { role: 'system', content: `${GPT6_AUTONOMY}\n\n${GPT6_ADDENDUM_SOURCE}` },
    { role: 'system', content: GPT6_PERMISSION_TIMING },
    { role: 'system', content: GPT6_INSTRUCTION_PRECEDENCE },
    { role: 'system', content: GPT6_TESTING_CALIBRATION },
    { role: 'system', content: GPT6_SCOPE_DISCIPLINE },
    { role: 'system', content: GPT6_PROGRESS_NARRATION },
  ];
}
