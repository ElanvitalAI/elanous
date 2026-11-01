// ── MCP proxy ToolRuntime factory (B 트랙 Phase 2 · 2026-05-12) ──
//
// Wraps a remote McpTool (received from the external server's
// `tools/list`) into a ToolRuntime instance so the rest of elanous —
// `dispatchToolByName`, TUI, PWA `/chat`, webterm `:agent`, NEXUS
// HTTP `/v1/tools/*`, the local MCP server's `tools/list` — see and
// invoke it identically to any first-party tool.
//
// Per RFC §8 decisions:
//   • Q2 — proxy tool id = `<server-id>.<tool-name>` (e.g. `xcode.build_target`).
//   • Q3 — guardian/verifier 1차 비활성: we don't register the tool in
//     `nativeToolCatalog`, so dispatchToolByName's guardian/verifier
//     wrapping naturally skips. Future phases can opt-in per-server.
//
// Conversion contract (McpToolCallResult → ToolRunResult):
//   • If the server returns a `content` array, concatenate every
//     `{type:'text', text:...}` block → `output` (LLM-facing summary).
//   • `structuredContent` (if present) is preserved verbatim under
//     `structured` so callers that care about the raw JSON can read
//     it without parsing strings.
//   • Image-bearing content blocks (`{type:'image', data, mimeType}`)
//     are surfaced at the top level as `dataB64` + `mediaType` so the
//     existing image-content pipeline (memory `project_image_content_pipeline_complete`)
//     repackages the bytes for vision-capable providers. Only the
//     first image block is surfaced — multi-image results lose
//     ordering, which matches the existing single-image contract.
//   • `isError: true` from the server is surfaced as `ok: false`
//     so error responses are observable structurally (in addition to
//     the textual `output` from `content`).

import type {
  ToolRuntime,
  ToolRuntimeContext,
  ToolRunResult,
} from '../tool-runtime/types.js';
import { debug } from '../debug/log.js';
import {
  createCapabilityGrantStore,
  type CapabilityGrantStore,
} from '../conductor/capability-grant-store.js';
import {
  createSeqTracker,
  makeEnvelope,
  type FeedbackEnvelope,
} from '../feedback/envelope.js';
import { mcpMediaJobs, mcpResultImages } from '../feedback/media.js';
import { getHarnessRunId } from '../harness/harness-space.js';
import { McpServerError } from './client.js';
import type { McpClient, McpTool, McpToolCallResult } from './client.js';

export interface McpToolGrant {
  readonly serverId: string;
  readonly toolName: string;
  readonly expiresAt?: string;
}

/** ⛔⭐ **여기 있는 것은 «운영 소비자가 있는 것»뿐이다.**
 *
 *  ⓐ `grant`      ← `registerMcpClients` 가 config 의 `authorizedTools` 로 부른다
 *  ⓑ `isGranted`  ← 프록시 런타임이 `client.callTool` «앞»에서 부른다
 *  ⓒ `revokeServer` ← 부팅 실패 catch ⊕ `shutdown()` 이 부른다
 *
 *  ⛔ 초판에는 `revoke(serverId, toolName)`(툴 «하나»만 폐기)도 있었는데
 *  ***테스트 밖 호출자가 «하나도» 없었다*** — 리뷰가 4라운드 연속 그것을 지적했고
 *  그것이 이 골이 `UNCONVERGEABLE` 로 죽은 직접 원인이다.
 *  ⇒ **없는 소비자를 위해 표면을 넓히지 않는다.** 툴 단위 폐기가 필요해지는 것은
 *  「런타임에 grant 를 주고받는 길」(CLI ⊕ 데몬 라우트)이 생길 때이고, 그때 «소비자와 함께» 되돌아온다.
 *  📌 지금 grant 는 **부팅이 소유**한다 — config 로 들어오고 handle 과 함께 죽는다. */
export interface McpToolAuthorizer {
  grant(grant: McpToolGrant): void;
  isGranted(serverId: string, toolName: string): boolean;
  revokeServer(serverId: string): number;
}

export interface McpToolAuthorizerOpts {
  now?: () => Date;
  store?: CapabilityGrantStore;
}

