/** ⛔⭐⭐⭐ 「턴이 무엇을 그렸나」를 «세면서 안 내보내는» 것을 잡는 자 — 17차 `[F]`.
 *
 *  ## 왜 이 파일이 있나
 *
 *  📏 2026-08-22 실측: `chat-runtime.ts` 의 턴 실행 경로 «셋»이 각자 블록 수를 세는데,
 *  ***끝 관측이 셋 다 달랐다.***
 *
 *  ```
 *  경로                      끝 관측        images  tools  mcpApps  feedback
 *  runChatTurnStreaming      stream.end       ✅     ✅    ⛔없다     ✅
 *  runChatTurnObserver       ⛔ 통째로 없다    ⛔     ⛔     ⛔        ⛔
 *  runChatTurnAcp            acp.end          ✅     ✅     ✅      (안 센다)
 *  ```
 *
 *  🔑 ***16차 §2d 가 「블록을 만드는 자리 셋 중 둘만 결과를 실었다」를 찾았는데,
 *  같은 부류가 「관측」 축에서 반복되고 있었다.***
 *  ⛔ 그리고 관측 결손은 **사용자 눈에 안 보인다** — 화면은 멀쩡하고 로그만 비어 있다.
 *  ⇒ 그래서 16차가 위젯 문제를 30분 뒤질 때 «어느 경로였나»를 로그로 못 갈랐다.
 *
 *  ## ⛔ 이 자가 무는 규칙 — 「세었으면 내보내라」
 *
 *  함수가 카운터를 **선언**했다는 것은 그 축을 «잰다»는 뜻이다.
 *  ⇒ 그렇다면 끝 관측이 그 값을 **내야 한다**. 재고도 안 내보내면 아무도 못 본다.
 *  ⭐ 반대로 «세지 않는» 축은 넣지 «않는» 것이 옳다 — 0 을 내면
 *    ***「측정 불가」가 「없다」로 둔갑한다***(`MANUAL-time-and-windows` ⑩ 이 못 박은 함정).
 *    그래서 이 자는 「선언 → 내보냄」만 요구하고 그 역은 요구하지 않는다.
 *
 *  ## ⚠️ 이 자가 답하지 «않는» 것
 *
 *  그 관측이 «실제로 찍히나» — 그건 라이브 축이고 여기서는 소스를 읽을 뿐이다.
 *  ⇒ 라이브로는 `elanous logs --category webterm.chat.runturn` 으로 본다. */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = resolve(import.meta.dir, 'chat-runtime.ts');

/** 카운터 변수명 → 관측 필드명. ⛔ 여기 있는 축만 잰다(모르는 축은 «없다»고 말하지 않는다). */
const COUNTER_TO_FIELD: ReadonlyArray<readonly [string, string]> = [
  ['imageCount', 'images'],
  ['toolCount', 'tools'],
  ['mcpAppCount', 'mcpApps'],
  ['feedbackCount', 'feedback'],
  // ⭐ 대표 2026-08-22 결정으로 신설된 축(ACP 경로의 「생각」) — 세는 경로는 반드시 내보내야 한다.
  ['thoughtCount', 'thoughts'],
  // ⭐ 「생각 채널로 왔지만 생각이 아닌 것」(FeedbackEnvelope) — 세면 반드시 내보낸다.
  ['feedbackEnvelopeChunks', 'feedbackEnvelopes'],
  // H-1 — terminal envelopes dropped from the thought channel · thought chunks cut by the size cap.
  ['termEnvelopeChunks', 'termEnvelopes'],
  ['thoughtTruncatedChunks', 'thoughtTruncated'],
];

