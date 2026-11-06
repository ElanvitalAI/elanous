// CV-3 P5.x — Agent CLI REST endpoints (real codex/claude/gemini sub-process spawn).
//
// Exposes globalAcpAgentManager()-backed agent CLI sessions to PWA
// surfaces (Showroom agent panel) over a small REST + SSE surface.
// Internal flow:
//
//   POST /v1/agent-cli/sessions
//     → globalDualRoleManager().clientSessionCreate({ backendId, cwd })
//     → returns { sessionId, backendId, cwd, createdAt }
//
//   POST /v1/agent-cli/prompt   (SSE)
//     body: { sessionId, message }
//     emits per chunk: `event: chunk\ndata: <text>\n\n`
//             stop:    `event: stop\ndata: {"stopReason": "..."}\n\n`
//             error:   `event: error\ndata: {"error": "..."}\n\n`
//
//   POST /v1/agent-cli/cancel
//     body: { sessionId }
//     → globalDualRoleManager().clientSessionCancel
//
//   DELETE /v1/agent-cli/sessions/:sid
//     → clientSessionClose
//
// Auth: same checkAuth() gate as `/v1/tools` / `/v1/terminals`.
// cwd default: monad-agent repo root (process.cwd()) — matches user's
// vision Q1 (agent CLI works inside monad-agent codebase by default).

import { jsonResponse } from './json-response.js';
import { checkAuth, type MetaApiOpts } from './meta-api.js';
import { globalDualRoleManager } from '../../acp/dual-role-manager.js';
// 2026-05-15 — HITL adapter import 제거. agent-cli wire 의 default approver
// 를 yolo (자동 grant) 으로 전환 — 추후 본격 권한 모드 wire 시 다시 import.
// 기존 path: createAcpPermissionApproverFromHitl · createAcpQuestionApproverFromHitl
import type {
  AcpPermissionApprover,
  AcpQuestionApprover,
} from '../../acp/client.js';
import { type SessionUpdate } from '@agentclientprotocol/sdk';
import {
  buildCrossBackendHistoryPrefix,
  buildSessionHistoryPrefix,
  globalAgentCliConversationStore,
} from './agent-cli-conversation-store.js';
import { loadSession } from '../../session/index.js';
import { defaultSessionStore } from '../../session/session-store.js';
import { deriveOriginFromInputSourceKind } from '../../boot/daemon-session-origin-derive.js';
import type { InputSourceKind } from '../../input/input-source-kind.js';

/** P5.x supported backends — validated server-side so a malformed
 *  body can't smuggle in a random brand. Mirrors `ACP_BACKENDS` keys
 *  in `src/acp/backend-registry.ts`. When adding a new backend (ex.
 *  PR #2832 added 'grok'), update **both** here AND AcpBackendIdLike
 *  in `src/nexus/chat/backend-mapping.ts` — they're independent lists
 *  by design (this one is the runtime allowlist, that one is the type
 *  literal). */
const SUPPORTED_BACKENDS = new Set(['codex-app-server', 'claude', 'gemini', 'grok']);

/** W8-A multimodal marker — user turn 의 text 끝에 붙어 "이미지 첨부됐었음"
 *  을 cross-backend prefix 으로 carry. raw base64 안 들어감. 같은 marker 가
 *  이미 text 에 있으면 dedupe — caller 가 의도적 type 했을 가능성 보존. */
const IMAGE_ATTACHED_MARKER = '[image attached]';

/** Annotate user-supplied text with IMAGE_ATTACHED_MARKER when the turn
 *  carried image block(s). Pure-image turn (no text) returns the marker
 *  alone — caller (`handleAgentCliPromptStream`) decides to still append
 *  to aggregator so cross-backend swap doesn't lose the turn. */
function annotateWithImageMarker(userText: string, hadImage: boolean): string {
  if (!hadImage) return userText;
  if (userText.includes(IMAGE_ATTACHED_MARKER)) return userText;
  return userText.length > 0
    ? `${userText} ${IMAGE_ATTACHED_MARKER}`
    : IMAGE_ATTACHED_MARKER;
}