const MCP_GRANT_ACTION = 'inspect';

export function createMcpToolAuthorizer(
  opts: McpToolAuthorizerOpts = {},
): McpToolAuthorizer {
  const store = opts.store ?? createCapabilityGrantStore({ now: opts.now });
  const denialsByServer = new Map<string, { count: number; toolNames: Set<string> }>();
  const grantFor = (serverId: string, toolName: string): McpToolGrant => ({ serverId, toolName });
  const log = (event: string, grant: McpToolGrant) => {
    debug.log('mcp.authorization', event, {
      serverId: grant.serverId,
      toolName: grant.toolName,
      expiresAt: grant.expiresAt,
    });
  };

  return {
    grant(grant) {
      if (grant.expiresAt !== undefined && !Number.isFinite(new Date(grant.expiresAt).getTime())) {
        throw new Error(`invalid MCP grant expiry: ${grant.expiresAt}`);
      }
      store.grant({
        persona: grant.serverId,
        action: MCP_GRANT_ACTION,
        shellId: grant.toolName,
        grantedAt: (opts.now ? opts.now() : new Date()).toISOString(),
        ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
      });
      log('grant', grant);
    },
    isGranted(serverId, toolName) {
      const granted = store.isGranted(serverId, MCP_GRANT_ACTION, toolName);
      if (!granted) {
        const denials = denialsByServer.get(serverId) ?? { count: 0, toolNames: new Set<string>() };
        denials.count += 1;
        denials.toolNames.add(toolName);
        denialsByServer.set(serverId, denials);
        debug.log('mcp.authorization', 'denied', {
          serverId,
          toolName,
          deniedCount: denials.count,
          deniedToolCount: denials.toolNames.size,
        });
      }
      return granted;
    },
    revokeServer(serverId) {
      const grants = store.list({ persona: serverId, action: MCP_GRANT_ACTION });
      const removed = store.revoke({ persona: serverId, action: MCP_GRANT_ACTION });
      for (const grant of grants) log('revoke-server', grantFor(serverId, grant.shellId ?? ''));
      return removed;
    },
  };
}

export type McpProxyResult = Record<string, unknown> & {
  classification?: 'mcp-authorization-denied' | 'mcp-transport-error' | 'mcp-server-error';
};

export interface McpProxyRuntimeOpts {
  /** Stable server id — becomes the `<server-id>.` prefix on tool ids. */
  serverId: string;
  /** Remote tool spec from the server's `tools/list` response. */
  mcpTool: McpTool;
  /** The client that owns the child process. The runtime forwards
   *  `tools/call` through this instance. */
  client: Pick<McpClient, 'callTool'>;
  /** Shared authorization ledger. Every outbound MCP proxy is fail-closed. */
  authorizer: Pick<McpToolAuthorizer, 'isGranted'>;
  /** ⛔ **Test seam only** — 이 저장소 관례(`_clientForTesting` · `_threadIndexForTesting`)를 따라
   *  이름에 `ForTest` 를 박았다. ***사용자 손잡이가 아니다.***
   *  프로덕션 호출자는 없다(`registerMcpClients` 는 안 넘긴다) — 상한이 실제로 «무는지»를
   *  관측으로 먼저 재고, 그 값 위에서 설정 노출 여부를 정한다. */
  _outputLimitForTest?: Partial<McpOutputLimit>;
}

/** ⛔⭐ **남의 서버가 얼마를 뱉을지 우리가 모른다.**
 *
 *  로컬 stdio 서버만 붙일 땐 견딜 만했다 — 우리가 고른 바이너리였으니까.
 *  원격을 붙이는 순간 «남이 운영하는» 서버의 응답이 그대로 LLM 맥락으로 들어간다.
 *  ⇒ 상한이 없으면 한 번의 툴 호출이 맥락을 통째로 태울 수 있다.
 *
 *  ⚠️ 수치는 토큰 «추정»이다 — 여기서 진짜 토크나이저를 돌리지 않는다(프로바이더마다 다르고
 *  이 층은 프로바이더를 모른다). 문자수/4 를 쓴다. ⛔ 그래서 이 값을 «정확한 토큰»이라 읽지 마라. */
