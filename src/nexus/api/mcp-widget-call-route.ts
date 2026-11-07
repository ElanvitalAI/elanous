import { debug } from '../../debug/log.js';
import { mcpMediaJobs, type MediaJob } from '../../feedback/media.js';
import type { FeedbackEnvelope } from '../../feedback/envelope.js';
import { MCP_WIDGET_CALL_ROUTE } from '../../tool-runtime/mcp-route-path.js';
import { dispatchToolByName, getToolRuntime } from '../../tool-runtime/registry.js';
import { buildToolTraceMessage } from '../../session/chat.js';
import { saveRemoteMedia } from './media-store.js';
import { defaultSessionStore } from '../../session/session-store.js';
import type { SerializedMessage } from '../../session/index.js';
import type { ToolRunResult, ToolRuntimeContext } from '../../tool-runtime/types.js';

export const MCP_WIDGET_CALL_ROUTE_PATH = MCP_WIDGET_CALL_ROUTE;
export const MAX_MCP_WIDGET_CALL_BODY_BYTES = 64 * 1024;
/** ⛔⭐ **상한은 «실측»에서 온다 — 추측한 수를 박지 않는다.**
 *
 *  🩸 초판은 `3회 · 10초` 였다. 그런데 실기기 왕복(2026-09-10 21:34 KST)에서 폴링이
 *  ***`poll-gave-up {attempts:2, elapsedMs:10001}` 로 포기했고, 그 job 은 «실제로는 완료됐다»***
 *  (`job_status` → `status:"completed"`). ⇒ 그림이 화면에 영영 안 떴다.
 *
 *  📏 이 저장소가 «그날 아침에 이미» 잰 값: `gpt_image_2` 한 장 ≈ **60초**(RFC §7b ⓐ).
 *  ⇒ 상한이 실물의 «6분의 1» 이었다. ***값을 갖고 있으면서 안 쓴 것이 결함이다.***
 *
 *  ⭐ 그래서 여유를 «세 배»로 둔다 — 상대가 느린 날에도 한 장은 건진다.
 *  ⛔ 무한이 아니다: 배경 작업이 영원히 살면 데몬이 job 마다 하나씩 쌓는다.
 */
export const MCP_WIDGET_JOB_POLL_MAX_ELAPSED_MS = 180_000;
/** Production video playbook budget: 20 minutes. A batch with any video uses this
 * longer shared deadline so image jobs do not cause an in-progress video to be abandoned. */
export const MCP_WIDGET_VIDEO_JOB_POLL_MAX_ELAPSED_MS = 1_200_000;

export interface McpWidgetCallRouteOpts {
  authorize: (req: Request) => boolean;
  /** Resolves the widget's configured MCP server from trusted server-side context. */
  getTrustedServerId: (req: Request) => string | undefined;
  getFeedbackEmitter?: (sessionId: string) => ((env: FeedbackEnvelope) => void) | undefined;
  getRuntime?: (toolId: string) => unknown;
  dispatch?: (
    toolId: string,
    args: Record<string, unknown>,
    context: ToolRuntimeContext,
  ) => Promise<ToolRunResult>;
  /** ⭐ 시험 전용 — 시간 상한을 «주입»한다.
   *
   *  ⛔ 없으면 위 상수(실측 기반 180초)를 쓴다. 시험이 그 «실물 시간»을 실제로 기다리면
   *  한 파일이 수 분씩 걸리고, 상한을 실측에 맞춰 올릴 때마다 시험이 «같이» 느려진다.
   *  🩸 실제로 그렇게 됐다 — 상한을 10초→180초로 올리자 시험 넷이 그 값을 기다리다 깨졌다.
   *  ⇒ ***상한은 「실물의 값」이고 시험은 「그 규칙」을 잰다*** — 둘을 분리한다. */
  _pollLimitsForTest?: {
    maxElapsedMs?: number;
    now?: () => number;
    setTimeout?: (callback: () => void, ms: number) => unknown;
    clearTimeout?: (timer: unknown) => void;
  };
  /** 위젯 턴을 on-disk 세션 저장소에 남긴다(주입 가능 — 시험은 목으로 받는다).
   *
   *  ⛔⭐ 이 자리가 «없어서» 안드로이드에서 슬래시 명령으로 «시작한» 세션이
   *  저장소에 아예 안 생겼다(OBS-T521). 클라이언트가 슬래시를 만나면
   *  `/v1/prompt/stream` 을 «건너뛰고» 이 라우트로 곧장 오기 때문이다 —
   *  그 경로에는 저장소로 가는 다리가 하나도 없었다. 📏 실측: 실기기에서
   *  `/video` 로 연 세션 둘 다 `/v1/sessions/store/<id>` 가 404 였고 목록에도 없었다.
   *  ⇒ 앱을 다시 열면 방금 만든 영상이 통째로 사라진다. */
  persistTurn?: (
    sessionId: string,
    messages: readonly SerializedMessage[],
  ) => void;
}

