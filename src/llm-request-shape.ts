// ── Codex(Responses API) 요청 «모양» 요약 — 4xx 거절 관측용 (TUI-OBS-400-SHAPE · 결함 #69) ──
//
// 왜: Codex 백엔드는 400 을 `{"detail":"Bad Request"}` 한 줄로만 돌려준다. 그래서 «요청이 너무 컸나 ·
// 메시지가 몇 개였나 · tool_call ↔ tool_result 짝이 깨졌나 · 첨부가 섞였나» 를 로그로 가를 수 없었다
// (10-16 OPT 실측: 같은 문면이 «합쳤을 때만» 400 — 원인 추정 불가).
//
// 무엇을 싣나: 수·바이트·종류·짝 깨짐 수 «만». ⛔ 본문·프롬프트·도구 인자·도구 출력·사용자 텍스트·키는
// 싣지 않는다. 짝 깨진 call_id 는 sha256 앞 8자로만(상한 5개) — 같은 id 가 다음 런에도 보이는지 대조용.
// 순수 함수 — 호출부(streamCodexResponsesEvents)가 실제 전송 객체와 전송 문자열을 넘긴다.

import { createHash } from 'node:crypto';

const HASH_SAMPLE_CAP = 5;

// ⛔ 카운트 «키» 도 요청에서 온 문자열이다 — 알려진 종류만 키로 쓰고 나머지는 `unknown` 으로 접는다
//    (잘못된 type/role 문자열에 내용이 들어 있어도 이벤트에 새지 않게 · 리뷰 r1).
const KNOWN_ROLES = new Set(['user', 'assistant', 'system', 'developer', 'tool']);
const KNOWN_ITEM_TYPES = new Set([
  'message', 'function_call', 'function_call_output', 'reasoning', 'custom_tool_call', 'custom_tool_call_output',
  'local_shell_call', 'local_shell_call_output', 'web_search_call', 'image_generation_call', 'item_reference',
]);
const KNOWN_CONTENT_TYPES = new Set([
  'input_text', 'output_text', 'input_image', 'input_file', 'input_audio', 'refusal', 'summary_text', 'reasoning_text', 'string',
]);
const KNOWN_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const KNOWN_SUMMARIES = new Set(['auto', 'concise', 'detailed', 'none']);
const KNOWN_TOOL_CHOICES = new Set(['auto', 'required', 'none', 'function', 'allowed_tools', 'custom']);
const MODEL_ID_RE = /^[A-Za-z0-9._:/@+-]{1,80}$/;

function known(set: Set<string>, value: unknown): string {
  return typeof value === 'string' && set.has(value) ? value : 'unknown';
}

function hash8(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 8);
}

function byteLen(value: unknown): number {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    return Buffer.byteLength(text ?? '', 'utf8');
  } catch {
    return -1;
  }
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function countContentBlocks(content: unknown, counts: Record<string, number>, empty: { n: number }): void {
  if (typeof content === 'string') {
    bump(counts, 'string');
    if (content.length === 0) empty.n += 1;
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') { bump(counts, 'unknown'); continue; }
    const b = block as Record<string, unknown>;
    const type = typeof b.type === 'string' ? b.type : '';
    bump(counts, known(KNOWN_CONTENT_TYPES, type));
    if ((type === 'input_text' || type === 'output_text') && typeof b.text === 'string' && b.text.length === 0) empty.n += 1;
  }
}

export interface CodexRequestShape {
  status: number;
  /** UTF-8 bytes of the exact JSON string sent on the wire. */
  bytes: number;
  instructionsBytes: number;
  inputBytes: number;
  toolsBytes: number;
  /** Largest single input item, bytes — one huge tool output vs. many small items. */
  maxInputItemBytes: number;
  inputItemCount: number;
  /** Items carrying a `role` (user/assistant/system/developer messages). */
  messageCount: number;
  roleCounts: Record<string, number>;
  /** Top-level item kinds: message / function_call / function_call_output / reasoning / … */
  itemTypeCounts: Record<string, number>;
  /** Content block kinds across messages and array-form tool outputs (input_text / input_image / …). */
  contentTypeCounts: Record<string, number>;
  emptyTextBlockCount: number;
  toolCallCount: number;
  toolResultCount: number;
  /** function_call «items» whose call_id has no function_call_output anywhere (counted per item, duplicates included). */
  unpairedToolCallCount: number;
  /** function_call_output «items» whose call_id has no function_call anywhere (counted per item). */
  orphanToolResultCount: number;
  /** function_call_output items whose call_id has a function_call only «after» them. */
  toolResultBeforeCallCount: number;
  /** function_call items beyond the first for the same call_id. */
  duplicateToolCallIdCount: number;
  missingCallIdCount: number;
  unpairedToolCallIdHashes: string[];
  orphanToolResultIdHashes: string[];
  toolDefinitionCount: number;
  model?: string;
  reasoningEffort?: string;
  reasoningSummary?: string;
  store: boolean;
  hasPreviousResponseId: boolean;
  toolChoice?: string;
  hasPromptCacheKey: boolean;
  /** Size of the provider's error body — the body itself is not recorded. */
  errorBodyBytes?: number;
}