/** 2026-05-16 capability gate helper — userContent 의 image/audio/video
 *  block 들을 peer.promptCapabilities 와 대조. 미지원 type 발견 시 HTTP
 *  400 Response 반환 (caller 가 return). 모두 지원 시 null (gate 통과).
 *
 *  Session 없으면 (clientSessionById 가 undefined 반환) gate skip — 다음
 *  로직의 clientSessionSend 가 UnknownSessionError 던지도록 위임 (별 path
 *  에러 처리 일관성).
 *
 *  Peer capabilities 가 아직 nil 이면 (initialize 미완) gate skip — 보수적
 *  으로 forward 시도 후 peer 가 처리. */
function checkBlockCapabilities(
  sessionId: string,
  blocks: readonly unknown[],
): Response | null {
  const manager = globalDualRoleManager();
  const record = manager.clientSessionById(sessionId);
  if (!record) return null; // 다음 logic 의 UnknownSessionError 위임
  const caps = record.agent.getCapabilities();
  if (!caps) return null;   // initialize 미완 · 보수 skip

  const unsupported = new Set<string>();
  for (const b of blocks) {
    const type = (b as { type?: unknown } | null)?.type;
    if (typeof type !== 'string') continue;
    if (type === 'image' && !caps.prompt.image) unsupported.add('image');
    else if (type === 'audio' && !caps.prompt.audio) unsupported.add('audio');
    else if (type === 'video' && !caps.prompt.video) unsupported.add('video');
  }
  if (unsupported.size === 0) return null;

  return jsonResponse({
    error: 'unsupported-content-block',
    backend: record.backendId,
    backendSessionId: record.backendSessionId,
    unsupported: Array.from(unsupported).sort(),
    promptCapabilities: {
      text: caps.prompt.text,
      image: caps.prompt.image,
      audio: caps.prompt.audio,
      video: caps.prompt.video,
      resourceLink: caps.prompt.resourceLink,
      embeddedContext: caps.prompt.embeddedContext,
    },
  }, 400);
}

/** Phase α — HITL Pushcut intercept (PLAN-cv-3-hitl-pushcut-intercept-
 *  2026-05-08.md · D1=B agent panel 자동 ON · D3=A 5min timeout deny).
 *
 *  When PR #2009 already registered a Pushcut confirm channel into
 *  `registerDefaultConfirmChannels`, but no caller was wiring the ACP
 *  approver path that triggers `requestConfirmation()`. This module-
 *  scope factory closes that loop — `handleAgentCliCreateSession`
 *  passes these into `clientSessionCreate` so every spawned agent CLI
 *  routes its permission / question requests through the HITL bus.
 *
 *  Lazy-memoized so the helper is constructed once per process even
 *  when many sessions are created. The adapter itself is stateless;
 *  the underlying `requestConfirmation()` reads the registered
 *  channels at call time, so swapping channels via test seams stays
 *  observable. */
// 2026-05-15 — HITL_TIMEOUT_MS · denyOnTimeout 미사용 (yolo path). 추후 wire
// 시 복귀: `const HITL_TIMEOUT_MS = 5 * 60_000; const denyOnTimeout = () => false;`
let _cachedPermissionApprover: AcpPermissionApprover | null = null;
let _cachedQuestionApprover: AcpQuestionApprover | null = null;

/** 2026-05-15 — YOLO default approvers. agent-cli wire (claude / codex /
 *  gemini CLI) 의 permission / question 요청을 자동 grant (Pushcut · HITL
 *  channel 회피). 사용자 dogfood 시 Pushcut 응답 대기로 CLI 가 5분 hang
 *  되는 문제 발생 — 추후 본격 권한 모드 wire 후 config / CLI 토글 으로 전환
 *  가능. test seam (_setAgentCliHitlApproversForTest) 은 그대로 유지.
 *
 *  Permission — 항상 true (granted).
 *  Question — 모든 question 의 첫 option 자동 선택. */
const yoloPermissionApprover: AcpPermissionApprover = async (_req) => true;
const yoloQuestionApprover: AcpQuestionApprover = async (req) => {
  const answers: Record<string, string> = {};
  for (const q of req.questions) {
    if (q.options.length > 0) {
      answers[q.id] = q.options[0].label;
    }
  }
  return { answers };
};

