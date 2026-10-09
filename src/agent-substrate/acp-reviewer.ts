// ── ACP Claude Code 를 PR 리뷰어 substrate 의 llmReview seam 으로 ──
//
// PLAN-review-reactive-completion-loop §L2 의 ACP 독립심판(acp-judge)과 같은 substrate 를
// **read-only 리뷰**에도 노출한다. `reviewPullRequest(input, llmReview)` 의 llmReview 주입 seam 에
// ACP Claude Code(독립 프로세스·Opus 등 tier 지정)를 꽂아, buildReviewPrompt/parseReviewResult/
// renderReview 를 그대로 재사용한다 — API 리뷰어(gpt-5.6-sol)와 완전 동형 출력.
//
// ★ 왜 ACP 인가: 미션 구현·게이트와 다른 **독립 주체(Claude Code Opus)** 가 리뷰 → 단일모델 러버스탬프
//   불가. `elanous self review --acp` 창구가 이걸 대표 손에 쥐어준다.
// ★ tool-enabled(2026-07-23) — 종전 no-tools 우회를 걷어냈다. 근본 재진단: SDK 버전 skew 아님(우리·백엔드
//   둘 다 @agentclientprotocol/sdk 0.14.1). tool_call 세션 업데이트의 검증 실패는 **노이즈**(notification 은
//   응답 불필요·SDK 가 로그 후 계속). 종전 hang 의 진짜 원인 = approver 부재 시 퍼미션 **자동 취소**로 Read
//   툴이 반복 거부돼 정체. → **auto-allow approver**(대표 지시)로 해소. 이제 Opus 가 실제 레포 파일을 읽어
//   호출처/전체 문맥까지 검증(예: "grep 검증 권고" 류 지적을 스스로 확인). 재사용: AcpAgent + session/set_model.
import { AcpAgent, type AcpAgentOpts } from '../acp/client.js';
import { AcpAgentManager } from '../acp/agent-manager.js';
import { canonicalizeBackendId, getAcpBackend } from '../acp/backend-registry.js';
import { debug } from '../debug/log.js';
import type { ReviewImage } from './pr-reviewer.js';

export interface AcpReviewerOpts {
  /** 테스트용 ACP 에이전트 생성기. 지정하면 정식 창구 대신 이 seam을 사용한다. */
  createAgent?: (opts: AcpAgentOpts) => AcpAgent;
  /** ACP 에이전트 cwd — 리뷰어가 파일을 읽어 교차검증하므로 반드시 레포 루트를 준다. */
  cwd: string;
  /** ACP 백엔드 id (기본 claude = Claude Code via claude-code-acp). */
  backend?: string;
  /** Per-review ACP spawn specification (subscription executor). */
  backendSpec?: import('../acp/backend-registry.js').AcpBackendSpec;
  /** Subscription child environment after billing credentials are removed. */
  env?: Record<string, string>;
  /** 모델 tier 별칭 (opus|sonnet|haiku 등). 지정 시 session/set_model 로 고정(백엔드 CLI 기본 위임 아님). */
  model?: string;
  /** 리뷰 1턴 최대 대기(ms). 초과 시 cancel→throw(부분 리뷰로 오판 pass 방지). 기본 300000. */
  timeoutMs?: number;
}

/**
 * ⛔⭐⭐ 리뷰어 기본 ACP 백엔드 — **`codex`**(2026-08-01 대표 지시 · 전문 =
 * [[INCIDENT-2026-08-01-cross-review-path-first-live-run-and-two-premature-verdicts]] · 원장 `JDG-S9`).
 *
 * **근본**: `claude-code-acp@0.16.2` 가 보내는 툴콜 진행 알림(`session/update` · `kind:"read"` ·
 * `content: []` ⊕ `locations`)이 **`-32602 Invalid params`**(zod 검증 실패)로 거부된다.
 * ⚠️ **파이프라인은 성공한다**(`verdict=pass` · `exit 0` · `ready-to-merge`) — **에러만 조용히 흐른다.**
 * ⇒ 심판이 *"파일이 실재함을 검증했다"* 라고 적었는데 **읽기 알림이 거부된 상태**였고,
 *   그것이 *"알림만 거부(판정 유효)"* 인지 *"툴콜 자체 실패(diff 만으로 판정)"* 인지 **가르지 못했다**
 *   (그 툴콜이 관측에 안 남는다 — `review.done` 요약만).
 *
 * ⭐ **대조군**: **codex 경로는 정상 동작한다**(대표 실측 2026-08-01) ⇒ 결손은 `claude-code-acp` 한정.
 *
 * ⛔⛔ **이것은 회피이지 수리가 아니다.** 이중 게이트가 claude 경로도 쓰므로 **반드시 고쳐야 한다**
 * (`JDG-S9` 열림). ⚠️ `backend: 'claude'` 를 **명시하면 그대로 탄다** — 수리 검증은 그 경로로 한다.
 */