/** Summarise a Codex Responses request body for a rejected (4xx) call. Never copies text content. */
export function summarizeCodexRequestShape(
  wireBody: Record<string, unknown>,
  wireJson: string,
  status: number,
  errorBodyText?: string,
): CodexRequestShape {
  const input = Array.isArray(wireBody.input) ? wireBody.input : [];
  const roleCounts: Record<string, number> = {};
  const itemTypeCounts: Record<string, number> = {};
  const contentTypeCounts: Record<string, number> = {};
  const empty = { n: 0 };
  // 항목별로 센다(리뷰 r2) — 같은 call_id 가 여러 번 나와도 짝 깨짐 수는 «항목 수» 다.
  const calls: Array<{ id: string; index: number }> = [];
  const results: Array<{ id: string; index: number }> = [];
  let toolCallCount = 0;
  let toolResultCount = 0;
  let missingCallIdCount = 0;
  let maxInputItemBytes = 0;

  input.forEach((raw, index) => {
    maxInputItemBytes = Math.max(maxInputItemBytes, byteLen(raw));
    if (!raw || typeof raw !== 'object') { bump(itemTypeCounts, 'unknown'); return; }
    const item = raw as Record<string, unknown>;
    const type = typeof item.type === 'string' ? item.type : (typeof item.role === 'string' ? 'message' : 'unknown');
    bump(itemTypeCounts, known(KNOWN_ITEM_TYPES, type));
    if (typeof item.role === 'string') {
      bump(roleCounts, known(KNOWN_ROLES, item.role));
      countContentBlocks(item.content, contentTypeCounts, empty);
    }
    if (type === 'function_call') {
      toolCallCount += 1;
      const id = typeof item.call_id === 'string' && item.call_id ? item.call_id : '';
      if (!id) { missingCallIdCount += 1; return; }
      calls.push({ id, index });
    } else if (type === 'function_call_output') {
      toolResultCount += 1;
      countContentBlocks(item.output, contentTypeCounts, empty);
      const id = typeof item.call_id === 'string' && item.call_id ? item.call_id : '';
      if (!id) { missingCallIdCount += 1; return; }
      results.push({ id, index });
    }
  });

  const firstCallAt = new Map<string, number>();
  for (const c of calls) if (!firstCallAt.has(c.id)) firstCallAt.set(c.id, c.index);
  const resultIds = new Set(results.map((r) => r.id));
  const unpairedItems = calls.filter((c) => !resultIds.has(c.id));
  const orphanItems = results.filter((r) => !firstCallAt.has(r.id));
  const resultBeforeCall = results.filter((r) => firstCallAt.has(r.id) && r.index < (firstCallAt.get(r.id) as number)).length;
  const duplicateToolCallIdCount = calls.length - firstCallAt.size;
  const unpaired = [...new Set(unpairedItems.map((c) => c.id))];
  const orphan = [...new Set(orphanItems.map((r) => r.id))];

  const reasoning = wireBody.reasoning && typeof wireBody.reasoning === 'object'
    ? wireBody.reasoning as Record<string, unknown> : undefined;
  const toolChoiceRaw = wireBody.tool_choice;
  const toolChoice = toolChoiceRaw === undefined || toolChoiceRaw === null
    ? undefined
    : known(KNOWN_TOOL_CHOICES, typeof toolChoiceRaw === 'object' ? (toolChoiceRaw as Record<string, unknown>).type : toolChoiceRaw);
  const tools = Array.isArray(wireBody.tools) ? wireBody.tools : [];

  return {
    status,
    bytes: Buffer.byteLength(wireJson, 'utf8'),
    instructionsBytes: typeof wireBody.instructions === 'string' ? Buffer.byteLength(wireBody.instructions, 'utf8') : 0,
    inputBytes: byteLen(input),
    toolsBytes: byteLen(tools),
    maxInputItemBytes,
    inputItemCount: input.length,
    messageCount: Object.values(roleCounts).reduce((a, b) => a + b, 0),
    roleCounts,
    itemTypeCounts,
    contentTypeCounts,
    emptyTextBlockCount: empty.n,
    toolCallCount,
    toolResultCount,
    unpairedToolCallCount: unpairedItems.length,
    orphanToolResultCount: orphanItems.length,
    toolResultBeforeCallCount: resultBeforeCall,
    duplicateToolCallIdCount,
    missingCallIdCount,
    unpairedToolCallIdHashes: unpaired.slice(0, HASH_SAMPLE_CAP).map(hash8),
    orphanToolResultIdHashes: orphan.slice(0, HASH_SAMPLE_CAP).map(hash8),
    toolDefinitionCount: tools.length,
    ...(typeof wireBody.model === 'string' ? { model: MODEL_ID_RE.test(wireBody.model) ? wireBody.model : 'unknown' } : {}),
    ...(reasoning?.effort !== undefined ? { reasoningEffort: known(KNOWN_EFFORTS, reasoning.effort) } : {}),
    ...(reasoning?.summary !== undefined ? { reasoningSummary: known(KNOWN_SUMMARIES, reasoning.summary) } : {}),
    store: wireBody.store === true,
    hasPreviousResponseId: typeof wireBody.previous_response_id === 'string' && wireBody.previous_response_id.length > 0,
    ...(toolChoice ? { toolChoice } : {}),
    hasPromptCacheKey: typeof wireBody.prompt_cache_key === 'string',
    ...(typeof errorBodyText === 'string' ? { errorBodyBytes: Buffer.byteLength(errorBodyText, 'utf8') } : {}),
  };
}

/** 4xx rejections whose cause can be the request shape. Auth (401/403) and quota (429) are not shape problems. */
export function isShapeRelevantRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429;
}
