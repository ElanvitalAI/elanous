import { isRecord } from '../../../../src/primitives/guards';
import { debugLog } from './debug';

type JsonRpcId = string | number;
type McpAppSource = object;
type PushOmissionReason = 'too_large' | 'unserializable' | 'not_a_tool_result';

export interface McpAppFrameBinding {
  frameId: string;
  source: McpAppSource;
  server: string;
  /** Host-owned tool that created this screen. Without it host pushes are refused. */
  tool?: string;
  /** ⛔ The tool *call* that created this screen — unique per invocation.
   *  Correlating on server+tool alone broadcasts: call `generate_image`
   *  twice and the second result lands in both widgets, overwriting the
   *  first. The host knows this id (the chat block carries it); the widget
   *  never names it. */
  toolCallId?: string;
}

export interface McpAppToolResult {
  server: string;
  tool: string;
  /** When present, only the screen created by this exact call receives it. */
  toolCallId?: string;
  result: unknown;
}

interface RegisteredMcpAppFrame extends McpAppFrameBinding {
  generation: number;
  ready: boolean;
}

interface PendingMcpAppCall {
  frameId: string;
  id: JsonRpcId;
  generation: number;
}

interface PendingMcpAppPush extends McpAppToolResult {
  frameId: string;
  generation: number;
}

interface McpAppBridgeState {
  frames: Readonly<Record<string, RegisteredMcpAppFrame>>;
  pending: Readonly<Record<string, PendingMcpAppCall>>;
  pushes: readonly PendingMcpAppPush[];
  /** Results whose screen has not registered yet, keyed by their own call id. */
  unmatched: readonly McpAppToolResult[];
  nextGeneration: number;
}

type McpAppBridgeAction =
  | { kind: 'observe'; reason: 'untrusted-source' | 'malformed-message' | 'unknown-method'; method?: string }
  | { kind: 'respond'; frameId: string; message: Record<string, unknown> }
  | { kind: 'daemon-tool-call'; frameId: string; id: JsonRpcId; generation: number; server: string; tool: string; arguments: unknown }
  /** ⛔⭐⭐ `omitted`·`bytes` 는 «관측을 위한 짐»이다 — 이 순수 결정 함수들은 로그를 못 쓴다.
   *
   *  📏 2026-08-22 실측(16차 `[F]`): 위젯이 빈 화면으로 남았는데 **왜인지 아무도 못 말했다.**
   *  결과가 64KB 를 넘으면 우리는 본문을 버리고 `content: []` 를 보내는데(`too_large`),
   *  그 사실이 위젯의 `_meta` «안»에만 있었다 — 그것은 ***우리 고유 키라 위젯이 이해할 리 없고***,
   *  우리 로그에도 «한 줄도» 안 남았다. ⇒ 사람이 「크기 때문에 잘렸다」를 알 방법이 없었다.
   *  ⛔ 그래서 그 값을 액션에 실어 나른다 — 실행부가 관측하고, 결정 함수는 순수하게 남는다. */
  | { kind: 'notify'; frameId: string; message: Record<string, unknown>; omitted?: PushOmissionReason; bytes: number };

type Decision = { state: McpAppBridgeState; actions: McpAppBridgeAction[] };

export const MCP_APP_PUSH_MAX_BYTES = 64 * 1024;

/** ⛔⭐⭐⭐ MCP Apps 메서드 이름의 «집» — 규범에서 그대로 읽었다(추측 0).
 *
 *  📏 출처: `modelcontextprotocol/ext-apps` 의 `src/spec.types.ts`(SEP-1865) — 그 파일의
 *  `TOOL_RESULT_METHOD`·`INITIALIZED_METHOD`·`INITIALIZE_METHOD` 상수를 실제로 읽어 맞췄다.
 *  그 규범이 정의하는 `ui/` 메서드는 «열일곱»이고 우리는 그중 셋만 안다.
 *
 *  📏 2026-08-21 실측 결함: 우리 푸시가 `notifications/tool-result`(접두 없음)를 쓰고 있었다.
 *  위젯은 `ui/notifications/tool-result` 를 듣는다 — ***이름이 달라서 영영 안 닿는다.***
 *  ⇒ 이 저장소가 같은 날 열아홉 번 밟은 그 형태다. 그래서 이름을 «한 곳»에 두고 시험도 여기서 읽는다. */
