/**
 * Deterministic, network-free LLM for gate tests without provider credentials.
 * The opt-in is deliberately explicit; production never selects this provider.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { LLMMessage, LLMOpts, LLMProvider, LLMStreamEvent } from '../llm.js';
import { compareLlmCassetteRecording } from './device-fidelity.js';
import { debug } from '../debug/log.js';

export const TEST_FAKE_LLM_ENV = 'ELANOUS_TEST_FAKE_LLM';
export const TEST_FAKE_LLM_RESPONSE_ENV = 'ELANOUS_TEST_FAKE_LLM_RESPONSE';
/** PTY task-state fixture: fail only a request whose last human prompt contains this marker. */
export const TEST_FAKE_LLM_FAIL_WHEN_ENV = 'ELANOUS_TEST_FAKE_LLM_FAIL_WHEN';
/** Optional maximum Unicode code points per emitted text delta (unset = one delta). */
export const TEST_FAKE_LLM_CHUNK_SIZE_ENV = 'ELANOUS_TEST_FAKE_LLM_CHUNK_SIZE';
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

/** Test and simulated code default to the fake provider. A live `--test` CLI
 *  run is pinned to real by the global flag adapter unless explicitly faked. */
export function testFakeLlmDefaultSelected(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ELANOUS_LLM_MODE === 'real') return false;
  if (env.ELANOUS_LLM_MODE === 'fake') return true;
  if (env.ELANOUS_TEST_FAKE_LLM === '1') return true;
  return env.NODE_ENV === 'test' || Boolean(env.ELANOUS_UX_SIM_RUN_ID?.trim()) || env.ELANOUS_SIM_UNIVERSE === '1';
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

function responseChunks(text: string): string[] {
  const rawSize = process.env[TEST_FAKE_LLM_CHUNK_SIZE_ENV];
  if (rawSize === undefined || rawSize.trim() === '') return [text];
  const size = Number(rawSize);
  if (!Number.isSafeInteger(size) || size < 1) return [text];
  const points = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < points.length; index += size) chunks.push(points.slice(index, index + size).join(''));
  return chunks;
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
  let spec: { when?: unknown; name?: unknown; args?: unknown; after?: { name?: unknown; args?: unknown } };
  try { spec = JSON.parse(raw) as typeof spec; } catch { return null; }
  if (typeof spec.when !== 'string' || typeof spec.name !== 'string') return null;
  const text = lastHumanText(messages);
  let selectedName: string = spec.name;
  let selectedArgs: unknown = spec.args;
  if (text === null) {
    const prior = messages.at(-2);
    const result = messages.at(-1);
    const after = spec.after;
    if (!after || typeof after.name !== 'string'
      || prior?.role !== 'assistant' || !Array.isArray(prior.content)
      || !prior.content.some(block => block.type === 'tool_use' && block.name === spec.name)
      || result?.role !== 'user' || !Array.isArray(result.content)
      || !result.content.some(block => block.type === 'tool_result')) return null;
    selectedName = after.name;
    selectedArgs = after.args;
  } else if (!text.includes(spec.when)) return null;
  const args = selectedArgs && typeof selectedArgs === 'object' ? selectedArgs as Record<string, unknown> : {};
  return { type: 'tool_call', id: `call_fake_llm_tool_${++toolCallSeq}`, name: selectedName, args };
}

