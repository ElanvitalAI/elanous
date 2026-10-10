// ACP 최종심판 순수 부분 테스트 — buildJudgePrompt(tool 지침 이식·#5181) + parseJudge.
import { describe, test, expect } from 'bun:test';
import { buildJudgePrompt, judgeWithAcp, parseJudge, type AcpJudgeInput } from './acp-judge.js';
import { DEFAULT_REVIEW_BACKEND } from '../agent-substrate/acp-reviewer.js';
import { debug } from '../debug/log.js';

const base: AcpJudgeInput = { diff: 'diff --git a b', context: '리뷰 지적 반영', gatePassed: true, cwd: '/r' };

// ⛔⭐⭐ 심판 기본 백엔드 회귀 가드 (2026-08-01 · 교차 리뷰 must-fix · JDG-S9).
//   내가 `acp-reviewer` 만 고치고 여기를 놓쳤고 `[T]` 가 전수로 잡았다 —
//   ***`-32602` 를 실제로 낸 것은 이 심판 경로(`--final-judge`)였다.***
//   두 곳이 갈리면 "리뷰는 codex, 심판은 claude" 가 되어 결손이 그대로 남는다.
//   ⇒ 값을 따로 적지 말고 **같은 상수**를 쓴다. 이 검사가 그 결속을 고정한다.
describe('심판 기본 백엔드', () => {
  test('리뷰어와 같은 상수를 쓴다 — 두 경로가 갈리지 않는다', async () => {
    const src = await Bun.file(new URL('./acp-judge.ts', import.meta.url)).text();
    expect(src).toContain('input.backend ?? DEFAULT_REVIEW_BACKEND');
    expect(src).not.toContain("input.backend ?? 'claude'");
    expect(DEFAULT_REVIEW_BACKEND).toBe('codex');
  });
});

describe('judgeWithAcp', () => {
  test('짧은 이름을 정규화해 매니저에 넘기고 backend transport를 관측한다', async () => {
    const calls: Array<{ backendId: string; opts: Record<string, unknown> }> = [];
    const logs: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const agent = {
      newSession: async () => 'judge-session',
      prompt: async (_sid: string, _blocks: unknown, onUpdate: (update: any) => void) => {
        onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"verdict":"merge","asks":[],"reason":"ok"}' } });
      },
      cancel: async () => {},
      selectSessionModel: async () => undefined,
    };
    const originalLog = debug.log;
    (debug as any).log = (category: string, event: string, data?: Record<string, unknown>) => { logs.push({ category, event, data }); };
    try {
      const result = await judgeWithAcp({
        ...base,
        backend: 'codex',
        agentManager: {
          getAgent: async (backendId, opts) => {
            calls.push({ backendId, opts });
            return agent as any;
          },
        },
      });
      expect(result.verdict).toBe('merge');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.backendId).toBe('codex-app-server');
      expect(logs).toContainEqual(expect.objectContaining({
        category: 'acp-judge',
        event: 'start',
        data: expect.objectContaining({
          requestedBackend: 'codex',
          backend: 'codex-app-server',
          transport: 'codex-app-server',
        }),
      }));
    } finally {
      (debug as any).log = originalLog;
    }
  });
});

describe('buildJudgePrompt', () => {
  test('tool-enabled 심판 지침 포함 — orphan/dead-code 검증 요구(#5181)', () => {
    const p = buildJudgePrompt(base);
    expect(p).toContain('read-only tools');
    expect(p).toMatch(/orphan|dead-code|imported\/used/i);
    expect(p).toContain('Do NOT edit'); // 변경/실행 금지
  });
  test('gate 상태를 사실로 명시', () => {
    expect(buildJudgePrompt({ ...base, gatePassed: true })).toContain('PASSED');
    expect(buildJudgePrompt({ ...base, gatePassed: false })).toContain('NOT PASSED');
  });
  test('diff 한도 초과 시 절단', () => {
    const big = 'x'.repeat(30000);
    const p = buildJudgePrompt({ ...base, diff: big, diffCharLimit: 100 });
    expect(p).toContain('[diff truncated]');
  });
});

describe('parseJudge', () => {
  test('merge/rework/reject 판정 파싱', () => {
    expect(parseJudge('{"verdict":"merge","asks":[],"reason":"ok"}').verdict).toBe('merge');
    expect(parseJudge('{"verdict":"rework","asks":["x 고쳐라"],"reason":"미완"}').asks).toEqual(['x 고쳐라']);
    expect(parseJudge('{"verdict":"reject","asks":[],"reason":"방향 틀림"}').verdict).toBe('reject');
  });
  test('JSON 뒤 중괄호가 있는 산문도 첫 판정을 파싱한다', () => {
    const raw = '{"verdict":"merge","asks":["keep",3],"reason":"ok"} tool output: {noise}';
    expect(parseJudge(raw)).toMatchObject({ verdict: 'merge', asks: ['keep'], reason: 'ok' });
  });
  test('코드 펜스 안 JSON을 파싱한다', () => {
    const raw = '```json\n{"verdict":"rework","asks":["x 고쳐라"],"reason":"미완"}\n```';
    expect(parseJudge(raw)).toMatchObject({ verdict: 'rework', asks: ['x 고쳐라'], reason: '미완' });
  });
  test('앞선 산문 뒤 JSON을 파싱한다', () => {
    const raw = '검토 결과입니다.\n{"verdict":"reject","asks":[],"reason":"방향 틀림"}';
    expect(parseJudge(raw)).toMatchObject({ verdict: 'reject', asks: [], reason: '방향 틀림' });
  });
  test('문자열의 중괄호와 중첩 객체를 포함한 JSON을 파싱한다', () => {
    const raw = '{"verdict":"merge","asks":[],"reason":"keep {this}","evidence":{"file":"a.ts"}}';
    expect(parseJudge(raw)).toMatchObject({ verdict: 'merge', asks: [], reason: 'keep {this}' });
  });
  // TA-LAND-MUSTFIX-ZERO — asks 가 없거나 못 읽으면 `[]` 를 «0» 으로 내지 않고 «모름» 표지를 단다.
  test('asks 없음·배열 아님·문자열 아닌 원소는 asksUnreadable · 정상 배열은 표지 없음', () => {
    expect(parseJudge('{"verdict":"merge","reason":"ok"}')).toMatchObject({ verdict: 'merge', asks: [], asksUnreadable: true });
    expect(parseJudge('{"verdict":"merge","asks":"none","reason":"ok"}').asksUnreadable).toBe(true);
    expect(parseJudge('{"verdict":"merge","asks":["keep",3],"reason":"ok"}')).toMatchObject({ asks: ['keep'], asksUnreadable: true });
    expect(parseJudge('{"verdict":"merge","asks":[],"reason":"ok"}').asksUnreadable).toBeUndefined();
  });
  test('JSON 없음은 기존 no-json 사유로 ambiguous다', () => {
    expect(parseJudge('그냥 텍스트')).toMatchObject({ verdict: 'ambiguous', asks: [], reason: 'no-json: 그냥 텍스트' });
  });
  test('손상된 균형 JSON은 기존 json-parse-fail 사유로 ambiguous다', () => {
    expect(parseJudge('{not json}')).toMatchObject({ verdict: 'ambiguous', asks: [], reason: 'json-parse-fail' });
  });
  test('알 수 없는 verdict → ambiguous', () => {
    expect(parseJudge('{"verdict":"maybe","asks":[],"reason":""}').verdict).toBe('ambiguous');
  });
});