export const MCP_UI_INITIALIZE_METHOD = 'ui/initialize';
/** ⛔ 방향은 View → Host 다. 호스트가 이 이름을 «보내면» 규범 위반이다. */
export const MCP_UI_INITIALIZED_METHOD = 'ui/notifications/initialized';
/** 호스트가 위젯에 결과를 밀 때 쓰는 이름. `params` 는 `CallToolResult` «그 자체»다(감싸지 않는다). */
export const MCP_UI_TOOL_RESULT_METHOD = 'ui/notifications/tool-result';
/** 규범 이전의 이름 — 옛 위젯이 이것을 보낼 수 있어 «받기»만 한다. 보내지는 않는다. */
export const LEGACY_INITIALIZED_METHOD = 'notifications/initialized';
/** 우리가 결과를 못 실었을 때 그 이유를 싣는 자리. 규범 밖이라 이름공간을 붙인다. */
export const MCP_APP_RESULT_OMITTED_META_KEY = 'elanous/resultOmittedReason';

const emptyState = (): McpAppBridgeState => ({ frames: {}, pending: {}, pushes: [], unmatched: [], nextGeneration: 1 });
const pendingKey = (frameId: string, generation: number, id: JsonRpcId) =>
  `${frameId}:${generation}:${typeof id}:${String(id)}`;

function response(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function copy(state: McpAppBridgeState): {
  frames: Record<string, RegisteredMcpAppFrame>;
  pending: Record<string, PendingMcpAppCall>;
  pushes: PendingMcpAppPush[];
  unmatched: McpAppToolResult[];
  nextGeneration: number;
} {
  return {
    frames: { ...state.frames }, pending: { ...state.pending }, pushes: [...state.pushes],
    unmatched: [...state.unmatched], nextGeneration: state.nextGeneration,
  };
}

/** ⛔ 못 실은 것을 «툴 오류»로 꾸미지 않는다 — 툴은 성공했고 못 나른 것은 우리다.
 *  그래서 본문은 비우고 이유만 이름공간 붙인 `_meta` 에 싣는다. */
function omittedPushMessage(reason: PushOmissionReason): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: MCP_UI_TOOL_RESULT_METHOD,
    params: { content: [], _meta: { [MCP_APP_RESULT_OMITTED_META_KEY]: reason } },
  };
}

/** 규범이 `params: CallToolResult` 를 요구하므로 «아닌 것»을 그대로 실어 보내지 않는다.
 *
 *  ⛔📏 무인 리뷰(2026-08-21 · PR #10861)가 잡았다: `result` 가 `unknown` 이라 문자열도 그대로 나갔고,
 *  내가 쓴 시험이 `params: 'first'` 를 «성공으로 고정»해 규범 위반을 계약으로 잠갔다.
 *  ⇒ 이 세션이 내내 잡던 그 형태를 내가 냈다.
 *
 *  ⛔⭐ 여기서 «검증»을 과장하지 않는다 — 우리가 확인하는 것은 둘뿐이다:
 *    ⓐ 객체인가(배열·원시값이 아닌가) ⓑ `content` 가 있으면 배열인가.
 *  SDK 의 `CallToolResult` 는 `content` 에 기본값이 있어 «없을 수도» 있다. 그래서 있으면만 본다.
 *  나머지 필드까지 맞는지는 «안 본다» — 모르는 것을 안다고 말하지 않는다. */
function isCallToolResultShape(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return !('content' in value) || Array.isArray(value.content);
}

/** ⛔⭐ `params` 는 `CallToolResult` «그 자체»다. 우리가 `{ tool, result }` 로 감싸면
 *  위젯이 `params.content` 를 찾다가 «빈손»으로 돌아간다(규범 `McpUiToolResultNotification`). */
/** ⛔ 「무엇을 보내나」와 «왜 그것을 보내나»를 같이 돌려준다.
 *  `bytes` 는 **원래 실으려던 것의 크기**다 — 생략됐을 때 「얼마나 넘쳤나」를 사람이 알아야
 *  상한을 올릴지 결과를 줄일지 정할 수 있다. ⛔ 「너무 크다」만 알면 다음 수가 없다. */
