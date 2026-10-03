import type { ChatBlock, ChatMessage } from './chat-runtime';
// ⛔⭐ 라이브와 «같은» 이미지 추출기를 쓴다 — 새로 쓰면 두 자리가 갈린다(위 `toolTraceBlocks` 머리말).
import { mcpResultImages, pushToolCards } from './chat-runtime';

/** ⛔⭐⭐⭐ **저장된 세션을 «화면에 그릴» 메시지로 옮긴다.**
 *
 *  ## 왜 이 파일이 있나
 *
 *  📏 2026-08-22 실측(16차 `[F]` · 세션 `elanous-session-4kfnjj`):
 *  ```
 *  복원 대상(user+assistant)  472
 *    ├ "[tool_use]" / "[tool_result]"  327  (69%)   ⛔ 이것이 화면을 덮고 있었다
 *    └ 진짜 대화                        145
 *  ```
 *  ***대화를 열면 열 줄 중 일곱 줄이 `[tool_use]` 였다.***
 *  (라이브 확인: 새로고침 후 화면에 `[tool_use]` 167회 · `[tool_result]` 167회.)
 *
 *  ## ⛔ 그 글자는 «버그»가 아니라 다른 독자를 위한 것이다
 *
 *  저장소는 **LLM 대화 재현**에도 쓰인다 — 그쪽에는 「이 자리에 툴 호출이 있었다」는 표식이 필요하다.
 *  ⇒ 📌 ***데이터를 지우지 않는다. 화면에만 안 그린다.*** 지우면 다음 턴의 맥락이 깨진다.
 *
 *  ## ⚠️ 무엇을 «안» 하나
 *
 *  - ✅ **툴 기록을 블록으로 재구성한다**(권고 3단계 · 2026-08-22) — 아래 `toolTraceBlock` 참조.
 *  - **중복 답변을 지우지 않는다** — 같은 문장이 두 번 저장되는 «원인»을 아직 모른다(권고 2단계).
 *    ⛔ 복원부에서 dedupe 하면 원인이 덮이고, 진짜로 두 번 말한 경우까지 지운다. */

/** 저장소에서 오는 한 줄. 데몬 `GET /v1/sessions/store/:id` 의 `messages[]` 모양이다.
 *  ⛔ 밖으로 열지 않는다 — 소비처가 이 파일뿐이고, 호출자는 구조적 타이핑으로 리터럴을 넘긴다
 *  (리뷰 must-fix: 쓰이지 않는 공개 표면). */
interface StoredSessionMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly ts?: unknown;
  /** ⭐ `role:'tool'` 일 때 `session/chat.ts` 의 `buildToolTraceMessage` 가 싣는 칸들.
   *  ⛔📏 1차판 타입에는 이 셋이 «없었다» — 그래서 시험이 실제 저장 모양을 넘기자
   *  타입 자가 잡았다(`toolName does not exist`). ***타입이 실제보다 좁았던 것이다.*** */
  readonly toolName?: unknown;
  readonly toolArgs?: unknown;
  readonly toolResult?: unknown;
}

/** LLM 재현용 자리표시자 «한 줄».
 *
 *  ⛔ 「포함하면」이 아니라 ***그 줄 전체가*** 그것일 때만 참이다.
 *    사람이 대화에서 `[tool_use]` 를 «언급»할 수 있고(*"왜 `[tool_use]` 가 보이지?"*),
 *    그 문장은 진짜 대화다. 그것까지 지우면 **없앤 쓰레기보다 잃은 대화가 크다**. */
export function isLlmReplayPlaceholderLine(line: string): boolean {
  return /^\[tool_(use|result)\]$/.test(line.trim());
}