export const DEFAULT_REVIEW_BACKEND = 'codex';

// ACP ToolKind(zToolKind) 중 read-only(부작용 없음) — 리뷰어에게 허가할 계열.
const READONLY_TOOL_KINDS = new Set(['read', 'search', 'fetch', 'think', 'switch_mode']);
// 명시적 변경/실행 계열 — 리뷰(read-only)에선 절대 불허.
const MUTATING_TOOL_KINDS = new Set(['edit', 'delete', 'move', 'execute']);

/** ★ 리뷰어 퍼미션 화이트리스트 — read-only 툴만 허가(#5171 셀프리뷰 지적 반영). kind 우선, kind 가
 *  other/미상이면 title 휴리스틱으로 read 계열만 통과(그 외 보수적 거부). 프롬프트 인젝션·모델 오작동이
 *  Write/Bash 를 부르는 공격 표면을 프리앰플 지시가 아니라 **구조적으로** 차단. 순수 함수(테스트 가능). */
export function isReadOnlyReviewTool(kind: string | undefined, title: string): boolean {
  if (kind && MUTATING_TOOL_KINDS.has(kind)) return false;
  if (kind && READONLY_TOOL_KINDS.has(kind)) return true;
  // kind='other'/미상 → title 로 read 계열만 허용(보수적).
  return /\b(read|grep|glob|search|find|list|fetch|view|cat|ls|head|tail)\b/i.test(title);
}

// 툴 사용 권장 프리앰블 — diff 는 진실의 일부일 뿐. 호출처/전체 파일을 읽어 검증하라(read-only 만).
const TOOL_REVIEW_PREAMBLE = [
  'You are reviewing an opened PR. The diff below is the primary evidence, but you MAY and SHOULD use',
  'your read-only tools (Read, Grep, Glob) to verify claims the diff alone cannot settle — e.g. whether a',
  'changed function has callers outside the diff, whether a new export is actually consumed, whether a type',
  'exists. Do NOT edit files, run mutating commands, push, or open PRs — review only. When done, reply with',
  'the review text in the required format.',
  '',
].join('\n');

/** ★ ACP 백엔드를 1회성 prompt→text 러너로 만들어 reviewPullRequest 의 llmReview 로 주입.
 *  - model 지정 시 selectSessionModel 로 tier 고정(picked 관측).
 *  - ⭐auto-allow permission approver — 리뷰어의 read-only 툴콜을 무조건 허가(대표 지시)해 Read 반복거부
 *    정체를 원천제거. 각 허가는 debug.log 로 각인(제1원칙 관측 관문 — 자동승인은 관측되는 결정).
 *  - timeout: 초과 시 cancel→throw. 오류/타임아웃은 각인 후 rethrow → reviewPullRequest 가 fail-soft
 *    (reviewed=false)로 흡수, CLI 가 reviewed=false 를 "리뷰 실패"로 표면화(부분결과 오판 pass 방지). */