export interface McpOutputLimit {
  /** 이 추정치를 넘으면 «한 번» 경고한다(툴마다 한 번). */
  warnTokens: number;
  /** 이 추정치를 넘으면 «자른다». */
  maxTokens: number;
}

/** 기본값은 Claude Code 가 공개한 것과 같은 눈금(10k 경고 / 25k 상한)을 쓴다 —
 *  ⭐ 남이 이미 운영으로 검증한 수를 근거 없이 바꾸지 않는다. */
//  ⛔ `Object.freeze` — export 된 «가변» 객체는 아무 import 나 프로덕션 상한을 «전역으로»
//     바꿀 수 있다. 상한의 값이 「아무도 못 낮춘다」인데 그 자체가 낮춰지면 안 된다.
export const DEFAULT_MCP_OUTPUT_LIMIT: Readonly<McpOutputLimit> = Object.freeze({
  warnTokens: 10_000,
  maxTokens: 25_000,
});

/** ⛔⭐ **상한 값 자체를 믿지 않는다.** `NaN` 이 오면 `length > NaN*4` 가 «항상 거짓»이라
 *  ***절단이 통째로 안 걸린다***(= 상한 우회). 음수면 `slice(0, 음수)` 가 뒤에서 세어 다르게 자른다.
 *  ⇒ 유한한 «음이 아닌 정수»로 못 박고, `warnTokens` 가 `maxTokens` 를 못 넘게 한다.
 *  📌 시험 이음매로 들어오는 값도 여기를 지난다 — 이음매가 상한을 무력화하면 안 된다. */
export function normalizeMcpOutputLimit(raw: Partial<McpOutputLimit> | undefined): McpOutputLimit {
  const pick = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
  const maxTokens = pick(raw?.maxTokens, DEFAULT_MCP_OUTPUT_LIMIT.maxTokens);
  const warnTokens = Math.min(pick(raw?.warnTokens, DEFAULT_MCP_OUTPUT_LIMIT.warnTokens), maxTokens);
  return { warnTokens, maxTokens };
}

/** 문자수 → 토큰 «추정». ⛔ 정확하지 않다(§McpOutputLimit 주석). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Build a ToolRuntime that proxies into the given McpClient.
 *
 *  The id `<server-id>.<tool-name>` makes proxied tools visually
 *  distinct from native tools in tool autocomplete and log lines.
 *  Tool name validation (legal LLM tool_use name) is the server's
 *  responsibility — most providers accept dots in tool names, and
 *  elanous's downstream LLM dispatch (`src/llm.ts`) doesn't reject
 *  them either. */