/** ⛔⭐⭐⭐ 턴 경로를 ***손으로 적지 않는다 — 소스에서 「찾는다」.***
 *
 *  📏 2026-08-22 실측(17차 `[F]`): 1차판은 셋을 손으로 적었고
 *  ***`runAcpForeignTurnObserver`(네 번째 경로)를 빠뜨렸다.*** 그 경로는 `imageCount`·`toolCount` 를
 *  «세면서» 끝 관측이 통째로 없었는데, ***목록에 없어서 이 자가 못 봤다.***
 *
 *  🔑 ***「셋 중 하나가 빠졌다」를 잡으려고 만든 자가, 자기 «목록»에서 넷째를 빠뜨렸다.***
 *  ⇒ 그래서 발견 기준을 바꿨다: **카운터를 «선언한» export 함수는 전부 턴 경로다.**
 *    `imageCount`/`toolCount` 같은 이름을 세는 함수는 이 파일에서 턴 처리기뿐이고,
 *    ***새 경로가 생기면 목록을 고치지 않아도 자동으로 사정권에 들어온다.***
 *  ⛔ 하나도 못 찾으면 「전부 통과」가 아니라 **실패**한다(아래 첫 시험). */
function discoverTurnFunctions(source: string): string[] {
  const found: string[] = [];
  const fnDecl = /^export (?:async )?function (\w+)\s*\(/gm;
  for (let m = fnDecl.exec(source); m !== null; m = fnDecl.exec(source)) {
    const name = m[1]!;
    const body = bodyOf(source, name);
    if (COUNTER_TO_FIELD.some(([counter]) => new RegExp(`let ${counter}\\s*=`).test(body))) found.push(name);
  }
  return found;
}

/** 소스를 함수 단위로 자른다 — **다음 «최상위 선언» 직전까지.**
 *
 *  📏 2026-08-22 실측(17차 `[F]`) — 이 경계를 «두 번» 고쳤다:
 *  ⓐ 1차: 「다음 `export function` 까지」 ⇒ ***마지막 함수가 파일 나머지를 통째로 삼켰다.***
 *    🔑 파일 «끝»에 카운터를 숨긴 화살표 함수로 반증했을 때, 자가 「잡았다」가 아니라
 *      ***「그 함수 안에 있다」고 «오인»해 통과***했다.
 *  ⓑ 2차 시도: 중괄호 «균형»으로 자르려 했다 ⇒ ⛔ **되돌렸다.**
 *    마스킹 렉서가 ***정규식 리터럴을 몰라*** 어긋났고(`/['"]/` 의 따옴표를 문자열 시작으로 읽는다),
 *    휴리스틱을 넣어도 경로를 넷 중 둘밖에 못 찾았다.
 *    ⭐ 다만 «조용히 틀리지» 않았다 — 이름을 대고 실패했고 그래서 바로 알았다.
 *  ⇒ ⓒ 지금: **다음 최상위 선언(`^export `·`^function `·`^const `…) 직전까지.**
 *    ⭐ 함수 «안»의 그런 줄은 들여쓰기돼 있어 `^` 에 안 걸리고,
 *      파일 끝의 `export const fake = …` 같은 것도 «경계가 된다».
 *    ⚠️ 값싸고 이 파일에 충분하다. AST 가 필요해지면 그때 붙여라 — 지금은 과하다. */
const TOP_LEVEL_DECL = /^(?:export |declare |function |const |let |var |class |interface |type |enum )/m;

function bodyOf(source: string, fnName: string): string {
  const start = source.search(new RegExp(`^export (?:async )?function ${fnName}\\b`, 'm'));
  if (start < 0) throw new Error(`함수를 못 찾았다: ${fnName} — 이름이 바뀌었으면 이 자의 목록도 고쳐라`);
  const rest = source.slice(start + 1);
  const next = rest.search(TOP_LEVEL_DECL);
  return next < 0 ? rest : rest.slice(0, next);
}

/** ⛔⭐⭐⭐ 끝 관측의 ***payload 만*** 뽑는다. 무인 리뷰 must-fix(PR #11267):
 *
 *  > 자가 끝 관측 payload를 검증하지 않고 함수 본문 «어디에든» 있는 문자열(주석 포함)만 찾으므로 …
 *  > 무관한 로그/주석으로 통과할 수 있는 **Goodhart 테스트**다.
 *
 *  📏 그 지적이 옳았고, ***이 자 자신이 그 병을 앓고 있었다*** — `chat-runtime.ts` 의 주석에
 *  `` `mcpApps:` `` 라는 글자가 실제로 있어서, 진짜 payload 에서 그 필드가 빠져도
 *  ***주석 한 줄로 통과할 수 있었다.***
 *  🔑 ***자를 만드는 사람이 「무엇을 재는지」를 좁히지 않으면, 자는 「있는 척」을 잰다.***
 *
 *  ⇒ 그래서 ⓐ `debugLog('...end', {…})` 호출의 «괄호 균형»을 세어 payload 를 잘라 내고
 *    ⓑ 주석을 지운 다음 ⓒ 그 안에서만 필드를 본다. */
/** ⛔⭐⭐ 주석과 문자열 «내용»을 공백으로 덮는다. **길이는 보존한다** — 그래야 인덱스가
 *  원본과 어긋나지 않는다. 이 마스킹된 사본으로 «모든» 판단을 한다.
 *
 *  📏 무인 리뷰 must-fix 2차(PR #11267): 1차 수렴은 `//` 줄 주석만 지워서
 *  ***`/* mcpApps: mcpAppCount *\/` 같은 블록 주석에는 여전히 속았고***,
 *  문자열 안의 `{`·`}` 가 payload 경계를 깨뜨릴 수 있었다.
 *  ⇒ 그래서 「지운다」가 아니라 ***「구문을 알고 덮는다」***로 바꿨다.
 *
 *  ⚠️ 이 렉서가 모르는 것: 정규식 리터럴(`/…/`)과 템플릿의 `${…}` 안쪽.
 *    이 파일이 재는 대상(관측 payload)에는 둘 다 나오지 않고, 나오기 시작하면
 *    ***경계가 깨져 시험이 실패한다*** — 조용히 통과하지 않는다. */
function maskCommentsAndStrings(src: string): string {
  const out = src.split('');
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      blank(i, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end;
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (src[i] === '\'' || src[i] === '"' || src[i] === '`') {
      const quote = src[i];
      let k = i + 1;
      while (k < src.length && src[k] !== quote) k += (src[k] === '\\' ? 2 : 1);
      blank(i, Math.min(k + 1, src.length)); // 따옴표까지 덮는다 — 안의 `{`/`}` 가 경계를 깨지 않도록
      i = k + 1;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

function endObservationPayloads(body: string): string[] {
  // ⛔ 마스킹된 사본에서 «찾고 자르고 판단»한다. 원본을 쓰면 주석 한 줄로 통과한다(그 Goodhart).
  //   ⚠️ 이벤트 이름이 문자열이라 마스킹되므로, 호출을 찾을 때는 `debugLog(` 까지만 보고
  //     이름은 «원본»에서 대조한다.
  const masked = maskCommentsAndStrings(body);
  const out: string[] = [];
  const call = /debugLog\(/g;
  for (let m = call.exec(masked); m !== null; m = call.exec(masked)) {
    const nameAt = body.slice(m.index, m.index + 120);
    // ⛔📏 17차: 처음엔 `runturn\.` 만 봤는데 네 번째 경로의 끝 관측은
    //   `webterm.chat.acp.foreign-turn.end` — ***계열 이름이 달라서 못 봤다.***
    //   ⇒ `webterm.chat.<무엇이든>.end` 를 본다. 하이픈이 이름에 «있다»(`foreign-turn`).
    if (!/debugLog\(\s*'webterm\.chat\.[\w.-]*\.end'/.test(nameAt)) continue;
    const open = masked.indexOf('{', m.index);
    if (open < 0) continue;
    let depth = 1;
    let i = open + 1;
    for (; i < masked.length && depth > 0; i += 1) {
      if (masked[i] === '{') depth += 1;
      else if (masked[i] === '}') depth -= 1;
    }
    if (depth !== 0) throw new Error('payload 의 중괄호가 안 닫힌다 — 이 자가 소스를 잘못 자르고 있다');
    out.push(masked.slice(open + 1, i - 1));
  }
  return out;
}

const SOURCE_TEXT = readFileSync(SOURCE, 'utf8');
const TURN_FUNCTIONS = discoverTurnFunctions(SOURCE_TEXT);

describe('턴 끝 관측 — 「세었으면 내보내라」', () => {
  test('턴 경로를 «찾아내고», 그 전부가 끝 관측을 낸다', () => {
    // ⭐ 분모를 낸다 — 「무엇을 몇 개 봤나」를 안 적으면 초록이 「전부 봤다」로 읽힌다.
    console.log(`[turn-end-observation] 찾은 턴 경로 ${TURN_FUNCTIONS.length}개: ${TURN_FUNCTIONS.join(', ')}`
      + `; 기준=카운터(${COUNTER_TO_FIELD.map(([c]) => c).join('|')}) 중 하나를 선언한 export 함수`);
    // ⛔ 하나도 못 찾으면 「전부 통과」가 아니라 실패다 — 이름 규칙이 바뀌면 이 자가 «말해야» 한다.
    //   📏 2026-08-22 기준 «넷». 늘어나는 것은 정상(새 경로)이고, 줄어들면 발견이 깨진 것이다.
    expect(TURN_FUNCTIONS.length).toBeGreaterThanOrEqual(4);

    // ⛔⭐⭐⭐ **발견이 「놓친 것」을 잡는다** — 무인 리뷰 should-fix(PR #11275):
    //   *"`export function` / `let <counter> =` 표기에 강하게 묶여 있어 화살표 export 등으로
    //   바뀌면 경로를 «조용히» 놓친다."* ⇒ 그것이 ***이 자가 고치려는 바로 그 병***이다.
    // 🔑 그래서 AST 대신 «분모 대조»로 막는다:
    //   ***파일 «전체»의 카운터 선언 수 == 발견된 함수들이 «담은» 선언 수.***
    //   ⇒ 발견 밖에 카운터가 하나라도 있으면 — 그 함수가 어떤 모양이든 — 이 줄이 실패한다.
    const declRe = new RegExp(`let (?:${COUNTER_TO_FIELD.map(([c]) => c).join('|')})\\s*=`, 'g');
    const inFile = (SOURCE_TEXT.match(declRe) ?? []).length;
    const inFound = (TURN_FUNCTIONS.map((fn) => bodyOf(SOURCE_TEXT, fn)).join('\n').match(declRe) ?? []).length;
    expect(`파일 ${inFile}개 · 발견 안 ${inFound}개`).toBe(`파일 ${inFile}개 · 발견 안 ${inFile}개`);
    const missing = TURN_FUNCTIONS.filter((fn) => endObservationPayloads(bodyOf(SOURCE_TEXT, fn)).length === 0);
    expect(missing).toEqual([]);
  });

  test('⛔ 카운터를 «선언한» 경로는 그 값을 끝 관측 «payload 안에서» 싣는다', () => {
    const offenders: string[] = [];
    for (const fn of TURN_FUNCTIONS) {
      const body = bodyOf(SOURCE_TEXT, fn);
      // ⭐ 「버렸다」 payload 는 수를 안 싣는 것이 «옳다» — 여기서는 제외하고, 아래 시험이 따로 문다.
      const counting = endObservationPayloads(body).filter((p) => !/dropped:\s*true/.test(p));
      for (const [counter, field] of COUNTER_TO_FIELD) {
        const declares = new RegExp(`let ${counter}\\s*=`).test(body);
        if (!declares) continue; // ⭐ 세지 «않는» 축은 요구하지 않는다(0 을 내면 「측정 불가」가 「없다」가 된다).
        const emits = counting.some((p) => new RegExp(`\\b${field}:\\s*${counter}\\b`).test(p));
        if (!emits) offenders.push(`${fn}: ${counter} 를 세면서 끝 관측 payload 에 ${field} 로 안 싣는다`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('⛔ 버려진 턴은 «버렸다고» 말하되, 수는 «싣지 않는다»', () => {
    // 📏 observer 는 `dropCurrentTurn` / `placeholderId === null` 이면 조용히 반환하고 있었다.
    //   ⇒ 다른 탭의 턴이 «안 그려졌을» 때 그 이유를 물을 자리가 없었다.
    const payloads = endObservationPayloads(bodyOf(SOURCE_TEXT, 'runChatTurnObserver'));
    const dropped = payloads.filter((p) => /dropped:\s*true/.test(p));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatch(/reason:/);
    // ⛔⭐ 그리고 «수를 실으면 안 된다» — 블록을 누적하지 않은 갈래라 0 을 내면
    //   ***「측정 불가」가 「없다」로 둔갑한다***. 무인 리뷰 must-fix 가 이 절반을 짚었다.
    const leaked = COUNTER_TO_FIELD.filter(([, field]) => new RegExp(`\\b${field}:`).test(dropped[0]!));
    expect(leaked.map(([, f]) => f)).toEqual([]);
  });
});

/** ⛔⭐⭐ **사용자가 «보는» 실패가 관측에도 남는가 — 19차 `[F]`.**
 *
 *  📏 2026-08-22 라이브: 화면엔 `error: socket closed: 1006` 이 떴는데 `elanous logs` 는 조용했다.
 *  `ChatLayout` 의 턴 `catch` 는 갈래가 둘인데 ***중단 갈래만 관측을 내고 「진짜 실패」는 안 냈다.***
 *
 *  ## ⚠️ 이 자가 답하지 «않는» 것 — ⛔ 여기서 과장하지 않는다
 *
 *  이것은 ***「배선이 있나」***만 본다. ***「그 줄이 실제로 도는가」는 못 잰다*** —
 *  이 저장소엔 리액트 컴포넌트 시험 도구가 «없다»(로드맵 ⑤ · `ChatHistory.tsx` 주석이 같은 말을 한다).
 *  ⇒ 행위 축은 `chat-runtime.test.ts` 의 「실패한 턴도 「끝」을 낸다」가 «진짜로» 문다.
 *  ⭐ 그래도 ***주석·문자열로는 통과할 수 없게*** 마스킹한 사본에서 «호출 자리»를 찾는다. */
describe('턴 실패가 «조용하지» 않다 — ChatLayout 배선', () => {
  const CHAT_LAYOUT = resolve(import.meta.dir, '../components/chat/ChatLayout.tsx');

  /** 마스킹된 사본에서 «진짜 호출 자리»를 찾고, 이름은 원본에서 대조한다.
   *  ⇒ 주석 안의 `debugLog('…')` 은 마스킹돼 안 걸린다. */
  function realDebugLogEvents(source: string): string[] {
    const masked = maskCommentsAndStrings(source);
    const out: string[] = [];
    const call = /debugLog\(/g;
    for (let m = call.exec(masked); m !== null; m = call.exec(masked)) {
      const head = source.slice(m.index, m.index + 120);
      const name = /debugLog\(\s*'([\w.-]+)'/.exec(head);
      if (name) out.push(name[1]!);
    }
    return out;
  }

  test('⛔ 턴 catch 의 «두 갈래»가 각자 관측을 낸다 — 중단만 내고 실패는 조용하던 병', () => {
    const events = realDebugLogEvents(readFileSync(CHAT_LAYOUT, 'utf8'));
    // ⭐ 분모를 낸다 — 「무엇을 몇 개 봤나」를 안 적으면 초록이 「전부 봤다」로 읽힌다.
    console.log(`[chatlayout-turn-failure] ChatLayout 의 진짜 debugLog 호출 ${events.length}개`);
    expect(events.length).toBeGreaterThan(0);
    // ⓐ 중단 갈래 — 원래 있던 것. 사라지면 이 자가 말해야 한다.
    expect(events).toContain('webterm.chat.runturn.stream.abort');
    // ⓑ 실패 갈래 — 19차가 «없어서» 넣은 것.
    expect(events).toContain('webterm.chat.runturn.error');
  });
});
