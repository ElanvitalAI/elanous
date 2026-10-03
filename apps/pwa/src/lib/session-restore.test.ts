import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isLlmReplayPlaceholderLine, restorableChatMessages, stripLlmReplayPlaceholders } from './session-restore';
import type { ChatBlock } from './chat-runtime';

/** ⛔⭐⭐⭐ **복원된 화면이 「LLM 재현용 글자」로 덮이지 않는다.**
 *
 *  📏 2026-08-22 실측(16차 `[F]`): 새로고침하면 화면에 `[tool_use]` **167회** ·
 *  `[tool_result]` **167회** 가 떴다. 복원 대상 472줄 중 **327줄(69%)** 이 그 글자였다.
 *  ***대화를 열면 열 줄 중 일곱 줄이 그것이었다.***
 *
 *  ⛔ 그 글자는 «버그»가 아니라 **LLM 대화 재현용 표식**이다 ⇒ 데이터는 그대로 두고 «화면에만» 안 그린다. */

describe('LLM 재현용 자리표시자를 가린다 — 데이터는 그대로 두고 화면에만', () => {
  it('matches only a line that is entirely the placeholder', () => {
    expect(isLlmReplayPlaceholderLine('[tool_use]')).toBe(true);
    expect(isLlmReplayPlaceholderLine('[tool_result]')).toBe(true);
    expect(isLlmReplayPlaceholderLine('  [tool_use]  ')).toBe(true);
    // ⛔ 사람이 그 낱말을 «언급»한 문장은 진짜 대화다 — 지우면 대화가 사라진다.
    expect(isLlmReplayPlaceholderLine('[tool_use] 가 화면에 뜨는 게 문제야')).toBe(false);
    expect(isLlmReplayPlaceholderLine('왜 [tool_result] 가 보이지?')).toBe(false);
    expect(isLlmReplayPlaceholderLine('')).toBe(false);
  });

  /** ⛔⭐⭐ 아래 셋은 **라이브가 잡아 준 실제 모양**이다 — 1차판(메시지 단위)은 이것들을 못 잡아
   *  화면에 `[tool_use]` 가 «4개» 남았다. 저장소를 전수로 세서 모양을 확정했다. */
  it('strips placeholder lines inside a multi-line message', () => {
    expect(stripLlmReplayPlaceholders('[tool_use]\n[tool_use]\n[tool_use]')).toBe('');
    expect(stripLlmReplayPlaceholders('[tool_result]\n[tool_result]\n[tool_result]')).toBe('');
  });

  it('⭐ keeps the real answer when a placeholder is glued to its end', () => {
    // 📏 실측: «최근 생성물을 … 표시했습니다.⏎[tool_use]»
    //   ⛔ 메시지째 버리면 ***사람이 읽을 답변이 같이 사라진다.*** 이 한 줄이 설계를 갈랐다.
    const stored = [{ role: 'assistant', content: '최근 생성물을 표시했습니다.\n[tool_use]' }];
    expect(restorableChatMessages(stored, 0).map((m) => m.text)).toEqual(['최근 생성물을 표시했습니다.']);
  });

  it('⭐ preserves the surrounding whitespace of real text — indentation can carry meaning', () => {
    // ⛔📏 무인 리뷰 must-fix(PR #11162): 1차판은 결과를 `.trim()` 해서
    //   ***자리표시자와 무관한 본문의 들여쓰기·빈 줄까지 바꿨다.*** 코드 블록이 조용히 망가진다.
    const body = '```js\n  const a = 1;\n```\n';
    // ⓐ 자리표시자가 «없으면» 한 글자도 안 바뀐다(1차판은 여기서 뒤 개행을 먹었다).
    expect(stripLlmReplayPlaceholders(body)).toBe(body);
    // ⓑ 자리표시자가 섞여도 «나머지 줄»의 들여쓰기는 그대로다.
    //   ⚠️ 제거된 «그 줄»의 자리는 당연히 사라진다 — 그것이 이 함수의 일이다.
    expect(stripLlmReplayPlaceholders(`${body}[tool_use]`)).toBe('```js\n  const a = 1;\n```');
    // ⓒ 핵심 계약: 본문의 «내부» 들여쓰기가 살아 있다.
    expect(stripLlmReplayPlaceholders(`${body}[tool_use]`)).toContain('\n  const a = 1;');
  });

  it('drops a message that is only whitespace once the placeholders are gone', () => {
    // 「비었나」 판정은 trim 으로 하되, 남기는 «값»은 다듬지 않는다.
    expect(restorableChatMessages([{ role: 'assistant', content: '  \n[tool_use]\n  ' }], 0)).toEqual([]);
  });

  it('keeps a sentence that merely mentions the token', () => {
    const stored = [{ role: 'user', content: '왜 [tool_use] 가 화면에 뜨지?' }];
    expect(restorableChatMessages(stored, 0)).toHaveLength(1);
  });

  it('drops the placeholders and keeps the real conversation, in order', () => {
    const stored = [
      { role: 'user', content: '위젯 보여줘' },
      { role: 'assistant', content: '[tool_use]' },
      { role: 'user', content: '[tool_result]' },
      { role: 'assistant', content: '최근 생성물을 표시했습니다.' },
    ];
    const out = restorableChatMessages(stored, 1000);

    expect(out.map((m) => m.text)).toEqual(['위젯 보여줘', '최근 생성물을 표시했습니다.']);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    // 타임스탬프가 «순서»를 지킨다 — 화면 정렬이 그것에 기댄다.
    expect(out[0]!.timestamp).toBeLessThan(out[1]!.timestamp);
  });

  /** ⛔⭐⭐ 「중복 답변」의 정체 — 저장 버그가 «아니라» 이 함수가 만드는 것이었다(2단계 조사 결과). */
  it('folds a duplicate that THIS function created by stripping a placeholder', () => {
    // 📏 실측 모양: 중간 상태(답변+[tool_use])와 최종(답변)이 «떼어내면» 같아진다.
    const answer = '최근 생성물을 표시했습니다.';
    const out = restorableChatMessages([
      { role: 'assistant', content: `${answer}\n[tool_use]` },
      { role: 'user', content: '[tool_result]' },
      { role: 'assistant', content: answer },
    ], 0);
    expect(out.map((m) => m.text)).toEqual([answer]);
  });

  it('⛔ does NOT fold a duplicate that was already there — that is real conversation', () => {
    // 사람이 같은 말을 두 번 할 수 있다. 자리표시자를 «떼지 않은» 메시지는 건드리지 않는다.
    const out = restorableChatMessages([
      { role: 'user', content: '한 번 더' },
      { role: 'user', content: '한 번 더' },
    ], 0);
    expect(out.map((m) => m.text)).toEqual(['한 번 더', '한 번 더']);
  });

  it('⛔⭐ folds ONLY the pair it created — a genuine repeat right after must survive', () => {
    // ⛔📏 무인 리뷰 must-fix(PR #11166): 1차판은 첫 출력의 stripped 플래그가 «남아»
    //   뒤의 동일 텍스트를 전부 삼켰다. ⇒ 원래부터 중복인 셋째까지 사라졌다.
    const answer = '답변';
    const out = restorableChatMessages([
      { role: 'assistant', content: `${answer}\n[tool_use]` },  // ← 내가 만든 중복의 «출처»
      { role: 'assistant', content: answer },                     // ← 접혀야 한다
      { role: 'assistant', content: answer },                     // ← ⛔ 원래 중복 — «남아야» 한다
    ], 0);
    expect(out.map((m) => m.text)).toEqual([answer, answer]);
  });

  it('does not fold across a different role or different text', () => {
    const out = restorableChatMessages([
      { role: 'assistant', content: '같은 말\n[tool_use]' },
      { role: 'user', content: '같은 말' },
    ], 0);
    expect(out).toHaveLength(2);
  });

  it('gives role:tool no bubble of its own — it rides on the next answer', () => {
    const out = restorableChatMessages(
      [{ role: 'tool', content: '⚙️ ToolSearch', toolName: 'ToolSearch' }, { role: 'assistant', content: '답' }],
      0,
    );
    // 말풍선은 «하나»다 — 툴 줄이 따로 서지 않는다.
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('답');
  });

  it('does not delete anything from the store — it only selects', () => {
    // ⭐ 계약: 입력 배열이 «그대로» 남는다. 저장소는 LLM 재현에도 쓰이므로 지우면 맥락이 깨진다.
    const stored = [{ role: 'assistant', content: '[tool_use]' }, { role: 'user', content: 'hi' }];
    const before = JSON.stringify(stored);
    restorableChatMessages(stored, 0);
    expect(JSON.stringify(stored)).toBe(before);
  });

  it('reproduces the measured ratio on a realistic mix — the number that made this worth doing', () => {
    // 📏 실측 비율을 그대로 재현: 327 자리표시자 ⊕ 145 진짜 대화 = 472.
    const stored = [
      ...Array.from({ length: 327 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: i % 2 ? '[tool_result]' : '[tool_use]' })),
      ...Array.from({ length: 145 }, (_, i) => ({ role: 'assistant', content: `진짜 ${i}` })),
    ];
    expect(stored).toHaveLength(472);
    expect(restorableChatMessages(stored, 0)).toHaveLength(145);
  });
});