export function createMcpProxyRuntime(
  opts: McpProxyRuntimeOpts,
): ToolRuntime<Record<string, unknown>, McpProxyResult> {
  const id = `${opts.serverId}.${opts.mcpTool.name}`;
  const limit = normalizeMcpOutputLimit(opts._outputLimitForTest);
  /** 툴 정의가 「이 결과는 이 화면으로 보라」를 선언하면 결과에 실어 보낸다.
   *
   *  ⛔⭐⭐ **열쇠가 «둘»이고 둘은 다른 생태계다 — 섞으면 영영 안 걸린다.**
   *    `_meta.ui.resourceUri`      MCP Apps 확장(SEP-1865 · Final) — 규범
   *    `openai/outputTemplate`     OpenAI Apps SDK 관례 — 다른 생태계
   *  📏 2026-08-20 실측(mcp.higgsfield.ai · 툴 73개):
   *    `_meta.ui.resourceUri` = **40개** · `openai/outputTemplate` = **0개**
   *  ⇒ 초판이 후자만 봐서 ***우리가 붙은 서버에서는 한 번도 안 걸렸다***.
   *  🩹 규범 열쇠를 «먼저» 보고, 없으면 다른 생태계 열쇠를 폴백으로 본다.
   *  ⚠️ 상대는 `ui/resourceUri`(납작한 키)도 «같이» 보낸다 — 그것도 받는다. */
  /** ⛔⭐ **「선언 안 함」과 「빈 값으로 선언」은 다른 값이다.**
   *  그래서 «길이»가 아니라 «칸이 있고 문자열인가»로 고른다 — 빈 문자열도 그대로 싣는다.
   *  (초판이 그 구분을 지켰고, 이 개정은 «열쇠»만 고친다.) */
  const widgetResourceUri = (): string | undefined => {
    const meta = opts.mcpTool._meta;
    if (meta === undefined) return undefined;
    const nested = (meta as { ui?: { resourceUri?: unknown } }).ui?.resourceUri;
    if (typeof nested === 'string') return nested;
    const flat = meta['ui/resourceUri'];
    if (typeof flat === 'string') return flat;
    const openai = meta['openai/outputTemplate'];
    if (typeof openai === 'string') return openai;
    return undefined;
  };
  const withOutputTemplate = (result: McpProxyResult): McpProxyResult => {
    const uri = widgetResourceUri();
    return uri === undefined
      ? result
      : { ...result, _meta: { ui: { resourceUri: uri } } };
  };
  let warned = false;   // 경고 예산은 런타임(= 서버·툴 한 쌍)마다 하나
  const warnOnce = (): void => {
    if (warned) return;   // ⛔ 같은 툴이 매 호출마다 짖으면 아무도 안 읽는다
    warned = true;
    debug.log('mcp.output', 'over-warn-threshold', { serverId: opts.serverId, toolName: opts.mcpTool.name });
  };
  const truncateObserver = (info: { originalTokens: number; keptTokens: number; structuredDropped: boolean }): void => {
    debug.log('mcp.output', 'truncated', { serverId: opts.serverId, toolName: opts.mcpTool.name, ...info });
  };
  // ⛔ 절단과 «다른 사건»이라 이벤트를 나눈다 — 섞으면 「몇 번 잘렸나」가 오염된다.
  const droppedObserver = (info: { reason: string }): void => {
    debug.log('mcp.output', 'structured-dropped', { serverId: opts.serverId, toolName: opts.mcpTool.name, ...info });
  };
  const description = opts.mcpTool.description ?? `MCP tool ${id}`;
  const parameters =
    isJsonSchemaObject(opts.mcpTool.inputSchema)
      ? (opts.mcpTool.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {} };
  return {
    id,
    spec: {
      name: id,
      description,
      parameters,
    },
    // RFC #2474 Phase 3 — declare 'mcp' so the local MCP server's
    // `tools/list` relay (src/mcp/server.ts) picks the proxy up, and
    // 'tui', the tool runtime's conversation surface, so catalog-less
    // proxy tools participate in `listToolRuntimes('tui')` discovery.
    surfaces: ['mcp', 'tui'],
    async run(
      req: Record<string, unknown>,
      ctx: ToolRuntimeContext,
    ): Promise<McpProxyResult> {
      if (!opts.authorizer.isGranted(opts.serverId, opts.mcpTool.name)) {
        return {
          ok: false,
          classification: 'mcp-authorization-denied',
          output: `mcp authorization denied: ${id}`,
        };
      }
      try {
        const runId = (ctx.runId || getHarnessRunId()).trim();
        // The correlation id is needed only for Aside's delegated return path.
        // Do not disclose the local run identity to other MCP servers.
        const meta = opts.serverId === 'aside' && runId ? { elanousRunId: runId } : undefined;
        const result = await opts.client.callTool(opts.mcpTool.name, req, meta);
        const converted = mcpResultToRunResult(result);
        emitMcpMediaFeedback(converted, ctx);
        const capped = capMcpOutput(converted, {
          limit, onWarn: warnOnce, onTruncate: truncateObserver, onStructuredDropped: droppedObserver,
        });
        const withTemplate = withOutputTemplate(capped);
        return result.isError === true
          ? { ...withTemplate, classification: 'mcp-server-error' }
          : withTemplate;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // ⛔⭐ 「서버가 안 된다고 했다」와 「서버에 못 닿았다」를 «타입»으로 가른다.
        //    `client.ts` 는 JSON-RPC error 봉투도 «던져서» 알리므로, 던진 것만
        //    보고 전부 전송 오류로 뭉개면 서버 오류가 전송 오류로 «오분류»된다.
        //    ⛔ 문면(`MCP error <code>:`)으로 갈랐다면 서버가 문구를 바꾸는 날 조용히 깨진다.
        // ⛔⭐ **오류 문면도 «남의 서버가 뱉은 것»이다.** `McpServerError.message` 는
        //    상대가 준 JSON-RPC error 의 message 를 그대로 나른다 — 그것이 무제한이면
        //    성공 응답을 막아 놓고 «실패 응답으로» 맥락이 타는다(리뷰 must-fix).
        //    ⇒ 성공·실패가 «같은» 상한을 지난다.
        return withOutputTemplate(capMcpOutput({
          ok: false,
          classification:
            err instanceof McpServerError ? 'mcp-server-error' : 'mcp-transport-error',
          output: `mcp-proxy error: ${msg}`,
        }, { limit, onWarn: warnOnce, onTruncate: truncateObserver, onStructuredDropped: droppedObserver }));
      }
    },
  };
}