/** ⛔⭐⭐ 한 메시지 «안»에서 자리표시자 줄만 떼어낸다. 남는 것이 없으면 빈 문자열.
 *
 *  📏 2026-08-22 실측으로 이 함수를 «다시 썼다». 1차판은 「메시지 전체가 그것이면 버린다」였는데,
 *  라이브에서 167 → **4** 로 줄고 «남았다». 저장소를 전수로 세니 안 잡히는 모양이 **정확히 셋**이었다:
 *  ```
 *  «[tool_use]⏎[tool_use]⏎[tool_use]»                    ← 여러 줄이 한 메시지에
 *  «[tool_result]⏎[tool_result]⏎[tool_result]»           ← 같은 것
 *  «최근 생성물을 … 표시했습니다.⏎[tool_use]»             ← ⛔ 진짜 답변 «뒤»에 붙어 있다
 *  ```
 *  🔑 ***셋째가 이 설계를 갈랐다*** — 메시지째 버리면 **사람이 읽을 답변이 같이 사라진다.**
 *  ⇒ 그래서 «메시지 단위»가 아니라 «줄 단위»로 떼어낸다. */
export function stripLlmReplayPlaceholders(content: unknown): string {
  // ⛔⭐📏 무인 리뷰 must-fix(PR #11162): 1차판은 여기서 `.trim()` 했다.
  //   ⇒ 자리표시자와 «무관한» 진짜 대화의 선행/후행 공백·개행까지 바꿨다.
  //     코드 블록처럼 들여쓰기가 «뜻을 갖는» 본문이 조용히 망가진다.
  //   ⇒ 📌 이 함수는 ***자리표시자 줄만 뺀다.*** 다듬지 않는다.
  //     「비었나」 판정은 부르는 쪽이 `.trim()` 으로 «따로» 한다(값을 바꾸지 않고).
  return String(content ?? '')
    .split('\n')
    .filter((line) => !isLlmReplayPlaceholderLine(line))
    .join('\n');
}

/** ⛔⭐⭐⭐ 툴 감사 기록 → 화면 블록.
 *
 *  📏 2026-08-22 실측: 저장된 `toolResult` 는 **JSON 문자열**이고, 위젯 툴이면 그 안에
 *  `_meta.ui.resourceUri` 가 «살아 있다»(1442자 · 상한 2000 안 · 절단 없음).
 *  ⭐ 그리고 위젯 본문(1.2MB HTML)은 저장할 필요가 «없다» — `McpAppBlock` 이 `screenUrl` 로
 *  데몬에 «조회»한다. ⇒ 주소만 있으면 새로고침 뒤에도 위젯이 뜬다.
 *
 *  ⛔ `toolId` 는 저장돼 있지 «않다» — 복원용 합성 id 를 준다. 라이브 푸시 라우팅에는 안 쓰이고
 *    (그건 이미 지나간 턴이다), 블록이 `toolResult` 를 «직접» 들고 있어 브리지가 그것으로 민다. */
/** ⛔⭐⭐⭐ 툴 감사 기록 하나 → 화면 블록 «여럿».
 *
 *  📏 2026-08-22(17차 `[F]`): 16차는 §5c 에서 ***"이미지 블록은 재구성하지 않는다"***고 «유보»했다.
 *  이유는 *"잘린 기록에서 URL 이 깨질 수 있어 «재고» 넣어야 한다"* 였다. ⇒ **재봤다:**
 *  - ⓐ 저장된 `toolResult` 에 이미지 URL 이 ***절단 없이*** 있다(실측 1442B · 상한 2000 안).
 *  - ⓑ 그 CDN URL 은 저장 ***21시간 뒤에도 200***(서명 없는 공개 주소).
 *  - ⓒ ⭐ **그리고 라이브에 이미 «같은 일을 하는 함수»가 있다** — `mcpResultImages`
 *    (`chat-runtime.ts` · 대표 2026-08-21 *"결과에 이미지가 있으면 «그려서» 보여 준다"*).
 *
 *  🔑 그래서 **새 휴리스틱을 쓰지 «않는다».** 라이브와 «같은 함수»를 부른다 —
 *  ***그것이 이 저장소가 네 번 잡은 「같은 계약이 두 자리에서 갈린다」를 안 만드는 유일한 방법이다.***
 *  ⛔ 손으로 URL 을 긁으면 ***`json-schema.org` 같은 「이미지가 아닌」 URL 이 같이 걸린다***(실측).
 *
 *  ⭐ 순서도 라이브와 맞춘다 — **이미지 먼저, 그다음 위젯/알약**(`chat-runtime.ts` 의 ACP 경로와 동형). */
