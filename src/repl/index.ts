import { execFileSync as ownerExecFileSync } from 'node:child_process';
import { assignedVersions as ownerAssignedVersions } from '../release-loop/feature-store.js';
import { releaseLedgerRoot as ownerLedgerRoot } from '../instance/resolve.js';
import { openMsgStoreReadOnly as openOwnerMsgStore } from '../msg/msg-store.js';
import { judgeStop } from '../agent/stop-door.js';
import { sessionProviderAppliesToTurn } from './session-provider-turn.js';
import { buildInstalledPackQueryTool, dispatchInstalledPackQuery } from '../boot/installed-pack-query.js';
import { emitTurnLife } from '../debug/turn-life.js';
import { agentSpendLabel, safeAgentSummary, toolActivityTarget, toolResultFailed } from '../tui/chat/tool-activity.js';
import { getPlanState } from '../code-edit/plan-tool.js';
import { planWireFromState } from '../code-edit/plan-wire.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';
// Sticky-session REPL — multi-turn CLI conversation in one process.
//
// `elanous repl` keeps the boot cost (LLM SDK init, session load, debug
// log open, anchor + tree precompute) to one paid hit instead of N×
// the per-turn cost of `elanous chat`. The same session id threads
// through every turn so history accumulates, provider rotation
// between turns is fine, and tool dispatchers stay warm.
//
// Two input modes — both reach the same dispatch:
//   - **interactive** (TTY) — readline prompts the human turn by turn
//   - **scripted** (--scenario / stdin pipe) — a YAML file or JSONL
//     stream feeds prompts in sequence. CI / regression / LLM-driven
//     self-spawn all use this path.
//
// Meta-commands (lines starting with `:`) implement attach / provider
// switch / fork / save / exit etc. so the human keeps the affordances
// the dashboard's TUI surface offers, but inside a plain terminal
// REPL that pipes through ssh / tmux / VS Code terminal alike.

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath, isAbsolute, basename } from 'node:path';
import { getSessionCwd } from '../session/working-dir.js';
import * as ui from '../ui.js';
import { suggestProjectForFolder } from '../project/project-store.js';
import { runTurn } from '../session/chat.js';
import type { MeasuredTurnUsage } from '../session/turn-usage.js';
import { createTurnIdClaim, usageCompletionFrame } from './usage-completion.js';
import { withConfiguredWebSearch } from '../core-turn/configured-web-search.js';
import { getHarnessSpace } from '../harness/harness-space.js';
import { decideTuiCoreTurn, logTuiCoreTurnRoute } from './tui-core-turn.js';
import {
  ensureCliSession,
  sessionBudget,
} from '../session/chat.js';
import {
  resolveSessionId,
  loadSession,
  listSessions,
  setActiveSessionId,
  getActiveSessionId,
  parseMessageSource,
} from '../session/index.js';
import { getUserConfig, reloadUserConfig, saveUserConfig, jumpToRotationEntry } from '../user-config.js';
import type { UserConfig } from '../user-config/types.js';
import { setAmbientSessionId, debug } from '../debug/log.js';
import { NEXT_TUI_AGENT_SEND_TYPE } from '../agent/agent-steer.js';
import { buildInstalledSkillCatalogMessage, type InstalledSkillSummary } from '../skills/skill-catalog-preamble.js';
import { resolveModelContextWindow } from '../models/context-window.js';
import { decideSigintAction } from './sigint.js';
import { decideSessionStart, observeSessionStart } from '../session/session-start.js';
import { buildReplayTurnsFromSession } from './replay.js';
import type { ContentBlock } from '../llm.js';
import { prepareRequestImage } from '../image/request-image-normalize.js';
import { inspectActiveProvider } from '../provider-summary.js';
import { parse as parseYaml } from 'yaml';
import type { PendingTaskNotification } from '../agent/task-notification.js';
import { dispatchReplMessageTool, isReplMessageTool } from './ops-msg-bridge.js';
import { buildActiveDirectivesSystemMessages, buildSeatBootSystemMessages, buildSeatMemoryIndexSystemMessages, detectSeatTui, resolveSeatMemoryContext, resolveSessionMemoryStore, type SeatBootDeps } from '../seat/seat-boot-preamble.js';
import { SEAT_HAND_PULL_LINE, SEAT_ZERO_WORK_CONTINUE } from '../seat/seat-turn-prose.js';
import { seatRole, type SeatRole } from '../seat/seat-role.js';
import { coordinatorReasoningConfig } from '../seat/coordinator-reasoning.js';
import { lookupSeatOwners, type SeatOwnerReaders } from '../core-turn/seat-owner-lookup.js';
import type { WorkReference } from '../core-turn/seat-owner-check.js';
import { listChecklist } from '../release-loop/checklist.js';
import type { GraphProgressObservation } from '../graph-runner/graph-progress-observation.js';
import { installNextTuiSelfHealthTracker } from '../tui/chat/self-health-status.js';
import { bashApprovalFinding } from '../tool-runtime/bash-approval.js';
import { createReplGraphApprover, createReplPublishApprover, createReplShellApprover, dispatchNextTuiBash, type ShellApprovalIpcProcess } from '../tui-client/next-shell-approval.js';
import { createReplHarnessAsker, parseHarnessAskUserRound } from '../tui-client/next-harness-ask-user.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { isToolSearchCall, routeToolSearch } from '../skills/tools/tool-search-route.js';
import { buildCapabilitySearchTool, CAPABILITY_SEARCH_NAME, buildToolSearchTool, TOOL_SEARCH_NAME } from '../skills/tools/tool-search-spec.js';
import { agentResultStatus, type AgentDisplayEvent } from '../tui/core/agents.js';
import { createNextTuiMessageBlockEmitter } from './next-tui-message-blocks.js';
import { monotonicNowMs } from '../esc-abort-gate.js';
import { createPushNowRouter, createShellSnapshotRouter } from './shell-snapshot-router.js';
import { createNextTuiSteerInbox, createNextTuiSteerRouter } from './next-tui-steer.js';
import { setShellWatchdogStatusSink } from '../tool-runtime/shell-watchdog.js';
import { nextTuiPushNowDecision } from '../tui/core/queue.js';
import { setSessionTierOverride } from '../model-tier/session-override.js';
import { parseToolResultEnvelope } from '../chat/tool-render/result-text.js';
import type { AgentTask } from '../agent/types.js';
import { capsuleDoneFromAgentTask, encodeCapsuleFrame } from '../turn-capsule/capsule-frame.js';
import { createTurnCancelRouter } from '../turn-capsule/turn-cancel.js';

/** Private side channel for the next TUI. Ordinary REPL JSONL stdout is unchanged. */
const NEXT_TUI_BG_PREFIX = 'ELANOUS_TUI_BG_STATUS\t';
type NestedTask = Pick<AgentTask, 'id' | 'parentTaskId' | 'label' | 'definition' | 'state'>;

/** A completed descendant belongs to a turn only through its registered root Agent task. */
export function completedNestedAgents(tasks: readonly NestedTask[], roots: ReadonlySet<string>) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.filter((task) => {
    if (!task.parentTaskId || !['done', 'error', 'aborted'].includes(task.state)) return false;
    const seen = new Set([task.id]);
    let parent: string | undefined = task.parentTaskId;
    while (parent && !seen.has(parent)) {
      if (roots.has(parent)) return true;
      seen.add(parent);
      parent = byId.get(parent)?.parentTaskId;
    }
    return false;
  }).map((task) => ({ id: task.id, description: `↳ ${task.label ?? task.definition.name}`,
    status: task.state === 'done' ? 'done' as const : 'failed' as const }));
}
type ReplShellActivity =
  | { phase: 'start'; id: string; name: 'Bash' | 'RunShell'; startedAtMonotonicMs: number }
  | { phase: 'finish'; id: string; name: 'Bash' | 'RunShell' }
  | { phase: 'snapshot'; calls: Array<{ id: string; name: 'Bash' | 'RunShell'; startedAtMonotonicMs: number }> };
type ReplToolActivity =
  | { phase: 'start' | 'finish'; id: string; name: string; target?: string; summary?: string; spend?: string; failed?: boolean }
  | { phase: 'snapshot'; calls: Array<{ id: string; name: string; target?: string }> };

const shellSnapshotRouter = createShellSnapshotRouter();
const pushNowRouter = createPushNowRouter();
const steerRouter = createNextTuiSteerRouter();
// CAPSULE-B2 — the host cancels a turn without killing this child.
const turnCancelRouter = createTurnCancelRouter();
if (typeof process.send === 'function') process.on('message', (message: unknown) => {
  const heldBefore = turnCancelRouter.heldCount();
  if (turnCancelRouter.receive(message)) {
    // JUD #38560 ⓑ — a cancel before its turn listens (cold boot) is held, not lost.
    if (turnCancelRouter.heldCount() > heldBefore) emitTurnLife('turn-life:turn-cancel-held', { turnId: (message as { turnId: string }).turnId });
    return;
  }
  if (!shellSnapshotRouter.receive(message) && !pushNowRouter.receive(message)) steerRouter.receive(message);
});

export function createNextTuiBackgroundBridge(sessionId: string, bufferedCount: () => number) {
  if (process.env.ELANOUS_NEXT_TUI_BG_STATUS !== '1') return null;
  const { globalAgentRegistry } = require('../agent/registry.js') as typeof import('../agent/registry.js');
  const { globalTaskNotificationQueue } = require('../agent/task-notification.js') as typeof import('../agent/task-notification.js');
  const unregisteredPromises = new Set<string>();
  const backgroundTaskIds = new Set<string>();
  const ownedRootTaskIds = new Set<string>();
  let last = '';
  const emit = () => {
    const tasks = globalAgentRegistry.list();
    for (const task of tasks) unregisteredPromises.delete(task.id);
    for (const task of tasks) if (task.background) backgroundTaskIds.add(task.id);
    const running = tasks.filter((task) => task.background && (task.state === 'pending' || task.state === 'running')).length;
    const roster = tasks.filter((task) => backgroundTaskIds.has(task.id)).sort((left, right) => {
      const leftDone = left.state === 'done' || left.state === 'error' || left.state === 'aborted';
      const rightDone = right.state === 'done' || right.state === 'error' || right.state === 'aborted';
      return Number(leftDone) - Number(rightDone) || (leftDone && rightDone ? (left.finishedAt ?? 0) - (right.finishedAt ?? 0) : 0);
    }).map((task) => ({
      id: task.id, label: task.label ?? task.definition.name, state: task.state,
      ...(task.corrections ? { corrections: task.corrections } : {}),
    }));
    const nestedAgents = completedNestedAgents(tasks, ownedRootTaskIds);
    const frame = JSON.stringify({ sessionId, promised: unregisteredPromises.size > 0, running, pending: globalTaskNotificationQueue.size + bufferedCount(), tasks: roster, nestedAgents });
    if (frame === last) return;
    last = frame;
    process.stderr.write(`${NEXT_TUI_BG_PREFIX}${frame}\n`);
  };
  // OBSERVE-TURN-EVENT-LIFECYCLE — 하위(배경) Agent 종결 알림 도착: 관측만 남기고 방출은 그대로 emit 로.
  const done = globalAgentRegistry.onTaskDone(() => {
    try { emitTurnLife('turn-life:event-arrived', { source: 'subagent', arrivedAt: Date.now() }); } catch { /* observability is fail-open */ }
    emit();
  });
  // CAPSULE-B1-DONE-EVENT — each finished background root task also leaves as one `capsule-done` frame
  // (D12: the TUI can open a turn while idle). The notification drain below stays as is.
  const capsuleDone = watchCapsuleDone(sessionId, globalAgentRegistry, backgroundTaskIds);
  // CAPSULE-B5 — completions filed only in this child's queue (RunShell bg · self-implement run-stop) also leave as frames.
  const queueCapsules = (require('../turn-capsule/queue-bridge.js') as typeof import('../turn-capsule/queue-bridge.js'))
    .watchQueueCapsuleDone(sessionId, globalTaskNotificationQueue);
  // CAPSULE-A2 — a Bash call detached past its sync cap leaves through the same frame wire.
  const shellCapsules = (require('../turn-capsule/shell-capsule.js') as typeof import('../turn-capsule/shell-capsule.js'))
    .installShellCapsuleSink(sessionId, (event) => { process.stderr.write(encodeCapsuleFrame(event)); });
  // O1: watched lines cross the session boundary as progress; they are not completions.
  const stopShellWatch = (require('../turn-capsule/shell-watch-frame.js') as typeof import('../turn-capsule/shell-watch-frame.js'))
    .watchShellLineFrames(sessionId, globalTaskNotificationQueue, (frame) => { process.stderr.write(frame); });
  const onTaskStop = (message: unknown): void => {
    if (!message || typeof message !== 'object') return;
    const request = message as { type?: unknown; sessionId?: unknown; taskId?: unknown };
    if (request.type !== 'elanous.next-tui.task-stop' || request.sessionId !== sessionId || typeof request.taskId !== 'string') return;
    const known = backgroundTaskIds.has(request.taskId) ? globalAgentRegistry.get(request.taskId) : undefined;
    const verdict = judgeStop({
      kind: 'task',
      id: request.taskId,
      exists: known !== undefined,
      ended: known !== undefined && (known.state === 'done' || known.state === 'error' || known.state === 'aborted'),
      owner: known ? known.parentSessionId ?? sessionId : undefined,
      requester: sessionId,
    });
    if (verdict.stopped && known) globalAgentRegistry.abort(known.id);
    emit();
  };
  process.on('message', onTaskStop);
  // AGENT-STEER — the person's `/agent <name> <text>`: the same channel as the AgentSend seat tool.
  const onAgentSend = (message: unknown): void => {
    if (!message || typeof message !== 'object') return;
    const request = message as { type?: unknown; sessionId?: unknown; to?: unknown; body?: unknown };
    if (request.type !== NEXT_TUI_AGENT_SEND_TYPE || request.sessionId !== sessionId
      || typeof request.to !== 'string' || typeof request.body !== 'string') return;
    const { sendToAgent } = require('../agent/agent-steer.js') as typeof import('../agent/agent-steer.js');
    const outcome = sendToAgent(globalAgentRegistry, { to: request.to, body: request.body, from: 'human', ownerSessionId: sessionId });
    if (outcome.ok) backgroundTaskIds.add(outcome.taskId);
    else debug.log('agent.steer', 'unknown-target', { from: 'human', to: request.to, known: outcome.known.length }, { level: 'warn' });
    emit();
  };
  process.on('message', onAgentSend);
  const timer = setInterval(emit, 250);
  timer.unref();
  emit();
  return {
    beginTurn() {
      // A late descendant remains visible after its own turn settles, but
      // an old tree must not reappear once the next human turn begins.
      ownedRootTaskIds.clear();
      emit();
    },
    observeToolResult(name: string, args: Record<string, unknown>, result: unknown) {
      if (name !== 'Agent') return;
      const parsed = typeof result === 'string' ? parseToolResultEnvelope(result).value : result;
      if (!parsed || typeof parsed !== 'object') return;
      const spawned = parsed as { taskId?: unknown; background?: unknown };
      if (typeof spawned.taskId !== 'string') return;
      ownedRootTaskIds.add(spawned.taskId);
      if (spawned.background === true) backgroundTaskIds.add(spawned.taskId);
      if (args.run_in_background === true && spawned.background === true) unregisteredPromises.add(spawned.taskId);
      emit();
    },
    emit,
    dispose() { clearInterval(timer); done.dispose(); capsuleDone.dispose(); queueCapsules.dispose(); shellCapsules?.dispose(); stopShellWatch(); process.off('message', onTaskStop); process.off('message', onAgentSend); },
  };
}