/** 저장소에 남기는 「완성된 미디어」 한 줄의 도구 이름. 클라이언트가 이 이름으로 찾는다. */
export const MEDIA_RESULT_TOOL_NAME = 'media.result';

/** 폴링이 «끝난» 미디어 잡을 저장소 한 줄로 바꾼다.
 *
 *  ⛔⭐ 왜 «따로» 적나 — 위젯 호출 시점의 도구 흔적에는 잡이 `status:"pending"` 으로만 들어 있다
 *  (결과 주소는 그 «뒤» 폴링으로 온다). 📏 실측(2026-09-11): 그래서 앱을 다시 열면 말풍선은
 *  돌아오는데 ***그 아래 그림·영상은 안 돌아왔다***(OBS-T521 이 한계로 적어 둔 자리).
 *
 *  ⭐ 봉투 전체가 아니라 «앱이 그리는 데 필요한 것만» 적는다 — 상대 MCP 의 응답 모양이 바뀌어도
 *  이 계약은 안 흔들린다. ⛔ 결과 주소가 «없으면» 적지 않는다(그리지 못할 줄을 남기면 빈 칸이 뜬다).
 */
export function mediaResultMessage(
  job: MediaJob,
  nowIso: string,
  /** 로컬 보관본 주소(`/v1/media/<id>`). ⭐ «있으면» 적고 없으면 그 칸을 «만들지 않는다**.
   *  ⛔ 원격 주소는 «언제나» 적는다 — 보관본이 회수되거나 못 담겼을 때 돌아갈 자리다. */
  localUrl?: string,
): SerializedMessage | null {
  if (!job.resultUrl) return null;
  return {
    role: 'tool',
    content: `🖼 ${job.kind} ${job.jobId}`,
    ts: nowIso,
    toolName: MEDIA_RESULT_TOOL_NAME,
    toolResult: JSON.stringify({
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
      model: job.model,
      resultUrl: job.resultUrl,
      ...(localUrl ? { localUrl } : {}),
      ...(job.prompt ? { prompt: job.prompt } : {}),
    }),
  };
}

/** 위젯 호출 «한 턴»을 저장소에 남길 메시지로 바꾼다.
 *
 *  ⭐ 순수 함수로 떼어 둔 이유 — 라우트를 태우지 않고 「무엇을 적나」만 잴 수 있어야 한다.
 *  ⛔ 데몬이 UI 문구를 «지어내지 않는다**: 사용자 줄은 클라이언트가 준 `userText` 를 쓰고,
 *     없을 때만 도구 인자의 `prompt` 로 내려간다(그것도 없으면 사용자 줄을 아예 안 적는다 —
 *     ***빈 줄을 적느니 안 적는 게 낫다***). 결과 줄은 이 저장소의 기존 원시형
 *     `buildToolTraceMessage` 를 그대로 쓴다(재발명 0).
 */
export function widgetCallTranscriptMessages(
  toolName: string,
  args: Record<string, unknown>,
  userText: string | undefined,
  result: unknown,
): SerializedMessage[] {
  const messages: SerializedMessage[] = [];
  const typed = typeof userText === 'string' ? userText.trim() : '';
  const params = isObject(args) && isObject(args.params) ? args.params : undefined;
  const prompt = typeof params?.prompt === 'string' ? params.prompt.trim() : '';
  const userLine = typed || prompt;
  if (userLine) {
    messages.push({ role: 'user', content: userLine, ts: new Date().toISOString() });
  }
  messages.push(buildToolTraceMessage(toolName, args, result));
  return messages;
}

