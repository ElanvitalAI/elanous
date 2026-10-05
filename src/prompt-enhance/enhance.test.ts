import { describe, it, expect, spyOn } from 'bun:test';
import { enhancePrompt, parseEnhanceJson, extractChecklistFallback } from './enhance.js';
import * as llm from '../llm.js';
import { debug } from '../debug/log.js';

// 발표덱 드리프트 사건의 원문 축약본 — 구체 항목/장수 지시 포함.
const MISSION = `엘라누스는 무엇인가
 - claude code 누출 이후 시작 (2026.4)
 - PFC(전전두엽) 모방
 - 기억 시스템, 미엘린 시스템, 헤마

자원들 (HW)
 - 맥북 M5 MAX 128GB(메인 서버), 맥스튜디오 M3 Ultra 512GB

엘라누스 셀프 하니스 시스템 설명 (3장 )
  - 2장의 mermaid 차트 => 기본 구조와 자동 리뷰 시스템
  - PTY 가 무엇인지
  => 이미지로 PTY 잘 설명 필요함`;

describe('enhance — verbatim 보존 불변식', () => {
  it('disabled 모드는 원문을 fenced 로만 감싼다(순수 verbatim)', async () => {
    const r = await enhancePrompt(MISSION, { disabled: true });
    expect(r.verbatimPreserved).toBe(true);
    expect(r.enhanced).toContain(MISSION); // 원문 글자 그대로
    expect(r.enhancedBy).toBe('fallback');
    expect(r.checklist).toEqual([]);
  });

  it('원문이 enhanced 안에 항상 글자 그대로 포함된다(구조적 보장)', async () => {
    // disabled 로 네트워크 없이 검증(가산 경로도 assemble 이 원문을 통째 임베딩하므로 동일 불변).
    const r = await enhancePrompt(MISSION, { disabled: true });
    expect(r.enhanced.includes(MISSION)).toBe(true);
  });

  it('선택 실물 수는 ask 원문 밖의 스캐폴드에만 가산한다', async () => {
    const raw = '원문은 그대로 둔다.';
    const measurement = 'fixtures/count-target: top-level files 1, direct directories 1, symbolic links 1';
    const stream = spyOn(llm, 'streamLLM').mockResolvedValue('{"goal":"","constraints":[],"checklist":["preserve"]}');
    try {
      const r = await enhancePrompt(raw, { directoryMeasurement: measurement });

      expect(r.original).toBe(raw);
      expect(r.enhanced).toContain(`## 저작기 관측 실물 수\n${measurement}`);
      expect(r.enhanced.indexOf(measurement)).toBeGreaterThan(r.enhanced.indexOf(`\`\`\`\n${raw}\n\`\`\``));
    } finally {
      stream.mockRestore();
    }
  });

  it('실물 수 선택 인자가 없으면 현재 스캐폴드 결과를 유지한다', async () => {
    const raw = '원문은 그대로 둔다.';
    const withoutMeasurement = await enhancePrompt(raw, { disabled: true });

    expect(withoutMeasurement.enhanced).toBe(`\`\`\`\n${raw}\n\`\`\``);
    expect(withoutMeasurement.enhanced).not.toContain('저작기 관측 실물 수');
  });
});

describe('extractChecklistFallback — 원문 항목 커버리지 추출', () => {
  const items = extractChecklistFallback(MISSION);

  it('구체 항목·장수 지시를 항목으로 뽑는다', () => {
    const joined = items.join('\n');
    expect(joined).toContain('mermaid');
    expect(joined).toMatch(/3장|셀프 하니스/);
    expect(joined).toMatch(/128GB|M5 MAX/);
    expect(joined).toContain('PTY'); // 이미지로 PTY 설명 지시
  });

  it('빈 줄/구분선만 있는 라인은 항목이 아니다', () => {
    expect(items.every((i) => i.length > 1 && !/^=+$|^-+$/.test(i))).toBe(true);
  });

  it('과다 방지 캡(<=60)', () => {
    expect(items.length).toBeLessThanOrEqual(60);
  });
});