async function scriptedDelay(messages: LLMMessage[], signal?: AbortSignal): Promise<boolean> {
  const ms = Number(process.env[TEST_FAKE_LLM_DELAY_MS_ENV] ?? 0);
  if (!Number.isFinite(ms) || ms <= 0) return !signal?.aborted;
  const when = process.env[TEST_FAKE_LLM_DELAY_WHEN_ENV];
  if (when && !(lastHumanText(messages) ?? '').includes(when)) return !signal?.aborted;
  if (signal?.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(true), ms);
    const onAbort = () => finish(false);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Shares the real LLMProvider contract; only the external model call is replaced. */
export const testFakeLlmProvider: LLMProvider = {
  name: 'test-fake-llm',
  defaultModel: 'test-fake-llm',
  available: () => testFakeLlmEnabled() || testFakeLlmDefaultSelected(),
  async *chat(messages: LLMMessage[], _opts?: LLMOpts): AsyncGenerator<string, void, unknown> {
    captureRequest(messages);
    consumeScriptStep(messages);
    if (!await scriptedDelay(messages, _opts?.signal)) return;
    yield testFakeLlmResponse(messages);
  },
  async *streamChat(messages: LLMMessage[], _opts?: LLMOpts): AsyncGenerator<LLMStreamEvent, void, unknown> {
    captureRequest(messages);
    const failWhen = process.env[TEST_FAKE_LLM_FAIL_WHEN_ENV];
    if (failWhen && (lastHumanText(messages) ?? '').includes(failWhen)) throw new Error(`fake LLM failure for ${failWhen}`);
    const step = consumeScriptStep(messages);
    if (!await scriptedDelay(messages, _opts?.signal)) return;
    if (step?.startsWith('stall:')) {
      yield { type: 'text', delta: step.slice('stall:'.length) };
      const signal = _opts?.signal;
      if (!signal) await new Promise<void>(() => {});
      else if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return;
    }
    const call = scriptedToolCall(messages);
    if (call) { yield call; return; }
    for (const delta of responseChunks(testFakeLlmResponse(messages))) yield { type: 'text', delta };
  },
};

/** LLM execution policy for a simulation world. Real calls must go through the
 * shared, already-configured provider supplied by the caller (the same
 * credential slot used by ordinary LLM traffic); this module never reads or
 * stores credentials itself. */
export type SimLlmMode = 'fake' | 'replay' | 'real' | 'auto';
export type SimOutboundBoundary = 'llm' | 'github' | 'shell' | 'network' | (string & {});

export interface SimLlmBudget {
  /** Total real LLM calls allowed for the whole simulation run. */
  maxCalls: number;
  /** Wall-clock limit for all real LLM calls in this router, in milliseconds. */
  maxWallMs: number;
}

export interface SimWorldLlmConfig {
  mode: SimLlmMode;
  nodeModes?: Readonly<Record<string, SimLlmMode>>;
  outboundAllowlist?: readonly SimOutboundBoundary[];
  budget?: SimLlmBudget;
}

export interface SimLlmRouterOptions {
  mode: SimLlmMode;
  /** A node's mode takes precedence over the world's mode. */
  nodeModes?: Readonly<Record<string, SimLlmMode>>;
  /** Exact request-key to response-event cassette. This Map is populated by
   * auto/real misses and can be persisted by the world runner. */
  recordings?: Map<string, readonly LLMStreamEvent[]>;
  /** World-owned cassette file. Its parent is the isolated simulation state root. */
  recordingFile?: string;
  /** Shared credential slot selected by the normal application LLM config. */
  sharedCredentialProvider?: LLMProvider;
  /** Explicit simulation egress allowlist. Only the LLM boundary is eligible. */
  outboundAllowlist?: readonly SimOutboundBoundary[];
  /** Required before the router can make any real call. Budgets are shared
   * across every node-specific provider returned by this router. */
  budget?: SimLlmBudget;
  /** Test seam. Defaults to the deterministic, network-free provider above. */
  fakeProvider?: LLMProvider;
  /** Monotonic clock seam for deterministic budget checks. */
  now?: () => number;
  /** Wall clock seam for cassette expiry; defaults to current time. */
  wallNow?: () => Date;
  /** Cassette lifetime. Source: H3 cassette policy (30 days, OP #95544). */
  recordingTtlMs?: number;
}

export interface SimWorldLlmRuntimeOptions {
  sharedCredentialProvider?: LLMProvider;
  fakeProvider?: LLMProvider;
  recordingFile?: string;
  now?: () => number;
}

export interface SimLlmRouter {
  forNode(nodeId: string): LLMProvider;
  readonly recordings: Map<string, readonly LLMStreamEvent[]>;
  readonly recordingIds: Set<string>;
  budgetSnapshot(): { calls: number; elapsedMs: number; maxCalls?: number; maxWallMs?: number };
}

/** A simulation blocks all outbound boundaries by default. The only possible
 * exception is the explicitly allowlisted LLM broker; no generic network
 * request can use this exception. */
export function simOutboundAllowed(boundary: SimOutboundBoundary, allowlist: readonly SimOutboundBoundary[] = []): boolean {
  return boundary === 'llm' && allowlist.includes('llm');
}

function recordingKey(nodeId: string, messages: readonly LLMMessage[], opts?: LLMOpts): string {
  // Do not put prompts, credentials, or raw user content in the cassette key.
  // Its one-way digest lets the world find an exact replay without storing the
  // request itself in the recording.
  const request = JSON.stringify({
    nodeId,
    messages,
    model: opts?.model,
    temperature: opts?.temperature,
    maxTokens: opts?.maxTokens,
    tools: opts?.tools,
    firstTurnTools: opts?.firstTurnTools,
    toolChoice: opts?.toolChoice,
    serverTools: opts?.serverTools,
  });
  return createHash('sha256').update(request).digest('hex');
}

function cassetteContentId(key: string, events: readonly LLMStreamEvent[]): string {
  return createHash('sha256').update(key).update('\0').update(JSON.stringify(events)).digest('hex');
}

function scrubRecordedValue(value: unknown, key = ''): unknown {
  if (/authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|credential/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]')
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
      .replace(/\/(?:Users|home)\/[^\s/:]+/g, '/[REDACTED_HOME]')
      .replace(/\b(password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  }
  if (Array.isArray(value)) return value.map((item) => scrubRecordedValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, scrubRecordedValue(child, childKey)]));
  }
  return value;
}