/** 응답을 상한 안으로 «자른다».
 *
 *  ⛔⭐ **`structured` 를 「자르지」 않고 «뺀다».** 잘린 JSON 은 없는 것보다 나쁘다 —
 *  소비자가 파싱하다 죽거나, 더 나쁘게는 «부분 데이터를 온전한 것으로» 읽는다.
 *  ⇒ 뺐다는 사실을 `structuredDropped` 로 남겨 「없다」와 「빼앗겼다」를 가른다.
 *
 *  ⛔ 자르는 것은 «머리를 남기고» 꼬리를 버린다 — 툴 응답은 앞쪽이 대개 더 정보량이 많다.
 *  ⊕ 잘렸다는 사실을 «구조»로도 남긴다(`truncated`) — 문면으로만 남기면 소비자가 못 센다. */
export function capMcpOutput(
  result: ToolRunResult,
  deps: {
    limit: McpOutputLimit;
    onWarn?: () => void;
    /** ⭐ 「텍스트가 잘렸다」 축. `mcp.output/truncated` 로 간다. */
    onTruncate?: (info: { originalTokens: number; keptTokens: number; structuredDropped: boolean }) => void;
    /** ⭐ 「structured 를 뺐다」 축 — ⛔ 절단과 «다른 사건»이다. 섞으면 대시보드가 오독한다. */
    onStructuredDropped?: (info: { reason: 'unmeasurable' | 'over-limit' }) => void;
  },
): McpProxyResult {
  const limit = normalizeMcpOutputLimit(deps.limit);   // ⛔ 직접 호출자도 상한을 무력화 못 한다
  const out = { ...(result as Record<string, unknown>) } as McpProxyResult;
  const text = typeof out.output === 'string' ? out.output : '';
  let structuredTokens = 0;
  let structuredDropped = false;
  let structuredUnmeasurable = false;

  // ⛔⭐⭐ **잴 수 없는 것을 «0」으로 세지 않는다.**
  //    순환 참조 · 던지는 `toJSON` · 함수처럼 직렬화가 안 되는 값을 빈 문자열로 치면
  //    ***0토큰으로 계산돼 상한을 그대로 통과한다*** — 상한을 둔 이유가 「모르는 크기」인데
  //    «모른다»를 «작다»로 읽는 fail-open 이다. ⇒ 못 재면 «뺀다».
  if (out.structured !== undefined) {
    const json = safeJson(out.structured);
    if (json === null) {
      delete out.structured;
      structuredDropped = true;
      structuredUnmeasurable = true;
      deps.onStructuredDropped?.({ reason: 'unmeasurable' });
    } else {
      structuredTokens = estimateTokens(json);
    }
  }

  // ⛔⭐ **여기서 «빠져나가지» 않는다.** 초판은 못 잰 경우 즉시 반환했는데, 그러면
  //    ***거대한 텍스트가 상한을 통째로 건너뛰었다***(리뷰 3R). structured 를 뺀 «뒤»에도
  //    텍스트는 같은 상한 경로를 지나야 한다.
  const originalTokens = estimateTokens(text) + structuredTokens;
  if (originalTokens > limit.warnTokens) deps.onWarn?.();

  if (originalTokens > limit.maxTokens) {
    if (out.structured !== undefined) {
      delete out.structured;
      structuredDropped = true;
      deps.onStructuredDropped?.({ reason: 'over-limit' });
    }
    const maxChars = limit.maxTokens * 4;
    // ⛔⭐ **텍스트가 «실제로» 잘렸을 때만 절단 사건이다.** measurable structured 만 빼고
    //    텍스트는 손 안 댄 경우까지 `truncated` 이벤트를 내면 「몇 번 잘렸나」가 오염된다 —
    //    그 둘을 다른 사건으로 관측하겠다는 것이 이 착지의 계약이다(리뷰 4R).
    const textCut = text.length > maxChars;
    if (textCut) out.output = text.slice(0, maxChars);
    out.originalTokensEstimated = originalTokens;
    if (textCut) {
      deps.onTruncate?.({
        originalTokens,
        keptTokens: estimateTokens(typeof out.output === 'string' ? out.output : ''),
        structuredDropped,
      });
    }
  }

  // `truncated` = ***「응답이 줄었다」*** — 텍스트 절단이든 structured 제거든.
  // 소비자가 한 칸만 봐도 「받은 것이 전부가 아니다」를 알 수 있어야 한다.
  if (structuredDropped || out.originalTokensEstimated !== undefined) out.truncated = true;
  if (structuredDropped) out.structuredDropped = true;
  if (structuredUnmeasurable) out.structuredUnmeasurable = true;
  return out;
}