/** 운영 배선이 쓰는 저장소 write-through.
 *
 *  ⛔⭐ 이것을 라우트의 «기본값»으로 두지 «않는다** — 그러면 이 라우트를 태우는 모든 시험이
 *  사람의 진짜 `~/.elanous/sessions` 에 쓴다(이 파일의 시험만 12곳이다). ⇒ 운영 배선
 *  (`http-server.ts`)이 «명시»로 넘기고, 그 배선 자체를 시험이 잡는다.
 *  ⚠️ 그래서 「부품은 있고 스위치가 없다」가 되지 않도록 배선 시험이 «짝»으로 있어야 한다. */
export function persistWidgetTurnToSessionStore(
  sessionId: string,
  messages: readonly SerializedMessage[],
): void {
  for (const msg of messages) {
    // ⭐ `appendById` 는 «없으면 adopt» 한다 — 그래서 이 한 줄이 「세션을 만든다」까지 겸한다.
    defaultSessionStore.appendById(sessionId, msg, { source: 'pwa', origin: 'native' });
  }
}

function jsonResponse(body: unknown, status: number, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function readJsonBody(req: Request): Promise<unknown> {
  if (!req.body) throw new SyntaxError('missing body');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MCP_WIDGET_CALL_BODY_BYTES) throw new RangeError('body too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function isLocalToolName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 클라이언트가 준 «화면에 보이는 그대로»의 사용자 줄. 문자열이 아니면 없는 것으로 본다. */
function userTextOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function sessionIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined;
}

async function withTimeout<T>(operation: Promise<T>, ms: number, setTimer: (callback: () => void, ms: number) => unknown, clearTimer: (timer: unknown) => void): Promise<T> {
  let timer: unknown;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimer(() => reject(new Error('mcp-widget-job-poll-timed-out')), ms);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimer(timer);
  }
}

function scheduleAfterResponse(task: () => void): void {
  setTimeout(task, 0);
}

export function pollMaxElapsedMsFor(
  pendingJobs: Array<{ job: MediaJob; index: number }>,
  limits?: NonNullable<McpWidgetCallRouteOpts['_pollLimitsForTest']>,
): number {
  if (limits?.maxElapsedMs !== undefined) return limits.maxElapsedMs;
  return pendingJobs.some(({ job }) => job.kind === 'video')
    ? MCP_WIDGET_VIDEO_JOB_POLL_MAX_ELAPSED_MS
    : MCP_WIDGET_JOB_POLL_MAX_ELAPSED_MS;
}

/** ⛔⭐ **`Promise.race` 는 «기다림»만 끝낸다 — 실제 `dispatch` 는 계속 산다.**
 *
 *  🩸 무인 리뷰가 잡았다: 10초 뒤 `poll-gave-up` 을 남겨도 `jobs_wait` 는 살아 있고,
 *  그것이 «나중에» 끝나면 ***이미 포기한 폴링이 봉투를 낸다***. 소비자에게는 「포기했다」고
 *  기록해 놓고 화면은 갱신되는, 관측과 행동이 어긋난 상태다.
 *
 *  ⛔ `dispatch` 는 취소를 안 받는다(계약에 신호가 없다). 그래서 «호출»을 멈추는 대신
 *  ***emitter 를 해지한다*** — 늦게 끝난 호출이 무엇을 하든 그 봉투가 «나가지 않는다».
 *  ⇒ 자원(그 호출 자체)은 스스로 끝나고, 관측(`poll-gave-up`)과 행동이 «일치»한다. */
function revocableEmitter(
  inner: ((env: FeedbackEnvelope) => void) | undefined,
): { emit?: (env: FeedbackEnvelope) => void; revoke: () => void; revoked: () => boolean } {
  let live = true;
  return {
    ...(inner ? { emit: (env: FeedbackEnvelope) => { if (live) inner(env); } } : {}),
    revoke: () => { live = false; },
    revoked: () => !live,
  };
}