function toolTraceBlocks(trace: StoredSessionMessage, id: string): ChatBlock[] {
  const primary = toolTraceBlock(trace, id);
  let parsed: unknown;
  try { parsed = JSON.parse(String(trace.toolResult ?? '')); } catch { parsed = undefined; }
  const images: ChatBlock[] = mcpResultImages(parsed).map((img) => ({ kind: 'image', ...img }));
  // REL9p — the same card extraction as the live paths (`pushToolCards`); a truncated record just yields no card.
  const cards: ChatBlock[] = [];
  pushToolCards(cards, parsed ?? trace.toolResult);
  return [...images, primary, ...cards];
}

function toolTraceBlock(trace: StoredSessionMessage, id: string): ChatBlock {
  const name = String(trace.toolName ?? '');
  let parsed: unknown;
  try { parsed = JSON.parse(String(trace.toolResult ?? '')); } catch { parsed = undefined; }
  const rec = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : undefined;
  const meta = rec?._meta;
  const ui = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).ui : undefined;
  const nested = ui && typeof ui === 'object' && !Array.isArray(ui)
    ? (ui as Record<string, unknown>).resourceUri : undefined;
  // ⛔⭐⭐ 납작한 키도 «받는다» — 규범 밖이지만 ***상대가 실제로 그것을 보낸다.***
  //   📏 근거는 추측이 아니라 이 저장소의 실측이다:
  //     `src/mcp/proxy-runtime.ts:200` — *"상대는 `ui/resourceUri`(납작한 키)도 «같이» 보낸다 — 그것도 받는다"*
  //   ⊕ 같은 폴백을 이미 «둘»이 갖고 있다: `chat-runtime.ts`(라이브 경로) ⊕ `proxy-runtime.ts`(데몬).
  //   ⇒ 📌 여기서만 빼면 ***복원 경로에서만 위젯이 안 뜬다*** — 이 차수가 네 번 잡은
  //     「같은 계약이 갈린다」의 형태다(무인 리뷰가 이 폴백을 빼라 했으나 그래서 유지한다).
  const flat = rec?.['ui/resourceUri'];
  const screenUrl = typeof nested === 'string' ? nested : typeof flat === 'string' ? flat : undefined;

  if (screenUrl !== undefined && screenUrl.trim() !== '') {
    return {
      kind: 'mcp_app',
      toolId: id,
      toolName: name,
      screenUrl,
      // ⛔ 이 값이 없으면 브리지가 «밀 것이 없다» — `#11061` 이 그것으로 위젯을 비웠다.
      ...(parsed !== undefined ? { toolResult: parsed } : {}),
    };
  }
  // 화면을 안 가진 툴은 «알약»으로. ⛔ 상태는 `done` 이다 — 저장된 것은 «끝난» 호출뿐이다.
  return {
    kind: 'tool_use',
    id,
    name,
    status: 'done',
    ...(rec !== undefined && trace.toolArgs !== undefined
      ? { args: { raw: String(trace.toolArgs) } } : {}),
  };
}