function pushMessage(result: unknown): { message: Record<string, unknown>; omitted?: PushOmissionReason; bytes: number } {
  if (!isCallToolResultShape(result)) return { message: omittedPushMessage('not_a_tool_result'), omitted: 'not_a_tool_result', bytes: -1 };
  const message = { jsonrpc: '2.0', method: MCP_UI_TOOL_RESULT_METHOD, params: result };
  try {
    structuredClone(message);
    const bytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
    if (bytes <= MCP_APP_PUSH_MAX_BYTES) return { message, bytes };
    return { message: omittedPushMessage('too_large'), omitted: 'too_large', bytes };
  } catch {
    // ⛔ 직렬화가 안 되면 크기를 «못 잰다». 0 으로 뭉개지 않고 「모른다」를 -1 로 나른다.
    return { message: omittedPushMessage('unserializable'), omitted: 'unserializable', bytes: -1 };
  }
}

function notifyPush(push: PendingMcpAppPush): McpAppBridgeAction {
  const { message, omitted, bytes } = pushMessage(push.result);
  return { kind: 'notify', frameId: push.frameId, message, bytes, ...(omitted ? { omitted } : {}) };
}

function deliverPush(state: McpAppBridgeState, push: PendingMcpAppPush): Decision {
  const frame = state.frames[push.frameId];
  if (!frame || frame.generation !== push.generation) return { state, actions: [] };
  if (frame.ready) return { state, actions: [notifyPush(push)] };
  const next = copy(state);
  next.pushes.push(push);
  return { state: next, actions: [] };
}

export function createMcpAppBridgeState(): McpAppBridgeState {
  return emptyState();
}

function removeMcpAppFrame(next: ReturnType<typeof copy>, frameId: string): void {
  delete next.frames[frameId];
  for (const [key, pending] of Object.entries(next.pending)) {
    if (pending.frameId === frameId) delete next.pending[key];
  }
  next.pushes = next.pushes.filter((push) => push.frameId !== frameId);
}

export function registerMcpAppFrame(state: McpAppBridgeState, binding: McpAppFrameBinding): Decision {
  const next = copy(state);
  for (const [frameId, frame] of Object.entries(next.frames)) {
    if (frameId === binding.frameId || frame.source === binding.source) removeMcpAppFrame(next, frameId);
  }
  const generation = next.nextGeneration++;
  next.frames[binding.frameId] = { ...binding, generation, ready: false };

  // ⭐ Claim any result that arrived before this screen existed. It is queued
  //   (not sent) because the frame is not ready yet — `readyMcpAppFrame`
  //   flushes it FIFO once the widget says it is listening.
  const claimed = next.unmatched.filter((held) => (
    held.server === binding.server && held.tool === binding.tool
    && held.toolCallId !== undefined && held.toolCallId === binding.toolCallId
  ));
  next.unmatched = next.unmatched.filter((held) => !claimed.includes(held));
  for (const held of claimed) next.pushes.push({ ...held, frameId: binding.frameId, generation });

  // ⛔📏 여기서 `notifications/initialized` 를 위젯에 «보내고» 있었다. 규범은 그 이름을
  //   ***View → Host*** 로 정의한다(`McpUiInitializedNotification`) — 호스트가 보내면 위반이고,
  //   규범을 따르는 위젯에는 「호스트가 초기화됐다」는 말이 아예 «없다». 그래서 안 보낸다.
  //   ⭐ 호스트가 준비됐다는 말은 이미 `ui/initialize` «응답»이 한다.
  return { state: next, actions: [] };
}

export function disposeMcpAppFrame(state: McpAppBridgeState, frameId: string, generation?: number): Decision {
  const current = state.frames[frameId];
  if (!current || (generation !== undefined && current.generation !== generation)) return { state, actions: [] };
  const next = copy(state);
  removeMcpAppFrame(next, frameId);
  return { state: next, actions: [] };
}

export function disposeMcpAppConversation(state: McpAppBridgeState): McpAppBridgeState {
  return { frames: {}, pending: {}, pushes: [], unmatched: [], nextGeneration: state.nextGeneration };
}

