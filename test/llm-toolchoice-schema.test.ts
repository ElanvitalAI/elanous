import { describe, expect, test } from 'bun:test';

import { strictifyToolSchema, toChatToolChoice, toResponsesToolChoice, toOpenAITools, toCodexResponsesTools, streamLLMWithTools, type LLMProvider, type LLMStreamEvent, type ToolChoice } from '../src/llm.js';

// ─────────────────────────────────────────────────────────────────────────
// #2 — schema strict (additionalProperties:false, free-form 보호, 재귀)
// ─────────────────────────────────────────────────────────────────────────
describe('strictifyToolSchema', () => {
  test('object WITH properties → additionalProperties:false 추가', () => {
    const r = strictifyToolSchema({ type: 'object', properties: { a: { type: 'string' } } }) as any;
    expect(r.additionalProperties).toBe(false);
    expect(r.properties.a).toEqual({ type: 'string' });
  });

  test('free-form object (properties 없음) → 그대로(추가 안 함·digEvidence 보호)', () => {
    const r = strictifyToolSchema({ type: 'object' }) as any;
    expect('additionalProperties' in r).toBe(false);
  });

  test('빈 properties({}) → 그대로(추가 안 함·placeholder 도구 보호)', () => {
    const r = strictifyToolSchema({ type: 'object', properties: {} }) as any;
    expect('additionalProperties' in r).toBe(false);
    expect(r.properties).toEqual({});
  });

  test('caller 가 이미 additionalProperties 설정 → 존중(덮어쓰지 않음)', () => {
    const r = strictifyToolSchema({ type: 'object', properties: { a: {} }, additionalProperties: true }) as any;
    expect(r.additionalProperties).toBe(true);
  });

  test('중첩 object properties → 재귀 적용', () => {
    const r = strictifyToolSchema({
      type: 'object',
      properties: { nested: { type: 'object', properties: { x: { type: 'number' } } } },
    }) as any;
    expect(r.additionalProperties).toBe(false);
    expect(r.properties.nested.additionalProperties).toBe(false);
  });

  test('array items + anyOf → 재귀', () => {
    const r = strictifyToolSchema({
      type: 'object',
      properties: {
        list: { type: 'array', items: { type: 'object', properties: { k: {} } } },
        u: { anyOf: [{ type: 'object', properties: { p: {} } }, { type: 'string' }] },
      },
    }) as any;
    expect(r.properties.list.items.additionalProperties).toBe(false);
    expect(r.properties.u.anyOf[0].additionalProperties).toBe(false);
  });

  test('원본 불변(mutate 안 함)', () => {
    const orig = { type: 'object', properties: { a: {} } };
    strictifyToolSchema(orig);
    expect('additionalProperties' in orig).toBe(false);
  });

  test('non-object(primitive/null) → 그대로', () => {
    expect(strictifyToolSchema(null)).toBeNull();
    expect(strictifyToolSchema('x')).toBe('x');
  });
});