type CapsuleRegistry = Pick<import('../agent/registry.js').AgentRegistry, 'onTaskDone' | 'onTaskStart' | 'onToolCall' | 'get'>
  & Partial<Pick<import('../agent/registry.js').AgentRegistry, 'onTaskResume'>>;

/** CAPSULE-B1 — one `capsule-done` frame per background root task of this session (start: one progress line).
 *  `background` is flipped back to foreground on completion (task-notification), so membership is also read from
 *  `knownBackground` (filled by the status bridge and the Agent tool result). Supplements get a frame too (a notice, never a turn). */
export function watchCapsuleDone(
  sessionId: string, registry: CapsuleRegistry, knownBackground: ReadonlySet<string>,
  write: (line: string) => void = (line) => { process.stderr.write(line); },
): { dispose(): void } {
  const emitted = new Set<string>();
  // ELN-CAPSULE-COMPLETION-SCOPED ②: supplements also leave a capsule-done frame — the TUI turns it into a queued
  // notice (capsule-done-knock never opens a turn), so an idle seat sees the result instead of nothing.
  const ours = (task: AgentTask): boolean => !task.parentTaskId
    && (task.parentSessionId === undefined || task.parentSessionId === sessionId)
    && (task.background === true || knownBackground.has(task.id));
  const started = registry.onTaskStart((task) => {
    if (!task.background || !ours(task)) return;
    write(encodeCapsuleFrame({ type: 'capsule-progress', capsuleId: task.id, kind: 'agent', sessionId, at: Date.now(),
      line: `${task.label ?? task.definition.name} · started` }));
  });
  const finished = registry.onTaskDone((task) => {
    if (emitted.has(task.id) || !ours(task)) return;
    const event = capsuleDoneFromAgentTask(task, sessionId);
    if (!event) return;
    emitted.add(task.id);
    write(encodeCapsuleFrame(event));
    emitTurnLife('turn-life:capsule-done-emitted', { sessionId, capsuleId: event.capsuleId, kind: event.kind, status: event.status,
      durationMs: event.endedAt - event.startedAt });
  });
  // B3 ask (#88867): a running background capsule's tool starts become its folded progress line — tool name and
  // sequence only; raw args and results never enter the frame.
  const toolCalls = registry.onToolCall((call) => {
    if (call.phase !== 'start' || emitted.has(call.agentId)) return;
    const task = registry.get(call.agentId);
    if (!task || !ours(task)) return;
    write(encodeCapsuleFrame({ type: 'capsule-progress', capsuleId: task.id, kind: 'agent', sessionId, at: call.ts,
      line: `${task.label ?? task.definition.name} · #${call.callIdx} ${call.tool}` }));
  });
  // AGENT-STEER — a resumed capsule finishes again: its new completion is a new frame.
  const resumed = registry.onTaskResume?.((task) => { emitted.delete(task.id); });
  return { dispose() { started.dispose(); finished.dispose(); toolCalls.dispose(); resumed?.dispose(); } };
}

/** REPL public entry — wires whichever input source the caller chose
 *  to the shared turn dispatcher. The CLI command (in src/index.ts)
 *  resolves config + flags then hands off here. */
export interface ReplOpts {
  /** Initial user-config snapshot. Reloaded inside REPL on `:reload`
   *  or after `:provider <label>`. */
  cfg: UserConfig;
  /** Authenticated Next host session; missing identity leaves board receipts unavailable. */
  memberBoardSession?: () => Promise<{ nexusUrl: string; sessionToken: string; appSlug?: string } | undefined> | { nexusUrl: string; sessionToken: string; appSlug?: string } | undefined;
  /** Resume an explicit session (id or unique prefix). When omitted,
   *  REPL creates a fresh session at boot. */
  initialSessionId: string | undefined;
  /** Force a fresh session even if active marker exists. */
  forceNew: boolean;
  /** `--continue`/`--resume` — 활성 세션 이어하기(명시). 대표 #73: 기본은 새 세션. */
  continueActive?: boolean;
  /** Enable the tool loop (Read/Grep/Bash/...). Default true — REPL
   *  is the agent surface; users opt out with --no-tools. */
  enableTools: boolean;
  /** Path to a YAML scenario file. Each `turns` entry runs as one
   *  REPL turn before the loop hands control back to stdin (or
   *  exits when --exit-after-scenario is set). */
  scenarioPath: string | undefined;
  /** Resume the user prompts from a previous session as a fresh
   *  scenario run (BACKLOG #5). Mutually exclusive with `scenarioPath`.
   *  When set, the REPL loads the named session, extracts its user
   *  prompts via `buildReplayTurnsFromSession`, and runs them through
   *  the same dispatcher as a YAML scenario. Use case: bug repro
   *  automation, provider comparison, fix verification. */
  replaySessionId?: string | undefined;
  /** Read JSONL turns from stdin (one JSON object per line; shape
   *  matches a single scenario turn). Mutually exclusive with TTY
   *  interactive mode — when stdin is not a TTY and no scenario is
   *  given, default to JSONL. */
  scriptedFromStdin: boolean;
  /** Emit one JSON line per turn instead of streaming text. Useful
   *  when REPL is driven from a parent process. */
  jsonOutput: boolean;
  /** Exit after the last scripted turn finishes. Default true for
   *  pure scenario runs, false when stdin is a TTY (the human
   *  expects the prompt to come back). */
  exitAfterScenario: boolean;
  /** CHAT-TOOLS-ENTRY-VIA-CORE-TURN — this REPL is the Next TUI host's child (set only by that launch:
   *  `src/tui-client/fast-repl-child.ts` and `repl --next-tui` from `src/tui-client/local-chat-turn.ts`). A structured
   *  caller flag: its tool turns take the core turn with the configured WebSearch. Absent = the plain REPL, unchanged. */
  nextTui?: boolean;
}

/** One scripted turn — used by both YAML scenarios and JSONL stdin
 *  streams. Schema designed to match the existing `repro --scenario`
 *  prompts entry where applicable. */
export interface ScenarioTurn {
  id?: string;
  prompt: string;
  /** Explicit structured references for this turn; never derived from prompt text. */
  workReferences?: unknown;
  /** Session tier carried from the Next TUI host to its persistent REPL child. */
  modelTier?: 'budget' | 'balanced' | 'best';
  /** Next TUI process-local choice; contains no credential material. */
  sessionProvider?: { provider: string; model?: string };
  /** Switch provider before this turn. Resolves through
   *  `rotationEntryLabel` (e.g. "opus" / "codex" / "gemini"). */
  rotate?: string;
  /** MSG-SOURCE-HIERARCHY: who sent this turn (structured; parsed, never guessed from the text). */
  from?: unknown;
  /** File paths to attach as image content blocks. Resolved
   *  relative to the scenario file (or cwd for stdin). */
  attachments?: string[];
  /** Per-turn assertion overrides — mirrors the eval-prompt
   *  `text_min_chars` / `reply_contains` style for forward-compat
   *  with regression scenarios. */
  asserts?: {
    text_min_chars?: number;
    reply_contains?: string[];
    reply_not_contains?: string[];
  };
}

interface ScenarioFile {
  description?: string;
  defaults?: { asserts?: ScenarioTurn['asserts'] };
  turns: ScenarioTurn[];
}

interface PendingAttachment {
  path: string;
  block: ContentBlock;
}

/** Build the REPL's tool catalog + dispatcher. Mirrors
 *  `buildCliAgentTools` in src/index.ts but lives here so the REPL
 *  module is self-contained when consumed in tests. */
/** Keep the isolated Next test session bound to the same app as a member connect session. */
export async function resolveNextTestVerifiedOwner(sessionFile: string): Promise<{ id: string; appSlug?: string } | undefined> {
  const fixture = JSON.parse(readFileSync(sessionFile, 'utf8')) as {
    nexusUrl?: string; sessionToken?: string; appSlug?: string;
  };
  const { resolveDashboardVerifiedOwner } = await import('../dashboard/plugin-route-adapter.js');
  return resolveDashboardVerifiedOwner({
    nexusUrl: fixture.nexusUrl ?? '', sessionToken: fixture.sessionToken, appSlug: fixture.appSlug,
  });
}

/** 자리 memory_save 시간 상한 — 호스트 요청기(`requestMemberBoardSession`)의 자체 시간 초과(2초)보다 짧게 둔다.
 *  그쪽이 시간 초과로 «세션 없음»(undefined)을 돌려주면 본부로 오판하므로, 그 전에 우리가 끊고 회원으로 본다. */
// 출처: `src/tui-client/next-member-board-session.ts` requestMemberBoardSession timeoutMs 2_000
const SEAT_MEMORY_AUDIENCE_TIMEOUT_MS = 1_500;

/** 회원 세션이 있나 — 회원 세션 칸이 «하나라도» 값이 있으면 member(반쯤 묶인 세션도 반출을 막는 쪽). 세션이 아예 없을 때만 hq-seat.
 *  던짐·시간 초과도 member. */
export async function resolveSeatMemoryAudience(
  memberBoardSession: ReplOpts['memberBoardSession'] | undefined,
  timeoutMs = SEAT_MEMORY_AUDIENCE_TIMEOUT_MS,
): Promise<'member' | 'hq-seat'> {
  if (!memberBoardSession) return 'hq-seat';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const session = await Promise.race([
      Promise.resolve().then(() => memberBoardSession()),
      new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); }),
    ]);
    if (session === 'timeout') return 'member';
    if (!session || typeof session !== 'object') return 'hq-seat';
    // nexusUrl 만·sessionToken 만 있는 반쯤 묶인 세션도 회원이다 — 묶임이 완전한지는 반출 판정의 근거가 아니다.
    return Object.values(session).some(value => value !== undefined && value !== null && value !== '') ? 'member' : 'hq-seat';
  } catch {
    return 'member';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// OP's coding tools remain searchable; only their full schemas leave the session prefix.
// Grep/Glob/ListDir/Read stay immediate on every seat surface (SEAT_IMMEDIATE_SEARCH_TOOLS in tier-flip).
const COORDINATOR_DEFERRED_TOOLS = new Set(['Edit', 'Write', 'AgentList', 'AgentOutput', 'AgentStop', 'memory_delete', 'memory_search', 'update_plan']);
const COORDINATOR_MAIL_PAGE_SIZE = 10;
const COORDINATOR_PANE_LINES = 20;

export function coordinatorMsgListArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (args.limit === undefined || args.limit === null || args.limit === 0) return { ...args, limit: COORDINATOR_MAIL_PAGE_SIZE };
  if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 1000) return args;
  return { ...args, limit: Math.min(args.limit, COORDINATOR_MAIL_PAGE_SIZE) };
}

export function coordinatorElsReadResult(args: Record<string, unknown>, result: string): string {
  if (args.action !== 'read') return result;
  try {
    const parsed = JSON.parse(result) as { ok?: boolean; message?: unknown };
    if (!parsed.ok || typeof parsed.message !== 'string') return result;
    const lines = parsed.message.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length <= COORDINATOR_PANE_LINES) return result;
    parsed.message = `[showing last ${COORDINATOR_PANE_LINES} lines]\n${lines.slice(-COORDINATOR_PANE_LINES).join('\n')}`;
    return JSON.stringify(parsed);
  } catch { return result; }
}