/** ⛔ 실패를 «빈 문자열»로 돌려주지 않는다 — 호출자가 「작다」로 읽는다.
 *  못 쟀으면 `null` 로 «못 쟀다»를 말한다. `undefined` 직렬화 결과(`undefined`)도 같다. */
function safeJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : null;
  } catch { return null; }
}

// ─── Conversion helpers ──────────────────────────────────────────

/** Convert `McpToolCallResult` to the shape elanous's ToolRunResult
 *  contract expects. Image-bearing convention (Phase 1 · 2026-05-05
 *  image-content-pipeline) matched: emit `mediaType` + `dataB64`
 *  at top level when an image content block is present, so the LLM
 *  dispatch wrapper repackages it as a vision tool_result. */
export function mcpResultToRunResult(result: McpToolCallResult): ToolRunResult {
  const content = Array.isArray(result.content) ? result.content : [];
  const texts: string[] = [];
  let image:
    | { mediaType: string; dataB64: string }
    | undefined;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      continue;
    }
    if (block.type === 'image' && image === undefined) {
      const data = typeof block.data === 'string' ? block.data : undefined;
      const rawMime =
        typeof block.mimeType === 'string'
          ? block.mimeType
          : typeof block.media_type === 'string'
          ? (block.media_type as string)
          : undefined;
      if (data && rawMime) {
        image = { mediaType: rawMime, dataB64: data };
      }
    }
  }
  const output = texts.length > 0 ? texts.join('\n') : '';
  const base: Record<string, unknown> = { output };
  if (image) {
    base.mediaType = image.mediaType;
    base.dataB64 = image.dataB64;
  }
  if (result.structuredContent !== undefined) {
    base.structured = result.structuredContent;
  }
  if (result.isError === true) {
    base.ok = false;
  }
  return base as ToolRunResult;
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Submit → wait → status share one job `blockId`; seq must survive across
 *  `run()` calls and across distinct proxy runtimes (generate_* vs jobs_wait). */
const mcpMediaSeqTracker = createSeqTracker();