function readyMcpAppFrame(state: McpAppBridgeState, frame: RegisteredMcpAppFrame): Decision {
  if (frame.ready) return { state, actions: [] };
  const next = copy(state);
  next.frames[frame.frameId] = { ...frame, ready: true };
  const queued = next.pushes.filter((push) => push.frameId === frame.frameId && push.generation === frame.generation);
  next.pushes = next.pushes.filter((push) => push.frameId !== frame.frameId || push.generation !== frame.generation);
  return { state: next, actions: queued.map(notifyPush) };
}

/** MCP Apps 악수 — 위젯이 «가장 먼저» 거는 말.
 *
 *  📏 2026-08-21 실물에서 잡았다: 위젯 iframe 안에 `-32601 Method not found` 가 찍혔고,
 *  관측을 넓히니 요구한 이름이 ***`ui/initialize`*** 였다(x2). 그 전까지 위젯은
 *  악수를 못 해 «빈 채로» 멈춰 있었다.
 *
 *  📌 계약은 상대 번들에서 «직접» 읽었다(추측 아님):
 *    요청  { appInfo, appCapabilities, protocolVersion }
 *    응답  { protocolVersion, hostInfo, hostCapabilities, hostContext }
 *
 *  ⛔⭐ **우리가 «실제로 하는 것»만 선언한다.** 그 번들의 hostCapabilities 는
 *    `openLinks` · `downloadFile` · `serverTools` · `serverResources` 를 가르는데,
 *    우리는 툴 호출만 프록시한다(`tools/call` → 데몬 길 → 승인 게이트).
 *    ⇒ `serverTools` 하나만 켠다. `openLinks` 는 «의도적으로 막는» 것이므로 켜지 않는다
 *      — 켜 놓고 거부하면 상대가 그 기능을 믿고 UI 를 그린다. */
const MCP_APP_PROTOCOL_VERSION = '2025-11-21';

function initializeResult(): Record<string, unknown> {
  return {
    protocolVersion: MCP_APP_PROTOCOL_VERSION,
    hostInfo: { name: 'elanous', version: '1' },
    // ⛔ 안 하는 것을 «한다고» 말하지 않는다.
    hostCapabilities: { serverTools: {} },
    hostContext: {},
  };
}

export function decideMcpAppMessage(state: McpAppBridgeState, source: unknown, message: unknown): Decision {
  const frame = Object.values(state.frames).find((candidate) => candidate.source === source);
  if (!frame) return { state, actions: [{ kind: 'observe', reason: 'untrusted-source' }] };
  if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { state, actions: [{ kind: 'observe', reason: 'malformed-message' }] };
  }
  if (message.method === LEGACY_INITIALIZED_METHOD || message.method === MCP_UI_INITIALIZED_METHOD) {
    return readyMcpAppFrame(state, frame);
  }
  if (!isId(message.id)) return { state, actions: [] };
  // ⭐ 악수 — 이것이 없으면 위젯은 «영영 시작하지 못한다»(2026-08-21 실물).
  if (message.method === MCP_UI_INITIALIZE_METHOD) {
    return {
      state,
      actions: [{
        kind: 'respond',
        frameId: frame.frameId,
        message: { jsonrpc: '2.0', id: message.id, result: initializeResult() },
      }],
    };
  }
  if (message.method === 'ui/open-link' || message.method !== 'tools/call') {
    // ⛔⭐ 거부한 «이름»을 남긴다. 2026-08-21 실물: 위젯 안에 `-32601 Method not found` 가
    //   찍혔는데 우리 관측엔 «무엇을 요구했는지»가 없어서, 사람이 화면 글자로만 알았다.
    //   ⇒ 상대 위젯이 실제로 쓰는 말을 «값으로» 모아야 무엇을 더 구현할지 정할 수 있다.
    //   ⛔ 지금 아는 말은 둘뿐이다: notifications/initialized · tools/call.
    return {
      state,
      actions: [
        { kind: 'observe', reason: 'unknown-method', method: message.method },
        { kind: 'respond', frameId: frame.frameId, message: response(message.id, -32601, 'Method not found') },
      ],
    };
  }
  if (!isRecord(message.params) || typeof message.params.name !== 'string') {
    return { state, actions: [{ kind: 'respond', frameId: frame.frameId, message: response(message.id, -32602, 'Invalid params') }] };
  }
  const key = pendingKey(frame.frameId, frame.generation, message.id);
  if (state.pending[key]) {
    return { state, actions: [{ kind: 'respond', frameId: frame.frameId, message: response(message.id, -32600, 'Duplicate request id') }] };
  }
  const next = copy(state);
  next.pending[key] = { frameId: frame.frameId, id: message.id, generation: frame.generation };
  return {
    state: next,
    actions: [{
      kind: 'daemon-tool-call', frameId: frame.frameId, id: message.id, generation: frame.generation,
      server: frame.server, tool: message.params.name, arguments: message.params.arguments,
    }],
  };
}