function scrubRecordedEvents(events: readonly LLMStreamEvent[]): LLMStreamEvent[] {
  const result: LLMStreamEvent[] = [];
  let textRun: LLMStreamEvent[] = [];
  const flushText = () => {
    if (!textRun.length) return;
    const joined = textRun.map((event) => event.type === 'text' ? event.delta : '').join('');
    const scrubbed = scrubRecordedValue(joined) as string;
    if (scrubbed === joined) result.push(...textRun);
    else result.push({ type: 'text', delta: scrubbed });
    textRun = [];
  };
  for (const event of events) {
    if (event.type === 'text') textRun.push(event);
    else {
      flushText();
      result.push(scrubRecordedValue(event) as LLMStreamEvent);
    }
  }
  flushText();
  return result;
}

const DEFAULT_CASSETTE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // Source: H3 cassette policy (30 days, OP #95544).

function readRecordingFile(path: string): { recordings: Map<string, readonly LLMStreamEvent[]>; expires: Map<string, number> } {
  const recordings = new Map<string, readonly LLMStreamEvent[]>();
  const expires = new Map<string, number>();
  const addRecording = (key: string, events: unknown) => {
    if (!/^[a-f0-9]{64}$/.test(key) || !Array.isArray(events)
      || events.some((event) => !event || typeof event !== 'object' || !('type' in event))) {
      throw new Error('simulation LLM cassette file contains an invalid recording');
    }
    recordings.set(key, events as LLMStreamEvent[]);
  };
  const addSnapshot = (parsed: unknown) => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !('version' in parsed) || parsed.version !== 1 || !('recordings' in parsed)
      || !parsed.recordings || typeof parsed.recordings !== 'object' || Array.isArray(parsed.recordings)) {
      throw new Error('simulation LLM cassette file has an unsupported format');
    }
    for (const [key, events] of Object.entries(parsed.recordings)) {
      addRecording(key, events);
      expires.set(key, statSync(path).mtimeMs + DEFAULT_CASSETTE_TTL_MS);
    }
  };
  if (existsSync(path)) {
    const source = readFileSync(path, 'utf8');
    if (source.trim()) {
      let parsed: unknown;
      try { parsed = JSON.parse(source); }
      catch { throw new Error('simulation LLM cassette file is not valid JSON'); }
      addSnapshot(parsed);
    }
  }
  const entriesPath = `${path}.records`;
  if (!existsSync(entriesPath)) return { recordings, expires };
  for (const filename of readdirSync(entriesPath).filter((name) => name.endsWith('.json')).sort()) {
    const key = filename.slice(0, -'.json'.length);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(join(entriesPath, filename), 'utf8')); }
    catch { throw new Error(`simulation LLM cassette entry is invalid: ${filename}`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('version' in parsed) || (parsed.version !== 2 && parsed.version !== 3)
      || !('key' in parsed) || parsed.key !== key || !('events' in parsed)) {
      throw new Error(`simulation LLM cassette entry has an unsupported format: ${filename}`);
    }
    if (parsed.version === 3) {
      const entry = parsed as { recordedAt?: unknown; expiresAt?: unknown; provenance?: unknown };
      const recordedAt = typeof entry.recordedAt === 'string' ? Date.parse(entry.recordedAt) : Number.NaN;
      const expiresAt = typeof entry.expiresAt === 'string' ? Date.parse(entry.expiresAt) : Number.NaN;
      if (!Number.isFinite(recordedAt) || !Number.isFinite(expiresAt) || expiresAt <= recordedAt
        || !entry.provenance || typeof entry.provenance !== 'object' || (entry.provenance as { source?: unknown }).source !== 'replay') {
        throw new Error(`simulation LLM cassette entry has invalid expiry or provenance metadata: ${filename}`);
      }
    }
    addRecording(key, parsed.events);
    const metadata = parsed as { expiresAt?: unknown };
    if (metadata.expiresAt !== undefined && typeof metadata.expiresAt === 'string') {
      const expiresAt = Date.parse(metadata.expiresAt);
      if (Number.isFinite(expiresAt)) expires.set(key, expiresAt);
    } else {
      expires.set(key, statSync(join(entriesPath, filename)).mtimeMs + DEFAULT_CASSETTE_TTL_MS);
    }
  }
  return { recordings, expires };
}

