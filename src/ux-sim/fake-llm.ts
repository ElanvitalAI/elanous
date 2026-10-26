/**
 * Deterministic, network-free LLM for gate tests without provider credentials.
 * The opt-in is deliberately explicit; production never selects this provider.
 */
import { appendFileSync } from 'node:fs';
import type { LLMMessage, LLMOpts, LLMProvider, LLMStreamEvent } from '../llm.js';

export const TEST_FAKE_LLM_ENV = 'ELANOUS_TEST_FAKE_LLM';
export const TEST_FAKE_LLM_RESPONSE_ENV = 'ELANOUS_TEST_FAKE_LLM_RESPONSE';
/** TUI-400-AUTOHEAL-FALLBACK — 호출별 결함 스크립트(쉼표 목록 · `400` | `400codex` | `ok`). 예: `400,ok,ok`.
 *  `400` 칸은 실측 «대화 기록 어긋남» 꼴(`LLM API 400: … No tool call found for function call output …`)을 던진다.
 *  스크립트가 끝나면 `ok`. 칸 소비는 이 프로세스 안 호출 순서다(라이브 TUI 격리 무대용 — 생산은 이 env 를 안 본다). */
export const TEST_FAKE_LLM_SCRIPT_ENV = 'ELANOUS_TEST_FAKE_LLM_SCRIPT';
export const TEST_FAKE_LLM_400_MESSAGE = 'LLM API 400: {"error":{"message":"No tool call found for function call output with call_id call_fake_llm.","type":"invalid_request_error"}}';
/** TUI-ORPHAN-AUTO-RESUME-STOP — `400codex` 칸: 같은 «고아 도구 출력» 400 을 Codex 공급자 머리(`Codex API 400`)로 던진다.
 *  seat-autowake 의 종결 판정은 생산 Codex 문면을 문다 — `400` 칸(`LLM API 400`)으로는 그 길이 안 열린다. */
export const TEST_FAKE_LLM_CODEX_400_MESSAGE = 'Codex API 400: {"error":{"message":"No tool call found for function call output with call_id call_fake_llm.","type":"invalid_request_error"}}';

export function testFakeLlmEnabled(): boolean {
  return process.env[TEST_FAKE_LLM_ENV] === '1';
}

/** `{step}` in the response becomes the number of user messages (tool results excluded) the model received — a different reply per
 *  turn of one conversation (TUI-GOAL-INTERIM-QUIET: «every step ends with 아직 못 했다» without same-reply stops). */
const TEST_FAKE_LLM_STEP_TOKEN = '{step}';

export function testFakeLlmResponse(messages?: readonly LLMMessage[]): string {
  const text = process.env[TEST_FAKE_LLM_RESPONSE_ENV] ?? '[test-fake-llm] OK';
  if (!text.includes(TEST_FAKE_LLM_STEP_TOKEN)) return text;
  // Person/internal-turn text only — a tool result travels as a user-role message and must not count as a step.
  const step = (messages ?? []).filter((m) => m.role === 'user'
    && !(Array.isArray(m.content) && m.content.some((block) => block.type === 'tool_result'))).length;
  return text.split(TEST_FAKE_LLM_STEP_TOKEN).join(String(step));
}

let scriptCursor = 0;
/** 커서가 센 스크립트 문자열 — env 가 바뀌면 처음부터 다시 센다(앞 시험의 진행이 뒤 시험으로 새지 않게). */
let scriptCursorFor: string | undefined;

/** 시험 seam — 스크립트 칸 위치를 처음으로. */
export function resetTestFakeLlmScript(): void {
  scriptCursor = 0;
  scriptCursorFor = undefined;
}

/** TUI-ORPHAN-AUTO-RESUME-STOP — 마지막 사람 발화가 이 표지를 담으면 스크립트 칸을 안 쓰고 답한다
 *  («결함이 계속되는 세션에서도 사람 턴은 답을 받는다» 무대 · 칸 수를 호출 수에 맞춰 세지 않게). */
export const TEST_FAKE_LLM_SCRIPT_SKIP_WHEN_ENV = 'ELANOUS_TEST_FAKE_LLM_SCRIPT_SKIP_WHEN';

/** 다음 호출의 스크립트 칸을 소비한다. 400 칸이면 던지고 `stall:<text>` 는 스트림에서 첫 조각 뒤 멈춘다. */
function consumeScriptStep(messages: LLMMessage[]): string | undefined {
  const raw = process.env[TEST_FAKE_LLM_SCRIPT_ENV];
  if (!raw) return undefined;
  const skipWhen = process.env[TEST_FAKE_LLM_SCRIPT_SKIP_WHEN_ENV];
  if (skipWhen && (lastHumanText(messages) ?? '').includes(skipWhen)) return undefined;
  if (raw !== scriptCursorFor) { scriptCursorFor = raw; scriptCursor = 0; }
  const steps = raw.split(',').map((step) => step.trim()).filter(Boolean);
  const step = steps[scriptCursor];
  scriptCursor += 1;
  if (step === '400') throw new Error(TEST_FAKE_LLM_400_MESSAGE);
  if (step === '400codex') throw new Error(TEST_FAKE_LLM_CODEX_400_MESSAGE);
  return step;
}

