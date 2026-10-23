import { describe, expect, test } from 'bun:test';
import { wellFormedLLMMessages, wellFormedString } from './llm-wellformed.js';

// 실물(10-22 n8n): 이모지를 UTF-16 단위로 자른 반토막이 이력에 섞여 grok «unexpected end of hex escape» · codex 400.
const cut = '🎬 과제'.slice(1); // 낮은 반토막으로 시작
const high = '촬영 🎬'.slice(0, -1); // 높은 반토막으로 끝

describe('LLM 요청 본문 — 짝 없는 서로게이트 정리', () => {
  test('반례: 잘린 이모지가 든 본문은 JSON 직렬화 뒤 서로게이트 이스케이프가 남는다 → 정리 뒤엔 없다', () => {
    const before = JSON.stringify({ content: `${high}\n다음` });
    expect(before).toMatch(/\\ud83c/i);
    const after = JSON.stringify({ content: wellFormedString(`${high}\n다음`) });
    expect(after).not.toMatch(/\\ud8[0-9a-f]{2}/i);
    expect(wellFormedString(`${high}\n다음`)).toBe('촬영 �\n다음');
    expect(wellFormedString(cut)).toBe('� 과제');
  });

  test('정상 글(짝 맞는 이모지)은 그대로 · 바뀐 게 없으면 같은 배열 참조', () => {
    const msgs = [{ role: 'user', content: '🎬 정상' }, { role: 'assistant', content: [{ type: 'text', text: 'ok 😀' }] }];
    const r = wellFormedLLMMessages(msgs);
    expect(r.messages).toBe(msgs);
    expect(r.fixedMessages).toBe(0);
  });

  test('도구 결과·도구 입력 깊은 곳의 반토막도 고치고, 바뀐 메시지만 새로 만든다', () => {
    const ok = { role: 'user', content: '그대로' };
    const bad = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: `미리보기 ${high}` }] },
        { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: `echo ${cut}` } },
      ],
    };
    const r = wellFormedLLMMessages([ok, bad]);
    expect(r.fixedMessages).toBe(1);
    expect(r.fixedStrings).toBe(2);
    expect(r.messages[0]).toBe(ok);
    expect(JSON.stringify(r.messages[1])).not.toMatch(/\\ud8[0-9a-f]{2}|\\udc[0-9a-f]{2}/i);
    expect(bad.content[0]!.content![0]!.text).toBe(`미리보기 ${high}`); // 원본은 건드리지 않는다
  });
  test('r1 반례: 객체 키의 반토막 · 아주 깊은 곳(40단)의 반토막도 고친다 · 순환은 멈춘다', () => {
    const keyBad = { role: 'assistant', content: [{ type: 'tool_use', id: 'u', name: 'X', input: { [`k${high}`]: 1 } }] };
    let deep: Record<string, unknown> = { text: `끝 ${high}` };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    const deepBad = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: deep }] };
    const r = wellFormedLLMMessages([keyBad, deepBad]);
    expect(r.fixedMessages).toBe(2);
    expect(JSON.stringify(r.messages)).not.toMatch(/\\ud8[0-9a-f]{2}|\\udc[0-9a-f]{2}/i);
    const cyclic: Record<string, unknown> = { text: 'ok' };
    cyclic.self = cyclic;
    expect(wellFormedLLMMessages([cyclic]).fixedMessages).toBe(0);
  });
});
