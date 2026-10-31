// NEXUS · in-memory state (extended by phase)
//
// Shape that every later phase extends:
//   - PR β fills `tabs` with chat / webterm kind entries
//   - PR δ attaches optional `bus` for pub/sub fan-out (still keeps
//     `events` ring buffer as the historical log)
//   - N-2 supervisor adds `health.lastOkAt` · `restartCount` per tab
//   - N-3 SwitchRegistry hangs off `config`

import type { TabKind, TabState } from '../kinds/types.js';
import type { NexusEventBus } from '../api/event-bus.js';
import type { AgentStatusStore } from '../../agent-status/store.js';
import type { HudStore } from './hud-store.js';

export interface NexusEvent {
  ts: number;
  kind:
    | 'nexus.boot'
    | 'nexus.shutdown'
    | 'tab.created'
    | 'tab.up'
    | 'tab.down'
    | 'tab.unhealthy'
    | 'tab.restart'
    | 'tab.halt'
    | 'config.changed'
    // Workflow approval lifecycle (BACKLOG #9 · HANDOFF §4.2 follow-up).
    // SSE subscribers can filter `?topics=workflow.` to receive both.
    // `workflow.approval.pending` fires when an approval node parks
    // a deferred Promise; `workflow.approval.resolved` fires when the
    // /approve or /reject REST endpoint resolves it.
    | 'workflow.approval.pending'
    | 'workflow.approval.resolved'
    // Workflow run-execution lifecycle (session §15.8(b) follow-up).
    // SSE subscribers filter `?topics=workflow.run.` to follow a run
    // without polling. PWA invalidates the corresponding query keys
    // on each kind, eliminating the 1s `useWorkflowRun` /
    // `useWorkflowRuns` polls (kept as 30s safety net).
    | 'workflow.run.started'
    | 'workflow.run.node-started'
    | 'workflow.run.node-skipped'
    | 'workflow.run.node-done'
    | 'workflow.run.completed'
    | 'workflow.run.failed'
    // Surface-unification v2 (2026-05-11) — trigger registry lifecycle.
    // `trigger.subscribed` fires when the daemon attaches a trigger source
    // (start). `trigger.unsubscribed` fires on stop. `trigger.fired` fires
    // for every actual emit. PWA `ActiveTriggersPanel` subscribes via
    // `subscribeEvents({topics:['trigger.']})` for live status + trace
    // overlays. Detail carries `{workflowName, nodeId, variant, ok?, runId?, error?}`.
    | 'trigger.subscribed'
    | 'trigger.unsubscribed'
    | 'trigger.fired'
    // HITL PWA in-app banner channel (β-1a · 2026-05-08).
    // SSE subscribers filter `?topics=hitl.banner.` to render an
    // in-Showroom Approve/Reject banner. `show` carries the prompt +
    // requestId so the PWA can POST `/v1/hitl/callback/:requestId`
    // with `{answer: true|false}`. `cancel` fires when another channel
    // (Pushcut, Telegram, terminal) won the race so the banner can
    // dismiss without a stale prompt lingering.
    | 'hitl.banner.show'
    | 'hitl.banner.cancel'
    // Media generation feedback fan-out. Android subscribes to `media.` over
    // the global SSE bus because widget calls do not keep a prompt SSE open.
    // `detail` carries the original FeedbackEnvelope for forward compatibility.
    | 'media.feedback'
    // Intent-prediction ranker fan-out (2026-05-09 dogfood fix · CV-3
    // R1 follow-up). The IntentPanel container subscribes via
    // `subscribeEvents({topics: ['intent-prediction.']})` (global
    // /v1/events bus) — before this kind landed the service never
    // published to the bus, so the panel sat at ranking=null forever
    // even after recordFeedback POSTs round-tripped successfully.
    // `detail` carries the IntentRanking shape (sessionId · candidates ·
    // version · generatedAt). Per-session SSE at
    // /v1/intent-prediction/:sessionId/sse remains the canonical
    // single-session path; the global bus is the multi-session
    // multiplex the showroom layout uses today.
    | 'intent-prediction.ranking'
    // R5.4 (2026-05-09) — PWA Session Card Deck swipe decision fan-out.
    // POST /v1/sessions/:id/decision publishes one of these per
    // accepted decision so SSE consumers (PWA status panel · future
    // ACP forward adapter · metric collector) react without polling.
    // `detail` = { sessionId, decision: 'reject'|'approve'|'pause'|'expand' }.
    | 'session-decision'
    // 라이브 세션 관리(2026-07-09) — on-disk 세션 생성/갱신 fan-out. 데몬이
    // onSessionCreated/onMessageAppended 를 이 이벤트로 발행하면 PWA /sessions 가
    // `/v1/events?topics=session.` SSE 로 즉시 리스트 갱신(polling 대체). `detail` =
    // { sessionId, source, messageCount?, title? }.
    | 'session.created'
    | 'session.updated'
    // 세션 패브릭 cutover C4 (2026-07-16) — PWA 메시지레벨 fan-out. `'pwa'` SurfaceSink 가
    // fanOutSessionOutput 배달마다 이 이벤트를 발행하면 PWA 알림/뱃지 면이 `topics=session.`
    // SSE 로 **내용을 담은** 메시지레벨 갱신을 받는다(content-less `session.updated` 와 달리
    // role/text 포함). 스트리밍(ACP peer broadcast)은 C5 별도. `detail` = { sessionId, role, text }.
    | 'session.output'
    // Hand mission addressed line. Durable rows live in agent-missions; this event
    // is only the existing /v1/events SSE notification edge.
    | 'mission.line'
    // Rich-dev-feedback opportunistic followup §6.2 #3 (2026-05-13) —
    // AgentStatusStore lifecycle fan-out. The bridge in
    // `agent-status-event-bridge.ts` subscribes to the store and
    // publishes one `agent.status` event per transition.
    // `detail` = { agentId, status: 'running'|'queued'|'error'|'done',
    //              lastEvent?: string, updatedAt: number }.
    // PWA subscribes via `subscribeAgentStatusEvents` and routes each
    // event to the accumulator as a `tool.search-hit`-style
    // FeedbackEnvelope so `<StatusChip>` hydrates wherever chat is
    // rendered (PWA tab · iOS native · future Telegram bot).
    | 'agent.status'
    | 'ta.repair.completed'
    // PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M2 — HudStore
    // (process-wide HUD segment map) lifecycle. The bridge in
    // `hud-event-bridge.ts` subscribes to the store and publishes one
    // `hud.segment` NexusEvent per set/clear. `detail` is the
    // `HudSegmentEventDetail` shape (phase · key · value? · priority?
    // · tone? · glyph?). PWA's M4 `subscribeHudSegmentEvents`
    // synthesizes a FeedbackEnvelope { kind: 'hud.segment' } and routes
    // it through the M1 `applyHudSegmentEnvelope` accumulator.
    | 'hud.segment'
    // GRAPH-WIZARD variant 관측 (ARG-L2-DESIGNER-FU1 · 2026-10-23) — POST /v1/graphs/wizard 의
    // variant 한 턴이 끝날 때 호출 경계(handleGraphWizardPost)가 한 건 발행한다. `detail` =
    // { mode: 'variant', status: 'composed'|'fallback-standard', reason, goal, templateId,
    //   growth?: { from, outcome, nodeId, returnTo? }, overlayId?, patches? }.
    // SSE 구독자는 `?topics=graph.compose` 로 받는다.
    | 'graph.compose';
  tabId?: string;
  detail?: Record<string, unknown>;
}