describe('저장된 메시지 시각 복원', () => {
  const first = '2026-10-02T19:09:23.000Z';
  const later = '2026-10-02T21:09:23.000Z';
  const base = Date.parse(later);
  const tool = (ts?: unknown) => ({ role: 'tool', content: '⚙️ search', toolName: 'search', ts });

  it('uses each ordinary message ISO timestamp, without sorting by time', () => {
    const out = restorableChatMessages([
      { role: 'user', content: 'first', ts: later },
      { role: 'assistant', content: 'second', ts: first },
    ], base);
    expect(out.map((m) => m.text)).toEqual(['first', 'second']);
    expect(out.map((m) => m.timestamp)).toEqual([Date.parse(later), Date.parse(first)]);
  });

  it('uses the existing output-index fallback for missing, invalid and non-string ts', () => {
    const out = restorableChatMessages([
      { role: 'user', content: 'no ts' },
      { role: 'assistant', content: 'invalid', ts: 'not-a-date' },
      { role: 'user', content: 'number', ts: base },
      { role: 'assistant', content: 'non-ISO', ts: 'October 2, 2026' },
      { role: 'user', content: 'valid', ts: first },
    ], base);
    expect(out.map((m) => m.timestamp)).toEqual([base, base + 1, base + 2, base + 3, Date.parse(first)]);
    expect(out.map((m) => m.text)).toEqual(['no ts', 'invalid', 'number', 'non-ISO', 'valid']);
  });

  it('falls back for calendar-invalid ISO dates rather than accepting normalized dates', () => {
    const out = restorableChatMessages([
      { role: 'user', content: 'February 30', ts: '2026-02-30T19:09:23.000Z' },
      { role: 'assistant', content: 'non-leap February 29', ts: '2026-02-29T19:09:23.000Z' },
      { role: 'user', content: 'leap February 29', ts: '2024-02-29T19:09:23.000Z' },
      tool('2026-02-30T19:09:23.000Z'), tool(first),
      { role: 'assistant', content: 'grouped answer', ts: later },
    ], base);
    expect(out.map((m) => m.text)).toEqual(['February 30', 'non-leap February 29', 'leap February 29', 'grouped answer']);
    expect(out.map((m) => m.timestamp)).toEqual([
      base, base + 1, Date.parse('2024-02-29T19:09:23.000Z'), base + 3,
    ]);
  });

  it('uses the FIRST tool trace timestamp for a grouped answer, not its later traces or answer', () => {
    const out = restorableChatMessages([
      tool(first), tool(later), { role: 'assistant', content: 'answer', ts: later },
    ], base);
    expect(out).toHaveLength(1);
    expect(out[0]!.blocks!.filter((b) => b.kind === 'tool_use')).toHaveLength(2);
    expect(out[0]!.timestamp).toBe(Date.parse(first));
  });

  it('uses the first tool timestamp for an empty answer and a trailing tool-only bubble', () => {
    const empty = restorableChatMessages([
      tool(first), tool(later), { role: 'assistant', content: '[tool_use]', ts: later },
    ], base);
    expect(empty.map((m) => m.timestamp)).toEqual([Date.parse(first)]);
    const trailing = restorableChatMessages([
      { role: 'user', content: 'question', ts: later }, tool(first), tool(later),
    ], base);
    expect(trailing.map((m) => m.timestamp)).toEqual([Date.parse(later), Date.parse(first)]);
  });

  it('keeps a pending group through a user message, then starts a new group after its answer', () => {
    const out = restorableChatMessages([
      tool(first), { role: 'user', content: 'interleaved', ts: later },
      { role: 'assistant', content: 'first answer', ts: later },
      tool(later), { role: 'assistant', content: 'second answer', ts: first },
    ], base);
    expect(out.map((m) => m.text)).toEqual(['interleaved', 'first answer', 'second answer']);
    expect(out.map((m) => m.timestamp)).toEqual([Date.parse(later), Date.parse(first), Date.parse(later)]);
  });

  it('falls back for a group whose first trace has no usable ts, even if a later trace has one', () => {
    const out = restorableChatMessages([
      { role: 'user', content: 'question' }, tool('invalid'), tool(first),
      { role: 'assistant', content: 'answer', ts: later }, tool(),
    ], base);
    expect(out.map((m) => m.timestamp)).toEqual([base, base + 1, base + 2]);
    expect(out.map((m) => m.text)).toEqual(['question', 'answer', '']);
  });
});

