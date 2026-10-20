/**
 * ⛔⭐ 이 시험이 무는 것은 ***「공식 문면이 «그대로» 실려 astra 에 «닿는가»」***다.
 *    ⊕ 「지었는데 안 닿는다」를 막는 칸이 ***세 번째 describe*** 다(preamble 을 «실제로» 만든다).
 */
import { describe, expect, test } from 'bun:test';

import {
  GPT6_ADDENDUM_BLIND_SPOTS, GPT6_ADDENDUM_SOURCE, buildGpt6FamilyAddendum,
} from './gpt6-family-addendum.js';
import { buildUniversalPreamble } from './universal-preamble.js';
import { getModelFamily } from '../models/prompts.js';

const joined = () => buildGpt6FamilyAddendum().map((m) => String(m.content)).join('\n\n');

describe('buildGpt6FamilyAddendum — 공식 문면을 «그대로» 옮겼나', () => {
  // ⭐ 2026-09-23 — 넷 → «다섯». 신설분은 `## Scope discipline` 이고, 공식 문면이 아니라
  //   ***방금 바꾼 모델(gpt-6-sol)의 «알려진 실패 양상»에 붙인 것***이다(과잉설계·scope creep).
  //   ⛔ 수를 여기서 세는 이유는 *"절 넷만 가져온다"* 라는 규율이 «양을 제한»하기 때문이다 —
  //     늘릴 때마다 이 줄이 빨개져야 «왜 늘렸나»를 적게 된다. 그래서 핀을 «유지»한다.
  // 5→6 (2026-10-18 · 결함 #87): gpt-6 이 도구 사이에 글을 0자 냈다 → «진행 설명» 절을 더했다.
  test('절 여섯을 낸다 — 자율 · 허락의 시점 · 우선순위 · 시험 · 범위 · 진행 설명', () => {
    const msgs = buildGpt6FamilyAddendum();
    expect(msgs.length).toBe(6);
    for (const m of msgs) expect(m.role).toBe('system');
  });

  test('신설 절은 «범위 규율»이고 알려진 실패 양상을 겨눈다', () => {
    const msgs = buildGpt6FamilyAddendum().map((m) => String(m.content));
    expect(msgs[4]).toContain('Scope discipline');
    // 바깥 표본이 지목한 처방 셋이 실제로 들어 있나 (문면이 조용히 비지 않게).
    expect(msgs[4]).toContain('minimal diff');
    expect(msgs[4]).toContain('new architecture');
    expect(msgs[4]).toContain('Preserve the existing workflow');
  });

  test('신설 절 «진행 설명» 은 맨 끝이고 도구 묶음 전 한 문장을 요구한다', () => {
    const msgs = buildGpt6FamilyAddendum().map((m) => String(m.content));
    expect(msgs[5]).toContain('Progress narration');
    expect(msgs[5]).toContain('Before each batch of tool calls');
    expect(msgs[5]).toContain('one short plain-text sentence');
    // 잡무까지 하나씩 말하면 소음이 된다 — 그 제한이 조용히 빠지지 않게.
    expect(msgs[5]).toContain('Do not narrate routine bookkeeping');
  });

  test('⭐ ***순서가 뜻을 갖는다*** — 금지(우선순위)보다 «자율»이 먼저다', () => {
    const msgs = buildGpt6FamilyAddendum().map((m) => String(m.content));
    // 🩸 관측된 실패가 「멈춤」이었다 ⇒ 자율을 앞에 둔다. 순서를 뒤집으면 이 시험이 빨강.
    expect(msgs[0]).toContain('Autonomy and persistence');
    expect(msgs[1]).toContain('When to ask for permission');
    expect(msgs[2]).toContain('Instruction precedence');
    expect(msgs[3]).toContain('Testing calibration');
  });

  test('⛔⭐ 공식 «핵심 문면»이 인용 그대로 있다 — 바꾸면 근거가 사라진다', () => {
    const all = joined();
    // §Initiative and follow-through 의 세 프롬프트
    expect(all).toContain('bias towards action and carry the user\'s intended task to completion');
    expect(all).toContain('"can you...", "I want to...", "help me..."');
    expect(all).toContain('Do not stop at acknowledging capability');
    // 허락의 «시점»
    expect(all).toContain('The user should be approving a concrete, reviewable result');
    expect(all).toContain('User authorization and preferences persist across turns');
    // §Instruction following — ***이 저장소에서 가장 중요한 줄***
    expect(all).toContain('take precedence over guidelines provided in a skill');
    expect(all).toContain('AGENTS.md');
    expect(all).toContain('Do not treat exceptions to requirements in local markdown');
    // 멈춤을 «관측 가능»하게 만드는 진단 프롬프트
    expect(all).toContain('name the exact file you read, quote the relevant instruction');
    // §Testing and verification
    expect(all).toContain('Do not write tests for reversible, low-impact changes');
  });

  test('⛔⭐ ***출처가 산출에 실린다*** — 없으면 다음 사람이 «창작»으로 읽는다', () => {
    expect(joined()).toContain(GPT6_ADDENDUM_SOURCE);
    expect(GPT6_ADDENDUM_SOURCE).toContain('gpt-6-astra.md#prompting-best-practices');
    expect(GPT6_ADDENDUM_SOURCE).toContain('Quoted, not paraphrased');
  });

  test('⛔ ***인격·문체 절은 «일부러» 안 가져왔다*** — 이 저장소의 보고 요구와 충돌한다', () => {
    const all = joined();
    // 공식 문면의 문체 지시 두 개가 «없어야» 한다.
    expect(all).not.toContain('Avoid section headings');
    expect(all).not.toContain('slop words');
  });

  test('⛔ 사각이 «값으로» 있다 — 이 규율이 계열 판정기를 고치지 «않는다»', () => {
    const j = GPT6_ADDENDUM_BLIND_SPOTS.join(' ');
    expect(j).toContain('not-a-family-fix');
    expect(j).toContain('anchor-still-large');
  });
});