export function makeAcpReviewLLM(opts: AcpReviewerOpts): (prompt: string, images?: readonly ReviewImage[]) => Promise<string> {
  return async (prompt: string, images?: readonly ReviewImage[]): Promise<string> => {
    const requestedBackend = opts.backend ?? DEFAULT_REVIEW_BACKEND;
    const injected = Boolean(opts.createAgent);
    // The injected seam deliberately accepts arbitrary test backends. The
    // production path alone resolves aliases and transport through the factory.
    const backend = canonicalizeBackendId(requestedBackend);
    // ⛔⭐⭐⭐ 백엔드 해석은 «`try` 밖»이라 여기서 던지면 아래 `catch` 의 `acp-review/error` 가
    //   «안 걸린다**. 그래서 `--acp-backend claude-code`(미등록) 같은 오타를 주면 레지스트리가
    //   ***`Unknown ACP backend "claude-code". Known: …"`*** 라는 «완벽한» 오류를 던지는데도
    //   `acp-review` 카테고리에 «아무것도 안 남았다**(2026-08-07 실측).
    //   ⛔ 더 나쁜 것: CLI 는 `reviewed=false` 일 때 *"관측: elanous logs --category acp-review"* 라
    //      «안내»한다 — ***도구가 「여기를 보라」고 말한 자리에 답이 없었다.***
    //   ⇒ 이 한 줄만 자기 catch 로 감싼다(전체 try 를 앞당기면 `start` 관측이 그 안으로 들어간다).
    let transport: string | null;
    try {
      transport = injected ? null : opts.backendSpec?.transport ?? getAcpBackend(backend).transport ?? 'acp';
    } catch (e) {
      debug.log('acp-review', 'error', {
        requestedBackend, backend, stage: 'resolve-backend', message: (e as Error).message,
      }, { level: 'error' });
      throw e;
    }
    const timeoutMs = opts.timeoutMs ?? 300_000;
    debug.log('acp-review', 'start', {
      requestedBackend,
      backend,
      transport,
      model: opts.model ?? '(default)',
      promptChars: prompt.length,
    });
    let allowed = 0;
    let denied = 0;
    let capabilitiesObserved = false;
    const agentOpts: Omit<AcpAgentOpts, 'backendId'> = {
      cwd: opts.cwd,
      ...(opts.backendSpec ? { backendSpec: opts.backendSpec, env: opts.env } : {}),
      log: (message) => debug.log('acp-review', 'agent-log', { backend, message }),
      onCapabilities: (capabilities) => {
        capabilitiesObserved = true;
        try {
          debug.log('acp-review', 'capabilities', {
            backend,
            protocolVersion: capabilities.protocolVersion,
            image: capabilities.prompt.image,
            audio: capabilities.prompt.audio,
            loadSession: capabilities.loadSession,
          });
        } catch {
          // Observation must not interrupt a review after negotiation.
        }
      },
      // ★ read-only 화이트리스트(#5171 셀프리뷰 지적) — 리뷰어의 Read/Grep/Glob 등만 자동허가, Write/Bash/
      //   Edit 등 변경·실행 툴은 거부(자율 리뷰라 HITL 없음·프리앰블만으론 인젝션 방어 불가·구조적 차단).
      permissionApprover: async (req) => {
        const ok = isReadOnlyReviewTool(req.kind, req.title);
        if (ok) { allowed++; debug.log('acp-review', 'permission-allow', { backend, n: allowed, title: req.title.slice(0, 80), kind: req.kind ?? null }); }
        else { denied++; debug.log('acp-review', 'permission-deny', { backend, n: denied, title: req.title.slice(0, 80), kind: req.kind ?? null }); }
        return ok;
      },
    };
    // A review owns its manager and subprocess: the global manager caches
    // chat agents, whose callbacks and lifecycle must not be mutated here.
    const reviewManager = injected || opts.backendSpec ? undefined : new AcpAgentManager();
    let agent: AcpAgent | undefined;
    let text = '';
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      agent = opts.createAgent
        ? opts.createAgent({ backendId: requestedBackend, ...agentOpts })
        : opts.backendSpec
          ? new AcpAgent({ backendId: requestedBackend, ...agentOpts })
          : await reviewManager!.getAgent(requestedBackend, agentOpts);
      if (injected || opts.backendSpec) await agent.start();
      if (!capabilitiesObserved) {
        try {
          debug.log('acp-review', 'capabilities', {
            backend,
            protocolVersion: null,
            image: null,
            audio: null,
            loadSession: null,
          });
        } catch {
          // Observability must not interrupt a review.
        }
      }
      const sid = await agent.newSession();
      if (opts.model) {
        const picked = await agent.selectSessionModel(sid, opts.model);
        debug.log('acp-review', 'model', { requested: opts.model, picked: picked?.name ?? null, backend });
      }
      timer = setTimeout(() => { timedOut = true; agent!.cancel(sid).catch(() => { /* noop */ }); }, timeoutMs);
      // ⭐⭐ `P4b` 멀티미디어 — 이미지를 «별도 ContentBlock» 으로 싣는다.
      //   ⛔ 광고를 «먼저 본다** — 백엔드가 image 를 안 받는다고 말하면 안 보낸다. 보내 봐야
      //      거절이 이 층보다 훨씬 읽기 어려운 자리에서 나고, 그 거절은 리뷰 실패로 보인다.
      //   📏 2026-08-07 실측으로 둘 다 `image: true` 다(claude ⊕ codex-app-server). 그전엔
      //      codex 가 «자기 광고를 안 해» null 로 보였고, 그것이 두 창 동안 이 축을 막았다.
      const advertisedImage = agent.getCapabilities?.()?.prompt.image === true;
      const imageBlocks = advertisedImage && images
        ? images.map((image) => ({ type: 'image' as const, mimeType: image.mimeType, data: image.data }))
        : [];
      if (images?.length) {
        try {
          debug.log('acp-review', 'images', {
            backend,
            requested: images.length,
            sent: imageBlocks.length,
            advertisedImage,
            // ⛔ 「보냈다」와 「받아 준다고 말했다」를 «다른 칸»으로 둔다 — 하나로 접으면
            //   백엔드가 광고를 안 할 때 「이미지가 없었다」로 읽힌다.
            labels: images.map((image) => image.label).slice(0, 4),
          });
        } catch {
          // Observation must not prevent the review from running.
        }
      }
      await agent.prompt(sid, [{ type: 'text', text: TOOL_REVIEW_PREAMBLE + prompt }, ...imageBlocks], (u) => {
        if (u.sessionUpdate === 'agent_message_chunk') {
          const c = u.content;
          if (c.type === 'text' && c.text) text += c.text;
        }
      });
      if (timedOut) throw new Error(`ACP 리뷰 타임아웃(${timeoutMs}ms·툴콜 ${allowed})`);
    } catch (e) {
      debug.log('acp-review', 'error', { backend, model: opts.model ?? '(default)', message: (e as Error).message }, { level: 'error' });
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      // Both paths are review-owned: injected agents retain their direct
      // cleanup seam, while the per-review manager releases its agents and
      // process hooks. An injected agent is external to the manager.
      try {
        if (injected || opts.backendSpec) await agent?.stop();
        else await reviewManager!.dispose();
      } catch (e) {
        debug.log('acp-review', 'stop-fail', { backend, message: (e as Error).message }, { level: 'error' });
      }
    }
    debug.log('acp-review', 'done', { backend, chars: text.length, allowed, denied });
    return text;
  };
}

