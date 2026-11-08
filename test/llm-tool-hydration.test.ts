import type { LLMToolSpec } from '../src/llm/tool-spec.js';
// ── ⭐ 툴 루프 하이드레이션 흡수 (F2 gap④ · 2026-07-26) ──────────────────
//
// 소환로 3갭(#5460)을 고쳐 ToolSearch 가 스키마를 **돌려주게** 됐지만, 그것만으론
// 툴이 호출가능해지지 않았다: `streamLLMWithTools` 가 프로바이더에 넘기는 `tools`
// 배열이 루프 내내 **고정**이라, 선언 목록에 없는 함수는 프로바이더가 받지 않는다.
// 실측(5회·하니스 2종): 모델이 소환 → 여전히 못 부름 → **같은 툴 재소환** → 포기.
//
// 이 파일은 그 사슬의 마지막 고리를 못박는다 — dispatch 가 스펙을 돌려주면 **다음
// 턴의 프로바이더 tools 배열에 실제로 들어가야** 한다. 실 LLM 없이 결정론적으로:
// scripted provider 가 매 턴 받은 `opts.tools` 를 캡처한다.

import { afterEach, describe, expect, test } from 'bun:test';
import { streamLLMWithTools } from '../src/llm';
import type { LLMProvider, LLMStreamEvent } from '../src/llm';
import { HYDRATED_TOOLS_KEY } from '../src/skills/tools/tool-search-spec.js';
import { routeToolSearch } from '../src/skills/tools/tool-search-route.js';
import { __resetSnapshotStore, __resetTurnState } from '../src/undo-turn/index.js';
import { resetPlanModeState } from '../src/plan-mode/index.js';

afterEach(() => {
  __resetSnapshotStore();
  __resetTurnState();
  resetPlanModeState();
});

/** 매 턴 프로바이더가 받은 tool 이름 배열을 기록하는 scripted provider. */
function capturingProvider(
  turns: LLMStreamEvent[][],
  seen: string[][],
  histories?: unknown[],
): LLMProvider {
  let call = 0;
  return {
    name: 'scripted',
    defaultModel: 'd',
    available: () => true,
    async *streamChat(history: unknown, opts?: { tools?: readonly LLMToolSpec[] }) {
      seen.push((opts?.tools ?? []).map((t) => t.name));
      histories?.push(history);
      const events = turns[call++] ?? [];
      for (const ev of events) yield ev;
    },
    async *chat() {},
  } as unknown as LLMProvider;
}

const summoner: LLMToolSpec = { name: 'ToolSearch', description: 'summon', parameters: { type: 'object' } };
const battleship: LLMToolSpec = {
  name: 'Battleship',
  description: 'heavy autonomous tool',
  parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
};