/** TUI-SEAT-MEMORY-RECALL — 요청 기록(격리 무대 전용). 경로를 주면 호출마다 받은 메시지(role·문자열 content)를
 *  JSONL 한 줄로 덧붙인다 — «모델이 실제로 받은 preamble» 을 무대 밖에서 단언하기 위함. 생산은 이 env 를 안 본다. */
export const TEST_FAKE_LLM_CAPTURE_ENV = 'ELANOUS_TEST_FAKE_LLM_CAPTURE';

function captureRequest(messages: LLMMessage[]): void {
  const path = process.env[TEST_FAKE_LLM_CAPTURE_ENV];
  if (!path) return;
  const rows = messages.map((message) => ({
    role: message.role,
    content: typeof message.content === 'string'
      ? message.content
      : message.content.map((block) => block.type === 'text' ? { type: 'text', text: block.text } : { type: block.type }),
  }));
  appendFileSync(path, `${JSON.stringify({ messages: rows })}\n`);
}

/** TUI-NEXT-QUEUE-AND-WAKE — `{"when":"<표지>","name":"<도구>","args":{…}}`. 마지막 메시지가 표지를 담은 사람 발화
 *  (도구 결과 아님)면 텍스트 대신 그 도구 호출 하나를 낸다 — 도구가 실제 턴 루프에서 «불리는» 무대(예: ScheduleWakeup).
 *  도구 결과 뒤 호출·표지 없는 발화는 고정 응답. JSON 이 틀리면 없는 것과 같다. */
export const TEST_FAKE_LLM_TOOL_CALL_ENV = 'ELANOUS_TEST_FAKE_LLM_TOOL_CALL';
/** 응답 전 지연(ms) — «도는 턴»을 사람 손으로 잡을 만큼 길게 만든다(busy 중 입력 무대). */
export const TEST_FAKE_LLM_DELAY_MS_ENV = 'ELANOUS_TEST_FAKE_LLM_DELAY_MS';
/** 주면 마지막 사람 발화가 이 표지를 담을 때만 지연한다. */
export const TEST_FAKE_LLM_DELAY_WHEN_ENV = 'ELANOUS_TEST_FAKE_LLM_DELAY_WHEN';

let toolCallSeq = 0;

/** 마지막 메시지가 사람 발화면 그 글, 도구 결과(또는 사람 아님)면 null. */
function lastHumanText(messages: LLMMessage[]): string | null {
  const last = messages.at(-1);
  if (!last || last.role !== 'user') return null;
  if (typeof last.content === 'string') return last.content;
  if (last.content.some((block) => block.type === 'tool_result')) return null;
  return last.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

function scriptedToolCall(messages: LLMMessage[]): LLMStreamEvent | null {
  const raw = process.env[TEST_FAKE_LLM_TOOL_CALL_ENV];
  if (!raw) return null;
  let spec: { when?: unknown; name?: unknown; args?: unknown };
  try { spec = JSON.parse(raw) as typeof spec; } catch { return null; }
  if (typeof spec.when !== 'string' || typeof spec.name !== 'string') return null;
  const text = lastHumanText(messages);
  if (text === null || !text.includes(spec.when)) return null;
  const args = spec.args && typeof spec.args === 'object' ? spec.args as Record<string, unknown> : {};
  return { type: 'tool_call', id: `call_fake_llm_tool_${++toolCallSeq}`, name: spec.name, args };
}

async function scriptedDelay(messages: LLMMessage[]): Promise<void> {
  const ms = Number(process.env[TEST_FAKE_LLM_DELAY_MS_ENV] ?? 0);
  if (!Number.isFinite(ms) || ms <= 0) return;
  const when = process.env[TEST_FAKE_LLM_DELAY_WHEN_ENV];
  if (when && !(lastHumanText(messages) ?? '').includes(when)) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shares the real LLMProvider contract; only the external model call is replaced. */
export const testFakeLlmProvider: LLMProvider = {
  name: 'test-fake-llm',
  defaultModel: 'test-fake-llm',
  available: testFakeLlmEnabled,
  async *chat(messages: LLMMessage[], _opts?: LLMOpts): AsyncGenerator<string, void, unknown> {
    captureRequest(messages);
    consumeScriptStep(messages);
    await scriptedDelay(messages);
    yield testFakeLlmResponse(messages);
  },
  async *streamChat(messages: LLMMessage[], _opts?: LLMOpts): AsyncGenerator<LLMStreamEvent, void, unknown> {
    captureRequest(messages);
    const step = consumeScriptStep(messages);
    await scriptedDelay(messages);
    if (step?.startsWith('stall:')) {
      yield { type: 'text', delta: step.slice('stall:'.length) };
      await new Promise<void>(() => {});
      return;
    }
    const call = scriptedToolCall(messages);
    if (call) { yield call; return; }
    yield { type: 'text', delta: testFakeLlmResponse(messages) };
  },
};