describe('배선 — ChatLayout 이 그 선별을 «실제로» 쓰나', () => {
  it('calls restorableChatMessages instead of filtering inline', () => {
    // ⛔⭐ 위 시험들은 「함수가 옳다」만 본다 — ***아무도 안 부르면 화면은 그대로다.***
    //   📏 이 차수에 그 함정을 실제로 밟았다(`#11120`: 시험 다섯이 초록인데 라이브에서 안 탔다).
    const code = readFileSync(resolve(import.meta.dir, '../components/chat/ChatLayout.tsx'), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    expect(code.some((l) => l.includes('restorableChatMessages('))).toBe(true);
    // 인라인 필터가 «되살아나지» 않게 — 그것이 원래 결함의 모양이었다.
    expect(code.some((l) => l.includes(".filter((m) => m.role === 'user'"))).toBe(false);
  });
});

/** ⛔⭐⭐⭐ **권고 3단계 — 툴 감사 기록이 «블록»으로 올라온다.**
 *
 *  📏 이 단계의 재료는 `#11120` 이 만들었다(PWA 턴이 `role:'tool'` 을 남기기 시작했다).
 *  그리고 `#11133` 이 관문을 쟀다 — 위젯 주소가 저장에서 «살아남는다»(1442자 · 절단 없음).
 *  ⇒ 이제 새로고침 뒤에도 위젯이 뜬다. */
describe('3단계 — 툴 기록을 블록으로 올린다', () => {
  const widgetResult = JSON.stringify({ output: 'x', _meta: { ui: { resourceUri: 'ui://srv/screen.html' } } });

  it('turns a widget tool trace into an mcp_app block carrying its result', () => {
    const out = restorableChatMessages([
      { role: 'tool', content: '⚙️ show', toolName: 'srv__show', toolResult: widgetResult },
      { role: 'assistant', content: '표시했습니다.' },
    ], 0);

    const blocks = out[0]!.blocks!;
    const app = blocks.find((b) => b.kind === 'mcp_app') as Extract<ChatBlock, { kind: 'mcp_app' }>;
    expect(app).toBeDefined();
    expect(app.screenUrl).toBe('ui://srv/screen.html');
    expect(app.toolName).toBe('srv__show');
    // ⛔ 이 값이 없으면 브리지가 «밀 것이 없다» — #11061 이 그것으로 위젯을 비웠다.
    expect(app.toolResult).toMatchObject({ _meta: { ui: { resourceUri: 'ui://srv/screen.html' } } });
  });

  it('⭐ keeps the answer text as a block — otherwise blocks would hide it', () => {
    // ⛔ 렌더러는 `blocks` 가 있으면 `text` 를 «무시»한다. 텍스트를 블록으로 안 넣으면 답변이 사라진다.
    const out = restorableChatMessages([
      { role: 'tool', content: '⚙️ show', toolName: 'srv__show', toolResult: widgetResult },
      { role: 'assistant', content: '표시했습니다.' },
    ], 0);
    const texts = out[0]!.blocks!.filter((b) => b.kind === 'text') as Extract<ChatBlock, { kind: 'text' }>[];
    expect(texts.map((b) => b.text)).toEqual(['표시했습니다.']);
    // 툴 줄이 «먼저», 텍스트가 «뒤» — 라이브 화면과 같은 순서다.
    expect(out[0]!.blocks![0]!.kind).toBe('mcp_app');
    expect(out[0]!.blocks![out[0]!.blocks!.length - 1]!.kind).toBe('text');
  });

  it('⭐ accepts the FLAT `ui/resourceUri` too — the peer actually sends it', () => {
    // ⛔ 규범 밖이지만 실물이 보낸다(`src/mcp/proxy-runtime.ts:200` 실측 주석).
    //   같은 폴백을 라이브 경로(`chat-runtime.ts`)와 데몬(`proxy-runtime.ts`)이 «이미» 갖는다.
    //   ⇒ 여기서만 빼면 ***복원 경로에서만 위젯이 안 뜬다.*** 그래서 «의도»를 시험으로 못 박는다.
    const out = restorableChatMessages([
      { role: 'tool', content: '⚙️ s', toolName: 's', toolResult: JSON.stringify({ 'ui/resourceUri': 'ui://srv/flat.html' }) },
      { role: 'assistant', content: '답' },
    ], 0);
    const app = out[0]!.blocks!.find((b) => b.kind === 'mcp_app') as Extract<ChatBlock, { kind: 'mcp_app' }>;
    expect(app?.screenUrl).toBe('ui://srv/flat.html');
  });

  it('⛔ but neither shape present ⇒ pill, not a widget', () => {
    // 음성 시험 — 아무 주소도 없으면 «절대» mcp_app 으로 승격하지 않는다.
    const out = restorableChatMessages([
      { role: 'tool', content: '⚙️ s', toolName: 's', toolResult: JSON.stringify({ _meta: { ui: {} }, output: 'x' }) },
      { role: 'assistant', content: '답' },
    ], 0);
    expect(out[0]!.blocks!.some((b) => b.kind === 'mcp_app')).toBe(false);
    expect(out[0]!.blocks!.some((b) => b.kind === 'tool_use')).toBe(true);
  });

  it('falls back to a tool_use pill when the trace has no screen', () => {
    const out = restorableChatMessages([
      { role: 'tool', content: '⚙️ ToolSearch', toolName: 'ToolSearch', toolResult: '{"matched":3}' },
      { role: 'assistant', content: '찾았습니다.' },
    ], 0);
    const pill = out[0]!.blocks!.find((b) => b.kind === 'tool_use') as Extract<ChatBlock, { kind: 'tool_use' }>;
    expect(pill).toMatchObject({ name: 'ToolSearch', status: 'done' });
  });

  it('does not attach tool blocks to a user message', () => {
    // 툴은 «답변»의 일이다 — 사람 말풍선에 붙으면 대화가 뒤집힌다.
    const out = restorableChatMessages([
      { role: 'tool', content: '⚙️ show', toolName: 'srv__show', toolResult: widgetResult },
      { role: 'user', content: '다음 질문' },
      { role: 'assistant', content: '답' },
    ], 0);
    expect(out[0]!.blocks).toBeUndefined();
    // 아직 «쓰이지 않은» 툴 블록은 다음 답변까지 기다린다.
    expect(out[1]!.blocks!.some((b) => b.kind === 'mcp_app')).toBe(true);
  });

  it('survives a trace whose result is not JSON', () => {
    const out = restorableChatMessages([
      { role: 'tool', content: '⚙️ t', toolName: 't', toolResult: 'not json at all' },
      { role: 'assistant', content: '답' },
    ], 0);
    expect(out[0]!.blocks!.some((b) => b.kind === 'tool_use')).toBe(true);
  });
});

/** ⛔⭐⭐ **보류된 툴 블록이 «사라지는» 세 경로** — 무인 리뷰 must-fix(PR #11170).
 *  그냥 `continue` 하면 그 위젯은 세션 끝에서 사라지거나 훨씬 뒤의 «무관한 답변»에 붙는다. */
describe('보류된 툴 블록은 «절대» 유실되지 않는다', () => {
  const widgetResult = JSON.stringify({ _meta: { ui: { resourceUri: 'ui://srv/s.html' } } });
  const trace = { role: 'tool', content: '⚙️ show', toolName: 'srv__show', toolResult: widgetResult };

  it('① 다음 답변이 «비어» 있어도 — 블록만으로 말풍선을 세운다', () => {
    const out = restorableChatMessages([trace, { role: 'assistant', content: '[tool_use]' }], 0);
    expect(out).toHaveLength(1);
    expect(out[0]!.blocks!.some((b) => b.kind === 'mcp_app')).toBe(true);
  });

  it('② 다음 답변이 «접히는» 중복이어도 — 접지 않고 블록을 싣는다', () => {
    const answer = '답변';
    const out = restorableChatMessages([
      { role: 'assistant', content: `${answer}\n[tool_use]` },
      trace,
      { role: 'assistant', content: answer },   // 평소라면 접힌다
    ], 0);
    // ⛔ 중복 한 줄보다 «잃은 위젯»이 크다 — 그래서 이 경우엔 접지 않는다.
    expect(out).toHaveLength(2);
    expect(out[1]!.blocks!.some((b) => b.kind === 'mcp_app')).toBe(true);
  });

  it('③ 세션이 툴로 «끝나도» — 마지막에 말풍선을 하나 세운다', () => {
    const out = restorableChatMessages([{ role: 'user', content: '보여줘' }, trace], 0);
    expect(out).toHaveLength(2);
    expect(out[1]!.role).toBe('assistant');
    expect(out[1]!.blocks!.some((b) => b.kind === 'mcp_app')).toBe(true);
  });

  it('⛔ 그리고 «없는» 블록으로 빈 말풍선을 만들지는 않는다', () => {
    const out = restorableChatMessages([{ role: 'user', content: '질문' }], 0);
    expect(out).toHaveLength(1);
  });
});

/** ⛔⭐⭐⭐ 「복원하면 이미지가 사라진다」 — 16차 §5c 가 «재고» 하며 유보한 축.
 *
 *  📏 17차가 재봤다: ⓐ URL 은 절단 없이 저장되고 ⓑ 21시간 뒤에도 200 이며
 *  ⓒ ***라이브에 이미 같은 일을 하는 `mcpResultImages` 가 있다***(대표 2026-08-21).
 *  ⇒ 그래서 새 휴리스틱 대신 **그 함수를 재사용**했다. 이 절이 그 계약을 문다. */
describe('복원 — 툴 결과의 이미지', () => {
  const imageResult = JSON.stringify({
    content: [{ uri: 'https://cdn.example.com/leaf.png', description: '은행잎' }],
  });

  it('⭐ 결과에 이미지가 있으면 «그린다» — 링크만 남기지 않는다(라이브와 동형)', () => {
    const out = restorableChatMessages([
      { role: 'user', content: '그려줘' },
      { role: 'tool', content: '⚙️', toolName: 'srv__gen', toolResult: imageResult },
      { role: 'assistant', content: '그렸습니다.' },
    ], 0);
    const blocks = out.at(-1)!.blocks!;
    const img = blocks.find((b) => b.kind === 'image');
    expect(img).toBeDefined();
    expect(img).toMatchObject({ src: 'https://cdn.example.com/leaf.png', mediaType: 'image/png', alt: '은행잎' });
    // ⭐ 순서도 라이브와 같다 — 이미지가 알약/위젯 «앞»에 선다.
    expect(blocks.findIndex((b) => b.kind === 'image'))
      .toBeLessThan(blocks.findIndex((b) => b.kind === 'tool_use'));
  });

  it('⛔ 「이미지가 아닌」 URL 은 «안» 그린다 — 손으로 긁으면 걸리는 것들', () => {
    // 📏 실측: 저장된 결과에는 `https://json-schema.org/draft/2020-12/schema` 같은 URL 이 섞여 있다.
    //   ⇒ 그래서 「URL 을 긁는」 휴리스틱을 쓰지 않고 `mcpResultImages` 를 재사용한다.
    const out = restorableChatMessages([
      { role: 'tool', content: '⚙️', toolName: 'srv__x', toolResult: JSON.stringify({
        content: [{ uri: 'https://json-schema.org/draft/2020-12/schema' }, { uri: 'javascript:alert(1)' }],
      }) },
      { role: 'assistant', content: '했습니다.' },
    ], 0);
    expect(out.at(-1)!.blocks!.some((b) => b.kind === 'image')).toBe(false);
  });

  it('⛔ 같은 이미지가 두 번 오면 «한 번»만 그린다', () => {
    const trace = { role: 'tool', content: '⚙️', toolName: 'srv__gen', toolResult: imageResult };
    const out = restorableChatMessages([trace, trace, { role: 'assistant', content: '완료.' }], 0);
    expect(out.at(-1)!.blocks!.filter((b) => b.kind === 'image')).toHaveLength(1);
  });
});