describe('streamLLMWithTools — 하이드레이션 흡수 (gap④)', () => {
  test('⭐ 소환한 툴이 다음 턴 프로바이더 tools 에 실제로 들어간다', async () => {
    const seen: string[][] = [];
    const provider = capturingProvider([
      [{ type: 'tool_call', id: 's1', name: 'ToolSearch', args: { query: 'select:Battleship' } }],
      [{ type: 'text', delta: 'done' }],
    ], seen);

    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async () => ({
          content: '<functions>…</functions>',
          matched: ['Battleship'],
          unknown: [],
          [HYDRATED_TOOLS_KEY]: [battleship],
        }),
      },
      { provider, model: 'gpt-5.4', tools: [summoner], maxTurns: 4 },
    );

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toEqual(['ToolSearch']);              // 턴0 — 소환기만
    expect(seen[1]).toEqual(['ToolSearch', 'Battleship']); // 턴1 — 소환된 툴이 선언됨
  });

  test('하이드레이션된 툴을 다음 턴에 실제로 호출할 수 있다(사슬 완결)', async () => {
    const seen: string[][] = [];
    const dispatched: string[] = [];
    const provider = capturingProvider([
      [{ type: 'tool_call', id: 's1', name: 'ToolSearch', args: { query: 'select:Battleship' } }],
      [{ type: 'tool_call', id: 'b1', name: 'Battleship', args: { goal: 'build it' } }],
      [{ type: 'text', delta: 'done' }],
    ], seen);

    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name) => {
          dispatched.push(name);
          if (name === 'ToolSearch') {
            return { content: 'x', matched: ['Battleship'], unknown: [], [HYDRATED_TOOLS_KEY]: [battleship] };
          }
          return 'battleship-ran';
        },
      },
      { provider, model: 'gpt-5.4', tools: [summoner], maxTurns: 4 },
    );

    // 소환 → 호출. 이 순서가 실측에서 끊겨 재소환 루프가 됐던 지점.
    expect(dispatched).toEqual(['ToolSearch', 'Battleship']);
  });

  // should-fix(elanous review #5461): 표식 문자열이 아니라 **실제 routeToolSearch 결과**로
  // 찍는다 — 예약키 부재 + 구조화 스키마가 대화에 중복 직렬화되지 않음을 정직하게 본다.
  test('⭐ 프로바이더 history 에 예약키가 없고 스키마가 중복 직렬화되지 않는다', async () => {
    const seen: string[][] = [];
    const histories: unknown[] = [];
    const provider = capturingProvider([
      [{ type: 'tool_call', id: 's1', name: 'ToolSearch', args: { query: 'select:Battleship' } }],
      [{ type: 'text', delta: 'done' }],
    ], seen, histories);

    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        // 실제 프로덕션 소환 경로 그대로.
        dispatchTool: async (_n, a) => routeToolSearch(a, [battleship], { surface: 'test' }),
      },
      { provider, model: 'gpt-5.4', tools: [summoner], maxTurns: 4 },
    );

    // 소환 후 턴의 history = 모델이 실제로 읽는 것.
    const turn1 = JSON.stringify(histories[1] ?? histories[histories.length - 1]);
    expect(turn1).toContain('<functions>');              // 렌더 블록은 있어야
    expect(turn1).not.toContain(HYDRATED_TOOLS_KEY);     // 예약키는 없어야
    // ⭐ 스키마가 **정확히 1회** 직렬화됐는지. description 은 렌더된 스키마에만 등장하므로
    //   (tool_call args 에는 없다) 중복/부재를 동시에 잡는 신뢰 가능한 카운터다.
    //   `<= 1` 은 0회에도 통과해 무의미했다(재리뷰 must-fix).
    const schemaHits = turn1.split(battleship.description).length - 1;
    expect(schemaHits).toBe(1);
    // 그런데 툴은 실제로 선언됐어야 한다(하이드레이션은 살아있다).
    expect(seen[1]).toEqual(['ToolSearch', 'Battleship']);
  });

  // should-fix(elanous review #5461): 가드 기준을 opts.tools→activeTools 로 바꿨으니
  // 기존 오타-복구(대소문자)가 **양쪽 툴 모두에서** 유지되는지 못박는다.
  test('대소문자 오타복구가 기존 툴과 하이드레이션 툴 모두에서 유지된다', async () => {
    const seen: string[][] = [];
    const dispatched: string[] = [];
    const provider = capturingProvider([
      [{ type: 'tool_call', id: 's1', name: 'toolsearch', args: { query: 'select:Battleship' } }], // 기존 툴 오타
      [{ type: 'tool_call', id: 'b1', name: 'battleship', args: { goal: 'g' } }],                  // 소환 툴 오타
      [{ type: 'text', delta: 'done' }],
    ], seen);

    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async (name) => {
          dispatched.push(name);
          if (name === 'ToolSearch') {
            return { content: 'x', matched: ['Battleship'], unknown: [], [HYDRATED_TOOLS_KEY]: [battleship] };
          }
          return 'ok';
        },
      },
      { provider, model: 'gpt-5.4', tools: [summoner], maxTurns: 4 },
    );

    // 둘 다 정규 이름으로 복구돼 dispatch 돼야 한다.
    expect(dispatched).toEqual(['ToolSearch', 'Battleship']);
  });

  test('같은 툴 재소환은 중복 선언을 만들지 않는다', async () => {
    const seen: string[][] = [];
    const provider = capturingProvider([
      [{ type: 'tool_call', id: 's1', name: 'ToolSearch', args: { query: 'select:Battleship' } }],
      [{ type: 'tool_call', id: 's2', name: 'ToolSearch', args: { query: 'select:Battleship' } }],
      [{ type: 'text', delta: 'done' }],
    ], seen);

    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async () => ({
          content: 'x', matched: ['Battleship'], unknown: [], [HYDRATED_TOOLS_KEY]: [battleship],
        }),
      },
      { provider, model: 'gpt-5.4', tools: [summoner], maxTurns: 4 },
    );

    const last = seen[seen.length - 1]!;
    expect(last.filter((n) => n === 'Battleship')).toHaveLength(1);
  });

  test('하이드레이션 없는 평범한 툴 턴은 tools 를 바꾸지 않는다(무회귀)', async () => {
    const seen: string[][] = [];
    const provider = capturingProvider([
      [{ type: 'tool_call', id: 'r1', name: 'Read', args: { file_path: '/tmp/a' } }],
      [{ type: 'text', delta: 'done' }],
    ], seen);

    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      { onText: () => {}, dispatchTool: async () => 'ok' },
      {
        provider, model: 'gpt-5.4', maxTurns: 4,
        tools: [{ name: 'Read', description: 'd', parameters: { type: 'object' } }],
      },
    );

    for (const t of seen) expect(t).toEqual(['Read']);
  });

  test('dispatch 가 throw 하면 하이드레이션도 없다(실패 결과를 신뢰하지 않음)', async () => {
    const seen: string[][] = [];
    const provider = capturingProvider([
      [{ type: 'tool_call', id: 's1', name: 'ToolSearch', args: { query: 'select:Battleship' } }],
      [{ type: 'text', delta: 'done' }],
    ], seen);

    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      { onText: () => {}, dispatchTool: async () => { throw new Error('boom'); } },
      { provider, model: 'gpt-5.4', tools: [summoner], maxTurns: 4 },
    );

    for (const t of seen) expect(t).toEqual(['ToolSearch']);
  });

  // must-fix(재리뷰 #5461): 추출·삭제는 **항상** 돌아야 한다 — 결과가 에러 모양이어도
  // 예약키(모델-비대상 배관)가 대화로 새면 안 된다.
  // ⚠️ 루프의 `isError` 는 dispatch 가 **throw** 했을 때만 참이다. `{error}` 를 **반환**한
  //   결과는 정상 결과로 취급된다(기존 의미론·이 PR 범위 밖) — 그래서 여기선 채택 여부가
  //   아니라 **누출 차단**만 단언한다. throw 경로의 미채택은 별도 테스트가 덮는다.
  test('에러 모양 결과여도 예약키는 대화로 새지 않는다', async () => {
    const seen: string[][] = [];
    const histories: unknown[] = [];
    const provider = capturingProvider([
      [{ type: 'tool_call', id: 's1', name: 'ToolSearch', args: { query: 'x' } }],
      [{ type: 'text', delta: 'done' }],
    ], seen, histories);

    await streamLLMWithTools(
      [{ role: 'user', content: 'q' }],
      {
        onText: () => {},
        dispatchTool: async () => ({
          error: 'dispatch said no',
          [HYDRATED_TOOLS_KEY]: [battleship],
        }),
      },
      { provider, model: 'gpt-5.4', tools: [summoner], maxTurns: 4 },
    );

    expect(JSON.stringify(histories)).not.toContain(HYDRATED_TOOLS_KEY);
    // ⭐ 재리뷰 must-fix: 누출 차단만으론 부족 — **채택도 안 되어야** 한다.
    //   `{error}` 반환은 루프의 isError 를 세우지 않으므로 별도 판정이 필요했다.
    for (const t of seen) expect(t).toEqual(['ToolSearch']);
  });
});