function persistRecordingFile(path: string, recordings: ReadonlyMap<string, readonly LLMStreamEvent[]>, recordedAt: string, expiresAt: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Keep legacy v1 cassette JSON immutable; each new entry gets an atomic, independent sidecar file.
  writeFileSync(path, '', { flag: 'a', mode: 0o600 });
  const entriesPath = `${path}.records`;
  mkdirSync(entriesPath, { recursive: true, mode: 0o700 });
  for (const [key, events] of recordings) {
    const entryPath = join(entriesPath, `${key}.json`);
    const temporary = `${entryPath}.${randomUUID()}.tmp`;
    // Source: H3 cassette provenance and expiry contract; sidecar is atomically replaced.
    writeFileSync(temporary, JSON.stringify({ version: 3, key, events, recordedAt, expiresAt, recordingId: cassetteContentId(key, events), provenance: { source: 'replay' } }), { mode: 0o600 });
    renameSync(temporary, entryPath);
  }
}

/** Parse the world-facing declaration without accepting arbitrary real-world egress. */
export function parseSimWorldLlmConfig(value: unknown): SimWorldLlmConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('world.llm must be an object');
  const row = value as Record<string, unknown>;
  const unknown = Object.keys(row).find((key) => !['mode', 'nodes', 'nodeModes', 'outboundAllowlist', 'budget'].includes(key));
  if (unknown) throw new Error(`world.llm.${unknown} is not a supported field`);
  if (row.nodes !== undefined && row.nodeModes !== undefined) throw new Error('world.llm may declare nodes or nodeModes, not both');
  const validMode = (mode: unknown, path: string): SimLlmMode => {
    if (mode !== 'fake' && mode !== 'replay' && mode !== 'real' && mode !== 'auto') throw new Error(`${path} must be fake, replay, real, or auto`);
    return mode;
  };
  const mode = validMode(row.mode, 'world.llm.mode');
  let nodeModes: Record<string, SimLlmMode> | undefined;
  const declaredNodes = row.nodes ?? row.nodeModes;
  if (declaredNodes !== undefined) {
    if (!declaredNodes || typeof declaredNodes !== 'object' || Array.isArray(declaredNodes)) throw new Error('world.llm.nodes must be an object');
    nodeModes = Object.fromEntries(Object.entries(declaredNodes).map(([node, nodeMode]) => {
      if (!node.trim()) throw new Error('world.llm.nodes keys must be non-empty node ids');
      return [node, validMode(nodeMode, `world.llm.nodes.${node}`)];
    }));
  }
  let outboundAllowlist: SimOutboundBoundary[] | undefined;
  if (row.outboundAllowlist !== undefined) {
    if (!Array.isArray(row.outboundAllowlist) || row.outboundAllowlist.some((entry) => entry !== 'llm')
      || new Set(row.outboundAllowlist).size !== row.outboundAllowlist.length) {
      throw new Error('world.llm.outboundAllowlist may contain only llm');
    }
    outboundAllowlist = row.outboundAllowlist as 'llm'[];
  }
  let budget: SimLlmBudget | undefined;
  if (row.budget !== undefined) {
    if (!row.budget || typeof row.budget !== 'object' || Array.isArray(row.budget)) throw new Error('world.llm.budget must be an object');
    const budgetRow = row.budget as Record<string, unknown>;
    if (Object.keys(budgetRow).some((key) => key !== 'maxCalls' && key !== 'maxWallMs')
      || !validateBudget({ maxCalls: budgetRow.maxCalls as number, maxWallMs: budgetRow.maxWallMs as number })) {
      throw new Error('world.llm.budget requires positive maxCalls and maxWallMs');
    }
    budget = { maxCalls: budgetRow.maxCalls as number, maxWallMs: budgetRow.maxWallMs as number };
  }
  if ((mode === 'real' || mode === 'auto' || Object.values(nodeModes ?? {}).some((nodeMode) => nodeMode === 'real' || nodeMode === 'auto'))
    && (!budget || !outboundAllowlist?.includes('llm'))) {
    throw new Error('world.llm real/auto modes require an llm outbound allowlist and call/wall budget');
  }
  return { mode, ...(nodeModes ? { nodeModes } : {}), ...(outboundAllowlist ? { outboundAllowlist } : {}), ...(budget ? { budget } : {}) };
}