function getNexusHitlApprovers(): {
  permissionApprover: AcpPermissionApprover;
  questionApprover: AcpQuestionApprover;
} {
  // 2026-05-15 — yolo default. test seam 으로 inject 된 approver 가 우선
  // (unit test path 보존). 추후 권한 모드 본격 wire 시 본 함수 의 분기 추가.
  if (!_cachedPermissionApprover) {
    _cachedPermissionApprover = yoloPermissionApprover;
  }
  if (!_cachedQuestionApprover) {
    _cachedQuestionApprover = yoloQuestionApprover;
  }
  return {
    permissionApprover: _cachedPermissionApprover,
    questionApprover: _cachedQuestionApprover,
  };
}

/** Test seam — clear the memoized approvers so a unit test can exercise
 *  the lazy factory or inject mock instances via the public hook below. */
export function _resetAgentCliHitlApproversForTest(): void {
  _cachedPermissionApprover = null;
  _cachedQuestionApprover = null;
}

/** Test seam — inject specific approvers, bypassing the HITL adapter
 *  factory entirely. Pass `null` for either to fall back to the lazy
 *  factory on next call. Lets unit tests assert the wire path without
 *  mocking the channel race or HitlPendingCallbacks. */
export function _setAgentCliHitlApproversForTest(opts: {
  permissionApprover?: AcpPermissionApprover | null;
  questionApprover?: AcpQuestionApprover | null;
}): void {
  if (opts.permissionApprover !== undefined) {
    _cachedPermissionApprover = opts.permissionApprover;
  }
  if (opts.questionApprover !== undefined) {
    _cachedQuestionApprover = opts.questionApprover;
  }
}

interface CreateSessionBody {
  backend?: string;
  cwd?: string;
}

interface PromptBody {
  sessionId?: string;
  message?: string;
  /** W8-A 후속 #1 (2026-05-14) — cross-backend conversation aggregator
   *  (옵션 A · partial). 'append' (default · backend own history 만) ·
   *  'rebuild' (NEXUS-side store 의 last N turn cross-backend history →
   *  prefix 빌드 · 모든 agent-cli backend 가 same conversation 인지). */
  historyMode?: 'append' | 'rebuild' | 'seed-session';
  /** historyMode='seed-session' 시 — 히스토리를 replay 할 elanous 세션 id(fork된 세션).
   *  그 세션의 on-disk 대화를 seed prefix 로 주입해 fresh backend 가 부모 맥락 이어받음.
   *  fork-continue 첫 turn 에만 사용(이후 turn 은 'append'). */
  seedSessionId?: string;
  /** Cross-backend conversation 의 chat 식별자. elanous ACP session id
   *  또는 stable client-side identifier. 같은 chatId 안의 모든 backend
   *  turn 이 누적. 미명시 시 historyMode 무관 (legacy path). */
  chatId?: string;
  /** Conversation aggregator store 에 push 시 turn 의 backendId. picker
   *  에서 사용자가 명시한 backend (codex-app-server / claude / gemini)
   *  와 일치. 옵션 — 미명시 시 store 안 push (legacy path). */
  backendId?: string;
  /** P5.x.+ multimodal (#1982) — when supplied, the daemon forwards
   *  the user content as ACP ContentBlock[] (image/audio/video/etc) to
   *  the underlying CLI sub-process. The plain-text `message` is appended
   *  as the trailing text block when both are provided. ACP CLI
   *  brand별 multimodal 지원은 다름:
   *    - codex     : image only · audio/video silent drop
   *    - claude    : image + audio · video silent drop
   *    - gemini    : image + audio · video silent drop (Gemini Live API
   *                  는 별 path · agent-cli CLI 가 forward 안 함)
   *  W8-A 후속 (2026-05-14) — 'video' kind 추가. 본 schema 가 video raw
   *  base64 받지만 현 cut 의 모든 brand CLI 는 silent drop. iOS-side 가
   *  elanous-builtin path (NEXUS 의 video frame extraction) 에서 처리하도록
   *  안내. 향후 brand 가 native video 지원 시 자연 활성.
   *  per-brand validation 은 daemon 측 LLM 측에서 silent drop 가능. */
  userContent?: Array<{
    type: 'text' | 'image' | 'audio' | 'video' | 'resource' | 'resource_link';
    [k: string]: unknown;
  }>;
  /** 클라 서피스 귀속(2026-07-18·GN). 네이티브 iOS/Android 앱이 `{kind:'native',
   *  platform:'ios'|'android'}` 를 보내면 agent-cli 턴(S4)을 canonical 세션 스토어
   *  S1 에도 origin='native' 로 미러 → `elanous session` 가시화 + taste 소스 귀속.
   *  chatId 를 S1 세션 id 로 사용(멱등 adopt). 미지정 시 legacy(S4 만). */
  source?: { kind?: string; platform?: string };
}