/**
 * ⭐⭐ 지연 로드 ACP 리뷰 심 — **이 래퍼가 `#7486` 의 범인이었다.**
 *
 * 리더·심·전송층을 다 고친 «뒤에도» `acp-review images` 관측이 **0** 이었고, 원인은 여기서
 * 두 번째 인자를 «떨어뜨린» 것이었다. 그때 이 코드는 `index.ts` 안의 **익명 화살표**라
 * 테스트가 닿지 않았다 — 그래서 회귀를 막을 자리가 «없었다**(리뷰 must-fix).
 *
 * ⇒ 이름을 주고 뽑았다. `load` 를 주입 seam 으로 둬 실제 동적 import 없이 인자 보존을 잰다.
 */
export function makeLazyAcpReviewLLM(
  opts: AcpReviewerOpts,
  load: () => Promise<(o: AcpReviewerOpts) => (prompt: string, images?: readonly ReviewImage[]) => Promise<string>>
    = async () => (await import('./acp-reviewer.js')).makeAcpReviewLLM,
): (prompt: string, images?: readonly ReviewImage[]) => Promise<string> {
  let inner: ((prompt: string, images?: readonly ReviewImage[]) => Promise<string>) | null = null;
  return async (prompt, images) => {
    if (!inner) inner = (await load())(opts);
    // ⛔ `images` 를 반드시 그대로 넘긴다. 여기서 떨어뜨리면 위아래가 다 이미지를 날라도 소용없다.
    return inner(prompt, images);
  };
}