/** World-device constructor shared by the world runner and its isolated integration tests. */
export function createSimWorldLlm(config: SimWorldLlmConfig, runtime: SimWorldLlmRuntimeOptions = {}): SimLlmRouter {
  return createSimLlmRouter({ ...config, ...runtime });
}

function validateBudget(budget: SimLlmBudget | undefined): budget is SimLlmBudget {
  return !!budget && Number.isSafeInteger(budget.maxCalls) && budget.maxCalls > 0
    && Number.isFinite(budget.maxWallMs) && budget.maxWallMs > 0;
}

/** Build the four-mode LLM adapter used by simulated graph/world nodes.
 *
 * `fake` always uses the local deterministic provider. `replay` fails closed
 * on a cassette miss. `real` always calls the shared provider. `auto` replays
 * an exact cassette hit and otherwise calls the shared provider and records
 * its response. All real calls require the LLM-only egress allowlist and a
 * run-wide call/wall budget. Tests should pass a fake provider as the shared
 * provider; no test needs or should make a real model request.
 */
export function createSimLlmRouter(options: SimLlmRouterOptions): SimLlmRouter {
  if (!['fake', 'replay', 'real', 'auto'].includes(options.mode)) throw new Error(`unknown simulation LLM mode: ${String(options.mode)}`);
  for (const [nodeId, mode] of Object.entries(options.nodeModes ?? {})) {
    if (!nodeId.trim() || !['fake', 'replay', 'real', 'auto'].includes(mode)) throw new Error(`invalid simulation LLM node override: ${nodeId}`);
  }
  const wallNow = options.wallNow ?? (() => new Date());
  const loaded = options.recordingFile ? readRecordingFile(options.recordingFile) : { recordings: new Map<string, readonly LLMStreamEvent[]>(), expires: new Map<string, number>() };
  const recordings = options.recordings ?? loaded.recordings;
  const expires = loaded.expires;
  const recordingIds = new Set<string>();
  const fakeProvider = options.fakeProvider ?? testFakeLlmProvider;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  let calls = 0;

  const budgetSnapshot = () => ({ calls, elapsedMs: Math.max(0, now() - startedAt),
    ...(options.budget ? { maxCalls: options.budget.maxCalls, maxWallMs: options.budget.maxWallMs } : {}) });
  const canCallReal = () => simOutboundAllowed('llm', options.outboundAllowlist)
    && !!options.sharedCredentialProvider?.available()
    && validateBudget(options.budget)
    && calls < options.budget.maxCalls
    && now() - startedAt < options.budget.maxWallMs;

  function providerForNode(nodeId: string): LLMProvider {
    if (!nodeId.trim()) throw new Error('simulation LLM node id must be non-empty');
    const mode = options.nodeModes && Object.hasOwn(options.nodeModes, nodeId) ? options.nodeModes[nodeId]! : options.mode;
    const cassetteKey = (messages: LLMMessage[], opts?: LLMOpts) => recordingKey(nodeId, messages, opts);
    const replay = (key: string) => {
      const saved = recordings.get(key);
      const expiresAt = expires.get(key);
      return saved && (expiresAt === undefined || expiresAt > wallNow().getTime()) ? saved : undefined;
    };

    async function* run(messages: LLMMessage[], opts?: LLMOpts): AsyncGenerator<LLMStreamEvent, void, unknown> {
      const key = cassetteKey(messages, opts);
      const saved = replay(key);
      if (mode === 'replay' || (mode === 'auto' && saved)) {
        if (!saved) throw new Error(`simulation LLM cassette miss or expired for node ${nodeId}`);
        recordingIds.add(cassetteContentId(key, saved));
        debug.log('llm.cassette', 'response replayed', { source: 'replay', recordingId: key, nodeId });
        yield* saved;
        return;
      }
      if (mode === 'fake') {
        const stream = fakeProvider.streamChat?.(messages, opts)
          ?? (async function* () { for await (const delta of fakeProvider.chat(messages, opts)) yield { type: 'text', delta } as const; })();
        yield* stream;
        return;
      }
      const cassetteForComparison = mode === 'real' ? recordings.get(key) : undefined;

      if (!simOutboundAllowed('llm', options.outboundAllowlist)) throw new Error('simulation outbound blocked: llm is not allowlisted');
      debug.log('llm.cassette', cassetteForComparison ? 'real response compared' : 'real response requested', {
        source: 'real', ...(cassetteForComparison ? { comparedRecordingId: cassetteContentId(key, cassetteForComparison) } : {}), nodeId,
      });
      if (!options.sharedCredentialProvider?.available()) throw new Error('simulation real LLM requires the shared credential provider');
      if (!validateBudget(options.budget)) throw new Error('simulation real LLM requires a positive call and wall-time budget');
      if (calls >= options.budget.maxCalls) throw new Error('simulation real LLM call budget exceeded');
      if (opts?.signal?.aborted) throw new Error('simulation real LLM call aborted before dispatch');
      const elapsed = now() - startedAt;
      const remainingMs = options.budget.maxWallMs - elapsed;
      if (remainingMs <= 0) throw new Error('simulation real LLM wall-time budget exceeded');
      calls += 1;

      const controller = new AbortController();
      const inheritedSignal = opts?.signal;
      const onAbort = () => controller.abort(inheritedSignal?.reason);
      if (inheritedSignal?.aborted) onAbort();
      else inheritedSignal?.addEventListener('abort', onAbort, { once: true });
      let timeoutFailure: ((error: Error) => void) | undefined;
      const timeout = new Promise<never>((_resolve, reject) => { timeoutFailure = reject; });
      // The provider may yield a chunk and then wait while the consumer processes it.
      // Keep the later deadline rejection observed even while no iterator.next() is active.
      void timeout.catch(() => undefined);
      const timer = setTimeout(() => {
        controller.abort(new Error('simulation real LLM wall-time budget exceeded'));
        timeoutFailure?.(new Error('simulation real LLM wall-time budget exceeded'));
      }, remainingMs);
      let abortFailure: ((error: Error) => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => { abortFailure = reject; });
      void aborted.catch(() => undefined);
      const onInheritedAbort = () => abortFailure?.(new Error('simulation real LLM call aborted; cassette not recorded'));
      inheritedSignal?.addEventListener('abort', onInheritedAbort, { once: true });
      const provider = options.sharedCredentialProvider;
      const events: LLMStreamEvent[] = [];
      let iterator: AsyncIterator<LLMStreamEvent> | undefined;
      let iteratorDone = false;
      try {
        const realStream = provider.streamChat?.(messages, { ...opts, signal: controller.signal })
          ?? (async function* () { for await (const delta of provider.chat(messages, { ...opts, signal: controller.signal })) yield { type: 'text', delta } as const; })();
        iterator = realStream[Symbol.asyncIterator]();
        while (true) {
          const next = await Promise.race([iterator.next(), timeout, aborted]);
          if (next.done) { iteratorDone = true; break; }
          const event = next.value;
          if (inheritedSignal?.aborted) throw new Error('simulation real LLM call aborted; cassette not recorded');
          if (controller.signal.aborted || now() - startedAt >= options.budget.maxWallMs) {
            throw new Error('simulation real LLM wall-time budget exceeded');
          }
          events.push(event);
          yield event;
        }
        if (inheritedSignal?.aborted) throw new Error('simulation real LLM call aborted; cassette not recorded');
        if (controller.signal.aborted || now() - startedAt >= options.budget.maxWallMs) {
          throw new Error('simulation real LLM wall-time budget exceeded');
        }
        const sanitized = scrubRecordedEvents(events);
        if (mode === 'real' && cassetteForComparison) {
          compareLlmCassetteRecording(cassetteContentId(key, cassetteForComparison), [...cassetteForComparison], sanitized, undefined, key);
          return;
        }
        const recordedAt = wallNow();
        const expiry = new Date(recordedAt.getTime() + (options.recordingTtlMs ?? DEFAULT_CASSETTE_TTL_MS));
        if (options.recordingFile) persistRecordingFile(options.recordingFile, new Map([[key, sanitized]]), recordedAt.toISOString(), expiry.toISOString());
        recordings.set(key, sanitized);
        expires.set(key, expiry.getTime());
      } finally {
        clearTimeout(timer);
        inheritedSignal?.removeEventListener('abort', onInheritedAbort);
        inheritedSignal?.removeEventListener('abort', onAbort);
        if (!iteratorDone && iterator?.return) void Promise.resolve(iterator.return()).catch(() => undefined);
      }
    }

    return {
      name: `sim-llm:${nodeId}:${mode}`,
      defaultModel: mode === 'fake' ? fakeProvider.defaultModel : options.sharedCredentialProvider?.defaultModel ?? fakeProvider.defaultModel,
      available: () => mode === 'fake' || mode === 'replay' || (mode === 'auto' && (recordings.size > 0 || canCallReal()))
        || (mode === 'real' && canCallReal()),
      async *chat(messages, opts) {
        for await (const event of run(messages, opts)) if (event.type === 'text') yield event.delta;
      },
      streamChat: run,
    };
  }

  return { forNode: providerForNode, recordings, recordingIds, budgetSnapshot };
}
