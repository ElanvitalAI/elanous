import type { LLMToolSpec } from '../../llm/tool-spec.js';
// daemon tool · delegate_code_agent (2026-07-08)
//
// elanous(elanous-builtin)가 큰 코드 작업을 외부 코딩 에이전트(claude code / codex /
// gemini / grok)에 위임하는 도구. self-improving 흐름에서 "더 강한 코더에 맡기기".
// ACP dual-role manager 로 sub-process 세션을 열고 task 를 보내 완료까지 대기한 뒤
// 누적 텍스트를 반환한다(블로킹). elanous 직접(Edit/Write/Bash)로 충분한 작은 작업엔
// 쓰지 말 것 — 큰 구현·리팩토링·외부 기능 이식 등에만.

import { homedir } from 'node:os';
import { childLifetimeSignal } from '../../turn-abort-scope.js';
import { mkdirSync } from 'node:fs';

import type { DaemonToolDispatchCtx } from './types.js';
import { globalDualRoleManager } from '../../acp/dual-role-manager.js';
import { getUserConfig } from '../../user-config/reader.js';
import { extractUpdateText } from '../../skills/tools/acp-session.js';
import { recordAutonomousActionSafe } from '../../domains/autonomy-log.js';
import { debug } from '../../debug/log.js';
import {
  createAcpPermissionApproverFromHitl,
  createAcpQuestionApproverFromHitl,
} from '../../hitl/hitl-acp-adapter.js';
import {
  mapCodexGoalStatusToMissionStatus,
  type CodexGoalStatus,
} from '../../acp/codex-app-server-agent.js';
import type { DualRoleManager } from '../../acp/dual-role-manager.js';
import {
  renderToolUpdate,
  DELEGATE_AGGREGATE_CAP,
  type RelayToolUpdate,
} from '../../channel/agent-event-relay.js';
import { spillFileName } from '../../channel/file-sink.js';
import { persistMissionRouteDecision, routeDecisionFromExecutionBackend } from '../../autopilot/mission-route-decision.js';

/** Read the delegated session's final codex goal (best-effort) and shape
 *  it for the tool result: raw status + mapped elanous mission status +
 *  budget usage. Returns null when the backend has no goal support. */
async function readDelegateGoal(
  mgr: DualRoleManager,
  sessionId: string,
): Promise<{ status: string; missionStatus: string; tokensUsed?: number; tokenBudget?: number | null } | null> {
  try {
    const g = (await mgr.clientSessionGetGoal({ sessionId })) as {
      status?: CodexGoalStatus; tokensUsed?: number; tokenBudget?: number | null;
    } | null;
    if (!g || typeof g.status !== 'string') return null;
    return {
      status: g.status,
      missionStatus: mapCodexGoalStatusToMissionStatus(g.status),
      ...(typeof g.tokensUsed === 'number' ? { tokensUsed: g.tokensUsed } : {}),
      ...(g.tokenBudget !== undefined ? { tokenBudget: g.tokenBudget } : {}),
    };
  } catch { return null; }
}

/** Expand a leading `~` / `~/` to the user's HOME. The delegate `cwd`
 *  comes straight from the LLM tool call, which routinely emits paths
 *  like `~/source/monad-agent` (the user typed a tilde). `spawn`
 *  does NOT expand `~` (only shells do), so a literal-tilde cwd makes the
 *  ACP sub-process fail to start with ENOENT — surfacing as a misleading
 *  "codex app-server stdin drain timeout" (the write races the async
 *  spawn error). Expanding here fixes every backend spawn at the seam
 *  where the LLM-supplied path enters. */
function expandHome(raw: string): string {
  const home = process.env.HOME || homedir() || '';
  if (!home) return raw;
  if (raw === '~' || raw === '~/') return home;
  if (raw.startsWith('~/')) return home + raw.slice(1);
  return raw;
}

/** Interactive HITL wait per delegated approval before deny (matches the
 *  slash-path `/cc` timeout). Long enough for the human to tap, short
 *  enough not to wedge the sub-agent forever. */