export function buildReplTools(options: {
  /** Only the structured Next TUI child can advertise the els tool. */
  readonly nextTui?: boolean;
  /** Explicit role for isolated profile tests; production resolves the registered seat. */
  readonly seatRole?: SeatRole;
  readonly onGraphProgress?: (event: GraphProgressObservation) => void;
  readonly sessionId?: string;
  /** One trusted user request/turn, distinct from the lifetime of the sticky REPL session. */
  readonly getRequestId?: () => string | undefined;
  /** CAPSULE-A2 — the TUI turn id, for turn-life correlation of shell capsules. */
  readonly getTurnId?: () => string | undefined;
  readonly shellApprovalProcess?: ShellApprovalIpcProcess;
  readonly dispatchBash?: (args: Record<string, unknown>, options: { cwd: string; signal?: AbortSignal; priorHumanApproval?: boolean }) => Promise<unknown>;
  readonly getSignal?: () => AbortSignal | undefined;
  /** An authenticated member session supplied by the Next host. */
  readonly memberBoardSession?: ReplOpts['memberBoardSession'];
  /** Injected route bridge for focused dispatcher regressions. */
  readonly pluginRuntime?: Pick<import('../cli/child-plugin-runtime.js').ChildPluginRuntimeContract, 'hostTools' | 'dispatchPluginTool'>;
  /** Test seam: fake Jev client for the seat memory_save write gate (production resolves config and key itself). */
  readonly seatMemoryJevDeps?: import('../memory-triage/jev-adapter.js').MemoryJevDeps;
  /** Test seam: the seat memory store this session uses (production detects it from the cwd and seat-state). */
  readonly seatMemoryContext?: { seat: string; dir: string };
} = {}): {
  specs: LLMToolSpec[];
  dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>;
} {
  // The Next chat REPL is a separate, sticky process: the TUI parent's runner
  // singleton is not inherited. Keep one registry for this child across turns.
  if (options.nextTui) {
    const runner = require('../shell-runner/dispatch.js') as typeof import('../shell-runner/dispatch.js');
    if (!runner.getShellRunnerDeps()) {
      const { getShellRegistry } = require('../shell-runner/registry.js') as typeof import('../shell-runner/registry.js');
      runner.setShellRunnerDeps({ registry: getShellRegistry() });
    }
  }
  const coordinator = options.nextTui === true && (options.seatRole ?? replSeatRole(getSessionCwd(), undefined)) === 'coordinator';
  const specs: LLMToolSpec[] = [];
  /** Either signal aborts; undefined when neither exists (callers keep their «no signal» path). */
  const combineSignals = (a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined =>
    a && b ? AbortSignal.any([a, b]) : (a ?? b);
  const dispatchByName = new Map<string, (args: Record<string, unknown>, callSignal?: AbortSignal) => Promise<unknown>>();
  if (options.nextTui) {
    const els = require('../els/els-control-tool.js') as typeof import('../els/els-control-tool.js');
    if (els.elsControlSocketPath()) {
      const spec = els.buildElsControlTool();
      specs.push(spec);
      dispatchByName.set(spec.name, async args => {
        const result = await els.dispatchElsControl(args);
        return coordinator ? coordinatorElsReadResult(args, result) : result;
      });
    }
  }
  const packQuery = buildInstalledPackQueryTool();
  specs.push(packQuery);
  dispatchByName.set(packQuery.name, args => dispatchInstalledPackQuery(args));
  const sr = require('../session-runtime/index.js') as typeof import('../session-runtime/index.js');
  const surface = sr.resolveSessionSurfaceProfile({ preferredSurfaceId: 'coding/turn' });
  for (const spec of sr.resolveDynamicSessionNativeToolSpecs({
    userText: '',
    defaultFamilyIds: surface.defaultNativeFamilyIds,
    surfaceId: surface.id,
  })) {
    specs.push(spec);
  }
  const core = (require('../domains/core-tools.js') as typeof import('../domains/core-tools.js')).buildCoreTools();
  for (const memoryTool of core.specs.filter(spec => spec.name === 'memory_recall' || spec.name === 'memory_save')) {
    if (specs.some(spec => spec.name === memoryTool.name)) continue;
    specs.push(memoryTool);
    dispatchByName.set(memoryTool.name, args => core.dispatch(memoryTool.name, args));
  }
  // 🧠 OP-MEMORY-PARITY (O6) — 자리 세션이면 memory_save 를 자리 저장소 판으로 바꾸고 memory_delete·memory_search 를 붙인다.
  //    자리가 아니면(사람 대화 TUI) 손대지 않는다 — 전역 memory_save 그대로.
  try {
    // MEMORY-STORE-SPLIT — CLI 와 같은 해석기(자리 → 저장소 프로젝트 → 전역). 전역이면 null(전역 memory_save 그대로).
    const sessionStore = options.seatMemoryContext ? null : resolveSessionMemoryStore(getSessionCwd());
    const seatMemory = options.seatMemoryContext ?? (sessionStore ? { seat: sessionStore.seat, dir: sessionStore.dir, ...(sessionStore.commonDir ? { commonDir: sessionStore.commonDir } : {}) } : null);
    if (seatMemory) {
      (require('../seat-memory/seat-memory-tools.js') as typeof import('../seat-memory/seat-memory-tools.js'))
        .applySeatMemoryTools(specs, dispatchByName, {
          ...seatMemory,
          // MEMORY-TRIAGE-NO-LLM ① — 출처 = 이 세션의 신뢰된 사용자 요청(턴). 없으면 옛 쓰기(그림자)로 남는다.
          getSourceEventId: () => {
            const requestId = options.getRequestId?.();
            return requestId && options.sessionId ? `repl:${options.sessionId}/${requestId}` : undefined;
          },
          // 회원 기억은 기본으로 Jev(외부)로 보내지 않는다. 함수가 «있는지»가 아니라 턴 시점 «실제 세션»으로 정한다
          // (next TUI 자식은 함수를 늘 넘긴다). 조회 실패·시간 초과는 회원으로 본다.
          getAudience: () => resolveSeatMemoryAudience(options.memberBoardSession),
          ...(options.seatMemoryJevDeps ? { jevDeps: options.seatMemoryJevDeps } : {}),
        });
    }
  } catch (error) {
    debug.log('memory', 'tools-skipped', { error: error instanceof Error ? error.message : String(error) });
  }
  // DECISION-GATE v2 reads the turn outcome from the plan state, so the model needs update_plan in this child:
  // it is registered in the tool runtime but no native family above advertises it to the REPL (self-proactive 1/4).
  if (!specs.some(spec => spec.name === 'update_plan')) {
    const planTool = require('../code-edit/plan-tool.js') as typeof import('../code-edit/plan-tool.js');
    specs.push(planTool.buildUpdatePlanTool());
    dispatchByName.set('update_plan', async args => (await planTool.dispatchUpdatePlan(args as Record<string, unknown>)).output);
  }
  // The ops ledger is a runtime family, so the native-only catalog above
  // cannot advertise it. Keep the REPL surface limited to seat mail.
  const ledger = require('../skills/tools/ops-ledger.js') as typeof import('../skills/tools/ops-ledger.js');
  const ask = require('../skills/tools/msg-ask.js') as typeof import('../skills/tools/msg-ask.js');
  specs.push(ledger.buildMsgListTool(), ledger.buildMsgPostTool(), ask.buildMsgAskTool(), ledger.buildMsgAckTool());
  // COMMITMENT-CLOSE — waker notices name this tool; tool search must find it here (#160639 · #160695).
  {
    const commitments = require('../commitment/close.js') as typeof import('../commitment/close.js');
    specs.push(commitments.buildCommitmentCloseTool());
    dispatchByName.set(commitments.COMMITMENT_CLOSE_TOOL_NAME, async args => commitments.dispatchCommitmentClose(args as Record<string, unknown>).output);
  }
  // HAND-RAISE-LADDER — every ✋ ends in one outcome (resolve · reject · escalate); the auto-escalation notice names this tool.
  {
    const hands = require('../skills/tools/hand-raise-tool.js') as typeof import('../skills/tools/hand-raise-tool.js');
    specs.push(hands.buildHandRaiseTool());
    dispatchByName.set(hands.HAND_RAISE_TOOL_NAME, async args => hands.dispatchHandRaise(args as Record<string, unknown>).output);
  }
  // OP-HANDLES-L2b — the one-step assignment door; coordinators reach for it instead of «assign via mail + check writers».
  {
    const assign = require('../skills/tools/seat-assign-tool.js') as typeof import('../skills/tools/seat-assign-tool.js');
    specs.push(assign.buildSeatAssignTool());
    dispatchByName.set(assign.SEAT_ASSIGN_TOOL_NAME, async args => (await assign.dispatchSeatAssign(args as Record<string, unknown>)).output);
  }
  // SESSION-AUTOPILOT — the structured switch (autopilot_set) and the person's goal stack, in every session.
  {
    const autopilot = require('../session-autopilot/autopilot-tool.js') as typeof import('../session-autopilot/autopilot-tool.js');
    for (const spec of autopilot.buildAutopilotTools()) {
      specs.push(spec);
      dispatchByName.set(spec.name, args => autopilot.dispatchAutopilotTool(spec.name, args, {
        cwd: getSessionCwd(), ...(options.sessionId ? { sessionId: options.sessionId } : {}) }));
    }
  }
  const bashMod = require('../skills/tools/index.js') as typeof import('../skills/tools/index.js');
  // CAPSULE-A2 — the chat child's Bash runs under the capsule policy.
  const dispatchBash = options.dispatchBash ?? ((args: Record<string, unknown>, opts: { cwd: string; signal?: AbortSignal }) => {
    const turnId = options.getTurnId?.();
    return bashMod.dispatchBashCapsule(args, opts, turnId ? { correlation: { turnId } } : {});
  });
  specs.push(bashMod.buildBashTool());
  const runShellMod = require('../skills/tools/shell.js') as typeof import('../skills/tools/shell.js');
  specs.push(runShellMod.buildRunShellTool());
  const shellApprover = createReplShellApprover(options.shellApprovalProcess ?? process as unknown as ShellApprovalIpcProcess);
  const graphApprover = createReplGraphApprover(options.shellApprovalProcess ?? process as unknown as ShellApprovalIpcProcess);
  const publishApprover = createReplPublishApprover(options.shellApprovalProcess ?? process as unknown as ShellApprovalIpcProcess);
  const harnessAsker = options.sessionId ? createReplHarnessAsker(
    options.shellApprovalProcess ?? process as unknown as ShellApprovalIpcProcess, options.sessionId) : null;
  if (options.sessionId) {
    specs.push({ name: 'HarnessAskUser',
      description: 'Ask the current human one interview round per user request with one or two questions and a short assumption list. The reply comes from the Next TUI composer; no answer means stop and preserve assumptions.',
      parameters: { type: 'object', properties: {
        questions: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
      }, required: ['questions', 'assumptions'], additionalProperties: false },
    });
    let interviewRequestId: string | undefined;
    let interviewUsed = false;
    dispatchByName.set('HarnessAskUser', async (args) => {
      const requestId = options.getRequestId?.();
      if (!requestId) return { status: 'unanswered', reason: 'request-scope-unavailable' };
      if (requestId !== interviewRequestId) {
        interviewRequestId = requestId;
        interviewUsed = false;
      }
      if (interviewUsed) return { status: 'unanswered', reason: 'interview-round-already-used' };
      const round = parseHarnessAskUserRound(args);
      if (!round) return { status: 'unanswered', reason: 'invalid-interview-round' };
      interviewUsed = true;
      const answer = harnessAsker ? await harnessAsker(round, options.getSignal?.()) : null;
      return answer === null ? { status: 'unanswered', reason: harnessAsker ? 'human-did-not-answer' : 'host-unavailable', assumptions: round.assumptions }
        : { status: 'answered', answer, assumptions: round.assumptions };
    });
  }
  const runBash = (args: Record<string, unknown>, signal?: AbortSignal, priorHumanApproval = false) =>
    dispatchBash(args, { cwd: getSessionCwd(), ...(signal ? { signal } : {}), priorHumanApproval });
  dispatchByName.set('Bash', async (args, callSignal) => {
    // ELN-SEAT-TURN-HARD-CAP ④: the seat turn cap aborts through the call's own signal (dctx.signal); the person's Esc
    // signal stays too — either one stops the shell child (11-18: the cap never reached a running Bash, +247 s).
    const signal = combineSignals(options.getSignal?.(), callSignal);
    const command = typeof args.command === 'string' ? args.command : '';
    const approvalFinding = bashApprovalFinding(command, getUserConfig().shell.bashApproval);
    if (approvalFinding) {
      return dispatchNextTuiBash({
        command,
        enabled: true,
        requiresApproval: true,
        approve: shellApprover,
        signal,
        dispatch: (priorHumanApproval) => runBash(args, signal, priorHumanApproval),
      });
    }
    return runBash(args, signal);
  });
  dispatchByName.set('RunShell', async (args, callSignal) => {
    const signal = combineSignals(options.getSignal?.(), callSignal);
    return runShellMod.dispatchRunShellCapsule((args.script !== undefined || args.check !== undefined) ? { ...args, approval: 'none' } : args, {
      signal, sessionId: options.sessionId, availableToolNames: specs.map(spec => spec.name),
      // Preserve the existing per-step prompt for local reads. A receipt for an
      // unlisted step is never execution authority: the spawn gate requires a signed grant.
      scriptApproval: async (step, stepSignal) => {
        const requiresApproval = runShellMod.scriptCommandPolicy(step) !== 'read-local' || args.network === 'inherit'
          || args.approval === 'always' || args.approval === 'first-time';
        if (!shellApprover) {
          const cost = ['eln', 'usage', 'runs', '--since', '30m', '--by', 'role', '--json'];
          const exactCost = step.length === cost.length && step.every((part, i) => part === cost[i]);
          const inbox = ['eln', 'msg', 'count', '--to', 'OP', '--json'];
          const exactInbox = step.length === inbox.length && step.every((part, i) => part === inbox[i]);
          const exactOp = step.length === 8 && step[0] === 'eln' && step[1] === 'ops' && step[2] === 'check-30m'
            && step[3] === '--previous-green' && /^(?:0|[1-9][0-9]{0,3})$/.test(step[4]!)
            && step[5] === '--expect-version' && /^[0-9]+\.[0-9]+\.[0-9]+(?:-dev\.[0-9]+)?$/.test(step[6]!)
            && step[7] === '--json';
          // RUNSHELL-SEARCH-PARITY — read-only search steps (rg · git grep · ast-grep · eln docs search) need no approver.
          const search = runShellMod.searchCommandPolicy(step) === 'read-local';
          return { allowed: !requiresApproval && (exactOp || exactCost || exactInbox || search), priorHumanApproval: false };
        }
        if (runShellMod.scriptCommandPolicy(step) !== 'read-local')
          return { allowed: true, priorHumanApproval: false };
        const promptRequired = args.network === 'inherit' || args.approval === 'always' || args.approval === 'first-time';
        const gate = await dispatchNextTuiBash({ command: step.join(' '), enabled: true, requiresApproval: promptRequired,
          approve: shellApprover, signal: stepSignal,
          dispatch: async (priorHumanApproval) => ({ priorHumanApproval }) });
        return 'error' in gate
          ? { allowed: false, priorHumanApproval: false }
          : { allowed: true, priorHumanApproval: gate.priorHumanApproval };
      },
    });
  });
  const appDeploy = require('../agent/app-deploy-plugin.js') as typeof import('../agent/app-deploy-plugin.js');
  const appDeploySpec = appDeploy.appDeployPluginSpec();
  specs.push(appDeploySpec);
  dispatchByName.set(appDeploySpec.name, (args) => appDeploy.runAppDeploy(args));
  const nextTestRoot = getElanousConfigDir();
  const nextTestSessionFile = resolvePath(nextTestRoot, 'next-member-session.test.json');
  const nextTestGraphFile = resolvePath(nextTestRoot, 'next-graph-results.test.json');
  const stampedStateDir = process.env.ELANOUS_STATE_DIR;
  const nextTestWorld = process.env.ELANOUS_TEST_FAKE_LLM === '1' && process.env.ELANOUS_NEXT_TUI_BG_STATUS === '1'
    && !!stampedStateDir && resolvePath(stampedStateDir) === resolvePath(nextTestRoot)
    && (require('../instance/resolve.js') as typeof import('../instance/resolve.js'))
      .resolveInstance({ stampedStateDir }).kind === 'test';
  const pluginBridge = options.pluginRuntime ?? (require('../cli/child-plugin-runtime.js') as typeof import('../cli/child-plugin-runtime.js'))
    .createChildPluginRuntimeContract({
      observeGraphProgress: options.onGraphProgress,
      requestConfirmation: async (prompt) => (await graphApprover?.(prompt))?.approved ?? false,
      // Timeout, a cancelled turn or a missing channel are not an owner refusal: callers hold the node instead.
      requestDecision: async (prompt: string, signal?: AbortSignal, decisionOptions?: { readonly timeoutMs?: number }) =>
        graphApprover ? await graphApprover(prompt, signal, decisionOptions) : { approved: false as const, reason: 'unavailable' as const },
      ...(publishApprover ? { requestPublishApproval: async (url: string, expiresAt: string, prompt: string, signal?: AbortSignal) => await publishApprover(url, expiresAt, prompt, signal) } : {}),
      // The host supplies only a private app session. Nexus remains the authority
      // for the owner; a missing, expired or rejected session stays anonymous.
      resolveVerifiedOwner: async () => {
        try {
          const session = await options.memberBoardSession?.();
          if (!session?.nexusUrl || !session.sessionToken) return undefined;
          const { resolveDashboardVerifiedOwner } = await import('../dashboard/plugin-route-adapter.js');
          return await resolveDashboardVerifiedOwner(session);
        } catch { return undefined; }
      },
      // An isolated fake-LLM universe may supply a member session. The owner ID
      // still comes only from the Nexus owner endpoint, never from this file.
      ...(nextTestWorld && existsSync(nextTestSessionFile)
        ? { resolveVerifiedOwner: async () => {
          return resolveNextTestVerifiedOwner(nextTestSessionFile);
        } } : {}),
      ...(nextTestWorld && existsSync(nextTestGraphFile)
        ? { dispatchGraph: async (_pluginId: string, graphId: string, _graphFile: string,
            args: Record<string, unknown>, context?: import('../tool-runtime/types.js').ToolRuntimeContext) => {
          if (!context?.verifiedOwner?.id) throw new Error('graph route requires a verified owner context');
          const fixtures = JSON.parse(readFileSync(nextTestGraphFile, 'utf8')) as Record<string, unknown>;
          if (!Object.hasOwn(fixtures, graphId)) throw new Error(`test graph fixture missing: ${graphId}`);
          let result = fixtures[graphId];
          if (result && typeof result === 'object'
            && (result as { status?: unknown }).status === 'awaiting-approval') {
            const pending = result as { runId?: unknown; designSha256?: unknown; packetSha256?: unknown; pendingNode?: unknown };
            if (pending.pendingNode !== 'approve' || typeof pending.runId !== 'string'
              || typeof pending.designSha256 !== 'string' || typeof pending.packetSha256 !== 'string'
              || !/^[a-f0-9]{64}$/u.test(pending.packetSha256)) throw new Error('Scene 5 graph has no bound spending gate');
            const designPath = args.ticketDesignPath;
            if (typeof designPath !== 'string' || !existsSync(designPath)
              || createHash('sha256').update(readFileSync(designPath)).digest('hex') !== pending.designSha256)
              throw new Error('Scene 5 pending graph does not match the submitted design');
            const packetFile = resolvePath(nextTestRoot, 'next-scene5-decision.test.json');
            if (!existsSync(packetFile)) throw new Error('Scene 5 decision packet missing');
            const { scene5DecisionPrompt } = await import('../tui-client/scene5-decision-consumer.js');
            const prompt = scene5DecisionPrompt(readFileSync(packetFile),
              { graphId, runId: pending.runId, designSha256: pending.designSha256, packetSha256: pending.packetSha256 });
            const outcome = graphApprover ? await graphApprover(prompt) : { approved: false as const, reason: 'unavailable' as const };
            result = outcome.approved || outcome.reason === 'declined'
              ? { graphId, runId: pending.runId, status: 'decision-recorded',
                decision: outcome.approved ? 'approved' : 'rejected', realGcpCalls: 0 }
              : { graphId, runId: pending.runId, status: 'awaiting-approval', approvalHeld: outcome.reason, realGcpCalls: 0 };
          }
          appendFileSync(resolvePath(nextTestRoot, 'next-graph-calls.test.jsonl'),
            `${JSON.stringify({ graphId, args, verifiedOwner: context.verifiedOwner.id, result })}\n`);
          return result;
        } } : {}),
    });
  // One merge helper for every turn that adds plugin routes (the daemon chat turn uses the same one).
  specs.push(...(require('../cli/child-plugin-runtime.js') as typeof import('../cli/child-plugin-runtime.js'))
    .routeOnlyHostToolSpecs(pluginBridge.hostTools, new Set(specs.map((spec) => spec.name))));
  if (!specs.some(spec => spec.name === TOOL_SEARCH_NAME)) specs.push(buildToolSearchTool());
  if (!specs.some(spec => spec.name === CAPABILITY_SEARCH_NAME)) specs.push(buildCapabilitySearchTool());
  // TUI-NEXT-QUEUE-AND-WAKE: the next TUI parent opens an IPC hop only for its own REPL children;
  // the classic ScheduleWakeup spec is advertised and each call is answered by the parent's scheduler.
  const wakeMod = require('../tui-client/next-wakeup.js') as typeof import('../tui-client/next-wakeup.js');
  const wakeup = wakeMod.createReplWakeupTool(process as unknown as import('../tui-client/next-wakeup.js').WakeupIpcProcess);
  if (wakeup) {
    specs.push(wakeup.spec);
    dispatchByName.set(wakeup.spec.name, wakeup.dispatch);
  }
  (require('../tui/sidetab/nl-tool.js') as typeof import('../tui/sidetab/nl-tool.js')).registerNextSidetabReplTool(specs, dispatchByName, process as unknown as import('../tui/sidetab/nl-tool.js').NextSidetabIpcProcess);
  if (coordinator) {
    for (let i = 0; i < specs.length; i++) {
      if (COORDINATOR_DEFERRED_TOOLS.has(specs[i]!.name)) specs[i] = { ...specs[i]!, coordinatorDefer: true };
    }
  }
  const planner = sr.createSearchPlannerState({ maxAutoNarrowCandidates: 2 });
  // APP-BUILD-DECLINE-NO-BYPASS-DEPLOY: after a declined app_build, shell deploy/host exposure in the same request is refused.
  const declineGuard = (require('../plugins/core/app-build-decline-guard.js') as typeof import('../plugins/core/app-build-decline-guard.js'))
    .createAppBuildDeclineTurnGuard(() => options.getRequestId?.());
  const dispatch = async (name: string, args: Record<string, unknown>, dctx?: { signal?: AbortSignal }): Promise<unknown> => {
    const callSignal = combineSignals(options.getSignal?.(), dctx?.signal);
    try {
      const bypassRefusal = declineGuard.refuse(name, args);
      if (bypassRefusal) return bypassRefusal;
      if (isToolSearchCall(name)) return routeToolSearch(args, specs, { surface: 'tui-next', requireQueryCoverage: name === CAPABILITY_SEARCH_NAME });
      const direct = dispatchByName.get(name);
      if (direct) return await direct(args, dctx?.signal);
      if (isReplMessageTool(name)) return await dispatchReplMessageTool(name, coordinator && name === 'MsgList' ? coordinatorMsgListArgs(args) : args);
      return await sr.dispatchSessionRuntimeTool(name, args, {
        // ELN-CAPSULE-COMPLETION-SCOPED ①: background Agent receipts carry this session (was unscoped → any session drained them).
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        // ELN-SEAT-TURN-HARD-CAP ④: Agent and the other session tools stop on the cap or Esc (was undefined).
        signal: callSignal,
        userText: '',
        modelFamily: undefined,
        searchPlannerState: planner,
        turnIndex: undefined,
        ptyDashboardOn: false,
        // Match the CLI agent path: native Agent fallback needs the parent's
        // catalog and dispatcher so children can actually use inherited tools.
        agentHostTools: specs,
        agentDispatchTool: dispatch,
        // ELN-SUBAGENT-INHERIT-SEAT-TOOLS: a seat's general-purpose child gets the seat's catalog, not the 5-tool CLI
        // allowlist. CLI specs (cwd-bound to the child) win on a name clash; seat-only tools (Msg*, RunShell, ElsControl, …)
        // route back through this parent dispatch, so mail is sent by the parent seat and RunShell keeps its capsule hold.
        inheritGeneralPurposeToolCatalog: true,
        buildChildToolCatalog: (childCwd: string) => {
          const cli = require('../cli/agent-cli.js') as typeof import('../cli/agent-cli.js');
          const child = cli.buildCliAgentTools(undefined, undefined, childCwd, {});
          const childNames = new Set(child.specs.map(spec => spec.name));
          const seatOnly = specs.filter(spec => !childNames.has(spec.name));
          const seatOnlyNames = new Set(seatOnly.map(spec => spec.name));
          return {
            ...child,
            specs: [...child.specs, ...seatOnly],
            dispatch: (toolName: string, toolArgs: Record<string, unknown>) => seatOnlyNames.has(toolName)
              ? dispatch(toolName, toolArgs) : child.dispatch(toolName, toolArgs),
          };
        },
        getToolRuntime: () => undefined,
        dispatchToolRuntime: async (n) => ({ error: `runtime unavailable in REPL: ${n}` }),
        dispatchPluginTool: async (toolName, toolArgs) => {
          const routed = await pluginBridge.dispatchPluginTool(toolName, toolArgs);
          declineGuard.observe(routed);
          if (!routed.ok) return routed;
          if (toolName === 'brief_today') {
            const handlerRef = pluginBridge.hostTools.find(tool => tool.name === toolName)?.handlerRef;
            const expectedGraphId = handlerRef?.replace(/^(?:\.\/)?graph:/, '') ?? '';
            if (!handlerRef || !/^(?:\.\/)?graph:/.test(handlerRef)) return routed;
            const { nextScene2BriefReceipt } = await import('./scene2-brief-receipt.js');
            const output = nextScene2BriefReceipt(routed.result, expectedGraphId);
            if (!output || !routed.result || typeof routed.result !== 'object') return routed;
            const { output: _oldOutput, ...graphResult } = routed.result as Record<string, unknown>;
            return { ok: true, result: { output, ...graphResult } };
          }
          if (toolName !== 'suggest_accept' || typeof toolArgs.suggestionId !== 'string') return routed;
          try {
            const session = await options.memberBoardSession?.();
            if (!session?.nexusUrl || !session.sessionToken) return routed;
            const { resolveDashboardVerifiedOwner } = await import('../dashboard/plugin-route-adapter.js');
            const owner = await resolveDashboardVerifiedOwner(session);
            if (!owner?.id) return routed;
            const handlerRef = pluginBridge.hostTools.find(tool => tool.name === toolName)?.handlerRef;
            if (!handlerRef || !/^(?:\.\/)?graph:/.test(handlerRef)) return routed;
            const { nextScene6BoardReceipt } = await import('./scene6-board-receipt.js');
            const output = await nextScene6BoardReceipt({ graph: routed.result,
              expectedGraphId: handlerRef.replace(/^(?:\.\/)?graph:/, ''), cardId: toolArgs.suggestionId,
              memberId: owner.id, nexusUrl: session.nexusUrl, sessionToken: session.sessionToken });
            if (!output || !routed.result || typeof routed.result !== 'object') return routed;
            const { output: _oldOutput, ...graphResult } = routed.result as Record<string, unknown>;
            return { ok: true, result: { output, ...graphResult } };
          } catch { return routed; }
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `dispatch failed: ${msg}` };
    }
  };
  return { specs, dispatch };
}

function buildAgentSystemPrompt(
  cfg: UserConfig,
  enabledToolNames: readonly string[],
  cwd: string,
  role?: SeatRole,
): string | undefined {
  try {
    const ulMod = require('../prompt-library/universal-preamble.js') as typeof import('../prompt-library/universal-preamble.js');
    const modelsMod = require('../models/prompts.js') as typeof import('../models/prompts.js');
    const modelId = cfg.llm.model;
    const modelFamily = modelId ? modelsMod.getModelFamily(modelId) : undefined;
    const universal = ulMod.buildUniversalPreamble({
      cwd,
      ...(modelFamily !== undefined ? { modelFamily } : {}),
      enabledTools: [...enabledToolNames],
      ...(role !== undefined ? { seatRole: role } : {}),
      // SEAT-TURN-FOLLOWUPS Q10 — space leads and kingdom seats get the leader card (federation.yaml ⊕ coord-tracks).
      ...(() => {
        try {
          const detection = detectSeatTui(cwd);
          const lead = detection ? (require('../seat/seat-leadership.js') as typeof import('../seat/seat-leadership.js')).liveSeatLeadership(detection.seat, cwd) : null;
          return lead ? { seatLeader: lead } : {};
        } catch { return {}; }
      })(),
      // ELN-PROMPT-CACHE-PIN — built once per session; the els block travels in the turn's volatile context.
      sessionPinned: true,
    });
    const joined = universal
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .filter(s => s.length > 0)
      .join('\n\n');
    return joined.length > 0 ? joined : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 새 TUI REPL 의 시스템 프롬프트 «한 곳» — 범용 preamble ⊕ 자리 부트 카드(TUI-SESSION-BOOT).
 *
 * 새 TUI(`src/tui/entry.ts` → `src/tui-client/local-chat-turn.ts`)는 `elanous repl --json --stdin-jsonl`
 * 자식으로 턴을 돌린다. 그래서 legacy 대시보드의 `buildDashboardTurnPreamble` 부트 경로는 지나지 않고
 * «여기»만 지난다 — 자리 역할·미읽음 수를 첫 턴의 모델 입력에 싣는 자리도 여기 하나뿐이다.
 *
 * 카드는 `seat/seat-boot-preamble.ts` 의 `buildSeatBootSystemMessages` 를 그대로 쓴다(새 주입 로직 없음).
 * 자리 판정이 서면 카드 한 장(대화마다 한 번 만든 같은 문면) · 자리가 아니면 빈 배열이라 주입 0건이다.
 * 도구 표면이 꺼져 있으면(`enabledToolNames === undefined`) 종전처럼 범용 preamble 은 빠지고 카드만 남는다.
 */
export function buildReplSystemPrompt(ctx: ReplSystemPromptContext): string | undefined {
  const parts = buildReplSystemPromptParts(ctx);
  const joined = [parts.stable ?? '', ...parts.volatile].filter(part => part.length > 0);
  return joined.length > 0 ? joined.join('\n\n') : undefined;
}

export interface ReplSystemPromptContext {
  cfg: UserConfig;
  /** 도구 표면이 꺼져 있으면 undefined — 그때도 자리 부트 카드는 실린다. */
  enabledToolNames: readonly string[] | undefined;
  cwd: string;
  sessionId?: string | undefined;
  /** 시험·임베디드 호출부용 시임 — 기본은 실제 홈·msg 원장·process.env. */
  seatBootDeps?: SeatBootDeps | undefined;
  /** Installed skill summaries are injectable for deterministic prompt tests. */
  skillCatalog?: readonly InstalledSkillSummary[] | undefined;
  skillCatalogContextWindow?: number | null | undefined;
  workReferences?: unknown;
  ownerReaders?: SeatOwnerReaders;
}

/** ELN-PROMPT-CACHE-PIN — the repl system prompt split by lifetime.
 *  `stable` = the cached prefix (skill catalog · universal preamble · app hint · seat boot card · seat memory index):
 *  the same bytes for the whole session. `volatile` = per-turn blocks («my els location» · owner check of this
 *  turn's work references) that go AFTER the history as the turn's volatile context, never into the instructions. */
export function buildReplSystemPromptParts(ctx: ReplSystemPromptContext): { stable: string | undefined; volatile: string[] } {
  return { stable: buildReplStableSystemPrompt(ctx), volatile: buildReplVolatileContext(ctx) };
}

function buildReplStableSystemPrompt(ctx: ReplSystemPromptContext): string | undefined {
  // SEAT-COORDINATOR-PROMPT-PROFILE — 자리 성격은 부트 카드와 같은 자리 판정(detectSeatTui) ⊕ 자리 원장 role 로 정한다.
  //   조율 자리(OP)면 코딩 lifecycle·트리·GPT-6 persist·앱 빌더 힌트 대신 조율자 프로필. 손 자리·비자리는 종전 그대로.
  const role = replSeatRole(ctx.cwd, ctx.seatBootDeps);
  const base = ctx.enabledToolNames === undefined
    ? undefined
    : buildAgentSystemPrompt(ctx.cfg, ctx.enabledToolNames, ctx.cwd, role);
  const skillToolsEnabled = ctx.enabledToolNames?.includes('skill_exec') === true
    && ctx.enabledToolNames.includes('elanous_skills_list');
  let skillCatalogText = '';
  if (skillToolsEnabled && role !== 'coordinator') {
    try {
      const catalog = ctx.skillCatalog ?? (() => {
        const skills = require('../skills/index.js') as typeof import('../skills/index.js');
        return skills.applySkillFilter(skills.getSkillIndex(), ctx.cfg.skills)
          .map(({ name, description }) => ({ name, description }));
      })();
      const built = buildInstalledSkillCatalogMessage(
        catalog,
        ctx.skillCatalogContextWindow ?? resolveModelContextWindow(ctx.cfg.llm.model),
      );
      skillCatalogText = built.message?.content ?? '';
      debug.log('repl.skill-catalog', 'built', {
        skillCount: built.skillCount, estimatedTokens: built.estimatedTokens,
        budgetTokens: built.budgetTokens, mode: built.mode,
      });
    } catch (error) {
      debug.log('repl.skill-catalog', 'failed', { reason: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    }
  }
  const card = buildSeatBootCardText(ctx);
  // 🧠 OP-MEMORY-PARITY (O6) — 세션 시작 자리 기억 색인(카드와 같은 대화 스냅샷 · 같은 대화 동안 바이트 고정).
  let seatMemoryIndex = '';
  try {
    seatMemoryIndex = buildSeatMemoryIndexSystemMessages(
      { cwd: ctx.cwd, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) }, ctx.seatBootDeps ?? {},
    ).map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n\n');
  } catch { /* 색인만 빠진다 */ }
  // ACTIVE-DIRECTIVES-BLOCK — 세션 시작 «살아 있는 지시»(같은 대화 스냅샷 · 안정 구역 · ≤1.5KB).
  let activeDirectives = '';
  try {
    activeDirectives = buildActiveDirectivesSystemMessages(
      { cwd: ctx.cwd, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) }, ctx.seatBootDeps ?? {},
    ).map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n\n');
  } catch { /* 블록만 빠진다 */ }
  const appCapabilityHint = ctx.enabledToolNames === undefined || role === 'coordinator' ? '' : '사용자가 시스템 설계·만들기·배포를 요청하면 엘라누스의 등록 도구로 요구사항, 아키텍처 문서·구성도·설계 PDF/도식, 프론트엔드·백엔드 API·DB 스키마/시드 코드와 로컬 실행·시험을 진행하라. 실제 배포는 제공된 app.publish@1/app-publish.action@1 capability와 소유자 검증·게시 승인을 사용하라. 회원 연결이 없거나 app.publish를 쓸 수 없으면 생성 서버를 127.0.0.1의 빈 31500~31599 포트에서 백그라운드 실행하고 tailscale serve status --json으로 해당 포트의 기존 매핑이 없는지 확인한 뒤 tailscale serve --bg --tls-terminated-tcp <선택포트> tcp://127.0.0.1:<선택포트>로 그 포트만 tailnet에 공유하라(443의 루트 경로와 기존 Serve 설정 변경 금지, 공개 인터넷 노출 금지). 실제 URL의 HTTP 200과 앱 화면을 확인한 뒤 URL·프로세스·serve 설정과 되돌리기 명령을 보고하고, 제공되지 않은 실행 기능은 가정하지 마라. 단계별 실제 파일·시험 결과·영수증과 반환된 tailnet URL을 보여 주고, URL의 실제 동작 확인 전 배포 완료를 주장하지 말라. app.publish 되돌리기는 해당 배포 ID·영수증 범위로, 로컬 운영자 배포 되돌리기는 tailscale serve --tls-terminated-tcp <선택포트> off와 보고한 프로세스 종료만 수행하라(serve reset 금지). app_build 실행 확인을 사용자가 거절했거나 응답이 없으면(APP_BUILD_DECLINED) 그 턴에서는 Bash 빌드·tailscale serve/funnel·공개 리스너·배포 CLI 등 다른 경로로 빌드·배포하지 말고 사용자에게 다음 행동을 물어라.';
  // SESSION-AUTOPILOT — one line: when the person's words are about the autopilot mode, call autopilot_set.
  let autopilotLine = '';
  try {
    const autopilot = require('../session-autopilot/autopilot-tool.js') as typeof import('../session-autopilot/autopilot-tool.js');
    if (ctx.enabledToolNames?.includes(autopilot.AUTOPILOT_TOOL_NAME)) autopilotLine = autopilot.AUTOPILOT_PROMPT_LINE;
  } catch { /* the line only drops out */ }
  const parts = [skillCatalogText, base ?? '', appCapabilityHint, card, seatMemoryIndex, activeDirectives, autopilotLine].filter(part => part.length > 0);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function buildReplVolatileContext(ctx: ReplSystemPromptContext): string[] {
  const out: string[] = [];
  // ELN-ELS-SELF-CONTEXT — «my els location» changes while the session runs; every turn carries the current block.
  try {
    const els = (require('../els/els-self-context.js') as typeof import('../els/els-self-context.js')).elsSelfContextVolatileText(ctx.cwd);
    if (els) out.push(els);
  } catch { /* the els block only drops out */ }
  // Every ordinary seat turn receives this reminder, not just the initial boot turn.
  // No work reference or owner is inferred from the user's prose or the seat name.
  let ownerCheck = '';
  try {
    const seatContext = resolveSeatMemoryContext(ctx.cwd, ctx.seatBootDeps ?? {});
    if (seatContext) {
      // SEAT-OWNER-CHECK-NO-BLOCK — a missing/unknown reference is not a reason to stop for a person.
      // The seat finds its own work; only a confirmed foreign owner leads to a handoff.
      const seat = seatContext.seat;
      ownerCheck = '## 조사 전 주인 확인\n일반 조사·구현을 시작하기 전에 현재 일의 구조화된 칸·PR·우편 참조와 최신 주인 정본을 확인하라. '
        + `참조가 없거나 주인 조회가 unknown이면 멈추거나 사람을 부르지 말고 내 일을 직접 찾는다: \`eln release checklist status --version <현재 판> --owner ${seat} --json\` 의 내 노랑 칸과 \`eln msg list --to ${seat}\` 의 미읽음 우편을 읽고 맨 위 일로 바로 진행하라. `
        + `${SEAT_ZERO_WORK_CONTINUE} ` + '다른 자리가 주인으로 확인된 일이면 주인에게 조율하고 중복 조사를 시작하지 마라. 이 지침은 인가 판정이 아니다.';
      // HAND-PULL-FIRST — a hand seat pulls `eln work next` when its cell is done (never waits for an assignment).
      try { if (seatRole(seat) === 'hand') ownerCheck += ` ${SEAT_HAND_PULL_LINE}`; } catch { /* role unknown: no hand line */ }
      ownerCheck += '\n' + buildTurnOwnerResult(seatContext.seat, ctx.workReferences, ctx.ownerReaders);
    }
  } catch { /* seat detection unavailable: do not invent an identity */ }
  if (ownerCheck) out.push(ownerCheck);
  // COACH-CONTEXT-AUTO-INJECT — the WORLD block (facts + coach delta) for opted-in seats (default OP) on every turn.
  try {
    const seatContext = resolveSeatMemoryContext(ctx.cwd, ctx.seatBootDeps ?? {});
    if (seatContext) {
      const world = (require('../op-world/op-world.js') as typeof import('../op-world/op-world.js')).worldBlockForSeatTurn(seatContext.seat);
      if (world) out.push(world);
    }
  } catch { /* the WORLD block only drops out */ }
  // SESSION-AUTOPILOT — while ON, the decision-autonomy paragraph + the person's goals ride the turn's volatile tail.
  try {
    const ap = require('../session-autopilot/autopilot.js') as typeof import('../session-autopilot/autopilot.js');
    const goalsMod = require('../session-autopilot/goals.js') as typeof import('../session-autopilot/goals.js');
    const file = ap.autopilotStateFile(ctx.cwd);
    const apState = ap.readAutopilotState(file);
    const paragraph = ap.autopilotPolicyParagraph(apState, goalsMod.readGoals(goalsMod.autopilotGoalsFile(file)) ?? []);
    if (paragraph) out.push(paragraph);
    // AUTOPILOT-DYNAMIC-GOAL-FEED — the effective goal rides FIRST as one fixed-id block (same goal = same bytes · replaced, never stacked).
    const feed = require('../session-autopilot/dynamic-goal.js') as typeof import('../session-autopilot/dynamic-goal.js');
    return feed.withGoalFeed(out, apState?.on ? feed.goalFeedBlock(apState.derived) : null);
  } catch { /* the paragraph only drops out */ }
  return out;
}

/** ELN-PROMPT-CACHE-PIN — one session's pinned system prompt. The stable part is built on the first turn of a
 *  session and reused byte-for-byte until the session id, cwd or tool roster changes (a new session). Instruction
 *  files (AGENTS.md · AGENTS.local.md · DESIGN.md) are therefore read once per session; an edit made mid-session is
 *  logged as deferred and applies in the next session. The volatile part is rebuilt every turn. */
export function createReplSystemPromptPin(
  fingerprint: (cwd: string) => string = (cwd) => (require('../prompt-library/universal-preamble.js') as typeof import('../prompt-library/universal-preamble.js')).projectAnchorFingerprint(cwd),
): (ctx: ReplSystemPromptContext) => { stable: string | undefined; volatile: string[] } {
  let pinned: { key: string; stable: string | undefined; anchors: string; deferredLogged: string | null } | null = null;
  return (ctx) => {
    const key = [ctx.sessionId ?? '', ctx.cwd, (ctx.enabledToolNames ?? ['<no-tools>']).join(',')].join('\u0000');
    if (pinned === null || pinned.key !== key) {
      const anchors = safeFingerprint(fingerprint, ctx.cwd);
      const stable = buildReplStableSystemPrompt(ctx);
      pinned = { key, stable, anchors, deferredLogged: null };
      debug.log('repl.prompt-cache', 'stable-prefix-pinned', {
        sessionId: ctx.sessionId ?? null, cwd: ctx.cwd, stableChars: stable?.length ?? 0,
      });
      return { stable, volatile: buildReplVolatileContext(ctx) };
    }
    const anchors = safeFingerprint(fingerprint, ctx.cwd);
    if (anchors !== pinned.anchors && anchors !== pinned.deferredLogged) {
      pinned.deferredLogged = anchors;
      debug.log('repl.prompt-cache', 'anchor-change-deferred', {
        sessionId: ctx.sessionId ?? null, cwd: ctx.cwd, appliesAt: 'next-session',
      });
    }
    return { stable: pinned.stable, volatile: buildReplVolatileContext(ctx) };
  };
}

function safeFingerprint(fingerprint: (cwd: string) => string, cwd: string): string {
  try { return fingerprint(cwd); } catch { return ''; }
}

/** Turn references are explicit JSON data. A cell additionally requires its exact release version. */
export function buildTurnOwnerResult(seat: string, input: unknown, readers?: SeatOwnerReaders): string {
  const unknown = '[주인 조회 결과] unknown — 확인된 다른 주인 없음 · 막힘 아님. 내 노랑 칸·미읽음 우편에서 맨 위 일을 직접 골라 진행.';
  if (!Array.isArray(input) || input.length === 0 || input.length > 32) return unknown;
  const refs: WorkReference[] = [];
  const versions = new Map<string, string>();
  for (const value of input) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown;
    const r = value as Record<string, unknown>;
    if (r.kind === 'cell' && typeof r.id === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(r.id)
      && typeof r.version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(r.version)) {
      if (versions.has(r.id) && versions.get(r.id) !== r.version) return unknown;
      versions.set(r.id, r.version); refs.push({ kind: 'cell', id: r.id, version: r.version });
    } else if (r.kind === 'pr' && typeof r.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.repository)
      && typeof r.number === 'number' && Number.isSafeInteger(r.number) && r.number > 0) {
      refs.push({ kind: 'pr', repository: r.repository, number: r.number });
    } else if (r.kind === 'mail' && typeof r.id === 'string' && /^[1-9][0-9]{0,14}$/.test(r.id)) {
      refs.push({ kind: 'mail', id: r.id });
    } else return unknown;
  }
  const actualReaders: SeatOwnerReaders = readers ?? {
    checklistVersion: id => {
      if (versions.has(id)) return versions.get(id)!;
      const found = ownerAssignedVersions().filter(v => /^0\.3\.\d+$/.test(v))
        .filter(v => listChecklist(v, ownerLedgerRoot()).items.some(item => item.id === id));
      return found.length === 1 ? found[0]! : null;
    },
    readChecklist: version => listChecklist(version, ownerLedgerRoot()),
    listChecklists: () => ownerAssignedVersions().filter(v => /^0\.3\.\d+$/.test(v)).map(v => listChecklist(v, ownerLedgerRoot())),
    readPullRequest: (repository, number) => JSON.parse(ownerExecFileSync('gh', ['pr', 'view', String(number), '--repo', repository, '--json', 'number,body'], { encoding: 'utf8', timeout: 10000 })),
    readMail: id => { const store = openOwnerMsgStore(); try { return store.getMessage(id); } finally { store.close(); } },
  };
  try {
    const result = lookupSeatOwners(seat, refs, actualReaders);
    // Conflict is not a confirmed owner. Keep it unknown at the turn boundary.
    const rows = result.references.map(r => ({ reference: r.reference,
      status: r.status === 'conflict' ? 'unknown' : r.status,
      owners: r.status === 'conflict' || r.status === 'unknown' ? [] : r.owners }));
    const status = rows.some(r => r.status === 'unknown') ? 'unknown' : result.status;
    return `[주인 조회 결과] ${JSON.stringify({ status, references: rows })} (참고용, 인가 아님)`;
  } catch { return unknown; }
}

/** 이 REPL 이 앉은 자리의 성격(자리 원장 role). 자리가 아니거나 판정 실패면 undefined(종전 프롬프트). */
function replSeatRole(cwd: string, deps: SeatBootDeps | undefined): SeatRole | undefined {
  try {
    const detection = detectSeatTui(cwd, {
      ...(deps?.home !== undefined ? { home: deps.home } : {}),
      ...(deps?.env !== undefined ? { env: deps.env } : {}),
    });
    const role = detection ? seatRole(detection.seat) : null;
    if (role) debug.log('repl.seat-role', 'resolved', { seat: detection?.seat ?? null, role });
    return role ?? undefined;
  } catch (error) {
    debug.log('repl.seat-role', 'failed', { error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
    return undefined;
  }
}

/** 자리 부트 카드 문면(system 메시지 0~1개를 이어 붙인 것). 자리가 아니면 ''. */
function buildSeatBootCardText(ctx: {
  cwd: string;
  sessionId?: string | undefined;
  seatBootDeps?: SeatBootDeps | undefined;
}): string {
  try {
    return buildSeatBootSystemMessages(
      { cwd: ctx.cwd, ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}) },
      ctx.seatBootDeps ?? {},
    )
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .filter((text) => text.length > 0)
      .join('\n\n');
  } catch (error) {
    // 카드 오류가 턴을 막지는 않지만, 조용히 자리 문맥을 잃지 않도록 실패를 기록한다.
    debug.log('dashboard.seat-boot', 'card-error', {
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

/** IMAGE-REQUEST-BUDGET — normalize image attachments (2048 px · JPEG/WebP re-encode) and add the resize notice the
 *  model reads (upstream codex image_resize_notice). A dropped image becomes a text block naming its path. */
async function prepareAttachmentBlocks(
  attachments: readonly PendingAttachment[],
  onDropped: (note: string) => void,
): Promise<ContentBlock[]> {
  const imageCount = attachments.filter((a) => a.block.type === 'image').length;
  const blocks: ContentBlock[] = [];
  const notices: string[] = [];
  let index = 0;
  for (const attachment of attachments) {
    if (attachment.block.type !== 'image') { blocks.push(attachment.block); continue; }
    index += 1;
    const prepared = await prepareRequestImage(Buffer.from(attachment.block.base64, 'base64'), attachment.path, {
      mediaType: attachment.block.mediaType, index, total: imageCount, where: 'user message',
    });
    blocks.push(prepared.block);
    if (prepared.notice) notices.push(prepared.notice);
    if (prepared.droppedNote) onDropped(prepared.droppedNote);
  }
  for (const notice of notices) blocks.push({ type: 'text', text: notice });
  return blocks;
}

function loadAttachment(rawPath: string, baseDir: string): PendingAttachment | null {
  const resolved = isAbsolute(rawPath) ? rawPath : resolvePath(baseDir, rawPath);
  if (!existsSync(resolved)) {
    ui.error(`attach failed — not found: ${resolved}`);
    return null;
  }
  const ext = resolved.toLowerCase().split('.').pop() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    const base64 = readFileSync(resolved).toString('base64');
    const mediaType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const block: ContentBlock = { type: 'image', mediaType, base64 };
    return { path: resolved, block };
  }
  // Non-image — feed as text content for now (LLM treats inlined text
  // as part of the user message). Future: handle PDF/audio via the
  // ACP NormalizedAttachment pipeline.
  const text = readFileSync(resolved, 'utf-8');
  const block: ContentBlock = {
    type: 'text',
    text: `[attached: ${basename(resolved)}]\n\n\`\`\`\n${text}\n\`\`\``,
  };
  return { path: resolved, block };
}

async function runOneTurn(
  cfg: UserConfig,
  sessionId: string,
  userText: string,
  pendingAttachments: PendingAttachment[],
  tools: ReturnType<typeof buildReplTools> | undefined,
  systemPrompt: string | undefined,
  jsonOutput: boolean,
  /** The caller's structured Next TUI flag (`ReplOpts.nextTui`) — never inferred from env. */
  nextTui: boolean,
  nextTuiDelivery?: { pending: PendingTaskNotification[] },
  onJsonDelta?: (delta: string) => void,
  onJsonStatus?: (line: string) => void,
  onJsonReplace?: (fullText: string) => void,
  onJsonAgent?: (event: AgentDisplayEvent) => void,
  onJsonMessageBlock?: (block: import('../conv-substrate/message-block.js').MessageBlock) => void,
  onJsonShellActivity?: (event: ReplShellActivity) => void,
  signal?: AbortSignal,
  shellSnapshotTurnId?: string,
  onJsonToolActivity?: (event: ReplToolActivity) => void,
  onPushNowRequest?: (requestId: string, phase: 'probe' | 'commit', activeTools: string[]) => void,
  /** MSG-SOURCE-HIERARCHY: who sent this turn's text (persisted on the user message). */
  from?: import('../session/index.js').MessageSource,
  /** SEAT-HUMAN-GOAL-PIN ④ — 부모(TUI) 소유 핀(payload) — child 교체/재기동 뒤 복구. */
  parentPinnedGoal?: string,
  workReferences?: unknown,
  /** ELN-PROMPT-CACHE-PIN — this turn's volatile context (els location · owner check · self-health): sent after
   *  the history, outside the cached system prefix. */
  turnVolatileContext?: readonly string[],
): Promise<{ reply: string; provider: string; model: string | null; durationMs: number; logPath: string | null; measuredUsage?: MeasuredTurnUsage; goalComplete?: boolean; goalStopReason?: string; goalCompletionVia?: string }> {
  const startedAt = Date.now();
  const seatContext = resolveSeatMemoryContext(getSessionCwd());
  if (seatContext && workReferences !== undefined) {
    const { handoffForeignOwner } = await import('./seat-owner-handoff.js');
    const handoff = await handoffForeignOwner({ seat: seatContext.seat, workReferences, evidence: userText,
      lookup: buildTurnOwnerResult,
      post: async args => { await dispatchReplMessageTool('MsgPost', args); },
    });
    if (handoff) return { reply: handoff, provider: cfg.llm.provider, model: cfg.llm.model ?? null,
      durationMs: Date.now() - startedAt, logPath: null };
  }
  let memorySaveFailed = false;
  (require('../tui/persistent-user-memory.js') as typeof import('../tui/persistent-user-memory.js'))
    .rememberExplicitTuiUserFact(userText, undefined, () => { memorySaveFailed = true; });
  if (memorySaveFailed) {
    return { reply: '기억을 저장하지 못했습니다. 저장소 상태를 확인한 뒤 다시 요청해 주세요.',
      provider: cfg.llm.provider, model: cfg.llm.model ?? null, durationMs: Date.now() - startedAt, logPath: null };
  }
  const replyChunks: string[] = [];
  // IMAGE-REQUEST-BUDGET — every attached image is downscaled/re-encoded before it joins the request; one that still
  // cannot fit is sent as its path with a visible note, never failing the turn.
  const userImages = pendingAttachments.length > 0
    ? await prepareAttachmentBlocks(pendingAttachments, (note) => {
      if (jsonOutput) onJsonStatus?.(note);
      else ui.info(note);
    })
    : [];
  if (!jsonOutput) {
    process.stdout.write('  ');
  }
  // CHAT-TOOLS-ENTRY-VIA-CORE-TURN (JUD-B TUI clause · OP #84368) — a Next TUI tool turn takes the core turn like
  // `chat --tools` (#38246): structured `coreTurn` flag, WebSearch added when a search provider is configured (the
  // research route needs a web tool in the pool). Goal loop · harness child · no-tools keep their existing path.
  //   Only the Next TUI child (the caller's structured `nextTui` flag): the plain `elanous repl` keeps its old path —
  //   no coreTurn, no added WebSearch, no new route record (Terra #38386 r1 mustFix).
  //   CHAT-GOAL-LOOP-DEFAULT-OFF(0.3.33) — a TUI turn (human or seat) never arms the goal loop: no config switch,
  //   no sentence verdict. Only explicit-goal callers (chat --goal-loop · dev --implement · PWA :agent) arm it.
  const coreTurnDecision = !nextTui ? undefined : decideTuiCoreTurn({
    hasTools: (tools?.specs.length ?? 0) > 0,
    harnessChild: getHarnessSpace() !== null,
  });
  const turnTools = tools && coreTurnDecision?.coreTurn ? withConfiguredWebSearch(tools, 'tui') : tools;
  const planCalls: Array<{ outcome: string; elapsedMs: number }> = [];
  // Archon-port T1.2 (2026-05-08) — apply user-config `chat.toolDeny`
  // to the REPL tool roster. Pre-T1.2 the REPL ignored toolDeny.
  let replToolSpecs = turnTools?.specs;
  if (replToolSpecs && cfg.chat.toolDeny.length > 0) {
    const { applyToolPolicy } = require('../tool-runtime/tool-policy.js') as typeof import('../tool-runtime/tool-policy.js');
    replToolSpecs = applyToolPolicy(replToolSpecs, { deny: cfg.chat.toolDeny }) ?? replToolSpecs;
  }
  // The classic dashboard has its own turn preamble. The next TUI's sticky
  // REPL must deliver this child's completed tasks on the next parent turn.
  let nextTuiNotifications = '';
  if (nextTuiDelivery) {
    const { globalTaskNotificationQueue, renderTaskNotificationsXml } =
      require('../agent/task-notification.js') as typeof import('../agent/task-notification.js');
    // CAPSULE-K3-d — only this session's receipts (+ unscoped legacy), never a sibling session's.
    const { drainNextTuiNotifications } = require('../turn-capsule/session-drain.js') as typeof import('../turn-capsule/session-drain.js');
    nextTuiDelivery.pending.push(...drainNextTuiNotifications(globalTaskNotificationQueue, sessionId));
    nextTuiNotifications = renderTaskNotificationsXml(nextTuiDelivery.pending);
  }
  // Completion output is untrusted task data. Carry it as a user-role content
  // block for this call, leaving the human prompt and system prompt intact.
  if (nextTuiNotifications) userImages.unshift({ type: 'text', text: nextTuiNotifications });
  // 🧠 OP-MEMORY-PARITY (O6) — 자리 세션 턴 회상: 이 글(사람·우편)에 맞는 자리 기억을 배경 블록으로 싣는다(추가 모델 호출 0).
  //    시스템 프롬프트가 아니라 이번 호출의 사용자 역할 텍스트 블록 — 캐시 접두를 흔들지 않는다.
  try {
    const recall = (require('../seat-memory/seat-memory-layers.js') as typeof import('../seat-memory/seat-memory-layers.js'))
      .seatMemoryRecallText({ cwd: getSessionCwd(), userText, sessionId });
    if (recall) userImages.unshift({ type: 'text', text: recall });
  } catch { /* 회상만 빠진다 */ }
  const surfaceRunId = onJsonMessageBlock ? randomUUID() : undefined;
  const messageBlocks = onJsonMessageBlock ? createNextTuiMessageBlockEmitter({
    sessionId, runId: surfaceRunId!, emit: onJsonMessageBlock,
  }) : undefined;
  const activeShellCalls = new Map<string, { id: string; name: 'Bash' | 'RunShell'; startedAtMonotonicMs: number }>();
  const activeToolCalls = new Map<string, { id: string; name: string; target?: string }>();
  const onShellSnapshotSignal = (): void => {
    onJsonShellActivity?.({ phase: 'snapshot', calls: [...activeShellCalls.values()] });
    onJsonToolActivity?.({ phase: 'snapshot', calls: [...activeToolCalls.values()] });
  };
  const stopShellSnapshotListener = (onJsonShellActivity || onJsonToolActivity) && shellSnapshotTurnId
    ? shellSnapshotRouter.listen(shellSnapshotTurnId, onShellSnapshotSignal)
    : undefined;
  const stopPushNowListener = onPushNowRequest && shellSnapshotTurnId
    ? pushNowRouter.listen(shellSnapshotTurnId, ({ requestId, phase }) => onPushNowRequest(requestId, phase, [...activeToolCalls.values()].map((call) => call.name)))
    : undefined;
  // A200 — input typed during this turn joins the next model request (tool-result boundary), not the turn end.
  const steerTurnId = onPushNowRequest ? shellSnapshotTurnId : undefined;
  const steerInbox = steerTurnId
    ? createNextTuiSteerInbox(sessionId, (steerIds) => {
      process.stdout.write(`${JSON.stringify({ event: 'steer-applied', turnId: steerTurnId, steerIds })}\n`);
    })
    : undefined;
  const stopSteerListener = steerInbox && steerTurnId
    ? steerRouter.listen(steerTurnId, (request) => {
      if (request.kind === 'steer') steerInbox.push(request.steerId, request.text, request.urgent === true, request.seatMail, request.attachments ?? [], process.cwd());
      else steerInbox.retract(request.steerIds);
    })
    : undefined;
  let result: Awaited<ReturnType<typeof runTurn>>;
  const coordinator = nextTui && replSeatRole(getSessionCwd(), undefined) === 'coordinator';
  try {
    result = await runTurn({
    userConfig: coordinatorReasoningConfig(cfg, coordinator),
    disableSimpleQuestionFastRoute: coordinator,
    sessionId,
    // SEAT-HUMAN-GOAL-PIN ④: 부모(TUI) 소유 핀(payload) — child 저장소보다 우선, 교체/재기동 뒤 복구.
    ...(parentPinnedGoal !== undefined ? { parentPinnedGoal } : {}),
    userText,
    ...(surfaceRunId ? { surfaceRunId } : {}),
    utteranceSurface: 'tui',
    ...(from ? { from } : {}),
    systemPrompt,
    ...(turnVolatileContext && turnVolatileContext.length > 0 ? { turnVolatileContext } : {}),
    // ELN-PROMPT-CACHE-PIN — one tool set per session: no per-message warm preload of deferred tools.
    stableToolSet: true,
    userImages: userImages.length > 0 ? userImages : undefined,
    ...(process.env.ELANOUS_TEST_FAKE_LLM === '1' && Number.isFinite(Number(process.env.ELANOUS_TEST_FAKE_LLM_IDLE_TIMEOUT_MS))
      && Number(process.env.ELANOUS_TEST_FAKE_LLM_IDLE_TIMEOUT_MS) > 0
      ? { llmOpts: { streamIdleTimeoutMs: Number(process.env.ELANOUS_TEST_FAKE_LLM_IDLE_TIMEOUT_MS) } }
      : {}),
    onDelta: (d) => {
      if (jsonOutput) {
        replyChunks.push(d);
        onJsonDelta?.(d);
      }
      else process.stdout.write(d);
    },
    onReplaceText: (fullText) => {
      if (jsonOutput) {
        replyChunks.splice(0, replyChunks.length, fullText);
        onJsonReplace?.(fullText);
      } else {
        process.stdout.write(`\n\n  [근거 반영된 답변]\n  ${fullText}\n`);
      }
    },
    onStatusLine: (line) => { onJsonStatus?.(line); messageBlocks?.status(line); },
    onGoalInterim: (text, iteration) => messageBlocks?.progress(text, [`목표 단계 ${iteration || 1} 완료`]),
    onReasoning: (event) => { if (event.kind === 'summary_delta') messageBlocks?.thought(event.delta, true); },
    tools: replToolSpecs,
    dispatchTool: turnTools?.dispatch,
    ...(coreTurnDecision?.coreTurn
      ? { coreTurn: true, onResearchPlanSettled: (info: { outcome: string; elapsedMs: number }) => { planCalls.push(info); } }
      : {}),
    ...(signal ? { signal } : {}),
    onToolCall: (call) => {
      messageBlocks?.toolCall(call);
      if (jsonOutput && onJsonToolActivity) {
        const activeCall = { id: call.id, name: call.name, target: toolActivityTarget(call.name, call.args) };
        activeToolCalls.set(call.id, activeCall);
        onJsonToolActivity({ phase: 'start', ...activeCall });
      }
      if (call.name === 'Agent') onJsonAgent?.({ phase: 'start', id: call.id,
        ...(typeof call.args.description === 'string' ? { description: call.args.description } : {}) });
      if (jsonOutput && onJsonShellActivity && (call.name === 'Bash' || call.name === 'RunShell')) {
        const activeCall: { id: string; name: 'Bash' | 'RunShell'; startedAtMonotonicMs: number } = {
          id: call.id, name: call.name as 'Bash' | 'RunShell', startedAtMonotonicMs: monotonicNowMs(),
        };
        activeShellCalls.set(call.id, activeCall);
        onJsonShellActivity({ phase: 'start', ...activeCall });
      }
      if (!jsonOutput) {
        const args = JSON.stringify(call.args);
        const argsPreview = args.length > 100 ? args.slice(0, 100) + '…' : args;
        process.stdout.write(`\n  ⏺ ${call.name}(${argsPreview})\n  `);
      }
    },
    onToolResult: (call) => {
      messageBlocks?.toolResult(call);
      if (jsonOutput && onJsonToolActivity) {
        activeToolCalls.delete(call.id);
        const agentSummary = call.name === 'Agent' ? safeAgentSummary(call.result) : undefined;
        const agentSpend = call.name === 'Agent' ? agentSpendLabel(call.result) : undefined;
        onJsonToolActivity({ phase: 'finish', id: call.id, name: call.name, ...(agentSummary ? { summary: agentSummary } : {}), ...(agentSpend ? { spend: agentSpend } : {}),
          ...(toolResultFailed(call.result) ? { failed: true } : {}) });
      }
      if (call.name === 'Agent') onJsonAgent?.({ phase: 'finish', id: call.id, status: agentResultStatus(call.result) });
      if (jsonOutput && onJsonShellActivity && (call.name === 'Bash' || call.name === 'RunShell')) {
        activeShellCalls.delete(call.id);
        onJsonShellActivity({ phase: 'finish', id: call.id, name: call.name });
      }
      if (!jsonOutput) {
        let preview: string;
        if (typeof call.result === 'string') preview = call.result;
        else if (call.result && typeof call.result === 'object' && 'output' in call.result) {
          preview = String((call.result as { output: unknown }).output);
        } else {
          preview = JSON.stringify(call.result);
        }
        preview = preview.replace(/\s+/g, ' ').trim();
        if (preview.length > 160) preview = preview.slice(0, 160) + '…';
        process.stdout.write(`     ↳ ${preview}\n  `);
      }
    },
    });
  } finally {
    if (coreTurnDecision) logTuiCoreTurnRoute(coreTurnDecision, replToolSpecs?.some(spec => spec.name === 'WebSearch') ?? false, planCalls);
    stopShellSnapshotListener?.();
    stopPushNowListener?.();
    stopSteerListener?.();
    // Undelivered steer stays in the parent's queue and leaves as the next turn.
    steerInbox?.finish();
  }
  // A failed turn keeps the buffered notifications for the next JSONL prompt.
  nextTuiDelivery?.pending.splice(0);
  const reply = jsonOutput ? replyChunks.join('') : '';
  const logPath = (() => {
    try {
      const status = debug.status?.();
      return status?.path ?? null;
    } catch { return null; }
  })();
  if (!jsonOutput) {
    process.stdout.write('\n');
    ui.info(`[turn done · ${result.provider}${result.model ? '/' + result.model : ''} · ${sessionBudget(sessionId)}]`);
  }
  return {
    reply: reply || result.text,
    provider: result.provider,
    model: result.model ?? null,
    durationMs: Date.now() - startedAt,
    logPath,
    ...(result.measuredUsage ? { measuredUsage: result.measuredUsage } : {}),
    ...(result.goalComplete ? { goalComplete: true } : {}),
    ...(result.goalStopReason ? { goalStopReason: result.goalStopReason } : {}),
    ...(result.goalCompletionVia ? { goalCompletionVia: result.goalCompletionVia } : {}),
  };
}

function loadScenarioFromYaml(path: string): ScenarioFile {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as Partial<ScenarioFile>;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.turns)) {
    throw new Error(`scenario file lacks 'turns' array: ${path}`);
  }
  return {
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    defaults: parsed.defaults,
    turns: parsed.turns,
  };
}

function applyAsserts(
  reply: string,
  asserts: ScenarioTurn['asserts'] | undefined,
  defaults: ScenarioTurn['asserts'] | undefined,
  turnId: string,
): string[] {
  const failures: string[] = [];
  const merged = { ...(defaults ?? {}), ...(asserts ?? {}) };
  if (typeof merged.text_min_chars === 'number' && reply.length < merged.text_min_chars) {
    failures.push(`${turnId}: text ${reply.length} < ${merged.text_min_chars}`);
  }
  for (const needle of merged.reply_contains ?? []) {
    if (!reply.includes(needle)) failures.push(`${turnId}: reply missing "${needle}"`);
  }
  for (const needle of merged.reply_not_contains ?? []) {
    if (reply.includes(needle)) failures.push(`${turnId}: reply unexpectedly contains "${needle}"`);
  }
  return failures;
}

/** Apply meta-commands. Returns true when the line was consumed (no
 *  prompt to dispatch); false when the line is an ordinary prompt. */
async function handleMetaCommand(
  line: string,
  ctx: {
    cfg: UserConfig;
    sessionIdRef: { current: string };
    pendingAttachments: PendingAttachment[];
    rl: ReadlineInterface;
    cwd: string;
    onExit: () => void;
  },
): Promise<{ consumed: boolean; cfgUpdate?: UserConfig }> {
  if (!line.startsWith(':')) return { consumed: false };
  const [cmd, ...args] = line.slice(1).trim().split(/\s+/);
  switch (cmd) {
    case 'help':
    case '?': {
      ui.info([
        ':help  ·  :provider <label>  ·  :budget  ·  :session  ·  :history',
        ':attach <path>  ·  :clear-attachments  ·  :reload  ·  :fork  ·  :exit',
      ].join('\n'));
      return { consumed: true };
    }
    case 'exit':
    case 'quit':
    case 'q': {
      ctx.onExit();
      return { consumed: true };
    }
    case 'budget': {
      ui.info(`session ${ctx.sessionIdRef.current.slice(0, 8)}  ${sessionBudget(ctx.sessionIdRef.current)}`);
      return { consumed: true };
    }
    case 'session': {
      ui.info(`active session: ${ctx.sessionIdRef.current}`);
      return { consumed: true };
    }
    case 'attach': {
      if (args.length === 0) {
        ui.error('usage: :attach <path>');
        return { consumed: true };
      }
      const att = loadAttachment(args.join(' '), ctx.cwd);
      if (att) {
        ctx.pendingAttachments.push(att);
        ui.info(`attached ${basename(att.path)} (queued for next turn — ${ctx.pendingAttachments.length} total)`);
      }
      return { consumed: true };
    }
    case 'clear-attachments': {
      const n = ctx.pendingAttachments.length;
      ctx.pendingAttachments.length = 0;
      ui.info(`cleared ${n} attachment(s)`);
      return { consumed: true };
    }
    case 'provider': {
      if (args.length === 0) {
        const p = inspectActiveProvider(ctx.cfg);
        ui.info(`current: ${p.provider}/${p.model ?? '?'}`);
        return { consumed: true };
      }
      const label = args[0]!;
      const { cfg: nextCfg, entry } = jumpToRotationEntry(ctx.cfg, label);
      if (!entry) {
        ui.error(`no rotation entry matching "${label}"`);
        return { consumed: true };
      }
      // Persist so the next REPL turn (and any elanous subprocess the
      // LLM might spawn for self-debug) sees the same active provider.
      try { saveUserConfig(nextCfg); } catch { /* best-effort */ }
      const p = inspectActiveProvider(nextCfg);
      ui.info(`provider → ${p.provider}/${p.model ?? '?'} (label "${label}")`);
      return { consumed: true, cfgUpdate: nextCfg };
    }
    case 'reload': {
      const refreshed = reloadUserConfig();
      ui.info(`reloaded ~/.config/elanous/config.json`);
      return { consumed: true, cfgUpdate: refreshed };
    }
    case 'history': {
      const loaded = loadSession(ctx.sessionIdRef.current);
      if (!loaded) {
        ui.error('no history (session not found)');
        return { consumed: true };
      }
      ui.info(`${loaded.meta.messageCount} message(s) — last 3:`);
      for (const m of loaded.messages.slice(-3)) {
        const head = m.content.slice(0, 80).replace(/\s+/g, ' ');
        console.log(`  [${m.role}] ${head}${m.content.length > 80 ? '…' : ''}`);
      }
      return { consumed: true };
    }
    case 'fork': {
      // Spawn a fresh session that shares no history with the
      // current one. Useful when the human wants to try the same
      // prompt with a different framing without polluting history.
      const next = ensureCliSession(ctx.cfg);
      setActiveSessionId(next.id);
      setAmbientSessionId(next.id);
      ctx.sessionIdRef.current = next.id;
      ui.info(`forked → fresh session ${next.id.slice(0, 8)}`);
      return { consumed: true };
    }
    default: {
      ui.error(`unknown command: :${cmd}  (try :help)`);
      return { consumed: true };
    }
  }
}

/** Runs the REPL until stdin EOF or an explicit `:exit`. Top-level
 *  entry from src/index.ts. */
export async function runRepl(opts: ReplOpts): Promise<number> {
  // Resolve initial session.
  let cfg = opts.cfg;
  let initialId: string | undefined;
  if (opts.initialSessionId) {
    const id = resolveSessionId(opts.initialSessionId);
    if (!id) {
      ui.error(`no session matching "${opts.initialSessionId}"`);
      return 1;
    }
    initialId = id;
  }
  const startDecision = decideSessionStart({
    ...(initialId ? { explicitSessionId: initialId } : {}),
    continueActive: opts.continueActive === true,
    forceNew: opts.forceNew,
    activeSessionId: () => getActiveSessionId(),
    // TUI-H8-FOLLOW ① — 활성 표지가 사라진 세션이면 최신 세션으로.
    sessionExists: (id) => loadSession(id) !== null,
    latestSessionId: () => listSessions({ limit: 1 })[0]?.id ?? null,
  });
  initialId = startDecision.sessionIdHint;
  const session = ensureCliSession(cfg, initialId);
  setActiveSessionId(session.id);
  observeSessionStart({
    surface: 'repl',
    origin: initialId && session.id === initialId ? startDecision.origin : 'new',
    reason: initialId && session.id !== initialId ? 'resume-target-missing' : startDecision.reason,
    sessionId: session.id,
  });
  setAmbientSessionId(session.id);
  if (!opts.jsonOutput && (!initialId || session.id !== initialId)) {
    try {
      const project = suggestProjectForFolder(process.cwd());
      if (project) ui.info(`Project suggestion: ${project.name} (${project.id})`);
    } catch { /* suggestions must not interrupt the REPL */ }
  }
  const sessionIdRef = { current: session.id };
  const selfHealthTracker = installNextTuiSelfHealthTracker();
  selfHealthTracker?.setSessionId(session.id);

  const nextTuiDelivery = process.env.ELANOUS_NEXT_TUI_BG_STATUS === '1'
    ? { pending: [] as PendingTaskNotification[] } : undefined;
  const backgroundBridge = createNextTuiBackgroundBridge(session.id, () => nextTuiDelivery?.pending.length ?? 0);
  let activeTurnSignal: AbortSignal | undefined;
  let activeTurnId: string | undefined;
  let activeRequestId: string | undefined;
  let requestSequence = 0;
  const baseTools = opts.enableTools ? buildReplTools({ nextTui: opts.nextTui === true, sessionId: session.id, getSignal: () => activeTurnSignal,
    getRequestId: () => activeRequestId,
    getTurnId: () => activeTurnId,
    onGraphProgress: (event) => {
      if (activeTurnId) process.stdout.write(`${JSON.stringify({ event: 'graph-progress', turnId: activeTurnId,
        graphProgress: event })}\n`);
    },
    memberBoardSession: opts.memberBoardSession }) : undefined;
  const tools = baseTools && backgroundBridge ? {
    ...baseTools,
    dispatch: async (name: string, args: Record<string, unknown>) => {
      const result = await baseTools.dispatch(name, args);
      backgroundBridge.observeToolResult(name, args, result);
      return result;
    },
  } : baseTools;
  // ELN-PROMPT-CACHE-PIN — stable part pinned per session · volatile part rebuilt per turn (sent after history).
  const replSystemPromptPin = createReplSystemPromptPin();
  const systemPromptForTurn = (workReferences?: unknown) => replSystemPromptPin({
    cfg,
    enabledToolNames: tools?.specs.map(s => s.name),
    cwd: getSessionCwd(),
    sessionId: sessionIdRef.current,
    workReferences,
  });
  const pendingAttachments: PendingAttachment[] = [];

  if (!opts.jsonOutput) {
    const p = inspectActiveProvider(cfg);
    ui.header(`elanous repl — session ${session.id.slice(0, 8)}`);
    ui.info(`provider: ${p.provider}/${p.model ?? '?'} · tools: ${tools ? tools.specs.length : 0} · :help for commands · :exit to quit`);
  }

  // Phase A — scripted scenario file or session replay (if any).
  // Replay (BACKLOG #5) uses the same loop body as YAML scenarios — we
  // synthesize a ScenarioFile from the source session's user prompts.
  let scriptedScenario: ScenarioFile | null = null;
  let scenarioBaseDir = process.cwd();
  if (opts.scenarioPath) {
    scriptedScenario = loadScenarioFromYaml(opts.scenarioPath);
    scenarioBaseDir = resolvePath(opts.scenarioPath, '..');
  } else if (opts.replaySessionId) {
    const replayId = resolveSessionId(opts.replaySessionId);
    if (!replayId) {
      ui.error(`--replay: no session matching "${opts.replaySessionId}"`);
      return 1;
    }
    const loaded = loadSession(replayId);
    if (!loaded) {
      ui.error(`--replay: failed to load session ${replayId}`);
      return 1;
    }
    const conv = buildReplayTurnsFromSession(loaded);
    if (conv.turns.length === 0) {
      ui.error(`--replay: session ${replayId.slice(0, 8)} has no replayable user prompts`);
      return 1;
    }
    if (!opts.jsonOutput) {
      ui.info(`replay: ${conv.extractedCount} prompt(s) from session ${replayId.slice(0, 8)} · skipped ${conv.skippedCount} non-user${conv.droppedAttachmentCount > 0 ? ` · ${conv.droppedAttachmentCount} with attachments dropped` : ''}`);
    }
    if (debug.enabled) {
      debug.log('repl.replay', 'session-loaded', {
        replaySessionId: replayId,
        ...conv,
      });
    }
    scriptedScenario = { turns: conv.turns };
  }

  if (scriptedScenario) {
    const sc = scriptedScenario;
    const baseDir = scenarioBaseDir;
    let assertFailures = 0;
    for (const turn of sc.turns) {
      const turnId = turn.id ?? `t${sc.turns.indexOf(turn) + 1}`;
      if (turn.rotate) {
        const { cfg: nextCfg, entry } = jumpToRotationEntry(cfg, turn.rotate);
        if (!entry) {
          ui.error(`turn ${turnId}: rotate "${turn.rotate}" not found in rotation`);
          continue;
        }
        cfg = nextCfg;
      }
      const turnAttachments: PendingAttachment[] = [];
      for (const ap of turn.attachments ?? []) {
        const att = loadAttachment(ap, baseDir);
        if (att) turnAttachments.push(att);
      }
      if (!opts.jsonOutput) {
        ui.header(`turn ${turnId}${turn.rotate ? ` · ${turn.rotate}` : ''}`);
        console.log(`  ❯ ${turn.prompt}`);
      }
      backgroundBridge?.beginTurn();
      const scenarioPrompt = systemPromptForTurn(turn.workReferences);
      const result = await runOneTurn(
        cfg,
        sessionIdRef.current,
        turn.prompt,
        turnAttachments,
        tools,
        scenarioPrompt.stable,
        opts.jsonOutput,
        opts.nextTui === true,
        nextTuiDelivery,
        ...Array(12).fill(undefined) as [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined],
        turn.workReferences,
        scenarioPrompt.volatile,
      );
      backgroundBridge?.emit();
      const failures = applyAsserts(result.reply, turn.asserts, sc.defaults?.asserts, turnId);
      if (opts.jsonOutput) {
        const out = {
          turnId,
          sessionId: sessionIdRef.current,
          provider: result.provider,
          model: result.model,
          reply: result.reply,
          durationMs: result.durationMs,
          logPath: result.logPath,
          assertFailures: failures,
        };
        console.log(JSON.stringify(out));
      } else {
        if (failures.length > 0) {
          for (const f of failures) ui.error(`assert: ${f}`);
        }
      }
      assertFailures += failures.length;
    }
    if (opts.exitAfterScenario) {
      backgroundBridge?.dispose();
      return assertFailures > 0 ? 2 : 0;
    }
  } // end if (scriptedScenario)

  // Phase B — interactive (TTY) or JSONL stdin (pipe).
  const isTty = process.stdin.isTTY === true;
  if (!isTty || opts.scriptedFromStdin) {
    // JSONL stream — one turn per line.
    const lines = readStdinLines();
    const claimTurnId = createTurnIdClaim();
    for await (const raw of lines) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      let turn: ScenarioTurn;
      try {
        turn = JSON.parse(trimmed) as ScenarioTurn;
      } catch {
        // Non-JSON line — treat as a plain prompt for forward-compat.
        turn = { prompt: trimmed };
      }
      // A repeated transport ID is a replay, so it cannot receive a new
      // completion frame that a parent might attach to the old turn.
      if (process.env.ELANOUS_NEXT_TUI_STREAM === '1' && typeof turn.id === 'string') {
        if (!claimTurnId(turn.id)) {
          process.stdout.write(`${JSON.stringify({ turnId: turn.id, error: 'duplicate or empty turn ID' })}\n`);
          continue;
        }
      }
      // The sticky child outlives /provider --global and config key rotations.
      // Re-read before every Next TUI turn, then apply this turn's non-secret choice.
      if (process.env.ELANOUS_NEXT_TUI_STREAM === '1') cfg = reloadUserConfig();
      if (turn.rotate) {
        const { cfg: nextCfg, entry } = jumpToRotationEntry(cfg, turn.rotate);
        if (!entry) {
          ui.error(`turn rotate "${turn.rotate}" not found in rotation`);
          continue;
        }
        cfg = nextCfg;
      }
      if (process.env.ELANOUS_NEXT_TUI_STREAM === '1'
        && (turn.modelTier === 'budget' || turn.modelTier === 'balanced' || turn.modelTier === 'best')) {
        setSessionTierOverride(sessionIdRef.current, { llm: turn.modelTier, rationale: 'next TUI /model' });
        debug.log('tui.next', 'model-tier-applied', { sessionId: sessionIdRef.current, tier: turn.modelTier });
      }
      const turnAttachments: PendingAttachment[] = [];
      for (const ap of turn.attachments ?? []) {
        const att = loadAttachment(ap, process.cwd());
        if (att) turnAttachments.push(att);
      }
      backgroundBridge?.beginTurn();
      const selfHealth = selfHealthTracker?.snapshot(sessionIdRef.current) ?? null;
      if (selfHealth && typeof turn.id === 'string') {
        process.stdout.write(`${JSON.stringify({ event: 'self-health', turnId: turn.id, sessionId: sessionIdRef.current, selfHealth })}\n`);
      }
      const turnPrompt = systemPromptForTurn(turn.workReferences);
      // ELN-PROMPT-CACHE-PIN — the self-health line changes per turn: volatile context, not the instructions.
      const turnSystemPrompt = turnPrompt.stable;
      const turnVolatileBase = selfHealth ? [...turnPrompt.volatile, selfHealth.line] : turnPrompt.volatile;
      // SIGNAL-INBOX-SNAPSHOT (Q6) — a seat turn (incl. every goal-drive continuation) carries one «Inbox (unhandled)» block.
      const inboxSnapshot = (() => {
        try {
          const seat = (require('../seat/seat-boot-preamble.js') as typeof import('../seat/seat-boot-preamble.js')).detectSeat(process.cwd())?.seat ?? null;
          return (require('../msg/inbox-snapshot-turn.js') as typeof import('../msg/inbox-snapshot-turn.js')).seatInboxSnapshotText(seat);
        } catch { return null; }
      })();
      const turnVolatileContext = inboxSnapshot ? [...turnVolatileBase, inboxSnapshot] : turnVolatileBase;
      let result: Awaited<ReturnType<typeof runOneTurn>>;
      const turnAbort = new AbortController();
      const pushNowReady = new Set<string>();
      let terminateAfterTurn = false;
      const onTerminate = (): void => { terminateAfterTurn = true; turnAbort.abort(); };
      const streamTurn = process.env.ELANOUS_NEXT_TUI_STREAM === '1' && typeof turn.id === 'string';
      activeTurnSignal = streamTurn ? turnAbort.signal : undefined;
      activeTurnId = streamTurn ? turn.id : undefined;
      const planVersionAtStart = getPlanState().version;
      activeRequestId = `request-${++requestSequence}`;
      // A201 — a shell watchdog stop shows one status line on this turn's screen.
      const previousWatchdogSink = streamTurn
        ? setShellWatchdogStatusSink((text) => { process.stdout.write(`${JSON.stringify({ event: 'status', turnId: turn.id, text })}\n`); })
        : null;
      if (streamTurn) process.once('SIGTERM', onTerminate);
      const stopTurnCancel = streamTurn ? turnCancelRouter.listen(turn.id!, (reason) => {
        emitTurnLife('turn-life:turn-cancel-received', { sessionId: sessionIdRef.current, turnId: turn.id });
        turnAbort.abort(reason);
      }) : undefined;
      try {
        // TUI-NEXT-PROVIDER-FLAG-IGNORED — the session choice applies on plain
        // JSONL turns too, not only behind the stream gate.
        const sessionCfg = sessionProviderAppliesToTurn(turn)
          ? await (async () => {
            const { configForSessionProviderTurn, parseSessionProvider } = await import('../tui-client/session-provider.js');
            return configForSessionProviderTurn(cfg, parseSessionProvider(turn.sessionProvider!.provider, turn.sessionProvider!.model));
          })()
          : cfg;
        result = await runOneTurn(
          sessionCfg,
          sessionIdRef.current,
          turn.prompt,
          turnAttachments,
          tools,
          turnSystemPrompt,
          true, // JSONL stream → always JSON output
          opts.nextTui === true,
          nextTuiDelivery,
          process.env.ELANOUS_NEXT_TUI_STREAM === '1' && typeof turn.id === 'string'
            ? (delta) => { process.stdout.write(`${JSON.stringify({ event: 'delta', turnId: turn.id, text: delta, source: 'assistant-text' })}\n`); }
            : undefined,
          process.env.ELANOUS_NEXT_TUI_STREAM === '1' && typeof turn.id === 'string'
            ? (text) => { process.stdout.write(`${JSON.stringify({ event: 'status', turnId: turn.id, text })}\n`); }
            : undefined,
          process.env.ELANOUS_NEXT_TUI_STREAM === '1' && typeof turn.id === 'string'
            ? (text) => { process.stdout.write(`${JSON.stringify({ event: 'replace', turnId: turn.id, text })}\n`); }
            : undefined,
          process.env.ELANOUS_NEXT_TUI_STREAM === '1' && typeof turn.id === 'string'
            ? (event) => { process.stdout.write(`${JSON.stringify({ event: 'agent', turnId: turn.id, ...event })}\n`); }
            : undefined,
          process.env.ELANOUS_NEXT_TUI_STREAM === '1' && typeof turn.id === 'string'
            ? (block) => { process.stdout.write(`${JSON.stringify({ event: 'message-block', turnId: turn.id, block })}\n`); }
            : undefined,
          streamTurn
            ? (activity) => { process.stdout.write(`${JSON.stringify({ event: 'shell-activity', turnId: turn.id, ...activity })}\n`); }
            : undefined,
          streamTurn ? turnAbort.signal : undefined,
          streamTurn ? turn.id : undefined,
          streamTurn
            ? (activity) => { process.stdout.write(`${JSON.stringify({ event: 'tool-activity', turnId: turn.id, ...activity })}\n`); }
            : undefined,
          streamTurn
            ? (requestId, phase, activeTools) => {
              let outcome: 'ready' | 'interrupted' | 'deferred';
              if (phase === 'probe') {
                outcome = nextTuiPushNowDecision(activeTools) === 'interrupt' ? 'ready' : 'deferred';
                if (outcome === 'ready') pushNowReady.add(requestId);
              } else {
                outcome = pushNowReady.delete(requestId) && nextTuiPushNowDecision(activeTools) === 'interrupt' ? 'interrupted' : 'deferred';
              }
              process.stdout.write(`${JSON.stringify({ event: 'push-now-result', turnId: turn.id, requestId, outcome, activeTools })}\n`);
              if (outcome === 'interrupted') turnAbort.abort();
            }
            : undefined,
          parseMessageSource(turn.from),
          typeof (turn as { parentPinnedGoal?: string }).parentPinnedGoal === 'string'
            ? (turn as { parentPinnedGoal?: string }).parentPinnedGoal
            : undefined,
          turn.workReferences,
          turnVolatileContext,
        );
      } catch (error) {
        if (streamTurn) process.off('SIGTERM', onTerminate);
        if (terminateAfterTurn) {
          backgroundBridge?.dispose();
          selfHealthTracker?.dispose();
          process.stdin.destroy();
          process.exit(0);
        }
        if (!backgroundBridge) throw error;
        backgroundBridge.emit();
        if (process.env.ELANOUS_NEXT_TUI_STREAM === '1' && typeof turn.id === 'string') {
          process.stdout.write(`${JSON.stringify({ event: 'message-block', turnId: turn.id, block: {
            id: `${sessionIdRef.current}:${turn.id}:error`, ts: Date.now(), source: 'system',
            body: { kind: 'error', text: error instanceof Error ? error.message : String(error) },
            detail: { level: 1, summary: error instanceof Error ? error.message : String(error) },
          } })}\n`);
        }
        console.log(JSON.stringify({ sessionId: sessionIdRef.current, error: error instanceof Error ? error.message : String(error) }));
        continue;
      } finally {
        stopTurnCancel?.();
        activeTurnSignal = undefined;
        activeTurnId = undefined;
        activeRequestId = undefined;
        if (streamTurn) setShellWatchdogStatusSink(previousWatchdogSink);
      }
      if (streamTurn) process.off('SIGTERM', onTerminate);
      if (terminateAfterTurn) {
        backgroundBridge?.dispose();
        selfHealthTracker?.dispose();
        process.stdin.destroy();
        process.exit(0);
      }
      backgroundBridge?.emit();
      const failures = applyAsserts(result.reply, turn.asserts, undefined, turn.id ?? 't?');
      const out = {
        turnId: turn.id ?? null,
        sessionId: sessionIdRef.current,
        provider: result.provider,
        model: result.model,
        reply: result.reply,
        ...(result.goalComplete ? { goalComplete: true } : {}),
        ...(result.goalStopReason ? { goalStopReason: result.goalStopReason } : {}),
        ...(result.goalCompletionVia ? { goalCompletionVia: result.goalCompletionVia } : {}),
        ...(() => { const planOutcome = planWireFromState(getPlanState(), planVersionAtStart); return planOutcome ? { planOutcome } : {}; })(),
        durationMs: result.durationMs,
        logPath: result.logPath,
        assertFailures: failures,
        selfHealth,
      };
      const usageFrame = streamTurn
        ? usageCompletionFrame(turn.id!, sessionIdRef.current, result.measuredUsage, turnAbort.signal.aborted)
        : undefined;
      if (usageFrame) {
        process.stdout.write(`${JSON.stringify(usageFrame)}\n`);
      }
      console.log(JSON.stringify(out));
    }    backgroundBridge?.dispose();
    selfHealthTracker?.dispose();
    return 0;
  }

  // TTY — readline loop.
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '❯ ',
    terminal: true,
    historySize: 200,
  });
  let exitRequested = false;
  const onExit = () => { exitRequested = true; rl.close(); };

  // BACKLOG #3 — Ctrl-C double-tap to exit + ambient cleanup on close.
  // Default node SIGINT during a bare readline prompt would just kill
  // the process without flushing logs or clearing the ambient session
  // id (next process inheriting the same shell would see a stale id
  // via the env / registry path). Mirror the familiar shell pattern:
  // first Ctrl-C clears the input buffer + prints a hint, second
  // within ~1.5 s closes gracefully. During an in-flight turn we
  // can't abort the streaming yet (runOneTurn doesn't take an abort
  // signal), so the hint also tells the user to press again to
  // force-quit.
  let lastSigintAt = 0;
  rl.on('SIGINT', () => {
    const now = Date.now();
    const action = decideSigintAction(lastSigintAt, now);
    if (debug.enabled) {
      debug.log('repl.tty', 'sigint', {
        sessionId: sessionIdRef.current,
        action,
      });
    }
    if (action === 'exit') {
      ui.info('exiting (Ctrl-C twice)');
      exitRequested = true;
      rl.close();
      return;
    }
    lastSigintAt = now;
    process.stdout.write('\n');
    ui.info('press Ctrl-C again to exit (or :exit). Mid-turn streaming cannot be aborted yet.');
    rl.prompt();
  });

  // Best-effort ambient cleanup: clear the session id so a sibling
  // process inheriting the same shell does not pick up a stale value
  // through `getAmbientSessionId()`.
  rl.on('close', () => {
    if (debug.enabled) {
      debug.log('repl.tty', 'close', { sessionId: sessionIdRef.current });
    }
    setAmbientSessionId(null);
  });

  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      rl.prompt();
      continue;
    }
    const meta = await handleMetaCommand(trimmed, {
      cfg,
      sessionIdRef,
      pendingAttachments,
      rl,
      cwd: process.cwd(),
      onExit,
    });
    if (meta.cfgUpdate) cfg = meta.cfgUpdate;
    if (meta.consumed) {
      if (exitRequested) break;
      rl.prompt();
      continue;
    }
    // Ordinary prompt.
    const turnAttachments = pendingAttachments.splice(0);
    backgroundBridge?.beginTurn();
    const replPrompt = systemPromptForTurn();
    await runOneTurn(
      cfg,
      sessionIdRef.current,
      trimmed,
      turnAttachments,
      tools,
      replPrompt.stable,
      opts.jsonOutput,
      opts.nextTui === true,
      nextTuiDelivery,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined,
      undefined, // workReferences (main #seat-owner-handoff) — this plain chat path carries none
      replPrompt.volatile,
    );
    backgroundBridge?.emit();
    if (exitRequested) break;
    rl.prompt();
  }
  backgroundBridge?.dispose();
  return 0;
}

async function* readStdinLines(): AsyncGenerator<string, void, unknown> {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) yield line;
}
