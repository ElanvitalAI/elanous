// U3c Phase 5a — consolidates the dashboard turn loop's system-message
// builders into one sync helper shared by the ACP `getPreamble` callback
// and the plain-chat direct runtime entry point.
//
// Keeping both callers on this builder makes config and active-tool
// propagation identical while their wiring remains independently testable.
// All builders are sync, which keeps the `DashboardAcpBootDeps.
// getPreamble` contract (returns `readonly LLMMessage[]`, no Promise)
// intact.
//
// `turnProfile` is nullable because Phase 5a fires the getter at
// boot time with no active turn in flight (flag OFF, idle session) —
// the surface-system block is simply omitted in that case. Phase 5b
// populates `turnProfile` via the ACP turn ref before each `.send()`.

import type { LLMMessage } from '../llm.js';
import type { ModelFamily } from '../models/prompts.js';
import { debug } from '../debug/log.js';
import type { NativeToolCatalogEntry } from '../native-tool-catalog.js';
import { buildUniversalPreamble } from '../prompt-library/universal-preamble.js';
import { buildPlanModeSystemMessages } from '../plan-mode/system-prompt.js';
import { buildImplDisciplineSystemMessages } from '../impl-discipline/index.js';
import { buildConcisenessSystemMessages } from '../prompt-library/chat-conciseness.js';
import {
  buildSessionRuntimeSystemMessages,
  buildSessionRuntimeTurnSystemMessages,
  type SessionTurnProfile,
} from '../session-runtime/index.js';
import { buildExecutionAskSystemMessages } from '../ask-user-question/index.js';
import { buildApprovalPolicySystemMessages } from '../code-edit/index.js';
import { buildSandboxEscalationSystemMessages } from '../shell-primitive/index.js';
import { elanousSelfAccessPrompt, elanousSelfAmbientParts } from '../agent/self-ambient.js';
import { localRefGroundingAmbient } from '../agent/ref-grounding.js';
import {
  globalTaskNotificationQueue,
  renderTaskNotificationsXml,
} from '../agent/task-notification.js';
import type { getUserConfig } from '../user-config.js';
import { isNativeStructureEnabledForProvider, resolveActiveProvider } from '../user-config.js';

type UserConfig = ReturnType<typeof getUserConfig>;

export interface DashboardTurnPreambleContext {
  /** Current user prompt text. Drives impl-discipline + surface
   *  guidance selection. */
  userText: string;
  /** Session working directory. Drives the git-snapshot block. */
  cwd: string;
  /** Active turn profile (surface + selection mode). Omit when the
   *  getter fires outside a turn (Phase 5a boot-time idle). Phase 5b
   *  populates this via the dashboard's ACP turn-ref. */
  turnProfile?: SessionTurnProfile | null;
  /** Snapshot of the user config. Injected by the caller to keep
   *  this module decoupled from the live config singleton. */
  userConfig: UserConfig;
  /** Model family for the active provider. Drives codex-only behavioral
   *  addendums (fix L-1) inside the universal preamble. Omit to skip
   *  family-specific addendums. */
  modelFamily?: ModelFamily;
  /** Current request session ID. It is injected only while this preamble is built for the turn. */
  sessionId?: string;
  /** Catalog richness for non-dashboard callers; the essential dashboard passes false. */
  rich?: boolean;
  /** Active tool names for session-specific guidance (Wave 3,
   *  2026-05-04). When provided, the universal preamble emits per-tool
   *  one-liner directives (e.g. AskUserQuestion → use for tool-deny
   *  clarification). Pass `tools.map(t => t.name)` from the caller. */
  enabledTools?: readonly string[];
  /** Explicit controller provenance for tests and embedded callers. When
   *  omitted, the controller environment is used. */
  controlEnv?: { controller?: string; channels?: string };
}