const DELEGATE_HITL_TIMEOUT_MS = 120_000;

export const DELEGATE_BACKENDS = ['claude', 'codex-app-server', 'gemini', 'grok'] as const;

export function buildDelegateAgentTool(): LLMToolSpec {
  return {
    name: 'delegate_code_agent',
    description:
      '코드 작업을 외부 코딩 에이전트에 위임한다. sub-process ACP 세션을 열고 task 를 보내 완료까지 대기한 뒤 결과를 반환. **사용자가 "claude/codex/gemini/grok 로 (구현/개발/리팩토링/코딩) 해줘" 처럼 특정 코딩 에이전트를 명시 지목한 경우에만 이 도구를 해당 backend 로 호출한다(대표 결정 2026-07-14). 지목이 없으면 네 재량으로 backend 를 골라 위임하지 마라 — 기능 구현·수정·리팩토링은 SelfImplement/RunDevHarness 로 가고, 한 줄 수정·설정값·문서처럼 작은 것만 직접 Edit/Write/Bash/PtyShell 로 코딩하라.** backend: claude(claude code) | codex-app-server(codex) | gemini | grok. task 는 자세히 적을 것(위임 에이전트가 독립 실행하므로 맥락 포함).',
    parameters: {
      type: 'object',
      properties: {
        backend: { type: 'string', description: 'claude | codex-app-server | gemini | grok' },
        task: { type: 'string', description: '위임할 작업 지시(맥락 포함·자세히).' },
        cwd: { type: 'string', description: '작업 디렉토리(선택·기본 daemon tool-cwd).' },
        missionId: { type: 'string', description: '미션 correlation id(선택). phaseId와 함께 줄 때만 브리핑 evidence로 기록.' },
        phaseId: { type: 'string', description: '미션 subagent phase id(선택). missionId와 함께 필요.' },
      },
      required: ['backend', 'task'],
    },
  };
}