async function pollMcpMediaJobs(
  serverId: string,
  pendingJobs: Array<{ job: MediaJob; index: number }>,
  dispatch: NonNullable<McpWidgetCallRouteOpts['dispatch']>,
  context: ToolRuntimeContext,
  limits?: NonNullable<McpWidgetCallRouteOpts['_pollLimitsForTest']>,
  persistTurn?: McpWidgetCallRouteOpts['persistTurn'],
): Promise<void> {
  const maxElapsedMs = pollMaxElapsedMsFor(pendingJobs, limits);
  const now = limits?.now ?? Date.now;
  const setTimer = limits?.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = limits?.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  // ⭐ 폴링은 «자기 emitter» 로 돈다 — 상한에 닿으면 그것만 해지한다(원래 턴의 emitter 는 안 건드린다).
  let nextEnvelopeSeq = 0;
  const gate = revocableEmitter(context.emitFeedback);
  const emitPollingFeedback = (env: FeedbackEnvelope) => {
    nextEnvelopeSeq = Math.max(nextEnvelopeSeq, env.seq);
    gate.emit?.(env);
  };
  const pollContext: ToolRuntimeContext = {
    ...context,
    ...(gate.emit ? { emitFeedback: emitPollingFeedback } : {}),
  };
  const startedAt = now();
  let pending = pendingJobs;
  let attempts = 0;

  while (pending.length > 0) {
    const elapsedMs = now() - startedAt;
    const remainingMs = maxElapsedMs - elapsedMs;
    if (remainingMs <= 0) break;
    attempts += 1;
    try {
      const result = await withTimeout(
        dispatch(`${serverId}.jobs_wait`, {
          jobs: pending.map(({ index, job }) => ({ index, job_id: job.jobId })),
        }, pollContext),
        remainingMs, setTimer, clearTimer,
      );
      const nextJobs = new Map(mcpMediaJobs(result).map((job) => [job.jobId, job]));
      for (const { job } of pending) {
        const next = nextJobs.get(job.jobId);
        if (next && next.status !== 'pending') {
          debug.log('mcp.widget', 'poll-done', {
            jobId: job.jobId,
            status: next.status,
            attempts,
            elapsedMs: now() - startedAt,
          });
          // ⭐ 「끝났다」를 저장소에도 남긴다 — 이것이 없으면 앱을 다시 열었을 때
          //   말풍선만 돌아오고 그림·영상은 안 돌아온다.
          // ⛔ fail-soft 이되 «조용하지 않다** — 미러가 조용히 고장 나면 「사라졌다」를 조사할 수 없다.
          if (context.sessionId && persistTurn) {
            try {
              // ⭐ 한 벌을 «우리 쪽에» 담는다 — 상대 생성물은 30일 뒤 삭제된다(플레이북 실측).
              //   ⛔ 실패해도 «막지 않는다** — 보관은 보험이고, 원격 주소는 그대로 적힌다.
              const stored = next.resultUrl
                ? await saveRemoteMedia(next.resultUrl, next.kind)
                : null;
              const message = mediaResultMessage(
                next,
                new Date().toISOString(),
                stored ? `/v1/media/${stored.id}` : undefined,
              );
              if (message) persistTurn(context.sessionId, [message]);
            } catch (err) {
              debug.log('mcp.widget', 'media-result-persist-failed', {
                jobId: job.jobId,
                error: err instanceof Error ? err.message : String(err),
              }, { level: 'error' });
            }
          }
        }
      }
      pending = pending.filter(({ job }) => {
        const next = nextJobs.get(job.jobId);
        return !next || next.status === 'pending';
      });
    } catch {
      break;
    }
  }

  if (pending.length > 0) {
    const elapsedMs = now() - startedAt;
    try {
      for (const { job } of pending) {
        try {
          nextEnvelopeSeq += 1;
          gate.emit?.({
            envelopeVersion: 1,
            sessionId: context.sessionId!,
            blockId: `${context.sessionId}:media.job:${job.jobId}`,
            kind: 'media.job',
            phase: 'end',
            emittedAt: Date.now(),
            seq: nextEnvelopeSeq,
            payload: { jobId: job.jobId, mediaKind: job.kind, status: 'failed' },
            // ⛔ 원인을 «단정하지 않는다» — 이 자리에는 «두» 경로가 모인다:
            //    ⓐ 시간 상한을 다 썼다  ⓑ `jobs_wait` 가 «즉시 거부»해 루프가 break 했다.
            //    ⓑ 인데 「timed out」이라 말하면 1초 만에 죽고도 「시간이 다 됐다」고 «거짓말»한다.
            //    ⇒ 사유를 가르는 것은 별개 판이고, 그 전까지는 «참인 문장»만 말한다.
            asciiFallback: [`${job.jobId} failed: polling ended without a result`],
          });
        } catch (err) {
          debug.log('mcp.widget', 'poll-gave-up-notify-failed', { jobId: job.jobId, error: String(err) });
        }
        try {
          debug.log('mcp.widget', 'poll-gave-up', { jobId: job.jobId, attempts, elapsedMs, emitterRevoked: false });
        } catch (err) {
          debug.log('mcp.widget', 'poll-gave-up-observation-failed', { jobId: job.jobId, error: String(err) });
        }
      }
    } finally {
      gate.revoke();
    }
  }
}