describe('parseEnhanceJson', () => {
  it('정상 JSON 파싱', () => {
    const p = parseEnhanceJson('앞말 {"goal":"덱 생성","constraints":["누락금지"],"checklist":["A","B"]} 뒷말');
    expect(p).not.toBeNull();
    expect(p!.goal).toBe('덱 생성');
    expect(p!.checklist).toEqual(['A', 'B']);
  });

  it('checklist 비면 null(폴백 유도)', () => {
    expect(parseEnhanceJson('{"goal":"x","constraints":[],"checklist":[]}')).toBeNull();
  });

  it('JSON 아니면 null', () => {
    expect(parseEnhanceJson('그냥 텍스트')).toBeNull();
  });

  it('의역된 항목도 모델이 생성 시점에 준 요청·보존 출처를 그대로 보존한다', () => {
    const p = parseEnhanceJson(JSON.stringify({
      goal: 'g',
      constraints: [],
      checklist: ['기존 반환 필드의 의미를 유지한다', '새 메타데이터를 가산한다'],
      checklistProvenance: ['preservation', 'request'],
    }));

    expect(p?.checklist).toEqual(['기존 반환 필드의 의미를 유지한다', '새 메타데이터를 가산한다']);
    expect(p?.checklistProvenance).toEqual(['preservation', 'request']);
  });

  it('출처가 없거나 유효하지 않으면 보존으로 추측하지 않고 unknown으로 정규화한다', () => {
    const missing = parseEnhanceJson('{"goal":"g","constraints":[],"checklist":["A","B"]}');
    const invalid = parseEnhanceJson('{"goal":"g","constraints":[],"checklist":["A","B"],"checklistProvenance":["request","preserve"]}');

    expect(missing?.checklistProvenance).toEqual(['unknown', 'unknown']);
    expect(invalid?.checklistProvenance).toEqual(['request', 'unknown']);
  });
});