function restoredTimestamp(ts: unknown, fallback: number): number {
  if (typeof ts !== 'string') return fallback;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(ts);
  if (!match) return fallback;
  const [, yearPart, monthPart, dayPart, hourPart, minutePart, secondPart, offsetHourPart, offsetMinutePart] = match;
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || daysInMonth === undefined || day > daysInMonth
    || Number(hourPart) > 23 || Number(minutePart) > 59 || Number(secondPart) > 59
    || (offsetHourPart !== undefined && (Number(offsetHourPart) > 23 || Number(offsetMinutePart) > 59))) return fallback;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 화면에 그릴 메시지만 남긴다. ⛔ 저장소는 그대로 둔다(위 머리말 참조).
 *
 *  ## ⛔⭐⭐ 「중복 답변」의 정체 — 저장 버그가 «아니었다»
 *
 *  📏 2026-08-22 실측: 같아 보이던 두 답변의 전문을 비교하니 **차이가 하나뿐이었다**.
 *  ```
 *  len 73  "…생성하지 않았습니다.⏎[tool_use]"   ← 중간 상태(툴을 더 부르겠다는 표식)
 *  len 62  "…생성하지 않았습니다."               ← 최종 답변
 *  ```
 *  ⇒ ***저장은 옳다.*** 하나는 「이 답 뒤에 툴이 이어진다」이고 하나는 최종이다.
 *  ⛔ 그런데 **자리표시자를 떼면 그 둘이 «같아진다»** ⇒ 화면에 같은 문장이 두 번 뜬다.
 *  🔑 ***즉 이 중복은 「원래 있던 것」이 아니라 «이 함수가 만드는 것»이다.***
 *
 *  ⇒ 그래서 **자리표시자를 «실제로 떼어낸» 메시지가 직전과 같아질 때만** 접는다.
 *  ⛔ 원래부터 중복인 것(사람이 같은 말을 두 번 한 경우 등)은 «안 건드린다» —
 *    그것은 이 함수가 판단할 일이 아니고, 지우면 진짜 대화가 사라진다.
 *  📏 실측: 그 규칙이 접는 것은 **5쌍 / 143줄**이고, 전부 이 함수가 만든 것이다. */