/** Routes a host-owned result only to frames created by the same server and tool. */
export function publishMcpAppToolResult(state: McpAppBridgeState, published: McpAppToolResult): Decision {
  let next = state;
  const actions: McpAppBridgeAction[] = [];
  let matched = false;
  for (const frame of Object.values(state.frames)) {
    if (frame.server !== published.server || frame.tool !== published.tool) continue;
    // ⛔ When either side names the call, both must agree. A frame bound to a
    //   call never accepts another call's result, and a result bound to a call
    //   never reaches a frame bound to a different one.
    if (published.toolCallId !== undefined || frame.toolCallId !== undefined) {
      if (published.toolCallId !== frame.toolCallId) continue;
    }
    matched = true;
    const delivered = deliverPush(next, { ...published, frameId: frame.frameId, generation: frame.generation });
    next = delivered.state;
    actions.push(...delivered.actions);
  }
  // ⛔ A result can arrive before its screen is even registered — the tool
  //   finishes, then React mounts the iframe, then the frame loads. Dropping
  //   it here loses the *initial state* the protocol says the host must push,
  //   and the widget comes up blank with nothing to show it was ever sent.
  //   ⭐ Held only when the result names its call, so an unmatched broadcast
  //     cannot accumulate forever against screens that will never exist.
  if (!matched && published.toolCallId !== undefined) {
    const held = copy(next);
    held.unmatched = [...held.unmatched, published];
    next = held;
  }
  return { state: next, actions };
}

export function settleMcpAppCall(
  state: McpAppBridgeState,
  frameId: string,
  generation: number,
  id: JsonRpcId,
  outcome: { result: unknown } | { error: unknown },
): Decision {
  const key = pendingKey(frameId, generation, id);
  const frame = state.frames[frameId];
  const pending = state.pending[key];
  if (!pending || !frame || frame.generation !== generation) return { state, actions: [] };
  const next = copy(state);
  delete next.pending[key];
  const message = 'result' in outcome
    ? { jsonrpc: '2.0', id, result: outcome.result }
    : { jsonrpc: '2.0', id, error: { code: -32603, message: 'Daemon tool call failed', data: outcome.error } };
  return { state: next, actions: [{ kind: 'respond', frameId, message }] };
}

export interface BrowserMcpAppBridge {
  register(binding: McpAppFrameBinding): () => void;
  /** ⛔📏 2026-08-21 전수: `publishMcpAppToolResult` 는 «시험에서만» 불리고 있었다.
   *  브리지 표면에 이 문이 «없어서» 프로덕션 코드가 결과를 밀 방법이 아예 없었다.
   *  ⇒ 「기능이 없다」가 아니라 «있는데 그 경로가 안 쓴다» — 이 저장소가 이름 붙인 그 형태다. */
  publish(result: McpAppToolResult): void;
  disposeConversation(): void;
  close(): void;
}

