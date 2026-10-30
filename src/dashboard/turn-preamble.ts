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
import { debug, redactSecretText } from '../debug/log.js';
import type { NativeToolCatalogEntry } from '../native-tool-catalog.js';
import { buildUniversalPreamble } from '../prompt-library/universal-preamble.js';
import { buildSeatBootSystemMessages, type SeatBootDeps } from './seat-boot-preamble.js';
import { buildPlanModeSystemMessages } from '../plan-mode/system-prompt.js';
import { buildImplDisciplineSystemMessages } from '../impl-discipline/index.js';
import { buildConcisenessSystemMessages } from '../prompt-library/chat-conciseness.js';
import {
  buildSessionRuntimeSystemMessages,
  buildSessionRuntimeTurnSystemMessages,
  buildResearchDateSystemMessage,
  type SessionTurnProfile,
} from '../session-runtime/index.js';
import { buildExecutionAskSystemMessages } from '../ask-user-question/index.js';
import { buildApprovalPolicySystemMessages } from '../code-edit/index.js';
import { buildSandboxEscalationSystemMessages } from '../shell-primitive/index.js';
import { elanousSelfAccessPrompt, investigationRecallAmbient } from '../agent/self-ambient.js';
import { sessionMemoryLayer, sessionSelfAmbientParts } from './turn-session-layers.js';
import { localRefGroundingAmbient } from '../agent/ref-grounding.js';
import {
  globalTaskNotificationQueue,
  renderTaskNotificationsXml,
} from '../agent/task-notification.js';
import type { getUserConfig } from '../user-config.js';
import { isNativeStructureEnabledForProvider, resolveActiveProvider } from '../user-config.js';
import { measureInputLagTurnStart } from '../tui/input-lag-probe.js';
import { resolveModelContextWindow } from '../models/context-window.js';
import { buildInstalledSkillCatalogMessage, type InstalledSkillSummary } from './skill-catalog-preamble.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { buildSelfHealthLine, type InstalledRecord, type SelfHealthErrors } from '../pty-shell/tui-run-state.js';
import type { PtyBuildIdentity } from '../pty-shell/pty-manifest.js';

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
  /** Active tool names for session-specific guidance (Wave 3,
   *  2026-05-04). When provided, the universal preamble emits per-tool
   *  one-liner directives (e.g. AskUserQuestion → use for tool-deny
   *  clarification). Pass `tools.map(t => t.name)` from the caller. */
  enabledTools?: readonly string[];
  /** Installed frontmatter summaries for the stable skill-routing prompt prefix. */
  skillCatalog?: readonly InstalledSkillSummary[];
  /** Active model context size, when known. Unknown models use the conservative helper default. */
  skillCatalogContextWindow?: number | null;
  /** Runtime-selected model can differ from the configured default model. */
  skillCatalogModelId?: string;
  /** 🪪 L1 자리 부트 카드를 싣나(`seat-boot-preamble.ts`). 대화형 TUI 호출부만 켠다 — 기본 꺼짐이라
   *  다른 호출부·시험은 셸의 `COORD_ID` 에 따라 출력이 갈리지 않는다. */
  seatBoot?: boolean | SeatBootDeps;
  /** Explicit controller provenance for tests and embedded callers. When
   *  omitted, the controller environment is used. */
  controlEnv?: { controller?: string; channels?: string };
  /** File-memory layer seam: a store root and env for scope resolution (tests), or false to omit it. */
  memory?: { root?: string; env?: NodeJS.ProcessEnv } | false;

  /** 🫀 매 턴 자기 건강 한 줄(TUI-SELF-HEALTH-LINE · 0.2.34) 재료. 판(실행 판 vs 설치본) 축은
   *  이 블록 없이도 tui-run-state 의 실물 판정(runningBuild ⊕ readCurrentInstallRecord)으로 매 턴
   *  나간다. `errors`·`creditUsage` 는 호출자가 집계한 값 — «직전 30분 창에서 어떤 이벤트를 자기
   *  오류로 세는지»·«크레딧 사용을 무엇으로 잴지» 는 미결 항목이라 이 빌더가 정하지 않는다. */
  selfHealth?: {
    /** 직전 30분 자기 오류 집계 — 없으면(undefined·null) 오류 축은 아예 말하지 않는다. */
    errors?: SelfHealthErrors | null;
    /** 크레딧 사용 재료(호출자가 만든 값) — 없으면 그 축은 생략된다. */
    creditUsage?: string;
    /** 재기동 명령에 얹을 대화 id — 생략하면 ctx.sessionId. */
    sessionId?: string;
    /** 새 판 안내 회차(stale-install-check notifiedCount 회차 문면) — 기본 1. */
    notifiedCount?: number;
    /** 판정 seam(시험 격리) — 기본은 실물(runningBuild·readCurrentInstallRecord·readCheckoutHead). */
    build?: () => PtyBuildIdentity;
    readInstalled?: () => InstalledRecord;
    readCheckoutHead?: (codeRoot: string) => string | undefined;
  };
}