interface CancelBody {
  sessionId?: string;
}

/** POST /v1/agent-cli/sessions — create new agent CLI session. */
export async function handleAgentCliCreateSession(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  let body: CreateSessionBody;
  try { body = (await req.json()) as CreateSessionBody; }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  const backend = body.backend;
  if (typeof backend !== 'string' || !SUPPORTED_BACKENDS.has(backend)) {
    return jsonResponse({
      error: 'invalid-backend',
      backend,
      supported: Array.from(SUPPORTED_BACKENDS),
    }, 400);
  }
  // cwd default = process.cwd() (daemon's working directory · usually
  // the monad-agent repo). Caller can override for cross-project runs.
  const cwd = typeof body.cwd === 'string' && body.cwd.length > 0
    ? body.cwd
    : process.cwd();
  // Round 3 PR2 (β-2 · 2026-05-08) — Showroom HITL toggle. When the
  // PWA appends `?hitl=off`, skip wiring the global HITL approver
  // chain so a demo Showroom can run without surfacing prompts. The
  // legacy default (no query param) keeps Phase α behaviour.
  const url = new URL(req.url);
  const hitlDisabled = url.searchParams.get('hitl') === 'off';

  try {
    const manager = globalDualRoleManager();
    // Phase α — wire HITL approvers so this agent CLI routes its
    // permission/question requests through the channel race registered
    // in `runNexus()` (PR #2009). D1=B per RFC: every agent-cli session
    // is treated as opt-in HITL territory; chat-only Showrooms never
    // hit this endpoint and stay untouched. D3=A: 5-min timeout, deny
    // on no-answer (fail-closed · matches `requestConfirmation` default).
    const approvers = hitlDisabled
      ? { permissionApprover: undefined, questionApprover: undefined }
      : getNexusHitlApprovers();
    const record = await manager.clientSessionCreate({
      backendId: backend,
      cwd,
      ...(approvers.permissionApprover ? { permissionApprover: approvers.permissionApprover } : {}),
      ...(approvers.questionApprover ? { questionApprover: approvers.questionApprover } : {}),
    });
    return jsonResponse({
      sessionId: record.id,
      backendId: record.backendId,
      backendSessionId: record.backendSessionId,
      cwd: record.cwd,
      createdAt: record.createdAt,
      hitl: hitlDisabled ? 'off' : 'on',
    }, 200);
  } catch (e) {
    return jsonResponse({
      error: 'session-create-failed',
      reason: e instanceof Error ? e.message : String(e),
    }, 500);
  }
}

/** POST /v1/agent-cli/prompt — stream session/prompt via SSE.
 *
 *  Streams chunks as the underlying AcpAgent emits SessionUpdate events.
 *  Closes the SSE stream when prompt resolves (with `stop` event) or
 *  rejects (with `error` event). Uses a ReadableStream Body so Bun.serve
 *  can flush each chunk immediately. */
