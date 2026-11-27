/**
 * ELN-PERSISTENCE-LADDER ③ 단위 — «진척» 판정 pure 헬퍼 시험(§⑫ 목표 루프 · OP orders ELN-UNIVERSAL-AGENT-1124).
 * 턴 상한 끊음은 «진척 없음» 기준만: 진척 = 새 파일 · 새 근거 · 새 산출.
 * ⛔ mock.module 없음 — 순수 함수 직접 주입.
 */
import { describe, expect, test } from 'bun:test';
import type { LLMMessage } from '../llm.js';
import { progressTokens, progressBeyondSignature, EMPTY_PROGRESS_TOKENS } from './goal-done-when.js';

function use(id: string, name: string, input: Record<string, unknown>): LLMMessage {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] };
}
function result(id: string, content: string): LLMMessage {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } as unknown as LLMMessage;
}

describe('ELN-PERSISTENCE-LADDER ③ — 진척 토큰 수집', () => {
  test('쓰기 도구의 대상 경로는 filePaths 로, 결과 본문은 resultHashes 로, 도구 이름은 toolNames 로 모은다', () => {
    const tokens = progressTokens([
      use('w1', 'Write', { file_path: 'src/new-module.ts', content: 'export {}' }),
      use('b1', 'bash', { command: 'ls' }),
      result('b1', 'stdout-줄-1'),
    ]);
    expect([...tokens.filePaths]).toEqual(['src/new-module.ts']);
    expect(tokens.resultHashes.size).toBe(1);
    expect([...tokens.toolNames]).toEqual(['Write', 'bash']);
  });

  test('빈 턴은 EMPTY_PROGRESS_TOKENS 와 동형이다', () => {
    const tokens = progressTokens([]);
    expect(tokens.filePaths.size).toBe(0);
    expect(tokens.resultHashes.size).toBe(0);
    expect(tokens.toolNames.size).toBe(0);
    expect(progressBeyondSignature(EMPTY_PROGRESS_TOKENS, tokens)).toBe(false);
  });
});

describe('ELN-PERSISTENCE-LADDER ③ — progressBeyondSignature(진척 없음 기준만)', () => {
  const writeA = () => progressTokens([use('w1', 'Write', { file_path: 'src/a.ts', content: 'x' })]);
  const writeA_result1 = () => progressTokens([use('w1', 'Write', { file_path: 'src/a.ts', content: 'x' }), result('w1', 'v1')]);

  test('같은 시그니처 + 같은 결과 = 진척 없음(false)', () => {
    const prev = writeA_result1();
    const curr = progressTokens([use('w1', 'Write', { file_path: 'src/a.ts', content: 'x' }), result('w1', 'v1')]);
    expect(progressBeyondSignature(prev, curr)).toBe(false);
  });

  test('같은 시그니처 + 새 결과 내용(새 근거·새 산출) = 진척(true)', () => {
    const prev = writeA_result1();
    const curr = progressTokens([use('w1', 'Write', { file_path: 'src/a.ts', content: 'x' }), result('w1', 'v2-다른-출력')]);
    expect(progressBeyondSignature(prev, curr)).toBe(true);
  });

  test('같은 시그니처 + 새 파일 경로(새 파일) = 진척(true)', () => {
    const prev = writeA();
    const curr = progressTokens([use('w1', 'Write', { file_path: 'src/b.ts', content: 'x' })]);
    expect(progressBeyondSignature(prev, curr)).toBe(true);
  });

  test('빈 결과 반복(도구만 재호출) = 진척 없음(false) — 현행 보수 유지', () => {
    const prev = writeA();
    const curr = writeA();
    expect(progressBeyondSignature(prev, curr)).toBe(false);
  });
});