describe('enhance — LLM usage 관측', () => {
  it('usage 이벤트마다 원값을 기록하고 결과 텍스트를 유지한다', async () => {
    const stream = spyOn(llm, 'streamLLM').mockImplementation(async (_messages, _onChunk, opts) => {
      opts?.onUsage?.({ provider: 'anthropic', inputTokens: 21, outputTokens: 9, cacheReadInputTokens: 4 });
      opts?.onUsage?.({ outputTokens: 1, cacheCreationInputTokens: 6 });
      return '{"goal":"g","constraints":["c"],"checklist":["item"]}';
    });
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      const result = await enhancePrompt('keep this raw prompt', { model: 'usage-model' });
      expect(result.enhancedBy).toBe('llm');
      expect(result.enhanced).toContain('keep this raw prompt');
      const usageLogs = log.mock.calls.filter((call) => call[0] === 'llm.usage' && call[1] === 'llm-usage');
      expect(usageLogs.map((call) => call[2])).toEqual([
        {
          site: 'prompt-enhance', model: 'usage-model', provider: 'anthropic',
          inputTokens: 21, outputTokens: 9, cacheReadInputTokens: 4,
          cost: { kind: 'unknown', model: 'usage-model' },
        },
        {
          site: 'prompt-enhance', model: 'usage-model',
          outputTokens: 1, cacheCreationInputTokens: 6,
          cost: { kind: 'unknown', model: 'usage-model' },
        },
      ]);
    } finally { log.mockRestore(); stream.mockRestore(); }
  });

  it('forwards raw usage to an optional caller observer without changing the enhanced result', async () => {
    const usage = [{ inputTokens: 2, outputTokens: 3 }, { outputTokens: 0 }];
    const stream = spyOn(llm, 'streamLLM').mockImplementation(async (_messages, _onChunk, opts) => {
      for (const event of usage) opts?.onUsage?.(event);
      return '{"goal":"g","constraints":[],"checklist":["item"]}';
    });
    const received: unknown[] = [];
    try {
      const result = await enhancePrompt('raw', { onUsage: (event) => received.push(event) });
      expect(received).toEqual(usage);
      expect(result.original).toBe('raw');
      expect(result.checklist).toEqual(['item']);
    } finally { stream.mockRestore(); }
  });

  it('catalog-priced models emit a known cost field, including cache tokens', async () => {
    let call = 0;
    const stream = spyOn(llm, 'streamLLM').mockImplementation(async (_messages, _onChunk, opts) => {
      call += 1;
      if (call === 1) {
        opts?.onUsage?.({ inputTokens: 1_000_000, outputTokens: 0 });
      } else {
        opts?.onUsage?.({
          provider: 'anthropic',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 1_000_000,
          cacheCreationInputTokens: 1_000_000,
        });
      }
      return '{"goal":"g","constraints":["c"],"checklist":["item"]}';
    });
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await enhancePrompt('keep this raw prompt', { model: 'gpt-5.6-terra' });
      await enhancePrompt('keep this raw prompt', { model: 'claude-sonnet-4-6' });
      const usageLogs = log.mock.calls.filter((call) => call[0] === 'llm.usage' && call[1] === 'llm-usage');
      expect(usageLogs.map((call) => call[2])).toEqual([
        {
          site: 'prompt-enhance', model: 'gpt-5.6-terra',
          inputTokens: 1_000_000, outputTokens: 0,
          cost: { kind: 'known', model: 'gpt-5.6-terra', usd: 2, source: 'catalog', cacheReadPricedAt: 'input-rate', cacheWritePricedAt: 'input-rate' },
        },
        {
          site: 'prompt-enhance', model: 'claude-sonnet-4-6',
          provider: 'anthropic', inputTokens: 0, outputTokens: 0,
          cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000,
          cost: { kind: 'known', model: 'claude-sonnet-4-6', usd: 4.05, source: 'catalog', cacheReadPricedAt: 'cache-read', cacheWritePricedAt: 'cache-write' },
        },
      ]);
    } finally { log.mockRestore(); stream.mockRestore(); }
  });

  it('usage logging failure is swallowed and does not trigger fallback', async () => {
    const stream = spyOn(llm, 'streamLLM').mockImplementation(async (_messages, _onChunk, opts) => {
      opts?.onUsage?.({ inputTokens: 1 });
      return '{"goal":"g","constraints":["c"],"checklist":["item"]}';
    });
    const log = spyOn(debug, 'log').mockImplementation(((category: string) => {
      if (category === 'llm.usage') throw new Error('usage log failed');
    }) as typeof debug.log);
    try {
      expect((await enhancePrompt('still enhanced')).enhancedBy).toBe('llm');
    } finally { log.mockRestore(); stream.mockRestore(); }
  });
});

describe('enhance — checklist 출처 생성 계약', () => {
  it('모델에 checklist와 병렬 출처를 생성하도록 요청하고 결과의 문자열 checklist를 유지한다', async () => {
    const stream = spyOn(llm, 'streamLLM').mockResolvedValue(JSON.stringify({
      goal: 'g',
      constraints: ['c'],
      checklist: ['의역된 보존 계약', '새 요청을 구현한다'],
      checklistProvenance: ['preservation', 'request'],
    }));
    try {
      const result = await enhancePrompt('불변식: 기존 계약을 보존한다.\n새 요청: 출처를 추가한다.');
      const system = String((stream.mock.calls[0]?.[0] as { content: string }[])[0]!.content);

      expect(system).toContain('checklistProvenance');
      expect(result.checklist).toEqual(['의역된 보존 계약', '새 요청을 구현한다']);
      expect(result.checklistProvenance).toEqual(['preservation', 'request']);
    } finally {
      stream.mockRestore();
    }
  });

  it('legacy 모델 응답에는 unknown 출처를 가산하고 기존 문자열 checklist를 그대로 반환한다', async () => {
    const stream = spyOn(llm, 'streamLLM').mockResolvedValue('{"goal":"g","constraints":["c"],"checklist":["legacy item"]}');
    try {
      const result = await enhancePrompt('기존 응답을 받는다.');

      expect(result.checklist).toEqual(['legacy item']);
      expect(result.checklistProvenance).toEqual(['unknown']);
    } finally {
      stream.mockRestore();
    }
  });
});