export async function handleAgentCliPromptStream(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  let body: PromptBody;
  try { body = (await req.json()) as PromptBody; }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  const sessionId = body.sessionId;
  const message = body.message;
  const userContent = body.userContent;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return jsonResponse({ error: 'missing-sessionId' }, 400);
  }
  if (typeof message !== 'string' && !Array.isArray(userContent)) {
    return jsonResponse({ error: 'missing-message' }, 400);
  }

  // 2026-05-16 capability gate — peer 가 advertise 한 promptCapabilities 와
  // userContent 의 block type 대조. image/audio/video block 이 있는데 peer
  // 가 미지원 시 HTTP 400 으로 explicit reject (silent drop 의 UX 실패 방지).
  // ex. Grok 0.1.210 의 `image: false` 케이스 — 이전엔 daemon 이 forward
  // 후 Grok 이 silent drop · 사용자는 image 보낸 줄 알고 응답이 무관해서
  // 혼란. 본 gate 후 iOS 에 즉시 "Grok 은 image 미지원" 명확한 에러 도달.
  if (Array.isArray(userContent) && userContent.length > 0) {
    const peerCheck = checkBlockCapabilities(sessionId, userContent);
    if (peerCheck) return peerCheck;
  }

  // W8-A 후속 #1 (2026-05-14) — cross-backend NEXUS aggregator (옵션 A
  // partial). historyMode='rebuild' + chatId 시 본 store 의 last N turn
  // 을 cross-backend history → text prefix block 으로 inject. 모든 agent-
  // cli backend (codex/claude/gemini) 의 turn 이 같은 chatId 안에 누적 →
  // 사용자가 backend swap 해도 다른 backend 가 prior context 인지.
  const aggregator = globalAgentCliConversationStore();
  const historyMode = body.historyMode ?? 'append';
  const chatId = typeof body.chatId === 'string' && body.chatId.length > 0 ? body.chatId : null;
  const backendIdHint = typeof body.backendId === 'string' && body.backendId.length > 0
    ? body.backendId
    : 'unknown';
  const currentUserText = typeof message === 'string' ? message : '';

  // W8-A multimodal follow-up — detect image presence so we can annotate
  // the stored user text with `IMAGE_ATTACHED_MARKER`. This survives
  // backend swap: the next backend's rebuild prefix will show the visual
  // context without base64. Pure-image prompts (no text) become exactly
  // the marker text.
  const hadImageInput = Array.isArray(userContent)
    && userContent.some((b): boolean => {
      const typed = b as { type?: unknown } | null;
      return typed?.type === 'image';
    });

  let historyPrefixText = '';
  if (historyMode === 'rebuild' && chatId) {
    historyPrefixText = buildCrossBackendHistoryPrefix(aggregator, chatId, currentUserText, 8);
  } else if (historyMode === 'seed-session' && typeof body.seedSessionId === 'string' && body.seedSessionId) {
    // fork-continue — fork된 elanous 세션의 on-disk 히스토리를 seed prefix 로 replay(첫 turn).
    try {
      const seed = loadSession(body.seedSessionId);
      if (seed) historyPrefixText = buildSessionHistoryPrefix(seed.messages, currentUserText, 8);
    } catch { /* fail-soft — seed 없으면 그냥 새 대화 */ }
  }

  // P5.x.+ multimodal — when userContent is supplied, build ContentBlock[]
  // (with text appended as trailing block if both are present). The
  // dual-role-manager's clientSessionSend already accepts the union shape
  // `string | ContentBlock[]`. history prefix (rebuild mode) 시 leading
  // text block 으로 unshift — backend 가 prior context 부터 봄.
  // (image turns 의 경우 store text 에 "[image attached]" marker 가 이미 포함됨)
  let sendMessage: string | unknown[];
  if (Array.isArray(userContent) && userContent.length > 0) {
    const blocks: unknown[] = [];
    if (historyPrefixText.length > 0) {
      blocks.push({ type: 'text', text: historyPrefixText });
    }
    blocks.push(...userContent);
    if (typeof message === 'string' && message.length > 0) {
      blocks.push({ type: 'text', text: message });
    }
    sendMessage = blocks;
  } else {
    const userTextStr = message ?? '';
    sendMessage = historyPrefixText.length > 0
      ? `${historyPrefixText}\n\n---\n\n${userTextStr}`
      : userTextStr;
  }

  const manager = globalDualRoleManager();
  const encoder = new TextEncoder();

  const turnStartedAt = Date.now();
  let toolCallCount = 0;
  let textBytes = 0;
  // W8-A 후속 #1 — aggregator 에 agent response 누적용 (turn-end push).
  let accumulatedAgentText = '';

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: string): void => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          /* stream closed */
        }
      };
      const onUpdate = (update: SessionUpdate): void => {
        const text = extractUpdateText(update);
        if (text) {
          textBytes += text.length;
          accumulatedAgentText += text;
          send('chunk', JSON.stringify({ text }));
          return;
        }
        // P5.x.+ tool call viz (#1985) — surface tool_call /
        // tool_call_update events alongside text chunks so the
        // panel UI 가 agent CLI 의 행동을 실시간 visualize.
        const summary = extractToolCallSummary(update);
        if (summary) {
          if (summary.kind === 'tool_call') toolCallCount += 1;
          send(summary.kind, JSON.stringify(summary.payload));
        }
      };
      try {
        const result = await manager.clientSessionSend({
          sessionId,
          // Cast: server-side ContentBlock 타입은 SDK 의 그것과 호환되며
          // (dual-role-manager 가 plain text 인 경우만 lift) · client 의
          // PromptUserContentBlock 형태를 그대로 forward 가능. 검증 실
          // 패는 daemon-side LLM 측에서 silent drop.
          message: sendMessage as never,
          onUpdate,
        });
        // P5.x.+ activity pill (#1985) — emit turn-level metrics so
        // ShowroomPanel can show wall-clock, tool count, byte count
        // per agent panel session.
        send('usage', JSON.stringify({
          turnDurationMs: Date.now() - turnStartedAt,
          toolCallCount,
          textBytes,
        }));
        send('stop', JSON.stringify({
          sessionId: result.sessionId,
          stopReason: String(result.stopReason),
          lastSeenAt: result.lastSeenAt,
        }));
        // W8-A 후속 #1 (2026-05-14) — turn-end aggregator push. chatId 명시
        // 시 user prompt + agent response 둘 다 cross-backend store 에 push.
        // 다음 turn (같은 chat · 다른 backend) 가 historyMode='rebuild' 호출
        // 시 prefix 로 surface — 양방향 (agent-cli 끼리) 자연 흐름.
        // multimodal user turns: text 에 IMAGE_ATTACHED_MARKER 자동 주입 (위
        // hadImageInput 로직). text 없는 pure-image turn 도 marker text 만
        // 으로라도 보존 (이전엔 skip → cross-backend swap 시 통째 누락).
        if (chatId) {
          if (currentUserText.length > 0 || hadImageInput) {
            const textToStore = annotateWithImageMarker(currentUserText, hadImageInput);
            aggregator.append(chatId, {
              role: 'user',
              backendId: backendIdHint,
              text: textToStore,
              at: turnStartedAt,
            });
          }
          if (accumulatedAgentText.length > 0) {
            aggregator.append(chatId, {
              role: 'agent',
              backendId: backendIdHint,
              text: accumulatedAgentText,
              at: Date.now(),
            });
          }
        }
        // GN (2026-07-18) — 네이티브 iOS/Android 앱 대화를 canonical 세션 스토어 S1 에도
        // 미러(origin='native'). agent-cli 경로는 S4(aggregator) 만 써서 `elanous session`
        // 에 안 보였다(불가시·감사 G3/GN). 클라가 source.kind='native' 를 보낼 때만·
        // fail-soft·chatId 를 S1 세션 id 로(멱등 adopt). 네이티브 표면은 source와
        // origin에 함께 기록해 source 소비자와 origin 소비자를 모두 보존한다.
        const nativeOrigin = deriveOriginFromInputSourceKind(body.source?.kind as InputSourceKind | undefined);
        const s1Id = chatId ?? sessionId; // chatId(cross-backend 대화) 우선·없으면 sessionId
        if (nativeOrigin === 'native' && s1Id) {
          try {
            const nn = { source: 'native' as const, origin: nativeOrigin };
            if (currentUserText.length > 0 || hadImageInput) {
              defaultSessionStore.appendById(
                s1Id,
                { role: 'user', content: annotateWithImageMarker(currentUserText, hadImageInput), ts: new Date().toISOString() },
                nn,
              );
            }
            if (accumulatedAgentText.length > 0) {
              defaultSessionStore.appendById(
                s1Id,
                { role: 'assistant', content: accumulatedAgentText, ts: new Date().toISOString() },
                nn,
              );
            }
          } catch { /* fail-soft — S1 미러 실패가 agent-cli turn 을 깨지 않음 */ }
        }
      } catch (e) {
        send('error', JSON.stringify({
          error: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        try { controller.close(); } catch { /* noop */ }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    },
  });
}