/** Flag per-prompt system layers so the Codex Responses serializer keeps
 *  them out of the cached `instructions` prefix (TUI-PROMPT-CACHE-PREFIX). */
function markCacheVolatile(messages: readonly LLMMessage[]): LLMMessage[] {
  return messages.map((m) => (m.role === 'system' ? { ...m, cacheVolatile: true } : m));
}

export function buildControllerSystemMessage(controller: string, channels?: string): LLMMessage {
  return {
    role: 'system',
    content: `[제어 표면] 이 엘라누스 세션은 밖의 제어자 ${controller} 가 몰고 있다. 열린 관: ${channels || 'pty'}. 감독 메모로 들어온 지시는 이 제어자의 지시다. PTY 로 들어오는 입력도 사람이 아니라 이 제어자가 넣은 것일 수 있다.`,
  };
}

/** How old a git snapshot the TUI preamble may serve while it rebuilds in the background.
 *  Edits (post-Edit force refresh) and HEAD moves invalidate it earlier; the dashboard's
 *  5s git tick keeps it younger than this so an idle-then-type turn still hits. */
const DASHBOARD_GIT_SNAPSHOT_STALE_MS = 60_000;

/** TUI-TYPING-LAG-OBS 시험 seam — 이 ms 만큼 turn-preamble 을 «동기로» 막아 타이핑 지연을 일으킨다.
 *  운영 기본 0. 켜는 길 둘: ux-sim·단위 시험은 `setPreambleSyncBlockMsForTesting` · 격리 TUI 는
 *  env `ELANOUS_TEST_PREAMBLE_SYNC_BLOCK_MS`(⛔ test 우주에서만 읽는다 — 운영 우주에선 무시).
 *  test 우주 = 이 프로세스의 실효 뿌리가 운영 집이 아닌 것. `--test` 플래그만 보면 pty-drive 가
 *  `--test` 를 `--config-dir <격리 뿌리>` 로 바꿔 띄운 시험 자식에서 seam 이 안 켜진다. */
export const PREAMBLE_SYNC_BLOCK_ENV = 'ELANOUS_TEST_PREAMBLE_SYNC_BLOCK_MS';
let preambleSyncBlockOverrideMs: number | null = null;

export function setPreambleSyncBlockMsForTesting(ms: number | null): void {
  preambleSyncBlockOverrideMs = ms;
}