/** ⛔⭐ **terminal 에서 seq 를 «잊지 않는다».**
 *
 *  🩸 초판은 `phase === 'end'` 에 `forget` 했다. 그런데 같은 job 의 후속 `jobs_wait`·`job_status`
 *  가 ***같은 blockId 를 다시 쓰므로*** seq 가 1 부터 다시 시작했다 — 소비자가 seq 로 순서를
 *  정하면 시간이 «거꾸로» 간다(무인 리뷰가 두 라운드에 걸쳐 잡았다).
 *  ⇒ 위 주석이 요구한 *"seq must survive across `run()` calls"* 를 실제로 지킨다.
 *
 *  ⛔ 대신 이 트래커는 **모듈 수명**이라 안 잊으면 «영원히 자란다». 그래서 상한을 둔다 —
 *  가장 오래 안 쓴 블록부터 버린다(Map 이 삽입 순서를 지킨다). 상한을 넘어 버려진 블록이
 *  다시 오면 seq 가 1 로 돌아가지만, 그것은 「같은 대화가 512 블록 뒤에 되살아난 경우」라
 *  실제 왕복(제출→대기→상태, 3회 안팎)에서는 닿지 않는다. */
const MCP_MEDIA_SEQ_BLOCK_CAP = 512;
const mcpMediaSeqBlocks = new Map<string, true>();

function rememberMediaBlock(blockId: string): void {
  // 재방문을 «최신»으로 올린다 — 삭제 후 재삽입이 Map 의 순서를 갱신하는 관용구다.
  mcpMediaSeqBlocks.delete(blockId);
  mcpMediaSeqBlocks.set(blockId, true);
  while (mcpMediaSeqBlocks.size > MCP_MEDIA_SEQ_BLOCK_CAP) {
    const oldest = mcpMediaSeqBlocks.keys().next();
    if (oldest.done) break;
    mcpMediaSeqBlocks.delete(oldest.value);
    mcpMediaSeqTracker.forget(oldest.value);
  }
}

/** 시험 전용 — 모듈 수명 상태가 시험 사이에 새지 않게 한다. */
export function _resetMcpMediaSeqStateForTest(): void {
  mcpMediaSeqBlocks.clear();
  mcpMediaSeqTracker.clear();
}

function emitMcpMediaFeedback(
  converted: ToolRunResult,
  ctx: ToolRuntimeContext,
): void {
  if (!ctx.emitFeedback || !ctx.sessionId) return;
  const parent = ctx.toolCallId ? { parentToolCallId: ctx.toolCallId } : {};
  const emit = (env: FeedbackEnvelope): void => {
    try {
      ctx.emitFeedback!(env);
    } catch {
      /* wire glue swallows — media emit must not break the LLM turn */
    }
  };
  const emitAndMaybeForget = (env: FeedbackEnvelope): void => {
    emit(env);
    rememberMediaBlock(env.blockId);
  };
  for (const image of mcpResultImages(converted)) {
    emitAndMaybeForget(makeEnvelope({
      kind: 'media.image',
      sessionId: ctx.sessionId,
      blockId: `${ctx.sessionId}:media.image:${image.src}`,
      phase: 'end',
      payload: image,
      asciiFallback: [image.src],
      ...parent,
    }, mcpMediaSeqTracker));
  }
  for (const job of mcpMediaJobs(converted)) {
    const line = job.resultUrl
      ? `${job.jobId} ${job.status} ${job.resultUrl}`
      : `${job.jobId} ${job.status}`;
    const ended = job.status !== 'pending';
    emitAndMaybeForget(makeEnvelope({
      kind: 'media.job',
      sessionId: ctx.sessionId,
      blockId: `${ctx.sessionId}:media.job:${job.jobId}`,
      phase: ended ? 'end' : 'update',
      payload: {
        jobId: job.jobId,
        mediaKind: job.kind,
        status: job.status,
        ...(job.resultUrl ? { resultUrl: job.resultUrl } : {}),
        ...(job.model ? { model: job.model } : {}),
        ...(job.prompt ? { prompt: job.prompt } : {}),
      },
      asciiFallback: [line],
      ...parent,
    }, mcpMediaSeqTracker));
    if (job.kind === 'video' && job.resultUrl) {
      emitAndMaybeForget(makeEnvelope({
        kind: 'media.video',
        sessionId: ctx.sessionId,
        blockId: `${ctx.sessionId}:media.video:${job.resultUrl}`,
        phase: 'end',
        payload: { src: job.resultUrl },
        asciiFallback: [job.resultUrl],
        ...parent,
      }, mcpMediaSeqTracker));
    }
  }
}