describe('⛔⭐⭐ 배선 — ***astra 에 «닿는가»***', () => {
  const cwd = process.cwd();

  test('`gpt-6-astra` 는 `gpt` 계열로 풀린다(현재 판정기)', () => {
    expect(getModelFamily('gpt-6-astra')).toBe('gpt');
  });

  test('✅ preamble 을 «실제로» 만들면 그 절이 «뜬다»', () => {
    const all = buildUniversalPreamble({ cwd, modelFamily: getModelFamily('gpt-6-astra') })
      .map((m) => String(m.content)).join('\n');
    expect(all).toContain('bias towards action');
    expect(all).toContain('take precedence over guidelines provided in a skill');
    expect(all).toContain(GPT6_ADDENDUM_SOURCE);
  });

  // FU-3(#28961 리뷰): 결함 #87 의 관측 대상은 `gpt-6-sol` 이다 — astra 만 재면 sol 배선이 조용히 빠져도 모른다.
  test('✅ `gpt-6-sol`·`gpt-6-luna` preamble 에도 «진행 설명» 절이 뜬다', () => {
    for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
      expect(getModelFamily(model)).toBe('gpt');
      const all = buildUniversalPreamble({ cwd, modelFamily: getModelFamily(model) })
        .map((m) => String(m.content)).join('\n');
      expect(all).toContain('Progress narration');
      expect(all).toContain('Before each batch of tool calls');
    }
  });

  test('⛔ codex 계열(terra·sol)은 «무변경» — 이 규율이 안 붙는다', () => {
    for (const model of ['gpt-5.6-terra', 'gpt-5.6-sol']) {
      const fam = getModelFamily(model);
      expect(fam).toBe('codex');
      const all = buildUniversalPreamble({ cwd, modelFamily: fam })
        .map((m) => String(m.content)).join('\n');
      expect(all).not.toContain('bias towards action');
    }
  });
});