export interface McpAppBridgeEventHost {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface McpAppToolCaller {
  callWidgetTool(input: { server: string; tool: string; arguments: unknown }): Promise<unknown>;
}

export function createBrowserMcpAppBridge(
  host: McpAppBridgeEventHost,
  daemon: McpAppToolCaller,
): BrowserMcpAppBridge {
  let state = createMcpAppBridgeState();
  /** ⛔⭐⭐ **「불렀다」는 「닿았다」가 «아니다»** — 이 값의 이름이 그것을 말해야 한다.
   *
   *  📏 무인 리뷰 must-fix(2026-08-22 · PR #11061): 1차판은 이 값을 `delivered` 라 불렀다.
   *  ⇒ 실제로 아는 것은 ***「대상에 `postMessage` 가 있었고 그것을 불렀다」***뿐이다.
   *    상대가 그것을 받았는지는 이 자리에서 «알 수 없다»(수신 확인 채널이 없다).
   *  ⛔ 「모른다」를 「됐다」로 적는 것 — 그것이 바로 이 PR 이 고치러 온 형태다. 내가 그것을 냈다.
   *
   *  ⊕ 그리고 `postMessage` 가 «던지면» 1차판은 로그까지 못 갔다 — 같은 조용한 실패의 재판이다. */
  const post = (frameId: string, message: Record<string, unknown>): 'posted' | 'no-target' | 'threw' => {
    const source = state.frames[frameId]?.source as { postMessage?: (value: unknown, targetOrigin: string) => void } | undefined;
    if (typeof source?.postMessage !== 'function') return 'no-target';
    try {
      source.postMessage(message, '*');
      return 'posted';
    } catch {
      // ⛔ 삼키지 않는다 — 부르는 쪽이 이 값을 «관측으로» 남긴다.
      return 'threw';
    }
  };
  const apply = (actions: McpAppBridgeAction[]) => {
    for (const action of actions) {
      if (action.kind === 'observe') {
        debugLog('mcp-app.bridge.discard', { reason: action.reason, ...(action.method ? { method: action.method } : {}) });
      }
      if (action.kind === 'notify') {
        // ⛔⭐⭐ 결과가 «실제로 위젯에 닿았나»를 여기서만 알 수 있다.
        //   📏 16차 실측: 이 줄이 없어서 「위젯이 왜 비었나」에 아무도 답하지 못했다 —
        //     본문을 버린 것도(`omitted`), 대상 창이 사라진 것도(`delivered:false`) 조용했다.
        //   ⭐ `bytes` 는 «원래 실으려던» 크기다. 상한(64KB)과 나란히 두어야 다음 수가 정해진다.
        // ⛔ `post` 는 «던지지 않는다» — 그래서 이 로그는 어느 갈래에서도 «반드시» 남는다.
        //   1차판은 예외가 나면 여기까지 못 왔다(리뷰 must-fix). 조용한 실패의 재판이었다.
        const posted = post(action.frameId, action.message);
        debugLog('mcp-app.bridge.push', {
          frameId: action.frameId,
          // ⛔ 이름이 아는 만큼만 말한다: 「불렀다 · 부를 곳이 없었다 · 부르다 던졌다」.
          //   ⚠️ `posted` 는 «도달»이 아니다 — 수신 확인 채널이 없다.
          post: posted,
          bytes: action.bytes,
          maxBytes: MCP_APP_PUSH_MAX_BYTES,
          ...(action.omitted ? { omitted: action.omitted } : {}),
        });
      }
      if (action.kind === 'respond') post(action.frameId, action.message);
      if (action.kind === 'daemon-tool-call') {
        void daemon.callWidgetTool({ server: action.server, tool: action.tool, arguments: action.arguments }).then(
          (result) => {
            const settled = settleMcpAppCall(state, action.frameId, action.generation, action.id, { result });
            state = settled.state;
            apply(settled.actions);
          },
          (error: unknown) => {
            const settled = settleMcpAppCall(state, action.frameId, action.generation, action.id, { error: String(error) });
            state = settled.state;
            apply(settled.actions);
          },
        );
      }
    }
  };
  const onMessage = (event: MessageEvent) => {
    const decided = decideMcpAppMessage(state, event.source, event.data);
    state = decided.state;
    apply(decided.actions);
  };
  host.addEventListener('message', onMessage);
  return {
    register(binding) {
      const registered = registerMcpAppFrame(state, binding);
      state = registered.state;
      apply(registered.actions);
      const generation = state.frames[binding.frameId]?.generation;
      return () => {
        if (generation === undefined) return;
        const disposed = disposeMcpAppFrame(state, binding.frameId, generation);
        state = disposed.state;
      };
    },
    publish(result) {
      const published = publishMcpAppToolResult(state, result);
      state = published.state;
      apply(published.actions);
    },
    disposeConversation() { state = disposeMcpAppConversation(state); },
    close() {
      host.removeEventListener('message', onMessage);
      state = disposeMcpAppConversation(state);
    },
  };
}