export function restorableChatMessages(
  stored: readonly StoredSessionMessage[],
  baseTimestamp: number,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  /** ⛔⭐⭐ 직전 «입력 후보» — 출력이 아니라 «입력»을 들고 다녀야 한다.
   *
   *  📏 무인 리뷰 must-fix(PR #11166): 1차판은 직전 «출력»과 그 stripped 플래그를 봤다.
   *  ⇒ `답변+[tool_use]` · `답변` · `답변` 처럼 ***원래부터 중복인 셋째까지 접혔다*** —
   *    첫 출력의 `stripped=true` 가 계속 남아 뒤의 모든 동일 텍스트를 삼켰기 때문이다.
   *  ⇒ 접히든 안 접히든 «직전 입력»으로 갱신해야 그 전파가 끊긴다. */
  let previousInput: { role: ChatMessage['role']; text: string; wasStripped: boolean } | undefined;
  /** ⭐⭐ 다음 답변 «앞»에 붙일 툴 블록들(권고 결정 ②-A).
   *
   *  📏 저장 순서가 이 설계를 뒷받침한다 — 감사 추적은 툴이 끝날 «때마다» 즉시 저장되고
   *  (19:17:10 / :15 / :21), 답변은 그 «뒤»에 온다(19:17:24). ⇒ 시간순이 살아 있다.
   *  ⭐ 그래서 라이브 화면과 «같은 모양»이 된다 — 답변 말풍선 안, 텍스트 «위»에 툴 줄이 선다. */
  let pendingToolBlocks: ChatBlock[] = [];
  let pendingToolTimestamp: unknown;
  for (const m of stored) {
    if (m.role === 'tool') {
      // ⛔ 툴 기록은 «자기 말풍선»을 갖지 않는다 — 다음 답변에 선행 블록으로 붙는다.
      if (pendingToolBlocks.length === 0) pendingToolTimestamp = m.ts;
      // ⭐ 이미지가 여러 장일 수 있어 «여럿»을 받는다. ⛔ 중복 src 는 넣지 않는다(라이브와 동형).
      for (const b of toolTraceBlocks(m, `restore-tool-${pendingToolBlocks.length}-${out.length}`)) {
        if (b.kind === 'image' && pendingToolBlocks.some((p) => p.kind === 'image' && p.src === b.src)) continue;
        pendingToolBlocks.push(b);
      }
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const original = String(m.content ?? '');
    const text = stripLlmReplayPlaceholders(original);
    const role = (m.role === 'assistant' ? 'assistant' : 'user') as ChatMessage['role'];
    // ⛔ 「비었나」만 trim 으로 «판정»한다 — 화면에 넘기는 값은 «원래 공백 그대로»다.
    if (text.trim() === '') {
      // ⛔⭐📏 무인 리뷰 must-fix(PR #11170): 여기서 그냥 `continue` 하면 **보류된 툴 블록이 안 실린다.**
      //   ⇒ 그 위젯은 «세션 끝에서 사라지거나» 훨씬 뒤의 «무관한 답변»에 붙는다.
      //   ⇒ 텍스트가 없어도 툴 블록이 있으면 «그것만으로» 말풍선을 세운다.
      if (pendingToolBlocks.length > 0 && role === 'assistant') {
        out.push({ id: `restore-${out.length}`, role, text: '', blocks: pendingToolBlocks, timestamp: restoredTimestamp(pendingToolTimestamp, baseTimestamp + out.length) });
        pendingToolBlocks = [];
        pendingToolTimestamp = undefined;
      }
      continue;
    }
    const wasStripped = text !== original;
    // ⭐ 위 주석의 규칙 — 「내가 만든 중복」만 접는다.
    //   ⛔📏 1차판은 «지금» 것의 `wasStripped` 만 봤다(시험이 잡았다) — 중복을 만든 것은 «앞» 메시지다.
    //   ⇒ 둘 중 «한쪽이라도» 떼어낸 것이면 접는다.
    const foldsIntoPrevious = previousInput !== undefined
      && previousInput.role === role
      && previousInput.text === text
      && (wasStripped || previousInput.wasStripped)
      // ⛔⭐ 보류된 툴 블록이 있으면 «접지 않는다» — 접으면 그 블록을 실을 자리가 사라진다
      //   (무인 리뷰 must-fix · PR #11170). 중복 한 줄보다 «잃은 위젯»이 크다.
      && pendingToolBlocks.length === 0;
    // ⛔ 접히든 «안» 접히든 직전 입력은 갱신한다 — 그래야 「내가 만든 한 쌍」에서 전파가 멈춘다.
    previousInput = { role, text, wasStripped };
    if (foldsIntoPrevious) continue;
    // ⛔⭐ `blocks` 가 있으면 렌더러가 `text` 를 «무시»한다(`ChatMessage.blocks` 주석).
    //   ⇒ 그래서 텍스트도 블록으로 넣는다. 안 그러면 툴 줄만 뜨고 «답변이 사라진다».
    const blocks: ChatBlock[] | undefined = pendingToolBlocks.length > 0 && role === 'assistant'
      ? [...pendingToolBlocks, { kind: 'text', text }]
      : undefined;
    const timestamp = restoredTimestamp(blocks !== undefined ? pendingToolTimestamp : m.ts, baseTimestamp + out.length);
    if (blocks !== undefined) {
      pendingToolBlocks = [];
      pendingToolTimestamp = undefined;
    }
    out.push({
      id: `restore-${out.length}`,
      role,
      text,
      ...(blocks !== undefined ? { blocks } : {}),
      timestamp,
    });
  }
  // ⛔⭐ 마지막 답변 «뒤»에 툴이 끝난 경우(또는 그 턴이 아직 답을 안 낸 경우) 블록이 남는다.
  //   ⇒ 버리지 않는다. 그것을 버리면 ***마지막 턴의 위젯이 영영 안 뜬다***(리뷰 must-fix).
  if (pendingToolBlocks.length > 0) {
    out.push({ id: `restore-${out.length}`, role: 'assistant', text: '', blocks: pendingToolBlocks, timestamp: restoredTimestamp(pendingToolTimestamp, baseTimestamp + out.length) });
  }
  return out;
}