export async function dispatchDelegateAgent(
  args: { backend?: unknown; task?: unknown; cwd?: unknown; missionId?: unknown; phaseId?: unknown },
  ctx: DaemonToolDispatchCtx,
): Promise<unknown> {
  const backend = typeof args.backend === 'string' ? args.backend.trim() : '';
  const task = typeof args.task === 'string' ? args.task.trim() : '';
  const missionId = typeof args.missionId === 'string' ? args.missionId.trim() : '';
  const phaseId = typeof args.phaseId === 'string' ? args.phaseId.trim() : '';
  if (!(DELEGATE_BACKENDS as readonly string[]).includes(backend)) {
    return { error: `backend must be one of: ${DELEGATE_BACKENDS.join(', ')}` };
  }
  if (!task) return { error: 'task required' };
  if ((missionId && !phaseId) || (!missionId && phaseId)) return { error: 'missionId and phaseId must be provided together' };
  const cwd = typeof args.cwd === 'string' && args.cwd ? expandHome(args.cwd) : ctx.cwd;
  // The LLM often names a TARGET dir that doesn't exist yet ("/tmp/x에
  // 만들어줘" → cwd:/tmp/x). A missing cwd makes posix_spawn fail with a
  // misleading binary-ENOENT (2026-07-12 discord NL-delegate crash), so
  // materialize it up front — creating the requested workdir matches the
  // user's stated intent.
  try { mkdirSync(cwd, { recursive: true }); } catch { /* spawn guard below reports */ }

  const mgr = globalDualRoleManager();
  // Surface-scoped HITL — when the triggering surface (e.g. the Telegram
  // chat that said "Claude로 구현해줘") supplied confirm channels, route
  // the delegated sub-agent's permission / question prompts back there
  // and let the human approve per action (permissionMode:'default' so
  // the backend actually ASKS). Absent ⇒ preserve the unattended
  // self-improving posture: auto-approve so the sub-agent isn't blocked
  // (control is asserted by the caller framing + upstream merge/reboot
  // HITL gates).
  const surfaceChannels = ctx.surfaceHitlChannels;
  const interactive = !!surfaceChannels && surfaceChannels.length > 0;
  // Autonomous by default: edit/command PERMISSIONS auto-approve (asking the
  // human to approve every write defeats delegation — that's the interactive-
  // editor paradigm ACP inherited, not the autonomous one). Opt into per-edit
  // oversight via `acp.editApproval`. Structured QUESTIONS still surface to the
  // human regardless (that's genuine consultation, not babysitting).
  const editApproval = getUserConfig().acp?.editApproval === true;
  const askPermission = interactive && editApproval;
  const sessionCreateOpts = {
    backendId: backend,
    cwd,
    permissionMode: askPermission ? ('default' as const) : ('auto' as const),
    permissionApprover: askPermission
      ? createAcpPermissionApproverFromHitl({
          channels: surfaceChannels!,
          timeoutMs: DELEGATE_HITL_TIMEOUT_MS,
        })
      : async () => true,
    // Questions always route to the human when a surface exists.
    ...(interactive
      ? {
          questionApprover: createAcpQuestionApproverFromHitl({
            channels: surfaceChannels!,
            ...(ctx.surfaceQuestionChannels && ctx.surfaceQuestionChannels.length > 0
              ? { questionChannels: ctx.surfaceQuestionChannels }
              : {}),
            timeoutMs: DELEGATE_HITL_TIMEOUT_MS,
          }),
        }
      : {}),
  };
  const startedAt = Date.now();
  debug.log('agent.spawn', 'delegate', {
    backend,
    cwd,
    taskChars: task.length,
  });
  let rec;
  try {
    rec = await mgr.clientSessionCreate(sessionCreateOpts);
  } catch (err) {
    debug.log('agent.error', 'delegate-failed', {
      backend,
      cwd,
      taskChars: task.length,
      durationMs: Date.now() - startedAt,
      outputChars: 0,
      reason: 'session-create-failed',
    }, { level: 'error' });
    return { error: `세션 생성 실패(${backend}): ${err instanceof Error ? err.message : String(err)}` };
  }
  // There is no implicit mission ownership for a chat delegation.  Persist
  // only explicitly correlated sessions, avoiding evidence contamination.
  if (missionId && phaseId) {
    try { persistMissionRouteDecision(phaseId, routeDecisionFromExecutionBackend(backend)); } catch { /* fail-soft */ }
  }
  // /cancel wiring — when the turn's abort signal fires (Telegram
  // `/cancel`), close this ACP session so the blocking clientSessionSend
  // unwinds and the sub-process is torn down cleanly. Previously the NL
  // delegate had NO cancel path, so an in-flight codex/claude job could
  // only be stopped by killing processes. Best-effort + idempotent.
  //
  // ⛔⭐⭐ 2026-08-19 — 여기서도 `ctx.signal` 을 «직접» 듣지 않는다(대표 지시).
  //   ESC(turn-only)로 도는 턴을 멈춰도 ***이 서브에이전트는 계속 산다***. `/cancel` 은 종전대로 닫는다.
  //   자식 수명 신호는 `childLifetimeSignal` 이 «구조»로 갈라 준다 — 여기서 뜻을 검사하지 않는다.
  const recId = rec.id;
  const lifetime = childLifetimeSignal(ctx.signal);
  const onAbort = (): void => {
    void Promise.resolve(mgr.clientSessionClose(recId)).catch(() => { /* best-effort */ });
  };
  if (lifetime?.aborted) onAbort();
  else lifetime?.addEventListener('abort', onAbort, { once: true });
  // Follow-up B — set the codex-native goal so the sub-agent tracks the
  // task as a bounded objective (budget enforcement + goal status).
  // Best-effort: only codex acts; other backends / errors no-op.
  try { await mgr.clientSessionSetGoal({ sessionId: rec.id, objective: task }); }
  catch { /* goal is optional — never fail the delegation on goal/set */ }
  let out = '';
  // Channel-terminal-relay (#3571) fan-in for the NL delegate path — the
  // `/cc` slash path relays tool commands/stdout/diffs into the chat via
  // turn-runner, but delegate_code_agent used to accumulate PROSE ONLY
  // (`extractUpdateText` returns '' for tool updates), so a natural-
  // language "Claude로 구현해줘" hid the actual diffs/output. Relay them
  // too so elanous's agent (and the user) sees what the sub-agent did.
  const relayVerbosity = 'normal' as const; // single policy — no user knob
  const fileSink = ctx.surfaceFileSink;
  try {
    const result = await mgr.clientSessionSend({
      sessionId: rec.id,
      message: task,
      onUpdate: (u) => {
        const su = (u as { sessionUpdate?: string }).sessionUpdate;
        if (su === 'tool_call' || su === 'tool_call_update') {
          const rendered = renderToolUpdate(u as RelayToolUpdate, { verbosity: relayVerbosity });
          if (rendered) {
            out += rendered.text;
            // P1.4 — spill the FULL overflowing body as a file into the
            // originating chat (when the surface is file-capable) so the
            // user sees the complete diff/stdout even though `out` (the
            // LLM tool-result) is clipped at DELEGATE_AGGREGATE_CAP below.
            if (rendered.overflow && fileSink) {
              fileSink.sendFile(rendered.overflow.body, {
                ext: rendered.overflow.ext,
                caption: `${rendered.overflow.title} · ${rendered.overflow.body.length} chars`,
                name: spillFileName(rendered.overflow.title, rendered.overflow.ext),
              });
            }
          }
          return;
        }
        const t = extractUpdateText(u);
        if (t) out += t;
      },
    });
    // Read the final goal so the caller sees codex's progress verdict
    // (mapped to a elanous mission status + budget usage).
    const goal = await readDelegateGoal(mgr, rec.id);
    // Autopilot P0.2 — 자율행동(코드 위임) 회상 로깅. "elanous 가 큰 코드 작업을 X 에 위임".
    recordAutonomousActionSafe({
      loop: 'delegate',
      action: `${backend} 위임: ${task.slice(0, 100)}`,
      rationale: '큰 구현/리팩토링/외부 기능 이식을 강한 코더에 위임(self-improving)',
      outcome: `${String(result.stopReason)} · ${out.length}자 산출`,
      refs: { backend, sessionId: rec.id },
    });
    debug.log('agent.done', 'delegate-finish', {
      backend,
      cwd,
      taskChars: task.length,
      durationMs: Date.now() - startedAt,
      outputChars: out.length,
    });
    return {
      backend,
      sessionId: rec.id,
      stopReason: String(result.stopReason),
      output: out.slice(0, DELEGATE_AGGREGATE_CAP),
      truncated: out.length > DELEGATE_AGGREGATE_CAP,
      ...(ctx.signal.aborted ? { cancelled: true } : {}),
      ...(goal ? { goal } : {}),
    };
  } catch (err) {
    // A /cancel-driven clientSessionClose makes the pending send throw —
    // surface it as an explicit cancellation, not a generic failure.
    if (ctx.signal.aborted) {
      debug.log('agent.error', 'delegate-failed', {
        backend,
        cwd,
        taskChars: task.length,
        durationMs: Date.now() - startedAt,
        outputChars: out.length,
        reason: 'cancelled',
      }, { level: 'error' });
      return { backend, sessionId: rec.id, cancelled: true, output: out.slice(0, DELEGATE_AGGREGATE_CAP) };
    }
    recordAutonomousActionSafe({
      loop: 'delegate',
      action: `${backend} 위임 실패: ${task.slice(0, 80)}`,
      rationale: '코드 위임 시도(self-improving)',
      outcome: `실패: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
      refs: { backend, sessionId: rec.id },
    });
    debug.log('agent.error', 'delegate-failed', {
      backend,
      cwd,
      taskChars: task.length,
      durationMs: Date.now() - startedAt,
      outputChars: out.length,
      reason: 'delegate-send-failed',
    }, { level: 'error' });
    return { error: `위임 실행 실패(${backend}): ${err instanceof Error ? err.message : String(err)}`, partialOutput: out.slice(0, 2000) };
  } finally {
    lifetime?.removeEventListener('abort', onAbort);
  }
}