export interface NexusState {
  /** Mirrors NexusRuntimeMeta.nexusVersion — bumped per phase. */
  nexusVersion: string;
  phase: string;
  startedAt: number;
  /** Template name when launched via --template; undefined = ad-hoc. */
  template?: string;
  /** By tab id — empty in PR α; populated by PR β kinds. */
  tabs: Record<string, TabState>;
  /** Ring buffer (last 1000) — historical log replayed via /v1/nexus
   *  recentEvents tail. */
  events: NexusEvent[];
  /** Optional pub/sub bus — pushEvent fans out here when set so SSE
   *  subscribers see live events without polling. PR δ attaches; tests
   *  that don't need the wire leave it undefined. */
  bus?: NexusEventBus;
  /** Rich-dev-feedback opportunistic followup §6.2 #3 (2026-05-13) —
   *  daemon-native AgentStatusStore. runNexus always attaches one so
   *  ACP turn-runner / future writers have a canonical sink; the
   *  `agent.status` bus bridge (`wireAgentStatusEvents`) is wired
   *  unconditionally. Tests that need to inspect transitions can read
   *  this field directly; tests that don't want the bridge leave it
   *  undefined (state construction stays cheap when bus is absent). */
  agentStatusStore?: AgentStatusStore;
  /** PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M2 — daemon-native
   *  HudStore. runNexus always attaches one so the dashboard mirror (M3)
   *  + REST IPC seam (`POST /v1/hud-segment`) share a single source of
   *  truth. The `hud.segment` bus bridge (`wireHudSegmentEvents`) wires
   *  set/clear → SSE fanout. Tests that need to inspect transitions read
   *  this field directly. */
  hudStore?: HudStore;
}

export interface CreateNexusStateOpts {
  nexusVersion: string;
  phase: string;
  template?: string;
}

export function createNexusState(opts: CreateNexusStateOpts): NexusState {
  return {
    nexusVersion: opts.nexusVersion,
    phase: opts.phase,
    startedAt: Date.now(),
    ...(opts.template !== undefined ? { template: opts.template } : {}),
    tabs: {},
    events: [],
  };
}

const MAX_EVENTS = 1000;

export function pushEvent(state: NexusState, event: Omit<NexusEvent, 'ts'>): NexusEvent {
  const e: NexusEvent = { ts: Date.now(), ...event };
  state.events.push(e);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  state.bus?.publish(e);
  return e;
}

/** Re-export TabKind for downstream consumers that don't need TabState. */
export type { TabKind };