export function preambleSyncBlockMs(
  env: NodeJS.ProcessEnv = process.env,
  instanceRoot: () => string = effectiveInstanceRoot,
): number {
  if (preambleSyncBlockOverrideMs !== null) return Math.max(0, preambleSyncBlockOverrideMs);
  const raw = env[PREAMBLE_SYNC_BLOCK_ENV];
  if (!raw || instanceRoot() === prodInstanceRoot()) return 0;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** 일부러 이벤트 루프를 동기로 막는다(시험 seam). 시계를 돌며 도는 바쁜 루프 대신 `Atomics.wait` —
 *  CPU 를 태우지 않고, 시험이 시계를 가짜로 바꿔도 끝난다. */
function blockPreambleSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function buildDashboardTurnPreamble(
  ctx: DashboardTurnPreambleContext,
): LLMMessage[] {
  return measureInputLagTurnStart(() => {
    blockPreambleSync(preambleSyncBlockMs());
    return buildDashboardTurnPreambleUnmeasured(ctx);
  });
}

/** TURN-START-BLOCK-REST 1단계 — 빌더마다 걸린 ms(0.1ms 반올림)를 `chat.turn-preamble built` 의
 *  `builderMs` 칸에 싣는다. 시계는 빌더마다 앞뒤 한 번씩이고, `built` 이벤트가 안 나가는
 *  (`debug.enabled` 꺼짐) 턴에서는 재지 않는다. 이 함수의 빌더는 전부 동기라 잰 ms 가 곧
 *  이벤트 루프를 막은 시간이다(`builderMsKind: 'sync'`). */
type BuilderMs = Record<string, number>;

function timed<T>(ms: BuilderMs | null, name: string, fn: () => T): T {
  if (ms === null) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    ms[name] = Math.round((performance.now() - t0) * 10) / 10;
  }
}