describe('tool builders 가 strict 적용', () => {
  const tool = { name: 't', description: 'd', parameters: { type: 'object', properties: { a: { type: 'string' } } } };

  test('toOpenAITools → additionalProperties:false', () => {
    const r = toOpenAITools([tool])!;
    expect((r[0].function.parameters as any).additionalProperties).toBe(false);
  });

  test('toCodexResponsesTools → additionalProperties:false + {type,name} shape', () => {
    const r = toCodexResponsesTools([tool])!;
    expect(r[0].type).toBe('function');
    expect(r[0].name).toBe('t');
    expect((r[0].parameters as any).additionalProperties).toBe(false);
  });

  // Claude 격리: Anthropic 은 별도 빌더(toAnthropicTools*)를 쓰고 strictifyToolSchema
  // 를 호출하지 않는다(구조적 격리 — 원 파라미터 불변). 여기선 입력 원본이 strict 로
  // 오염되지 않았음을 확인(원본 불변 = Claude 경로가 같은 원본을 안전하게 재사용).
  test('Claude 격리 — 원본 파라미터는 strict 로 오염되지 않음(다른 빌더 안전 재사용)', () => {
    expect('additionalProperties' in (tool.parameters as any)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #1 — tool_choice 매퍼 (chat vs responses shape 차이)
// ─────────────────────────────────────────────────────────────────────────
describe('toChatToolChoice', () => {
  test('auto/required/none 그대로', () => {
    expect(toChatToolChoice('auto')).toBe('auto');
    expect(toChatToolChoice('required')).toBe('required');
    expect(toChatToolChoice('none')).toBe('none');
  });
  test('특정 도구 → {type:function, function:{name}}', () => {
    expect(toChatToolChoice({ name: 'submit' })).toEqual({ type: 'function', function: { name: 'submit' } });
  });
  test('undefined → undefined(강제 없음·회귀 안전)', () => {
    expect(toChatToolChoice(undefined)).toBeUndefined();
  });
});

describe('toResponsesToolChoice', () => {
  test('특정 도구 → required 다운그레이드 (Codex Responses 는 객체 거부·400)', () => {
    // ⚠️ model-family: Codex /responses 는 문자열만 허용 → {name} 을 'required' 로.
    expect(toResponsesToolChoice({ name: 'submit' })).toBe('required');
  });
  test('required/none/auto/undefined 문자열 그대로', () => {
    expect(toResponsesToolChoice('required')).toBe('required');
    expect(toResponsesToolChoice('none')).toBe('none');
    expect(toResponsesToolChoice('auto')).toBe('auto');
    expect(toResponsesToolChoice(undefined)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #1 — 루프 turn-0-only 강제 (일괄 방지 안전성)
// ─────────────────────────────────────────────────────────────────────────
function capturingProvider(turns: LLMStreamEvent[][], captured: (ToolChoice | undefined)[]): LLMProvider {
  let call = 0;
  return {
    name: 'scripted', defaultModel: 'd', available: () => true,
    async *streamChat(_messages, opts = {}) {
      captured.push(opts.toolChoice);
      const events = turns[call++] ?? [];
      for (const ev of events) yield ev;
    },
    async *chat() {},
  } as LLMProvider;
}

describe('streamLLMWithTools — turn-0-only tool_choice 강제', () => {
  const tools = [{ name: 'submit', description: 'd', parameters: { type: 'object', properties: {} } }];

  test('turn 0 = 강제 · turn 1 = undefined(auto·일괄 방지)', async () => {
    const captured: (ToolChoice | undefined)[] = [];
    const provider = capturingProvider([
      [{ type: 'tool_call', id: 'a', name: 'submit', args: {} }],  // turn 0 → 도구
      [{ type: 'text', delta: 'done' }],                            // turn 1 → 최종 텍스트
    ], captured);
    await streamLLMWithTools(
      [{ role: 'user', content: 'x' }],
      { onText() {}, dispatchTool: async () => ({ ok: true }) },
      { provider, tools, toolChoice: { name: 'submit' } },
    );
    expect(captured[0]).toEqual({ name: 'submit' });  // turn 0 강제
    expect(captured[1]).toBeUndefined();               // turn 1 auto — 최종 답 가능
  });

  test('toolChoice 미지정 → 전 턴 undefined(기본 동작 불변·회귀 0)', async () => {
    const captured: (ToolChoice | undefined)[] = [];
    const provider = capturingProvider([
      [{ type: 'tool_call', id: 'a', name: 'submit', args: {} }],
      [{ type: 'text', delta: 'done' }],
    ], captured);
    await streamLLMWithTools(
      [{ role: 'user', content: 'x' }],
      { onText() {}, dispatchTool: async () => ({ ok: true }) },
      { provider, tools },
    );
    expect(captured[0]).toBeUndefined();
    expect(captured[1]).toBeUndefined();
  });
});