/** POST /v1/mcp/widgets/call. The request never chooses the MCP server prefix. */
export async function handleMcpWidgetCall(
  req: Request,
  opts: McpWidgetCallRouteOpts,
): Promise<Response> {
  if (!opts.authorize(req)) return jsonResponse({ error: 'unauthorized' }, 401);

  const serverId = opts.getTrustedServerId(req);
  if (!serverId) return jsonResponse({ error: 'mcp-widget-server-unavailable' }, 503);

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof RangeError) return jsonResponse({ error: 'mcp-widget-request-too-large' }, 413);
    return jsonResponse({ error: 'invalid-mcp-widget-request' }, 400);
  }
  if (!isObject(body) || !isLocalToolName(body.toolName) || !isObject(body.args)) {
    return jsonResponse({ error: 'invalid-mcp-widget-request' }, 400);
  }

  const toolId = `${serverId}.${body.toolName}`;
  const getRuntime = opts.getRuntime ?? getToolRuntime;
  if (!getRuntime(toolId)) return jsonResponse({ error: 'mcp-widget-tool-not-found', tool: body.toolName }, 404);

  const sessionId = sessionIdOf(body.sessionId);
  let emitFeedback: ((env: FeedbackEnvelope) => void) | undefined;
  if (sessionId && opts.getFeedbackEmitter) {
    try {
      emitFeedback = opts.getFeedbackEmitter(sessionId);
    } catch {
      emitFeedback = undefined;
    }
  }
  if (sessionId && !emitFeedback) debug.log('mcp.widget', 'feedback-emitter-absent', { sessionId });
  const context: ToolRuntimeContext = sessionId && emitFeedback
    ? { surface: 'mcp', sessionId, emitFeedback }
    : { surface: 'mcp' };

  try {
    const dispatch = opts.dispatch ?? dispatchToolByName;
    const result = await dispatch(toolId, body.args, context);
    const classification = (result as { classification?: unknown }).classification;
    if (classification === 'mcp-authorization-denied') {
      return jsonResponse({ error: 'mcp-widget-authorization-denied', tool: body.toolName }, 403);
    }
    if (classification === 'mcp-transport-error') {
      return jsonResponse({ error: 'mcp-widget-unavailable', retryable: true }, 502, { 'retry-after': '1' });
    }
    if (classification === 'mcp-server-error') {
      return jsonResponse({ error: 'mcp-widget-unavailable', retryable: false }, 502);
    }
    const pendingJobs = mcpMediaJobs(result)
      .map((job, index) => ({ job, index }))
      .filter(({ job }) => job.status === 'pending');
    if (sessionId) {
      // ⛔ fail-soft 이되 «조용하지 않다» — 저장소 미러가 조용히 고장 나면
      //   「대화가 사라졌다」를 사고 조사할 수 없다(제1원칙). 그래서 error 로 남긴다.
      try {
        // ⛔ 주입이 «없으면 안 적는다** — 조용한 기본 대신 배선을 강제한다.
        opts.persistTurn?.(
          sessionId,
          widgetCallTranscriptMessages(body.toolName, body.args, userTextOf(body.userText), result),
        );
      } catch (err) {
        debug.log('mcp.widget', 'transcript-persist-failed', {
          sessionId,
          tool: body.toolName,
          error: err instanceof Error ? err.message : String(err),
        }, { level: 'error' });
      }
    }
    if (sessionId && emitFeedback && pendingJobs.length > 0) {
      for (const { job } of pendingJobs) debug.log('mcp.widget', 'poll-start', { jobId: job.jobId });
      scheduleAfterResponse(() => {
        void pollMcpMediaJobs(serverId, pendingJobs, dispatch, context, opts._pollLimitsForTest, opts.persistTurn);
      });
    }
    return jsonResponse(result, 200);
  } catch {
    return jsonResponse({ error: 'mcp-widget-execution-failed' }, 500);
  }
}