function buildDashboardTurnPreambleUnmeasured(
  ctx: DashboardTurnPreambleContext,
): LLMMessage[] {
  const builderMs: BuilderMs | null = debug.enabled ? {} : null;
  const startedAt = builderMs === null ? 0 : performance.now();
  // This is the first stable block in the system preamble. Its cached content changes only
  // when the installed/visible skill list or model context budget changes.
  const skillCatalogBuild = ctx.skillCatalog
    ? timed(builderMs, 'skillCatalog', () => buildInstalledSkillCatalogMessage(
      ctx.skillCatalog!,
      ctx.skillCatalogContextWindow ?? resolveModelContextWindow(ctx.skillCatalogModelId ?? ctx.userConfig.llm.model),
    ))
    : null;
  const skillCatalogSystemMsgs = skillCatalogBuild?.message ? [skillCatalogBuild.message] : [];
  // Universal preamble — surface-agnostic anchor (AGENTS.md +
  // CLAUDE.md). Spread first so the project context lands BEFORE any
  // surface-specific guidance, mirroring Claude Code's Phase 0
  // ordering. Returns [] when neither anchor file exists, so the
  // spread is a no-op outside actual project repos (tests etc.).
  const universalPreamble = timed(builderMs, 'universal', () => buildUniversalPreamble({
    cwd: ctx.cwd,
    ...(ctx.modelFamily !== undefined ? { modelFamily: ctx.modelFamily } : {}),
    ...(ctx.enabledTools !== undefined ? { enabledTools: ctx.enabledTools } : {}),
  }));
  // 🪪 L1 — 자리 부트 카드(세션마다 한 번 만든 스냅샷: 안 읽은 우편·HANDOFF·예약·지난 세션 — `cli/seat-cli.ts` 공용 조립).
  //    새 세션 부팅·`/session new`·`/session clear` 는 `startSeatBootConversation` 이 스냅샷을 새로 만들어 «첫 턴 = 새 카드» 로 만든다.
  //    정체성(앵커) 바로 뒤. 자리가 아니면 [].
  const seatBoot = ctx.seatBoot;
  const seatBootSystemMsgs = seatBoot
    ? timed(builderMs, 'seatBoot', () => buildSeatBootSystemMessages(
      { cwd: ctx.cwd, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) },
      seatBoot === true ? {} : seatBoot,
    ))
    : [];
  const planModeSystemMsgs = timed(builderMs, 'planMode', () => buildPlanModeSystemMessages());
  const askSystemMsgs = timed(builderMs, 'ask', () => buildExecutionAskSystemMessages() as LLMMessage[]);
  const approvalSystemMsgs = timed(builderMs, 'approval', () => buildApprovalPolicySystemMessages() as LLMMessage[]);
  const sandboxSystemMsgs = timed(builderMs, 'sandbox', () => buildSandboxEscalationSystemMessages() as LLMMessage[]);
  // Session-scoped (built once, rebuilt on change) — see turn-session-layers.ts.
  const sessionKey = ctx.sessionId ?? 'tui';
  const memory = ctx.memory;
  const memorySystemMsgs = memory === false
    ? []
    : timed(builderMs, 'memory', () => sessionMemoryLayer({ sessionKey, cwd: ctx.cwd, ...(memory ?? {}) }));
  // TUI-TYPING-LAG — the snapshot is built twice per turn (dashboard ⊕ ACP) with 5+ git
  // subprocesses each; a recent one is served and rebuilt off the event loop instead.
  const gitSnapshotSystemMsgs = timed(builderMs, 'gitSnapshot', () => buildSessionRuntimeSystemMessages({
    cwd: ctx.cwd,
    gitSnapshotStaleMs: DASHBOARD_GIT_SNAPSHOT_STALE_MS,
  }));
  const turnProfile = ctx.turnProfile;
  // Keep the synchronous preamble on the already-resolved surface. Shared
  // research-intent routing and Bloom evidence guidance are added by core-turn.
  const researchTurn = turnProfile?.surface.id === 'research/agent';
  const surfaceSystemMsgs = turnProfile
    ? timed(builderMs, 'surface', () => buildSessionRuntimeTurnSystemMessages(turnProfile, ctx.userText))
    : ([] as LLMMessage[]);
  if (researchTurn) {
    surfaceSystemMsgs.push(buildResearchDateSystemMessage());
  }
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
    nativeTools = timed(builderMs, 'nativeTools', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { findNativeTool } = require('../native-tool-catalog.js') as typeof import('../native-tool-catalog.js');
      return [...new Map((ctx.enabledTools ?? [])
        .map(findNativeTool)
        .filter((tool): tool is NativeToolCatalogEntry => tool !== undefined)
        .map(tool => [tool.id, tool])).values()];
    });
  }
  const implDisciplineSystemMsgs = timed(builderMs, 'implDiscipline', () => buildImplDisciplineSystemMessages({
    text: ctx.userText,
  }, {
    nativeStructureEnabled,
    ...(nativeTools !== undefined ? { enabledTools: nativeTools } : {}),
  }) as LLMMessage[]);
  const concisenessSystemMsgs = timed(builderMs, 'conciseness', () => researchTurn
    ? [] as LLMMessage[]
    : buildConcisenessSystemMessages(ctx.userConfig.chat.conciseness) as LLMMessage[]);
  // ★ elanous 자기접근 규율 + 자기인지 ambient(P3 · 2026-07-13) — 텔레그램/디스코드
  //   (makeElanousAgentRunTurn)와 단일 출처(agent/self-ambient.ts). TUI 채팅에서도 미션
  //   진단("P2 왜 실패?")·자율 시스템 관측·회상이 규율+ambient+툴(self-ops family) 3박자로
  //   성립한다. fail-soft: ambient 조회 실패가 턴을 막지 않는다.
  let selfOpsSystemMsgs: LLMMessage[] = [];
  try {
    selfOpsSystemMsgs = timed(builderMs, 'selfOps', () => [
      elanousSelfAccessPrompt(ctx.sessionId),
      ...sessionSelfAmbientParts(sessionKey),
      investigationRecallAmbient(ctx.userText),
      localRefGroundingAmbient(ctx.userText),
    ]
      .filter(Boolean)
      .map((content): LLMMessage => ({ role: 'system', content })));
  } catch { /* fail-soft */ }
  // 🫀 매 턴 자기 건강 한 줄(TUI-SELF-HEALTH-LINE · 0.2.34) — 자기 관측 → 자기 인지의 사실 칸.
  //    판(실행 판 vs 설치본) 축은 tui-run-state 의 실물 판정(judgeBuildStaleness ⊕ readCurrentInstallRecord)을
  //    매 턴 소비하고, 오류·크레딧 축은 호출자가 집계한 재료(ctx.selfHealth)를 얹는다. fail-soft:
  //    판정이 깨져도 줄만 빠지고 턴은 간다.
  const selfHealth = ctx.selfHealth;
  const selfHealthSystemMsgs = timed(builderMs, 'selfHealth', (): LLMMessage[] => {
    try {
      const line = buildSelfHealthLine(selfHealth?.errors ?? undefined, {
        ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
        ...(selfHealth?.sessionId !== undefined ? { sessionId: selfHealth.sessionId } : {}),
        ...(selfHealth?.build !== undefined ? { build: selfHealth.build } : {}),
        ...(selfHealth?.readInstalled !== undefined ? { readInstalled: selfHealth.readInstalled } : {}),
        ...(selfHealth?.readCheckoutHead !== undefined ? { readCheckoutHead: selfHealth.readCheckoutHead } : {}),
        ...(selfHealth?.notifiedCount !== undefined ? { notifiedCount: selfHealth.notifiedCount } : {}),
        ...(selfHealth?.creditUsage !== undefined ? { creditUsage: selfHealth.creditUsage } : {}),
      });
      return line === null ? [] : [{ role: 'system', content: line }];
    } catch {
      return []; // fail-soft — 자기 건강 줄이 턴을 막지 않는다
    }
  });
  const controlEnv = ctx.controlEnv ?? {
    controller: process.env.ELANOUS_CONTROLLER,
    channels: process.env.ELANOUS_CONTROL_CHANNELS,
  };
  const controller = controlEnv.controller;
  const controllerSystemMsgs = controller
    ? timed(builderMs, 'controller', () => [buildControllerSystemMessage(controller, controlEnv.channels)])
    : [];
  // TUI-PROMPT-CACHE-PREFIX — only the universal anchor (AGENTS.md ·
  // CLAUDE.md · tool discipline) is stable for the life of a session. Every
  // other layer can change between prompts (boot card · memory · git
  // snapshot · plan/approval mode · per-userText guidance · self health), so
  // it is flagged `cacheVolatile`: the Codex serializer then keeps it out of
  // `instructions` and sends it as a developer item after the cached history.
  const preamble: LLMMessage[] = [
    ...skillCatalogSystemMsgs,
    ...universalPreamble,
    ...markCacheVolatile([
      ...seatBootSystemMsgs,
      ...planModeSystemMsgs,
      ...askSystemMsgs,
      ...approvalSystemMsgs,
      ...sandboxSystemMsgs,
      ...memorySystemMsgs,
      ...gitSnapshotSystemMsgs,
      ...surfaceSystemMsgs,
      ...selfOpsSystemMsgs,
      ...selfHealthSystemMsgs,
      ...controllerSystemMsgs,
      ...implDisciplineSystemMsgs,
      ...concisenessSystemMsgs,
    ]),
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
    timed(builderMs, 'taskNotifications', () => {
      // ACP may ask for a preamble while the session is idle. Keep queued
      // completion receipts for the next actual user/auto-wake turn.
      if (!ctx.userText.trim()) return;
      const notificationOnlyWake = /(?:^|\n)(?:Question: )?\[자동 재개\] 위임 끝: .+ \((?:done|error|aborted)\) — <task-notification> 의 결과를 읽고 이어서 처리$/u
        .test(ctx.userText);
      if (notificationOnlyWake) {
        preamble.push({ role: 'system', content: '[알림 전용 턴] 이것은 완료 알림을 전달한 비요청 status receipt다. 작업 요청으로 취급하지 말고 Agent 또는 SelfImplement 위임을 시작하지 않는다. 포함된 결과를 바탕으로 한 번의 간결한 상태 요약만 답하고 멈춘다. 결과가 전달되지 않았다면 결과가 아직 제공되지 않았다고 알리고 내용을 추측하지 않는다.' });
      }
      const pendingNotifications = ctx.sessionId
        ? globalTaskNotificationQueue.drainForParentSessionOrUnscoped(ctx.sessionId)
        : globalTaskNotificationQueue.drain();
      taskNotificationCount = pendingNotifications.length;
      if (pendingNotifications.length === 0) {
        if (notificationOnlyWake) {
          debug.log('tui.notify', 'notification-only-turn', { notificationCount: 0, resultAvailable: false });
        }
        return;
      }
      const taskNotificationsXml = renderTaskNotificationsXml(pendingNotifications, {
        statusReceipt: notificationOnlyWake,
      });
      if (taskNotificationsXml) {
        debug.log('tui.notify', notificationOnlyWake ? 'notification-only-turn' : 'notification-with-user-request', {
          notificationCount: pendingNotifications.length,
        });
        // Preserve bounded, secret-redacted evidence of the exact XML body
        // delivered to the model. This lets live TUI diagnosis distinguish
        // an opened turn from a notification whose fields were dropped.
        const safeXml = redactSecretText(taskNotificationsXml);
        const xmlPreview = safeXml.slice(0, 2_000);
        debug.log('tui.notify', 'notification-payload', {
          notificationCount: pendingNotifications.length,
          xmlChars: taskNotificationsXml.length,
          xmlPreview,
          xmlPreviewTruncated: safeXml.length > xmlPreview.length,
        }, { compact: { stringMax: 2_100 } });
        preamble.push({ role: 'user', content: taskNotificationsXml });
      }
    });
  } catch {
    // Fail-soft: a task-notification delivery failure must not block the turn.
  }

  if (debug.enabled && builderMs !== null) {
    const total = preamble.reduce((sum, m) => {
      const c = m.content;
      return sum + (typeof c === 'string' ? c.length : JSON.stringify(c).length);
    }, 0);
    debug.log('chat.turn-preamble', 'built', {
      hasTurnProfile: ctx.turnProfile != null,
      builderCounts: {
        universal: universalPreamble.length,
        ...(ctx.skillCatalog ? { skillCatalog: skillCatalogSystemMsgs.length } : {}),
        seatBoot: seatBootSystemMsgs.length,
        planMode: planModeSystemMsgs.length,
        ask: askSystemMsgs.length,
        approval: approvalSystemMsgs.length,
        sandbox: sandboxSystemMsgs.length,
        memory: memorySystemMsgs.length,
        gitSnapshot: gitSnapshotSystemMsgs.length,
        surface: surfaceSystemMsgs.length,
        selfOps: selfOpsSystemMsgs.length,
        selfHealth: selfHealthSystemMsgs.length,
        controller: controllerSystemMsgs.length,
        implDiscipline: implDisciplineSystemMsgs.length,
        conciseness: concisenessSystemMsgs.length,
      },
      // 실린 빌더만 키가 있다(seatBoot·memory·surface·nativeTools·controller 는 조건부로 안 불린다).
      builderMs,
      builderMsKind: 'sync',
      builderTotalMs: Math.round((performance.now() - startedAt) * 10) / 10,
      totalMessageCount: preamble.length,
      taskNotificationCount,
      skillCatalogTokens: skillCatalogBuild?.estimatedTokens ?? 0,
      skillCatalogBudgetTokens: skillCatalogBuild?.budgetTokens ?? 0,
      skillCatalogMode: skillCatalogBuild?.mode ?? 'not-provided',
      totalChars: total,
      userTextPreview: ctx.userText.length > 80 ? `${ctx.userText.slice(0, 80)}…` : ctx.userText,
    });
  }
  return preamble;
}