/** POST /v1/agent-cli/cancel — abort active prompt for a session. */
export async function handleAgentCliCancel(
  req: Request,
  opts: MetaApiOpts,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  let body: CancelBody;
  try { body = (await req.json()) as CancelBody; }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) {
    return jsonResponse({ error: 'missing-sessionId' }, 400);
  }
  try {
    const manager = globalDualRoleManager();
    const record = manager.clientSessionById(body.sessionId);
    if (!record) {
      return jsonResponse({ error: 'unknown-session', sessionId: body.sessionId }, 404);
    }
    // Underlying AcpAgent.cancel — best-effort. The next session/prompt
    // call resumes normally; cancel signals the agent to stop the
    // current turn (codex/claude/gemini interpret per their own
    // semantics).
    await record.agent.cancel(record.backendSessionId);
    return jsonResponse({ ok: true, sessionId: body.sessionId }, 200);
  } catch (e) {
    return jsonResponse({
      error: 'cancel-failed',
      reason: e instanceof Error ? e.message : String(e),
    }, 500);
  }
}

/** DELETE /v1/agent-cli/sessions/:sid — close session (releases resources
 *  · subprocess stays alive · just unregisters the per-session handle). */
export async function handleAgentCliCloseSession(
  req: Request,
  opts: MetaApiOpts,
  sessionId: string,
): Promise<Response> {
  if (!checkAuth(req, opts)) return jsonResponse({ error: 'unauthorized' }, 401);
  if (!sessionId) return jsonResponse({ error: 'missing-sessionId' }, 400);
  try {
    const manager = globalDualRoleManager();
    const ok = await manager.clientSessionClose(sessionId);
    return jsonResponse({ ok, sessionId }, 200);
  } catch (e) {
    return jsonResponse({
      error: 'close-failed',
      reason: e instanceof Error ? e.message : String(e),
    }, 500);
  }
}