// ⭐ SCQA 요약(`situation`/`complication`) — 접지 사실을 준 호출자에게만 생성되고,
//   ***입력을 옮겨 적은 요약은 버려진다***. 무인 리뷰 must-fix(2026-08-08)가 요구한 경우들을 고정한다.
describe('enhance — SCQA 요약과 echo 가드', () => {
  const FACT_A = 'src/a.ts — verified the sole call site expands every checklist item into its own line.';
  const FACT_B = 'src/b.ts — verified the regression contract asserts per-item rendering.';
  const ASK = '수용 기준이 너무 많다. 간략하게 줄여라.';

  const replyWith = (payload: Record<string, unknown>) =>
    spyOn(llm, 'streamLLM').mockImplementation(async () => JSON.stringify({
      goal: 'g',
      constraints: ['c'],
      checklist: ['x'],
      ...payload,
    }));

  it('groundedFacts 를 안 주면 요약을 요구하지도 받지도 않는다', async () => {
    const spy = replyWith({ situation: '이것은 요약이다', complication: '이것이 문제다' });
    try {
      const r = await enhancePrompt(ASK);
      // 프롬프트가 그 필드를 언급하지 않으므로, LLM 이 보내도 «쓰지 않는다»는 계약이 아니다 —
      // 계약은 「요구하지 않는다」이고, 그 관측 가능한 형태는 시스템 프롬프트에 두 항목이 없는 것이다.
      const system = String((spy.mock.calls[0]?.[0] as { content: string }[])[0]!.content);
      expect(system).not.toContain('situation —');
      expect(system).not.toContain('complication —');
      expect(r.checklist.length).toBeGreaterThan(0);
    } finally { spy.mockRestore(); }
  });

  it('groundedFacts 를 주면 요약을 요구하고 접지 사실을 참고 입력으로 싣는다', async () => {
    const spy = replyWith({ situation: '한 자리가 항목마다 줄을 만든다', complication: '그래서 문서가 무거워진다' });
    try {
      const r = await enhancePrompt(ASK, { groundedFacts: [FACT_A, FACT_B] });
      const messages = spy.mock.calls[0]?.[0] as { content: string }[];
      expect(String(messages[0]!.content)).toContain('4. situation');
      expect(String(messages[1]!.content)).toContain(FACT_A);
      expect(r.situation).toBe('한 자리가 항목마다 줄을 만든다');
      expect(r.complication).toBe('그래서 문서가 무거워진다');
    } finally { spy.mockRestore(); }
  });

  it('접지 사실을 글자 그대로 옮긴 요약은 «버린다»(양쪽)', async () => {
    const spy = replyWith({ situation: FACT_A, complication: `앞말 ${FACT_B} 뒷말` });
    try {
      const r = await enhancePrompt(ASK, { groundedFacts: [FACT_A, FACT_B] });
      expect(r.situation).toBeUndefined();
      expect(r.complication).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it('한쪽만 옮겨 적었으면 그 한쪽만 버린다', async () => {
    const spy = replyWith({ situation: '상태를 내 말로 썼다', complication: FACT_B });
    try {
      const r = await enhancePrompt(ASK, { groundedFacts: [FACT_A, FACT_B] });
      expect(r.situation).toBe('상태를 내 말로 썼다');
      expect(r.complication).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it('접지 사실의 «설명부»만 옮겨도 버린다', async () => {
    const detail = FACT_A.slice(FACT_A.indexOf(' — ') + 3);
    const spy = replyWith({ situation: `요약: ${detail}`, complication: '문제다' });
    try {
      const r = await enhancePrompt(ASK, { groundedFacts: [FACT_A] });
      expect(r.situation).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it('원문(ask)을 되풀이한 요약도 버린다', async () => {
    const spy = replyWith({ situation: ASK, complication: '문제다' });
    try {
      const r = await enhancePrompt(ASK, { groundedFacts: [FACT_A] });
      expect(r.situation).toBeUndefined();
      expect(r.complication).toBe('문제다');
    } finally { spy.mockRestore(); }
  });

  it('빈 문자열은 «안 준 것»과 같다', async () => {
    const spy = replyWith({ situation: '   ', complication: '' });
    try {
      const r = await enhancePrompt(ASK, { groundedFacts: [FACT_A] });
      expect(r.situation).toBeUndefined();
      expect(r.complication).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it('LLM 이 던지면 요약 없이 폴백한다', async () => {
    const spy = spyOn(llm, 'streamLLM').mockImplementation(async () => { throw new Error('boom'); });
    try {
      const r = await enhancePrompt(ASK, { groundedFacts: [FACT_A] });
      expect(r.enhancedBy).toBe('fallback');
      expect(r.situation).toBeUndefined();
      expect(r.complication).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it('disabled 면 요약이 없다', async () => {
    const r = await enhancePrompt(ASK, { disabled: true, groundedFacts: [FACT_A] });
    expect(r.situation).toBeUndefined();
    expect(r.complication).toBeUndefined();
  });
});

// ⭐⭐ 판정 신호 후보 — ***휴리스틱이 5라운드 UNCONVERGEABLE 로 끝난 자리***(run-92822cd2 · 2026-08-08).
//   그 런의 리뷰가 낸 오탐 형태를 여기서 «먼저» 막는다:
//     "의미 연결이 공통 토큰 2개라는 휴리스틱뿐이라 일반어가 겹친 무관한 것에서도 신호를 생성한다"
//   ⇒ 이 판의 설계는 «규칙으로 잇지 않는다» — LLM 이 만들고, 못 만들면 «안 만든다».
describe('enhance — 판정 신호 후보', () => {
  const FACT = 'src/a.ts — verified the sole call site.';
  const ASK = '수용 기준이 너무 많다. 줄여라.';
  const replyWith = (payload: Record<string, unknown>) =>
    spyOn(llm, 'streamLLM').mockImplementation(async () => JSON.stringify({
      goal: 'g', constraints: ['c'], checklist: ['x'], ...payload,
    }));

  it('세 칸이 다 오면 그대로 싣는다', async () => {
    const spy = replyWith({ decisionSignal: { condition: 'bun test src/a.test.ts 를 돌린다', observation: '그 요약 줄의 pass 수', expectedResult: 'fail 이 0 이다' } });
    try {
      const r = await enhancePrompt(ASK, { groundedFacts: [FACT] });
      expect(r.decisionSignal).toEqual({ condition: 'bun test src/a.test.ts 를 돌린다', observation: '그 요약 줄의 pass 수', expectedResult: 'fail 이 0 이다' });
    } finally { spy.mockRestore(); }
  });

  it('⛔ 한 칸이라도 비면 «셋 다» 버린다 — 부분 신호는 「있다」와 「쓸 수 있다」를 가른다', async () => {
    for (const partial of [
      { condition: 'a', observation: 'b' },
      { condition: 'a', observation: '', expectedResult: 'c' },
      { observation: 'b', expectedResult: 'c' },
    ]) {
      const spy = replyWith({ decisionSignal: partial });
      try {
        const r = await enhancePrompt(ASK, { groundedFacts: [FACT] });
        expect(r.decisionSignal).toBeUndefined();
      } finally { spy.mockRestore(); }
    }
  });

  it('groundedFacts 를 안 주면 요구하지 않는다', async () => {
    const spy = replyWith({});
    try {
      await enhancePrompt(ASK);
      const system = String((spy.mock.calls[0]?.[0] as { content: string }[])[0]!.content);
      expect(system).not.toContain('decisionSignal');
    } finally { spy.mockRestore(); }
  });

  it('⭐ 근거의 명령을 «그대로 인용»해도 버리지 않는다 (요약과 규율이 다르다)', async () => {
    // ⛔ 요약(situation·complication)은 옮겨 적으면 «버린다». 그러나 판정 신호는 실물을 물어야 해서
    //   근거의 파일명·명령을 그대로 써야 한다 — 같은 모듈 안에서 칸마다 규율이 다르다.
    const spy = replyWith({ decisionSignal: { condition: FACT, observation: 'src/a.ts 의 그 호출부', expectedResult: '한 번만 남는다' } });
    try {
      const r = await enhancePrompt(ASK, { groundedFacts: [FACT] });
      expect(r.decisionSignal?.condition).toBe(FACT);
    } finally { spy.mockRestore(); }
  });

  it('LLM 이 던지면 신호가 없다 — 지어내지 않는다', async () => {
    const spy = spyOn(llm, 'streamLLM').mockImplementation(async () => { throw new Error('down'); });
    try {
      const r = await enhancePrompt(ASK, { groundedFacts: [FACT] });
      expect(r.decisionSignal).toBeUndefined();
    } finally { spy.mockRestore(); }
  });
});

/**
 * ⛔⭐⭐⭐ 이 절이 무는 것 — ***체크리스트의 「용도」가 프롬프트를 가르고, 그 가름이 «한쪽만» 바꾼다.***
 *
 * 📏 왜 생겼나(2026-08-09 · 소비자 전수 감사): 프롬프트가 *"이 체크리스트가 완주 판정 기준이다 —
 *   하나라도 누락되면 미완이다"* 라고 주장하는데 **호출 경로 넷 중 하나에서만 참**이다.
 *   진짜 관문은 `agent-mission/driver.ts:402` 의 `verifyCoverage` 하나뿐이고,
 *   저작 경로는 그 목록을 «문서에 렌더»할 뿐 아무것도 판정하지 않는다.
 *   그 거짓의 값이 `ACCEPTANCE CRITERIA` 문서의 **19.9%**(실측 최대 94줄)였다.
 *
 * ⛔ 그리고 이 축은 앞선 런이 «죽은» 자리다(run-b4f8f5df · 2R UNCONVERGEABLE ·
 *   *"checklist 의미 보존 실패와 관측·테스트의 Goodhart 우회가 2라운드에도 동일 반복"*).
 *   ⇒ 그래서 이 테스트는 **개수를 안 문다**. 개수를 물면 그 수를 만드는 쪽으로 최적화된다.
 *     대신 ⓐ 문면이 갈리는가 ⓑ 안 준 경로가 «한 글자도» 안 바뀌는가 ⓒ 보존 대상이 이름으로 있는가를 문다.
 */
describe('enhance — 체크리스트 «용도»가 프롬프트를 가른다', () => {
  const ASK = '대상 경로: src/x.ts\n\n불변식: 기존 계약을 안 바꾼다.\n경계: 다른 파일을 안 고친다.\n판정 신호: 조건 = 돌린다; 관측 = 산출; 기대 = 는다.';
  const capture = () => spyOn(llm, 'streamLLM').mockImplementation(async () => JSON.stringify({
    goal: 'g', constraints: ['c'], checklist: ['a', 'b'],
  }));
  const systemOf = (spy: ReturnType<typeof capture>) =>
    String((spy.mock.calls[0]?.[0] as { content: string }[])[0]!.content);

  /** ⭐ 불변식 — agent-mission 경로는 이 칸을 «안 준다». 그 판의 문면이 종전과 같아야 한다. */
  it('용도를 «안 주면» 종전 coverage-gate 문면을 그대로 받는다', async () => {
    const spy = capture();
    try {
      await enhancePrompt(ASK);
      const system = systemOf(spy);
      expect(system).toContain('이 체크리스트가 완주 판정 기준이다 — 하나라도 누락되면 미완이다.');
      expect(system).toContain('빠짐없이 추출한 문자열 배열');
      expect(system).not.toContain('원문을 «옮겨 적는 목록이 아니다»');
    } finally { spy.mockRestore(); }
  });

  it('coverage-gate 를 «명시»해도 같은 문면이다 (기본값과 동치)', async () => {
    const a = capture();
    let withoutOpt = '';
    try { await enhancePrompt(ASK); withoutOpt = systemOf(a); } finally { a.mockRestore(); }
    const b = capture();
    try {
      await enhancePrompt(ASK, { checklistUse: 'coverage-gate' });
      expect(systemOf(b)).toBe(withoutOpt);
    } finally { b.mockRestore(); }
  });

  it('authoring 은 「빠짐없이 나열」을 «안» 시키고 「고르라」고 시킨다', async () => {
    const spy = capture();
    try {
      await enhancePrompt(ASK, { checklistUse: 'authoring' });
      const system = systemOf(spy);
      expect(system).not.toContain('이 체크리스트가 완주 판정 기준이다 — 하나라도 누락되면 미완이다.');
      expect(system).not.toContain('빠짐없이 추출한 문자열 배열');
      expect(system).toContain('원문을 «옮겨 적는 목록이 아니다»');
      expect(system).toContain('«다른 결정»을 내릴 수 있는 것');
      expect(system).toContain('원문을 문장 단위로 쪼개지 않는다');
      expect(system).toContain('상한·임계·횟수를 요구하는 항목은 원문에 수치가 있으면 그 수치를 담는다.');
      expect(system).toContain('수치를 임의로 정하지 말라는 방어를 붙이지 말고');
      expect(system).toContain('기존 이름의 「미결 항목」으로 올린다.');
    } finally { spy.mockRestore(); }
  });

  /**
   * ⭐⭐ 앞선 런이 «의미 보존 실패»로 죽었다. 그래서 보존 대상을 프롬프트에 «이름으로» 둔다 —
   *   이 넷이 빠지면 골 문서의 해당 절이 «빈다»(각각 다른 소비자가 읽는다).
   */
  it('authoring 문면이 «항상 남길 넷»을 이름으로 든다', async () => {
    const spy = capture();
    try {
      await enhancePrompt(ASK, { checklistUse: 'authoring' });
      const system = systemOf(spy);
      for (const name of ['「불변식」', '「경계」', '「판정 신호」', '대상 경로']) {
        expect(system).toContain(name);
      }
    } finally { spy.mockRestore(); }
  });

  /** ⛔ 관측은 «분모»만 낸다 — 「그중 몇 개가 남았나」는 퍼지 매칭이라 안 센다(그것이 Goodhart 자리다). */
  it('checklist-shape 관측이 용도·항목수·ask 표지수를 낸다', async () => {
    const spy = capture();
    const log = spyOn(debug, 'log').mockImplementation(() => undefined);
    try {
      await enhancePrompt(ASK, { checklistUse: 'authoring' });
      const shape = log.mock.calls
        .find((call) => call[0] === 'prompt-enhance' && call[1] === 'checklist-shape')?.[2] as
        { checklistUse: string; items: number; askMarkers: number } | undefined;
      expect(shape).toMatchObject({ checklistUse: 'authoring', items: 2 });
      // ask 에 불변식·경계·판정 신호가 각각 하나씩 = 셋. ⛔ 체크리스트 문면과 대조하지 «않는다».
      expect(shape?.askMarkers).toBe(3);
    } finally { log.mockRestore(); spy.mockRestore(); }
  });
});