export function buildControllerSystemMessage(controller: string, channels?: string): LLMMessage {
  return {
    role: 'system',
    content: `[제어 표면] 이 엘라누스 세션은 밖의 제어자 ${controller} 가 몰고 있다. 열린 관: ${channels || 'pty'}. 감독 메모로 들어온 지시는 이 제어자의 지시다. PTY 로 들어오는 입력도 사람이 아니라 이 제어자가 넣은 것일 수 있다.`,
  };
}

export function buildDashboardTurnPreamble(
  ctx: DashboardTurnPreambleContext,
): LLMMessage[] {
  // Universal preamble — surface-agnostic anchor (AGENTS.md +
  // CLAUDE.md). Spread first so the project context lands BEFORE any
  // surface-specific guidance, mirroring Claude Code's Phase 0
  // ordering. Returns [] when neither anchor file exists, so the
  // spread is a no-op outside actual project repos (tests etc.).
  const universalPreamble = buildUniversalPreamble({
    cwd: ctx.cwd,
    ...(ctx.modelFamily !== undefined ? { modelFamily: ctx.modelFamily } : {}),
    ...(ctx.enabledTools !== undefined ? { enabledTools: ctx.enabledTools } : {}),
  });
  const planModeSystemMsgs = buildPlanModeSystemMessages();
  const askSystemMsgs = buildExecutionAskSystemMessages() as LLMMessage[];
  const approvalSystemMsgs = buildApprovalPolicySystemMessages() as LLMMessage[];
  const sandboxSystemMsgs = buildSandboxEscalationSystemMessages() as LLMMessage[];
  const gitSnapshotSystemMsgs = buildSessionRuntimeSystemMessages({
    cwd: ctx.cwd,
  });
  const surfaceSystemMsgs = ctx.turnProfile
    ? buildSessionRuntimeTurnSystemMessages(ctx.turnProfile, ctx.userText)
    : ([] as LLMMessage[]);
  // ⭐⭐ `tools.nativeStructure` 는 «어느 provider 에 켤지»를 목록으로 고를 수 있다(2026-08-18).
  //   ⛔ 목록이 없으면 종전대로 «전 provider» — 기존 설정을 쓰는 사람의 값이 안 바뀐다.
  //   ⛔ `config.llm.provider` 를 그대로 읽지 않는다. 그것은 `'auto'` 일 수 있고,
  //     그러면 목록과 «영영 안 맞는다» ⇒ 해석은 `resolveActiveProvider` 한 자리에서만.
  //   ⛔ 설정 블록 자체가 «없을 수» 있다(부분 config·테스트 더블) ⇒ 없으면 종전대로 «꺼짐».
  //     종전 코드가 `?.` 로 갖고 있던 보호다 — 함수로 옮기며 잃으면 그 자리에서 터진다(실측).
  //     `resolveActiveProvider`에 기본 provider를 만들지 않고, 호출 «전»에 llm 블록을 판정한다.
  //     The focused fixture uses getUserConfig() to meet UserConfig; this guard preserves existing partial runtime doubles.
  const nativeStructureConfig = ctx.userConfig.tools?.nativeStructure;
  const nativeStructureEnabled = nativeStructureConfig !== undefined
    && ctx.userConfig.llm !== undefined
    && isNativeStructureEnabledForProvider(nativeStructureConfig, resolveActiveProvider(ctx.userConfig));
  let nativeTools: NativeToolCatalogEntry[] | undefined;
  if (nativeStructureEnabled) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { findNativeTool } = require('../native-tool-catalog.js') as typeof import('../native-tool-catalog.js');
    nativeTools = [...new Map((ctx.enabledTools ?? [])
      .map(findNativeTool)
      .filter((tool): tool is NativeToolCatalogEntry => tool !== undefined)
      .map(tool => [tool.id, tool])).values()];
  }
  const implDisciplineSystemMsgs = buildImplDisciplineSystemMessages({
    text: ctx.userText,
  }, {
    nativeStructureEnabled,
    ...(nativeTools !== undefined ? { enabledTools: nativeTools } : {}),
  }) as LLMMessage[];
  const concisenessSystemMsgs = buildConcisenessSystemMessages(
    ctx.userConfig.chat.conciseness,
  ) as LLMMessage[];
  // ★ elanous 자기접근 규율 + 자기인지 ambient(P3 · 2026-07-13) — 텔레그램/디스코드
  //   (makeElanousAgentRunTurn)와 단일 출처(agent/self-ambient.ts). TUI 채팅에서도 미션
  //   진단("P2 왜 실패?")·자율 시스템 관측·회상이 규율+ambient+툴(self-ops family) 3박자로
  //   성립한다. fail-soft: ambient 조회 실패가 턴을 막지 않는다.
  let selfOpsSystemMsgs: LLMMessage[] = [];
  try {
    selfOpsSystemMsgs = [elanousSelfAccessPrompt(ctx.sessionId), ...elanousSelfAmbientParts(ctx.userText), localRefGroundingAmbient(ctx.userText)]
      .filter(Boolean)
      .map((content): LLMMessage => ({ role: 'system', content }));
  } catch { /* fail-soft */ }
  const controlEnv = ctx.controlEnv ?? {
    controller: process.env.ELANOUS_CONTROLLER,
    channels: process.env.ELANOUS_CONTROL_CHANNELS,
  };
  const controllerSystemMsgs = controlEnv.controller
    ? [buildControllerSystemMessage(controlEnv.controller, controlEnv.channels)]
    : [];
  const preamble = [
    ...universalPreamble,
    ...planModeSystemMsgs,
    ...askSystemMsgs,
    ...approvalSystemMsgs,
    ...sandboxSystemMsgs,
    ...gitSnapshotSystemMsgs,
    ...surfaceSystemMsgs,
    ...selfOpsSystemMsgs,
    ...controllerSystemMsgs,
    ...implDisciplineSystemMsgs,
    ...concisenessSystemMsgs,
  ];
  // Capture exactly what the ACP path's getPreamble emits so we can
  // verify what codex actually sees as system prompt at turn-start.
  // Phase 5c-2 (PR #741) retired the legacy direct path; this is now
  // the ONLY system-prompt source for the dashboard turn loop. If the
  // model behaves as if it lacks project context, this log tells us
  // whether (a) a builder dropped out, (b) byte budget is the issue,
  // or (c) the model is simply ignoring what we sent.
  let taskNotificationCount = 0;
  try {
    const pendingNotifications = globalTaskNotificationQueue.drain();
    taskNotificationCount = pendingNotifications.length;
    const taskNotificationsXml = renderTaskNotificationsXml(pendingNotifications);
    if (taskNotificationsXml) {
      preamble.push({ role: 'user', content: taskNotificationsXml });
    }
  } catch {
    // Fail-soft: a task-notification delivery failure must not block the turn.
  }

  if (debug.enabled) {
    const total = preamble.reduce((sum, m) => {
      const c = m.content;
      return sum + (typeof c === 'string' ? c.length : JSON.stringify(c).length);
    }, 0);
    debug.log('chat.turn-preamble', 'built', {
      hasTurnProfile: ctx.turnProfile != null,
      rich: ctx.rich === true,
      builderCounts: {
        universal: universalPreamble.length,
        planMode: planModeSystemMsgs.length,
        ask: askSystemMsgs.length,
        approval: approvalSystemMsgs.length,
        sandbox: sandboxSystemMsgs.length,
        gitSnapshot: gitSnapshotSystemMsgs.length,
        surface: surfaceSystemMsgs.length,
        selfOps: selfOpsSystemMsgs.length,
        controller: controllerSystemMsgs.length,
        implDiscipline: implDisciplineSystemMsgs.length,
        conciseness: concisenessSystemMsgs.length,
      },
      totalMessageCount: preamble.length,
      taskNotificationCount,
      totalChars: total,
      userTextPreview: ctx.userText.length > 80 ? `${ctx.userText.slice(0, 80)}…` : ctx.userText,
    });
  }
  return preamble;
}