/** Path matcher: `/v1/agent-cli/sessions/:sid`. Returns the sid when
 *  the path matches, null otherwise. */
export function parseAgentCliSessionPath(pathname: string): string | null {
  const m = /^\/v1\/agent-cli\/sessions\/([^/]+)$/.exec(pathname);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

/** Pull display text out of a SessionUpdate. Mirrors the helper in
 *  src/skills/tools/acp-session.ts but kept inline so this file stays
 *  self-contained (no cross-package import cycle). */
function extractUpdateText(update: SessionUpdate): string {
  // SessionUpdate is a discriminated union — agent_message_chunk is the
  // primary text-bearing variant. agent_thought_chunk also surfaces
  // text but is currently filtered out (chain-of-thought = noise for
  // panel UX). Tool calls / tool results are NOT streamed as text —
  // they show up as separate update kinds (P5.x.+ may surface).
  const u = update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
  if (u.sessionUpdate === 'agent_message_chunk') {
    if (u.content?.type === 'text' && typeof u.content.text === 'string') {
      return u.content.text;
    }
  }
  return '';
}

/** P5.x.+ tool call viz (#1985) — extract a compact summary of the
 *  tool_call / tool_call_update SessionUpdate variants. Returns the
 *  SSE event kind ('tool_call' or 'tool_call_update') + a serializable
 *  payload that the client uses to render a tool entry in the panel.
 *
 *  Codex emits these for `commandExecution` (bash) · `fileChange` (edit)
 *  · `mcpToolCall` (MCP server) · `webSearch`. Each call has a stable
 *  `toolCallId` + status lifecycle (pending → in_progress → completed
 *  / failed). The client renders one collapsed entry per id and updates
 *  status on subsequent updates. */
function extractToolCallSummary(update: SessionUpdate): {
  kind: 'tool_call' | 'tool_call_update';
  payload: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    contentText?: string;
  };
} | null {
  const u = update as {
    sessionUpdate?: string;
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    content?: unknown;
  };
  if (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update') {
    return null;
  }
  const payload: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    contentText?: string;
  } = {};
  if (typeof u.toolCallId === 'string') payload.toolCallId = u.toolCallId;
  if (typeof u.title === 'string') payload.title = u.title;
  if (typeof u.kind === 'string') payload.kind = u.kind;
  if (typeof u.status === 'string') payload.status = u.status;
  // Compact content extraction — codex's content is `[{ type: 'content',
  // content: { type: 'text', text } }]`; we surface only the inner text
  // so the client can show command output / patch summary inline.
  if (Array.isArray(u.content)) {
    for (const block of u.content) {
      const b = block as { content?: { type?: string; text?: string } };
      if (b.content?.type === 'text' && typeof b.content.text === 'string') {
        payload.contentText = b.content.text;
        break;
      }
    }
  }
  return { kind: u.sessionUpdate as 'tool_call' | 'tool_call_update', payload };
}
